#!/usr/bin/env sh
# Hermetic contracts for the portable macOS/Windows shard entry point.
# This exercises the runner with a cargo stub; it never builds the workspace.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
RUNNER="$ROOT/scripts/ci_run_platform_shard.sh"
COMMON="$ROOT/scripts/ci_run_shard.sh"
PLAN="$ROOT/scripts/ci_shard_plan.sh"
AGG="$ROOT/scripts/ci_aggregate_shards.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-platform-shard.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$RUNNER" ] || fail "platform runner is not executable"
if grep -q 'stdbuf' "$RUNNER"; then fail "platform wrapper must not use stdbuf"; fi
if grep -Eq 'tail.*--pid' "$COMMON"; then fail "common runner must not use GNU tail --pid"; fi
if grep -q 'tail -c' "$COMMON"; then fail "common runner must not depend on GNU tail byte offsets"; fi

REAL_CARGO=$(command -v cargo || true)
[ -n "$REAL_CARGO" ] || fail "cargo is required for metadata planning"
UNIT_COUNT=$(sh "$PLAN" units | wc -l | tr -d ' ')
[ "$UNIT_COUNT" -gt 0 ] || fail "shard plan must contain at least one unit"
mkdir -p "$TMP/bin"
apply_stub="$TMP/bin/cargo"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'case " $* " in' \
  '  *" metadata "*) exec "$REAL_CARGO" "$@" ;;' \
  'esac' \
  'if [ "${PLATFORM_STUB_MODE:-pass}" = slow ]; then' \
  '  sleep 120' \
  'fi' \
  'case " $* " in' \
  '  *" --no-run"*) exit 0 ;;' \
  'esac' \
  'echo '\''test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out'\''' \
  >"$apply_stub"
chmod +x "$apply_stub"

# The stub delegates only metadata to the real cargo and makes every selected
# test unit finish immediately. One shard is enough to verify the status
# schema without paying for the entire workspace.
mkdir -p "$TMP/pass"
PATH="$TMP/bin:$PATH" REAL_CARGO="$REAL_CARGO" CD_CACHE_STATE=warm \
  sh "$RUNNER" --os macos --shard 1 --shards "$UNIT_COUNT" --out "$TMP/pass" \
  --heartbeat 0 --unit-timeout 0 >/dev/null

status="$TMP/pass/shard-1/status.json"
[ "$(jq -r .os "$status")" = macos ] || fail "status must record macos"
[ "$(jq -r .status "$status")" = pass ] || fail "stub shard must pass"
[ "$(jq -r .units_finished "$status")" = 1 ] || fail "one-unit shard must finish one unit"
[ "$(jq -r .units_total "$status")" = 1 ] || fail "one-unit shard must report one total"
[ "$(jq -r .tests_passed "$status")" -gt 0 ] || fail "stub shard must record passed tests"

# Verify the platform label is accepted by the same fail-closed aggregate used
# by Ubuntu, without needing to run every real cargo command.
mkdir -p "$TMP/aggregate/shard-1"
all_units=$(sh "$PLAN" units | tr '\n' ' ')
jq -n \
  --arg units "$all_units" \
  --argjson unit_count "$UNIT_COUNT" \
  '{os: "windows", shard: 1, shards: 1, status: "pass", units_total: $unit_count,
    units_finished: $unit_count, tests_passed: 1, tests_failed: 0, tests_ignored: 0,
    seconds: 1, build_seconds: 0, in_flight: null,
    units: ($units | split(" ") | map(select(length > 0))), failed_units: []}' \
  >"$TMP/aggregate/shard-1/status.json"
sh "$AGG" --dir "$TMP/aggregate" --shards 1 \
  --label "windows workspace test shards" >"$TMP/aggregate.out"
grep -q 'windows workspace test shards gate passed' "$TMP/aggregate.out" ||
  fail "aggregate label was not propagated"

# A terminated cargo child must leave a machine-readable incomplete result with
# the unit (or package build) that was active. This is the evidence the
# always-upload step can preserve when a platform step times out.
mkdir -p "$TMP/term"
set +e
PATH="$TMP/bin:$PATH" REAL_CARGO="$REAL_CARGO" PLATFORM_STUB_MODE=slow \
  CD_CACHE_STATE=warm sh "$RUNNER" --os windows --shard 1 --shards "$UNIT_COUNT" \
  --out "$TMP/term" --heartbeat 0 --unit-timeout 0 >"$TMP/term.out" 2>&1 &
pid=$!
set -e
ready=0
i=0
while [ "$i" -lt 30 ]; do
  if [ -f "$TMP/term/shard-1/manifest.json" ]; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || { kill -TERM "$pid" 2>/dev/null || true; fail "slow shard never wrote a manifest"; }
kill -TERM "$pid" 2>/dev/null || true
set +e
wait "$pid"
set -e
term_status="$TMP/term/shard-1/status.json"
[ -f "$term_status" ] || fail "terminated shard must write status.json"
[ "$(jq -r .status "$term_status")" = incomplete ] || fail "terminated shard must be incomplete"
[ "$(jq -r '.in_flight // empty' "$term_status")" != "" ] ||
  fail "terminated shard must record in_flight"

echo "ci_platform_shard_test: OK"
