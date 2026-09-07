import { expect, test, type Page, type Request } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS, loginAs, uniqueTitle } from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import {
  COORDINATION_SCHEMA_ID,
  captureCoordinationRequests,
  createQualificationInvestigation,
  expectNoPerRowReads,
  expectOnlyPublicCoordinationWrites,
  expectQueueUrlUnchanged,
  expectSelfBody,
  QUEUE_QUERY_SCHEMA_ID,
} from "../src/operations-queue-coordination-harness.js";

/**
 * Operations Queue participant coordination browser qualification.
 *
 * Limitations versus Investigation First (spec 31), kept here rather than
 * changing production code:
 *
 * - There is no "Review participant assignment" / "Confirm participant
 *   assignment" dialog. The shipped confirmation is: choose a recorded
 *   participant in the labeled combobox (zero writes), then activate
 *   Assign participant. Selecting in the combobox must not POST.
 * - Rows do not render a "Revision N" fact. Revision is asserted on the
 *   versioned POST body (`expectedRevision`) and on the server-confirmed
 *   coordinator fact after the queue refresh.
 * - After `release_participant` or a successful 503 retry, the initiator
 *   control can unmount. These cases assert the next shipped control is
 *   keyboard-reachable instead of inventing a focus target.
 */

interface ParticipantCoordinationWrite {
  readonly schemaId: string;
  readonly investigationId: string;
  readonly action: "claim_self" | "release_self" | "assign_participant" | "release_participant";
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly targetIdentityId?: string;
}

function recordedParticipant(): { identityId: string; username: string } {
  return {
    identityId: `participant-${Date.now()}`,
    username: "ravi-fixture",
  };
}

function recordedIdentityLabel(person: { identityId: string; username: string }): string {
  return `${person.username} (${person.identityId})`;
}

async function addRecordedParticipant(
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

function writesOf(
  capture: ReturnType<typeof captureCoordinationRequests>,
): readonly ParticipantCoordinationWrite[] {
  return capture.bodies.map((body): ParticipantCoordinationWrite => {
    const write: ParticipantCoordinationWrite = {
      schemaId: body.schemaId,
      investigationId: body.investigationId,
      action: body.action,
      expectedRevision: body.expectedRevision,
      idempotencyKey: body.idempotencyKey,
    };
    if ("targetIdentityId" in body && typeof body.targetIdentityId === "string") {
      return { ...write, targetIdentityId: body.targetIdentityId };
    }
    return write;
  });
}

function expectParticipantWrite(
  body: ParticipantCoordinationWrite,
  caseId: string,
  action: "assign_participant" | "release_participant",
  targetIdentityId: string,
  expectedRevision: number,
): void {
  expect(body).toEqual({
    schemaId: COORDINATION_SCHEMA_ID,
    investigationId: caseId,
    action,
    targetIdentityId,
    expectedRevision,
    idempotencyKey: expect.stringMatching(/^[a-z0-9._:-]+$/iu),
  });
}

function expectCanonicalQueueLocation(page: Page, initialUrl: string): void {
  expectQueueUrlUnchanged(page, initialUrl);
  const location = new URL(page.url());
  expect(location.pathname).toBe("/operations");
  expect(location.searchParams.has("cursor")).toBe(false);
  expect(location.searchParams.has("uiStrategyId")).toBe(false);
}

function expectNoStrategyPreference(requests: readonly Request[]): void {
  expect(requests.some((request) => {
    const url = new URL(request.url());
    return request.method() === "PUT" && url.pathname === "/api/ui-strategies/preference";
  })).toBe(false);
}

async function expectNoHistoryUiStrategyId(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => Object.prototype.hasOwnProperty.call(history.state ?? {}, "uiStrategyId")),
  ).toBe(false);
}

function expectNoLegacyCaseList(requests: readonly Request[]): void {
  for (const request of requests) {
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== "/api/cases") continue;
    expect(
      url.searchParams.get("schemaId"),
      `legacy case list GET was substituted: ${url.pathname}?${url.searchParams.toString()}`,
    ).toBe(QUEUE_QUERY_SCHEMA_ID);
    expect(url.searchParams.has("cursor")).toBe(false);
  }
}

const NARROW_VIEWPORT = { width: 320, height: 720 } as const;

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}

async function expectQueueUsableAtNarrowViewport(page: Page, title: string): Promise<void> {
  const group = page.getByRole("group", { name: `Participant coordination for ${title}` });
  await expect(group).toBeVisible();
  await expectNoHorizontalOverflow(page);
}

test.describe("Operations Queue participant-coordination browser qualification", () => {
  test("claims self, assigns a recorded participant after explicit selection, then releases", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations participant coordination");
    const caseId = await createQualificationInvestigation(page, title);
    const participant = recordedParticipant();
    await addRecordedParticipant(page, caseId, participant);
    const label = recordedIdentityLabel(participant);
    const requests = captureCoordinationRequests(page, caseId);
    await page.setViewportSize(NARROW_VIEWPORT);

    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      const initialUrl = page.url();
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
      const rowLink = page.getByRole("link", { name: new RegExp(title, "u") });
      const claim = page.getByRole("button", { name: `Claim for me ${title}` });
      const select = page.getByRole("combobox", { name: `Recorded participants for ${title}` });
      await expect(rowLink).toBeVisible();
      await expect(rowLink).toContainText("Coordinator: Not recorded");
      await expect(claim).toBeVisible();
      await expect(select).toBeVisible();
      await expect(page.getByRole("button", { name: "Review participant assignment" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm participant assignment" })).toHaveCount(0);
      await expectQueueUsableAtNarrowViewport(page, title);

      await rowLink.focus();
      await rowLink.press("Tab");
      await expect(claim).toBeFocused();
      await claim.press("Space");
      await expect.poll(() => requests.bodies.length).toBe(1);
      expectSelfBody(requests.bodies[0]!, caseId, "claim_self", 0);
      const claimKey = requests.bodies[0]!.idempotencyKey;
      const releaseSelf = page.getByRole("button", { name: `Release me ${title}` });
      await expect(releaseSelf).toBeVisible();
      await expect(releaseSelf).toBeFocused();
      await expect(rowLink).toContainText(`Coordinator: ${FIXTURE_USERS.dave.username}`);

      await releaseSelf.press("Tab");
      await expect(select).toBeFocused();
      await select.selectOption(participant.identityId);
      await expect(select).toHaveValue(participant.identityId);
      expect(writesOf(requests)).toHaveLength(1);

      const assign = page.getByRole("button", {
        name: `Assign participant ${label} to ${title}`,
      });
      await select.press("Tab");
      await expect(assign).toBeFocused();
      await assign.press("Enter");
      await expect.poll(() => requests.bodies.length).toBe(2);
      expectParticipantWrite(writesOf(requests)[1]!, caseId, "assign_participant", participant.identityId, 1);
      expect(writesOf(requests)[1]!.idempotencyKey).not.toBe(claimKey);
      await expect(rowLink).toContainText(`Coordinator: ${participant.username}`);
      await expect(assign).toBeFocused();
      await expect(page.getByRole("button", { name: `Claim for me ${title}` })).toHaveCount(0);

      const releaseCoordinator = page.getByRole("button", {
        name: `Release coordinator ${label} from ${title}`,
      });
      await expect(releaseCoordinator).toBeVisible();
      await assign.press("Tab");
      await expect(releaseCoordinator).toBeFocused();
      await releaseCoordinator.press("Enter");
      await expect.poll(() => requests.bodies.length).toBe(3);
      expectParticipantWrite(writesOf(requests)[2]!, caseId, "release_participant", participant.identityId, 2);
      await expect(rowLink).toContainText("Coordinator: Not recorded");
      await expect(page.getByRole("button", {
        name: `Release coordinator ${label} from ${title}`,
      })).toHaveCount(0);
      const claimAgain = page.getByRole("button", { name: `Claim for me ${title}` });
      await expect(claimAgain).toBeVisible();
      await claimAgain.focus();
      await expect(claimAgain).toBeFocused();

      expectCanonicalQueueLocation(page, initialUrl);
      expectNoStrategyPreference(requests.allRequests);
      await expectNoHistoryUiStrategyId(page);
      expectNoPerRowReads(requests.allRequests, caseId);
      expectOnlyPublicCoordinationWrites(requests.allRequests, caseId);
      expectNoLegacyCaseList(requests.allRequests);
      await expectQueueUsableAtNarrowViewport(page, title);
    } finally {
      requests.stop();
    }
  });

  test("retries only commit-outcome-unknown assign with the same payload", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations participant retry");
    const caseId = await createQualificationInvestigation(page, title);
    const participant = recordedParticipant();
    await addRecordedParticipant(page, caseId, participant);
    const label = recordedIdentityLabel(participant);
    const requests = captureCoordinationRequests(page, caseId);
    let applyCount = 0;
    await page.route(`**/api/cases/${caseId}/coordination`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      applyCount += 1;
      if (applyCount === 1) {
        const response = await route.fetch();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "commit_outcome_unknown" }),
        });
        expect(response.ok()).toBeTruthy();
        return;
      }
      await route.continue();
    });
    await page.setViewportSize(NARROW_VIEWPORT);

    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      const initialUrl = page.url();
      const select = page.getByRole("combobox", { name: `Recorded participants for ${title}` });
      await expect(select).toBeVisible();
      await expectQueueUsableAtNarrowViewport(page, title);
      await select.selectOption(participant.identityId);
      expect(writesOf(requests)).toHaveLength(0);
      const assign = page.getByRole("button", {
        name: `Assign participant ${label} to ${title}`,
      });
      await assign.press("Enter");
      await expect(page.getByRole("alert")).toContainText("may have recorded this action");
      expect(writesOf(requests)).toHaveLength(1);
      const first = writesOf(requests)[0]!;
      expectParticipantWrite(first, caseId, "assign_participant", participant.identityId, 0);
      await expect(assign).toBeDisabled();
      const retry = page.getByRole("button", {
        name: `Retry assign participant ${participant.identityId} for ${title}`,
      });
      await expect(retry).toBeVisible();
      await retry.focus();
      await expect(retry).toBeFocused();
      await expect.poll(() => writesOf(requests).length).toBe(1);

      await retry.press("Enter");
      await expect.poll(() => writesOf(requests).length).toBe(2);
      expect(writesOf(requests)[1]).toEqual(first);
      expect(applyCount).toBe(2);
      await expect(page.getByRole("link", { name: new RegExp(title, "u") }))
        .toContainText(`Coordinator: ${participant.username}`);
      await expect(page.getByRole("button", {
        name: `Retry assign participant ${participant.identityId} for ${title}`,
      })).toHaveCount(0);
      const assignAfterRetry = page.getByRole("button", {
        name: `Assign participant ${label} to ${title}`,
      });
      await expect(assignAfterRetry).toBeEnabled();
      await assignAfterRetry.focus();
      await expect(assignAfterRetry).toBeFocused();
      expectCanonicalQueueLocation(page, initialUrl);
      expectNoPerRowReads(requests.allRequests, caseId);
      expectOnlyPublicCoordinationWrites(requests.allRequests, caseId);
      expectNoLegacyCaseList(requests.allRequests);
      await expectQueueUsableAtNarrowViewport(page, title);
    } finally {
      await page.unroute(`**/api/cases/${caseId}/coordination`);
      requests.stop();
    }
  });

  test("keeps 403 forbidden truthful without a legacy fallback", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations participant forbidden");
    const caseId = await createQualificationInvestigation(page, title);
    const participant = recordedParticipant();
    await addRecordedParticipant(page, caseId, participant);
    const label = recordedIdentityLabel(participant);
    const requests = captureCoordinationRequests(page, caseId);
    let applyCount = 0;
    await page.route(`**/api/cases/${caseId}/coordination`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      applyCount += 1;
      if (applyCount === 1) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: "{}",
        });
        return;
      }
      await route.continue();
    });
    await page.setViewportSize(NARROW_VIEWPORT);

    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      const initialUrl = page.url();
      const select = page.getByRole("combobox", { name: `Recorded participants for ${title}` });
      await expect(select).toBeVisible();
      await expectQueueUsableAtNarrowViewport(page, title);
      await select.selectOption(participant.identityId);
      const assign = page.getByRole("button", {
        name: `Assign participant ${label} to ${title}`,
      });
      await assign.press("Enter");
      await expect.poll(() => writesOf(requests).length).toBe(1);
      expect(writesOf(requests)).toHaveLength(1);
      expectParticipantWrite(writesOf(requests)[0]!, caseId, "assign_participant", participant.identityId, 0);
      // A 403 is an authentication/access-loss boundary: protected API
      // semantics tear down the protected tree instead of inventing a row
      // error. Verify the truthful sign-in surface and no legacy fallback.
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      expect(requests.allRequests.filter((request) => request.method() === "POST")).toHaveLength(1);
      expect(applyCount).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/signin");
      expectNoPerRowReads(requests.allRequests, caseId);
      expectOnlyPublicCoordinationWrites(requests.allRequests, caseId);
      expectNoLegacyCaseList(requests.allRequests);
      expectNoStrategyPreference(requests.allRequests);
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.unroute(`**/api/cases/${caseId}/coordination`);
      requests.stop();
    }
  });

  test("keeps a viewer read-only without emitting coordination writes", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, FIXTURE_USERS.dave);
    const title = uniqueTitle("Operations participant viewer");
    const caseId = await createQualificationInvestigation(page, title);
    await addRecordedParticipant(page, caseId, {
      identityId: FIXTURE_USERS.carol.identityId,
      username: FIXTURE_USERS.carol.username,
    });
    await loginAs(page, FIXTURE_USERS.carol);
    const requests: Request[] = [];
    const listener = (request: Request) => {
      requests.push(request);
    };
    page.on("request", listener);
    await page.setViewportSize(NARROW_VIEWPORT);
    try {
      await page.goto(`/operations?q=${encodeURIComponent(title)}`);
      const initialUrl = page.url();
      await expect(page.getByRole("heading", { name: "Operations Queue", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: title })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(requests.some((request) => {
        const url = new URL(request.url());
        return request.method() === "GET"
          && url.pathname === "/api/cases"
          && url.searchParams.get("schemaId") === QUEUE_QUERY_SCHEMA_ID;
      })).toBe(true);
      await expect(page.getByRole("button", { name: /Claim for me|Release me/u })).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: `Recorded participants for ${title}` })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Assign participant|Release coordinator/u })).toHaveCount(0);
      await expect(page.getByRole("group", { name: `Participant coordination for ${title}` })).toHaveCount(0);
      expect(requests.filter((request) => {
        const url = new URL(request.url());
        return request.method() === "POST"
          && (url.pathname === "/api/cases" || /\/api\/cases\/[^/]+\/coordination$/u.test(url.pathname));
      })).toEqual([]);
      expectNoPerRowReads(requests, caseId);
      expectNoLegacyCaseList(requests);
      expectCanonicalQueueLocation(page, initialUrl);
      expectNoStrategyPreference(requests);
      await expectNoHistoryUiStrategyId(page);
      await expectNoHorizontalOverflow(page);
    } finally {
      page.off("request", listener);
    }
  });
});
