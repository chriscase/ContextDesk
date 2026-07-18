# Development

## Prerequisites

- Rust stable (edition 2021+)  
- Node.js 20+  
- Platform dependencies for [Tauri 2](https://v2.tauri.app/start/prerequisites/)  

## Workspace commands

```sh
# Doc honesty gate (claim↔code; also runs in CI job `claims`)
sh scripts/check_claims.sh
# Close-proof fixtures (#254) — offline; no network
sh scripts/check_close_proof.sh --offline
sh scripts/check_close_proof.sh --fixture scripts/fixtures/close_proof_sample.json

# Full gate — see AGENTS.md "Build / test / lint"
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Desktop
cd desktop
npm install
npm run tauri:dev    # preferred — free-port aware

# Large-workspace index bench (#117; ignored by default CI — AGENTS #8)
# Creates a synthetic 50k-file tree, indexes with SQLite store + soft max 100k.
cargo test -p cd-core --lib index_50k_soft_cap_allows_large_tree -- --ignored --nocapture
```

Index soft caps: `AppConfig.index_max_files` (default **100_000**). When the cap is
hit, `ReindexStats.truncated` is true and a `tracing::warn!` is emitted (never silent).
Per-file max is 512 KiB; walk depth max is 12 (see `index.rs`).

## Dev ports (multi-Tauri machines)

Almost every `create-tauri-app` template uses **Vite on 1420**. If you run several Tauri apps, that port is almost always busy (`strictPort: true` then fails).

**ContextDesk strategy:**

| Step | Behavior |
|------|----------|
| 1 | Prefer explicit `CD_DEV_PORT` (or `PORT`) if set |
| 2 | Else start at **1450** (ContextDesk base — not 1420) |
| 3 | Scan **1450…1490** for a free TCP port |
| 4 | Start Vite with that port and pass the same URL to Tauri via `--config` merge |

```sh
cd desktop

# Auto-pick free port (usual)
npm run tauri:dev

# Pin a port
CD_DEV_PORT=1462 npm run tauri:dev

# Just print what would be chosen
npm run dev:port
npm run dev:port -- --json
```

**Conventions for other apps on this machine:** give each product a unique **base** port (e.g. ContextDesk 1450, other apps 1460 / 1470 / …) so first-launch collisions are rare; keep a small free-port scan as a backstop.

Bare `npm run dev` (Vite only) defaults to 1450 and may hop if free; for Tauri always use `npm run tauri:dev` so the shell and Vite stay on the same port.

## Config locations (defaults)

| Path | Use |
|------|-----|
| `branding.toml` (repo) | Product identity for builds |
| `~/.contextdesk/` | User config, profiles, skills (planned) |
| `<workspace>/.contextdesk/` | Project skills & memory (planned) |

## Connectors

**Shipped in Settings** (not hand-edited secret files): Files/memory, SQLite RO, Confluence RO, X search, web research.

| Kind | Module | Status | Notes |
|------|--------|--------|--------|
| Files / memory | workspace + `memory_fs` | **Shipped** | Allowlisted roots; Settings workspace |
| SQLite RO | `sql_ro` + `sql_query__{id}` | **Shipped** | Connector `kind:sqlite` absolute path; `SQLITE_OPEN_READ_ONLY` + `query_only`; wall-clock interrupt timeout; agent tool via registry (#130) |
| Postgres RO | `sql_ro::execute_postgres_ro` | **Shipped** | Connector `kind:postgres`; session `default_transaction_read_only` + `statement_timeout`; password keychain-only; **sslmode=disable** → NoTls; **prefer/require/verify-*** → rustls (`tokio-postgres-rustls` + webpki roots, #250) |
| Confluence RO | `confluence_ro` | **Shipped** | PAT in keychain (`confluence/default/pat`); space allowlist; Settings Connectors. **Wire path (#132):** Settings → keychain PAT → `set_confluence` / `apply_host_connectors` → `specs_for_model` exposes `confluence_search`/`confluence_get_page` → dispatch → `cql_search`/`fetch_page`. Offline: `cargo test -p cd-core --lib confluence` (includes wiremock Bearer + space filter). |
| X search | `x_search` | **Shipped** | Bearer in keychain; Settings |
| Web research | `web_research` | **Shipped** | SSRF-gated search/fetch; packs |
| MCP (stdio) | `mcp_client` + `ToolHost::attach_mcp_connector` | **Shipped** | `kind:"mcp"` connectors; absolute command; Settings command/args; offline fixture `tests/fixtures/mcp_echo_server.py`; first-use approval (#129) |
| HTTP presets | `http_preset` + `http_get__{id}` | **Shipped** | Exact host + GET route allowlist; SSRF default; optional keychain bearer; Settings Connectors (#131) |

Forward-looking MCP config shape (not a current Settings feature):

```json
{
  "id": "docs-mcp",
  "kind": "mcp",
  "enabled": true,
  "settings": {
    "name": "docs",
    "command": "/usr/local/bin/my-mcp-server",
    "args": [],
    "hard_write_tools": []
  }
}
```

No marketplace auto-start.

## Postgres read-only role (recommended)

Agent SQL tools only run single-SELECT statements and set session `default_transaction_read_only` + `statement_timeout`, but the database role should still be least-privilege:

```sql
-- Run as a superuser / owner once per database.
CREATE ROLE cd_ro LOGIN PASSWORD '...';  -- store password in OS keychain via Settings, not config.json
GRANT CONNECT ON DATABASE your_db TO cd_ro;
GRANT USAGE ON SCHEMA public TO cd_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cd_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cd_ro;
ALTER ROLE cd_ro NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
```

Settings → Connectors → Postgres: host / database / user / sslmode (non-secret) + password (keychain). Tool name: `sql_query__{connector_id}`.

**TLS (#250):** `sslmode=disable` uses NoTls. Default and `prefer` / `require` / `verify-ca` / `verify-full` use rustls with platform webpki roots. Offline unit tests select the stack per mode; a live TLS server is not required for default CI. Opt-in live check: set `CD_PG_TEST_DSN` (libpq URL or key=value) and run `cargo test -p cd-core live_postgres -- --ignored --nocapture`.

## Grok Build session (opt-in)

After **explicit user opt-in**, the desktop host may load `~/.grok/auth.json` **in Rust only** (`cd_core::grok_auth`). Webview never receives tokens.

| Concern | Behavior |
|---------|----------|
| File | `~/.grok/auth.json` (Grok CLI / Grok Build session store) |
| Fields used | `key` (access), `refresh_token`, `expires_at`, `oidc_issuer`, `oidc_client_id`, `auth_mode`, `email` |
| API host pin | Bearer may only be sent to exact host `api.x.ai` |
| Refresh | If `expires_at` is past and `refresh_token` is present, host calls OIDC token endpoint on `auth.x.ai` with `grant_type=refresh_token` (`ensure_fresh_credentials`) |
| Failure | Clear re-login message — run `grok login` again; ContextDesk does not store passwords |
| Headers | `Authorization: Bearer …`, OIDC CLI headers (`X-XAI-Token-Auth`, `x-authenticateresponse`), client version header |
| Logging | Never log raw tokens (`redacted_debug` only) |

**User responsibility:** reusing a Grok Build / Grok CLI session is subject to xAI / Grok product Terms of Service and your account entitlements. ContextDesk does not give legal advice; opt-in means you accept that risk.

See also `docs/THREAT_MODEL.md`.

## SSRF policy (provider bases)

Outbound provider / probe URLs go through `cd_core::ssrf::validate_provider_url` **before** any HTTP.

| Policy | Behavior |
|--------|----------|
| `SsrfPolicy::default()` | Block RFC1918, link-local, CGNAT, cloud metadata IPs; **allow loopback** (Ollama) |
| `SsrfPolicy::local_only()` | Same defaults; intended for local profiles |
| `SsrfPolicy::allow_private_networks()` | **Opt-in** for intentional private / corporate gateways |

Desktop probe UI passes `allow_private` into the host (`probe_url`). Prefer public or loopback bases on the happy path. Enabling private networks is an advanced override — treat it as expanding the trust boundary (see `docs/THREAT_MODEL.md`).

DNS rebinding residual: hostname resolution is not re-checked after every hop; prefer literal hosts you control for sensitive gateways.

## cd-server (headless)

- **Loopback, no keys:** fine for single-user local dev (`--bind 127.0.0.1:8787`).
- **LAN / non-loopback:** requires `--allow-lan` **and** API keys. Prefer `--api-keys-file` or `CD_API_KEYS` — avoid `--api-keys` on the command line (visible in `ps`).
- **TLS:** cd-server is **HTTP-only**. Terminate TLS at a reverse proxy when using `--allow-lan` (see `docs/THREAT_MODEL.md`).
- Startup refuses unauthenticated non-loopback binds (`guard_exposure`, #144/#171).

### Team workspaces, roles, persistent shared memory, audit (#167, finishes #50)

The **headless server is legitimately file/flag-configured** — AGENTS.md #7 (settings-first)
governs the desktop happy path, not `cd-server`. Pass `--config server.toml` (or set
`CD_SERVER_CONFIG`) to define multiple team workspaces, each with its own roots and its
own admin/member API-key set:

```toml
# server.toml — contains NO raw provider secrets
data_dir = "/var/lib/cd-server"      # optional; default: <config dir>/server

[[workspaces]]
id = "team-a"
roots = ["/srv/knowledge/team-a"]
keys = [
  { key = "short-dev-token", role = "admin" },       # hashed at load (dev only)
  { key_hash = "…64 hex…",   role = "member" },       # preferred for strong tokens
]

[[workspaces]]
id = "team-b"
roots = ["/srv/knowledge/team-b"]
keys = [ { key_hash = "…", role = "admin" } ]
```

- **Roles.** `admin` may write shared memory and manage the workspace; `member` may
  search / read and use scoped (permission-gated) writes. Admin-only endpoints reject a
  `member` key with **403** (`/v1/memory/publish`). Legacy `--root` + `--api-keys` still
  work: those keys are granted `admin` on the `default` workspace.
- **No raw secrets in the config file.** Provide strong tokens as `key_hash` (a plain
  sha256 hex of the token — not a secret). The loader **refuses** a `key` that looks like a
  raw provider secret (`sk-…` / `xai-…` / high-entropy), reusing the `cd_core::config`
  `api_key_ref` guard. Generate a hash the same way `hash_key` does:
  `printf %s 'YOUR_TOKEN' | shasum -a 256`. Treat any file that does hold raw tokens as an
  operational secret (chmod 600, never commit) — same as `--api-keys-file`.
- **Persistent shared memory.** `/v1/memory/publish` appends to
  `<data_dir>/workspaces/<id>/memory.jsonl` **before** acknowledging; the server reloads it
  into RAM on boot, so a publish → restart → list round-trip returns the note.
- **Audit trail.** Writes and denials append a hash-chained `cd_core::audit::AuditEntry`
  to `<data_dir>/audit.jsonl` (`AuditLog` scrubs secrets). Research/session tool writes are
  audited too (the audit path is passed into `build_host`). Verify integrity with
  `AuditLog::verify_chain`.

Manual two-workspace check:

```bash
cd-server --bind 127.0.0.1:8799 --config server.toml
# admin publishes:
curl -s -XPOST localhost:8799/v1/memory/publish -H 'authorization: Bearer <admin>' \
  -H 'content-type: application/json' -d '{"workspace_id":"team-a","title":"Arch","body":"…"}'
# member is denied (403):
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8799/v1/memory/publish \
  -H 'authorization: Bearer <member>' -H 'content-type: application/json' \
  -d '{"workspace_id":"team-a","title":"x","body":"y"}'
# restart the process, then list — the note persists:
curl -s -XPOST localhost:8799/v1/memory/list -H 'authorization: Bearer <member>' \
  -H 'content-type: application/json' -d '{"workspace_id":"team-a"}'
```

Platform keychain / path matrix: `docs/PLATFORMS.md` (#178).

## Secrets

Copy `.env.example` → `.env` for local experiments. Never commit `.env`.

Grok Build session reuse (planned) reads `~/.grok/auth.json` only after explicit UI opt-in.

### OS keychain (provider secrets)

API keys and connector PATs are stored in the **OS keychain / secret service**, never in `config.json` or the webview after save.

| Item | Value |
|------|--------|
| Service name | `{branding.slug}-secrets` (default: `contextdesk-secrets`) |
| Provider API key ref | `provider/{profile_id}/api_key` |
| Confluence PAT ref | `confluence/default/pat` (constant `CONFLUENCE_PAT_REF`) |

Profiles on disk only store the **ref id** (`api_key_ref` / `pat_ref`). The desktop host resolves secrets in Rust; IPC returns booleans/redacted DTOs (`provider_has_secret`), never the secret material.

Rename product: change `slug` in `branding.toml` — keychain service name follows the slug; existing entries under the old service name will not migrate automatically.

### Secret scanning (gitleaks) in CI

CI job **`gitleaks`** (`.github/workflows/ci.yml`) runs on every push/PR to `main` via [`gitleaks/gitleaks-action`](https://github.com/gitleaks/gitleaks-action). Path-level denials for local secrets also live in `.gitignore` (`.env`, `auth.json`, `*.pem`, credential patterns).

#### False-positive process

1. **Confirm it is a false positive** — not a real key, token, or private host with credentials. If real, **rotate the credential** and remove it from history (`git filter-repo` / support) before anything else.
2. **Prefer fixing the sample** — redact fixtures, use obviously fake placeholders (`sk-test-…`, `xai-test-…`), or move demo material under `docs/examples/` with clearly invalid values.
3. **Allowlist only when necessary** — add a narrow rule in `.gitleaks.toml` (path + rule id) with a one-line comment *why*. Never blanket-disable gitleaks or `# gitleaks:allow` on production-looking secrets.
4. **PR description** must mention the allowlist change and link the CI log that failed.
5. **Review** — another human or agent should confirm the allowlisted string cannot authenticate anywhere.

Local scan (optional):

```sh
gitleaks detect --source . --verbose
```
