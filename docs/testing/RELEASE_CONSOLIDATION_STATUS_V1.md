# Release consolidation status v1

Status: **candidate ready for owner review and merge approval**

Feature freeze: no non-blocking feature work is being added to this release
candidate while owner review and merge approval are pending.

This record describes the candidate on
`integrate/release-consolidation-v1`. It intentionally separates the exact
code/build identity from the later documentation commits.

## Identity and ancestry

- Consolidation code/evidence tip before this status record: `2dc828beb282f5c338b4a60f3cea454f2d57aea2`
- Current branch tip: resolve `git rev-parse HEAD` after fetching the branch; documentation and scoped CI commits may advance it
- Exact code/build pin: `a79069445dc79aba835e7627ec75c8cbbffd5492`
- Scoped CI mitigations: `52fc2f51c9c692a042e26fc9e3719c3c77967231` (bounded Linux parallelism) and `498b5b79c31f3ceb5b141446d1f3c7feccaa6824` (single Linux test/build worker; workflow-only)
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
| Exact release binary identity | pass; embedded `git=a79069445dc7` |

Binary SHA-256 for the exact code pin:

`34e9d7b773cb2d46e20ea7b8ec8df97e2d7fd286efcc645a2e59cbe873a5c8eb`

The code pin includes the pure-rustfmt follow-up and the cross-platform fixture
line-ending contracts. The former closes the nested Tauri workspace formatting
mismatch; the latter keeps manifest-hashed ledger and Triage SDK golden JSON
byte-stable on Windows. Neither changes product logic.

## Live evidence

The share-safe Vercel and employer observations are recorded in
`RELEASE_LIVE_EVIDENCE_V1.md`. They support product-path usefulness for the
named runs; they do not create universal model or gateway badges.

## Remaining release actions

1. Full GitHub CI has passed on run `31762796754` at branch tip
   `9ae170715fb72e156e2921c93fb64fae83997cfe`, including Windows portability,
   Ubuntu/macOS workspace tests, desktop/Tauri checks, and secret scanning.
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

The Ubuntu workspace CI retry three times lost hosted-runner communication during the
large test step without a test assertion failure, including once after bounded
parallelism. The latest workflow-only mitigation serializes Linux test/build work;
it does not alter the exact runtime/build pin or binary identity.

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
`RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md`; draft PR #873 is open, mergeable, and
CI-green, but it has not been approved or merged.

The read-only verifier `docs/testing/verify-release-consolidation.sh` passes on
the current tip and proves the exact pin, accepted ancestry, clean state,
merge-tree result, docs-or-scoped-CI post-pin scope, required evidence files, and
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
