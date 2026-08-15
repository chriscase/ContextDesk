#!/usr/bin/env sh
# Compile workspace test artifacts with the same -p selectors shards use.
#
# Hosted run 31851734335 restored ubuntu-workspace-tests as warm, yet every
# shard spent ~11 minutes on build:cd-cli and recompiled libduckdb-sys.
# Warmup had used `cargo test --workspace --no-run`, which unifies dependency
# features across all members. Shards then run `cargo test -p PKG ...`, which
# selects a different feature set and misses those fingerprints.
#
# Cargo can keep multiple feature variants of a crate side-by-side. Warming
# each package with the shard compile shape therefore populates the variants
# shards actually request, without needing nightly feature-unification.
#
# No network beyond the registry the suite already uses; no secrets.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PLAN="$ROOT/scripts/ci_shard_plan.sh"

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_warm_test_artifacts.sh

Compiles every shard unit's cargo selectors with --no-run, aggregating flags
per package exactly as scripts/ci_run_shard.sh does in its build phase.
EOF
}

die() {
  echo "ci_warm_test_artifacts: $*" >&2
  exit 2
}

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
  '')
    ;;
  *)
    die "unknown argument '$1'"
    ;;
esac

command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-warm-tests.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

sh "$PLAN" units >"$tmp/units"
[ -s "$tmp/units" ] || die "shard plan produced no units"

: >"$tmp/compile-pkgs"
while IFS= read -r unit; do
  [ -n "$unit" ] || continue
  compile=$(sh "$PLAN" compile-args "$unit")
  pkg=${compile#"-p "}
  pkg=${pkg%% *}
  printf '%s\t%s\n' "$pkg" "$compile" >>"$tmp/compile-pkgs"
done <"$tmp/units"

PKGS=$(cut -f1 "$tmp/compile-pkgs" | LC_ALL=C sort -u)
echo "ci_warm_test_artifacts: compiling $(echo "$PKGS" | wc -w | tr -d ' ') packages for shard-shaped fingerprints"

for pkg in $PKGS; do
  : >"$tmp/flags"
  awk -F'\t' -v pkg="$pkg" '$1 == pkg { print $2 }' "$tmp/compile-pkgs" |
    while IFS= read -r compile; do
      rest=${compile#"-p $pkg "}
      # Match ci_run_shard.sh build phase: skip doc selectors. Cargo rejects
      # combining doctest selection with --no-run ("can't skip running doc
      # tests with --no-run"; hosted run 31893128816). Doc units compile when
      # shards execute them, same as before this warmer existed.
      case $rest in
        --doc | --doc\ *) continue ;;
      esac
      printf '%s\n' "$rest"
    done | LC_ALL=C sort -u >"$tmp/flags"

  [ -s "$tmp/flags" ] || continue
  flags=$(tr '\n' ' ' <"$tmp/flags")
  echo "ci_warm_test_artifacts: cargo test -p $pkg $flags --no-run"
  # shellcheck disable=SC2086
  cargo test -p "$pkg" $flags --no-run
done

echo "ci_warm_test_artifacts: done"
