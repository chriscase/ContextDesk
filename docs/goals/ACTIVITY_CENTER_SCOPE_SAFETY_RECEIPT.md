# Activity Center scope-safety receipt

Base at branch creation: `c83e21fc545991f44db95cdb79942b6ce7827a02`, tree `d6003582f73330d61b0e5b988f83116d5a9392e5`.
Goal freeze: `2815f019554a94afe62a3cd8f75875d140fcfd89`.
Historical sources, not merged: #1165 `c5029e888b273b0b1cb9bf2436c888ae0e9300ac`, #1167 `a2c5d4c5c55064c0a664e2bbdb10af654c17c435`.

| ID | Evidence |
| --- | --- |
| ACS-01 | Branch starts at the verified main. Goal 1 spec `37-trusted-investigation-discovery.spec.ts` and desktop code are untouched. #1165 and #1167 stay open. |
| ACS-02 | `use-activity-center.ts` returns loading without previous rows when `committedKey` is not the current publication key. Test: conceals the previous scope on the render before effects. |
| ACS-03 | `loadMore` and `open` compare the captured publication key with `liveRef`. The same test fires the stored callbacks from a layout effect and expects no resolve call and no old cursor request. |
| ACS-04 | Existing continuation, abort, and late-response tests remain. A stale cursor still reloads page one. |
| ACS-05 | Same-scope refresh test expects loading with `previous` and a null cursor, then a failed refresh that keeps those rows. |
| ACS-06 | Disabled-start test expects zero gateway calls. Readable-to-disabled paint is idle. |
| ACS-07 | `open` still calls `gateway.resolve` and returns only an authorized pathname. |
| ACS-08 | `collab/e2e/specs/38-activity-center-scope-safety.spec.ts`. The 503 is route-injected. Login as another account is not same-tree first-render proof. |
| ACS-09 | Focused tests above. Mutation log is outside the published tree. |
| ACS-10 | This receipt, `docs/goals/04-ACTIVITY-CENTER-SCOPE-SAFETY.md`, the backlog, and `INVESTIGATION_LOOP.md`. |

Handbook: `docs/design/proven-methods/INVESTIGATION_LOOP.md` states that Overview conceals the previous scope on the render that receives the new scope, before passive effects run.
