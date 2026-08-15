# Employer catalog implementation notes

Status: recovered research detail; not a gateway compatibility claim

Production adapter status on the current release line:

- Employer BGE-M3 can use the explicit `openai_embeddings` retrieval dialect
  once the exact gateway route is verified. The adapter binds model identity,
  endpoint fingerprint, vector dimensions, and response ordering; this does
  not yet establish that the employer route serves BGE-M3.
- Employer Qwen3-Reranker can use the explicit `tei_rerank_v1` dialect only
  when the gateway's envelope matches that contract. Score calibration and
  model-specific route behavior remain deployment evidence, not name hints.
- Vercel v4 embedding/reranking now has explicit score-preserving production
  adapters (`vercel_v4_embeddings` and `vercel_v4_rerank_v1`). They are
  selected only by explicit role dialect and the exact Vercel gateway host;
  this adds wire support, not a live quality or employer-model equivalence
  claim.

Source conversation: owner-local (id withheld from the public repository)

This file retains the implementation-specific material that did not fit in the
main synthesis. It comes from the clean prefix of the transferred research
report and the two checksum-verified machine-readable artifacts. The report's
long Markdown transfer did not match its published SHA-256 and becomes visibly
corrupted in its later sections. Only the coherent prefix was used here; the
damaged text was discarded.

The labels below mean:

- **Documented baseline**: reported by the external research against the linked
  upstream source.
- **Deployment unknown**: must be measured on the employer's exact gateway.
- **Product policy**: a ContextDesk implementation choice, not a model property.

## Exact catalog decision matrix

| Employer catalog id | Upstream identity and role | Documented baseline | Deployment risks that matter to ContextDesk | Minimum remaining experiment |
| --- | --- | --- | --- | --- |
| `Mistral-Small-24B-Instruct-2501-FP8-dynamic` | Exact high-confidence match to the Red Hat AI dynamic-FP8 derivative of Mistral Small 24B Instruct; generation only | 32K context; JSON output and function calling are model-level capabilities | Strict schema enforcement, SSE shape, cancellation, practical context/output limits, and correct Mistral tool parser are server properties | Forced tool call plus tool-result continuation; JSON-object and strict-schema probes kept separate; interrupted-stream and maximum-practical-context probes |
| `bge-m3` | High-confidence BAAI BGE-M3 family match; retrieval encoder | 8,192-token input; 1,024-dimensional dense CLS representation; optional learned sparse and ColBERT-style token representations; no legacy BGE query prefix by default | A generic OpenAI embeddings route naturally carries dense vectors only; normalization, pooling, truncation, aliases, and instruction injection are unknown | Three-input batch with a duplicate; validate indices/order, finite values, homogeneous 1,024 dimension, norms, duplicate stability, truncation behavior, and query/document instruction policy |
| `deepseek-v4-flash` | High-confidence DeepSeek-V4-Flash family match; generation/reasoning/code | Advertised 1M context; dedicated encoder covers roles, tools, reasoning modes, and response-format prompting | The checkpoint does not use an ordinary Jinja chat template. DSML/tool translation, reasoning channels, structured output, and actual context allocation are adapter dependent. This is the highest adapter-risk generator in the list. | Verify visible content versus reasoning fields, forced tool call and continuation, schema validity, stream-channel separation, practical context, and output cap |
| `gpt-oss-120b` | High-confidence OpenAI gpt-oss-120b match; generation/reasoning/tools | 128K native context; structured output and agentic tools documented | Direct serving must translate the Harmony message/channel format. Plausible prose alone does not prove that reasoning, tool, and final channels are mapped correctly. | Assert no control-channel leakage into final content; verify fragmented tool arguments, continuation, multiple tools, schema mode, terminal usage, and cancellation |
| `ministral-3-14b-instruct-2512` | Medium-high-confidence alias of Mistral's Ministral 3 14B Instruct; multimodal generation | 256K-class context; text/image input, multilingual behavior, function calling, and JSON output documented | Vision can be disabled, context capped, and Mistral parser/config flags omitted by the serving stack | Qualify text and image roles independently; then test tool continuation, JSON versus strict schema, stream termination, practical context, and output cap |
| `qwen-3.6-27b` | Medium-high-confidence alias of Qwen3.6-27B; multimodal generation/reasoning/code | 262,144 native context; roughly 1,010,000 only with context extension; text/image input and tool use documented | Thinking mode, reasoning-field mapping, Qwen tool parser, vision enablement, and context extension are deployment choices | Separate thinking/non-thinking probes; verify reasoning isolation, forced tools and continuation, strict schema, image input, native and extended context limits, and output cap |
| `qwen3-reranker-0.6b` | High-confidence Qwen3-Reranker-0.6B family match; generative yes/no reranker, not chat | 32K input; instruction-aware and multilingual; scores derive from relative yes/no token likelihood | Stock TEI support was not established. Adapters may expose an unbounded logit difference, its sigmoid, or a normalized yes probability. The values rank similarly but are not calibrated alike. | Discover the exact route/dialect; reverse input documents to prove request-relative indices; record score transform/direction, instruction, truncation, top-N semantics, batching limit, and failure behavior |

The model name is only a probe-order hint. Every result remains scoped to the
profile, endpoint fingerprint, exact catalog id, route/dialect, workflow, probe
schema, product version, and time of observation.

## Reranking dialects that must stay explicit

No OpenAI reranking standard exists. A path alone is insufficient to select a
request builder or parser.

| Dialect | Request distinctions | Response distinctions |
| --- | --- | --- |
| TEI `/rerank` | `texts`, `truncate`, `raw_scores`, `return_text` | Bare sorted array of `{index, score}`; raw versus activation-transformed score is configurable |
| Jina-like `/v1/rerank` | `documents`, `top_n`, `return_documents` | Object containing `results[]` with `relevance_score` |
| Cohere v2 `/v2/rerank` | `documents`, `top_n` | `results[]` plus provider-specific metadata; one query ranks many documents |
| Voyage `/v1/rerank` | `documents`, `top_k`, `return_documents`, `truncation` | `data[]` with `relevance_score` |
| vLLM score/rerank family | May expose `/score`, `/v1/score`, `/rerank`, `/v1/rerank`, or `/v2/rerank` for supported architectures | Availability and compatibility convention depend on the loaded model and adapter |
| Vendor `/v1/reranking` | May use documents, texts, passages, or explicit pairs | May return sorted indexed objects or scores aligned to input order |

A rerank observation must retain request-relative index, input text hash, rank,
raw score, exposed score field, score transform, higher-is-better behavior,
instruction hash, truncation, top-N behavior, and dialect. If the result has
duplicates, missing or out-of-range indices, non-finite scores, or an ambiguous
mapping, reject it and keep the pre-rerank order.

## Failure classification and route-probing policy

The clean report prefix contained a useful class-aware policy:

| Observation | ContextDesk action |
| --- | --- |
| `401` or `403` | Stop probing routes; fix credentials or authorization. |
| `429` | Honor a bounded `Retry-After`; do not fan out to more routes. |
| `404` or `405` | Treat as evidence that the exact path is absent and move to the next configured candidate. |
| `400`, `415`, or `422` | Try another registered dialect only when the response clearly indicates envelope validation; do not guess indefinitely. |
| `408`, `502`, `503`, or `504` | Record temporary unavailability without erasing prior verified compatibility evidence. |
| `2xx` with malformed JSON or an invalid contract | Mark the route incompatible/degraded; never reinterpret HTML, prose, or partial data as success. |

Normalize HTTP status, content type, allowlisted correlation id, `Retry-After`,
a bounded redacted body, recognizable provider code/type/message, and an
internal class. Do not require every provider to use one JSON error envelope.

## BGE-M3 and Qwen reranker product policies

- Bind every vector index to exact model and endpoint identities, route/dialect,
  representation, dimension, tokenizer/vocabulary where applicable, pooling,
  normalization/similarity policy, instruction profile, preprocessing/chunking
  version, and truncation policy.
- Start BGE-M3 with verified dense vectors. Enable sparse output only through a
  typed token-id/weight contract and ColBERT only through a typed multi-vector
  contract. Never flatten either representation into a single `number[]`.
- Canonical BGE-M3 starts with no query or document prefix. Any server-injected
  prompt or private fine-tune instruction becomes index identity.
- For Qwen3-Reranker, preserve the task framing, instruction, query, and answer
  suffix, and truncate the candidate document first. This is an application
  policy to test, not a promise about a remote route.
- Batch rerank candidates by total token budget rather than document count and
  keep original evidence ids independent of response positions.
- Do not apply a universal `0.5` threshold or compare scores across rerankers.
  Rank order may be usable before score calibration is.

## Recovered primary-source links

These URLs were present in the readable source key. They are retained as
research provenance and were not re-fetched during this recovery.

- [Mistral Small 24B Instruct 2501 FP8 dynamic](https://huggingface.co/RedHatAI/Mistral-Small-24B-Instruct-2501-FP8-dynamic)
- [Mistral Small 24B Instruct 2501](https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501)
- [BAAI BGE-M3 model card](https://huggingface.co/BAAI/bge-m3), [paper](https://arxiv.org/abs/2402.03216), [FlagEmbedding examples](https://github.com/FlagOpen/FlagEmbedding/tree/master/examples/inference/embedder)
- [DeepSeek-V4-Flash model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash), [encoding notes](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/README.md)
- [OpenAI gpt-oss introduction](https://openai.com/index/introducing-gpt-oss/), [model card](https://openai.com/index/gpt-oss-model-card/), [Harmony repository](https://github.com/openai/harmony)
- [Ministral 3 14B Instruct 2512](https://huggingface.co/mistralai/Ministral-3-14B-Instruct-2512)
- [Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B)
- [Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
- [OpenAI models](https://developers.openai.com/api/reference/resources/models), [Chat Completions](https://developers.openai.com/api/reference/resources/chat), [embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- [Hugging Face TEI quick tour](https://huggingface.co/docs/text-embeddings-inference/quick_tour), [supported models](https://huggingface.co/docs/text-embeddings-inference/supported_models), [HTTP types](https://github.com/huggingface/text-embeddings-inference/blob/main/router/src/http/types.rs), [Qwen3 reranker issue](https://github.com/huggingface/text-embeddings-inference/issues/643)
- [vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/), [Cohere rerank](https://docs.cohere.com/v2/reference/rerank), [Jina rerank](https://api.jina.ai/redoc), [Voyage rerank](https://docs.voyageai.com/reference/reranker-api)

Vercel Voyage qualification proves ContextDesk's Vercel specialty adapters. It
does not answer any of the employer-deployment unknowns above.
