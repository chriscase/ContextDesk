# Model and gateway compatibility research dossier

Status: active research record; not a release or compatibility claim

Last updated: 2026-08-09

Owner: ContextDesk model-readiness workstream

This document is the durable landing place for public model research, gateway
contract research, and the verification work derived from them. It exists so
future maintainers and agents do not have to reconstruct model behavior from
chat history.

Related evidence:

- [Deep research and ContextDesk synthesis](../research/deep-research/2026-08-09-ai-integration/README.md)
  preserves the external research provenance, exact machine-readable artifacts,
  and release-oriented conclusions.
- [Vercel refinement lab notes](./VERCEL_REFINEMENT_LAB_NOTES.md) preserve
  sanitized live observations.
- [Gateway contract fixture coverage](./GATEWAY_CONTRACT_FIXTURES_COVERAGE.md)
  maps live observations to hermetic regression tests.
- [Investigation qualification protocol](../benchmarks/INVESTIGATION_QUALIFICATION_PROTOCOL.md)
  defines answer-quality qualification.
- [Quality evaluation harness](../benchmarks/QUALITY_EVAL_HARNESS.md) defines
  comparative evaluation without treating one model as truth authority.

## Claim discipline

Keep every finding in one of these classes:

1. **Documented** — supported by a direct, public primary source such as an
   official model card, API specification, provider document, or source
   repository.
2. **Live observed** — seen against an exact gateway profile, endpoint
   fingerprint, model id, role contract, and probe schema. This is not a global
   property of the model name.
3. **Hermetically reproduced** — the safe contract shape or failure mode has a
   deterministic local fixture or test. This proves ContextDesk handling, not
   current gateway availability.
4. **Inferred** — a reasoned expectation that remains unverified.
5. **Unknown** — requires an explicit live probe or owner/environment input.

Do not promote marketing claims, benchmark rankings, model-family resemblance,
or a successful chat request into a compatibility claim for another role.

## Security and retention rules

This file and derived fixtures may contain public protocol field names,
synthetic request/response examples, public model ids, dimensions, limits, and
sanitized error categories. They must not contain API keys, authorization
headers, private gateway addresses, employer-only documentation, account ids,
request ids, billing metadata, raw production prompts, incident data, complete
stochastic model answers, or embedding vectors captured from live traffic.

Before committing an external research report:

- replace copied prose with a concise synthesis;
- verify important claims against the cited primary source;
- distinguish model behavior from serving-stack behavior;
- move testable wire-shape claims into sanitized fixtures;
- record remaining uncertainty as a probe, not an assumption.

The original external report may remain an uncommitted local attachment, but
the repository copy must be the reviewed, source-linked synthesis.

## Research request in flight

The current research covers these exact catalog ids or labels:

- `Mistral-Small-24B-Instruct-2501-FP8-dynamic`
- `bge-m3`
- `deepseek-v4-flash`
- `gpt-oss-120b`
- `ministral-3-14b-instruct-2512`
- `qwen-3.6-27b`
- `qwen3-reranker-0.6b`

Requested outputs are a source-linked capability matrix, transport-contract
comparison, BGE-M3 and Qwen reranker guidance, minimal compatibility probes,
product recommendations, and a list of facts that still require the employer's
actual gateway. When the report arrives, integrate it into the tables below
rather than pasting it verbatim.

## Public-source baseline

These facts are useful starting points, not proof about a particular gateway
deployment.

| Subject | Documented baseline | Primary source | Verification consequence |
| --- | --- | --- | --- |
| OpenAI-compatible embeddings | The common request is `POST /v1/embeddings` with `model` and one or more `input` values; results contain indexed embedding vectors. | [OpenAI embeddings API](https://platform.openai.com/docs/api-reference/embeddings) | Probe single and batch inputs, stable ordering, finite values, and exact returned dimension. |
| Hugging Face Text Embeddings Inference | TEI exposes native `/embed`, an OpenAI-compatible `/v1/embeddings`, and a separate native `/rerank` endpoint. | [TEI quick tour](https://huggingface.co/docs/text-embeddings-inference/quick_tour) | OpenAI-compatible chat does not establish the reranking path; try only documented/configured adapter shapes. |
| Vercel AI Gateway | Vercel documents unified catalog discovery and embedding support, while ContextDesk has separately observed Vercel's specialty v4 embedding and reranking contracts. | [Vercel models and providers](https://vercel.com/docs/ai-gateway/models-and-providers) | Use catalog role metadata where available, then verify the specialty role through its exact adapter. |
| BGE-M3 | The canonical model produces 1,024-dimensional dense vectors, supports inputs up to 8,192 tokens, and does not require a query instruction for its normal retrieval use. It can also produce sparse and ColBERT-style representations when the serving stack exposes them. | [BAAI BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) | Treat dense, sparse, and multi-vector output as separate capabilities. Never assume a generic embeddings endpoint exposes all three. |
| Qwen3-Reranker-0.6B | The canonical model is a 0.6B, instruction-aware text reranker with a 32K model context. Its documented integrations can expose raw logit differences or sigmoid-normalized scores. | [Qwen3-Reranker-0.6B model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | Verify score ordering and index binding; do not rely on absolute score thresholds until normalization is known. |

## Capability matrix

Populate one row per exact public model identity. Gateway-specific results go
in the verification ledger instead of overwriting this documented baseline.

| Exact model identity | Intended roles | Inputs and limits | Output contract | Instructions/prefixes | Documented caveats | Sources | Research status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BAAI/bge-m3` | embedding: dense; optionally sparse and multi-vector | up to 8,192 tokens; multilingual | dense dimension 1,024 | no query instruction required by canonical model | exposed modes depend on serving stack | [model card](https://huggingface.co/BAAI/bge-m3) | partial |
| `Qwen/Qwen3-Reranker-0.6B` | reranking | query/document pairs; canonical context 32K | ordered scores; scale depends on integration | task instruction supported and recommended | raw logits and normalized probability are both documented integration outcomes | [model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | partial |
| Remaining in-flight models | pending | pending | pending | pending | exact-name identity must be resolved first | pending | awaiting report |

## Gateway transport matrix

| Gateway or server contract | Discovery | Chat | Embedding | Reranking | Evidence status |
| --- | --- | --- | --- | --- | --- |
| OpenAI-compatible | commonly `/v1/models` | commonly `/v1/chat/completions` | commonly `/v1/embeddings` | no OpenAI reranking standard | documented baseline; verify endpoint subset |
| Hugging Face TEI | deployment-specific | not its embedding-server role | `/embed` and `/v1/embeddings` | `/rerank` | documented baseline |
| Vercel AI Gateway | catalog discovery documented | OpenAI-compatible and other adapters documented | documented and live-observed through specialty adapter | live-observed through specialty adapter | see lab notes and fixtures |
| Employer gateway | catalog observed in UI | partial live evidence pending durable capture | unknown until exact probe | unknown until exact probe | not yet verified |

## Exact-deployment verification ledger

Never record a bare `verified=true`. A durable result is scoped to:

| Field | Required meaning |
| --- | --- |
| Provider profile | local stable profile id; no credential |
| Endpoint fingerprint | non-reversible/safe identity used to detect configuration drift |
| Exact catalog model id | exact string sent to the gateway |
| Role contract | chat, triage, embedding, reranking, attachments, or another explicit role |
| Probe schema/version | the exact compatibility suite used |
| Observed capabilities | individual pass, limited, fail, or not-tested results |
| Timestamp and freshness | when evidence was gathered and whether catalog/endpoint drift makes it stale |
| Sanitized reason | bounded diagnostic with no prompt, secret, or private response content |
| Product version | ContextDesk build/commit that parsed and judged the response |

Existing Vercel observations remain in the lab notes until this dossier is
updated from the completed research report. Product state should use the typed
qualification record implemented in code, not parse this Markdown file.

## Minimal probe backlog

The research report should refine, not broaden, this sequence:

1. Discover the catalog once and retain its role metadata without assuming it
   is correct.
2. Confirm the selected endpoint and a minimal valid envelope for the claimed
   role.
3. For embeddings, verify single and batch inputs, returned ordering,
   non-empty finite vectors, homogeneous dimension, normalization behavior, and
   query/document instruction policy.
4. For reranking, use one obvious relevant document and decoys to verify score
   direction, index binding, complete permutation or top-N semantics,
   duplicates, batching/limits, and task-instruction handling.
5. For chat roles, verify basic generation separately from structured output,
   tool calls, continuation, streaming, attachments, and triage quality.
6. Save sanitized capability evidence locally; convert stable wire contracts
   and negative cases into hermetic fixtures.
7. Evaluate retrieval usefulness with fixed corpora and ablations: keyword
   baseline, embedding only, reranking only where meaningful, and combined.

## Research ingestion checklist

- [ ] Attach or paste the completed external report into the active task.
- [ ] Resolve ambiguous catalog labels to canonical public model identities.
- [ ] Check every important statement against a direct primary source.
- [ ] Complete the public capability and transport matrices.
- [ ] Mark unsupported or deployment-specific claims as unknown/inferred.
- [ ] Add only the smallest necessary live probes for remaining unknowns.
- [ ] Add sanitized fixtures for stable request/response and failure contracts.
- [ ] Update the Vercel lab journal with observations, not generalized claims.
- [ ] Update qualification/help documentation if user-visible behavior changes.
- [ ] Record exact commands/results and residual limitations before release use.
