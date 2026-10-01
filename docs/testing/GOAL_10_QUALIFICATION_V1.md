# Goal 10 qualification and independent-review receipt

Status: draft integration, unmerged. Publication and the final applicable full
pass are reported against the exact committed head/tree in the draft PR body.
This receipt records the focused evidence on the source that precedes that
commit; committing the receipt does not change the qualified implementation.
No evidence-only follow-up is required to record hosted checks.

## Provenance and scope

- Repository: `chriscase/ContextDesk`.
- Owned branch: `integrate/evidence-label-workspace-v1`.
- Base: `c672948b8b74471b197ecf848a26fecadd0eece9`.
- Base tree: `806a1613e4a9b048ba9808b49155f0d3449b3f3d`.
- Frozen [user request](../goals/10-STRUCTURED-EVIDENCE-LABELS.md) SHA-256:
  `ca94a8f8b2e69d551cd99396c6d0325468f4486f2528abea38ab0ac5166877a9`. Copied byte-for-byte.
- Existing dirty/unpushed work and historical integration branches were retained.
  This slice extends the shipped annotation stack; it introduces no parallel
  inventory, annotation API, capability, or portable archive version.
- Normal publication of source, tests and sanitized evidence is authorized.
  Merge, ready-for-review promotion, issue closure, rewrite, release and
  successor-goal work are excluded.

## Contract, durable model and privacy

The shared strict parser accepts 1–120 trimmed safe single-line UTF-16 code
units, with existing control/bidi constraints, exact case-sensitive equality,
and explicit `add`/`remove`. There is no normalization, alias, toggle, taxonomy,
AI labeling, ranking or facet search. Exact duplicates collapse; case variants
remain distinct. Privacy lanes are independent: removing a share-safe label
does not remove an owner-only add with the same text.

A typed optional `labelEvent` extends `ArtifactAnnotationV1`. The existing
immutable row binds UUID event identity, case, artifact, body/hash, privacy,
author identity/name, server time and source. Its label payload binds exact
text, operation, artifact/privacy-lane sequence and stable parent intent key.
The server projects filtered history deterministically and returns a strictly
checked `currentLabels` list. Add and remove remain append-only; no artifact
identity, bytes, privacy, provenance, ownership or membership is rewritten.

The existing case-scoped command freezes 1–64 unique IDs, label, operation,
privacy and idempotency key. A case transaction serializes events and commits
the parent replay record, timeline and generic audit atomically. Canonical
request hashing ignores property and target order; semantic changes conflict.
The request is copied before its first await. Per-target outcomes distinguish
`applied`, `replayed`, `already_desired`, and visibility-safe `not_found`.

No new permission is introduced. Existing annotation authority governs writes;
owner-only label writes also require current private-read authority. The server
rechecks current visibility on replay. Hidden artifacts and unknown IDs share
`not_found`; revoked private-write/replay attempts fail uniformly. Private label
rows are filtered before counts and projection. Private label events, including
share-safe labels on private artifacts, are absent from the mixed public timeline
and recent activity. Protected annotation history and generic audit remain.
Sequences expose only the artifact/privacy lane. Separate public/protected
allocations each cap label events at 25,000 per case (50,000 combined), so a full
hidden allocation cannot change a public mutation's capacity or sequence.

SQLite uses the existing transactional annotation document. PostgreSQL adds
checked `label_event` JSONB to the same immutable annotation table; migration
033 rejects missing/null fields, extra keys, unsafe text and unbounded sequence,
with unique case/artifact/privacy ordering. Existing insert-only protections
reject UPDATE/DELETE. Its guarded downgrade refuses while label history exists.

## Uncertain recovery and presentation

Pending/unresolved label intent retains copied IDs, exact text, operation,
privacy and key. Network/protocol/server/unknown equivalents freeze it. The
read controller exposes initiation/completion identities; an earlier or
overlapping read cannot authorize replay. Only the latest successful same-scope
read initiated after the uncertain result can do so. Desired-state proof ends
recovery without another mutation; otherwise retry is explicit and sends the
same intent/key. Every subsequent uncertain result revokes prior permission.
Render-time epoch and callback guards prevent retained actions, authority
replacement, and A→B→A from reviving an old request before passive cleanup.
Ordinary selection changes do not rewrite frozen targets. Known note failures
keep their own feedback; a label submission takes ownership of shared command
status, preventing false note warnings from an uncertain label result.

`EvidenceAnnotationWorkspace` shows selected evidence, current exact labels,
durable notes/history, explicit add/remove and privacy controls, and truthful
unavailable/stale/loading states. Investigation First retains its existing
selection. Keystone adopts the same workspace through public Runtime and its
existing working set. Both mounts supply a frozen canonical label model from
Runtime; the shared kit owns structural view types and never imports wire
contract behavior or maintains another label truth model. Both are mounted in the actual-server browser proof.
Beacon has no compatible evidence selection; War Room's CaseBoard selection
uses its separate existing transport rather than a Runtime annotation surface.
Neither receives a parallel inventory or extra read for visual symmetry.

Exact portable export refuses with a typed `label_history_unsupported` result
and explanatory UI text. The existing export authorization precedes disclosure.
Dry-run of an archive claiming label activity is inexact and offers no apply
token; apply without a valid exact token refuses. The archive schema is not
versioned. Goal 06 partial export handoffs and Goal 07/09 separate review/benchmark
paths remain covered by the full collaboration regression suite.

## Focused qualification

- Canonical contract: 3 tests, strict request/event/result/list bindings,
  rejects malformed and ambiguous mutations, shuffled history, duplicates,
  exact case variants and privacy lanes.
- Durable label suite: 10 tests, Memory/real SQLite/real PostgreSQL. Concurrent
  same-intent replay, conflicting semantics, competing ordered add/remove,
  mixed attachment/log/private/missing targets, no-op adds, retained add history,
  exact current projection, actual byte reads and unchanged artifact records.
  SQLite closes/reopens its database; PostgreSQL constructs a fresh store and
  requeries durable rows. Audit failure rolls back rows, parent intent and
  timeline on all three backends, including after reopening. Direct PostgreSQL
  writes exercise checks and insert-only enforcement. Public capacity is tested
  against a seeded full protected allocation.
- Live HTTP case suite: 24 tests, including contributor→case-lead→contributor
  private-label grant/revocation, filtered reads/replay and no activity leak.
- Portable suite: 40 tests with real PostgreSQL enabled, including protected
  history with no public timeline, truthful export refusal, lossy incoming
  activity rejection and no issued apply token. ExportPanel: 27 tests.
- Mounted shared workspace: 10 label tests plus 6 existing note tests. Bulk
  controller: 20 tests. Covers repeated unknown, failed/overlapping reads,
  same-intent retry, desired-state recovery without a second mutation, retained
  callbacks before passive cleanup, A→B→A and private visibility replacement.
- Existing Keystone component suite: 12 tests passed during focused work.
- Migration suite: 16 real-PostgreSQL tests passed.
- Help corpus and Proven Methods structural checks passed.

Required timing repeats run in five separate processes, 30/30 tests each
(label workspace plus bulk controller), with no retries or skips:

| Run | Exit | Wall seconds |
| --- | --- | --- |
| 1 | 0 | 1.263 |
| 2 | 0 | 1.267 |
| 3 | 0 | 1.248 |
| 4 | 0 | 1.238 |
| 5 | 0 | 1.243 |

The next unused spec prefix is 44. The dedicated config has one worker and
zero retries. With `CD_GOAL10_JOINED=1`, it starts the actual built server on a
disposable SQLite database, serves the actual web build, and uses synthetic
local authentication and synthetic evidence only. A committed POST followed by
a deliberately lost acknowledgment freezes the operation; refreshed durable
history recovers with exactly one POST. It adds/removes across mixed selected
artifacts in Investigation First, adds a case variant in Keystone, checks
unchanged inventory, refuses exact portable export, restarts the actual server,
reauthenticates and reloads retained exact labels. At 390 px it checks keyboard
focus/Tab order, forced-colors and reduced-motion media, visible outline,
zero transition and workspace width.

Three independent final-source Chromium journeys passed with no retries:

| Run | Exit | Wall seconds |
| --- | --- | --- |
| 1 | 0 | 5.159 |
| 2 | 0 | 3.688 |
| 3 | 0 | 5.069 |

[Sanitized narrow Keystone screenshot](../assets/goal10/keystone-narrow-forced-colors.png)
was inspected for legibility, controls and overflow. Its SHA-256 is
`445ed43ddc384db368e377dac5d57878f0815119441503f02cc118910d29c794`.
The joined test explicitly skips without its real-server opt-in; a generic
fixture-browser run is not this proof. The dedicated local qualification has
no environment skips. The unchanged hosted fixture lane does not opt into it.

## Temporary mutation proof

Each mutation was temporary, ran a focused assertion, failed as expected, and
restored the source byte-for-byte to its previous SHA-256 before continuation.
No mutation is present in the candidate.

| Mutation | Detection | Filtered exclusions |
| --- | --- | --- |
| Case-fold projection keys | 1 failed, 2 passed | 0 |
| Permit private label activity | 1 failed | 23 |
| Permit pre-unknown read at barrier | 1 failed | 8 |
| Remove retained epoch guard | 1 failed | 19 |
| Disable authoritative portable-history refusal | 1 failed | 39 |
| Remove bulk atomic boundary | 3 failed, one per backend | 7 |

The exclusions above are intentional test-name filters, not environment skips.
Raw logs, disposable stores, local absolute paths and fixture auth material are
kept local; this receipt publishes summarized synthetic evidence only.

## Bounded adversarial source review

One separate read-only source campaign compared this slice with its base.
Findings closed within the same campaign: private activity/sequence counts,
equivalent uncertain-result unlocking, retained retry after repeated unknown,
canonical property-order binding, nullable SQL checks, and hidden quota oracle.
The narrow follow-up on the defensive request snapshot, export messaging and
note ownership found a stale note flag; its closure also preserved known-note
failure feedback, with a mounted regression. A final narrow wiring recheck
confirmed canonical semantics flow through public Runtime after the boundary
correction, with no new finding. Final reviewer disposition:
**no remaining actionable findings**. Source review is not test execution,
independent hosted verification or a broad product acceptance claim.

## Prior failures, independent blockers and nonclaims

Development failures remain visible: initial TypeScript union/envelope errors
were repaired; early browser attempts used the Overview presentation instead
of Investigations, assumed a short checkbox accessible name, and attempted a
desktop account control at mobile width. The corrected journey uses the existing
route/name and restores desktop width before reauthentication. An initial
note-feedback refinement was corrected after source review. Its first test
invocation used the repository root instead of the collab workspace and failed
to start; the corrected invocation passed. Earlier successful repeat runs were
retained locally, then repeated after the final feedback correction.

The first committed-candidate full pass at `da7632cd` passed typecheck/lint,
948 contract tests and 1,434 server tests (19 environment skips), but failed one
web architecture-boundary assertion (1,850 web tests passed). It reported three
inline type imports and the shared kit's direct contract-behavior import.
Ordinary type imports and a canonical public Runtime model close this without
weakening the boundary checker. The 52-test affected suite then passed, and the
required five timing/three browser processes were repeated on the correction.
The correction is a normal follow-up commit, with reviewed history retained.
The final exact-head full result is reported in the draft PR body.

Baseline root CI [36768372784](https://github.com/chriscase/ContextDesk/actions/runs/36768372784)
on the base is still attempt 1, completed/failure, Windows Rust shard 4 job
110068410035. The failure log confirms
`comparison::tests::live_comparison_deadline_returns_durable_partial_results`
at the temporary `log_corpora` cleanup assertion. No targeted rerun is recorded.
This independent baseline blocker is unresolved; no Rust test was changed or
rerun. The known #1176 Catalog synchronization candidate remains separate.
Postmerge collab 36768372793 and collab-qualify 36768372799 are the supplied
successful Goal 09 baseline, not Goal 10 acceptance.

No untouched Rust/desktop campaign was repeated. This slice claims no search
facets, label taxonomy, portable label round-trip, provider/model quality,
production data validation, performance benchmark, deployment, merge or release.
The full local suite may skip unrelated absent LDAP/provider environments; its
exact counts and hosted status are reported in the draft PR. Hosted checks may
still be pending at review handoff. Goals 08/09 and bulk notes are documented
as shipped; Goal 10 stays unmerged; facets and portable round-trip stay separate.

## Exact changed-file manifest

This manifest includes this receipt and the synthetic screenshot. The final
commit's manifest is rechecked before publication. No lockfile, private recovery
archive, raw log, local database or credential file is included.

```text
collab/contracts/schemas/artifact-annotation-bulk-request.v1.json
collab/contracts/schemas/artifact-annotation-bulk-result.v1.json
collab/contracts/schemas/artifact-annotation-list.v1.json
collab/contracts/schemas/artifact-annotation.v1.json
collab/contracts/src/artifact-annotation.ts
collab/contracts/src/evidence-annotations.ts
collab/contracts/src/evidence-labels.test.ts
collab/contracts/src/evidence-labels.ts
collab/contracts/src/index.ts
collab/e2e/evidence-labels.playwright.config.ts
collab/e2e/specs/44-structured-evidence-labels.spec.ts
collab/server/src/db/migrate.test.ts
collab/server/src/db/migrations/033_evidence_label_events.down.sql
collab/server/src/db/migrations/033_evidence_label_events.up.sql
collab/server/src/modules/cases/cases.test.ts
collab/server/src/modules/cases/evidence-labels.test.ts
collab/server/src/modules/cases/routes.ts
collab/server/src/modules/cases/service.ts
collab/server/src/modules/cases/store.ts
collab/server/src/modules/portable-investigations/portable-investigations.test.ts
collab/server/src/modules/portable-investigations/routes.ts
collab/server/src/modules/portable-investigations/service.ts
collab/web/src/ExportPanel.test.tsx
collab/web/src/ExportPanel.tsx
collab/web/src/investigations/runtime/InvestigationRuntimeProvider.tsx
collab/web/src/investigations/runtime/annotation-contract.ts
collab/web/src/investigations/runtime/controllers/use-artifact-annotations.test.tsx
collab/web/src/investigations/runtime/controllers/use-artifact-annotations.ts
collab/web/src/investigations/runtime/gateway.test.ts
collab/web/src/investigations/runtime/gateway.ts
collab/web/src/investigations/runtime/public.ts
collab/web/src/investigations/runtime/testkit/fixtures.test.ts
collab/web/src/investigations/strategies/investigation-first/InvestigationFirstStrategy.tsx
collab/web/src/investigations/strategies/keystone/KeystoneStrategy.tsx
collab/web/src/investigations/strategies/shared/EvidenceAnnotationWorkspace.test.tsx
collab/web/src/investigations/strategies/shared/EvidenceAnnotationWorkspace.tsx
collab/web/src/investigations/strategies/shared/EvidenceLabelWorkspace.test.tsx
collab/web/src/styles/investigation-strategy-shared.css
docs/assets/goal10/keystone-narrow-forced-colors.png
docs/design/PROVEN_METHODS.md
docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md
docs/design/proven-methods/INVESTIGATION_LOOP.md
docs/goals/10-STRUCTURED-EVIDENCE-LABELS.md
docs/help/war-room/war-room-evidence-review.md
docs/testing/GOAL_10_QUALIFICATION_V1.md
```
