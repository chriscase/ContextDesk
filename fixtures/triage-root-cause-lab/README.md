# Hermetic known-root-cause triage lab

Neutral synthetic multi-source corpora for adversarial broad-triage quality.
Answer keys under each `truth/` directory are **evaluator-only** and must never
be injected into model context.

Cases:
1. `decoy-before-trigger` — earlier decoy error vs later true causal trigger
2. `multi-hop-chain` — 3-source causal chain with repeated downstream noise
3. `missing-root-evidence` — symptoms only; root sources deliberately omitted
4. `order-only-time` — offsetless local time blocks confident cross-source order

Mutations that equate earliest error with root cause, label every event an
error, fabricate counts, or claim omitted sources were observed are generated
in hermetic tests (case 5), not as separate corpora.
