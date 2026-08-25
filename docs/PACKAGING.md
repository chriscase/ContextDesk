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

### Authoritative release orchestration (CI)

**One path owns the GitHub Release object:** `.github/workflows/release.yml`.
Desktop and CLI builders (`release-desktop.yml`, `cli-release.yml`) upload
Actions artifacts only. They must not create, retitle, rewrite, or publish a
GitHub Release. That is the fail-closed answer to two workflows racing on the
same `v*` tag and clobbering title, body, or prerelease state.

| Workflow | Trigger | GitHub Release |
|----------|---------|----------------|
| `release.yml` (authoritative) | tag `v*`, `workflow_dispatch` | Creates **one** locked draft after both matrices complete. Never publishes. |
| `release-desktop.yml` | `workflow_call` / isolated dispatch | Artifacts only |
| `cli-release.yml` | `workflow_call` / isolated dispatch | Artifacts only |
| `release-promote.yml` | `workflow_dispatch` only | Publishes only after exact-SHA validation |

**Not** run on every PR or push to `main`. Day-to-day CI is `.github/workflows/ci.yml`.
Offline contract tests: `python3 scripts/release-contract/check_release_contract.py`.

Release builds embed `CD_CHANNEL=installed` plus the exact `CD_GIT_SHA` (40-char)
and `CD_GIT_DESCRIBE`. Tag, Cargo workspace, desktop Cargo, `tauri.conf.json`,
and `desktop/package.json` versions must agree (prerelease tags keep the
`MAJOR.MINOR.PATCH` package core). CLI archive names use the tag without `v`.

The assemble step refuses a partial Windows/macOS/Linux desktop or CLI matrix,
duplicate basenames, a foreign git SHA, and reuse of `v0.1.0-rc5` (or any other)
assets on a different tag. It writes one `SHA256SUMS`, `inventory.txt`,
`sbom.cdx.json`, and `release-manifest.json` covering **every** released asset
(desktop installers, CLI archives, updater payloads, and `latest.json`).

GA (`vX.Y.Z` with no prerelease suffix) requires a signed `latest.json` whose
URLs and signatures bind to those exact artifacts. Missing updater signing
prerequisites fail in preflight **before** any publishable release state.
Prerelease tags may draft without updater signatures; they still cannot be
promoted to GA rules.

Apple notarization and Windows Authenticode are **not_configured** in this
repository. Do not claim notarized or Authenticode-signed installers unless a
future workflow actually wires those jobs and named secrets.

**War Room** (the `collab/` collaboration surface) is **source-run / separately
deployed today**. It is not an asset of the desktop installer or CLI archive
release. Do not describe a GitHub Release as shipping War Room.

#### Operator release checklist

1. Align versions: Cargo workspace, `desktop/src-tauri/Cargo.toml`,
   `desktop/src-tauri/tauri.conf.json`, and `desktop/package.json`.
2. Ensure the intended SHA is green under the full gate.
3. Tag that exact SHA: `git tag v0.1.0 && git push origin v0.1.0`
   **or** Actions → **release** → **Run workflow** with that tag.
   This is **not** a no-tag dry run.
4. Wait for **release** to finish. Confirm the draft title/body/prerelease
   match the locked contract and that `SHA256SUMS` lists every desktop, CLI,
   and updater asset.
5. Smoke-test installers and CLI archives from that draft only. Never copy
   `v0.1.0-rc5` (or any other SHA/tag) assets onto a new cut.
6. Promote **only** via Actions → **release-promote** with the exact 40-char
   SHA and `confirm_publish=publish`. Any other confirm value, or any
   validation failure, leaves the draft unpublished.
7. Updater signing secret **names** (values stay in GitHub Actions; never
   commit them): `TAURI_SIGNING_PRIVATE_KEY`, optional
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. GA preflight fails closed if the
   private key is absent.

#### Honesty: CLAIMS “Proven multi-OS installers”

Do **not** mark multi-OS installers **Shipped** in `docs/CLAIMS.md` until a
**real green orchestrated run** has produced downloadable artifacts for the
complete desktop and CLI matrices. Until then keep the Roadmap residual
(#172 / #55). The in-repo contract is testable offline; it is not itself a
published installer.

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
- **Artifacts:** `bundle.createUpdaterArtifacts: true` on GA/signed runs. The
  orchestrator assembles one `latest.json` after the desktop matrix finishes
  and verifies URL/signature binding. Builders do not attach updater JSON
  themselves.
- **UX:** Settings → General → **Check for updates**. No background auto-install; confirm dialog before download+install.
- **CSP:** Update fetch runs in Rust, not the webview; `connect-src` does not need the GitHub host.

### Operator: generate / rotate keys

```sh
npx @tauri-apps/cli signer generate -w ./cd.key
# Commit only the printed public key into tauri.conf.json plugins.updater.pubkey
# Put private key contents into repo secret TAURI_SIGNING_PRIVATE_KEY
```

If you lose the private key, generate a new pair, update the committed pubkey, and cut a fresh release — prior installers cannot verify new signatures until they ship with the new pubkey (or users reinstall).

GA assemble verifies that `latest.json` URLs use
`/releases/download/<exact-tag>/` (never `/latest/` or another tag such as
`v0.1.0-rc5`) and that each signature binds to the exact updater artifact
bytes in the inventory.

## CLI multi-platform archives

See [CLI_PACKAGING.md](./CLI_PACKAGING.md). CLI archives are built by
`.github/workflows/cli-release.yml` as **artifacts only**. The authoritative
draft GitHub Release that attaches those archives next to desktop installers
is assembled by `.github/workflows/release.yml`. Isolated CLI dispatch never
publishes and never mutates title/body/prerelease.

Acceptance instructions: [RELEASE_CONTRACT_ACCEPTANCE_V1.md](./testing/RELEASE_CONTRACT_ACCEPTANCE_V1.md).
