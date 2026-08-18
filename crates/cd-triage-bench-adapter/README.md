# cd-triage-bench-adapter

Runs ContextDesk as **one strategy among many** in `cd-triage-bench`, over the
public SDK boundary only.

```text
Case + EvidenceSnapshot + EvaluationTask
  -> materialize_bounded_packet   visibility fail-closed (bench, then adapter)
  -> build_request                real TriageRequestV2::validate
  -> run_deterministic_mock | imported TriageReplayV1
  -> validate_public_replay       real TriageReplayV1::validate
  -> record_run                   owner-only; real TriageRun::validate
  -> project_share_safe           explicit projection; real scan_share_safe_text
```

Recording is **replay ingest**, not live execution. The mock and an imported
`TriageReplayV1` share one recording path. Usage and cost stay unknown.

## Boundary rules

| Rule | Where it is proved |
| --- | --- |
| Default tree is `cd-triage-sdk` + `cd-triage-runtime` + `cd-triage-bench` only | `tests/dependency_direction.rs` |
| No `cd-core`, `cd-workflow`, DuckDB, SQLite, keyring, `reqwest`, `tokio`, Tauri, or network transport by default | `tests/dependency_direction.rs` |
| No schema id or validator is redeclared here | `tests/dependency_direction.rs` |
| No filesystem, network, clock, env, or process access | `tests/dependency_direction.rs` |
| No case / adjudication / score / qualification / readiness / routing / private-store write | `tests/dependency_direction.rs` |
| Packet cannot widen past the task visibility policy | `tests/pipeline.rs` |
| Request identity uses the public runtime algorithm; packet/corpus identities stay separate | `tests/pipeline.rs`, `tests/fingerprints.rs` |
| Every terminal is a recorded run, never a discarded attempt | `tests/terminals.rs` |
| Imported replay uses the same recorder as the mock | `tests/replay_ingest.rs` |
| Failed-with-partial stays Failed | `tests/terminals.rs` |
| Share-safe export leaks no model identity, answer, or raw body | `tests/privacy.rs` |
| Fairness is `same_snapshot`; usage and cost stay unknown | `tests/pipeline.rs` |
| Phase graph agrees with `cd_workflow::triage::MockTriageRunner` | `tests/workflow_mock_conformance.rs` (feature `workflow-mock`) |

## Features

| Feature | Default | What it pulls in |
| --- | --- | --- |
| *(none)* | yes | `cd-triage-sdk`, `cd-triage-runtime`, `cd-triage-bench`, serde, thiserror |
| `workflow-mock` | no | `cd-core` (DuckDB, keyring) + `cd-workflow`, for conformance tests only |
| `live` | no | nothing — a placeholder, see below |

## Honest limits

* **The runtime facade is not a live host implementation.** The adapter uses
  its canonical request identity and replay validation, but does not call
  `triage()` / `triage_with_policy()`. The `live` feature carries no host
  engine dependency and makes no live claim. A guard test fails if default
  adapter code starts calling those execution functions.
* **The default engine is a deterministic mock.** It contacts no provider and
  never sees evidence bytes — a `TaskPacket` carries content *digests* only.
  When scripted to produce a grounded final answer, the answer envelope is
  derived from packet identities and is stamped with the
  `deterministic_mock` reason code.
* **Usage and cost stay unknown.** The public envelope reports neither, and
  unknown is not zero. Scripted `elapsed_ms` values are not measurements, so
  timing stays unknown too.
* **Owner-only is the default recording boundary.** The recorded run keeps the
  task text, the exact `ModelRef` per slot, and the full replay. Share-safe
  output is a separate, hand-written projection — never the same record with a
  relabelled boundary.
* **`scan_share_safe_text` is substring-based.** A literal bench `task-<hex>`
  identity contains `sk-` and is flagged as credential-shaped. The projection
  therefore exports a task *fingerprint*. See
  `bench_identities_are_projected_as_fingerprints_because_the_scanner_is_substring_based`.

## Fixtures

`fixtures/` holds committed goldens for the snapshot, task, packet, request,
recorded run, share-safe projections, and one replay per terminal, plus two
replays that the real parser must reject. Regenerate deliberately:

```bash
UPDATE_ADAPTER_FIXTURES=1 cargo test -p cd-triage-bench-adapter
```

## Checks

```bash
cargo fmt -p cd-triage-bench-adapter -- --check
cargo clippy -p cd-triage-bench-adapter --all-targets -- -D warnings
cargo test -p cd-triage-bench-adapter
cargo tree -p cd-triage-bench-adapter --edges normal

# non-default; compiles cd-core and DuckDB
cargo test -p cd-triage-bench-adapter --features workflow-mock
```
