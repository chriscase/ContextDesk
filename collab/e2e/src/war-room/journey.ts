/**
 * Shared moves for the War Room scenario journeys.
 *
 * These wrap existing product routes only. Nothing here reaches past the API
 * the shipped web shell itself calls, so a journey that passes here is evidence
 * about the product rather than about a test-only back door.
 */
import { expect, type Page } from "@playwright/test";
import { BROWSER_MUTATION_HEADERS } from "../helpers.js";
import { deepLink, scenario, type ScenarioId } from "./scenarios.js";
import type { ScenarioRecorder } from "./acceptance.js";

export interface TimelineEventView {
  seq: number;
  kind: string;
  actorUsername: string;
  targetId: string | null;
  clientTime: string | null;
  serverTime: string;
  payload: string;
}

/** Raw timeline, including the client/server time split the journeys assert on. */
export async function timelineEvents(page: Page, caseId: string): Promise<TimelineEventView[]> {
  const res = await page.request.get(`/api/cases/${caseId}/timeline`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { events?: TimelineEventView[] };
  return body.events ?? [];
}

export interface ContributionAttempt {
  status: number;
  error: string | null;
  id: string | null;
}

/**
 * Post a timeline contribution, optionally asserting an event time.
 *
 * Returns the outcome instead of throwing, because several journeys are
 * specifically about a refusal being visible and well-reasoned.
 */
export async function postContribution(
  page: Page,
  caseId: string,
  input: { kind: "note" | "hypothesis" | "action" | "message"; body: string; clientTime?: string },
): Promise<ContributionAttempt> {
  const res = await page.request.post(`/api/cases/${caseId}/contributions`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: {
      kind: input.kind,
      body: input.body,
      ...(input.clientTime === undefined ? {} : { clientTime: input.clientTime }),
    },
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  return {
    status: res.status(),
    error: typeof parsed.error === "string" ? parsed.error : null,
    id: typeof parsed.id === "string" ? parsed.id : null,
  };
}

/**
 * Open one of a scenario's declared deep links and record that the journey
 * actually went there, so an unopened address fails the acceptance run.
 */
export async function openDeepLink(
  page: Page,
  recorder: ScenarioRecorder,
  linkId: string,
  values: Readonly<Record<string, string>> = {},
): Promise<string> {
  const target = scenario(recorder.scenarioId).deepLinks.find((row) => row.id === linkId);
  if (!target) {
    throw new Error(`scenario ${recorder.scenarioId} declares no deep link ${linkId}`);
  }
  const url = deepLink(target, values);
  await page.goto(url);
  recorder.recordDeepLink(linkId, url);
  return url;
}

/**
 * Open the Capture stage's timeline disclosure, which starts collapsed.
 *
 * The disclosure is React-controlled: `open` is bound to component state and
 * driven by `onToggle`. A click can therefore be swallowed before the stage
 * finishes mounting, and an already-open disclosure can be snapped shut again
 * by a concurrent re-render (the stage refreshes activity and presence on its
 * own schedule). So poll on the condition that actually matters — the event
 * list being on screen — rather than on the attribute the click sets, and keep
 * asking until it stays.
 */
export async function openTimeline(page: Page): Promise<void> {
  const timeline = page.locator("details.triage-record__timeline");
  await expect(timeline).toBeVisible();
  const events = timeline.locator(".triage-record__scroll");
  await expect
    .poll(
      async () => {
        if (await events.isVisible()) return true;
        await timeline.locator("summary").first().click();
        return events.isVisible();
      },
      { timeout: 15_000, message: "the Capture timeline event list never stayed open" },
    )
    .toBe(true);
}

/**
 * Bring one contribution's timeline entry on screen and return it.
 *
 * Wraps `openTimeline` in the same converge-don't-assume loop, because the
 * disclosure can close between opening it and reading an entry inside it.
 */
export async function showTimelineEntry(page: Page, contributionId: string) {
  const entry = timelineEntry(page, contributionId);
  await expect
    .poll(
      async () => {
        if (await entry.isVisible()) return true;
        await openTimeline(page);
        return entry.isVisible();
      },
      {
        timeout: 15_000,
        message: `timeline entry for contribution ${contributionId} never became visible`,
      },
    )
    .toBe(true);
  return entry;
}

/**
 * Expand one timeline entry's audit block, where client time and server time
 * are shown side by side. `match` selects the entry by any text it contains, so
 * a journey names the record it means instead of trusting list order.
 */
export async function openAuditDetails(
  page: Page,
  match: string | RegExp,
): Promise<ReturnType<Page["locator"]>> {
  await openTimeline(page);
  const entry = page.locator("li.timeline__item").filter({ hasText: match }).first();
  await expect(entry, `no timeline entry matching ${String(match)}`).toBeVisible();
  const audit = entry.locator("details.triage-record__audit");
  if ((await audit.getAttribute("open")) === null) {
    await audit.locator("summary").click();
  }
  await expect(audit).toHaveAttribute("open", "");
  return audit;
}

/** The scenario's declared triage question, for use in test titles. */
export function question(id: ScenarioId): string {
  return scenario(id).triageQuestion;
}

/**
 * The evidence-board row for one artifact, by the name shown in bold.
 */
export function evidenceRow(page: Page, filename: string) {
  return page.locator("#stage-analyze .case-memory__list > li").filter({ hasText: filename });
}

/**
 * Open an artifact's inline viewer and return its two reading surfaces.
 *
 * The viewer shows a short preview of the lines it judged interesting, and
 * keeps the complete text behind an "Expand complete log" disclosure. Both are
 * in the DOM at once, so journeys must say which one they mean: `preview` is
 * "what a responder sees without doing anything", `full` is "what is there if
 * they ask for all of it".
 */
export async function inspectEvidence(
  page: Page,
  filename: string,
): Promise<{ row: ReturnType<typeof evidenceRow>; preview: ReturnType<typeof evidenceRow> }> {
  const row = evidenceRow(page, filename);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Inspect log" }).click();
  const preview = row.locator("ol.log-viewer__lines--preview");
  await expect(preview).toBeVisible();
  return { row, preview };
}

/**
 * Expand the complete text of an already-inspected artifact and return the
 * full line list. Used when the material a responder needs is deliberately
 * outside the viewer's error-line preview — correspondence, for instance.
 */
export async function expandFullLog(row: ReturnType<typeof evidenceRow>) {
  const disclosure = row.locator("details").filter({ hasText: "Expand complete log" });
  await expect(disclosure).toBeVisible();
  if ((await disclosure.getAttribute("open")) === null) {
    await disclosure.locator("summary").click();
  }
  await expect(disclosure).toHaveAttribute("open", "");
  return disclosure.locator("ol.log-viewer__lines");
}

/** The timeline entry for one contribution id, addressed the way routes are. */
export function timelineEntry(page: Page, contributionId: string) {
  return page.locator(`li.timeline__item[data-route-item="${contributionId}"]`);
}

/** Open the audit block of one contribution's timeline entry. */
export async function openAuditDetailsFor(page: Page, contributionId: string) {
  const entry = await showTimelineEntry(page, contributionId);
  const audit = entry.locator("details.triage-record__audit");
  if ((await audit.getAttribute("open")) === null) {
    await audit.locator("summary").click();
  }
  await expect(audit).toHaveAttribute("open", "");
  return audit;
}

/**
 * Grant another fixture person access to this investigation, using the same
 * participants route the shipped shell uses. Requires a case-lead or admin
 * session, which is exactly the constraint the product places on it.
 */
export async function addParticipant(
  page: Page,
  caseId: string,
  person: { identityId: string; username: string },
): Promise<void> {
  const res = await page.request.post(`/api/cases/${caseId}/participants`, {
    headers: BROWSER_MUTATION_HEADERS,
    data: { identityId: person.identityId, username: person.username },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

export interface SnapshotView {
  id: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  evidence: unknown[];
}

/**
 * Select the named evidence on the Analyze board and freeze it, returning the
 * snapshot the product created. Journeys use this rather than an API shortcut
 * because freezing is one of the moves a responder actually performs.
 */
export async function freezeEvidence(page: Page, filenames: string[]): Promise<SnapshotView> {
  const analyze = page.locator("#stage-analyze");
  for (const filename of filenames) {
    await analyze.getByRole("checkbox", { name: `Include ${filename} in snapshot` }).check();
  }
  const [frozen] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
    ),
    analyze.getByRole("button", { name: `Freeze selected evidence (${filenames.length})` }).click(),
  ]);
  return (await frozen.json()) as SnapshotView;
}

export interface TriageRunView {
  id: string;
  snapshotId: string;
  snapshotFingerprint: string;
  status: string;
  candidates: Array<{
    candidateId: string;
    model: string;
    status: string;
    errorCode: string | null;
    summary: string | null;
    evidenceRefs: string[];
    usageStatus: string;
    costStatus: string;
    unknowns: string[];
  }>;
}

/** Launch the provider-free synthetic comparison bound to the current snapshot. */
export async function runSyntheticComparison(page: Page, caseId: string): Promise<string> {
  const analyze = page.locator("#stage-analyze");
  const [launched] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/cases/${caseId}/triage-runs`)
        && res.request().method() === "POST"
        && res.ok(),
    ),
    analyze.getByRole("button", { name: "Run synthetic comparison" }).click(),
  ]);
  const job = (await launched.json()) as { id: string };
  await expect(
    analyze.locator(`[id="triage-run-${job.id}"] .triage-runs__status--completed`),
  ).toBeVisible({ timeout: 30_000 });
  return job.id;
}

/** Current run history straight from the API, for lineage assertions. */
export async function triageRuns(page: Page, caseId: string): Promise<TriageRunView[]> {
  const res = await page.request.get(`/api/cases/${caseId}/triage-runs`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { jobs?: TriageRunView[] };
  return body.jobs ?? [];
}
