# Retrieval implementation notes

Status: recovered bounded research detail plus the first production adapter
slice; no live employer quality claim

Current implementation slice (release line):

- `openai_embeddings` is a shared, batched `/v1/embeddings` adapter used by
  qualification and production retrieval. It requires indexed, finite,
  homogeneous vectors and a protected bearer reference when configured.
- `tei_rerank_v1` is a shared `/rerank` adapter used by qualification and
  production retrieval. It preserves request-relative indices and rejects
  malformed or ambiguous results; failed reranking retains the pre-rerank
  order.
- Legacy roles without a dialect retain the local Ollama embedding default
  on the conventional Ollama port and the TEI-style rerank default. Vercel's
  native v4 retrieval envelopes remain explicitly unverified for production.

Source conversation: `6a791c7e-4bb8-83ea-b176-35e66f103cd9`

The thread reader retained only the first 20,000 characters of the oversized
research answer. Those characters contained the executive conclusions and a
detailed evidence-pipeline table. This file preserves the implementation
invariants and unanswered ContextDesk experiments that were not explicit in
the main synthesis.

## Do not produce one homogeneous relevance ranking

Exact/structured retrieval, BM25, dense retrieval, fusion, reranking,
deduplication, and context packing serve different purposes. Fusion and
reranking may reorder the semantic lane, but must not silently remove:

- exact identifiers, paths, symbols, versions, hashes, and configuration values;
- chronology anchors and the first/last occurrence of repeated events;
- contradictions and independent errors;
- initiating changes, rollback, and recovery evidence; or
- evidence mandated by the selected workflow or evaluation case.

Authorization is a hard boundary. Retrieval must not semantically work around
evidence that the user is not allowed to access; the correct result is
uncertainty or refusal.

## Evidence-pipeline invariants

| Boundary | Information to preserve | Failure/degradation behavior |
| --- | --- | --- |
| Ingestion and parsing | Raw source hash/bytes, source identity, permissions, encoding, parser id/version, parse coverage and warnings | Preserve the original source; fall back to bounded line-oriented text for unsupported structure rather than silently dropping it. |
| Chunk/event formation | Stable evidence id, parent id, byte/line range, overlap, token count, chronology and truncation | Never orphan a chunk from its parent or split away stack-trace/table/symbol context without a locator. |
| Metadata and lexical indexing | Field provenance, tokenizer/index schema, exact punctuation/case, paths, hashes, timestamps, trace/span ids | Deterministic fields may filter. Model-derived labels should normally boost or annotate, not hard-exclude. Keep literal scan as a small-corpus fallback. |
| Embedding generation | Exact pipeline identity, dimension, representation, tokenizer/revision, instruction, pooling, normalization, token count and truncation | Reject mixed/non-finite/incompatible vectors and preserve keyword retrieval. Rebuild or segregate when identity changes. |
| Query interpretation | Original query, extracted literals/filters/time range, every rewrite and its provenance | Run generated rewrites as additive lanes; never replace the literal query. |
| Candidate generation and fusion | Per-retriever rank, score type, filters, candidate count, latency, ANN parameters, duplicate resolution and fusion formula | Keep branch results visible. Fall back to exact/BM25. Prefer RRF until score calibration is measured. |
| Reranking | Input-relative indices, evidence text hashes, instruction, truncation, raw/normalized score semantics, output permutation and latency | Reject malformed output and retain the fused order. Protect mandatory evidence from the cutoff. |
| Diversity control | Deterministic duplicate group, removal reason, source/role quota, first/last occurrence and contradiction flags | Do not collapse semantically similar but causally distinct events. Use MMR only after deterministic duplicate grouping. |
| Context packing | Per-item tokens, order, omitted ids/reasons, parent expansions, chronology/causal groups and final context hash | Prefer fewer complete evidence units to many truncated fragments. Keep mandatory anchors pinned and report omissions. |
| Answer and citation validation | Model/prompt identity, evidence ids, claim-to-evidence mapping, invalid ids, unsupported claims, token/deadline data | On generation failure, show extractive evidence. Remove or qualify unsupported claims rather than keeping a plausible answer. |
| Evaluation | Query-level retrieval and answer observations, failure class, index/model versions, latency/cost and confidence intervals | Do not hide exact-lookup, chronology, causal, or citation failures inside one aggregate score. |

For logs, retain both event time and observed/ingestion time plus trace, span,
severity, resource, body, and typed attributes where present. Flattening these
to text destroys retrieval filters and causal ordering.

## Fixed product-path ablation

Run the same frozen, sanitized corpus through these lanes:

1. exact/structured plus BM25 baseline;
2. dense only;
3. hybrid exact/BM25 plus dense using RRF;
4. baseline plus rerank;
5. dense plus rerank; and
6. hybrid plus rerank.

Hold the candidate budget, final packed-token budget, answer prompt, and answer
model fixed within each comparison. Repeat with both a lower-cost and stronger
answer model to measure whether retrieval helps evidence location while leaving
reasoning or instruction-following gaps intact.

Stratify cases instead of relying on one average:

- exact identifier/error/path/symbol/configuration lookup;
- paraphrase and vocabulary mismatch;
- multilingual retrieval;
- natural-language-to-code or documentation;
- incident chronology and initiating-cause analysis;
- contradiction, rollback, and recovery retention;
- repetitive events that are semantically similar but temporally distinct; and
- attachment-derived evidence with a stable source locator.

Measure retrieval and answer quality separately:

- mandatory-evidence retention before and after reranking/packing;
- recall at candidate and packed-context cutoffs;
- reciprocal rank or nDCG where graded ranking labels exist;
- exact-anchor, chronology, contradiction, cause, rollback, and recovery facts;
- claim-to-citation support and invalid/missing citation ids;
- latency, token usage/cost, timeout/cancellation, and fallback frequency; and
- degradation versus the closed-book or lexical baseline when extra evidence
  adds noise.

## Decisions the ablation must settle

- Enable dense retrieval by default only if it improves semantic/paraphrase
  classes without materially reducing exact-anchor and chronology retention.
- Keep RRF as the initial fusion rule unless measured calibration makes another
  method consistently better. BM25, cosine, and provider relevance scores do
  not share a portable numeric scale.
- Add reranking only when it improves final answer usefulness, not merely an IR
  metric. Skip it for deterministic exact lookups, already-small filtered sets,
  or query classes where its latency exceeds its value.
- Tune candidate depth against answer quality. More recall can make an answer
  worse when it adds plausible distractors or forces decisive evidence to be
  truncated.
- Test evidence order explicitly. Reversing or regrouping chronology can expose
  reader sensitivity even when the evidence set is unchanged.
- Keep advanced techniques deferred until they win a controlled ablation:
  learned sparse retrieval, ColBERT/multi-vector indexes, HyDE, broad
  multi-query generation, generative/listwise reranking, generated knowledge
  graphs, RAPTOR-style trees, and model-generated semantic chunking.

## Known non-solutions

Embeddings or reranking cannot recover evidence lost during decoding, parsing,
hard filtering, permissions, indexing, candidate cutoffs, deduplication,
packing, or stage-local handoff. They also cannot guarantee causal reasoning,
calibrated uncertainty, instruction following, or citation use by the answer
model. When a stronger answer model succeeds on the same decisive packet and
the product path fails, investigate the host handoff and orchestration before
changing retrieval.

## Citation recovery status

The bounded preview named DPR, BEIR, Pyserini hybrid reproductions, RAGGED,
Tree-sitter, OpenTelemetry's log data model, code-retrieval benchmarks, and a
2025 synthetic long-context study. Its internal citation handles did not retain
the source URLs. No URLs were guessed during this recovery. The source
conversation remains authoritative for the complete bibliography.
