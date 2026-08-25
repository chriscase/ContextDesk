# Release contract acceptance v1

This is the fail-closed acceptance note for the unified desktop+CLI release
path. It is honest about what this lane proves and what remains residual.

**Authoritative orchestration:** `.github/workflows/release.yml`
**Promote (dispatch only):** `.github/workflows/release-promote.yml`
**Builders (artifacts only):** `release-desktop.yml`, `cli-release.yml`

## What this contract requires

1. One GitHub Release object per tag. Builders cannot race or clobber title,
   body, or prerelease state.
2. Tag / Cargo / Tauri / npm / CLI archive identity is consistent. Release
   binaries embed `CD_CHANNEL=installed` plus exact `CD_GIT_SHA` (40-char) and
   `CD_GIT_DESCRIBE`.
3. Promotion requires the complete Windows/macOS/Linux desktop matrix **and**
   the CLI matrix (`macos-arm64`, `macos-x64`, `linux-x64`, `windows-x64`).
4. One `SHA256SUMS`, `inventory.txt`, `sbom.cdx.json`, and
   `release-manifest.json`; promotion re-downloads the flat draft asset set and
   verifies every payload digest plus the generated metadata digests.
5. GA requires a signed `latest.json` whose URLs bind to the exact tag and whose
   Tauri Base64-wrapped minisign signatures cryptographically verify the exact
   updater bytes against the public key pinned in `tauri.conf.json`. Missing
   `TAURI_SIGNING_PRIVATE_KEY` fails before any publishable release state.
6. Apple notarization and Windows Authenticode remain **not_configured**.
7. `release-promote` resolves the remote tag and release target to the exact
   SHA, then publishes only a complete validated draft. Exact upload and
   already-published retries are idempotent; differing bytes or metadata fail
   closed.
8. Never reuse `v0.1.0-rc5` assets or another SHA.

## War Room

War Room (`collab/`) is **source-run / separately deployed today**. It is not
packaged into the desktop installer or CLI archive GitHub Release. Operators
who need War Room run it from a source checkout of `collab/`.

## Offline proof (this lane)

No heavyweight local Rust or Tauri build is required to accept the contract:

```bash
python3 scripts/release-contract/check_release_contract.py
python3 scripts/cli-release/check_cli_release_contract.py
```

Synthetic fixtures cover: partial matrices, version mismatch, wrong SHA,
missing or wrong-key signatures, altered downloaded bytes, checksum/manifest
drift, extra and missing assets, resumable exact-digest upload, duplicate
assets, symbolic release targets, release-object clobbering, idempotent
already-published completion, and safe rollback. A public minisign test vector
exercises the same OpenSSL 3.x Ed25519 verification used by production; no
private release key is present in the fixture.

## Required secret names (values never in git)

| Name | When |
|------|------|
| `GITHUB_TOKEN` | Provided by Actions; draft create / promote |
| `TAURI_SIGNING_PRIVATE_KEY` | Required for GA; presence-checked only |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional; only if the updater key has a password |

No Apple notarization or Authenticode secret names are configured. Do not
invent them.

## Residual

- No publish or tag matrix was executed in the contract-implementation lane.
- Proven multi-OS installers remain unshipped until a real green orchestrated
  run lists the exact assets.
- Apple notarization: not_configured.
- Windows Authenticode: not_configured.
- War Room is not a release asset.
