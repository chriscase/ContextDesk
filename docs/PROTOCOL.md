# Protocol — `cd.v1` (shipped wire + sketch)

Version prefix allows breaking changes later (`cd.v2`).

## Shipped wire today (desktop / research DTO)

The live IPC path is **Tauri commands** + stream **`EventDto`** objects
(`kind` + JSON `payload`), not a separate `session.*` message bus.

| Host command (examples) | Role |
|-------------------------|------|
| `agent_turn` | Run a research/agent turn; streams events via `tauri::ipc::Channel` |
| `cancel_turn` | Cooperative cancel for an in-flight turn |
| `complete_permission_cmd` | allow_once / deny / allow_session_path |
| Session/workspace/settings commands | Persistence and config |

### Stream event discriminants (`EventDto.kind`)

Produced by `cd_core::research::event_to_dto` — **snake_case** names:

| `kind` | Payload highlights |
|--------|--------------------|
| `turn_started` | `session_id`, `model` |
| `text_delta` | `text` |
| `thought_delta` | `text` |
| `tool` | single event with `phase` (`started`/`finished`), `id`, `name`, `summary`, `detail`, `ok` |
| `citation` | `source_id`, `label`, `locator` |
| `search_trail` | `steps` |
| `permission_required` | `request_id`, `tool_name`, `target`, `reason`, `preview`, `risk`, `arguments` |
| `turn_completed` | `reason` |
| `error` | `code`, `message` (safe) |

Server SSE (when used) reuses the same DTO shape; full team protocol design is tracked under remediation epic **#98**.

## Sketch only (not implemented as a message layer)

The following names were an early **design sketch**. They are **not** the
shipped Tauri/command surface and must not be treated as live API:

| Sketch message | Intent (unimplemented as named RPC) |
|----------------|-------------------------------------|
| `session.create` | New chat session |
| `session.prompt` | User message |
| `session.cancel` | Abort turn |
| `permission.respond` | Grant decision |
| `workspace.configure` | Roots / connectors |

Dotted event names (`turn.started`, `tool.started`+`tool.finished`, …) are
likewise sketch labels; prefer the snake_case table above.

## Embed guidance

Hosts should treat the stream `EventDto` contract as the UI surface. Do not scrape private core types across crate versions without semver.

## Non-goals for v1

- Full ACP parity with coding agents  
- Binary file transfer in-band (use paths / side channels)  

## Versioning policy

- `cd_core::PROTOCOL_VERSION` is the string for this major (`cd.v1`).
- The **event `kind` discriminants** in the table above are **guarded** by
  `research::tests::protocol_md_event_kinds_match_dto` (offline unit test).
  Only those discriminants are treated as stable for this major; do not call
  sketch/`session.*` names “frozen.”
- Additive optional fields on events are allowed without bumping.
- Renaming/removing event `kind` discriminants requires `cd.v2` and a migration note in this file.
- Hosts should ignore unknown event kinds for forward compatibility.
