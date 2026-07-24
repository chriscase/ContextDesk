# Demo: Seamless Confluence (#452)

1. **Settings → Connectors → Confluence** — enable, base URL, paste PAT, Save.
2. **Test connection** — expect OK + authenticated space sample (or clear Settings-pointing error).
3. **Discover spaces** — select keys (e.g. ENG) → **Add selected to allowlist** → **Save**.
4. Chat: ask to list spaces / search wiki — agent should use `confluence_list_spaces` / `confluence_search` with exact tool names.
5. Browse: `confluence_list_children` with `space=ENG` → `confluence_get_page`.
6. Harvest still requires allowlist (unchanged policy).

Offline proofs: wiremock tests `mock_list_spaces_and_429_retry`, `http_error_auth_is_actionable`, `confluence_agent_hint_present_when_configured`.
