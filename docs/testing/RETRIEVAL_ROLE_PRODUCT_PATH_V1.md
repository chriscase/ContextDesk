# Retrieval role product path — v1

Status: implemented on the acceptance release line; Vercel specialty lanes
are live-verified, while employer-gateway quality is still unverified.

## What is wired

The desktop host and headless CLI attach explicitly enabled retrieval roles
through the same `ToolHost` used by ordinary and linked-log turns:

- `cd_workflow::retrieval::build_embedding_backend` selects the configured
  embedding dialect and protected-file credential reference.
- `cd_workflow::retrieval::build_rerank_backend` selects the configured
  reranker dialect and protected-file credential reference.
- Linked-log `search_logs` uses the configured embedder for semantic scoring
  only when corpus model/dimension identity matches, then optionally reranks
  the bounded existing hit set.
- Reranking never removes evidence. Invalid, incomplete, non-finite, or
  timed-out scores keep the deterministic pre-rerank order.
- Remote retrieval requires the role's explicit egress acknowledgment. A
  failed construction or unacknowledged endpoint leaves the existing local or
  keyword path usable.
- `contextdesk gateway diagnose` now builds these same production adapters for
  its specialty product lane, using the credential already resolved for the
  diagnostic run (no additional Keychain/file read).
- CLI chat construction now attaches the configured roles through the same
  factories; a configured role is no longer merely visible in status while
  ordinary CLI triage silently uses only the fallback.

## What is deliberately not claimed

Configuration is not verification, and adapter support is not model quality.
The release does not claim that an employer `bge-m3` endpoint actually serves
the OpenAI embeddings envelope, or that an employer Qwen reranker serves the
TEI/Cohere envelope. Those exact route/dialect facts still require a live
diagnostic on the employer gateway.

Stored vectors remain bound to their exact model identity and dimension. A
configured model change therefore degrades to keyword retrieval until the
corpus is explicitly re-analyzed through the matching embedder.

## Hermetic evidence

- `cargo test -p cd-core --lib log_analysis::search` — rerank reorder and
  invalid-response fallback tests pass.
- `cargo test -p cd-workflow --test retrieval_production_path` — configured
  protected-file embedding role reaches the production retrieval seam.
- CLI host wiring test — explicitly enabled loopback embedding and reranker
  roles attach without a provider request or credential read.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml` — native host
  suite passes.

The next live experiment is one selected employer embedding model and one
selected reranker model, using exact catalog IDs, explicit dialect selection,
protected-file credentials, and share-safe artifacts only.

## Vercel live evidence — 2026-08-10

Using the exact catalog IDs returned by discovery and the protected
`file:` credential path:

| Role | Exact model ID | Direct contract | Production adapter | Synthetic quality check |
| --- | --- | --- | --- | --- |
| embedding | `voyage/voyage-4-lite` | pass (`vector_len=1024`) | pass (4 finite homogeneous vectors, dimension 1024) | pass (expected semantic match at index 0) |
| reranker | `voyage/rerank-2.5-lite` | pass (permutation contract) | pass (expected relevance match at index 0) | checked in production lane |

Each run made two provider requests (one qualification probe and one
production-adapter request), completed within the explicit 120-second
deadline, and removed all disposable state. The share-safe report contains no
credential, endpoint, raw provider body, or private path. These results prove
wire compatibility and a small synthetic sanity check on Vercel; they do not
prove that the employer's BGE-M3/Qwen routes use the same dialects or that
retrieval improves a real employer corpus.
