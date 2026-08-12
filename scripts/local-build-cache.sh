#!/usr/bin/env bash
#
# Opt-in shared Cargo target management for ContextDesk worktrees.
#
# This helper never changes global Cargo configuration. Cleanup is deliberately
# restricted to an explicitly named, recognized Cargo target directory.

set -euo pipefail
IFS=$'\n\t'

readonly CACHE_MARKER=".contextdesk-generated-target-v1"
readonly CARGO_CACHE_TAG_SIGNATURE="Signature: 8a477f597d28d172789f06886806bc55d"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/local-build-cache.sh activate [--cache-root ABSOLUTE_PATH]
  scripts/local-build-cache.sh inventory [--repo-root PATH] [--cache-root ABSOLUTE_PATH]
  scripts/local-build-cache.sh preserve-app --source APP --destination APP
  scripts/local-build-cache.sh cleanup (--dry-run | --apply)
      [--repo-root PATH] [--cache-root ABSOLUTE_PATH]
      [--preserved-app APP]... --target TARGET [--target TARGET]...

activate
  Creates one marked shared Cargo target outside every registered worktree and
  prints shell exports. Opt in with:
    eval "$(scripts/local-build-cache.sh activate)"

inventory
  Read-only inventory of registered worktrees, dirty source state, recognized
  Cargo targets, packaged apps, and local frontend/embedding caches.

preserve-app
  Copies an exact .app bundle outside registered worktrees and verifies a
  content digest. The destination must not already exist.

cleanup
  Accepts only explicit recognized Cargo target directories. --dry-run is
  non-mutating. --apply uses cargo clean after all paths and preserved apps
  have passed validation.
EOF
}

contains_newline() {
  [[ "$1" == *$'\n'* || "$1" == *$'\r'* ]]
}

require_absolute_clean_path() {
  local path="$1"
  [[ -n "$path" ]] || die "path must not be empty"
  contains_newline "$path" && die "paths containing newlines are not supported"
  [[ "$path" == /* ]] || die "path must be absolute: $path"
  [[ "$path" != *"//"* ]] || die "path must not contain repeated separators: $path"
  [[ "$path" != */./* && "$path" != */../* && "$path" != */. && "$path" != */.. ]] ||
    die "path must not contain '.' or '..' components: $path"
  [[ "$path" != "/" ]] || die "filesystem root is never an allowed target"
}

strip_trailing_slashes() {
  local path="$1"
  while [[ "$path" != "/" && "$path" == */ ]]; do
    path="${path%/}"
  done
  printf '%s\n' "$path"
}

path_has_symlink_component() {
  local path="$1"
  local relative="${path#/}"
  local current=""
  local component
  local old_ifs="$IFS"

  IFS='/'
  read -r -a components <<<"$relative"
  IFS="$old_ifs"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    if [[ -L "$current" ]]; then
      return 0
    fi
  done
  return 1
}

physical_existing_dir() {
  local path
  path="$(strip_trailing_slashes "$1")"
  require_absolute_clean_path "$path"
  [[ -d "$path" ]] || die "directory does not exist: $path"
  path_has_symlink_component "$path" && die "symlink path components are refused: $path"
  (cd "$path" && pwd -P)
}

physical_existing_file_or_dir() {
  local path
  path="$(strip_trailing_slashes "$1")"
  require_absolute_clean_path "$path"
  [[ -e "$path" ]] || die "path does not exist: $path"
  path_has_symlink_component "$path" && die "symlink path components are refused: $path"
  if [[ -d "$path" ]]; then
    (cd "$path" && pwd -P)
  else
    local parent
    parent="$(cd "$(dirname "$path")" && pwd -P)"
    printf '%s/%s\n' "$parent" "$(basename "$path")"
  fi
}

path_is_within() {
  local child="$1"
  local parent="$2"
  [[ "$child" == "$parent" || "$child" == "$parent/"* ]]
}

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

default_cache_root() {
  if [[ -n "${CONTEXTDESK_BUILD_CACHE_ROOT:-}" ]]; then
    printf '%s\n' "$CONTEXTDESK_BUILD_CACHE_ROOT"
  elif [[ "$(uname -s 2>/dev/null || true)" == "Darwin" && -n "${HOME:-}" ]]; then
    # Prefer the platform cache location on macOS even when a shell exports
    # XDG_CACHE_HOME. This keeps one durable cache instead of silently
    # creating a second multi-gigabyte target under ~/.cache.
    printf '%s/Library/Caches/ContextDesk/build-v1\n' "$HOME"
  elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    printf '%s/contextdesk/build-v1\n' "$XDG_CACHE_HOME"
  elif [[ -n "${HOME:-}" ]]; then
    printf '%s/.cache/contextdesk/build-v1\n' "$HOME"
  else
    die "set CONTEXTDESK_BUILD_CACHE_ROOT or pass --cache-root"
  fi
}

resolve_repo_root() {
  local requested="${1:-}"
  local root
  if [[ -n "$requested" ]]; then
    if [[ "$requested" != /* ]]; then
      requested="$PWD/$requested"
    fi
    root="$(physical_existing_dir "$requested")"
  else
    root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
      die "run inside a ContextDesk worktree or pass --repo-root"
    root="$(physical_existing_dir "$root")"
  fi
  git -C "$root" rev-parse --git-dir >/dev/null 2>&1 ||
    die "not a Git worktree: $root"
  printf '%s\n' "$root"
}

worktree_paths() {
  local repo_root="$1"
  git -C "$repo_root" worktree list --porcelain |
    while IFS= read -r line; do
      if [[ "$line" == "worktree "* ]]; then
        printf '%s\n' "${line#worktree }"
      fi
    done
}

primary_worktree() {
  local repo_root="$1"
  local first
  first="$(worktree_paths "$repo_root" | sed -n '1p')"
  [[ -n "$first" ]] || die "Git did not report a primary worktree"
  physical_existing_dir "$first"
}

refuse_path_inside_worktrees() {
  local candidate="$1"
  local repo_root="$2"
  local worktree
  while IFS= read -r worktree; do
    worktree="$(physical_existing_dir "$worktree")"
    if path_is_within "$candidate" "$worktree"; then
      die "path must be outside every registered worktree: $candidate"
    fi
  done < <(worktree_paths "$repo_root")
}

prepare_cache_root() {
  local requested="$1"
  local repo_root="$2"
  local cache_root
  cache_root="$(strip_trailing_slashes "$requested")"
  require_absolute_clean_path "$cache_root"
  path_has_symlink_component "$cache_root" &&
    die "cache root has a symlink path component: $cache_root"
  refuse_path_inside_worktrees "$cache_root" "$repo_root"
  mkdir -p "$cache_root"
  cache_root="$(physical_existing_dir "$cache_root")"
  refuse_path_inside_worktrees "$cache_root" "$repo_root"
  mkdir -p "$cache_root/cargo-target"
  : >"$cache_root/cargo-target/$CACHE_MARKER"
  printf '%s\n' "$cache_root"
}

cache_root_without_creating() {
  local requested="$1"
  local repo_root="$2"
  local root
  root="$(strip_trailing_slashes "$requested")"
  require_absolute_clean_path "$root"
  path_has_symlink_component "$root" &&
    die "cache root has a symlink path component: $root"
  if [[ -d "$root" ]]; then
    root="$(physical_existing_dir "$root")"
    refuse_path_inside_worktrees "$root" "$repo_root"
  fi
  printf '%s\n' "$root"
}

du_kib() {
  local path="$1"
  if [[ -e "$path" ]]; then
    du -sk "$path" 2>/dev/null | awk '{print $1}'
  else
    printf '0\n'
  fi
}

has_cargo_target_signature() {
  local target="$1"
  if [[ -f "$target/$CACHE_MARKER" || -f "$target/.rustc_info.json" ]]; then
    return 0
  fi
  if [[ -f "$target/CACHEDIR.TAG" ]] &&
    grep -Fq "$CARGO_CACHE_TAG_SIGNATURE" "$target/CACHEDIR.TAG"; then
    return 0
  fi
  return 1
}

registered_target_kind() {
  local target="$1"
  local repo_root="$2"
  local cache_root="$3"
  local primary
  local worktree

  primary="$(primary_worktree "$repo_root")"
  if [[ "$target" == "$primary/target" || "$target" == "$primary/desktop/src-tauri/target" ]]; then
    printf 'primary-refused\n'
    return 0
  fi
  if [[ "$target" == "$cache_root/cargo-target" ]]; then
    printf 'shared\n'
    return 0
  fi
  while IFS= read -r worktree; do
    worktree="$(physical_existing_dir "$worktree")"
    [[ "$worktree" == "$primary" ]] && continue
    if [[ "$target" == "$worktree/target" ]]; then
      printf 'worktree-root\n'
      return 0
    fi
    if [[ "$target" == "$worktree/desktop/src-tauri/target" ]]; then
      printf 'worktree-tauri\n'
      return 0
    fi
  done < <(worktree_paths "$repo_root")
  printf 'unrecognized\n'
}

bundle_digest() {
  local app="$1"
  (
    cd "$app"
    find . \( -type f -o -type l \) -print | LC_ALL=C sort |
      while IFS= read -r item; do
        contains_newline "$item" && die "bundle entries containing newlines are unsupported"
        if [[ -L "$item" ]]; then
          printf 'link %s -> %s\n' "$item" "$(readlink "$item")"
        else
          printf 'file %s ' "$item"
          shasum -a 256 "$item" | awk '{print $1}'
        fi
      done
  ) | shasum -a 256 | awk '{print $1}'
}

validate_preserved_app() {
  local app="$1"
  local repo_root="$2"
  app="$(physical_existing_dir "$app")"
  [[ "$app" == *.app ]] || die "preserved package must be a .app bundle: $app"
  refuse_path_inside_worktrees "$app" "$repo_root"
  printf '%s\n' "$app"
}

find_packages() {
  local target="$1"
  find "$target" -type l -name '*.app' -print |
    while IFS= read -r package; do
      printf 'SYMLINK:%s\n' "$package"
    done
  find "$target" -type d -name '*.app' -prune -print |
    while IFS= read -r package; do
      printf 'BUNDLE:%s\n' "$package"
    done
}

package_has_verified_copy() {
  local package="$1"
  shift
  local expected
  local copy
  expected="$(bundle_digest "$package")"
  for copy in "$@"; do
    if [[ "$(bundle_digest "$copy")" == "$expected" ]]; then
      return 0
    fi
  done
  return 1
}

command_activate() {
  local cache_root
  local repo_root
  local sccache_bin
  cache_root="$(default_cache_root)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --cache-root)
      [[ $# -ge 2 ]] || die "--cache-root requires a path"
      cache_root="$2"
      shift 2
      ;;
    *)
      die "unknown activate option: $1"
      ;;
    esac
  done
  repo_root="$(resolve_repo_root "")"
  cache_root="$(prepare_cache_root "$cache_root" "$repo_root")"
  printf 'export CONTEXTDESK_BUILD_CACHE_ROOT=%s\n' "$(shell_quote "$cache_root")"
  printf 'export CARGO_TARGET_DIR=%s\n' "$(shell_quote "$cache_root/cargo-target")"
  # sccache is optional, but when installed it gives intentionally isolated
  # or cleaned targets the same compiler-object reuse as the shared target.
  if sccache_bin="$(command -v sccache 2>/dev/null)"; then
    mkdir -p "$cache_root/sccache"
    printf 'export RUSTC_WRAPPER=%s\n' "$(shell_quote "$sccache_bin")"
    printf 'export SCCACHE_DIR=%s\n' "$(shell_quote "$cache_root/sccache")"
  fi
}

inventory_target() {
  local target="$1"
  local kind="$2"
  local primary="$3"
  local safe="yes"
  local reason="recognized-cargo-target"
  local package

  if path_is_within "$target" "$primary"; then
    safe="no"
    reason="primary-checkout"
  elif ! has_cargo_target_signature "$target"; then
    safe="no"
    reason="missing-cargo-signature"
  fi
  printf 'TARGET kind=%s safe_to_regenerate=%s reason=%s size_kib=%s path=%s\n' \
    "$kind" "$safe" "$reason" "$(du_kib "$target")" "$(shell_quote "$target")"
  while IFS= read -r package; do
    [[ -n "$package" ]] || continue
    case "$package" in
    SYMLINK:*)
      printf 'PACKAGE kind=symlink preserved=no path=%s\n' \
        "$(shell_quote "${package#SYMLINK:}")"
      ;;
    BUNDLE:*)
      printf 'PACKAGE kind=app-bundle preserved=no size_kib=%s path=%s\n' \
        "$(du_kib "${package#BUNDLE:}")" "$(shell_quote "${package#BUNDLE:}")"
      ;;
    esac
  done < <(find_packages "$target")
}

command_inventory() {
  local repo_request=""
  local cache_root
  local repo_root
  local primary
  local worktree
  local dirty
  local role
  local path

  cache_root="$(default_cache_root)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --repo-root)
      [[ $# -ge 2 ]] || die "--repo-root requires a path"
      repo_request="$2"
      shift 2
      ;;
    --cache-root)
      [[ $# -ge 2 ]] || die "--cache-root requires a path"
      cache_root="$2"
      shift 2
      ;;
    *)
      die "unknown inventory option: $1"
      ;;
    esac
  done
  repo_root="$(resolve_repo_root "$repo_request")"
  primary="$(primary_worktree "$repo_root")"
  cache_root="$(cache_root_without_creating "$cache_root" "$repo_root")"

  printf 'INVENTORY mode=dry-run repo=%s primary=%s\n' \
    "$(shell_quote "$repo_root")" "$(shell_quote "$primary")"
  while IFS= read -r worktree; do
    worktree="$(physical_existing_dir "$worktree")"
    if [[ "$worktree" == "$primary" ]]; then
      role="primary"
    else
      role="linked"
    fi
    if [[ -n "$(git -C "$worktree" status --porcelain --untracked-files=normal)" ]]; then
      dirty="yes"
    else
      dirty="no"
    fi
    printf 'WORKTREE role=%s active=registered dirty=%s path=%s\n' \
      "$role" "$dirty" "$(shell_quote "$worktree")"

    path="$worktree/target"
    [[ -d "$path" ]] && inventory_target "$path" "root" "$primary"
    path="$worktree/desktop/src-tauri/target"
    [[ -d "$path" ]] && inventory_target "$path" "tauri" "$primary"
    path="$worktree/desktop/node_modules"
    [[ -d "$path" ]] &&
      printf 'CACHE kind=node_modules shared=no size_kib=%s path=%s\n' \
        "$(du_kib "$path")" "$(shell_quote "$path")"
    path="$worktree/.fastembed_cache"
    [[ -d "$path" ]] &&
      printf 'CACHE kind=embedding shared=no size_kib=%s path=%s\n' \
        "$(du_kib "$path")" "$(shell_quote "$path")"
  done < <(worktree_paths "$repo_root")

  if [[ -d "$cache_root/cargo-target" ]]; then
    inventory_target "$cache_root/cargo-target" "shared" "$primary"
  else
    printf 'TARGET kind=shared state=missing size_kib=0 path=%s\n' \
      "$(shell_quote "$cache_root/cargo-target")"
  fi
}

command_preserve_app() {
  local source=""
  local destination=""
  local repo_root
  local destination_parent
  local source_digest

  while [[ $# -gt 0 ]]; do
    case "$1" in
    --source)
      [[ $# -ge 2 ]] || die "--source requires a path"
      source="$2"
      shift 2
      ;;
    --destination)
      [[ $# -ge 2 ]] || die "--destination requires a path"
      destination="$2"
      shift 2
      ;;
    *)
      die "unknown preserve-app option: $1"
      ;;
    esac
  done
  [[ -n "$source" && -n "$destination" ]] ||
    die "preserve-app requires --source and --destination"
  repo_root="$(resolve_repo_root "")"
  source="$(physical_existing_dir "$source")"
  [[ "$source" == *.app ]] || die "source must be a .app bundle: $source"
  require_absolute_clean_path "$destination"
  destination="$(strip_trailing_slashes "$destination")"
  [[ "$destination" == *.app ]] || die "destination must end in .app: $destination"
  [[ ! -e "$destination" ]] || die "destination already exists: $destination"
  path_has_symlink_component "$destination" &&
    die "destination has a symlink path component: $destination"
  refuse_path_inside_worktrees "$destination" "$repo_root"
  destination_parent="$(dirname "$destination")"
  mkdir -p "$destination_parent"
  destination_parent="$(physical_existing_dir "$destination_parent")"
  destination="$destination_parent/$(basename "$destination")"
  refuse_path_inside_worktrees "$destination" "$repo_root"
  path_is_within "$destination" "$source" &&
    die "destination must not be inside the source bundle"

  source_digest="$(bundle_digest "$source")"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$source" "$destination"
  else
    cp -Rp "$source" "$destination"
  fi
  [[ "$(bundle_digest "$destination")" == "$source_digest" ]] ||
    die "preserved app digest did not match source"
  printf 'PRESERVED_APP digest=%s source=%s destination=%s\n' \
    "$source_digest" "$(shell_quote "$source")" "$(shell_quote "$destination")"
}

command_cleanup() {
  local mode=""
  local repo_request=""
  local cache_root
  local repo_root
  local primary
  local target
  local kind
  local package
  local copy
  local manifest
  local before
  local after
  local i
  local -a targets=()
  local -a preserved_apps=()
  local -a validated_preserved_apps=()
  local -a validated_targets=()
  local -a validated_kinds=()

  cache_root="$(default_cache_root)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --dry-run)
      [[ -z "$mode" ]] || die "choose exactly one of --dry-run or --apply"
      mode="dry-run"
      shift
      ;;
    --apply)
      [[ -z "$mode" ]] || die "choose exactly one of --dry-run or --apply"
      mode="apply"
      shift
      ;;
    --repo-root)
      [[ $# -ge 2 ]] || die "--repo-root requires a path"
      repo_request="$2"
      shift 2
      ;;
    --cache-root)
      [[ $# -ge 2 ]] || die "--cache-root requires a path"
      cache_root="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target requires a path"
      targets+=("$2")
      shift 2
      ;;
    --preserved-app)
      [[ $# -ge 2 ]] || die "--preserved-app requires a path"
      preserved_apps+=("$2")
      shift 2
      ;;
    *)
      die "unknown cleanup option: $1"
      ;;
    esac
  done
  [[ -n "$mode" ]] || die "cleanup requires exactly one of --dry-run or --apply"
  [[ ${#targets[@]} -gt 0 ]] || die "cleanup requires at least one explicit --target"

  repo_root="$(resolve_repo_root "$repo_request")"
  primary="$(primary_worktree "$repo_root")"
  cache_root="$(cache_root_without_creating "$cache_root" "$repo_root")"

  for copy in "${preserved_apps[@]}"; do
    copy="$(validate_preserved_app "$copy" "$repo_root")"
    validated_preserved_apps+=("$copy")
  done
  preserved_apps=("${validated_preserved_apps[@]}")

  # Validate every target and package before the first mutating command.
  for target in "${targets[@]}"; do
    target="$(physical_existing_dir "$target")"
    kind="$(registered_target_kind "$target" "$repo_root" "$cache_root")"
    case "$kind" in
    primary-refused)
      die "refusing to clean a target in the primary checkout: $target"
      ;;
    unrecognized)
      die "not an exact registered Cargo target directory: $target"
      ;;
    shared | worktree-root | worktree-tauri) ;;
    *)
      die "internal target classification failure: $kind"
      ;;
    esac
    has_cargo_target_signature "$target" ||
      die "target lacks a recognized Cargo/generated marker: $target"
    for copy in "${preserved_apps[@]}"; do
      path_is_within "$copy" "$target" &&
        die "preserved app copy must be outside every cleanup target: $copy"
    done

    while IFS= read -r package; do
      [[ -n "$package" ]] || continue
      case "$package" in
      SYMLINK:*)
        die "symlinked packaged apps are refused: ${package#SYMLINK:}"
        ;;
      BUNDLE:*)
        package="${package#BUNDLE:}"
        if [[ ${#preserved_apps[@]} -eq 0 ]] ||
          ! package_has_verified_copy "$package" "${preserved_apps[@]}"; then
          die "packaged app has no verified preserved copy: $package"
        fi
        ;;
      esac
    done < <(find_packages "$target")
    validated_targets+=("$target")
    validated_kinds+=("$kind")
  done

  for ((i = 0; i < ${#validated_targets[@]}; i++)); do
    target="${validated_targets[$i]}"
    kind="${validated_kinds[$i]}"
    before="$(du_kib "$target")"
    if [[ "$mode" == "dry-run" ]]; then
      printf 'WOULD_CLEAN kind=%s size_kib=%s path=%s\n' \
        "$kind" "$before" "$(shell_quote "$target")"
      continue
    fi

    if [[ "$kind" == "worktree-tauri" ]]; then
      manifest="$(dirname "$target")/Cargo.toml"
    else
      manifest="$repo_root/Cargo.toml"
    fi
    [[ -f "$manifest" ]] || die "Cargo manifest missing for target cleanup: $manifest"
    cargo clean --manifest-path "$manifest" --target-dir "$target"
    if [[ "$kind" == "shared" ]]; then
      mkdir -p "$target"
      : >"$target/$CACHE_MARKER"
    fi
    after="$(du_kib "$target")"
    printf 'CLEANED kind=%s before_kib=%s after_kib=%s path=%s\n' \
      "$kind" "$before" "$after" "$(shell_quote "$target")"
  done
}

main() {
  [[ $# -gt 0 ]] || {
    usage
    exit 1
  }
  local command="$1"
  shift
  case "$command" in
  activate) command_activate "$@" ;;
  inventory) command_inventory "$@" ;;
  preserve-app) command_preserve_app "$@" ;;
  cleanup) command_cleanup "$@" ;;
  -h | --help | help) usage ;;
  *) die "unknown command: $command" ;;
  esac
}

main "$@"
