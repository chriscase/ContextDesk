#!/usr/bin/env sh
# Offline proof that `cargo test --workspace` and `cargo test -p` do not share
# dependency fingerprints when members enable different features of a shared
# crate. This is the mismatch hosted Ubuntu shards hit after warmup used
# `--workspace --no-run` (run 31851734335: warm cache_state, yet build:cd-cli
# recompiled libduckdb-sys for ~11 minutes).
#
# No network beyond crates.io for the tiny fixture; no secrets; no ContextDesk
# workspace build.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
PROOF=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-fingerprint-unify.XXXXXX")
trap 'rm -rf "$PROOF"' EXIT HUP INT TERM

die() {
  echo "ci_fingerprint_unify_test: $*" >&2
  exit 1
}

command -v cargo >/dev/null 2>&1 || die "cargo is required"

mkdir -p "$PROOF/a/src" "$PROOF/b/src"
cat >"$PROOF/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = ["a", "b"]
EOF
cat >"$PROOF/a/Cargo.toml" <<'EOF'
[package]
name = "a"
version = "0.1.0"
edition = "2021"
[dependencies]
serde = { version = "1", default-features = false }
EOF
cat >"$PROOF/a/src/lib.rs" <<'EOF'
pub fn x() {}
EOF
cat >"$PROOF/b/Cargo.toml" <<'EOF'
[package]
name = "b"
version = "0.1.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
EOF
cat >"$PROOF/b/src/lib.rs" <<'EOF'
pub fn y() {}
EOF

export CARGO_TARGET_DIR="$PROOF/target"
export CARGO_INCREMENTAL=0
# Match CI warning policy off for the fixture; keep cargo output grep-friendly.
export RUSTFLAGS=""
export CARGO_TERM_COLOR=never
cd "$PROOF"

cargo build --workspace -q
# After a workspace-unified build, a single-package build must recompile serde
# when that package wants a different feature set.
log=$PROOF/p-build.log
if ! cargo build -p a -v >"$log" 2>&1; then
  die "cargo build -p a failed after workspace build"
fi

if ! grep -E 'Compiling[[:space:]]+serde(_core)?[[:space:]]' "$log" >/dev/null; then
  echo "expected Compiling serde after workspace -> -p (fingerprint mismatch proof)" >&2
  echo "---- log ----" >&2
  cat "$log" >&2
  exit 1
fi

# Control: sequential -p builds keep both feature variants; returning to -p a
# must be Fresh (this is why warmup now uses shard-shaped -p compiles).
rm -rf "$PROOF/target"
cargo build -p a -q
cargo build -p b -q
log2=$PROOF/p-again.log
cargo build -p a -v >"$log2" 2>&1 || die "cargo build -p a (second pass) failed"
if grep -E 'Compiling[[:space:]]+serde(_core)?[[:space:]]' "$log2" >/dev/null; then
  echo "sequential -p a then -p b then -p a should keep serde Fresh" >&2
  cat "$log2" >&2
  exit 1
fi
if ! grep -E 'Fresh[[:space:]]+serde(_core)?[[:space:]]' "$log2" >/dev/null; then
  # Some cargo versions omit Fresh lines at default verbosity even with -v for
  # already-cached units; accept Finished-in-0 when Compiling is absent.
  if ! grep -E 'Finished .* in 0\.' "$log2" >/dev/null; then
    echo "expected Fresh serde or instant Finished on second -p a" >&2
    cat "$log2" >&2
    exit 1
  fi
fi

# Workflow contract: warmup must call the shard-shaped warmer, not --workspace.
wf=$ROOT/.github/workflows/ci.yml
grep -q 'ci_warm_test_artifacts.sh' "$wf" ||
  die "ci.yml warmup must call scripts/ci_warm_test_artifacts.sh"
if grep -E 'cargo test --workspace --no-run' "$wf" | grep -v '#' >/dev/null; then
  die "ci.yml must not warm with cargo test --workspace --no-run"
fi
grep -q 'ubuntu-workspace-tests-v2' "$wf" ||
  die "ci.yml must bump shared-key so old workspace-unified caches are not reused"
grep -q "save-if: \${{ github.ref == 'refs/heads/main' }}" "$wf" ||
  die "ci.yml rust-cache writers must save only on main"

echo "ci_fingerprint_unify_test: OK"
