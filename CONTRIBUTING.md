# Contributing

Thanks for helping build ContextDesk.

1. Read [AGENTS.md](AGENTS.md), [docs/PRODUCT.md](docs/PRODUCT.md), and [docs/NON_GOALS.md](docs/NON_GOALS.md).
2. Pick an issue; prefer items labeled `good first issue` or small `P1` tasks.
3. Keep PRs focused; link `Fixes #N`.
4. No secrets in commits (see [SECURITY.md](SECURITY.md)).
5. **Before pushing**, run the same gate CI runs (from repo root):

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p cd-server -- --print-branding
( cd desktop/src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo check )
( cd desktop && npm ci && npm run typecheck && npm run lint && npm run test && npm run build )
```

`cargo test -p cd-core` alone is **not** enough — CI also enforces fmt, clippy (all targets), `cd-server` tests, the Tauri host crate, and desktop typecheck/lint/test/build. See **Build / test / lint** and **Definition of done** in [AGENTS.md](AGENTS.md).

UI work should meet the quality bar in AGENTS.md (modular CSS, dark default, compact tools, accessible motion).
