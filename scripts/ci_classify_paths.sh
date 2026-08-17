#!/usr/bin/env sh
# Classify changed paths for CI routing. Input is one repository-relative path
# per line. The default is the full Ubuntu Rust gate; only a wholly isolated
# bench or collaboration surface may opt out of the eight Ubuntu shards.

set -eu

bench_only=1
collab_only=1
changed_count=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  changed_count=$((changed_count + 1))
  case "$path" in
    crates/cd-triage-bench/* | docs/benchmarks/*)
      collab_only=0
      ;;
    collab/* | crates/cd-collab/* | docs/collab/*)
      bench_only=0
      ;;
    *)
      bench_only=0
      collab_only=0
      ;;
  esac
done

surface=full
run_ubuntu=true
if [ "$changed_count" -gt 0 ] && [ "$bench_only" -eq 1 ]; then
  surface=bench-only
  run_ubuntu=false
elif [ "$changed_count" -gt 0 ] && [ "$collab_only" -eq 1 ]; then
  surface=collab-only
  run_ubuntu=false
fi

printf 'surface=%s\n' "$surface"
printf 'run_ubuntu=%s\n' "$run_ubuntu"
printf 'changed_count=%s\n' "$changed_count"
