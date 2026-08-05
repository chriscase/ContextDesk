#!/usr/bin/env bash
# Hermetic Confluence connector demo — no real Atlassian account/token/tenant.
# Starts a mock REST surface, runs cd-core contract tests, prints status.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Users/chriscase/Documents/GitHub/ContextDesk/target}"
cd "$ROOT"

echo "=== Confluence hermetic demo (mock only) ==="
echo "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "Worktree: $ROOT"
echo
echo "1) Focused connector contract (ToolHost + wiremock):"
cargo test -p cd-core --test confluence_connector_contract -- --nocapture
echo
echo "2) RO client unit + wiremock suite:"
cargo test -p cd-core --lib confluence_ro -- --nocapture
echo
echo "3) Config defaults (disabled / write off):"
cargo test -p cd-core --lib config::tests::confluence_not_configured_when_disabled -- --nocapture || true
echo
echo "=== Demo complete. No live Atlassian traffic was used. ==="
echo "Future free-site setup (manual, not performed by this script):"
echo "  - Create an Atlassian Cloud free site when you choose to"
echo "  - Create an API token in Atlassian account settings"
echo "  - Settings → Connectors → Confluence: enable, base URL, spaces, save token (keychain ref only)"
echo "  - Leave write_enabled off until you need HardWrite create/update"
echo "  - Never commit tokens; pat_ref is confluence/default/pat"
