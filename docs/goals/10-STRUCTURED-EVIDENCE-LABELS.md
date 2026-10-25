/goal Implement ContextDesk Goal 10 — Structured Evidence Labels and Shared
Review Workspace — on a fresh integration branch from current main.

Do not rebuild the already-shipped bulk annotation stack.

Repository:
chriscase/ContextDesk

Expected starting main:
c672948b8b74471b197ecf848a26fecadd0eece9

Expected tree:
806a1613e4a9b048ba9808b49155f0d3449b3f3d

Suggested branch:
integrate/evidence-label-workspace-v1

Before implementation, reverify main and active work. Preserve dirty/unpushed
work and stop on unexpected incompatible advancement.

## Baseline reliability checkpoint

Goal 09 is integrated through #1188.

Post-merge:
- collab 36768372793 succeeded
- collab-qualify 36768372799 succeeded
- root CI 36768372784 failed only Windows Rust shard 4,
  job 110068410035

The failure is in pre-existing:
comparison::tests::live_comparison_deadline_returns_durable_partial_results

at its temporary log_corpora cleanup assertion.

This goal does not authorize modifying that Rust test. Recheck the separate
reliability disposition once. If the targeted rerun is green, record it.
If the same test remains red, report it as an independent baseline blocker.
Do not hide it or make a product change for it.

Historical #1176 is also a separate known Catalog focus-test synchronization
candidate. Do not silently bundle it into this product branch.

## User outcome

An investigator can select several evidence artifacts, inspect their current
structured labels, deliberately add or remove one exact label across the
selection, see the resulting current state and append-only history, reload
the case, and get the same result.

The operation must not change evidence identity, bytes, privacy, provenance,
case membership or storage ownership.

## Existing foundation to preserve

Already shipped:

- ArtifactAnnotationV1 and annotation list
- bounded ArtifactAnnotationBulkRequest/Result, max 64
- transactional/idempotent server bulk annotation
- public Runtime annotation resources/commands
- EvidenceAnnotationWorkspace
- Investigation First cross-artifact selection
- privacy-aware append-only notes
- commit-outcome-unknown recovery
- S3/local evidence-provider separation

Do not create a second annotation system or reimplement those capabilities.

Historical merged sources #1123, #1124 and #1125 are shipped history, not
branches to rebase or merge.

## Canonical label contract

Create one strict shared contract for structured evidence labels.

Labels are:
- trimmed;
- nonempty and bounded;
- exact and case-sensitive;
- ordinary user-visible text subject to the repository's existing safe-text
  constraints.

Do NOT add:
- case folding;
- aliases;
- fuzzy equality;
- hierarchical taxonomy;
- administrator deduplication;
- popularity/ranking;
- AI-generated labels.

Exact duplicate labels on one artifact collapse semantically; differently
cased labels remain distinct.

Persist append-only label events rather than rewriting artifact identity.

Each durable event must bind:
- case;
- artifact;
- exact label;
- explicit operation: add or remove;
- privacy class where applicable;
- actor;
- time;
- source/provenance;
- stable event identity.

The current label set is a deterministic server projection of event history.

A remove event does not erase the historical add.

## Bulk mutation

Expose one bounded case-scoped bulk command through the existing server and
public Runtime seams.

A request freezes:
- selected artifact IDs;
- exact label;
- operation = add or remove;
- privacy;
- idempotency identity.

No toggle operation.

Use the existing authorization model. Do not add a broader capability simply
because labels are structured metadata unless the current authority model
provably cannot represent the operation; if that becomes necessary, stop and
justify it rather than inventing permission drift.

Preserve:
- 1..64 target bound;
- atomic/idempotent write intent;
- privacy filtering;
- audit/timeline honesty;
- case/artifact binding;
- no artifact-byte mutation.

Return per-artifact outcomes with strict binding. Distinguish at least:
applied, replayed/already-in-desired-state, and not-found/refused semantics
without leaking inaccessible artifact existence.

Use checked/bounded storage and strict parsers.

## Uncertain outcome recovery

Carry forward the lessons from Goals 05/07/09.

The client must freeze the semantic operation while it is pending/unresolved.

After commit_outcome_unknown or an equivalent uncertain result:
- an earlier/overlapping history read cannot authorize replay;
- a successful same-scope read initiated after that result is required;
- if history proves the requested state already exists, recover without a
  second mutation;
- otherwise an explicit retry reuses the same semantic intent/idempotency
  identity;
- each new uncertain result revokes prior retry permission.

Retained handlers, identity/authority replacement and A→B→A must not revive
an old bulk action.

## Shared review workspace

Extend EvidenceAnnotationWorkspace; do not fork another component.

Show:
- selected evidence;
- current exact labels;
- durable notes;
- explicit add-label/remove-label controls;
- current-state versus history language;
- truthful loading/stale/unavailable states.

Investigation First remains supported.

Adopt the shared workspace in Keystone using the public Runtime seam and its
existing evidence surface.

Inspect War Room and Beacon. Where an existing compatible Runtime evidence
selection already exists, reuse the same workspace. Do not invent a parallel
evidence inventory or a new server read merely for visual symmetry.

Normal selection changes must not silently rewrite an in-flight frozen intent.

## Privacy and export boundaries

Labels may themselves disclose investigation meaning.

Never surface owner-only labels to a caller who cannot read them.

Do not leak hidden labels through:
- counts;
- empty/nonempty wording;
- search hints;
- bulk outcomes;
- activity;
- share-safe export.

Goal 10 does not version the portable archive schema.

If an exact portable export/dry-run/apply would silently omit durable label
history, refuse that exact operation with explicit truthful messaging rather
than dropping metadata.

Do not break:
- Goal 06 export handoff;
- Goal 07 assessment behavior;
- Goal 09 owner-only benchmark handoff;
unless those operations explicitly claim to carry this new label history.

## Search boundary

Do not add investigation tag/facet search in this goal.

The output of this goal is the canonical exact label contract that a later
search/facet goal may consume.

No duplicate search truth model.

## Qualification

Use focused tests during implementation, then one final applicable full pass.

Required proof includes:

1. strict contract parsing and mutations;
2. real SQLite and PostgreSQL persistence/transaction behavior if new durable
   server state is introduced;
3. concurrent same-intent idempotence and competing add/remove ordering;
4. privacy capability revocation;
5. scope replacement before passive cleanup with retained callbacks;
6. repeated uncertain-result causal-read gating;
7. no artifact identity/content change;
8. exact labels survive restart/reload;
9. bulk add and remove across mixed selected artifacts;
10. current projection agrees with append-only event history;
11. portable exact operation refuses rather than loses label history;
12. Investigation First + Keystone mounted qualification;
13. actual server-backed Chromium journey using the next unused spec prefix;
14. narrow/keyboard/forced-colors/reduced-motion checks;
15. meaningful temporary mutations proving key assertions are load-bearing.

Run timing-sensitive regressions five independent times and the new browser
journey three times, without retries.

Run one separate bounded adversarial source review.

Do not repeat untouched Rust/desktop campaigns merely for counts.

Keep prior failures visible and distinguish filtered tests from environment
skips.

## Documentation and backlog

Update Help/Proven Methods and reconcile the continuous-delivery backlog:

- Goals 08 and 09 are shipped.
- Goal 10 is the current unmerged slice.
- bulk notes are already shipped; do not describe them as new.
- investigation label facets remain a successor that now has a canonical
  contract to build on.
- portable label round-trip remains separate unless explicitly added later.

## Publication

Publish one draft PR from the owned integration branch.

Normal commits and normal fast-forward publication of source/tests/sanitized
evidence are authorized, subject to actual transfer controls.

Do not:
- merge;
- mark ready;
- close unrelated PRs/issues;
- rewrite history;
- release/deploy;
- use production/private data;
- start the next goal.

Return READY_FOR_REVIEW or READY_FOR_REVIEW_CI_PENDING with:
- base/merge base;
- tested/published head and tree;
- exact changed-file manifest;
- label contract and event model;
- capability/privacy disposition;
- backend transaction evidence;
- uncertain-recovery proof;
- presentation coverage;
- browser journey;
- test/mutation/review evidence;
- hosted checkout identities;
- residual/nonclaims.

Then stop for independent review.