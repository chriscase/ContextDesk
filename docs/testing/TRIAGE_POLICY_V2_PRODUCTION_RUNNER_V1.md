# Triage Policy V2 production runner, resolver, and event ledger — V1

Status: **production-wired contributor subset; hermetically proven; no live
provider claim**

Branch: `claude/triage-policy-v2-runner-i4v37f`, developed from exact baseline
`2ba4a08dcca0feaaefe65eb89614103fb06ad294` (tip of
`integrate/triage-policy-sdk-v2`).

This slice closes the three residual blockers recorded by
[`TRIAGE_POLICY_V2_PRODUCTION_ADAPTER_V1.md`](TRIAGE_POLICY_V2_PRODUCTION_ADAPTER_V1.md):
a host resolver now derives exact `RolePreflightV2` facts plus authorized
backends from saved configuration and qualification evidence; the owner-only
V2 request/event/result stream is now projected from the production
contribution run by a typed event ledger; and a production CLI command now
selects the adapter end to end.

## What was added

| Piece | Location |
| --- | --- |
| Typed run observer + policy binding on the production contribution route | `crates/cd-core/src/multi_model/contribution_pipeline.rs` (`ContributionRunObserverV1`, `ContributionRouteRefusalV1`), `crates/cd-core/src/agent.rs` (`ContributionPolicyBindingV1`, strict route guards) |
| Response-character accounting for physical contributor calls | `ContributionStageTelemetry.output_chars` (additive, serde-default) |
| Host-neutral resolver: config + qualification + credentials → exact preflight facts + authorized backends | `crates/cd-workflow/src/triage_run.rs` (`resolve_triage_policy_v2`) |
| Production event ledger: typed projection into ordered `TriageRunEventV2` replay | `crates/cd-workflow/src/triage_run.rs` (`TriageRunLedgerV1`) |
| Share-safe projection of one owner-only replay | `crates/cd-workflow/src/triage_run.rs` (`share_safe_projection`) |
| Run facade over the shared linked-turn path | `crates/cd-workflow/src/triage_run.rs` (`run_triage_policy_v2_linked_turn`, `resolve_and_run_triage_policy_v2`) |
| Adapter projection capability for visible optional dropout | `crates/cd-workflow/src/triage_production.rs` (`V2ProjectionCapabilitiesV1`, `prepare_v2_contribution_runtime_with_projection`) |
| Request/policy content fingerprints | `crates/cd-core/src/triage_sdk.rs` (`request_fingerprint_v2`, `policy_fingerprint_v2`) |
| Production CLI caller | `contextdesk triage-policy run` (`crates/cd-cli/src/commands/triage_policy.rs`, stateful dispatch in `main.rs`) |
| Rust→TS parity golden for a completed production replay | `fixtures/triage-sdk/v2/replay.production-contributors.json`, asserted byte-exact in Rust and parsed in `packages/contracts/src/triageSdkV2.test.ts` |
| Adversarial manual mutations for the new enforcement points | `scripts/mutation/manual_high_risk.py` (8 new `triage_*` mutations; harness gained a per-mutation `package`) |

## Semantics enforced

- **Policy-bound strictness.** When a compiled policy owns the contribution
  runtime (`ContributionPolicyBindingV1` present), the linked turn refuses —
  with a typed, content-free reason and a normal terminal event — any route
  that would call a provider the policy did not admit: a focused (non-broad)
  task, a missing/incomplete deterministic brief, an invalid host packet, or
  a pipeline error. `None` keeps every established path byte-identical.
- **Exact identity end to end.** The ledger is constructed from the compiled
  plan and adapter bindings; every stage event and typed outcome row must
  match the exact `(slot_id, profile_id, model_id, role)` binding or the
  ledger poisons and terminates as `ledger_projection_mismatch` instead of
  misattributing work. Identity is never reconstructed from rendered prose.
- **Physical calls vs semantic corrections.** Per-attempt `input_chars` /
  `output_chars` / elapsed and run-level `provider_calls` come from typed
  pipeline telemetry; the correction allowance on this subset is structurally
  zero and reported as such. The ledger cross-checks the admitted call caps.
- **Same-model non-independence.** Reconciliation reports completed role
  slots, distinct exact models, and distinct gateways separately; one model
  in two roles counts once.
- **Role dropout stays visible.** With the new projection capability, an
  optional slot the compiler degraded stays configured-and-inert and appears
  as an explicit `not_admitted` role attempt with its compile rejection
  codes. Required rejections still fail compilation. Admitted finalizer /
  reviewer / timeline slots keep their typed adapter refusals.
- **Timeout / cancel.** Pipeline cancellation and whole-turn deadline become
  typed attempt statuses plus exactly one `cancelled` (echoing the request's
  cancellation identity) or `timed_out` terminal carrying an honest partial.
- **Budget bounds.** The request's user-authored overrides may narrow but
  never extend policy-authored deadline/call bounds; the effective deadline
  is enforced on the host router clock the turn actually reads.
- **Terminal honesty.** All-required-completed runs are `grounded_final`
  (host-validated floor answer; root cause never established on this
  subset). Anything else is an honest partial with the completed
  deterministic work attached, never hidden.
- **Share-safe events.** The share-safe projection drops terminals, strips
  exact model identity from role attempts, re-validates every retained event
  (including the forbidden-substring scan), and refuses rather than
  downgrades when a share-safe result cannot be produced. Model-authored gap
  labels never become ledger identity — gap ids are host-derived
  (`gap:<slot_id>:<n>`).
- **Standard unchanged.** Standard-mode policies refuse with
  `standard_uses_established_path`; the established single-model route
  remains authoritative, and all legacy contribution/review/fast-triage
  behavior is untouched when no policy binding is present.

## Hermetic proof

```bash
eval "$(scripts/local-build-cache.sh activate)"
export CARGO_BUILD_JOBS=2
cargo test -p cd-workflow --test triage_policy_run_ledger
cargo test -p cd-workflow --lib
cargo test -p cd-workflow --test triage_policy_production_adapter
cargo test -p cd-core --lib multi_model
cargo test -p cd-core --lib agent::tests::policy_bound
cargo test -p cd-core --test triage_sdk_contract_v2
cargo test -p cd-cli --test triage_policy_cli
cargo fmt --all -- --check
cargo clippy -p cd-workflow --lib --tests -- -D warnings
cargo clippy -p cd-core --lib -- -D warnings
cargo clippy -p cd-cli -- -D warnings
python3 scripts/mutation/manual_high_risk.py --output docs/mutation/triage-policy-runner-v1.json \
  --timeout 1500 --tested-sha HEAD --only triage_policy_route_guard_bypassed \
  --only triage_ledger_required_failure_ignored --only triage_ledger_cancellation_ignored \
  --only triage_ledger_same_model_counted_twice --only triage_share_safe_keeps_exact_model \
  --only triage_ledger_abstention_counts_as_completion \
  --only triage_ledger_accepts_mismatched_stage_identity \
  --only triage_adapter_binds_backends_for_degraded_slots
( cd desktop && npm ci && npm run typecheck \
  && npx vitest run ../packages/contracts/src/triageSdkV2.test.ts ../packages/client/src/triage.test.ts )
```

## Recorded results (this branch, 2026-08-12)

Every command above was executed on this branch in a hermetic environment
(no provider, gateway, credential store, or live corpus; shared local build
cache; `CARGO_BUILD_JOBS=2`):

| Gate | Result |
| --- | --- |
| `cargo test -p cd-workflow --test triage_policy_run_ledger` | 13 passed, 0 failed, 1 ignored (the golden regenerator) |
| `cargo test -p cd-workflow --lib` | 128 passed, 0 failed (includes the new `triage_run` resolver/override/privacy unit tests) |
| `cargo test -p cd-workflow --test triage_policy_production_adapter` | 5 passed, 0 failed |
| `cargo test -p cd-core --lib agent::tests::policy_bound` | 2 passed, 0 failed (strict refusal before any provider call; observer sees exactly one packet, four stages, one outcome) |
| `cargo test -p cd-core --lib multi_model` | 63 passed, 0 failed |
| `cargo test -p cd-core --test triage_sdk_contract_v2` | 16 passed, 0 failed, 1 ignored — pre-existing goldens stay byte-exact |
| `cargo test -p cd-cli --test triage_policy_cli` | 9 passed, 0 failed (6 pre-existing + 3 new `run` process tests) |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy -p cd-workflow --lib --tests`, `-p cd-core --lib`, `-p cd-cli` (all `-D warnings`) | clean |
| Manual adversarial mutations (8 targeted) | **8 killed, 0 survived, 0 unviable, 0 timeout** — `docs/mutation/triage-policy-runner-v1.json` |
| TypeScript parity (`triageSdkV2.test.ts` + `client/triage.test.ts`) | 2 files, 15 tests passed, including the new production-ledger `grounded_final` golden |
| `npm run typecheck` (desktop workspace, covers `packages/*`) | clean |

The committed golden `fixtures/triage-sdk/v2/replay.production-contributors.json`
is the byte-exact Rust serialization of a deterministic production-ledger run:
7 events (`run_started`, `packet_ready`, two completed `role_attempt` rows with
measured physical-call accounting — 2204/2223 input chars, 298/295 output
chars — `reconciliation` with 2/2 slots, 2 distinct models, 2 gateways,
`validation`, one `completed` terminal carrying the `grounded_final`/`passed`
result with `accepted_evidence_ids: ["opaque-a"]`).

## Residual gaps (not claimed)

- No live provider, gateway, credential store, or network was used; this
  establishes wiring and semantics, not live compatibility or usefulness.
- Tauri and cd-server still do not select the runner. The facade takes only
  `cd_core`/`cd_workflow` types (host, resolved inputs, cache root, request,
  policy), so both can call it; `cd-server` additionally needs a
  `cd-workflow` dependency before an SSE route can stream
  `TriageRunEventV2`. The TypeScript `TriageService` conformance suite
  already anticipates that stream.
- Live per-attempt V2 events: role attempts are appended when the typed
  outcome lands (phase-batched), not per stage; hosts stream progress via
  the established `MultiModelStage` events meanwhile.
- Admitted finalizer, reviewer, and timeline slots still refuse (typed);
  per-contributor operation caps smaller than the whole-turn deadline still
  refuse; retrieval specialists and `RetrievalSnapshotV1` remain unbuilt.
- The chat-session history/persistence surface is not integrated with `run`
  (a run is a standalone investigation command).
- CLI process tests prove the refusal paths hermetically; the completed-run
  path is proven at the workflow layer with scripted backends (no fake
  provider client was added — the scripted `ChatBackend` test doubles are
  the repository's established seam).
- The ledger's provider-call budget cross-check is defense-in-depth behind
  the pipeline's own enforcement; no honest flow can trigger it, so it is
  deliberately not in the mutation kill list.

Handbook impact: the two Triage Policy V2 rows in
[`PROVEN_METHODS.md`](../design/PROVEN_METHODS.md) move from "host resolver /
event projection / CLI selection unwired" to "CLI-wired contributor subset
with typed ledger; Tauri/SSE callers and finalizer/reviewer execution remain
open"; `TRIAGE_POLICY_V2.md` §current-production-adapter and the adapter
report's residual list are updated to point here.
