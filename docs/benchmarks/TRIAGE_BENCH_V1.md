# Incident-triage evaluation bench v1

**Status:** **Local integration** on `integrate/rc` plus the public-SDK mock
adapter branch (issues #876/#877/#878/#879 and report-only #880/#881).
Offline crate `cd-triage-bench`. Not shipped on `main`. Not a readiness or
release claim.

## Purpose

Answer, on frozen historical incidents: how did one whole triage strategy
compare to another — a human expert, a web-only assistant used by hand, another
product, or ContextDesk behind its public SDK mock adapter — **without** absorbing
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
- Failed, partial, timed-out, and cancelled runs are stored runs.
- The public-SDK adapter materializes packets under the task visibility
  policy and fails closed on evidence widening. Default CI uses the
  deterministic mock engine only.
- Reports never emit readiness, qualification, or routing badges.
- Manual import preserves raw bytes byte-exact.

## CLI

See [`crates/cd-triage-bench/README.md`](../../crates/cd-triage-bench/README.md).

```bash
cargo test -p cd-triage-bench
cargo run -p cd-triage-bench -- --library /tmp/bench-lib init
```

## Production anchors (this branch only)

- `crates/cd-triage-bench/`
- Handbook row: Incident-triage evaluation bench in
  `docs/design/PROVEN_METHODS.md`

## Future scope (not this slice)

Web collaboration, object-storage ingestion, direct web-tool automation,
multi-strategy synthesis, similar-case retrieval, and live ContextDesk
provider execution (the hermetic mock adapter is the #879 CI path).
