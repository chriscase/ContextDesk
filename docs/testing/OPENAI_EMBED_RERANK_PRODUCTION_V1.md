# Production OpenAI-compatible embeddings & explicit rerank dialects v1

**Branch:** `feat/openai-embed-rerank-production-v1`  
**Base:** `2bdd4379b6062e4e121aa1721d9cfaee43b60a57`  
**Suite tip:** see `git rev-parse HEAD` on this branch after docs stamp  
**Production code changed:** **yes**

## Purpose

Make employer-gateway embeddings and reranking usable on the **real production
retrieval path** (`EmbedBackend` / `RerankBackend` → hybrid search), not only
qualification-side HTTP helpers.

## What shipped

| Area | Change |
| --- | --- |
| Embed | `OpenAiCompatibleEmbedBackend` — batched `POST …/embeddings`, index order, finite homogeneous dims, model echo binding, protected-file bearer, batch bounds |
| Parse | `parse_openai_embeddings_response` / `validate_embedding_batch` shared contracts |
| Rerank dialect | `RerankDialect` (default `TeiCohere`); never inferred from URL; `parse_tei_cohere_rerank_scores` / `parse_tei_cohere_ranking_indices` |
| HTTP rerank | `HttpRerankBackend::with_dialect`; TEI/Cohere + Qwen `relevanceScore` |
| Config | `RetrievalRoleModel.embed_wire` / `rerank_dialect` |
| Workflow | `build_embedding_backend(role, secrets)` OpenAI-default; dialect-aware `build_rerank_backend`; qualification reuses production parsers |
| Share-safe | `ShareSafeRetrievalReport` + `assert_share_safe_json` |
| Tests | Hermetic mock-gateway embed/rerank labs; fixed-corpus ablation; wire matrix update |

## Commands / counts (green)

```text
cargo test -p cd-core --test openai_compatible_embed_production   # 7
cargo test -p cd-core --test rerank_dialect_production            # 4
cargo test -p cd-core --test gateway_wire_rerank                  # 12
cargo test -p cd-workflow --test retrieval_production_embed_rerank # 5
cargo fmt --all -- --check
cargo clippy -p cd-core -p cd-workflow --all-targets -- -D warnings
```

## Mutations (invert → fail → restore → green)

| Contract | Result |
| --- | --- |
| Wrong model identity assert | fail → green |
| Dialect from URL string | fail → green |
| Batch order flip | fail → green |
| Share-safe private URL leak | fail → green |
| Silent accept missing embed rows (test inversion) | fail → green |
| Malformed rerank accepted (test inversion) | fail → green |

## Gaps / deferred

- Sparse / multi-vector BGE-M3 and automatic routing not implemented.
- Vercel v4 embed/rerank remains qualification-special-case for that host only.
- Full monorepo CI matrix not re-run; focused embed/rerank/retrieval suites only.
- No live gateway / Keychain / employer corpus.
- Deterministic retrieval-ablation lab still labels live BGE-M3 as a
  configuration-gated future capability in its offline roster; production
  adapters exist when roles are configured.

## Non-goals confirmed

- No PR; no desktop UI; no live provider calls.
