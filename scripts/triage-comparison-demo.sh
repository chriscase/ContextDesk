#!/usr/bin/env bash
# Demo helper for fixtures/triage-comparison-demo.
#
# Import, recorded/replay ingest, and report use existing offline commands.
# This script does not implement or invoke an offline bench-compare mode.
# `print-live` only prints the live `contextdesk bench-compare` command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$ROOT/fixtures/triage-comparison-demo"
TASK_ID="task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007"
SNAPSHOT_ID="snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb"
CASE_ID="case-demo-checkout-timeout"

usage() {
  cat <<'EOF'
Usage: scripts/triage-comparison-demo.sh <command> [--library DIR] [--privacy owner-only|share-safe]

Commands:
  import       init + import-case + import-snapshot + import-task
  offline      record-replay both checked-in envelopes + import-run both recorded docs
  report       cd-triage-bench report (default privacy: owner-only)
  print-live   print the live contextdesk bench-compare command; do not execute it
  self-check   import + offline + both reports, then fail closed on identity drift

Environment:
  CD_TRIAGE_BENCH, CD_TRIAGE_BENCH_ADAPTER, CONTEXTDESK_BIN
  CARGO_TARGET_DIR (defaults to <repo>/target)

This is not an offline bench-compare implementation.
EOF
}

COMMAND=""
LIBRARY="${LIB:-/tmp/cd-triage-comparison-demo-lib}"
PRIVACY="owner-only"

while [[ $# -gt 0 ]]; do
  case "$1" in
    import|offline|report|print-live|self-check)
      if [[ -n "$COMMAND" ]]; then
        echo "exactly one command is required" >&2
        exit 2
      fi
      COMMAND="$1"
      shift
      ;;
    --library)
      LIBRARY="${2:?--library requires a directory}"
      shift 2
      ;;
    --privacy)
      PRIVACY="${2:?--privacy requires owner-only or share-safe}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  usage >&2
  exit 2
fi

resolve_bin() {
  local env_name="$1"
  local crate="$2"
  local bin="$3"
  local override="${!env_name:-}"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  local target_dir="${CARGO_TARGET_DIR:-$ROOT/target}"
  if [[ -x "$target_dir/debug/$bin" ]]; then
    printf '%s\n' "$target_dir/debug/$bin"
    return 0
  fi
  echo "building $crate ($bin)" >&2
  cargo build -p "$crate" >/dev/null
  printf '%s\n' "$target_dir/debug/$bin"
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "missing required demo file: $path" >&2
    exit 1
  fi
}

require_package() {
  require_file "$DEMO/case.json"
  require_file "$DEMO/snapshot.json"
  require_file "$DEMO/task.json"
  require_file "$DEMO/blobs/checkout.log"
  require_file "$DEMO/candidates/candidate-a.json"
  require_file "$DEMO/candidates/candidate-b.json"
  require_file "$DEMO/recorded/human-run.json"
  require_file "$DEMO/recorded/other-product-run.json"
  require_file "$DEMO/replay/replay-completed.json"
  require_file "$DEMO/replay/replay-failed.json"
  require_file "$DEMO/identities.json"
}

cmd_import() {
  local bench="$1"
  mkdir -p "$(dirname "$LIBRARY")"
  if [[ ! -d "$LIBRARY" ]]; then
    "$bench" --library "$LIBRARY" init
  elif [[ ! -f "$LIBRARY/library.json" ]]; then
    "$bench" --library "$LIBRARY" init
  fi
  local got
  got="$("$bench" --library "$LIBRARY" import-case "$DEMO/case.json")"
  got="${got//$'\n'/}"
  if [[ "$got" != "$CASE_ID" ]]; then
    echo "import-case returned $got, expected $CASE_ID" >&2
    exit 1
  fi
  got="$("$bench" --library "$LIBRARY" import-snapshot "$DEMO/snapshot.json" --blob "$DEMO/blobs/checkout.log")"
  got="${got//$'\n'/}"
  if [[ "$got" != "$SNAPSHOT_ID" ]]; then
    echo "import-snapshot returned $got, expected $SNAPSHOT_ID" >&2
    exit 1
  fi
  got="$("$bench" --library "$LIBRARY" import-task "$DEMO/task.json")"
  got="${got//$'\n'/}"
  if [[ "$got" != "$TASK_ID" ]]; then
    echo "import-task returned $got, expected $TASK_ID" >&2
    exit 1
  fi
  echo "imported case=$CASE_ID snapshot=$SNAPSHOT_ID task=$TASK_ID"
}

cmd_offline() {
  local bench="$1"
  local adapter="$2"
  "$adapter" --library "$LIBRARY" record-replay "$TASK_ID" \
    --replay "$DEMO/replay/replay-completed.json" \
    --operator demo-operator \
    --created-at 2026-01-15T08:30:00Z
  "$adapter" --library "$LIBRARY" record-replay "$TASK_ID" \
    --replay "$DEMO/replay/replay-failed.json" \
    --operator demo-operator \
    --created-at 2026-01-15T08:31:00Z
  "$bench" --library "$LIBRARY" import-run "$DEMO/recorded/human-run.json"
  "$bench" --library "$LIBRARY" import-run "$DEMO/recorded/other-product-run.json"
  echo "offline recorded/replay ingest finished (not bench-compare)"
}

cmd_report() {
  local bench="$1"
  case "$PRIVACY" in
    owner-only|share-safe) ;;
    *)
      echo "--privacy must be owner-only or share-safe" >&2
      exit 2
      ;;
  esac
  "$bench" --library "$LIBRARY" report --format markdown --privacy "$PRIVACY"
}

cmd_print_live() {
  local contextdesk
  contextdesk="${CONTEXTDESK_BIN:-${CARGO_TARGET_DIR:-$ROOT/target}/debug/contextdesk}"
  cat <<EOF
# Live provider path only. This is not an offline command.
# Replace HOST_PROFILE_ID and HOST_MODEL_ID in both candidate files first.
# Point --data-dir at an existing host profile that already has credentials.

$contextdesk --data-dir "\$HOME/Library/Application Support/ContextDesk" \\
  bench-compare \\
  --library $LIBRARY \\
  --task $TASK_ID \\
  --candidate $DEMO/candidates/candidate-a.json \\
  --candidate $DEMO/candidates/candidate-b.json
EOF
}

require_package
cd "$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

case "$COMMAND" in
  print-live)
    cmd_print_live
    ;;
  import)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    cmd_import "$BENCH_BIN"
    ;;
  offline)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    ADAPTER_BIN="$(resolve_bin CD_TRIAGE_BENCH_ADAPTER cd-triage-bench-adapter-cli cd-triage-bench-adapter)"
    cmd_offline "$BENCH_BIN" "$ADAPTER_BIN"
    ;;
  report)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    cmd_report "$BENCH_BIN"
    ;;
  self-check)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    ADAPTER_BIN="$(resolve_bin CD_TRIAGE_BENCH_ADAPTER cd-triage-bench-adapter-cli cd-triage-bench-adapter)"
    LIBRARY="$(mktemp -d "${TMPDIR:-/tmp}/cd-triage-comparison-demo.XXXXXX")"
    trap 'rm -rf "$LIBRARY"' EXIT
    cmd_import "$BENCH_BIN"
    cmd_offline "$BENCH_BIN" "$ADAPTER_BIN"
    owner="$("$BENCH_BIN" --library "$LIBRARY" report --format markdown --privacy owner-only)"
    share="$("$BENCH_BIN" --library "$LIBRARY" report --format markdown --privacy share-safe)"
    printf '%s\n' "$owner" | grep -q "$TASK_ID"
    printf '%s\n' "$owner" | grep -q "$SNAPSHOT_ID"
    printf '%s\n' "$share" | grep -q "$TASK_ID"
    printf '%s\n' "$share" | grep -q 'Privacy: `share_safe`'
    printf '%s\n' "$owner" | grep -q 'Privacy: `owner_only`'
    runs="$("$BENCH_BIN" --library "$LIBRARY" list runs)"
    run_count="$(printf '%s\n' "$runs" | awk 'NF' | wc -l | tr -d ' ')"
    if [[ "$run_count" -lt 4 ]]; then
      echo "expected at least 4 stored runs, got: $runs" >&2
      exit 1
    fi
    echo "self-check passed ($run_count runs in $LIBRARY)"
    ;;
esac
