# Host adapter sketch (`cd.v1`)

External Tauri/Rust apps can embed ContextDesk knowledge without forking the UI.

## Options

1. **Library embed** — depend on `cd-core`, call `run_agent_turn`, `ToolHost`, `KeywordIndex`.
2. **Local RPC** — run `cd-server` on `127.0.0.1` with API key; call `/v1/search` and stream events later.

## Minimal in-process sketch

```rust
// pseudo
use cd_core::agent::{run_agent_turn, ScriptedBackend, AgentOptions};
use cd_core::tool_host::ToolHost;
// build workspace + index, then:
// let events = run_agent_turn(backend, &mut host, question, &mut history, &opts, None).await?;
```

## Auth for local server

- Default bind: `127.0.0.1`
- API keys hashed (SHA-256) in process memory
- Every search/publish requires `workspace_id` so keys cannot cross workspaces without explicit mapping

## Semver

Protocol constant: `cd_core::PROTOCOL_VERSION` (`cd.v1`). Breaking stream event changes require `cd.v2`.
