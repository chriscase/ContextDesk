# Triage Policy V2 production runner — host-neutral V1

Status: **provider-neutral runner/resolver seam; not host-wired**

`cd_workflow::triage_production_runner` adds a reusable asynchronous runner
around the existing `contribution_pipeline` and `triage_production` seams. A
trusted host supplies the already-qualified `AuthorizedTriageBackendV1` values,
an immutable `FastTriagePacketV1`, and (for finalizer/reviewer roles) a
`TriageProductionHooks` implementation. The resolver performs exact slot/model
set checks and never reads configuration, credentials, endpoints, or provider
responses.

Enhanced and Advanced runs use the canonical ordered ledger:

```text
run_started → packet_ready → contributor attempts
  → preliminary_reconciliation → conditional reviewer attempt
  → final_reconciliation → finalizer attempt
  → validation → correction checkpoint → one terminal
```

The runner uses `run_contribution_pipeline` for contributor roles that fit the
existing validated contribution contract. Timeline/reviewer/finalizer calls
use the same opaque `ChatBackend` binding and a host hook for validation and
bounded correction. Whole-turn, phase, provider-call, context, cancellation,
and operation ceilings are enforced before each call. The ledger is owner-only
and is validated with the shared `TriageReplayV1` contract before return.

Standard mode is refused by this opt-in resolver so its established path is
unchanged. Until a hook returns a validated `AnswerEnvelopeV1`, a completed
graph still returns an honest partial deterministic result; model text cannot
establish root cause.

Focused hermetic proof:

```bash
CARGO_TARGET_DIR=/tmp/contextdesk-triage-runner-target \
  cargo test -p cd-workflow --lib triage_production_runner
CARGO_TARGET_DIR=/tmp/contextdesk-triage-runner-target \
  cargo clippy -p cd-workflow --lib --tests -- -D warnings
```

The suite covers identity refusal, owner-only ledger/terminal validation,
untrusted prompt boundaries, and same-model independence accounting. No live
gateway, credential, filesystem, CLI, Tauri, or server path is used.

Residual work: host adapters still need to resolve saved policy selections,
qualification evidence, credentials, and packet construction; a concrete
finalizer hook must project validated `AnswerEnvelopeV1`; and CLI/Tauri/server
must opt in explicitly. This slice makes no live compatibility or release
readiness claim.

Handbook impact: Triage Policy V2 remains **Partial**; this document records
the host-neutral execution seam and its honest-partial boundary.
