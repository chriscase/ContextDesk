# Triage SDK Contract V2

Status: additive contract foundation; no production orchestration or provider
readiness claim.

This contract is the host-neutral boundary shared by a future Rust SDK, CLI
JSON/JSONL, Tauri IPC, HTTP/SSE, and deterministic mock/replay adapters. It has
no dependency on `AppConfig`, Tauri state, CLI arguments, Keychain, or a fixed
filesystem.

## Schemas

| Schema | Purpose |
| --- | --- |
| `contextdesk.triage.request.v2` | task, governed scope, exact policy selection, overrides, cancellation identity |
| `contextdesk.triage.run_event.v2` | ordered progress, role attempt, reconciliation, validation, and terminal event |
| `contextdesk.triage.result.v2` | authoritative grounded final or honest partial result |
| `contextdesk.triage.result_share_safe.v2` | metadata-only projection with no answer content or exact model identity |
| `contextdesk.triage.cancellation.v1` | identity-only cancellation request |
| `contextdesk.triage.replay.v1` | request fingerprint plus a contiguous event stream with exactly one terminal |

Unknown schema versions fail before payload parsing. New optional fields may
be added only without changing existing meanings; semantic changes require a
new schema version.

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
reviewer remain distinct phases. Legacy aliases and unknown V2 roles fail
closed during deserialization.

## Relationship to extension contracts

The earlier extension-contract lane supplies evidence-packet, negotiation,
role-capability, role-outcome, and privacy concepts. This change corrects two
important semantic points before integration: finalizer and reviewer are
distinct roles, and share-safe retrieval records store only a model
fingerprint rather than an exact private catalog id. Triage SDK V2 adds only
the missing request/run/result/cancellation/replay boundary.

## Non-claims

These DTOs do not run a provider, qualify a model, schedule contributors,
allocate budgets, validate a final causal answer, or make a release-readiness
claim. Production paths must later dogfood the same workflow and event stream;
the desktop receives no privileged orchestration API.
