#!/usr/bin/env sh
# Contract tests for path-aware CI routing. These are deliberately offline:
# routing must be deterministic and must default to the complete gate.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
CLASSIFY="$ROOT/scripts/ci_classify_paths.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-path-filter.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_route() {
  name=$1
  expected_surface=$2
  expected_run=$3
  shift 3
  printf '%s\n' "$@" | sh "$CLASSIFY" >"$TMP/out"
  grep -qx "surface=$expected_surface" "$TMP/out" || fail "$name surface"
  grep -qx "run_ubuntu=$expected_run" "$TMP/out" || fail "$name run_ubuntu"
}

# The bench crate has shipped in-workspace dependents, so a change confined
# to it must take the full gate. See the dependency guard below.
assert_route "bench crate" full true \
  crates/cd-triage-bench/src/lib.rs \
  docs/benchmarks/TRIAGE_BENCH_V1.md
assert_route "bench live bridge" full true crates/cd-triage-bench-live/src/lib.rs
assert_route "bench adapter" full true crates/cd-triage-bench-adapter/src/record.rs
assert_route "bench adapter cli" full true crates/cd-triage-bench-adapter-cli/src/main.rs
assert_route "bench cli command" full true crates/cd-cli/src/commands/bench_compare.rs
assert_route "unrelated cli" full true crates/cd-cli/src/commands/chat.rs
assert_route "collab-only" collab-only false collab/README.md collab/src/index.ts
assert_route "mixed bench and rust" full true \
  crates/cd-triage-bench/src/lib.rs crates/cd-core/src/lib.rs
assert_route "workflow change" full true .github/workflows/ci.yml
assert_route "empty input" full true

python3 - "$ROOT" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError as exc:
    raise SystemExit(f"PyYAML is required for the workflow contract: {exc}")

root = Path(sys.argv[1])
ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())
ci_text = (root / ".github/workflows/ci.yml").read_text()
jobs = ci["jobs"]
path = jobs.get("ci-path-filter")
if not path:
    raise SystemExit("missing ci-path-filter job")
if "run_ubuntu" not in path.get("outputs", {}):
    raise SystemExit("path filter must publish run_ubuntu")

ubuntu = jobs["rust-ubuntu"]
if "ci-path-filter" not in (ubuntu.get("needs") or []):
    raise SystemExit("rust-ubuntu must depend on ci-path-filter")
if ubuntu.get("if") != "needs.ci-path-filter.outputs.run_ubuntu == 'true'":
    raise SystemExit("rust-ubuntu must be skipped only for isolated surfaces")

aggregate = jobs["rust-ubuntu-tests"]
if aggregate["name"] != "rust tests (ubuntu aggregate)":
    raise SystemExit("aggregate check name changed")
if aggregate.get("if") != "always()":
    raise SystemExit("aggregate must always report scoped or full validation")
guard = aggregate["steps"][0]
if guard.get("name") != "require valid CI routing":
    raise SystemExit("aggregate must validate routing before any scoped validation")
guard_script = guard.get("run") or ""

def guard_result(result, surface, run_ubuntu):
    env = os.environ.copy()
    env.update({
        "PATH_FILTER_RESULT": result,
        "SURFACE": surface,
        "RUN_UBUNTU": run_ubuntu,
    })
    return subprocess.run(
        ["sh", "-eu", "-c", guard_script],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

for surface, run_ubuntu in (
    ("full", "true"),
    ("collab-only", "false"),
):
    result = guard_result("success", surface, run_ubuntu)
    if result.returncode != 0:
        raise SystemExit(f"valid route {surface}:{run_ubuntu} was rejected: {result.stdout}")
for result_name, surface, run_ubuntu in (
    ("failure", "", ""),
    ("success", "", ""),
    ("success", "full", "false"),
    ("success", "bench-only", "false"),
    ("success", "bench-only", "true"),
    ("success", "collab-only", "true"),
    ("success", "unknown", "true"),
):
    result = guard_result(result_name, surface, run_ubuntu)
    if result.returncode == 0:
        raise SystemExit(
            f"invalid route {result_name}/{surface}:{run_ubuntu} passed the required aggregate"
        )
aggregate_runs = "\n".join(s.get("run") or "" for s in aggregate["steps"])
if "cargo test -p cd-triage-bench" in aggregate_runs:
    raise SystemExit(
        "the bench crate has shipped in-workspace dependents; it must take the full "
        "gate rather than an isolated lane that never compiles them"
    )

# Dependency guard. An isolated surface is only sound while nothing outside it
# depends on it. This walks the real workspace manifests so re-introducing an
# isolated route for a crate that has grown dependents fails here instead of
# silently shipping a green gate that never built them.
def path_dependents(crate_dir_name):
    dependents = []
    for manifest in sorted((root / "crates").glob("*/Cargo.toml")):
        if manifest.parent.name == crate_dir_name:
            continue
        if f'path = "../{crate_dir_name}"' in manifest.read_text():
            dependents.append(manifest.parent.name)
    return dependents

isolated_surfaces = {
    # surface name -> (classifier path prefix, crate directory it claims to isolate)
    "collab-only": ("collab/", "cd-collab"),
}
classify = root / "scripts/ci_classify_paths.sh"
classifier_text = classify.read_text()
for surface, (_prefix, crate_dir) in isolated_surfaces.items():
    if surface not in classifier_text:
        raise SystemExit(f"isolated surface {surface} disappeared from the classifier")
    dependents = path_dependents(crate_dir)
    if dependents:
        raise SystemExit(
            f"{surface} claims {crate_dir} is isolated but these crates depend on it: "
            + ", ".join(dependents)
        )

bench_dependents = path_dependents("cd-triage-bench")
if not bench_dependents:
    raise SystemExit(
        "cd-triage-bench no longer has in-workspace dependents; revisit whether an "
        "isolated bench route is sound again and update this guard deliberately"
    )
if "bench-only" in classifier_text:
    raise SystemExit(
        "cd-triage-bench has in-workspace dependents ("
        + ", ".join(bench_dependents)
        + ") so it must not have an isolated CI route"
    )

if 'if [ "$EVENT_NAME" = "pull_request" ]; then' not in ci_text:
    raise SystemExit("path-aware filtering must be limited to pull requests")
if "the complete Ubuntu workspace gate" not in ci_text:
    raise SystemExit("workflow must document full main-push coverage")

gui = (root / ".github/workflows/gui-accept.yml").read_text()
if 'cron: "0 6 * * *"' not in gui:
    raise SystemExit("GUI acceptance must be nightly")
print("path-aware workflow contracts ok")
PY

echo "ci_path_filter_test: OK"
