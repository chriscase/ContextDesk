# Triage runtime and evaluation-bench bridge v1

**Status:** Standard/Saved/Inline production host integration is implemented
locally on top of the validated #918/#920 baseline. Live same-snapshot bench
execution remains open; this is not a live-bench or release-readiness claim.

## Goal

Expose one host-neutral Rust runtime facade for Standard and policy-driven
triage, make ContextDesk's CLI and desktop hosts use that facade, and let the
source-neutral bench record live or replayed ContextDesk runs without weakening
packet, privacy, or fairness guarantees.

## Existing baseline

The validated baseline already contains:

- versioned request, event, result, cancellation, and replay DTOs in the leaf
  `cd-triage-sdk` crate;
- the pure Triage Policy V2 compiler and deterministic mock seam;
- the Enhanced/Advanced production runner, trusted ContextDesk host resolver,
  exact role qualification, deadlines, cancellation, reconciliation, and
  replay validation;
- CLI and Tauri Enhanced/Advanced execution through that trusted resolver;
- a pure offline bench adapter and deterministic mock recorder;
- source-neutral adjudication and comparison reporting over stored
  `TriageRun` rows.

This integration adds the public runtime facade, decouples validated replay
ingestion from the mock, and connects Standard/Saved/Inline execution to one
`cd-workflow` engine with canonical request identity, exact cancellation,
validated provisional events, and an authoritative returned replay. The
remaining piece is a provable live bridge from a bench evidence snapshot to a
ContextDesk corpus and packet.

## Dependency direction

```text
cd-triage-sdk             wire DTOs and validators only
       |
cd-triage-runtime         lightweight facade, canonical request identity,
       |                  preflight/execute/cancel/replay port
       |
cd-workflow               ContextDesk host implementations
       |
CLI / Tauri / optional live bench runner

cd-triage-bench ---------- source-neutral case, snapshot, run, review, report
       |
cd-triage-bench-adapter -- pure packet/request/replay/record projections
       |
optional live runner ----- depends on runtime + workflow only outside default CI
```

`cd-triage-sdk` must never depend on the runtime or workflow crates. The
default bench and adapter closure must remain free of provider, credential,
database, async-runtime, GUI, and network dependencies.

## Public runtime facade

The runtime facade owns no providers. It validates and fingerprints a
`TriageRequestV2`, invokes a caller-supplied engine port in the fixed order
`preflight -> execute`, validates the returned replay, checks exact request and
run identity, and derives the typed terminal outcome.

Expected host refusals are typed attempt outcomes, not discarded calls.
Preflight rejection can legitimately occur before an SDK packet/replay exists;
the live bench runner records that failure against its already-materialized
bench packet with an explicit `replay: none` provenance fact. Contract-invalid
requests remain import errors rather than fabricated engine attempts.

`triage(...)` accepts Standard selection only.
`triage_with_policy(...)` accepts Saved or Inline selection only. Calling the
wrong facade fails before host preflight and therefore before configuration,
credential, corpus, or provider access.

The canonical request fingerprint is SHA-256 over compact UTF-8 JSON after
removing the independently bound `run_id`, recursively sorting object member
names, and preserving array order, using the typed request's `serde_json`
scalar encoding. Excluding `run_id` avoids a cycle for deterministic adapters
that derive run identity from request identity; replay validation still binds
both independently. A fixed test vector guards the wire identity. CLI, Tauri,
workflow, and bench callers must converge on this implementation; raw input
bytes and adapter-private packet fields are not alternate request identity
algorithms. Packet and corpus fingerprints remain separate evidence.

Live event callbacks are provisional views. Before delivery, the facade binds
each event to the request's run id and fingerprint and enforces contiguous
sequence. Only the returned, fully cross-bound replay is authoritative.
A passed validation checkpoint may be superseded only by a later typed
`cancelled` or `timed_out` terminal whose honest partial is failed, carries no
answer or accepted evidence, and names the matching interruption reason. A
completed or ordinary failed terminal may never use that downgrade exception.

## ContextDesk host implementations

Host-specific adapters may receive `AppConfig`, credential stores, policy and
qualification stores, cache roots, and `ToolHost`, but none of those types
cross the public runtime boundary.

Enhanced/Advanced reuse the existing `preflight_for_policy`,
`resolve_v2_host`, `TriageProductionRunnerV1`, and `run_v2_host` path. The
`WorkflowTriageEngineV1` owns that adaptation; CLI and Tauri call
`triage_with_policy(...)` instead of duplicating policy overrides,
fingerprinting, resolver calls, terminal projection, or cancellation maps. The
desktop returns the authoritative replay across IPC; TypeScript validates it
and preserves the existing terminal-event client API. The adapter does not
create another provider client or policy compiler.

Standard preserves one exact gateway-scoped model and the established
deterministic linked-log behavior. Before provider synthesis begins, its host
captures an immutable broad-triage packet from the pinned corpus,
event/template/suppression revisions, and deterministic brief. The execution
phase consumes that prepared packet rather than rebuilding or widening it.
Dynamic evidence outside that packet is not permitted in an SDK Standard run;
scope or binding drift fails closed.

Standard replay shape remains:

```text
run_started -> packet_ready -> standard-finalizer attempt
            -> reconciliation -> validation -> terminal
```

A grounded final requires a host-validated `AnswerEnvelopeV1` whose binding
matches the prepared packet and pinned corpus revision. Rendered text or
`TextDelta` content is never parsed back into authority. Missing typed output,
binding drift, or packet drift yields an honest partial or typed failure.

## Replay ingestion

The pure adapter now records any public `TriageReplayV1` only after SDK phase
validation, runtime request/cross-event binding, and exact adapter packet,
policy, model, slot, and terminal checks. The deterministic mock goes through
the same recorder so terminal and provenance behavior cannot drift.

A replay that names the adapter's exact bench packet can be ingested directly.
A production replay normally names a ContextDesk packet instead; it requires
the live materialization proof below and must otherwise fail closed.
Cancellation before an engine packet exists is recordable only when the
adapter already established the bench visibility boundary; the record must say
that no execution packet or replay was produced.

## Live same-snapshot proof

`same_snapshot` is not established by equal labels. The optional live runner
must construct and retain this chain:

```text
bench snapshot + task visibility
  -> verified content-addressed blobs
  -> isolated source directory containing only visible supported items
  -> isolated ContextDesk corpus with complete import accounting
  -> pinned corpus revision
  -> immutable ContextDesk packet id/digest
  -> validated SDK replay/result
  -> owner-only bench TriageRun
```

The first production slice supports visible held log items only. Email,
attachment, external-reference, missing-blob, widened, duplicate, unsafe-name,
or unsupported-format input fails before credential or provider access. This
restriction does not reduce the bench's source-neutral evidence model; it
states honestly which evidence the ContextDesk strategy adapter can execute.

The runner uses sanitized deterministic source filenames and retains an
owner-only mapping from each ContextDesk source label to the originating bench
item id and content digest. It verifies before execution:

- every visible item is represented exactly once;
- every blob digest and byte length match the snapshot;
- aggregate imported source bytes match the visible held bytes;
- imported file count matches the supported visible item count;
- no selected source was excluded, failed, truncated, or left partial;
- the temporary corpus contains no non-visible source;
- the pinned corpus revision is unchanged when the packet is built.

The source directory and isolated cache are private temporary directories;
source files are owner-readable only. Inventory verification and import occur
before any credential lookup or provider construction. A live-batch deadline
and cancellation signal cover blob verification, materialization, import,
packet preparation, provider execution, recording, and cleanup; the remaining
allowance, never the original allowance, is passed into the triage runtime.

The SDK request uses the isolated ContextDesk corpus id and pinned revision.
Its `source_ids` remain empty because the isolated corpus itself is the exact
visibility boundary; the current host correctly rejects unsupported non-empty
source restrictions.

The owner-only materialization proof records both the bench packet/corpus
fingerprints and the executed ContextDesk packet id/digest. The share-safe
projection retains only approved fingerprints, counts, terminal facts, and
bounded reason codes.

Canonical answer citations are mapped as:

```text
claim evidence id -> validated answer evidence row -> ContextDesk source label
                  -> owner-only materialization map -> bench evidence item id
```

An absent or ambiguous mapping makes the run unscorable or rejected; the
adapter never treats a ContextDesk event id as if it were a bench item id.

Temporary sources and corpora are removed on success, failure, timeout, and
cancellation. The live runner writes no ContextDesk qualification, readiness,
routing, case, adjudication, or score state.

## Usage, cost, timing, and privacy

Missing accounting stays unknown. Provider-round counts are not physical
transport-call counts, and neither is converted into token usage or cost.
Timing is recorded only from a host measurement with explicit start/end
provenance. Raw provider bodies, prompts, credentials, endpoints, private
paths, exact model identities, answer text, and evidence excerpts remain
owner-only.

## Required proof

Hermetic tests must cover:

- facade dispatch, preflight ordering, cancellation, replay identity, and all
  terminal kinds;
- Standard prepared-packet reuse, no evidence widening, exact model binding,
  deadline/cancellation before provider contact, typed-answer validation, and
  one terminal event;
- Enhanced/Advanced facade parity with the existing CLI/Tauri host path;
- replay ingestion independent of the deterministic mock;
- live materialization success plus missing, changed, extra, unsupported, and
  partial evidence refusals before provider contact;
- citation mapping and ambiguous/missing mapping refusal;
- owner-only completeness and share-safe privacy scanning;
- stored live and replayed runs appearing in existing adjudication packets and
  comparison reports without special report code;
- default dependency-direction checks and optional-live feature isolation.

The current production-host slice covers Standard and configured-policy facade
dispatch, canonical identity, exact cancellation registration/cleanup, all
typed terminal projections, Standard's exact six-event graph and model binding,
workflow host cleanup after failed corpus binding, CLI/Tauri configured-policy
selection, authoritative desktop replay return, TypeScript replay validation,
and the existing default dependency direction. Live materialization items above
remain required before a same-snapshot live-bench capability claim.

Focused fast lanes should cover the leaf SDK, runtime facade, bench, and
adapter. Production-path workflow tests belong in the existing Rust shards.
No CI change may rename or replace the required main gate
`rust tests (ubuntu aggregate)`, and macOS/Windows shard and aggregate coverage
must remain intact.
