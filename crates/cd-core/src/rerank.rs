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
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};

/// Character cap applied to each document sent to a reranker. Bounds request
/// size and memory; rerank quality on log lines does not need full payloads.
pub const RERANK_DOC_CHAR_CAP: usize = 512;

/// Hard cap on documents per rerank request (batch bound).
pub const RERANK_MAX_DOCUMENTS: usize = 100;

/// Default wall-clock budget for one rerank call.
pub const RERANK_DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// Explicit rerank **response dialect**. Must be configured (or defaulted via
/// this enum's `Default`) — never inferred from a URL host alone.
///
/// Both TEI/Cohere and common Qwen-reranker gateways speak the indexed
/// `{results:[{index, relevance_score}]}` envelope; the dialect names the
/// registered contract used by production **and** qualification so they
/// cannot drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RerankDialect {
    /// Text-Embeddings-Inference / Cohere / Jina / Infinity / many Qwen
    /// gateways: `POST …/rerank` → `results[{index, relevance_score}]`.
    /// Higher score = more relevant. Scores realign to request document order.
    #[default]
    TeiCohere,
}

impl RerankDialect {
    /// Stable snake_case label for reports/config.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TeiCohere => "tei_cohere",
        }
    }

    /// Parse an explicit dialect name. Rejects unknown and empty values —
    /// never falls back based on a URL.
    pub fn parse_explicit(name: &str) -> CoreResult<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "tei_cohere" | "tei-cohere" | "cohere" | "qwen_reranker" | "qwen-reranker" => {
                Ok(Self::TeiCohere)
            }
            other => Err(CoreError::Config(format!(
                "unknown rerank dialect `{other}`; registered dialects: tei_cohere"
            ))),
        }
    }
}

/// Resolve the dialect from an **explicit** configuration value only.
/// `None` → default registered dialect. Never inspects a URL.
pub fn resolve_rerank_dialect(configured: Option<RerankDialect>) -> RerankDialect {
    configured.unwrap_or_default()
}

/// Parse a TEI/Cohere (and Qwen-compatible) rerank JSON body into **input
/// order** scores. Rejects duplicate, missing, out-of-range, non-finite, or
/// ambiguous rows. Does not invent zeros for gaps.
pub fn parse_tei_cohere_rerank_scores(
    body: &serde_json::Value,
    document_count: usize,
) -> CoreResult<Vec<f32>> {
    if document_count == 0 {
        return Ok(Vec::new());
    }
    let rows = body
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| {
            CoreError::Message("rerank response contract: missing results array".into())
        })?;
    let mut scores = vec![f32::NAN; document_count];
    let mut seen = vec![false; document_count];
    for row in rows {
        let index = row.get("index").and_then(|v| v.as_u64()).ok_or_else(|| {
            CoreError::Message("rerank response contract: missing or non-integer index".into())
        })? as usize;
        if index >= document_count {
            return Err(CoreError::Message(format!(
                "rerank response contract: index {index} out of range for {document_count} documents"
            )));
        }
        if seen[index] {
            return Err(CoreError::Message(format!(
                "rerank response contract: duplicate index {index}"
            )));
        }
        let score_v = row
            .get("relevance_score")
            .or_else(|| row.get("relevanceScore"))
            .and_then(|v| v.as_f64())
            .ok_or_else(|| {
                CoreError::Message(
                    "rerank response contract: missing or non-numeric relevance_score".into(),
                )
            })?;
        if !score_v.is_finite() {
            return Err(CoreError::Message(
                "rerank response contract: non-finite relevance_score".into(),
            ));
        }
        seen[index] = true;
        scores[index] = score_v as f32;
    }
    if seen.iter().any(|s| !*s) {
        return Err(CoreError::Message(
            "rerank response contract: missing score for one or more documents".into(),
        ));
    }
    validate_rerank_scores(&scores, document_count)?;
    Ok(scores)
}

/// Parse ranking **indices** (order by descending relevance) from a TEI body.
/// Shared with qualification transports that return ranked ids rather than
/// per-document score vectors. Same rejection rules as
/// [`parse_tei_cohere_rerank_scores`].
pub fn parse_tei_cohere_ranking_indices(
    body: &serde_json::Value,
    document_count: usize,
) -> CoreResult<Vec<usize>> {
    let scores = parse_tei_cohere_rerank_scores(body, document_count)?;
    let mut indexed: Vec<(usize, f32)> = scores.into_iter().enumerate().collect();
    // Higher score first; ties keep lower original index (stable, deterministic).
    indexed.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    Ok(indexed.into_iter().map(|(i, _)| i).collect())
}

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

/// HTTP reranker speaking an **explicit** registered dialect (default
/// [`RerankDialect::TeiCohere`]). Dialect is never chosen from the URL host.
///
/// TEI/Cohere (and many Qwen-reranker gateways):
/// ```json
/// POST {base_url}/rerank
/// {"model": "...", "query": "...", "documents": ["...", "..."], "top_n": N}
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
    dialect: RerankDialect,
}

impl std::fmt::Debug for HttpRerankBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately omits the bearer credential.
        f.debug_struct("HttpRerankBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("dialect", &self.dialect.as_str())
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl HttpRerankBackend {
    /// Build with the default registered dialect ([`RerankDialect::TeiCohere`]).
    /// Prefer [`Self::with_dialect`] when configuration names a dialect.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        Self::with_dialect(base_url, model, bearer, RerankDialect::default())
    }

    /// Build against `base_url` with an **explicit** [`RerankDialect`].
    /// The dialect is never derived from the URL string.
    pub fn with_dialect(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
        dialect: RerankDialect,
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
            dialect,
        })
    }

    /// Registered dialect this backend parses responses with.
    pub fn dialect(&self) -> RerankDialect {
        self.dialect
    }
}

#[derive(serde::Serialize)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
    top_n: usize,
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
            top_n: capped.len(),
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
        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| CoreError::Message(format!("rerank response contract: {e}")))?;
        match self.dialect {
            RerankDialect::TeiCohere => parse_tei_cohere_rerank_scores(&parsed, documents.len()),
        }
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

    #[test]
    fn dialect_parse_is_explicit_never_url_shaped() {
        assert_eq!(
            RerankDialect::parse_explicit("tei_cohere").unwrap(),
            RerankDialect::TeiCohere
        );
        assert_eq!(
            RerankDialect::parse_explicit("qwen-reranker").unwrap(),
            RerankDialect::TeiCohere
        );
        assert!(RerankDialect::parse_explicit("https://host/rerank").is_err());
        assert!(RerankDialect::parse_explicit("").is_err());
        assert_eq!(
            resolve_rerank_dialect(None),
            RerankDialect::TeiCohere,
            "None configures the default registered dialect — not a URL probe"
        );
    }

    #[test]
    fn tei_cohere_parser_rejects_malformed_and_realigns_scores() {
        let ok = serde_json::json!({
            "results": [
                {"index": 1, "relevance_score": 0.9},
                {"index": 0, "relevance_score": 0.2},
            ]
        });
        assert_eq!(
            parse_tei_cohere_rerank_scores(&ok, 2).unwrap(),
            vec![0.2, 0.9]
        );
        // Qwen-style camelCase score field
        let qwen = serde_json::json!({
            "results": [
                {"index": 0, "relevanceScore": 0.1},
                {"index": 1, "relevanceScore": 0.8},
            ]
        });
        assert_eq!(
            parse_tei_cohere_rerank_scores(&qwen, 2).unwrap(),
            vec![0.1, 0.8]
        );
        assert!(parse_tei_cohere_rerank_scores(
            &serde_json::json!({"results":[{"index":0,"relevance_score":0.5}]}),
            2
        )
        .is_err());
        assert!(parse_tei_cohere_rerank_scores(
            &serde_json::json!({"results":[
                {"index":0,"relevance_score":0.5},
                {"index":0,"relevance_score":0.6},
            ]}),
            2
        )
        .is_err());
        assert!(parse_tei_cohere_rerank_scores(
            &serde_json::json!({"results":[
                {"index":0,"relevance_score":0.5},
                {"index":99,"relevance_score":0.6},
            ]}),
            2
        )
        .is_err());
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
