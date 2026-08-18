# Triage Workflow Seam V2

Status: host-neutral compiler/mock contract plus a production CLI/Tauri runtime
over the same public replay boundary.

`cd_workflow::triage::compile_preflight` maps an explicit
`TriagePolicyV2` plus host-supplied `RolePreflightV2` facts to the pure core
`CompiledTriagePolicyV2`. It does not read `AppConfig`, credentials, a
Keychain, a filesystem, or a provider.

`MockTriageRunner` consumes that compiled plan through the
`TriageRoleExecutor` trait and emits the shared `triage_sdk` event stream. For
Enhanced and Advanced policies the graph is deliberately sequential:

```text
run_started → packet_ready → contributor role_attempts
  → preliminary_reconciliation → conditional reviewer role_attempt
  → final_reconciliation → finalizer role_attempt
  → validation → bounded correction checkpoint → one terminal event
```

The reviewer attempt is retained as `reviewer_not_required` when its host
condition is false, so a consumer cannot mistake a skipped challenge for a
missing role. Every configured or degraded slot receives one typed attempt in
phase order. Standard keeps its established single-finalizer replay sequence
(`role_attempt → reconciliation → validation → terminal`) so enabling V2
contracts does not silently alter the default mode.

Cancellation, deadline, required-role dropout, optional degradation, and the
conditional reviewer are represented as typed attempts with an honest partial
terminal result. The correction checkpoint is explicit but always marked
`applied: false` with `mock_correction_not_wired`; it is a graph boundary, not
a claim that a provider correction backend exists. Same-model role attempts
are counted once in reconciliation's distinct-model fields. The same input and
script produce the same replay.

The real host adapter now exists. `WorkflowTriageEngineV1` resolves exact
policy selection and packet identity, derives host-owned preflight facts,
binds authorized backends, and is selected by both CLI and Tauri through the
public runtime facade. `triage_production` remains the narrow contributor
preparation seam; `triage_production_runner` owns Standard's finalizer path and
the Enhanced/Advanced contributor, conditional-reviewer, finalizer,
validation, and bounded-correction graph. Provider work remains gated by exact
host qualification and cancellation/deadline/budget checks. This proves a
production path, not universal provider compatibility, answer usefulness, or
release readiness.

## Hardened integration checkpoint

The exact integrated branch checkpoint `integrate/triage-policy-sdk-v2` at
`59f7bc61` adds the adversarial state-machine lane and closes the remaining
replay/runner gaps:

- Enhanced/Advanced replay accepts only the canonical preliminary-review-final
  phase order; Standard retains its legacy finalizer-first sequence.
- Required contributor failure makes the finalizer explicitly not admitted;
  optional dropout cannot swallow a cancellation/deadline boundary.
- Additive qualification fields reject explicit JSON `null` while preserving
  omission-based Standard migration.
- The adversarial suite covers phase reordering, duplicate terminals, same-model
  false consensus, budget oversubscription, malformed reason codes, dropout,
  cancellation/timeout, finalizer eligibility, and share-safe privacy.

Focused evidence at this checkpoint: 9 adversarial tests, 17 SDK contract tests
(1 ignored golden regeneration), 29 core policy tests, 15 workflow unit tests,
7 CLI tests, and clippy with `-D warnings` for `cd-core`, `cd-workflow`, and
`cd-cli`. These remain hermetic; no live provider or release-readiness claim is
made.

## Cross-language replay parity checkpoint

At `49492c2f`, the Rust and TypeScript SDK boundaries accept the same V2 event
vocabulary and phase rules. TypeScript now validates `preliminary_reconciliation`,
`final_reconciliation`, and `correction`, and applies the Rust replay ordering
rules (including the intentional cancellation-before-validation boundary).
The contract test also fixes the qualification-binding mutation to remove a
field rather than reassign the already-valid fixture value. Rust's focused SDK
contract suite remains green after the cancellation parity correction. This
checkpoint was a contract milestone; the later production runtime host now
consumes the same cross-language boundary.
