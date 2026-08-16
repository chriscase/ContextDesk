#!/usr/bin/env sh
# Deterministic shard plan for the Ubuntu workspace test gate (#874).
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
DEFAULT_SHARDS=4

usage() {
  cat <<'EOF'
Usage:
  sh scripts/ci_shard_plan.sh units                    # shard units, canonical order
  sh scripts/ci_shard_plan.sh base-units               # unsplitted cargo test targets
  sh scripts/ci_shard_plan.sh plan   [--shards N]      # "<shard>\t<unit>" for every unit
  sh scripts/ci_shard_plan.sh shard  K [--shards N]    # units assigned to shard K
  sh scripts/ci_shard_plan.sh args   UNIT              # cargo selector args for one unit
  sh scripts/ci_shard_plan.sh compile-args UNIT        # selector with run-filters stripped
  sh scripts/ci_shard_plan.sh verify [--shards N]      # fail closed if the partition is not
                                                       # exhaustive, disjoint, and balanced

Options:
  --shards N   number of shards (default: $CD_SHARD_COUNT, else 4)

The partition is a pure function of the commit: heaviest units first, each
placed on the currently lightest shard (lowest index on a tie). Leftover
light units fill the light shards instead of stacking onto one leftover-heavy
bucket. The same tree always produces the same plan on every runner and on a
developer laptop.
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

# Complementary filters for oversized `--lib` binaries.  Hosted evidence:
# shard 1 uniquely ran unsplitted `cd-core/lib` and lost its runner; later
# `cd-core/lib/other` (`--skip log_analysis::`, 1485 #[test]s) landed on
# shard 8 via alphabetical round-robin and timed out at 65m (run 31906598802).
# After runtime/services split, the remaining skip leftover still occupied
# shard 2 alone and produced no result after 56m1s (run 31926634503;
# aggregate: never run: cd-core/lib/other).
#
# Seven complementary units together are exactly `cargo test -p cd-core --lib`.
# Match filters are OR; the skip child must list every match filter (verify
# fails closed if it does not) and must not itself be heavy (a leftover that
# is still heavy must be split again, not given a longer job timeout).
# Short prefixes that are substrings of another module path (`events::`,
# `index::`, `object_store::`, `probe::`, `text::`) stay in the same match
# group as the longer name so rustc substring filters do not double-run.
#
# Columns: parent_unit, child_suffix, mode (match|skip), filter
# Filter may be space-separated prefixes (match = OR, skip = repeated --skip).
lib_splits() {
  printf '%s\n' \
    'cd-core/lib	log_analysis	match	log_analysis::' \
    'cd-core/lib	runtime	match	agent:: capability_qualification:: fast_triage:: investigations:: memory:: multi_model:: tool_host::' \
    'cd-core/lib	services	match	chat:: confluence_ro:: embed:: events:: harvest:: incident_evidence:: incident_evidence_archive:: investigation_answer:: model_curation:: normalized_log_events:: quality_eval:: research:: sessions:: sql_ro:: turn_trace:: web_research::' \
    'cd-core/lib	platform	match	ai_probe:: audit:: config:: error:: gateway_cost_ledger:: injection:: keychain_store:: linked_triage_contract:: mcp_client:: memory_fs:: module_registry:: modules:: probe:: providers:: reasoning_effort:: rerank:: skills:: triage_quality:: workspace_backup:: x_search::' \
    'cd-core/lib	control	match	branding:: cheap_model_fast_triage_benchmark:: context_plan:: deadline_controls:: extension_contract:: git_source:: home_source:: http_preset:: model_role_hints:: news_sources:: paths:: preflight:: provider_telemetry:: redact:: router:: sse:: tools:: triage_policy_store:: triage_role_qualification:: triage_sdk::' \
    'cd-core/lib	surface	match	activity:: build_identity:: connectors:: context_budgeting:: discovery:: embedding_space:: grok_auth:: help:: index:: index_watch:: model_context:: model_ref:: multi_stage_budget:: object_store:: openai_chat_contract:: permissions:: process_progress:: s3_object_store:: session_context:: ssrf:: text:: vector_index:: workspace::' \
    'cd-core/lib	other	skip	activity:: agent:: ai_probe:: audit:: branding:: build_identity:: capability_qualification:: chat:: cheap_model_fast_triage_benchmark:: config:: confluence_ro:: connectors:: context_budgeting:: context_plan:: deadline_controls:: discovery:: embed:: embedding_space:: error:: events:: extension_contract:: fast_triage:: gateway_cost_ledger:: git_source:: grok_auth:: harvest:: help:: home_source:: http_preset:: incident_evidence:: incident_evidence_archive:: index:: index_watch:: injection:: investigation_answer:: investigations:: keychain_store:: linked_triage_contract:: log_analysis:: mcp_client:: memory:: memory_fs:: model_context:: model_curation:: model_ref:: model_role_hints:: module_registry:: modules:: multi_model:: multi_stage_budget:: news_sources:: normalized_log_events:: object_store:: openai_chat_contract:: paths:: permissions:: preflight:: probe:: process_progress:: provider_telemetry:: providers:: quality_eval:: reasoning_effort:: redact:: rerank:: research:: router:: s3_object_store:: session_context:: sessions:: skills:: sql_ro:: sse:: ssrf:: text:: tool_host:: tools:: triage_policy_store:: triage_quality:: triage_role_qualification:: triage_sdk:: turn_trace:: vector_index:: web_research:: workspace:: workspace_backup:: x_search::'
}

# Hosted test-wall seconds from run 31906598802 (cold Ubuntu shards 1-7)
# plus run 31926634503 (shard 2 = cd-core/lib/other alone, 56m1s, no
# artifact). That leftover (~500 tests) is now three match groups; each
# third is weighted as a heavy so it cannot share a shard with another
# heavy. The skip leftover must stay below HEAVY_WEIGHT (verify fails
# closed if it does not). Default 8s covers the many sub-10s units.
#
# A unit at or above HEAVY_WEIGHT is a "heavy": when there are at least
# that many shards, verify refuses two heavies on one shard.
HEAVY_WEIGHT=180

weight_for() {
  case $1 in
    cd-core/lib/control) printf '%s\n' 750 ;;
    cd-core/lib/platform) printf '%s\n' 750 ;;
    cd-core/lib/surface) printf '%s\n' 750 ;;
    cd-core/test/real_format_exception_episode_acceptance_lab) printf '%s\n' 660 ;;
    cd-core/lib/runtime) printf '%s\n' 400 ;;
    cd-core/lib/log_analysis) printf '%s\n' 367 ;;
    cd-core/lib/services) printf '%s\n' 340 ;;
    cd-core/test/duplicate_rendering_acceptance_lab) printf '%s\n' 189 ;;
    cd-core/test/log_lab) printf '%s\n' 55 ;;
    cd-core/lib/other) printf '%s\n' 40 ;;
    *) printf '%s\n' 8 ;;
  esac
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
    cut -f4
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
  done | LC_ALL=C sort -u
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
  [ -n "$count" ] || count=${CD_SHARD_COUNT:-$DEFAULT_SHARDS}
  case $count in
    '' | *[!0-9]*) die "shard count must be a positive integer, got '$count'" ;;
  esac
  [ "$count" -ge 1 ] || die "shard count must be >= 1, got '$count'"
  printf '%s\n' "$count"
}

# Greedy multiprocessor scheduling: heaviest unit first, always onto the
# currently lightest shard (lowest index on a tie). Leftover light units
# therefore fill the light shards instead of piling onto the shard that
# already drew cd-core/lib/other — that round-robin leftover-heavy bucket
# is what timed out at 65m on hosted run 31906598802 (shard 8).
plan() {
  shards=$1
  units | while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    printf '%s\t%s\n' "$(weight_for "$unit")" "$unit"
  done |
    LC_ALL=C sort -t "$(printf '\t')" -k1,1nr -k2,2 |
    awk -F'\t' -v shards="$shards" '
      BEGIN { for (s = 1; s <= shards; s++) load[s] = 0 }
      NF >= 2 {
        w = $1 + 0
        u = $2
        best = 1
        for (s = 2; s <= shards; s++) {
          if (load[s] < load[best]) best = s
        }
        load[best] += w
        printf "%d\t%s\n", best, u
      }
    '
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
        match)
          printf -- '-p %s --lib --' "$pkg"
          # Word-split is intentional: filters are space-separated prefixes.
          for f in $filter; do
            printf ' %s' "$f"
          done
          printf '\n'
          ;;
        skip)
          printf -- '-p %s --lib --' "$pkg"
          for f in $filter; do
            printf ' --skip %s' "$f"
          done
          printf '\n'
          ;;
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

  # 3. Every shard index in 1..N must own at least one unit. Print the
  #    hosted test-weight so a leftover-heavy pile is visible in the log.
  i=1
  heavy_count=0
  while [ "$i" -le "$shards" ]; do
    n=0
    w=0
    heavies_here=0
    while IFS= read -r unit; do
      [ -n "$unit" ] || continue
      n=$((n + 1))
      uw=$(weight_for "$unit")
      w=$((w + uw))
      if [ "$uw" -ge "$HEAVY_WEIGHT" ]; then
        heavies_here=$((heavies_here + 1))
        heavy_count=$((heavy_count + 1))
      fi
    done <<EOF
$(awk -F'\t' -v want="$i" '$1 == want { print $2 }' "$tmp/plan")
EOF
    if [ "$n" -eq 0 ]; then
      echo "error: shard $i is empty; reduce the shard count" >&2
      failures=$((failures + 1))
    fi
    echo "  shard $i/$shards: $n units  test-weight=$w"
    printf '%s\n' "$heavies_here" >"$tmp/heavies-$i"
    i=$((i + 1))
  done

  # 3b. When there are enough shards for every heavy, two heavies must not
  #     share a shard. Alphabetical round-robin put cd-core/lib/other on
  #     shard 8 with 13 companions; that leftover-heavy bucket hit 65m.
  if [ "$heavy_count" -gt 0 ] && [ "$shards" -ge "$heavy_count" ]; then
    i=1
    while [ "$i" -le "$shards" ]; do
      h=$(cat "$tmp/heavies-$i")
      if [ "$h" -gt 1 ]; then
        echo "error: shard $i carries $h heavy units (weight >= $HEAVY_WEIGHT); leftover-heavy pile" >&2
        failures=$((failures + 1))
      fi
      i=$((i + 1))
    done
  fi

  # 4. No target that `cargo test` would run may be left unmapped.
  unmapped=$(unmapped_targets)
  if [ -n "$unmapped" ]; then
    echo "error: these targets are testable but belong to no shard unit:" >&2
    printf '  %s\n' "$unmapped" >&2
    echo "  teach scripts/ci_shard_plan.sh how to select them before merging" >&2
    failures=$((failures + 1))
  fi

  # 5. Independent cross-check against the filesystem for integration tests.
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

  # 7. The skip leftover for a parent must list every match filter so the
  #    complementary children remain an exact cover of `--lib`.
  if ! awk -F'\t' '
    $3 == "match" { matchf[$1] = matchf[$1] " " $4 }
    $3 == "skip" { skipf[$1] = $4; skipn[$1]++ }
    END {
      err = 0
      for (p in matchf) {
        if (skipn[p] != 1) {
          printf "error: lib split parent %s needs exactly one skip leftover\n", p
          err = 1
          continue
        }
        n = split(matchf[p], a, /[[:space:]]+/)
        for (i = 1; i <= n; i++) {
          if (a[i] == "") continue
          if ((" " skipf[p] " ") !~ (" " a[i] " ")) {
            printf "error: leftover skip for %s is missing match filter %s\n", p, a[i]
            err = 1
          }
        }
      }
      exit err
    }
  ' "$tmp/splits"; then
    failures=$((failures + 1))
  fi

  # 8. A skip leftover that is still heavy is the 56m shard-2 failure mode
  #    (run 31926634503: never run: cd-core/lib/other). Split it further;
  #    do not raise the job timeout.
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    mode=$(printf '%s\n' "$row" | cut -f3)
    [ "$mode" = skip ] || continue
    parent=$(printf '%s\n' "$row" | cut -f1)
    suffix=$(printf '%s\n' "$row" | cut -f2)
    child="$parent/$suffix"
    uw=$(weight_for "$child")
    if [ "$uw" -ge "$HEAVY_WEIGHT" ]; then
      echo "error: skip leftover $child is still heavy (weight $uw >= $HEAVY_WEIGHT); split it further" >&2
      failures=$((failures + 1))
    fi
  done <"$tmp/splits"

  if [ "$failures" -ne 0 ]; then
    echo "shard plan verification FAILED ($failures problem(s))" >&2
    exit 1
  fi
  echo "shard plan verified: exhaustive, disjoint, no empty shard, no leftover-heavy pile"
}

[ $# -ge 1 ] || {
  usage >&2
  exit 2
}

cmd=$1
shift

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
  base-units) base_units ;;
  plan) plan "$(shard_count "$shards_opt")" ;;
  shard)
    [ -n "$positional" ] || die "shard needs an index, e.g. 'shard 2 --shards 4'"
    shard "$positional" "$(shard_count "$shards_opt")"
    ;;
  args)
    [ -n "$positional" ] || die "args needs a unit id, e.g. 'args cd-core/test/golden_retrieval'"
    args_for "$positional"
    ;;
  compile-args)
    [ -n "$positional" ] || die "compile-args needs a unit id"
    compile_args_for "$positional"
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
