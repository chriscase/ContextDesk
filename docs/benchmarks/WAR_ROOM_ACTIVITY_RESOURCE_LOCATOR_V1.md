# War Room activity and resource locator v1

Status: **local integration** on the War Room next-release train.
This is a collab **contract, server, store, web, and test** slice. The Overview
consumes the projection as a readable activity feed with exact native links
and a Copy link action. It does not add a desktop host or Rust change.

Schema IDs:

- `cd-collab.investigation_resource_locator.v1`
- `cd-collab.investigation_activity_item.v1`
- `cd-collab.investigation_activity_page.v1`
- `cd-collab.investigation_resource_resolve.v1`
- `cd-collab.investigation_activity_error.v1`

Routes (authenticated, read-only):

- `GET /api/investigation-activity`
- `GET /api/cases/:id/investigation-activity`
- `GET /api/investigation-resources/resolve?locator=`

`GET /api/activity` and `GET /api/overview` remain unchanged. A locator is not
an authorization token.

## Activity-source authority

Authoritative state is the existing investigation timeline (`timeline_events` /
memory timeline) plus the durable records those events name (cases, evidence,
contributions, snapshots). Activity items are a **deterministic projection**.
This slice does not persist a second feed, so there is no second source of
truth to drift.

- Duplicate delivery of the same timeline row yields the same `activityId`.
- Reordered delivery is sorted by `occurredAt DESC`, `investigationId ASC`,
  `seq DESC`, `activityId ASC`.
- A failed metadata write cannot publish a partial feed: projection runs
  inside the same store the domain write already committed.
- Rebuild / reconciliation: replay `listTimeline` / `listRecentTimeline` and
  project again. Canonical JSON of the page is byte-identical for the same
  authorized state.

Overview reads a bounded recent window of 500 source events. Investigation-
scoped reads use the full timeline for that case.

## Locator versioning

Compact form: `cdl.v1/{installationId}/{investigationId}/{kind}/{resourceId}[;rev=N]`.

JSON locators also carry a **derived** pathname
`/investigations/{uuid}/{stage}?...#section` from `routedInvestigationFocus`.
Discussion comments use `section=discussion` (legacy `case-discussion` still
parses). Job-level workstream events open the Analyze run record
(`triage-lane-runner`, `kind=triage-run`). Lane attempts open the workstream
record (`workstreams`, `kind=workstream`, with `lane`). Parsers reject:

- unknown kinds and version ≠ 1
- malformed installation, investigation, or resource ids
- path traversal, `..`, encoded dots/slashes, fragments that do not match
- control characters and URL injection
- pathname that does not match the derived destination
- missing revision on `decision_revision`
- investigation locators whose resource id is not the investigation id

Private evidence content, credentials, excerpts, customer names, and
filenames do not appear in locators or URLs. Opaque ids remain for machine
consumers and Technical details views.

Resolution reauthorizes at request time. Cross-investigation substitution,
dangling resources, **kind-confused locators** (for example a note id presented
as `evidence_item`, a snapshot id presented as `evidence_item`, an intake
batch id presented as `evidence_item`, an experiment or gold id presented as
`decision_revision`, a gold snapshot presented as `decision_revision`, or a
helpfulness observation presented as `comparison_finding`), wrong
revisions, and unauthorized private evidence all fail closed as `not_found` so
existence is not leaked. Timeline fallback matches the same projected
`locator.kind` + `resourceId` (+ revision when supplied) as the activity feed;
contribution provenance also requires the durable kind (`message`, `note` /
`handoff`, `hypothesis`, `action`) rather than any row with that id.
`corpus_intake_committed` projects `intake_batch` at the batch id and Capture
`corpus-intake` / `kind=intake-batch`, not Analyze evidence.
Portable restore remaps investigation and resource ids, including intake-batch
ids from `targetNamespace=intake_batch`, gold snapshot ids from
`targetNamespace=gold` (`experiment_gold_promoted`), helpfulness
observation ids from `targetNamespace=helpfulness`
(`experiment_helpfulness_recorded`), `${experimentId}:${traceId}`
composites from `targetNamespace=experiment` (`experiment_trace_imported`),
and `${jobId}:${candidateId}` composites from `targetNamespace=triage_job`
(`triage_candidate_*`; persist refuses dropped or bare-job targets), and
snapshot ids from `targetNamespace=snapshot` (`snapshot_frozen`; persist
refuses dropped snapshot targets), and imported-run ids from
`targetNamespace=imported_ai_run` (`external_run_imported`; persist refuses
dropped imported-run targets), and contribution ids from
`targetNamespace=contribution` (`contribution_*` / `hypothesis_status`; persist
refuses dropped contribution targets), and evidence ids from
`targetNamespace=evidence` (`evidence_*`; persist refuses dropped evidence
targets);
resolve is re-run
against the destination identities after apply and remains `not_found` for
kind-confused or unauthorized locators. `experiment_gold_promoted` projects
`gold` at the gold snapshot id and Decide `decision-heading`, not the
experiment or accepted decision id. `experiment_helpfulness_recorded` projects
`helpfulness` at the observation id and Compare `cross-exam-heading`, not the
experiment id. `experiment_trace_imported` projects `interaction_trace` at
`${experimentId}:${traceId}` and Compare `candidate-comparison-heading`, not
the experiment id or `evidence_context`. `experiment_imported` projects
`experiment` at the experiment id and Compare `candidate-comparison-heading`,
not `comparison_finding`. Live `experiment_decision_*` writes address the
decision id (`targetId` = decision id) so activity is not payload-dependent;
portable persist refuses archives that drop `targetNamespace=decision`.

## Privacy and authorization

- Investigation membership (or admin) is required to see any item.
- `owner_only` items are visible only to authorized members and never include
  filename, excerpt, or body.
- Redacted or omitted records project a generic summary such as "omitted
  evidence" without content.
- Historical restored usernames (`historical-*`) display as
  "Historical participant".
- AI / imported output has `provenanceClass` `ai_generated` or `imported` and
  `humanFinding: false`.

## Human-label behavior

Helpers never invent a title. When the recorded label is missing, a GUID, a
hash, a fingerprint, a package id, or a raw event name, the projection uses a
bounded fallback (`Evidence item`, `Workstream attempt`, `Investigation`,
`Historical participant`, `Participant`). A short numeric suffix is allowed
only for timeline event seq.

## Pagination and filtering

Opaque base64url cursors encode `{ v, occurredAt, investigationId, seq, activityId, filterFingerprint }`.
Malformed or stale cursors (including filter mismatch or a cursor whose item
is no longer in the authorized projection) fail closed. They do not restart
from the beginning.

Bounded filters: investigation, actor, activity kind, stage, workstream, time
window, and `assignedToMe` when `assignedTo` / `assigneeId` / `ownerId` is
recorded. Assigned-to-me is not invented when that identity data is absent.

## Shipped in this slice versus residual UI

Shipped here: locator contract, activity projection, authorization/privacy
boundary, memory and PostgreSQL projection over existing stores, authenticated
read APIs, the Overview feed consumer, exact shipped-section routing, copied
activity URLs, and focused tests.

**Not shipped:** Overview pagination/filter controls, desktop/Rust consumers,
an export timeline kind (export locators exist; export lifecycle projects only
when a timeline event already exists), unbounded overview history beyond the
500-event window, and any claim that AI output is a human finding.
