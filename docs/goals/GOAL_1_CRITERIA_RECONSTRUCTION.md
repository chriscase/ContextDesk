# Goal 1 — Trusted investigation discovery

Provenance. This text is the owner objective supplied for the correction of
draft PR #1181. It was not in Git when implementation began. An earlier commit
on this branch, `493c6abdd84ff59b4f043872170fbd5a6ae0c327`, froze only the
five-item TID-1..TID-5 subset in
`GOAL_TRUSTED_INVESTIGATION_DISCOVERY.md`. That subset is historical evidence.
It is not G1-01 through G1-10. This file does not rewrite that commit.

`01-STANDING-INSTRUCTIONS.md` was not readable on this machine when this
artifact was added. No standing-instruction rules were invented.

## Acceptance criteria

G1-01 — complete, discoverable controls

Expose software-impact, contributor, and recorded-range controls for every registered collection consumer: the four existing presentations at the observed baseline. Retain their layout differences, but give them equivalent query capability and truthful active-filter summaries. Support clear-one and clear-all without losing unrelated location state. Switching presentation must not clear the shared query. No fifth strategy.

G1-02 — canonical URLs and input validity

Filters round-trip through the canonical Investigations URL, including reload and browser back/forward. Preserve the authoritative parser and existing reject-unknown normalization; no second competing validator or cursor parser. Malformed/empty/unknown-key impact identity, invalid dates/ranges, invalid identity tokens, and overlong query text must not issue a malformed request or imply an accepted narrower search. Preserve existing safe canonicalization behavior and test the actual resulting request and UI; a silent fallback must not be displayed as though the rejected filter remains active.

Do not serialize cursor, schema ID, page size, request-generation IDs, or secrets into the browser URL. A structurally valid identity absent from current top facets is not automatically an invalid contract value. Preserve the selected filter and allow clearing it without inventing a count or fetching unauthorized labels.

G1-03 — server-authoritative facets and semantics

Read impact identity objects from server facet payloads; never parse a display label or decode the facet key to reconstruct authority. Counts come from the authorized server projection, not visible rows. Respect the bounded top facets and otherCount; do not claim the dropdown enumerates every authorized value or invent an endpoint to fetch the remainder. Use only already-authorized label sources; render a neutral identity fallback when necessary. Keep selected values understandable when absent from the returned facet window.

Label the new range explicitly as recording/creation time. Prefer explicit timezone-bearing instant input, or implement a documented timezone conversion using existing helpers. Test offset equivalence, invalid/reversed ranges, and both inclusive endpoints. If using date-only controls, define start/end-of-day and daylight-saving behavior and test it; do not truncate the last day accidentally. Retain any observed-date page-local control only with explicit local scope, including after continuation.

G1-04 — continuation, refresh, and ordering

Use only server-returned opaque cursors. Preserve server order; deduplicate by stable first occurrence across pages, retaining newest server facets/archive count/cursor per the existing foundation. Do not reorder by client severity/date/popularity or replace the server's membership logic. Disable duplicate concurrent continuation. Query/identity/authority changes invalidate old continuation work. Distinguish first-page refresh from retrying a failed continuation. A stale cursor must offer a truthful restart path, never loop invisibly or mix old and new scopes.

G1-05 — first-render and stale-action safety

Verify shell -> adapter -> Runtime -> presentation, not only the lower-level hook. On identity, authority, or semantic query change, old rows/facets/cursors/errors/action callbacks cannot be used under the new scope even before passive effects run. An old response resolving afterward must not resurrect the old page. Test stored callbacks as well as late promises. An account without read authority makes zero collection requests, reveals no previous rows/counts, and has no operative retry/load-more control. Preserve same-scope stale-data disclosure without retaining another scope's data.

G1-06 — truthful user states

Cover initial loading, unfiltered empty, filtered empty for EACH filter family and combinations, unavailable query capability, first-fetch failure, same-scope refresh failure, continuation failure, stale-cursor restart, and authority loss. Show explicit stale wording where old same-scope rows remain. A network failure is not zero results. A filter not present in a particular top-facet window is not proof that it is unauthorized or nonexistent. Reset and retry must have predictable, tested behavior.

G1-07 — real four-presentation journey

Use a safe synthetic corpus exceeding one server page. Include records that cannot be found on the first page, overlapping continuation fixtures, archived records, distinct impact identities, distinct contributors, and dates around both boundaries. Through each real presentation: apply filters -> verify request and results -> copy/reload canonical location -> switch presentation -> continue -> open the correct canonical investigation. Include back/forward and clearing the last filter. Do not claim that importing a shared component proves it is actually mounted or wired.

Use at least one real disposable-server journey through the production contract/server/Runtime path. Supplement it with controlled route/gateway fault injection for error timing. Distinguish mocked and real-backend evidence in the report. No private corpus or live LLM is needed.

G1-08 — accessibility and usability

Every control has a visible label and accessible name. Verify keyboard operation, focus retention/return after filtering/reset/load-more, semantic grouping, screen-reader status text, and no hidden active filters at narrow width. Test 320px and normal desktop layouts, forced colors, and reduced motion across the real consumers. Screenshots must come from the built synthetic application; no generated mockups as acceptance evidence. Automated accessibility checks do not equal a real assistive-technology audit; state what was performed.

G1-09 — negative proof and regression protection

Add adversarial tests that fail if: contributor/date are dropped by an adapter; impact identity is reconstructed from labels; local rows are used for whole-collection counts; duplicate pages accumulate; a prior scope response/action is accepted; denied reads issue requests; a filtered empty view claims there are no recorded investigations; invalid input broadens the query while the UI still claims the filter is active. Demonstrate controlled mutation sensitivity for at least three load-bearing guarantees, including scope fencing and one query-forwarding path. Keep mutations out of the published tree.

G1-10 — gates, documentation, publication

Run focused tests first, then the actual collaboration workspace gates and browser suite at the exact candidate. At the observed baseline these scripts exist:

cd collab
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e

Use the repository's browser/dependency setup and disposable service policy. Honor root/desktop gates required by AGENTS and existing CI; this collaboration-only scope is not permission to weaken or edit workflow selection. Report which gates ran locally versus on hosted CI, exact checkout SHAs, failures/skips, and artifact availability. Do not call an environment-skipped persistence test a pass.

Update relevant user help and the proven-methods handbook/status matrix when the user workflow or context flow changes; record a specific reason for any no-impact decision. Reconcile the backlog against actual shipped and candidate states without closing issues. Publish the goal, implementation, tests, small sanitized evidence, and receipt on an owned branch with one draft PR. Obtain an independent exact-head adversarial review. No merge.
