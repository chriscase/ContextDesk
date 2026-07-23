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

## Server HTTP surface (`cd-server`, remediation #165–#168, sync #287)

| Method | Path | Role |
|--------|------|------|
| `POST` | `/v1/research` | Research turn; JSON `{ events, degraded, model }` |
| `GET` | `/v1/research/stream` | SSE of the same event kinds (incremental; cancel on disconnect) |
| `POST` | `/v1/session/prompt` | Session turn or `invoke_tool`; may emit `permission_required` |
| `POST` | `/v1/permission/respond` | Client grant/deny → `grant_and_execute` (never auto-approved) |
| `GET` | `/v1/sync/membership` | Workspaces and `admin`/`member` role visible to the bearer |
| `POST` | `/v1/sync/changes_since` | Cursor-paged authoritative workspace-memory records |
| `POST` | `/v1/sync/apply` | Admin-only idempotent workspace-memory mutation batch |
| `POST` | `/v1/chat/telegram/webhook` | Telegram update input; authenticated by Telegram's secret-token header |
| `POST` | `/v1/chat/pair` | Authenticated workspace admin registers a process-lifetime trusted desktop pairing |
| `GET` | `/v1/chat/approvals` | Paired admin polls queued chat-originated SoftWrite/HardWrite proposals |
| `POST` | `/v1/chat/approvals/respond` | Paired admin AllowOnce/deny; core type-to-confirm remains enforced |
| `GET` | `/v1/watchers?workspace_id=…` | List persistent watcher definitions and last-run state |
| `GET` | `/v1/watchers/{watcher_id}` | Read one watcher and its last-run state |
| `PUT` | `/v1/watchers/{watcher_id}` | Admin-only create/update of a workspace watcher |
| `DELETE` | `/v1/watchers/{watcher_id}` | Admin-only watcher removal |
| `POST` | `/v1/watchers/{watcher_id}/run` | Admin-only immediate evaluation (normal execution is scheduled) |

Session hosts are retained **in-process** for the lifetime of the `cd-server` process (keyed by `session_id`). No TTL yet; restart clears pending grants. Writes never execute without a matching client `permission/respond` allow.

### Workspace-memory sync v1 (server half)

All sync routes use the existing bearer authentication and workspace membership.
Members may discover membership and pull; only admins may call `sync/apply`. Personal
scope is rejected at the server boundary and never appears in a pull response.

`POST /v1/sync/changes_since` accepts:

```json
{
  "workspace_id": "team-a",
  "cursor": { "updated_at": 0, "rev": 0, "id": "" },
  "limit": 200
}
```

Omit `cursor` for the first page. `limit` is clamped to 1–500. The response contains
`records`, `next_cursor`, `has_more`, and `server_time`. The cursor is the stable
`(updated_at, rev, id)` tuple of the last returned record; clients persist it only
after applying the complete page. Records include superseded/retracted rows so links
and tombstones reconcile correctly.

`POST /v1/sync/apply` accepts 1–100 mutations:

```json
{
  "workspace_id": "team-a",
  "mutations": [{
    "mutation_id": "desktop-a:42",
    "origin_node": "desktop-a",
    "client_updated_at": 1784745600,
    "client_rev": 3,
    "base_rev": 2,
    "operation": {
      "UpdateMeta": {
        "id": "018f4c67-89ab-7def-8123-456789abcdef",
        "tags": ["confirmed"],
        "pinned": null,
        "valid_to": null,
        "status": null
      }
    }
  }]
}
```

`operation` is the serialized `MemoryWriteOp` (`Insert`, `UpdateMeta`, `Supersede`,
or `Retract`). An insert must omit/null `base_rev`; updates should send the last seen
revision. Results are per mutation: `applied`, `duplicate`, `conflict`, `rejected`,
`not_found`, or `indeterminate`. The durable mutation journal makes a completed
`mutation_id` retry-safe across restarts. `indeterminate` means a crash/store failure
may have happened after the durable intent record: pull before deciding whether to
retry with a new mutation id.

Conflicts use `base_rev` first, then last-writer-wins on the client
`(client_updated_at, client_rev)` tuple against the current server row. Accepted writes
receive a monotonic server `updated_at`; supersession creates a replacement row and
preserves both links. Client timestamps more than five minutes in the future are
rejected. This is the server contract only; the desktop cache/offline worker remains
open under #287.

### Telegram chat bridge

Telegram chat/thread ids map to process-lifetime `telegram-*` sessions. Research replies are
rendered from the same `cd.v1` `StreamEvent` sequence used by `/v1/research` and SSE. Telegram
sessions carry a distinct server-side origin: `/v1/permission/respond` refuses them even when a
caller knows a request id. Configured admin users may confirm **SoftWrite only** in-channel with
an exact `/approve_soft <request-id> WRITE`; arbitrary chat assent is ordinary model input.
HardWrite can only be completed by `/v1/chat/approvals/respond` from an authenticated paired
workspace admin. Pairings and pending chat proposals are in-memory and clear on restart.

### Watchers / triggers

Watcher definitions are durable rows in `<data_dir>/watchers.sqlite`. Each definition is scoped
to one workspace and has `watch`, `condition`, and `action` objects tagged by `kind`. Watch sources
are `query`, `connector_poll`, or `schedule`; every interval is at least 300 seconds and receives
a deterministic scheduler jitter. Query watchers rebuild from workspace roots so they observe
changes after server startup. Connector polls may invoke only tools classified `Read`.

Conditions are hermetic `always`, `contains`, or `result_count_at_least` predicates. Actions are:

- `notify`, which sends through the configured Telegram bridge; `{{watcher_id}}` and `{{event}}`
  are the only substitutions.
- `propose_tool`, which accepts only write-classified tools and deliberately invokes without a
  grant. The resulting permission request is queued for `/v1/chat/approvals`; watcher-originated
  SoftWrite and HardWrite are both barred from `/v1/permission/respond` and from in-chat approval.

The SQLite `(watcher_id, event_key)` primary key is claimed transactionally before an action.
Repeated query/connector results or the same schedule slot therefore cannot fire twice, including
after restart. The store also persists `last_run_at`, `last_event_key`, `last_fired_at`, and the
last outcome. A crash after the claim is fail-closed (the event may be missed, never duplicated).
