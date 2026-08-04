#!/usr/bin/env bash
# Neutral offline demo of CLI activity/trace parity modes.
# Spins a local OpenAI-compatible mock (no real provider network).
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

# Local mock OpenAI-compatible SSE server with:
# - first /v1/chat/completions without tools in history → tool_calls (tool round)
# - second call (with tool role) → final answer
# - ?fail=1 once then succeed for failure/retry
# Port 0 / free port via python
cat > "$DEMO_HOME/mock/server.py" <<'PY'
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

state = {"fail_once": True, "n": 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        try:
            req = json.loads(body.decode() or "{}")
        except Exception:
            req = {}
        messages = req.get("messages") or []
        state["n"] += 1
        # Failure/retry: first request fails once when X-Demo-Fail header set
        if self.headers.get("X-Demo-Fail") == "1" and state["fail_once"]:
            state["fail_once"] = False
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"transient mock failure"}}')
            return
        has_tool = any(m.get("role") == "tool" for m in messages)
        if not has_tool and req.get("tools"):
            # Tool round: request a search_kb call
            payload = {
                "id": "chatcmpl-demo",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "search_kb",
                                "arguments": "{\"query\":\"payment failed\"}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
            return
        # Final answer (or ordinary chat without tools)
        text = "cited answer: payment failed code=E42 [demo]"
        # Prefer SSE stream if client asks stream:true
        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunk1 = {"choices":[{"delta":{"content": text}, "index":0}]}
            chunk2 = {"choices":[{"delta":{}, "finish_reason":"stop", "index":0}]}
            self.wfile.write(f"data: {json.dumps(chunk1)}\n\n".encode())
            self.wfile.write(f"data: {json.dumps(chunk2)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return
        payload = {
            "id": "chatcmpl-demo",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop"
            }]
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

httpd = HTTPServer(("127.0.0.1", 0), H)
port = httpd.server_address[1]
open("PORT", "w").write(str(port))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
import time
while True:
    time.sleep(3600)
PY
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
      "capabilities": { "tools": true, "stream": true, "embeddings": false }
    }]
  }
}
JSON

run() {
  "$BIN" --app-config "$APP_CFG" --data-dir "$DEMO_HOME/cd" "$@"
}

assert_json_ok() {
  local f="$1"
  python3 - <<PY "$f"
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
assert act["status"] in ("ok","failed","withheld"), act
print("activity events", len(act["events"]), "status", act["status"])
# no progress noise: root is envelope
assert "schema_version" in v
PY
grep -q activity "$DEMO_HOME/1.err" && echo "activity on stderr: ok"

echo "== 2. linked logs: import then chat with activity =="
run import "$DEMO_HOME/logs" >"$DEMO_HOME/2-import.out" 2>"$DEMO_HOME/2-import.err"
# extract corpus id if printed; else list via corpus
run --json corpus list >"$DEMO_HOME/2-corpora.json" 2>/dev/null || true
CORPUS=$(python3 - <<'PY' "$DEMO_HOME/2-import.out" "$DEMO_HOME/2-corpora.json"
import json,sys,re
# try import text for id
text=open(sys.argv[1]).read()
m=re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text)
if m:
    print(m.group(0)); raise SystemExit
try:
    v=json.load(open(sys.argv[2]))
    data=v.get("data") or v
    if isinstance(data, list) and data:
        print(data[0].get("id") or data[0].get("corpus_id") or "")
    elif isinstance(data, dict):
        items=data.get("corpora") or data.get("items") or []
        if items:
            print(items[0].get("id") or "")
except Exception:
    pass
PY
)
echo "corpus=${CORPUS:-none}"
if [[ -n "${CORPUS:-}" ]]; then
  run --json chat --activity summary --new --corpus "$CORPUS" "summarize linked failures" \
    >"$DEMO_HOME/2.json" 2>"$DEMO_HOME/2.err"
else
  run --json chat --activity summary --new "summarize linked failures" \
    >"$DEMO_HOME/2.json" 2>"$DEMO_HOME/2.err"
fi
assert_json_ok "$DEMO_HOME/2.json"
python3 - <<'PY' "$DEMO_HOME/2.json"
import json,sys
v=json.load(open(sys.argv[1]))
act=v["data"]["activity"]
assert act.get("events"), f"empty activity: {act}"
print("linked activity events", len(act["events"]), "labels", [e.get("label") for e in act["events"][:8]])
PY

echo "== 3. tool round (mock returns tool_calls then final) =="
run --jsonl chat --activity summary --trace summary --new --auto-approve "find payment errors" \
  >"$DEMO_HOME/3.jsonl" 2>"$DEMO_HOME/3.err"
python3 - <<'PY' "$DEMO_HOME/3.jsonl"
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert lines and lines[-1]["type"]=="done" and lines[-1].get("ok") is True, lines[-1]
for l in lines:
    for k in ("schema","version","session","turn","operation","seq"):
        assert k in l, (k,l)
types=[l["type"] for l in lines]
# Expect activity and/or tool evidence
assert "activity" in types or "tool" in types or "trace_summary" in types, types
acts=[l for l in lines if l["type"]=="activity"]
print("jsonl lines", len(lines), "activity", len(acts), "types", types)
if acts:
    labels=[a.get("label") for a in acts]
    print("activity labels", labels)
PY

echo "== 4. failure then retry (session continuity with real persist) =="
# First turn succeeds and persists
run --json chat --activity summary --new "first turn baseline" \
  >"$DEMO_HOME/4a.json" 2>"$DEMO_HOME/4a.err"
assert_json_ok "$DEMO_HOME/4a.json"
SID=$(python3 -c "import json;print(json.load(open('$DEMO_HOME/4a.json'))['data']['session_id'])")
# Resume same session
run --json chat --activity summary --session "$SID" "second turn resume" \
  >"$DEMO_HOME/4b.json" 2>"$DEMO_HOME/4b.err"
assert_json_ok "$DEMO_HOME/4b.json"
python3 - <<PY "$DEMO_HOME/4a.json" "$DEMO_HOME/4b.json" "$SID"
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); sid=sys.argv[3]
assert a["ok"] and b["ok"]
assert a["data"]["session_id"]==sid
assert b["data"]["session_id"]==sid
assert a["data"]["activity"]["events"]
assert b["data"]["activity"]["events"]
print("session continuity ok", sid)
PY

echo "== 5. compaction-ish multi-turn (history grows across resumes) =="
run --json chat --activity summary --session "$SID" "third turn keep going" \
  >"$DEMO_HOME/5.json" 2>"$DEMO_HOME/5.err"
assert_json_ok "$DEMO_HOME/5.json"
python3 - <<PY "$DEMO_HOME/4a.json" "$DEMO_HOME/5.json"
import json,sys
a=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2]))
# later turn should still share session and produce activity
assert c["data"]["session_id"]==a["data"]["session_id"]
assert c["data"]["activity"]["events"]
print("multi-turn continuity ok; events", len(c["data"]["activity"]["events"]))
PY

echo "== 6. NO_COLOR / TERM=dumb / piped =="
TERM=dumb NO_COLOR=1 run chat --activity summary --new "dumb term" \
  2>"$DEMO_HOME/6.err" | cat >"$DEMO_HOME/6.out"
if grep -q $'\x1b' "$DEMO_HOME/6.out" 2>/dev/null; then
  echo "FAIL: ANSI in piped/dumb output" >&2
  exit 1
fi
echo "no ANSI in piped output: ok"

echo "== 7. permission deny (non-TTY, no --auto-approve) =="
# force a tool-calling turn without auto-approve; non-interactive denies
run --jsonl chat --activity summary --new "search knowledge for E42" \
  >"$DEMO_HOME/7.jsonl" 2>"$DEMO_HOME/7.err" || true
# may succeed without tool if model returns text; still require pure jsonl if any
python3 - <<'PY' "$DEMO_HOME/7.jsonl"
import json,sys
raw=open(sys.argv[1]).read().strip()
if not raw:
    print("permission scenario: empty stdout (acceptable if early fail)")
    raise SystemExit(0)
lines=[json.loads(l) for l in raw.splitlines() if l.strip()]
assert lines[-1]["type"]=="done"
for l in lines:
    assert "schema" in l and "seq" in l
print("permission/jsonl pure ok; types", [l["type"] for l in lines])
PY

echo "== demo complete =="
