# Packaging & release

## Desktop

- **Product name / identifier / window title** are derived from repo-root `branding.toml` by `desktop/scripts/gen-tauri-conf.mjs` (before `tauri dev` / `tauri build`).
- **Icons** live under `desktop/src-tauri/icons/` (full multi-size set for macOS/Windows/Linux).
- **Dev:** `cd desktop && npm run tauri:dev` (Rust + platform Tauri deps).
- **Local bundle:** `cd desktop && npm ci && npm run tauri:build`  
  With `"bundle.active": true` in `tauri.conf.json`, installers land under  
  `desktop/src-tauri/target/release/bundle/` (e.g. `.dmg`, `.msi` / NSIS, `.AppImage`, `.deb`).

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

1. Bump `version` in `desktop/src-tauri/tauri.conf.json` (and crates if needed).
2. Ensure main is green under the full gate.
3. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`
4. Wait for the **release** workflow; open the **draft** GitHub Release; smoke-test one installer per OS.
5. Publish the release when ready.
6. **Signing / notarization** (Apple, Windows Authenticode) remains operator-owned — no secrets in the repo. Wire secrets only via GitHub Actions settings if you add signing later.
7. Auto-updater / `latest.json` is **#173** (not this workflow).

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
cargo run -p cd-server -- --bind 127.0.0.1:8787 --root /path/to/docs --api-keys "dev-key"
```

Non-loopback requires `--allow-lan`. Put TLS at a reverse proxy.
