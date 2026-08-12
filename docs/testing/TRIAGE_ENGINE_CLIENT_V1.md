# Triage EngineClient Adapter V1

Status: provider-free TypeScript adapter and conformance foundation. It does
not wire a production Tauri or HTTP command and makes no live-model claim.

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
- owner-only terminal content and exact model identities cannot be relabelled
  share-safe;
- the import/time conformance suite remains unchanged and green.

## Residual production wiring

`createTauriEngineClient` intentionally installs an unsupported triage service.
A later production slice must add thin Tauri commands that call the Rust
policy compiler and host-neutral workflow, forward the shared event stream,
bind cancellation, and return the authoritative terminal. It must not port the
compiler or orchestration into TypeScript. HTTP/SSE support should implement
the same `TriageService` and run this conformance suite.
