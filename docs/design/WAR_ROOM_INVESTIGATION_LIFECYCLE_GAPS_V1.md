# War Room investigation ownership and lifecycle — gap report v1

Status: **gap report**. Nothing in this document is shipped behavior. It
records what a deep review of investigation ownership and lifecycle found and
deliberately did *not* build, so the next person starts from a written
position rather than re-deriving it.

Reviewed at `b2175c6894bedf17756f71a3123ea08fb865debb`. The bounded slice that
*was* implemented — archive/restore safeguards, inventory search and archived
visibility, varied demo scenarios, and the Help topic — is described in the
[Investigation loop chapter](proven-methods/INVESTIGATION_LOOP.md#14-shipped--partial--planned-matrix)
and is not repeated here.

## 1. What the review found already mature

These were candidates for work and turned out not to need any. Recording them
matters as much as recording the gaps: each is a place where a well-meaning
change would have duplicated an existing contract.

| Area | Where it already lives | Why no work was done |
| --- | --- | --- |
| Customer / organization / affected-system metadata | `contracts/src/investigation-entity.ts` | A reusable global registry with a closed six-value vocabulary (`organization`, `customer`, `person`, `service`, `system`, `other`), a six-value involvement relationship vocabulary, immutable historical attribution on each link, and an explicit boundary against the attribution catalog. Nothing customer-centric is special-cased. Adding a second "affected system" field would have forked this. |
| Historical triage dates and event-time semantics | `contracts/src/temporal.ts` | `occurredAt` versus `recordedAt` is fully modelled: precision and zone are *derived* from the recorded text so a half-stated occurrence cannot exist, zone-unspecified values are never converted or suffixed, ordering uses an explicitly-labelled approximation, and `isBackfilled` lets a surface label historical records honestly. |
| Durable activity and history | `contracts/src/investigation-activity.ts`, `server/src/modules/activity/` | Versioned `cdl.v1` resource locators, a deterministic projection, fail-closed membership/privacy resolution, and cursor pagination. |
| Share-safe labels without raw UUID noise | `web/src/technical-identity.tsx` | `TechnicalIdentifiers` and `recordNickname` already implement progressive disclosure: a record is named in words, exact identifiers stay one disclosure away, complete and copyable, and a truncated hash is never presented as a label. |
| Human-only resolution | `contracts/src/investigation-resolution.ts` | A conclusion reached by a person reading notes is first-class, with basis, provenance, rationale, unknowns, and a revision guard. |
| Stage-specific next-action guidance | `web/src/TriageWorkspace.tsx` (`Do this now:`), `web/src/HelpCenter.tsx` | Each stage already carries a next action, and the Help Center carries 40 topics organized by stage. |

## 2. Gaps deliberately not built

### 2.1 Software / version / build tags — not started

**Finding.** There is no software, version, or build concept anywhere in the
collab contracts, server, or web surface. A search for `buildTag`,
`softwareVersion`, `releaseTag`, or equivalents returns only the unrelated
log-corpus `build` phase in `log-time/`. An investigation cannot record which
release it concerns.

**Why it was not built.** This is not a bounded slice. Doing it honestly needs,
at minimum: a contract with its own controlled-vocabulary decision (free text
drifts into `v1.2`/`1.2`/`1.2.0` within a week); a store column and therefore a
migration in both the memory and PostgreSQL stores; route and situation-patch
plumbing; a place in `investigation-portable.ts` so an archived investigation
does not silently drop the field on restore; and an export/privacy decision,
because a build identifier can be disclosive. That is a subsystem, and the
review's instruction was not to invent one.

**A small safe contract, if it is picked up.** Model it as a *link*, not a
string on the case. The entity registry already solves the "same label reused
across years of investigations without retyping, renameable without rewriting
history" problem, and a software release has exactly that shape. Either add a
`software` entity kind with a version-bearing involvement, or mirror the
registry's design in a sibling module. Do not add three free-text columns to
`CaseV1`.

**What to decide first:** whether a version is an entity (reusable, renameable,
with immutable historical attribution) or a property of the investigation
(simpler, but re-typed every time and unqueryable across cases).

### 2.2 Activity filtering is reachable from the server but not the UI

**Finding.** `parseInvestigationActivityQueryFilter`
(`server/src/modules/activity/service.ts`) accepts `investigationId`,
`actorId`, `activityKind`, `stage`, `workstreamId`, `from`, `to`,
`assignedToMe`, `cursor`, and `limit`, all validated fail-closed and covered by
tests. The web surface calls `/api/investigation-activity?limit=30` and passes
none of them (`web/src/Cases.tsx`). Filtering and pagination exist and are
unreachable.

**Why it was not built.** It is genuinely bounded and worth doing, but it is UI
work in a 3,900-line component, and the review's own fallback instruction was
to prefer a coherent demo-data plus lifecycle/search/help foundation over
scattered UI. It is listed here as the highest-value next slice rather than
half-done.

**Shape of the work.** A pure query-builder module beside
`investigation-search.ts` (query string in, validated filter out, tested
directly), then a compact filter bar and a "load more" control that passes the
cursor the server already returns. No server change is required.

### 2.3 Collaborative and private investigation notes — small contract, no subsystem

**Finding.** `CaseDiscussion` (`web/src/CaseDiscussion.tsx`) is a durable
human-message surface with per-message `privacyClass` (`owner_only` /
`share_safe`), presence, and honest failure states. Contributions carry the
same privacy class. What does **not** exist: a private-to-one-person note that
is not a discussion message, drafts, threading, mentions, or notification.

**Deliberate non-goal.** Building a notes subsystem here would duplicate the
contribution contract, which already stores durable human text with kind,
privacy, provenance, revision history, and tombstoning. The honest gap is
narrower than "notes are missing".

**The small safe contract, stated rather than built.** If a private working
note is wanted, it should be a `note` contribution with `privacyClass:
"owner_only"` and no new storage: the kind and the privacy class both already
exist and are already enforced on read (`visibleBody`) and on export. What is
missing is only the *surface* — a place to write one that does not look like
posting to the discussion — plus one decision nobody has made: whether an
owner-only note survives a change of case lead, and if so, who can read it
afterwards. That decision is the actual blocker, and it is a policy question,
not an engineering one. Do not add a storage path before answering it.

### 2.4 `retentionClass` is recorded and never used

**Finding.** `retentionClass` is set to `"standard"` at case creation
(`server/src/modules/cases/service.ts`), carried through the portable archive
and the export brief, rendered in Markdown — and read by no policy anywhere. No
route changes it, and nothing acts on it.

**Why it was left.** A retention *policy* implies expiry, which implies
deletion, which the workspace deliberately does not have (§2.5). Wiring
retention without first deciding what expiry means would be the largest
possible change made for the smallest possible reason. It is recorded here so
the field is not mistaken for working machinery.

### 2.5 Deletion: answered, deliberately absent

There is no delete path for an investigation, and none was added. This is the
correct design and is now enforced rather than merely absent:
`describeDeleteRequest` returns the honest answer so a caller asking to delete
learns what exists instead of meeting an unexplained failure.

Anyone adding deletion later must revisit legal hold, audit retention, and the
portable archive together. None of the three currently assumes an investigation
can stop existing.

## 3. Starting a fresh SDK-backed triage versus comparing lanes

The review was asked to assess how a user starts a *fresh* triage against how
they merely compare existing lanes. The finding is a discoverability gap, not a
missing capability.

Both paths exist and are distinct. `TriageRunPanel` starts new work: it selects
a frozen snapshot, an execution mode (`deterministic_mock` or `gateway`), lane
concurrency, and per-candidate models, then posts to
`/api/cases/:id/triage-runs`. `ExperimentLab` compares finished work and never
starts any. Provenance stays explicit throughout — every candidate records its
provider, model, and profile, and imported runs are typed separately from human
contributions, so a model's output is never presented as a person's finding.

What is weak is the *entry*: both live under the Analyze and Compare stages
with no statement of which one a person wants, and a user who has not run
anything yet meets the comparison surface with nothing to compare. The
correspondence and human-notes demo scenarios added in this pass partly address
this by showing that an investigation needs neither. A fuller fix belongs with
§2.2, since both are the same problem — the surface not saying what it is for.

## 4. Not in scope for this review

No work touched, and no claim is made about: private or customer data,
credentials, live LDAP or gateway paths, the desktop/Tauri host, release
publication, or unrelated infrastructure. All demo material is synthetic and
addresses only the RFC 2606 reserved `.test` namespace, which is pinned by a
test.
