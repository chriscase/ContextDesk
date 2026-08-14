# Vercel retrieval-role diagnostic — exact release code

Date: 2026-08-10  
Source/build identity: `77e520da063bf872a011d3418c983660e5b47cd0`  
Gateway: configured Vercel profile, protected-file credential reference  
Diagnostic: `gateway diagnose --level basic --yes --no-color --jsonl`

This is a live wire check of the production embedding and reranking adapters
from the exact source SHA used by the source-based acceptance procedure. It is
not a claim about the employer gateway or about final answer quality.

## Embedding role

- Exact catalog model: `voyage/voyage-4-lite`
- Direct lane: **pass** — vector length 1024; 1 request
- Production lane: **pass** — four finite, homogeneous vectors, dimension 1024; 1 request
- Synthetic host scorer: **pass** — selected expected index 0; no provider request
- Requests total: 2
- Verdict: gateway compatibility **pass**; product-path compatibility **pass**
- Artifact hashes:
  - `report.json`: `b082d7e1bdba806069c5df8d8b864d458c1b46953375dfaf1da1470567e6ca8f`
  - `manifest.json`: `2cb0db3468e89ce4e0f5abbc7349028a3bb8c8407912feb3051a28653e6da7c7`

## Reranking role

- Exact catalog model: `voyage/rerank-2.5-lite`
- Direct lane: **pass** — ranked IDs formed a complete permutation; 1 request
- Production lane: **pass** — expected item ranked first; 1 request
- Host scorer: not applicable; production order is the contract for this role
- Requests total: 2
- Verdict: gateway compatibility **pass**; product-path compatibility **pass**;
  answer usefulness **inconclusive** (this role does not generate answers)
- Artifact hashes:
  - `report.json`: `9b3acebec367fdcca2e69537e43269ac73611dcb56cba0e3e134d12a95460142`
  - `manifest.json`: `c46cc767ba2af8570070664919bd67b547882f1c8c44abbc856cedbd057cee45`

The local share-safe bundles are retained under `/private/tmp` with the run
directories named by role and source SHA. No provider body, endpoint, header,
secret, or private path is part of the share-safe report.
