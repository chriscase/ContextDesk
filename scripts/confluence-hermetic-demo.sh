#!/usr/bin/env bash
# Hermetic Confluence connector demo — no real Atlassian account/token/tenant.
# Runs focused cd-core contract + unit proofs. Failures abort (set -e).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Prefer shared/workspace target when set by the environment; otherwise use
# the repo-local default Cargo layout (no hardcoded absolute user paths).
if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
  # Sibling primary checkout target if present (optional speed-up only).
  if [[ -d "$ROOT/../ContextDesk/target" ]]; then
    export CARGO_TARGET_DIR="$(cd "$ROOT/../ContextDesk/target" && pwd)"
  fi
fi

echo "=== Confluence hermetic demo (mock only) ==="
echo "ROOT=$ROOT"
echo "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-(cargo default)}"
echo

echo "1) Focused connector contract (ToolHost + wiremock):"
cargo test -p cd-core --test confluence_connector_contract -- --nocapture
echo

echo "2) RO client unit + wiremock suite (plain conversion + REST):"
cargo test -p cd-core --lib confluence_ro -- --nocapture
echo

echo "3) Config defaults (disabled / write off) + auth_from_pat:"
cargo test -p cd-core --lib config::tests::confluence -- --nocapture
echo

echo "=== Demo complete. No live Atlassian traffic was used. ==="
echo "Future free-site setup (manual, not performed by this script):"
echo "  - Create an Atlassian Cloud free site when you choose to"
echo "  - Create an API token in Atlassian account settings"
echo "  - Settings → Connectors → Confluence: enable, base URL, auth mode (Basic+email for Cloud),"
echo "    spaces, save token (keychain ref only: confluence/default/pat)"
echo "  - Leave write_enabled off until you need HardWrite create/update"
echo "  - CLI: contextdesk confluence status|search|get-page"
echo "  - Never commit tokens; never journal page bodies in Activity"
