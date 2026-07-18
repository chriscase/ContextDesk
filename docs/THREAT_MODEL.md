# Threat model (initial)

Living document — expand as connectors and server land.  
Last security reconciliation: 2026-07-17 (remediation #140–#145).

## Assets

| Asset | Sensitivity |
|-------|-------------|
| Provider API keys / session tokens | Critical |
| Workspace file contents (may include secrets) | High |
| Project memory / skills | Medium–High |
| Chat transcripts | Medium–High |
| Audit logs | Medium (tamper-evident chain) |
| Team server shared knowledge | High (multi-tenant) |

## Trust boundaries

1. **Webview / React** — untrusted for secrets; display only  
2. **Rust core / Tauri host** — trusted computing base for policy  
3. **Remote LLM providers** — untrusted third parties; all prompts may leak  
4. **MCP child processes** — untrusted; host assigns side-effect class  
5. **Tool results / retrieved docs** — untrusted content (prompt injection)  
6. **Optional team server** — separate TCB; default bind localhost; non-loopback requires API keys  

## Adversaries

- Malicious or compromised document in the workspace  
- Malicious MCP server  
- Network attacker on probe/chat SSRF  
- Local malware reading config dir  
- Cross-tenant access on misconfigured server  

## Controls (must implement)

| Control | Status |
|---------|--------|
| UI-originated write grants | Implemented (`complete_permission` + request ids; deny/grant audited #143) |
| Filesystem allowlist roots | Implemented (`paths` + workspace) |
| Secret filename denylist on read | Implemented (heuristic list) |
| Keychain for API keys | Implemented (`secrets` + Tauri commands; never over IPC) |
| SSRF policy on bases & web | Implemented: literal IPs + mapped IPv6 + **DNS resolve-and-vet** + **socket pin** (`resolve_and_validate` / `build_pinned_client`, #140/#141); **per-redirect hop re-vet** on web_fetch. Residual: TOCTOU narrowed by pin; OS DNS still trusted for the resolve step. |
| Untrusted labeling of tool results | Implemented: **per-call nonce** open/close markers + body defang of `<<<` prefixes (`injection`, #142). Fixed forgeable delimiters removed. |
| Audit denials + tamper-evidence | Implemented: outcomes include `denied`/`granted`/`pending`/`allowed`/`error`; SHA-256 hash chain + `verify_chain` (#143). |
| Grok session opt-in + URL pin | Implemented (exact host `api.x.ai`; refresh prefers pinned auth host) |
| Server LAN exposure guard | Implemented: non-loopback bind refuses empty API keys; `--allow-lan` warns on stderr (#144). Empty-key authorize bypass is loopback-only. |
| MCP host-side side-effect policy | Implemented: spawn/register/dispatch (#128); HardWrite default + first-use approval (#129); results `wrap_untrusted` |
| SQL single-SELECT allowlist | Keyword denylist + tests; AST harden residual |
| Server multi-tenant isolation | workspace_id on routes; API keys hashed |

## Explicit non-goals of early MVP

- Protecting against a fully compromised host OS  
- Formal verification of the agent loop  
- Guaranteeing LLM providers do not retain data (contractual/user choice)

## Residual risks

- Users may allowlist directories containing secrets  
- Remote models will see whatever tools return (nonce labeling reduces instruction-following risk; does not eliminate model-level injection)  
- OIDC session reuse has ToS and token-theft residual risk  
- DNS resolve step still trusts the OS resolver (pinning limits rebinding after connect; does not replace a resolver that lies)  
- MCP stdio servers remain untrusted once enabled; tools default HardWrite + first-use approval (#129); absolute command only; child `env_clear` |
- Team server TLS is operator-owned (reverse proxy); cd-server itself does not terminate TLS  
