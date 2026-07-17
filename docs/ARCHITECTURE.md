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
│ Connectors                                               │
│  files · memory · sqlite · postgres(RO) · mcp · http…    │
└──────────────────────────────────────────────────────────┘
```

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
