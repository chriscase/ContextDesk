# Triage Policy V2 server replay surface v1

`POST /v1/triage/replay` is a provider-neutral **replay-only** SSE surface.
It accepts a `workspace_id` and an owner-authored
`contextdesk.triage.replay.v1` object, applies the server's existing API-key
workspace authorization, validates the complete replay before any event is
sent, then emits the original ordered `contextdesk.triage.run_event.v2` JSON
objects as `triage_run_event` SSE frames.

This endpoint does not execute a triage turn. It does not discover models,
load credentials, build a corpus packet, create an HTTP client, or contact a
provider. Production execution remains a separate host integration concern.

## Request

```json
{
  "workspace_id": "team-a",
  "replay": { "schema_id": "contextdesk.triage.replay.v1", "...": "..." }
}
```

The existing server request limit and the SDK's wire/event bounds limit the
transport and replay. The replay is fully validated before first-byte egress;
the SSE stream is a finite in-memory iterator over the bounded validated event
list.

## Error boundary

Errors use the content-free envelope
`contextdesk.triage.replay_error.v1`. They expose only a stable category such
as `unauthorized`, `forbidden`, `workspace_not_found`, `invalid_request`, or
`invalid_replay`; rejected owner-only event data is never echoed.

## Focused proof

```text
cargo test -p cd-server triage_replay -- --nocapture
```

The tests prove authorized ordered replay, cross-workspace refusal, contract
failure before streaming, and non-echoing invalid-request behavior. They are
hermetic and use no provider, credential, corpus, or network access.
