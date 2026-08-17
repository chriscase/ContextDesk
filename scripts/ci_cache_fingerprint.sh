#!/usr/bin/env sh
# Deterministic rust-cache fingerprint for CI evidence (#874 follow-up).
#
# Swatinem/rust-cache@v2 already hashes Cargo.lock, rust-toolchain files,
# rustc, and compiler env prefixes (CARGO, CC, CFLAGS, CXX, CMAKE, RUST).
# The RUST prefix matches RUSTFLAGS, so the workflow must not set
# `env-vars: RUSTFLAGS` as if it were missing. This script only records an
# auditable digest next to cache_state; it does not replace rust-cache's key.
#
# No network, no secrets.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OS_LABEL=""

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_cache_fingerprint.sh [--os OS]

Prints KEY=value lines:
  os, shared_key, lock_sha256, rustc, rustflags, fingerprint

`shared_key` is the rust-cache shared-key family for that OS. Ubuntu keeps
`ubuntu-workspace-tests`; macOS/Windows keep `*-workspace-tests-v2`.
EOF
}

die() {
  echo "ci_cache_fingerprint: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --os)
      [ $# -ge 2 ] || die "--os needs a value"
      OS_LABEL=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

case $OS_LABEL in
  "" | ubuntu | ubuntu-latest) SHARED_KEY=ubuntu-workspace-tests ;;
  macos | macos-latest) SHARED_KEY=macos-latest-workspace-tests-v2 ;;
  windows | windows-latest) SHARED_KEY=windows-latest-workspace-tests-v2 ;;
  *) die "unknown --os '$OS_LABEL' (use ubuntu-latest, macos-latest, windows-latest)" ;;
esac

hex256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{ print $1 }'
  else
    openssl dgst -sha256 | awk '{ print $NF }'
  fi
}

LOCK_SHA=missing
if [ -f "$ROOT/Cargo.lock" ]; then
  LOCK_SHA=$(hex256 <"$ROOT/Cargo.lock")
fi

RUSTC=missing
if command -v rustc >/dev/null 2>&1; then
  RUSTC=$(rustc --version --verbose | tr '\n' '|' | sed 's/|$//')
fi

RUSTFLAGS_VAL=${RUSTFLAGS-}

# Material is explicit and order-stable. rust-cache still owns the stored
# key; this digest is recorded next to cache_state so a 113MB deps-only hit
# can be distinguished from a workspace+DuckDB restore.
MATERIAL=$(printf '%s\n' \
  "shared_key=$SHARED_KEY" \
  "lock=$LOCK_SHA" \
  "rustc=$RUSTC" \
  "rustflags=$RUSTFLAGS_VAL" \
  "policy=cache-workspace-crates+targets+RUSTFLAGS")
FINGERPRINT=$(printf '%s' "$MATERIAL" | hex256 | cut -c1-16)

{
  echo "os=${OS_LABEL:-ubuntu-latest}"
  echo "shared_key=$SHARED_KEY"
  echo "lock_sha256=$LOCK_SHA"
  echo "rustc=$RUSTC"
  echo "rustflags=$RUSTFLAGS_VAL"
  echo "fingerprint=$FINGERPRINT"
}

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "os=${OS_LABEL:-ubuntu-latest}"
    echo "shared_key=$SHARED_KEY"
    echo "lock_sha256=$LOCK_SHA"
    echo "fingerprint=$FINGERPRINT"
  } >>"$GITHUB_OUTPUT"
fi
