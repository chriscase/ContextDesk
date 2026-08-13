# Release consolidation status v1

Status: **candidate prepared; remote CI and merge approval pending**

Feature freeze: no non-blocking feature work is being added to this release
candidate while remote CI and review are pending.

This record describes the candidate on
`integrate/release-consolidation-v1`. It intentionally separates the exact
code/build identity from the later documentation commits.

## Identity and ancestry

- Consolidation code/evidence tip before this status record: `2dc828beb282f5c338b4a60f3cea454f2d57aea2`
- Current documentation tip: resolve `git rev-parse HEAD` after fetching the branch
- Exact code/build pin: `160deb66cf64e77e5ffc37865f25817a7b0f2fc8`
- Accepted triage runtime ancestor: `fcfdd30d1e52ee0fa379cce4682a79c51ce252c6`
- Successful demo branch ancestor: `0638e2776d9e68e936302b8be6aa757b62690dcf`
- Merge simulation with `origin/main`: clean; no conflicts
- Main checkout and the pre-existing dirty acceptance worktree were not changed

The dirty acceptance checkout remains a preserved, non-authoritative working
copy on `integrate/acceptance-release-v1` at its own historical pin. Its
uncommitted procedure edits were not inspected for adoption or overwritten.
Acceptance operators must use this consolidation branch and its exact code pin,
not that older checkout, once the owner opens the promotion PR.

## Local gates

| Gate | Result |
| --- | --- |
| Rust workspace tests (`--workspace --all-targets --locked`) | 113 suites; 3,621 passed; 0 failed; 21 ignored |
| Rust formatting | pass |
| Rust workspace clippy (`-D warnings`) | pass |
| Tauri host check | pass |
| Tauri host clippy (`-D warnings`) | pass |
| Desktop typecheck | pass |
| Desktop lint | 0 errors; 9 warnings |
| Desktop tests and packaging checks | 192 Vitest files / 1,888 tests; 54 Node checks; all pass |
| Demo PowerShell contract suite | 8 passed, including parser and executable preflight under local `pwsh` |
| Claims, CLI docs, protocol fixtures, evidence drift, packaging, media checks | pass |
| Exact release binary identity | pass; embedded `git=160deb66cf64` |

Binary SHA-256 for the exact code pin:

`2b294f078eeff8e47b85d5daf0580d14b25aae94c12487729a78e6997db596df`

## Live evidence

The share-safe Vercel and employer observations are recorded in
`RELEASE_LIVE_EVIDENCE_V1.md`. They support product-path usefulness for the
named runs; they do not create universal model or gateway badges.

## Remaining release actions

1. Open a review PR for this branch and run the repository's full GitHub CI
   matrix, including Windows portability and secret scanning.
2. Obtain final independent exact-SHA review and owner approval.
3. Replace or close obsolete release PR #860 and draft PRs #870/#871 only
   after the replacement PR is accepted.
4. Audit open issues #861, #863–#872 and record which acceptance criteria are
   complete versus deliberately deferred to the next development cycle.

Those issue bodies still contain unchecked acceptance criteria, so none were
auto-closed or relabeled as complete during consolidation.

As of the final audit, the superseded PRs remain open and were not modified:

- #860: `integrate/evidence-investigation-final-rc2` → `main`, head
  `677a3b621b92c5c88b21b684cce677b63d70dbd9`, non-draft and mergeable but
  superseded by this candidate.
- #870: `agent/gateway-diagnostic-budget` → `integrate/acceptance-release-v1`,
  head `17a854f506561634f63d07c9d83cbd5af70057f6`, draft and conflicting.
- #871: `agent/gateway-diagnostic-redaction` →
  `integrate/acceptance-release-v1`, head
  `61f9fc1019d76b39590097c228b2bd92a7952109`, draft and conflicting.

They require owner-approved retirement after the replacement PR is accepted;
closing them now would erase useful historical review context.

No new feature feedback is part of this candidate unless it identifies a
release-blocking defect. The current shared build target is retained for
reproducibility; only missing worktree registrations and disposable verification
worktrees have been pruned.

## Post-demo lane review

The latest delegated lanes were reviewed against this candidate before the
release handoff:

- Claude's `contextdesk/adversarial-verify-m82zyb` is historical evidence for
  the earlier `a3a5263e` baseline. Its Ollama timeout fix is already present in
  this candidate; its qualification tests document cancellation residuals but
  do not represent a current-head review.
- Claude's `retrieval-safety-pass-88408b8` closes five real retrieval-diagnostic
  safety gaps, but its production patch is based on `88408b8` and conflicts
  with the later embedding/rerank transport contracts already in this
  candidate. It is therefore preserved as a follow-up lane, not merged by
  guesswork into the release candidate.
- The Triage Policy V2 runner lane remains a substantial experimental
  contributor-led SDK/CLI slice. Its own report says Tauri/server selection,
  finalizer/reviewer execution, retrieval specialists, and live-provider
  evidence remain open; it is not required for the successful single-model
  demo and remains next-cycle work.
- The Grok adversarial policy and qualification audits are hermetic, historical
  test evidence on earlier ancestors. Their covered invariants are represented
  by the current workspace gates or remain tracked in the open issues; no
  source changes were copied without a current-head review.

This review found no new release-blocking defect in the accepted demo path.
The retrieval safety pass is the highest-value follow-up after the release
candidate is accepted; it must be rebased and re-gated rather than cherry-
picked across conflicting transport code.

The approval-gated PR command and remote CI checklist are captured in
`RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md`; no PR has been opened yet.

The read-only verifier `docs/testing/verify-release-consolidation.sh` passes on
the current tip and proves the exact pin, accepted ancestry, clean state,
merge-tree result, docs-only post-pin scope, required evidence files, and
release-document hygiene. Its shell syntax check passes, and an intentionally
wrong code pin is rejected before any other check.

The complete requirement-by-requirement completion audit is recorded in
`RELEASE_REQUIREMENT_AUDIT_V1.md`.

The local host now has PowerShell 7 available, so the harness parser and
provider-free preflight were exercised here. This does not replace the
Windows-runner job: Windows source/build and platform-specific behavior still
require the owner-authorized PR CI matrix.

## Verified worktree cleanup

Before handoff, the following clean, branch-backed worktrees were verified to
be ancestors of this candidate and were removed as disposable checkout
registrations. Their Git branches and commits remain available locally/remotely;
the protected main checkout and the dirty acceptance checkout were not touched:

| Removed worktree | Preserved branch |
| --- | --- |
| `contextdesk-demo-batch-v1` | `integrate/demo-batch-v1` |
| `contextdesk-final-integration` | `integrate/acceptance-release-v1-final` |
| `contextdesk-multimodel-v2` | `feat/multimodel-contribution-reconcile-v1` |
| `contextdesk-release-quality-v2` | `integrate/release-quality-v2` |
| `contextdesk-telemetry-summary-authority-v1` | `fix/telemetry-summary-authority-v1` |
| `contextdesk-triage-policy-sdk-v2` | `integrate/triage-policy-sdk-v2` |

No uncommitted files were present in those worktrees. The shared Rust target
and all unmerged or dirty worktrees were retained.
