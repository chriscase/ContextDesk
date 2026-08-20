#!/usr/bin/env bash
set -euo pipefail

umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
requested_base="${1:-/private/tmp}"

case "$requested_base" in
  /private/tmp|/private/tmp/*|/tmp|/tmp/*) ;;
  *)
    echo "refusing non-temporary destination: $requested_base" >&2
    echo "use /private/tmp (recommended) or /tmp" >&2
    exit 2
    ;;
esac

base_parent="$(dirname "$requested_base")"
if [[ ! -d "$base_parent" ]]; then
  echo "refusing destination whose parent does not already exist: $requested_base" >&2
  exit 2
fi
base_parent="$(cd "$base_parent" && pwd -P)"
base="$base_parent/$(basename "$requested_base")"

case "$base" in
  /private/tmp|/private/tmp/*|/tmp|/tmp/*) ;;
  *)
    echo "refusing non-temporary destination: $base" >&2
    echo "use /private/tmp (recommended) or /tmp" >&2
    exit 2
    ;;
esac

mkdir -p "$base"
base="$(cd "$base" && pwd -P)"

case "$base" in
  /private/tmp|/private/tmp/*|/tmp|/tmp/*) ;;
  *)
    echo "refusing destination that resolves outside a temporary directory: $base" >&2
    exit 2
    ;;
esac

workspace="$(mktemp -d "$base/contextdesk-private-comparison.XXXXXX")"
chmod 700 "$workspace"

install -m 600 \
  "$repo_root/collab/contracts/fixtures/experiment-package.two-approach.valid.json" \
  "$workspace/01-experiment-package.json"
install -m 600 \
  "$repo_root/collab/contracts/fixtures/plain-transcript.incomplete.json" \
  "$workspace/02-external-chat-transcript.json"
install -m 600 \
  "$repo_root/collab/contracts/fixtures/interaction-trace.programmatic.json" \
  "$workspace/03-contextdesk-programmatic-trace.json"
install -m 600 \
  "$repo_root/collab/contracts/fixtures/gold-reference.valid.json" \
  "$workspace/04-gold-reference-structure-only.json"

echo "Private comparison workspace created:"
echo "$workspace"
echo "Permissions: owner-only (directory 700, files 600)."
echo "Replace every synthetic value with redacted or opaque local-only values."
echo "The gold file is a structure reference only; promote the reviewed accepted decision in Experiment Lab."
echo "Do not copy the completed files into the repository."
echo "Runbook: $repo_root/docs/benchmarks/CONTEXTDESK_DEMO_RUNBOOK.md"
