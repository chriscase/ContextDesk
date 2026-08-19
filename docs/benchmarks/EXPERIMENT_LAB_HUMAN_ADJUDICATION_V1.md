# Experiment Lab human adjudication v1

Status: hermetic collab review loop. Not a live-provider or gold-answer claim.

This is the human review surface for a **share-safe experiment package** already
produced by a comparison. Evaluation scoring stays in the headless bench.
Collab records attributed helpfulness and a proposed-then-accepted decision.

## Demo path

1. **Live comparison** (outside collab) produces a share-safe package or
   summary. The checked-in fixture is the synthetic three-model checkout
   comparison (`qwen-3.6-27b`, `gpt-oss-120b`, `ministral-14b`) at
   `collab/contracts/fixtures/experiment-package.valid.json`. It reuses the
   public comparison identities, not live Vercel output.
2. **Import** the JSON into a collab case (`POST /api/cases/:id/experiments`).
   Repeating the same `packageId` is idempotent.
3. **Similarities / differences** show shared evidence anchors, candidate-specific
   evidence, and role conflicts. The UI always shows: *Agreement is not proof of
   correctness.*
4. **Helpfulness review** records a rubric dimension, 0–3 score, rationale,
   evidence refs, and the authenticated reviewer. Candidate gold/cost/usage stay
   `unknown` unless already `absent`.
5. **Decision**: a contributor proposes text + rationale + evidence refs; a
   case-lead/admin accepts with `expectedRevision`. A stale revision returns 409.
   Accepted decisions are append-only.
6. **Export** the share-safe review projection. It contains the matrix,
   agreement, observations, and accepted decision. It does not contain raw model
   captures, prompts, credentials, endpoints, or provider request IDs.

## Honesty

- Unknown stays unknown.
- Do not invent a gold answer, correctness score, cost, or confidence.
- Native `json_object` / forced-tool limitations belong on qualification records,
  not this review loop.
