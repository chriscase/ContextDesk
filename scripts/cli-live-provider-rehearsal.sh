#!/usr/bin/env bash
set -euo pipefail

# Repeatable, data-free rehearsal for the ContextDesk CLI demo path.
#
# Offline (default): ZIP import -> explore -> bounded context -> dry-run trace.
# Live: the same ZIP path plus two grounded, traced turns against a provider
# already configured in a ContextDesk data directory. Only this script's
# synthetic fixture is sent to the provider.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${CONTEXTDESK_REHEARSAL_BIN:-$repo_root/target/release/contextdesk}"
mode="${CONTEXTDESK_REHEARSAL_MODE:-offline}"
keep="${CONTEXTDESK_REHEARSAL_KEEP:-0}"
source_data_dir="${CONTEXTDESK_REHEARSAL_DATA_DIR:-}"

if [[ ! -x "$binary" ]]; then
  echo "Building the release CLI..." >&2
  cargo build --locked --release -p cd-cli --manifest-path "$repo_root/Cargo.toml"
fi

run_root="$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-cli-rehearsal.XXXXXX")"
run_data="$run_root/data"
fixture_dir="$run_root/fixture"
output_dir="$run_root/output"
mkdir -p "$run_data" "$fixture_dir" "$output_dir"

cleanup() {
  if [[ "$keep" == "1" ]]; then
    echo "Rehearsal artifacts retained at: $run_root" >&2
  else
    rm -rf -- "$run_root"
  fi
}
trap cleanup EXIT

if [[ "$mode" == "live" ]]; then
  if [[ -z "$source_data_dir" || ! -f "$source_data_dir/config.json" ]]; then
    echo "Live mode requires CONTEXTDESK_REHEARSAL_DATA_DIR pointing to a configured ContextDesk data directory." >&2
    exit 2
  fi
  # Copy only provider configuration. Corpus/session state stays disposable;
  # credential material remains in the OS keychain and is never copied.
  cp "$source_data_dir/config.json" "$run_data/config.json"
elif [[ "$mode" == "offline" ]]; then
  "$binary" --data-dir "$run_data" --json config init \
    --non-interactive --skip-provider --default-timezone UTC \
    >"$output_dir/config.json"
else
  echo "CONTEXTDESK_REHEARSAL_MODE must be 'offline' or 'live'." >&2
  exit 2
fi

python3 - "$fixture_dir/synthetic-incident.zip" <<'PY'
import sys
import zipfile

archive = sys.argv[1]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr(
        "region-a/app.log",
        '{"ts":"2026-01-12T09:15:00Z","level":"ERROR","service":"worker","message":"SYNTH_QUEUE_STALL queue stalled correlation=demo-42"}\n'
        '{"ts":"2026-01-12T09:14:58Z","level":"INFO","service":"config","message":"SYNTH_POOL_CHANGE db_pool_max changed 32 to 4 correlation=demo-42"}\n',
    )
    z.writestr("docs/screenshot.png", b"\x89PNG\r\n\x1a\n\x00synthetic-binary-attachment")
PY

archive="$fixture_dir/synthetic-incident.zip"
cli=("$binary" --data-dir "$run_data")

"${cli[@]}" --json import "$archive" --explain-selection \
  | tee "$output_dir/import.json"
"${cli[@]}" --json explore SYNTH_QUEUE_STALL \
  | tee "$output_dir/explore.json"
"${cli[@]}" --json context "What happened around correlation demo-42?" \
  | tee "$output_dir/context.json"

if [[ "$mode" == "offline" ]]; then
  "${cli[@]}" --jsonl chat \
    "Find the synthetic queue-stall event and cite its exact seq and source." \
    --new --dry-run --trace context \
    | tee "$output_dir/dry-run.jsonl"
  python3 - "$output_dir/import.json" "$output_dir/explore.json" "$output_dir/context.json" "$output_dir/dry-run.jsonl" <<'PY'
import json
import sys

imp, explore, context = [json.load(open(path, encoding="utf-8")) for path in sys.argv[1:4]]
lines = [json.loads(line) for line in open(sys.argv[4], encoding="utf-8") if line.strip()]
assert imp["ok"] and imp["data"]["events_imported"] == 2 and imp["data"]["sources_failed"] == 0
assert imp["data"]["sources_unsupported"] == 1
assert explore["ok"] and explore["data"]["hits"]
assert context["ok"] and context["data"]["evidence"]
assert lines[-1]["type"] == "done" and lines[-1]["ok"] is True
assert any(line["type"] == "trace_context" for line in lines)
print("REHEARSAL_PASS mode=offline zip_import=pass explore=pass context=pass dry_run_zero_network=pass")
PY
  exit 0
fi

"${cli[@]}" --jsonl chat \
  "Find the synthetic queue-stall event and cite its exact seq and source." \
  --new --trace full --trace-ack \
  | tee "$output_dir/turn-1.jsonl"

first_session="$(python3 - "$output_dir/turn-1.jsonl" <<'PY'
import json
import sys

lines = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert lines[-1]["type"] == "done" and lines[-1]["ok"] is True
assert any(
    line.get("type") == "tool"
    and line.get("name") == "search_logs"
    and line.get("ok") is True
    for line in lines
)
assert all(line.get("ok") is True for line in lines if line.get("type") == "tool")
summary = next(line for line in lines if line.get("type") == "trace_summary")
assert summary["grounding"] == "grounded"
assert lines[-1]["session_id"]
print(lines[-1]["session_id"])
PY
)"

"${cli[@]}" --jsonl chat \
  "In that same incident, what configuration change happened immediately before it? Cite exact seq and source." \
  --trace full --trace-ack \
  | tee "$output_dir/turn-2.jsonl"

python3 - "$first_session" "$output_dir/turn-2.jsonl" <<'PY'
import json
import sys

def read(path):
    return [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]

def verify(lines):
    assert lines[-1]["type"] == "done" and lines[-1]["ok"] is True
    assert any(
        line.get("type") == "tool"
        and line.get("name") == "search_logs"
        and line.get("ok") is True
        for line in lines
    )
    assert all(line.get("ok") is True for line in lines if line.get("type") == "tool")
    summary = next(line for line in lines if line.get("type") == "trace_summary")
    assert summary["grounding"] == "grounded"
    return lines[-1]["session_id"]

first = sys.argv[1]
second = verify(read(sys.argv[2]))
assert first == second
print("REHEARSAL_PASS mode=live zip_import=pass native_tools=pass grounding=pass trace=pass two_turn_session=pass")
PY
