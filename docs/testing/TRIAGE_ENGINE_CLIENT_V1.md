# Triage EngineClient Adapter V1

Status: provider-neutral TypeScript adapter with a production Tauri command
surface and a replay-only HTTP/SSE surface. It makes no live-model or release
readiness claim.

## Shared boundary

The existing `EngineClient` now has an additive `triage` namespace. Existing
`import`, `time`, and `events` behavior is unchanged. The namespace exposes:

- explicit capability status;
- host preflight consumption returning the Rust-owned compiled policy shape;
- run and replay consumption over ordered `TriageRunEventV2` values;
- exact cancellation identity and standard `AbortSignal` support;
- per-run and subscribed delivery of the same event objects.

TypeScript never compiles a policy. The strict contract parser consumes the
Rust-generated standard-policy golden. The deterministic mock receives the
same host-shaped preflight and replay values through its scenario and only
models transport delivery, abort/cancel selection, and subscription behavior.

## Proved hermetically

- exact host preflight bytes survive unchanged;
- run and replay preserve sequence and one terminal event;
- completed and cancelled honest partial results remain partial;
- pre-abort and exact active cancellation select a host-authored cancellation
  replay rather than inventing success;
- unsupported adapters report capability false and reject with the typed
  `unsupported` error;
- the Tauri adapter routes preflight, execution, cancellation, and replay to
  the Rust-owned host resolver and returns the same ordered event objects;
- owner-only terminal content and exact model identities cannot be relabelled
  share-safe;
- the import/time conformance suite remains unchanged and green.

## Remaining wiring and boundaries

`createTauriEngineClient` now calls the thin Tauri commands
`triage_preflight_v2`, `triage_run_v2`, and `triage_cancel_v2`. Rust owns policy
selection, qualification, packet construction, provider calls, validation,
cancellation, and cleanup; TypeScript only parses DTOs and forwards the one
ordered event stream. The HTTP/SSE route currently exposes validated replay
only, so a headless live runner still needs an authenticated stateful host
before it can claim live execution. Both surfaces must continue to use the
same `TriageService` contracts and conformance suite.
