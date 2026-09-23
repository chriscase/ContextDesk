# Goal 1 receipt — trusted investigation discovery

This receipt supersedes `TRUSTED_INVESTIGATION_DISCOVERY_RECEIPT.md` for
acceptance. That older file is the historical TID-1..TID-5 map. It is not
G1-01 through G1-10.

## Pins

| Pin | Value |
| --- | --- |
| Base `origin/main` | `10073524218496926f7e06df654b33fb1c4609fa` |
| Main tree | `e88d8e6b20397d52d7084db0dfcb9c0dbd6a37c9` |
| Merge base | `10073524218496926f7e06df654b33fb1c4609fa` |
| Behavior head | `bc60b6299bd256cf09037eb5ee1febe303e6aaa4` |
| Lint-only follow-up | `77297c6ae7c76e39c903d2e39d8a279af1e9279f` removes an unused import. No behavior change. |
| PR #1181 | Draft, open, unmerged. https://github.com/chriscase/ContextDesk/pull/1181 |
| PR #1180 | Draft, open, unmerged, head `18f2e77a2cfa71caa9c85e9b34a3692a71d97404`, tree `0155061acba76b78b97bc6c7aa0bb6d42af7e547`. Ancestor of this branch. Not rewritten. |
| Owner goal artifact | `docs/goals/03-GOAL-1-TRUSTED-DISCOVERY.md`, added in `38fd2d20523b1e41329ed9ad61e0447db646ac91` |
| Historical TID freeze | `493c6abdd84ff59b4f043872170fbd5a6ae0c327`. Five-item subset only. Not equivalent to G1. |

`01-STANDING-INSTRUCTIONS.md` was not on this machine. No standing-instruction
rules were invented.

Readiness for #1158, #1159, and #1165 is deferred. Their files do not overlap
this slice. They were not merged or incorporated. #1179 remains an open draft
backlog edit and was not merged.

## Acceptance map

| ID | Status | Evidence |
| --- | --- | --- |
| G1-01 | Met on the four presentations | `CollectionDiscoveryFilters` summary, clear-one, clear-all. No fifth strategy. In-memory stage and focus are kept when the shell accepts a query. |
| G1-02 | Met for contract rejection | Invalid URL queries parse to the bare list. A reversed range or overlong query is refused by `shareableCollectionQuery` before it is stored. The previous accepted query stays visible. |
| G1-03 | Met | Facet identities come from the server object. Outside the top window, the label has no invented count. Recorded dates are UTC calendar days. War Room observed-from stays page-local. |
| G1-04 | Met for the controller | Opaque cursors, first-seen dedup, one rejected-cursor restart, and the restart sentence. The fixture browser continuation is route-injected, not a second server page. |
| G1-05 | Met for identity, authority, and a changed query | `ignores a collection command captured before the identity changes` records the first paint as idle, drops the late page, and ignores the captured command after an authority change. `does not apply a captured continuation after the query changes` keeps the new query. |
| G1-06 | Partial | Unfiltered empty, filtered empty, denied, unavailable, and same-scope refresh failure are covered. Not every filter-family combination has its own test. |
| G1-07 | Met for the built-server continuation; fixture pagination stays labeled | `trusted-discovery-built-server-browser.mjs` creates 52 records, archives one, and on each of the four presentations loads the real second page, keeps the newest row, opens the oldest investigation, and restores the recorded range. `routeInjected` is false. Spec 37's page split remains route-injected and is labeled as such. |
| G1-08 | Partial | Labels, keyboard clear at 320px, forced colors, and reduced motion are in spec 37. Screenshots: `docs/goals/trusted-discovery-screenshots/`. No assistive-technology audit was performed. The other three presentations were not screenshotted. |
| G1-09 | Partial | Shipped tests cover dropped forwarding, label reconstruction, denied reads, and invalid input. Temporary mutations of query forwarding, invalid-input broadening, and the three scope fences failed the named tests and passed after restore. Those mutations are not in the published tree. |
| G1-10 | Partial until the lint-fix head's hosted test job is green | Help article `find-investigations` is published. The backlog says draft #1181 is not shipped. Hosted browser qualification of `bc60b629` passed. The same run's lint failed on an unused import. `77297c6a` fixes that import. Its hosted run was started and is not recorded as passed here. |

## Commands at the functional commits

Local, on this worktree, after `35e19791` unless noted:

- Web `npx vitest run` at `35e19791`: 101 files, 1615 passed.
- Server `npx vitest run`: 1287 passed, 115 skipped. Skipped tests are not passes. They are environment-gated persistence tests.
- Web lint, server lint, e2e typecheck: exit 0.
- `npm run e2e` in `collab`: 143 passed, 8 skipped. Skipped tests are the durable-server, live-profile, bridge, and log-time lanes that the suite skips without those services. They are not passes.
- Spec 37 after `83fd7f1c`, retries 0, one worker: 6 passed.
- Dependency-boundary test after `bd6233bf`: passed.
- Built-server browser script: one real Runtime journey, `routeInjected: false`.

## Hosted checks

Green browser qualification of `83fd7f1c934a954ff6b28ce9b05b5f5a1f3a5d4f`,
workflow run `35803066300`, attempt 1, job `collab war-room browser
qualification` `106997590558`. The log shows spec 37 passing once each, with
no retry line. The same run's `collab (typecheck, lint, test, migrate
dry-run)` job failed because `collection-discovery.ts` imported the collection
contract. `bd6233bf` moves that check into `app-location.ts`.

Hosted collab run for behavior head `bc60b6299bd256cf09037eb5ee1febe303e6aaa4`:

- https://github.com/chriscase/ContextDesk/actions/runs/35805384871
- Browser qualification job `107005188802`: success. Degraded lane and browser bridge also succeeded.
- `collab (typecheck, lint, test, migrate dry-run)` job `107005188575`: failed lint, unused `shareableCollectionQuery` import.
- Windows `demo:check` job `107005188861`: the same lint error.

Lint-only head `77297c6a` is pushed. Its hosted conclusion is not in this receipt.

## Screenshots

From the built web app served by `collab/server/dist/index.js` against a new
sqlite file:

- `docs/goals/trusted-discovery-screenshots/built-server-1280.png`
- `docs/goals/trusted-discovery-screenshots/built-server-320-forced-colors.png`

## Mutations

Not published. On a clean tree, each inversion failed the named test, then
passed after `git checkout` restore.

| Mutation | Test | Fail | Restore |
| --- | --- | --- | --- |
| Drop `impactIdentity` in `inputForLocation` | `sends impactIdentity and does not refetch semantically identical values` | exit 1 | exit 0 |
| Parser catch keeps a query string | `drops invalid instants, reversed ranges, identity tokens, and overlong queries` | exit 1 | exit 0 |
| Remove the restart `isCurrent` check, `succeedResourceLoad` key fence, and `visible` scope fence together | `does not publish a rejected-cursor restart after the identity changes` | exit 1 | exit 0 |

Inverting only the `visible` check did not fail that test. That single edit
is not the scope-fencing proof.

## Independent review

Review of `35e19791` blocked the draft. It required the reversed-range and
overlong-query fix, an identity-stamped collection command, removal of the
tautological focus assertion, and an honest label on route-injected
pagination.

Review of `83fd7f1c` said those four points were fixed or labeled. Review of
`853bb115` accepted the late-page fence and the real second page, and asked
for a first-paint assertion, an authority check, a stale continuation after
a query change, and an open on every presentation. `bc60b629` adds those.
The rejection alert clears when the shell location changes.

## Handbook and backlog

`docs/design/PROVEN_METHODS.md` and
`docs/design/proven-methods/INVESTIGATION_LOOP.md` do not state a claim about
collection cursor restart or the discovery filters. The restart notice and
Help article do not contradict a sentence in those files, so those chapters
were not edited. Help article `find-investigations` is the user-facing
description of recorded time versus War Room's page-local observed date.

`docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md` says draft #1181 is not
shipped. No issue was closed.

## Residuals

- No assistive-technology audit.
- Spec 37 continuation is still route-injected. The built-server script is
  the real second page.
- The built-server corpus creates two impacts, one extra contributor, and one
  archived case. The browser assertions use the recorded-day search and the
  outside-day empty result. They do not click those impact or contributor
  controls.
- No assistive-technology audit. Screenshots exist for all four presentations
  at normal width and one 320px forced-colors frame.
- Hosted lint for `77297c6a` was not finished when this receipt was written.
- `01-STANDING-INSTRUCTIONS.md` was unavailable.
