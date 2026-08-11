# Production rerank candidate depth v1

The normal `search_logs` path now distinguishes the final result budget (`k`)
from the bounded pre-rerank candidate pool (`candidate_k`). The host retrieves
up to the candidate pool, applies the configured reranker, and truncates to the
final `k` only afterward. If `candidate_k` is omitted, it remains the existing
`k`-sized behavior.

`candidate_k` is host-bounded to `k..=100`; malformed, oversized, or otherwise
unusable values cannot create unbounded retrieval work. Suppression is applied
before candidate construction, so excluded templates cannot return through the
wider pool. Invalid rerank responses leave the exact pre-rerank order intact,
and equal scores preserve that stable order.

The production-path proof is:

```text
cargo test -p cd-core --lib log_analysis::search
cargo test -p cd-core --lib tool_host::tests::toolhost_search_logs_can_promote_candidate_beyond_final_k
```

This proves candidate-pool plumbing and deterministic fallback behavior. It does
not claim that any real embedder or reranker improves answer usefulness.
