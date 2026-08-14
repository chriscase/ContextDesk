#!/usr/bin/env sh
# Run one shard of the workspace test gate with per-unit diagnostics (#874).
#
# The point of this script is that a lost runner is still readable: every test
# target is announced before it starts and recorded when it finishes, so the
# artifact (or the raw job log) always names the unit that was in flight when
# the runner went away, plus the counts for everything that already passed.
#
# Layout produced under --out:
#
#   shard-<K>/plan.txt        units this shard owns, in run order
#   shard-<K>/build.log       `cargo test --no-run` output for the shard
#   shard-<K>/progress.jsonl  one record per unit start/finish (append-only)
#   shard-<K>/status.json     machine-readable shard result for the aggregate
#   shard-<K>/logs/<unit>.log full cargo output for one unit
#
# Test selection is delegated to scripts/ci_shard_plan.sh, so this script
# cannot skip a test target on its own: it runs exactly what the plan assigns.
#
# No network beyond what the test suite itself already needs, no secrets.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PLAN="$ROOT/scripts/ci_shard_plan.sh"

SHARD=""
SHARDS=${CD_SHARD_COUNT:-4}
OUT="$ROOT/ci-shards"
HEARTBEAT=${CD_SHARD_HEARTBEAT_SECONDS:-60}
# A single test binary that runs longer than this is pathological: the whole
# workspace used to finish in 70-80 minutes.  Timing out names the offending
# unit and lets the rest of the shard still report, instead of burning the job
# timeout on a hang.  A timeout is a failure -- it never skips a test.
UNIT_TIMEOUT=${CD_SHARD_UNIT_TIMEOUT_SECONDS:-1800}
SUMMARY_DIR=""

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_run_shard.sh --shard K [--shards N] [--out DIR]
                             [--heartbeat SECS] [--unit-timeout SECS]
  sh scripts/ci_run_shard.sh --summary DIR

  --shard K          shard index to run (1-based)
  --shards N         total shards (default: $CD_SHARD_COUNT, else 4)
  --out DIR          artifact root (default: ./ci-shards)
  --heartbeat SECS   progress line interval while a unit runs (default 60, 0 disables)
  --unit-timeout S   per-unit wall-clock limit in seconds (default 1800, 0 disables)
  --summary DIR      diagnostic mode: report the last completed unit and test
                     counts from an artifact directory, including a shard whose
                     runner disappeared mid-run
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
# Works on a partial directory on purpose: when a runner vanishes there is no
# status.json, only the progress records written before it died.
summarize() {
  dir=$1
  [ -d "$dir" ] || die "no such directory: $dir"
  found=0
  for progress in "$dir"/*/progress.jsonl "$dir"/*/*/progress.jsonl; do
    [ -e "$progress" ] || continue
    found=$((found + 1))
    shard_dir=$(dirname "$progress")
    status="$shard_dir/status.json"
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
case $SHARD in '' | *[!0-9]*) die "--shard must be a positive integer" ;; esac
case $SHARDS in '' | *[!0-9]*) die "--shards must be a positive integer" ;; esac
# Fail closed on a matrix that has drifted away from the configured shard
# count: an out-of-range index would otherwise run an empty shard and pass.
[ "$SHARD" -ge 1 ] && [ "$SHARD" -le "$SHARDS" ] ||
  die "shard $SHARD is outside 1..$SHARDS (matrix and CD_SHARD_COUNT disagree)"

SHARD_DIR="$OUT/shard-$SHARD"
rm -rf "$SHARD_DIR"
mkdir -p "$SHARD_DIR/logs"
PROGRESS="$SHARD_DIR/progress.jsonl"
: >"$PROGRESS"

# `timeout` is coreutils and always present on the Linux runners this gate uses;
# a local shell without it simply loses the per-unit limit.
TIMEOUT_PREFIX=""
if [ "$UNIT_TIMEOUT" -gt 0 ] && command -v timeout >/dev/null 2>&1; then
  TIMEOUT_PREFIX="timeout $UNIT_TIMEOUT"
fi
RC_FILE="$SHARD_DIR/.last-rc"

sh "$PLAN" shard "$SHARD" --shards "$SHARDS" >"$SHARD_DIR/plan.txt"
TOTAL=$(wc -l <"$SHARD_DIR/plan.txt" | tr -d ' ')
[ "$TOTAL" -gt 0 ] || die "shard $SHARD/$SHARDS has no units; refusing to report a vacuous pass"

SHARD_START=$(now_s)
echo "=============================================================="
echo "shard $SHARD/$SHARDS  |  $TOTAL units  |  started $(stamp)"
echo "  RUST_TEST_THREADS=${RUST_TEST_THREADS:-<default>}  CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-<default>}"
echo "  heartbeat ${HEARTBEAT}s  unit timeout ${UNIT_TIMEOUT}s${TIMEOUT_PREFIX:+ (enforced)}"
echo "=============================================================="
sed 's/^/  /' "$SHARD_DIR/plan.txt"

record() {
  # record <event> <phase> <unit> <status> <passed> <failed> <ignored> <seconds>
  jq -nc \
    --arg event "$1" --arg phase "$2" --arg unit "$3" --arg status "$4" \
    --arg at "$(stamp)" \
    --argjson shard "$SHARD" --argjson shards "$SHARDS" \
    --argjson passed "${5:-0}" --argjson failed "${6:-0}" \
    --argjson ignored "${7:-0}" --argjson seconds "${8:-0}" \
    '{event: $event, phase: $phase, shard: $shard, shards: $shards, unit: $unit,
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
trap 'hb_stop' EXIT HUP INT TERM

# Run a command, stream its output live to both the job log and a file, and
# leave its real exit status in $RC.
#
# The status has to travel through a file.  This is POSIX sh: there is no
# pipefail and no PIPESTATUS, so `cmd | tee` would report tee's status, and
# `set -e` tears the left-hand subshell down before a trailing `echo $?` can
# run -- either way a failing test binary would report a green shard.  The
# status is recorded from inside an `if`, where `set -e` is suspended.
RC=0
run_logged() {
  logfile=$1
  mode=$2
  shift 2
  rm -f "$RC_FILE"
  if [ "$mode" = append ]; then
    { if "$@" </dev/null 2>&1; then echo 0 >"$RC_FILE"; else echo $? >"$RC_FILE"; fi; } | tee -a "$logfile"
  else
    { if "$@" </dev/null 2>&1; then echo 0 >"$RC_FILE"; else echo $? >"$RC_FILE"; fi; } | tee "$logfile"
  fi
  # No status file means the subshell died before it could report one; that is
  # a failure, never a pass.
  if [ -s "$RC_FILE" ]; then RC=$(cat "$RC_FILE"); else RC=99; fi
}

# Sum the `test result:` lines a cargo run emits -- one per test binary, plus
# one for doc tests -- so every shard reports how much it actually executed.
count_field() {
  awk -v key="$2" '
    /^test result:/ { for (i = 1; i < NF; i++) if ($(i + 1) == key) total += $i }
    END { print total + 0 }
  ' "$1"
}

# --------------------------------------------------------------- build phase
# One `--no-run` build per package, before any test runs, so the shard log
# separates "still compiling" from "running tests" instead of leaving both
# behind one opaque step.  Doc tests are excluded: cargo rejects --no-run for
# them and they compile at run time anyway.
BUILD_START=$(now_s)
PKGS=$(awk -F/ '{ print $1 }' "$SHARD_DIR/plan.txt" | LC_ALL=C sort -u)
: >"$SHARD_DIR/build.log"
build_rc=0
group_open "shard $SHARD/$SHARDS: build test binaries"
for pkg in $PKGS; do
  flags=""
  while read -r unit; do
    case $unit in
      "$pkg"/doc) continue ;;
      "$pkg"/*) ;;
      *) continue ;;
    esac
    unit_args=$(sh "$PLAN" args "$unit")
    flags="$flags ${unit_args#-p $pkg }"
  done <"$SHARD_DIR/plan.txt"
  [ -n "$flags" ] || continue

  echo "[shard $SHARD/$SHARDS] build start  $pkg  $(stamp)"
  record start build "build:$pkg" running 0 0 0 0
  t0=$(now_s)
  hb_start "build $pkg"
  # Word splitting on $flags is intended: the plan rejects target names that
  # contain whitespace, so each element is a single cargo argument.
  # shellcheck disable=SC2086
  run_logged "$SHARD_DIR/build.log" append cargo test -p "$pkg" $flags --no-run
  rc=$RC
  hb_stop
  dt=$(($(now_s) - t0))
  if [ "$rc" -eq 0 ]; then
    echo "[shard $SHARD/$SHARDS] build ok     $pkg  ${dt}s"
    record finish build "build:$pkg" pass 0 0 0 "$dt"
  else
    echo "[shard $SHARD/$SHARDS] build FAILED $pkg  ${dt}s"
    record finish build "build:$pkg" fail 0 0 0 "$dt"
    build_rc=1
  fi
done
group_close
BUILD_SECONDS=$(($(now_s) - BUILD_START))
echo "[shard $SHARD/$SHARDS] build phase finished in ${BUILD_SECONDS}s (rc=$build_rc)"

# ---------------------------------------------------------------- test phase
PASSED=0
FAILED=0
IGNORED=0
FINISHED=0
FAILED_UNITS=""
INDEX=0

# The plan is read on fd 3: a test binary that reads stdin would otherwise
# swallow the remaining units and silently shorten the shard.
while read -r unit <&3; do
  INDEX=$((INDEX + 1))
  log="$SHARD_DIR/logs/$(printf '%s' "$unit" | tr '/' '_').log"
  unit_args=$(sh "$PLAN" args "$unit")

  echo "[shard $SHARD/$SHARDS] START  ($INDEX/$TOTAL)  $unit  $(stamp)"
  record start test "$unit" running 0 0 0 0
  t0=$(now_s)
  group_open "shard $SHARD/$SHARDS: ($INDEX/$TOTAL) $unit"
  hb_start "($INDEX/$TOTAL) $unit"
  # Output is streamed live, not just captured: a runner that dies mid-unit
  # still leaves the partial log in the job.
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
done 3<"$SHARD_DIR/plan.txt"

SECONDS_TOTAL=$(($(now_s) - SHARD_START))
STATUS=pass
[ -z "$FAILED_UNITS" ] || STATUS=fail
[ "$build_rc" -eq 0 ] || STATUS=fail
[ "$FINISHED" -eq "$TOTAL" ] || STATUS=fail

jq -n \
  --argjson shard "$SHARD" --argjson shards "$SHARDS" \
  --arg status "$STATUS" --arg finished_at "$(stamp)" \
  --argjson units_total "$TOTAL" --argjson units_finished "$FINISHED" \
  --argjson tests_passed "$PASSED" --argjson tests_failed "$FAILED" \
  --argjson tests_ignored "$IGNORED" \
  --argjson seconds "$SECONDS_TOTAL" --argjson build_seconds "$BUILD_SECONDS" \
  --arg units "$(tr '\n' ' ' <"$SHARD_DIR/plan.txt")" \
  --arg failed_units "$FAILED_UNITS" \
  '{shard: $shard, shards: $shards, status: $status, finished_at: $finished_at,
    units_total: $units_total, units_finished: $units_finished,
    tests_passed: $tests_passed, tests_failed: $tests_failed,
    tests_ignored: $tests_ignored, seconds: $seconds, build_seconds: $build_seconds,
    units: ($units | split(" ") | map(select(length > 0))),
    failed_units: ($failed_units | split(" ") | map(select(length > 0)))}' \
  >"$SHARD_DIR/status.json"

rm -f "$RC_FILE"

echo "=============================================================="
echo "shard $SHARD/$SHARDS  $STATUS"
echo "  units      : $FINISHED/$TOTAL"
echo "  tests      : $PASSED passed, $FAILED failed, $IGNORED ignored"
echo "  build time : ${BUILD_SECONDS}s"
echo "  total time : ${SECONDS_TOTAL}s"
[ -z "$FAILED_UNITS" ] || echo "  failed     : $FAILED_UNITS"
echo "=============================================================="

[ "$STATUS" = pass ] || exit 1
