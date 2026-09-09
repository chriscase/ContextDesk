import { expect, test, type Page, type Request } from "@playwright/test";
import {
  BROWSER_MUTATION_HEADERS,
  caseIdForTitle,
  createCase,
  fixtureText,
  gotoStage,
  importChat,
  loginAs,
  uniqueTitle,
} from "../src/helpers.js";
import { REFLOW_VIEWPORTS } from "../src/investigation-strategy/conformance.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

/**
 * War Room human-assessments Chromium qualification.
 *
 * Nonclaims kept here rather than expanding production or the harness:
 *
 * - No Firefox, WebKit, hosted CI, or real assistive-technology run.
 * - Forced-colors / 3px focus-outline proof is not claimed; the shared
 *   strategy harness can assert a visible outline, but this journey does not
 *   emulate forced colors.
 * - A no-write session uses the established `/api/auth/me` capability
 *   projection (drop `investigation:write`, keep read) on the importer.
 *   The fixture viewer cannot see owner_only imported runs, so that role
 *   is not used as a stand-in for assessment history.
 * - A session with no investigation:read is exercised only through the
 *   same `/api/auth/me` intercept. It is not a separately provisioned
 *   no-read fixture user.
 */

const JUDGMENT_REQUEST_SCHEMA_ID = "cd-collab.external_run_judgment_request.v1";
const JUDGMENT_SUCCESS_SCHEMA_ID = "cd-collab.external_run_judgment_success.v1";
const JUDGMENT_LIST_SCHEMA_ID = "cd-collab.external_run_judgment_list.v1";
const JUDGMENT_SCHEMA_ID = "cd-collab.external_run_judgment.v1";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const RATIONALE = "Queue depth is not independently verified.";
const UNKNOWN_OUTCOME_BODY = { error: "commit_outcome_unknown" } as const;

interface ImportedRunRow {
  id: string;
  corroborationState: string;
  outputText: string;
}

interface JudgmentRequestBody {
  schemaId: string;
  caseId: string;
  runId: string;
  expectedSequence: number;
  idempotencyKey: string;
  judgment: string;
  links: readonly unknown[];
  rationale: string | null;
}

function captureFocusPath(caseId: string, runId: string): string {
  return `/investigations/${caseId}/capture?section=triage-capture&item=${encodeURIComponent(runId)}&kind=imported-run#triage-capture`;
}

function isJudgmentRoute(url: URL, caseId: string, runId: string): boolean {
  return url.pathname === `/api/cases/${caseId}/runs/${runId}/judgments`;
}

function expectCanonicalCaptureFocus(page: Page, caseId: string, runId: string): void {
  const location = new URL(page.url());
  expect(location.pathname).toBe(`/investigations/${caseId}/capture`);
  expect(location.searchParams.get("section")).toBe("triage-capture");
  expect(location.searchParams.get("item")).toBe(runId);
  expect(location.searchParams.get("kind")).toBe("imported-run");
  expect(location.hash).toBe("#triage-capture");
  expect(location.searchParams.has("cursor")).toBe(false);
  expect(location.searchParams.has("uiStrategyId")).toBe(false);
}

async function chooseWarRoom(page: Page, username: string): Promise<void> {
  const account = page.getByRole("button", { name: `Signed in as ${username}` });
  await account.click();
  const strategy = page.getByRole("radio", { name: /^War Room\b/u });
  await expect(strategy).toBeVisible();
  if (!(await strategy.isChecked())) {
    await strategy.check();
    await expect(strategy).toBeChecked();
    const save = page.getByRole("button", { name: "Use selected experience" });
    await save.scrollIntoViewIfNeeded();
    await save.click();
  }
  await page.keyboard.press("Escape");
  if (new URL(page.url()).pathname.startsWith("/investigations")) {
    await expect(page.locator(".topbar__title-app")).toHaveText("War Room");
  }
}

async function listedRuns(page: Page, caseId: string): Promise<ImportedRunRow[]> {
  const response = await page.request.get(`/api/cases/${caseId}/imports`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { runs?: ImportedRunRow[] };
  return body.runs ?? [];
}

async function recordJudgmentViaPublicApi(
  page: Page,
  caseId: string,
  runId: string,
  rationale: string,
): Promise<void> {
  const response = await page.request.post(`/api/cases/${caseId}/runs/${runId}/judgments`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      schemaId: JUDGMENT_REQUEST_SCHEMA_ID,
      caseId,
      runId,
      expectedSequence: 0,
      idempotencyKey: `assess-e2e-readonly-${runId}`,
      judgment: "insufficient_evidence",
      links: [],
      rationale,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { schemaId?: string; replayed?: boolean; applied?: { seq?: number } };
  expect(body.schemaId).toBe(JUDGMENT_SUCCESS_SCHEMA_ID);
  expect(body.replayed).toBe(false);
  expect(body.applied?.seq).toBe(1);
}

function captureJudgmentTraffic(page: Page, caseId: string, runId: string): {
  readonly posts: Array<{ raw: string; body: JudgmentRequestBody }>;
  readonly gets: Request[];
  readonly corroborationWrites: Request[];
  stop(): void;
} {
  const posts: Array<{ raw: string; body: JudgmentRequestBody }> = [];
  const gets: Request[] = [];
  const corroborationWrites: Request[] = [];
  const record = (request: Request) => {
    const url = new URL(request.url());
    if (isJudgmentRoute(url, caseId, runId)) {
      if (request.method() === "POST") {
        posts.push({
          raw: request.postData() ?? "",
          body: request.postDataJSON() as JudgmentRequestBody,
        });
      }
      if (request.method() === "GET") gets.push(request);
      return;
    }
    if (
      request.method() === "POST"
      && url.pathname === `/api/cases/${caseId}/imports/${runId}/corroborate`
    ) {
      corroborationWrites.push(request);
    }
  };
  page.on("request", record);
  return {
    posts,
    gets,
    corroborationWrites,
    stop() {
      page.off("request", record);
    },
  };
}

function expectInsufficientEvidenceRequest(
  body: JudgmentRequestBody,
  caseId: string,
  runId: string,
  rationale: string,
): void {
  expect(body).toEqual({
    schemaId: JUDGMENT_REQUEST_SCHEMA_ID,
    caseId,
    runId,
    expectedSequence: 0,
    idempotencyKey: expect.stringMatching(IDEMPOTENCY_KEY),
    judgment: "insufficient_evidence",
    links: [],
    rationale,
  });
}

function assessmentsPanel(page: Page) {
  return page.locator(".strategy-kit__human-assessments");
}

function humanAssessmentsHeading(page: Page) {
  return page.getByRole("heading", { name: "Human assessments", exact: true });
}

function importedRunCard(page: Page, excerpt: string) {
  return page.locator(".imported-run").filter({ hasText: excerpt });
}

async function expectNoHorizontalOverflowForPanel(page: Page): Promise<void> {
  await page.setViewportSize(REFLOW_VIEWPORTS["reflow-390"]);
  const panel = assessmentsPanel(page);
  await expect(panel).toBeVisible();
  const dimensions = await panel.evaluate((node) => ({
    panelScrollWidth: node.scrollWidth,
    panelClientWidth: node.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.panelScrollWidth).toBeLessThanOrEqual(dimensions.panelClientWidth + 1);
}

async function expectAssessmentsMountedFor(
  page: Page,
  focusedExcerpt: string,
  otherExcerpt: string,
  options: { readonly saveReview?: boolean } = {},
): Promise<void> {
  const focused = importedRunCard(page, focusedExcerpt);
  const other = importedRunCard(page, otherExcerpt);
  await expect(focused).toBeVisible();
  await expect(other).toBeVisible();
  await expect(focused.locator(".imported-run__banner")).toHaveText("Unverified imported run");
  if (options.saveReview === false) {
    await expect(focused.getByRole("button", { name: "Save review" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Save review" })).toHaveCount(0);
  } else {
    await expect(focused.getByRole("button", { name: "Save review" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Save review" })).toBeVisible();
  }
  await expect(humanAssessmentsHeading(page)).toHaveCount(1);
  const adjacent = await focused.evaluate((node) => {
    const next = node.nextElementSibling;
    return next instanceof HTMLElement
      && next.classList.contains("strategy-kit__human-assessments");
  });
  expect(adjacent, "human assessments did not mount immediately after the focused imported run").toBe(true);
  const otherAdjacent = await other.evaluate((node) => {
    const next = node.nextElementSibling;
    return next instanceof HTMLElement
      && next.classList.contains("strategy-kit__human-assessments");
  });
  expect(otherAdjacent, "human assessments mounted on an unfocused imported run").toBe(false);
}

async function establishImportedInvestigation(page: Page, title: string): Promise<{
  caseId: string;
  focused: ImportedRunRow;
  other: ImportedRunRow;
}> {
  await createCase(page, title);
  const dave = FIXTURE_USERS.dave;
  await importChat(page, {
    output: fixtureText("chats", "external-triage-a.txt"),
    prompt: "Triage the mailer timeout using only the pasted log facts.",
    sourceLabel: SEEDED_SOURCES.chatA,
    operatorUsername: dave.username,
    operatorId: dave.identityId,
    visibility: "importer_described",
  });
  await importChat(page, {
    output: fixtureText("chats", "external-triage-b.txt"),
    sourceLabel: SEEDED_SOURCES.chatB,
    operatorUsername: dave.username,
    operatorId: dave.identityId,
  });
  const caseId = await caseIdForTitle(page, title);
  const runs = await listedRuns(page, caseId);
  const focused = runs.find((run) => run.outputText.includes("queue depth is the root cause"));
  const other = runs.find((run) => run.outputText.includes("DNS NXDOMAIN"));
  expect(focused, "focused imported run was not recorded").toBeTruthy();
  expect(other, "second imported run was not recorded").toBeTruthy();
  expect(focused!.corroborationState).toBe("unverified");
  expect(other!.corroborationState).toBe("unverified");
  return { caseId, focused: focused!, other: other! };
}

test.describe("War Room imported-run human assessments", () => {
  test("records an insufficient-evidence assessment without changing legacy review", async ({ page }) => {
    test.setTimeout(120_000);
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await chooseWarRoom(page, dave.username);
    const title = uniqueTitle("Imported-run assessment persist");
    const { caseId, focused, other } = await establishImportedInvestigation(page, title);
    const traffic = captureJudgmentTraffic(page, caseId, focused.id);
    const corroborationBefore = focused.corroborationState;

    try {
      await gotoStage(page, "Situation");
      await expect(page.getByRole("button", { name: "Open to record a human judgment" }).first()).toBeVisible();
      await page.getByRole("button", { name: "Open to record a human judgment" }).first().click();
      await page.goto(captureFocusPath(caseId, focused.id));
      expectCanonicalCaptureFocus(page, caseId, focused.id);
      await expectAssessmentsMountedFor(page, "queue depth is the root cause", "DNS NXDOMAIN");
      const panel = assessmentsPanel(page);
      await expect(panel.getByText("No human assessment has been recorded yet.")).toBeVisible();
      await expect(panel.getByText("Waiting for recorded human assessments.")).toHaveCount(0);
      await expect(panel.getByText("Loading recorded human assessments…")).toHaveCount(0);
      await expect(panel.getByRole("heading", { name: "Record an assessment" })).toBeVisible();
      await expect.poll(() => traffic.gets.length).toBeGreaterThan(0);
      expect(traffic.posts).toHaveLength(0);

      await panel.getByRole("radio", { name: "Insufficient evidence" }).check();
      await panel.getByRole("textbox", { name: "Rationale (optional)" }).fill(`  ${RATIONALE}  `);
      const recorded = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST" && isJudgmentRoute(url, caseId, focused.id);
      });
      await panel.getByRole("button", { name: "Record assessment" }).click();
      const recordedResponse = await recorded;
      expect(recordedResponse.ok(), await recordedResponse.text()).toBeTruthy();
      const recordedBody = await recordedResponse.json() as Record<string, unknown>;
      expect(recordedBody).toMatchObject({
        schemaId: JUDGMENT_SUCCESS_SCHEMA_ID,
        caseId,
        runId: focused.id,
        replayed: false,
        applied: {
          schemaId: JUDGMENT_SCHEMA_ID,
          caseId,
          runId: focused.id,
          seq: 1,
          judgment: "insufficient_evidence",
          links: [],
          rationale: RATIONALE,
        },
      });
      await expect.poll(() => traffic.posts.length).toBe(1);
      expectInsufficientEvidenceRequest(traffic.posts[0]!.body, caseId, focused.id, RATIONALE);
      expect(traffic.posts[0]!.raw).toBe(JSON.stringify(traffic.posts[0]!.body));
      await expect(panel.getByText("The assessment was recorded.")).toBeVisible();
      const history = panel.locator(".strategy-kit__human-assessments-history");
      await expect(history.getByText("Insufficient evidence")).toBeVisible();
      await expect(history.getByText(dave.username)).toBeVisible();
      await expect(history.locator("time")).toBeVisible();
      await expect(history.getByText(RATIONALE)).toBeVisible();
      await expect(panel.getByText("No human assessment has been recorded yet.")).toHaveCount(0);
      await expect(panel.getByText("No rationale recorded")).toHaveCount(0);
      expect(traffic.posts).toHaveLength(1);
      expect(traffic.corroborationWrites).toHaveLength(0);

      await expectNoHorizontalOverflowForPanel(page);
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.reload();
      expectCanonicalCaptureFocus(page, caseId, focused.id);
      await expect(assessmentsPanel(page).getByText(RATIONALE)).toBeVisible();
      await expect(
        assessmentsPanel(page).locator(".strategy-kit__human-assessments-item")
          .getByText("Insufficient evidence", { exact: true }),
      ).toBeVisible();
      await expect(humanAssessmentsHeading(page)).toHaveCount(1);

      await gotoStage(page, "Analyze");
      await expect(humanAssessmentsHeading(page)).toHaveCount(0);
      await page.goto(captureFocusPath(caseId, other.id));
      expectCanonicalCaptureFocus(page, caseId, other.id);
      await expectAssessmentsMountedFor(page, "DNS NXDOMAIN", "queue depth is the root cause");
      await expect(assessmentsPanel(page).getByText("No human assessment has been recorded yet.")).toBeVisible();
      await expect(assessmentsPanel(page).getByText(RATIONALE)).toHaveCount(0);

      await page.goto(captureFocusPath(caseId, focused.id));
      expectCanonicalCaptureFocus(page, caseId, focused.id);
      await expect(assessmentsPanel(page).getByText(RATIONALE)).toBeVisible();
      await expect(importedRunCard(page, "queue depth is the root cause").locator(".imported-run__banner"))
        .toHaveText("Unverified imported run");
      await expect(importedRunCard(page, "queue depth is the root cause").getByRole("button", { name: "Save review" }))
        .toBeVisible();
      const after = await listedRuns(page, caseId);
      expect(after.find((run) => run.id === focused.id)?.corroborationState).toBe(corroborationBefore);
      expect(after.find((run) => run.id === other.id)?.corroborationState).toBe("unverified");
      expect(traffic.posts).toHaveLength(1);
      expect(traffic.corroborationWrites).toHaveLength(0);
    } finally {
      traffic.stop();
    }
  });

  test("keeps history readable for a projected no-write session without emitting judgment writes", async ({ page }) => {
    test.setTimeout(120_000);
    const dave = FIXTURE_USERS.dave;
    const recordedRationale = "Read access should still show this recorded reading.";
    await loginAs(page, dave);
    await chooseWarRoom(page, dave.username);
    const title = uniqueTitle("Imported-run assessment readonly");
    const { caseId, focused, other } = await establishImportedInvestigation(page, title);
    await recordJudgmentViaPublicApi(page, caseId, focused.id, recordedRationale);
    const me = await page.request.get("/api/auth/me");
    expect(me.ok(), await me.text()).toBeTruthy();
    const session = await me.json() as {
      capabilities?: string[];
      roles?: string[];
    };
    expect(session.roles, "this journey must not fabricate a viewer role").toEqual(["admin"]);
    expect(session.capabilities).toContain("investigation:read");
    expect(session.capabilities).toContain("investigation:write");
    const noWriteCapabilities = (session.capabilities ?? [])
      .filter((capability) => capability !== "investigation:write");
    expect(noWriteCapabilities).toContain("investigation:read");
    expect(noWriteCapabilities).not.toContain("investigation:write");
    const traffic = captureJudgmentTraffic(page, caseId, focused.id);

    try {
      await page.route("**/api/auth/me", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...session, capabilities: noWriteCapabilities }),
        });
      });
      await page.goto(captureFocusPath(caseId, focused.id));
      expectCanonicalCaptureFocus(page, caseId, focused.id);
      await expectAssessmentsMountedFor(
        page,
        "queue depth is the root cause",
        "DNS NXDOMAIN",
        { saveReview: false },
      );
      const panel = assessmentsPanel(page);
      await expect(panel.getByText(recordedRationale)).toBeVisible();
      await expect(panel.getByText("Insufficient evidence")).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Record an assessment" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Record assessment" })).toHaveCount(0);
      await expect(panel.getByRole("radio", { name: "Insufficient evidence" })).toHaveCount(0);
      await expect(panel.getByText("Assessment writing unavailable")).toBeVisible();
      await expect.poll(() => traffic.gets.length).toBeGreaterThan(0);
      expect(traffic.posts).toEqual([]);
      expect(traffic.corroborationWrites).toEqual([]);

      const protectedReadGets: string[] = [];
      const recordGets = (request: Request) => {
        const url = new URL(request.url());
        if (
          request.method() === "GET"
          && (
            url.pathname === "/api/cases"
            || url.pathname.startsWith(`/api/cases/${caseId}`)
          )
        ) {
          protectedReadGets.push(url.pathname);
        }
      };
      await page.unroute("**/api/auth/me");
      await page.route("**/api/auth/me", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...session, capabilities: [] }),
        });
      });
      page.on("request", recordGets);
      try {
        await page.goto("/investigations");
        await page.goto(captureFocusPath(caseId, focused.id));
        await expect(page.getByRole("heading", {
          name: "Investigations unavailable in this view",
        })).toBeVisible();
        await expect(page.getByText(/no investigation or evidence data was requested/iu)).toBeVisible();
        await expect(page.getByText(recordedRationale)).toHaveCount(0);
        await expect(humanAssessmentsHeading(page)).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Record an assessment" })).toHaveCount(0);
        expect(
          protectedReadGets,
          "a no-read session still requested investigation, evidence, or assessment data",
        ).toEqual([]);
        expect(traffic.posts).toEqual([]);
      } finally {
        page.off("request", recordGets);
        await page.unroute("**/api/auth/me");
      }
    } finally {
      traffic.stop();
      await page.unroute("**/api/auth/me");
    }
  });

  test("retries a 503 unknown outcome only after an explicit history refresh", async ({ page }) => {
    test.setTimeout(120_000);
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await chooseWarRoom(page, dave.username);
    const title = uniqueTitle("Imported-run assessment retry");
    const { caseId, focused } = await establishImportedInvestigation(page, title);
    const traffic = captureJudgmentTraffic(page, caseId, focused.id);
    let applyCount = 0;
    let retryEnvelope: Record<string, unknown> | null = null;
    await page.route("**/api/cases/**/judgments", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "POST" || !isJudgmentRoute(url, caseId, focused.id)) {
        await route.continue();
        return;
      }
      applyCount += 1;
      if (applyCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify(UNKNOWN_OUTCOME_BODY),
        });
        return;
      }
      const response = await route.fetch();
      retryEnvelope = await response.json() as Record<string, unknown>;
      await route.fulfill({ response });
    });

    try {
      await page.goto(captureFocusPath(caseId, focused.id));
      expectCanonicalCaptureFocus(page, caseId, focused.id);
      const panel = assessmentsPanel(page);
      await expect(panel.getByText("No human assessment has been recorded yet.")).toBeVisible();
      await panel.getByRole("radio", { name: "Insufficient evidence" }).check();
      await panel.getByRole("textbox", { name: "Rationale (optional)" }).fill(RATIONALE);
      await expect(panel.getByRole("button", { name: "Retry loading assessments" })).toHaveCount(0);
      await panel.getByRole("button", { name: "Record assessment" }).click();

      const problem = panel.getByRole("group", { name: "Assessment submission problem" });
      await expect(problem).toBeVisible();
      await expect(problem).toBeFocused();
      await expect(panel.getByRole("alert")).toContainText("Assessment outcome unknown");
      await expect(panel.getByRole("alert")).toContainText("may have been recorded");
      await expect(panel.getByText("Refresh required")).toBeVisible();
      await expect(panel.getByRole("radio", { name: "Insufficient evidence" })).toBeChecked();
      await expect(panel.getByRole("radio", { name: "Insufficient evidence" })).toBeDisabled();
      await expect(panel.getByRole("textbox", { name: "Rationale (optional)" })).toHaveValue(RATIONALE);
      await expect(panel.getByRole("textbox", { name: "Rationale (optional)" })).toBeDisabled();
      await expect(panel.getByRole("button", { name: "Retry loading assessments" })).toHaveCount(0);
      const retry = panel.getByRole("button", { name: "Retry unchanged assessment" });
      const refresh = panel.getByRole("button", { name: "Refresh recorded assessments" });
      await expect(refresh).toBeVisible();
      await expect(retry).toBeVisible();
      await expect(retry).toBeDisabled();
      expect(traffic.posts).toHaveLength(1);
      expectInsufficientEvidenceRequest(traffic.posts[0]!.body, caseId, focused.id, RATIONALE);
      const firstRaw = traffic.posts[0]!.raw;
      expect(firstRaw).toBe(JSON.stringify(traffic.posts[0]!.body));
      await page.waitForTimeout(300);
      expect(traffic.posts, "the UI retried an unknown outcome without an explicit user action").toHaveLength(1);
      expect(applyCount).toBe(1);

      const refreshGet = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET" && isJudgmentRoute(url, caseId, focused.id);
      });
      await refresh.click();
      const listResponse = await refreshGet;
      expect(listResponse.ok(), await listResponse.text()).toBeTruthy();
      const listBody = await listResponse.json() as {
        schemaId?: string;
        caseId?: string;
        runId?: string;
        judgments?: unknown[];
      };
      expect(listBody).toEqual({
        schemaId: JUDGMENT_LIST_SCHEMA_ID,
        caseId,
        runId: focused.id,
        judgments: [],
      });
      expect(traffic.posts).toHaveLength(1);
      await expect(retry).toBeEnabled();
      await expect(panel.getByRole("textbox", { name: "Rationale (optional)" })).toHaveValue(RATIONALE);
      await expect(panel.getByRole("textbox", { name: "Rationale (optional)" })).toBeDisabled();
      await expect(panel.getByRole("radio", { name: "Insufficient evidence" })).toBeChecked();
      await expect(panel.getByRole("radio", { name: "Insufficient evidence" })).toBeDisabled();
      await expect(panel.getByText("No human assessment has been recorded yet.")).toBeVisible();

      const retried = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST" && isJudgmentRoute(url, caseId, focused.id);
      });
      await retry.click();
      const retryResponse = await retried;
      expect(retryResponse.ok(), await retryResponse.text()).toBeTruthy();
      await expect.poll(() => traffic.posts.length).toBe(2);
      expect(applyCount).toBe(2);
      expect(traffic.posts[1]!.raw).toBe(firstRaw);
      expect(traffic.posts[1]!.body).toEqual(traffic.posts[0]!.body);
      expect(retryEnvelope).toMatchObject({
        schemaId: JUDGMENT_SUCCESS_SCHEMA_ID,
        caseId,
        runId: focused.id,
        replayed: false,
        applied: {
          schemaId: JUDGMENT_SCHEMA_ID,
          caseId,
          runId: focused.id,
          seq: 1,
          judgment: "insufficient_evidence",
          links: [],
          rationale: RATIONALE,
          actor: { username: dave.username },
        },
        run: {
          id: focused.id,
          caseId,
        },
      });
      await expect(panel.getByText("The assessment was recorded.")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Retry unchanged assessment" })).toHaveCount(0);
      const historyItems = panel.locator(".strategy-kit__human-assessments-item");
      await expect(historyItems).toHaveCount(1);
      await expect(historyItems.getByText("Insufficient evidence")).toBeVisible();
      await expect(historyItems.getByText(RATIONALE)).toBeVisible();
      await expect(panel.getByText("No human assessment has been recorded yet.")).toHaveCount(0);
      await expect(importedRunCard(page, "queue depth is the root cause").locator(".imported-run__banner"))
        .toHaveText("Unverified imported run");
      expect(traffic.posts).toHaveLength(2);
      expect(traffic.corroborationWrites).toHaveLength(0);
    } finally {
      await page.unroute("**/api/cases/**/judgments");
      traffic.stop();
    }
  });
});
