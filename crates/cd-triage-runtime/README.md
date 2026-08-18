# cd-triage-runtime

`cd-triage-runtime` is the public, host-neutral execution port above the
wire-only `cd-triage-sdk` crate. It validates and fingerprints requests,
enforces Standard versus policy-aware dispatch, requires preflight before
execution, validates returned replays, and exposes a typed terminal outcome.

It is not a provider implementation. Provider discovery, configuration,
credentials, corpus resolution, network access, retries, deadlines, and
cancellation mechanics remain behind the caller's `TriageEngine`
implementation. Streamed events are provisional; only the validated replay
returned by the engine is authoritative.

ContextDesk host wiring and evaluation-bench live execution are follow-up
integration work. This crate does not read files, configuration, or secrets and
does not open network or database connections.

## Request fingerprint

The canonical request fingerprint is computed only after contract validation:

1. serialize the typed `TriageRequestV2` to a JSON value;
2. remove `run_id`, which is independently replay-bound and may be derived
   from the fingerprint by deterministic adapters;
3. sort object member names recursively, while preserving array order;
4. emit compact UTF-8 JSON using `serde_json` scalar encoding;
5. hash those bytes with SHA-256 and prefix the lowercase hex digest with
   `sha256:`.

The runtime tests retain a fixed compatibility vector. Other implementations
must match that vector before producing replay identities for this facade.

Engine methods use shared references so a host can dispatch a request-bound
cancellation through interior state while execution is still in flight.
Provisional event sinks are bound to the validated request's run id,
fingerprint, and contiguous sequence before any callback receives an event.

Focused checks:

```text
cargo clippy -p cd-triage-runtime --all-targets -- -D warnings
cargo test -p cd-triage-runtime
cargo tree -p cd-triage-runtime --edges normal,build,dev --target all
```
