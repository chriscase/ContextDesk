# War Room activity and resource locator v1

Status: **local integration** on the War Room next-release train.
This is a collab **contract, server, store, web, and test** slice. The Overview
consumes the projection as a readable activity feed with exact native links
and a Copy link action. It does not add a desktop host or Rust change.

Schema IDs:

- `cd-collab.investigation_resource_locator.v1`
- `cd-collab.investigation_activity_item.v1`
- `cd-collab.investigation_activity_page.v1`
- `cd-collab.investigation_resource_resolve.v1`
- `cd-collab.investigation_activity_error.v1`

Routes (authenticated, read-only):

- `GET /api/investigation-activity`
- `GET /api/cases/:id/investigation-activity`
- `GET /api/investigation-resources/resolve?locator=`

`GET /api/activity` and `GET /api/overview` remain unchanged. A locator is not
an authorization token.

## Activity-source authority

Authoritative state is the existing investigation timeline (`timeline_events` /
memory timeline) plus the durable records those events name (cases, evidence,
contributions, snapshots). Activity items are a **deterministic projection**.
This slice does not persist a second feed, so there is no second source of
truth to drift.

- Duplicate delivery of the same timeline row yields the same `activityId`.
- Reordered delivery is sorted by `occurredAt DESC`, `investigationId ASC`,
  `seq DESC`, `activityId ASC`.
- A failed metadata write cannot publish a partial feed: projection runs
  inside the same store the domain write already committed.
- Rebuild / reconciliation: replay `listTimeline` / `listRecentTimeline` and
  project again. Canonical JSON of the page is byte-identical for the same
  authorized state.

Overview reads a bounded recent window of 500 source events. Investigation-
scoped reads use the full timeline for that case.

## Locator versioning

Compact form: `cdl.v1/{installationId}/{investigationId}/{kind}/{resourceId}[;rev=N]`.

JSON locators also carry a **derived** pathname
`/investigations/{uuid}/{stage}?...#section`. Parsers reject:

- unknown kinds and version ≠ 1
- malformed installation, investigation, or resource ids
- path traversal, `..`, encoded dots/slashes, fragments that do not match
- control characters and URL injection
- pathname that does not match the derived destination
- missing revision on `decision_revision`
- investigation locators whose resource id is not the investigation id

Private evidence content, credentials, excerpts, customer names, and
filenames do not appear in locators or URLs. Opaque ids remain for machine
consumers and Technical details views.

Resolution reauthorizes at request time. Cross-investigation substitution,
dangling resources, wrong revisions, and unauthorized private evidence all
fail closed as `not_found` so existence is not leaked.

## Privacy and authorization

- Investigation membership (or admin) is required to see any item.
- `owner_only` items are visible only to authorized members and never include
  filename, excerpt, or body.
- Redacted or omitted records project a generic summary such as "omitted
  evidence" without content.
- Historical restored usernames (`historical-*`) display as
  "Historical participant".
- AI / imported output has `provenanceClass` `ai_generated` or `imported` and
  `humanFinding: false`.

## Human-label behavior

Helpers never invent a title. When the recorded label is missing, a GUID, a
hash, a fingerprint, a package id, or a raw event name, the projection uses a
bounded fallback (`Evidence item`, `Workstream attempt`, `Investigation`,
`Historical participant`, `Participant`). A short numeric suffix is allowed
only for timeline event seq.

## Pagination and filtering

Opaque base64url cursors encode `{ v, occurredAt, investigationId, seq, activityId, filterFingerprint }`.
Malformed or stale cursors (including filter mismatch or a cursor whose item
is no longer in the authorized projection) fail closed. They do not restart
from the beginning.

Bounded filters: investigation, actor, activity kind, stage, workstream, time
window, and `assignedToMe` when `assignedTo` / `assigneeId` / `ownerId` is
recorded. Assigned-to-me is not invented when that identity data is absent.

## Shipped in this slice versus residual UI

Shipped here: locator contract, activity projection, authorization/privacy
boundary, memory and PostgreSQL projection over existing stores, authenticated
read APIs, the Overview feed consumer, exact shipped-section routing, copied
activity URLs, and focused tests.

**Not shipped:** Overview pagination/filter controls, desktop/Rust consumers,
an export timeline kind (export locators exist; export lifecycle projects only
when a timeline event already exists), unbounded overview history beyond the
500-event window, and any claim that AI output is a human finding.
