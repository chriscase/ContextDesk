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
| UI-originated write grants | Designed (permissions module) |
| Filesystem allowlist roots | Partial (workspace) |
| Secret filename denylist on read | Planned |
| Keychain for API keys | Planned |
| SSRF policy on bases | Planned |
| Untrusted labeling of tool results | Planned |
| Grok session opt-in + URL pin | Planned (Phase 2+) |
| MCP host-side side-effect policy | Planned |
| SQL single-SELECT allowlist | Planned |
| Server multi-tenant isolation tests | Planned |

## Explicit non-goals of early MVP

- Protecting against a fully compromised host OS  
- Formal verification of the agent loop  
- Guaranteeing LLM providers do not retain data (contractual/user choice)

## Residual risks

- Users may allowlist directories containing secrets  
- Remote models will see whatever tools return  
- OIDC session reuse has ToS and token-theft residual risk  
