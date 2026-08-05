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
# Requires: sidecar stamp == full HEAD **and** runtime `capabilities.git_sha`
# matches the worktree (embedded build identity — not stamp alone).
require_exact_head_binary() {
  local bin="${1:-}"
  local sha caps emb
  if [[ -z "$bin" ]]; then
    echo "exact_head: binary path required" >&2
    return 2
  fi
  sha="$(exact_head_full_sha)"
  python3 "$_exact_head_py" check --binary "$bin" --expected-sha "$sha" \
    --repo-root "$(exact_head_repo_root)"
  # Embedded runtime identity (cd_core build_identity via capabilities).
  caps="$("$bin" --json capabilities 2>/dev/null || true)"
  if [[ -z "$caps" ]]; then
    echo "exact_head: capabilities probe failed for $bin" >&2
    return 2
  fi
  emb="$(
    PYTHONPATH="${_exact_head_lib_dir}${PYTHONPATH:+:$PYTHONPATH}" \
      python3 -c "
import sys
import exact_head_identity as ehi
caps = sys.argv[1]
sha = sys.argv[2]
emb = ehi.parse_capabilities_git_sha(caps)
print(ehi.require_embedded_runtime_identity(embedded_git_sha=emb, expected_full_sha=sha))
" "$caps" "$sha"
  )" || {
    echo "exact_head: embedded runtime git identity check failed" >&2
    return 2
  }
  echo "exact_head_ok sha=$sha embedded_git_sha=$emb"
}

# Build current checkout (if needed) and stamp the binary with full HEAD SHA.
# Always rebuilds when EXACT_HEAD_FORCE_BUILD=1 or stamp mismatches.
ensure_exact_head_binary() {
  local root target bin sha profile
  root="$(exact_head_repo_root)"
  target="${CARGO_TARGET_DIR:-$root/target}"
  profile="${EXACT_HEAD_PROFILE:-debug}"
  if [[ "$profile" == "release" ]]; then
    bin="${EXACT_HEAD_BIN:-$target/release/contextdesk}"
  else
    bin="${EXACT_HEAD_BIN:-$target/debug/contextdesk}"
  fi
  sha="$(exact_head_full_sha)"

  # Fast path: stamp + embedded runtime identity both match HEAD.
  if [[ "${EXACT_HEAD_FORCE_BUILD:-0}" != "1" ]] \
    && require_exact_head_binary "$bin" >/dev/null 2>&1; then
    printf '%s\n' "$bin"
    return 0
  fi

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
  require_exact_head_binary "$bin" >/dev/null
  printf '%s\n' "$bin"
}
