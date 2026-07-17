# Threat model (initial)

Living document — expand as connectors and server land.

## Assets

| Asset | Sensitivity |
|-------|-------------|
| Provider API keys / session tokens | Critical |
| Workspace file contents (may include secrets) | High |
| Project memory / skills | Medium–High |
| Chat transcripts | Medium–High |
| Audit logs | Medium |
| Team server shared knowledge | High (multi-tenant) |

## Trust boundaries

1. **Webview / React** — untrusted for secrets; display only  
2. **Rust core / Tauri host** — trusted computing base for policy  
3. **Remote LLM providers** — untrusted third parties; all prompts may leak  
4. **MCP child processes** — untrusted; host assigns side-effect class  
5. **Tool results / retrieved docs** — untrusted content (prompt injection)  
6. **Optional team server** — separate TCB; default bind localhost  

## Adversaries

- Malicious or compromised document in the workspace  
- Malicious MCP server  
- Network attacker on probe/chat SSRF  
- Local malware reading config dir  
- Cross-tenant access on misconfigured server  

## Controls (must implement)

| Control | Status |
|---------|--------|
| UI-originated write grants | Implemented (`complete_permission` + request ids) |
| Filesystem allowlist roots | Implemented (`paths` + workspace) |
| Secret filename denylist on read | Implemented (heuristic list) |
| Keychain for API keys | Implemented (`secrets` + Tauri commands) |
| SSRF policy on bases | Implemented (literal IPs + mapped IPv6; DNS rebinding residual) |
| Untrusted labeling of tool results | Implemented (`injection`) |
| Grok session opt-in + URL pin | Implemented (exact host `api.x.ai`) |
| MCP host-side side-effect policy | Config types; runtime dispatch Phase 3+ |
| SQL single-SELECT allowlist | Keyword denylist + tests; AST harden residual |
| Server multi-tenant isolation | workspace_id on routes; API keys hashed |

## Explicit non-goals of early MVP

- Protecting against a fully compromised host OS  
- Formal verification of the agent loop  
- Guaranteeing LLM providers do not retain data (contractual/user choice)

## Residual risks

- Users may allowlist directories containing secrets  
- Remote models will see whatever tools return  
- OIDC session reuse has ToS and token-theft residual risk  
