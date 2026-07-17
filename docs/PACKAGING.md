# Packaging & release

## Desktop

- Product name / identifier from `branding.toml` and `desktop/src-tauri/tauri.conf.json`.
- Icons under `desktop/src-tauri/icons/`.
- Dev: `cd desktop && npm run tauri dev` (requires Rust + platform Tauri deps).
- Bundle: set `"bundle.active": true` and run `npm run tauri build`.

## Signing

Platform code signing (Apple/Windows) is operator-specific; not committed here.

## Server

```sh
cargo run -p cd-server -- --bind 127.0.0.1:8787 --root /path/to/docs --api-keys "dev-key"
```

Non-loopback requires `--allow-lan`. Put TLS at a reverse proxy.
