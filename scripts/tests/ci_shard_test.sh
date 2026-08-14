#!/usr/bin/env sh
# Hermetic regressions for the sharded Ubuntu test gate (#874).
#
# These cover the parts that decide whether CI can be trusted: the partition is
# an exact cover of the workspace, the aggregate refuses every way a shard can
# fail to account for its tests, and a runner that dies mid-shard still names
# the unit it was running.  No cargo build and no network -- only
# `cargo metadata`, which the plan script needs anyway.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

PLAN="$ROOT/scripts/ci_shard_plan.sh"
RUN="$ROOT/scripts/ci_run_shard.sh"
AGG="$ROOT/scripts/ci_aggregate_shards.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_ok() {
  desc=$1
  shift
  if ! "$@" >"$TMP/out" 2>&1; then
    echo "--- output ---" >&2
    cat "$TMP/out" >&2
    fail "$desc"
  fi
}

expect_fail() {
  desc=$1
  shift
  if "$@" >"$TMP/out" 2>&1; then
    echo "--- output ---" >&2
    cat "$TMP/out" >&2
    fail "$desc (command unexpectedly succeeded)"
  fi
}

# ---------------------------------------------------------------- plan shape
sh "$PLAN" units >"$TMP/units"
UNIT_COUNT=$(grep -c . "$TMP/units" || true)
[ "$UNIT_COUNT" -gt 0 ] || fail "the workspace enumerated zero test units"

# The plan must be a pure function of the tree: CI, the aggregate, and a
# developer reproducing a shard locally all have to agree on it.
sh "$PLAN" units >"$TMP/units.again"
cmp -s "$TMP/units" "$TMP/units.again" || fail "unit enumeration is not deterministic"

# Every integration test file on disk must be reachable as a unit, so a new
# tests/*.rs cannot land outside the gate.
for file in "$ROOT"/crates/*/tests/*.rs; do
  [ -e "$file" ] || continue
  stem=$(basename "$file" .rs)
  grep -q "/test/$stem\$" "$TMP/units" || fail "$file is in no shard"
done

# Exhaustive and disjoint at several widths, not just the configured one.
for n in 1 2 3 4 7; do
  expect_ok "verify should pass with $n shards" sh "$PLAN" verify --shards "$n"

  : >"$TMP/union"
  i=1
  while [ "$i" -le "$n" ]; do
    sh "$PLAN" shard "$i" --shards "$n" >>"$TMP/union"
    i=$((i + 1))
  done
  LC_ALL=C sort "$TMP/union" >"$TMP/union.sorted"
  LC_ALL=C sort "$TMP/units" >"$TMP/units.sorted"
  cmp -s "$TMP/union.sorted" "$TMP/units.sorted" ||
    fail "shards at width $n are not an exact cover of the workspace"
  [ "$(uniq -d "$TMP/union.sorted" | grep -c . || true)" -eq 0 ] ||
    fail "shards at width $n run some unit twice"
done

# Selector mapping: a wrong flag here would silently run a different target.
[ "$(sh "$PLAN" args cd-core/lib)" = "-p cd-core --lib" ] || fail "lib selector"
[ "$(sh "$PLAN" args cd-core/bins)" = "-p cd-core --bins" ] || fail "bins selector"
[ "$(sh "$PLAN" args cd-core/doc)" = "-p cd-core --doc" ] || fail "doc selector"
[ "$(sh "$PLAN" args cd-core/test/golden_retrieval)" = "-p cd-core --test golden_retrieval" ] ||
  fail "integration test selector"

# Doc tests are part of `cargo test --workspace`; dropping them would quietly
# shrink coverage.
grep -qx "cd-core/doc" "$TMP/units" || fail "doc tests are missing from the plan"
grep -qx "cd-core/lib" "$TMP/units" || fail "lib unit tests are missing from the plan"

# A target kind the plan cannot select -- a bench, or an example with
# `test = true` -- must stop the gate rather than sit outside it. Driven with a
# stub `cargo metadata` because the workspace has no such target today, which
# is exactly why the guard needs a test.
META_STUB="$TMP/meta-stub"
mkdir -p "$META_STUB"
cat >"$META_STUB/cargo" <<'EOF'
#!/usr/bin/env sh
cat <<'JSON'
{"packages":[{"name":"cd-core","manifest_path":"/nonexistent/Cargo.toml","targets":[
  {"kind":["lib"],"name":"cd_core","test":true,"doctest":true},
  {"kind":["bench"],"name":"retrieval_bench","test":true,"doctest":false}]}],
 "workspace_members":[],"version":1}
JSON
EOF
chmod +x "$META_STUB/cargo"
expect_fail "a bench target the plan cannot select must fail verification" \
  env PATH="$META_STUB:$PATH" sh "$PLAN" verify --shards 2
grep -q "belong to no shard unit" "$TMP/out" ||
  fail "verify must explain that a testable target is unmapped"
grep -q "retrieval_bench" "$TMP/out" || fail "verify must name the unmapped target"

expect_fail "shard 0 must be rejected" sh "$PLAN" shard 0 --shards 4
expect_fail "shard above the count must be rejected" sh "$PLAN" shard 5 --shards 4
expect_fail "runner must reject a shard outside the matrix" \
  sh "$RUN" --shard 9 --shards 4 --out "$TMP/never"

# ------------------------------------------------------------- aggregate gate
SHARDS=4

# Build a synthetic artifact tree that mirrors what the shard jobs upload.
make_results() {
  dir=$1
  rm -rf "$dir"
  i=1
  while [ "$i" -le "$SHARDS" ]; do
    sd="$dir/rust-ubuntu-shard-$i/shard-$i"
    mkdir -p "$sd"
    sh "$PLAN" shard "$i" --shards "$SHARDS" >"$sd/plan.txt"
    n=$(grep -c . "$sd/plan.txt" || true)
    jq -n --argjson shard "$i" --argjson shards "$SHARDS" --argjson n "$n" \
      --arg units "$(tr '\n' ' ' <"$sd/plan.txt")" \
      '{shard: $shard, shards: $shards, status: "pass", finished_at: "2026-01-01T00:00:00Z",
        units_total: $n, units_finished: $n, tests_passed: 10, tests_failed: 0,
        tests_ignored: 0, seconds: 60, build_seconds: 30,
        units: ($units | split(" ") | map(select(length > 0))), failed_units: []}' \
      >"$sd/status.json"
    printf '{"event":"finish","phase":"test","unit":"synthetic","status":"pass"}\n' >"$sd/progress.jsonl"
    i=$((i + 1))
  done
}

make_results "$TMP/good"
expect_ok "a complete, passing set of shards must pass" \
  sh "$AGG" --dir "$TMP/good" --shards "$SHARDS"

# A runner that disappears uploads nothing at all.
make_results "$TMP/missing"
rm -rf "$TMP/missing/rust-ubuntu-shard-3"
expect_fail "a missing shard must fail the gate" \
  sh "$AGG" --dir "$TMP/missing" --shards "$SHARDS"
grep -q "shard 3" "$TMP/out" || fail "aggregate must name the missing shard"

# A shard that ran but reported failures.
make_results "$TMP/failed"
jq '.status = "fail" | .failed_units = ["cd-core/test/golden_retrieval"] | .tests_failed = 2' \
  "$TMP/failed/rust-ubuntu-shard-2/shard-2/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/failed/rust-ubuntu-shard-2/shard-2/status.json"
expect_fail "a failed shard must fail the gate" \
  sh "$AGG" --dir "$TMP/failed" --shards "$SHARDS"

# A shard killed part way through still uploads a status file; a truncated run
# is not a pass.
make_results "$TMP/truncated"
jq '.units_finished = (.units_total - 1)' \
  "$TMP/truncated/rust-ubuntu-shard-1/shard-1/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/truncated/rust-ubuntu-shard-1/shard-1/status.json"
expect_fail "a shard that stopped early must fail the gate" \
  sh "$AGG" --dir "$TMP/truncated" --shards "$SHARDS"

# The coverage check is the whole point of sharding: a unit no shard ran must
# not pass even when every shard reports success.
make_results "$TMP/hole"
jq '.units = (.units[1:]) | .units_total = (.units_total - 1) | .units_finished = (.units_finished - 1)' \
  "$TMP/hole/rust-ubuntu-shard-4/shard-4/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/hole/rust-ubuntu-shard-4/shard-4/status.json"
expect_fail "an unrun test unit must fail the gate" \
  sh "$AGG" --dir "$TMP/hole" --shards "$SHARDS"
grep -q "never run" "$TMP/out" || fail "aggregate must report the unrun unit"

# A shard that quietly ran nothing.
make_results "$TMP/empty"
jq '.units = [] | .units_total = 0 | .units_finished = 0 | .tests_passed = 0' \
  "$TMP/empty/rust-ubuntu-shard-1/shard-1/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/empty/rust-ubuntu-shard-1/shard-1/status.json"
expect_fail "a vacuous shard must fail the gate" \
  sh "$AGG" --dir "$TMP/empty" --shards "$SHARDS"

# A matrix that disagrees with CD_SHARD_COUNT must not silently drop a quarter
# of the suite.
expect_fail "fewer shards than expected must fail the gate" \
  sh "$AGG" --dir "$TMP/good" --shards 5
expect_fail "an empty artifact directory must fail the gate" \
  sh "$AGG" --dir "$TMP/does-not-exist" --shards "$SHARDS"

# --------------------------------------------------------- shard runner paths
# Drive ci_run_shard.sh end to end against a stub cargo.  This is the part that
# cannot be inspected by reading the script: POSIX sh has no pipefail, so a test
# binary's exit status has to survive the `tee` that streams its output, or a
# red suite would report a green shard.  `metadata` is delegated to the real
# cargo so the plan stays honest.
STUB="$TMP/stub"
mkdir -p "$STUB"
REAL_CARGO=$(command -v cargo)
cat >"$STUB/cargo" <<EOF
#!/usr/bin/env sh
if [ "\$1" = metadata ]; then exec "$REAL_CARGO" "\$@"; fi
case " \$* " in
  *" --no-run "*)
    echo "   Compiling stub"
    [ -z "\${STUB_CARGO_BUILD_FAIL:-}" ] || { echo "error: could not compile"; exit 101; }
    exit 0
    ;;
esac
if [ -n "\${STUB_CARGO_FAIL:-}" ]; then
  echo "running 4 tests"
  echo "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s"
  exit 101
fi
echo "running 4 tests"
echo "test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s"
exit 0
EOF
chmod +x "$STUB/cargo"

# One unit per shard, so shard 1 is a single deterministic unit.
WIDE=$UNIT_COUNT
FIRST_UNIT=$(sh "$PLAN" shard 1 --shards "$WIDE")

expect_ok "a passing shard must exit 0" \
  env PATH="$STUB:$PATH" sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-pass" --heartbeat 0
PASS_STATUS="$TMP/stub-pass/shard-1/status.json"
[ "$(jq -r '.status' "$PASS_STATUS")" = pass ] || fail "passing shard must record status=pass"
[ "$(jq -r '.tests_passed' "$PASS_STATUS")" = 3 ] || fail "test counts must be parsed from cargo output"
[ "$(jq -r '.tests_ignored' "$PASS_STATUS")" = 1 ] || fail "ignored counts must be parsed"
[ "$(jq -r '.units[0]' "$PASS_STATUS")" = "$FIRST_UNIT" ] || fail "status.json must record the units it ran"
[ -s "$TMP/stub-pass/shard-1/logs/$(printf '%s' "$FIRST_UNIT" | tr '/' '_').log" ] ||
  fail "a per-unit log must be written"

expect_ok "summary mode must render a completed shard" sh "$RUN" --summary "$TMP/stub-pass"
grep -q "result: pass" "$TMP/out" || fail "summary must report a completed shard's result"
grep -q "no unit was left in flight" "$TMP/out" ||
  fail "summary must not invent an in-flight unit for a completed shard"

expect_fail "a failing test binary must fail the shard" \
  env PATH="$STUB:$PATH" STUB_CARGO_FAIL=1 \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-fail" --heartbeat 0
FAIL_STATUS="$TMP/stub-fail/shard-1/status.json"
[ "$(jq -r '.status' "$FAIL_STATUS")" = fail ] || fail "failing shard must record status=fail"
[ "$(jq -r '.tests_failed' "$FAIL_STATUS")" = 1 ] || fail "failing shard must record the failed count"
[ "$(jq -r '.failed_units[0]' "$FAIL_STATUS")" = "$FIRST_UNIT" ] ||
  fail "failing shard must name the failed unit"
[ -s "$TMP/stub-fail/shard-1/logs/$(printf '%s' "$FIRST_UNIT" | tr '/' '_').log" ] ||
  fail "a failing unit must still leave its log behind"

# A shard that cannot even build must fail, and must still leave a result the
# aggregate can read -- otherwise a compile break looks like a lost runner.
expect_fail "a build failure must fail the shard" \
  env PATH="$STUB:$PATH" STUB_CARGO_BUILD_FAIL=1 \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-build-fail" --heartbeat 0
[ "$(jq -r '.status' "$TMP/stub-build-fail/shard-1/status.json")" = fail ] ||
  fail "a build failure must record status=fail"
[ -s "$TMP/stub-build-fail/shard-1/build.log" ] || fail "a build failure must leave build.log"

# ------------------------------------------------------- lost-runner forensics
# No status.json, one unit started and never finished: exactly the shape left
# behind when the hosted runner drops its connection.
LOST="$TMP/lost/rust-ubuntu-shard-2/shard-2"
mkdir -p "$LOST"
{
  printf '{"event":"start","phase":"test","unit":"cd-core/test/golden_retrieval","at":"2026-01-01T00:00:00Z"}\n'
  printf '{"event":"finish","phase":"test","unit":"cd-core/test/golden_retrieval","status":"pass","tests_passed":7,"at":"2026-01-01T00:01:00Z"}\n'
  printf '{"event":"start","phase":"test","unit":"cd-core/test/log_lab","at":"2026-01-01T00:01:00Z"}\n'
} >"$LOST/progress.jsonl"
expect_ok "summary mode must read a partial shard" sh "$RUN" --summary "$TMP/lost"
grep -q "IN FLIGHT WHEN THE LOG ENDS: cd-core/test/log_lab" "$TMP/out" ||
  fail "summary must name the unit that was running when the log ended"
grep -q "cd-core/test/golden_retrieval" "$TMP/out" ||
  fail "summary must name the last completed unit"
grep -q "INCOMPLETE" "$TMP/out" ||
  fail "summary must mark a shard with no status.json as incomplete"

echo "ci_shard_test: OK ($UNIT_COUNT test units, $SHARDS shards)"
