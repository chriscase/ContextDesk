#!/usr/bin/env sh
# Hermetic checks for the macOS/Windows lane study. No cargo build.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-lane-study.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

STUDY="$ROOT/scripts/ci_macos_windows_lane_study.sh"
PLAN="$ROOT/scripts/ci_shard_plan.sh"
CONFIG="$ROOT/scripts/ci_shard_config.sh"
EVIDENCE="$ROOT/scripts/fixtures/ci_macos_windows_lane_evidence.json"
WF="$ROOT/.github/workflows/ci.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$STUDY" ] || fail "missing study script"
[ -f "$EVIDENCE" ] || fail "missing evidence fixture"

# The implementation follow-up is deliberately based on this study. Guard the
# four-way probe/warmup/shard/aggregate shape so later workflow edits do not silently
# turn the platform coverage gates back into a monolith.
grep -q 'compile workspace tests (cache warmup)' "$WF" ||
  fail "ci.yml is missing the macOS/Windows cache warmup"
if grep -q 'test workspace (macOS/Windows)' "$WF"; then
  fail "ci.yml still contains the monolithic macOS/Windows test step"
fi
grep -q 'ci_run_platform_shard.sh' "$WF" ||
  fail "ci.yml is missing the portable platform shard runner"
grep -q 'name: rust tests (macos-latest aggregate)' "$WF" ||
  fail "ci.yml is missing the macOS aggregate check name"
grep -q 'name: rust tests (windows-latest aggregate)' "$WF" ||
  fail "ci.yml is missing the Windows aggregate check name"
grep -q 'name: rust (macos-latest)' "$WF" ||
  fail "ci.yml is missing the macOS preflight check name"
grep -q 'name: rust (windows-latest)' "$WF" ||
  fail "ci.yml is missing the Windows preflight check name"
for os in macos windows; do
  [ "$(sh "$CONFIG" count "$os")" = 4 ] ||
    fail "$os canonical shard count is not four"
  grep -q "fromJSON(needs.rust-shard-config.outputs.${os}_matrix)" "$WF" ||
    fail "ci.yml does not consume the canonical $os shard matrix"
done
# Each OS chain must stay independent: macOS jobs must not wait on Windows
# warmup/probe, and Windows must not wait on macOS.
if awk '
  $0 ~ /^  rust-macos(-shard|-tests)?:/ { in_job=1; next }
  in_job && $0 ~ /^  [A-Za-z0-9_-]+:/ { in_job=0 }
  in_job && $0 ~ /rust-windows/ { found=1 }
  END { exit found ? 0 : 1 }
' "$WF"; then
  fail "a macOS job lists a Windows dependency"
fi
if awk '
  $0 ~ /^  rust-windows(-shard|-tests)?:/ { in_job=1; next }
  in_job && $0 ~ /^  [A-Za-z0-9_-]+:/ { in_job=0 }
  in_job && $0 ~ /rust-macos/ { found=1 }
  END { exit found ? 0 : 1 }
' "$WF"; then
  fail "a Windows job lists a macOS dependency"
fi

sh "$PLAN" verify --shards 2 >/dev/null
sh "$PLAN" verify --shards 3 >/dev/null
sh "$PLAN" verify --shards 4 >/dev/null

sh "$STUDY" >"$TMP/text"
sh "$STUDY" --json >"$TMP/json"

grep -q 'Recommendation: 4-way partition WITH an exact-key cache probe and conditional per-OS warmup' "$TMP/text" ||
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
[ "$units" -gt 0 ] || fail "study enumerated zero shard units"
[ "$base" -gt 0 ] || fail "study enumerated zero cargo test targets"
[ "$units" -eq $((base + 1)) ] ||
  fail "lib split should add exactly one shard unit ($base targets -> $units units)"

assert_balanced_partition() {
  shards=$1
  partition=$(jq -c --arg shards "$shards" '.partitions[$shards]' "$TMP/json")
  jq -e --argjson shards "$shards" --argjson units "$units" '
    length == $shards and
    add == $units and
    (max - min) <= 1 and
    all(. > 0)
  ' <<EOF >/dev/null || fail "$shards-way partition drifted: $partition"
$partition
EOF
  printf '%s\n' "$partition"
}

s2=$(assert_balanced_partition 2)
s3=$(assert_balanced_partition 3)
s4=$(assert_balanced_partition 4)

win=$(jq -r .evidence.warm.windows.test_workspace_seconds "$TMP/json")
mac=$(jq -r .evidence.warm.macos.test_workspace_seconds "$TMP/json")
[ "$win" = "2085" ] || fail "pinned Windows test seconds drifted: $win"
[ "$mac" = "1415" ] || fail "pinned macOS test seconds drifted: $mac"
rec=$(jq -r .evidence.recommended_desktop_shards "$TMP/json")
[ "$rec" = "4" ] || fail "recommended shard count drifted: $rec"

# Evidence fixture must not invent a cache-miss success.
jq -e '.notes[] | select(test("cache miss"))' "$EVIDENCE" >/dev/null ||
  fail "fixture lost the cache-miss honesty note"

# 4-way cover is exact and disjoint (already verified, re-check union).
: >"$TMP/union"
i=1
while [ "$i" -le 4 ]; do
  sh "$PLAN" shard "$i" --shards 4 >>"$TMP/union"
  i=$((i + 1))
done
LC_ALL=C sort "$TMP/union" >"$TMP/union.sorted"
sh "$PLAN" units | LC_ALL=C sort >"$TMP/units.sorted"
cmp -s "$TMP/union.sorted" "$TMP/units.sorted" ||
  fail "4-way shards are not an exact cover"

echo "ok: macOS/Windows lane study ($units units, 4-way $s4)"
