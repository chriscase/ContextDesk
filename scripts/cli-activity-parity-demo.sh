#!/usr/bin/env bash
# Neutral offline demo of CLI activity/trace parity modes.
# Local OpenAI-compatible mock only — no live provider network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Users/chriscase/Documents/GitHub/ContextDesk/target}"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
cd "$ROOT"

DEMO_HOME="${DEMO_HOME:-$(mktemp -d -t cd-activity-demo.XXXXXX)}"
export HOME="$DEMO_HOME"
KEEP_COPY="${DEMO_KEEP:-}"
MOCK_PID=""
cleanup() {
  if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  if [[ -n "$KEEP_COPY" ]]; then
    mkdir -p "$KEEP_COPY"
    cp -R "$DEMO_HOME/." "$KEEP_COPY/" 2>/dev/null || true
    echo "kept artifacts at $KEEP_COPY"
  fi
  rm -rf "$DEMO_HOME"
}
trap cleanup EXIT

BIN="${CARGO_TARGET_DIR}/debug/contextdesk"
if [[ ! -x "$BIN" ]]; then
  echo "== build contextdesk =="
  cargo build -p cd-cli --quiet
fi
test -x "$BIN"

mkdir -p "$DEMO_HOME/logs" "$DEMO_HOME/cd" "$DEMO_HOME/mock"
cat > "$DEMO_HOME/logs/app.log" <<'LOG'
2024-01-01T00:00:00Z INFO service started
2024-01-01T00:00:01Z ERROR payment failed code=E42
2024-01-01T00:00:02Z INFO retry scheduled
LOG

# Local mock server (SSE tool_calls + fail-once + final answers).
cp "$ROOT/scripts/cli-activity-parity-mock-server.py" "$DEMO_HOME/mock/server.py"
( cd "$DEMO_HOME/mock" && python3 server.py ) &
MOCK_PID=$!
for i in $(seq 1 50); do
  [[ -f "$DEMO_HOME/mock/PORT" ]] && break
  sleep 0.05
done
PORT=$(cat "$DEMO_HOME/mock/PORT")
echo "mock provider on 127.0.0.1:$PORT"

APP_CFG="$DEMO_HOME/cd/config.json"
cat > "$APP_CFG" <<JSON
{
  "providers": {
    "active_id": "demo",
    "profiles": [{
      "id": "demo",
      "label": "demo",
      "kind": "open_ai_compatible",
      "base_url": "http://127.0.0.1:${PORT}",
      "api_key_ref": null,
      "chat_model": "demo-model",
      "embed_model": null,
      "local_only": true,
      "capabilities": { "tools": true, "stream": false, "embeddings": false }
    }]
  }
}
JSON

run() {
  "$BIN" --app-config "$APP_CFG" --data-dir "$DEMO_HOME/cd" "$@"
}

assert_json_ok() {
  python3 - <<PY "$1"
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("ok") is True, v
print("ok", v["data"].get("session_id",""))
PY
}

echo "== 1. ordinary chat + activity summary =="
run --json chat --activity summary --new "hello ordinary" \
  >"$DEMO_HOME/1.json" 2>"$DEMO_HOME/1.err"
assert_json_ok "$DEMO_HOME/1.json"
python3 - <<'PY' "$DEMO_HOME/1.json"
import json,sys
v=json.load(open(sys.argv[1]))
act=v["data"]["activity"]
assert act["events"], act
print("activity events", len(act["events"]), "status", act["status"])
PY
grep -q activity "$DEMO_HOME/1.err" && echo "activity on stderr: ok"

echo "== 2. linked logs: import then chat with activity =="
run import "$DEMO_HOME/logs" >"$DEMO_HOME/2-import.out" 2>"$DEMO_HOME/2-import.err"
CORPUS=$(python3 - <<'PY' "$DEMO_HOME/2-import.out" "$DEMO_HOME/2-import.err"
import re,sys
blob=open(sys.argv[1]).read()+open(sys.argv[2]).read()
m=re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', blob)
print(m.group(0) if m else "")
PY
)
echo "corpus=${CORPUS:-none}"
if [[ -n "${CORPUS}" ]]; then
  run --json chat --activity summary --new --corpus "$CORPUS" --auto-approve "summarize linked failures" \
    >"$DEMO_HOME/2.json" 2>"$DEMO_HOME/2.err"
else
  run --json chat --activity summary --new --auto-approve "summarize linked failures" \
    >"$DEMO_HOME/2.json" 2>"$DEMO_HOME/2.err"
fi
assert_json_ok "$DEMO_HOME/2.json"
python3 - <<'PY' "$DEMO_HOME/2.json"
import json,sys
v=json.load(open(sys.argv[1]))
act=v["data"]["activity"]
assert act.get("events"), act
print("linked labels", [e.get("label") for e in act["events"]])
labels="|".join(e.get("label","") for e in act["events"]).lower()
if "error" in labels or act["status"]!="ok":
    print("truthful non-ok/error path ok")
# stream lifecycle must be mergeable: if activity has model rounds, errors still allowed
assert act["events"]
PY

# Unlinked data-dir for tool/fail/resume demos (avoid inheriting linked corpus state).
DATA2="$DEMO_HOME/cd2"
mkdir -p "$DATA2"
run2() { "$BIN" --app-config "$APP_CFG" --data-dir "$DATA2" "$@"; }

echo "== 3. tool round (FORCE_TOOL + auto-approve search_kb, unlinked data-dir) =="
run2 --jsonl chat --activity summary --trace summary --new --auto-approve "FORCE_TOOL find payment errors" \
  >"$DEMO_HOME/3.jsonl" 2>"$DEMO_HOME/3.err"
python3 - <<'PY' "$DEMO_HOME/3.jsonl"
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert lines and lines[-1]["type"]=="done" and lines[-1].get("ok") is True, lines[-1]
for l in lines:
    for k in ("schema","version","session","turn","operation","seq"):
        assert k in l, (k,l)
acts=[l for l in lines if l["type"]=="activity"]
assert acts, lines
labels=[a.get("label","") for a in acts]
joined=" | ".join(labels)
print("tool-round labels:", joined)
assert any("Model request" in l for l in labels), labels
# Require a real Tool phase, not the substring in "tool_calls" finish reason
assert any(
    l.lower().startswith("tool ") or "search_kb" in l.lower() or "awaiting permission" in l.lower()
    for l in labels
), "expected Tool started/finished for search_kb: " + joined
# Must NOT be a linked_no_tool-only path for this unlinked tool demo
assert not any(l.get("code")=="linked_no_tool" for l in lines if l.get("type")=="error"), lines
print("tool round activity ok")
PY

echo "== 4. failure then recovery (hard fail, then clean success) =="
set +e
run2 --json chat --activity summary --new "FORCE_FAIL_ALWAYS first attempt" \
  >"$DEMO_HOME/4-fail.json" 2>"$DEMO_HOME/4-fail.err"
FAIL_RC=$?
set -e
python3 - <<'PY' "$DEMO_HOME/4-fail.json" "$FAIL_RC"
import json,sys
path, rc = sys.argv[1], int(sys.argv[2])
raw=open(path).read().strip()
assert raw, "fail attempt produced empty stdout"
v=json.loads(raw)
ok = v.get("ok")
status = ((v.get("data") or {}).get("activity") or {}).get("status")
labels="|".join(
    e.get("label","") for e in ((v.get("data") or {}).get("activity") or {}).get("events") or []
)
print("fail attempt ok=", ok, "rc=", rc, "activity_status=", status, "labels=", labels)
assert (
    ok is False
    or rc != 0
    or status in ("failed","withheld")
    or "error" in labels.lower()
    or "Error:" in labels
), (v, labels, rc)
print("failure path ok")
PY
# Clean recovery turn after hard failure
run2 --json chat --activity summary --new "recovery after failure" \
  >"$DEMO_HOME/4-retry.json" 2>"$DEMO_HOME/4-retry.err"
assert_json_ok "$DEMO_HOME/4-retry.json"
python3 - <<'PY' "$DEMO_HOME/4-retry.json"
import json,sys
v=json.load(open(sys.argv[1]))
assert v["ok"] is True
assert v["data"]["activity"]["events"]
print("recovery success ok")
PY

echo "== 5. session continuity + multi-turn context (compaction stand-in) =="
run2 --json chat --activity summary --new "continuity seed turn" \
  >"$DEMO_HOME/5a.json" 2>"$DEMO_HOME/5a.err"
assert_json_ok "$DEMO_HOME/5a.json"
SID=$(python3 -c "import json;print(json.load(open('$DEMO_HOME/5a.json'))['data']['session_id'])")
for i in 1 2 3 4; do
  run2 --json chat --activity summary --session "$SID" "continuity turn $i with extra padding text to grow history for compaction visibility" \
    >"$DEMO_HOME/5b-$i.json" 2>"$DEMO_HOME/5b-$i.err"
  assert_json_ok "$DEMO_HOME/5b-$i.json"
done
python3 - <<PY "$DEMO_HOME/5a.json" "$DEMO_HOME/5b-4.json"
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
assert a["data"]["session_id"]==b["data"]["session_id"]
assert b["data"]["activity"]["events"]
labels="|".join(e.get("label","") for e in b["data"]["activity"]["events"]).lower()
assert "model" in labels or "request" in labels or "retrieval" in labels or "context" in labels, labels
print("session continuity + multi-turn context activity ok; events", len(b["data"]["activity"]["events"]))
# Honest note: mid-turn compaction is core-driven; multi-turn history growth is the offline demo stand-in.
PY

echo "== 6. NO_COLOR / TERM=dumb / piped =="
TERM=dumb NO_COLOR=1 run2 chat --activity summary --new "dumb term" \
  2>"$DEMO_HOME/6.err" | cat >"$DEMO_HOME/6.out"
if grep -q $'\x1b' "$DEMO_HOME/6.out" 2>/dev/null; then
  echo "FAIL: ANSI in piped/dumb output" >&2
  exit 1
fi
echo "no ANSI in piped output: ok"

echo "== 7. non-interactive jsonl purity (no --auto-approve) =="
run2 --jsonl chat --activity summary --new "FORCE_TOOL without auto approve" \
  >"$DEMO_HOME/7.jsonl" 2>"$DEMO_HOME/7.err" || true
python3 - <<'PY' "$DEMO_HOME/7.jsonl"
import json,sys
raw=open(sys.argv[1]).read().strip()
assert raw, "empty jsonl"
lines=[json.loads(l) for l in raw.splitlines() if l.strip()]
assert lines[-1]["type"]=="done"
for l in lines:
    assert "schema" in l and "seq" in l
print("jsonl pure under non-auto-approve; types", [l["type"] for l in lines])
PY

echo "== demo complete =="
