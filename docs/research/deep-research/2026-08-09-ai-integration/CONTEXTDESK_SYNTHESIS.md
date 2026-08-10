# ContextDesk synthesis: models, gateways, retrieval, and release

Status: ContextDesk-owned engineering synthesis

Last updated: 2026-08-09

This document combines the three external research tasks with the current
integration branch, existing architecture records, hermetic tests, and live
Vercel experiments. It deliberately separates conclusions supported by current
ContextDesk evidence from promising external recommendations that still need
implementation or measurement.

## Durable conclusions

### Keep three small operation contracts

The useful portable boundary is `Generate`, `Embed`, and `Rerank`, with explicit
protocol dialects behind each operation. Do not create one universal request
object containing every provider field. Authentication, discovery, request
translation, streaming, and provider extensions remain adapter concerns.

OpenAI-compatible chat is a valuable default dialect, not a statement that
strict JSON, tools, attachments, embeddings, reranking, reasoning fields,
usage, or cancellation behave alike. `/v1/embeddings` is the strongest common
dense-embedding envelope. Reranking has no equivalent universal standard and
needs an explicit dialect and parser.

### Verification is scoped evidence, not a badge on a name

A useful result belongs to an exact provider profile, endpoint fingerprint,
catalog model id, route/dialect, role or workflow, probe schema, and product
version. Compatibility, retrieval quality, answer quality, and orchestration
quality remain separate evidence classes. A temporary outage must not erase a
previous compatibility result, but endpoint, model, adapter, instruction, or
probe-contract drift can make relevant evidence stale.

Catalog and name metadata can prioritize probes and simplify selection. It must
not create a positive capability result.

### Hybrid retrieval is the sensible target, not an unconditional release gate

ContextDesk's mixed evidence favors a strong exact/structured and BM25 baseline
plus an optional dense semantic lane. Rank-based fusion such as Reciprocal Rank
Fusion is a safer initial default than mixing uncalibrated BM25, cosine, and
provider relevance scores.

Reranking is valuable when the first stage has good recall but poor top-rank
precision, semantic near-misses, or repetitive candidates. It is unnecessary
for many exact identifier, path, symbol, configuration-value, or already small
candidate sets. Failure or timeout must preserve the pre-rerank order.

Embedding and reranking must never silently remove mandatory exact evidence,
chronology anchors, contradictions, rollback/recovery records, or distinct
events that merely look semantically repetitive.

### Retrieval cannot repair a broken evidence handoff

Evidence lost during parsing, filtering, candidate cutoffs, deduplication,
packing, authorization, or stage-local handoff cannot be recovered by a better
answer model. This is directly supported by ContextDesk's live work: stronger
models solved the fixed decisive packet while the older staged product path
withheld or omitted evidence. The global-timeline and typed causal-agreement
changes repaired that host boundary; embeddings alone could not have done so.

### Store the embedding pipeline identity with the corpus

Stored vectors must be bound to, at minimum, exact model identity, endpoint or
deployment fingerprint, dimension, representation type, normalization and
similarity policy, query/document instruction profile, preprocessing/chunking
version, and ideally tokenizer/revision information when available. Mismatched
or heterogeneous vector dimensions fail closed. Identity-defining changes
require a segregated index or rebuild.

For canonical BGE-M3, the documented dense representation is 1,024 dimensions
with optional sparse and multi-vector modes. A generic OpenAI embeddings route
should initially be treated as dense-only unless a typed adapter proves other
representations. Canonical BGE-M3 does not need the old BGE query prefix by
default, but the deployed endpoint's normalization and instruction behavior
still require measurement.

### Preserve reranker semantics instead of manufacturing confidence

Reranker evidence must retain route/dialect, input-relative index, rank, raw
score, score field, higher-is-better behavior, score semantic, instruction
hash, truncation, and top-N behavior. Qwen3-Reranker integrations can expose
raw logit differences or normalized probabilities; a numeric value such as
`0.5` has no portable meaning. Ranking may be usable while thresholding and
cross-model score fusion remain unsafe.

## What ContextDesk already gets right

- Capability evidence is keyed by profile, endpoint fingerprint, exact model,
  and probe schema; name hints do not create measured passes.
- CLI and GUI share discovery and synthetic qualification evidence.
- Large-catalog CLI selection is subset-first, sequential, confirmed,
  cancellable, paced, and preserves completed partial results.
- Chat qualification separately checks generation, native tool calls,
  continuation, structured output, streaming, and cancellation.
- Vercel specialty qualification uses the live-observed v4 embedding and
  reranking contracts rather than pretending they are chat responses.
- Sanitized fixtures cover malformed embeddings, dimensions, non-finite values,
  duplicate/missing rerank indices, role mismatch, and backend errors.
- The log retrieval engine preserves a structured/keyword fallback and records
  degradation rather than manufacturing semantic success.
- Corpus vectors are already checked for model and dimension compatibility.
- The quality harness separates compatibility, retrieval, answer, and
  orchestration evidence and scores semantic facts instead of exact model prose.
- Live DeepSeek V4 Flash triage now establishes the correct initiating cause,
  symptom, independent error, rollback, and recovery after the host-side
  causal-agreement fix.

## Product gaps revealed by the research and source audit

### Release-critical basics

1. **Finish and commit optional protected-file credentials.** The CLI/core work
   exists locally, but the desktop setup path and final integration proof remain
   incomplete. An explicit file or environment source must never fall through
   to Keychain.
2. **Run the full release gate from one clean integration commit.** The recent
   workspace run cleared core and many integration suites, but its terminal
   exit was not retained. Run the documented Rust, Tauri, and desktop checks
   after the credential work is coherent.
3. **Complete packaged GUI and CLI acceptance.** Prove discovery, targeted
   verification, selection, ordinary chat, attachment-assisted chat, triage,
   cancellation, diagnostics, and restart persistence with the same build.
4. **Repeat the no-Keychain live path.** Use the protected file explicitly and
   count credential-source reads; do not diagnose macOS dialog count as stage
   reloads.
5. **Keep release claims narrow.** DeepSeek triage has live acceptance evidence.
   Ordinary chat, attachments, employer-specific retrieval, and packaged-app
   behavior need their own evidence.

### Retrieval integration immediately after the basics

1. **Share specialty protocol adapters between qualification and production.**
   Qualification already knows OpenAI-compatible and Vercel v4 embeddings, but
   `cd-workflow` production retrieval currently constructs the older Ollama
   embedding backend. Product and probe paths must not disagree about what a
   configured role means.
2. **Wire retrieval roles through desktop and CLI configuration.** The workflow
   module explicitly says desktop retrieval activation is not wired. Keep the
   feature off by default until the product path and status surface agree.
3. **Enrich embedding qualification.** Use the research suite's cheap
   three-input batch probe to record dimension, indices/order, finite values,
   norm statistics, duplicate stability, and truncation/instruction policy.
4. **Enrich reranking qualification.** Preserve scores and their semantics,
   reverse the synthetic documents to verify request-relative indices, and
   register explicit dialects rather than guessing a parser from a path.
5. **Run a real product-path ablation.** Compare keyword, embedding, hybrid,
   keyword+rerank, embedding+rerank, and hybrid+rerank on fixed corpora. Measure
   retrieval facts and final-answer usefulness separately.
6. **Exercise exact employer roles later.** Vercel Voyage proves ContextDesk's
   v4 envelopes, not the employer gateway's BGE-M3 or Qwen3 reranker dialect.

### Valuable but deferred

- Gateway-scoped model references and per-mode defaults across multiple
  gateways.
- Explicit same-gateway fallback policies and optional cross-gateway review
  with visible privacy/cost consent.
- Responses/OpenResponses adapters where demand justifies them.
- Sparse and multi-vector BGE-M3 indexes, ColBERT, HyDE, learned sparse
  retrieval, generative reranking, and automatic ensembles.
- Automatic model selection or routing from quality scores.

These should remain designed-for but not allowed to delay a usable release.

## Recommended release decision

Do not make full remote embedding/reranking productization a prerequisite for
the next release candidate. Ship the reliable structured/keyword fallback and
model-readiness work first, with optional retrieval described only to the level
actually wired and proven. Immediately follow with the shared specialty-adapter
slice and live retrieval ablation.

The shortest honest path is:

1. Complete protected-file credentials in both hosts.
2. Commit the currently separated credential work.
3. Run all documented local gates from a clean integration head.
4. Build one acceptance artifact and run GUI/CLI smoke tests.
5. Re-run live Vercel discovery, DeepSeek compatibility, ordinary chat,
   attachment chat, and the accepted triage corpus without Keychain.
6. Promote only after claims, diagnostics, and residuals match the evidence.

## Research proposals to adopt selectively

The preserved external probe JSON and Rust sketch are useful design inputs, but
they should not be copied wholesale. The highest-value near-term deltas are:

- protocol dialect on each observed route;
- separate JSON capability levels rather than one structured-output Boolean;
- richer embedding and reranking measurements;
- temporary-unavailable state distinct from stale/incompatible;
- workflow-specific verification rather than a universal verified label; and
- explicit truncation, ordering, and score semantics.

Existing ContextDesk identity, isolation, fail-closed parsing, and evidence
stores should be extended incrementally instead of replaced.
