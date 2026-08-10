# Fixed-corpus retrieval ablation v1

Status: hermetic production-path evidence; not a live model-quality claim

The default retrieval-ablation test now executes six lanes over the committed
small tier (20 cases, 142 queries) through the production import and
`hybrid_search_events` seams:

```text
cargo test -p cd-core --test retrieval_ablation_lab \
  fixed_corpus_six_lane_ablation_is_executed_and_separated_from_answer_quality \
  -- --nocapture
```

The corpus is imported with the deterministic `ConceptEmbedBackend`; the
reranked lanes use `ScriptedRerankBackend`. These identities are deliberately
marked synthetic and must never be presented as BGE-M3, Qwen, Vercel, or
employer-gateway evidence. The test does not send corpus text or credentials
over the network.

The release worktree also carries a workflow-level seam proof at
`crates/cd-workflow/tests/retrieval_production_path.rs`. It constructs the
configured `bge-m3` embedding and `qwen3-reranker-0.6b` roles through the
protected-file credential path, then runs the real `hybrid_search_events`
workflow against a hermetic gateway. This verifies factory wiring and
credential/header behavior; it is still not evidence that those employer
models are live-compatible or useful.

## What is measured

- mean retrieval recall at the top-25 prefix for answerable queries;
- retention of trigger/propagation causal anchors at top-25;
- maximum contaminating-group share at top-25;
- measured embedding and reranker calls;
- successful execution through the same import, vector-binding, fusion, and
  bounded rerank code used by product retrieval.

Answer usefulness, citation validity, and causal correctness remain separate
scoring stages. Retrieval numbers alone never create a model readiness badge.

## Current hermetic observation

The output below was captured from the test on this release worktree. It is a
plumbing/evaluation fixture, not a quality ranking:

| Lane | Mean recall@25 | Mandatory-anchor recall@25 | Max decoy share | Embed calls | Rerank calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| exact_keyword | 0.7145 | 0.6641 | 1.0000 | 0 | 0 |
| dense_only | 0.7384 | 0.6406 | 1.0000 | 142 | 0 |
| hybrid_rrf | 0.8251 | 0.7578 | 1.0000 | 142 | 0 |
| exact_reranked | 0.7227 | 0.6484 | 1.0000 | 0 | 130 |
| dense_reranked | 0.6230 | 0.5156 | 1.0000 | 142 | 142 |
| hybrid_rrf_reranked | 0.7036 | 0.6328 | 1.0000 | 142 | 142 |

The apparent hybrid advantage and reranker regression are properties of the
deterministic fixture and scripted adapters. They are useful regression
signals: reranking is not assumed to help, mandatory evidence is measured
independently, and a reranker may not evict required anchors silently. They do
not predict how DeepSeek, BGE-M3, Qwen, or Vercel will behave.

## Remaining live work

1. Run the same frozen cases with a real, explicitly identified embedding
   endpoint and record model identity, dimensions, latency, and privacy
   consent.
2. Run the same candidate packets with a real reranker dialect and preserve
   input-relative indices and score semantics.
3. Keep the answer model and packed context fixed while comparing retrieval
   lanes; score final answers separately for evidence grounding and causal
   role integrity.
4. Do not replace the current honest `FUTURE_CAPABILITY_UNAVAILABLE` rows for
   employer BGE-M3/Qwen until those live observations are captured and reviewed.
