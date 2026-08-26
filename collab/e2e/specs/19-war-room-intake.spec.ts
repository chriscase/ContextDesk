import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  caseIdForTitle,
  createCase,
  gotoStage,
  importChat,
  loginAs,
  screenshot,
  uniqueTitle,
  uploadEvidence,
} from "../src/helpers.js";
import { FIXTURE_USERS, SEEDED_SOURCES } from "../src/users.js";
import { beginScenario, catalogProblems } from "../src/war-room/acceptance.js";
import {
  NOISY_BUNDLE_ACCEPTED,
  NOISY_BUNDLE_REJECTED,
  TIMEZONE_JOURNEY,
  noisySupportBundle,
  warRoomBytes,
  warRoomText,
} from "../src/war-room/fixtures.js";
import {
  expandFullLog,
  inspectEvidence,
  openAuditDetailsFor,
  openDeepLink,
  postContribution,
  question,
  timelineEvents,
} from "../src/war-room/journey.js";
import { SCENARIO_IDS, WAR_ROOM_SCENARIOS } from "../src/war-room/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));

const REJECTION_LABELS: Readonly<Record<string, string>> = {
  unsupported_media: "Unrecognized file type",
  binary_or_unknown: "Not safely readable as text",
  nested_archive: "Nested ZIP archive",
};

/**
 * War Room acceptance journeys 1–4: getting messy real-world material into an
 * investigation without losing what is unknown about it.
 *
 * Every byte these journeys upload is synthetic and authored under
 * `fixtures/war-room/`. The assertions are the ones declared in
 * `src/war-room/scenarios.ts`; a journey that fails to reach one of its own
 * declared assertions fails the run rather than passing quietly.
 */

test.describe("War Room intake journeys", () => {
  test("the scenario catalog is internally consistent", async () => {
    // Runs first in the numbered War Room specs so a malformed catalog fails
    // here, with the problem named, rather than as a confusing selector error
    // three journeys later.
    expect(catalogProblems()).toEqual([]);
    expect(WAR_ROOM_SCENARIOS).toHaveLength(SCENARIO_IDS.length);
    for (const scenario of WAR_ROOM_SCENARIOS) {
      // Every journey must be executed by a spec file that exists.
      expect(existsSync(join(here, "..", scenario.spec)), `${scenario.id} names a missing spec`).toBe(
        true,
      );
    }
  });

  test(`noisy multi-file ZIP: ${question("noisy-zip-corpus")}`, async ({ page }) => {
    const record = beginScenario("noisy-zip-corpus");
    const title = uniqueTitle("Noisy bundle");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await gotoStage(page, "Capture");
    await page.getByRole("radio", { name: "ZIP archive" }).check();
    await page.getByLabel("ZIP file to upload").setInputFiles({
      name: "support-bundle.zip",
      mimeType: "application/zip",
      buffer: noisySupportBundle(),
    });
    const [previewed] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/corpus-intake/preview") && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Preview intake" }).click(),
    ]);
    expect(previewed.ok(), await previewed.text()).toBeTruthy();

    await record.check("zip-preview-names-every-entry", async () => {
      const capture = page.locator("#stage-capture");
      await capture.getByText("Review rejected file details").click();
      for (const row of [...NOISY_BUNDLE_ACCEPTED, ...NOISY_BUNDLE_REJECTED]) {
        await expect(
          capture.getByText(row.path, { exact: true }),
          `archive entry ${row.path} is never shown to the responder`,
        ).toBeVisible();
      }
      return `all ${NOISY_BUNDLE_ACCEPTED.length + NOISY_BUNDLE_REJECTED.length} archive entries listed in the preview`;
    });

    await record.check("zip-rejection-states-a-reason", async () => {
      const capture = page.locator("#stage-capture");
      for (const row of NOISY_BUNDLE_REJECTED) {
        await expect(
          capture.getByText(`1 · ${REJECTION_LABELS[row.reason] ?? "Could not be accepted"}`, {
            exact: true,
          }),
          `refused entry ${row.path} shows no reason`,
        ).toBeVisible();
      }
      return `refusal reasons shown: ${NOISY_BUNDLE_REJECTED.map((row) => REJECTION_LABELS[row.reason]).join(", ")}`;
    });

    const [committed] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/corpus-intake")
          && !res.url().includes("preview")
          && res.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Commit accepted files" }).click(),
    ]);
    expect(committed.ok(), await committed.text()).toBeTruthy();
    const batch = (await committed.json()) as {
      id: string;
      items: Array<{ artifactId: string; relativePath: string }>;
    };
    expect(batch.items).toHaveLength(NOISY_BUNDLE_ACCEPTED.length);

    await gotoStage(page, "Analyze");
    const analyze = page.locator("#stage-analyze");
    await record.check("zip-paths-survive-commit", async () => {
      for (const row of NOISY_BUNDLE_ACCEPTED) {
        await expect(
          analyze.locator(".case-memory__list").getByText(row.path, { exact: true }),
          `committed evidence lost its in-archive path ${row.path}`,
        ).toBeVisible();
      }
      // The refused entries must not have crept in under another name.
      for (const row of NOISY_BUNDLE_REJECTED) {
        await expect(
          analyze.locator(".case-memory__list").getByText(row.path, { exact: true }),
        ).toHaveCount(0);
      }
      return `committed evidence keeps its bundle paths; ${NOISY_BUNDLE_REJECTED.length} refused entries stayed out`;
    });

    await record.check("zip-log-readable-in-place", async () => {
      const { preview } = await inspectEvidence(page, "bundle/mailer/mailer-offsetless.log");
      // The failing line must be in the viewer's own preview, not only behind
      // the "expand complete log" disclosure: a responder should not have to
      // go looking for the error the bundle was sent about.
      await expect(preview.getByText(/syn-mailer-118/).first()).toBeVisible();
      return "the failing mailer line is in the inline preview, readable without expanding or downloading";
    });

    await openDeepLink(page, record, "intake-batch", { caseId, batchId: batch.id });
    await expect(
      page.getByRole("heading", { name: "Logs and files for this investigation" }),
    ).toBeVisible();
    const mailerArtifactId = batch.items.find((row) =>
      row.relativePath === "bundle/mailer/mailer-offsetless.log",
    )?.artifactId;
    expect(mailerArtifactId, "committed batch is missing the mailer log").toBeTruthy();
    await openDeepLink(page, record, "evidence-item", { caseId, artifactId: mailerArtifactId! });
    await expect(
      page.locator("#stage-analyze .case-memory__list")
        .getByText("bundle/mailer/mailer-offsetless.log", { exact: true }),
    ).toBeVisible();

    await screenshot(page, "19-noisy-zip-corpus");
    record.finish();
  });

  test(`offsetless timestamps: ${question("offsetless-timestamps")}`, async ({ page }) => {
    const record = beginScenario("offsetless-timestamps");
    const title = uniqueTitle("Ambiguous clock");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic mailer log whose timestamps carry no UTC offset.",
      filename: "mailer-offsetless.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("mailer-offsetless.log"),
      privacyClass: "share_safe",
    });
    await uploadEvidence(page, caseId, {
      kind: "log",
      summary: "Synthetic deploy log with explicit +00:00 offsets.",
      filename: "deploy-utc.log",
      mediaType: "text/plain",
      bytes: warRoomBytes("deploy-utc.log"),
      privacyClass: "share_safe",
    });

    // The responder tries to pin the bare log timestamp onto the timeline.
    const refused = await postContribution(page, caseId, {
      kind: "note",
      body: `Mailer failure observed at ${TIMEZONE_JOURNEY.ambiguous} in the log, offset unknown.`,
      clientTime: TIMEZONE_JOURNEY.ambiguous,
    });
    await record.check("tz-bare-timestamp-refused", async () => {
      expect(
        refused.status,
        `a timestamp with no offset was accepted as an event time: ${JSON.stringify(refused)}`,
      ).toBe(400);
      expect(refused.error ?? "").toMatch(/RFC3339/i);
      return `offsetless event time refused with ${refused.status}: ${refused.error ?? ""}`;
    });

    // The correction: the responder asserts the emitting host's offset.
    const corrected = await postContribution(page, caseId, {
      kind: "note",
      body:
        "Correcting the record: the mailer host logs in -07:00, so the failure is "
        + `${TIMEZONE_JOURNEY.corrected}, which is after the ${TIMEZONE_JOURNEY.deployUtc} deploy step. `
        + `This ordering rests on a ${TIMEZONE_JOURNEY.orderingRestsOn}.`,
      clientTime: TIMEZONE_JOURNEY.corrected,
    });
    await record.check("tz-correction-accepted-with-offset", async () => {
      expect(corrected.status, `an explicit RFC3339 offset was still refused: ${corrected.error ?? ""}`).toBe(200);
      const events = await timelineEvents(page, caseId);
      const stored = events.find((row) => row.targetId === corrected.id);
      expect(stored, "the corrected contribution is missing from the timeline").toBeTruthy();
      // -07:00 at 02:15:09 is 09:15:09Z, after the 09:12:31Z deploy step.
      expect(new Date(stored!.clientTime!).toISOString()).toBe("2026-03-14T09:15:09.000Z");
      expect(new Date(stored!.clientTime!).getTime()).toBeGreaterThan(
        new Date(TIMEZONE_JOURNEY.deployUtc).getTime(),
      );
      return `corrected event time stored as ${stored!.clientTime}, after the deploy at ${TIMEZONE_JOURNEY.deployUtc}`;
    });

    // An entry with no asserted event time at all.
    const undated = await postContribution(page, caseId, {
      kind: "note",
      body: "Noting this now; I do not know when it happened.",
    });
    expect(undated.status).toBe(200);

    await openDeepLink(page, record, "capture-timeline", { caseId });
    await expect(page.locator("#stage-capture")).toBeVisible();

    await record.check("tz-no-silent-localisation", async () => {
      await gotoStage(page, "Analyze");
      const { preview } = await inspectEvidence(page, "mailer-offsetless.log");
      // The stored bytes still carry the ambiguous literal, unrewritten: no
      // offset appended, nothing shifted into the viewer's timezone.
      await expect(preview.getByText(TIMEZONE_JOURNEY.ambiguous, { exact: false }).first()).toBeVisible();
      await expect(preview.getByText(/02:15:09(Z|[+-]\d{2}:?\d{2})/)).toHaveCount(0);
      return `evidence still shows the literal ${TIMEZONE_JOURNEY.ambiguous} with no timezone applied`;
    });

    await gotoStage(page, "Capture");
    await record.check("tz-client-and-server-time-distinct", async () => {
      const audit = await openAuditDetailsFor(page, corrected.id!);
      await expect(audit.getByText("Client time", { exact: true })).toBeVisible();
      await expect(audit.getByText("Server time", { exact: true })).toBeVisible();
      await expect(audit).toContainText(TIMEZONE_JOURNEY.corrected.slice(0, 10));
      const events = await timelineEvents(page, caseId);
      const stored = events.find((row) => row.targetId === corrected.id)!;
      expect(stored.clientTime, "client and server time collapsed into one value").not.toBe(
        stored.serverTime,
      );
      return "the timeline shows event time and record time as separate fields";
    });

    await record.check("tz-absent-event-time-reads-unknown", async () => {
      const events = await timelineEvents(page, caseId);
      const stored = events.find((row) => row.targetId === undated.id);
      expect(stored, "the undated contribution is missing from the timeline").toBeTruthy();
      expect(
        stored!.clientTime,
        "an absent event time was backfilled from the server clock",
      ).toBeNull();
      const audit = await openAuditDetailsFor(page, undated.id!);
      await expect(audit).toContainText("not recorded");
      return "an entry with no asserted event time reads as not recorded";
    });

    await screenshot(page, "19-offsetless-timestamps");
    record.finish();
  });

  test(`customer email chain: ${question("customer-email-chain")}`, async ({ page }) => {
    const record = beginScenario("customer-email-chain");
    const title = uniqueTitle("Forwarded chain");
    await loginAs(page, FIXTURE_USERS.dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    const chain = warRoomText("customer-email-chain.eml");
    const uploaded = await uploadEvidence(page, caseId, {
      kind: "email",
      summary: "Forwarded four-message support chain; reporter observation is second-hand below the fold.",
      filename: "customer-email-chain.eml",
      mediaType: "message/rfc822",
      bytes: Buffer.from(chain, "utf8"),
      // Correspondence stays owner-only until someone confirms it carries no
      // customer identifiers. That is a deliberate choice, not a default.
      privacyClass: "owner_only",
    });

    await openDeepLink(page, record, "email-evidence", { caseId, artifactId: uploaded.id });
    const analyze = page.locator("#stage-analyze");
    const chainRow = analyze.locator(".case-memory__list > li").filter({
      hasText: "customer-email-chain.eml",
    });
    await expect(chainRow).toBeVisible();

    await record.check("email-kind-distinct-from-log", async () => {
      await expect(
        chainRow.locator(".case-memory__meta").first(),
        "the chain is not labelled as email evidence",
      ).toContainText("email");
      return "the evidence row labels the chain as email, distinct from the log inventory";
    });

    await record.check("email-privacy-class-explicit", async () => {
      await expect(
        chainRow.locator(".case-memory__meta").nth(1),
        "the chain's privacy class is not shown",
      ).toContainText("owner_only");
      return "the chain is recorded owner_only, chosen at upload rather than defaulted to share-safe";
    });

    await record.check("email-chain-kept-whole", async () => {
      const { row } = await inspectEvidence(page, "customer-email-chain.eml");
      // Correspondence has no "error" line, so the viewer's preview shows the
      // headers and the responder has to ask for the rest. That is fine — what
      // must not happen is the rest having been dropped at upload.
      const full = await expandFullLog(row);
      await expect(full.getByText(/Forwarding the chain below/).first()).toBeVisible();
      await expect(full.getByText(/Escalating\./).first()).toBeVisible();
      await expect(full.getByText(/only the confirmation email that never/).first()).toBeVisible();
      await expect(full.getByText(/roughly when you first noticed/).first()).toBeVisible();
      return "all four messages, including quoted history, survived the upload and are readable in full";
    });

    // The first-hand observation is recorded separately from the paraphrase,
    // so a later reader can tell them apart.
    const observation = await postContribution(page, caseId, {
      kind: "note",
      body:
        "First-hand from the reporter: orders completed, confirmation emails never arrived, "
        + "first noticed a little after 2am west-coast time. The 'same as January' framing is "
        + "the account team's paraphrase, not the reporter's.",
    });
    expect(observation.status).toBe(200);

    await screenshot(page, "19-customer-email-chain");
    record.finish();
  });

  test(`pasted external chat: ${question("pasted-external-chat")}`, async ({ page }) => {
    const record = beginScenario("pasted-external-chat");
    const title = uniqueTitle("Pasted chat");
    const dave = FIXTURE_USERS.dave;
    await loginAs(page, dave);
    await createCase(page, title);
    const caseId = await caseIdForTitle(page, title);

    const transcript = warRoomText("pasted-external-chat.txt");
    await importChat(page, {
      output: transcript,
      prompt: "our order confirmation emails stopped going out early saturday morning. what happened?",
      sourceLabel: SEEDED_SOURCES.chatA,
      operatorUsername: dave.username,
      operatorId: dave.identityId,
      // Nobody knows what the external assistant could see, so it stays unknown.
      visibility: "unknown",
    });

    const imports = await page.request.get(`/api/cases/${caseId}/imports`);
    expect(imports.ok(), await imports.text()).toBeTruthy();
    const importBody = (await imports.json()) as {
      runs?: Array<{ id: string; operatorUsername?: string; evidenceVisibility?: string }>;
    };
    const imported = importBody.runs?.[0];
    expect(imported, "the pasted transcript was not recorded as an imported run").toBeTruthy();

    await record.check("chat-unverified-banner-present", async () => {
      await expect(page.getByText("Unverified imported run").first()).toBeVisible();
      return "the transcript carries a standing unverified-imported-run banner";
    });

    await record.check("chat-operator-attributed", async () => {
      expect(imported!.operatorUsername, "the import is anonymous").toBe(dave.username);
      await expect(page.locator(".imported-run").filter({ hasText: dave.username }).first()).toBeVisible();
      return `import attributed to operator ${imported!.operatorUsername}`;
    });

    await record.check("chat-visibility-defaults-unknown", async () => {
      expect(
        imported!.evidenceVisibility,
        "the surface implies the external assistant saw case evidence",
      ).toBe("unknown");
      return "evidence visibility recorded as unknown; the transcript is not treated as evidence-grounded";
    });

    await record.check("chat-not-counted-as-local-run", async () => {
      const runs = await page.request.get(`/api/cases/${caseId}/triage-runs`);
      expect(runs.ok(), await runs.text()).toBeTruthy();
      const runBody = (await runs.json()) as { jobs?: unknown[] };
      expect(
        runBody.jobs ?? [],
        "the imported transcript leaked into the executed run history",
      ).toHaveLength(0);
      return "no executed run exists; the import is kept as its own record type";
    });

    await openDeepLink(page, record, "imported-run", { caseId, importId: imported!.id });
    await expect(page.getByText("Unverified imported run").first()).toBeVisible();

    await screenshot(page, "19-pasted-external-chat");
    record.finish();
  });
});
