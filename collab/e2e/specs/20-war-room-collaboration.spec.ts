import { expect, test } from "@playwright/test";
import {
  caseIdForTitle,
  createCase,
  gotoStage,
  loginAs,
  openCase,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS } from "../src/users.js";
import { beginScenario } from "../src/war-room/acceptance.js";
import { BACKFILL_JOURNEY, warRoomBytes } from "../src/war-room/fixtures.js";
import {
  addParticipant,
  freezeEvidence,
  openAuditDetailsFor,
  openDeepLink,
  postContribution,
  question,
  runSyntheticComparison,
  showTimelineEntry,
  timelineEvents,
  triageRuns,
} from "../src/war-room/journey.js";

/**
 * War Room acceptance journeys 5–8: what happens between people, and across
 * time, once evidence is in the investigation.
 *
 * These journeys are deliberately unglamorous. Two of them never launch a model
 * at all. That is the point: the surface has to stay useful when the interesting
 * machinery is absent, degraded, or weeks out of date.
 */

test.describe("War Room collaboration journeys", () => {
  test(`human-only investigation: ${question("human-only-investigation")}`, async ({ page }) => {
    const record = beginScenario("human-only-investigation");
    const title = uniqueTitle("Human only");
    // A case lead, because the human decision at the end of this journey is a
    // status change and a brief — both lead-gated in the shipped product.
    await loginAs(page, FIXTURE_USERS.erin);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log, read by people rather than by a model.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    const snapshot = await freezeEvidence(page, ["mailer-offsetless.log"]);
    expect(snapshot.evidence).toHaveLength(1);

    const note = await postContribution(page, caseId, {
      kind: "note",
      body: "Read the mailer log directly. Every failure line is upstream_timeout against the same peer.",
    });
    const hypothesis = await postContribution(page, caseId, {
      kind: "hypothesis",
      body: "Suspect the SMTP timeout was shortened by a config change. Not confirmed; nobody has read the config yet.",
    });
    const action = await postContribution(page, caseId, {
      kind: "action",
      body: "Raised the SMTP timeout back to the previous value and stopped the backoff loop.",
    });
    for (const posted of [note, hypothesis, action]) {
      expect(posted.status, `contribution rejected: ${posted.error ?? ""}`).toBe(200);
    }

    // The three entries were written through the same route the composer posts
    // to; the mounted stage predates them, so reload before reading it back.
    await page.reload();
    await openCase(page, title);
    await gotoStage(page, "Capture");
    await record.check("human-only-entry-kinds-preserved", async () => {
      await expect(await showTimelineEntry(page, note.id!)).toContainText("Current note");
      const hypothesisEntry = await showTimelineEntry(page, hypothesis.id!);
      await expect(hypothesisEntry).toContainText("Current hypothesis");
      await expect(await showTimelineEntry(page, action.id!)).toContainText("Current action");
      // A hypothesis must not be dressed as an established finding.
      await expect(hypothesisEntry).not.toContainText("Current note");
      return "note, hypothesis, and action stay distinct on the timeline";
    });

    await record.check("human-only-no-phantom-consensus", async () => {
      expect(await triageRuns(page, caseId), "a lane ran in a human-only journey").toHaveLength(0);
      await gotoStage(page, "Compare");
      const compare = page.locator("#stage-compare");
      await expect(compare).toBeVisible();
      // Nothing was compared, so nothing may be *asserted* as agreement: no
      // candidate matrix, no shared-evidence tally, no consensus verdict. The
      // standing "agreement is not proof" caveat is copy explaining what the
      // stage would mean, and is expected to stay.
      await expect(compare.locator("table.experiment-lab__matrix")).toHaveCount(0);
      await expect(compare.getByText(/\d+\s+shared/i)).toHaveCount(0);
      await expect(compare.getByText(/\b(?:consensus|lanes agree|all lanes)\b/i)).toHaveCount(0);
      await expect(
        compare.getByText("Agreement is not proof of correctness.").first(),
        "the agreement caveat disappeared from an empty comparison",
      ).toBeVisible();
      return "no candidate matrix, tally, or consensus verdict is shown; only the standing caveat remains";
    });

    await openDeepLink(page, record, "situation", { caseId });
    await expect(page.locator("#stage-situation")).toBeVisible();
    await openDeepLink(page, record, "decide", { caseId });

    await record.check("human-only-no-lane-required", async () => {
      const decide = page.locator("#stage-decide");
      const status = decide.getByRole("combobox", { name: "Case status" });
      await expect(status, "a case lead cannot record a decision without a lane").toBeVisible();
      await status.selectOption("resolved");
      const [updated] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith(`/api/cases/${caseId}/status`) && res.request().method() === "POST",
        ),
        decide.getByRole("button", { name: "Update status" }).click(),
      ]);
      expect(updated.ok(), await updated.text()).toBeTruthy();
      const listed = await page.request.get("/api/cases");
      const body = (await listed.json()) as { cases?: Array<{ id: string; status: string }> };
      expect(body.cases?.find((row) => row.id === caseId)?.status).toBe("resolved");
      expect(await triageRuns(page, caseId), "a lane ran after all").toHaveLength(0);
      return "the investigation reached a recorded resolved decision with zero comparisons launched";
    });

    await screenshot(page, "20-human-only-investigation");
    record.finish();
  });

  test(`asynchronous handoff: ${question("asynchronous-handoff")}`, async ({ page }) => {
    const record = beginScenario("asynchronous-handoff");
    const title = uniqueTitle("Shift handoff");
    const leaving = FIXTURE_USERS.erin;
    const arriving = FIXTURE_USERS.alice;

    // ————— The departing responder's shift —————
    await loginAs(page, leaving);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);
    await addParticipant(page, caseId, arriving);
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log pulled before the shift ended.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    await freezeEvidence(page, ["mailer-offsetless.log"]);
    await runSyntheticComparison(page, caseId);
    const leavingNote = await postContribution(page, caseId, {
      kind: "hypothesis",
      body:
        "Handing over: the mailer timeouts all name the same peer. I did not get to the deploy "
        + "config, so whether a release changed the SMTP timeout is still open.",
    });
    expect(leavingNote.status).toBe(200);

    // The address the departing responder pastes into the incident channel.
    await gotoStage(page, "Analyze");
    const workstreamLink = page
      .locator(".workstreams")
      .first()
      .getByRole("link", { name: /(?:workstream|simulation) — / })
      .first();
    await expect(workstreamLink).toBeVisible();
    const sharedHref = await workstreamLink.getAttribute("href");
    expect(sharedHref, "no shareable workstream address was offered").toBeTruthy();
    const workstreamKey = new URL(sharedHref!, "http://127.0.0.1").searchParams.get("lane");
    expect(workstreamKey, "the shared workstream address carries no lane").toBeTruthy();

    // ————— Six hours later, someone else opens the link cold —————
    await loginAs(page, arriving);
    await openDeepLink(page, record, "workstream", { caseId, workstreamKey: workstreamKey! });
    const detail = page.locator(".workstreams__detail");
    await expect(detail).toBeVisible();

    await record.check("handoff-link-survives-transfer", async () => {
      await expect(detail.getByRole("heading", { name: /(?:workstream|simulation) — / })).toBeVisible();
      await expect(page).toHaveURL(/section=workstreams/);
      await expect(page).toHaveURL(/lane=/);
      return `the copied workstream address opened the same work for ${arriving.username}`;
    });

    await record.check("handoff-unknowns-surfaced", async () => {
      await expect(
        detail.getByRole("heading", { name: "What it left unknown" }),
        "open questions are not surfaced as their own block",
      ).toBeVisible();
      await expect(detail.getByText("Agreement is not proof of correctness.")).toBeVisible();
      return "the workstream shows an explicit unknowns block plus the agreement-is-not-proof caveat";
    });

    await record.check("handoff-authors-visible", async () => {
      await expect(detail.getByText("Requested by")).toBeVisible();
      await expect(detail.getByText(leaving.username, { exact: true }).first()).toBeVisible();
      await gotoStage(page, "Capture");
      await expect(await showTimelineEntry(page, leavingNote.id!)).toContainText(
        `by ${leaving.username}`,
      );
      return `the departing responder ${leaving.username} is named on their own work`;
    });

    const arrivingNote = await postContribution(page, caseId, {
      kind: "note",
      body:
        "Picking this up. Continuing the open question from the handover: reading the deploy "
        + "config rollout next.",
    });
    await record.check("handoff-second-author-recorded", async () => {
      expect(arrivingNote.status, `arriving responder could not contribute: ${arrivingNote.error ?? ""}`).toBe(200);
      const events = await timelineEvents(page, caseId);
      const stored = events.find((row) => row.targetId === arrivingNote.id);
      expect(stored?.actorUsername, "the later entry inherited the earlier author").toBe(
        arriving.username,
      );
      await page.reload();
      await gotoStage(page, "Capture");
      await expect(await showTimelineEntry(page, arrivingNote.id!)).toContainText(
        `by ${arriving.username}`,
      );
      return `the arriving responder's entry is attributed to ${arriving.username}, not ${leaving.username}`;
    });

    await screenshot(page, "20-asynchronous-handoff");
    record.finish();
  });

  test(`historical backfill: ${question("historical-backfill")}`, async ({ page }) => {
    const record = beginScenario("historical-backfill");
    const title = uniqueTitle("March postmortem");
    const reconstructor = FIXTURE_USERS.dave;
    await loginAs(page, reconstructor);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Collected in August from an archived host; covers the March window only.",
      filename: "postmortem-march-window.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("postmortem-march-window.log"),
      privacyClass: "share_safe",
    });

    const reconstructed = [
      { at: BACKFILL_JOURNEY.windowStart, body: "Reconstructed: mailer queue was still draining normally." },
      { at: BACKFILL_JOURNEY.firstFailure, body: "Reconstructed: first send failure, id syn-mailer-118." },
      { at: BACKFILL_JOURNEY.recovery, body: "Reconstructed: sends recovered; window closed." },
    ];
    const posted: string[] = [];
    for (const step of reconstructed) {
      const result = await postContribution(page, caseId, {
        kind: "note",
        body: step.body,
        clientTime: step.at,
      });
      expect(result.status, `backfilled entry refused: ${result.error ?? ""}`).toBe(200);
      posted.push(result.id!);
    }

    await record.check("backfill-event-date-retained", async () => {
      const events = await timelineEvents(page, caseId);
      const stored = posted.map((id) => events.find((row) => row.targetId === id)!);
      expect(stored.every((row) => row.clientTime !== null)).toBe(true);
      expect(new Date(stored[0]!.clientTime!).toISOString()).toBe("2026-03-14T09:10:00.000Z");
      expect(new Date(stored[2]!.clientTime!).toISOString()).toBe("2026-03-14T10:02:00.000Z");
      return `backdated event times retained: ${stored.map((row) => row.clientTime).join(", ")}`;
    });

    await record.check("backfill-write-time-not-rewritten", async () => {
      const events = await timelineEvents(page, caseId);
      const stored = posted.map((id) => events.find((row) => row.targetId === id)!);
      for (const row of stored) {
        const eventTime = new Date(row.clientTime!).getTime();
        const writeTime = new Date(row.serverTime).getTime();
        expect(
          writeTime,
          "the record's write time was moved back to match the asserted event time",
        ).toBeGreaterThan(eventTime);
      }
      return "every backfilled record kept a write time later than the event it describes";
    });

    await openDeepLink(page, record, "capture-backfill", { caseId });
    await record.check("backfill-both-times-visible", async () => {
      const audit = await openAuditDetailsFor(page, posted[1]!);
      await expect(audit.getByText("Client time", { exact: true })).toBeVisible();
      await expect(audit.getByText("Server time", { exact: true })).toBeVisible();
      await expect(audit, "the March event date is not shown").toContainText("2026-03-14");
      // The write happened in a different month; the reader must be able to see
      // that this entry is a reconstruction rather than a live observation.
      const events = await timelineEvents(page, caseId);
      const stored = events.find((row) => row.targetId === posted[1])!;
      expect(stored.serverTime.slice(0, 7)).not.toBe(stored.clientTime!.slice(0, 7));
      return "event time and write time are shown together and fall in different months";
    });

    await record.check("backfill-attributed-to-reconstructor", async () => {
      const events = await timelineEvents(page, caseId);
      for (const id of posted) {
        expect(events.find((row) => row.targetId === id)?.actorUsername).toBe(
          reconstructor.username,
        );
      }
      await expect(await showTimelineEntry(page, posted[1]!)).toContainText(
        `by ${reconstructor.username}`,
      );
      return `the reconstruction is attributed to ${reconstructor.username}, who performed it now`;
    });

    await screenshot(page, "20-historical-backfill");
    record.finish();
  });

  test(`new evidence and rerun: ${question("new-evidence-rerun")}`, async ({ page }) => {
    const record = beginScenario("new-evidence-rerun");
    const title = uniqueTitle("Second log");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log available at the time of the first comparison.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    const firstSnapshot = await freezeEvidence(page, ["mailer-offsetless.log"]);
    const firstRunId = await runSyntheticComparison(page, caseId);

    // ————— The second log arrives afterwards —————
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic config-reload log that arrived after the first comparison.",
      filename: "late-arriving-worker.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("late-arriving-worker.log"),
      privacyClass: "share_safe",
    });
    await page.reload();
    await openCase(page, title);
    const secondSnapshot = await freezeEvidence(page, [
      "mailer-offsetless.log",
      "late-arriving-worker.log",
    ]);
    const rerunId = await runSyntheticComparison(page, caseId);

    await record.check("rerun-snapshot-lineage-explicit", async () => {
      expect(
        secondSnapshot.parentSnapshotId,
        "re-freezing dropped the lineage back to the earlier snapshot",
      ).toBe(firstSnapshot.id);
      expect(secondSnapshot.evidence).toHaveLength(2);
      expect(firstSnapshot.evidence).toHaveLength(1);
      return `snapshot ${secondSnapshot.id} names ${firstSnapshot.id} as its parent`;
    });

    await record.check("rerun-fingerprints-differ", async () => {
      const runs = await triageRuns(page, caseId);
      const first = runs.find((row) => row.id === firstRunId);
      const second = runs.find((row) => row.id === rerunId);
      expect(first?.snapshotFingerprint).toBe(firstSnapshot.fingerprint);
      expect(second?.snapshotFingerprint).toBe(secondSnapshot.fingerprint);
      expect(
        first!.snapshotFingerprint,
        "both runs claim the same fingerprint, hiding that the inputs changed",
      ).not.toBe(second!.snapshotFingerprint);
      return `run fingerprints differ: ${first!.snapshotFingerprint.slice(0, 12)}… vs ${second!.snapshotFingerprint.slice(0, 12)}…`;
    });

    await record.check("rerun-earlier-run-preserved", async () => {
      const runs = await triageRuns(page, caseId);
      expect(runs).toHaveLength(2);
      const first = runs.find((row) => row.id === firstRunId)!;
      expect(first.snapshotId, "the earlier run was re-pointed at the new snapshot").toBe(
        firstSnapshot.id,
      );
      await gotoStage(page, "Analyze");
      await expect(page.locator(`[id="triage-run-${firstRunId}"]`)).toBeVisible();
      await expect(page.locator(`[id="triage-run-${rerunId}"]`)).toBeVisible();
      return "both runs remain in the history, each still bound to the snapshot it ran against";
    });

    await record.check("rerun-no-causal-claim", async () => {
      const analyze = page.locator("#stage-analyze");
      // The product is allowed to offer a comparison of the two runs. It is not
      // allowed to attribute their difference to the added file.
      await expect(analyze.getByText(/Agreement is not proof of correctness\./).first()).toBeVisible();
      await expect(analyze.getByText(/caused by the (?:new|added)/i)).toHaveCount(0);
      await expect(analyze.getByText(/because of the (?:new|added)/i)).toHaveCount(0);
      return "no causal claim is made about the difference between two differently-bound runs";
    });

    await openDeepLink(page, record, "first-run", { caseId, firstRunId });
    await expect(page.locator(`[id="triage-run-${firstRunId}"]`)).toBeVisible();
    await openDeepLink(page, record, "rerun", { caseId, rerunId });
    await expect(page.locator(`[id="triage-run-${rerunId}"]`)).toBeVisible();

    await screenshot(page, "20-new-evidence-rerun");
    record.finish();
  });
});
