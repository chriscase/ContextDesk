# War Room operator journey v1

Status: **browser qualification of the shipped collab war-room path**. Child of
`main` @ `aca5aeb0183be238ab7b42a5d46c2ea10ee0455f`. Not a live-provider,
LDAP, Postgres-restart, or gold-answer claim.

Code under test: Playwright spec `collab/e2e/specs/11-operator-journey.spec.ts`
driving the existing `@cd-collab/e2e` fixture (`serve-fixture.ts`,
`MapAuthAdapter`, in-memory stores, `DeterministicMockTriageExecutor`) and
shipped UI/API. No dedicated runner was added; synthetic lanes already exist.

## What this lab qualifies

One operator session, through shipped controls:

1. A human records a timeline note and uploads evidence from two files (a
   share-safe worker log and an owner-only worker log).
2. External AI output is pasted through the import form with catalog source
   `Fixture chat assistant` (`external-tool`). It stays an **unverified
   imported run**, labeled `imported output` / `imported · unverified`, and is
   never labeled `human-authored` or corroborated into a verified finding.
3. Only the share-safe log is frozen. The snapshot fingerprint, `same_snapshot`
   fairness class, and empty parent (root lineage) come from the freeze POST.
4. The default synthetic comparison launches three offline lanes
   (`qwen-3.6-27b`, `gpt-oss-120b`, `ministral-3-14b-instruct-2512`) bound to
   that fingerprint. Usage and cost stay **unknown**.
5. Experiment Lab states agreement, differences, unknowns, snapshot identity,
   and the caveat that agreement is not proof of correctness.
6. A human proposes and a case lead accepts a decision. The accepted text is
   a judgment about what to inspect, not a model-correctness verdict.
7. `Export share-safe review` preserves accepted decision revision 1, alias
   `snapshot-1`, host-owned `snapshotProof` (`host_frozen_snapshot` /
   `same_snapshot` / `root`), `privacyClass: share_safe`, and omission flags.
   The serialized export withholds the raw fingerprint, fixture password, and
   free-text decision/note. The case brief inventory still names both privacy
   classes and does not leak owner-only file bytes.
8. Reload plus reopen keeps the human note, unverified import, snapshot
   fingerprint, same-snapshot lanes, and accepted decision.

## What this lab does not do

- It does not call a live model provider or invent provider JSON.
- It does not add `operator-journey-runner.mjs`; the shipped synthetic
  executor is the offline path.
- It does not claim LDAP login, Postgres process-restart, or live-gateway
  quality. Those remain the existing opt-in residuals (`09-live-profile`,
  `07-persistence` restart skip, `10-bridge-comparison` with
  `COLLAB_E2E_BRIDGE=1`).
- It does not close a product issue or treat lane agreement as correctness.

## Limitations / residuals

- Fixture auth is `MapAuthAdapter` with checked-in `fixture-*-secret` values
  already used by collab HTTP tests. Production remains LDAP.
- `/ready` stays 503 on the fixture (`database: down`). Wait on `/health`.
- Owner-only evidence is registered and shown, but excluded from the frozen
  snapshot so share-safe comparison stays well-typed.
- The imported chat is left unbound and is not selected into the Experiment
  Lab handoff; an unbound paste would honestly collapse snapshot proof to
  `unknown`. Binding a paste to a snapshot remains a later operator action.

Handbook impact: none — browser stitching of already-shipped war-room seams;
no architecture, trust-boundary, or evidence-flow change.
