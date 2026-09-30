# War Room continuous delivery backlog

This is the living delivery queue for ContextDesk's War Room. It is not a
promise to implement stale requests in written order. At every protected merge
the owner reconciles the queue against the new `main`, removes work that is
already shipped, rechecks dependencies and risks, selects the highest-value
ready slice, freezes its exact base, and starts that slice when it does not
conflict with protected work.

Baseline for Goal 09: `main` `5650f0666a42e0adfaecedd1b4d9286002dde3ba`,
tree `16fea5e5f43844daba7da7d09ad6ed651cd6eab8`. Goal 08 joined main
through merged PR #1187. Earlier baseline observations remain in their frozen
contracts and receipts.

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

## Shipped handoffs and active unmerged benchmark slice

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

Goal 07 shipped through merged [PR #1186](https://github.com/chriscase/ContextDesk/pull/1186). It adds a focused, append-only human
assessment history for a manually imported response while preserving the
separate legacy Save review status and resolution. The authoritative server
records actor, time, citations, sequence, audit and replay intent; War Room
Capture presents provenance, disagreement and deliberate reconciliation after
an uncertain response. The [frozen contract](../goals/07-TRUSTED-HUMAN-REVIEW.md)
and [receipt](../goals/TRUSTED_HUMAN_REVIEW_RECEIPT.md) retain the review gates. Assessment rows remain outside the portable
archive schema, so affected exact operations must refuse rather than drop
history. This shipment is not a claim of measured triage quality. Historical
#1177 and #1179 remain unchanged source branches; the accepted Goal 06/07
behavior shipped through #1185/#1186, not by merging those branches.

Goal 08 shipped through merged [PR #1187](https://github.com/chriscase/ContextDesk/pull/1187): [recorded software context reuse](../goals/08-RECORDED-SOFTWARE-CONTEXT-REUSE.md).
It reuses exact values and
product/version/build combinations from already loaded authorized records in
existing create and Situation editors. Suggestions can be partial; manual
entry and existing save commands remain authoritative. Historical #1174 is
source material only and stays unchanged. No catalog, software-impact identity,
new server query, or administrator deduplication shipped in this slice.

Goal 09 is the current unmerged slice: [trusted benchmark promotion and offline
handoff](../goals/09-TRUSTED-BENCHMARK-HANDOFF.md) on
`integrate/trusted-benchmark-handoff-v1`. It adds explicit promotion of an
accepted Experiment Lab decision, version review, and a separately authorized
owner-only identity-preserving file that the existing offline bench can import.
The alias-only share-safe review export remains separate. Historical #1175
remains source material. Neither a human benchmark nor evidence alignment is a
correctness verdict, and this slice does not measure provider or review quality.

## Deferred successor queue

Trusted Investigation Discovery shipped through merged PR #1181. The desktop
investigation-team save-status synchronization shipped through merged PR #1182.
Activity Center first-frame scope safety shipped through #1183. S3 recovery
shipped through #1184. Unmerged historical branches remain source material.
Goal 09 is the active unmerged slice above; the candidates below and #1158
remain deferred and are not authorized by this checkpoint.

1. **Evidence annotation workspace and safe bulk metadata.** Build on the
   shipped append-only annotation contract: compact review, structured tags or
   labels, cross-artifact selection, and safe bulk actions without mutating
   artifact identity or bypassing case permissions.
2. **Investigation search and facets.** Collection-wide recorded status, entity,
   software impact, contributor, and date filters shipped through #1181. Tags
   still need a canonical contract before they are a backlog item of their own.
3. **Product/version/build catalog quality.** Shipped Goal 08 covers bounded reuse of
   already loaded recorded values. Administrator-assisted deduplication and a
   complete catalog remain separate proposals; avoid a second software-impact
   truth model.
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
