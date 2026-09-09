import { expect, test, type Page, type Request } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";

const DESKTOP = { width: 1280, height: 900 };
const ALL_STRATEGIES = ["war-room", "investigation-first", "keystone", "beacon"];
type StrategyName = "Investigation First" | "Keystone" | "Beacon";

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

interface ContributionBody {
  kind?: unknown;
  body?: unknown;
  hypothesisLinks?: unknown;
  idempotencyKey?: unknown;
}

interface ContributionRecord {
  id: string;
  body: string;
  hypothesisLinks: Array<{ kind: "artifact" | "contribution"; id: string }> | null;
}

async function strategyPolicy(page: Page): Promise<StrategyPolicy> {
  const response = await page.request.get("/api/admin/ui-strategies");
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as StrategyPolicy;
}

async function updateStrategyPolicy(
  page: Page,
  policy: Pick<StrategyPolicy, "instance" | "roleRules">,
): Promise<StrategyPolicy> {
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
  return await response.json() as StrategyPolicy;
}

async function enableStrategyParity(page: Page): Promise<StrategyPolicy> {
  const previous = await strategyPolicy(page);
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId: previous.instance.defaultId,
      selectionMode: "free",
      approvedIds: [...ALL_STRATEGIES],
    },
    // Keep the fixture policy strategy-neutral for both the writer and viewer
    // parity journeys; the original role rules are restored in finally.
    roleRules: [],
  });
  return previous;
}

async function restoreStrategyPolicy(page: Page, policy: StrategyPolicy): Promise<void> {
  await updateStrategyPolicy(page, {
    instance: policy.instance,
    roleRules: policy.roleRules,
  });
}

async function makeFixedDefault(page: Page, name: StrategyName): Promise<void> {
  const defaultId = {
    "Investigation First": "investigation-first",
    Keystone: "keystone",
    Beacon: "beacon",
  }[name];
  await updateStrategyPolicy(page, {
    instance: {
      enabledIds: [...ALL_STRATEGIES],
      visibleIds: [...ALL_STRATEGIES],
      defaultId,
      selectionMode: "approved_subset",
      approvedIds: [],
    },
    roleRules: [],
  });
}

async function selectStrategy(
  page: Page,
  name: StrategyName,
  username: string,
): Promise<void> {
  const before = new URL(page.url());
  const account = page.getByRole("button", { name: `Signed in as ${username}` });
  await account.click();
  const strategy = page.getByRole("radio", { name: new RegExp(`^${name}\\b`, "u") });
  if (!(await strategy.isChecked())) {
    await strategy.check();
    const save = page.getByRole("button", { name: "Use selected experience" });
    await save.scrollIntoViewIfNeeded();
    await save.click();
  }
  if (await account.getAttribute("aria-expanded") === "true") await page.keyboard.press("Escape");
  await expect(page.locator(".topbar__title-app")).toHaveText(name);
  const after = new URL(page.url());
  expect(after.pathname).toBe(before.pathname);
  expect(after.search).toBe(before.search);
  expect(after.hash).toBe(before.hash);
}

async function createInvestigation(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/cases", {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      title,
      problemStatement: "Evidence-linked hypothesis browser qualification.",
      affectedParties: "Fixture checkout traffic",
      impact: "Qualification only",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { id?: string };
  expect(body.id, "case creation did not return an id").toBeTruthy();
  return body.id!;
}

async function addViewer(page: Page, caseId: string): Promise<void> {
  const response = await page.request.post(`/api/cases/${caseId}/participants`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      identityId: FIXTURE_USERS.carol.identityId,
      username: FIXTURE_USERS.carol.username,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function uploadEvidenceByApi(
  page: Page,
  caseId: string,
  filename: string,
): Promise<string> {
  const response = await page.request.post(`/api/cases/${caseId}/evidence`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      kind: "log",
      summary: "Canonical evidence for hypothesis strategy parity.",
      filename,
      mediaType: "text/plain",
      contentBase64: Buffer.from("timeout=upstream status=504\n", "utf8").toString("base64"),
      privacyClass: "share_safe",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { artifact?: { id?: string } };
  expect(body.artifact?.id, "evidence upload did not return an artifact id").toBeTruthy();
  return body.artifact!.id!;
}

async function addSourceContribution(page: Page, caseId: string, body: string): Promise<string> {
  const response = await page.request.post(`/api/cases/${caseId}/contributions`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      kind: "note",
      body,
      privacyClass: "share_safe",
      idempotencyKey: `hypothesis-source-${crypto.randomUUID()}`,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const contribution = await response.json() as { id?: string };
  expect(contribution.id, "source contribution did not return an id").toBeTruthy();
  return contribution.id!;
}

async function currentContributions(page: Page, caseId: string): Promise<ContributionRecord[]> {
  const response = await page.request.get(`/api/cases/${caseId}/contributions`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { contributions?: ContributionRecord[] };
  return body.contributions ?? [];
}

async function selectEvidence(
  page: Page,
  strategy: StrategyName,
  filename: string,
): Promise<void> {
  const checkbox = strategy === "Keystone"
    ? page.getByRole("checkbox", { name: `Add ${filename} to working set` })
    : page.getByRole("checkbox", { name: new RegExp(filename.replaceAll(".", "\\."), "u") });
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  const checked = strategy === "Keystone"
    ? page.getByRole("checkbox", { name: `Remove ${filename} from working set` })
    : checkbox;
  await expect(checked).toBeChecked();
}

function contributionPosts(page: Page, caseId: string) {
  const bodies: ContributionBody[] = [];
  const record = (request: Request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/cases/${caseId}/contributions`
    ) {
      bodies.push(request.postDataJSON() as ContributionBody);
    }
  };
  page.on("request", record);
  return { bodies, stop: () => page.off("request", record) };
}

test.describe("evidence-linked hypothesis strategy parity", () => {
  test("preserves one canonical evidence trail while switching among all three strategies", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await enableStrategyParity(page);
    try {
      const title = uniqueTitle("Hypothesis strategy parity");
      const caseId = await createInvestigation(page, title);
      const sourceBody = "The timeout increase began immediately after the rollout.";
      const sourceId = await addSourceContribution(page, caseId, sourceBody);
      await page.goto(`/investigations/${caseId}/situation`);
      await selectStrategy(page, "Investigation First", FIXTURE_USERS.dave.username);
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();

      const filename = "strategy-parity.log";
      await page.getByRole("button", { name: "File", exact: true }).setInputFiles({
        name: filename,
        mimeType: "text/plain",
        buffer: Buffer.from("timeout=upstream status=504\n", "utf8"),
      });
      await page.locator("select[name='kind']").selectOption("log");
      await page.locator("input[name='summary']").fill("Canonical evidence uploaded once.");
      const [uploaded] = await Promise.all([
        page.waitForResponse((response) => {
          const pathname = new URL(response.url()).pathname;
          return response.request().method() === "POST"
            && (pathname === `/api/cases/${caseId}/evidence`
              || pathname === `/api/cases/${caseId}/evidence/stream`);
        }),
        page.getByRole("button", { name: "Add to evidence inventory" }).click(),
      ]);
      expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
      const uploadBody = await uploaded.json() as { artifact?: { id?: string } };
      const artifactId = uploadBody.artifact?.id;
      expect(artifactId, "browser evidence upload did not return an artifact id").toBeTruthy();

      const posts = contributionPosts(page, caseId);
      const journeys: Array<{
        strategy: StrategyName;
        body: string;
        prefix: RegExp;
        links: Array<{ kind: "artifact" | "contribution"; id: string }>;
      }> = [
        {
          strategy: "Investigation First",
          body: "The uploaded log supports testing a rollout correlation.",
          prefix: /^evidence-hypothesis-/u,
          links: [{ kind: "artifact", id: artifactId! }],
        },
        {
          strategy: "Keystone",
          body: "The same log warrants a focused timeout-window comparison.",
          prefix: /^keystone-hypothesis-/u,
          links: [{ kind: "artifact", id: artifactId! }],
        },
        {
          strategy: "Beacon",
          body: "The log and recorded rollout entry support a causal test.",
          prefix: /^beacon-hypothesis-/u,
          links: [
            { kind: "artifact", id: artifactId! },
            { kind: "contribution", id: sourceId },
          ],
        },
      ];

      for (const [index, journey] of journeys.entries()) {
        if (index > 0) await selectStrategy(page, journey.strategy, FIXTURE_USERS.dave.username);
        await selectEvidence(page, journey.strategy, filename);
        if (journey.strategy === "Keystone") {
          await page.getByRole("tab", { name: "Reasoning" }).click();
          await expect(page).toHaveURL(`/investigations/${caseId}/analyze`);
        }
        if (journey.strategy === "Beacon") {
          await page.getByRole("combobox", { name: "Source entry (optional)" }).selectOption(sourceId);
        }
        const before = posts.bodies.length;
        await page.getByRole("textbox", { name: "Hypothesis" }).fill(journey.body);
        await page.getByRole("button", { name: "Record hypothesis" }).click();
        await expect(page.getByText("Hypothesis recorded")).toBeVisible();
        await expect.poll(() => posts.bodies.length).toBe(before + 1);
        expect(posts.bodies[before]).toMatchObject({
          kind: "hypothesis",
          body: journey.body,
          hypothesisLinks: journey.links,
          idempotencyKey: expect.stringMatching(journey.prefix),
        });
        const stored = (await currentContributions(page, caseId))
          .filter((item) => item.body === journey.body);
        expect(stored).toHaveLength(1);
        expect(stored[0]!.hypothesisLinks).toEqual(journey.links);
      }

      expect(posts.bodies).toHaveLength(3);
      expect(new URL(page.url()).pathname).toBe(`/investigations/${caseId}/analyze`);
      posts.stop();
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("keeps every evidence-hypothesis surface read-only for a viewer", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await enableStrategyParity(page);
    try {
      const title = uniqueTitle("Hypothesis viewer parity");
      const caseId = await createInvestigation(page, title);
      const filename = "viewer-parity.log";
      await uploadEvidenceByApi(page, caseId, filename);
      await addViewer(page, caseId);
      const durableWrites: string[] = [];
      const recordWrite = (request: Request) => {
        const pathname = new URL(request.url()).pathname;
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method())
          && pathname.startsWith(`/api/cases/${caseId}`)
          && !pathname.endsWith("/presence")
        ) {
          durableWrites.push(`${request.method()} ${pathname}`);
        }
      };
      page.on("request", recordWrite);
      for (const strategy of ["Investigation First", "Keystone", "Beacon"] as const) {
        await loginAs(page, FIXTURE_USERS.dave);
        await makeFixedDefault(page, strategy);
        await loginAs(page, FIXTURE_USERS.carol);
        await page.goto(`/investigations/${caseId}/situation`);
        await expect(page.locator(".topbar__title-app")).toHaveText(strategy);
        if (strategy === "Keystone") {
          await page.getByRole("tab", { name: "Reasoning" }).click();
        }
        await expect(page.getByText("Hypothesis writing unavailable")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Hypothesis" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Record hypothesis" })).toHaveCount(0);
        await expect(page.getByText(filename, { exact: true }).first()).toBeVisible();
      }
      expect(durableWrites).toEqual([]);
      page.off("request", recordWrite);
    } finally {
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });

  test("retries a Beacon commit-outcome-unknown with the exact frozen hypothesis request", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await loginAs(page, FIXTURE_USERS.dave);
    const original = await enableStrategyParity(page);
    const caseId = await createInvestigation(page, uniqueTitle("Hypothesis retry parity"));
    const filename = "hypothesis-retry.log";
    const artifactId = await uploadEvidenceByApi(page, caseId, filename);
    const sourceId = await addSourceContribution(
      page,
      caseId,
      "The rollout and timeout windows overlap.",
    );
    const bodies: ContributionBody[] = [];
    await page.route(`**/api/cases/${caseId}/contributions`, async (route) => {
      const request = route.request();
      const body = request.method() === "POST"
        ? request.postDataJSON() as ContributionBody
        : null;
      if (body?.kind !== "hypothesis") {
        await route.continue();
        return;
      }
      bodies.push(structuredClone(body));
      const response = await route.fetch();
      if (bodies.length === 1) {
        expect(response.ok()).toBeTruthy();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "commit_outcome_unknown" }),
        });
        return;
      }
      expect(response.status()).toBe(200);
      await route.fulfill({ response });
    });
    try {
      await page.goto(`/investigations/${caseId}/situation`);
      await selectStrategy(page, "Beacon", FIXTURE_USERS.dave.username);
      await selectEvidence(page, "Beacon", filename);
      await page.getByRole("combobox", { name: "Source entry (optional)" }).selectOption(sourceId);
      const hypothesis = "The cited rollout entry and log support the same timeout hypothesis.";
      const editor = page.getByRole("textbox", { name: "Hypothesis" });
      await editor.fill(hypothesis);
      await page.getByRole("button", { name: "Record hypothesis" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Hypothesis outcome unknown" }))
        .toBeVisible();
      await expect(editor).toHaveValue(hypothesis);
      await expect(page.getByRole("combobox", { name: "Source entry (optional)" }))
        .toHaveValue(sourceId);
      await expect(page.getByRole("checkbox", { name: new RegExp(filename, "u") }))
        .toBeChecked();
      expect(bodies).toHaveLength(1);
      await page.waitForTimeout(1_000);
      expect(bodies, "the Runtime retried an ambiguous hypothesis automatically").toHaveLength(1);

      await page.getByRole("button", { name: "Record hypothesis" }).click();
      await expect.poll(() => bodies.length).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({
        kind: "hypothesis",
        body: hypothesis,
        hypothesisLinks: [
          { kind: "artifact", id: artifactId },
          { kind: "contribution", id: sourceId },
        ],
        idempotencyKey: expect.stringMatching(/^beacon-hypothesis-/u),
      });
      await expect(page.getByText("Hypothesis recorded")).toBeVisible();
      const stored = (await currentContributions(page, caseId))
        .filter((item) => item.body === hypothesis);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.hypothesisLinks).toEqual(bodies[0]!.hypothesisLinks);
    } finally {
      await page.unroute(`**/api/cases/${caseId}/contributions`);
      await loginAs(page, FIXTURE_USERS.dave);
      await restoreStrategyPolicy(page, original);
    }
  });
});
