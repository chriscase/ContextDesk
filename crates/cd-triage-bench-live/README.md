# ContextDesk live triage benchmark bridge

This crate is the intentionally heavy, non-default bridge between the
source-neutral triage benchmark and the real ContextDesk workflow host.

It copies only the task-visible, content-addressed bytes into a private staging
directory; verifies every copy; imports those sources into a run-exclusive
corpus; proves the corpus inventory and revision; executes the public SDK
request through `cd-workflow`; and records the returned replay through the
proof-aware adapter path. The proof binds the exact resolved policy, production
packet and ledger digest, every host evidence id to its imported source, and
every recorded citation back to a task-visible benchmark evidence item. The
isolated corpus is discarded after every terminal or failure.

For comparisons, `run_live_comparison` prepares that isolated corpus once and
executes a bounded, sequential candidate list against the same proven
`BoundedPacket` and corpus revision. Each candidate still gets a distinct
request/cancellation identity and its own validated replay and persisted
`TriageRun`. The strictest candidate deadline bounds the entire comparison;
shared cache, source limits, and cancellation identity are required. Each
candidate's request deadline is its own override capped by that comparison
deadline, independent of list position and of how long earlier candidates
took, so sequential execution does not hand earlier candidates more wall clock
than later ones. The budget is not divided between candidates — a divided
share can fall below the deadline a policy needs in order to run at all — so
boundedness comes from refusing to start another candidate once the budget is
spent. The resulting rows are immediately consumable by the existing honest
bench report projection, which preserves failed/partial runs and does not rank
candidates.

A comparison that stops early — cancellation, deadline, request binding,
recording, persistence, or cleanup — still returns every run it already
persisted, with `LiveComparisonResult::stopped` naming the reason. Only a
comparison that persisted nothing returns `Err`: durable rows must never be
reported as an error with their identities discarded.

`LiveCorpusLimits::validate` refuses a limit above the published production
import bound, so a caller may lower a bound and never raise one.

The first live version accepts raw log evidence only. It rejects summaries,
time filters, non-log evidence, missing raw bytes, external-only references,
partial imports, and any source inventory drift.
The whole-run deadline starts before copy/import, and one cancellation signal
spans preparation and provider execution. Usage and cost remain unknown when
the public execution contracts do not report them.

Before managed ingest can publish, the bridge syncs a content-free cleanup
intent and holds a cross-process lease. A later process reclaims only the
orphaned corpus carrying that exact managed identity. Credential reads are
also deadline/cancellation bounded and share a fixed global worker limit, so a
blocked keychain cannot grow the blocking pool without bound.

Recovering that debt is bounded and non-fatal. `retry_pending_live_cleanup`
returns a content-free `PendingCleanupOutcome`; a marker it cannot resolve —
malformed, leased by a live run, or naming a corpus it cannot open — is
counted and left for a later attempt. Refusing to clean an old corpus deletes
nothing and protects nothing, so it must never brick every future run. The
invariant that still fails closed is `record_cleanup_intent`: a run whose own
cleanup cannot be tracked does not start.
