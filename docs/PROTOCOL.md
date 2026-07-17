# Protocol sketch — `cd.v1`

Stable event names for desktop, server SSE/WS, and embed hosts.  
Version prefix allows breaking changes later (`cd.v2`).

## Client → core

| Message | Purpose |
|---------|---------|
| `session.create` | New chat session in a workspace |
| `session.prompt` | User message (+ optional skill force) |
| `session.cancel` | Abort in-flight turn |
| `permission.respond` | allow_once / deny / allow_session_path |
| `workspace.configure` | roots, connectors, active provider profile |

## Core → client (stream)

| Event | Payload (conceptual) |
|-------|----------------------|
| `turn.started` | session id, model |
| `text.delta` | markdown chunk |
| `thought.delta` | optional reasoning chunk |
| `tool.started` | id, name, compact summary |
| `tool.finished` | id, status, preview, full (lazy) |
| `citation` | source ref, span |
| `search.trail` | sources probed |
| `permission.required` | write intent, preview, risk |
| `turn.completed` | usage, finish reason |
| `error` | code, message (safe) |

## Embed guidance

Hosts should treat the stream as the UI contract. Do not scrape private core types across crate versions without semver.

## Non-goals for v1 protocol

- Full ACP parity with coding agents  
- Binary file transfer in-band (use paths / side channels)  

## Versioning policy

- `cd_core::PROTOCOL_VERSION` is the frozen string for this major (`cd.v1`).
- Additive optional fields on events are allowed without bumping.
- Renaming/removing event `type` discriminants requires `cd.v2` and a migration note in this file.
- Hosts should ignore unknown event types for forward compatibility.
