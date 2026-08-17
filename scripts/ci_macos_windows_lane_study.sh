#!/usr/bin/env sh
# Fail-closed inventory and contract for the macOS/Windows rust-lane split.
#
# It enumerates the same workspace test units Ubuntu already shards
# (`scripts/ci_shard_plan.sh`), verifies that 2/3/4-way partitions remain an
# exact cover, and prints the hosted timings behind the staged implementation.
# No cargo build, no network, no secrets. Requires: cargo, jq (via the shard
# planner).
#
# Why this exists: macOS and Windows were previously monolithic
# `cargo test --workspace` lanes. Ubuntu already paid for the planner, runner,
# and aggregate. Copying the 8-way leftover-heavy Ubuntu split onto Windows would
# import #898's timeout class. The first hosted 2-way implementation preserved
# coverage but regressed critical-path time, so this tool now records the
# measured 4-way + cache-probe follow-up without claiming a speedup before it
# has hosted proof.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PLAN="$ROOT/scripts/ci_shard_plan.sh"
EVIDENCE="$ROOT/scripts/fixtures/ci_macos_windows_lane_evidence.json"

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_macos_windows_lane_study.sh            # verify + print contract
  sh scripts/ci_macos_windows_lane_study.sh --json     # machine-readable summary
  sh scripts/ci_macos_windows_lane_study.sh --help

Does not edit .github/workflows/ci.yml. Does not run the test suite.
EOF
}

die() {
  echo "ci_macos_windows_lane_study: $*" >&2
  exit 1
}

[ -x "$PLAN" ] || [ -f "$PLAN" ] || die "missing $PLAN"
[ -f "$EVIDENCE" ] || die "missing $EVIDENCE"

JSON=0
case ${1:-} in
  --help | -h)
    usage
    exit 0
    ;;
  --json)
    JSON=1
    ;;
  "")
    :
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

command -v jq >/dev/null 2>&1 || die "jq is required"

# Bounded metadata only. The planner already fails closed on an empty tree.
sh "$PLAN" verify --shards 2 >/dev/null
sh "$PLAN" verify --shards 3 >/dev/null
sh "$PLAN" verify --shards 4 >/dev/null

UNITS=$(sh "$PLAN" units)
BASE=$(sh "$PLAN" base-units)
UNIT_COUNT=$(printf '%s\n' "$UNITS" | grep -c . || true)
BASE_COUNT=$(printf '%s\n' "$BASE" | grep -c . || true)
[ "$UNIT_COUNT" -gt 0 ] || die "zero shard units"
[ "$BASE_COUNT" -gt 0 ] || die "zero cargo test targets"

count_for() {
  shards=$1
  want=$2
  sh "$PLAN" plan --shards "$shards" | awk -F'\t' -v want="$want" '$1 == want { c++ } END { print c + 0 }'
}

# Hosted timings are pinned in the fixture so a later writer cannot invent
# "cache miss = success" or a made-up speedup.
MAIN_SHA=$(jq -r .main_sha "$EVIDENCE")
WARM_RUN=$(jq -r .warm_run_id "$EVIDENCE")
MACOS_TEST_S=$(jq -r .warm.macos.test_workspace_seconds "$EVIDENCE")
WIN_TEST_S=$(jq -r .warm.windows.test_workspace_seconds "$EVIDENCE")
MACOS_JOB_S=$(jq -r .warm.macos.job_seconds "$EVIDENCE")
WIN_JOB_S=$(jq -r .warm.windows.job_seconds "$EVIDENCE")
UBUNTU_WARMUP_S=$(jq -r .warm.ubuntu.warmup_job_seconds "$EVIDENCE")
UBUNTU_WORST_SHARD_S=$(jq -r .warm.ubuntu.worst_shard_job_seconds "$EVIDENCE")
COLD_DUCKDB_MIN=$(jq -r .cold_ubuntu_duckdb_compile_minutes_min "$EVIDENCE")
COLD_DUCKDB_MAX=$(jq -r .cold_ubuntu_duckdb_compile_minutes_max "$EVIDENCE")
WARM_SHARD_BUILD_S=$(jq -r .warm.ubuntu.example_shard_build_seconds "$EVIDENCE")
WARM_SHARD_TOTAL_S=$(jq -r .warm.ubuntu.example_shard_total_seconds "$EVIDENCE")

RECOMMENDED_SHARDS=$(jq -r .recommended_desktop_shards "$EVIDENCE")
[ "$RECOMMENDED_SHARDS" = "4" ] || die "fixture recommended_desktop_shards must stay 4 for the current follow-up"

if [ "$JSON" -eq 1 ]; then
  jq -n \
    --argjson units "$UNIT_COUNT" \
    --argjson base "$BASE_COUNT" \
    --argjson s2_1 "$(count_for 2 1)" \
    --argjson s2_2 "$(count_for 2 2)" \
    --argjson s3_1 "$(count_for 3 1)" \
    --argjson s3_2 "$(count_for 3 2)" \
    --argjson s3_3 "$(count_for 3 3)" \
    --argjson s4_1 "$(count_for 4 1)" \
    --argjson s4_2 "$(count_for 4 2)" \
    --argjson s4_3 "$(count_for 4 3)" \
    --argjson s4_4 "$(count_for 4 4)" \
    --slurpfile ev "$EVIDENCE" \
    '{
      unit_count: $units,
      cargo_test_targets: $base,
      partitions: {
        "2": [$s2_1, $s2_2],
        "3": [$s3_1, $s3_2, $s3_3],
        "4": [$s4_1, $s4_2, $s4_3, $s4_4]
      },
      evidence: $ev[0]
    }'
  exit 0
fi

cat <<EOF
macOS/Windows rust-lane study + implementation contract

Tree:          $MAIN_SHA (planner input is this checkout)
Units:         $UNIT_COUNT shard units / $BASE_COUNT cargo test targets
Exact cover:   verified at 2, 3, and 4 shards

Candidate partitions (round-robin over the same plan Ubuntu uses):
  2 shards: $(count_for 2 1) + $(count_for 2 2)
  3 shards: $(count_for 3 1) + $(count_for 3 2) + $(count_for 3 3)
  4 shards: $(count_for 4 1) + $(count_for 4 2) + $(count_for 4 3) + $(count_for 4 4)

Hosted evidence (run $WARM_RUN on $MAIN_SHA; rust-cache restore 37–74s ⇒ warm):
  macOS  rust job              ${MACOS_JOB_S}s  (test --workspace ${MACOS_TEST_S}s)
  Windows rust job             ${WIN_JOB_S}s  (test --workspace ${WIN_TEST_S}s)
  Ubuntu warmup job            ${UBUNTU_WARMUP_S}s
  Ubuntu worst shard job       ${UBUNTU_WORST_SHARD_S}s
  Ubuntu warm shard example    build ${WARM_SHARD_BUILD_S}s of total ${WARM_SHARD_TOTAL_S}s
  Cold DuckDB compile (Ubuntu shards, historical)
                               ${COLD_DUCKDB_MIN}–${COLD_DUCKDB_MAX} minutes per job

Recommendation: 4-way partition WITH an exact-key cache probe and conditional per-OS warmup.
The hosted 2-way implementation preserved coverage but was slower end-to-end;
this 4-way design is a candidate until its own hosted run proves a speedup.
Not a preflight-only gate: the complete shard aggregate remains required.
Not an 8-way copy of the Ubuntu leftover-heavy split (#898).

Why not preflight-as-required-gate:
  A second job that still runs cargo test --workspace does not cut wall clock.
  Treating fmt/clippy/subset as the required check would skip tests.

Why not 8 Windows/macOS shards:
  Each cold shard compiles bundled DuckDB unless a warmup job writes a
  shared rust-cache. Ubuntu already proved 36–55 min cold compile per
  shard when that was missed. Leftover-heavy cd-core/lib slices timeout
  when isolated (#898 / #893).

Staged workflow shape (draft follow-up; no merge or ruleset change here):
  1. An exact-key lookup-only probe runs per OS. A cache miss conditionally
     starts one writer with cargo test --workspace --no-run; a hit skips it.
  2. rust (macos-latest) / rust (windows-latest) restore the real cache and run
     fmt, clippy, examples, and smoke as fast preflight signals. They do not
     replace the complete suite.
  3. rust-platform-shard matrix [1, 2, 3, 4] restores with save-if: false,
     never lookup-only, and uses scripts/ci_run_platform_shard.sh.
  4. rust-platform-tests publishes fail-closed aggregates named
     rust tests (macos-latest aggregate) and rust tests (windows-latest aggregate).
     They are coverage signals until the active ruleset is deliberately updated.
  5. Do not skip units. Do not raise timeouts. Do not treat cache miss as success.

See docs/testing/MACOS_WINDOWS_CI_LANES.md
EOF
