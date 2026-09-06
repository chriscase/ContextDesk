import { expect, test, type Page, type Request } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import {
  expectForcedColors,
  expectReducedMotion,
  expectReflow,
} from "../src/investigation-strategy/conformance.js";
import { FIXTURE_USERS } from "../src/users.js";

const ALL_STRATEGIES = ["war-room", "investigation-first", "keystone", "beacon"];
const COORDINATION_REQUEST_SCHEMA_ID =
  "cd-collab.investigation_coordination_action_request.v1";

interface StrategyPolicy {
  revision: number;
  instance: {
    enabledIds: string[];
    visibleIds: string[];
    defaultId: string;
    selectionMode: "free" | "approved_subset";
    approvedIds: string[];
  };
  roleRules: Array<{
    role: "viewer" | "contributor" | "case-lead" | "admin";
    approvedIds: string[];
    defaultId: string | null;
  }>;
}

interface CoordinationRequestBody {
  schemaId: string;
  investigationId: string;
  action: "claim_self" | "release_self" | "assign_participant" | "release_participant";
  expectedRevision: number;
  idempotencyKey: string;
  targetIdentityId?: string;
  clientTime?: string;
}

async function strategyPolicy(page: Page): Promise<StrategyPolicy> {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as StrategyPolicy;
}

async function updateStrategyPolicy(
  page: Page,
  policy: Pick<StrategyPolicy, "instance" | "roleRules">,
): Promise<void> {
  const current = await strategyPolicy(page);
  const response = await page.request.put("/api/admin/ui-strategies", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: current.revision,
      instance: policy.instance,
      roleRules: policy.roleRules,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function useFixedInvestigationFirst(page: Page): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId: "investigation-first",
      selectionMode: "approved_subset",
      approvedIds: [],
    },
    roleRules: [],
  });
  return previous;
}

async function restoreStrategyPolicy(page: Page, previous: StrategyPolicy): Promise<void> {
  await updateStrategyPolicy(page, {
    instance: previous.instance,
    roleRules: previous.roleRules,
  });
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Synthetic coordination browser qualification.",
      affectedParties: "Fixture operators",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id, "case creation did not return an id").toBeTruthy();
  return body.id!;
}

async function addParticipant(
  page: Page,
  caseId: string,
  participant: { identityId: string; username: string },
): Promise<void> {
  const response = await page.request.post(`/api/cases/${caseId}/participants`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: participant,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function coordinationPostBodies(page: Page, caseId: string): {
  bodies: CoordinationRequestBody[];
  stop(): void;
} {
  const bodies: CoordinationRequestBody[] = [];
  const record = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST"
      && url.pathname === `/api/cases/${caseId}/coordination`
    ) {
      bodies.push(request.postDataJSON() as CoordinationRequestBody);
    }
  };
  page.on("request", record);
  return { bodies, stop: () => page.off("request", record) };
}

function expectSelfRequest(
  body: CoordinationRequestBody,
  caseId: string,
  action: "claim_self" | "release_self",
  expectedRevision: number,
): void {
  expect(body).toEqual({
    schemaId: COORDINATION_REQUEST_SCHEMA_ID,
    investigationId: caseId,
    action,
    expectedRevision,
    idempotencyKey: expect.stringMatching(/^coordination-[a-z0-9._:-]+$/iu),
  });
}

test.describe("Investigation First coordination browser qualification", () => {
  test("records self and privileged actions only after confirmation", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const previousPolicy = await useFixedInvestigationFirst(page);
    const participant = {
      identityId: `participant-${Date.now()}`,
      username: "ravi-fixture",
    };
    const title = uniqueTitle("Coordination action proof");
    const caseId = await createInvestigation(page, title);
    await addParticipant(page, caseId, participant);
    const posts = coordinationPostBodies(page, caseId);

    try {
      await page.goto(`/investigations/${caseId}/situation`);
      const coordination = page.locator(".strategy-kit__coordination");
      const heading = coordination.getByRole("heading", { name: "Coordination", exact: true });
      await expect(heading).toBeVisible();
      await expect(page.getByText("No coordinator is recorded.")).toBeVisible();
      await expect(page.getByText("Revision 0")).toBeVisible();

      const claim = page.getByRole("button", { name: "Claim coordination" });
      await claim.click();
      expect(posts.bodies).toHaveLength(0);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(claim).toBeFocused();
      await claim.click();
      const claimResponse = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/coordination`);
      await page.getByRole("button", { name: "Confirm claim coordination" }).click();
      expect((await claimResponse).ok()).toBeTruthy();
      await expect(page.getByText("Coordination was updated.")).toBeVisible();
      await expect(coordination.getByText(FIXTURE_USERS.dave.username, { exact: true })).toBeVisible();
      await expect(heading).toBeFocused();
      expect(posts.bodies).toHaveLength(1);
      expectSelfRequest(posts.bodies[0]!, caseId, "claim_self", 0);

      await page.getByRole("button", { name: "Release my coordination" }).click();
      expect(posts.bodies).toHaveLength(1);
      const releaseSelfResponse = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/coordination`);
      await page.getByRole("button", { name: "Confirm release my coordination" }).click();
      expect((await releaseSelfResponse).ok()).toBeTruthy();
      await expect(page.getByText("Revision 2")).toBeVisible();
      expect(posts.bodies).toHaveLength(2);
      expectSelfRequest(posts.bodies[1]!, caseId, "release_self", 1);

      await page.getByText("Participant coordination").click();
      await page.getByRole("combobox", { name: "Participant" }).selectOption(participant.identityId);
      await page.getByRole("button", { name: "Review participant assignment" }).click();
      expect(posts.bodies).toHaveLength(2);
      const assignResponse = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/coordination`);
      await page.getByRole("button", { name: "Confirm participant assignment" }).click();
      expect((await assignResponse).ok()).toBeTruthy();
      await expect(page.getByText(participant.username, { exact: true })).toBeVisible();
      await expect(coordination.locator("code").filter({ hasText: participant.identityId })).toBeVisible();
      expect(posts.bodies).toHaveLength(3);
      expect(posts.bodies[2]).toEqual({
        schemaId: COORDINATION_REQUEST_SCHEMA_ID,
        investigationId: caseId,
        action: "assign_participant",
        targetIdentityId: participant.identityId,
        expectedRevision: 2,
        idempotencyKey: expect.stringMatching(/^coordination-[a-z0-9._:-]+$/iu),
      });

      await page.route("**/api/cases/**", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || url.pathname !== `/api/cases/${caseId}`) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const body = await response.json() as {
          participants?: Array<{ identityId: string; username: string }>;
        };
        await route.fulfill({
          response,
          contentType: "application/json",
          body: JSON.stringify({
            ...body,
            participants: (body.participants ?? []).filter(
              ({ identityId }) => identityId !== participant.identityId,
            ),
          }),
        });
      });
      await page.reload();
      await expect(page.getByText(participant.username, { exact: true })).toBeVisible();
      await expect(page.getByText(
        "Not listed among this investigation’s recorded participants.",
      )).toBeVisible();
      await page.getByText("Participant coordination").click();
      await page.getByRole("button", { name: "Release recorded coordinator" }).click();
      expect(posts.bodies).toHaveLength(3);
      const releaseParticipantResponse = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/coordination`);
      await page.getByRole("button", { name: "Confirm release recorded coordinator" }).click();
      expect((await releaseParticipantResponse).ok()).toBeTruthy();
      await expect(page.getByText("Revision 4")).toBeVisible();
      await expect(page.getByText("No coordinator is recorded.")).toBeVisible();
      expect(posts.bodies).toHaveLength(4);
      expect(posts.bodies[3]).toEqual({
        schemaId: COORDINATION_REQUEST_SCHEMA_ID,
        investigationId: caseId,
        action: "release_participant",
        targetIdentityId: participant.identityId,
        expectedRevision: 3,
        idempotencyKey: expect.stringMatching(/^coordination-[a-z0-9._:-]+$/iu),
      });
    } finally {
      posts.stop();
      await page.unroute("**/api/cases/**");
      await restoreStrategyPolicy(page, previousPolicy);
    }
  });

  test("keeps viewer, denied, and archived records nonwritable", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const previousPolicy = await useFixedInvestigationFirst(page);
    const title = uniqueTitle("Coordination access proof");
    const caseId = await createInvestigation(page, title);
    await addParticipant(page, caseId, {
      identityId: FIXTURE_USERS.carol.identityId,
      username: FIXTURE_USERS.carol.username,
    });
    const coordinationWrites: CoordinationRequestBody[] = [];
    const coordinationReads: string[] = [];
    const record = (request: Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname !== `/api/cases/${caseId}/coordination`) return;
      if (request.method() === "GET") coordinationReads.push(pathname);
      if (request.method() === "POST") {
        coordinationWrites.push(request.postDataJSON() as CoordinationRequestBody);
      }
    };
    page.on("request", record);

    try {
      await loginAs(page, FIXTURE_USERS.carol);
      await page.goto(`/investigations/${caseId}/situation`);
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
      await expect(page.getByText("No coordinator is recorded.")).toBeVisible();
      await expect(page.getByText(/changes are unavailable with your current access/iu)).toBeVisible();
      await expect(page.getByRole("button", { name: /claim coordination|participant assignment|release/iu })).toHaveCount(0);
      expect(coordinationReads).toHaveLength(1);
      expect(coordinationWrites).toEqual([]);

      const authenticated = await page.request.get("/api/auth/me");
      expect(authenticated.ok(), await authenticated.text()).toBeTruthy();
      const session = await authenticated.json() as Record<string, unknown>;
      await page.route("**/api/auth/me", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...session, capabilities: [] }),
        });
      });
      coordinationReads.length = 0;
      await page.goto(`/investigations/${caseId}/situation`);
      await expect(page.getByRole("heading", {
        name: "Investigation unavailable in this view",
      })).toBeFocused();
      await expect(page.getByText(/No investigation data was requested/iu)).toBeVisible();
      await expect(page.getByRole("heading", { name: "Coordination" })).toHaveCount(0);
      expect(coordinationReads).toEqual([]);
      expect(coordinationWrites).toEqual([]);

      await page.unroute("**/api/auth/me");
      await loginAs(page, FIXTURE_USERS.dave);
      await page.goto(`/investigations/${caseId}/situation`);
      await page.getByRole("button", { name: "Archive investigation" }).click();
      const archived = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/lifecycle`);
      await page.getByRole("button", { name: "Confirm archive investigation" }).click();
      expect((await archived).ok()).toBeTruthy();
      await expect(page.getByText(
        "Coordination cannot change while this investigation is archived.",
      )).toBeVisible();
      await expect(page.getByRole("button", { name: /claim coordination|participant assignment|release/iu })).toHaveCount(0);
      expect(coordinationWrites).toEqual([]);
    } finally {
      page.off("request", record);
      await page.unroute("**/api/auth/me");
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, previousPolicy);
    }
  });

  test("does not retry an unknown commit outcome until the exact explicit retry", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const previousPolicy = await useFixedInvestigationFirst(page);
    const caseId = await createInvestigation(page, uniqueTitle("Coordination retry proof"));
    const posts: CoordinationRequestBody[] = [];

    await page.route("**/api/cases/**/coordination", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "POST" || url.pathname !== `/api/cases/${caseId}/coordination`) {
        await route.continue();
        return;
      }
      posts.push(route.request().postDataJSON() as CoordinationRequestBody);
      if (posts.length === 1) {
        const committed = await route.fetch();
        expect(committed.ok(), await committed.text()).toBeTruthy();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "commit_outcome_unknown" }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto(`/investigations/${caseId}/situation`);
      await page.getByRole("button", { name: "Claim coordination" }).click();
      await page.getByRole("button", { name: "Confirm claim coordination" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "may have been recorded" });
      await expect(alert).toBeVisible();
      expect(posts).toHaveLength(1);
      expectSelfRequest(posts[0]!, caseId, "claim_self", 0);
      await page.waitForTimeout(300);
      expect(posts, "the UI retried an unknown outcome without an explicit user action").toHaveLength(1);

      await expect(page.getByRole("button", { name: "Refresh coordination" })).toBeVisible();
      const committedProjection = await page.request.get(`/api/cases/${caseId}/coordination`);
      expect(committedProjection.ok(), await committedProjection.text()).toBeTruthy();
      await expect(committedProjection.json()).resolves.toMatchObject({
        coordinator: { username: FIXTURE_USERS.dave.username },
        revision: 1,
      });

      const replayed = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cases/${caseId}/coordination`);
      await page.getByRole("button", { name: "Retry exact action" }).click();
      expect((await replayed).ok()).toBeTruthy();
      await expect(page.getByText("Coordination was updated.")).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(posts[0]);
      await expect(page.getByRole("heading", { name: "Coordination", exact: true })).toBeFocused();
    } finally {
      await page.unroute("**/api/cases/**/coordination");
      await restoreStrategyPolicy(page, previousPolicy);
    }
  });

  test("keeps coordination operable at narrow width and under browser media preferences", async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await loginAs(page, FIXTURE_USERS.dave);
    const previousPolicy = await useFixedInvestigationFirst(page);
    const caseId = await createInvestigation(page, uniqueTitle("Coordination media proof"));

    try {
      await page.goto(`/investigations/${caseId}/situation`);
      const root = page.locator(".strategy-kit__coordination");
      const claim = page.getByRole("button", { name: "Claim coordination" });
      const privileged = page.getByText("Participant coordination");
      await expectReflow(page, "reflow-390", [root, claim, privileged]);
      await expectReducedMotion(page, page.locator(".investigation-first"));
      await expectForcedColors(page, [root, claim]);
    } finally {
      await restoreStrategyPolicy(page, previousPolicy);
    }
  });
});
