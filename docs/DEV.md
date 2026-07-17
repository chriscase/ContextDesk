# Development

## Prerequisites

- Rust stable (edition 2021+)  
- Node.js 20+  
- Platform dependencies for [Tauri 2](https://v2.tauri.app/start/prerequisites/)  

## Workspace commands

```sh
# Format / lint (as tooling lands)
cargo fmt
cargo clippy -p cd-core -- -D warnings
cargo test -p cd-core

# Desktop
cd desktop
npm install
npm run tauri dev
```

## Config locations (defaults)

| Path | Use |
|------|-----|
| `branding.toml` (repo) | Product identity for builds |
| `~/.contextdesk/` | User config, profiles, skills (planned) |
| `<workspace>/.contextdesk/` | Project skills & memory (planned) |

## Secrets

Copy `.env.example` → `.env` for local experiments. Never commit `.env`.

Grok Build session reuse (planned) reads `~/.grok/auth.json` only after explicit UI opt-in.
