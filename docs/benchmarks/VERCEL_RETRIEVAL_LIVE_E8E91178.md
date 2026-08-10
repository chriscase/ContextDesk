# Vercel retrieval live check — `e8e91178`

**Run date:** 2026-08-10  
**Source build:** `e8e91178` (`feat(retrieval): require explicit remote egress consent`)  
**Gateway:** Vercel AI Gateway v4 specialty routes  
**Input:** committed synthetic fixture `contextdesk_vercel_retrieval_direct_v1`  
**Scope:** 41 synthetic documents, 7 synthetic queries, one embedding model and one reranker

This was a bounded direct retrieval check through the existing
`cd-vercel-retrieval-lab` credential plumbing. The key was supplied by a
protected file reference; it was not printed, passed as an argument, or read
through Keychain. The full bounded local capture is outside the repository at:

```text
/private/tmp/contextdesk-retrieval-live-e8e91178.json
SHA-256: dfaef793561754712e7496bd8bf2d26987f2e838dc812402e41fd765ebbb357f
```

The capture contains synthetic vectors and document identities only. It is not
a production corpus or an answer-quality result.

## Wire compatibility

| Role | Exact model | Result |
| --- | --- | --- |
| Embedding | `alibaba/qwen3-embedding-0.6b` | Valid v4 response; 1,024 dimensions; 7 queries; no warnings |
| Reranking | `voyage/rerank-2.5-lite` | Valid v4 response; complete ranking for every query; no warnings |

Observed latency was approximately 1.8 s for the embedding batch and 7.9 s
for the combined reranking calls. The embedding response reported 1,896 usage
tokens.

## Aggregate retrieval observations

The three embedding query shapes were plain, evidence-terms, and the neutral
structural form. Values are mean recall at each fixture’s declared K.

| Lane | Relevant recall | Mandatory-anchor recall | Forbidden share |
| --- | ---: | ---: | ---: |
| Qwen embedding — plain | 0.5881 | 0.5595 | 0.0408 |
| Qwen embedding — evidence terms | 0.5988 | 0.5238 | 0.0571 |
| Qwen embedding — structural | 0.5881 | 0.5595 | 0.0000 |
| Voyage rerank over full candidate set | 0.7286 | 0.5952 | 0.0490 |
| Qwen + Voyage — plain | 0.6988 | 0.5595 | 0.0408 |
| Qwen + Voyage — evidence terms | 0.6988 | 0.6667 | 0.0490 |
| Qwen + Voyage — structural | **0.7464** | **0.6667** | 0.0490 |

## Verdict

- **Protocol:** pass for the exact Vercel v4 embedding and reranking contracts.
- **Retrieval usefulness:** promising on this synthetic fixture; the neutral
  structural shape was the strongest combined lane and preserved more required
  anchors than the plain lane.
- **Production readiness:** not established. This does not verify the
  employer’s BGE-M3 or Qwen reranker deployment, does not prove answer quality,
  and does not justify silently enabling remote retrieval.
- **Safety:** remote retrieval remains default-deny. A product role must carry
  explicit `allow_remote` consent before query or candidate text can leave the
  machine; otherwise ContextDesk reports `egress_not_acknowledged` and keeps
  the structured/keyword baseline.

The next meaningful evidence is a consented employer-gateway run using the
exact discovered BGE-M3 and Qwen-reranker IDs, followed by a fixed-corpus
product-path answer evaluation. No model-name equivalence should be inferred
from this Vercel result.
