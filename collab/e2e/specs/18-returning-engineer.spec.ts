import { expect, test, type Page } from "@playwright/test";
import {
  addTimelineEntry,
  caseIdForTitle,
  createCase,
  fixtureBytes,
  fixtureText,
  gotoStage,
  importChat,
  loginAs,
  stagePanel,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

/**
 * An engineer comes back to an investigation somebody else was working and has
 * to re-form a picture of it: what is suspected, what is outstanding, what the
 * logs actually say, what the model-assisted lanes produced, and how to send a
 * colleague to the exact record.
 *
 * Everything here is synthetic fixture material the test creates itself. Runs
 * are the deterministic offline executor: no provider is contacted.
 */

const dave = FIXTURE_USERS.dave;

const OBSERVATION =
  "Pager fired at 02:14 UTC: synthetic checkout p99 went from 400ms to 9s on the syn-west tier.";
const HYPOTHESIS =
  "The synthetic payment pool exhausts after each upstream retry storm, so later requests queue.";
const NEXT_ACTION =
  "Count distinct synthetic retry attempts per request id in the frozen worker log.";

/** A long stack trace and a two-line log — the small and large evidence cases. */
const LONG_TRACE = fixtureBytes("evidence", "checkout-timeout-trace.log");
const SHORT_LOG = fixtureBytes("evidence", "shared-timeout.log");

async function seedInvestigation(page: Page, title: string): Promise<string> {
  await createCase(page, title);
  const caseId = await caseIdForTitle(page, title);
  await addTimelineEntry(page, "note", OBSERVATION);
  await addTimelineEntry(page, "hypothesis", HYPOTHESIS);
  await addTimelineEntry(page, "action", NEXT_ACTION);
  await importChat(page, {
    output: fixtureText("chats", "external-triage-a.txt"),
    prompt: "Triage the synthetic checkout latency using only the pasted log facts.",
    sourceLabel: SEEDED_SOURCES.chatA,
    operatorUsername: dave.username,
    operatorId: dave.identityId,
    visibility: "importer_described",
  });
  await uploadEvidence(page, caseId, {
    kind: "log",
    summary: "Synthetic checkout timeout log with the failing stack trace.",
    filename: "checkout-timeout-trace.log",
    mediaType: "text/plain",
    bytes: LONG_TRACE,
    privacyClass: "share_safe",
  });
  await uploadEvidence(page, caseId, {
    kind: "log",
    summary: "Two-line synthetic worker timeout excerpt.",
    filename: "shared-timeout.log",
    mediaType: "text/plain",
    bytes: SHORT_LOG,
    privacyClass: "share_safe",
  });
  // The board mounted before those API uploads, so re-read the shipped surface.
  await page.reload();
  return caseId;
}

/** Freeze the long trace and run the offline multi-lane comparison over it. */
async function runLanes(page: Page): Promise<void> {
  await gotoStage(page, "Analyze");
  await page
    .getByRole("checkbox", { name: "Include checkout-timeout-trace.log in snapshot" })
    .check();
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
    ),
    page.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
  ]);
  await page.getByRole("checkbox", { name: /gpt-oss-120b .*contributor/ }).check();
  await page.getByRole("checkbox", { name: /ministral-3-14b-instruct-2512 .*challenger/ }).check();
  await page.getByRole("button", { name: "Run synthetic triage" }).click();
  await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("a returning engineer re-forms the picture", () => {
  test("reads what is suspected, outstanding, seen, and still unverified without leaving Situation", async ({
    page,
  }) => {
    const title = uniqueTitle("Returning engineer");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await gotoStage(page, "Situation");

    const briefing = stagePanel(page, "Situation").getByRole("region", {
      name: "Where the investigation stands",
    });
    await expect(briefing).toBeVisible();

    // The substance of the record, not a count of it.
    await expect(briefing.getByText(HYPOTHESIS)).toBeVisible();
    await expect(briefing.getByText(NEXT_ACTION)).toBeVisible();
    await expect(briefing.getByText(OBSERVATION)).toBeVisible();

    // A hypothesis is never presented as a cause.
    await expect(briefing).toContainText("A hypothesis is not an established cause");

    // Imported output is separated and never labeled as a human finding.
    const imported = briefing.getByRole("region", {
      name: /Imported analysis awaiting a human read/,
    });
    await expect(imported).toContainText("queue depth is the root cause");
    await expect(imported).toContainText("imported · unverified");
    await expect(imported).not.toContainText("human-authored");

    // Registered evidence is restated, with a way through to the board.
    await expect(briefing).toContainText("2 items registered");
    await briefing.getByRole("button", { name: "Open the evidence board" }).click();
    await expect(page).toHaveURL(/\/analyze\?section=triage-evidence-board/);
    await expect(stagePanel(page, "Analyze")).toBeVisible();
  });

  test("opens the exact record a briefing entry names", async ({ page }) => {
    const title = uniqueTitle("Briefing handoff");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await gotoStage(page, "Situation");

    const briefing = stagePanel(page, "Situation").getByRole("region", {
      name: "Where the investigation stands",
    });
    const hypotheses = briefing.getByRole("region", { name: /Working hypotheses/ });
    await hypotheses.getByRole("button", { name: "Open where this was recorded" }).click();

    // Capture opens on the recorded contribution, addressably.
    await expect(page).toHaveURL(/\/capture\?section=triage-capture&item=[^&]+&kind=contribution/);
    await expect(
      stagePanel(page, "Capture").getByLabel("Case timeline events").getByText(HYPOTHESIS),
    ).toBeVisible();
  });

  test("keeps a long trace bounded, expandable, and copyable next to a short log", async ({
    page,
  }) => {
    const title = uniqueTitle("Evidence scale");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await runLanes(page);

    // The provider-free simulation truthfully cites no evidence. Inspect the
    // registered artifact itself rather than pretending a simulated lane read it.
    const evidenceItem = page
      .locator(".case-memory__item")
      .filter({ hasText: "checkout-timeout-trace.log" });
    await evidenceItem.getByRole("button", { name: "Inspect log" }).click();

    // The long trace is previewed with its real scale stated, not silently cut.
    const disclosure = evidenceItem
      .locator("details")
      .filter({ hasText: "Expand complete log or stack trace" })
      .first();
    const fullLines = LONG_TRACE.toString("utf8").split(/\r?\n/).length;
    await expect(disclosure).toContainText(`${fullLines} lines`);
    // Collapsed, the complete text is present but not shown to the reader.
    await expect(disclosure.locator(".log-viewer__lines")).toBeHidden();

    // Reading the whole thing is one keyboard-reachable disclosure away.
    await disclosure.locator("summary").press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator(".log-viewer__lines")).toContainText(
      "waited 22000ms on inventory-client",
    );

    // A background refresh must not discard what the reader expanded.
    await page.waitForTimeout(2500);
    await expect(disclosure).toHaveAttribute("open", "");
  });

  test("reads every lane as work, names unknowns, and never claims a human finding", async ({
    page,
  }) => {
    const title = uniqueTitle("Lane reading");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await runLanes(page);

    const analyze = stagePanel(page, "Analyze");
    const lanes = analyze.locator("a.workstreams__card-open");
    await expect(lanes).toHaveCount(3);

    await lanes.first().click();
    const detail = page.locator("article.workstreams__detail");
    // The offline workflow exercise never masquerades as model analysis or a
    // human finding.
    await expect(detail).toContainText("No written finding was recorded");
    await expect(detail).toContainText("no investigative finding or evidence citation");
    // What it left unknown is stated rather than implied to be nothing.
    await expect(detail.getByRole("heading", { name: "What it left unknown" })).toBeVisible();
    await expect(detail).toContainText("cost");
    // Its history reads in order.
    await expect(detail.getByRole("heading", { name: "What happened, in order" })).toBeVisible();
    await expect(detail).toContainText("Run queued");
  });

  test("shares one lane by address, and that address reopens it after a reload", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const title = uniqueTitle("Lane sharing");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await runLanes(page);

    await page.locator("a.workstreams__card-open").first().click();
    const detail = page.locator("article.workstreams__detail");
    const laneName = await detail.getByRole("heading").first().innerText();

    await page.getByRole("button", { name: "Copy link to this workstream" }).click();
    await expect(page.getByText(/it is not an access grant/)).toBeVisible();
    const shared = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(shared).searchParams.get("kind")).toBe("workstream");

    // A colleague opening that address lands on the same lane, not the list.
    await page.goto(shared);
    await expect(page.locator("article.workstreams__detail")).toBeVisible();
    await expect(page.locator("article.workstreams__detail").getByRole("heading").first()).toHaveText(
      laneName,
    );
    // Back returns to where they came from without losing the investigation.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp("/investigations/"));
  });

  test("fails closed on a lane address this investigation does not have", async ({ page }) => {
    const title = uniqueTitle("Missing lane");
    await loginAs(page, dave);
    const caseId = await seedInvestigation(page, title);
    await runLanes(page);

    await page.goto(
      `/investigations/${caseId}/analyze?section=workstreams&item=absent%3Alane&kind=workstream&lane=absent%3Alane#workstreams`,
    );
    const analyze = stagePanel(page, "Analyze");
    await expect(analyze).toContainText(
      "That workstream is not part of this investigation, or it is no longer available to your account",
    );
    // Nothing else was silently opened in its place.
    await expect(page.locator("article.workstreams__detail")).toHaveCount(0);
    await expect(analyze.getByRole("link", { name: "Back to all workstreams" })).toBeVisible();
  });

  test("the operating picture names stage, provenance, and what is still open", async ({
    page,
  }) => {
    const title = uniqueTitle("Operating picture");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await runLanes(page);

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Overview", exact: true })
      .click();

    const feed = page.locator(".activity-feed");
    await expect(feed).toBeVisible();
    // Work recorded in Analyze reaches the picture without a manual reload.
    await expect(feed).toContainText("completed a workstream");
    await expect(feed).toContainText("Stage: Analyze");
    // Provenance is explicit for human and for model-assisted work alike.
    await expect(feed.getByText("human-authored").first()).toBeVisible();
    await expect(feed.getByText(/not a human finding/).first()).toBeVisible();

    // Imported output nobody has read is called out, with a path to it.
    const threads = page.getByRole("complementary", { name: "Open threads" });
    await expect(threads).toContainText("Imported or AI output not yet read");
    await expect(threads).toContainText("most recent recorded events");
    await threads.getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp("/investigations/"));
  });

  test("stays readable and operable by keyboard on a narrow viewport", async ({ page }) => {
    const title = uniqueTitle("Narrow briefing");
    await loginAs(page, dave);
    await seedInvestigation(page, title);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoStage(page, "Situation");

    const briefing = stagePanel(page, "Situation").getByRole("region", {
      name: "Where the investigation stands",
    });
    await expect(briefing.getByText(HYPOTHESIS)).toBeVisible();

    // Every briefing control is reachable and operable from the keyboard.
    const open = briefing.getByRole("button", { name: "Open where this was recorded" }).first();
    await open.focus();
    await expect(open).toBeFocused();
    await open.press("Enter");
    await expect(page).toHaveURL(/\/capture\?section=triage-capture/);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
