#!/usr/bin/env bash
# Neutral offline demo of CLI activity/trace parity modes.
# Synthetic fixtures only — no live provider network required for dry-run paths.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Users/chriscase/Documents/GitHub/ContextDesk/target}"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
# If rustup has no default in this shell, still use the stable toolchain binary.
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -x "${HOME}/.cargo/bin/cargo" ]]; then
    export PATH="${HOME}/.cargo/bin:${PATH}"
  fi
fi
if [[ -z "${RUSTUP_TOOLCHAIN:-}" ]] && ! rustup show active-toolchain >/dev/null 2>&1; then
  export RUSTUP_TOOLCHAIN=stable
fi
cd "$ROOT"

DEMO_HOME="${DEMO_HOME:-$(mktemp -d -t cd-activity-demo.XXXXXX)}"
export HOME="$DEMO_HOME"
KEEP_COPY="${DEMO_KEEP:-}"
cleanup() {
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

echo "== demo home: $DEMO_HOME =="
mkdir -p "$DEMO_HOME/logs" "$DEMO_HOME/cd"
cat > "$DEMO_HOME/logs/app.log" <<'LOG'
2024-01-01T00:00:00Z INFO service started
2024-01-01T00:00:01Z ERROR payment failed code=E42
2024-01-01T00:00:02Z INFO retry scheduled
LOG

APP_CFG="$DEMO_HOME/cd/config.json"
cat > "$APP_CFG" <<'JSON'
{
  "providers": {
    "active_id": "demo",
    "profiles": [{
      "id": "demo",
      "label": "demo",
      "kind": "open_ai_compatible",
      "base_url": "http://127.0.0.1:9",
      "api_key_ref": null,
      "chat_model": "demo-model",
      "embed_model": null,
      "local_only": true,
      "capabilities": { "tools": false, "stream": true, "embeddings": false }
    }]
  }
}
JSON

run() {
  "$BIN" --app-config "$APP_CFG" --data-dir "$DEMO_HOME/cd" "$@"
}

echo "== 1. ordinary chat dry-run + activity summary =="
run chat --dry-run --activity summary --new "hello ordinary" \
  >"$DEMO_HOME/1.out" 2>"$DEMO_HOME/1.err" || true
grep -q activity "$DEMO_HOME/1.err" && echo "activity summary on stderr: ok" || echo "WARN: no activity on stderr"

echo "== 2. linked logs: import then chat dry-run =="
run import "$DEMO_HOME/logs" >"$DEMO_HOME/2-import.out" 2>"$DEMO_HOME/2-import.err" || true
run chat --dry-run --activity summary --new "summarize linked failures" \
  >"$DEMO_HOME/2.out" 2>"$DEMO_HOME/2.err" || true

echo "== 3. tool-round / failure shape via --jsonl + --trace summary =="
run --jsonl chat --dry-run --trace summary --activity summary --new "probe tools" \
  >"$DEMO_HOME/3.jsonl" 2>"$DEMO_HOME/3.err" || true
python3 - <<'PY' "$DEMO_HOME/3.jsonl"
import json,sys
path=sys.argv[1]
lines=[json.loads(l) for l in open(path) if l.strip()]
assert lines, "jsonl empty"
assert lines[-1].get("type")=="done", lines[-1]
for l in lines:
    for k in ("schema","version","session","turn","operation","seq"):
        assert k in l, f"missing {k} in {l}"
print(f"jsonl ok: {len(lines)} lines, types={[l.get('type') for l in lines]}")
PY

echo "== 4. session continuity =="
run --json chat --dry-run --activity summary --new "first turn" \
  >"$DEMO_HOME/4a.json" 2>"$DEMO_HOME/4a.err" || true
SID=$(python3 -c "import json;print(json.load(open('$DEMO_HOME/4a.json'))['data']['session_id'])" 2>/dev/null || true)
if [[ -n "${SID:-}" ]]; then
  run --json chat --dry-run --activity summary --session "$SID" "second turn resume" \
    >"$DEMO_HOME/4b.json" 2>"$DEMO_HOME/4b.err" || true
  echo "session continuity: $SID"
else
  echo "session continuity: skipped (no session id)"
  cat "$DEMO_HOME/4a.json" || true
  cat "$DEMO_HOME/4a.err" || true
fi

echo "== 5. NO_COLOR / TERM=dumb / piped =="
TERM=dumb NO_COLOR=1 run chat --dry-run --activity summary --new "dumb term" \
  2>"$DEMO_HOME/5.err" | cat >"$DEMO_HOME/5.out" || true
if grep -q $'\x1b' "$DEMO_HOME/5.out" 2>/dev/null; then
  echo "FAIL: ANSI in piped/dumb output" >&2
  exit 1
fi
echo "no ANSI in piped output: ok"

echo "== demo complete =="
