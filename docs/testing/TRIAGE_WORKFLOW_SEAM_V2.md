# Triage Workflow Seam V2

Status: host-neutral compilation and deterministic mock/replay contract only.

`cd_workflow::triage::compile_preflight` maps an explicit
`TriagePolicyV2` plus host-supplied `RolePreflightV2` facts to the pure core
`CompiledTriagePolicyV2`. It does not read `AppConfig`, credentials, a
Keychain, a filesystem, or a provider.

`MockTriageRunner` consumes that compiled plan through the
`TriageRoleExecutor` trait and emits the shared `triage_sdk` event stream:
`run_started`, `packet_ready`, one `role_attempt` for every compiled or
degraded slot, `reconciliation`, `validation`, and exactly one terminal event.
Cancellation, deadline, required-role dropout, optional degradation, and the
conditional reviewer are all represented as typed attempts with an honest
partial terminal result. The same input and script produce the same replay.

Residual work is the real host adapter: resolve policy selections and packet
identity in the CLI/desktop host, construct authorized role backends, and
implement `TriageRoleExecutor` around those backends. That adapter must retain
the same preflight facts, event ordering, slot accounting, privacy boundary,
and terminal invariant; this seam intentionally makes no readiness or provider
compatibility claim.
