# Packaging & release

## Desktop

- **Product name / identifier / window title** are derived from repo-root `branding.toml` by `desktop/scripts/gen-tauri-conf.mjs` (before `tauri dev` / `tauri build`).
- **Icons** live under `desktop/src-tauri/icons/` (full multi-size set for macOS/Windows/Linux).
- **Dev:** `cd desktop && npm run tauri:dev` (Rust + platform Tauri deps).
- **Local bundle:** `cd desktop && npm ci && npm run tauri:build`  
  With `"bundle.active": true` in `tauri.conf.json`, installers land under  
  `desktop/src-tauri/target/release/bundle/` (e.g. `.dmg`, `.msi` / NSIS, `.AppImage`, `.deb`).

  > **Unsigned local bundle:** the installers are written to `bundle/` even without any
  > signing keys. Because updater artifacts are enabled (`bundle.createUpdaterArtifacts`,
  > #173), `tauri build` then exits non-zero at its final *updater-signing* step unless
  > `TAURI_SIGNING_PRIVATE_KEY` is set — the `.app` / `.dmg` under `bundle/` are already
  > complete at that point, so a local smoke-test just uses them. Set the key (see the
  > updater section) to also emit the signed `*.app.tar.gz` used for auto-update. In CI the
  > key comes from a GitHub Actions secret; nothing signing-related is committed.

### Icons (regenerate)

Source art: `desktop/src-tauri/icons/app-icon-source.png` (≥512×512 PNG).

```sh
cd desktop
# Optional: replace app-icon-source.png with your ≥512px master, then:
npx @tauri-apps/cli icon src-tauri/icons/app-icon-source.png
```

That writes `icon.icns`, `icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, plus store sizes. Commit the outputs.

### Tag-driven GitHub Release (CI)

Workflow: `.github/workflows/release.yml` (#172).

| Trigger | Behavior |
|---------|----------|
| Push tag `v*` (e.g. `v0.1.0`) | Matrix build macOS / Ubuntu 22.04 / Windows → **draft** GitHub Release with installers |
| `workflow_dispatch` | Same, using the provided tag name input |

**Not** run on every PR or push to `main` (saves runner minutes). Day-to-day CI is `.github/workflows/ci.yml` (fmt/clippy/tests/frontend/Tauri host compile).

#### Operator release checklist

1. Bump `version` in `desktop/src-tauri/tauri.conf.json` (keep `cd-core` / package versions aligned when shipping).
2. Ensure main is green under the full gate (`cargo test --workspace`, desktop tsc/build, CI).
3. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`  
   **Or dry-run without a permanent tag:** Actions → **release** → **Run workflow** → enter a tag name (e.g. `v0.1.0-rc1`). Uses `workflow_dispatch` in `release.yml`.
4. Wait for the **release** workflow; open the **draft** GitHub Release; smoke-test one installer per OS.
5. Publish the release when ready.
6. **Signing / notarization** (Apple, Windows Authenticode) remains operator-owned — no secrets in the repo. Wire secrets only via GitHub Actions settings if you add signing later.
7. Auto-updater / `latest.json` is **#173** (not this workflow). Requires `TAURI_SIGNING_PRIVATE_KEY` secret for updater artifacts; unsigned installers still land in `bundle/` for local smoke.

#### Honesty: CLAIMS “Proven multi-OS installers”

Do **not** mark multi-OS installers **Shipped** in `docs/CLAIMS.md` until a real tag (or dispatch) run has produced downloadable artifacts on a GitHub Release. Until then keep the Roadmap residual (#172 / #55).

Expected artifacts (via `tauri-apps/tauri-action`, `targets: all`):

| OS | Typical outputs |
|----|-----------------|
| macOS | `.dmg` (and often `.app` inside) |
| Windows | `.msi` and/or NSIS `.exe` |
| Linux | `.AppImage`, `.deb` |

## Signing

Platform code signing is operator-specific; not committed here. Do not put certificates or private keys in the repository.

## Server

```sh
# Loopback single-user (no keys OK):
cargo run -p cd-server -- --bind 127.0.0.1:8787 --root /path/to/docs

# Preferred keys source (not visible in `ps`):
printf 'dev-key\n' > /tmp/cd-keys
cargo run -p cd-server -- --bind 0.0.0.0:8787 --allow-lan \
  --api-keys-file /tmp/cd-keys --root /path/to/docs
# or: CD_API_KEYS=dev-key cargo run -p cd-server -- ...
```

Non-loopback requires `--allow-lan` **and** at least one API key (startup refuses otherwise).  
**TLS:** terminate HTTPS at a reverse proxy — cd-server is HTTP-only. Avoid `--api-keys` on argv (leaks in process lists); prefer `--api-keys-file` or `CD_API_KEYS`.

## Opt-in signed updater (#173)

- **Plugin:** `tauri-plugin-updater` (Rust + `@tauri-apps/plugin-updater` JS).
- **Public key** is committed under `desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key** is **never** committed. Store as GitHub Actions secrets:
  - `TAURI_SIGNING_PRIVATE_KEY` — minisign private key string (from `npx tauri signer generate`)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — optional password if the key has one
- **Endpoint:** HTTPS only — `https://github.com/chriscase/ContextDesk/releases/latest/download/latest.json`
- **Artifacts:** `bundle.createUpdaterArtifacts: true` + release workflow `includeUpdaterJson: true`.
- **UX:** Settings → General → **Check for updates**. No background auto-install; confirm dialog before download+install.
- **CSP:** Update fetch runs in Rust, not the webview; `connect-src` does not need the GitHub host.

### Operator: generate / rotate keys

```sh
npx @tauri-apps/cli signer generate -w ./cd.key
# Commit only the printed public key into tauri.conf.json plugins.updater.pubkey
# Put private key contents into repo secret TAURI_SIGNING_PRIVATE_KEY
```

If you lose the private key, generate a new pair, update the committed pubkey, and cut a fresh release — prior installers cannot verify new signatures until they ship with the new pubkey (or users reinstall).
