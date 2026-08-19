#!/usr/bin/env sh
# Classify changed paths for CI routing. Input is one repository-relative path
# per line. The default is the full Ubuntu Rust gate; only a wholly isolated
# surface may opt out of the eight Ubuntu shards.
#
# A surface is isolated only when no crate outside it depends on it. That is a
# property of the workspace, not of the changed paths, so it is enforced by
# scripts/tests/ci_path_filter_test.sh rather than assumed here.
#
# `crates/cd-triage-bench/**` deliberately has NO isolated route. The bench
# crate is a library with shipped in-workspace dependents — the `contextdesk`
# binary among them — so a change confined to it can break code that the
# isolated lane would never compile. It takes the full gate like any other
# crate.

set -eu

collab_only=1
changed_count=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  changed_count=$((changed_count + 1))
  case "$path" in
    collab/* | crates/cd-collab/* | docs/collab/*)
      ;;
    *)
      collab_only=0
      ;;
  esac
done

surface=full
run_ubuntu=true
if [ "$changed_count" -gt 0 ] && [ "$collab_only" -eq 1 ]; then
  surface=collab-only
  run_ubuntu=false
fi

printf 'surface=%s\n' "$surface"
printf 'run_ubuntu=%s\n' "$run_ubuntu"
printf 'changed_count=%s\n' "$changed_count"
