# Gateway contract fixtures — live-evidence coverage matrix

Status: durable test-evidence map (not a product capability claim)
Branch: `test/gateway-contract-fixtures-v1`
Base: `d17a120d`
Last updated: 2026-08-09

This matrix converts **verified live gateway observations** into **sanitized,
deterministic, hermetic** contract/regression tests. It is a test-evidence lane
only: no credentials, Keychain access, live network, private hosts, request IDs,
timestamps, billing metadata, or full stochastic model prose are retained.

Source journal for the live runs (observations only):
[`VERCEL_REFINEMENT_LAB_NOTES.md`](./VERCEL_REFINEMENT_LAB_NOTES.md).

## Safety rules for every fixture

| Allowed | Forbidden (must not copy from live traffic) |
| --- | --- |
| Public protocol field names and envelope shapes | Authorization / `Bearer` values, API keys, Keychain material |
| Synthetic model ids that match public catalog names | Private / employer endpoint hostnames with credentials |
| Fixed finite numbers, short marker tokens | Request IDs, trace IDs, timestamps, account/billing metadata |
| Role labels (`chat` / `embedding` / `reranking`) | Full free-form model completions from live runs |
| Deterministic scripted transports | Wall-clock network latency assertions as pass criteria |

Fixtures live under [`fixtures/gateway-contracts/v1/`](../../fixtures/gateway-contracts/v1/).
Hermetic tests: `crates/cd-core/tests/gateway_contract_fixtures.rs`.

## Coverage matrix

| Live observation | Normalized contract preserved | Test status | Why the fixture is safe/stable | Must not copy from live |
| --- | --- | --- | --- | --- |
| Vercel catalog returns chat, embedding, and reranking models together | Catalog rows may declare mixed specialty roles; role classification must not treat every id as chat-capable | **Added** `mixed_catalog_classifies_roles_without_assuming_chat` + fixture `catalog-mixed-roles.json`; **existing** `model_role_hints` golden catalog | Synthetic ids + public `modelType` labels only; no auth, no pricing that encodes account state | Full account inventory dumps, private aliases, auth headers, request IDs |
| Name-based roles must demote specialty models from ordinary chat defaults | Embedding / reranker name hints never set `ordinary_chat_default` | **Existing** `model_role_hints` unit + golden fixture; **added** exact live ids `voyage/voyage-4`, `voyage/rerank-2.5`, `deepseek/deepseek-v4-flash`, `openai/gpt-oss-120b` | Pure string classification; no I/O | Live recommendation rankings, cost, quality claims |
| `deepseek/deepseek-v4-flash` accepted generation, tool-call, tool-result, structured output, streaming, cancellation | Chat-role qualification suite: six probes pass via transport contract, not wall-clock | **Added** `live_chat_models_pass_full_scripted_suite` (scripted transport); **existing** `success_path_basic_generation_and_tools` | Scripted markers / inert tool args only; no model prose | Live completions, token usage, ~9–17 s timings as assertions |
| `openai/gpt-oss-120b` accepted the same chat contract | Same six-probe suite for this exact model id | **Added** (same test, second model id) | Same as above | Same as above |
| `voyage/voyage-4` returned one finite 1024-d embedding | Specialty embed envelope: response length, exact dimension, all finite | **Added** `voyage_4_embedding_envelope_and_qualification`; **existing** empty/non-finite fail in capability_qualification | Programmatic unit vector (no live floats); dimension constant only | Live embedding vectors, usage tokens, request IDs, latency ms as pass criteria |
| `voyage/rerank-2.5` returned a complete permutation | Rerank envelope: complete index permutation of submitted docs; scores finite | **Added** `voyage_rerank_complete_permutation_and_qualification`; **existing** `HttpRerankBackend` / `parse_ranking_indices` fail-closed cases | Synthetic indices + scores in `[0,1]`; no document text from incidents | Live document text, ranking of real incidents, account metadata |
| Vercel v4 embed/rerank use specialty envelopes, not chat | Request/response shapes differ from OpenAI chat completions | **Added** `vercel_v4_specialty_envelopes_are_not_chat_shapes` + request fixtures; **existing** lab bin envelope tests | Field names and nesting only | Bearer tokens, host-specific path auth, live warnings copy |
| Slow but valid model responses | Qualification must succeed via scripted deterministic transport; no sleep-based latency gates | **Added** `verbose_scripted_chat_passes_without_wall_clock_sleep` | Multi-fragment content assembled in-process; no `sleep` / no `Duration` pass criteria | Wall-clock 9–17 s measurements as test thresholds |
| Malformed / truncated payloads | Fail closed (error or Fail status), never invent defaults | **Added** fail-closed matrix + fixture files; **existing** openai SSE matrix, rerank HTTP tests, embedding NaN test | Minimal broken JSON shapes | Partial live error bodies that quote secrets |
| Duplicate / missing / out-of-range rerank indices | Reject incomplete or ambiguous rankings | **Added** + **existing** `HttpRerankBackend` / lab `validate_ranking` / workflow `parse_ranking_indices` | Index/score numbers only | Live ranking rows |
| Non-finite or dimension-mismatched embeddings | Reject NaN/Inf, empty, or inconsistent dims | **Added** + **existing** qualification embed fail | Synthetic bad numbers | Live vectors |
| Role-mismatched responses | Embedding/reranker roles offer only specialty probes; chat-shaped body must not satisfy embed parse | **Added** `role_mismatch_fails_closed` | Wrong envelope shapes, no secrets | Live misroute responses |
| Explicit backend error envelopes | HTTP error / `raw_error` / transport error → Fail (or classified unreachable), not silent pass | **Added** `backend_error_envelopes_fail_closed`; **existing** probe status classify, 429/SSE matrix | Status codes + short synthetic reasons | Provider error bodies that may echo prompts/keys |
| Discovery empty/malformed catalog | Empty model list is non-success / unreachable, not a verified empty inventory claim | **Existing** discovery probe logic (live path); **added** pure parse of empty/malformed catalog fixtures | Shape-only | Live empty responses with account headers |
| `openai/gpt-5.6-luna` failed the tool-continuation lane twice with every provider round completing normally; `deepseek/deepseek-v4-flash` passed the same case | A completed turn declined by the host evidence gate is a host outcome, not a provider fault: grounding tracks citeable identities (not `result_count`), a refused tool result leaves the next prompt unchanged, and the share-safe category is `host_grounding_refused`, never `provider_error` | **Added** `tool_continuation_shape_records_no_provider_fault_in_either_case`, `a_refused_tool_result_leaves_the_next_prompt_unchanged`, `a_nonzero_result_count_without_identities_is_never_treated_as_grounded`, `a_host_grounding_refusal_is_never_reported_as_a_provider_error` + fixture `tool-continuation-grounding-shape.json`; **added** boundary pin `a_pattern_matched_template_can_outlive_its_time_filtered_events_with_no_evidence` | Round counts, tool-offer counts, finish reasons, and small fixed counts only; prompt identity is a symbolic `prompt_repeats_round` back-reference instead of live token counts | Request/response bodies, model prose, tool arguments, corpus/session/run ids, prompt or completion token counts, per-round latencies |

Evidence record for that last row, including what the live runs do **not**
prove: [`TOOL_CONTINUATION_GROUNDING_EVIDENCE.md`](./TOOL_CONTINUATION_GROUNDING_EVIDENCE.md).

## Existing coverage retained (audit summary)

| Area | Primary locations | Notes |
| --- | --- | --- |
| Discovery / probe classification | `discovery.rs` unit tests; `is_vercel_ai_gateway` | Live Vercel catalog fetch is host-only; pure status classify is offline |
| Role name hints | `model_role_hints.rs` + `fixtures/providers/model-role-hints.v1.json` | Golden catalog extended with live-observed public ids |
| Capability qualification | `capability_qualification.rs` unit tests + `ScriptedQualificationTransport` | Chat suite, cancel isolation, embed/rerank fail paths |
| OpenAI-compatible transport | `tests/openai_compatible_provider_matrix.rs` | SSE fragment, tool-call reassembly, cancel, malformed mid-stream |
| Generic HTTP rerank | `rerank.rs` unit tests (wiremock) | Permutation order, duplicate/missing, HTTP 429 |
| Vercel retrieval lab envelopes | `bin/cd-vercel-retrieval-lab.rs` tests | v4 document request/response, ranking validation |
| Live workflow adapters | `cd-workflow` capability_qualification tests | `parse_ranking_indices` v4 vs generic |

## Uncovered / intentionally out of scope

| Contract | Why uncovered here |
| --- | --- |
| Answer quality / product triage usefulness | Quality-eval harness lane — do not edit |
| Multi-stage budget / progress UX | Separate implementation lanes — do not edit |
| Live network reachability of `ai-gateway.vercel.sh` | Requires credentials/network; hermetic suite forbids it |
| Exact live latency or cost dollars | Non-deterministic; represent with scripted transports only |
| Stochastic full model prose | Unstable snapshot; use markers (`QUALIFY_OK_V1`) |
| Employer/private gateway catalogs | Out of scope; keep fixtures provider-public and synthetic |
| Retrieval quality with voyage embed+rerank in product path | Lab/benchmark evidence only; not activated as product default |

## Production defects discovered

None observed while encoding this matrix. No production behavior was changed to force a pass. If a future fixture fails against production parsers, add the smallest failing regression and report it separately rather than broadening implementation.
