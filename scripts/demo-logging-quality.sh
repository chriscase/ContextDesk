#!/usr/bin/env bash
# Repeatable offline demo: import → logging-assessment → evidence → Markdown projection.
# Synthetic fixtures only. Zero provider / keychain.
# JSON is the source of truth; Markdown is a pure projection of fixed finding hints.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export CXX="${CXX:-g++}"
export CC="${CC:-gcc}"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER:-g++}"

OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/cd-logging-quality-demo.XXXXXX")}"
DATA="$OUT/data"
PLAN="$OUT/plan.md"
FIX="$ROOT/fixtures/log-lab/scenarios/mixed-time-quality/import"
rm -rf "$DATA" "$PLAN"
mkdir -p "$DATA"

echo "== building CLI =="
cargo build -p cd-cli
BIN="$CARGO_TARGET_DIR/debug/contextdesk"

echo "== import =="
"$BIN" --data-dir "$DATA" import "$FIX"
ID="$("$BIN" --data-dir "$DATA" --json corpus list | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["corpora"][0]["id"])')"
echo "corpus_id=$ID"

echo "== assessment (human) =="
"$BIN" --data-dir "$DATA" logging-assessment "$ID"

echo "== assessment (json) =="
"$BIN" --data-dir "$DATA" --json logging-assessment "$ID" >"$OUT/assessment.json"
python3 - <<PY
import json
from pathlib import Path
env=json.loads(Path("$OUT/assessment.json").read_text())
a=env["data"]["assessment"]
assert a["schemaId"]=="contextdesk.logging_quality_assessment.v1"
assert a["schemaVersion"]==1
assert a["limitations"], "limitations must be non-empty"
assert a["metrics"]["storedLevel"]["severityProvenanceAvailable"] is False
body=json.dumps(a).lower()
assert "messagenewline" not in body
assert "multilineheuristic" not in body
assert "is confirmed noise" not in body
assert "engineering improvement plan" not in body
raw=Path("$OUT/assessment.json").read_text().lower()
for bad in ("/users/", "/home/", "api_key", "password=", "bearer "):
    assert bad not in raw, bad
print("grade", a["summary"]["grade"], "score", a["summary"]["overallScore"])
print("findings", len(a["findings"]))
for f in a["findings"][:3]:
    print(" ", f["id"], "→", f["improvementHint"]["templateId"])
PY

echo "== export markdown projection =="
"$BIN" --data-dir "$DATA" logging-assessment "$ID" \
  --report-format markdown --output "$PLAN"
grep -q "JSON is the source of truth" "$PLAN"
grep -q "Measured fact" "$PLAN"
! grep -qi "Engineering Improvement Plan" "$PLAN"

echo
echo "DEMO_OK out=$OUT plan=$PLAN"
