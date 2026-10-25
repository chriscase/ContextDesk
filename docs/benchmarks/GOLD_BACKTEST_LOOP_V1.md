# Accepted decision to versioned gold backtest v1

Status: hermetic collab promotion + bench consumption on `main`; Goal 09's
browser-saved owner-only handoff is local integration until its draft PR merges.
Neither is a live-provider or infallible-truth claim.

A gold reference is a **human benchmark decision**, not a proof that a model
was correct. Gold alignment is scored separately from helpfulness. Agreement
among candidates is never treated as correctness.

## Loop

1. **Comparison** produces a share-safe experiment package (the checked-in
   three-model checkout fixture:
   `collab/contracts/fixtures/experiment-package.valid.json`).
2. **Human review** in Experiment Lab records helpfulness observations and a
   proposed decision.
3. **Accepted decision** is append-only. A case-lead accepts with
   `expectedRevision`. Proposed decisions cannot be promoted.
4. **Gold promotion** (`POST /api/cases/:id/experiments/:eid/gold`) copies the
   accepted decision, selected evidence-anchor ids, optional expected
   role/evidence relationships, and optional helpfulness dimensions into an
   immutable `cd-collab.gold_reference.v1` artifact. Repeating the same
   decision and anchors is idempotent. A different payload requires
   `expectedGoldVersion` matching the latest version or returns 409. Prior
   versions are never mutated.
5. **Later backtest**: `cd-triage-bench import-gold` stores the artifact;
   `report` aligns later runs against the latest matching gold for the same
   task and snapshot fingerprints. Reports distinguish:
   - gold alignment (`aligned` / `partial` / `divergent` / `unscored`)
   - helpfulness / score visibility
   - human acceptance of the gold decision
   - unknown states when no gold exists (historical v2 JSON omits gold keys)

## Deliberate owner-only handoff (Goal 09 local integration)

In War Room Decide, a case lead opens **Version the human benchmark** after a
decision is accepted. The accepted decision's currently eligible evidence is
preselected for inspection. The operator can clear or change the selection,
optionally assign roles and helpfulness dimensions, then deliberately promote.
The UI checks current eligible references before sending the frozen request.
After a lost or uncertain result, it retains that request and requires a fresh
history read; an exact recorded match is recovered without another write.
An empty history read does not prove rollback. A deliberate retry uses the same
semantic selection and the server's existing idempotence/version guard.

An authorized **Download owner-only benchmark** operation fetches one exact
stored gold ID/version from the named case and experiment. It emits
`cd-collab.gold_reference_export.v1` with `privacyClass: owner_only` and the
unchanged gold object. It includes original case, task, snapshot, evidence and
attribution identities. The browser checks the full envelope and selected
version before saving. The existing alias-only share-safe Experiment Lab review
export is separate; aliases cannot be reversed into these original identities.
This file is for a trusted owner's offline handoff, not public sharing or a
portable investigation archive. The export action is audited and cannot change
the stored benchmark. A download click alone is not proof that a file was saved.

The existing offline `cd-triage-bench --library DIR import-gold FILE` accepts
either this strict envelope or a legacy bare gold file; bare input has unknown
privacy provenance, not implied share-safe status. `report --format json
--privacy owner-only --task TASK_ID` applies the latest gold only when task and
snapshot identities match. Alignment describes cited evidence and optional
roles; it does not establish diagnosis, provider quality, or human-review impact.

## Fixture

- Accepted gold: `collab/contracts/fixtures/gold-reference.valid.json`
  (copied for the bench at `crates/cd-triage-bench/fixtures/gold/three-model-checkout.v1.json`).
  Selected evidence: `ev-demo-checkout-log`, `ev-demo-inventory-timeout`.
- No-gold scenario: the existing experiment summary and a bench report with no
  imported gold. Both stay valid without inventing alignment.

The fixture reuses public comparison identities. It contains no live Vercel
output, raw captures, prompts, credentials, endpoints, or provider request IDs.

## Honesty

- Unknown stays unknown.
- Gold alignment is not a correctness verdict.
- Helpfulness scores are independent of gold alignment.
- Native `json_object` / forced-tool limitations belong on qualification
  records, not this loop.
