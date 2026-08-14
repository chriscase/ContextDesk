#!/usr/bin/env sh
# Hermetic parser regressions for scripts/check_claims.sh.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-claims-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

run_ok() {
  if ! CHECK_CLAIMS_SKIP_AUX=1 CLAIMS_FILE="$1" sh "$ROOT/scripts/check_claims.sh" >/dev/null; then
    echo "FAIL: expected valid claims fixture: $1" >&2
    exit 1
  fi
}

run_fail() {
  if CHECK_CLAIMS_SKIP_AUX=1 CLAIMS_FILE="$1" sh "$ROOT/scripts/check_claims.sh" >/dev/null 2>&1; then
    echo "FAIL: expected malformed claims fixture to fail: $1" >&2
    exit 1
  fi
}

BASE="$TMP/claims.md"
cp "$ROOT/docs/CLAIMS.md" "$BASE"
run_ok "$BASE"

# An extra unescaped pipe must not shift the anchor into another column.
awk 'NR == 7 { print; print "| Synthetic malformed | Shipped | crates/cd-core/src/index.rs:KeywordIndex | extra | pipe |"; next } { print }' \
  "$BASE" > "$TMP/extra-pipe.md"
run_fail "$TMP/extra-pipe.md"

# Escaped pipes are rejected explicitly instead of being silently masked.
sed 's/Rich Logs list\/detail/Rich Logs list\\|detail/' "$BASE" > "$TMP/escaped-pipe.md"
run_fail "$TMP/escaped-pipe.md"

# A row with a blank anchor must fail even when its row count is unchanged.
sed 's#crates/cd-core/src/log_analysis/package.rs:export_corpus_zip# #' "$BASE" > "$TMP/missing-anchor.md"
run_fail "$TMP/missing-anchor.md"

echo "check_claims_test: OK"
