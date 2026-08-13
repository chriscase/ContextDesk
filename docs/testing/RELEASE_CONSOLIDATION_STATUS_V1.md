# Release consolidation status v1

Status: **candidate prepared; remote CI and merge approval pending**

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
| Demo PowerShell contract suite | 8 passed |
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

No new feature feedback is part of this candidate unless it identifies a
release-blocking defect. The current shared build target is retained for
reproducibility; only missing worktree registrations and disposable verification
worktrees have been pruned.
