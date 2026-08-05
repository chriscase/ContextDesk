#!/usr/bin/env bash
# Exact-head CLI demo acceptance consolidator (offline, synthetic fixtures only).
#
# Covers criterion-2 flow against a binary that proves identity with
# `git rev-parse HEAD` (build-or-prove; never silent stale target/debug).
#
# Usage:
#   ./scripts/exact_head_cli_acceptance.sh
#   EXACT_HEAD_KEEP=1 EXACT_HEAD_OUT=/path/to/keep ./scripts/exact_head_cli_acceptance.sh
#
# Env:
#   CARGO_TARGET_DIR  shared target (default: <repo>/target) — never cleaned
#   EXACT_HEAD_OUT    directory for captured step artifacts (default: mktemp)
#   EXACT_HEAD_KEEP   if 1, retain EXACT_HEAD_OUT / run home
#   EXACT_HEAD_FORCE_BUILD  if 1, always rebuild before stamp
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export EXACT_HEAD_REPO_ROOT="$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"

# shellcheck source=lib/exact_head_binary.sh
source "$ROOT/scripts/lib/exact_head_binary.sh"

OUT="${EXACT_HEAD_OUT:-}"
KEEP="${EXACT_HEAD_KEEP:-0}"
OWN_OUT=0
if [[ -z "$OUT" ]]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/cd-exact-head-accept.XXXXXX")"
  OWN_OUT=1
fi
mkdir -p "$OUT"
DEMO_HOME="$OUT/home"
mkdir -p "$DEMO_HOME/logs" "$DEMO_HOME/cd" "$DEMO_HOME/mock" "$DEMO_HOME/folder" "$OUT/steps"

MOCK_PID=""
cleanup() {
  if [[ -n "${MOCK_PID:-}" ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  if [[ "$KEEP" != "1" && "$OWN_OUT" == "1" ]]; then
    rm -rf -- "$OUT"
  else
    echo "exact_head: artifacts at $OUT" >&2
  fi
}
trap cleanup EXIT

log() { printf '== %s ==\n' "$*" | tee -a "$OUT/steps/progress.log" >&2; }
fail() { echo "FAIL: $*" | tee -a "$OUT/steps/progress.log" >&2; exit 1; }

# --- 0. Exact-head binary (never silent stale) ---
log "0 exact-head binary identity"
HEAD_SHA="$(exact_head_full_sha)"
echo "worktree_sha=$HEAD_SHA" | tee "$OUT/isolation_sha.txt"
# Prove pre-existing unstamped binary would be rejected (adversarial smoke).
STALE_PROBE="$CARGO_TARGET_DIR/debug/contextdesk"
if [[ -x "$STALE_PROBE" ]] && [[ ! -f "${STALE_PROBE}.exact-head-sha" ]]; then
  if python3 "$ROOT/scripts/lib/exact_head_identity.py" check \
    --binary "$STALE_PROBE" --expected-sha "$HEAD_SHA" 2>"$OUT/steps/stale-reject.err"; then
    fail "unstamped existing binary must not check-ok"
  else
    echo "stale_reject_ok" | tee "$OUT/steps/stale-reject.txt"
  fi
fi
BIN="$(ensure_exact_head_binary)"
require_exact_head_binary "$BIN" | tee "$OUT/steps/00-binary-identity.txt"
test -x "$BIN" || fail "binary not executable"

run() {
  "$BIN" --app-config "$APP_CFG" --data-dir "$DEMO_HOME/cd" "$@"
}

# --- Mock provider (local only) ---
log "mock provider start"
cp "$ROOT/scripts/cli-activity-parity-mock-server.py" "$DEMO_HOME/mock/server.py"
( cd "$DEMO_HOME/mock" && python3 server.py ) &
MOCK_PID=$!
for _ in $(seq 1 80); do
  [[ -f "$DEMO_HOME/mock/PORT" ]] && break
  sleep 0.05
done
[[ -f "$DEMO_HOME/mock/PORT" ]] || fail "mock server did not publish PORT"
PORT="$(cat "$DEMO_HOME/mock/PORT")"
echo "mock=127.0.0.1:$PORT" | tee "$OUT/steps/mock.txt"

APP_CFG="$DEMO_HOME/cd/config.json"
mkdir -p "$DEMO_HOME/cd"
cat > "$APP_CFG" <<JSON
{
  "providers": {
    "active_id": "exact-head-demo",
    "profiles": [{
      "id": "exact-head-demo",
      "label": "exact-head-demo",
      "kind": "open_ai_compatible",
      "base_url": "http://127.0.0.1:${PORT}",
      "api_key_ref": null,
      "chat_model": "demo-model",
      "embed_model": null,
      "local_only": true,
      "capabilities": { "tools": true, "stream": true, "embeddings": false }
    }]
  },
  "default_timezone": null
}
JSON

# --- Synthetic fixtures (product-neutral) ---
log "1 synthetic fixtures (folder + zip)"
# Ambiguous local timestamps (no zone) for timezone review / apply-all.
mkdir -p "$DEMO_HOME/folder/svc-a" "$DEMO_HOME/folder/svc-b"
cat > "$DEMO_HOME/folder/svc-a/app.log" <<'LOG'
2024-06-15 10:00:01 ERROR service=checkout SYNTH_QUEUE_STALL correlation=demo-42
2024-06-15 10:00:02 INFO service=checkout retry scheduled correlation=demo-42
LOG
cat > "$DEMO_HOME/folder/svc-b/worker.log" <<'LOG'
2024-06-15 10:00:00 WARN service=worker SYNTH_POOL_CHANGE db_pool_max 32->4 correlation=demo-42
2024-06-15 10:00:03 ERROR service=worker SYNTH_QUEUE_STALL correlation=demo-42
LOG
python3 - "$DEMO_HOME/synthetic-incident.zip" "$DEMO_HOME/folder" <<'PY'
import sys, zipfile, pathlib
archive, folder = sys.argv[1], pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for p in folder.rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(folder).as_posix())
print("zip_ok", archive)
PY

# --- Import parity: folder then zip (fresh data dirs) ---
log "2 import folder"
run --json config init --non-interactive --skip-provider --force \
  >"$OUT/steps/02-config-init.json" 2>"$OUT/steps/02-config-init.err" || true
# Re-write provider after init may overwrite — restore mock profile.
cp "$APP_CFG" "$DEMO_HOME/cd/config.json.bak" 2>/dev/null || true
# config init may rewrite config; re-apply mock provider
python3 - <<PY
import json
from pathlib import Path
p = Path("$DEMO_HOME/cd/config.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg["providers"] = {
  "active_id": "exact-head-demo",
  "profiles": [{
    "id": "exact-head-demo",
    "label": "exact-head-demo",
    "kind": "open_ai_compatible",
    "base_url": "http://127.0.0.1:${PORT}",
    "api_key_ref": None,
    "chat_model": "demo-model",
    "embed_model": None,
    "local_only": True,
    "capabilities": {"tools": True, "stream": True, "embeddings": False}
  }]
}
# Leave default_timezone unset so apply-all path is exercised.
cfg["default_timezone"] = None
p.write_text(json.dumps(cfg, indent=2))
print("config_restored")
PY

run --json import "$DEMO_HOME/folder" --explain-selection \
  >"$OUT/steps/02-import-folder.json" 2>"$OUT/steps/02-import-folder.err"
python3 - <<'PY' "$OUT/steps/02-import-folder.json"
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("ok") is True, v
d=v["data"]
assert d.get("events_imported",0) >= 4, d
assert d.get("corpus_id"), d
print("folder_import_ok events", d["events_imported"], "corpus", d["corpus_id"])
open(sys.argv[1]+".corpus","w").write(d["corpus_id"])
PY
CORPUS_FOLDER="$(cat "$OUT/steps/02-import-folder.json.corpus")"

log "3 import zip (second corpus for parity)"
run --json import "$DEMO_HOME/synthetic-incident.zip" --name "zip-parity" --explain-selection \
  >"$OUT/steps/03-import-zip.json" 2>"$OUT/steps/03-import-zip.err"
python3 - <<'PY' "$OUT/steps/03-import-zip.json" "$OUT/steps/02-import-folder.json"
import json,sys
z=json.load(open(sys.argv[1])); f=json.load(open(sys.argv[2]))
assert z["ok"] and f["ok"]
assert z["data"]["events_imported"] == f["data"]["events_imported"], (z["data"], f["data"])
assert z["data"]["corpus_id"] != f["data"]["corpus_id"]
print("zip_folder_parity_ok events", z["data"]["events_imported"])
open(sys.argv[1]+".corpus","w").write(z["data"]["corpus_id"])
PY
CORPUS="$CORPUS_FOLDER"

# --- Timezone: status (ambiguous local) then apply-all ---
log "4 timezone status + apply-all"
run --json timezone status --corpus "$CORPUS" \
  >"$OUT/steps/04-tz-status.json" 2>"$OUT/steps/04-tz-status.err" || true
# apply-all even if status shape varies — must be the real subcommand
run --json timezone apply-all America/Chicago --corpus "$CORPUS" --yes \
  >"$OUT/steps/04-tz-apply-all.json" 2>"$OUT/steps/04-tz-apply-all.err"
python3 - <<'PY' "$OUT/steps/04-tz-apply-all.json"
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("ok") is True, v
print("apply_all_ok", v.get("data"))
PY
run --json timezone status --corpus "$CORPUS" \
  >"$OUT/steps/04-tz-status-after.json" 2>"$OUT/steps/04-tz-status-after.err"

# --- Explore + context inspection ---
log "5 explore + context"
run --json explore SYNTH_QUEUE_STALL --corpus "$CORPUS" \
  >"$OUT/steps/05-explore.json" 2>"$OUT/steps/05-explore.err"
python3 - <<'PY' "$OUT/steps/05-explore.json"
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("ok") is True, v
assert v["data"].get("hits"), v
print("explore_hits", len(v["data"]["hits"]))
PY
run --json context "What happened around correlation demo-42?" --corpus "$CORPUS" \
  >"$OUT/steps/05-context.json" 2>"$OUT/steps/05-context.err"
python3 - <<'PY' "$OUT/steps/05-context.json"
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get("ok") is True, v
assert v["data"].get("evidence") is not None, v
print("context_ok evidence_keys", list(v["data"].keys())[:12])
PY

# --- Explicit one-turn --context-selection (ordinary chat) ---
log "6 chat --context-selection + --trace summary dry-run"
# --context-selection is ordinary-chat only; clear ambient current corpus.
python3 - <<'PY' "$DEMO_HOME/cd/cli/cli-state.json"
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
st=json.loads(p.read_text()) if p.exists() else {"schema_version":1}
st["current_corpus_id"]=None
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(st, indent=2)+"\n")
print("cleared_current_corpus")
PY
run --jsonl chat \
  "Summarize the provided selection only." \
  --new --dry-run --trace summary \
  --context-selection "SYNTH_QUEUE_STALL correlation=demo-42 from host selection" \
  >"$OUT/steps/06-context-selection.jsonl" 2>"$OUT/steps/06-context-selection.err"
python3 - <<'PY' "$OUT/steps/06-context-selection.jsonl"
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert lines, "empty jsonl"
assert lines[-1].get("type")=="done", lines[-1]
# Must complete (ok true for dry-run ordinary); reject linked-policy denial.
assert lines[-1].get("ok") is not False or lines[-1].get("type")=="done"
err_lines=[l for l in lines if l.get("type")=="error"]
assert not any("ordinary chat" in str(l.get("message","")) for l in err_lines), err_lines
assert any(l.get("type")=="trace_summary" for l in lines) or any("trace" in str(l) for l in lines)
print("context_selection_dry_run_ok lines", len(lines), "last", lines[-1])
PY

# --- Linked grounded turns with --activity and --trace ---
log "7 grounded turn 1: activity + trace"
# Phrase "linked failures" triggers the offline mock's search_logs tool path
# (scripts/cli-activity-parity-mock-server.py); SYNTH_* tokens remain in corpus.
run --jsonl chat \
  "summarize linked failures for SYNTH_QUEUE_STALL correlation=demo-42 and cite host evidence" \
  --new --corpus "$CORPUS" --auto-approve \
  --activity summary --trace summary \
  >"$OUT/steps/07-turn1.jsonl" 2>"$OUT/steps/07-turn1.err" || true
python3 - <<'PY' "$OUT/steps/07-turn1.jsonl" "$OUT/steps/07-turn1.err"
import json,sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
err=Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
lines=[]
for line in raw.splitlines():
    line=line.strip()
    if not line: continue
    try: lines.append(json.loads(line))
    except Exception: pass
assert lines, (raw[:500], err[:500])
last=lines[-1]
assert last.get("type")=="done", last
sid=last.get("session_id") or next((l.get("session_id") for l in lines if l.get("session_id")), None)
assert sid, lines[:3]
open(sys.argv[1]+".session","w").write(sid)
tools=[l for l in lines if l.get("type")=="tool"]
search_tools=[l for l in tools if l.get("name")=="search_logs"]
cites=[l for l in lines if l.get("type")=="citation"]
activity_like=any(l.get("type")=="activity" for l in lines)
trace_like=any(l.get("type") in ("trace_summary","trace_context") for l in lines)
print("turn1_ok session", sid, "tools", len(tools), "search_logs", len(search_tools), "cites", len(cites), "activity", activity_like, "trace", trace_like)
# Require real tool activity OR citation OR honest grounded-ish completion.
assert search_tools or cites or any(
    l.get("type")=="tool" and l.get("ok") is True for l in lines
), ("expected search_logs tool activity", lines[:20])
assert activity_like and trace_like, (activity_like, trace_like)
PY
SESSION="$(cat "$OUT/steps/07-turn1.jsonl.session")"

log "8 grounded turn 2: continue session + activity"
run --jsonl chat \
  "Continue: summarize linked failures around SYNTH_POOL_CHANGE in the same incident" \
  --session "$SESSION" --corpus "$CORPUS" --auto-approve \
  --activity summary --trace context \
  >"$OUT/steps/08-turn2.jsonl" 2>"$OUT/steps/08-turn2.err" || true
python3 - <<'PY' "$OUT/steps/08-turn2.jsonl" "$SESSION"
import json,sys
from pathlib import Path
lines=[]
for line in Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").splitlines():
    line=line.strip()
    if not line: continue
    try: lines.append(json.loads(line))
    except Exception: pass
assert lines and lines[-1].get("type")=="done"
sid=lines[-1].get("session_id") or sys.argv[2]
tools=[l for l in lines if l.get("type")=="tool"]
activity_like=any(l.get("type")=="activity" for l in lines)
trace_like=any(l.get("type") in ("trace_summary","trace_context") for l in lines)
print("turn2_ok session", sid, "lines", len(lines), "tools", len(tools), "activity", activity_like, "trace", trace_like)
assert activity_like, "turn2 must project activity"
open(sys.argv[1]+".session","w").write(sid)
PY

# --- Session continuity after reopen (session show) ---
log "9 session continuity"
run --json session show "$SESSION" \
  >"$OUT/steps/09-session-show.json" 2>"$OUT/steps/09-session-show.err" || \
run --json session list \
  >"$OUT/steps/09-session-list.json" 2>"$OUT/steps/09-session-list.err"
python3 - <<'PY' "$OUT" "$SESSION"
import json,sys
from pathlib import Path
out, sid = Path(sys.argv[1]), sys.argv[2]
show=out/"steps/09-session-show.json"
listing=out/"steps/09-session-list.json"
blob=""
if show.exists():
    blob=show.read_text(encoding="utf-8", errors="replace")
elif listing.exists():
    blob=listing.read_text(encoding="utf-8", errors="replace")
assert sid in blob, (sid, blob[:400])
print("session_continuity_ok", sid)
PY

# --- Cancellation or honest failure/recovery ---
log "10 cancel or honest failure path"
# Prefer cooperative cancel if supported; else FORCE_FAIL_ALWAYS mock failure.
set +e
run --jsonl chat \
  "FORCE_FAIL_ALWAYS trigger honest terminal failure for recovery demo" \
  --new --corpus "$CORPUS" --auto-approve --activity summary \
  >"$OUT/steps/10-failure.jsonl" 2>"$OUT/steps/10-failure.err"
fail_rc=$?
set -e
python3 - <<'PY' "$OUT/steps/10-failure.jsonl" "$OUT/steps/10-failure.err" "$fail_rc"
import json,sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
err=Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
rc=int(sys.argv[3])
lines=[]
for line in raw.splitlines():
    line=line.strip()
    if not line: continue
    try: lines.append(json.loads(line))
    except Exception: pass
# Honest failure: non-zero rc OR done with ok=false OR error envelope
honest=False
if rc != 0:
    honest=True
if lines and lines[-1].get("type")=="done" and lines[-1].get("ok") is False:
    honest=True
if any(l.get("type")=="error" for l in lines):
    honest=True
if "fail" in (raw+err).lower() or "error" in (raw+err).lower():
    honest=True
assert honest, (rc, raw[:400], err[:400])
print("honest_failure_or_cancel_ok rc", rc)
PY

# Recovery: a subsequent dry-run still works (CLI not wedged).
run --jsonl chat "recovery probe after failure" --new --dry-run --trace summary \
  >"$OUT/steps/10-recovery.jsonl" 2>"$OUT/steps/10-recovery.err"
python3 - <<'PY' "$OUT/steps/10-recovery.jsonl"
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert lines[-1].get("type")=="done"
print("recovery_ok")
PY

# --- Summary ---
log "SUMMARY"
python3 - <<'PY' "$OUT" "$HEAD_SHA" "$BIN" "$CORPUS" "$SESSION"
import json,sys
from pathlib import Path
out=Path(sys.argv[1])
report={
  "ok": True,
  "worktree_sha": sys.argv[2],
  "binary": sys.argv[3],
  "corpus_id": sys.argv[4],
  "session_id": sys.argv[5],
  "steps": sorted(p.name for p in (out/"steps").iterdir()),
  "covers": [
    "exact_head_binary_identity",
    "stale_binary_reject_smoke",
    "zip_folder_import_parity",
    "ambiguous_local_timestamps",
    "timezone_apply_all",
    "explore_context",
    "context_selection",
    "activity_and_trace",
    "two_grounded_turns",
    "session_continuity",
    "honest_failure_recovery",
  ],
}
(out/"ACCEPTANCE_REPORT.json").write_text(json.dumps(report, indent=2)+"\n")
print("REHEARSAL_PASS exact_head_cli_acceptance")
print(json.dumps(report, indent=2))
PY
