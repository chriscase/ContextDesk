#!/usr/bin/env sh
# Record an honest rust-cache restore result for Ubuntu CI shards (#874).
#
# Swatinem/rust-cache exposes `cache-hit` only for an exact key match. A miss
# is always recorded as cold — including prefix restores — so a later job
# cannot claim a warm cache it did not actually get.
#
# No network, no secrets. Requires: jq.
set -eu

OUT=""
HIT=""
ROLE=""
SHARD=""
SHARED_KEY="ubuntu-workspace-tests"
SAVE=""

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_record_cache.sh --out FILE --hit true|false|'' --role warmup|shard
                                [--shard N] [--shared-key NAME] [--save true|false]

Writes a bounded JSON object. `cache_state` is `warm` only when --hit is true.
EOF
}

die() {
  echo "ci_record_cache: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --out)
      [ $# -ge 2 ] || die "--out needs a value"
      OUT=$2
      shift 2
      ;;
    --hit)
      [ $# -ge 2 ] || die "--hit needs a value"
      HIT=$2
      shift 2
      ;;
    --role)
      [ $# -ge 2 ] || die "--role needs a value"
      ROLE=$2
      shift 2
      ;;
    --shard)
      [ $# -ge 2 ] || die "--shard needs a value"
      SHARD=$2
      shift 2
      ;;
    --shared-key)
      [ $# -ge 2 ] || die "--shared-key needs a value"
      SHARED_KEY=$2
      shift 2
      ;;
    --save)
      [ $# -ge 2 ] || die "--save needs a value"
      SAVE=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[ -n "$OUT" ] || die "--out is required"
[ -n "$ROLE" ] || die "--role is required"
case $ROLE in
  warmup | shard) ;;
  *) die "--role must be warmup or shard, got '$ROLE'" ;;
esac

# GitHub expressions can yield true, false, empty, or the literal '<nil>'.
# Only an explicit true is a warm exact hit.
case $HIT in
  true | True | TRUE) HIT_JSON=true STATE=warm ;;
  *) HIT_JSON=false STATE=cold ;;
esac

if [ -z "$SAVE" ]; then
  if [ "$ROLE" = warmup ]; then SAVE_JSON=true; else SAVE_JSON=false; fi
else
  case $SAVE in
    true | True | TRUE) SAVE_JSON=true ;;
    false | False | FALSE) SAVE_JSON=false ;;
    *) die "--save must be true or false, got '$SAVE'" ;;
  esac
fi

dir=$(dirname "$OUT")
mkdir -p "$dir"

if [ -n "$SHARD" ]; then
  shard_json=$SHARD
else
  shard_json=null
fi

jq -n \
  --arg schema "cd.ci.cache_status.v1" \
  --arg role "$ROLE" \
  --arg state "$STATE" \
  --arg key "$SHARED_KEY" \
  --argjson hit "$HIT_JSON" \
  --argjson save "$SAVE_JSON" \
  --argjson shard "$shard_json" \
  '{schema: $schema, role: $role, shard: $shard, shared_key: $key,
    cache_hit: $hit, cache_state: $state, save: $save}' \
  >"$OUT"

echo "cache record: role=$ROLE state=$STATE hit=$HIT_JSON save=$SAVE_JSON key=$SHARED_KEY"
