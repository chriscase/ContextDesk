# Incident-triage evaluation bench v1

**Status:** **Local integration.** The store/entities, manual
import/provenance, rubric v1 expert adjudication, report-only comparison,
public-SDK adapter, deterministic mock runner, and validated replay ingestion
are implemented. Live same-snapshot provider execution remains residual. This
does not close epic #876 and is not a readiness or release claim.

## Purpose

Answer, on frozen historical incidents: how did one whole triage strategy
compare to another — a human expert, a web-only assistant used by hand, another
product, or ContextDesk behind its public SDK — **without** absorbing
incident management into ContextDesk and **without** requiring a GUI.

This lane is separate from:

- #867 hermetic quality-eval (synthetic, component-level, CI-safe)
- production triage orchestration (`cd-core` / `cd-workflow`)
- the future web collaboration layer (#883–#888)

## Honesty rules

- `EvidenceSnapshot` identity is content-addressed; comparisons require the
  same task + snapshot.
- Case resolution/domain expertise is evaluation-only and cannot appear in a
  materialized task packet.
- Unknown cost, timing, prompts, and versions stay unknown.
- CLI import documents reject unknown fields even when generated ids are omitted.
- Unresolved cases remain valid without an invented root cause.
- Failed and partial runs are stored runs.
- Run identity includes material outcome and attribution metadata; conflicting
  re-imports become explicit near-duplicates instead of silently keeping the
  first writer's provenance.
- Legacy v1 adjudications without phase remain readable; new adjudications
  bind to generated review packets, verify computed blinding, and enforce
  support-before-diagnosis chronology.
- Reports use `backtest_report.v2`, expose partial score coverage, and keep
  version comparisons partitioned by source kind and strategy build.
- Reports never emit readiness, qualification, or routing badges.
- Manual import preserves raw bytes byte-exact.

## Durable packet privacy and migration

Newly materialized strategy packets use
`contextdesk.triage_bench.task_packet.v2`; reviewer packets use
`contextdesk.triage_bench.review_packet.v2`. Both schemas require an explicit
`privacy` field, and that field participates in the packet's content-derived
identity.

Packet privacy is monotonic. A task packet takes the most restrictive label
from its case, snapshot, evaluation task, and every selected evidence item. A
review packet additionally includes the run label and accepts raw output only
when its bytes match the run's recorded digest and length. Recognized
owner-only SDK replay envelopes remain owner-only. Store reads rematerialize
packets from their source records and reject a persisted packet whose privacy
or content does not match.

The v1 packet schemas did not carry privacy and are therefore not accepted as
durable packets. There is intentionally no blind in-place upgrade: regenerate
them from the preserved case/snapshot/task/run/blob records. Regeneration
changes packet ids; adjudications bound to a v1 review-packet id must be
regenerated and rebound to the corresponding v2 review packet. Missing or
unverifiable source material fails closed instead of being labeled
`share_safe`.

## ContextDesk SDK adapter (#879, draft)

`cd-triage-bench-adapter` runs ContextDesk as one strategy among many over the
public SDK boundary. It is a sibling crate, not part of `cd-triage-bench`, so
the bench keeps no engine dependency:

```text
snapshot -> bounded packet -> TriageRequestV2
         -> deterministic mock OR imported TriageReplayV1
         -> validate_public_replay -> owner-only TriageRun
         -> explicit share-safe projection
```

This is **replay ingestion**, not live execution. The host-neutral public
facade now supplies canonical request identity and replay binding; a later live
ContextDesk evaluation still needs a host implementation and same-snapshot
bridge.

What the adapter does **not** claim:

- No live run. The adapter does not call the runtime facade's `triage()` /
  `triage_with_policy()` functions, and its `live` feature remains a
  dependency-free placeholder with no host engine.
- No token usage or cost. The public envelope reports neither; unknown is
  not recorded as zero.
- No case, adjudication, score, qualification, readiness, routing, or
  private-store write inside ContextDesk crates.
- No host attestation of a production packet. Recording fails closed when
  `PacketReady` or the terminal packet identity differs from the adapter's
  materialized task packet. A validated provider-free pre-packet terminal is
  recorded separately as `execution_packet_state: not_produced`; it cannot
  carry a result or nonzero provider work.

Its default ContextDesk dependency tree is `cd-triage-sdk` +
`cd-triage-runtime` + `cd-triage-bench`; `cd-core` / `cd-workflow` are reachable
exclusively through the non-default `workflow-mock` conformance feature. See
[`crates/cd-triage-bench-adapter/README.md`](../../crates/cd-triage-bench-adapter/README.md).

## CLI

See [`crates/cd-triage-bench/README.md`](../../crates/cd-triage-bench/README.md).

```bash
cargo test -p cd-triage-bench
cargo run -p cd-triage-bench -- --library /tmp/bench-lib init
```

## Production anchors (this branch only)

- `crates/cd-triage-bench/`
- `crates/cd-triage-bench-adapter/` (#879 draft; mock only, no live path)
- Handbook row: Incident-triage evaluation bench in
  `docs/design/PROVEN_METHODS.md`

## Future scope (not this slice)

Web collaboration, object-storage ingestion, direct web-tool automation,
multi-strategy synthesis, similar-case retrieval, a batch runner over the
adapter, and any live ContextDesk provider execution (#879 residual).
