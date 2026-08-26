/**
 * Deterministic War Room scenario catalog for repeated Computer Use acceptance.
 *
 * This file is the single source of truth shared by three consumers:
 *
 *   1. the Playwright journeys under `specs/19..22-war-room-*.spec.ts`,
 *   2. the acceptance report emitted by `acceptance.ts`, and
 *   3. the reviewed matrix in `docs/WAR_ROOM_SCENARIO_MATRIX.md`.
 *
 * Every scenario is stated in the words a responder would use, not in the
 * vocabulary of the implementation, because the thing under test is whether a
 * human (or an agent driving a browser) can answer a real triage question from
 * what the shipped surface actually shows.
 *
 * Rules this catalog holds itself to:
 *
 * - **Synthetic only.** Every fixture byte is authored here or under
 *   `fixtures/war-room/`. No customer text, no captured production log, no real
 *   address, host, or credential. `scripts/check_war_room_scenarios.mjs`
 *   re-checks that claim on every run.
 * - **No fabricated provider quality.** A scenario may assert that a lane
 *   *reported* a status. None asserts that a model was right, fast, or better
 *   than another, and none asserts a usage or cost number: the product reports
 *   those as `unknown` and the catalog keeps them unknown.
 * - **Failure is a first-class expectation.** `expectedUnknowns` is not a
 *   to-do list. It records what the surface must continue to admit it does not
 *   know; a scenario fails if an unknown is quietly resolved into a guess.
 */

export const SCENARIO_IDS = [
  "noisy-zip-corpus",
  "offsetless-timestamps",
  "customer-email-chain",
  "pasted-external-chat",
  "human-only-investigation",
  "asynchronous-handoff",
  "historical-backfill",
  "new-evidence-rerun",
  "degraded-model-lanes",
  "local-vs-shared-service",
  "log-workbench-triage",
  "workbench-email-chat",
  "workbench-locator-privacy",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

/**
 * One pass/fail usability claim. `claim` is what a responder must be able to do
 * or see; `failsWhen` names the observable that makes it a failure, so a red
 * run reads as a usability defect rather than a selector mismatch.
 */
export interface UsabilityAssertion {
  id: string;
  claim: string;
  failsWhen: string;
}

/** A copyable address the journey must be able to land on directly. */
export interface DeepLinkTarget {
  id: string;
  purpose: string;
  /** Path template. `{caseId}` is substituted with the live investigation id. */
  template: string;
}

export interface WarRoomScenario {
  id: ScenarioId;
  /** Stable display order, mirrored by the matrix and the report. */
  ordinal: number;
  title: string;
  /** The one question the responder opened the War Room to answer. */
  triageQuestion: string;
  /** What a human must be able to read on screen, without opening a database. */
  expectedEvidence: string[];
  /** Where each visible fact came from, as the surface must state it. */
  expectedProvenance: string[];
  /** What must stay explicitly unknown. Never a backlog item. */
  expectedUnknowns: string[];
  /** What the surface should make obvious as the next move. */
  usefulNextActions: string[];
  deepLinks: DeepLinkTarget[];
  assertions: UsabilityAssertion[];
  /** Spec file that executes this journey. */
  spec: string;
  /** Non-default run condition, when the journey needs one. */
  requires?: string;
}

const INVESTIGATION = "/investigations/{caseId}";

export const WAR_ROOM_SCENARIOS: readonly WarRoomScenario[] = [
  {
    id: "noisy-zip-corpus",
    ordinal: 1,
    title: "A noisy multi-file ZIP lands on the desk",
    triageQuestion:
      "Someone dropped a support bundle in the channel. Which of the files inside it actually shows the failure, and what did the intake refuse to read?",
    expectedEvidence: [
      "A per-file preview listing every entry in the archive by its path inside the ZIP, before anything is committed.",
      "An explicit accepted/rejected split, so the responder can see that the bundle was not silently truncated.",
      "A stated reason on each rejected entry (for example `unsupported_media` on a binary blob) rather than a silent drop.",
      "The readable log entries available to open in place, so a responder can confirm the failing line without downloading the archive.",
    ],
    expectedProvenance: [
      "Each committed file keeps the path it had inside the archive, so a finding can be traced back to the bundle.",
      "The committed batch has its own identity and a copyable deep link back to the intake that produced it.",
      "Committed files appear in the investigation's evidence inventory content-addressed, not as loose text.",
    ],
    expectedUnknowns: [
      "Whether a rejected binary entry was relevant. The intake reports that it could not read it, and does not guess at its contents.",
      "Whether the bundle is complete. Nothing in the archive proves it was not filtered before it was sent.",
    ],
    usefulNextActions: [
      "Open the log that names the failure and read the failing line in place.",
      "Select the relevant files and freeze them as a snapshot, so later work is bound to exactly this evidence.",
      "Share the batch deep link with whoever collected the bundle to ask about the unreadable entry.",
    ],
    deepLinks: [
      {
        id: "intake-batch",
        purpose: "Return to the committed intake batch and its accepted/rejected split.",
        template: `${INVESTIGATION}/capture?section=corpus-intake&item={batchId}&kind=intake-batch#corpus-intake`,
      },
      {
        id: "evidence-item",
        purpose: "Land on one committed file in the evidence board.",
        template: `${INVESTIGATION}/analyze?section=triage-evidence-board&item={artifactId}&kind=evidence#triage-evidence-board`,
      },
    ],
    assertions: [
      {
        id: "zip-preview-names-every-entry",
        claim: "The preview names every entry in the archive, including the ones it will refuse.",
        failsWhen: "An entry present in the uploaded ZIP never appears on screen at any point.",
      },
      {
        id: "zip-rejection-states-a-reason",
        claim: "A refused entry shows a machine-stated reason next to it.",
        failsWhen: "A file is dropped from the commit with no visible reason.",
      },
      {
        id: "zip-paths-survive-commit",
        claim: "Committed evidence keeps its in-archive path in the evidence board.",
        failsWhen: "The evidence board shows a flattened or renamed filename that cannot be traced to the bundle.",
      },
      {
        id: "zip-log-readable-in-place",
        claim: "A responder can read the failing log line without leaving the investigation.",
        failsWhen: "Inspecting a committed log offers a download instead of its contents.",
      },
    ],
    spec: "specs/19-war-room-intake.spec.ts",
  },
  {
    id: "offsetless-timestamps",
    ordinal: 2,
    title: "Offsetless log timestamps, then an explicit timezone correction",
    triageQuestion:
      "The mailer log says the error was at 02:15:09 with no offset, and the deploy was at 09:12 UTC. Did the error happen before or after the deploy?",
    expectedEvidence: [
      "The log text as written, ambiguous timestamp included, rather than a silently normalised one.",
      "A rejection with a stated reason when a responder tries to pin that bare timestamp onto the timeline as an event time.",
      "After the correction, the same moment recorded with an explicit offset, distinguishable from the time it was typed in.",
    ],
    expectedProvenance: [
      "The timeline separates the time an event happened (client time) from the time the record was written (server time).",
      "An entry with no asserted event time reads as `not recorded`, not as the moment it was typed.",
      "The corrected entry carries the offset the responder supplied, so a later reader can see the correction was a human assertion.",
    ],
    expectedUnknowns: [
      "The timezone of the original log. The product refuses the bare timestamp rather than assuming UTC or the viewer's locale.",
      "Whether the responder's supplied offset is correct. It is recorded as an attributed human claim, not as a verified fact.",
    ],
    usefulNextActions: [
      "Re-enter the event time with an explicit offset once the emitting host's timezone is known.",
      "Note in the timeline which host's clock the original line came from, so the next reader does not re-derive it.",
      "Freeze the log so the ambiguity is preserved in evidence rather than fixed up in place.",
    ],
    deepLinks: [
      {
        id: "capture-timeline",
        purpose: "Return to the timeline showing client time against server time.",
        template: `${INVESTIGATION}/capture`,
      },
    ],
    assertions: [
      {
        id: "tz-bare-timestamp-refused",
        claim: "A timestamp with no offset is refused as an event time, with a reason.",
        failsWhen: "The bare timestamp is accepted and displayed as if its timezone were known.",
      },
      {
        id: "tz-no-silent-localisation",
        claim: "The stored log text keeps the ambiguous timestamp exactly as written.",
        failsWhen: "The evidence view rewrites the log line into the viewer's timezone.",
      },
      {
        id: "tz-client-and-server-time-distinct",
        claim: "The timeline shows event time and record time as separate fields.",
        failsWhen: "Only one timestamp is shown, so a backdated entry is indistinguishable from a live one.",
      },
      {
        id: "tz-correction-accepted-with-offset",
        claim: "The same instant is accepted once an explicit offset is supplied.",
        failsWhen: "A correctly offset RFC3339 event time is still refused, leaving no way to correct the record.",
      },
      {
        id: "tz-absent-event-time-reads-unknown",
        claim: "An entry with no asserted event time reads as not recorded.",
        failsWhen: "A missing event time is backfilled from the server clock and shown as if the responder asserted it.",
      },
    ],
    spec: "specs/19-war-room-intake.spec.ts",
  },
  {
    id: "customer-email-chain",
    ordinal: 3,
    title: "A forwarded customer email chain",
    triageQuestion:
      "Support forwarded a four-message reply chain. What did the reporter actually observe first-hand, and what is someone else's paraphrase?",
    expectedEvidence: [
      "The full chain stored as email evidence, with the quoted history intact rather than trimmed to the newest message.",
      "The reply order visible on screen, so the responder can tell the original report from the escalation around it.",
      "The chain content-addressed in the evidence inventory alongside logs, not held only in a mail client.",
    ],
    expectedProvenance: [
      "The evidence is classified as an email, distinct from a log or an attachment.",
      "A responder-written summary is attributed to the responder, separate from the email body itself.",
      "The privacy class is chosen explicitly at upload, so a correspondence chain is not share-safe by default.",
    ],
    expectedUnknowns: [
      "Whether the quoted history inside the chain is faithful. Quoted text is not independently verifiable from the chain alone.",
      "Every timestamp inside the message bodies is display text from the sending client; the product does not treat it as an established event time.",
      "Who else was on the thread before it was forwarded.",
    ],
    usefulNextActions: [
      "Record the reporter's first-hand observation as a timeline note, separated from the paraphrase.",
      "Freeze the chain with the logs it refers to, so a later comparison sees both.",
      "Keep the chain owner-only until someone confirms it carries no customer identifiers.",
    ],
    deepLinks: [
      {
        id: "email-evidence",
        purpose: "Land on the email chain in the evidence board.",
        template: `${INVESTIGATION}/analyze?section=triage-evidence-board&item={artifactId}&kind=evidence#triage-evidence-board`,
      },
    ],
    assertions: [
      {
        id: "email-chain-kept-whole",
        claim: "The stored chain keeps every message, including quoted history.",
        failsWhen: "Only the newest message survives the upload.",
      },
      {
        id: "email-kind-distinct-from-log",
        claim: "Email evidence is labelled as email, not merged into the log inventory.",
        failsWhen: "The evidence board presents the chain indistinguishably from a log file.",
      },
      {
        id: "email-privacy-class-explicit",
        claim: "The privacy class is an explicit choice recorded with the artifact.",
        failsWhen: "Correspondence is stored share-safe without anyone choosing it.",
      },
    ],
    spec: "specs/19-war-room-intake.spec.ts",
  },
  {
    id: "pasted-external-chat",
    ordinal: 4,
    title: "A pasted external chat triage of unknown origin",
    triageQuestion:
      "A colleague pasted in a chat transcript where some assistant already diagnosed this. How much weight can I put on it?",
    expectedEvidence: [
      "The transcript stored verbatim and readable in the investigation.",
      "A standing, unmissable banner marking it as an unverified imported run.",
      "The named source it was attributed to, chosen from the catalog rather than typed free-hand.",
    ],
    expectedProvenance: [
      "The importing operator's username and identity are recorded with the import.",
      "Evidence visibility is recorded as `unknown` unless the importer explicitly describes it.",
      "The import is a distinct record type from a run this deployment executed; it is never merged into the local run history as if it had been.",
    ],
    expectedUnknowns: [
      "What evidence the external assistant actually saw. The transcript is not proof it read anything.",
      "Whether the transcript was edited before pasting.",
      "The prompt, tools, model version, and any turns trimmed before the paste stay unknown and are not inferred.",
    ],
    usefulNextActions: [
      "Hand the transcript to Experiment Lab to compare its claims against locally frozen evidence.",
      "Ask the colleague which log the assistant was given, and record the answer on the timeline.",
      "Treat any citation in the transcript as a lead to verify, not as a finding.",
    ],
    deepLinks: [
      {
        id: "imported-run",
        purpose: "Land on the imported transcript with its unverified banner.",
        template: `${INVESTIGATION}/capture?section=triage-capture&item={importId}&kind=imported-run#triage-capture`,
      },
    ],
    assertions: [
      {
        id: "chat-unverified-banner-present",
        claim: "The imported transcript is visibly marked unverified wherever it is shown.",
        failsWhen: "The transcript reads like a finding this deployment produced.",
      },
      {
        id: "chat-operator-attributed",
        claim: "The importing operator is recorded and visible.",
        failsWhen: "The import is anonymous, so no one can be asked where it came from.",
      },
      {
        id: "chat-visibility-defaults-unknown",
        claim: "Evidence visibility stays unknown unless the importer described it.",
        failsWhen: "The surface implies the external assistant saw the case evidence.",
      },
      {
        id: "chat-not-counted-as-local-run",
        claim: "The import is kept separate from runs this deployment executed.",
        failsWhen: "The imported transcript appears in the local run history as an executed lane.",
      },
    ],
    spec: "specs/19-war-room-intake.spec.ts",
  },
  {
    id: "human-only-investigation",
    ordinal: 5,
    title: "A human-only investigation with no model lane at all",
    triageQuestion:
      "Our provider budget is gone and the incident is live. Can two engineers run this case end to end without launching a single model lane?",
    expectedEvidence: [
      "Uploaded evidence, a frozen snapshot, notes, hypotheses, and actions — all reachable with no comparison ever started.",
      "A timeline that reads as a narrative of human work, in order, with authors.",
      "A recorded decision that stands on its own without a lane result attached.",
    ],
    expectedProvenance: [
      "Every timeline entry is attributed to the person who wrote it.",
      "Entry kinds stay distinct: a hypothesis is not silently promoted into a finding.",
      "The frozen snapshot records exactly which evidence the humans were looking at.",
    ],
    expectedUnknowns: [
      "Nothing is asserted about model agreement, because no lane ran. The surface must not show an empty comparison as consensus.",
    ],
    usefulNextActions: [
      "Freeze the evidence now so that a later model comparison, if one is ever run, is bound to what the humans actually saw.",
      "Record the hypothesis as a hypothesis, so the next reader can see it was never confirmed.",
      "Export a share-safe brief for the incident channel.",
    ],
    deepLinks: [
      {
        id: "situation",
        purpose: "The at-a-glance state of the investigation for someone arriving cold.",
        template: `${INVESTIGATION}/situation`,
      },
      {
        id: "decide",
        purpose: "The decision and export stage.",
        template: `${INVESTIGATION}/decide`,
      },
    ],
    assertions: [
      {
        id: "human-only-no-lane-required",
        claim: "The case reaches a recorded decision with no comparison ever launched.",
        failsWhen: "Any stage blocks, empties, or nags until a model lane is run.",
      },
      {
        id: "human-only-entry-kinds-preserved",
        claim: "Note, hypothesis, and action stay visibly distinct on the timeline.",
        failsWhen: "A hypothesis is displayed with the same weight as an established finding.",
      },
      {
        id: "human-only-no-phantom-consensus",
        claim: "With no lanes run, no agreement or consensus is displayed.",
        failsWhen: "An empty comparison renders as agreement.",
      },
    ],
    spec: "specs/20-war-room-collaboration.spec.ts",
  },
  {
    id: "asynchronous-handoff",
    ordinal: 6,
    title: "A multi-person asynchronous handoff across a shift boundary",
    triageQuestion:
      "I am picking this up cold six hours after the last update. What did the previous responder establish, what did they only suspect, and what were they stuck on?",
    expectedEvidence: [
      "The previous responder's entries visible in order without expanding anything.",
      "An explicit unknowns block on the workstream, so open questions are not buried in prose.",
      "The frozen evidence the previous responder was working from, still bound to what they saw.",
    ],
    expectedProvenance: [
      "Each entry names its author, so the arriving responder knows who to ask.",
      "The two responders' contributions stay separately attributed rather than merged into a shared voice.",
      "A shared workstream address survives being copied into a chat message and opened by someone else.",
    ],
    expectedUnknowns: [
      "Anything the previous responder recorded as unknown stays unknown for the arriving one; the handoff does not resolve it by omission.",
      "Whether the previous responder finished their line of inquiry or ran out of shift.",
    ],
    usefulNextActions: [
      "Open the workstream link from the incident channel and read the unknowns first.",
      "Add a note continuing the previous line of inquiry under your own name.",
      "Re-freeze if new evidence arrived, rather than editing the previous snapshot.",
    ],
    deepLinks: [
      {
        id: "workstream",
        purpose: "The shareable address a departing responder pastes into chat.",
        template: `${INVESTIGATION}/analyze?section=workstreams&lane={workstreamKey}#workstreams`,
      },
    ],
    assertions: [
      {
        id: "handoff-authors-visible",
        claim: "Every contribution names its author to the arriving responder.",
        failsWhen: "Entries are anonymous or collapsed into one voice.",
      },
      {
        id: "handoff-unknowns-surfaced",
        claim: "Open questions appear as an explicit block, not buried in note text.",
        failsWhen: "The arriving responder must read every note to discover what was unresolved.",
      },
      {
        id: "handoff-link-survives-transfer",
        claim: "A copied workstream address opens the same work for a different signed-in person.",
        failsWhen: "The link resolves to a list, a 404, or someone else's default view.",
      },
      {
        id: "handoff-second-author-recorded",
        claim: "The arriving responder's own entry is attributed to them, not to the previous author.",
        failsWhen: "A later contribution inherits the earlier responder's name.",
      },
    ],
    spec: "specs/20-war-room-collaboration.spec.ts",
  },
  {
    id: "historical-backfill",
    ordinal: 7,
    title: "Historical backfill of an outage from three weeks ago",
    triageQuestion:
      "We are reconstructing a March outage in August for a postmortem. Can the record show when things happened without pretending we knew them then?",
    expectedEvidence: [
      "Backfilled entries carrying the event date they describe, not the date they were typed.",
      "The timeline distinguishing the reconstructed event order from the order the entries were written.",
      "Evidence uploaded now but describing the older window, with its own summary saying so.",
    ],
    expectedProvenance: [
      "Client time and server time are both retained and both visible, weeks apart.",
      "The backfill is attributed to the person doing the reconstruction, not to whoever was on call in March.",
      "Backdating changes the asserted event time only; it never rewrites the record's own write time.",
    ],
    expectedUnknowns: [
      "Whether the reconstructed order is right. It is a present-day human assertion about the past and is recorded as one.",
      "Anything not captured at the time. The backfill cannot recover evidence that was never collected, and must not imply it did.",
    ],
    usefulNextActions: [
      "Record each reconstructed step with its explicit event time and offset.",
      "Note which reconstructed times came from a log and which from someone's memory.",
      "Freeze the evidence gathered for the postmortem separately from any live incident snapshot.",
    ],
    deepLinks: [
      {
        id: "capture-backfill",
        purpose: "The timeline showing backfilled event times against their write times.",
        template: `${INVESTIGATION}/capture`,
      },
    ],
    assertions: [
      {
        id: "backfill-event-date-retained",
        claim: "A backdated entry keeps the historical event time the responder asserted.",
        failsWhen: "The event time is overwritten with the time the entry was created.",
      },
      {
        id: "backfill-write-time-not-rewritten",
        claim: "Backdating does not alter the record's own write time.",
        failsWhen: "The server-side write time moves to match the asserted event time, erasing that this was a reconstruction.",
      },
      {
        id: "backfill-both-times-visible",
        claim: "Both times are visible together, so a reader sees the gap.",
        failsWhen: "Only one timestamp is shown, making a three-week-old reconstruction look contemporaneous.",
      },
      {
        id: "backfill-attributed-to-reconstructor",
        claim: "The backfill is attributed to the person doing it now.",
        failsWhen: "The entry is attributed to whoever was on call during the original window.",
      },
    ],
    spec: "specs/20-war-room-collaboration.spec.ts",
  },
  {
    id: "new-evidence-rerun",
    ordinal: 8,
    title: "New evidence arrives, and the earlier comparison is rerun",
    triageQuestion:
      "A second log landed after we already compared. Does the earlier conclusion still hold, and can I tell the two runs apart?",
    expectedEvidence: [
      "A second frozen snapshot that includes the new file, recorded as a child of the first rather than replacing it.",
      "Both runs kept in the history, each showing which snapshot it was bound to.",
      "Distinct snapshot fingerprints, so no one can mistake the rerun for a rerun of the same inputs.",
    ],
    expectedProvenance: [
      "Snapshot lineage is explicit: the second snapshot names the first as its parent.",
      "Each run states the snapshot identity and fingerprint it was bound to.",
      "The first run's results are not retroactively re-described as covering the new evidence.",
    ],
    expectedUnknowns: [
      "Whether the difference between the two runs is caused by the new evidence. Two runs over different inputs do not establish that.",
      "Provider usage and cost for either run stay unknown.",
    ],
    usefulNextActions: [
      "Compare the two runs' evidence overlap rather than their prose.",
      "Re-read the earlier decision against the wider snapshot before keeping it.",
      "Keep the first snapshot rather than deleting it, so the earlier conclusion stays auditable.",
    ],
    deepLinks: [
      {
        id: "first-run",
        purpose: "The original run bound to the narrower snapshot.",
        template: `${INVESTIGATION}/analyze?section=triage-lane-runner&item={firstRunId}&kind=triage-run#triage-lane-runner`,
      },
      {
        id: "rerun",
        purpose: "The rerun bound to the widened snapshot.",
        template: `${INVESTIGATION}/analyze?section=triage-lane-runner&item={rerunId}&kind=triage-run#triage-lane-runner`,
      },
    ],
    assertions: [
      {
        id: "rerun-snapshot-lineage-explicit",
        claim: "The widened snapshot records the earlier snapshot as its parent.",
        failsWhen: "Re-freezing overwrites the earlier snapshot or drops the lineage.",
      },
      {
        id: "rerun-fingerprints-differ",
        claim: "The two runs report different snapshot fingerprints.",
        failsWhen: "Both runs claim the same fingerprint, hiding that the inputs changed.",
      },
      {
        id: "rerun-earlier-run-preserved",
        claim: "The earlier run stays in the history with its original binding.",
        failsWhen: "The rerun replaces the earlier run, or the earlier run is re-labelled with the new snapshot.",
      },
      {
        id: "rerun-no-causal-claim",
        claim: "The surface does not claim the new evidence caused the difference.",
        failsWhen: "A diff between two differently-bound runs is presented as an effect of the added file.",
      },
    ],
    spec: "specs/20-war-room-collaboration.spec.ts",
  },
  {
    id: "degraded-model-lanes",
    ordinal: 9,
    title: "Partial and failed model lanes",
    triageQuestion:
      "One lane failed and one came back partial. Is what is left still usable, and can I see what I am missing?",
    expectedEvidence: [
      "Each lane's own terminal state on its own card: completed, partial, or failed, never a single rolled-up verdict.",
      "The overall run marked partial rather than completed when a lane did not finish.",
      "An error code shown on the failed lane instead of an empty card.",
    ],
    expectedProvenance: [
      "The failed lane still names the model and profile it was assigned, so the gap is attributable.",
      "The partial lane's output is labelled partial wherever it is read, not just on the run summary.",
      "Every lane keeps the snapshot fingerprint it was bound to, including the ones that failed.",
    ],
    expectedUnknowns: [
      "What the failed lane would have said. The surface leaves it absent rather than interpolating from its peers.",
      "Whether the surviving lanes agreeing means anything. Agreement across a degraded run is explicitly not proof.",
      "Usage and cost stay unknown for every lane, degraded or not.",
    ],
    usefulNextActions: [
      "Read the surviving lanes' evidence citations rather than their conclusions.",
      "Rerun only if the failure looks environmental; otherwise record the gap and move on.",
      "Record the degraded state in the decision rationale, so a later reader knows the comparison was thin.",
    ],
    deepLinks: [
      {
        id: "degraded-run",
        purpose: "The run with mixed lane outcomes.",
        template: `${INVESTIGATION}/analyze?section=triage-lane-runner&item={runId}&kind=triage-run#triage-lane-runner`,
      },
      {
        id: "failed-lane",
        purpose: "The individual failed lane, addressed on its own.",
        template: `${INVESTIGATION}/analyze?section=triage-lane-runner&item={runId}:{candidateId}&kind=triage-candidate#triage-lane-runner`,
      },
    ],
    assertions: [
      {
        id: "lanes-per-lane-state-visible",
        claim: "Each lane shows its own outcome independently.",
        failsWhen: "One rolled-up status hides that a lane failed.",
      },
      {
        id: "lanes-failure-has-a-code",
        claim: "A failed lane shows an error code rather than rendering blank.",
        failsWhen: "The failed lane is empty, or is omitted from the run entirely.",
      },
      {
        id: "lanes-run-status-honest",
        claim: "A run with an unfinished lane is not reported as completed.",
        failsWhen: "The run reads completed while a lane failed.",
      },
      {
        id: "lanes-no-interpolation",
        claim: "The missing lane's output stays missing.",
        failsWhen: "The surface fills the gap from the other lanes, or averages them.",
      },
      {
        id: "lanes-usage-cost-unknown",
        claim: "Usage and cost read unknown on every lane.",
        failsWhen: "Any number is shown for usage or cost.",
      },
    ],
    spec: "specs/21-war-room-lanes-and-deployment.spec.ts",
    requires: "COLLAB_E2E_BRIDGE=degraded",
  },
  {
    id: "local-vs-shared-service",
    ordinal: 10,
    title: "The same investigation on a private workstation and on the shared service",
    triageQuestion:
      "I started this on my laptop and now the team needs it. What changes when the same investigation is on the shared deployment instead of mine?",
    expectedEvidence: [
      "A visible statement of which account kind the current session is using.",
      "Role-dependent controls that differ by signed-in person on the shared deployment.",
      "Share-safe export gated by role rather than offered to everyone.",
    ],
    expectedProvenance: [
      "Authored records keep their original author across deployment modes; they are not re-attributed to the local operator.",
      "The privacy class chosen on a private workstation still governs the artifact after it is shared.",
      "A share-safe export is scanned before it leaves, and fails closed when the scan finds something.",
    ],
    expectedUnknowns: [
      "Whether a private-workstation artifact is safe to share. The scan checks known patterns; it does not certify the content.",
      "What a viewer-role colleague will be able to see is determined by role mapping, which the local mode does not exercise.",
    ],
    usefulNextActions: [
      "Check the account kind before assuming a control is missing because of a bug.",
      "Re-check privacy class on every artifact before the first share-safe export.",
      "Ask an administrator for the role you need rather than working around the gate.",
    ],
    deepLinks: [
      {
        id: "profile",
        purpose: "The account kind and local-versus-directory statement.",
        template: "/profile",
      },
      {
        id: "decide-export",
        purpose: "The export stage where the share-safe gate applies.",
        template: `${INVESTIGATION}/decide`,
      },
    ],
    assertions: [
      {
        id: "deployment-account-kind-stated",
        claim: "The signed-in account kind is stated on screen.",
        failsWhen: "A responder cannot tell a local account from a directory account.",
      },
      {
        id: "deployment-role-gates-share-safe",
        claim: "Share-safe export is unavailable to a role that may not use it.",
        failsWhen: "A viewer-role account can produce a share-safe export.",
      },
      {
        id: "deployment-authorship-stable",
        claim: "Authored records keep their original author.",
        failsWhen: "Records are re-attributed to whoever is currently signed in.",
      },
      {
        id: "deployment-privacy-class-persists",
        claim: "An owner-only artifact stays owner-only when the case is shared.",
        failsWhen: "Sharing the investigation widens an artifact's privacy class.",
      },
    ],
    spec: "specs/21-war-room-lanes-and-deployment.spec.ts",
  },
  {
    id: "log-workbench-triage",
    ordinal: 11,
    title: "Side-by-side log workbench on Analyze",
    triageQuestion:
      "Can I open two logs from this investigation, find the timeout, save that view, and still have it after reload?",
    expectedEvidence: [
      "A Log workbench on Analyze that lists this investigation's imported files by human names.",
      "A truthful count of how many of those files the chooser is showing, and why a fifth pane will not open.",
      "Two panes open side by side on selected files.",
      "A search hit for the timeout line with an honest match count.",
      "A saved view that reappears after reload.",
    ],
    expectedProvenance: [
      "The files are investigation evidence, not entries in the global Sources catalog.",
      "Digests and ids stay behind technical details.",
    ],
    expectedUnknowns: [
      "The timezone of local worker timestamps until a person declares one.",
      "Whether a bounded search saw every later match.",
    ],
    usefulNextActions: [
      "Declare a timezone in Timezone review for the worker family.",
      "Freeze the selected evidence after the view is useful.",
    ],
    deepLinks: [
      {
        id: "log-workbench",
        purpose: "Land on the Log workbench in Analyze.",
        template: `${INVESTIGATION}/analyze?section=triage-log-workbench#triage-log-workbench`,
      },
    ],
    assertions: [
      {
        id: "workbench-named-on-analyze",
        claim: "Analyze shows a Log workbench for this investigation's files.",
        failsWhen: "The operator has to open the global Sources catalog to find the imported logs.",
      },
      {
        id: "workbench-file-filter",
        claim:
          "The file chooser narrows the investigation's files by human name or folder and states how many it is hiding.",
        failsWhen:
          "Finding one file among many means reading every row, the count hides the remainder, or the filter answers to a raw evidence id.",
      },
      {
        id: "workbench-two-panes",
        claim: "Two selected logs can be opened side by side.",
        failsWhen: "Only one file can be on screen at a time.",
      },
      {
        id: "workbench-pane-limit-refusal",
        claim:
          "A fifth file is refused with the four-pane limit stated, leaving every open pane where it was.",
        failsWhen:
          "Choosing another file silently closes one the responder opened, or nothing on screen says why it did not open.",
      },
      {
        id: "workbench-virtual-row-contract",
        claim: "Long records keep the fixed row height used by virtual scrolling.",
        failsWhen: "A wrapped row makes match navigation drift away from its recorded line.",
      },
      {
        id: "workbench-search-timeout",
        claim: "Search returns the timeout line with a match count.",
        failsWhen: "The timeout line is missing or the count is empty.",
      },
      {
        id: "workbench-saved-view-reload",
        claim: "A saved view is still listed after reload.",
        failsWhen: "Reload forgets the saved view.",
      },
    ],
    spec: "specs/26-log-workbench.spec.ts",
  },
  {
    id: "workbench-email-chat",
    ordinal: 12,
    title: "Email and chat sit beside logs without becoming logs",
    triageQuestion:
      "Support forwarded an email and a chat. Can I read them next to the logs without treating the conversation as a timestamped log?",
    expectedEvidence: [
      "The email and chat files listed in the Log workbench.",
      "The sentence that the conversation is not a log, searchable as written.",
    ],
    expectedProvenance: [
      "The files keep the names they had in the synthetic bundle.",
    ],
    expectedUnknowns: [
      "Whether the chat's 'around 02:30 local' matches the worker clock.",
    ],
    usefulNextActions: [
      "Search the logs for the request id named in chat.",
    ],
    deepLinks: [
      {
        id: "log-workbench",
        purpose: "Read email, chat, and logs in the workbench.",
        template: `${INVESTIGATION}/analyze?section=triage-log-workbench#triage-log-workbench`,
      },
    ],
    assertions: [
      {
        id: "workbench-email-visible",
        claim: "The support email is listed with the logs.",
        failsWhen: "The email never appears on Analyze.",
      },
      {
        id: "workbench-chat-not-a-log",
        claim: "The chat text that it is not a log is readable in search.",
        failsWhen: "The conversation is rewritten as a log line with a guessed timestamp.",
      },
    ],
    spec: "specs/26-log-workbench.spec.ts",
  },
  {
    id: "workbench-locator-privacy",
    ordinal: 13,
    title: "A copied log locator does not leak to someone who cannot open the case",
    triageQuestion:
      "If I copy a bookmark token, can a teammate who cannot open this investigation tell that the file exists?",
    expectedEvidence: [
      "An authorized reader can resolve the token to a line.",
      "An unauthorized reader gets the same not-found shape, with no path.",
    ],
    expectedProvenance: [
      "The token is a digest, not a filename.",
    ],
    expectedUnknowns: [
      "Whether the token refers to a missing bookmark or a hidden one — both look the same to the unauthorized reader.",
    ],
    usefulNextActions: [
      "Share the investigation membership instead of the token if the other person should see the line.",
    ],
    deepLinks: [
      {
        id: "log-workbench",
        purpose: "The workbench that minted the bookmark.",
        template: `${INVESTIGATION}/analyze?section=triage-log-workbench#triage-log-workbench`,
      },
    ],
    assertions: [
      {
        id: "workbench-locator-authorized",
        claim: "The owner can mint a bookmark token.",
        failsWhen: "No share-safe token is recorded.",
      },
      {
        id: "workbench-locator-unauthorized-404",
        claim: "A teammate without access gets no path and no investigation id.",
        failsWhen: "The unauthorized response names the file or the investigation.",
      },
    ],
    spec: "specs/26-log-workbench.spec.ts",
  },
] as const;

export function scenario(id: ScenarioId): WarRoomScenario {
  const found = WAR_ROOM_SCENARIOS.find((row) => row.id === id);
  if (!found) {
    throw new Error(`unknown War Room scenario: ${id}`);
  }
  return found;
}

/** Every assertion id in the catalog, in catalog order. */
export function allAssertionIds(): string[] {
  return WAR_ROOM_SCENARIOS.flatMap((row) => row.assertions.map((item) => item.id));
}

/**
 * Substitute `{name}` placeholders in a deep-link template.
 *
 * Braces rather than `:name`, because several of these ids legitimately
 * contain colons (a lane is addressed as `<jobId>:<candidateId>`) and a
 * colon-delimited syntax cannot tell a placeholder from a substituted value.
 *
 * Fails closed: an unsubstituted placeholder is a broken address, and shipping
 * one would make an acceptance run pass against a URL no human could reuse.
 */
export function deepLink(
  target: DeepLinkTarget,
  values: Readonly<Record<string, string>>,
): string {
  const path = target.template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : encodeURIComponent(value);
  });
  const leftover = /\{[A-Za-z][A-Za-z0-9]*\}/.exec(path);
  if (leftover) {
    throw new Error(`deep link ${target.id} left ${leftover[0]} unsubstituted`);
  }
  return path;
}
