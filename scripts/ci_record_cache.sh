#!/usr/bin/env sh
# Record an honest rust-cache restore result for CI cache ownership (#874).
#
# Swatinem/rust-cache exposes `cache-hit` only for an exact key match. A miss
# is always recorded as cold. An exact hit is still cold when --restore-dir
# is set and that directory was not populated — `lookup-only: true` reports
# a hit without downloading files (hosted run 31845262696).
#
# `cache_state` is `warm` only when the files are actually present *and*
# look like a compiled workspace (debug/deps rust artifacts plus DuckDB).
# A top-level CACHEDIR.TAG or empty target/ is still cold.
#
# No network, no secrets. Requires: jq.
set -eu

OUT=""
HIT=""
ROLE=""
SHARD=""
SHARED_KEY="ubuntu-workspace-tests"
SAVE=""
RESTORE_DIR=""
FINGERPRINT=""
ASSERT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_record_cache.sh --out FILE --hit true|false|'' --role warmup|preflight|shard
                                [--shard N] [--shared-key NAME] [--save true|false]
                                [--restore-dir DIR] [--fingerprint HEX]
  sh scripts/ci_record_cache.sh --assert-dir DIR

Writes a bounded JSON object. `cache_state` is `warm` only when --hit is true
AND, if --restore-dir is set, that directory contains compiled workspace
artifacts including bundled DuckDB. Swatinem `lookup-only: true` reports
cache-hit without downloading files; never use it on the shard jobs.

`--assert-dir` exits 0 only when DIR looks like a compiled workspace with
DuckDB artifacts. Warmup jobs use it after `cargo test --workspace --no-run`
so a successful compile that skipped DuckDB cannot save a hollow cache.
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
    --restore-dir)
      [ $# -ge 2 ] || die "--restore-dir needs a value"
      RESTORE_DIR=$2
      shift 2
      ;;
    --fingerprint)
      [ $# -ge 2 ] || die "--fingerprint needs a value"
      FINGERPRINT=$2
      shift 2
      ;;
    --assert-dir)
      [ $# -ge 2 ] || die "--assert-dir needs a value"
      ASSERT_DIR=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'" ;;
  esac
done

# True when PATH is a regular, non-empty file. Empty files and directories
# are not compiled artifacts.
is_nonzero_file() {
  [ -f "$1" ] && [ -s "$1" ]
}

# True when PATH looks like a linkable compiled object on Linux, macOS, or
# Windows (static lib, rust rlib, import lib, or shared library).
is_compiled_lib() {
  is_nonzero_file "$1" || return 1
  case $1 in
    *.rlib | *.rmeta | *.lib | *.a | *.so | *.dylib | *.dll | *.obj) return 0 ;;
  esac
  return 1
}

# True when PATH's basename mentions duckdb (any common capitalization).
name_mentions_duckdb() {
  base=${1##*/}
  case $base in
    *[Dd]uck[Dd][Bb]*) return 0 ;;
  esac
  return 1
}

# A restore is honest only when a real DuckDB artifact exists. An empty
# libduckdb-sys-* directory, a zero-byte stub, or CACHEDIR.TAG is not enough.
has_duckdb_artifact() {
  dir=$1
  if [ -d "$dir/debug/deps" ]; then
    for probe in "$dir"/debug/deps/*; do
      [ -e "$probe" ] || continue
      if name_mentions_duckdb "$probe" && is_compiled_lib "$probe"; then
        return 0
      fi
    done
  fi
  for d in "$dir"/debug/build/libduckdb-sys-* "$dir"/debug/build/duckdb-*; do
    [ -d "$d" ] || continue
    for probe in "$d"/* "$d"/out/* "$d"/out/.libs/*; do
      [ -e "$probe" ] || continue
      if name_mentions_duckdb "$probe" && is_compiled_lib "$probe"; then
        return 0
      fi
    done
  done
  return 1
}

has_compiled_deps() {
  dir=$1
  [ -d "$dir/debug/deps" ] || return 1
  for probe in "$dir"/debug/deps/*; do
    [ -e "$probe" ] || continue
    if is_compiled_lib "$probe"; then
      return 0
    fi
  done
  return 1
}

# Classify a restored/compiled target tree. Prints one of:
#   empty | no-artifacts | no-duckdb | ok
classify_target() {
  dir=$1
  if [ ! -d "$dir" ]; then
    echo empty
    return 0
  fi
  any=false
  for probe in "$dir"/*; do
    if [ -e "$probe" ]; then
      any=true
      break
    fi
  done
  if [ "$any" = false ]; then
    echo empty
    return 0
  fi

  if ! has_compiled_deps "$dir"; then
    echo no-artifacts
    return 0
  fi
  if ! has_duckdb_artifact "$dir"; then
    echo no-duckdb
    return 0
  fi
  echo ok
}

if [ -n "$ASSERT_DIR" ]; then
  kind=$(classify_target "$ASSERT_DIR")
  case $kind in
    ok)
      echo "ci_record_cache: $ASSERT_DIR has compiled workspace + DuckDB artifacts"
      exit 0
      ;;
    empty)
      echo "ci_record_cache: $ASSERT_DIR is missing or empty" >&2
      ;;
    no-artifacts)
      echo "ci_record_cache: $ASSERT_DIR has no compiled rust deps (target/debug/deps)" >&2
      ;;
    no-duckdb)
      echo "ci_record_cache: $ASSERT_DIR is missing bundled DuckDB artifacts" >&2
      ;;
  esac
  exit 1
fi

[ -n "$OUT" ] || die "--out is required"
[ -n "$ROLE" ] || die "--role is required"
case $ROLE in
  warmup | preflight | shard) ;;
  *) die "--role must be warmup, preflight, or shard, got '$ROLE'" ;;
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

RESTORE="none"
if [ "$STATE" = warm ] && [ -n "$RESTORE_DIR" ]; then
  case $(classify_target "$RESTORE_DIR") in
    ok) RESTORE=files ;;
    empty)
      STATE=cold
      RESTORE=key-hit-without-files
      ;;
    no-artifacts)
      STATE=cold
      RESTORE=key-hit-without-artifacts
      ;;
    no-duckdb)
      STATE=cold
      RESTORE=key-hit-without-duckdb
      ;;
  esac
elif [ "$STATE" = warm ]; then
  RESTORE=assumed
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
  --arg restore "$RESTORE" \
  --arg fingerprint "$FINGERPRINT" \
  --argjson hit "$HIT_JSON" \
  --argjson save "$SAVE_JSON" \
  --argjson shard "$shard_json" \
  '{schema: $schema, role: $role, shard: $shard, shared_key: $key,
    cache_hit: $hit, cache_state: $state, save: $save, restore: $restore,
    fingerprint: (if $fingerprint == "" then null else $fingerprint end)}' \
  >"$OUT"

echo "cache record: role=$ROLE state=$STATE hit=$HIT_JSON save=$SAVE_JSON restore=$RESTORE key=$SHARED_KEY fingerprint=${FINGERPRINT:-none}"
