#!/usr/bin/env bash
# Hermetic quality-eval suite matrix (open-v1 + adversarial-v1 by default).
# No network, credentials, or readiness-store mutation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export CXX="${CXX:-g++}"
export CC="${CC:-gcc}"
export LIBRARY_PATH="${LIBRARY_PATH:-/usr/lib/gcc/x86_64-linux-gnu/13:/usr/lib/x86_64-linux-gnu}"

OUT="${1:-}"
FORCE_ARGS=()
if [[ "${2:-}" == "--force" ]] || [[ "${OUT}" == "--force" ]]; then
  FORCE_ARGS=(--force)
  if [[ "${OUT}" == "--force" ]]; then
    OUT=""
  fi
fi

BIN=(cargo run -q -p cd-core --bin cd-quality-eval-lab --)

echo "== validate open-v1 =="
"${BIN[@]}" validate --suite fixtures/quality-eval/open-v1

echo "== validate adversarial-v1 =="
"${BIN[@]}" validate --suite fixtures/quality-eval/adversarial-v1

echo "== run open-v1 =="
"${BIN[@]}" run --suite fixtures/quality-eval/open-v1 >/tmp/quality-eval-open-v1-run.json
echo "wrote /tmp/quality-eval-open-v1-run.json (temp; not readiness evidence)"

echo "== run adversarial-v1 =="
"${BIN[@]}" run --suite fixtures/quality-eval/adversarial-v1 >/tmp/quality-eval-adversarial-v1-run.json
echo "wrote /tmp/quality-eval-adversarial-v1-run.json (temp; not readiness evidence)"

echo "== combined safe matrix summary =="
if [[ -n "${OUT}" ]]; then
  "${BIN[@]}" matrix --suite open-v1 --suite adversarial-v1 --output "${OUT}" "${FORCE_ARGS[@]}"
else
  "${BIN[@]}" matrix --suite open-v1 --suite adversarial-v1
fi
