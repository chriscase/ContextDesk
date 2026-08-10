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

/// Validate the provider-neutral score contract at the consumer boundary.
///
/// Individual adapters should validate their own wire formats, but callers
/// must not assume every future or injected [`RerankBackend`] does so. A
/// partial, oversized, or non-finite score vector cannot be aligned honestly
/// with the submitted documents and must be withheld in full.
pub fn validate_rerank_scores(scores: &[f32], expected: usize) -> CoreResult<()> {
    if scores.len() != expected {
        return Err(CoreError::Message(format!(
            "rerank response contract: expected {expected} scores, received {}",
            scores.len()
        )));
    }
    if scores.iter().any(|score| !score.is_finite()) {
        return Err(CoreError::Message(
            "rerank response contract: every score must be finite".into(),
        ));
    }
    Ok(())
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
    extra_headers: Vec<(String, String)>,
}

/// Vercel AI Gateway v4 reranking adapter.
///
/// This is deliberately separate from [`HttpRerankBackend`]. Vercel uses a
/// nested document envelope, camel-case `topN`, selection headers, and a
/// ranked-row response. The adapter converts that complete permutation into
/// the provider-neutral score vector expected by [`RerankBackend`].
pub struct VercelV4RerankBackend {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    bearer: Option<String>,
    extra_headers: Vec<(String, String)>,
}

impl std::fmt::Debug for VercelV4RerankBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VercelV4RerankBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl VercelV4RerankBackend {
    /// Build against the configured Vercel base URL using the v4 reranking
    /// envelope and the default bounded timeout.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        Self::new_with_policy(base_url, model, bearer, &crate::ssrf::SsrfPolicy::default())
    }

    /// Build with an explicit SSRF policy while retaining the Vercel v4
    /// envelope and timeout.
    pub fn new_with_policy(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
        policy: &crate::ssrf::SsrfPolicy,
    ) -> CoreResult<Self> {
        let resolver = crate::ssrf::SystemResolver;
        let (mut endpoint, client) = crate::ssrf::build_pinned_client_for_url(
            base_url,
            policy,
            &resolver,
            std::time::Duration::from_millis(RERANK_DEFAULT_TIMEOUT_MS),
        )?;
        endpoint.set_path("/v4/ai/reranking-model");
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        Ok(Self {
            client,
            endpoint,
            model: model.into(),
            bearer,
            extra_headers: Vec::new(),
        })
    }

    /// Add provider-specific headers; an explicit Authorization header wins
    /// over the bearer argument.
    pub fn with_extra_headers(mut self, headers: Vec<(String, String)>) -> Self {
        if headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        {
            self.bearer = None;
        }
        self.extra_headers = headers;
        self
    }

    fn apply_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request = request
            .header("ai-gateway-protocol-version", "0.0.1")
            .header("ai-gateway-auth-method", "api-key")
            .header("ai-reranking-model-specification-version", "4")
            .header("ai-model-id", &self.model);
        for (name, value) in &self.extra_headers {
            request = request.header(name, value);
        }
        if let Some(token) = &self.bearer {
            request = request.bearer_auth(token);
        }
        request
    }
}

#[derive(serde::Serialize)]
struct VercelV4RerankRequest<'a> {
    documents: VercelV4Documents<'a>,
    query: &'a str,
    #[serde(rename = "topN")]
    top_n: usize,
}

#[derive(serde::Serialize)]
struct VercelV4Documents<'a> {
    #[serde(rename = "type")]
    document_type: &'static str,
    values: &'a [String],
}

#[derive(serde::Deserialize)]
struct VercelV4RerankResponse {
    ranking: Vec<VercelV4RankingRow>,
}

#[derive(serde::Deserialize)]
struct VercelV4RankingRow {
    index: usize,
    #[serde(alias = "relevanceScore")]
    relevance_score: f32,
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
        Self::new_with_policy(base_url, model, bearer, &crate::ssrf::SsrfPolicy::default())
    }

    /// Build the adapter using a caller-supplied SSRF policy. Qualification
    /// and product hosts use this to share the same parser and request
    /// contract while retaining their own egress policy.
    pub fn new_with_policy(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
        policy: &crate::ssrf::SsrfPolicy,
    ) -> CoreResult<Self> {
        let resolver = crate::ssrf::SystemResolver;
        let (url, client) = crate::ssrf::build_pinned_client_for_url(
            base_url,
            policy,
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
            extra_headers: Vec::new(),
        })
    }

    /// Add provider-specific headers without exposing them through identity
    /// or serialization. An explicit Authorization header takes precedence
    /// over the bearer argument.
    pub fn with_extra_headers(mut self, headers: Vec<(String, String)>) -> Self {
        if headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        {
            self.bearer = None;
        }
        self.extra_headers = headers;
        self
    }
}

#[derive(serde::Serialize)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
    top_n: usize,
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
            top_n: documents.len(),
        };
        let mut request = self.client.post(self.endpoint.clone()).json(&body);
        for (name, value) in &self.extra_headers {
            request = request.header(name, value);
        }
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
        let mut seen = vec![false; documents.len()];
        for row in parsed.results {
            if row.index >= scores.len() {
                return Err(CoreError::Message(format!(
                    "rerank response contract: index {} out of range for {} documents",
                    row.index,
                    documents.len()
                )));
            }
            if seen[row.index] {
                return Err(CoreError::Message(format!(
                    "rerank response contract: duplicate index {}",
                    row.index
                )));
            }
            seen[row.index] = true;
            scores[row.index] = row.relevance_score;
        }
        validate_rerank_scores(&scores, documents.len())?;
        Ok(scores)
    }

    fn identity(&self) -> String {
        self.model.clone()
    }
}

#[async_trait]
impl RerankBackend for VercelV4RerankBackend {
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
        let body = VercelV4RerankRequest {
            documents: VercelV4Documents {
                document_type: "text",
                values: &capped,
            },
            query,
            top_n: documents.len(),
        };
        let response = self
            .apply_headers(self.client.post(self.endpoint.clone()).json(&body))
            .send()
            .await
            .map_err(|error| CoreError::Message(format!("rerank transport: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "rerank endpoint returned HTTP {status}"
            )));
        }
        let parsed = response
            .json::<VercelV4RerankResponse>()
            .await
            .map_err(|error| CoreError::Message(format!("rerank response contract: {error}")))?;
        if parsed.ranking.len() != documents.len() {
            return Err(CoreError::Message(format!(
                "rerank response contract: expected {} ranking rows, received {}",
                documents.len(),
                parsed.ranking.len()
            )));
        }
        let mut scores = vec![f32::NEG_INFINITY; documents.len()];
        let mut seen = vec![false; documents.len()];
        for row in parsed.ranking {
            if row.index >= documents.len() {
                return Err(CoreError::Message(format!(
                    "rerank response contract: index {} out of range for {} documents",
                    row.index,
                    documents.len()
                )));
            }
            if seen[row.index] {
                return Err(CoreError::Message(format!(
                    "rerank response contract: duplicate index {}",
                    row.index
                )));
            }
            seen[row.index] = true;
            scores[row.index] = row.relevance_score;
        }
        validate_rerank_scores(&scores, documents.len())?;
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
    fn score_contract_rejects_cardinality_and_non_finite_values() {
        assert!(validate_rerank_scores(&[0.2, 0.8], 2).is_ok());
        assert!(validate_rerank_scores(&[0.2], 2).is_err());
        assert!(validate_rerank_scores(&[0.2, 0.8, 0.1], 2).is_err());
        assert!(validate_rerank_scores(&[f32::NAN, 0.8], 2).is_err());
        assert!(validate_rerank_scores(&[f32::INFINITY, 0.8], 2).is_err());
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
    async fn vercel_v4_rerank_uses_specialty_envelope_and_restores_scores() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v4/ai/reranking-model"))
            .and(wiremock::matchers::header(
                "ai-reranking-model-specification-version",
                "4",
            ))
            .and(wiremock::matchers::header(
                "ai-model-id",
                "voyage/rerank-2.5",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "documents": {"type": "text", "values": ["first", "second"]},
                "query": "query",
                "topN": 2,
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ranking": [
                        {"index": 1, "relevanceScore": 0.9},
                        {"index": 0, "relevanceScore": 0.2}
                    ]
                })),
            )
            .mount(&server)
            .await;
        let backend = VercelV4RerankBackend::new(
            &server.uri(),
            "voyage/rerank-2.5",
            Some("secret-token".into()),
        )
        .unwrap();
        let docs = vec!["first".to_string(), "second".to_string()];
        let scores = backend.rerank("query", &docs).await.unwrap();
        assert_eq!(scores, vec![0.2, 0.9]);
        assert!(!format!("{backend:?}").contains("secret-token"));
    }

    #[tokio::test]
    async fn vercel_v4_rerank_rejects_incomplete_or_duplicate_permutations() {
        for ranking in [
            serde_json::json!([{"index": 0, "relevance_score": 0.2}]),
            serde_json::json!([
                {"index": 0, "relevance_score": 0.2},
                {"index": 0, "relevance_score": 0.9}
            ]),
        ] {
            let server = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("POST"))
                .and(wiremock::matchers::path("/v4/ai/reranking-model"))
                .respond_with(
                    wiremock::ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"ranking": ranking})),
                )
                .mount(&server)
                .await;
            let backend = VercelV4RerankBackend::new(&server.uri(), "m", None).unwrap();
            let error = backend
                .rerank("q", &["a".into(), "b".into()])
                .await
                .expect_err("incomplete permutation must fail closed");
            assert!(error.to_string().contains("rerank response contract"));
        }
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

        // Duplicate rows fail even when every document index also appears;
        // silently overwriting a score would accept an ambiguous response.
        let duplicate = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/rerank"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "results": [
                        {"index": 0, "relevance_score": 0.5},
                        {"index": 1, "relevance_score": 0.6},
                        {"index": 1, "relevance_score": 0.7}
                    ]
                })),
            )
            .mount(&duplicate)
            .await;
        let backend = HttpRerankBackend::new(&duplicate.uri(), "m", None).expect("backend");
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
