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
| Server LAN exposure guard | Implemented: non-loopback bind refuses empty API keys (#144/#171); `--allow-lan` warns on stderr; key hash compare is constant-time; prefer `--api-keys-file` / `CD_API_KEYS` over argv. Empty-key authorize bypass is loopback-only. |
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
- Team server TLS is operator-owned (reverse proxy); **cd-server is HTTP-only by design** — `--allow-lan` requires TLS termination at a reverse proxy (#171)  
- Telegram webhook input is authenticated by Telegram's secret-token header and then by an exact configured user→workspace role mapping. Chat-originated sessions cannot use the generic permission endpoint; HardWrite is only actionable by an authenticated paired workspace-admin client. Pairings/proposals are process-lifetime and are lost (not auto-approved) on restart (#289).


## Desktop updater trust boundary (#173)

| Asset | Trust |
|-------|--------|
| Update payloads | Fetched over HTTPS from GitHub Releases `latest.json` only |
| Integrity | Minisign / Ed25519 signature verified against **pinned** `plugins.updater.pubkey` in the app binary |
| Private key | CI secret only; never in repo, never over IPC, never in webview |
| Install decision | Explicit user confirmation in Settings (HardWrite-style); no silent auto-install |
| Webview CSP | Updater HTTP is Rust-side; webview does not need expanded `connect-src` for GitHub |

Compromise of GitHub releases without the private key cannot force a signed update. Compromise of the private key requires rotating the pubkey in a new install path.

## Module process isolation residual (#135)

Enforced for MCP/module children:
- `env_clear` + PATH + **granted** secret env only
- optional `cwd` set to the module directory
- wall-clock JSON-RPC timeout (default 30s) + response size caps

**Not** claimed (OS sandbox follow-up): seccomp/bubblewrap/sandbox-exec/Job Objects network or filesystem syscall isolation. Documented residual, not a false claim of full isolation.
