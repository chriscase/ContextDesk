# ContextDesk

**ContextDesk** is an open-source **developer knowledge workbench**: multi-source research, tool-calling assistance, durable project memory, and an optional headless server for shared team knowledge.

It is a **research & synthesis** product—not a code-editing agent. Pair it with your preferred coding agent when you need edits.

| | |
|--|--|
| **Stack** | Rust core · Tauri 2 desktop · React · optional headless server |
| **License** | [Apache-2.0](LICENSE) |
| **Status** | Early development — see [Issues](https://github.com/chriscase/ContextDesk/issues) |
| **Identity** | Rename-friendly — see [`branding.toml`](branding.toml) |
| **Phase 1 DoD** | [Issue #65](https://github.com/chriscase/ContextDesk/issues/65) · [Roadmap](docs/ROADMAP.md) · [Backlog audit](docs/BACKLOG_AUDIT.md) |

---

## What it does

- **Locate** knowledge across allowlisted files, markdown memory, databases (read-first), MCP servers, and other connectors
- **Synthesize** answers as streaming markdown with **citations** and a visible search trail
- **Remember** durable notes (project memory) and optional **skills** (markdown playbooks)
- **Act safely** with read / soft-write / hard-write permission tiers and explicit user confirmation
- **Connect models** via discovery-first AI settings: local Ollama, OpenAI-compatible gateways, optional Grok Build session reuse, and more
- **Embed** into other Rust/Tauri hosts via a stable library/event protocol (planned)
- **Collaborate** via an optional headless server for team memory (planned)

## What it does *not* do (non-goals)

- Compete with coding agents on repository edit loops / shell-driven implementation
- Silent writes to remote systems or unrestricted disk/HTTP/shell tools
- Ship employer-specific gateways, URLs, or branding in source

See [`docs/NON_GOALS.md`](docs/NON_GOALS.md) and [`docs/PRODUCT.md`](docs/PRODUCT.md).

---

## Repository layout

```text
branding.toml          # display name, slug, default theme (rename here)
crates/
  cd-core/             # library: providers, tools, workspace, agent loop
  cd-server/           # optional headless server (stub early)
desktop/               # Tauri 2 + React host
docs/                  # product + architecture (agent-friendly)
```

Core logic lives in **`cd-core`** so the desktop app, server, and future host adapters stay thin.

---

## Development (early)

Prerequisites: Rust (stable), Node 20+, platform deps for Tauri 2.

```sh
# Library tests
cargo test -p cd-core

# Desktop (free-port aware — avoids shared Tauri template port 1420)
cd desktop && npm install && npm run tauri:dev
```

See [`docs/DEV.md`](docs/DEV.md) (including **Dev ports**) and [`AGENTS.md`](AGENTS.md).

---

## Configuration & secrets

- Use [`.env.example`](.env.example) as a template; real `.env` files are gitignored
- API keys belong in the OS keychain or environment variables—not in the repo
- Do not commit `~/.grok/auth.json`, employer configs, or private documentation dumps

---

## Contributing

Issues and PRs welcome. Please read [`AGENTS.md`](AGENTS.md) (coding conventions for humans and agents), [`SECURITY.md`](SECURITY.md), and the epic/issue plan on GitHub.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
