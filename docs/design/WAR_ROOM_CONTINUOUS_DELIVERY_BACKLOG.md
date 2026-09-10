# War Room continuous delivery backlog

This is the living delivery queue for ContextDesk's War Room and related
investigation experiences. It is not a promise to implement stale requests in
written order. After every protected merge, the owner reconciles the queue
against the new `main`, removes work that is already shipped, rechecks
dependencies and risks, freezes the highest-value ready slice, and starts it
when it does not collide with protected work.

Baseline for this reconciliation: `main`
`7ddb6a58755b1e48c9334d86d6e0c03d0537cbe7`, tree
`1947bd933379d9ca469f59ae10c225cd52fcf811` (participant-coordination
qualification shipped).

## Delivery loop

Every slice must finish all six steps:

1. Verify the exact `main` commit, tree, and active protected work.
2. Compare the backlog with the capabilities that actually ship.
3. Freeze one bounded slice with explicit platform/UI ownership and acceptance
   criteria.
4. Implement it in an isolated branch without weakening authorization, audit,
   data integrity, lifecycle, storage, or canonical navigation boundaries.
5. Run focused and full verification plus an independent adversarial review.
6. Integrate through branch protection, verify the resulting `main`, publish
   the successor decision packet, and begin the successor when safe.

Only Chris marks a pull request ready and merges it to `main`. Defining the
next slice is part of completing the current slice rather than a separate
planning pause.

## Shipped foundations that must not be reimplemented

- Four switchable investigation presentations: War Room, Investigation First,
  Keystone, and Beacon. Overview and Operations are shell surfaces, not UI
  strategies.
- A public Investigation Runtime with identity and authority fencing, typed
  collection queries, contribution and situation writes, evidence annotations,
  lifecycle operations, shared handoffs, and strategy conformance tests.
- Operations Queue V1 at `/operations`, including server-owned ordering and
  scope counts, private identity-keyed saved views, explicit self claim/release,
  and capability-gated participant assignment/release. Coordinator, owner,
  workstream assignee, and decision-action owner remain distinct concepts.
- Investigation Activity Center on Overview, with a dedicated typed gateway,
  recorded activity, explicit filters, opaque-cursor continuation, canonical
  locator resolution, stale-refresh disclosure, and no-read request fencing.
- Versioned investigation collection search, status/entity/software-impact/
  contributor/date filter contracts, authorized facet counts, opaque cursors,
  and server-owned ordering. Strategy lists already consume the public query
  surface; not every contracted filter is exposed in every presentation yet.
- Append-only evidence annotations, bounded bulk annotation requests, shared
  annotation workspace behavior, streamed evidence upload and preview, and
  recoverable archive lifecycle. Annotation bodies and privacy classes are
  canonical; structured annotation tags are not yet a shipped contract.
- Local-directory and S3-compatible evidence-byte providers, secret-free
  administrator storage status/configuration, and an operator guide for
  self-hosted S3-compatible deployment. Database metadata remains authoritative
  over object bytes.
- Sparse-safe investigation records, software-impact records and catalog
  suggestions, LDAP bootstrap/recovery, audited server authority, and canonical
  investigation URLs.

Old design documents and open branches may predate these foundations. Their
“missing” lists are evidence to recheck, not current backlog truth.

## Protected integration queue — not shipped

The following items are candidates, not features on `main`. Their exact heads,
checks, and dependencies must be reverified immediately before owner action.

1. **Operations Queue qualification — PR #1158.** Saved-view browser
   qualification for already-shipped behavior. It is owner-ready at this
   baseline, but remains unmerged until Chris explicitly authorizes it.
2. **S3 ambiguous-upload safety — PR #1159 and dependent qualification/UI
   candidates.** Distinguish an upload that definitely failed from one that may
   have committed, then reconcile without blindly replaying bytes. Provider
   identity, operator CLI, and administrator binding-status candidates remain
   downstream and must not be described as shipped.
3. **Activity Center scope fencing — PR #1165 and its browser qualification.**
   Prevent stale rows or locators from crossing identity, capability, and
   filter transitions. This hardens the shipped Activity Center; it does not
   create a second Overview implementation.
4. **Reliability candidates.** Coordination, handoff, evidence-stream, catalog
   focus, and multimodel-save race fixes must retain exact reproduction and
   mutation evidence. They may be integrated independently only when their
   current bases and protected checks remain valid.
5. **Feature candidates.** Product/version/build catalog quality, accepted-
   evidence benchmark prefill, export delivery handoff, and the external-run
   judgment/provenance stack require their own exact-head reviews and protected
   integration order. An open draft is not roadmap truth.

Legacy or conflicting pull requests are classified separately as keep, park,
rederive, or close. They are never merged merely to reduce the queue.

## Next product slice after the protected queue

### Investigations collection filter completion

**Outcome:** let people filter the server-ordered investigation collection by
recorded software-impact identity, contributor, and recorded-at range wherever
the selected presentation exposes collection browsing. Make page-local filters
visibly local instead of implying that they searched the whole authorized
collection.

**Ownership boundary:** the shell owns canonical Investigations URL state; the
public Investigation Runtime carries typed queries and fenced resources; the
server owns authorized membership, facet counts, ordering, and opaque cursors;
strategies render the shared facts and controls. Strategies do not mint or
decode cursors, join records, infer labels, or issue direct transport calls.

**Required behavior:**

- Impact identity, contributor, and recorded-at filters round-trip through a
  canonical, shareable Investigations URL and reject unknown values safely.
- Filter and facet values come from the authorized server page. No strategy
  recomputes whole-collection counts from the visible page.
- Continuation preserves server ordering, de-duplicates records, and never puts
  the opaque cursor in the browser URL.
- Query, identity, and authority changes fence stale pages. A denied reader
  performs no collection request and sees no retry control.
- Loading, empty, filtered-empty, refresh failure, stale continuation, and
  unavailable query support remain distinct and truthful.
- Keyboard operation, focus return, semantic grouping, narrow reflow, forced
  colors, and reduced motion are verified across every registered collection
  consumer, not only one strategy.

**Acceptance evidence:** focused contract/server/Runtime/shell tests; full
collaboration tests, typecheck, lint, and production builds; browser journeys
covering canonical filters, all-strategy parity, continuation, failure/retry,
and read-denied zero requests; an independent exact-head adversarial review;
protected CI; then owner-authorized merge and post-merge smoke verification.

**Non-goals:** investigation tags; a new `occurredAt` query model; priority,
urgency, SLA, due dates, automatic routing, or presence locks; Operations Queue
or Overview rewrites; S3 changes; annotation tags; a fifth UI strategy; or any
strategy-owned authorization or storage behavior.

**Integration order:** finish or deliberately close #1158, the #1159 S3 safety
stack, and #1165 scope fencing; repin exact `main`; reconcile overlapping
collection/facet candidates; implement one bounded branch; review and qualify
it; let Chris merge; then choose between catalog-quality depth and evidence
storage operations from the new main.

## Provisional successor queue

This order is re-evaluated after each protected merge:

1. **Product/version/build catalog quality.** Integrate or rederive the current
   candidate on the existing software-impact identity model. Improve reuse,
   aliases, and data-entry consistency; defer administrator merge/deduplication
   until the write and audit semantics are explicit.
2. **Evidence storage operations.** After S3 unknown-outcome and provider-
   identity work lands, add durable health history and an explicit
   copy-verify-migrate workflow that never deletes the source automatically.
   Retention remains a later policy slice.
3. **Structured annotation vocabulary.** Add labels or tags only through a
   canonical, audited contract with clear visibility and merge semantics; do
   not reinterpret free-form annotation bodies.
4. **Evidence review and provenance.** Add append-only relevance judgments and
   provenance inspection without turning agreement into correctness or
   inventing gold labels, cost, or usage.
5. **Additional UI strategy only when differentiated.** A fifth strategy must
   pass measured task comparisons against the four shipped choices and use
   public Runtime seams only. Novel appearance is not enough.
6. **Portable and administrative depth.** Extend archive/export and policy
   surfaces only where shipped investigation or storage data cannot yet be
   operated safely.

## Ranking rules

A candidate moves to the front when it has high daily user value, a stable
public/server contract, a bounded dependency graph, credible automated and
hands-on evidence, and no collision with protected work. It moves back when it
duplicates shipped behavior, depends on an unowned authority seam, expands
retention or storage migration prematurely, or offers only cosmetic variation.

Every successor decision packet names the exact base, user outcome, unique
capability, file and authority boundary, dependencies, non-goals, risks,
required test and demo evidence, integration order, and the candidate after it.
