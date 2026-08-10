# Vercel retrieval-role diagnostic — release-tip rerun

Date: 2026-08-10  
Exact source/build SHA: `8bff602f9797952781da3a87c19f9823b43ed823`

This rerun used the exact release SHA pinned by
`docs/testing/SOURCE_ACCEPTANCE_PROCEDURE_RELEASE_V1.md`, the protected
`file:` credential reference, and the exact model IDs returned by catalog
discovery. No Keychain access was used.

| Role | Exact model ID | Direct contract | Production adapter | Synthetic check | Requests | Exit |
| --- | --- | --- | --- | --- | ---: | ---: |
| Embedding | `voyage/voyage-4-lite` | pass, vector length 1024 | pass, 4 finite homogeneous vectors, dimension 1024 | pass, expected match index 0 | 2 | 0 |
| Reranker | `voyage/rerank-2.5-lite` | pass, complete permutation | pass, expected relevance match index 0 | checked in production lane | 2 | 0 |

Both reports carried `git=8bff602f9797`, `gateway_model_status=pass`, and
`product_workflow_status=pass`. Cleanup removed all disposable state with no
failures. The reports were share-safe and did not contain credentials,
endpoints, raw provider bodies, or private paths.

The embedding and reranking results establish Vercel wire compatibility and a
small synthetic sanity check for the production retrieval adapters. They do
not establish employer-gateway dialect compatibility or usefulness on a real
employer corpus; those remain acceptance work.

Local share-safe artifact directories:

- `/private/tmp/contextdesk-vercel-embed-product-8bff602f-155345`
- `/private/tmp/contextdesk-vercel-rerank-product-8bff602f-155345`
