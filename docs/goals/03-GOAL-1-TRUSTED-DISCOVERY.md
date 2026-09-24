# Goal 1 — trusted investigation discovery across every presentation

/goal Complete ContextDesk's collection-wide investigation discovery journey across War Room, Investigation First, Keystone, and Beacon, using the existing authorized server query and public Runtime. Deliver an isolated, pushed, reviewable implementation with exact acceptance evidence, not merely plumbing or a visual prototype.

Follow `01-STANDING-INSTRUCTIONS.md`. This goal authorizes implementation and a draft review handoff, not merge, issue closure, release, production changes, or live provider use.

## Outcome

An authorized investigator can find investigations by recorded software-impact identity, recorded participant/contributor identity, and recorded-at range; combine those filters with existing search/status/entity/archive controls; share and reopen the canonical URL; switch presentations without losing the query; continue through server-ordered results without duplicates; open the intended investigation; and understand every loading, empty, error, stale, and denied state. No presentation silently searches only the visible page while implying collection-wide results. No previous user's/query's results flash under a new scope.

## Baseline and prerequisite policy

Observed main: `10073524218496926f7e06df654b33fb1c4609fa`; tree `e88d8e6b20397d52d7084db0dfcb9c0dbd6a37c9`.
Existing foundation: PR #1180, branch `grok/contextdesk-collection-filter-foundation-v1`, commit `18f2e77a2cfa71caa9c85e9b34a3692a71d97404`, tree `0155061acba76b78b97bc6c7aa0bb6d42af7e547`.

Reverify main and candidate before work. Read #1180's full seven-file diff. Reuse its canonical impact-identity URL support and stable-first pagination deduplication only after checking compatibility. If it has already landed, do not duplicate it. Otherwise use an owned `integrate/trusted-investigation-discovery-v1` worktree, retaining the exact source commit via a documented cherry-pick or explicit branch ancestry. Do not rewrite #1180 or silently close it. The resulting PR must disclose inherited versus new changes.

Resolve the readiness checkpoint for #1158, the #1159 safety stack, and #1165 scope fencing before owner integration, or obtain an explicit owner disposition deferring a non-blocking candidate. These are not permission to incorporate the entire queue. Isolated implementation may proceed when its files and authority seams do not collide with protected work. If a prerequisite changes underneath this branch, repin and revalidate before claiming readiness.

## Read first / source map

Read actual files, not just this list:

- `docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md` on current main, and the updated version in #1179.
- `collab/contracts/src/investigation-collection-browser.ts`
- `collab/server/src/modules/cases/collection-query.ts`
- `collab/web/src/app-location.ts`
- `collab/web/src/investigations/runtime/controllers/use-investigation-list.ts`
- `collab/web/src/investigations/strategies/collection-query.ts`
- `collab/web/src/investigations/war-room/useWarRoomCollectionQuery.ts`
- `collab/web/src/investigations/war-room/WarRoomCollectionList.tsx`
- `collab/web/src/investigations/strategies/investigation-first/InvestigationFirstStrategy.tsx`
- `collab/web/src/investigations/strategies/keystone/KeystoneStrategy.tsx`
- `collab/web/src/investigations/strategies/beacon/BeaconStrategy.tsx`
- Shared collection presentation/pagination, registry/conformance code, shell wiring, and existing browser scenario registry discovered from imports/search.
- Applicable instructions, `collab/package.json`, and current CI workflows.

Known source-level trap: WarRoomCollectionList's current filtered-empty predicate includes search/status/entity/local observed date but omits contributor and recorded-range filters. Fix the user-visible truthfulness issue, not just the controls. A failed request must never become an empty success.

## Ownership and semantics

The shell owns canonical Investigations URL state. The server owns authorization, membership, facet counts, ordering, and cursor minting. The public Runtime owns typed resources, request lifetimes, identity/authority fencing, and authorized commands. Presentations render those facts and invoke the public seam. Keep helpers at the narrowest existing presentation boundary; no new cross-product framework.

Use existing semantics literally: `recordedFrom`/`recordedTo` filter case creation/recording time, NOT observed occurrence. Current server bounds are inclusive and parse explicit-offset instants. `contributorId` matches recorded participants' identity IDs; do not silently reinterpret it as any evidence uploader, author, owner, coordinator, or assignee. Software-impact identity consists of productName/version/build/component/environment; exact normalized identity is not fuzzy version matching.

## Acceptance criteria

### G1-01 — complete, discoverable controls

Expose software-impact, contributor, and recorded-range controls for every registered collection consumer: the four existing presentations at the observed baseline. Retain their layout differences, but give them equivalent query capability and truthful active-filter summaries. Support clear-one and clear-all without losing unrelated location state. Switching presentation must not clear the shared query. No fifth strategy.

### G1-02 — canonical URLs and input validity

Filters round-trip through the canonical Investigations URL, including reload and browser back/forward. Preserve the authoritative parser and existing reject-unknown normalization; no second competing validator or cursor parser. Malformed/empty/unknown-key impact identity, invalid dates/ranges, invalid identity tokens, and overlong query text must not issue a malformed request or imply an accepted narrower search. Preserve existing safe canonicalization behavior and test the actual resulting request and UI; a silent fallback must not be displayed as though the rejected filter remains active.

Do not serialize cursor, schema ID, page size, request-generation IDs, or secrets into the browser URL. A structurally valid identity absent from current top facets is not automatically an invalid contract value. Preserve the selected filter and allow clearing it without inventing a count or fetching unauthorized labels.

### G1-03 — server-authoritative facets and semantics

Read impact identity objects from server facet payloads; never parse a display label or decode the facet key to reconstruct authority. Counts come from the authorized server projection, not visible rows. Respect the bounded top facets and `otherCount`; do not claim the dropdown enumerates every authorized value or invent an endpoint to fetch the remainder. Use only already-authorized label sources; render a neutral identity fallback when necessary. Keep selected values understandable when absent from the returned facet window.

Label the new range explicitly as recording/creation time. Prefer explicit timezone-bearing instant input, or implement a documented timezone conversion using existing helpers. Test offset equivalence, invalid/reversed ranges, and both inclusive endpoints. If using date-only controls, define start/end-of-day and daylight-saving behavior and test it; do not truncate the last day accidentally. Retain any observed-date page-local control only with explicit local scope, including after continuation.

### G1-04 — continuation, refresh, and ordering

Use only server-returned opaque cursors. Preserve server order; deduplicate by stable first occurrence across pages, retaining newest server facets/archive count/cursor per the existing foundation. Do not reorder by client severity/date/popularity or replace the server's membership logic. Disable duplicate concurrent continuation. Query/identity/authority changes invalidate old continuation work. Distinguish first-page refresh from retrying a failed continuation. A stale cursor must offer a truthful restart path, never loop invisibly or mix old and new scopes.

### G1-05 — first-render and stale-action safety

Verify shell -> adapter -> Runtime -> presentation, not only the lower-level hook. On identity, authority, or semantic query change, old rows/facets/cursors/errors/action callbacks cannot be used under the new scope even before passive effects run. An old response resolving afterward must not resurrect the old page. Test stored callbacks as well as late promises. An account without read authority makes zero collection requests, reveals no previous rows/counts, and has no operative retry/load-more control. Preserve same-scope stale-data disclosure without retaining another scope's data.

### G1-06 — truthful user states

Cover initial loading, unfiltered empty, filtered empty for EACH filter family and combinations, unavailable query capability, first-fetch failure, same-scope refresh failure, continuation failure, stale-cursor restart, and authority loss. Show explicit stale wording where old same-scope rows remain. A network failure is not zero results. A filter not present in a particular top-facet window is not proof that it is unauthorized or nonexistent. Reset and retry must have predictable, tested behavior.

### G1-07 — real four-presentation journey

Use a safe synthetic corpus exceeding one server page. Include records that cannot be found on the first page, overlapping continuation fixtures, archived records, distinct impact identities, distinct contributors, and dates around both boundaries. Through each real presentation: apply filters -> verify request and results -> copy/reload canonical location -> switch presentation -> continue -> open the correct canonical investigation. Include back/forward and clearing the last filter. Do not claim that importing a shared component proves it is actually mounted or wired.

Use at least one real disposable-server journey through the production contract/server/Runtime path. Supplement it with controlled route/gateway fault injection for error timing. Distinguish mocked and real-backend evidence in the report. No private corpus or live LLM is needed.

### G1-08 — accessibility and usability

Every control has a visible label and accessible name. Verify keyboard operation, focus retention/return after filtering/reset/load-more, semantic grouping, screen-reader status text, and no hidden active filters at narrow width. Test 320px and normal desktop layouts, forced colors, and reduced motion across the real consumers. Screenshots must come from the built synthetic application; no generated mockups as acceptance evidence. Automated accessibility checks do not equal a real assistive-technology audit; state what was performed.

### G1-09 — negative proof and regression protection

Add adversarial tests that fail if: contributor/date are dropped by an adapter; impact identity is reconstructed from labels; local rows are used for whole-collection counts; duplicate pages accumulate; a prior scope response/action is accepted; denied reads issue requests; a filtered empty view claims there are no recorded investigations; invalid input broadens the query while the UI still claims the filter is active. Demonstrate controlled mutation sensitivity for at least three load-bearing guarantees, including scope fencing and one query-forwarding path. Keep mutations out of the published tree.

### G1-10 — gates, documentation, publication

Run focused tests first, then the actual collaboration workspace gates and browser suite at the exact candidate. At the observed baseline these scripts exist:

```bash
cd collab
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
```

Use the repository's browser/dependency setup and disposable service policy. Honor root/desktop gates required by AGENTS and existing CI; this collaboration-only scope is not permission to weaken or edit workflow selection. Report which gates ran locally versus on hosted CI, exact checkout SHAs, failures/skips, and artifact availability. Do not call an environment-skipped persistence test a pass.

Update relevant user help and the proven-methods handbook/status matrix when the user workflow or context flow changes; record a specific reason for any no-impact decision. Reconcile the backlog against actual shipped and candidate states without closing issues. Publish the goal, implementation, tests, small sanitized evidence, and receipt on an owned branch with one draft PR. Obtain an independent exact-head adversarial review. No merge.

## Allowed scope and non-goals

Primary implementation: existing shell/query adapters, shared collection presentation, four consumers, focused Runtime corrections if proven necessary, tests, browser fixtures, styles, and directly relevant docs. Read server/contracts to verify semantics; production changes there require a demonstrated existing-contract defect and explicit review because this goal is to expose the shipped contract, not redesign it.

No new schema/query model, observed-at server filter, tags, priority/SLA/due dates, automatic assignment, new Operations/Overview surfaces, storage-provider changes, human-judgment implementation, benchmark scorer, model router, live provider integration, fifth UI, broad CSS redesign, unrelated dependency upgrades, or CI-gate changes.

## Work plan and final handoff

Freeze this goal with acceptance IDs. Establish baseline tests and a four-consumer capability map. Reuse verified foundation work. Implement the narrow shared state/control seam, then actual consumer wiring, then complete failure/authority/browser proof. Keep useful checkpoints on one integration branch; do not stop after one control or one strategy.

Return the structured receipt, a criterion-by-criterion acceptance table, exact changed paths, source/test/CI provenance, genuine screenshots, failures/skips/nonclaims, and a next-slice recommendation. Any missing G1 criterion stays explicit and the goal is not complete. Recommend subsequent catalog consistency/export handoff work only after inspecting the newly integrated main; do not automatically start it.
