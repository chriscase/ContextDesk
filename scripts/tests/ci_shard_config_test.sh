#!/usr/bin/env sh
# Static contract for the canonical cross-OS shard topology. No cargo/build.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
CONFIG="$ROOT/scripts/ci_shard_config.sh"
PLAN="$ROOT/scripts/ci_shard_plan.sh"
AGGREGATE="$ROOT/scripts/ci_aggregate_shards.sh"
RUN="$ROOT/scripts/ci_run_shard.sh"
PLATFORM_RUN="$ROOT/scripts/ci_run_platform_shard.sh"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-config.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_fail() {
  if "$@" >"$TMP/out" 2>&1; then
    cat "$TMP/out" >&2
    fail "command unexpectedly succeeded: $*"
  fi
}

[ "$(sh "$CONFIG" list)" = "$(printf '%s\n' 'ubuntu 8' 'macos 4' 'windows 4')" ] ||
  fail "canonical topology changed unexpectedly"
[ "$(sh "$CONFIG" count ubuntu)" = 8 ] || fail "Ubuntu count"
[ "$(sh "$CONFIG" count macos)" = 4 ] || fail "macOS count"
[ "$(sh "$CONFIG" count windows)" = 4 ] || fail "Windows count"
[ "$(sh "$CONFIG" matrix ubuntu)" = '[1,2,3,4,5,6,7,8]' ] || fail "Ubuntu matrix"
[ "$(sh "$CONFIG" matrix macos)" = '[1,2,3,4]' ] || fail "macOS matrix"
[ "$(sh "$CONFIG" matrix windows)" = '[1,2,3,4]' ] || fail "Windows matrix"

sh "$CONFIG" verify ubuntu 8 >/dev/null
sh "$CONFIG" verify macos 4 >/dev/null
sh "$CONFIG" verify windows 4 >/dev/null
expect_fail sh "$CONFIG" verify ubuntu 4
expect_fail sh "$CONFIG" verify macos 8
expect_fail sh "$CONFIG" verify windows 0
expect_fail sh "$CONFIG" count linux

# These mismatches must stop before cargo metadata or artifact inspection.
expect_fail sh "$PLAN" verify --os ubuntu --shards 4
grep -q "disagrees with canonical count" "$TMP/out" ||
  fail "planner mismatch did not name canonical topology"
expect_fail sh "$AGGREGATE" --dir "$TMP/no-artifacts" --os macos --shards 8
grep -q "does not match the canonical topology" "$TMP/out" ||
  fail "aggregate mismatch did not name canonical topology"
expect_fail sh "$RUN" --shard 9 --out "$TMP/never"
grep -q "outside 1..8" "$TMP/out" || fail "common runner did not default to canonical Ubuntu capacity"
expect_fail sh "$PLATFORM_RUN" --os macos --shard 5 --out "$TMP/never"
grep -q "outside 1..4" "$TMP/out" || fail "platform runner did not default to canonical macOS capacity"

sh "$CONFIG" github-output >"$TMP/github-output"
for expected in \
  'ubuntu_count=8' 'ubuntu_matrix=[1,2,3,4,5,6,7,8]' \
  'macos_count=4' 'macos_matrix=[1,2,3,4]' \
  'windows_count=4' 'windows_matrix=[1,2,3,4]'; do
  grep -qxF "$expected" "$TMP/github-output" || fail "missing GitHub output $expected"
done
[ "$(wc -l <"$TMP/github-output" | tr -d ' ')" -eq 6 ] ||
  fail "GitHub output must contain exactly six topology values"

python3 - "$WORKFLOW" <<'PY' || fail "workflow topology contract"
import re
import sys
import yaml

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)

if "CD_SHARD_COUNT" in workflow.get("env", {}):
    raise SystemExit("workflow env must not duplicate the canonical shard count")

jobs = workflow["jobs"]
config = jobs.get("rust-shard-config")
if not config or config.get("name") != "Rust shard topology":
    raise SystemExit("canonical shard topology job is missing or renamed")

outputs = config.get("outputs", {})
for os_name in ("ubuntu", "macos", "windows"):
    for suffix in ("count", "matrix"):
        key = f"{os_name}_{suffix}"
        expected = f"${{{{ steps.topology.outputs.{key} }}}}"
        if outputs.get(key) != expected:
            raise SystemExit(f"topology output {key} drifted: {outputs.get(key)!r}")

publish = next((step for step in config["steps"] if step.get("id") == "topology"), None)
if not publish or "ci_shard_config.sh github-output" not in (publish.get("run") or ""):
    raise SystemExit("topology job must publish the canonical script output")

contracts = {
    "ubuntu": ("rust-ubuntu-shard", "rust-ubuntu-tests"),
    "macos": ("rust-macos-shard", "rust-macos-tests"),
    "windows": ("rust-windows-shard", "rust-windows-tests"),
}

def needs(job):
    value = job.get("needs", [])
    return [value] if isinstance(value, str) else list(value)

def runs(job):
    return "\n".join(step.get("run") or "" for step in job.get("steps", []))

for os_name, (shard_name, aggregate_name) in contracts.items():
    shard = jobs[shard_name]
    aggregate = jobs[aggregate_name]
    count_expr = f"${{{{ needs.rust-shard-config.outputs.{os_name}_count }}}}"
    matrix_expr = f"${{{{ fromJSON(needs.rust-shard-config.outputs.{os_name}_matrix) }}}}"

    if "rust-shard-config" not in needs(shard):
        raise SystemExit(f"{shard_name} does not depend on canonical topology")
    if "rust-shard-config" not in needs(aggregate):
        raise SystemExit(f"{aggregate_name} does not depend on canonical topology")
    if "needs.rust-shard-config.result == 'success'" not in (shard.get("if") or ""):
        raise SystemExit(f"{shard_name} does not fail closed when topology validation fails")
    if shard.get("env", {}).get("CD_SHARD_COUNT") != count_expr:
        raise SystemExit(f"{shard_name} count is not sourced from topology")
    if aggregate.get("env", {}).get("CD_SHARD_COUNT") != count_expr:
        raise SystemExit(f"{aggregate_name} count is not sourced from topology")
    if shard["strategy"]["matrix"]["shard"] != matrix_expr:
        raise SystemExit(f"{shard_name} matrix is not sourced from topology")

    shard_runs = runs(shard)
    aggregate_runs = runs(aggregate)
    if '"$SHARD_CONFIG_RESULT" != success' not in aggregate_runs:
        raise SystemExit(f"{aggregate_name} does not fail closed when topology validation fails")
    if f"ci_shard_plan.sh verify --os {os_name} --shards \"$CD_SHARD_COUNT\"" not in shard_runs:
        raise SystemExit(f"{shard_name} does not fail closed in the planner")
    if f"ci_aggregate_shards.sh" not in aggregate_runs or f"--os {os_name}" not in aggregate_runs:
        raise SystemExit(f"{aggregate_name} does not fail closed in the aggregate")
    if '--shards "$CD_SHARD_COUNT"' not in aggregate_runs:
        raise SystemExit(f"{aggregate_name} does not consume the canonical count")

    combined = shard_runs + "\n" + aggregate_runs
    if re.search(r"--shards\s+(?:4|8)(?:\s|\\|$)", combined):
        raise SystemExit(f"{os_name} workflow still contains a literal capacity")

expected_names = {
    "rust-ubuntu-shard": "rust tests (ubuntu shard ${{ matrix.shard }})",
    "rust-ubuntu-tests": "rust tests (ubuntu aggregate)",
    "rust-macos-shard": "rust tests (macos-latest shard ${{ matrix.shard }})",
    "rust-macos-tests": "rust tests (macos-latest aggregate)",
    "rust-windows-shard": "rust tests (windows-latest shard ${{ matrix.shard }})",
    "rust-windows-tests": "rust tests (windows-latest aggregate)",
}
for job_name, expected in expected_names.items():
    if jobs[job_name].get("name") != expected:
        raise SystemExit(f"required check name changed for {job_name}")

print("workflow topology contracts ok")
PY

echo "ci_shard_config_test: OK"
