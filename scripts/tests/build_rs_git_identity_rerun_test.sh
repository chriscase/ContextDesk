#!/usr/bin/env bash
# Regression test: crates/cd-core/build.rs and crates/cd-cli/build.rs must
# rebuild (and re-embed CD_GIT_SHA) after an ordinary same-branch commit —
# not just after a branch switch.
#
# Root cause this guards against: `.git/HEAD`'s bytes only change when the
# checked-out ref itself changes (branch switch / detach). A same-branch
# `git commit` instead updates `.git/refs/heads/<branch>` and appends to
# `.git/logs/HEAD`, leaving `.git/HEAD` untouched. A build script that only
# declares `cargo:rerun-if-changed=.../.git/HEAD` is therefore skipped by
# Cargo on the next `cargo build`, silently baking a stale CD_GIT_SHA into an
# otherwise-fresh incremental build — exactly the trap `docs/DEMO_RUNBOOK.md`'s
# `capabilities` identity check assumes cannot happen.
#
# This test drives the REAL crates/cd-core/build.rs (copied verbatim, not
# reimplemented) inside a disposable scratch git+cargo fixture so it runs in
# a couple of seconds with no cd-core dependency graph involved.

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
readonly REPO_ROOT
BUILD_RS_SRC="$REPO_ROOT/crates/cd-core/build.rs"
readonly BUILD_RS_SRC

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_PARENT="${TEMP_PARENT%/}"
TEST_ROOT="$(mktemp -d "$TEMP_PARENT/cd-build-rs-rerun-test.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

printf '1..4\n'

[[ -f "$BUILD_RS_SRC" ]] || fail "missing $BUILD_RS_SRC"

# Nest the fixture crate two directories deep so the copied build.rs's
# `../../.git/...` paths resolve exactly as they do for the real crate.
FIXTURE_ROOT="$TEST_ROOT/repo"
CRATE_DIR="$FIXTURE_ROOT/crates/fixture"
mkdir -p "$CRATE_DIR/src"

git -C "$FIXTURE_ROOT" init -q 2>/dev/null || { mkdir -p "$FIXTURE_ROOT"; git -C "$FIXTURE_ROOT" init -q; }
git -C "$FIXTURE_ROOT" config user.email "build-rs-test@example.invalid"
git -C "$FIXTURE_ROOT" config user.name "Build RS Test"

cp "$BUILD_RS_SRC" "$CRATE_DIR/build.rs"

cat > "$CRATE_DIR/Cargo.toml" <<'EOF'
[package]
name = "fixture"
version = "0.0.0"
edition = "2021"
build = "build.rs"
EOF

cat > "$CRATE_DIR/src/main.rs" <<'EOF'
fn main() {
    println!("{}", option_env!("CD_GIT_SHA").unwrap_or("none"));
}
EOF

printf 'first\n' >"$FIXTURE_ROOT/README.md"
git -C "$FIXTURE_ROOT" add -A
git -C "$FIXTURE_ROOT" commit -qm "initial"
FIRST_SHA="$(git -C "$FIXTURE_ROOT" rev-parse --short=12 HEAD)"

CARGO_TARGET_DIR="$TEST_ROOT/target"
export CARGO_TARGET_DIR

(cd "$CRATE_DIR" && cargo build -q 2>"$TEST_ROOT/build1.log") ||
  { cat "$TEST_ROOT/build1.log" >&2; fail "initial cargo build failed"; }
FIRST_EMBEDDED="$("$CARGO_TARGET_DIR/debug/fixture")"
[[ "$FIRST_EMBEDDED" == "$FIRST_SHA" ]] ||
  fail "initial build embedded '$FIRST_EMBEDDED', expected '$FIRST_SHA'"
printf 'ok 1 - initial build embeds the commit it was built at\n'

# Same-branch commit: no checkout, no branch switch. `.git/HEAD`'s bytes do
# not change; only refs/heads/<branch> and logs/HEAD do.
HEAD_LOG="$(git -C "$FIXTURE_ROOT" rev-parse --git-path logs/HEAD)"
HEAD_LOG_BACKUP="$TEST_ROOT/head-log-before-second"
cp -p "$HEAD_LOG" "$HEAD_LOG_BACKUP"
printf 'second\n' >"$FIXTURE_ROOT/README.md"
git -C "$FIXTURE_ROOT" commit -qam "second"
SECOND_SHA="$(git -C "$FIXTURE_ROOT" rev-parse --short=12 HEAD)"
[[ "$SECOND_SHA" != "$FIRST_SHA" ]] || fail "fixture commits produced identical SHAs"

# Restore the reflog to its pre-commit bytes and timestamp. This deliberately
# removes it as a Cargo change signal, proving the current branch ref itself
# is watched. Fast consecutive real builds can otherwise miss a reflog-only
# transition on filesystems/toolchains with coarse timestamp observations.
cp -p "$HEAD_LOG_BACKUP" "$HEAD_LOG"

(cd "$CRATE_DIR" && cargo build -q 2>"$TEST_ROOT/build2.log") ||
  { cat "$TEST_ROOT/build2.log" >&2; fail "second cargo build failed"; }
printf 'ok 2 - rebuild after a same-branch commit succeeds\n'

SECOND_EMBEDDED="$("$CARGO_TARGET_DIR/debug/fixture")"
[[ "$SECOND_EMBEDDED" == "$SECOND_SHA" ]] ||
  fail "rebuild embedded stale '$SECOND_EMBEDDED', expected fresh '$SECOND_SHA'" \
       " (build.rs did not rerun for a same-branch commit — regression!)"
printf 'ok 3 - rebuild after a same-branch commit re-embeds the fresh CD_GIT_SHA\n'

# Repeat the identity transition from a linked worktree. In this layout
# `<worktree>/.git` is a pointer file, so hard-coded `.git/logs/HEAD` watchers
# silently watch a nonexistent path. The production build script must use
# `git rev-parse --git-path` and follow the worktree-specific reflog instead.
LINKED_ROOT="$TEST_ROOT/linked"
git -C "$FIXTURE_ROOT" worktree add -q -b linked-test "$LINKED_ROOT"
LINKED_CRATE="$LINKED_ROOT/crates/fixture"
LINKED_TARGET="$TEST_ROOT/linked-target"
(cd "$LINKED_CRATE" && CARGO_TARGET_DIR="$LINKED_TARGET" cargo build -q 2>"$TEST_ROOT/linked-build1.log") ||
  { cat "$TEST_ROOT/linked-build1.log" >&2; fail "initial linked-worktree build failed"; }

printf 'linked change\n' >"$LINKED_ROOT/README.md"
git -C "$LINKED_ROOT" commit -qam "linked second"
LINKED_SHA="$(git -C "$LINKED_ROOT" rev-parse --short=12 HEAD)"
(cd "$LINKED_CRATE" && CARGO_TARGET_DIR="$LINKED_TARGET" cargo build -q 2>"$TEST_ROOT/linked-build2.log") ||
  { cat "$TEST_ROOT/linked-build2.log" >&2; fail "second linked-worktree build failed"; }
LINKED_EMBEDDED="$("$LINKED_TARGET/debug/fixture")"
[[ "$LINKED_EMBEDDED" == "$LINKED_SHA" ]] ||
  fail "linked-worktree rebuild embedded stale '$LINKED_EMBEDDED', expected '$LINKED_SHA'"
printf 'ok 4 - linked-worktree commit re-embeds the fresh CD_GIT_SHA\n'
