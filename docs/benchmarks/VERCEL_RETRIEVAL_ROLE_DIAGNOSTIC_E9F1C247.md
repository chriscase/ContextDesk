# Vercel retrieval-role diagnostic — production adapters

Date: 2026-08-10  
Source build: `e9f1c24715e704cc785b56c1f2b5309c124e061c`  
Gateway profile: configured Vercel profile (share-safe pseudonym only in the
raw reports)  
Credential path: protected `file:` reference; no Keychain access

This is a live wire and product-adapter diagnostic, not a claim about an
employer gateway or a real incident corpus. The command used the exact model
IDs returned by Vercel catalog discovery and ran the production adapters that
configured retrieval roles use.

## Results

| Role | Exact catalog model ID | Direct contract | Production adapter | Synthetic check | Requests |
| --- | --- | --- | --- | --- | ---: |
| Embedding | `voyage/voyage-4-lite` | pass, vector length 1024 | pass, 4 finite homogeneous vectors, dimension 1024 | pass, expected match index 0 | 2 |
| Reranker | `voyage/rerank-2.5-lite` | pass, complete permutation | pass, expected relevance match index 0 | checked in production lane | 2 |

Both runs completed within an explicit 120-second deadline, exited 0, and
reported `gateway_model_status=pass` and `product_workflow_status=pass`.
Cleanup removed all disposable state and reported no failures. The share-safe
reports contain no credential, endpoint, raw provider body, or private path.

## Local artifacts

The share-safe report files remain under `/private/tmp` on the test machine:

- embedding report SHA-256:
  `d7e18a0b83b41cf2b83b339227dc841bfb14ea2ff42b5c4a359f43d3b1201d72`
- reranker report SHA-256:
  `e7483f56439359f9bb123ed88d74e46769cb616f4fb042e42142f869c8c98db5`

## Interpretation

The Vercel specialty routes and production adapters are compatible for these
exact models, and the tiny synthetic ranking check behaved as expected. This
does not establish that an employer BGE-M3 or Qwen endpoint uses the same
envelopes, route, or score semantics. Employer retrieval remains an acceptance
item: select the exact discovered IDs, choose explicit dialects, use the
protected credential reference, and evaluate fixed-corpus retrieval ablations
separately from answer usefulness.
