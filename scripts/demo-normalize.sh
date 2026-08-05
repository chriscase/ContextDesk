#!/usr/bin/env bash
# Repeatable offline demo for `contextdesk normalize` (synthetic data only).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"

OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/cd-normalize-demo.XXXXXX")}"
FIXTURE="$OUT/fixture"
DEST="$OUT/normalized"
rm -rf "$FIXTURE" "$DEST"
mkdir -p "$FIXTURE/api" "$FIXTURE/worker"

cat >"$FIXTURE/api/app.jsonl" <<'EOF'
{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"checkout started"}
{"ts":"2026-01-01T12:00:01Z","level":"ERROR","msg":"payment failed token=ghp_example_invalid_secret_marker_1234567890"}
EOF
cat >"$FIXTURE/worker/app.log" <<'EOF'
2021-03-05 02:53:53,654 INFO worker idle
  at worker.Handler.run(Handler.java:42)
2021-03-05 02:53:54,001 WARN retry
EOF
printf '\x00\x01\xff' >"$FIXTURE/noise.bin"

echo "== building CLI =="
cargo build -p cd-cli
BIN="$CARGO_TARGET_DIR/debug/contextdesk"

echo "== normalize =="
"$BIN" normalize "$FIXTURE" --output "$DEST" --output-format jsonl
echo
echo "== outputs =="
find "$DEST" -type f | sort
echo
echo "== report summary =="
python3 - <<PY
import json
from pathlib import Path
r=json.loads(Path("$DEST/normalization-report.json").read_text())
print(json.dumps({k:r[k] for k in [
  "events","sourcesSelected","timeSourceExplicit","timeUnresolved","timeOrderOnly","partial"
] if k in r or True}, indent=2))
# print camelCase keys present
print("keys", sorted(r.keys())[:20])
print("events", r.get("events"))
print("sources", len(r.get("sources",[])))
PY
echo
echo "== sample header + first event =="
first=$(find "$DEST/sources" -name '*.jsonl' | head -1)
head -n 2 "$first"
echo
echo "DEMO_OK out=$DEST"
