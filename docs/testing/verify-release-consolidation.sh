#!/bin/sh
# Read-only release-candidate verifier.
#
# This intentionally performs no fetch, checkout, build, cleanup, or provider
# operation. It proves the local facts required before opening the promotion
# PR; the PR itself remains owner-authorized and remote CI remains authoritative
# for Windows/platform-specific evidence.

set -eu

EXPECTED_BRANCH=${EXPECTED_BRANCH:-integrate/release-consolidation-v1}
EXPECTED_CODE_SHA=${EXPECTED_CODE_SHA:-160deb66cf64e77e5ffc37865f25817a7b0f2fc8}
CANDIDATE_REF=${CANDIDATE_REF:-HEAD}
MAIN_REF=${MAIN_REF:-origin/main}

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

git rev-parse --verify "$CANDIDATE_REF^{commit}" >/dev/null 2>&1 ||
    fail "candidate ref is unavailable: $CANDIDATE_REF"
git rev-parse --verify "$MAIN_REF^{commit}" >/dev/null 2>&1 ||
    fail "main ref is unavailable: $MAIN_REF"
git rev-parse --verify "$EXPECTED_CODE_SHA^{commit}" >/dev/null 2>&1 ||
    fail "exact code pin is unavailable: $EXPECTED_CODE_SHA"

CANDIDATE_SHA=$(git rev-parse "$CANDIDATE_REF^{commit}")
MAIN_SHA=$(git rev-parse "$MAIN_REF^{commit}")

[ "$(git symbolic-ref --short -q HEAD || true)" = "$EXPECTED_BRANCH" ] ||
    fail "current checkout is not on $EXPECTED_BRANCH"
[ "$(git rev-parse HEAD)" = "$CANDIDATE_SHA" ] ||
    fail "HEAD does not match candidate ref"
[ -z "$(git status --porcelain=v1)" ] || fail "worktree is dirty"

git merge-base --is-ancestor "$EXPECTED_CODE_SHA" "$CANDIDATE_SHA" ||
    fail "exact code pin is not an ancestor of the candidate"

for accepted in \
    fcfdd30d1e52ee0fa379cce4682a79c51ce252c6 \
    0638e2776d9e68e936302b8be6aa757b62690dcf
do
    git merge-base --is-ancestor "$accepted" "$CANDIDATE_SHA" ||
        fail "accepted SHA is not an ancestor: $accepted"
done

MERGE_TREE=$(git merge-tree --write-tree "$MAIN_REF" "$CANDIDATE_REF") ||
    fail "candidate does not merge cleanly with $MAIN_REF"

if ! git diff --quiet "$EXPECTED_CODE_SHA..$CANDIDATE_REF" -- . ':(exclude)docs'; then
    printf '%s\n' 'Non-documentation changes after the exact code pin:' >&2
    git diff --name-only "$EXPECTED_CODE_SHA..$CANDIDATE_REF" -- . ':(exclude)docs' >&2
    fail "post-pin changes are not documentation-only"
fi

for required in \
    docs/testing/RELEASE_CONSOLIDATION_STATUS_V1.md \
    docs/testing/RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md \
    docs/testing/RELEASE_LIVE_EVIDENCE_V1.md \
    docs/testing/SOURCE_ACCEPTANCE_PROCEDURE_RELEASE_V1.md
do
    [ -f "$required" ] || fail "required release document is missing: $required"
done

if rg -n -i '(/Users/|/private/tmp|[A-Z]:\\\\Users\\\\|vck_[A-Za-z0-9]|sk-[A-Za-z0-9])' \
    docs/testing/RELEASE_CONSOLIDATION_STATUS_V1.md \
    docs/testing/RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md \
    docs/testing/RELEASE_LIVE_EVIDENCE_V1.md \
    docs/testing/SOURCE_ACCEPTANCE_PROCEDURE_RELEASE_V1.md
then
    fail 'release documents contain an absolute local path or credential-like token'
fi

printf 'PASS: release consolidation candidate verified\n'
printf 'candidate_sha=%s\n' "$CANDIDATE_SHA"
printf 'main_sha=%s\n' "$MAIN_SHA"
printf 'exact_code_sha=%s\n' "$EXPECTED_CODE_SHA"
printf 'merge_tree=%s\n' "$MERGE_TREE"
printf 'post_pin_change_scope=docs-only\n'
