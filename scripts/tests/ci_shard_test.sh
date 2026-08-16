#!/usr/bin/env sh
# Hermetic regressions for the sharded Ubuntu test gate (#874).
#
# These cover the parts that decide whether CI can be trusted: the partition is
# an exact cover of the workspace, lib splits are complementary, the aggregate
# refuses every way a shard can fail to account for its tests, cache recording
# cannot claim warm on a miss, and a cancelled shard still writes status.json.
# No cargo build and no network -- only `cargo metadata`.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

PLAN="$ROOT/scripts/ci_shard_plan.sh"
RUN="$ROOT/scripts/ci_run_shard.sh"
AGG="$ROOT/scripts/ci_aggregate_shards.sh"
CACHE="$ROOT/scripts/ci_record_cache.sh"
WF="$ROOT/.github/workflows/ci.yml"

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
sh "$PLAN" base-units >"$TMP/base"
UNIT_COUNT=$(grep -c . "$TMP/units" || true)
BASE_COUNT=$(grep -c . "$TMP/base" || true)
[ "$UNIT_COUNT" -gt 0 ] || fail "the workspace enumerated zero test units"
[ "$BASE_COUNT" -gt 0 ] || fail "the workspace enumerated zero cargo test targets"

# The plan must be a pure function of the tree.
sh "$PLAN" units >"$TMP/units.again"
cmp -s "$TMP/units" "$TMP/units.again" || fail "unit enumeration is not deterministic"
sh "$PLAN" base-units >"$TMP/base.again"
cmp -s "$TMP/base" "$TMP/base.again" || fail "base-unit enumeration is not deterministic"

# Every integration test file on disk must be reachable as a unit.
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

# Selector mapping.
[ "$(sh "$PLAN" args cd-core/bins)" = "-p cd-core --bins" ] || fail "bins selector"
[ "$(sh "$PLAN" args cd-core/doc)" = "-p cd-core --doc" ] || fail "doc selector"
[ "$(sh "$PLAN" args cd-core/test/golden_retrieval)" = "-p cd-core --test golden_retrieval" ] ||
  fail "integration test selector"

# Doc tests are part of `cargo test --workspace`.
grep -qx "cd-core/doc" "$TMP/units" || fail "doc tests are missing from the plan"

# Lib split: the unsplitted parent must not be a run unit, children must exist,
# and compile-args must strip the filter so `--no-run` stays valid.
# Eight complementary children replace one parent. Hosted run 31931230358:
# isolated cd-core/lib/control on shard 1 produced no result after 57m2s
# (never run: cd-core/lib/control) while platform on shard 2 finished in
# 13m40s. Control is split into control + policy.
grep -qx "cd-core/lib" "$TMP/base" || fail "cd-core/lib must remain a cargo test target"
grep -qx "cd-core/lib" "$TMP/units" && fail "cd-core/lib must not run unsplitted (would pile onto one shard)"
grep -qx "cd-core/lib/log_analysis" "$TMP/units" || fail "cd-core/lib/log_analysis missing"
grep -qx "cd-core/lib/runtime" "$TMP/units" || fail "cd-core/lib/runtime missing"
grep -qx "cd-core/lib/services" "$TMP/units" || fail "cd-core/lib/services missing"
grep -qx "cd-core/lib/platform" "$TMP/units" || fail "cd-core/lib/platform missing"
grep -qx "cd-core/lib/control" "$TMP/units" || fail "cd-core/lib/control missing"
grep -qx "cd-core/lib/policy" "$TMP/units" || fail "cd-core/lib/policy missing"
grep -qx "cd-core/lib/surface" "$TMP/units" || fail "cd-core/lib/surface missing"
grep -qx "cd-core/lib/other" "$TMP/units" || fail "cd-core/lib/other missing"
[ $((BASE_COUNT + 7)) -eq "$UNIT_COUNT" ] ||
  fail "lib split should add seven extra shard units ($BASE_COUNT base -> $UNIT_COUNT units)"

[ "$(sh "$PLAN" args cd-core/lib/log_analysis)" = "-p cd-core --lib -- log_analysis::" ] ||
  fail "log_analysis lib-split selector"
RUNTIME_ARGS=$(sh "$PLAN" args cd-core/lib/runtime)
printf '%s\n' "$RUNTIME_ARGS" | grep -q -- '-- agent::' || fail "runtime selector must match agent::"
printf '%s\n' "$RUNTIME_ARGS" | grep -q -- 'tool_host::' || fail "runtime selector must match tool_host::"
printf '%s\n' "$RUNTIME_ARGS" | grep -q -- '--skip' && fail "runtime selector must be match, not skip"
SERVICES_ARGS=$(sh "$PLAN" args cd-core/lib/services)
printf '%s\n' "$SERVICES_ARGS" | grep -q -- 'incident_evidence::' || fail "services selector must match incident_evidence::"
printf '%s\n' "$SERVICES_ARGS" | grep -q -- 'events::' || fail "services selector must match events:: (substring-safe with normalized_log_events)"
PLATFORM_ARGS=$(sh "$PLAN" args cd-core/lib/platform)
printf '%s\n' "$PLATFORM_ARGS" | grep -q -- 'triage_quality::' || fail "platform selector must match triage_quality::"
printf '%s\n' "$PLATFORM_ARGS" | grep -q -- 'probe::' || fail "platform selector must match probe:: (covers ai_probe)"
CONTROL_ARGS=$(sh "$PLAN" args cd-core/lib/control)
printf '%s\n' "$CONTROL_ARGS" | grep -q -- 'redact::' || fail "control selector must match redact::"
printf '%s\n' "$CONTROL_ARGS" | grep -q -- 'sse::' && fail "control must not still own sse:: (moved to policy)"
POLICY_ARGS=$(sh "$PLAN" args cd-core/lib/policy)
printf '%s\n' "$POLICY_ARGS" | grep -q -- 'sse::' || fail "policy selector must match sse::"
printf '%s\n' "$POLICY_ARGS" | grep -q -- 'git_source::' || fail "policy selector must match git_source::"
SURFACE_ARGS=$(sh "$PLAN" args cd-core/lib/surface)
printf '%s\n' "$SURFACE_ARGS" | grep -q -- 'index::' || fail "surface selector must match index:: (covers vector_index)"
printf '%s\n' "$SURFACE_ARGS" | grep -q -- 'text::' || fail "surface selector must match text:: (covers session_context)"
OTHER_ARGS=$(sh "$PLAN" args cd-core/lib/other)
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip log_analysis::' || fail "other leftover must skip log_analysis::"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip agent::' || fail "other leftover must skip agent::"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip chat::' || fail "other leftover must skip chat::"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip triage_quality::' || fail "other leftover must skip platform filters"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip redact::' || fail "other leftover must skip control filters"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip sse::' || fail "other leftover must skip policy filters"
printf '%s\n' "$OTHER_ARGS" | grep -q -- '--skip index::' || fail "other leftover must skip surface filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/log_analysis)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the log_analysis filter"
[ "$(sh "$PLAN" compile-args cd-core/lib/runtime)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the runtime match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/services)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the services match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/platform)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the platform match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/control)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the control match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/policy)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the policy match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/surface)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the surface match filters"
[ "$(sh "$PLAN" compile-args cd-core/lib/other)" = "-p cd-core --lib" ] ||
  fail "compile-args must strip the --skip filters"
[ "$(sh "$PLAN" compile-args cd-core/test/golden_retrieval)" = "-p cd-core --test golden_retrieval" ] ||
  fail "compile-args for an integration target"

# Weight-aware assignment: leftover-heavy slices must not sit alone
# (run 31931230358: control alone on shard 1, 57m2s, no artifact).
CI_SHARDS=8
sh "$PLAN" plan --shards "$CI_SHARDS" >"$TMP/plan8"
for leftover in cd-core/lib/control cd-core/lib/policy cd-core/lib/platform cd-core/lib/surface cd-core/lib/other; do
  grep -q "^[0-9]	$leftover\$" "$TMP/plan8" || fail "$leftover missing from the 8-shard plan"
done
# Unsplitted control (redact + sse + git_source together) was the 57m bucket.
CONTROL_FILTERS=$(sh "$PLAN" args cd-core/lib/control)
printf '%s\n' "$CONTROL_FILTERS" | grep -q -- 'redact::' || fail "control keeps redact::"
printf '%s\n' "$CONTROL_FILTERS" | grep -q -- 'git_source::' && fail "unsplitted control must not keep git_source::"
other_shard=$(awk -F'\t' '$2 == "cd-core/lib/other" { print $1 }' "$TMP/plan8")
other_companions=$(awk -F'\t' -v s="$other_shard" '$1 == s { c++ } END { print c + 0 }' "$TMP/plan8")
[ "$other_companions" -gt 1 ] || fail "skip leftover cd-core/lib/other must not occupy a shard alone"
sh "$PLAN" plan --shards "$CI_SHARDS" >"$TMP/plan8.again"
cmp -s "$TMP/plan8" "$TMP/plan8.again" || fail "weighted shard plan is not deterministic"

# Complementary filters over a fixture list of rustc test names: no overlap,
# no dropped name. This is the coverage proof that the lib-split children
# equal `cargo test -p cd-core --lib`.
cat >"$TMP/lib-list.txt" <<'EOF'
log_analysis::ingest::parses_line
log_analysis::query::bounded_search
memory::sqlite_store::opens
agent::tool_host::refuses_hard_write
EOF
awk '
  /log_analysis::/ { matchn++; next }
  { skipn++ }
  END { if (matchn != 2 || skipn != 2) exit 1 }
' "$TMP/lib-list.txt" || fail "fixture split counts"
overlap=$(awk '/log_analysis::/ { print }' "$TMP/lib-list.txt" | awk '/log_analysis::/ && 0' )
# Every name is either matched or skipped, never both:
matched=$(grep -c 'log_analysis::' "$TMP/lib-list.txt" || true)
skipped=$(grep -vc 'log_analysis::' "$TMP/lib-list.txt" || true)
[ $((matched + skipped)) -eq 4 ] || fail "lib-split fixture must cover every name"
[ "$(grep -l 'log_analysis::' "$TMP/lib-list.txt" >/dev/null; echo $?)" = 0 ] || true
# Names that match the filter must not also be in the skip set.
both=$(awk '/log_analysis::/ { m[$0]=1 } { if ($0 !~ /log_analysis::/) s[$0]=1 } END { for (k in m) if (s[k]) print k }' "$TMP/lib-list.txt")
[ -z "$both" ] || fail "lib-split filters overlap on $both"

# A target kind the plan cannot select must stop the gate.
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
# Must equal the workflow's CD_SHARD_COUNT: the workflow-contract check below
# compares them and fails closed when they drift.
SHARDS=8

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
        cache_state: "warm",
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

make_results "$TMP/missing"
rm -rf "$TMP/missing/rust-ubuntu-shard-3"
expect_fail "a missing shard must fail the gate" \
  sh "$AGG" --dir "$TMP/missing" --shards "$SHARDS"
grep -q "shard 3" "$TMP/out" || fail "aggregate must name the missing shard"

make_results "$TMP/failed"
jq '.status = "fail" | .failed_units = ["cd-core/test/golden_retrieval"] | .tests_failed = 2' \
  "$TMP/failed/rust-ubuntu-shard-2/shard-2/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/failed/rust-ubuntu-shard-2/shard-2/status.json"
expect_fail "a failed shard must fail the gate" \
  sh "$AGG" --dir "$TMP/failed" --shards "$SHARDS"

make_results "$TMP/truncated"
jq '.units_finished = (.units_total - 1)' \
  "$TMP/truncated/rust-ubuntu-shard-1/shard-1/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/truncated/rust-ubuntu-shard-1/shard-1/status.json"
expect_fail "a shard that stopped early must fail the gate" \
  sh "$AGG" --dir "$TMP/truncated" --shards "$SHARDS"

make_results "$TMP/incomplete"
jq '.status = "incomplete" | .in_flight = "cd-core/lib/log_analysis" | .units_finished = 3' \
  "$TMP/incomplete/rust-ubuntu-shard-1/shard-1/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/incomplete/rust-ubuntu-shard-1/shard-1/status.json"
expect_fail "an incomplete (cancelled/timed-out) shard must fail the gate" \
  sh "$AGG" --dir "$TMP/incomplete" --shards "$SHARDS"
grep -q "incomplete" "$TMP/out" || fail "aggregate must mention incomplete status"

make_results "$TMP/hole"
jq '.units = (.units[1:]) | .units_total = (.units_total - 1) | .units_finished = (.units_finished - 1)' \
  "$TMP/hole/rust-ubuntu-shard-4/shard-4/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/hole/rust-ubuntu-shard-4/shard-4/status.json"
expect_fail "an unrun test unit must fail the gate" \
  sh "$AGG" --dir "$TMP/hole" --shards "$SHARDS"
grep -q "never run" "$TMP/out" || fail "aggregate must report the unrun unit"

make_results "$TMP/empty"
jq '.units = [] | .units_total = 0 | .units_finished = 0 | .tests_passed = 0' \
  "$TMP/empty/rust-ubuntu-shard-1/shard-1/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/empty/rust-ubuntu-shard-1/shard-1/status.json"
expect_fail "a vacuous shard must fail the gate" \
  sh "$AGG" --dir "$TMP/empty" --shards "$SHARDS"

expect_fail "fewer shards than expected must fail the gate" \
  sh "$AGG" --dir "$TMP/good" --shards 5
expect_fail "an empty artifact directory must fail the gate" \
  sh "$AGG" --dir "$TMP/does-not-exist" --shards "$SHARDS"

# Duplicate claim: copy shard 1's units onto shard 2 as well.
make_results "$TMP/dup"
jq --argjson extra "$(jq -c '.units' "$TMP/dup/rust-ubuntu-shard-1/shard-1/status.json")" \
  '.units += $extra' \
  "$TMP/dup/rust-ubuntu-shard-2/shard-2/status.json" >"$TMP/patched.json"
mv "$TMP/patched.json" "$TMP/dup/rust-ubuntu-shard-2/shard-2/status.json"
expect_fail "a unit claimed by two shards must fail the gate" \
  sh "$AGG" --dir "$TMP/dup" --shards "$SHARDS"
grep -q "more than one shard" "$TMP/out" || fail "aggregate must report duplication"

# --------------------------------------------------------- shard runner paths
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
if [ -n "\${STUB_CARGO_SLEEP:-}" ]; then
  echo "running 1 tests"
  sleep "\$STUB_CARGO_SLEEP"
  echo "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s"
  exit 0
fi
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

WIDE=$UNIT_COUNT
FIRST_UNIT=$(sh "$PLAN" shard 1 --shards "$WIDE")

expect_ok "a passing shard must exit 0" \
  env PATH="$STUB:$PATH" CD_CACHE_STATE=warm \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-pass" --heartbeat 0
PASS_STATUS="$TMP/stub-pass/shard-1/status.json"
[ "$(jq -r '.status' "$PASS_STATUS")" = pass ] || fail "passing shard must record status=pass"
[ "$(jq -r '.cache_state' "$PASS_STATUS")" = warm ] || fail "passing shard must record cache_state"
[ "$(jq -r '.tests_passed' "$PASS_STATUS")" = 3 ] || fail "test counts must be parsed from cargo output"
[ "$(jq -r '.tests_ignored' "$PASS_STATUS")" = 1 ] || fail "ignored counts must be parsed"
[ "$(jq -r '.units[0]' "$PASS_STATUS")" = "$FIRST_UNIT" ] || fail "status.json must record the units it ran"
[ -s "$TMP/stub-pass/shard-1/logs/$(printf '%s' "$FIRST_UNIT" | tr '/' '_').log" ] ||
  fail "a per-unit log must be written"
[ -s "$TMP/stub-pass/shard-1/manifest.json" ] || fail "manifest.json must be written"
MANIFEST_BYTES=$(wc -c <"$TMP/stub-pass/shard-1/manifest.json" | tr -d ' ')
[ "$MANIFEST_BYTES" -lt 2048 ] || fail "manifest.json must stay bounded (got ${MANIFEST_BYTES} bytes)"
[ "$(jq -r '.schema' "$TMP/stub-pass/shard-1/manifest.json")" = "cd.ci.shard_manifest.v1" ] ||
  fail "manifest schema"

expect_ok "summary mode must render a completed shard" sh "$RUN" --summary "$TMP/stub-pass"
grep -q "result: pass" "$TMP/out" || fail "summary must report a completed shard's result"
grep -q "no unit was left in flight" "$TMP/out" ||
  fail "summary must not invent an in-flight unit for a completed shard"

expect_fail "a failing test binary must fail the shard" \
  env PATH="$STUB:$PATH" STUB_CARGO_FAIL=1 CD_CACHE_STATE=cold \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-fail" --heartbeat 0
FAIL_STATUS="$TMP/stub-fail/shard-1/status.json"
[ "$(jq -r '.status' "$FAIL_STATUS")" = fail ] || fail "failing shard must record status=fail"
[ "$(jq -r '.cache_state' "$FAIL_STATUS")" = cold ] || fail "failing shard must keep honest cache_state"
[ "$(jq -r '.tests_failed' "$FAIL_STATUS")" = 1 ] || fail "failing shard must record the failed count"
[ "$(jq -r '.failed_units[0]' "$FAIL_STATUS")" = "$FIRST_UNIT" ] ||
  fail "failing shard must name the failed unit"

expect_fail "a build failure must fail the shard" \
  env PATH="$STUB:$PATH" STUB_CARGO_BUILD_FAIL=1 \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-build-fail" --heartbeat 0
[ "$(jq -r '.status' "$TMP/stub-build-fail/shard-1/status.json")" = fail ] ||
  fail "a build failure must record status=fail"
[ -s "$TMP/stub-build-fail/shard-1/build.log" ] || fail "a build failure must leave build.log"

# Snapshot hook is invoked with the shard directory as $1.
HOOK_OUT="$TMP/hook-manifest.json"
expect_ok "snapshot hook must run" \
  env PATH="$STUB:$PATH" HOOK_OUT="$HOOK_OUT" \
  CD_SHARD_SNAPSHOT_HOOK='cp "$1/manifest.json" "$HOOK_OUT"' \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-hook" --heartbeat 0
[ -s "$HOOK_OUT" ] || fail "snapshot hook must copy the manifest"
jq -e '.schema == "cd.ci.shard_manifest.v1"' "$HOOK_OUT" >/dev/null ||
  fail "hooked manifest must be valid"

# SIGTERM (step timeout / cancellation) must write incomplete status.json
# quickly — not after the in-flight cargo process finishes.
env PATH="$STUB:$PATH" STUB_CARGO_SLEEP=30 CD_CACHE_STATE=warm \
  sh "$RUN" --shard 1 --shards "$WIDE" --out "$TMP/stub-term" --heartbeat 0 --unit-timeout 0 \
  >"$TMP/stub-term.out" 2>&1 &
TERM_PID=$!
i=0
while [ "$i" -lt 80 ]; do
  if grep -q '"phase":"test"' "$TMP/stub-term/shard-1/progress.jsonl" 2>/dev/null; then
    break
  fi
  sleep 0.1
  i=$((i + 1))
done
grep -q '"phase":"test"' "$TMP/stub-term/shard-1/progress.jsonl" 2>/dev/null ||
  fail "SIGTERM fixture never started its test unit"
TERM_START=$(date +%s)
kill -TERM "$TERM_PID" 2>/dev/null || true
wait "$TERM_PID" || true
TERM_ELAPSED=$(($(date +%s) - TERM_START))
[ "$TERM_ELAPSED" -lt 8 ] || fail "SIGTERM took ${TERM_ELAPSED}s; cargo was not interrupted"
[ -f "$TMP/stub-term/shard-1/status.json" ] || fail "SIGTERM must still leave status.json"
TERM_STATUS=$(jq -r '.status' "$TMP/stub-term/shard-1/status.json")
[ "$TERM_STATUS" = incomplete ] ||
  fail "SIGTERM shard status must be incomplete, got $TERM_STATUS"
expect_fail "aggregate must refuse a SIGTERM shard" \
  sh "$AGG" --dir "$TMP/stub-term" --shards 1

# ------------------------------------------------------- lost-runner forensics
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

# ------------------------------------------------------------- cache honesty
expect_ok "exact hit is warm" sh "$CACHE" --out "$TMP/cache-warm.json" --hit true --role warmup
[ "$(jq -r '.cache_state' "$TMP/cache-warm.json")" = warm ] || fail "true hit must be warm"
[ "$(jq -r '.cache_hit' "$TMP/cache-warm.json")" = true ] || fail "true hit must set cache_hit"
[ "$(jq -r '.save' "$TMP/cache-warm.json")" = true ] || fail "warmup defaults to save=true"
[ "$(jq -r '.shared_key' "$TMP/cache-warm.json")" = ubuntu-workspace-tests-v2 ] || fail "shared key"

expect_ok "miss is cold" sh "$CACHE" --out "$TMP/cache-cold.json" --hit false --role shard --shard 1 --save false
[ "$(jq -r '.cache_state' "$TMP/cache-cold.json")" = cold ] || fail "false hit must be cold"
[ "$(jq -r '.cache_hit' "$TMP/cache-cold.json")" = false ] || fail "false hit must not claim cache_hit"
[ "$(jq -r '.save' "$TMP/cache-cold.json")" = false ] || fail "shard save=false"

expect_ok "empty hit is cold, never warm" sh "$CACHE" --out "$TMP/cache-empty.json" --hit "" --role shard --save false
[ "$(jq -r '.cache_state' "$TMP/cache-empty.json")" = cold ] || fail "empty hit must be cold"

expect_ok "garbage hit is cold" sh "$CACHE" --out "$TMP/cache-junk.json" --hit maybe --role warmup
[ "$(jq -r '.cache_state' "$TMP/cache-junk.json")" = cold ] || fail "non-true hit must not claim warm"

# Hosted run 31845262696: lookup-only reported cache-hit without files.
mkdir -p "$TMP/empty-target"
expect_ok "hit without restored files is cold" \
  sh "$CACHE" --out "$TMP/cache-hit-nofiles.json" --hit true --role shard --save false \
  --restore-dir "$TMP/empty-target"
[ "$(jq -r '.cache_hit' "$TMP/cache-hit-nofiles.json")" = true ] || fail "must still record the action hit"
[ "$(jq -r '.cache_state' "$TMP/cache-hit-nofiles.json")" = cold ] ||
  fail "key hit without files must not claim warm"
[ "$(jq -r '.restore' "$TMP/cache-hit-nofiles.json")" = "key-hit-without-files" ] ||
  fail "must name the lookup-only miss"

mkdir -p "$TMP/full-target/debug"
echo stub >"$TMP/full-target/debug/foo"
expect_ok "hit with restored files is warm" \
  sh "$CACHE" --out "$TMP/cache-hit-files.json" --hit true --role shard --save false \
  --restore-dir "$TMP/full-target"
[ "$(jq -r '.cache_state' "$TMP/cache-hit-files.json")" = warm ] || fail "hit+files must be warm"
[ "$(jq -r '.restore' "$TMP/cache-hit-files.json")" = files ] || fail "restore=files"

# ------------------------------------------------------- workflow contracts
python3 - "$WF" "$SHARDS" <<'PY' || fail "workflow contract python failed"
import sys, yaml

path, expected_shards = sys.argv[1], int(sys.argv[2])
wf = yaml.safe_load(open(path))
count = int(wf["env"]["CD_SHARD_COUNT"])
if count != expected_shards:
    raise SystemExit(f"CD_SHARD_COUNT={count} != test SHARDS={expected_shards}")

jobs = wf["jobs"]
required = [
    "secrets",
    "claims",
    "close-proof",
    "gui-accept-contracts",
    "rust",
    "rust-ubuntu",
    "rust-ubuntu-shard",
    "rust-ubuntu-tests",
    "tauri-host",
    "desktop",
]
for name in required:
    if name not in jobs:
        raise SystemExit(f"missing job {name}")

if jobs["secrets"]["name"] != "gitleaks":
    raise SystemExit("gitleaks job renamed")
if jobs["gui-accept-contracts"]["name"] != "GUI integration contracts (no WebDriver)":
    raise SystemExit("GUI contract job renamed")

rust_os = jobs["rust"]["strategy"]["matrix"]["os"]
if rust_os != ["macos-latest", "windows-latest"]:
    raise SystemExit(f"rust matrix should be macOS/Windows only, got {rust_os}")
if jobs["rust-ubuntu"]["name"] != "rust (ubuntu-latest)":
    raise SystemExit("ubuntu rust check name must stay rust (ubuntu-latest)")
if jobs["rust-ubuntu-tests"]["name"] != "rust tests (ubuntu aggregate)":
    raise SystemExit("aggregate check name changed")
if jobs["rust-ubuntu-tests"].get("if") != "always()":
    raise SystemExit("aggregate must run if: always()")

shard_ids = jobs["rust-ubuntu-shard"]["strategy"]["matrix"]["shard"]
if shard_ids != list(range(1, count + 1)):
    raise SystemExit(f"matrix shards {shard_ids} != 1..{count}")

def steps(job):
    return job["steps"]

def cache_step(job):
    for step in steps(job):
        uses = step.get("uses") or ""
        if uses.startswith("Swatinem/rust-cache@"):
            return step
    raise SystemExit("missing rust-cache step")

wu = cache_step(jobs["rust-ubuntu"])["with"]
if wu.get("shared-key") != "ubuntu-workspace-tests-v2":
    raise SystemExit(f"warmup shared-key {wu.get('shared-key')}")
if wu.get("lookup-only") in (True, "true"):
    raise SystemExit("warmup must save, not lookup-only")
save_if = wu.get("save-if")
if save_if in (False, "false"):
    raise SystemExit("warmup must be allowed to save on main")
if save_if not in (True, "true", None) and "refs/heads/main" not in str(save_if):
    raise SystemExit(f"warmup save-if should be main-only, got {save_if!r}")

sh = cache_step(jobs["rust-ubuntu-shard"])["with"]
if sh.get("shared-key") != "ubuntu-workspace-tests-v2":
    raise SystemExit("shard shared-key mismatch")
if sh.get("lookup-only") in (True, "true"):
    raise SystemExit("shards must not use lookup-only (that skips the download)")
if sh.get("save-if") not in (False, "false"):
    raise SystemExit("shards must not save the shared cache")

# macOS/Windows + tauri writers also save only on main (PR cache duplication).
rust_save = cache_step(jobs["rust"])["with"].get("save-if")
if rust_save is None or "refs/heads/main" not in str(rust_save):
    raise SystemExit(f"mac/win rust-cache save-if should be main-only, got {rust_save!r}")
tauri_save = cache_step(jobs["tauri-host"])["with"].get("save-if")
if tauri_save is None or "refs/heads/main" not in str(tauri_save):
    raise SystemExit(f"tauri rust-cache save-if should be main-only, got {tauri_save!r}")

uploads = [s for s in steps(jobs["rust-ubuntu-shard"]) if (s.get("uses") or "").startswith("actions/upload-artifact@")]
if len(uploads) != 1:
    raise SystemExit(f"expected one shard upload-artifact, got {len(uploads)}")
up = uploads[0]
if up.get("if") != "always()":
    raise SystemExit("shard upload must be if: always()")
if up["with"].get("name") != "rust-ubuntu-shard-${{ matrix.shard }}":
    raise SystemExit(f"artifact name {up['with'].get('name')}")
if int(up["with"]["retention-days"]) != 14:
    raise SystemExit(f"retention-days {up['with'].get('retention-days')}")
if up["with"].get("path") != "ci-shards/":
    raise SystemExit("artifact path must be ci-shards/")

cache_uploads = [s for s in steps(jobs["rust-ubuntu"]) if (s.get("uses") or "").startswith("actions/upload-artifact@")]
if not cache_uploads:
    raise SystemExit("warmup must upload cache-status")
cu = cache_uploads[0]
if cu.get("if") != "always()":
    raise SystemExit("cache-status upload must be if: always()")
if cu["with"].get("name") != "rust-ubuntu-cache-status":
    raise SystemExit("cache-status artifact name")
if int(cu["with"]["retention-days"]) != 14:
    raise SystemExit("cache-status retention")

# Ubuntu rust job warms with shard-shaped -p --no-run (not --workspace).
ubuntu_runs = "\n".join(s.get("run") or "" for s in steps(jobs["rust-ubuntu"]))
if "ci_warm_test_artifacts.sh" not in ubuntu_runs:
    raise SystemExit("ubuntu rust job must warm via scripts/ci_warm_test_artifacts.sh")
if "cargo test --workspace --no-run" in ubuntu_runs:
    raise SystemExit("ubuntu rust job must not warm with cargo test --workspace --no-run")
# A bare `cargo test --workspace` (no --no-run) would reintroduce the monolith.
for block in ubuntu_runs.splitlines():
    stripped = block.strip()
    if stripped == "cargo test --workspace":
        raise SystemExit("ubuntu rust job must not run cargo test --workspace")

macwin_runs = "\n".join(s.get("run") or "" for s in steps(jobs["rust"]))
if "cargo test --workspace" not in macwin_runs:
    raise SystemExit("macOS/Windows must still run cargo test --workspace")

tauri_os = jobs["tauri-host"]["strategy"]["matrix"]["os"]
if tauri_os != ["ubuntu-latest", "macos-latest"]:
    raise SystemExit(f"tauri-host matrix changed: {tauri_os}")

run_steps = [s for s in steps(jobs["rust-ubuntu-shard"]) if (s.get("name") or "").startswith("run shard")]
if not run_steps:
    raise SystemExit("missing run shard step")
if int(run_steps[0].get("timeout-minutes") or 0) < 1:
    raise SystemExit("run shard step must have a timeout so SIGTERM can write artifacts")

print("workflow contracts ok")
PY

echo "ci_shard_test: OK ($BASE_COUNT cargo targets, $UNIT_COUNT shard units, $SHARDS shards)"
