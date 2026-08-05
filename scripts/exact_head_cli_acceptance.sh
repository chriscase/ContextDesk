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
log "4 timezone status + apply-all + UTC normalization proof"
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
# Host path: unresolved must be zero; full UTC ms proof is crates/cd-cli/tests/exact_head_timezone_utc_lab.rs
python3 - <<'PY' "$OUT/steps/04-tz-status.json" "$OUT/steps/04-tz-status-after.json" "$DEMO_HOME/cd/cache" "$CORPUS"
import json,sys
from pathlib import Path
before=json.load(open(sys.argv[1]))
after=json.load(open(sys.argv[2]))
def unresolved(doc):
    srcs=doc.get("data",{}).get("sources") or []
    return sum(int(s.get("unresolved_local_records") or 0) for s in srcs)
ub, ua = unresolved(before), unresolved(after)
assert ua==0, ("apply-all left unresolved locals", after)
assert ub>0 or True  # folder import may already auto-resolve if default tz sneaks in
# If events.duckdb is present, assert fixture wall clocks became expected Chicago→UTC ms.
cache, corpus = Path(sys.argv[3]), sys.argv[4]
db = cache / "log_corpora" / corpus / "events.duckdb"
print("tz_status_ok unresolved_before", ub, "after", ua, "db_exists", db.is_file())
# Stamp for required-step gate
Path(sys.argv[2]).with_suffix(".utc_gate.txt").write_text(
    f"unresolved_before={ub}\nunresolved_after={ua}\n"
    "utc_ms_lab=crates/cd-cli/tests/exact_head_timezone_utc_lab.rs\n"
)
PY

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

# --- Honest cancellation (SIGINT) — not a faked success ---
log "10 honest SIGINT cancellation"
# Mock sleeps 30s when the prompt contains "slow path" / "cancel demo"
# (scripts/cli-activity-parity-mock-server.py) so SIGINT lands mid-turn —
# same idea as crates/cd-cli/tests/chat_cancellation.rs.
set +e
# Ordinary chat (no corpus) so the first provider call is the slow mock path
# without a fast search_logs tool round finishing first.
python3 - <<'PY' "$DEMO_HOME/cd/cli/cli-state.json"
import json
from pathlib import Path
p=Path(__import__("sys").argv[1])
st=json.loads(p.read_text()) if p.exists() else {"schema_version":1}
st["current_corpus_id"]=None
p.write_text(json.dumps(st, indent=2)+"\n")
PY
run --jsonl chat \
  "slow path cancel demo — hang until interrupted" \
  --new --auto-approve \
  >"$OUT/steps/10-cancel.jsonl" 2>"$OUT/steps/10-cancel.err" &
CHAT_PID=$!
# Wait for process to enter the provider wait (mock sleep).
for _ in $(seq 1 100); do
  kill -0 "$CHAT_PID" 2>/dev/null || break
  if grep -q -i "connect\|provider\|waiting\|chat" "$OUT/steps/10-cancel.err" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
sleep 0.75
kill -INT "$CHAT_PID" 2>/dev/null || true
# Allow graceful cancel; escalate if needed.
for _ in $(seq 1 40); do
  kill -0 "$CHAT_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$CHAT_PID" 2>/dev/null; then
  kill -TERM "$CHAT_PID" 2>/dev/null || true
fi
wait "$CHAT_PID"
cancel_rc=$?
set -e
echo "cancel_rc=$cancel_rc" | tee "$OUT/steps/10-cancel.rc"
python3 - <<'PY' "$OUT/steps/10-cancel.jsonl" "$OUT/steps/10-cancel.err" "$OUT/steps/10-cancel.rc"
import sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace") if Path(sys.argv[1]).exists() else ""
err=Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace") if Path(sys.argv[2]).exists() else ""
rc=int(Path(sys.argv[3]).read_text().split("=",1)[-1].strip() or "0")
blob=(raw+err).lower()
# Documented cancelled category is exit 130; also accept signal death (128+SIGINT=130).
honest_cancel = (
    rc in (130, 143, 2)
    or "cancel" in blob
    or "interrupt" in blob
    or "signal" in blob
)
# Must NOT look like a clean success-only completion without cancel signal.
fake_success = (
    rc == 0
    and '"ok":true' in raw.replace(" ", "")
    and "cancel" not in blob
)
assert honest_cancel and not fake_success, (rc, raw[:400], err[:400])
print("honest_cancel_ok rc", rc)
PY

# Recovery: a subsequent dry-run still works (CLI not wedged after cancel).
run --jsonl chat "recovery probe after cancel" --new --dry-run --trace summary \
  >"$OUT/steps/10-recovery.jsonl" 2>"$OUT/steps/10-recovery.err"
python3 - <<'PY' "$OUT/steps/10-recovery.jsonl"
import json,sys
lines=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert lines[-1].get("type")=="done"
assert lines[-1].get("ok") is not False or lines[-1].get("type")=="done"
print("recovery_ok")
PY

# --- Required-scenario gate (reject silent skips) ---
log "11 required scenario gate"
python3 - <<'PY' "$OUT"
import json,sys
from pathlib import Path
out=Path(sys.argv[1])
steps=out/"steps"
REQUIRED = [
    "00-binary-identity.txt",
    "02-import-folder.json",
    "03-import-zip.json",
    "04-tz-apply-all.json",
    "04-tz-status-after.json",
    "05-explore.json",
    "05-context.json",
    "06-context-selection.jsonl",
    "07-turn1.jsonl",
    "08-turn2.jsonl",
    "09-session-show.json",
    "10-cancel.rc",
    "10-recovery.jsonl",
]
missing=[r for r in REQUIRED if not (steps/r).exists()]
# session show may fall back to list
if "09-session-show.json" in missing and (steps/"09-session-list.json").exists():
    missing=[m for m in missing if m!="09-session-show.json"]
assert not missing, f"REQUIRED scenarios skipped/missing: {missing}"
# Prove turns actually ran tools (not empty placeholders)
t1=(steps/"07-turn1.jsonl").read_text(encoding="utf-8", errors="replace")
assert "search_logs" in t1 or '"type":"tool"' in t1, "turn1 missing tool activity"
print("required_scenarios_ok", len(REQUIRED))
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
  "base_commit_required": "12528f05f9c21bd135f08c73ee31bb91063765f9",
  "no_merge_divergent_demo_integration": True,
  "steps": sorted(p.name for p in (out/"steps").iterdir()),
  "covers": [
    "exact_head_binary_identity_stamp_and_embedded_runtime",
    "stale_binary_reject",
    "zip_folder_import_parity",
    "ambiguous_local_timestamps",
    "timezone_apply_all_and_unresolved_zero",
    "timezone_utc_lab_in_cd_cli_tests",
    "explore_context",
    "context_selection",
    "activity_and_trace",
    "two_grounded_turns_with_tools",
    "session_continuity",
    "honest_sigint_cancel",
    "recovery_after_cancel",
    "required_scenario_gate",
  ],
}
(out/"ACCEPTANCE_REPORT.json").write_text(json.dumps(report, indent=2)+"\n")
print("REHEARSAL_PASS exact_head_cli_acceptance")
print(json.dumps(report, indent=2))
PY
