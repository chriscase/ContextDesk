# Accepted decision to versioned gold backtest v1

Status: hermetic collab promotion + bench consumption. Not a live-provider
or infallible-truth claim.

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
