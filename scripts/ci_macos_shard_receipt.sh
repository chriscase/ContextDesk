#!/usr/bin/env sh
# A named shard check may pass only after its native step and its precise
# assignment agree. The full aggregate independently verifies global coverage.
set -eu
idx=$1 count=$2 out=$3
dir="$out/shard-$idx"
expected=$(sh scripts/ci_shard_plan.sh shard "$idx" --os macos --shards "$count")
[ -n "$expected" ]
jq -e --argjson i "$idx" --argjson n "$count" --arg expected "$expected" '
  .os == "macos" and .shard == $i and .shards == $n and .status == "pass"
  and .units == ($expected | split("\n")) and .units_total == (.units | length)
  and .units_finished == .units_total and .tests_failed == 0 and .in_flight == null
  and .failed_units == []
' "$dir/status.json" >/dev/null
jq -e --argjson i "$idx" --argjson n "$count" --arg expected "$expected" '
  .schema == "cd.ci.shard_manifest.v1" and .os == "macos" and .shard == $i
  and .shards == $n and .status == "pass" and .units_finished == .units_total
  and .units_total == ($expected | split("\n") | length) and .in_flight == null and .tests_failed == 0
' "$dir/manifest.json" >/dev/null
