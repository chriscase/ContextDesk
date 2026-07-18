# ContextDesk

[![CI](https://github.com/chriscase/ContextDesk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chriscase/ContextDesk/actions/workflows/ci.yml?query=branch%3Amain)

**ContextDesk** is an open-source **developer knowledge workbench**: multi-source research, tool-calling assistance, durable project memory, and an optional headless server for shared team knowledge.

It is a **research & synthesis** product—not a code-editing agent. Pair it with your preferred coding agent when you need edits.

| | |
|--|--|
| **Stack** | Rust core · Tauri 2 desktop · React · optional headless server |
| **License** | [Apache-2.0](LICENSE) |
| **Status** | Early development — see [Issues](https://github.com/chriscase/ContextDesk/issues) · live CI badge above |
| **Identity** | Rename via [`branding.toml`](branding.toml) (full runtime slug paths: [roadmap #179](https://github.com/chriscase/ContextDesk/issues/179)) |
| **Phase 1 DoD** | [Issue #65](https://github.com/chriscase/ContextDesk/issues/65) · [Roadmap](docs/ROADMAP.md) · [Backlog audit](docs/BACKLOG_AUDIT.md) |

---

## How it's different

Compared with general chat UIs (e.g. Open WebUI, LibreChat, AnythingLLM, Jan), ContextDesk optimizes for **local-first research with explicit write gates**, not chat multiplayer or arbitrary plugins:

| Edge | ContextDesk (code-true) |
|------|-------------------------|
| **Permission tiers** | Tools classified **read / soft-write / hard-write**; HardWrite requires an explicit UI grant (`PermissionRequired` → respond). No silent remote/disk mutation. |
| **SSRF + path policy** | Provider and web tools go through SSRF validation / pinned clients; workspace files are limited to allowlisted roots (`paths` + SSRF modules in `cd-core`). |
| **Secrets** | API keys live in the **OS keychain**; IPC returns DTOs/bools only—never secret strings to the webview (`keychain_store`, AGENTS.md). |
| **Embeddable core** | Business logic is the **`cd-core`** Rust library; desktop and `cd-server` stay thin hosts. |
| **Local-first / no account** | Default happy path is **Ollama on loopback** with no product account. Remote providers are optional and Settings-first. |

Planned (not shipped as first-class product surface yet): full MCP stdio Settings UX, team server roles, external modules, hybrid embeddings search.

---

## What it does (honest)

**Shipped on `main` (desktop-focused):**

- Allowlisted workspace files + markdown memory search with citations and search trail
- Streaming agent turns with cancel, session grants, and compaction (see remediation #90)
- Permission-gated soft/hard writes (memory, skills)
- Providers: Ollama, OpenAI-compatible, Anthropic Messages, optional Grok Build session
- Opt-in web research (`web_search` / `web_fetch`) with SSRF gates
- Durable chat sessions + keyword archive search

**Roadmap / partial (do not treat as done):**

- Headless **team** server (workspaces, roles, shared memory) — stubs + early SSE
- Embed protocol for third-party hosts — library exists; adapter examples incomplete
- MCP / SQL / Confluence Settings wiring end-to-end — epic #93
- Semantic/hybrid chat archive search — open (#79 / #119)

---

## Ollama-only quickstart (no API key)

End-to-end path for a machine with Rust, Node 20+, and Tauri deps:

1. **Install and start Ollama**, then pull a chat model:
   ```sh
   ollama pull mistral
   # health check
   curl -s http://127.0.0.1:11434/api/tags | head
   ```
2. **Clone and run the desktop host:**
   ```sh
   git clone https://github.com/chriscase/ContextDesk.git
   cd ContextDesk
   cargo test -p cd-core   # offline library gate
   cd desktop && npm install && npm run tauri:dev
   ```
3. **In the app:** Preflight / Settings → accept or pick a **workspace folder** (allowlist) → Provider **Ollama (local)** (default base `http://127.0.0.1:11434`) → model `mistral` → Save.
4. **Ask a question** about a file in that folder. Expect streaming markdown, a **search trail**, and **citations** when retrieval hits.

No OpenAI/Anthropic/Grok key is required for this path. Remote providers are optional later in Settings → AI.

---

## Repository layout

```text
branding.toml          # display name, slug, default theme (rename here)
crates/
  cd-core/             # library: providers, tools, workspace, agent loop
  cd-server/           # optional headless server (early)
desktop/               # Tauri 2 + React host
docs/                  # product + architecture (agent-friendly)
```

Core logic lives in **`cd-core`** so the desktop app, server, and future host adapters stay thin.

---

## Development

Prerequisites: Rust (stable), Node 20+, platform deps for Tauri 2.

```sh
# Full offline gate (matches CI intent)
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
( cd desktop && npx tsc -b && npm run build )

# Desktop interactive
cd desktop && npm install && npm run tauri:dev
```

See [`docs/DEV.md`](docs/DEV.md) (including **Dev ports**) and [`AGENTS.md`](AGENTS.md).

---

## Configuration & secrets

- Use [`.env.example`](.env.example) as a template; real `.env` files are gitignored
- API keys belong in the OS keychain or environment variables—not in the repo
- Do not commit `~/.grok/auth.json`, employer configs, or private documentation dumps

---

## Security

See [`SECURITY.md`](SECURITY.md) for private reporting (Private Vulnerability Reporting enable-step + maintainer fallback).

---

## Contributing

Issues and PRs welcome. Please read:

- [`AGENTS.md`](AGENTS.md) — conventions for humans and agents
- [`SECURITY.md`](SECURITY.md)
- [`docs/ISSUE_HONESTY.md`](docs/ISSUE_HONESTY.md) — no false “shipped” closes
- Issue / PR templates when present (`.github/`) — see roadmap #175 for community scaffolding

## License

Apache License 2.0 — see [LICENSE](LICENSE).
