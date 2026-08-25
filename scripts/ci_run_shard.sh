#!/usr/bin/env sh
# Run one shard of the workspace test gate with per-unit diagnostics (#874).
#
# The point of this script is that a lost or cancelled runner is still
# readable: every test target is announced before it starts, a bounded
# manifest.json is rewritten on each heartbeat, and SIGTERM (step timeout or
# job cancellation) writes an incomplete status.json so the always() upload
# step has something to ship. GitHub cannot upload from a VM that is already
# gone; preventing that is the workflow's cache-warmup + step timeout, not
# this script.
#
# Layout produced under --out:
#
#   shard-<K>/plan.txt        units this shard owns, in run order
#   shard-<K>/build.log       `cargo test --no-run` output for the shard
#   shard-<K>/progress.jsonl  one record per unit start/finish (append-only)
#   shard-<K>/manifest.json   bounded current snapshot (overwritten)
#   shard-<K>/status.json     machine-readable shard result for the aggregate
#   shard-<K>/logs/<unit>.log full cargo output for one unit
#
# Test selection is delegated to scripts/ci_shard_plan.sh.
#
# No network beyond what the test suite itself already needs, no secrets.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PLAN="$ROOT/scripts/ci_shard_plan.sh"
CONFIG="$ROOT/scripts/ci_shard_config.sh"

SHARD=""
SHARDS=${CD_SHARD_COUNT:-}
OUT="$ROOT/ci-shards"
HEARTBEAT=${CD_SHARD_HEARTBEAT_SECONDS:-60}
UNIT_TIMEOUT=${CD_SHARD_UNIT_TIMEOUT_SECONDS:-1800}
CACHE_STATE=${CD_CACHE_STATE:-unknown}
PLATFORM_OS=${CD_PLATFORM_OS:-}
SNAPSHOT_HOOK=${CD_SHARD_SNAPSHOT_HOOK:-}
SUMMARY_DIR=""

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_run_shard.sh --shard K [--shards N] [--out DIR]
                             [--heartbeat SECS] [--unit-timeout SECS]
  sh scripts/ci_run_shard.sh --summary DIR

  --shard K          shard index to run (1-based)
  --shards N         total shards (default: $CD_SHARD_COUNT, else the canonical
                     count for --os, or Ubuntu when --os is omitted)
  --out DIR          artifact root (default: ./ci-shards)
  --heartbeat SECS   progress line interval while a unit runs (default 60, 0 disables)
  --unit-timeout S   per-unit wall-clock limit in seconds (default 1800, 0 disables)
  --os NAME          optional platform label recorded in status artifacts
  --summary DIR      diagnostic mode: report the last completed unit and test
                     counts from an artifact directory, including a shard whose
                     runner disappeared mid-run

Environment:
  CD_CACHE_STATE           cold|warm|unknown (recorded in the manifest)
  CD_SHARD_SNAPSHOT_HOOK   optional command invoked with the shard directory
                           after each unit and on incomplete shutdown
EOF
}

die() {
  echo "ci_run_shard: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
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
    --os)
      [ $# -ge 2 ] || die "--os needs a value"
      PLATFORM_OS=$2
      shift 2
      ;;
    --summary)
      [ $# -ge 2 ] || die "--summary needs a directory"
      SUMMARY_DIR=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

now_s() { date -u +%s; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

group_open() { [ "${GITHUB_ACTIONS:-}" = "true" ] && printf '::group::%s\n' "$1" || true; }
group_close() { [ "${GITHUB_ACTIONS:-}" = "true" ] && printf '::endgroup::\n' || true; }

# ---------------------------------------------------------------- summary mode
summarize() {
  dir=$1
  [ -d "$dir" ] || die "no such directory: $dir"
  found=0
  for progress in "$dir"/*/progress.jsonl "$dir"/*/*/progress.jsonl; do
    [ -e "$progress" ] || continue
    found=$((found + 1))
    shard_dir=$(dirname "$progress")
    status="$shard_dir/status.json"
    manifest="$shard_dir/manifest.json"
    echo "--- $(basename "$shard_dir") ---"
    if [ -f "$status" ]; then
      jq -r '"  result: \(.status)  units: \(.units_finished)/\(.units_total)  tests: \(.tests_passed) passed, \(.tests_failed) failed, \(.tests_ignored) ignored  (\(.seconds)s)"' "$status"
      failed=$(jq -r '.failed_units[]?' "$status")
      [ -z "$failed" ] || {
        echo "  failed units:"
        printf '    %s\n' $failed
      }
    else
      echo "  result: INCOMPLETE - no status.json (runner most likely disappeared)"
    fi
    if [ -f "$manifest" ]; then
      jq -r '"  manifest: \(.status)  cache: \(.cache_state)  in_flight: \(.in_flight // "<none>")  heartbeat \(.heartbeat_at)"' "$manifest"
    fi
    jq -sr '
      (map(select(.event == "finish")) | last) as $last
      | (map(select(.event == "start")) | last) as $started
      | "  last finished unit: \($last.unit // "<none>") \(if $last then "(\($last.status), \($last.tests_passed) passed)" else "" end)",
        (if ($started != null) and (($last == null) or ($started.unit != $last.unit))
         then "  IN FLIGHT WHEN THE LOG ENDS: \($started.unit) (started \($started.at))"
         else "  no unit was left in flight" end)
    ' "$progress"
  done
  [ "$found" -gt 0 ] || die "no shard progress records under $dir"
}

if [ -n "$SUMMARY_DIR" ]; then
  summarize "$SUMMARY_DIR"
  exit 0
fi

# ------------------------------------------------------------------- run mode
[ -n "$SHARD" ] || {
  usage >&2
  exit 2
}
[ -n "$SHARDS" ] || {
  case $PLATFORM_OS in
    macos | windows) SHARDS=$(sh "$CONFIG" count "$PLATFORM_OS") ;;
    *) SHARDS=$(sh "$CONFIG" count ubuntu) ;;
  esac
}
case $SHARD in '' | *[!0-9]*) die "--shard must be a positive integer" ;; esac
case $SHARDS in '' | *[!0-9]*) die "--shards must be a positive integer" ;; esac
[ "$SHARD" -ge 1 ] && [ "$SHARD" -le "$SHARDS" ] ||
  die "shard $SHARD is outside 1..$SHARDS (matrix and configured count disagree)"

case $CACHE_STATE in
  cold | warm | unknown) ;;
  *) CACHE_STATE=unknown ;;
esac

SHARD_DIR="$OUT/shard-$SHARD"
rm -rf "$SHARD_DIR"
mkdir -p "$SHARD_DIR/logs"
PROGRESS="$SHARD_DIR/progress.jsonl"
MANIFEST="$SHARD_DIR/manifest.json"
: >"$PROGRESS"

TIMEOUT_PREFIX=""
if [ "$UNIT_TIMEOUT" -gt 0 ] && command -v timeout >/dev/null 2>&1; then
  TIMEOUT_PREFIX="timeout $UNIT_TIMEOUT"
fi

sh "$PLAN" shard "$SHARD" --shards "$SHARDS" >"$SHARD_DIR/plan.txt"
TOTAL=$(wc -l <"$SHARD_DIR/plan.txt" | tr -d ' ')
[ "$TOTAL" -gt 0 ] || die "shard $SHARD/$SHARDS has no units; refusing to report a vacuous pass"

SHARD_START=$(now_s)
STARTED_AT=$(stamp)
IN_FLIGHT=""
LAST_FINISHED=""
FINALIZED=0
PASSED=0
FAILED=0
IGNORED=0
FINISHED=0
FAILED_UNITS=""
BUILD_SECONDS=0
STATUS=running

echo "=============================================================="
echo "shard $SHARD/$SHARDS  |  $TOTAL units  |  started $STARTED_AT"
echo "  RUST_TEST_THREADS=${RUST_TEST_THREADS:-<default>}  CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-<default>}"
echo "  heartbeat ${HEARTBEAT}s  unit timeout ${UNIT_TIMEOUT}s${TIMEOUT_PREFIX:+ (enforced)}"
echo "  cache_state=$CACHE_STATE"
echo "=============================================================="
sed 's/^/  /' "$SHARD_DIR/plan.txt"

run_snapshot_hook() {
  [ -n "$SNAPSHOT_HOOK" ] || return 0
  # Best-effort: a broken hook must not hide the shard result.
  # `sh -c cmd name "$dir"` puts the shard directory in $1.
  sh -c "$SNAPSHOT_HOOK" snapshot-hook "$SHARD_DIR" || true
}

write_manifest() {
  jq -n \
    --arg schema "cd.ci.shard_manifest.v1" \
    --arg os "$PLATFORM_OS" \
    --argjson shard "$SHARD" --argjson shards "$SHARDS" \
    --arg status "$STATUS" --arg cache "$CACHE_STATE" \
    --arg started "$STARTED_AT" --arg heartbeat "$(stamp)" \
    --arg in_flight "$IN_FLIGHT" --arg last_finished "$LAST_FINISHED" \
    --argjson units_total "$TOTAL" --argjson units_finished "$FINISHED" \
    --argjson tests_passed "$PASSED" --argjson tests_failed "$FAILED" \
    --argjson tests_ignored "$IGNORED" \
    '{schema: $schema, os: (if $os == "" then null else $os end),
      shard: $shard, shards: $shards, status: $status,
      cache_state: $cache, started_at: $started, heartbeat_at: $heartbeat,
      units_total: $units_total, units_finished: $units_finished,
      tests_passed: $tests_passed, tests_failed: $tests_failed,
      tests_ignored: $tests_ignored,
      in_flight: (if $in_flight == "" then null else $in_flight end),
      last_finished: (if $last_finished == "" then null else $last_finished end)}' \
    >"$MANIFEST"
}

write_status() {
  STATUS=$1
  SECONDS_TOTAL=$(($(now_s) - SHARD_START))
  jq -n \
    --arg os "$PLATFORM_OS" \
    --argjson shard "$SHARD" --argjson shards "$SHARDS" \
    --arg status "$STATUS" --arg finished_at "$(stamp)" \
    --arg cache "$CACHE_STATE" \
    --argjson units_total "$TOTAL" --argjson units_finished "$FINISHED" \
    --argjson tests_passed "$PASSED" --argjson tests_failed "$FAILED" \
    --argjson tests_ignored "$IGNORED" \
    --argjson seconds "$SECONDS_TOTAL" --argjson build_seconds "$BUILD_SECONDS" \
    --arg units "$(tr '\n' ' ' <"$SHARD_DIR/plan.txt")" \
    --arg failed_units "$FAILED_UNITS" \
    --arg in_flight "$IN_FLIGHT" \
    '{os: (if $os == "" then null else $os end),
      shard: $shard, shards: $shards, status: $status, finished_at: $finished_at,
      cache_state: $cache,
      units_total: $units_total, units_finished: $units_finished,
      tests_passed: $tests_passed, tests_failed: $tests_failed,
      tests_ignored: $tests_ignored, seconds: $seconds, build_seconds: $build_seconds,
      in_flight: (if $in_flight == "" then null else $in_flight end),
      units: ($units | split(" ") | map(select(length > 0))),
      failed_units: ($failed_units | split(" ") | map(select(length > 0)))}' \
    >"$SHARD_DIR/status.json"
  write_manifest
}

record() {
  jq -nc \
    --arg event "$1" --arg phase "$2" --arg unit "$3" --arg status "$4" \
    --arg at "$(stamp)" \
    --arg os "$PLATFORM_OS" \
    --argjson shard "$SHARD" --argjson shards "$SHARDS" \
    --argjson passed "${5:-0}" --argjson failed "${6:-0}" \
    --argjson ignored "${7:-0}" --argjson seconds "${8:-0}" \
    '{event: $event, phase: $phase, os: (if $os == "" then null else $os end),
      shard: $shard, shards: $shards, unit: $unit,
      status: $status, at: $at, tests_passed: $passed, tests_failed: $failed,
      tests_ignored: $ignored, seconds: $seconds}' >>"$PROGRESS"
}

HB_PID=""
hb_start() {
  [ "$HEARTBEAT" -gt 0 ] || return 0
  label=$1
  (
    waited=0
    while :; do
      sleep "$HEARTBEAT"
      waited=$((waited + HEARTBEAT))
      printf '[shard %s/%s] heartbeat  %s  still running after %ss  (%s)\n' \
        "$SHARD" "$SHARDS" "$label" "$waited" "$(stamp)"
      if [ -f "$MANIFEST" ]; then
        jq --arg at "$(stamp)" '.heartbeat_at = $at' "$MANIFEST" >"$MANIFEST.tmp" &&
          mv "$MANIFEST.tmp" "$MANIFEST"
      fi
    done
  ) &
  HB_PID=$!
}
hb_stop() {
  [ -n "$HB_PID" ] || return 0
  kill "$HB_PID" 2>/dev/null || true
  wait "$HB_PID" 2>/dev/null || true
  HB_PID=""
}

CMD_PID=""
TAIL_PID=""

kill_children() {
  if [ -n "$TAIL_PID" ]; then
    kill "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
    TAIL_PID=""
  fi
  if [ -n "$CMD_PID" ]; then
    kill "$CMD_PID" 2>/dev/null || true
    wait "$CMD_PID" 2>/dev/null || true
    CMD_PID=""
  fi
}

finalize_incomplete() {
  [ "$FINALIZED" = 1 ] && return 0
  FINALIZED=1
  hb_stop
  kill_children
  write_status incomplete
  run_snapshot_hook
  echo "[shard $SHARD/$SHARDS] incomplete shutdown; wrote status.json (in_flight=${IN_FLIGHT:-<none>})"
}

trap 'finalize_incomplete; exit 143' HUP INT TERM
# EXIT must not clobber a completed pass/fail, but must catch a bare `exit`
# or a signal that only delivers EXIT on some shells.
trap '[ "$FINALIZED" = 1 ] || finalize_incomplete' EXIT

RC=0
# Background cargo so a SIGTERM trap can interrupt `wait`. A pipeline to `tee`
# is not interruptible in dash (`/bin/sh` on Ubuntu), which is why shard 1
# could sit in `in_progress` until the hosted VM disappeared.
run_logged() {
  logfile=$1
  mode=$2
  shift 2
  if [ "$mode" = replace ]; then
    : >"$logfile"
  fi
  [ -f "$logfile" ] || : >"$logfile"
  "$@" </dev/null >>"$logfile" 2>&1 &
  CMD_PID=$!
  # `tail -f` is available in the POSIX shells shipped by the macOS and
  # Windows hosted runners.  Do not use GNU-only `--pid` or `stdbuf`: the
  # parent waits for cargo and then stops this best-effort log follower.
  tail -f "$logfile" 2>/dev/null &
  TAIL_PID=$!
  if wait "$CMD_PID"; then
    RC=0
  else
    RC=$?
  fi
  CMD_PID=""
  if [ -n "$TAIL_PID" ]; then
    kill "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
    TAIL_PID=""
  fi
}

count_field() {
  awk -v key="$2" '
    /^test result:/ { for (i = 1; i < NF; i++) if ($(i + 1) == key) total += $i }
    END { print total + 0 }
  ' "$1"
}

write_status running
run_snapshot_hook

# --------------------------------------------------------------- build phase
BUILD_START=$(now_s)
: >"$SHARD_DIR/build.log"
build_rc=0
group_open "shard $SHARD/$SHARDS: build test binaries"

# Unique compile selectors per package, with run-filters stripped so `--no-run`
# is not handed `log_analysis::` / `--skip`.
: >"$SHARD_DIR/.compile-pkgs"
while read -r unit; do
  compile=$(sh "$PLAN" compile-args "$unit")
  pkg=${compile#"-p "}
  pkg=${pkg%% *}
  printf '%s\t%s\n' "$pkg" "$compile" >>"$SHARD_DIR/.compile-pkgs"
done <"$SHARD_DIR/plan.txt"

PKGS=$(cut -f1 "$SHARD_DIR/.compile-pkgs" | LC_ALL=C sort -u)
for pkg in $PKGS; do
  : >"$SHARD_DIR/.flags"
  awk -F'\t' -v pkg="$pkg" '$1 == pkg { print $2 }' "$SHARD_DIR/.compile-pkgs" |
    while IFS= read -r compile; do
      rest=${compile#"-p $pkg "}
      case $rest in
        --doc | --doc\ *) continue ;;
      esac
      printf '%s\n' "$rest"
    done | LC_ALL=C sort -u >"$SHARD_DIR/.flags"
  [ -s "$SHARD_DIR/.flags" ] || continue
  flags=$(tr '\n' ' ' <"$SHARD_DIR/.flags")

  echo "[shard $SHARD/$SHARDS] build start  $pkg  $(stamp)"
  IN_FLIGHT="build:$pkg"
  write_manifest
  record start build "build:$pkg" running 0 0 0 0
  t0=$(now_s)
  hb_start "build $pkg"
  # shellcheck disable=SC2086
  run_logged "$SHARD_DIR/build.log" append cargo test -p "$pkg" $flags --no-run
  rc=$RC
  hb_stop
  dt=$(($(now_s) - t0))
  IN_FLIGHT=""
  if [ "$rc" -eq 0 ]; then
    echo "[shard $SHARD/$SHARDS] build ok     $pkg  ${dt}s"
    record finish build "build:$pkg" pass 0 0 0 "$dt"
  else
    echo "[shard $SHARD/$SHARDS] build FAILED $pkg  ${dt}s"
    record finish build "build:$pkg" fail 0 0 0 "$dt"
    build_rc=1
  fi
  write_manifest
done
group_close
BUILD_SECONDS=$(($(now_s) - BUILD_START))
echo "[shard $SHARD/$SHARDS] build phase finished in ${BUILD_SECONDS}s (rc=$build_rc)"
rm -f "$SHARD_DIR/.compile-pkgs" "$SHARD_DIR/.flags"
write_status running
run_snapshot_hook

# ---------------------------------------------------------------- test phase
INDEX=0

while read -r unit <&3; do
  INDEX=$((INDEX + 1))
  log="$SHARD_DIR/logs/$(printf '%s' "$unit" | tr '/' '_').log"
  unit_args=$(sh "$PLAN" args "$unit")

  echo "[shard $SHARD/$SHARDS] START  ($INDEX/$TOTAL)  $unit  $(stamp)"
  IN_FLIGHT=$unit
  write_manifest
  record start test "$unit" running 0 0 0 0
  t0=$(now_s)
  group_open "shard $SHARD/$SHARDS: ($INDEX/$TOTAL) $unit"
  hb_start "($INDEX/$TOTAL) $unit"
  # shellcheck disable=SC2086
  run_logged "$log" replace $TIMEOUT_PREFIX cargo test $unit_args
  rc=$RC
  hb_stop
  group_close
  dt=$(($(now_s) - t0))

  p=$(count_field "$log" "passed;")
  f=$(count_field "$log" "failed;")
  i=$(count_field "$log" "ignored;")
  PASSED=$((PASSED + p))
  FAILED=$((FAILED + f))
  IGNORED=$((IGNORED + i))
  FINISHED=$((FINISHED + 1))
  LAST_FINISHED=$unit
  IN_FLIGHT=""

  if [ "$rc" -eq 0 ]; then
    echo "[shard $SHARD/$SHARDS] PASS   ($INDEX/$TOTAL)  $unit  ${p} tests, ${i} ignored, ${dt}s"
    record finish test "$unit" pass "$p" "$f" "$i" "$dt"
  else
    FAILED_UNITS="${FAILED_UNITS:+$FAILED_UNITS }$unit"
    if [ "$rc" -eq 124 ]; then
      echo "::error title=shard $SHARD unit timeout::$unit exceeded ${UNIT_TIMEOUT}s and was killed"
      echo "[shard $SHARD/$SHARDS] TIMEOUT ($INDEX/$TOTAL)  $unit after ${dt}s"
      record finish test "$unit" timeout "$p" "$f" "$i" "$dt"
    else
      echo "::error title=shard $SHARD unit failed::$unit exited $rc"
      echo "[shard $SHARD/$SHARDS] FAIL   ($INDEX/$TOTAL)  $unit  rc=$rc  ${f} failing tests, ${dt}s"
      record finish test "$unit" fail "$p" "$f" "$i" "$dt"
    fi
    echo "----- tail of $log -----"
    tail -n 40 "$log" || true
    echo "------------------------"
  fi
  write_status running
  run_snapshot_hook
done 3<"$SHARD_DIR/plan.txt"

if [ -z "$FAILED_UNITS" ] && [ "$build_rc" -eq 0 ] && [ "$FINISHED" -eq "$TOTAL" ]; then
  STATUS=pass
else
  STATUS=fail
fi
FINALIZED=1
hb_stop
write_status "$STATUS"
run_snapshot_hook

echo "=============================================================="
echo "shard $SHARD/$SHARDS  $STATUS"
echo "  units      : $FINISHED/$TOTAL"
echo "  tests      : $PASSED passed, $FAILED failed, $IGNORED ignored"
echo "  build time : ${BUILD_SECONDS}s"
echo "  total time : $(($(now_s) - SHARD_START))s"
echo "  cache      : $CACHE_STATE"
[ -z "$FAILED_UNITS" ] || echo "  failed     : $FAILED_UNITS"
echo "=============================================================="

[ "$STATUS" = pass ] || exit 1
