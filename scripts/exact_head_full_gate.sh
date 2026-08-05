#!/usr/bin/env bash
# Exact-head FULL acceptance gate (fail-closed).
#
# Separate from the interactive/demo consolidator alone:
#   REHEARSAL_PASS  — scripts/exact_head_cli_acceptance.sh succeeded
#   FULL_GATE_PASS  — this script: unit + cargo labs + consolidator all ok
#
# Stops on the first failure. Never prints FULL_GATE_PASS if any required
# step is missing or non-zero. Preserves exact-head identity via the
# consolidator (and CD_GIT_SHA when building for cargo tests).
#
# Usage (from worktree root):
#   ./scripts/exact_head_full_gate.sh
#   EXACT_HEAD_OUT=…/scratch/cli-accept EXACT_HEAD_KEEP=1 ./scripts/exact_head_full_gate.sh
set -euo pipefail
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export EXACT_HEAD_REPO_ROOT="$ROOT"
# Ensure cargo-built test binaries and consolidator share current SHA when set.
export CD_GIT_SHA="${CD_GIT_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"

OUT_DIR="${EXACT_HEAD_GATE_OUT:-}"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cd-exact-head-full-gate.XXXXXX")"
fi
mkdir -p "$OUT_DIR"
REPORT_JSON="$OUT_DIR/full_gate_results.json"
LOG="$OUT_DIR/full_gate.log"

log() { printf '== %s ==\n' "$*" | tee -a "$LOG" >&2; }
fail() {
  echo "FULL_GATE_BLOCK: $*" | tee -a "$LOG" >&2
  echo "FULL_GATE_BLOCK" | tee -a "$LOG" >&2
  exit 1
}

# Accumulate results for the pure evaluator (and human audit).
RESULTS_PY="$OUT_DIR/results_partial.jsonl"
: >"$RESULTS_PY"

record_step() {
  local step_id="$1" exit_code="$2"
  python3 -c "
import json
print(json.dumps({'step_id': '$step_id', 'exit_code': $exit_code, 'present': True}))
" >>"$RESULTS_PY"
}

run_step() {
  local step_id="$1"
  shift
  log "GATE step: $step_id — $*"
  set +e
  (
    cd "$ROOT"
    "$@"
  ) 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  record_step "$step_id" "$rc"
  if [[ "$rc" -ne 0 ]]; then
    # Finalize partial report then fail closed — never FULL_GATE_PASS.
    python3 - <<PY
import json
from pathlib import Path
import sys
sys.path.insert(0, "$ROOT/scripts/lib")
from exact_head_full_gate import evaluate_full_gate, StepResult, REQUIRED_STEPS
rows=[]
for line in Path("$RESULTS_PY").read_text().splitlines():
    if line.strip():
        rows.append(json.loads(line))
# Mark any required step not yet present as missing.
seen={r["step_id"] for r in rows}
results=[StepResult(step_id=r["step_id"], exit_code=r["exit_code"], present=True) for r in rows]
for sid, _ in REQUIRED_STEPS:
    if sid not in seen:
        results.append(StepResult(step_id=sid, exit_code=1, present=False))
v=evaluate_full_gate(results)
Path("$REPORT_JSON").write_text(json.dumps({
    "full_gate_pass": False,
    "reason": v.reason,
    "first_failure": v.first_failure,
    "steps": [{"step_id": r.step_id, "exit_code": r.exit_code, "present": r.present} for r in results],
    "worktree_sha": """$CD_GIT_SHA""",
}, indent=2) + "\\n")
print(v.reason)
assert not v.full_gate_pass
PY
    fail "step $step_id exited $rc"
  fi
  log "GATE step ok: $step_id"
}

log "exact-head full gate start sha=$CD_GIT_SHA out=$OUT_DIR"
echo "NOTE: REHEARSAL_PASS (consolidator alone) is narrower than FULL_GATE_PASS" | tee -a "$LOG" >&2

run_step identity_unit \
  python3 scripts/tests/exact_head_identity_test.py

run_step cancel_oracle_unit \
  python3 scripts/tests/exact_head_cancel_oracle_test.py

run_step timezone_utc_lab \
  cargo test -p cd-cli --test exact_head_timezone_utc_lab -- --nocapture

run_step chat_cancellation \
  cargo test -p cd-cli --test chat_cancellation -- --nocapture

run_step cli_activity_parity \
  cargo test -p cd-cli --test cli_activity_parity -- --nocapture

run_step cli_public_acceptance_full_path \
  cargo test -p cd-cli --test cli_public_acceptance_lab full_path -- --nocapture

# Consolidator: preserve exact-head identity; keep artifacts if EXACT_HEAD_OUT set.
export EXACT_HEAD_OUT="${EXACT_HEAD_OUT:-$OUT_DIR/cli-accept}"
export EXACT_HEAD_KEEP="${EXACT_HEAD_KEEP:-1}"
mkdir -p "$EXACT_HEAD_OUT"
run_step exact_head_cli_acceptance \
  bash scripts/exact_head_cli_acceptance.sh

# All steps recorded success — pure evaluator must agree (mutation-tested).
python3 - <<PY
import json
from pathlib import Path
import sys
sys.path.insert(0, "$ROOT/scripts/lib")
from exact_head_full_gate import evaluate_full_gate, StepResult, REQUIRED_STEPS, required_step_ids
rows=[]
for line in Path("$RESULTS_PY").read_text().splitlines():
    if line.strip():
        rows.append(json.loads(line))
results=[StepResult(step_id=r["step_id"], exit_code=int(r["exit_code"]), present=True) for r in rows]
# Structural: every required id must appear exactly once in the run log.
got=sorted(r.step_id for r in results)
exp=sorted(required_step_ids())
assert got == exp, (got, exp)
v=evaluate_full_gate(results)
Path("$REPORT_JSON").write_text(json.dumps({
    "full_gate_pass": v.full_gate_pass,
    "reason": v.reason,
    "first_failure": v.first_failure,
    "steps": [{"step_id": r.step_id, "exit_code": r.exit_code, "present": r.present} for r in results],
    "worktree_sha": """$CD_GIT_SHA""",
    "rehearsal_pass_is_narrower": True,
}, indent=2) + "\\n")
if not v.full_gate_pass:
    print(v.reason)
    raise SystemExit(1)
print(v.reason)
print("FULL_GATE_PASS")
PY

log "exact-head full gate complete report=$REPORT_JSON"
