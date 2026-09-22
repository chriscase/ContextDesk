# Receipt: trusted investigation discovery

Source Goal 1 file: absent at `origin/main` `10073524218496926f7e06df654b33fb1c4609fa` and at foundation `18f2e77a2cfa71caa9c85e9b34a3692a71d97404`. The frozen acceptance block is `docs/goals/GOAL_TRUSTED_INVESTIGATION_DISCOVERY.md`. Its content hash is `32bda7ec117072f1ff9c346e4c00860bd4b1ec18b1d86f75aa9ab68fbab3dcd8`.

Inherited foundation, unchanged and still the head of open draft PR #1180: `18f2e77a2cfa71caa9c85e9b34a3692a71d97404`. This branch does not rewrite or close that pull request.

Handbook impact: none — presentation of the existing collection query.

## Acceptance map

| ID | Pushed revision | What it proves |
| --- | --- | --- |
| TID-1 | `b669a77f47618e59055462e0ca45505b7b688c23`, boundary move `15da1d54524ee63598fb28d8fde653b4ee6d0b2f` | Impact, contributor, and recorded-at controls on War Room, Investigation First, Keystone, and Beacon; canonical URL round-trip without cursor, limit, or schema id; browser journeys open the chosen investigation. |
| TID-2 | `b669a77f47618e59055462e0ca45505b7b688c23` | Recorded-at stays on `createdAt`, contributor matches participant identity, impact uses the normalized identity, order is newest `createdAt` then ascending id, and facet counts stay the server's authorized-collection counts. The War Room "Observed from" control stays page-local. |
| TID-3 | `b669a77f47618e59055462e0ca45505b7b688c23` | Empty, filtered-empty, loading, error, failed refresh, and denied states stay distinct. Contributor-only and recorded-date-only misses do not say that nothing was recorded. Query, identity, and authority changes drop stale rows. A denied reader issues no collection request. |
| TID-4 | `b669a77f47618e59055462e0ca45505b7b688c23` | Server order, first-occurrence dedup, explicit retry of the current scope, and stale-cursor restart. Cursors stay out of shell URLs. |
| TID-5 | freeze `493c6abdd84ff59b4f043872170fbd5a6ae0c327`; implementation `b669a77f47618e59055462e0ca45505b7b688c23`; boundary move `15da1d54524ee63598fb28d8fde653b4ee6d0b2f`; this receipt commit | Frozen goal before behavior changes, synthetic browser journeys, deterministic negative tests, mutation sensitivity, disposable production-server proof, and unchanged package gates. |

## Evidence

Session scratch, not a shared production database and not the memory fixture for the production-server proof:

- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/branch-base.txt`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/goal-freeze.txt`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/unit.log`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/server.log`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/mutation.log`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/browser.log`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/production-server.json`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/gates.log`
- `/var/folders/g9/6_vmtkmx60lghgjjrm_lqcrw0000gn/T/grok-goal-169c3779d148/implementer/web-test-2.log`

Durable in-repo proof is the committed unit tests, server tests, Playwright spec `collab/e2e/specs/37-trusted-investigation-discovery.spec.ts`, and `collab/server/scripts/trusted-investigation-discovery-server-proof.mjs`.

The publication tip is the commit that adds this receipt. It is not merged, not marked ready, and does not close #1180.
