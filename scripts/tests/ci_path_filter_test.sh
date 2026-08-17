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

assert_route "bench-only" bench-only false \
  crates/cd-triage-bench/src/lib.rs \
  docs/benchmarks/TRIAGE_BENCH_V1.md
assert_route "collab-only" collab-only false collab/README.md collab/src/index.ts
assert_route "mixed bench and rust" full true \
  crates/cd-triage-bench/src/lib.rs crates/cd-core/src/lib.rs
assert_route "workflow change" full true .github/workflows/ci.yml
assert_route "empty input" full true

python3 - "$ROOT" <<'PY'
import sys
from pathlib import Path

try:
    import yaml
except ImportError as exc:
    raise SystemExit(f"PyYAML is required for the workflow contract: {exc}")

root = Path(sys.argv[1])
ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())
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
aggregate_runs = "\n".join(s.get("run") or "" for s in aggregate["steps"])
if "cargo test -p cd-triage-bench --all-targets" not in aggregate_runs:
    raise SystemExit("bench-only route must run complete bench validation")

gui = (root / ".github/workflows/gui-accept.yml").read_text()
if 'cron: "0 6 * * *"' not in gui:
    raise SystemExit("GUI acceptance must be nightly")
print("path-aware workflow contracts ok")
PY

echo "ci_path_filter_test: OK"
