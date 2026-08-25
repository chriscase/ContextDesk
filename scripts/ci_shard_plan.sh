#!/usr/bin/env sh
# Deterministic shard plan for the cross-OS workspace test gates (#874).
#
# The Linux gate used to be a single `cargo test --workspace` step that ran for
# 70-80 minutes; when the hosted runner lost its connection GitHub marked the
# job failed with the step still `in_progress` and no log blob at all.  Hosted
# runs 31828397526 and 31835229724 then showed that four cold shards each
# compiled DuckDB independently (~36-55 min) and shard 1 — the only owner of
# `cd-core/lib` — disappeared at ~86-96 min with no log or artifact.
#
# This script owns the partition so CI, the aggregate gate, and local
# reproduction all agree on it. Coverage is preserved by construction: the
# target list comes from `cargo metadata`. Every testable target lands in
# exactly one shard unit (or a complementary filter split of `--lib`) and
# `verify` fails closed if that ever stops being true.
#
# A "unit" is the smallest thing `cargo test` can be pointed at:
#
#   <pkg>/lib                library unit tests          (--lib)
#   <pkg>/lib/<split>        complementary --lib filter  (see lib_splits)
#   <pkg>/bins               binary unit tests           (--bins)
#   <pkg>/doc                documentation tests         (--doc)
#   <pkg>/test/<name>        one integration test        (--test <name>)
#
# No network, no cargo build, no secrets.  Requires: cargo, jq.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CONFIG="$ROOT/scripts/ci_shard_config.sh"

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_shard_plan.sh units                    # shard units, canonical order
  sh scripts/ci_shard_plan.sh base-units               # unsplitted cargo test targets
  sh scripts/ci_shard_plan.sh plan   [--os OS] [--shards N]
  sh scripts/ci_shard_plan.sh shard  K [--os OS] [--shards N]
  sh scripts/ci_shard_plan.sh args   UNIT              # cargo selector args for one unit
  sh scripts/ci_shard_plan.sh compile-args UNIT        # selector with run-filters stripped
  sh scripts/ci_shard_plan.sh verify [--os OS] [--shards N]
                                                       # fail closed if the partition is not
                                                       # exhaustive, disjoint, and balanced

Options:
  --os OS       validate against the canonical ubuntu, macos, or windows count
  --shards N   explicit number of shards; with --os, it must match that OS

With neither option, the canonical Ubuntu count is used. CD_SHARD_COUNT remains
supported for local compatibility, but is verified when --os is present.

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
# selects it in every case.  Kept in one place so `enumerate_base_units` and the
# unmapped-target guard below cannot drift apart.
LIB_KINDS='["lib","rlib","dylib","cdylib","staticlib","proc-macro"]'

# Complementary filters for oversized `--lib` binaries.  Hosted evidence: shard
# 1 uniquely ran `cd-core/lib` and was the only shard that lost its runner;
# surviving shards' tests were seconds except one 525s integration target.
# These two units together are exactly `cargo test -p cd-core --lib`.
#
# Columns: parent_unit, child_suffix, mode (match|skip), filter
lib_splits() {
  printf '%s\n' \
    'cd-core/lib	log_analysis	match	log_analysis::' \
    'cd-core/lib	other	skip	log_analysis::'
}

# Every testable target in the root workspace, in a canonical, locale-stable
# order, before lib splits.  `--no-deps` keeps this to workspace members.
enumerate_base_units() {
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
    cut -f4 |
    # Git Bash can preserve CRLF from native Windows tools.  Keep the
    # canonical unit stream byte-for-byte identical on every runner.
    tr -d '\015'
}

# Replace configured parent lib units with complementary child units.
expand_units() {
  base=$1
  splits=$(lib_splits)
  printf '%s\n' "$base" | while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    children=$(printf '%s\n' "$splits" | awk -F'\t' -v parent="$unit" '$1 == parent { print parent "/" $2 }')
    if [ -n "$children" ]; then
      printf '%s\n' "$children"
    else
      printf '%s\n' "$unit"
    fi
  done | LC_ALL=C sort -u | tr -d '\015'
}

# Any target `cargo test` would pick up but this script does not know how to
# turn into a unit -- a bench target, or an example with `test = true`.
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

BASE_CACHE=""
UNITS_CACHE=""

base_units() {
  if [ -z "$BASE_CACHE" ]; then
    BASE_CACHE=$(enumerate_base_units)
    [ -n "$BASE_CACHE" ] || die "no test units found - cargo metadata returned nothing usable"
    case $BASE_CACHE in
      *" "* | *"	"*) die "target name contains whitespace; shard selectors cannot be built safely" ;;
    esac
  fi
  printf '%s\n' "$BASE_CACHE"
}

units() {
  if [ -z "$UNITS_CACHE" ]; then
    UNITS_CACHE=$(expand_units "$(base_units)")
    [ -n "$UNITS_CACHE" ] || die "expanded shard plan is empty"
    case $UNITS_CACHE in
      *" "* | *"	"*) die "target name contains whitespace; shard selectors cannot be built safely" ;;
    esac
  fi
  printf '%s\n' "$UNITS_CACHE"
}

shard_count() {
  count=${1:-}
  os=${2:-}
  [ -n "$count" ] || count=${CD_SHARD_COUNT:-}
  if [ -n "$os" ]; then
    if [ -n "$count" ]; then
      sh "$CONFIG" verify "$os" "$count" >/dev/null
    else
      count=$(sh "$CONFIG" count "$os")
    fi
  elif [ -z "$count" ]; then
    count=$(sh "$CONFIG" count ubuntu)
  fi
  case $count in
    '' | *[!0-9]*) die "shard count must be a positive integer, got '$count'" ;;
  esac
  [ "$count" -ge 1 ] || die "shard count must be >= 1, got '$count'"
  printf '%s\n' "$count"
}

# Round-robin over the canonical order: index N goes to shard (N mod shards)+1.
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
    lib/*)
      parent="$pkg/lib"
      suffix=${rest#lib/}
      row=$(lib_splits | awk -F'\t' -v parent="$parent" -v suffix="$suffix" '$1 == parent && $2 == suffix { print }')
      [ -n "$row" ] || die "unknown lib split '$unit'"
      mode=$(printf '%s\n' "$row" | cut -f3)
      filter=$(printf '%s\n' "$row" | cut -f4)
      [ -n "$filter" ] || die "empty filter for lib split '$unit'"
      case $mode in
        match) printf -- '-p %s --lib -- %s\n' "$pkg" "$filter" ;;
        skip) printf -- '-p %s --lib -- --skip %s\n' "$pkg" "$filter" ;;
        *) die "unknown lib-split mode '$mode' in '$unit'" ;;
      esac
      ;;
    bins) printf -- '-p %s --bins\n' "$pkg" ;;
    doc) printf -- '-p %s --doc\n' "$pkg" ;;
    test/*) printf -- '-p %s --test %s\n' "$pkg" "${rest#test/}" ;;
    *) die "unknown unit kind in '$unit'" ;;
  esac
}

# `--no-run` rejects trailing test filters; keep the cargo selector only.
compile_args_for() {
  args_for "$1" | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i == "--") break
      printf "%s%s", (i == 1 ? "" : " "), $i
    }
    printf "\n"
  }'
}

# Fail closed on anything that would let a test escape the gate.
verify() {
  shards=$1
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-shard-plan.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  failures=0

  base_units >"$tmp/base"
  units >"$tmp/units"
  plan "$shards" >"$tmp/plan"

  total=$(wc -l <"$tmp/units" | tr -d ' ')
  base_total=$(wc -l <"$tmp/base" | tr -d ' ')
  echo "shard plan: $total shard units ($base_total cargo test targets) across $shards shards"

  # 1. No unit may be listed twice.
  dupes=$(LC_ALL=C sort "$tmp/units" | uniq -d)
  if [ -n "$dupes" ]; then
    echo "error: duplicate test units in the enumeration:" >&2
    printf '%s\n' "$dupes" >&2
    failures=$((failures + 1))
  fi

  # 2. The union of the shards must be exactly the expanded unit list.
  cut -f2 "$tmp/plan" | LC_ALL=C sort >"$tmp/assigned"
  LC_ALL=C sort "$tmp/units" >"$tmp/expected"
  if ! diff -u "$tmp/expected" "$tmp/assigned" >"$tmp/diff" 2>&1; then
    echo "error: shard assignment is not an exact partition of the workspace:" >&2
    cat "$tmp/diff" >&2
    failures=$((failures + 1))
  fi

  # 3. Every shard index in 1..N must own at least one unit.
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

  # 4. No target that `cargo test` would run may be left unmapped.
  unmapped=$(unmapped_targets)
  if [ -n "$unmapped" ]; then
    echo "error: these targets are testable but belong to no shard unit:" >&2
    printf '  %s\n' "$unmapped" >&2
    echo "  teach scripts/ci_shard_plan.sh how to select them before merging" >&2
    failures=$((failures + 1))
  fi

  # 5. Independent cross-check against the filesystem for integration tests.
  # Cargo emits native manifest paths. On Windows the Git Bash glob below is
  # POSIX-shaped (`/c/...`) while metadata uses `C:\\...`; compare the stable
  # crate-relative suffix instead of two representations of the same absolute
  # path.
  metadata |
    jq -r '.packages[] | "\(.manifest_path)\t\(.name)"' |
    awk -F'\t' '
      function crate_rel(path) {
        # Cargo emits one native backslash per separator on Windows.
        gsub(/\\/, "/", path)
        sub(/^.*\/crates\//, "", path)
        sub(/\/Cargo\.toml$/, "", path)
        return path
      }
      { print crate_rel($1) "\t" $2 }
    ' >"$tmp/manifests"
  for file in "$ROOT"/crates/*/tests/*.rs; do
    [ -e "$file" ] || continue
    relative=${file#"$ROOT"/crates/}
    crate_dir=${relative%%/tests/*}
    pkg=$(awk -F'\t' -v d="$crate_dir" '$1 == d { print $2 }' "$tmp/manifests")
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

  # 6. Lib splits must replace a real base unit, never add a phantom parent,
  #    and never leave the unsplitted parent in the run list (that would
  #    double-run those tests).
  lib_splits >"$tmp/splits"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    parent=$(printf '%s\n' "$row" | cut -f1)
    suffix=$(printf '%s\n' "$row" | cut -f2)
    child="$parent/$suffix"
    if ! grep -qxF "$parent" "$tmp/base"; then
      echo "error: lib split parent $parent is not a cargo test target" >&2
      failures=$((failures + 1))
    fi
    if grep -qxF "$parent" "$tmp/units"; then
      echo "error: split parent $parent still appears as a shard unit (would double-run)" >&2
      failures=$((failures + 1))
    fi
    if ! grep -qxF "$child" "$tmp/units"; then
      echo "error: lib split child $child is missing from the shard plan" >&2
      failures=$((failures + 1))
    fi
  done <"$tmp/splits"

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

shards_opt=""
os_opt=""
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
    --os)
      [ $# -ge 2 ] || die "--os needs a value"
      os_opt=$2
      shift 2
      ;;
    --os=*)
      os_opt=${1#--os=}
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
  base-units) base_units ;;
  plan) plan "$(shard_count "$shards_opt" "$os_opt")" ;;
  shard)
    [ -n "$positional" ] || die "shard needs an index, e.g. 'shard 2 --shards 4'"
    shard "$positional" "$(shard_count "$shards_opt" "$os_opt")"
    ;;
  args)
    [ -n "$positional" ] || die "args needs a unit id, e.g. 'args cd-core/test/golden_retrieval'"
    args_for "$positional"
    ;;
  compile-args)
    [ -n "$positional" ] || die "compile-args needs a unit id"
    compile_args_for "$positional"
    ;;
  verify) verify "$(shard_count "$shards_opt" "$os_opt")" ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
