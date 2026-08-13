# Release consolidation PR handoff v1

This is the approval-gated handoff for the post-demo release candidate. No PR
has been opened by the consolidation work; the owner must decide when to open
it.

## Exact source

- Repository: `https://github.com/chriscase/ContextDesk.git`
- Branch: `integrate/release-consolidation-v1`
- Current documentation tip: resolve `git rev-parse HEAD` after fetching the
  branch; documentation-only commits may advance it.
- Exact code/build pin: `160deb66cf64e77e5ffc37865f25817a7b0f2fc8`
- Expected merge simulation: clean against `origin/main`

The documentation tip is intentionally newer than the code pin. Build and
verify the exact code pin for source acceptance; the later commits are
documentation-only evidence and handoff notes.

## Local evidence already complete

- Rust workspace: 113 suites, 3,621 passed, 0 failed, 21 ignored
- Rust format and workspace clippy: pass
- Tauri check and clippy: pass
- Desktop typecheck: pass
- Desktop lint: 0 errors, 9 existing warnings
- Desktop tests: 1,888 Vitest tests passed
- Node packaging/privacy checks: 54 passed
- PowerShell demo contract: 8 passed, including parser and executable
  provider-free preflight under local `pwsh`
- Claims, CLI docs, protocol fixtures, evidence-drift, packaging, and media
  checks: pass
- Exact source binary identity previously verified as `git=160deb66cf64`
- Vercel and employer DeepSeek product-path evidence is recorded in
  `RELEASE_LIVE_EVIDENCE_V1.md`

## Owner-approved PR creation

Run only after reviewing the status and evidence documents:

```sh
git fetch origin
git checkout integrate/release-consolidation-v1
git rev-parse HEAD
git merge-tree --write-tree origin/main origin/integrate/release-consolidation-v1
gh pr create \
  --base main \
  --head integrate/release-consolidation-v1 \
  --title "promote: release consolidation after demo" \
  --body-file docs/testing/RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md
```

The PR description should link the status and acceptance documents and should
state that live evidence is model/gateway-specific, not a universal readiness
badge.

Recommended links:

- [consolidation status](RELEASE_CONSOLIDATION_STATUS_V1.md)
- [source acceptance procedure](SOURCE_ACCEPTANCE_PROCEDURE_RELEASE_V1.md)
- [share-safe live evidence](RELEASE_LIVE_EVIDENCE_V1.md)
- [requirement audit](RELEASE_REQUIREMENT_AUDIT_V1.md)

The read-only pre-PR verifier can be rerun from the candidate checkout:

```sh
docs/testing/verify-release-consolidation.sh
```

It checks the exact code pin, accepted ancestry, clean state, merge-tree
result, documentation-only post-pin changes, required evidence files, and
release-document path/credential hygiene. It does not fetch, build, clean,
contact a provider, or create a PR.

## Required remote gates before merge

The required CI workflow is configured for `pull_request` events (and pushes
to `main`), not arbitrary feature-branch pushes. Opening the PR is therefore
what starts the authoritative multi-OS checks; a local or branch-only run is
not a substitute.

1. Full GitHub CI, including Windows/source-build and secret/privacy scans.
2. Independent exact-SHA review of the code pin and acceptance procedure.
3. Review of the open issue criteria (#861, #863–#872); leave deliberately
   deferred feature work open.
4. Owner approval of the PR and the source-based acceptance procedure.
5. Only after approval, retire superseded PR #860 and drafts #870/#871.

Do not merge the consolidation branch, close the superseded PRs, or mark the
feature issues complete from this handoff alone.
