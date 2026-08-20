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
executes a bounded candidate list against the same proven `BoundedPacket` and
corpus revision. Each candidate still gets a distinct request/cancellation
identity and its own validated replay and persisted `TriageRun`. The strictest
candidate deadline bounds the entire comparison; shared cache, source limits,
and cancellation identity are required. Each candidate's request deadline is
its own override capped by that comparison deadline, independent of list
position and of how long any sibling took, so admission order does not hand
anyone extra wall clock. The budget is not divided between candidates — a
divided share can fall below the deadline a policy needs in order to run at
all — so boundedness comes from the concurrency ceiling and from refusing to
start another candidate once the budget is spent. The resulting rows are
immediately consumable by the existing honest bench report projection, which
preserves failed/partial runs and does not rank candidates.

## Bounded concurrency

The default comparison path runs **two** candidate lanes at once
(`DEFAULT_LIVE_COMPARISON_CONCURRENCY = 2`). Callers may pass
`run_live_comparison_with_options` (or `bench-compare --concurrency`) to use
`1` through `MAX_LIVE_COMPARISON_CONCURRENCY` (`4`). `1` restores sequential
admission. The scheduler never spawns one task per candidate up front: it
admits at most the configured number of in-flight lanes and starts the next
queued candidate only when a slot frees.

Exact-snapshot fairness is unchanged because every lane receives the same
immutable prepared packet, corpus id, and corpus revision. Provider
configuration, policy, role qualification, request fingerprint, cancellation
identity, replay proof, and durable `TriageRun` remain per-candidate. Lanes
do not share a `ToolHost`, workspace, cancellation registry, or other mutable
workflow state. Evidence bytes are copied and the host corpus is imported
exactly once.

A lower concurrency is often preferable when the provider rate-limits
concurrent requests. The host credential worker pool is already globally
capped at four outstanding keychain reads; the comparison ceiling stays at or
below that.

## Cancellation, deadlines, partial results, and sibling failure

A comparison that stops early — cancellation, deadline, request binding,
recording, persistence, or cleanup — still returns every run it already
persisted, with `LiveComparisonResult::stopped` naming the reason and
`LiveComparisonResult::lanes` distinguishing persisted, failed, and
not-started candidates in requested order. Only a comparison that persisted
nothing returns `Err`: durable rows must never be reported as an error with
their identities discarded.

- **Cancellation** sets the shared cancel flag, stops admitting queued
  candidates, and lets every in-flight lane observe the flag and persist
  whatever durable result it already produced.
- **Deadline** likewise stops admitting new work. In-flight lanes keep their
  own request deadline (the position-independent allowance). The comparison
  can overshoot by at most those in-flight allowances.
- **One lane failing while siblings run** does not drop a completed durable
  sibling. Admission closes so later queued candidates never start; already
  running siblings finish and persist. `runs` is the requested-order
  projection of persisted lanes, which is no longer necessarily a sequential
  prefix.

## Collab / UI progress

The Collab and CLI hosts still consume **one bounded final JSON result**
containing the candidate rows. This slice improves host-side wall-clock
completion; it does not add per-lane live progress events. Incremental UI
progress is a separate follow-up and must not be claimed by the web UI until
the protocol itself grows a backward-compatible, credential-free progress
shape.

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
