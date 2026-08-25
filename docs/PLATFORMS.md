# Platform support matrix (#178)

Default `cargo test` / CI stays **offline** and **keychain-free**. Real OS keychain round-trips are not exercised in CI.

## Keychain backends

Configured in root `Cargo.toml` via the `keyring` crate:

| OS | Backend feature | Service name shape |
|----|-----------------|--------------------|
| macOS | `apple-native` | Keychain: `{slug}-secrets` (`keychain_service_name`) |
| Windows | `windows-native` | Credential Manager: same service string |
| Linux | `sync-secret-service` | Secret Service / libsecret when available |

Refs are platform-independent strings, e.g. `provider/{profile_id}/api_key`, `confluence/default/pat`.  
In-memory `MemorySecretStore` is used for unit tests.

## Config / data directories

Branding-driven (e.g. `.contextdesk` from `workspace_dir_name` / slug). Host uses `dirs` crate conventions:

| OS | Typical config home (via `dirs`) |
|----|----------------------------------|
| macOS | `~/Library/Application Support/<product>/` or project-relative workspace roots |
| Windows | `%APPDATA%\<product>\` / user profile |
| Linux | `~/.config/` or XDG when applicable |

Workspace roots are user-chosen paths in Settings; path allowlisting is in `cd_core::paths` (`resolve_allowed_path`, `normalize_lexically`).

## CI coverage

| Job | Ubuntu | macOS | Windows |
|-----|--------|-------|---------|
| `rust` (fmt, clippy, examples, smoke) | yes (`rust (ubuntu-latest)`; tests compiled with `--no-run` as shard cache warmup) | yes (`rust (macos-latest)`; restore-only preflight) | yes (`rust (windows-latest)`; restore-only preflight) |
| `rust tests` (`cargo test --workspace`) | yes — eight deterministic shards + fail-closed `rust tests (ubuntu aggregate)` (#874) | yes — four deterministic shards + fail-closed `rust tests (macos-latest aggregate)` | yes — four deterministic shards + fail-closed `rust tests (windows-latest aggregate)` |
| `tauri-host` (desktop host compile) | yes | yes | no (see residual) |
| `desktop` UI (npm) | yes | — | — |
| `release` bundles | tag-only orchestrator | tag-only orchestrator | tag-only orchestrator (#172; builders are artifacts-only) |

## Known caveats

- **Linux CI** installs `libdbus-1-dev` for keyring compile; runtime Secret Service may be absent — tests must not require it.
- **Workspace tests** run as eight Ubuntu shards and four macOS/Windows shards, each with a fail-closed aggregate (`docs/DEV.md`, #874). Conditional cache writers compile only on a miss; preflight jobs no longer execute the suite. See `docs/CI_REQUIRED_CHECKS.md` before wiring required checks. Path-aware PR routing can skip the Ubuntu shards for isolated bench/collab surfaces while keeping the same required check name.
- **Windows path separators** (`\`) are handled by `std::path`; do not hard-code `/` in allowlist assertions beyond structural checks.
- **Symlink escape** tests remain `#[cfg(unix)]` (symlink APIs differ on Windows).
- **Real keychain I/O** is operator-local / `#[ignore]` if added later — never default CI.
