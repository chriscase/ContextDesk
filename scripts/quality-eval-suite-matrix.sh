#!/usr/bin/env bash
# Hermetic quality-eval suite matrix (open-v1 + adversarial-v1 by default).
# No network, credentials, or readiness-store mutation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
"${BIN[@]}" run --suite fixtures/quality-eval/open-v1 >/dev/null
echo "open-v1 hermetic run completed (not readiness evidence)"

echo "== run adversarial-v1 =="
"${BIN[@]}" run --suite fixtures/quality-eval/adversarial-v1 >/dev/null
echo "adversarial-v1 hermetic run completed (not readiness evidence)"

echo "== combined safe matrix summary =="
if [[ -n "${OUT}" ]]; then
  "${BIN[@]}" matrix --suite open-v1 --suite adversarial-v1 --output "${OUT}" "${FORCE_ARGS[@]}"
else
  "${BIN[@]}" matrix --suite open-v1 --suite adversarial-v1
fi
