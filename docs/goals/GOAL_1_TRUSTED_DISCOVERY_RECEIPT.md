# Goal 1 receipt — trusted investigation discovery

This receipt supersedes `TRUSTED_INVESTIGATION_DISCOVERY_RECEIPT.md` for
acceptance. That older file is the historical TID-1..TID-5 map. It is not
G1-01 through G1-10.

Behavior through the query fence is `612a4bce`. The checked product head is
`0b5de58d`. Each presentation's Load next page request must carry the server
cursor and both recorded bounds. Hosted collab, release qualification, and
root CI for that exact SHA succeeded. An independent review of that SHA
passed with no open issues. The commit that records those checks is
documentation only.

## Pins

| Pin | Value |
| --- | --- |
| Base `origin/main` | `10073524218496926f7e06df654b33fb1c4609fa` |
| Main tree | `e88d8e6b20397d52d7084db0dfcb9c0dbd6a37c9` |
| Merge base | `10073524218496926f7e06df654b33fb1c4609fa` |
| Behavior head | `612a4bce90a09eb7ac0adda9ca4587ca793a1caf` |
| Behavior tree | `b2cf0458fb52cc854704da67e01ee4381ba52da8` |
| Checked publication head | `0b5de58d74fc099b5871ab1df6cbc0f926e8d703` |
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
| G1-07 | Met for the disposable server; fixture pagination stays labeled | `trusted-discovery-built-server-browser.mjs` creates 52 records, two impact identities, contributor `identity-synth-eve`, and one archived row. On each presentation it applies the shared query, continues with a real cursor, reloads the canonical URL, uses back and forward, selects the contributor and the alpha impact, clears the last filters, and opens the newest investigation. `routeInjected` is false. Each presentation throws unless its own Load next page request contains the server cursor and both recorded bounds. A request from the previous presentation's filtered navigation cannot satisfy that check. Each report flag is the observed URL or request predicate, and `openedId` is the case id in the landed URL. The local re-run of this script exited 0 with all four presentations true and the same `openedId`. Spec 37 remains route-injected. |
| G1-08 | Met for the checks that were performed | Visible labels, keyboard clear, focus return, 320px, forced colors, and reduced motion are in spec 37. Screenshots from the built app: `docs/goals/trusted-discovery-screenshots/`. No assistive-technology audit was performed. |
| G1-09 | Met | Shipped tests fail when forwarding drops impact, contributorId, recordedFrom, or recordedTo, when a label is treated as authority, when a denied reader issues a request, or when invalid input stays active. Setting `recordedFrom` to null in both adapters failed both command tests; restore passed. The earlier query-forwarding, invalid-input, and scope-fence mutations also failed and were restored. None of those mutants are in the published tree. |
| G1-10 | Met for exact head `0b5de58d` | Help article `find-investigations` is published. The backlog says draft #1181 is not shipped. Hosted collab, browser qualification, release qualification, and root/desktop CI for `0b5de58d` succeeded. An independent review of that head passed with no open issues. |

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

Journey head `b23fb1ed2fbbcf022ec884664c10956ab4589f44`, attempt 1:

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35889607552` | success. Typecheck/lint/test/build job `107278446790`. Browser qualification `107278446709`. Bridge `107278446791`. Degraded lane `107278446561`. Windows `107278446895`. |
| collab | `35889602561` | success. Same five jobs, ids `107278429883`, `107278429768`, `107278429846`, `107278429499`, `107278429696`. |
| collab-qualify | `35889607591` | success. Job `107278446255`. |
| collab-qualify | `35889602542` | success. Job `107278427968`. |
| CI | `35889607549` | success. Desktop UI `107278449087`. Tauri host ubuntu `107278449205` and macos `107278449221`. Rust aggregates ubuntu `107293138039`, macos `107295349490`, windows `107296193380`. Gitleaks `107278450179`. |

Skipped on that CI run: `rust cache warmup (macos-latest)` job `107278602371` and `rust cache warmup (windows-latest)` job `107278627264`. Those are cache jobs, not test passes. No collab, browser, desktop, Tauri, or rust test job failed or was skipped.

Predicate journey head `8a7ae5534dde280016d74210119912eac5f58af4`, attempt 1:

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35895543211` | success. Typecheck/lint/test/build job `107298799184`. Browser qualification `107298798974`. Bridge `107298799203`. Degraded lane `107298798630`. Windows `107298799170`. |
| collab | `35895536201` | success. Same five jobs, ids `107298410810`, `107298410245`, `107298410526`, `107298410609`, `107298410589`. |
| collab-qualify | `35895543490` | success. Job `107298807401`. |
| collab-qualify | `35895536374` | success. Job `107298409720`. |
| CI | `35895543350` | success. Desktop UI `107314277255`. Tauri host ubuntu `107314277146` and macos `107314276922`. Rust aggregates ubuntu `107328981305`, windows `107332648731`, macos `107335590436`. Gitleaks `107314276947`. |

Skipped on that CI run: `rust cache warmup (macos-latest)` job `107314438845` and `rust cache warmup (windows-latest)` job `107314459130`. Those are cache jobs, not test passes. No collab, browser, desktop, Tauri, or rust test job failed or was skipped.

Request-assertion head `88eccd0efd0d8f2d6809cd84c098ee80881e8a4b`, attempt 1. This is not `79975204`.

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35915176429` | success. Typecheck/lint/test/build job `107364738234`. Browser qualification `107364737650`. Bridge `107364738156`. Degraded lane `107364738095`. Windows `107364738223`. |
| collab | `35915171811` | success. Same five jobs, ids `107364721629`, `107364721727`, `107364721363`, `107364721594`, `107364721819`. |
| collab-qualify | `35915176547` | success. Job `107364738360`. |
| collab-qualify | `35915171810` | success. Job `107364721604`. |
| CI | `35915176391` | success. Desktop UI `107364737808`. Tauri host ubuntu `107364738137` and macos `107364737996`. Rust aggregates ubuntu `107380236326`, windows `107380687381`, macos `107381091813`. Gitleaks `107364737687`. |

Skipped on that CI run: `rust cache warmup (macos-latest)` job `107364869608` and `rust cache warmup (windows-latest)` job `107364925758`. Those are cache jobs, not test passes. No collab, browser, desktop, Tauri, or rust test job failed or was skipped.

Continuation-bound head `0b5de58d74fc099b5871ab1df6cbc0f926e8d703`, attempt 1:

| Workflow | Run | Conclusion |
| --- | --- | --- |
| collab | `35926759941` | success. Typecheck/lint/test/build job `107403586271`. Browser qualification `107403586287`. Bridge `107403586462`. Degraded lane `107403586387`. Windows `107403586042`. |
| collab | `35926756209` | success. Same five jobs, ids `107403574104`, `107403573743`, `107403574048`, `107403574076`, `107403574020`. |
| collab-qualify | `35926759808` | success. Job `107403585393`. |
| collab-qualify | `35926756234` | success. Job `107403573903`. |
| CI | `35926759830` | success. Desktop UI `107403586543`. Tauri host ubuntu `107403586503` and macos `107403586229`. Rust aggregates ubuntu `107415951330`, macos `107415514128`, windows `107416567003`. Gitleaks `107403586201`. |

Skipped on that CI run: `rust cache warmup (macos-latest)` job `107403707361` and `rust cache warmup (windows-latest)` job `107403725046`. Those are cache jobs, not test passes. No collab, browser, desktop, Tauri, or rust test job failed or was skipped.

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

Review of exact head `b23fb1ed` passed with two suggestions and no defects.
Those suggestions were the literal journey flags and the switch check that
required only `q`. `8a7ae553` closes both.

Review of exact head `8a7ae553` passed with no open issues. `appliedQuery`,
`reloadedCanonicalQuery`, and `restoredOnBack` are the observed `q`,
`recordedFrom`, and `recordedTo` predicates after the presentation switch,
reload, and back/forward. `continuationHasCursor` is a collection request
that has `cursor` while the page URL does not. `clearedLastFilter` is the
absence of the shareable filter keys. `openedId` is the case id in the URL
accepted after the click, and `openedAfterClear` requires that id to be the
newest case. Deleting a throw leaves the stored field as that predicate, so
it can be false. Spec 37 stays route-injected. A local disposable-server run
of this script exited 0 with all four presentations true and the same
`openedId`.

Review of exact head `88eccd0e` passed with no open issues. Both adapter
command tests require `contributorId`, `recordedFrom`, and `recordedTo` on
the runtime command.

Review of exact head `0b5de58d` passed with no open issues. `recordedRequestMark`
is gone. The recorded-bound check applies only to collection requests captured
after the on-screen Load next page click, so the previous presentation's
filtered navigation cannot satisfy it. War Room, Investigation First, Keystone,
and Beacon share that loop. Hosted CI for this review was recorded separately
and was not assumed by the review.

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
- `8a7ae553` stores journey flags from the observed URL and request. The earlier literal-flag residual applied to `b23fb1ed` and is closed on this head.
- The three mutation proofs were re-run on `c952aeea` and restored. `b23fb1ed` does not edit those lines. The published tree does not contain those mutants.
- Catalog consistency and export handoff were not started. Inspect `main` after this draft lands before recommending that slice. `main` is still `10073524218496926f7e06df654b33fb1c4609fa`.

## Next slice

Do not start catalog consistency or export handoff from this branch. After
#1181 is integrated, re-read `main` and only then decide whether that handoff
is the next slice.
