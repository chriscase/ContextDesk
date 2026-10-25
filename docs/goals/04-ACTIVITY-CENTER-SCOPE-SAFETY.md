Forward-port and complete ContextDesk Activity Center first-frame scope
safety on current main, with deterministic component proof and real browser
qualification.

Repository:
chriscase/ContextDesk

Expected current main:
c83e21fc545991f44db95cdb79942b6ce7827a02

Expected current main tree:
d6003582f73330d61b0e5b988f83116d5a9392e5

Expected current-main merge:
PR #1182

Post-merge root CI:
36057595434

Historical source candidates to inspect, not merge blindly:

PR #1165
Head: c5029e888b273b0b1cb9bf2436c888ae0e9300ac
Purpose: first-render Activity Center scope fencing and focused hook proof.

PR #1167
Head: a2c5d4c5c55064c0a664e2bbdb10af654c17c435
Purpose: public-browser Activity Center qualification.

Historical candidates are source material only. Both were built on an older
main. Reimplement or forward-port the still-valid behavior against current
main; do not rebase and merge either historical PR as-is.

## Product outcome

An operator must never see or operate on Activity Center data from a previous
identity, authority, filter, or enabled/read scope—not even during the first
committed render before passive effects execute.

The surface may retain previously loaded data only during a same-scope refresh,
and only with truthful loading or stale/failure presentation.

The completed journey must preserve:

- server-owned activity filtering;
- opaque server cursors;
- canonical resource reauthorization before navigation;
- explicit retry;
- no hidden default filter;
- no reads for a denied or disabled account;
- no stale callback capable of acting under a replacement scope;
- no old rows, investigation metadata, cursor, failure, or load-more control
  during a scope transition.

This is a trust-boundary correction, not a redesign of Overview.

## 1. Repin and establish the baseline

Before editing:

1. Fetch origin.
2. Verify `origin/main` and its tree.
3. Verify the working tree is clean.
4. Inspect post-merge root CI run `36057595434`.
5. Record all completed, failed, cancelled, skipped, queued, and in-progress
   jobs honestly.

If `origin/main` moved after `c83e21fc`, repin the goal to the new exact main
and inspect the delta before implementation.

If root CI `36057595434` or a successor exact-main run fails:

- determine whether the failure is attributable to current main;
- do not conceal it inside this feature goal;
- report `BLOCKED_BY_BASELINE_FAILURE` if a real main defect remains.

If the run is still in progress, source inspection and local implementation may
proceed, but do not publish a draft PR or claim a green baseline until a
terminal exact-main result exists.

## 2. Freeze the exact goal

Create a fresh branch and worktree from the verified current main:

integrate/activity-center-scope-safety-v2

Before production changes, commit this complete goal text verbatim as:

docs/goals/04-ACTIVITY-CENTER-SCOPE-SAFETY.md

If that exact path is already occupied on the verified base, use the next
unused numeric goal prefix and record the selected path before making code
changes.

Record:

- base SHA;
- base tree;
- merge base;
- exact goal-file SHA-256;
- historical #1165 and #1167 heads;
- current-main source paths inspected.

Do not substitute a reduced acceptance summary for the complete goal.

## 3. Read before changing code

At minimum inspect:

- AGENTS.md
- docs/AGENT_WORKFLOW.md
- docs/design/PROVEN_METHODS.md
- docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md
- collab/web/src/overview/use-activity-center.ts
- collab/web/src/overview/use-activity-center.test.tsx
- the Overview presentation component and gateway
- shell identity and capability projection
- canonical investigation-resource resolution
- current Activity Center browser specifications
- current E2E filename inventory
- the exact patches and reviews for #1165 and #1167
- Goal 1's current `37-trusted-investigation-discovery.spec.ts`

Do not assume that the historical patches apply cleanly or remain complete.

## Acceptance contract

### ACS-01 — Exact provenance and current ownership

The implementation must:

- begin from the verified current main;
- distinguish inherited current-main behavior from newly forward-ported work;
- preserve Goal 1 and PR #1182 unchanged;
- treat #1165 and #1167 as historical design/test evidence;
- avoid importing old-main changes outside the narrow Activity Center scope.

Do not rewrite or force-push historical branches.

### ACS-02 — Synchronous first-render concealment

On the first render after any change in:

- authenticated identity;
- authority/capability scope;
- activity filter;
- enabled state;
- readable versus denied state;

the returned Activity Center controller must synchronously conceal all
prior-scope publication.

At minimum this includes:

- activity rows;
- retained previous rows;
- investigation metadata used by the surface;
- next cursor;
- load-more state and action availability;
- open/resolve failure;
- retry or stale notices tied to the old scope;
- any visible count or empty-state interpretation derived from those values.

Do not depend on `useEffect` running before the concealment becomes true.

A same-scope refresh is the only case in which prior rows may remain visible.

### ACS-03 — Captured callbacks fail closed

Capture callbacks from a published render, then transition identity, authority,
filter, and enabled state.

Prove that old callbacks cannot:

- continue old pagination;
- resolve or open an old locator;
- publish an old failure;
- replace new-scope rows;
- leak an old opaque cursor;
- issue a request using old authority.

At minimum, stale `loadMore` and `open` callbacks must fail closed.

A generic refresh callback may refresh the current scope, but it must never
resurrect the previous filter or scope.

### ACS-04 — Request and result fencing

Preserve and qualify:

- aborting old activity, investigation, and resolve requests;
- generation fencing;
- rejection of late successes and failures;
- deduplication of continued activity;
- opaque cursor handling;
- stale or malformed cursor restart;
- explicit continuation retry;
- no mixed pages after restart.

Late promises from an old scope must be unable to republish rows, cursor,
errors, or action state.

### ACS-05 — Truthful same-scope refresh

For a same-scope refresh:

- previously loaded rows may remain visible;
- loading must be represented truthfully;
- refresh failure must retain rows only with explicit stale/failure wording;
- a network or protocol failure must never appear as an empty collection;
- cursor and load-more state must not imply that continuation remains valid
  while the base page is being replaced;
- explicit retry must preserve the current filter.

Cover first-load failure separately from refresh failure.

### ACS-06 — Denied and disabled behavior

When initially disabled or lacking investigation-read authority:

- issue zero activity reads;
- issue zero case-list reads;
- issue zero locator-resolution requests;
- expose no retry, continuation, or open action;
- publish no prior user’s rows or failure;
- remain non-busy after the denied state is established.

Transitioning from readable to denied must conceal the readable state
synchronously.

### ACS-07 — Canonical open behavior

Opening a recorded activity must continue to:

- pass through the authoritative resource-resolution endpoint;
- navigate only to a validated canonical investigation route;
- refuse malformed, missing, unauthorized, or protocol-invalid resolution;
- avoid navigation when a resolve request becomes stale;
- provide truthful user feedback for a current-scope failure;
- clear old failure feedback on a new scope.

Do not replace canonical resolution with direct client-side route assembly.

### ACS-08 — Real browser qualification

Create a new browser specification using the next unused numeric prefix on
current main.

Do not reuse `37-*`. Goal 1 already owns:

collab/e2e/specs/37-trusted-investigation-discovery.spec.ts

The browser qualification must cover:

1. Overview remains distinct from Investigations.
2. A real recorded activity opens through canonical resolution.
3. A filtered 503 is presented as failure, not false-empty.
4. Retry keeps the filter and does not expose cursor state in the URL.
5. A no-read session performs zero activity/case reads.
6. Previously visible activity is absent after the denied projection.
7. Keyboard operation and focus are usable.
8. The surface reflows without horizontal overflow at 320px.
9. Semantic form, region, status, alert, and navigation roles remain useful.
10. Forced-colors mode preserves a discernible focus indicator and meaningful
    boundaries.
11. Reduced-motion mode removes or suppresses the relevant transition/scroll
    motion.

The browser may use route interception for deterministic network failures, but
must label that proof accurately.

Do not claim that a full-login remount proves React’s same-tree first render.
Focused hook tests own that deterministic guarantee.

The previous #1167 review noted weak forced-colors/reduced-motion proof.
Strengthen that proof rather than merely copying its assertions.

### ACS-09 — Adversarial and mutation-sensitive proof

Add focused deterministic tests for:

- identity transition;
- authority transition;
- filter transition;
- enabled-to-disabled transition;
- initially disabled zero requests;
- same-scope refresh retention;
- old continuation callback;
- old open callback;
- late success;
- late failure;
- current-scope retry.

Demonstrate mutation sensitivity for at least:

1. Removing synchronous publication masking.
2. Removing the stale callback scope check.
3. Allowing an initially disabled controller to request data.
4. Allowing a late old-scope result to publish.

For each mutation:

- state the temporary mutation;
- record the exact test that failed;
- restore the correct implementation;
- rerun the test successfully;
- leave no mutant in the branch.

Do not use arbitrary sleeps, additional retries, weaker assertions, or larger
timeouts as the primary repair.

### ACS-10 — Documentation and handoff

Update the living delivery backlog so it no longer claims:

- the old baseline;
- Activity Center as an unfinished broad feature;
- PR #1181 as unmerged.

The backlog should truthfully record:

- Trusted Investigation Discovery as shipped through #1181;
- the desktop synchronization repair as shipped through #1182;
- this Activity Center scope-safety slice as the current integration goal;
- S3 ambiguous-upload reconciliation as the preferred successor;
- #1158 as useful but lower-priority test qualification;
- unmerged historical branches as source material, not shipped behavior.

Evaluate the relevant Proven Methods chapter and status matrix. This change
alters a visible trust boundary, so update the handbook unless exact inspection
shows that its current text already describes this guarantee. Do not use a
generic “Handbook impact: none” without source-backed reasoning.

Create:

docs/goals/ACTIVITY_CENTER_SCOPE_SAFETY_RECEIPT.md

The receipt must map ACS-01 through ACS-10 to exact source, tests, artifacts,
commands, and revisions.

## 4. Scope boundaries

Expected production scope should remain narrow, centered on:

- collab/web/src/overview/use-activity-center.ts
- its focused tests
- one newly numbered Activity Center browser specification
- goal, receipt, backlog, Help/handbook material only where warranted

A directly necessary presentation correction is allowed when proven by a
failing acceptance test.

Do not change:

- Activity Center server contracts;
- permissions or capability semantics;
- collection-wide discovery behavior;
- strategy selection;
- S3 behavior;
- evidence upload behavior;
- Operations Queue saved views;
- desktop code;
- dependency versions;
- workflow definitions.

Do not incorporate #1158, #1159, #1166, #1168, #1170, or #1173 into this
branch.

## 5. Required verification

Use the repository shared build cache policy where applicable.

Run, at minimum:

1. Focused Activity Center hook/controller tests.
2. The focused tests at least 20 consecutive times without retry masking.
3. Web typecheck.
4. Web lint.
5. Full serialized web suite.
6. Web production build.
7. E2E typecheck.
8. The new Chromium specification with retries disabled.
9. The new specification at least 5 consecutive times with one worker.
10. Existing Overview and shell browser journeys.
11. Full applicable E2E suite.
12. Dependency-boundary checks.
13. Diff check.
14. Handbook/claims structural checks when documentation changes.
15. All applicable repository gates from AGENTS.md.

Clearly distinguish:

- real server/browser journeys;
- route-injected fault journeys;
- deterministic hook tests;
- screenshots;
- mutation demonstrations;
- skipped environment-dependent tests.

Do not call a skip a pass.

## 6. Publication

After the verified current-main baseline has a terminal successful result:

1. Push the fresh owned integration branch.
2. Open one coherent draft PR to main.
3. Do not modify #1165 or #1167.
4. Do not close historical PRs.
5. Do not mark the new PR ready.
6. Do not merge.
7. Obtain hosted collaboration and root CI on the exact head.
8. Obtain a fresh independent exact-head review.

Historical #1165 and #1167 should be closed as superseded only after the new
replacement branch is independently accepted and merged.

## 7. Final response format

### A. Verdict

One of:

READY_FOR_REVIEW
CHANGES_REQUIRED
BLOCKED_BY_BASELINE_FAILURE
BLOCKED_BY_MISSING_EVIDENCE

### B. Exact state

- repository
- branch
- draft PR
- base
- merge base
- head
- tree
- current main
- working-tree state

### C. Historical-source disposition

For #1165 and #1167:

- exact source head;
- behavior reused;
- behavior changed;
- behavior rejected;
- why direct rebase/merge was not used.

### D. Acceptance ledger

ACS-01 through ACS-10, each marked:

- proven;
- partial;
- blocked;
- not performed.

Every proven criterion must cite exact evidence.

### E. Verification

For each command:

- exact command;
- checkout SHA;
- environment;
- pass/fail;
- file/test counts;
- retries;
- skips;
- artifacts.

Include mutation results and hosted workflow IDs.

### F. Changed files

List every changed path and why it belongs to this goal.

### G. Nonclaims

State explicitly:

- Goal 1 was not modified;
- desktop behavior was not modified;
- no server/permission/storage contract changed;
- browser login remount is not first-render proof;
- route interception is not live provider proof;
- nothing was merged;
- no historical PR was closed.

### H. Successor recommendation

Re-evaluate current main and recommend whether the S3 ambiguous-upload
reconciliation vertical is ready to become the next integration goal.
