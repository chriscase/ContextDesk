# Gateway diagnostic lifecycle safety v1

This note records two provider-neutral safety invariants for `contextdesk
gateway diagnose`.

1. A deadline or user cancellation never lets the shared qualification worker
   outlive the diagnostic cleanup phase. The existing qualification token is
   passed to the production transport; non-streaming OpenAI-compatible,
   Ollama, and Anthropic requests race that token and drop the in-flight client
   future when it is set. The diagnostic then joins the worker before it may
   discard its temporary corpus or session state.
2. Share-safe terminal and persisted diagnostic reports contain a relative run
   reference only, never an absolute artifact directory. Owners resolve that
   reference beneath `--out` or the local default
   `<data-dir>/cache/gateway-diagnostics`; optional raw data remains local and
   owner-only.

Focused proofs:

```text
cargo test -p cd-workflow non_streaming_live_probe_cancellation_drops_a_stalled_provider_operation
cargo test -p cd-cli --lib qualification_timeout_waits_for_worker_exit_before_cleanup_can_continue
cargo test -p cd-cli --lib qualification_user_cancel_waits_for_worker_exit_before_terminal_cancelled
cargo test -p cd-cli --lib mutation_absolute_artifact_path_is_never_projected_to_terminal_or_share_safe_output
cargo test -p cd-cli --test gateway_diagnose
```

The first test uses the existing mock gateway with a request that has reached
the wire and deliberately stalls. It asserts that setting the established
qualification token drains the real blocking transport worker. The CLI tests
then assert timeout/cancel join ordering and reject an injected absolute
artifact path from share-safe output.

This is hermetic coverage. It does not make a live-provider compatibility or
release-readiness claim.
