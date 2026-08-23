# Interaction trace and strategy comparison v1

Status: hermetic collab + bench projection. Not a live-provider rehearsal and
not a model-winner claim.

Approaches that asked **different questions** or followed different
investigation paths can be compared as source-neutral candidates. A gold
reference remains a human benchmark decision. Helpfulness remains a human
review signal. Agreement and gold alignment are evidence-anchor observations,
never correctness.

## Loop

1. **Import** a share-safe experiment package, a `cd-collab.strategy_package.v1`
   that wraps the package plus interaction traces, or a hermetic
   `cd-collab.bench_run_artifact.v1` / labeled `bench-compare` share-safe
   payload (converted into a strategy package; no invented gold/cost/usage).
2. **Attach traces** to existing candidates:
   - structured `cd-collab.interaction_trace.v1` (programmatic);
   - `cd-collab.plain_transcript.v1` with best-effort turn extraction.
3. If a plain transcript cannot prove turns, tools, or evidence, it still
   imports. Missing fields stay `unknown`. A reviewer can add a human
   annotation instead of guessing.
4. **Strategy comparison** projects:
   - different question paths;
   - shared vs unique evidence;
   - earlier/later discovery order;
   - role conflicts;
   - convergence on an accepted gold reference;
   - divergence in hypotheses or evidence;
   - optional efficiency (turn count, evidence-acquisition steps, latency,
     cost, provider calls) with unknown preserved.
5. Experiment Lab shows the comparison beside helpfulness, gold, and the
   accepted decision. Share-safe export keeps hashes, bounded excerpts, and
   metadata only.

## Fixtures

- Converge: `collab/contracts/fixtures/strategy-package.converge.json`
  (programmatic agent vs chat operator; different questions; same checkout
  and inventory evidence).
- Diverge: `collab/contracts/fixtures/strategy-package.diverge.json`.
- Bench-run multi-strategy: `bench-run-artifact.multi-strategy.json`
  (share-safe lanes labeled `qwen-3.6-27b`, `gpt-oss-120b`,
  `ministral-3-14b-instruct-2512`; DeepSeek rejected by
  `bench-run-artifact.deepseek-rejected.json`).
- Programmatic trace: `interaction-trace.programmatic.json`.
- Incomplete plain chat: `plain-transcript.incomplete.json`.
- Gold-backed vs no-gold: reuse `gold-reference.valid.json` and reports/views
  with no gold.

No live Vercel output, raw captures, prompts, credentials, endpoints, or
provider request IDs.

## Honesty

- Ambiguous transcript structure stays unknown.
- Textual similarity is not a winner.
- Gold alignment is not a correctness verdict.
- This slice is **not** ready for a live Vercel/employer-gateway rehearsal.
  It is a hermetic comparison surface over imported traces.
