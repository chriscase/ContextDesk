#!/usr/bin/env sh
# Hermetic contracts for the rust-cache fingerprint helper.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
FP="$ROOT/scripts/ci_cache_fingerprint.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-cache-fp.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

sh "$FP" --os ubuntu-latest >"$TMP/ubuntu1"
sh "$FP" --os ubuntu-latest >"$TMP/ubuntu2"
cmp -s "$TMP/ubuntu1" "$TMP/ubuntu2" || fail "ubuntu fingerprint is not deterministic"

sh "$FP" --os macos-latest >"$TMP/macos"
sh "$FP" --os windows-latest >"$TMP/windows"

u_key=$(awk -F= '$1 == "shared_key" { print $2 }' "$TMP/ubuntu1")
m_key=$(awk -F= '$1 == "shared_key" { print $2 }' "$TMP/macos")
w_key=$(awk -F= '$1 == "shared_key" { print $2 }' "$TMP/windows")
[ "$u_key" = ubuntu-workspace-tests ] || fail "ubuntu shared_key"
[ "$m_key" = macos-latest-workspace-tests-v2 ] || fail "macos shared_key"
[ "$w_key" = windows-latest-workspace-tests-v2 ] || fail "windows shared_key"
[ "$m_key" != "$w_key" ] || fail "macos and windows must not share a cache key"
[ "$u_key" != "$m_key" ] || fail "ubuntu must not reuse a desktop cache key"

u_fp=$(awk -F= '$1 == "fingerprint" { print $2 }' "$TMP/ubuntu1")
m_fp=$(awk -F= '$1 == "fingerprint" { print $2 }' "$TMP/macos")
w_fp=$(awk -F= '$1 == "fingerprint" { print $2 }' "$TMP/windows")
[ -n "$u_fp" ] && [ -n "$m_fp" ] && [ -n "$w_fp" ] || fail "fingerprints must be non-empty"
[ "$m_fp" != "$w_fp" ] || fail "desktop fingerprints must differ by OS key"
[ "$u_fp" != "$m_fp" ] || fail "ubuntu fingerprint must differ from macos"

# RUSTFLAGS is a compile input: changing it must change the digest.
RUSTFLAGS='-D warnings' sh "$FP" --os ubuntu-latest >"$TMP/flag1"
RUSTFLAGS='-C debuginfo=0' sh "$FP" --os ubuntu-latest >"$TMP/flag2"
f1=$(awk -F= '$1 == "fingerprint" { print $2 }' "$TMP/flag1")
f2=$(awk -F= '$1 == "fingerprint" { print $2 }' "$TMP/flag2")
[ "$f1" != "$f2" ] || fail "RUSTFLAGS must be part of the fingerprint"

echo "ci_cache_fingerprint_test: OK"
