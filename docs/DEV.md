# Development

## Prerequisites

- Rust stable (edition 2021+)  
- Node.js 20+  
- Platform dependencies for [Tauri 2](https://v2.tauri.app/start/prerequisites/)  

## Clean working tree / what is *not* gitignored

Build outputs (`target/`, `node_modules/`, `dist/`, `*.tsbuildinfo`, Vite/ESLint caches) are ignored. **Do not** expect these tracked files to be ignored — tooling rewrites them on purpose:

| Path | Why it changes | What to do |
|------|----------------|------------|
| `Cargo.lock` (repo root) | `cargo build` / `cargo test` for `cd-core` / `cd-server` | Commit with the dep change that caused it |
| `desktop/src-tauri/Cargo.lock` | Nested Tauri workspace; path-deps `cd-core` | **Also** update when `cd-core` deps change (easy to forget) |
| `desktop/package-lock.json` | `npm install` / package bumps | Commit with package.json changes; prefer `npm ci` day-to-day |
| `desktop/src-tauri/tauri.conf.json` | `gen-tauri-conf.mjs` on every `tauri dev`/`build` | Should be **idempotent** (no diff if branding unchanged). If dirty, commit intentional branding/CSP changes only |
| `desktop/src-tauri/gen/schemas/*` | Tauri build-generated schema dump | Tracked for offline/CI; commit with intentional Tauri version or capability-source changes |

### Tauri capability schema parity

`desktop/src-tauri/capabilities/default.json` is the reviewed source of truth.
After changing it, regenerate the checked-in schema through Tauri's supported
build path (do not hand-edit generated JSON):

```sh
cargo check --manifest-path desktop/src-tauri/Cargo.toml
git diff --exit-code -- desktop/src-tauri/gen/schemas/capabilities.json
```

The first command rewrites `gen/schemas/capabilities.json` when source and
generated state differ. Commit that generated diff with the capability change,
then run both commands again; the second run must produce no diff.

### Source-run update (Settings → General)

From a git checkout, **Settings → General → Source-run update** shows ahead/behind/dirty
and **Fetch remotes** only (never hard-reset, never auto-pull). Rebuild steps are shown in-app
and differ from the **signed installer** channel (`Check for updates` / `CD_CHANNEL=installed`).

If `git pull` fails with local modifications, check `git status` first:

```sh
# Accidental lock noise after a local cargo experiment (discard):
git restore Cargo.lock desktop/src-tauri/Cargo.lock

# Intentional dep work still in progress:
git stash push -u -m 'wip locks'   # or commit on a branch

git pull --ff-only
```

When you change `crates/cd-core` dependencies, refresh **both** locks before push:

```sh
cargo generate-lockfile   # or: cargo update -p <crate>
( cd desktop/src-tauri && cargo generate-lockfile )
# Prefer minimal updates when possible; avoid bare `cargo update` (unbounded bumps).
git add Cargo.lock desktop/src-tauri/Cargo.lock
```

Secrets, OS app data, and SQLite DBs remain gitignored (see root `.gitignore`).

## Background index (#117)

Desktop `rebuild_host` opens the keyword index via `KeywordIndex::open_shell_bounded` (load store / empty shell, **no blocking full walk**), then spawns a background thread for `refresh()`. `search_kb` uses whatever is already loaded; when empty it reports that indexing may still be running. Poll status with Tauri `get_index_status`.

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

# One CI Ubuntu test shard, exactly as CI partitions it (#874) — see below
sh scripts/ci_shard_plan.sh verify --shards 8
sh scripts/ci_run_shard.sh --shard 2 --shards 8
sh scripts/ci_run_shard.sh --summary ci-shards
sh scripts/tests/ci_shard_test.sh

# Desktop
cd desktop
npm install
npm run tauri:dev    # preferred — free-port aware

# Large-workspace index bench (#117; ignored by default CI — AGENTS #8)
# Creates a synthetic 50k-file tree, indexes with a SQLite store + soft max 100k, and
# asserts: (a) no file-cap truncation at the default cap, (b) the in-RAM working set
# stays within the configured byte budget (checked at both the default budget and a
# deliberately small 1 MiB budget), (c) search still returns hits over the resident set.
cargo test -p cd-core --lib index_50k_soft_cap_allows_large_tree -- --ignored --nocapture

# Fast hermetic byte-budget bound (runs in default CI):
cargo test -p cd-core index
```

Index caps (all in `index.rs`; surfaced via `AppConfig`):

- **`index_max_files`** — soft file cap (default **100_000**; was a hard 5_000). When hit,
  `ReindexStats.truncated` is true and a `tracing::warn!` is emitted — never silent.
- **`index_max_bytes`** — in-RAM working-set **byte budget** (default **256 MiB**; `0` → default).
  The SQLite store still holds *every* chunk on disk; this bounds only the resident
  `chunks`/`postings` set so peak memory does not grow linearly-unbounded with corpus size.
  When the budget clips the resident set, the **most-recently-modified** files are kept
  (`KeywordIndex::load_from_store` streams recency-first and stops at the budget), a
  `tracing::warn!` fires, and `KeywordIndex::is_bytes_capped()` returns true (UI-readable).
  Inspect resident size with `KeywordIndex::index_bytes()`.
- **`MAX_FILE_BYTES`** — per-file read cap, **512 KiB** (larger files / binaries skipped
  before any `read_to_string`, so huge dumps never allocate in full).
- **`MAX_DEPTH`** — directory-walk depth cap, **12** (runaway nesting is skipped).

## CI Ubuntu workspace test shards (#874)

`cargo test --workspace` is still the local gate and still the gate on macOS and
Windows. On Ubuntu it ran 70–80 minutes as one step, and when the hosted runner
lost its connection GitHub marked the job failed with the step still
`in_progress` and **no log blob at all**. Hosted runs on the first sharding
attempt (`31828397526`, `31835229724`) then showed the same failure mode on
**shard 1 only**: 86–96 minutes, step stuck `in_progress`, no log, no artifact,
cache post-step never ran. Shards 2–4 passed (80/107 units); the aggregate
failed closed.

CI therefore:

1. Compiles Ubuntu workspace tests **once** in `rust (ubuntu-latest)` using
   shard-shaped `cargo test -p … --no-run` (`scripts/ci_warm_test_artifacts.sh`)
   and **saves** the shared `ubuntu-workspace-tests-v2` rust-cache entry there
   (main branch only). Warming with `cargo test --workspace --no-run` is
   wrong: workspace feature unification does not match per-shard `-p`
   fingerprints, so warm shards still recompiled DuckDB for ~11 minutes
   (hosted run `31851734335`).
2. Runs the same suite as `CD_SHARD_COUNT` (currently **8**) shards that
   restore that cache (`save-if: false`, never Swatinem `lookup-only`).
   `cd-core/lib` is executed as two complementary filters (`log_analysis::`
   and `--skip log_analysis::`) so the heavy library binary is not pinned to
   shard 1.

   The count went 4 → 8 because the shard drawing `cd-core/lib/other` was
   cancelled at the 60-minute job budget on two consecutive runs while the
   other three finished in 16–33 minutes. A shard pays build **and** test
   cost — a warm hosted shard reported `build time: 710s` of `total time:
   1203s` — so only the test half shrinks as units spread, which is why the
   count was doubled rather than nudged to 6. If the `cd-core/lib/other`
   shard overruns again, split it with a `lib_splits` entry in
   `scripts/ci_shard_plan.sh` rather than raising the count further.
3. Aggregates with `scripts/ci_aggregate_shards.sh`, which fails closed on a
   missing, failed, incomplete, or truncated shard, and on any unit no shard
   claimed.

| Script | Role |
| --- | --- |
| `scripts/ci_shard_plan.sh` | Enumerates every testable target from `cargo metadata` and partitions it. `verify` fails closed if the partition is not an exact, duplicate-free cover. |
| `scripts/ci_warm_test_artifacts.sh` | Warmup compile: per-package `-p` `--no-run` matching shard build selectors (fingerprint alignment). |
| `scripts/ci_run_shard.sh` | Runs one shard: per-unit start/finish lines, a heartbeat while a unit runs, a bounded `manifest.json`, `progress.jsonl`, and `status.json`. SIGTERM writes `incomplete`. |
| `scripts/ci_record_cache.sh` | Records `cache_state=warm` only on an exact rust-cache hit. |
| `scripts/ci_aggregate_shards.sh` | The gate. Fails if a shard is missing, failed, incomplete, stopped early, or if any test unit was claimed by no shard. |

Properties worth knowing:

- **Coverage is checked, not assumed.** The shard plan comes from Cargo's own
  view of the workspace, so a new `crates/*/tests/*.rs` joins a shard on its
  next run; the aggregate recomputes the plan and rejects any unit that no
  shard reported. Unit tests (`--lib`, including complementary `cd-core/lib`
  filters), binary unit tests (`--bins`), doc tests (`--doc`), and every
  integration target are all units.
- **The partition is deterministic** — round-robin over a canonically sorted
  unit list — so a shard reproduces identically on a laptop:
  `sh scripts/ci_run_shard.sh --shard 2 --shards 8`.
- **Cancellation diagnostics:** a step timeout or job cancel SIGTERM's
  `ci_run_shard.sh` while the VM is still up; the trap writes `status.json`
  and `if: always()` uploads `rust-ubuntu-shard-N` (14-day retention). A VM
  that is already gone cannot upload; the warmup job exists so shards should
  not sit in the 86–96 minute hosted-runner-loss window.
- **Cache is honest.** `cache_state` is `warm` only when Swatinem reports an
  exact `cache-hit` **and** the restored `target/` directory is non-empty.
  Shards use `save-if: false` (restore files, do not save). Do **not** set
  `lookup-only: true`: that reports a hit without downloading, which hosted
  run `31845262696` recorded as warm while each shard still compiled for
  11–12 minutes. The warmup job on **main** is the only writer
  (`save-if: ${{ github.ref == 'refs/heads/main' }}`); PR runs restore the
  main cache and do not save a second multi-GB copy.
- **Nothing about the suite is relaxed.** Shards keep `RUST_TEST_THREADS=1`.
  macOS and Windows still run `cargo test --workspace`.

Required-check / ruleset wiring is **not** workflow behavior; see
[`docs/CI_REQUIRED_CHECKS.md`](CI_REQUIRED_CHECKS.md).

## Renderer visual acceptance (desktop)

Real-Chromium visual, responsive, and accessibility regression for the desktop
UI: Vitest 4 browser mode via `@vitest/browser-playwright`, configured in
`desktop/vitest.visual.config.ts`, suites in `desktop/visual/`. It is a
**separate config on purpose** — `npm run test` and the documented CI gate are
unchanged, and nothing here runs in the ubuntu CI desktop job.

**Honesty scope:** everything this suite proves is renderer-level (headless
Chromium rendering the production CSS with mocked hosts) — real layout, real
computed styles, real focus and ARIA semantics, axe-core on rendered pixels.
It is never native packaged acceptance (`docs/CLOSE_PROOF.md` § Native
packaged proof): no packaged shell, no OS window manager, no OS-level input.

```sh
cd desktop
npx playwright install chromium   # once per machine (~130 MB cache)
npm run test:visual               # run the suite (must be green)
npm run test:visual:update        # regenerate baselines after a REVIEWED change
npm run typecheck:visual          # tsc over desktop/visual/
```

Baselines live in `desktop/visual/**/__screenshots__/` with the browser and
platform in the filename (`…-chromium-darwin.png`) — they are **per-OS by
construction**; a Linux run needs its own `-linux` baselines. A test with no
baseline fails and writes one for review — the first run of a new screenshot
is red by design; review the PNG, then re-run. On mismatch, expected/actual/
diff PNGs land in the gitignored `desktop/.vitest-attachments/`.

Determinism: pinned sRGB color profile, no LCD text, hidden scrollbars, DPR 1,
reduced motion, UTC, en-US; fonts are force-loaded before capture; theme flips
go through `applyTheme()`, which waits a painted frame (the tester returns
stale computed styles on synchronous reads after attribute/class flips — see
`visual/support/harness.ts`).

**Known sensitivity boundary (proven by mutation):** removing the #834
fixed-position rule, a visible-magnitude panel recolor, and a deleted
aria-label each fail loudly, but a *uniform tint shift below pixelmatch's
per-pixel threshold* (≈10% YIQ distance, e.g. `#12141a → #1a1c24`) passes the
screenshot comparison on every pixel. Token-level truth is owned by the
existing `src/styles/themes/*Contrast.test.ts` / `tokenResolution.test.ts`
unit suites; the visual suite adds geometry, composition, and rendered-pixel
regressions, not token drift detection.

**CI proposal (measured on an M-series Mac, 2026-07-31):** one clean full run
is ~9 s wall (6 files, 41 tests; ~1.4–2.4 s per file after browser start), so
the whole suite is cheap enough to be the **PR smoke** wherever a macOS
runner with the Playwright Chromium cache exists; until such a runner is
wired, it stays a documented local gate for UI-touching branches. A
**scheduled fuller matrix** (all five skins on the richest surfaces, extra
viewport ladder steps, a DPR-2 instance) would multiply baselines ~3–4× and
is deliberately not implemented — decide runner strategy first, since
baselines are per-OS.

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
| Postgres RO | `sql_ro::execute_postgres_ro` | **Shipped** | Connector `kind:postgres`; session `default_transaction_read_only` + `statement_timeout`; password keychain-only; **sslmode=disable** → NoTls; **prefer/require/verify-ca/verify-full** → rustls (`tokio-postgres-rustls` + webpki roots, #250). `verify-ca`/`verify-full` are sent on the wire as `require` (tokio-postgres rejects those literal strings) while rustls validates the cert chain + hostname. |
| Confluence RO | `confluence_ro` | **Shipped** | PAT in keychain; space allowlist; **Maneuver (#326 PR1):** children/ancestors/attachments; `get_page` formats. |
| Confluence SoftWrite harvest | `harvest` | **Shipped (PR3)** | `harvest_from_source` SoftWrite → durable memory + harvest row + SourceRef provenance; empty space allowlist denied; AllowOnce only (`harvest://` never session-auto). Transforms: plain_strip/raw_storage/structured_fields/summary. File dest / converters / sync UI / write = later PRs. Offline: `cargo test -p cd-core --lib harvest`. |
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

**TLS (#250):** `sslmode=disable` uses `NoTls`. The default (`prefer`) and `require` / `verify-ca` / `verify-full` use rustls with the platform webpki roots.

- **Wire mapping.** `tokio-postgres` 0.7 only accepts `disable` | `prefer` | `require` in the DSN `sslmode` key and rejects `verify-ca` / `verify-full` at parse time. So those two modes are mapped to the wire value `require` (TLS mandatory), and the certificate-chain **and** hostname verification that `verify-full` implies is enforced in the rustls `ClientConfig` instead — never via the rejected sslmode string (see `postgres_dsn_sslmode`). The mapping is only ever equal-or-stricter than the requested mode, never weaker.
- **Verification scope.** rustls' safe-default verifier validates against the bundled webpki roots on every TLS mode here, so `require`/`verify-*` all check that the server cert chains to a public CA and matches the host. A Postgres server presenting a private/self-signed cert that does not chain to a webpki root will therefore fail the TLS handshake; use `sslmode=disable` on a trusted network for such servers (custom root bundles are out of scope for #250).
- **Offline tests.** Unit tests select the stack per mode and assert the built DSN actually parses as a `tokio_postgres::Config` (proving `verify-full` no longer dies at DSN parse) — no live DB needed. Run `cargo test -p cd-core sql_ro`.
- **Opt-in live check.** Set `CD_PG_TEST_DSN` (libpq URL `postgresql://user:pass@host:5432/db?sslmode=prefer` or key=value `host=… dbname=… user=… password=… sslmode=verify-full`) and run `cargo test -p cd-core live_postgres -- --ignored --nocapture`. The test skips cleanly (stays `ignored`) when the env var is unset.

## Live self-hosted linked-tool acceptance (opt-in)

The ignored live-provider test exercises the production linked-agent loop
against a tools-enabled local Ollama model. It creates only temporary synthetic
workspace and log evidence, requires successful `search_logs` and `search_kb`
calls, and refuses non-loopback provider URLs.

```sh
CONTEXTDESK_LIVE_OLLAMA=1 \
  cargo test -p cd-core --test live_provider \
  live_ollama_linked_turn_uses_logs_and_workspace -- \
  --ignored --exact --nocapture
```

Defaults are `http://127.0.0.1:11434` and model `mistral`. Override them with
`CONTEXTDESK_LIVE_OLLAMA_URL` (loopback HTTP only) and
`CONTEXTDESK_LIVE_OLLAMA_MODEL`. This check reads no provider credential and
does not modify desktop configuration. Ordinary deterministic CI keeps it
ignored.

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
watchers_enabled = true
keys = [
  { key = "short-dev-token", role = "admin" },       # hashed at load (dev only)
  { key_hash = "…64 hex…",   role = "member" },       # preferred for strong tokens
]

[[workspaces]]
id = "team-b"
roots = ["/srv/knowledge/team-b"]
watchers_enabled = false # config-level kill switch for this workspace
keys = [ { key_hash = "…", role = "admin" } ]
```

- **Roles.** `admin` may write shared memory and manage the workspace; `member` may
  search / read and use scoped (permission-gated) writes. Admin-only endpoints reject a
  `member` key with **403** (`/v1/memory/publish`). Legacy `--root` + `--api-keys` still
  work: those keys are granted `admin` on the `default` workspace.
- **Watchers.** `watchers_enabled` defaults to true and is a workspace-level kill
  switch for the persistent scheduler. Watcher CRUD and immediate-run endpoints are
  admin-only; members may list definitions and last-run state.
- **No raw secrets in the config file.** Provide strong tokens as `key_hash` (a plain
  sha256 hex of the token — not a secret). The loader **refuses** a `key` that looks like a
  raw provider secret (`sk-…` / `xai-…` / high-entropy), reusing the `cd_core::config`
  `api_key_ref` guard. Generate a hash the same way `hash_key` does:
  `printf %s 'YOUR_TOKEN' | shasum -a 256`. Treat any file that does hold raw tokens as an
  operational secret (chmod 600, never commit) — same as `--api-keys-file`.
- **Persistent shared memory.** The source of truth is
  `<data_dir>/workspaces/<id>/memory.sqlite`. `/v1/memory/publish`, sync writes, and
  permission-approved server memory tools all use that store. The older
  `<data_dir>/workspaces/<id>/memory.jsonl` remains a compatibility mirror for the
  original publish/list wire and is imported idempotently at startup.
- **Sync durability.** `/v1/sync/apply` writes a pending record to
  `<data_dir>/workspaces/<id>/sync-mutations.jsonl` and fsyncs it before mutating SQLite,
  then fsyncs the applied result. Reusing a completed `mutation_id` returns the original
  result after restart; an interrupted pending mutation returns `indeterminate` so the
  client pulls before retrying. Admin is required for pushes; members may pull.
- **Privacy boundary.** Server stores and sync endpoints accept workspace scope only.
  Personal memory remains device-local. The desktop sync/cache worker is still pending
  under #287; these endpoints do not imply automatic desktop sync yet.
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
# discover the bearer role and pull authoritative workspace records:
curl -s localhost:8799/v1/sync/membership -H 'authorization: Bearer <member>'
curl -s -XPOST localhost:8799/v1/sync/changes_since \
  -H 'authorization: Bearer <member>' -H 'content-type: application/json' \
  -d '{"workspace_id":"team-a","limit":200}'
```

### Telegram chat bridge (#289)

Telegram is an input/notification surface, not a HardWrite authority. Add the bridge to the
same server TOML. The file contains keychain reference ids and numeric Telegram user ids only:

```toml
[telegram]
bot_token_ref = "telegram/default/bot_token"
webhook_secret_ref = "telegram/default/webhook_secret"
users = [
  # Read/research only:
  { user_id = 10001, workspace_id = "team-a", role = "member" },
  # May explicitly confirm SoftWrite in Telegram; still cannot approve HardWrite:
  { user_id = 10002, workspace_id = "team-a", role = "admin", allow_soft_write = true },
]
```

Store the bot token and a separately generated Telegram webhook secret in the OS keychain under
service `{branding.slug}-secrets` (default `contextdesk-secrets`) and the account/ref ids shown
above. Use the platform keychain UI or another secret-aware provisioning tool; do not put either
value in TOML, command history, environment variables, or process arguments. Startup fails closed
when a ref is malformed/missing, a SoftWrite user is not an admin, a user is duplicated, or a
mapped workspace does not exist. Bot API egress is fixed to `https://api.telegram.org`, DNS-vetted
and pinned through `ssrf.rs`, with redirects disabled.

Configure the Telegram webhook to
`https://<public-server>/v1/chat/telegram/webhook` and set Telegram's `secret_token` to the value
stored by `webhook_secret_ref`. TLS remains operator-owned at the reverse proxy. The webhook is
acknowledged immediately; research continues asynchronously and replies stay in the originating
chat thread. `/save <title>\n<body>` creates a SoftWrite proposal. Only a configured admin with
`allow_soft_write = true` can complete it using the exact command printed by the bot:
`/approve_soft <request-id> WRITE`. A plain “yes” is not a grant.

HardWrite proposals (and SoftWrite proposals without the explicit in-channel policy) queue for a
trusted desktop. An authenticated workspace-admin client pairs, polls, and responds:

```bash
# Pair this authenticated desktop for the process lifetime.
curl -s -XPOST localhost:8799/v1/chat/pair \
  -H 'authorization: Bearer <admin>' -H 'content-type: application/json' \
  -d '{"workspace_id":"team-a","device_label":"Chris desktop"}'

# Poll with the returned pairing_id.
curl -s 'localhost:8799/v1/chat/approvals?workspace_id=team-a&pairing_id=<pairing-id>' \
  -H 'authorization: Bearer <admin>'

# HardWrite requires AllowOnce and the core type-to-confirm phrase (normally WRITE).
curl -s -XPOST localhost:8799/v1/chat/approvals/respond \
  -H 'authorization: Bearer <admin>' -H 'content-type: application/json' \
  -d '{"workspace_id":"team-a","pairing_id":"<pairing-id>","request_id":"<request-id>","decision":"allow_once","typed":"WRITE"}'
```

The generic `/v1/permission/respond` endpoint refuses Telegram-originated sessions. With no paired
desktop, HardWrite stays queued and never executes. Session mappings, pairings, and proposal queues
are intentionally process-lifetime in v1; restart clears them. Chat ingress, authorization denial,
proposal, and decision records are written to the existing scrubbed hash-chain audit log without
storing message text.

### Server-resident watchers (#290)

Watchers persist in `<data_dir>/watchers.sqlite` and run while `cd-server` is alive. An admin
creates or replaces a definition with `PUT /v1/watchers/{id}`; members may list definitions and
last-run state. This example sends one notification per five-minute schedule slot:

```bash
curl -s -XPUT localhost:8799/v1/watchers/build-health \
  -H 'authorization: Bearer <admin>' -H 'content-type: application/json' \
  -d '{
    "id":"build-health",
    "workspace_id":"team-a",
    "enabled":true,
    "watch":{"kind":"schedule","interval_seconds":300},
    "condition":{"kind":"always"},
    "action":{
      "kind":"notify",
      "chat_id":-100012345,
      "message_thread_id":7,
      "text":"Watcher {{watcher_id}} fired: {{event}}"
    }
  }'
```

`watch.kind` may also be `query` (workspace search) or `connector_poll` (a configured connector
tool classified `Read`). Intervals below 300 seconds are rejected. `condition.kind` is `always`,
`contains`, or `result_count_at_least`. `action.kind=propose_tool` never supplies a grant: both
SoftWrite and HardWrite become pending proposals for the paired desktop, and the generic
permission endpoint refuses their watcher-originated session. SQLite claims each source-event
fingerprint before dispatch, so an unchanged query/poll result or repeated schedule slot does not
fire twice across ticks or restart. Use `POST /v1/watchers/{id}/run` for an authenticated manual
evaluation; deduplication still applies.

### Jira through the Atlassian Rovo MCP preset (#291)

The recommended Jira path is Atlassian's official
[Rovo MCP server](https://developer.atlassian.com/cloud/rovo-mcp/), reached through a separately
installed local [`mcp-remote`](https://github.com/geelen/mcp-remote) executable. ContextDesk does
not auto-install packages or embed a native Jira client. Configure the preset on a workspace:

```toml
[[workspaces.connectors]]
id = "jira"
kind = "mcp"
enabled = true

[workspaces.connectors.settings]
preset = "atlassian_rovo"
command = "/absolute/path/to/mcp-remote"
api_key_ref = "connector/jira/api_key"
auth_kind = "service_bearer" # or "personal_basic"
# email = "person@example.com" # required only for personal_basic
```

Provision only the token value under `api_key_ref` in the OS keychain service
`{branding.slug}-secrets`; never put it, an encoded Basic credential, or an Authorization header
in TOML. `service_bearer` is for an Atlassian service-account API key. `personal_basic` combines
the non-secret configured email with the keychain token in memory. Atlassian must enable API-token
authentication for the organization; OAuth 2.1 remains Atlassian's recommendation for interactive
clients. See Atlassian's
[API-token MCP guide](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token).

The preset fixes the remote endpoint to `https://mcp.atlassian.com/v1/mcp`, rejects a configurable
replacement, DNS-vets it with the outbound SSRF policy, and launches `mcp-remote` in HTTP-only mode.
The Authorization value exists only in the cleared child environment and is referenced from the
proxy header argument; it is absent from connector JSON, argv, logs, tool results, and HTTP DTOs.

Host classification follows Atlassian's
[supported Jira tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/):
issue/project metadata and JQL search are `Read`; comment/worklog/create/edit/transition are
`HardWrite`; every unlisted remote tool also defaults to `HardWrite`. MCP Reads retain the existing
first-use approval. Jira writes reject session-wide grants and require a fresh UI-originated
AllowOnce plus exact `WRITE` confirmation for every action.

Platform keychain / path matrix: `docs/PLATFORMS.md` (#178).

## Secrets

Copy `.env.example` → `.env` for local experiments. Never commit `.env`.

Grok Build session reuse (planned) reads `~/.grok/auth.json` only after explicit UI opt-in.

### Provider credential sources

Connector PATs and pasted/imported provider keys are stored in the **OS
Keychain / secret service**. A provider profile may instead select an absolute
owner-only protected file (regular file, mode `600`, no symlink). In that mode
`config.json` contains a `file:/absolute/path` reference, never the key bytes,
and runtime resolution does not consult Keychain.

| Item | Value |
|------|--------|
| Service name | `{branding.slug}-secrets` (default: `contextdesk-secrets`) |
| Provider API key ref | `provider/{profile_id}/api_key` |
| Confluence PAT ref | `confluence/default/pat` (constant `CONFLUENCE_PAT_REF`) |

Profiles on disk only store the **ref id** (`api_key_ref` / `pat_ref`). An
absent reference means no credential: hosts must never guess a conventional
Keychain entry. An invalid protected-file reference fails without falling back
to Keychain. The desktop host resolves secret contents in Rust; IPC returns
booleans/redacted DTOs and may return the selected protected-file path for
Settings editing, never the secret material.

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

## Durable memory (Phase 0/1)

See [`docs/design/MEMORY.md`](design/MEMORY.md) for the full contract.

| Scope | Default location | Notes |
|-------|------------------|--------|
| **Personal** | OS app-data / config dir: `~/<config_dir>/memory/personal.sqlite` | Never git-committable; barred from `changes_since` / sync |
| **Workspace** | In-repo: `<workspace_root>/<slug>/memory/memory.sqlite` | Gitignored by default (`ensure_workspace_memory_gitignored` + root `.gitignore`) |

Config knobs on `AppConfig.memory` (`MemoryConfig`):

- `durable_memory_enabled` (default **true**) — gates tool registration
- `workspace_location`: `in_repo` (default) or `app_data`
- `ambient_recall_enabled` (default **true**), `ambient_max_chars` (~1500), `ambient_max_memories` (≤5), `ambient_min_score` (~0.35)

Timestamps are unix **seconds**; ids are UUIDv7. Secrets are redacted via `cd_core::redact` before persist and before embed.

## Company import acceptance laboratory

Public-safe synthetic ZIP lab for import/parser/timezone acceptance (no private
company logs). Sizes `25k` / `75k` / `250k`.

```bash
cargo run --locked -p cd-core --bin cd-company-import-lab -- \
  release --size 75k --out ./company-import-lab-out

cargo test -p cd-core --lib company_import_lab
```

Contract: `fixtures/company-import-lab/README.md`.
Oracle schema: `contextdesk.company_import_lab.oracle.v1`.

## Company import acceptance laboratory

Public-safe synthetic ZIP lab for import/parser/timezone acceptance (no private
company logs). Sizes `25k` / `75k` / `250k`.

```bash
cargo run --locked -p cd-core --bin cd-company-import-lab -- \
  release --size 75k --out ./company-import-lab-out

cargo test -p cd-core --lib company_import_lab
```

Contract: `fixtures/company-import-lab/README.md`.
Oracle schema: `contextdesk.company_import_lab.oracle.v1`.

## Offline log-import diagnostic

Privacy-safe support evidence for import failures (no user log content):

```bash
cargo run --locked -p cd-core --bin cd-diagnose-log-import -- \
  --input path/to/logs-or.zip --output /tmp/import-diagnostic.json

cargo test -p cd-core --lib log_analysis::import_diagnose
```

Exit codes: `0` success report, `1` fail-closed or cancelled report written,
`2` usage. The reusable API accepts a cancellation flag; the standalone CLI
does not install an interactive signal handler.
The report schema is `contextdesk.import_diagnostic.v1`. Temporary corpora are
verified deleted before success is reported; cleanup failure is fail-closed.
The output path must not already exist. Attach only the JSON to bug reports.
