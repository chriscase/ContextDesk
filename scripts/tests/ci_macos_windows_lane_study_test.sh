#!/usr/bin/env sh
# Hermetic checks for the macOS/Windows lane study. No cargo build.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-lane-study.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

STUDY="$ROOT/scripts/ci_macos_windows_lane_study.sh"
PLAN="$ROOT/scripts/ci_shard_plan.sh"
EVIDENCE="$ROOT/scripts/fixtures/ci_macos_windows_lane_evidence.json"
WF="$ROOT/.github/workflows/ci.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$STUDY" ] || fail "missing study script"
[ -f "$EVIDENCE" ] || fail "missing evidence fixture"

# The implementation follow-up is deliberately based on this study. Guard the
# two-way warmup/shard/aggregate shape so later workflow edits do not silently
# turn the platform coverage gates back into a monolith.
grep -q 'compile workspace tests (cache warmup)' "$WF" ||
  fail "ci.yml is missing the macOS/Windows cache warmup"
if grep -q 'test workspace (macOS/Windows)' "$WF"; then
  fail "ci.yml still contains the monolithic macOS/Windows test step"
fi
grep -q 'ci_run_platform_shard.sh' "$WF" ||
  fail "ci.yml is missing the portable platform shard runner"
grep -q 'rust tests (\${{ matrix.os }} aggregate)' "$WF" ||
  fail "ci.yml is missing platform aggregate check names"
grep -q 'os: \[macos-latest, windows-latest\]' "$WF" ||
  fail "ci.yml macOS/Windows matrix changed"

sh "$PLAN" verify --shards 2 >/dev/null
sh "$PLAN" verify --shards 3 >/dev/null
sh "$PLAN" verify --shards 4 >/dev/null

sh "$STUDY" >"$TMP/text"
sh "$STUDY" --json >"$TMP/json"

grep -q 'Recommendation: 2-way partition WITH per-OS warmup' "$TMP/text" ||
  fail "study text lost the recommended next patch"
grep -q 'Not a preflight-only gate' "$TMP/text" ||
  fail "study text dropped the anti-skip rule"
grep -q 'Do not skip units' "$TMP/text" ||
  fail "study text dropped the no-skip rule"
grep -q 'Do not treat cache miss as success' "$TMP/text" ||
  fail "study text dropped the honest-cache rule"
grep -q 'Staged workflow shape' "$TMP/text" ||
  fail "study text no longer describes the staged implementation"

units=$(jq -r .unit_count "$TMP/json")
base=$(jq -r .cargo_test_targets "$TMP/json")
[ "$units" -eq 114 ] || fail "expected 114 shard units on this tip, got $units"
[ "$base" -eq 113 ] || fail "expected 113 cargo test targets on this tip, got $base"

s2=$(jq -c .partitions[\"2\"] "$TMP/json")
[ "$s2" = "[57,57]" ] || fail "2-way partition drifted: $s2"
s3=$(jq -c .partitions[\"3\"] "$TMP/json")
[ "$s3" = "[38,38,38]" ] || fail "3-way partition drifted: $s3"

win=$(jq -r .evidence.warm.windows.test_workspace_seconds "$TMP/json")
mac=$(jq -r .evidence.warm.macos.test_workspace_seconds "$TMP/json")
[ "$win" = "2085" ] || fail "pinned Windows test seconds drifted: $win"
[ "$mac" = "1415" ] || fail "pinned macOS test seconds drifted: $mac"
rec=$(jq -r .evidence.recommended_desktop_shards "$TMP/json")
[ "$rec" = "2" ] || fail "recommended shard count drifted: $rec"

# Evidence fixture must not invent a cache-miss success.
jq -e '.notes[] | select(test("cache miss"))' "$EVIDENCE" >/dev/null ||
  fail "fixture lost the cache-miss honesty note"

# 2-way cover is exact and disjoint (already verified, re-check union).
: >"$TMP/union"
i=1
while [ "$i" -le 2 ]; do
  sh "$PLAN" shard "$i" --shards 2 >>"$TMP/union"
  i=$((i + 1))
done
LC_ALL=C sort "$TMP/union" >"$TMP/union.sorted"
sh "$PLAN" units | LC_ALL=C sort >"$TMP/units.sorted"
cmp -s "$TMP/union.sorted" "$TMP/units.sorted" ||
  fail "2-way shards are not an exact cover"

echo "ok: macOS/Windows lane study ($units units, 2-way $s2)"
