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
  openCase,
  uniqueTitle,
  stagePanel,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";

interface SnapshotRow {
  id: string;
  fingerprint: string;
  fairnessClass: string;
  parentSnapshotId: string | null;
  evidence: { evidenceId: string }[];
}

interface ShareSafeExportBody {
  privacyClass?: string;
  review?: {
    snapshotAlias?: string;
    snapshotProof?: {
      basis?: string;
      fairnessClass?: string;
      lineageClass?: string;
      parentSnapshotAlias?: string | null;
    };
    decision?: { status?: string; revision?: number } | null;
    candidates?: unknown[];
    omissions?: {
      modelLabelsIncluded?: boolean;
      participantIdentitiesIncluded?: boolean;
      freeTextIncluded?: boolean;
      privateContentIncluded?: boolean;
      correlatableMetadataIncluded?: boolean;
    };
  };
}

const STAGES = ["situation", "capture", "analyze", "compare", "decide"] as const;

async function expectFocusedStage(
  page: Page,
  stage: (typeof STAGES)[number],
): Promise<void> {
  for (const candidate of STAGES) {
    const panel = page.locator(`#stage-${candidate}`);
    if (candidate === stage) await expect(panel).toBeVisible();
    else await expect(panel).toBeHidden();
  }
}

test.describe("complete war-room operator journey", () => {
  test("captures, imports, freezes, compares, decides, exports, and reloads on shipped controls", async ({
    page,
  }) => {
    const title = uniqueTitle("Operator journey");
    const dave = FIXTURE_USERS.dave;
    const humanNote = "On-call observation from the pager: mailer timeouts around syn-1.";
    const acceptedText =
      "Inspect the frozen mailer worker log before changing retries; lane agreement is not proof.";
    const acceptedRationale =
      "Human decision after reading the imported paste and the same-snapshot synthetic lanes.";

    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    // The command center presents one focused surface at a time. Start from
    // the shared picture, then deliberately move through the operator flow.
    await gotoStage(page, "Situation");
    await expectFocusedStage(page, "situation");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "Investigations",
    );
    await expect(page.locator("h2.case-view__title")).toHaveText(title);
    await expect(page.locator("#stage-situation").getByRole("heading", { name: "Situation" })).toBeVisible();

    await addTimelineEntry(page, "note", humanNote);
    await expectFocusedStage(page, "capture");
    // Situation restates the same note, so name the stage under test.
    const capture = stagePanel(page, "Capture");
    await expect(capture.getByText("human-authored").first()).toBeVisible();
    await expect(capture.getByText(humanNote)).toBeVisible();

    await importChat(page, {
      output: fixtureText("chats", "external-triage-a.txt"),
      prompt: "Triage the mailer timeout using only the pasted log facts.",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
      visibility: "importer_described",
    });
    const imported = page
      .locator(".imported-run")
      .filter({ hasText: "queue depth is the root cause" });
    await expect(imported.locator(".imported-run__banner")).toHaveText("Unverified imported run");
    await expect(imported).toContainText("Fixture chat assistant");
    await expect(imported).toContainText("From Fixture chat assistant");
    await expect(imported.getByText("Prompt and import details")).toBeVisible();
    await expect(imported).not.toContainText("human-authored");
    await expect(capture.getByText("imported output").first()).toBeVisible();
    await expect(capture.getByText("imported · unverified").first()).toBeVisible();
    await expect(capture.getByText(/\d+ human (entry|entries)/)).toBeVisible();
    await expect(capture.getByText(/1 imported run/)).toBeVisible();

    await gotoStage(page, "Analyze");
    await expectFocusedStage(page, "analyze");

    const sharedFile = page.locator("#case-evidence-file");
    await sharedFile.setInputFiles({
      name: "shared-timeout.log",
      mimeType: "text/plain",
      buffer: fixtureBytes("evidence", "shared-timeout.log"),
    });
    await page.locator(".case-memory__upload-form").getByLabel("Summary").fill("Shared timeout log pasted from the worker host.");
    await page.locator(".case-memory__upload-form").getByLabel("Artifact kind").selectOption("log");
    await page.locator(".case-memory__upload-form").getByLabel("Privacy class").selectOption("share_safe");
    const [sharedPosted] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/api/cases/") &&
          res.url().endsWith("/evidence") &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Upload evidence" }).click(),
    ]);
    expect(sharedPosted.ok(), await sharedPosted.text()).toBeTruthy();
    await expect(page.getByText("shared-timeout.log", { exact: true })).toBeVisible();
    await expect(page.getByText("share_safe", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy content hash for shared-timeout.log" }),
    ).toBeAttached();

    await page.locator("#case-evidence-file").setInputFiles({
      name: "unique-worker.log",
      mimeType: "text/plain",
      buffer: fixtureBytes("evidence", "unique-worker.log"),
    });
    await page.locator(".case-memory__upload-form").getByLabel("Summary").fill("Owner-only worker log kept off the share-safe snapshot.");
    await page.locator(".case-memory__upload-form").getByLabel("Artifact kind").selectOption("log");
    await page.locator(".case-memory__upload-form").getByLabel("Privacy class").selectOption("owner_only");
    const [uniquePosted] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/api/cases/") &&
          res.url().endsWith("/evidence") &&
          res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Upload evidence" }).click(),
    ]);
    expect(uniquePosted.ok(), await uniquePosted.text()).toBeTruthy();
    await expect(page.getByText("unique-worker.log", { exact: true })).toBeVisible();
    await expect(page.getByText("owner_only", { exact: true }).first()).toBeVisible();
    // No truncated digest leads any card on the board.
    await expect(page.getByText(/hash [0-9a-f]{12}…/)).toHaveCount(0);

    const includeShared = page.getByRole("checkbox", {
      name: "Include shared-timeout.log in snapshot",
    });
    await includeShared.check();
    await expect(
      page.getByRole("checkbox", { name: "Include unique-worker.log in snapshot" }),
    ).not.toBeChecked();
    const [frozen] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/snapshots") && res.request().method() === "POST" && res.ok(),
      ),
      page.getByRole("button", { name: "Freeze selected evidence (1)" }).click(),
    ]);
    const frozenBody = (await frozen.json()) as SnapshotRow;
    expect(frozenBody.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(frozenBody.fairnessClass).toBe("same_snapshot");
    expect(frozenBody.parentSnapshotId).toBeNull();
    expect(frozenBody.evidence).toHaveLength(1);
    const shortFp = `${frozenBody.fingerprint.slice(0, 12)}…`;
    await expect(page.getByRole("heading", { name: "Snapshot lineage" })).toBeVisible();
    await expect(page.getByText(/1 items ·/)).toBeVisible();
    await expect(page.getByText(/Runs bound to a snapshot never silently widen/)).toBeVisible();
    await expect(page.locator(".case-memory__snapshot small")).toHaveText(shortFp);

    const snapshotsRes = await page.request.get(`/api/cases/${caseId}/snapshots`);
    expect(snapshotsRes.ok(), await snapshotsRes.text()).toBeTruthy();
    const snapshots = ((await snapshotsRes.json()) as { snapshots?: SnapshotRow[] }).snapshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.fingerprint).toBe(frozenBody.fingerprint);

    await expect(page.locator(".triage-runs__mode")).toHaveText("synthetic / offline");
    await expect(page.getByRole("button", { name: "Run synthetic comparison" })).toBeEnabled();
    await page.getByRole("button", { name: "Run synthetic comparison" }).click();
    await expect(page.locator(".triage-runs__status--completed").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Same frozen snapshot").first()).toBeVisible();
    // The run row states the same-snapshot proof in words. The exact
    // fingerprint stays available, in full, behind the row's identifiers
    // disclosure rather than truncated into the heading.
    const identifiers = page.locator("details.technical-id").first();
    await expect(identifiers).toBeVisible();
    await identifiers.locator("summary").click();
    await expect(identifiers.getByText(frozenBody.fingerprint, { exact: true })).toBeVisible();
    const analyze = page.locator("#stage-analyze");
    const completedLanes = analyze.locator(".triage-runs__job .triage-runs__candidate");
    await expect(completedLanes).toHaveCount(3);
    await expect(completedLanes.filter({ hasText: "qwen-3.6-27b" })).toContainText("settled");
    await expect(completedLanes.filter({ hasText: "gpt-oss-120b" })).toContainText("settled");
    await expect(
      completedLanes.filter({ hasText: "ministral-3-14b-instruct-2512" }),
    ).toContainText("settled");
    await expect(page.getByText(/usage unknown · cost unknown/).first()).toBeVisible();
    // Analyze now presents the same recorded lane twice: once as a readable
    // workstream and once in the technical run history. Assert each surface.
    await expect(
      completedLanes
        .getByText(/Provider-free simulation completed.*did not run the named model/)
        .first(),
    ).toBeVisible();
    await expect(
      analyze
        .locator(".workstreams__card")
        .getByText("No written finding recorded.")
        .first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Review in Experiment Lab" }).first().click();
    await expect(analyze.locator(".triage-runs__handoff-success")).toContainText(
      "ready in Compare, opened as the newest comparison",
      { timeout: 30_000 },
    );
    // The handoff takes the reader to the comparison it just created, rather
    // than announcing it is ready somewhere they still have to find.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toMatch(/\/compare$/);
    await expectFocusedStage(page, "compare");
    const compare = page.locator("#stage-compare");
    await expect(compare.getByText("Simulated qwen-3.6-27b (not executed)").first()).toBeVisible();
    await expect(compare.getByText("Shared evidence").first().locator("..")).toContainText("0");
    await expect(
      compare.locator(".experiment-lab__identity"),
    ).toContainText("exact frozen evidence binding");
    await expect(compare.getByText("Agreement is not proof of correctness.").first()).toBeVisible();
    await expect(compare.getByRole("heading", { name: "Investigative findings" })).toBeVisible();
    await expect(compare.getByRole("heading", { name: "What stays unknown" })).toBeVisible();
    await expect(compare.getByText("Unknown stays unknown until evidence resolves it.")).toBeVisible();
    const runDetails = compare.getByText(/Run details and evaluation coverage/).first();
    await expect(runDetails).toBeVisible();
    await runDetails.click();
    await expect(compare.getByText(/Run telemetry was not reported/)).toBeVisible();

    await gotoStage(page, "Decide");
    await expectFocusedStage(page, "decide");
    const decide = page.locator("#stage-decide");

    await decide.getByText("Propose a new human decision").click();
    await decide.getByPlaceholder("Proposed decision").fill(acceptedText);
    await decide.getByPlaceholder("Decision rationale").fill(acceptedRationale);
    await decide.getByRole("button", { name: "Propose decision" }).click();
    const decisionLine = decide.locator(
      ".experiment-lab__decision-card .experiment-lab__decision-line",
    );
    await expect(decisionLine).toContainText(`(proposed): ${acceptedText}`);
    await decide.getByText("Accept the proposed decision").click();
    await decide.getByRole("button", { name: "Accept decision" }).click();
    await expect(decisionLine).toContainText(`(accepted): ${acceptedText}`);
    await expect(
      decide.locator(".experiment-lab__decision-card .experiment-lab__decision-rationale"),
    ).toContainText(acceptedRationale);

    await decide.getByRole("button", { name: "Export share-safe review" }).click();
    await expect(decide.getByText("Share-safe export ready")).toBeVisible();
    await expect(decide.getByText(/accepted · revision \d+/)).toBeVisible();
    await decide.getByText("View raw export").click();
    const exportedText = await decide.locator(".experiment-lab__raw-export pre").innerText();
    const exported = JSON.parse(exportedText) as ShareSafeExportBody;
    expect(exported.privacyClass).toBe("share_safe");
    expect(exported.review?.decision?.status).toBe("accepted");
    expect(exported.review?.decision?.revision).toBeGreaterThanOrEqual(1);
    expect(exported.review?.snapshotAlias).toBe("snapshot-1");
    expect(exported.review?.snapshotProof).toEqual({
      basis: "host_frozen_snapshot",
      fairnessClass: "same_snapshot",
      lineageClass: "root",
      parentSnapshotAlias: null,
    });
    expect(exported.review?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(exported.review?.omissions).toEqual({
      modelLabelsIncluded: false,
      participantIdentitiesIncluded: false,
      freeTextIncluded: false,
      privateContentIncluded: false,
      correlatableMetadataIncluded: false,
    });
    expect(exportedText).not.toContain(dave.password);
    expect(exportedText).not.toContain(frozenBody.fingerprint);
    expect(exportedText).not.toContain(humanNote);
    expect(exportedText).not.toContain(acceptedText);
    await gotoStage(page, "Analyze");
    await expect(page.getByText("unique-worker.log", { exact: true })).toBeVisible();
    await expect(page.getByText("owner_only", { exact: true }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByText(`Signed in as ${dave.username}`)).toBeVisible();
    await openCase(page, title);
    await expectFocusedStage(page, "analyze");
    await expect(page.locator(".case-memory__snapshot small")).toHaveText(shortFp);
    await expect(page.getByText("Same frozen snapshot").first()).toBeVisible();
    await expect(completedLanes).toHaveCount(3);

    await gotoStage(page, "Capture");
    const captureAgain = stagePanel(page, "Capture");
    await captureAgain.locator("details.triage-record__timeline > summary").click();
    await expect(
      captureAgain.getByLabel("Case timeline events").getByText(humanNote),
    ).toBeVisible();
    await expect(captureAgain.getByText("human-authored").first()).toBeVisible();
    await expect(imported.locator(".imported-run__banner")).toHaveText("Unverified imported run");
    await expect(page.getByText("imported output").first()).toBeVisible();

    await gotoStage(page, "Decide");
    await expect(decisionLine).toContainText(`(accepted): ${acceptedText}`);
    await expect(decide.getByRole("heading", { name: "Accepted decision" })).toBeVisible();
  });
});
