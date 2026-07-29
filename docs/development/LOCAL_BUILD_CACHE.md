# Shared local build cache

ContextDesk has two Rust workspaces: the repository root and
`desktop/src-tauri`. Cargo normally gives each Git worktree—and each workspace
inside it—a separate `target/`. That is safe but can duplicate tens of
gigabytes. ContextDesk provides an **opt-in** helper that points both workspaces
at one explicit Cargo target outside every registered worktree.

The helper does not modify `~/.cargo/config.toml`, shell profiles, repository
Cargo profiles, or CI configuration.

## Activate it for one shell

From any ContextDesk worktree:

```sh
eval "$(scripts/local-build-cache.sh activate)"
```

The default shared target is:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/contextdesk/build-v1/cargo-target
```

Choose an absolute location explicitly when the default volume is too small:

```sh
eval "$(scripts/local-build-cache.sh activate \
  --cache-root /Volumes/DeveloperCache/contextdesk/build-v1)"
```

The command refuses a cache root inside any registered worktree or behind a
symlink. It exports only:

```text
CONTEXTDESK_BUILD_CACHE_ROOT
CARGO_TARGET_DIR
```

Those exports apply to root Cargo commands and are inherited by desktop/Tauri
commands:

```sh
cargo test -p cd-core

( cd desktop/src-tauri && cargo check )

( cd desktop && npm run tauri:build -- --bundles app )
```

Cargo's target lock and fingerprints make the root and nested Tauri workspaces
compatible with the same target for the normal ContextDesk toolchain and target
triple. Use a different `--cache-root` suffix when intentionally switching Rust
toolchains, target triples, or incompatible build environments. Concurrent
commands may serialize on Cargo's target lock; do not treat one shared target as
a distributed cache.

The first build still compiles normally. Reuse helps later worktrees avoid
rebuilding identical dependencies and avoids two full Rust target trees in each
worktree.

## Read-only inventory

Inventory is always a dry run:

```sh
scripts/local-build-cache.sh inventory
```

It reports:

- the primary and linked registered worktrees;
- whether each worktree has tracked or untracked changes;
- root, Tauri, and shared Cargo targets with sizes and cleanup eligibility;
- `.app` bundles nested in targets;
- per-worktree `desktop/node_modules` and `.fastembed_cache` sizes.

Dirty source is reported, never deleted. `node_modules` and embedding caches are
reported but are not accepted by the cleanup command.

## Preserve a packaged app

A Tauri package lives inside its Cargo target and would otherwise be removed by
`cargo clean`. Copy and content-verify the exact app first:

```sh
scripts/local-build-cache.sh preserve-app \
  --source "$CARGO_TARGET_DIR/release/bundle/macos/ContextDesk.app" \
  --destination "$CONTEXTDESK_BUILD_CACHE_ROOT/preserved-apps/$(git rev-parse HEAD)/ContextDesk.app"
```

The destination must be new, outside every registered worktree, free of symlink
path components, and end in `.app`. The helper compares a deterministic digest
of every regular file and symlink in the source and copy.

## Clean only an explicit generated target

Start with a dry run:

```sh
scripts/local-build-cache.sh cleanup --dry-run \
  --target "$CARGO_TARGET_DIR"
```

Apply only after reviewing the exact path and size:

```sh
scripts/local-build-cache.sh cleanup --apply \
  --target "$CARGO_TARGET_DIR"
```

If a target contains an app bundle, provide the verified external copy:

```sh
scripts/local-build-cache.sh cleanup --apply \
  --preserved-app "$CONTEXTDESK_BUILD_CACHE_ROOT/preserved-apps/$(git rev-parse HEAD)/ContextDesk.app" \
  --target /absolute/path/to/worktree/desktop/src-tauri/target
```

All requested targets are validated before the first cleanup. The helper accepts
only:

- the marked shared `cargo-target`;
- `<linked-worktree>/target`;
- `<linked-worktree>/desktop/src-tauri/target`.

It refuses:

- either Cargo target in the primary checkout;
- repository or workspace roots;
- missing or unrecognized directories;
- paths with symlink components;
- targets without a Cargo/generated signature;
- packaged apps without a verified preserved copy;
- symlinked `.app` bundles.

Cleanup delegates deletion to `cargo clean --target-dir` after validation. It
does not recursively delete arbitrary paths and never accepts source,
`node_modules`, embedding caches, or preserved package directories.

Do not run cleanup while a Cargo, Clippy, test, or Tauri build is active against
the target. The helper can validate paths and packages, but it cannot portably
prove that no compiler child process is using a target. Inventory first, stop or
finish active builds, preserve any package, then apply cleanup.

The shared target is intentionally not pruned automatically. Use inventory to
watch its size and the same explicit dry-run/apply cleanup when it is no longer
worth retaining. This keeps disk use bounded without a background process
deleting artifacts unexpectedly.

## Frontend and hosted caching

Do not share mutable `node_modules` between worktrees. Dependency graphs can
differ while branches are active. Run `npm ci` in each worktree; npm's own
download cache remains shared by the package manager, while `node_modules`,
Vite output, and TypeScript caches stay local and safely regenerable.

Hosted GitHub Actions already uses `Swatinem/rust-cache@v2` for the root and
Tauri Rust jobs, and `actions/setup-node`'s npm cache for the desktop job. Those
caches accelerate compatible hosted jobs; they do not share local worktree
targets, preserve packaged apps, provide signing keys, or remove local
artifacts. Issue #757 requires no change to `.github/workflows/ci.yml`.
