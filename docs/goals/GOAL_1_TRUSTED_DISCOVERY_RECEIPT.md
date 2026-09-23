# Goal 1 receipt — trusted investigation discovery

This receipt supersedes `TRUSTED_INVESTIGATION_DISCOVERY_RECEIPT.md` for
acceptance. That older file is the historical TID-1..TID-5 map. It is not
G1-01 through G1-10.

Behavior is `612a4bce`. Exact publication head `1e68749f` is that behavior
plus the prior receipt text. Hosted collab, release qualification, and root
CI for `1e68749f` succeeded, and an independent review of that head passed.
The commit that adds those run ids is documentation only.

## Pins

| Pin | Value |
| --- | --- |
| Base `origin/main` | `10073524218496926f7e06df654b33fb1c4609fa` |
| Main tree | `e88d8e6b20397d52d7084db0dfcb9c0dbd6a37c9` |
| Merge base | `10073524218496926f7e06df654b33fb1c4609fa` |
| Behavior head | `612a4bce90a09eb7ac0adda9ca4587ca793a1caf` |
| Behavior tree | `b2cf0458fb52cc854704da67e01ee4381ba52da8` |
| Checked publication head | `1e68749f0992415accd233399be09a717ebfffc7` |
| PR #1181 | Draft, open, unmerged. https://github.com/chriscase/ContextDesk/pull/1181 |
| PR #1180 | Draft, open, unmerged, head `18f2e77a2cfa71caa9c85e9b34a3692a71d97404`, tree `0155061acba76b78b97bc6c7aa0bb6d42af7e547`. Ancestor of this branch. Not rewritten and not closed. |
| Owner goal artifact | `docs/goals/03-GOAL-1-TRUSTED-DISCOVERY.md`, added in `38fd2d20523b1e41329ed9ad61e0447db646ac91` |
| Owner goal SHA-256 | `5c64ca43d6b2003717c1b95b382de7fb78879d4a56be4f6e5d634d8c7a351ac9` |
| Historical TID freeze | `493c6abdd84ff59b4f043872170fbd5a6ae0c327`. Five-item subset only. Not equivalent to G1. History was not rewritten. |

`01-STANDING-INSTRUCTIONS.md` was not on this machine. No standing-instruction
rules were invented.

Readiness for #1158, #1159, and #1165 is deferred. Their files do not overlap
this slice. They were not merged or incorporated. #1179 remains an open draft
backlog edit and was not merged.

Inherited from open draft #1180, unchanged: canonical impact-identity URL
support and stable-first pagination dedup at `18f2e77a`. Everything after that
commit on `integrate/trusted-investigation-discovery-v1` is new work on this
branch. #1180 was not rewritten.

## Acceptance map

| ID | Status | Evidence |
| --- | --- | --- |
| G1-01 | Met | `CollectionDiscoveryFilters` is mounted by War Room, Investigation First, Keystone, and Beacon. Clear-one and clear-all keep unrelated location state. Switching presentation keeps the shell query. No fifth strategy. |
| G1-02 | Met | Invalid URL queries parse to the bare list. `shareableCollectionQuery` refuses a reversed range, overlong query, bad identity, or malformed impact before it is stored. The previous accepted query stays visible. The URL does not carry cursor, schema id, or limit. |
| G1-03 | Met | Facet identities come from the server object. A selected value outside the top window stays clearable and is labeled `not in the current top matches` with no invented count. Recorded dates are UTC calendar days, `T00:00:00.000Z` through `T23:59:59.999Z`, inclusive. War Room observed-from stays page-local. |
| G1-04 | Met | Opaque server cursors, first-seen dedup, and one rejected-cursor restart. The restart sentence is shown for the current scope. Spec 37's page split remains route-injected and is labeled as such. |
| G1-05 | Met | Identity and authority fencing stays in the runtime. `612a4bce` also withholds the previous rows and restart notice on the render where the shell query changes, and a continuation or refresh captured for the old query does not run. |
| G1-06 | Met | Unfiltered empty, filtered empty, denied, unavailable, first-fetch failure, same-scope refresh failure, continuation failure, and stale-cursor restart are covered. The shared empty predicate treats search, status, entity, impact, contributor, and both recorded bounds as filters, including one combination. A network failure is not zero results. |
| G1-07 | Met for the disposable server; fixture pagination stays labeled | `trusted-discovery-built-server-browser.mjs` creates 52 records, two impact identities, contributor `identity-synth-eve`, and one archived row. On each presentation it applies the shared query, continues with a real cursor, reloads the canonical URL, uses back and forward, selects the contributor and the alpha impact, clears the last filters, and opens the newest investigation. `routeInjected` is false. The re-run recorded `openedAfterClear: true` and the same `openedId` for War Room, Investigation First, Keystone, and Beacon. Spec 37 remains route-injected. |
| G1-08 | Met for the checks that were performed | Visible labels, keyboard clear, focus return, 320px, forced colors, and reduced motion are in spec 37. Screenshots from the built app: `docs/goals/trusted-discovery-screenshots/`. No assistive-technology audit was performed. |
| G1-09 | Met | Shipped tests fail when forwarding drops impact, a label is treated as authority, a denied reader issues a request, or invalid input stays active. Temporary mutations of query forwarding, invalid-input broadening, and the three runtime scope fences failed the named tests and passed after restore. Those mutations are not in the published tree. They were not repeated after `612a4bce`; that commit does not edit those mutated lines. |
| G1-10 | Met for exact head `1e68749f` | Help article `find-investigations` is published. The backlog says draft #1181 is not shipped. Hosted collab, browser qualification, release qualification, and root/desktop CI for `1e68749f` succeeded. An independent review of that head passed. `612a4bce` is the behavior parent. The diff between them is only this receipt. |

## Commands at the behavior head

Local, on this worktree:

- Web `npx vitest run` at `e21f0fc5`: 101 files, 1619 passed. That head is the parent of the query-fence commit.
- At `612a4bce`, `collection-query.test.tsx` and `useWarRoomCollectionQuery.test.tsx`: 25 passed. `tsc -p tsconfig.json --noEmit` in `collab/web` passed, and eslint on the fence files passed.
- Web production build at `612a4bce`: `npm run build -w @cd-collab/web` exited 0.
- Disposable built-server browser script, port 8858: exit 0. Report kind `built-server-browser-runtime`, `routeInjected: false`, `recordCount: 52`. Each of the four presentations has `appliedQuery`, `continuationHasCursor`, `reloadedCanonicalQuery`, `restoredOnBack`, `clearedLastFilter`, and `openedAfterClear` true, and `openedId` equal to the newest case. The script throws if any of those checks fail.
- Earlier full server suite: 1287 passed, 115 skipped. Skipped tests are environment-gated persistence tests. They are not passes.
- Earlier `npm run e2e` in `collab`: 143 passed, 8 skipped. Skipped tests are the durable-server, live-profile, bridge, and log-time lanes. They are not passes.

## Hosted checks

`8f228b88` collab run `35806168307` failed. Job `107007575613` (`collab (typecheck, lint, test, migrate dry-run)`) failed `HandoffPanel.test.tsx` because the failure copy was asserted before the in-flight recording state cleared. Browser qualification, the degraded lane, the bridge, and Windows `demo:check` on that run succeeded. Root CI run `35806168305` was cancelled before jobs started. Qualify run `35806168301` succeeded. `6de7ee4f` waits for the visible handoff outcome. That fix is in the behavior head.

Behavior head `612a4bce90a09eb7ac0adda9ca4587ca793a1caf`:

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35808188350` | success. Typecheck/lint/test/build job `107013566830`. Browser qualification job `107013566682`. Bridge `107013566522`. Degraded lane `107013566670`. Windows `107013566700`. |
| collab | `35808184801` | success. Same five jobs, ids `107013556024`, `107013555980`, `107013555974`, `107013555771`, `107013555964`. |
| collab-qualify | `35808188358` | success. Job `107013566665`. |
| collab-qualify | `35808184800` | success. Job `107013555651`. |
| CI | `35808188344` | success. Desktop UI `107014507008`. Tauri host ubuntu `107014506939` and macos `107014507083`. Rust test aggregates ubuntu `107022684410`, windows `107023622914`, macos `107023722225`. Gitleaks `107014507063`. |

Skipped on that CI run: `rust cache warmup (macos-latest)` and `rust cache warmup (windows-latest)`. Those are cache jobs, not test results, and they are not counted as passes. No persistence test was skipped inside the successful collab test job; the earlier local server skip count remains a non-pass.

Exact publication head `1e68749f0992415accd233399be09a717ebfffc7`:

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35811810521` | success. Typecheck/lint/test/build job `107024827615`. Browser qualification `107024827865`. Bridge `107024827758`. Degraded lane `107024827947`. Windows `107024827811`. |
| collab-qualify | `35811810456` | success. Job `107024827510`. |
| CI | `35811810458` | success. Desktop UI `107024828341`. Tauri host ubuntu `107024828277` and macos `107024828365`. Rust aggregates ubuntu `107032745333`, windows `107033774010`, macos `107032092574`. Gitleaks `107024828246`. |

Skipped on that CI run: the same two rust cache warmup jobs. They are not passes. Collab test, browser qualification, desktop UI, Tauri, and rust tests succeeded.

## Screenshots

From the built web app served by `collab/server/dist/index.js` against a new
sqlite file:

- `docs/goals/trusted-discovery-screenshots/built-server-war-room-1280.png`
- `docs/goals/trusted-discovery-screenshots/built-server-investigation-first-1280.png`
- `docs/goals/trusted-discovery-screenshots/built-server-keystone-1280.png`
- `docs/goals/trusted-discovery-screenshots/built-server-beacon-1280.png`
- `docs/goals/trusted-discovery-screenshots/built-server-320-forced-colors.png`
- `docs/goals/trusted-discovery-screenshots/built-server-1280.png`

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

Review of `e21f0fc5` blocked. A shell query change still published the previous
collection page, and a stored continuation was still able to run, until the
adapter effect. That review is not a pass for this head.

Review of `612a4bce` passed with no open issues. Both adapters publish a
loading view and a null restart notice when the location key differs from the
runtime query. A captured continuation or refresh returns before the passive
effect. Same-scope continuation still uses the cursor-stripped base key.

The new tests fail if the render-time loading branch or the captured-callback
ref check is removed. They do not by themselves fail if only the second
`locationOwnsCollection` return, or only the notice ternary, is removed. The
product code still has both. The fixture used by that test has a null notice,
so the paint string cannot see a leaked notice.

Review of exact head `1e68749f` passed with no open issues. The worktree was
clean. `612a4bce..1e68749f` changes only this receipt. The reviewer checked
the G1-07 script claims and the query fence against the tree at that head.

## Handbook and backlog

`docs/design/PROVEN_METHODS.md` and
`docs/design/proven-methods/INVESTIGATION_LOOP.md` do not state a claim about
collection cursor restart or the discovery filters. The restart notice and
Help article do not contradict a sentence in those files, so those chapters
were not edited. Help article `find-investigations` is the user-facing
description of recorded time versus War Room's page-local observed date.

Handbook impact: none — those chapters do not claim a collection cursor or a
discovery filter.

`docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md` says draft #1181 is not
shipped. No issue was closed. This pull request is not merged.

## Residuals and nonclaims

- No assistive-technology audit. Spec 37 and the built-app screenshots are the usability evidence.
- Spec 37 continuation is route-injected. The disposable built-server script is the real second page.
- `01-STANDING-INSTRUCTIONS.md` was unavailable.
- The three mutation proofs were not repeated on `612a4bce`. The published tree does not contain those mutants.
- Catalog consistency and export handoff were not started. Inspect `main` after this draft lands before recommending that slice. `main` is still `10073524218496926f7e06df654b33fb1c4609fa`.

## Next slice

Do not start catalog consistency or export handoff from this branch. After
#1181 is integrated, re-read `main` and only then decide whether that handoff
is the next slice.
