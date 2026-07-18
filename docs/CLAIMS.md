# Capability claims (shipped vs roadmap)

Machine-checked by `scripts/check_claims.sh`. **Shipped** rows must name a real `path:symbol` that exists on `main`.

| Capability | Status | Code anchor (path:symbol) | Doc references |
|------------|--------|---------------------------|----------------|
| Files/memory KB search | Shipped | crates/cd-core/src/index.rs:KeywordIndex | README, PRODUCT |
| Keyword index (incremental SQLite) | Shipped | crates/cd-core/src/index.rs:open_or_build | BACKLOG_AUDIT #26 |
| Durable chat sessions | Shipped | crates/cd-core/src/sessions.rs:SessionStore | README |
| Permission tiers + grants | Shipped | crates/cd-core/src/permissions.rs:PermissionDecision | THREAT_MODEL |
| SoftWrite/HardWrite tool host | Shipped | crates/cd-core/src/tool_host.rs:ToolHost | AGENTS |
| web_search / web_fetch | Shipped | crates/cd-core/src/web_research.rs:web_search | README, Settings |
| X search (optional key) | Shipped | crates/cd-core/src/x_search.rs:search_recent | Settings Connectors |
| Confluence RO | Shipped | crates/cd-core/src/confluence_ro.rs:ConfluenceRoConfig | Settings Connectors |
| Multi-model chat selection | Shipped | desktop/src-tauri/src/lib.rs:list_chat_models | UI composer |
| SQLite RO tool | Shipped | crates/cd-core/src/sql_ro.rs:execute_sqlite_ro_with_timeout | #130 |
| MCP stdio tools wired end-to-end | Shipped | crates/cd-core/src/tool_host.rs:attach_mcp_connector | #128 |
| HTTP/OpenAPI presets as agent tools | Shipped | crates/cd-core/src/http_preset.rs:preset_get | #131 |
| Postgres RO | Shipped | crates/cd-core/src/sql_ro.rs:execute_postgres_ro | #130 |
| Runtime branding from branding.toml | Shipped | crates/cd-core/src/branding.rs:embedded | #179, get_branding |
| Cooperative host turn cancellation | Shipped | crates/cd-core/src/agent.rs:run_agent_turn_with_sink | #90, #109 |
| Live event sink (stream as produced) | Shipped | crates/cd-core/src/agent.rs:run_agent_turn_with_sink | #90, #108 |
| Server incremental SSE research | Shipped | crates/cd-server/src/main.rs:research_sse | #166 |
| Opt-in signed updater (config + UI) | Shipped | desktop/src-tauri/tauri.conf.json:pubkey | #173, Settings Check for updates |
| Hybrid embed scoring (core API) | Shipped | crates/cd-core/src/index.rs:search_hybrid | #119 core; product wire residual |
| Team server roles + shared memory | Roadmap | crates/cd-server/src/main.rs:AppState | #167 |
| search_kb uses hybrid when embed on | Roadmap | crates/cd-core/src/tool_host.rs:tool_search | #119 residual |
| Skin / theme registry beyond dark/light/slate | Roadmap | desktop/src/styles/themes/ | #99 |
| External module sandbox | Roadmap | docs/ | #94 |
| README product screenshot in docs/assets | Roadmap | docs/examples/host-adapter.md | #176 residual |
| Proven multi-OS release installers (tag run) | Roadmap | .github/workflows/release.yml | #172 residual |

## Human checklist

When you change a capability’s status:

1. Update this table (Status + Code anchor).
2. Update README / DEV.md / PROTOCOL.md so prose matches.
3. Run `sh scripts/check_claims.sh` before merge.
4. Never mark **Shipped** without a grep-able anchor on `main`.
