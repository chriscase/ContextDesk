# Triage SDK Contract V2

Status: additive public contract used by the production CLI/Tauri runtime and
the hermetic bench adapter; no provider-readiness claim.

This contract is the host-neutral boundary shared by the Rust SDK, CLI
JSON/JSONL, Tauri IPC, HTTP/SSE, and deterministic mock/replay adapters. It has
no dependency on `AppConfig`, Tauri state, CLI arguments, Keychain, or a fixed
filesystem.

## Schemas

| Schema | Purpose |
| --- | --- |
| `contextdesk.triage.request.v2` | task, governed scope, exact policy selection, overrides, cancellation identity |
| `contextdesk.triage.run_event.v2` | ordered progress, role attempt, phase-specific reconciliation, validation, bounded correction, and terminal event |
| `contextdesk.triage.result.v2` | authoritative grounded final or honest partial result |
| `contextdesk.triage.result_share_safe.v2` | metadata-only projection with no answer content or exact model identity |
| `contextdesk.triage.cancellation.v1` | identity-only cancellation request |
| `contextdesk.triage.replay.v1` | request fingerprint plus a contiguous event stream with exactly one terminal |

Unknown schema versions fail before payload parsing. New optional fields may
be added only without changing existing meanings; semantic changes require a
new schema version.

The public boundary is bounded before host work: 4 MiB per wire object, 64 KiB
task text, 1 MiB inline policy, 256 source identities, 64 reason codes, 4,096
evidence identities or replay events, a one-hour explicit deadline, and 64
provider calls. Opaque identities are nonempty and at most 512 bytes. Inline
policies must name `contextdesk.triage_policy.v2` both in the selector and the
document. Rust and TypeScript reject the same overflow and schema mutations.

## Authority and privacy

`ModelRef` is the exact `(profile_id, model_id)` identity returned by the
configured catalog. It is not qualification, capability, quality, cost, or
readiness evidence. Namespaced model ids such as `openai/gpt-oss-120b` are
preserved verbatim.

A request is owner-only because it contains task text and may contain an inline
policy. An authoritative completed event is owner-only because its validated
answer envelope may contain bounded evidence excerpts. Share-safe exports use
the separate result projection and omit the answer plus exact model identity.
The projection is scanned and validated before export.

## Replay law

- sequence numbers are contiguous from zero;
- the first event is `run_started` and repeats the replay request fingerprint;
- every event has the same run identity;
- exactly one of `completed`, `failed`, `timed_out`, or `cancelled` occurs;
- the terminal is the last event;
- failure, timeout, and cancellation may carry an owner-only honest partial so
  completed deterministic work is not hidden;
- role attempts and reconciliation summaries remain explicit, including
  abstention, invalid output, unavailable roles, timeouts, cancellation,
  failures, and non-admission.

Hosts may attach their own delivery framing, but may not reorder, recreate, or
infer authoritative events from displayed prose.

Role attempts use Triage Policy V2's shared `TriageSlotKindV2` directly. A
contributor carries the closed typed contributor role, while finalizer and
reviewer remain distinct phases. The host-neutral mock graph emits
`preliminary_reconciliation` after contributors and `final_reconciliation`
after the conditional reviewer, then places the finalizer, host validation,
and one bounded `correction` checkpoint before the terminal. Standard mode may
continue to use the legacy single-finalizer sequence for byte/behavior
compatibility. Legacy aliases and unknown V2 roles fail closed during
deserialization.

The correction event is a host checkpoint, not model output: the deterministic
mock runner reports `applied: false`, while the production workflow runner owns
the bounded validation/correction hook. `WorkflowTriageEngineV1` resolves
Standard, saved, and inline selections for both CLI and Tauri, binds exact
authorized backends, and emits the same validated replay vocabulary. Standard
keeps its dedicated one-finalizer graph; Enhanced and Advanced remain
qualification-gated and fail closed before provider work when the host cannot
prove every required binding.

## Qualification binding and physical accounting

V2 preflight facts may carry the additive `qualification_schema_id`,
`workflow_id`, and `protocol_fingerprint` fields. A positive qualification for
Enhanced or Advanced policies is accepted only when all three are present and
equal to `contextdesk.triage.qualification.v2`, `contextdesk.triage.role.v2`,
and a bounded protocol fingerprint. Partial, stale, or mismatched stamps fail
closed. For migration, an all-absent stamp remains readable for Standard
preflight records because Standard's existing single-model behavior is
unchanged; omission never authorizes an expanded policy. Compiled slots carry
the stamp forward so later host stages cannot silently substitute a different
workflow or protocol.

`TriageRoleAttemptV1` has additive `physical_provider_calls`,
`semantic_corrections`, and `terminal_disposition` fields. Physical calls count
provider operations (including transport retries), semantic corrections count
content-bearing correction attempts, and disposition is the explicit terminal
state for that slot. They are independently bounded and validated; a
not-admitted role cannot claim calls, and a supplied disposition must match the
attempt status. Existing JSON may omit these fields and remains readable as a
legacy record with unknown accounting, but omission is never interpreted as
zero or as successful completion.

## Relationship to extension contracts

The earlier extension-contract lane supplies evidence-packet, negotiation,
role-capability, role-outcome, and privacy concepts. This change corrects two
important semantic points before integration: finalizer and reviewer are
distinct roles, and share-safe retrieval records store only a model
fingerprint rather than an exact private catalog id. Triage SDK V2 adds only
the missing request/run/result/cancellation/replay boundary.

## Non-claims

These DTOs alone do not run a provider, qualify a model, schedule contributors,
allocate budgets, validate a final causal answer, or make a release-readiness
claim. Those responsibilities live in the production workflow host, which uses
this same request/event/result/replay boundary; the desktop receives no
privileged orchestration contract. Exact model qualification, live usefulness,
cost, and release readiness remain separate evidence.
