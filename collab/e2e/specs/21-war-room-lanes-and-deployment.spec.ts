import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  exportPanel,
  gotoStage,
  loginAs,
  openCase,
  openExportSupport,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import { beginScenario } from "../src/war-room/acceptance.js";
import { warRoomBytes } from "../src/war-room/fixtures.js";
import {
  addParticipant,
  freezeEvidence,
  openDeepLink,
  postContribution,
  question,
  showTimelineEntry,
  triageRuns,
} from "../src/war-room/journey.js";

/**
 * War Room acceptance journeys 9–10: the run that did not go well, and the
 * difference between a private workstation and the shared service.
 *
 * Journey 9 needs the degraded bridge fixture, which reports one completed,
 * one partial, and one failed lane on the real host wire contract. It contacts
 * no provider and makes no quality claim; it exists so the shell can be
 * qualified against a comparison that is missing most of itself.
 */

test.describe("War Room lane and deployment journeys", () => {
  test(`partial and failed lanes: ${question("degraded-model-lanes")}`, async ({ page }) => {
    test.skip(
      process.env.COLLAB_E2E_BRIDGE !== "degraded",
      "set COLLAB_E2E_BRIDGE=degraded to run the mixed-outcome bridge fixture",
    );
    const record = beginScenario("degraded-model-lanes");
    const title = uniqueTitle("Degraded lanes");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log frozen for a comparison that will not finish cleanly.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    await freezeEvidence(page, ["mailer-offsetless.log"]);

    const analyze = page.locator("#stage-analyze");
    await analyze.getByRole("combobox", { name: "Execution mode" }).selectOption("gateway");
    await analyze
      .getByRole("combobox", { name: "qwen-3.6-27b gateway model" })
      .selectOption("profile:fixture-qwen");
    await analyze.getByRole("checkbox", { name: /gpt-oss-120b .*contributor/ }).check();
    await analyze.getByRole("checkbox", { name: /ministral-3-14b-instruct-2512 .*challenger/ }).check();
    await analyze
      .getByRole("combobox", { name: "gpt-oss-120b gateway model" })
      .selectOption("profile:fixture-gpt");
    await analyze
      .getByRole("combobox", { name: "ministral-3-14b-instruct-2512 gateway model" })
      .selectOption("profile:fixture-ministral");
    const [launched] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/cases/${caseId}/triage-runs`)
          && res.request().method() === "POST"
          && res.ok(),
      ),
      analyze.getByRole("button", { name: "Run gateway comparison" }).click(),
    ]);
    const job = (await launched.json()) as { id: string };
    const card = analyze.locator(`[id="triage-run-${job.id}"]`);
    await expect(card.locator(".triage-runs__status--partial")).toBeVisible({ timeout: 30_000 });

    const runs = await triageRuns(page, caseId);
    const run = runs.find((row) => row.id === job.id);
    expect(run, "the degraded run is missing from the history").toBeTruthy();
    const byStatus = (status: string) => run!.candidates.filter((row) => row.status === status);

    await record.check("lanes-run-status-honest", async () => {
      expect(run!.status, "a run with an unfinished lane reported itself completed").not.toBe(
        "completed",
      );
      expect(run!.status).toBe("partial");
      await expect(card.locator(".triage-runs__status--partial")).toBeVisible();
      await expect(card.locator(".triage-runs__status--completed")).toHaveCount(0);
      return `run reported ${run!.status} rather than completed`;
    });

    await record.check("lanes-per-lane-state-visible", async () => {
      expect(byStatus("completed"), "no lane completed").toHaveLength(1);
      expect(byStatus("partial"), "no lane came back partial").toHaveLength(1);
      expect(byStatus("failed"), "no lane failed").toHaveLength(1);
      const lanes = card.locator(".triage-runs__candidate");
      await expect(lanes).toHaveCount(3);
      // The shell writes a finished lane as "settled" and appends the raw
      // status when that lane did not simply complete, so a degraded outcome
      // is legible on the lane's own card rather than only in the rollup.
      for (const status of ["partial", "failed"]) {
        const lane = lanes.filter({ hasText: byStatus(status)[0]!.model });
        await expect(lane, `the ${status} lane is missing from the run`).toHaveCount(1);
        await expect(
          lane.locator(".triage-runs__candidate-heading"),
          `the ${status} lane does not say so on its own card`,
        ).toContainText(`settled · ${status}`);
      }
      const cleanLane = lanes.filter({ hasText: byStatus("completed")[0]!.model });
      await expect(cleanLane.locator(".triage-runs__candidate-heading")).toContainText("settled");
      await expect(
        cleanLane.locator(".triage-runs__candidate-heading"),
        "a completed lane was marked degraded",
      ).not.toContainText(/settled · (?:partial|failed)/);
      return "each lane states its own outcome: settled, settled · partial, settled · failed";
    });

    const failedLane = byStatus("failed")[0]!;
    await record.check("lanes-failure-has-a-code", async () => {
      expect(failedLane.errorCode, "the failed lane carries no error code").toBeTruthy();
      const laneCard = card.locator(".triage-runs__candidate").filter({
        hasText: failedLane.model,
      });
      await expect(laneCard, "the failed lane is missing from the run").toHaveCount(1);
      await expect(
        laneCard.locator("small"),
        "the failed lane renders without naming why it failed",
      ).toContainText(failedLane.errorCode!);
      // The lane still names the model it was assigned, so the gap is attributable.
      await expect(laneCard.locator(".triage-runs__candidate-heading")).toContainText(
        failedLane.model,
      );
      return `failed lane ${failedLane.model} shows error code ${failedLane.errorCode}`;
    });

    await record.check("lanes-no-interpolation", async () => {
      expect(
        failedLane.summary ?? "",
        "the failed lane was given text it never produced",
      ).toBe("");
      expect(failedLane.evidenceRefs ?? []).toHaveLength(0);
      // A partial lane's text must stay labelled partial where it is read.
      const partialLane = byStatus("partial")[0]!;
      expect(partialLane.summary ?? "").toMatch(/incomplete|stopped before it finished/i);
      const completedSummary = byStatus("completed")[0]!.summary ?? "";
      expect(
        failedLane.summary ?? "",
        "the missing lane was filled in from a peer",
      ).not.toBe(completedSummary);
      return "the failed lane stays empty; nothing was interpolated from the surviving lanes";
    });

    await record.check("lanes-usage-cost-unknown", async () => {
      for (const lane of run!.candidates) {
        expect(lane.usageStatus, `lane ${lane.model} reported a usage figure`).toBe("unknown");
        expect(lane.costStatus, `lane ${lane.model} reported a cost figure`).toBe("unknown");
      }
      await expect(card.getByText(/usage unknown · cost unknown/).first()).toBeVisible();
      return "every lane reports usage unknown and cost unknown, degraded or not";
    });

    await openDeepLink(page, record, "degraded-run", { caseId, runId: job.id });
    await expect(page.locator(`[id="triage-run-${job.id}"]`)).toBeVisible();
    await openDeepLink(page, record, "failed-lane", {
      caseId,
      runId: job.id,
      candidateId: failedLane.candidateId,
    });
    await expect(page.locator(`[id="triage-run-${job.id}"]`)).toBeVisible();

    await screenshot(page, "21-degraded-model-lanes");
    record.finish();
  });

  test(`local versus shared service: ${question("local-vs-shared-service")}`, async ({ page }) => {
    const record = beginScenario("local-vs-shared-service");
    const title = uniqueTitle("Shared deployment");
    const lead = FIXTURE_USERS.erin;
    const contributor = FIXTURE_USERS.alice;

    await loginAs(page, lead);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await addParticipant(page, caseId, contributor);

    // Correspondence the responder classified owner-only on their own machine.
    await uploadEvidence(page, caseId, {
      kind: "email",
      summary: "Forwarded chain classified owner-only before the case was shared.",
      filename: "customer-email-chain.eml",
      mediaType: "message/rfc822",
      bytes: warRoomBytes("customer-email-chain.eml"),
      privacyClass: "owner_only",
    });
    // A log the responder was willing to share.
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log, share-safe.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });

    await openDeepLink(page, record, "profile", {});
    await record.check("deployment-account-kind-stated", async () => {
      await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
      await expect(
        page.getByText(/Local account|Directory account/).first(),
        "the signed-in account kind is not stated anywhere on the profile",
      ).toBeVisible();
      return "the profile states which kind of account this session is using";
    });

    await record.check("deployment-privacy-class-persists", async () => {
      await openCase(page, title);
      const analyze = page.locator("#stage-analyze");
      const chain = analyze.locator(".case-memory__list > li").filter({
        hasText: "customer-email-chain.eml",
      });
      await expect(chain.locator(".case-memory__meta").nth(1)).toContainText("owner_only");
      const log = analyze.locator(".case-memory__list > li").filter({
        hasText: "mailer-offsetless.log",
      });
      await expect(log.locator(".case-memory__meta").nth(1)).toContainText("share_safe");
      return "sharing the investigation left the owner-only chain owner-only";
    });

    // ————— The contributor's turn on the shared deployment —————
    await loginAs(page, contributor);
    await openCase(page, title);
    const contributorNote = await postContribution(page, caseId, {
      kind: "note",
      body: "Contributor note: confirmed the failing peer is the same across every mailer line.",
    });
    expect(contributorNote.status).toBe(200);

    await record.check("deployment-role-gates-share-safe", async () => {
      await openExportSupport(page);
      const option = exportPanel(page).getByRole("option", { name: "share_safe" });
      await expect(
        option,
        "a contributor-role account could select a share-safe export",
      ).toHaveAttribute("disabled", "");
      return `share-safe export is disabled for the ${contributor.expectedRoles.join("/")} role`;
    });

    // ————— Back to the lead: authorship and the gate they do hold —————
    await loginAs(page, lead);
    await openDeepLink(page, record, "decide-export", { caseId });

    await record.check("deployment-authorship-stable", async () => {
      await gotoStage(page, "Capture");
      const entry = await showTimelineEntry(page, contributorNote.id!);
      await expect(
        entry,
        "the record was re-attributed to whoever is currently signed in",
      ).toContainText(`by ${contributor.username}`);
      return `the contributor's record still reads "by ${contributor.username}" when the lead views it`;
    });

    await gotoStage(page, "Decide");
    await openExportSupport(page);
    const panel = exportPanel(page);
    await panel.locator("select").first().selectOption("share_safe");
    await panel.getByRole("button", { name: "Export triage brief" }).click();
    // The lead does hold the gate; the scan still runs before anything leaves.
    await expect(
      panel.locator(".export__markdown, .export__error, .export__findings").first(),
    ).toBeVisible();

    await screenshot(page, "21-local-vs-shared-service");
    record.finish();
  });
});
