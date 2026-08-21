#!/usr/bin/env bash
# Demo helper for fixtures/triage-comparison-demo.
#
# Import, recorded/replay ingest, and report use existing offline commands.
# Live commands generate temporary candidate documents containing only exact
# profile/model selections and strategy metadata; credentials remain in the
# host configuration and credential adapter. Mixed-profile live runs must not
# set CONTEXTDESK_PROVIDER_API_KEY; each profile uses its own Keychain or
# protected-file reference.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$ROOT/fixtures/triage-comparison-demo"
TASK_ID="task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007"
ABSTENTION_TASK_ID="task-a234e534de674b597def0297299b0dfbd1a078d9d5cb976973e8abc1c2157ecb"
CONTRADICTION_TASK_ID="task-fb25638d4a48bf43144167d4448a3811452946acb5f7e4fd0e9087c87f3985fe"
SNAPSHOT_ID="snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb"
CASE_ID="case-demo-checkout-timeout"
GOLD_ID="gold-synth-three-model-checkout-v1"
DEFAULT_MODEL_A="qwen-3.6-27b"
DEFAULT_MODEL_B="gpt-oss-120b"
DEFAULT_MODEL_C="ministral-3-14b-instruct-2512"

usage() {
  cat <<'EOF'
Usage: scripts/triage-comparison-demo.sh <command> [options]

Commands:
  import       init + import-case + import-snapshot + import-task
  offline      record-replay both checked-in envelopes + import-run both recorded docs
  report       cd-triage-bench report (default privacy: owner-only)
  agreement    cd-triage-bench agreement (default privacy: owner-only)
  preflight    validate three exact model selections; optionally discover/verify live
  run-live     run three candidates on one task, then print owner/share-safe agreement
  matrix       repeat the same three candidates over every --task / --task-file entry
  print-live   print the live three-model workflow; do not execute it
  self-check   import + offline + reports + agreement views, then fail closed on identity drift

Options:
  --library DIR
  --privacy owner-only|share-safe
  --format text|json                     live comparison output (default: text)
  --data-dir DIR --app-config FILE
  --profile-id ID
  --profile-a ID --profile-b ID --profile-c ID
  --model-a ID --model-b ID --model-c ID
  --task ID (repeatable for matrix)
  --task-file FILE (newline-separated task ids)
  --discover / --verify (preflight live checks)

Environment:
  CD_TRIAGE_BENCH, CD_TRIAGE_BENCH_ADAPTER, CONTEXTDESK_BIN
  CARGO_TARGET_DIR (defaults to <repo>/target)

Live commands contact configured providers only when explicitly requested.
EOF
}

COMMAND=""
LIBRARY="${LIB:-/tmp/cd-triage-comparison-demo-lib}"
PRIVACY="owner-only"
FORMAT="text"
PROFILE_DEFAULT=""
PROFILE_A=""
PROFILE_B=""
PROFILE_C=""
MODEL_A="$DEFAULT_MODEL_A"
MODEL_B="$DEFAULT_MODEL_B"
MODEL_C="$DEFAULT_MODEL_C"
DATA_DIR=""
APP_CONFIG=""
DISCOVER=0
VERIFY=0
TASKS=()
TASK_COUNT=0
TASK_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    import|offline|report|agreement|preflight|run-live|matrix|print-live|self-check)
      if [[ -n "$COMMAND" ]]; then
        echo "exactly one command is required" >&2
        exit 2
      fi
      COMMAND="$1"
      shift
      ;;
    --profile-id)
      if [[ $# -lt 2 ]]; then echo "--profile-id requires an id" >&2; exit 2; fi
      PROFILE_DEFAULT="$2"
      shift 2
      ;;
    --profile-a)
      if [[ $# -lt 2 ]]; then echo "--profile-a requires an id" >&2; exit 2; fi
      PROFILE_A="$2"
      shift 2
      ;;
    --profile-b)
      if [[ $# -lt 2 ]]; then echo "--profile-b requires an id" >&2; exit 2; fi
      PROFILE_B="$2"
      shift 2
      ;;
    --profile-c)
      if [[ $# -lt 2 ]]; then echo "--profile-c requires an id" >&2; exit 2; fi
      PROFILE_C="$2"
      shift 2
      ;;
    --model-a)
      if [[ $# -lt 2 ]]; then echo "--model-a requires an id" >&2; exit 2; fi
      MODEL_A="$2"
      shift 2
      ;;
    --model-b)
      if [[ $# -lt 2 ]]; then echo "--model-b requires an id" >&2; exit 2; fi
      MODEL_B="$2"
      shift 2
      ;;
    --model-c)
      if [[ $# -lt 2 ]]; then echo "--model-c requires an id" >&2; exit 2; fi
      MODEL_C="$2"
      shift 2
      ;;
    --data-dir)
      if [[ $# -lt 2 ]]; then echo "--data-dir requires a directory" >&2; exit 2; fi
      DATA_DIR="$2"
      shift 2
      ;;
    --app-config)
      if [[ $# -lt 2 ]]; then echo "--app-config requires a file" >&2; exit 2; fi
      APP_CONFIG="$2"
      shift 2
      ;;
    --task)
      if [[ $# -lt 2 ]]; then echo "--task requires an id" >&2; exit 2; fi
      TASKS+=("$2")
      TASK_COUNT=$((TASK_COUNT + 1))
      shift 2
      ;;
    --task-file)
      if [[ $# -lt 2 ]]; then echo "--task-file requires a file" >&2; exit 2; fi
      TASK_FILE="$2"
      shift 2
      ;;
    --discover)
      DISCOVER=1
      shift
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    --format)
      if [[ $# -lt 2 ]]; then echo "--format requires text or json" >&2; exit 2; fi
      FORMAT="$2"
      if [[ "$FORMAT" != "text" && "$FORMAT" != "json" ]]; then
        echo "--format must be text or json" >&2
        exit 2
      fi
      shift 2
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

if [[ -z "$PROFILE_A" ]]; then PROFILE_A="$PROFILE_DEFAULT"; fi
if [[ -z "$PROFILE_B" ]]; then PROFILE_B="$PROFILE_DEFAULT"; fi
if [[ -z "$PROFILE_C" ]]; then PROFILE_C="$PROFILE_DEFAULT"; fi

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
  require_file "$DEMO/tasks/abstention.json"
  require_file "$DEMO/tasks/contradiction.json"
  require_file "$DEMO/blobs/checkout.log"
  require_file "$DEMO/candidates/candidate-a.json"
  require_file "$DEMO/candidates/candidate-b.json"
  require_file "$DEMO/candidates/candidate-c.json"
  require_file "$DEMO/recorded/human-run.json"
  require_file "$DEMO/recorded/other-product-run.json"
  require_file "$DEMO/replay/replay-completed.json"
  require_file "$DEMO/replay/replay-failed.json"
  require_file "$DEMO/identities.json"
}

validate_model_selection() {
  if [[ -z "$PROFILE_A" || -z "$PROFILE_B" || -z "$PROFILE_C" ]]; then
    echo "an exact host profile is required; use --profile-id or per-candidate profile flags" >&2
    exit 2
  fi
  if [[ -z "$MODEL_A" || -z "$MODEL_B" || -z "$MODEL_C" ||
        "$MODEL_A" == HOST_* || "$MODEL_B" == HOST_* || "$MODEL_C" == HOST_* ]]; then
    echo "all three candidates require non-placeholder exact model ids" >&2
    exit 2
  fi
  if [[ "$MODEL_A" == "$MODEL_B" || "$MODEL_A" == "$MODEL_C" || "$MODEL_B" == "$MODEL_C" ]]; then
    echo "the three comparison model ids must be distinct" >&2
    exit 2
  fi
  local model_lower
  for model_lower in "$MODEL_A" "$MODEL_B" "$MODEL_C"; do
    model_lower="$(printf '%s' "$model_lower" | tr '[:upper:]' '[:lower:]')"
    case "$model_lower" in
      *deepseek*|bge-m3|*reranker*)
        echo "model $model_lower is not allowed in the chat comparison lane" >&2
        exit 2
        ;;
    esac
  done
}

validate_task_id() {
  local task="$1"
  if [[ ! "$task" =~ ^task-[A-Za-z0-9._:-]+$ ]]; then
    echo "invalid task id: $task" >&2
    exit 2
  fi
}

load_task_file() {
  if [[ -z "$TASK_FILE" ]]; then
    return 0
  fi
  if [[ ! -f "$TASK_FILE" ]]; then
    echo "task file is missing: $TASK_FILE" >&2
    exit 2
  fi
  local task
  while IFS= read -r task || [[ -n "$task" ]]; do
    task="$(printf '%s' "$task" | sed 's/[[:space:]]*#.*$//' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$task" ]] && continue
    TASKS+=("$task")
    TASK_COUNT=$((TASK_COUNT + 1))
  done < "$TASK_FILE"
}

validate_tasks() {
  local index=0
  while [[ "$index" -lt "$TASK_COUNT" ]]; do
    validate_task_id "${TASKS[$index]}"
    index=$((index + 1))
  done
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
  local extra_task expected
  for extra_task in abstention contradiction; do
    case "$extra_task" in
      abstention) expected="$ABSTENTION_TASK_ID" ;;
      contradiction) expected="$CONTRADICTION_TASK_ID" ;;
    esac
    got="$("$bench" --library "$LIBRARY" import-task "$DEMO/tasks/$extra_task.json")"
    got="${got//$'\n'/}"
    if [[ "$got" != "$expected" ]]; then
      echo "import-task returned $got, expected $expected for $extra_task" >&2
      exit 1
    fi
  done
  echo "imported case=$CASE_ID snapshot=$SNAPSHOT_ID tasks=$TASK_ID,$ABSTENTION_TASK_ID,$CONTRADICTION_TASK_ID"
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

cmd_agreement() {
  local bench="$1"
  case "$PRIVACY" in
    owner-only|share-safe) ;;
    *)
      echo "--privacy must be owner-only or share-safe" >&2
      exit 2
      ;;
  esac
  "$bench" --library "$LIBRARY" agreement --format markdown --privacy "$PRIVACY"
}

run_contextdesk_with_state() {
  local contextdesk="$1"
  shift
  if [[ -n "$DATA_DIR" && -n "$APP_CONFIG" ]]; then
    "$contextdesk" --data-dir "$DATA_DIR" --app-config "$APP_CONFIG" "$@"
  elif [[ -n "$DATA_DIR" ]]; then
    "$contextdesk" --data-dir "$DATA_DIR" "$@"
  elif [[ -n "$APP_CONFIG" ]]; then
    "$contextdesk" --app-config "$APP_CONFIG" "$@"
  else
    "$contextdesk" "$@"
  fi
}

cmd_preflight() {
  validate_model_selection
  echo "three-model preflight (selection only; credentials are not displayed)"
  echo "- candidate-a: profile=$PROFILE_A model=$MODEL_A"
  echo "- candidate-b: profile=$PROFILE_B model=$MODEL_B"
  echo "- candidate-c: profile=$PROFILE_C model=$MODEL_C"
  if [[ "$DISCOVER" -eq 0 && "$VERIFY" -eq 0 ]]; then
    echo "No provider call made. Add --discover and/or --verify for live host checks."
    return 0
  fi
  local contextdesk
  if [[ -v CONTEXTDESK_BIN && -n "$CONTEXTDESK_BIN" ]]; then
    contextdesk="$CONTEXTDESK_BIN"
  else
    contextdesk="$(resolve_bin CONTEXTDESK_BIN cd-cli contextdesk)"
  fi
  if [[ "$DISCOVER" -eq 1 ]]; then
    run_contextdesk_with_state "$contextdesk" models discover
  fi
  if [[ "$VERIFY" -eq 1 ]]; then
    run_contextdesk_with_state "$contextdesk" --profile "$PROFILE_A" models verify "$MODEL_A" --yes
    run_contextdesk_with_state "$contextdesk" --profile "$PROFILE_B" models verify "$MODEL_B" --yes
    run_contextdesk_with_state "$contextdesk" --profile "$PROFILE_C" models verify "$MODEL_C" --yes
  fi
}

write_candidate() {
  local path="$1"
  local profile="$2"
  local model="$3"
  local name="$4"
  local cancellation="$5"
  local created_at="$6"
  python3 - "$path" "$profile" "$model" "$name" "$cancellation" "$created_at" <<'PY'
import json
import sys

path, profile, model, name, cancellation, created_at = sys.argv[1:]
payload = {
    "policy": {"kind": "standard", "model": {"profile_id": profile, "model_id": model}},
    "cancellation_id": cancellation,
    "strategy": {
        "name": name,
        "version": "demo-v1",
        "operator": "demo-operator",
        "created_at": created_at,
    },
    "overrides": {},
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
PY
}

make_candidates() {
  CANDIDATE_DIR="$(mktemp -d "/tmp/cd-triage-comparison-candidates.XXXXXX")"
  write_candidate "$CANDIDATE_DIR/candidate-a.json" "$PROFILE_A" "$MODEL_A" "comparison-candidate-a" "cancel-demo-a" "2026-01-15T08:00:00Z"
  write_candidate "$CANDIDATE_DIR/candidate-b.json" "$PROFILE_B" "$MODEL_B" "comparison-candidate-b" "cancel-demo-b" "2026-01-15T08:01:00Z"
  write_candidate "$CANDIDATE_DIR/candidate-c.json" "$PROFILE_C" "$MODEL_C" "comparison-candidate-c" "cancel-demo-c" "2026-01-15T08:02:00Z"
}

cmd_compare_one() {
  local contextdesk="$1"
  local bench="$2"
  local task="$3"
  echo "=== live three-model comparison: $task ==="
  run_contextdesk_with_state "$contextdesk" --format "$FORMAT" bench-compare \
    --library "$LIBRARY" \
    --task "$task" \
    --candidate "$CANDIDATE_DIR/candidate-a.json" \
    --candidate "$CANDIDATE_DIR/candidate-b.json" \
    --candidate "$CANDIDATE_DIR/candidate-c.json"
  echo "=== evidence agreement (owner-only): $task ==="
  "$bench" --library "$LIBRARY" agreement --task "$task" --format markdown --privacy owner-only
  echo "=== evidence agreement (share-safe): $task ==="
  "$bench" --library "$LIBRARY" agreement --task "$task" --format markdown --privacy share-safe
}

cmd_run_live() {
  local contextdesk="$1"
  local bench="$2"
  validate_model_selection
  validate_task_id "$TASK_ID"
  if [[ ! -f "$LIBRARY/library.json" ]]; then
    echo "benchmark library is not initialized; run import first: $LIBRARY" >&2
    exit 1
  fi
  make_candidates
  trap 'rm -rf "$CANDIDATE_DIR"' EXIT
  cmd_compare_one "$contextdesk" "$bench" "$TASK_ID"
}

cmd_matrix() {
  local contextdesk="$1"
  local bench="$2"
  validate_model_selection
  load_task_file
  if [[ "$TASK_COUNT" -lt 2 ]]; then
    echo "matrix requires at least two --task values or a --task-file with at least two task ids" >&2
    exit 2
  fi
  validate_tasks
  if [[ ! -f "$LIBRARY/library.json" ]]; then
    echo "benchmark library is not initialized: $LIBRARY" >&2
    exit 1
  fi
  make_candidates
  trap 'rm -rf "$CANDIDATE_DIR"' EXIT
  local index=0
  local task
  while [[ "$index" -lt "$TASK_COUNT" ]]; do
    task="${TASKS[$index]}"
    cmd_compare_one "$contextdesk" "$bench" "$task"
    index=$((index + 1))
  done
}

cmd_print_live() {
  cat <<EOF
# Live provider path only. This helper does not execute the commands below.
# The exact profile id must come from the host configuration/catalog.

scripts/triage-comparison-demo.sh preflight \\
  --profile-id HOST_PROFILE_ID \\
  --model-a $MODEL_A \\
  --model-b $MODEL_B \\
  --model-c $MODEL_C \\
  --discover --verify

scripts/triage-comparison-demo.sh run-live \\
  --library $LIBRARY \\
  --profile-id HOST_PROFILE_ID \\
  --model-a $MODEL_A \\
  --model-b $MODEL_B \\
  --model-c $MODEL_C

# For repeated tasks, use matrix and repeat --task, or pass --task-file.
EOF
  return

}

require_package
cd "$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

case "$COMMAND" in
  print-live)
    cmd_print_live
    ;;
  preflight)
    cmd_preflight
    ;;
  run-live|matrix)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    if [[ -v CONTEXTDESK_BIN && -n "$CONTEXTDESK_BIN" ]]; then
      CONTEXTDESK_RUN="$CONTEXTDESK_BIN"
    else
      CONTEXTDESK_RUN="$(resolve_bin CONTEXTDESK_BIN cd-cli contextdesk)"
    fi
    if [[ "$COMMAND" == "run-live" ]]; then
      cmd_run_live "$CONTEXTDESK_RUN" "$BENCH_BIN"
    else
      cmd_matrix "$CONTEXTDESK_RUN" "$BENCH_BIN"
    fi
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
  agreement)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    cmd_agreement "$BENCH_BIN"
    ;;
  self-check)
    BENCH_BIN="$(resolve_bin CD_TRIAGE_BENCH cd-triage-bench cd-triage-bench)"
    ADAPTER_BIN="$(resolve_bin CD_TRIAGE_BENCH_ADAPTER cd-triage-bench-adapter-cli cd-triage-bench-adapter)"
    LIBRARY="$(mktemp -d "${TMPDIR:-/tmp}/cd-triage-comparison-demo.XXXXXX")"
    trap 'rm -rf "$LIBRARY"' EXIT
    cmd_import "$BENCH_BIN"
    cmd_offline "$BENCH_BIN" "$ADAPTER_BIN"
    gold_import="$("$BENCH_BIN" --library "$LIBRARY" import-gold "$ROOT/collab/contracts/fixtures/gold-reference.valid.json")"
    gold_import="${gold_import//$'\n'/}"
    if [[ "$gold_import" != "$GOLD_ID v1" ]]; then
      echo "import-gold returned $gold_import, expected $GOLD_ID v1" >&2
      exit 1
    fi
    owner="$("$BENCH_BIN" --library "$LIBRARY" report --format markdown --privacy owner-only)"
    share="$("$BENCH_BIN" --library "$LIBRARY" report --format markdown --privacy share-safe)"
    owner_agreement="$("$BENCH_BIN" --library "$LIBRARY" agreement --format markdown --privacy owner-only)"
    share_agreement="$("$BENCH_BIN" --library "$LIBRARY" agreement --format markdown --privacy share-safe)"
    printf '%s\n' "$owner" | grep -q "$TASK_ID"
    printf '%s\n' "$owner" | grep -q "$SNAPSHOT_ID"
    printf '%s\n' "$owner" | grep -q "Gold reference.*$GOLD_ID.*v1"
    printf '%s\n' "$owner" | grep -q 'Human acceptance'
    printf '%s\n' "$share" | grep -q "$TASK_ID"
    printf '%s\n' "$share" | grep -q 'Privacy: `share_safe`'
    printf '%s\n' "$share" | grep -q 'Gold alignment is not a correctness verdict'
   printf '%s\n' "$owner" | grep -q 'Privacy: `owner_only`'
    printf '%s\n' "$owner_agreement" | grep -q 'Triage bench evidence agreement'
    printf '%s\n' "$share_agreement" | grep -q 'Triage bench evidence agreement (share-safe)'
    runs="$("$BENCH_BIN" --library "$LIBRARY" list runs)"
    run_count="$(printf '%s\n' "$runs" | awk 'NF' | wc -l | tr -d ' ')"
    if [[ "$run_count" -lt 4 ]]; then
      echo "expected at least 4 stored runs, got: $runs" >&2
      exit 1
    fi
    echo "self-check passed ($run_count runs in $LIBRARY)"
    ;;
esac
