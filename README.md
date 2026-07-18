# ContextDesk

[![CI](https://github.com/chriscase/ContextDesk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chriscase/ContextDesk/actions/workflows/ci.yml?query=branch%3Amain)

**ContextDesk is a local-first knowledge workbench that answers questions about your own files, memory, and connected sources — with citations — and confirms every write before it happens.**

Point it at folders you allowlist and at markdown project memory, ask how a subsystem works, and get streaming answers with file citations and a visible search trail. It runs happily against a local model (Ollama) with **no account and no API key**. It is a *research & synthesis* tool, not a code-editing agent — pair it with your coding agent when you need edits. The name is a working title; the whole product is rename-friendly via [`branding.toml`](branding.toml).

| | |
|--|--|
| **Stack** | Rust core (`cd-core`) · Tauri 2 + React desktop · optional headless server (`cd-server`) |
| **License** | [Apache-2.0](LICENSE) |
| **Status** | Early development — desktop works today; team server is partial. See [Issues](https://github.com/chriscase/ContextDesk/issues) and the live CI badge above. |
| **Identity** | Rename via [`branding.toml`](branding.toml) (full runtime slug paths tracked in [#179](https://github.com/chriscase/ContextDesk/issues/179)) |
| **Phase 1 DoD** | [Issue #65](https://github.com/chriscase/ContextDesk/issues/65) · [Roadmap](docs/ROADMAP.md) · [Backlog audit](docs/BACKLOG_AUDIT.md) |

> **Screenshot:** a captured shot of the desktop app (a chat answer with inline file
> citations and a search trail beside an allowlisted workspace) is pending a live
> `npm run tauri:dev` run against a populated workspace — capture steps are in
> [`docs/media/README.md`](docs/media/README.md), tracked in
> [#176](https://github.com/chriscase/ContextDesk/issues/176). No asset is fabricated.

---

## How it's different

Open WebUI, LibreChat, AnythingLLM, and Jan are all capable general chat UIs. ContextDesk optimizes for a narrower thing: **local-first research over sources you control, with an explicit write gate on every action** — not multiplayer chat or an open plugin marketplace. Each row below maps to a real mechanism in this repository; planned work is called out separately.

| Edge | ContextDesk | Open WebUI | LibreChat | AnythingLLM | Jan |
|------|-------------|-----------|-----------|-------------|-----|
| **Per-tool write gate** — reads run free; every write is classified `read` / `soft-write` / `hard-write` and a hard-write blocks on a UI-originated confirm | Yes — `crates/cd-core/src/permissions.rs` (`PermissionDecision`, `ToolSideEffect`) | — | — | — | — |
| **SSRF-hardened outbound + FS allowlist** — DNS resolve-and-pin, block private / link-local / CGNAT / cloud-metadata IPs, redirects off; tool file access limited to allowlisted roots | Yes — `crates/cd-core/src/ssrf.rs` (`resolve_and_validate`, `build_pinned_client`) + `crates/cd-core/src/paths.rs` | — | — | — | — |
| **Secret storage** — API keys live in the OS keychain and never cross IPC to the webview (commands return bools/refs only) | OS keychain; never sent to UI — `crates/cd-core/src/keychain_store.rs`, [AGENTS.md](AGENTS.md) #4 | Server env / DB | Server env / DB | Local app storage | Local app data |
| **Embeddable core** — the logic is a reusable Rust library other hosts can build on; the desktop and server are thin | Yes — `cd-core` crate | App | App | App (+ chat-embed widget) | App |
| **Local-first, no account** — default path is a local model on loopback with no product login | Yes — Ollama on `127.0.0.1:11434`, single-user desktop | Self-hosted; user accounts | Self-hosted; user accounts | Yes — local option | Yes — local-first |

<sub>Comparison reflects each project's default/primary design as of mid-2026; all four alternatives are actively developed and cover broader chat/RAG use cases. `—` means "not a first-class feature of that tool," not "impossible." Corrections welcome via an [issue](https://github.com/chriscase/ContextDesk/issues).</sub>

**External tools use MCP, under the same gate.** Third-party tools run as governed **MCP stdio subprocesses** (`crates/cd-core/src/module_registry.rs`, `modules.rs`; substrate spec in [ADR 0001](docs/adr/0001-external-module-substrate.md)). MCP tool calls are subject to the same read/soft/hard-write permission tiers, the registry is **browse-only** (metadata discovery — no marketplace auto-install, per [NON_GOALS.md](docs/NON_GOALS.md) #7), and subprocesses are capped and allowlisted.

---

## What it does (honest)

Status mirrors [`docs/CLAIMS.md`](docs/CLAIMS.md), which is machine-checked so shipped rows name a real symbol on `main`. Nothing below is described as done unless it is.

**Shipped on `main` (desktop-focused):**

- Allowlisted workspace files + markdown memory search, with **citations** and a **search trail** (`index.rs:KeywordIndex`, incremental SQLite)
- Streaming agent turns with cancel and live event sink (`agent.rs:run_agent_turn_with_sink`)
- Permission-gated soft/hard writes to memory and skills (`tool_host.rs:ToolHost`)
- Providers: **Ollama**, OpenAI-compatible, Anthropic Messages, optional Grok Build session; multi-model selection in the composer
- Opt-in web research (`web_search` / `web_fetch`) behind SSRF gates
- Read-only connectors: SQLite, Postgres, Confluence, X search
- MCP stdio tools and HTTP/OpenAPI presets wired as agent tools (`tool_host.rs:attach_mcp_connector`, `http_preset.rs`)
- Durable chat sessions + keyword archive search; hybrid embed scoring available as a core/opt-in retrieval path (`index.rs:search_hybrid`, #119)
- Optional headless server: incremental **SSE research endpoint** on `main` (`crates/cd-server/src/main.rs:research_sse`)
- Opt-in signed desktop updater (config + Settings UI)

**Roadmap / partial (do not treat as done):**

- Headless **team** server: workspaces, roles, shared memory (#167) — server binary + SSE exist; roles/sharing are not built
- Stable third-party **embed / host-adapter protocol** (#94) — `cd-core` is embeddable today, but the public adapter contract is early (see [`docs/examples/host-adapter.md`](docs/examples/host-adapter.md))
- **External module sandbox** hardening (#94)
- **Semantic** chat-archive search (#79) — archive search today is keyword-based
- Theme/skin registry beyond dark/light/slate (#99)
- Proven multi-OS release installers (#172)

---

## Ollama-only quickstart (no API key)

An end-to-end path for a machine with **Rust (stable)**, **Node 20+**, and [Tauri 2 platform deps](https://v2.tauri.app/start/prerequisites/). No OpenAI/Anthropic/Grok key is needed.

1. **Install [Ollama](https://ollama.com), then pull a small chat model** and health-check the local daemon:
   ```sh
   ollama pull mistral
   curl -s http://127.0.0.1:11434/api/tags | head   # should list your models
   ```
2. **Clone and launch the desktop host:**
   ```sh
   git clone https://github.com/chriscase/ContextDesk.git
   cd ContextDesk
   cargo test -p cd-core          # offline library gate — no network, no keys
   cd desktop && npm install && npm run tauri:dev   # free-port aware launcher
   ```
3. **Configure in the app (Settings-first, no config files):**
   - Preflight / Settings → pick a **workspace folder** to allowlist. Try the bundled [`fixtures/kb/`](fixtures/kb) folder (`auth.md`, `billing.md`, `deploy_runbook.md`, …).
   - Provider **Ollama (local)**, base `http://127.0.0.1:11434`, model `mistral` → Save.
4. **Ask a question** grounded in that folder, e.g. *"How does authentication work in this codebase?"* Expect streaming markdown, a **search trail** showing where it looked, and **citations** back to `fixtures/kb/auth.md` / `auth_gateway.md` when retrieval hits.

Remote providers stay optional and are added later in Settings → AI. Their keys go straight to the OS keychain — never into the repo or the webview.

---

## Repository layout

```text
branding.toml          # display name, slug, default theme (rename here)
crates/
  cd-core/             # library: providers, tools, workspace, agent loop, permissions, ssrf, keychain
  cd-server/           # optional headless server (early; SSE research shipped)
desktop/               # Tauri 2 + React host (thin)
docs/                  # product, architecture, claims, ADRs (agent-friendly)
fixtures/              # offline sample knowledge base for demos/tests
```

Core logic lives in **`cd-core`** so the desktop app, server, and future host adapters stay thin.

---

## Development

Prerequisites: Rust (stable), Node 20+, platform deps for Tauri 2.

```sh
# Full offline gate (matches CI intent)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
( cd desktop && npm install && npm run build )

# Doc honesty gate (claim ↔ code)
sh scripts/check_claims.sh

# Desktop interactive (free-port aware)
cd desktop && npm install && npm run tauri:dev
```

See [`docs/DEV.md`](docs/DEV.md) (including **Dev ports**), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`AGENTS.md`](AGENTS.md).

---

## Configuration & secrets

- Use [`.env.example`](.env.example) as a template; real `.env` files are gitignored.
- API keys belong in the OS keychain (or environment variables) — not in the repo, and never passed to the webview.
- Do not commit `~/.grok/auth.json`, employer configs, or private documentation dumps.

---

## Security

See [`SECURITY.md`](SECURITY.md) for private vulnerability reporting. The design deliberately keeps secrets out of the webview, pins outbound DNS against SSRF, and gates every write behind a UI confirmation — details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Security boundaries).

---

## Community & contributing

Issues and PRs are welcome. Please read:

- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — how we work together
- [`AGENTS.md`](AGENTS.md) — conventions for humans and agents (non-negotiables live here)
- [`docs/ISSUE_HONESTY.md`](docs/ISSUE_HONESTY.md) — no false "shipped" closes
- Templates: [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) · [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) · [pull request](.github/PULL_REQUEST_TEMPLATE.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE).
