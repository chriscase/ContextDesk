# Release requirement audit v1

This matrix is the completion audit for the post-demo consolidation candidate.
It distinguishes locally proven work from evidence that can only exist after an
owner-authorized pull request and remote CI.

Candidate branch: `integrate/release-consolidation-v1`  
Exact code/build pin: `a79069445dc79aba835e7627ec75c8cbbffd5492`
Current documentation tip: resolve `git rev-parse HEAD` after fetching the
branch; the current docs/CI tip is `7395610612dd389e79b57f2e19703b6c68416155`.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Reconcile triage runtime and demo batch | Merge commit `68743152717c92c2901ce02e9a1c30e3859378bf`; both accepted SHAs are ancestors | Proven |
| Preserve exact accepted build identity | Detached release build reported `git=a79069445dc7`; binary SHA is recorded in the status document | Proven locally |
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
| Windows/platform behavior | Windows, macOS, and Ubuntu Rust jobs passed in CI run `31762796754` | Proven remotely |
| Privacy and secret scanning | CI run `31762796754` passed gitleaks, claims, close-proof, GUI, and desktop privacy-related gates | Proven remotely |
| Exact mergeability | PR #873 reports `mergeable=true`, `mergeable_state=clean`; merge base is `main` | Proven remotely |
| Remaining blockers recorded | Status, handoff, live-evidence, and acceptance documents list residuals and do not issue universal readiness claims | Proven locally |
| PR plan prepared | `RELEASE_CONSOLIDATION_PR_HANDOFF_V1.md` contains the exact owner-run command and gate checklist | Proven locally |
| Obsolete worktree cleanup | Six clean, incorporated worktrees removed; branches preserved; dirty/unmerged worktrees retained | Proven locally |
| Feature freeze | Status document records no non-blocking feature work during this candidate | Proven locally |
| Merge to `main` | Requires owner authorization, PR review, remote CI, and merge approval | Pending external approval |

## Decision

The candidate is review-ready: all automated local and remote gates are green,
and the independent exact-pin review found no release-blocking defect. It is
not merged until the owner approves PR #873 and the deferred issue criteria are
acknowledged. The read-only verifier remains the evidence-drift guard; it does
not replace human approval.
