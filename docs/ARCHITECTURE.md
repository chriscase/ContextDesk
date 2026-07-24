# Architecture

## Layers

```text
┌──────────────────────────────────────────────────────────┐
│ Hosts (thin)                                             │
│  desktop/ (Tauri + React) · cd-server · future embeds    │
└───────────────────────────┬──────────────────────────────┘
                            │ IPC / HTTP / cd.v1 events
┌───────────────────────────▼──────────────────────────────┐
│ cd-core                                                  │
│  branding · config · providers · probe · agent · tools   │
│  workspace · memory · skills · router · citations        │
└───────────────────────────┬──────────────────────────────┘
                            │ Connector trait / MCP
┌───────────────────────────▼──────────────────────────────┐
│ Connectors / external modules                            │
│  files · memory · sqlite · postgres(RO) · mcp · http…    │
│  Module substrate: MCP stdio subprocess — see            │
│  docs/adr/0001-external-module-substrate.md (#133 / #94) │
└──────────────────────────────────────────────────────────┘
```

### External modules (normative)

Third-party tools use the **MCP subprocess** substrate (not WASM, not native dylibs).  
Security model, non-goals, and migration path: **[ADR 0001](adr/0001-external-module-substrate.md)**.

## Key modules (target)

| Module | Responsibility |
|--------|----------------|
| `branding` | Load `branding.toml`; display name/slug |
| `providers` | Chat/embed clients; capability matrix |
| `probe` | URL expansion, model list, local discovery |
| `auth_resolve` | Env, keychain, optional Grok Build session (opt-in) |
| `tools` | Registry, side effects, policy gate, audit |
| `agent` | Plan → tool → observe → answer loop; streaming events |
| `workspace` | Roots, connectors config, sessions |
| `object_store` / `workspace_backup` | Bounded object I/O; exclusion-aware, content-addressed backup planning/manifests |
| `memory` | Markdown memory L2 |
| `skills` | Discover/parse/inject playbooks |
| `router` | Multi-source fan-out budgets |
| `index` | Chunk + embed + search (local first) |

## Permission model

- **Read** — allowed within policy; logged  
- **SoftWrite** — draft/propose; user Accept  
- **HardWrite** — blocking UI confirm (click; type-to-confirm for remote/destructive)  

Grants are **UI-originated**, never model-asserted.

## Event stream (`cd.v1`)

See [`PROTOCOL.md`](PROTOCOL.md). Hosts render tokens, tools, citations, and permission requests from the same stream.

## Security boundaries

- Secrets only in Rust host / server  
- Allowlisted FS roots  
- SSRF-aware HTTP for user-configured bases  
- MCP processes capped and allowlisted  

## Optional S3-compatible backup (Phase A)

The desktop host is the authority for this explicit export path:

1. `workspace_backup` traverses only configured roots, refuses symlinks, excludes
   secrets, internal stores, `.git`, logs/databases, and build/dependency output,
   then hashes safe files with a fixed-size buffer.
2. A native desktop dialog shows exact roots, destination identity, estimates,
   exclusion reasons, dry-run state, and the “content leaves this machine”
   warning. No object-store operation occurs before approval; dry run performs
   no remote write.
3. The host resolves fixed reference IDs from the OS keychain and constructs the
   feature-gated S3 transport. Raw credentials never enter config or webview IPC.
4. Content bodies use stable hash keys. Only after all required bodies succeed
   does the host replace `manifests/latest.json`; partial failures therefore
   preserve the prior completed manifest and retries reuse uploaded bodies.

Transfers are sequential (bounded concurrency of one) and streaming. Cancellation
waits for the active storage future to stop before returning. Local workspace
roots remain authoritative. Restore, remote deletion, bidirectional sync, and S3
indexing are not part of Phase A.
