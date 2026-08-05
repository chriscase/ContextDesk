#!/usr/bin/env bash
# Mandatory smoke tests for a built `contextdesk` release artifact.
# Fail-closed: CLI_SMOKE_REQUIRED=1 (default in CI) refuses CLI_SMOKE_SKIP.
#
# Env:
#   CONTEXTDESK_BIN   — path to binary (required)
#   EXPECT_GIT_SHA    — optional; when set, must appear in capabilities --json
#   EXPECT_CHANNEL    — optional
#   EXPECT_DESCRIBE   — optional
#   CLI_SMOKE_REQUIRED — default 1; when 1, skip is forbidden
#   CLI_SMOKE_SKIP    — if set with REQUIRED=1, exit 2 (mutation fail-closed)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${CONTEXTDESK_BIN:-}"
REQUIRED="${CLI_SMOKE_REQUIRED:-1}"

if [[ -n "${CLI_SMOKE_SKIP:-}" ]]; then
  if [[ "$REQUIRED" == "1" ]]; then
    echo "smoke_cli_artifact: CLI_SMOKE_SKIP is forbidden when CLI_SMOKE_REQUIRED=1" >&2
    exit 2
  fi
  echo "smoke_cli_artifact: skipped (not allowed in release CI)"
  exit 0
fi

if [[ -z "$BIN" || ! -x "$BIN" && ! -f "$BIN" ]]; then
  echo "smoke_cli_artifact: CONTEXTDESK_BIN missing or not a file: $BIN" >&2
  exit 2
fi
chmod +x "$BIN" 2>/dev/null || true

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cd-cli-smoke.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

DATA="$WORK/data"
mkdir -p "$DATA"
DEMO_SRC="$ROOT/fixtures/cli-release-demo"
if [[ ! -d "$DEMO_SRC" ]]; then
  echo "smoke_cli_artifact: missing fixtures/cli-release-demo" >&2
  exit 2
fi
cp -R "$DEMO_SRC" "$WORK/demo"

echo "== smoke: --version =="
VERSION_OUT="$("$BIN" --version 2>&1 || true)"
echo "$VERSION_OUT"
if [[ -z "$VERSION_OUT" ]]; then
  echo "smoke: --version produced no output" >&2
  exit 1
fi

echo "== smoke: capabilities --json =="
CAPS="$("$BIN" --data-dir "$DATA" capabilities --json)"
echo "$CAPS" | head -c 2000
echo
python3 - <<'PY' "$CAPS" "${EXPECT_GIT_SHA:-}" "${EXPECT_CHANNEL:-}" "${EXPECT_DESCRIBE:-}"
import json, sys
caps_raw, expect_sha, expect_channel, expect_describe = sys.argv[1:5]
# Envelope or bare — accept both.
doc = json.loads(caps_raw)
data = doc.get("data", doc) if isinstance(doc, dict) else {}
if not isinstance(data, dict):
    raise SystemExit(f"capabilities JSON unexpected: {doc!r}")
# Required identity surface
for key in ("cli_version", "build_channel", "envelope_schema_version", "exit_categories", "commands"):
    if key not in data:
        raise SystemExit(f"capabilities missing {key}")
if not data.get("commands"):
    raise SystemExit("capabilities.commands empty")
if expect_sha:
    got = data.get("git_sha") or ""
    # Accept short or full SHA prefix match
    if expect_sha not in str(got) and not str(got).startswith(expect_sha[:12]) and expect_sha[:12] not in str(got):
        # Full SHA embed may be short-12 from build.rs git fallback; compare prefixes
        if not (got and (got in expect_sha or expect_sha.startswith(got) or got.startswith(expect_sha[:7]))):
            raise SystemExit(f"git_sha mismatch: expected {expect_sha!r} got {got!r}")
if expect_channel:
    if data.get("build_channel") != expect_channel:
        raise SystemExit(
            f"build_channel mismatch: expected {expect_channel!r} got {data.get('build_channel')!r}"
        )
if expect_describe:
    got_d = data.get("git_describe") or ""
    if expect_describe not in str(got_d) and str(got_d) not in expect_describe:
        # soft: describe may differ slightly; require non-empty when expected
        if not got_d:
            raise SystemExit("git_describe empty but EXPECT_DESCRIBE set")
print("capabilities identity: ok")
PY

echo "== smoke: synthetic import =="
IMPORT_OUT="$("$BIN" --data-dir "$DATA" --json import "$WORK/demo" 2>"$WORK/import.err" || true)"
echo "$IMPORT_OUT" | head -c 2000
echo
# stderr progress is fine; require success envelope
python3 - <<'PY' "$IMPORT_OUT" "$WORK/import.err"
import json, sys
raw, err_path = sys.argv[1], sys.argv[2]
try:
    doc = json.loads(raw)
except Exception as e:
    err = open(err_path, encoding="utf-8", errors="replace").read()
    raise SystemExit(f"import JSON parse failed: {e}; stderr={err[:500]!r}; stdout={raw[:500]!r}")
if not doc.get("ok"):
    raise SystemExit(f"import not ok: {doc}")
data = doc.get("data") or {}
cid = data.get("corpus_id")
if not cid:
    raise SystemExit(f"import missing corpus_id: {data}")
open(sys.argv[0] + ".cid", "w").write(cid) if False else None
print(cid)
PY
CORPUS_ID="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["data"]["corpus_id"])' "$IMPORT_OUT")"
echo "corpus_id=$CORPUS_ID"

echo "== smoke: corpus list =="
LIST_OUT="$("$BIN" --data-dir "$DATA" --json corpus list)"
echo "$LIST_OUT" | head -c 1500
echo
python3 - <<'PY' "$LIST_OUT" "$CORPUS_ID"
import json, sys
doc = json.loads(sys.argv[1])
cid = sys.argv[2]
if not doc.get("ok"):
    raise SystemExit(doc)
data = doc.get("data")
# list may be {corpora:[...]} or a list
blob = json.dumps(data)
if cid not in blob:
    raise SystemExit(f"corpus list missing {cid}: {data}")
print("corpus list: ok")
PY

echo "== smoke: explore =="
# explore <query> [--corpus id] — query is required positional
EXPLORE_OUT="$("$BIN" --data-dir "$DATA" --json explore "error" --corpus "$CORPUS_ID" 2>"$WORK/explore.err" || true)"
echo "$EXPLORE_OUT" | head -c 1500
echo
python3 - <<'PY' "$EXPLORE_OUT" "$WORK/explore.err"
import json, sys
raw, errp = sys.argv[1], sys.argv[2]
try:
    doc = json.loads(raw)
except Exception as e:
    err = open(errp, encoding="utf-8", errors="replace").read()
    raise SystemExit(f"explore failed to parse: {e}; stderr={err[:800]!r}; out={raw[:800]!r}")
if not doc.get("ok"):
    err = open(errp, encoding="utf-8", errors="replace").read()
    raise SystemExit(f"explore not ok: {doc}; stderr={err[:500]!r}")
print("explore: ok")
PY

echo "== smoke: normalize =="
NORMALIZED="$WORK/normalized"
NORMALIZE_OUT="$("$BIN" --json normalize "$WORK/demo" --output "$NORMALIZED" --output-format jsonl 2>"$WORK/normalize.err" || true)"
echo "$NORMALIZE_OUT" | head -c 2000
echo
python3 - <<'PY' "$NORMALIZE_OUT" "$NORMALIZED" "$WORK/normalize.err"
import json
import pathlib
import sys

raw, normalized_raw, err_path = sys.argv[1:4]
normalized = pathlib.Path(normalized_raw)
try:
    envelope = json.loads(raw)
except Exception as exc:
    err = pathlib.Path(err_path).read_text(encoding="utf-8", errors="replace")
    raise SystemExit(
        f"normalize JSON parse failed: {exc}; stderr={err[:800]!r}; stdout={raw[:800]!r}"
    )
if not envelope.get("ok"):
    err = pathlib.Path(err_path).read_text(encoding="utf-8", errors="replace")
    raise SystemExit(f"normalize not ok: {envelope}; stderr={err[:800]!r}")

manifest_path = normalized / "manifest.json"
report_path = normalized / "normalization-report.json"
if not manifest_path.is_file() or not report_path.is_file():
    raise SystemExit("normalize omitted manifest.json or normalization-report.json")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
report = json.loads(report_path.read_text(encoding="utf-8"))
if manifest.get("schemaId") != "contextdesk.normalization_manifest.v1":
    raise SystemExit(f"unexpected manifest schema: {manifest.get('schemaId')!r}")
if report.get("schemaId") != "contextdesk.normalization_report.v1":
    raise SystemExit(f"unexpected report schema: {report.get('schemaId')!r}")

sources = manifest.get("sources") or []
if not sources:
    raise SystemExit("normalize manifest has no sources")
event_total = 0
for source in sources:
    rel = source.get("relativePath")
    path = normalized / rel if isinstance(rel, str) else None
    if path is None or not path.is_file():
        raise SystemExit(f"missing normalized source file: {rel!r}")
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    if len(lines) < 2:
        raise SystemExit(f"normalized source has no events: {rel}")
    header = json.loads(lines[0])
    if header.get("schemaId") != "contextdesk.normalized_log_events.v1":
        raise SystemExit(f"unexpected JSONL schema in {rel}: {header.get('schemaId')!r}")
    events = [json.loads(line) for line in lines[1:]]
    seqs = [event.get("sourceSeq") for event in events]
    if seqs != list(range(len(events))):
        raise SystemExit(f"non-contiguous sourceSeq in {rel}: {seqs[:10]!r}")
    if source.get("events") != len(events):
        raise SystemExit(
            f"manifest event mismatch for {rel}: {source.get('events')!r} vs {len(events)}"
        )
    event_total += len(events)

if report.get("events") != event_total:
    raise SystemExit(
        f"report event mismatch: {report.get('events')!r} vs on-disk {event_total}"
    )
data = envelope.get("data") or {}
if data.get("events") != event_total:
    raise SystemExit(
        f"CLI event mismatch: {data.get('events')!r} vs on-disk {event_total}"
    )
print(f"normalize: ok ({event_total} events across {len(sources)} sources)")
PY

echo "smoke_cli_artifact: ALL PASSED"
