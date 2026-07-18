# ADR 0001: External module substrate

**Status:** Accepted  
**Date:** 2026-07-17  
**Issue:** #133 (epic #94)  
**Depends on:** AGENTS.md non-negotiables; connector/MCP path from #93/#128

## Context

ContextDesk needs a path for third-party tools without becoming an untrusted plugin free-for-all. The tree already has:

- `crates/cd-core/src/mcp_client.rs` — stdio JSON-RPC MCP session (`spawn` with `env_clear` + limited `PATH`, stderr null)
- `connectors::validate_mcp_command` — absolute command path only
- `ToolHost::attach_mcp_connector` — live attach when a connector is enabled (#128)

Competing substrates (WASM component model, native dylib) have no implementation. Without a written decision, #134–#136 risk diverging designs.

`docs/NON_GOALS.md` constrains the choice:

> 7. **MCP marketplace auto-install** — opt-in few servers only  
> 8. **Embedding a full third-party agent runtime** — use chat APIs + local ContextDesk tools

## Decision

**MCP over stdio subprocess is the external-module substrate.**

Third-party modules are MCP servers the host launches (absolute path, no shell string). Tools are registered dynamically on `ToolHost` with **host-assigned** side-effect classes and first-use permission mediation. There is no WASM guest runtime and no `dlopen` of untrusted native code in process.

## Security model

| Control | Rule |
|---------|------|
| Isolation | OS process boundary (MCP server child); not same-process WASM/dylib |
| Side effects | Host classifies Read / SoftWrite / HardWrite — **never** trust module-declared risk |
| Ambient access | No ambient whole-home FS or unrestricted network for modules; tools go through host policy + SSRF for HTTP |
| Secrets | Host supplies secrets from the **OS keychain only**; never module-visible raw secrets over IPC (DTOs/bools only) — AGENTS #1 |
| Grants | SoftWrite/HardWrite require **UI-originated** human confirmation — AGENTS #4 |
| Capabilities | Tauri stays locked down (no shell plugin for the webview; module spawn is host-side Rust only) — AGENTS #9 |
| Install | Opt-in only; **no auto-install marketplace** (NON_GOALS #7) |
| Runtime | Modules are tools, not an embedded third-party agent loop (NON_GOALS #8) |

## Migration path

1. **Done / in progress (#93, #128):** `mcp_client` + `attach_mcp_connector` + Settings connector registry for MCP entries; first-use approval (#129).
2. **#134:** `cd.module.v1` manifest (id, version, absolute command, tool allowlist metadata) for discovery without auto-run.
3. **#135:** Strengthen permission mediation & sandbox policy for untrusted modules (session grants, audit).
4. **#136:** Settings lifecycle UI — install path pick / enable / disable / remove / first-use approval (no marketplace auto-fetch).
5. **#137–#139:** Skills that ship tools, authoring guide, optional browse-only registry (documentation + discovery only).

### Skill enable path (#137 / closes #38 dead-end)

Write-claiming skills used to force `disabled = allows_write` on every parse and never persisted enable state — Settings had no Skills section and no Tauri toggle. That is **closed**:

- `enabled` is written into SKILL.md frontmatter by `write_skill` / `set_skill_enabled_on_disk`.
- `parse_skill_file` honors explicit `enabled`/`disabled`; re-discovery does not silently re-disable a user-enabled skill.
- Settings → **Skills** + `set_skill_enabled_cmd` are the UI-originated enable path (AGENTS #4).
- A skill directory MAY ship sibling `module.toml` (`cd.module.v1`); enabling the skill installs/provisions through #136 and first-use capability approval #135. Skills still cannot self-grant or elevate HardWrite.

Dead-code era is over for MCP attach on the connector path; remaining work is packaging, mediation UX, and docs — not a substrate rewrite.

## Alternatives rejected

### WASM component model

- **Rejected.** Strong isolation story, but no existing code, larger runtime surface, and harder ToolHost/permission integration. Revisit only if OS-process isolation proves insufficient.

### Native dylib / cdylib plugins

- **Rejected.** Same-process attack surface; contradicts capability lockdown and makes side-effect mediation unreliable. Never load untrusted native code into the host process.

## Consequences

- Module authors ship MCP servers; ContextDesk does not embed their agent runtime.
- Host owns tool registration names, side effects, and secret injection.
- Marketplace auto-install remains non-goal; discovery may be browse-only later (#139).
- Children #134–#136 must follow this ADR; substrate change requires a superseding ADR.

## AGENTS.md anchors

- **#1 Secrets** — keychain only; modules never receive cleartext secrets over IPC  
- **#2 Generic kinds** — no employer branding in module protocol  
- **#4 UI-originated grants** — HardWrite never silent  
- **#9 Capability lockdown** — no webview shell; spawn is host-mediated  

## References

- `crates/cd-core/src/mcp_client.rs`
- `crates/cd-core/src/connectors.rs` (`validate_mcp_command`)
- `crates/cd-core/src/tool_host.rs` (`attach_mcp_connector`)
- `docs/NON_GOALS.md` items 7–8
- `docs/THREAT_MODEL.md`
