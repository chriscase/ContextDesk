#!/usr/bin/env sh
# Portable macOS/Windows entry point for a complete workspace test shard.
#
# The common runner deliberately uses only POSIX shell facilities for process
# supervision.  Keep this wrapper separate from the Ubuntu workflow so the
# platform lane's portability contract is visible and testable.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CONFIG="$ROOT/scripts/ci_shard_config.sh"

OS=""
SHARD=""
SHARDS=""
OUT="$ROOT/ci-platform-shards"
HEARTBEAT=${CD_SHARD_HEARTBEAT_SECONDS:-60}
UNIT_TIMEOUT=${CD_SHARD_UNIT_TIMEOUT_SECONDS:-1800}

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_run_platform_shard.sh --os macos|windows --shard K
                                      [--shards N] [--out DIR]
                                      [--heartbeat SECS] [--unit-timeout SECS]
EOF
}

die() {
  echo "ci_run_platform_shard: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --os)
      [ $# -ge 2 ] || die "--os needs a value"
      OS=$2
      shift 2
      ;;
    --shard)
      [ $# -ge 2 ] || die "--shard needs a value"
      SHARD=$2
      shift 2
      ;;
    --shards)
      [ $# -ge 2 ] || die "--shards needs a value"
      SHARDS=$2
      shift 2
      ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a value"
      OUT=$2
      shift 2
      ;;
    --heartbeat)
      [ $# -ge 2 ] || die "--heartbeat needs a value"
      HEARTBEAT=$2
      shift 2
      ;;
    --unit-timeout)
      [ $# -ge 2 ] || die "--unit-timeout needs a value"
      UNIT_TIMEOUT=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

case $OS in
  macos | windows) ;;
  *) die "--os must be macos or windows" ;;
esac
[ -n "$SHARDS" ] || SHARDS=$(sh "$CONFIG" count "$OS")
case $SHARD in '' | *[!0-9]*) die "--shard must be a positive integer" ;; esac
case $SHARDS in '' | *[!0-9]*) die "--shards must be a positive integer" ;; esac
[ "$SHARD" -ge 1 ] && [ "$SHARD" -le "$SHARDS" ] ||
  die "shard $SHARD is outside 1..$SHARDS"

# The runner records this label in every manifest, progress record, and final
# status.  `env` is used instead of shell-specific variable assignment syntax
# so the boundary remains usable from Git Bash as well as macOS /bin/sh.
exec env CD_PLATFORM_OS="$OS" \
  sh "$ROOT/scripts/ci_run_shard.sh" \
  --os "$OS" \
  --shard "$SHARD" \
  --shards "$SHARDS" \
  --out "$OUT" \
  --heartbeat "$HEARTBEAT" \
  --unit-timeout "$UNIT_TIMEOUT"
