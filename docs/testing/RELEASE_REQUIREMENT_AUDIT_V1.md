# Release requirement audit v1

This matrix is the completion audit for the post-demo consolidation candidate.
It distinguishes locally proven work from evidence that can only exist after an
owner-authorized pull request and remote CI.

Candidate branch: `integrate/release-consolidation-v1`  
Exact code/build pin: `160deb66cf64e77e5ffc37865f25817a7b0f2fc8`  
Current documentation tip: resolve `git rev-parse HEAD` after fetching the
branch.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Reconcile triage runtime and demo batch | Merge commit `68743152717c92c2901ce02e9a1c30e3859378bf`; both accepted SHAs are ancestors | Proven |
| Preserve exact accepted build identity | Detached release build reported `git=160deb66cf64`; binary SHA is recorded in the status document | Proven locally |
| Preserve user work | Main checkout and dirty acceptance checkout were never modified; dirty acceptance procedure remains preserved | Proven locally |
| Preserve Vercel/employer evidence | Share-safe ledger in `RELEASE_LIVE_EVIDENCE_V1.md` | Proven, scoped to named runs |
| Correct source acceptance procedure | Branch, exact code pin, `Asia/Tokyo`, protected-file credentials, and 600-second procedure are pinned | Proven locally |
| Review delegated audit lanes | Status document records relevant, redundant, and deferred lanes; no unreviewed conflicting patch was copied | Proven locally |
| Full Rust workspace | 113 suites; 3,621 passed; 0 failed; 21 ignored | Proven locally |
| Rust format and clippy | Workspace format and `-D warnings` clippy passed | Proven locally |
| CLI checks | Workspace tests, CLI documentation, protocol fixtures, and packaging checks passed | Proven locally |
| Desktop/Tauri host | Tauri check/clippy and desktop build passed | Proven locally |
| Frontend | Typecheck passed; lint had 0 errors and 9 existing warnings; 1,888 Vitest tests passed | Proven locally |
| PowerShell harness | `pwsh` parser and provider-free preflight passed; 8-test contract suite passed | Proven locally |
| Windows/platform behavior | Requires the repository's Windows CI runner | Pending PR/CI |
| Privacy and secret scanning | Local claims/privacy/path checks passed; gitleaks is a PR workflow gate | Pending PR/CI |
| Exact mergeability | `git merge-tree --write-tree origin/main HEAD` is clean | Proven locally |
| Remaining blockers recorded | Status, handoff, live-evidence, and acceptance documents list residuals and do not issue universal readiness claims | Proven locally |
| PR plan prepared | `RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md` contains the exact owner-run command and gate checklist | Proven locally |
| Obsolete worktree cleanup | Six clean, incorporated worktrees removed; branches preserved; dirty/unmerged worktrees retained | Proven locally |
| Feature freeze | Status document records no non-blocking feature work during this candidate | Proven locally |
| Merge to `main` | Requires owner authorization, PR review, remote CI, and merge approval | Pending external approval |

## Decision

The candidate is ready to open for review, but it is not honestly merge-ready
until the pending PR/CI/review rows are complete. The read-only verifier
`verify-release-consolidation.sh` must pass before opening the PR; it does not
replace Windows CI or human approval.
