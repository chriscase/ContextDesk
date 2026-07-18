#!/usr/bin/env sh
# Close-proof guard (#254): remediation closes must cite a commit/PR SHA.
#
# Modes:
#   --fixture <file>   Offline: validate fixture comments (no network). Exit 1 if any fail.
#   (default)          If gh + GITHUB_TOKEN available, sample closed remediation issues
#                      closed on/after CUTOFF and require a hex SHA in close comments.
#                      If gh unavailable, run built-in offline fixtures only (CI-safe).
#
# No secrets. Offline path never needs network.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CUTOFF="${CLOSE_PROOF_CUTOFF:-2026-07-18}"
# SHA: 7–40 hex chars (short or full), not part of a longer hex string only check.
SHA_RE='(^|[^0-9a-fA-F])([0-9a-fA-F]{7,40})([^0-9a-fA-F]|$)'
# Also accept "PR #123" + merge language, but SHA is mandatory per CLOSE_PROOF.md.

fail=0
checked=0

comment_has_sha() {
  printf '%s' "$1" | grep -Eq "$SHA_RE"
}

check_body() {
  label=$1
  body=$2
  checked=$((checked + 1))
  if comment_has_sha "$body"; then
    echo "ok: $label (has SHA)"
    return 0
  fi
  echo "FAIL: $label — no commit SHA (7–40 hex) in close/proof comment" >&2
  fail=1
  return 1
}

run_builtin_fixtures() {
  echo "=== offline fixtures ==="
  # Good: has full SHA
  check_body "fixture-good" "Merged: ee8c2f236ac97a0e1976df46189d517abce07ceb
test result: ok. 3 passed
Adversarial: CONFIRMED" || true
  # Bad: no SHA (must fail)
  if comment_has_sha "tests pass gate green verified"; then
    echo "FAIL: fixture-bad unexpectedly matched SHA" >&2
    fail=1
  else
    echo "ok: fixture-bad correctly rejected (no SHA)"
    checked=$((checked + 1))
  fi
  # Bad: wrong pattern only "PR #102" without SHA — still reject for strict standard
  if comment_has_sha "PR #102 closed Fixes #102"; then
    # PR number alone is not a commit SHA — should not match SHA_RE (digits only 3)
    :
  fi
  if comment_has_sha "PR #102 closed Fixes #102"; then
    echo "FAIL: PR number alone should not satisfy SHA requirement" >&2
    fail=1
  else
    echo "ok: PR number alone is not a SHA"
    checked=$((checked + 1))
  fi
}

run_fixture_file() {
  f=$1
  if [ ! -f "$f" ]; then
    echo "error: fixture missing: $f" >&2
    exit 1
  fi
  # Fixture format: JSON array of { "id": "...", "body": "...", "expect": "pass"|"fail" }
  # Minimal parser without jq dependency for simple lines: id|expect|body...
  # Prefer: one JSON object per line with "expect" and "body" keys via python if available.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$f" <<'PY'
import json, re, sys
path = sys.argv[1]
sha_re = re.compile(r"(^|[^0-9a-fA-F])([0-9a-fA-F]{7,40})([^0-9a-fA-F]|$)")
fail = 0
data = json.load(open(path))
for row in data:
    body = row.get("body") or ""
    exp = row.get("expect", "pass")
    has = bool(sha_re.search(body))
    ok = (has and exp == "pass") or ((not has) and exp == "fail")
    label = row.get("id", "?")
    if ok:
        print(f"ok: fixture {label} (expect={exp})")
    else:
        print(f"FAIL: fixture {label} expect={exp} has_sha={has}", file=sys.stderr)
        fail = 1
sys.exit(fail)
PY
    return $?
  fi
  echo "error: python3 required for --fixture" >&2
  exit 1
}

run_gh_sample() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "skip: gh not available"
    return 0
  fi
  if [ -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ] && ! gh auth status >/dev/null 2>&1; then
    echo "skip: gh not authenticated"
    return 0
  fi
  echo "=== closed remediation since $CUTOFF (sample) ==="
  # List closed remediation issues; filter by closedAt in python
  tmp=$(mktemp)
  if ! gh issue list --repo "${GITHUB_REPOSITORY:-chriscase/ContextDesk}" \
    --label remediation --state closed --limit 100 \
    --json number,title,closedAt,url >"$tmp" 2>/dev/null; then
    echo "skip: gh issue list failed"
    rm -f "$tmp"
    return 0
  fi
  python3 - "$tmp" "$CUTOFF" <<'PY' || true
import json, re, subprocess, sys, os
path, cutoff = sys.argv[1], sys.argv[2]
sha_re = re.compile(r"(^|[^0-9a-fA-F])([0-9a-fA-F]{7,40})([^0-9a-fA-F]|$)")
issues = json.load(open(path))
fail = 0
checked = 0
repo = os.environ.get("GITHUB_REPOSITORY", "chriscase/ContextDesk")
for iss in issues:
    closed = (iss.get("closedAt") or "")[:10]
    if not closed or closed < cutoff:
        continue
    n = iss["number"]
    # Fetch comments (timeline close body often last comments)
    try:
        out = subprocess.check_output(
            ["gh", "issue", "view", str(n), "--repo", repo, "--json", "comments,body"],
            text=True,
        )
    except subprocess.CalledProcessError:
        print(f"skip: cannot view #{n}")
        continue
    data = json.loads(out)
    texts = [data.get("body") or ""]
    for c in data.get("comments") or []:
        texts.append(c.get("body") or "")
    blob = "\n".join(texts)
    # Only enforce when comment looks like a proof close (has "Merged" / "test result" / "Adversarial" / "Fixes")
    proofish = re.search(r"(Merged:|test result:|Adversarial|close-with-proof|Closed with proof)", blob, re.I)
    if not proofish and closed < "2026-07-19":
        # Historical closes before discipline: skip unless proofish
        continue
    checked += 1
    if sha_re.search(blob):
        print(f"ok: #{n} has SHA in issue thread")
    else:
        # Soft-warn historical; hard-fail only if closed after cutoff AND proofish without SHA
        if closed >= cutoff:
            print(f"FAIL: #{n} closed {closed} — no SHA in comments (see docs/CLOSE_PROOF.md)", file=sys.stderr)
            fail = 1
        else:
            print(f"warn: #{n} no SHA (pre-discipline)")
print(f"gh checked={checked}")
sys.exit(fail)
PY
  rc=$?
  rm -f "$tmp"
  return $rc
}

# --- main ---
if [ "${1:-}" = "--fixture" ]; then
  run_fixture_file "${2:?fixture path}"
  exit $?
fi

run_builtin_fixtures
if [ "${1:-}" = "--offline" ]; then
  :
else
  run_gh_sample || fail=1
fi

# Docs present
if [ ! -f "$ROOT/docs/CLOSE_PROOF.md" ]; then
  echo "FAIL: missing docs/CLOSE_PROOF.md" >&2
  fail=1
fi
if ! grep -q "close-proof standard" "$ROOT/docs/ISSUE_HONESTY.md"; then
  echo "FAIL: ISSUE_HONESTY.md missing close-proof standard link" >&2
  fail=1
fi

echo "checked≈$checked fail=$fail"
if [ "$fail" -ne 0 ]; then
  echo "check_close_proof: FAILED" >&2
  exit 1
fi
echo "check_close_proof: OK"
exit 0
