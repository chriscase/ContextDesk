# War Room continuous delivery backlog

This is the living delivery queue for ContextDesk's War Room. It is not a
promise to implement stale requests in written order. At every protected merge
the owner reconciles the queue against the new `main`, removes work that is
already shipped, rechecks dependencies and risks, selects the highest-value
ready slice, freezes its exact base, and starts that slice when it does not
conflict with protected work.

Baseline for Goal 07: `main` `0d6d592c5b9cca6b041a7f5eb7f5ef86442e5d11`,
tree `92ee16477790bfd45f9729153c4a2c4bec2fe66a`. Goal 06 joined the
earlier foundations on main through merged PR #1185.

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

This makes “define the next slice” part of completion rather than a separate
planning pause.

## Shipped foundations that must not be reimplemented

- Four switchable investigation presentations: War Room, Investigation First,
  Keystone, and Beacon. Overview remains a shell surface, not a strategy.
- Public Investigation Runtime, strategy conformance tests, identity fencing,
  contribution/situation writes, evidence annotations, and shared handoffs.
- Local and S3-compatible evidence storage, evidence workspace behavior, and
  administrator storage status/configuration.
- Sparse-safe investigation records, streamed evidence upload and preview,
  recoverable archive lifecycle, LDAP bootstrap/recovery, and audited server
  authority.

Old design documents and open branches may predate these foundations. Their
“missing” lists are evidence to recheck, not current backlog truth.

## Shipped foundation — Investigation Activity Center

**Outcome:** make `/` a useful cross-investigation command surface rather than
a second rendering of the selected Investigations experience.

The shell owns this surface. It reads the existing server-owned activity
projection and case status counts through a dedicated typed browser gateway.
It does not join the public strategy runtime and cannot write investigation
data.

Required behavior:

- Overview and Investigations are distinct mounts; changing UI strategy never
  changes Overview.
- Latest recorded activity, recorded open-thread facts, and explicit handoffs
  are visible without inventing urgency, SLA, priority, or completeness.
- Server-supported kind, stage, and date filters are explicit; no hidden
  `assignedToMe` default.
- Pagination treats the cursor as an opaque server token, de-duplicates rows,
  and restarts cleanly when the server rejects a stale continuation.
- Loading, empty, filtered-empty, denied, malformed, network, and refresh
  failure are distinct. A failed refresh may retain the last successful rows
  only with an explicit stale/failure notice.
- Opening an activity reauthorizes its locator, then follows only a validated
  canonical investigation route.
- Identity/capability/filter changes abort and fence old requests. The first
  render after that change conceals the previous rows, cursor, failure, and
  load-more control before passive effects run. A no-read account performs no
  activity, case, or resolve request.
- Keyboard, focus, semantic structure, 390/560-pixel reflow, forced colors,
  and reduced motion are release evidence, not prose-only aspirations.

The browser contract exports activity DTOs and parsers without Node crypto or
cursor decoding. Cursor generation, fingerprinting, and request validation
remain server-only.

## Active unmerged slice — trusted human review of imported responses

Goal 05 is shipped through merged [PR #1184](https://github.com/chriscase/ContextDesk/pull/1184).
Its [frozen contract](../goals/05-S3-EVIDENCE-RECONCILIATION.md) and
[receipt](../goals/S3_EVIDENCE_RECONCILIATION_RECEIPT.md) retain their qualification
limits. Historical #1159, #1166, #1168, #1170, and #1173 are closed
superseded sources, not open prerequisites. The old duplicate-push Software
Impact caption observation remains separate reliability evidence.

Goal 06 shipped through merged [PR #1185](https://github.com/chriscase/ContextDesk/pull/1185).
Its [contract](../goals/06-TRUSTED-EXPORT-HANDOFF.md) and
[receipt](../goals/TRUSTED_EXPORT_HANDOFF_RECEIPT.md) preserve the export and
manual-import evidence. Historical #1177 and #1179 remain source material.

Goal 07 is the current local draft. It adds a focused, append-only human
assessment history for a manually imported response while preserving the
separate legacy Save review status and resolution. The authoritative server
records actor, time, citations, sequence, audit and replay intent; War Room
Capture presents provenance, disagreement and deliberate reconciliation after
an uncertain response. The [frozen contract](../goals/07-TRUSTED-HUMAN-REVIEW.md)
defines the exact review gates. Assessment rows remain outside the portable
archive schema, so affected exact operations must refuse rather than drop
history. This draft is not merged or a claim of measured triage quality.

## Deferred successor queue

Trusted Investigation Discovery shipped through merged PR #1181. The desktop
investigation-team save-status synchronization shipped through merged PR #1182.
Activity Center first-frame scope safety shipped through #1183. S3 recovery
shipped through #1184. Unmerged historical branches remain source material.
Goal 07 is the active unmerged slice above; the candidates below and #1158
remain deferred and are not authorized by this checkpoint.

1. **Evidence annotation workspace and safe bulk metadata.** Build on the
   shipped append-only annotation contract: compact review, structured tags or
   labels, cross-artifact selection, and safe bulk actions without mutating
   artifact identity or bypassing case permissions.
2. **Investigation search and facets.** Collection-wide recorded status, entity,
   software impact, contributor, and date filters shipped through #1181. Tags
   still need a canonical contract before they are a backlog item of their own.
3. **Product/version/build catalog quality.** Reuse recorded values across
   investigations, expose administrator-assisted deduplication later, and
   avoid creating a second software-impact truth model.
4. **Evidence storage operations.** Add copy-verify migration, health history,
   and later retention/trash policy. A migration must never delete its source
   automatically.
5. **Additional UI strategy only when differentiated.** A fifth strategy must
   pass a measured task comparison against the four shipped choices and use
   public runtime seams only. Novel appearance is not enough.
6. **Portable and administrative depth.** Represent human assessments in a
   future versioned archive only after an exact, privacy-preserving round trip
   is designed and qualified. Extend other archive/export and policy surfaces
   only where shipped investigation or storage data cannot yet be operated safely.
7. **Measured review quality.** Compare whether cited human review improves
   triage decisions with a separately authorized evaluation; this goal records
   assessments but makes no benchmark or automatic correctness claim.

## Ranking rules

A candidate moves to the front when it has high daily user value, a stable
public/server contract, a bounded dependency graph, credible automated and
hands-on evidence, and no collision with protected work. It moves back when it
duplicates shipped behavior, depends on an unowned authority seam, expands
retention/storage migration prematurely, or offers only cosmetic variation.

The successor decision packet must name the exact base, user outcome, unique
capability, file/authority boundary, dependencies, non-goals, risks, test and
demo evidence, integration order, and the next candidate after it.
