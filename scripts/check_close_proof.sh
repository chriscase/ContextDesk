#!/usr/bin/env sh
# Close-proof guard (#254): every `remediation` close must carry verifiable,
# correctly-attributed, non-scripted proof in its CLOSING comment.
#
# Enforced standard (see docs/CLOSE_PROOF.md), per closing comment:
#   (1) a plausible commit SHA  — a standalone 7-40 hex token containing at
#       least one a-f letter (rejects pure-decimal PR numbers / dates / counts);
#   (2) pasted verification     — a line matching `test result`, `N passed`,
#       `cargo test`, `cargo clippy`, a standalone `PASS`, a fenced ``` block,
#       or a screenshot / image link;
#   (3) issue-specific prose    — no two different issues may share a
#       byte-identical closing-comment body (the #180 scripted anti-pattern).
#
# Modes:
#   --offline            Run built-in self-tests of the matchers + duplicate
#                        detection. No network. Hard-fails if the checker's own
#                        logic regresses. (Used as the CI hard gate.)
#   --fixture <file>     Validate a JSON fixture: [{id,body,expect:pass|fail}].
#                        `expect=pass` means the body must satisfy ALL THREE
#                        rules (SHA + proof + not a duplicate of another body);
#                        `expect=fail` means it violates at least one. Also
#                        prints a DUPLICATE flag for any shared body. Exit 1 on
#                        any mismatch.
#   (default)            Built-in self-tests, then — if gh + a token are present
#                        — sample closed remediation issues and HARD-FAIL any
#                        closed strictly AFTER CLOSE_PROOF_CUTOFF whose closing
#                        comment lacks a SHA or pasted proof, or that duplicates
#                        another issue's closing body. Issues closed on/before
#                        the cutoff are left untouched (no retroactive breakage).
#
# Dependency-light: POSIX sh + gh + jq. No secrets; offline path needs no network.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# Enforcement begins strictly AFTER this date. All remediation history to date
# was closed on/before 2026-07-18, so the default never breaks existing closes.
CUTOFF="${CLOSE_PROOF_CUTOFF:-2026-07-18}"
TAB=$(printf '\t')

fail=0
dupes_found=0

# --- Rule matchers (single source of truth, shared by every mode) ------------

# (1) Plausible commit SHA: a standalone 7-40 hex token with >=1 a-f letter.
# tr splits on any non-alnum so tokens are isolated; the hex-class grep keeps
# only pure-hex 7-40 runs; the final grep requires a letter so pure-decimal
# runs (PR numbers, dates like 20260718, "1234567") are NOT treated as SHAs.
comment_has_sha() {
  printf '%s' "$1" \
    | tr -c '0-9A-Za-z' '\n' \
    | grep -E '^[0-9a-fA-F]{7,40}$' 2>/dev/null \
    | grep -qi '[a-f]' 2>/dev/null
}

# (2) Pasted verification evidence. Case-insensitive for the phrase markers
# (which never appear in idle prose); case-SENSITIVE for a standalone `PASS`
# so lowercase "tests pass"/"gate green"/"verified" prose does NOT count.
comment_has_proof() {
  b=$1
  if printf '%s' "$b" | grep -Eiq \
    'test result|[0-9]+ +passed|cargo (test|clippy)|```|screenshot|https?://[^[:space:]]+\.(png|jpe?g|gif|svg|webp|bmp)'; then
    return 0
  fi
  # standalone uppercase PASS token (e.g. "result: PASS"), case-sensitive
  if printf '%s' "$b" | grep -Eq '(^|[^A-Za-z])PASS([^A-Za-z]|$)'; then
    return 0
  fi
  return 1
}

# --- Built-in offline self-tests --------------------------------------------

sha_ok=ee8c2f236ac97a0e1976df46189d517abce07ceb

assert_sha() { # desc body want(0|1)
  if comment_has_sha "$2"; then got=1; else got=0; fi
  if [ "$got" = "$3" ]; then echo "ok: $1 (sha=$got)"; else
    echo "FAIL: $1 — sha want=$3 got=$got" >&2; fail=1; fi
}
assert_proof() { # desc body want(0|1)
  if comment_has_proof "$2"; then got=1; else got=0; fi
  if [ "$got" = "$3" ]; then echo "ok: $1 (proof=$got)"; else
    echo "FAIL: $1 — proof want=$3 got=$got" >&2; fail=1; fi
}

run_builtin_fixtures() {
  echo "=== offline self-tests: SHA matcher ==="
  assert_sha "full 40-hex SHA"                 "Merged: $sha_ok" 1
  assert_sha "short SHA with letters (ee8c2f2)" "sha ee8c2f2 landed" 1
  assert_sha "PR number alone (#102)"          "PR #102 closed Fixes #102" 0
  assert_sha "pure-decimal 7 digits"           "count 1234567 items" 0
  assert_sha "too short (6 hex)"               "abc123 blob" 0
  assert_sha "date 20260718"                   "closed 20260718 done" 0

  echo "=== offline self-tests: proof matcher ==="
  assert_proof "rust test-result line" "test result: ok. 7 passed; 0 failed" 1
  assert_proof "N passed"              "final: 3 passed" 1
  assert_proof "cargo clippy line"     "\$ cargo clippy --all-targets" 1
  assert_proof "fenced block"          "output:\n\`\`\`\nstuff\n\`\`\`" 1
  assert_proof "screenshot link"       "see https://example.com/a.png" 1
  assert_proof "uppercase PASS token"  "gate: PASS" 1
  assert_proof "bare prose 'tests pass'" "Tests pass. Gate green. Verified." 0
  assert_proof "empty"                 "" 0

  echo "=== offline self-tests: combined standard ==="
  good="Merged: $sha_ok
test result: ok. 3 passed"
  if comment_has_sha "$good" && comment_has_proof "$good"; then
    echo "ok: SHA+proof satisfies standard"
  else echo "FAIL: SHA+proof should satisfy standard" >&2; fail=1; fi
  shaonly="Merged commit $sha_ok. Looks fine, closing."
  if comment_has_sha "$shaonly" && ! comment_has_proof "$shaonly"; then
    echo "ok: SHA without pasted proof is rejected"
  else echo "FAIL: SHA-without-proof should be rejected" >&2; fail=1; fi
  proofonly="test result: ok. 1 passed but no commit named"
  if comment_has_proof "$proofonly" && ! comment_has_sha "$proofonly"; then
    echo "ok: proof without SHA is rejected"
  else echo "FAIL: proof-without-SHA should be rejected" >&2; fail=1; fi

  echo "=== offline self-tests: duplicate detection ==="
  if command -v jq >/dev/null 2>&1; then
    dj='[{"id":"a","body":"same close"},{"id":"b","body":"same close"},{"id":"c","body":"unique"}]'
    n=$(printf '%s' "$dj" | jq -r '[.[].body]|group_by(.)|map(select(length>1))|length')
    if [ "$n" = "1" ]; then echo "ok: duplicate bodies detected"; else
      echo "FAIL: duplicate detection missed identical bodies (got groups=$n)" >&2; fail=1; fi
    uj='[{"id":"a","body":"x"},{"id":"b","body":"y"}]'
    n2=$(printf '%s' "$uj" | jq -r '[.[].body]|group_by(.)|map(select(length>1))|length')
    if [ "$n2" = "0" ]; then echo "ok: unique bodies not flagged"; else
      echo "FAIL: duplicate detection false-positive (got groups=$n2)" >&2; fail=1; fi
  else
    echo "warn: jq absent — skipping duplicate-detection self-test"
  fi
}

# --- Fixture-file mode -------------------------------------------------------

run_fixture_file() {
  f=$1
  if [ ! -f "$f" ]; then echo "error: fixture missing: $f" >&2; exit 1; fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq required for --fixture" >&2; exit 1; fi
  if ! jq -e . "$f" >/dev/null 2>&1; then
    echo "error: invalid JSON: $f" >&2; exit 1; fi

  echo "=== fixture: $f ==="
  # Emit per record: id <TAB> expect <TAB> dup(dup|uniq) <TAB> base64(body)
  tmp=$(mktemp)
  jq -r '
    ([ .[].body // "" ] | group_by(.) | map({k: .[0], c: length})) as $counts
    | .[] as $r
    | (($counts[] | select(.k == ($r.body // "")) | .c) // 1) as $c
    | [ ($r.id // "?"), ($r.expect // "pass"),
        (if $c > 1 then "dup" else "uniq" end),
        (($r.body // "") | @base64) ] | @tsv
  ' "$f" > "$tmp"

  while IFS="$TAB" read -r id expect dupf b64; do
    body=$(printf '%s' "$b64" | base64 -d 2>/dev/null || true)
    if comment_has_sha "$body"; then has_sha=1; else has_sha=0; fi
    if comment_has_proof "$body"; then has_proof=1; else has_proof=0; fi
    if [ "$dupf" = "dup" ]; then is_dup=1; dupes_found=$((dupes_found + 1)); else is_dup=0; fi

    if [ "$has_sha" -eq 1 ] && [ "$has_proof" -eq 1 ] && [ "$is_dup" -eq 0 ]; then
      pass=1; else pass=0; fi

    reason=""
    [ "$has_sha" -eq 0 ] && reason="${reason}no-sha "
    [ "$has_proof" -eq 0 ] && reason="${reason}no-proof "
    [ "$is_dup" -eq 1 ] && reason="${reason}duplicate-body "

    if { [ "$pass" -eq 1 ] && [ "$expect" = "pass" ]; } \
      || { [ "$pass" -eq 0 ] && [ "$expect" = "fail" ]; }; then
      echo "ok: fixture $id (expect=$expect${reason:+, ${reason% }})"
    else
      echo "FAIL: fixture $id expect=$expect but standard-pass=$pass (${reason:-clean})" >&2
      fail=1
    fi
  done < "$tmp"
  rm -f "$tmp"

  # Surface duplicate groups explicitly (the #180 anti-pattern).
  jq -r '
    [ .[] | {b: (.body // ""), id: (.id // "?")} ]
    | group_by(.b) | map(select(length > 1)) | .[]
    | "DUPLICATE: byte-identical closing body shared by " + ([.[].id] | join(", "))
  ' "$f" || true

  if [ "$fail" -ne 0 ]; then
    echo "check_close_proof(fixture): FAILED" >&2; exit 1; fi
  echo "check_close_proof(fixture): OK"
  exit 0
}

# --- Live gh sampling (blocking, scoped strictly after CUTOFF) ---------------

# Extract the CLOSING comment body of issue $1: the last comment matching a
# close marker, else the last comment overall.
closing_comment_body() {
  gh issue view "$1" --repo "$REPO" --json comments --jq '
    ([.comments[] | .body]) as $all
    | ([.comments[]
         | select(.body | test("Closed with proof|Closes? #|Fixes? #|Closed:"; "i"))
         | .body]) as $marked
    | (if ($marked | length) > 0 then $marked[-1] else ($all[-1] // "") end)
  ' 2>/dev/null || printf ''
}

run_gh_sample() {
  if ! command -v gh >/dev/null 2>&1; then echo "skip: gh not available"; return 0; fi
  if ! command -v jq >/dev/null 2>&1; then echo "skip: jq not available"; return 0; fi
  if [ -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && ! gh auth status >/dev/null 2>&1; then
    echo "skip: gh not authenticated"; return 0
  fi
  REPO="${GITHUB_REPOSITORY:-chriscase/ContextDesk}"
  echo "=== live sample: remediation closed AFTER $CUTOFF (repo $REPO) ==="

  list=$(mktemp)
  if ! gh issue list --repo "$REPO" --label remediation --state closed --limit 200 \
      --json number,closedAt \
      --jq '.[] | "\(.number) \(.closedAt[0:10])"' > "$list" 2>/dev/null; then
    echo "skip: gh issue list failed (treated as infra, not a violation)"
    rm -f "$list"; return 0
  fi

  dupmap=$(mktemp)
  gh_fail=0
  checked=0
  while read -r num day; do
    [ -n "$num" ] || continue
    # Enforce strictly AFTER cutoff; leave on/before-cutoff history untouched.
    case "$day" in "$CUTOFF") continue ;; esac
    if [ "$(printf '%s\n%s\n' "$day" "$CUTOFF" | LC_ALL=C sort | tail -1)" != "$day" ]; then
      continue   # cutoff sorts last => day < cutoff => history, skip
    fi
    body=$(closing_comment_body "$num")
    checked=$((checked + 1))
    if ! comment_has_sha "$body"; then
      echo "FAIL: #$num closed $day — no commit SHA in closing comment (docs/CLOSE_PROOF.md)" >&2
      gh_fail=1
    fi
    if ! comment_has_proof "$body"; then
      echo "FAIL: #$num closed $day — no pasted verification in closing comment" >&2
      gh_fail=1
    fi
    enc=$(printf '%s' "$body" | base64 | tr -d '\n')
    printf '%s\t%s\n' "$enc" "$num" >> "$dupmap"
  done < "$list"

  # Duplicate closing bodies across DIFFERENT post-cutoff issues.
  for enc in $(cut -f1 "$dupmap" | sort | uniq -d); do
    [ -n "$enc" ] || continue
    ids=$(awk -F'\t' -v e="$enc" '$1==e{print "#"$2}' "$dupmap" | tr '\n' ' ')
    echo "FAIL: byte-identical closing body shared by $ids (scripted anti-pattern)" >&2
    gh_fail=1
  done

  echo "gh checked=$checked (post-cutoff)"
  rm -f "$list" "$dupmap"
  return $gh_fail
}

# --- Docs-present checks -----------------------------------------------------

check_docs() {
  if [ ! -f "$ROOT/docs/CLOSE_PROOF.md" ]; then
    echo "FAIL: missing docs/CLOSE_PROOF.md" >&2; fail=1; fi
  if [ -f "$ROOT/docs/ISSUE_HONESTY.md" ] \
    && ! grep -q "close-proof standard" "$ROOT/docs/ISSUE_HONESTY.md"; then
    echo "FAIL: ISSUE_HONESTY.md missing close-proof standard link" >&2; fail=1; fi
}

# --- main --------------------------------------------------------------------

case "${1:-}" in
  --fixture)
    run_fixture_file "${2:?fixture path required}"
    ;;
esac

run_builtin_fixtures
check_docs

if [ "${1:-}" = "--offline" ]; then
  :
else
  if ! run_gh_sample; then fail=1; fi
fi

echo "check_close_proof: fail=$fail dupes_flagged=$dupes_found"
if [ "$fail" -ne 0 ]; then
  echo "check_close_proof: FAILED" >&2
  exit 1
fi
echo "check_close_proof: OK"
exit 0
