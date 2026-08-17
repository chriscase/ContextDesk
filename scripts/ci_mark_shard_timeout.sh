#!/usr/bin/env sh
# Convert a shard's controlled step deadline into a readable timeout artifact.
#
# The shard runner normally writes status.json when it receives SIGTERM. This
# helper is deliberately defensive: if the process was killed before that
# write completed, it reconstructs a bounded status from plan.txt and
# progress.jsonl rather than allowing the aggregate to report only MISSING.

set -eu

DIR=""
SHARD=""
SHARDS=""
REASON="step-deadline"

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_mark_shard_timeout.sh --dir DIR --shard K --shards N [--reason TEXT]

  --dir DIR       artifact root passed to ci_run_shard.sh
  --shard K       one-based shard index
  --shards N      total shard count
  --reason TEXT   bounded termination reason (default: step-deadline)
EOF
}

die() {
  echo "ci_mark_shard_timeout: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value"
      DIR=$2
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
    --reason)
      [ $# -ge 2 ] || die "--reason needs a value"
      REASON=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[ -n "$DIR" ] || die "--dir is required"
[ -n "$SHARD" ] || die "--shard is required"
[ -n "$SHARDS" ] || die "--shards is required"
[ -d "$DIR" ] || die "artifact directory does not exist: $DIR"

SHARD_DIR="$DIR/shard-$SHARD"
mkdir -p "$SHARD_DIR"
STATUS="$SHARD_DIR/status.json"
PLAN="$SHARD_DIR/plan.txt"
PROGRESS="$SHARD_DIR/progress.jsonl"

if [ -s "$STATUS" ] && jq empty "$STATUS" >/dev/null 2>&1; then
  current=$(jq -r '.status // "unknown"' "$STATUS")
  case $current in
    pass | fail)
      # A test failure is a real result, not a timeout. Never rewrite it.
      exit 0
      ;;
  esac
  jq --arg reason "$REASON" \
    '.status = "timeout" | .termination = $reason' \
    "$STATUS" >"$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
  echo "marked shard $SHARD/$SHARDS as timeout ($REASON); in_flight=$(jq -r '.in_flight // "<none>"' "$STATUS")"
  exit 0
fi

# Reconstruct a readable timeout status if the runner was interrupted while
# creating or replacing status.json. The plan is bounded and the progress
# stream is append-only, so this cannot claim a pass or invent coverage.
units_total=0
if [ -f "$PLAN" ]; then
  units_total=$(wc -l <"$PLAN" | tr -d ' ')
fi

units_finished=0
tests_passed=0
tests_failed=0
tests_ignored=0
in_flight=""
failed_units=""
if [ -s "$PROGRESS" ] && jq -e . "$PROGRESS" >/dev/null 2>&1; then
  units_finished=$(jq -sr '[.[] | select(.event == "finish" and .phase == "test")] | length' "$PROGRESS")
  tests_passed=$(jq -sr '[.[] | select(.event == "finish" and .phase == "test") | .tests_passed // 0] | add // 0' "$PROGRESS")
  tests_failed=$(jq -sr '[.[] | select(.event == "finish" and .phase == "test") | .tests_failed // 0] | add // 0' "$PROGRESS")
  tests_ignored=$(jq -sr '[.[] | select(.event == "finish" and .phase == "test") | .tests_ignored // 0] | add // 0' "$PROGRESS")
  in_flight=$(jq -sr '
    (map(select(.event == "start" and .phase == "test")) | last) as $start
    | (map(select(.event == "finish" and .phase == "test")) | last) as $finish
    | if ($start != null) and (($finish == null) or ($start.unit != $finish.unit))
      then $start.unit else "" end
  ' "$PROGRESS")
  failed_units=$(jq -sr '[.[] | select(.event == "finish" and .phase == "test" and .status != "pass" and .status != "ignored") | .unit] | unique | join(" ")' "$PROGRESS")
fi

units_json='[]'
if [ -f "$PLAN" ]; then
  units_json=$(jq -Rsc 'split("\n") | map(select(length > 0))' "$PLAN")
fi
failed_json=$(printf '%s' "$failed_units" | jq -Rsc 'split(" ") | map(select(length > 0))')

jq -n \
  --argjson shard "$SHARD" --argjson shards "$SHARDS" \
  --arg status timeout --arg termination "$REASON" \
  --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg cache "${CD_CACHE_STATE:-unknown}" \
  --argjson units_total "$units_total" --argjson units_finished "$units_finished" \
  --argjson tests_passed "$tests_passed" --argjson tests_failed "$tests_failed" \
  --argjson tests_ignored "$tests_ignored" --argjson seconds 0 --argjson build_seconds 0 \
  --arg in_flight "$in_flight" --argjson units "$units_json" --argjson failed_units "$failed_json" \
  '{shard: $shard, shards: $shards, status: $status, termination: $termination,
    finished_at: $finished_at, cache_state: $cache,
    units_total: $units_total, units_finished: $units_finished,
    tests_passed: $tests_passed, tests_failed: $tests_failed,
    tests_ignored: $tests_ignored, seconds: $seconds, build_seconds: $build_seconds,
    in_flight: (if $in_flight == "" then null else $in_flight end),
    units: $units, failed_units: $failed_units}' >"$STATUS.tmp"
mv "$STATUS.tmp" "$STATUS"
echo "reconstructed shard $SHARD/$SHARDS timeout artifact ($REASON); in_flight=$(jq -r '.in_flight // "<none>"' "$STATUS")"
