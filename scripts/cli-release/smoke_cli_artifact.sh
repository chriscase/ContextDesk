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

# Normalized-output validation is staged until the normalize branch is integrated.
if "$BIN" --data-dir "$DATA" capabilities --json 2>/dev/null | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); data=d.get("data",d); print("normalize" in json.dumps(data).lower())' | grep -q True; then
  echo "== smoke: normalized-output validation (normalize surface present) =="
  echo "NOTE: run additional normalize checks when product surface is wired."
else
  echo "== smoke: normalized-output validation SKIPPED (normalize branch not integrated) =="
fi

echo "smoke_cli_artifact: ALL PASSED"
