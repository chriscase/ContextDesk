# ContextDesk desktop

ContextDesk's desktop application is a Tauri 2 host with a React + Vite
webview. Rust owns trusted capabilities, credentials, filesystem access, and
provider traffic; the webview presents state and invokes the narrow host
boundary.

## Prerequisites

- Rust stable
- Node.js 20+
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your operating system

Install the locked frontend dependency graph from this directory:

```sh
npm ci
```

## Run the desktop application

```sh
npm run tauri:dev
```

The development command selects a free local frontend port and launches the
real Tauri host. Use `npm run dev` only for focused browser rendering work;
browser-only mode cannot prove keychain, filesystem, window, packaging, or
other trusted-host behavior.

## Verify changes

```sh
npm run typecheck
npm run lint
npm run test
npm run build

cd src-tauri
cargo fmt -- --check
cargo clippy -- -D warnings
cargo check
```

Run the repository-wide Rust and documentation gates from the repository root;
see [`../docs/DEV.md`](../docs/DEV.md) and
[`../docs/AGENT_WORKFLOW.md`](../docs/AGENT_WORKFLOW.md).

## Build a local package

```sh
CARGO_TARGET_DIR="$PWD/src-tauri/target" \
  npm run tauri:build -- --bundles app
```

On macOS, the `.app` is written below
`src-tauri/target/release/bundle/macos/`. A local unsigned bundle can finish
before the command reports that the release updater-signing private key is
missing. Do not create, request, or expose a release key merely to run a local
build.

## Conventions

- Never send secrets to the webview.
- Keep component CSS in the modular files under `src/styles/`.
- Reuse the SVG icon system in `src/components/icons.tsx`.
- Treat browser tests as complementary to, not a substitute for, packaged-app
  acceptance.
