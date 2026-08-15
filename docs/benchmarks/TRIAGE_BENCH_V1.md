# Incident-triage evaluation bench v1

**Status:** **Local integration.** The #877 store/entities first slice is on
`main` (#890/#891). This branch adds manual import/provenance (#878), rubric
v1 + file/CLI expert adjudication (#880), and report-only comparison over
stored records (#881). The SDK-driven batch runner is residual until #879.
Not a close of epic #876. Not a readiness or release claim.

## Purpose

Answer, on frozen historical incidents: how did one whole triage strategy
compare to another — a human expert, a web-only assistant used by hand, another
product, or (later) ContextDesk behind its public SDK — **without** absorbing
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
- Reports never emit readiness, qualification, or routing badges.
- Manual import preserves raw bytes byte-exact.

## ContextDesk SDK adapter (#879, draft)

`cd-triage-bench-adapter` runs ContextDesk as one strategy among many over the
public SDK boundary. It is a sibling crate, not part of `cd-triage-bench`, so
the bench keeps no engine dependency:

```text
snapshot -> bounded packet -> TriageRequestV2 -> deterministic mock replay
         -> owner-only TriageRun -> explicit share-safe projection
```

What the adapter does **not** claim:

- No live run. `triage()` / `triage_with_policy()` do not exist in this
  workspace; the adapter drives the versioned contracts only, and its `live`
  feature is a dependency-free placeholder.
- No token usage or cost. The public envelope reports neither.
- No case, adjudication, score, qualification, readiness, routing, or
  private-store write inside ContextDesk crates.

Its default dependency tree is `cd-triage-sdk` + `cd-triage-bench` only;
`cd-core` / `cd-workflow` are reachable exclusively through the non-default
`workflow-mock` conformance feature. See
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
