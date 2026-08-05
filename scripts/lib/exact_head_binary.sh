#!/usr/bin/env bash
# Exact-head contextdesk binary gate for acceptance/rehearsal scripts.
#
# Usage (from a script that has set ROOT to the worktree root):
#   source "$ROOT/scripts/lib/exact_head_binary.sh"
#   BIN="$(ensure_exact_head_binary)"   # prints path; rebuilds if needed
#   require_exact_head_binary "$BIN"    # fail closed if stamp ≠ HEAD
#
# Rules:
# - Never silently use a pre-existing binary without a matching stamp.
# - Stamp is written only after a deliberate cargo build of this checkout.
# - CARGO_TARGET_DIR may be shared; never clean the shared target.
# - Stamp + embedded capabilities.git_sha must both match worktree HEAD.
set -euo pipefail

_exact_head_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_exact_head_py="${_exact_head_lib_dir}/exact_head_identity.py"

exact_head_repo_root() {
  if [[ -n "${EXACT_HEAD_REPO_ROOT:-}" ]]; then
    printf '%s\n' "$EXACT_HEAD_REPO_ROOT"
    return 0
  fi
  git -C "${_exact_head_lib_dir}/../.." rev-parse --show-toplevel
}

exact_head_full_sha() {
  python3 "$_exact_head_py" git-sha --repo-root "$(exact_head_repo_root)"
}

exact_head_default_binary() {
  local root target
  root="$(exact_head_repo_root)"
  target="${CARGO_TARGET_DIR:-$root/target}"
  printf '%s\n' "$target/debug/contextdesk"
}

# Fail closed if binary does not prove identity with current HEAD.
# Returns 0 on success, 2 on failure (never aborts the caller via set -e
# mid-function without an explicit return).
require_exact_head_binary() {
  local bin="${1:-}"
  local sha caps emb rc
  if [[ -z "$bin" ]]; then
    echo "exact_head: binary path required" >&2
    return 2
  fi
  sha="$(exact_head_full_sha)"
  set +e
  python3 "$_exact_head_py" check --binary "$bin" --expected-sha "$sha" \
    --repo-root "$(exact_head_repo_root)" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    return 2
  fi
  # Embedded runtime identity (cd_core build_identity via capabilities).
  set +e
  caps="$("$bin" --json capabilities 2>/dev/null)"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 || -z "$caps" ]]; then
    echo "exact_head: capabilities probe failed for $bin" >&2
    return 2
  fi
  set +e
  emb="$(
    PYTHONPATH="${_exact_head_lib_dir}${PYTHONPATH:+:$PYTHONPATH}" \
      python3 -c "
import sys
import exact_head_identity as ehi
caps = sys.argv[1]
sha = sys.argv[2]
emb = ehi.parse_capabilities_git_sha(caps)
print(ehi.require_embedded_runtime_identity(embedded_git_sha=emb, expected_full_sha=sha))
" "$caps" "$sha" 2>&1
  )"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "exact_head: embedded runtime git identity check failed: $emb" >&2
    return 2
  fi
  echo "exact_head_ok sha=$sha embedded_git_sha=$emb"
  return 0
}

# Build current checkout (if needed) and stamp the binary with full HEAD SHA.
# Always rebuilds when EXACT_HEAD_FORCE_BUILD=1 or identity check fails.
ensure_exact_head_binary() {
  local root target bin sha profile need_build=1
  root="$(exact_head_repo_root)"
  target="${CARGO_TARGET_DIR:-$root/target}"
  profile="${EXACT_HEAD_PROFILE:-debug}"
  if [[ "$profile" == "release" ]]; then
    bin="${EXACT_HEAD_BIN:-$target/release/contextdesk}"
  else
    bin="${EXACT_HEAD_BIN:-$target/debug/contextdesk}"
  fi
  sha="$(exact_head_full_sha)"

  if [[ "${EXACT_HEAD_FORCE_BUILD:-0}" != "1" ]]; then
    if require_exact_head_binary "$bin" >/dev/null 2>&1; then
      need_build=0
    fi
  fi

  if [[ "$need_build" == "1" ]]; then
    echo "exact_head: building cd-cli for $sha (profile=$profile)" >&2
    (
      cd "$root"
      export CARGO_TARGET_DIR="$target"
      # Full SHA so capabilities.git_sha embeds the current worktree identity.
      export CD_GIT_SHA="$sha"
      export CD_GIT_DESCRIBE="$sha"
      if [[ "$profile" == "release" ]]; then
        cargo build -p cd-cli --release --quiet
      else
        cargo build -p cd-cli --quiet
      fi
    )
    if [[ ! -x "$bin" ]]; then
      echo "exact_head: build finished but binary missing: $bin" >&2
      return 2
    fi
    python3 "$_exact_head_py" write-stamp --binary "$bin" --sha "$sha" >/dev/null
  fi

  if ! require_exact_head_binary "$bin" >/dev/null; then
    echo "exact_head: identity still failing after ensure for $bin" >&2
    return 2
  fi
  # Re-print identity line for logs (require was silenced).
  require_exact_head_binary "$bin" >&2 || true
  printf '%s\n' "$bin"
  return 0
}
