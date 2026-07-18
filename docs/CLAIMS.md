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
| HTTP/OpenAPI presets as agent tools | Roadmap | crates/cd-core/src/http_preset.rs: | #131 |
| Postgres RO | Shipped | crates/cd-core/src/sql_ro.rs:execute_postgres_ro | #130 |
| Team server roles + shared memory | Roadmap | crates/cd-server/src/main.rs: | #167 |
| Rename-friendly branding runtime load | Roadmap | crates/cd-core/src/branding.rs:Branding | #179 |
| Skin / theme registry beyond dark/light | Roadmap | desktop/src/styles/themes/ | #99 |
| Signed release updater | Roadmap | desktop/src-tauri/tauri.conf.json | #173 |
| True host turn cancellation | Roadmap | crates/cd-core/src/agent.rs: | #90 |
| Real SSE provider streaming (not batch replay) | Roadmap | crates/cd-core/src/agent.rs:run_agent_turn | #90 |

## Human checklist

When you change a capability’s status:

1. Update this table (Status + Code anchor).
2. Update README / DEV.md / PROTOCOL.md so prose matches.
3. Run `sh scripts/check_claims.sh` before merge.
4. Never mark **Shipped** without a grep-able anchor on `main`.
