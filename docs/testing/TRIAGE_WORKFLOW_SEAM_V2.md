# Triage Workflow Seam V2

Status: host-neutral compilation and deterministic mock/replay contract only.

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

Residual work is the real host adapter: resolve policy selections and packet
identity in the CLI/desktop host, construct authorized role backends, and
implement `TriageRoleExecutor` around those backends. The existing
`triage_production` adapter is a narrower contributor-only preparation seam;
it is not selected by CLI/Tauri and does not execute the full graph. No host
currently wires finalizer, reviewer, correction, or these V2 replay events to
a live provider. Any future adapter must retain the same preflight facts,
event ordering, slot accounting, privacy boundary, and terminal invariant;
this seam intentionally makes no readiness or provider compatibility claim.
