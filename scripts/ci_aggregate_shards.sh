#!/usr/bin/env sh
# Fail-closed aggregate for the sharded Ubuntu workspace test gate (#874).
#
# Sharding is only safe if the sum of the shards is still the whole suite, so
# this gate refuses to pass unless every one of them reported and, together,
# they covered every test unit `cargo test --workspace` would have run.  The
# expected unit list is recomputed here from `cargo metadata` rather than
# trusted from the artifacts: a shard cannot vouch for its own coverage.
#
# Failure modes this rejects, all of which used to look like "green":
#   * a shard whose runner disappeared (no artifact at all)
#   * a shard that reported failures or timed out
#   * a shard that stopped early (units_finished < units_total)
#   * a matrix that no longer covers 1..N, or covers a unit twice
#   * a plan that no longer covers every workspace test target
#
# No network, no secrets.  Requires: cargo, jq.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PLAN="$ROOT/scripts/ci_shard_plan.sh"

DIR=""
SHARDS=${CD_SHARD_COUNT:-4}

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_aggregate_shards.sh --dir DIR [--shards N]

  --dir DIR    directory holding the downloaded shard artifacts; status.json
               files are discovered at any depth below it
  --shards N   number of shards that must be present (default: $CD_SHARD_COUNT, else 4)
EOF
}

die() {
  echo "ci_aggregate_shards: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value"
      DIR=$2
      shift 2
      ;;
    --shards)
      [ $# -ge 2 ] || die "--shards needs a value"
      SHARDS=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[ -n "$DIR" ] || {
  usage >&2
  exit 2
}
case $SHARDS in '' | *[!0-9]*) die "--shards must be a positive integer" ;; esac
[ "$SHARDS" -ge 1 ] || die "--shards must be >= 1"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-aggregate.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
failures=0

fail() {
  echo "::error title=ubuntu test shards::$*"
  echo "error: $*" >&2
  failures=$((failures + 1))
}

# Artifacts land as <dir>/<artifact-name>/shard-<k>/status.json, but the depth
# is not load-bearing: find every result and key it by the shard it claims.
: >"$tmp/index"
if [ -d "$DIR" ]; then
  find "$DIR" -name status.json -type f >"$tmp/status-files"
else
  echo "warning: $DIR does not exist - treating every shard as missing" >&2
  : >"$tmp/status-files"
fi
while read -r file; do
  [ -n "$file" ] || continue
  if ! idx=$(jq -er '.shard' "$file" 2>/dev/null); then
    fail "unreadable shard result $file"
    continue
  fi
  printf '%s\t%s\n' "$idx" "$file" >>"$tmp/index"
done <"$tmp/status-files"

echo "expecting $SHARDS shard result(s) under $DIR"
echo
printf '%-8s %-8s %-14s %-9s %-9s %-9s %-8s %s\n' shard result units passed failed ignored cache seconds
printf '%s\n' "-------------------------------------------------------------------------------------------"

: >"$tmp/units-seen"
total_passed=0
total_failed=0
total_ignored=0

i=1
while [ "$i" -le "$SHARDS" ]; do
  matches=$(awk -F'\t' -v want="$i" '$1 == want { print $2 }' "$tmp/index")
  count=$(printf '%s' "$matches" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    printf '%-8s %-8s %s\n' "$i" MISSING \
      "no artifact - shard job never uploaded a result (lost runner, cancellation, or setup failure)"
    fail "shard $i/$SHARDS produced no result; the suite did not run to completion"
    i=$((i + 1))
    continue
  fi
  if [ "$count" -gt 1 ]; then
    fail "shard $i/$SHARDS reported $count times; artifacts are ambiguous"
    i=$((i + 1))
    continue
  fi

  file=$matches
  status=$(jq -r '.status' "$file")
  ufin=$(jq -r '.units_finished' "$file")
  utot=$(jq -r '.units_total' "$file")
  p=$(jq -r '.tests_passed' "$file")
  f=$(jq -r '.tests_failed' "$file")
  ig=$(jq -r '.tests_ignored' "$file")
  secs=$(jq -r '.seconds' "$file")
  declared=$(jq -r '.shards' "$file")

  cache=$(jq -r '.cache_state // "unknown"' "$file")
  printf '%-8s %-8s %-14s %-9s %-9s %-9s %-8s %s\n' "$i" "$status" "$ufin/$utot" "$p" "$f" "$ig" "$cache" "$secs"

  case $status in
    pass) ;;
    timeout)
      inflight=$(jq -r '.in_flight // empty' "$file")
      reason=$(jq -r '.termination // "step deadline"' "$file")
      fail "shard $i/$SHARDS timed out ($reason)${inflight:+; in flight: $inflight}"
      ;;
    incomplete | running)
      inflight=$(jq -r '.in_flight // empty' "$file")
      fail "shard $i/$SHARDS reported '$status' (cancelled, timed out, or lost runner)${inflight:+; in flight: $inflight}"
      ;;
    *)
      failed_units=$(jq -r '.failed_units | join(", ")' "$file")
      fail "shard $i/$SHARDS reported '$status'${failed_units:+ (failed units: $failed_units)}"
      ;;
  esac
  [ "$ufin" = "$utot" ] ||
    fail "shard $i/$SHARDS stopped after $ufin of $utot units"
  [ "$declared" = "$SHARDS" ] ||
    fail "shard $i ran as 1 of $declared shards but the gate expects $SHARDS; the matrix and CD_SHARD_COUNT disagree"

  jq -r '.units[]' "$file" >>"$tmp/units-seen"
  total_passed=$((total_passed + p))
  total_failed=$((total_failed + f))
  total_ignored=$((total_ignored + ig))
  i=$((i + 1))
done

echo
echo "totals: $total_passed passed, $total_failed failed, $total_ignored ignored"

# Coverage: the union of the shards has to be exactly the workspace test plan.
# Recomputed from cargo metadata so a stale or doctored artifact cannot claim
# coverage it does not have.
sh "$PLAN" units >"$tmp/expected"
LC_ALL=C sort "$tmp/expected" >"$tmp/expected.sorted"
LC_ALL=C sort "$tmp/units-seen" >"$tmp/seen.sorted"

missing=$(LC_ALL=C comm -23 "$tmp/expected.sorted" "$tmp/seen.sorted")
extra=$(LC_ALL=C comm -13 "$tmp/expected.sorted" "$tmp/seen.sorted")
dupes=$(uniq -d "$tmp/seen.sorted")

if [ -n "$missing" ]; then
  fail "$(printf '%s\n' "$missing" | grep -c .) test unit(s) were never run by any shard"
  printf '  never run: %s\n' $missing >&2
fi
if [ -n "$extra" ]; then
  fail "shards reported test unit(s) that are not in the workspace plan"
  printf '  unexpected: %s\n' $extra >&2
fi
if [ -n "$dupes" ]; then
  fail "test unit(s) were claimed by more than one shard"
  printf '  duplicated: %s\n' $dupes >&2
fi

expected_units=$(grep -c . "$tmp/expected" || true)
echo "coverage: $(grep -c . "$tmp/seen.sorted" || true)/$expected_units workspace test units accounted for"

if [ "$total_failed" -gt 0 ]; then
  fail "$total_failed test(s) failed across the shards"
fi
if [ "$failures" -eq 0 ] && [ "$total_passed" -le 0 ]; then
  fail "no tests were executed at all; refusing to report a vacuous pass"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Ubuntu workspace test shards"
    echo
    echo "| shard | result | units | passed | failed | ignored | cache | seconds |"
    echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
    i=1
    while [ "$i" -le "$SHARDS" ]; do
      file=$(awk -F'\t' -v want="$i" '$1 == want { print $2 }' "$tmp/index" | head -n 1)
      if [ -n "$file" ]; then
        jq -r '"| \(.shard) | \(.status) | \(.units_finished)/\(.units_total) | \(.tests_passed) | \(.tests_failed) | \(.tests_ignored) | \(.cache_state // "unknown") | \(.seconds) |"' "$file"
      else
        echo "| $i | **missing** | - | - | - | - | - |"
      fi
      i=$((i + 1))
    done
    echo
    echo "Coverage: $(grep -c . "$tmp/seen.sorted" || true)/$expected_units workspace test units."
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$failures" -ne 0 ]; then
  echo
  echo "ubuntu workspace test gate FAILED ($failures problem(s))" >&2
  exit 1
fi

echo "ubuntu workspace test gate passed: all $SHARDS shards reported, full plan covered"
