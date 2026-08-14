#!/usr/bin/env sh
# Deterministic shard plan for the Ubuntu workspace test gate (#874).
#
# The Linux gate used to be a single `cargo test --workspace` step that ran for
# 70-80 minutes; when the hosted runner lost its connection GitHub marked the
# job failed with the step still `in_progress` and no log blob at all.  The
# suite is now split into a fixed number of shards, and this script owns the
# partition so CI, the aggregate gate, and local reproduction all agree on it.
#
# Coverage is preserved by construction: the unit list comes from
# `cargo metadata`, which is Cargo's own view of the workspace, so a test
# target cannot silently escape the gate.  Every testable target lands in
# exactly one shard and `verify` fails closed if that ever stops being true.
#
# A "unit" is the smallest thing `cargo test` can be pointed at:
#
#   <pkg>/lib          unit tests inside the library target      (--lib)
#   <pkg>/bins         unit tests inside the binary targets      (--bins)
#   <pkg>/doc          documentation tests                       (--doc)
#   <pkg>/test/<name>  one integration test target               (--test <name>)
#
# No network, no cargo build, no secrets.  Requires: cargo, jq.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DEFAULT_SHARDS=4

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_shard_plan.sh units                    # every test unit, canonical order
  sh scripts/ci_shard_plan.sh plan   [--shards N]      # "<shard>\t<unit>" for every unit
  sh scripts/ci_shard_plan.sh shard  K [--shards N]    # units assigned to shard K
  sh scripts/ci_shard_plan.sh args   UNIT              # cargo selector args for one unit
  sh scripts/ci_shard_plan.sh verify [--shards N]      # fail closed if the partition is not
                                                       # exhaustive, disjoint, and balanced

Options:
  --shards N   number of shards (default: $CD_SHARD_COUNT, else 4)

The partition is round-robin over the canonically sorted unit list, so it is a
pure function of the commit: the same tree always produces the same plan on
every runner and on a developer laptop.
EOF
}

die() {
  echo "ci_shard_plan: $*" >&2
  exit 1
}

metadata() {
  cargo metadata --no-deps --format-version 1 --manifest-path "$ROOT/Cargo.toml"
}

# A library target can be declared under any of these crate types; `--lib`
# selects it in every case.  Kept in one place so `enumerate_units` and the
# unmapped-target guard below cannot drift apart.
LIB_KINDS='["lib","rlib","dylib","cdylib","staticlib","proc-macro"]'

# Every testable target in the root workspace, in a canonical, locale-stable
# order.  `--no-deps` keeps this to workspace members and avoids touching the
# network: it does not resolve or download dependencies.
enumerate_units() {
  metadata |
    jq -r --argjson libkinds "$LIB_KINDS" '
      ([$libkinds[]] | map({(.): true}) | add) as $lib
      | .packages[] as $p
      | $p.targets[] as $t
      | (any($t.kind[]; $lib[.] == true)) as $is_lib
      | [
          (if $is_lib and $t.test                            then [$p.name, 0, "", "\($p.name)/lib"]  else empty end),
          (if ($t.kind | index("bin")) != null and $t.test   then [$p.name, 1, "", "\($p.name)/bins"] else empty end),
          (if $is_lib and $t.doctest                         then [$p.name, 2, "", "\($p.name)/doc"]  else empty end),
          (if ($t.kind | index("test")) != null and $t.test  then [$p.name, 3, $t.name, "\($p.name)/test/\($t.name)"] else empty end)
        ][]
      | @tsv
    ' |
    LC_ALL=C sort -u |
    cut -f4
}

# Any target `cargo test` would pick up but this script does not know how to
# turn into a unit -- a bench target, or an example with `test = true`.  Rather
# than let it fall outside the gate, the plan refuses to run until someone
# teaches the enumeration about it.
unmapped_targets() {
  metadata |
    jq -r --argjson libkinds "$LIB_KINDS" '
      ([$libkinds[]] | map({(.): true}) | add) as $lib
      | .packages[] as $p
      | $p.targets[]
      | select(.test or .doctest)
      | select(
          (any(.kind[]; $lib[.] == true) | not)
          and (.kind | index("bin")) == null
          and (.kind | index("test")) == null
        )
      | "\($p.name): \(.kind | join(",")) target \(.name)"
    '
}

# Cached enumeration: several subcommands need the list more than once and
# `cargo metadata` is the only slow part of this script.
UNITS_CACHE=""
units() {
  if [ -z "$UNITS_CACHE" ]; then
    UNITS_CACHE=$(enumerate_units)
    [ -n "$UNITS_CACHE" ] || die "no test units found - cargo metadata returned nothing usable"
    # Unit ids are split on whitespace when they become cargo arguments, so a
    # target name containing whitespace must fail the plan rather than silently
    # drop half a selector.
    case $UNITS_CACHE in
      *" "* | *"	"*) die "target name contains whitespace; shard selectors cannot be built safely" ;;
    esac
  fi
  printf '%s\n' "$UNITS_CACHE"
}

shard_count() {
  count=${1:-}
  [ -n "$count" ] || count=${CD_SHARD_COUNT:-$DEFAULT_SHARDS}
  case $count in
    '' | *[!0-9]*) die "shard count must be a positive integer, got '$count'" ;;
  esac
  [ "$count" -ge 1 ] || die "shard count must be >= 1, got '$count'"
  printf '%s\n' "$count"
}

# Round-robin over the canonical order: index N goes to shard (N mod shards)+1.
# Deterministic, exhaustive, and it keeps the heavy cd-core integration targets
# spread evenly instead of piling them into one shard.
plan() {
  shards=$1
  units | awk -v shards="$shards" '{ printf "%d\t%s\n", (NR - 1) % shards + 1, $0 }'
}

shard() {
  want=$1
  shards=$2
  case $want in
    '' | *[!0-9]*) die "shard index must be a positive integer, got '$want'" ;;
  esac
  [ "$want" -ge 1 ] && [ "$want" -le "$shards" ] ||
    die "shard index $want is outside 1..$shards"
  plan "$shards" | awk -F'\t' -v want="$want" '$1 == want { print $2 }'
}

# Translate a unit id into the cargo selector that runs exactly that unit.
args_for() {
  unit=$1
  pkg=${unit%%/*}
  rest=${unit#*/}
  [ -n "$pkg" ] && [ "$pkg" != "$unit" ] || die "malformed unit id '$unit'"
  case $rest in
    lib) printf -- '-p %s --lib\n' "$pkg" ;;
    bins) printf -- '-p %s --bins\n' "$pkg" ;;
    doc) printf -- '-p %s --doc\n' "$pkg" ;;
    test/*) printf -- '-p %s --test %s\n' "$pkg" "${rest#test/}" ;;
    *) die "unknown unit kind in '$unit'" ;;
  esac
}

# Fail closed on anything that would let a test escape the gate.
verify() {
  shards=$1
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-plan.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  failures=0

  units >"$tmp/units"
  plan "$shards" >"$tmp/plan"

  total=$(wc -l <"$tmp/units" | tr -d ' ')
  echo "shard plan: $total test units across $shards shards"

  # 1. No unit may be listed twice: a duplicate would run twice and, worse,
  #    hide a genuinely missing target behind a matching total.
  dupes=$(LC_ALL=C sort "$tmp/units" | uniq -d)
  if [ -n "$dupes" ]; then
    echo "error: duplicate test units in the enumeration:" >&2
    printf '%s\n' "$dupes" >&2
    failures=$((failures + 1))
  fi

  # 2. The union of the shards must be exactly the full unit list.  This is
  #    true by construction today; it is checked so a future change to the
  #    assignment cannot quietly drop or double-run a target.
  cut -f2 "$tmp/plan" | LC_ALL=C sort >"$tmp/assigned"
  LC_ALL=C sort "$tmp/units" >"$tmp/expected"
  if ! diff -u "$tmp/expected" "$tmp/assigned" >"$tmp/diff" 2>&1; then
    echo "error: shard assignment is not an exact partition of the workspace:" >&2
    cat "$tmp/diff" >&2
    failures=$((failures + 1))
  fi

  # 3. Every shard index in 1..N must own at least one unit, otherwise a shard
  #    job would report a vacuous pass.
  i=1
  while [ "$i" -le "$shards" ]; do
    n=$(awk -F'\t' -v want="$i" '$1 == want { c++ } END { print c + 0 }' "$tmp/plan")
    if [ "$n" -eq 0 ]; then
      echo "error: shard $i is empty; reduce the shard count" >&2
      failures=$((failures + 1))
    fi
    echo "  shard $i/$shards: $n units"
    i=$((i + 1))
  done

  # 4. No target that `cargo test` would run may be left unmapped: a bench
  #    target or a `test = true` example would otherwise be quietly excluded.
  unmapped=$(unmapped_targets)
  if [ -n "$unmapped" ]; then
    echo "error: these targets are testable but belong to no shard unit:" >&2
    printf '  %s\n' "$unmapped" >&2
    echo "  teach scripts/ci_shard_plan.sh how to select them before merging" >&2
    failures=$((failures + 1))
  fi

  # 5. Independent cross-check against the filesystem.  `cargo metadata` and
  #    the crates/*/tests tree have to agree, so a metadata parsing regression
  #    that silently drops integration targets cannot pass unnoticed.
  metadata | jq -r '.packages[] | "\(.manifest_path)\t\(.name)"' >"$tmp/manifests"
  for file in "$ROOT"/crates/*/tests/*.rs; do
    [ -e "$file" ] || continue
    manifest=$(dirname "$(dirname "$file")")/Cargo.toml
    pkg=$(awk -F'\t' -v m="$manifest" '$1 == m { print $2 }' "$tmp/manifests")
    if [ -z "$pkg" ]; then
      echo "error: $file has no workspace package (is its crate a workspace member?)" >&2
      failures=$((failures + 1))
      continue
    fi
    stem=$(basename "$file" .rs)
    if ! grep -qxF "$pkg/test/$stem" "$tmp/units"; then
      echo "error: integration test $file is in no shard" >&2
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -ne 0 ]; then
    echo "shard plan verification FAILED ($failures problem(s))" >&2
    exit 1
  fi
  echo "shard plan verified: exhaustive, disjoint, no empty shard"
}

[ $# -ge 1 ] || {
  usage >&2
  exit 2
}

cmd=$1
shift

# Shared option parsing: --shards N is accepted after any subcommand.
shards_opt=""
positional=""
while [ $# -gt 0 ]; do
  case $1 in
    --shards)
      [ $# -ge 2 ] || die "--shards needs a value"
      shards_opt=$2
      shift 2
      ;;
    --shards=*)
      shards_opt=${1#--shards=}
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*) die "unknown option '$1'" ;;
    *)
      positional="${positional:+$positional }$1"
      shift
      ;;
  esac
done

case $cmd in
  units) units ;;
  plan) plan "$(shard_count "$shards_opt")" ;;
  shard)
    [ -n "$positional" ] || die "shard needs an index, e.g. 'shard 2 --shards 4'"
    shard "$positional" "$(shard_count "$shards_opt")"
    ;;
  args)
    [ -n "$positional" ] || die "args needs a unit id, e.g. 'args cd-core/test/golden_retrieval'"
    args_for "$positional"
    ;;
  verify) verify "$(shard_count "$shards_opt")" ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
