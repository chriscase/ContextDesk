#!/usr/bin/env sh
# Canonical cross-OS workspace-test shard topology.
#
# Capacity is intentionally per OS: Ubuntu has the larger hosted workload,
# while macOS and Windows retain their independently qualified four-way split.
# Keep the counts in topology() only. The workflow consumes generated matrices,
# and planner/aggregate callers verify any supplied count against this source.
set -eu

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_shard_config.sh list
  sh scripts/ci_shard_config.sh count OS
  sh scripts/ci_shard_config.sh matrix OS
  sh scripts/ci_shard_config.sh verify OS COUNT
  sh scripts/ci_shard_config.sh github-output

OS is one of: ubuntu, macos, windows.
EOF
}

die() {
  echo "ci_shard_config: $*" >&2
  exit 2
}

# Columns: logical OS, shard count. This is the only capacity definition.
topology() {
  printf '%s\n' \
    'ubuntu 8' \
    'macos 4' \
    'windows 4'
}

validate_topology() {
  rows=$(topology)
  [ -n "$rows" ] || die "topology is empty"

  duplicates=$(printf '%s\n' "$rows" | awk '{ print $1 }' | LC_ALL=C sort | uniq -d)
  [ -z "$duplicates" ] || die "duplicate OS entries: $duplicates"

  printf '%s\n' "$rows" | awk '
    NF != 2 { exit 1 }
    $1 !~ /^(ubuntu|macos|windows)$/ { exit 1 }
    $2 !~ /^[1-9][0-9]*$/ { exit 1 }
    { seen[$1] = 1 }
    END {
      if (!seen["ubuntu"] || !seen["macos"] || !seen["windows"]) exit 1
    }
  ' || die "topology must define one positive count for ubuntu, macos, and windows"
}

count_for() {
  os=$1
  case $os in ubuntu | macos | windows) ;; *) die "unknown OS '$os'" ;; esac
  count=$(topology | awk -v want="$os" '$1 == want { print $2 }')
  [ -n "$count" ] || die "no shard count configured for '$os'"
  printf '%s\n' "$count"
}

matrix_for() {
  count=$(count_for "$1")
  awk -v count="$count" 'BEGIN {
    printf "["
    for (i = 1; i <= count; i++) printf "%s%d", (i == 1 ? "" : ","), i
    print "]"
  }'
}

verify_count() {
  os=$1
  actual=$2
  case $actual in '' | *[!0-9]*) die "count must be a positive integer, got '$actual'" ;; esac
  [ "$actual" -ge 1 ] || die "count must be >= 1, got '$actual'"
  expected=$(count_for "$os")
  [ "$actual" = "$expected" ] ||
    die "$os shard count $actual disagrees with canonical count $expected"
  printf '%s\n' "$expected"
}

validate_topology
[ $# -ge 1 ] || { usage >&2; exit 2; }

command=$1
shift
case $command in
  list)
    [ $# -eq 0 ] || die "list takes no arguments"
    topology
    ;;
  count)
    [ $# -eq 1 ] || die "count needs exactly one OS"
    count_for "$1"
    ;;
  matrix)
    [ $# -eq 1 ] || die "matrix needs exactly one OS"
    matrix_for "$1"
    ;;
  verify)
    [ $# -eq 2 ] || die "verify needs OS and COUNT"
    verify_count "$1" "$2"
    ;;
  github-output)
    [ $# -eq 0 ] || die "github-output takes no arguments"
    for os in ubuntu macos windows; do
      printf '%s_count=%s\n' "$os" "$(count_for "$os")"
      printf '%s_matrix=%s\n' "$os" "$(matrix_for "$os")"
    done
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
