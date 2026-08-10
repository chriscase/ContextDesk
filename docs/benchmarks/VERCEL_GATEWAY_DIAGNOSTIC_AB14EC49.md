# Vercel gateway diagnostic — `ab14ec49`

**Date:** 2026-08-10  
**Purpose:** live, bounded verification of the current production paths against
the Vercel gateway. This is an observation record, not a global model-quality
badge and not evidence for the employer gateway.

## Safety and identity

- Source branch: `integrate/acceptance-release-v1`
- Exact source/build SHA: `ab14ec497471559487084e21d0d1cd82cfbb8914`
- Credential source: protected local file plumbing; no Keychain lookup was used
  by these runs.
- No raw provider capture was requested or written.
- The diagnostic created and removed only its temporary corpora and sessions;
  cleanup failures were zero in every run.
- Model and profile names are recorded here because they are non-secret catalog
  identifiers. Endpoints, headers, credentials, private paths, and provider
  bodies are intentionally absent.

## DeepSeek V4 Flash triage run

Exact catalog model: `deepseek/deepseek-v4-flash`  
Run id: `gwdx-1786403162139-92602`  
Deadline: 600 seconds  
Requests made: 15 of 23 planned  

| Product check | Result |
|---|---|
| Ordinary generation | pass |
| Strict structured response | pass |
| Native tool call + continuation | transport pass; conservative grounding classification was `retry_required` |
| Selected context | pass |
| Known-truth linked-log triage | pass; 54,902 ms, 4 provider rounds |

The typed triage scorer passed with trigger identification and symptom
separation. The validated answer contained 4 candidates and 5 claims, including
one symptom claim and one initiating-cause claim. The overall verdict was:

```text
gateway_model_status=pass
product_workflow_status=pass
answers_useful_status=pass
```

This is the first live run on this release line that passes the full known-truth
triage scorer. A preceding run on `37a3a80f` completed in 70,912 ms but failed
only because the candidate stage mislabeled the causal and downstream groups as
competing. The candidate-role guidance was tightened, and the successful run
above validates that correction.

Share-safe artifacts:

```text
local artifact `contextdesk-vercel-deepseek-rolefix5-out/gwdx-1786403162139-92602/report.json`
  SHA-256 44b47696d2ed636aefcaa9d5dc892be31cfed75340ff68e11771c130a1ba7b70
local artifact `contextdesk-vercel-deepseek-rolefix5-out/gwdx-1786403162139-92602/manifest.json`
  SHA-256 637357211268c57d582896467bb45c0d60d107004c476893a7d3a991478b7a79
```

## Embedding role

Exact catalog model: `alibaba/qwen3-embedding-0.6b`  
Run id: `gwdx-1786403278518-93335`  
Requests made: 2  

- Direct embedding contract: pass (`vector_len=1024`).
- Production OpenAI-compatible embedding path: pass; four finite homogeneous
  vectors, dimension 1024.
- Known-ranking semantic check: pass; the database-timeout document ranked
  first.
- Overall gateway, product, and usefulness statuses: pass.

Share-safe artifact hashes:

```text
report.json  c4a7e1aec005186c47f2879cedcfef51d33eec210ec3b720137fecc45140395c
manifest.json 610bb2cc9fe1182dcf1051f2c317e208427c7a1b112e4059a370b03c81bd93ea
```

## Reranker role

Exact catalog model: `voyage/rerank-2.5-lite`  
Run id: `gwdx-1786403285871-93367`  
Requests made: 2  

- Direct reranker contract: pass; returned a valid permutation of the synthetic
  documents.
- Production reranker path: pass; the database-timeout document ranked first.
- Overall gateway and product statuses: pass.
- `answers_useful` is **inconclusive** for this specialty role because the
  diagnostic intentionally has no generative answer scorer; ranking order is
  checked by the production lane itself.

Share-safe artifact hashes:

```text
report.json  11508f68f4b1b669297bb5a0c058bfe715e83119abcf0472c748fe18b0349880
manifest.json 255ad1c9dd36ce3d5ec6ac5956532c7cd039bd87ac8a1c895d09a12198475395
```

## Interpretation and remaining limits

The Vercel evidence supports using DeepSeek V4 Flash for the current triage
workflow on this exact profile/model pair, Qwen3 Embedding 0.6B for the
OpenAI-compatible embedding role, and Voyage Rerank 2.5 Lite for the reranking
role. It does **not** establish employer-gateway behavior, latency guarantees,
or a universal model badge. Employer models still require the same explicit
diagnostic on the employer profile, using its exact discovered ids.
