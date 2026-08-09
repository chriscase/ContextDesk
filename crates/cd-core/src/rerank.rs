//! Provider-neutral optional reranking backends.
//!
//! Reranking is an OPTIONAL retrieval role: its absence or failure must leave
//! the structured/keyword baseline (and any semantic lane) fully usable.
//! Model names are configuration, never behavior — `qwen3-reranker-0.6b` is a
//! configuration example, not a hard-coded default. A rerank score means
//! retrieval relevance to the query text; it is never proof of causation.
//!
//! Capability (an adapter exists), current health (the endpoint answered a
//! probe just now), and measured quality (benchmark numbers) are distinct
//! facts and are surfaced separately by the retrieval status DTOs.

use async_trait::async_trait;

use crate::error::{CoreError, CoreResult};

/// Character cap applied to each document sent to a reranker. Bounds request
/// size and memory; rerank quality on log lines does not need full payloads.
pub const RERANK_DOC_CHAR_CAP: usize = 512;

/// Hard cap on documents per rerank request (batch bound).
pub const RERANK_MAX_DOCUMENTS: usize = 100;

/// Default wall-clock budget for one rerank call.
pub const RERANK_DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// A provider-neutral reranker: scores `documents` for relevance to `query`,
/// returning one score per document in input order (higher = more relevant).
#[async_trait]
pub trait RerankBackend: Send + Sync {
    /// Score `documents` against `query`; one finite score per document in
    /// input order (higher = more relevant to the QUERY TEXT — relevance,
    /// not causation).
    async fn rerank(&self, query: &str, documents: &[String]) -> CoreResult<Vec<f32>>;

    /// Configured model identity for telemetry/reports (e.g.
    /// `"qwen3-reranker-0.6b"`). Synthetic backends MUST say so in the
    /// identity so a scripted run can never be mistaken for a capability.
    fn identity(&self) -> String;
}

/// Truncate a document to the rerank character cap on a char boundary.
pub fn cap_rerank_document(text: &str) -> String {
    if text.chars().count() <= RERANK_DOC_CHAR_CAP {
        return text.to_string();
    }
    text.chars().take(RERANK_DOC_CHAR_CAP).collect()
}

/// Bridge an async rerank call into synchronous retrieval code with a hard
/// timeout, mirroring `memory::embed_blocking`. `None` = failed or timed out;
/// the caller must degrade gracefully (keep pre-rerank order) and record the
/// degradation.
pub fn rerank_blocking(
    backend: &dyn RerankBackend,
    query: &str,
    documents: &[String],
    timeout_ms: u64,
) -> Option<Vec<f32>> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| rerank_on_fresh_runtime(backend, query, documents, timeout_ms))
            .join()
            .unwrap_or(None)
    })
}

fn rerank_on_fresh_runtime(
    backend: &dyn RerankBackend,
    query: &str,
    documents: &[String],
    timeout_ms: u64,
) -> Option<Vec<f32>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    runtime
        .block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                backend.rerank(query, documents),
            )
            .await
        })
        .ok()?
        .ok()
}

// ---------------------------------------------------------------------------
// HTTP adapter (TEI / Cohere-compatible `/rerank` contract)
// ---------------------------------------------------------------------------

/// HTTP reranker speaking the widely-implemented `/rerank` JSON contract
/// (text-embeddings-inference, Cohere, Jina, Infinity, vLLM):
///
/// ```json
/// POST {base_url}/rerank
/// {"model": "...", "query": "...", "documents": ["...", "..."]}
/// -> {"results": [{"index": 0, "relevance_score": 0.97}, ...]}
/// ```
///
/// The URL is SSRF-vetted and the client pinned exactly like every other
/// provider client. An optional bearer credential is held in memory only:
/// never logged, never serialized, never part of `identity()`.
pub struct HttpRerankBackend {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    bearer: Option<String>,
}

impl std::fmt::Debug for HttpRerankBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately omits the bearer credential.
        f.debug_struct("HttpRerankBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl HttpRerankBackend {
    /// Build against `base_url` (scheme+host+port, e.g.
    /// `http://127.0.0.1:8080`); the `/rerank` path is appended. The URL is
    /// validated by the shared SSRF policy and resolved via the system
    /// resolver with pinning.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        let policy = crate::ssrf::SsrfPolicy::default();
        let resolver = crate::ssrf::SystemResolver;
        let (url, client) = crate::ssrf::build_pinned_client_for_url(
            base_url,
            &policy,
            &resolver,
            std::time::Duration::from_millis(RERANK_DEFAULT_TIMEOUT_MS),
        )?;
        // Preserve an operator-supplied path prefix such as `/v1` regardless
        // of whether the base URL has a trailing slash. `Url::join("rerank")`
        // treats a slash-less final segment as a file and would silently drop
        // it (`https://host/v1` -> `https://host/rerank`).
        let mut endpoint = url;
        let base_path = endpoint.path().trim_end_matches('/');
        let rerank_path = if base_path.is_empty() {
            "/rerank".to_string()
        } else {
            format!("{base_path}/rerank")
        };
        endpoint.set_path(&rerank_path);
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        Ok(Self {
            client,
            endpoint,
            model: model.into(),
            bearer,
        })
    }
}

#[derive(serde::Serialize)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
}

#[derive(serde::Deserialize)]
struct RerankResponse {
    results: Vec<RerankResultRow>,
}

#[derive(serde::Deserialize)]
struct RerankResultRow {
    index: usize,
    relevance_score: f32,
}

#[async_trait]
impl RerankBackend for HttpRerankBackend {
    async fn rerank(&self, query: &str, documents: &[String]) -> CoreResult<Vec<f32>> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        if documents.len() > RERANK_MAX_DOCUMENTS {
            return Err(CoreError::Config(format!(
                "rerank request exceeds the {RERANK_MAX_DOCUMENTS}-document batch bound"
            )));
        }
        let capped: Vec<String> = documents.iter().map(|d| cap_rerank_document(d)).collect();
        let body = RerankRequest {
            model: &self.model,
            query,
            documents: &capped,
        };
        let mut request = self.client.post(self.endpoint.clone()).json(&body);
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("rerank transport: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            // Body deliberately not echoed: provider errors can quote the
            // request; status code is enough for health classification.
            return Err(CoreError::Message(format!(
                "rerank endpoint returned HTTP {status}"
            )));
        }
        let parsed: RerankResponse = response
            .json()
            .await
            .map_err(|e| CoreError::Message(format!("rerank response contract: {e}")))?;
        let mut scores = vec![f32::NEG_INFINITY; documents.len()];
        for row in parsed.results {
            if row.index >= scores.len() {
                return Err(CoreError::Message(format!(
                    "rerank response contract: index {} out of range for {} documents",
                    row.index,
                    documents.len()
                )));
            }
            scores[row.index] = row.relevance_score;
        }
        if scores.iter().any(|score| !score.is_finite()) {
            return Err(CoreError::Message(
                "rerank response contract: missing or non-finite score for at least one document"
                    .into(),
            ));
        }
        Ok(scores)
    }

    fn identity(&self) -> String {
        self.model.clone()
    }
}

// ---------------------------------------------------------------------------
// Deterministic hermetic adapter (contract tests only — NEVER a capability)
// ---------------------------------------------------------------------------

/// Deterministic offline reranker for contract and plumbing tests: scores are
/// the Jaccard overlap of lowercase alphanumeric token sets plus a tiny
/// stable hash tiebreak. Its identity states that it is synthetic so no
/// report can pass it off as a shipped reranking capability.
#[derive(Debug, Default, Clone)]
pub struct ScriptedRerankBackend;

fn token_set(text: &str) -> std::collections::BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(str::to_string)
        .collect()
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811C_9DC5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[async_trait]
impl RerankBackend for ScriptedRerankBackend {
    async fn rerank(&self, query: &str, documents: &[String]) -> CoreResult<Vec<f32>> {
        if documents.len() > RERANK_MAX_DOCUMENTS {
            return Err(CoreError::Config(format!(
                "rerank request exceeds the {RERANK_MAX_DOCUMENTS}-document batch bound"
            )));
        }
        let query_tokens = token_set(query);
        Ok(documents
            .iter()
            .map(|document| {
                let doc_tokens = token_set(&cap_rerank_document(document));
                let intersection = query_tokens.intersection(&doc_tokens).count() as f32;
                let union = query_tokens.union(&doc_tokens).count().max(1) as f32;
                let jitter = (fnv1a32(document.as_bytes()) % 1_000) as f32 / 1_000_000.0;
                intersection / union + jitter
            })
            .collect())
    }

    fn identity(&self) -> String {
        "scripted-rerank (deterministic synthetic; contract tests only, not a capability)".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scripted_rerank_is_deterministic_and_bounded() {
        let backend = ScriptedRerankBackend;
        let docs: Vec<String> = vec![
            "checkout timeout threshold lowered".into(),
            "GET /assets status=200".into(),
        ];
        let a = backend.rerank("checkout timeout", &docs).await.unwrap();
        let b = backend.rerank("checkout timeout", &docs).await.unwrap();
        assert_eq!(a, b, "scripted scores must be deterministic");
        assert!(a[0] > a[1], "overlapping document must outrank noise");
        assert!(backend.identity().contains("synthetic"));

        let too_many: Vec<String> = (0..=RERANK_MAX_DOCUMENTS)
            .map(|i| format!("d{i}"))
            .collect();
        assert!(backend.rerank("q", &too_many).await.is_err());
    }

    #[test]
    fn document_cap_is_char_safe() {
        let long = "é".repeat(RERANK_DOC_CHAR_CAP + 50);
        let capped = cap_rerank_document(&long);
        assert_eq!(capped.chars().count(), RERANK_DOC_CHAR_CAP);
    }

    #[test]
    fn rerank_blocking_times_out_to_none() {
        struct Stalling;
        #[async_trait]
        impl RerankBackend for Stalling {
            async fn rerank(&self, _q: &str, _d: &[String]) -> CoreResult<Vec<f32>> {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                Ok(Vec::new())
            }
            fn identity(&self) -> String {
                "stalling-test".into()
            }
        }
        let docs = vec!["a".to_string()];
        let scores = rerank_blocking(&Stalling, "q", &docs, 50);
        assert!(scores.is_none(), "timeout must degrade to None, never hang");
    }

    #[tokio::test]
    async fn http_rerank_contract_round_trip_and_errors() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/rerank"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "results": [
                        {"index": 1, "relevance_score": 0.9},
                        {"index": 0, "relevance_score": 0.2}
                    ]
                })),
            )
            .mount(&server)
            .await;
        let backend =
            HttpRerankBackend::new(&server.uri(), "qwen3-reranker-0.6b", None).expect("backend");
        let docs = vec!["first".to_string(), "second".to_string()];
        let scores = backend.rerank("query", &docs).await.expect("scores");
        assert_eq!(scores, vec![0.2, 0.9], "scores return in document order");
        assert_eq!(backend.identity(), "qwen3-reranker-0.6b");
        let debug = format!("{backend:?}");
        assert!(!debug.contains("secret"), "debug never carries credentials");

        // Preserve API prefixes both with and without a trailing slash.
        let prefixed = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/rerank"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "results": [
                        {"index": 0, "relevance_score": 0.7},
                        {"index": 1, "relevance_score": 0.3}
                    ]
                })),
            )
            .mount(&prefixed)
            .await;
        for base in [
            format!("{}/v1", prefixed.uri()),
            format!("{}/v1/", prefixed.uri()),
        ] {
            let backend = HttpRerankBackend::new(&base, "m", None).expect("prefixed backend");
            assert_eq!(backend.rerank("q", &docs).await.unwrap(), vec![0.7, 0.3]);
        }

        // Missing scores fail closed rather than inventing zeros.
        let sparse = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/rerank"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"results": [{"index": 0, "relevance_score": 0.5}]}),
            ))
            .mount(&sparse)
            .await;
        let backend = HttpRerankBackend::new(&sparse.uri(), "m", None).expect("backend");
        assert!(backend.rerank("q", &docs).await.is_err());

        // Provider failure surfaces as a transport-class error (status only).
        let failing = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/rerank"))
            .respond_with(wiremock::ResponseTemplate::new(429))
            .mount(&failing)
            .await;
        let backend = HttpRerankBackend::new(&failing.uri(), "m", None).expect("backend");
        let error = backend.rerank("q", &docs).await.unwrap_err();
        assert!(format!("{error}").contains("429"));
    }
}
