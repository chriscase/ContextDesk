# Packaging & release

## Desktop

- Product name / identifier from `branding.toml` and `desktop/src-tauri/tauri.conf.json`.
- Icons under `desktop/src-tauri/icons/`.
- Dev: `cd desktop && npm run tauri:dev` (requires Rust + platform Tauri deps).
- Bundle: set `"bundle.active": true` in `tauri.conf.json` and run `npm run tauri:build`.
- CI: `desktop` job runs `npm ci && npm run build` (frontend) on every PR; full native bundle is release-operator.

### Release checklist

1. Bump `version` in `desktop/src-tauri/tauri.conf.json` and crate versions if needed.
2. `cargo test -p cd-core && cargo test -p cd-server`
3. `cd desktop && npm ci && npm run build && npm run tauri:build`
4. Smoke-test Settings → Preflight → one research turn offline.
5. Attach artifacts to a GitHub Release; note platform signing separately.

## Signing

Platform code signing (Apple/Windows) is operator-specific; not committed here.

## Server

```sh
cargo run -p cd-server -- --bind 127.0.0.1:8787 --root /path/to/docs --api-keys "dev-key"
```

Non-loopback requires `--allow-lan`. Put TLS at a reverse proxy.
