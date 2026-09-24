# Activity Center first-frame scope safety

Forward-port and complete ContextDesk Activity Center first-frame scope safety on current main, with deterministic component proof and real browser qualification.

Expected current main at freeze: `c83e21fc545991f44db95cdb79942b6ce7827a02`.
Expected current main tree: `d6003582f73330d61b0e5b988f83116d5a9392e5`.

Historical source candidates, not merged as-is:

- PR #1165 head `c5029e888b273b0b1cb9bf2436c888ae0e9300ac`
- PR #1167 head `a2c5d4c5c55064c0a664e2bbdb10af654c17c435`

## Product outcome

An operator must never see or operate on Activity Center data from a previous identity, authority, filter, or enabled/read scope—not even during the first committed render before passive effects execute.

The surface may retain previously loaded data only during a same-scope refresh, and only with truthful loading or stale/failure presentation.

The completed journey must preserve:

- server-owned activity filtering;
- opaque server cursors;
- canonical resource reauthorization before navigation;
- explicit retry;
- no hidden default filter;
- no reads for a denied or disabled account;
- no stale callback capable of acting under a replacement scope;
- no old rows, investigation metadata, cursor, failure, or load-more control during a scope transition.

This is a trust-boundary correction, not a redesign of Overview.

## Acceptance contract

### ACS-01 — Exact provenance and current ownership

The implementation must begin from the verified current main, distinguish inherited current-main behavior from newly forward-ported work, preserve Goal 1 and PR #1182 unchanged, treat #1165 and #1167 as historical design/test evidence, and avoid importing old-main changes outside the narrow Activity Center scope. Do not rewrite or force-push historical branches.

### ACS-02 — Synchronous first-render concealment

On the first render after any change in authenticated identity, authority/capability scope, activity filter, enabled state, or readable versus denied state, the returned Activity Center controller must synchronously conceal all prior-scope publication: activity rows, retained previous rows, investigation metadata used by the surface, next cursor, load-more state and action availability, open/resolve failure, retry or stale notices tied to the old scope, and any visible count or empty-state interpretation derived from those values. Do not depend on `useEffect` running before the concealment becomes true. A same-scope refresh is the only case in which prior rows may remain visible.

### ACS-03 — Captured callbacks fail closed

Capture callbacks from a published render, then transition identity, authority, filter, and enabled state. Old callbacks cannot continue old pagination, resolve or open an old locator, publish an old failure, replace new-scope rows, leak an old opaque cursor, or issue a request using old authority. Stale `loadMore` and `open` callbacks must fail closed. A generic refresh callback may refresh the current scope, but it must never resurrect the previous filter or scope.

### ACS-04 — Request and result fencing

Preserve and qualify aborting old activity, investigation, and resolve requests; generation fencing; rejection of late successes and failures; deduplication of continued activity; opaque cursor handling; stale or malformed cursor restart; explicit continuation retry; and no mixed pages after restart. Late promises from an old scope must be unable to republish rows, cursor, errors, or action state.

### ACS-05 — Truthful same-scope refresh

For a same-scope refresh, previously loaded rows may remain visible, loading must be represented truthfully, and refresh failure must retain rows only with explicit stale/failure wording. A network or protocol failure must never appear as an empty collection. Cursor and load-more state must not imply that continuation remains valid while the base page is being replaced. Explicit retry must preserve the current filter. Cover first-load failure separately from refresh failure.

### ACS-06 — Denied and disabled behavior

When initially disabled or lacking investigation-read authority, issue zero activity reads, zero case-list reads, and zero locator-resolution requests. Expose no retry, continuation, or open action. Publish no prior user’s rows or failure. Remain non-busy after the denied state is established. Transitioning from readable to denied must conceal the readable state synchronously.

### ACS-07 — Canonical open behavior

Opening a recorded activity must pass through the authoritative resource-resolution endpoint, navigate only to a validated canonical investigation route, refuse malformed, missing, unauthorized, or protocol-invalid resolution, avoid navigation when a resolve request becomes stale, provide truthful user feedback for a current-scope failure, and clear old failure feedback on a new scope. Do not replace canonical resolution with direct client-side route assembly.

### ACS-08 — Real browser qualification

Create a new browser specification using the next unused numeric prefix on current main. Do not reuse `37-*`. Cover Overview remaining distinct from Investigations; a real recorded activity opening through canonical resolution; a filtered 503 presented as failure, not false-empty; retry keeping the filter and not exposing cursor state in the URL; a no-read session performing zero activity/case reads; previously visible activity absent after the denied projection; keyboard operation and focus; no horizontal overflow at 320px; useful form, region, status, alert, and navigation roles; forced-colors focus and boundaries; and reduced-motion suppression. Route interception for deterministic network failures must be labeled. A full-login remount does not prove React’s same-tree first render.

### ACS-09 — Adversarial and mutation-sensitive proof

Add focused deterministic tests for identity, authority, filter, and enabled-to-disabled transitions, initially disabled zero requests, same-scope refresh retention, old continuation and open callbacks, late success, late failure, and current-scope retry. Demonstrate mutation sensitivity for removing synchronous publication masking, removing the stale callback scope check, allowing an initially disabled controller to request data, and allowing a late old-scope result to publish. Restore each mutant. Do not use arbitrary sleeps, additional retries, weaker assertions, or larger timeouts as the primary repair.

### ACS-10 — Documentation and handoff

Update the living delivery backlog so it no longer claims the old baseline, Activity Center as an unfinished broad feature, or PR #1181 as unmerged. Record Trusted Investigation Discovery as shipped through #1181, the desktop synchronization repair as shipped through #1182, this slice as the current integration goal, S3 ambiguous-upload reconciliation as the preferred successor, #1158 as useful but lower-priority, and unmerged historical branches as source material. Update the Proven Methods investigation-loop chapter and status matrix for this first-frame trust boundary unless the current text already states it. Create `docs/goals/ACTIVITY_CENTER_SCOPE_SAFETY_RECEIPT.md` mapping ACS-01 through ACS-10.
