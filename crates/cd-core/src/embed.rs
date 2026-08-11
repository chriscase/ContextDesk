//! Optional embeddings + hybrid retrieval scoring (#119).
//!
//! Default retrieval stays keyword-only. Semantic ranking is opt-in via an
//! [`EmbedBackend`] and never runs on the default `cargo test` network path.
//!
//! # Hybrid weights
//! Final score (documented):
//! `score = w_kw * keyword_norm + w_sem * cosine + w_rec * recency`
//! where keyword_norm is keyword score / max keyword score on the candidate set
//! (or 0 if empty), cosine is in `[0,1]` after clamping negatives to 0, and
//! recency is a 0..1 boost from file mtime (newer → higher). Defaults:
//! `w_kw=0.55`, `w_sem=0.35`, `w_rec=0.10`. When no embed backend is present,
//! semantic is 0 and weights are renormalized onto keyword+recency only.

use crate::embedding_space::{EmbeddingSpaceIdentity, LOCAL_ENDPOINT_FINGERPRINT};
use crate::error::{CoreError, CoreResult};
use crate::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum number of inputs in one OpenAI-compatible embedding request.
pub const HTTP_EMBED_MAX_BATCH: usize = 64;
/// Maximum characters in one input sent to a remote embedding endpoint.
pub const HTTP_EMBED_INPUT_CHAR_CAP: usize = 16_384;
/// Bounded timeout for one remote embedding request.
pub const HTTP_EMBED_TIMEOUT_MS: u64 = 60_000;

/// Async embedding provider (mirrors the chat backend pattern).
#[async_trait]
pub trait EmbedBackend: Send + Sync {
    /// Embed each input string; output vectors must all share the same length.
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>>;

    /// Stable backend-known model identity for vector-space binding and
    /// telemetry (mirrors [`crate::rerank::RerankBackend::identity`]).
    ///
    /// This is the identity the backend was configured/built with — not a
    /// provider-confirmed measurement; wires that echo a served model may
    /// verify it, wires that don't cannot upgrade it. Synthetic backends MUST
    /// say so in the identity so a scripted run can never be mistaken for a
    /// capability. Stored template vectors are only comparable to query
    /// vectors produced under the same identity and dimension count.
    fn identity(&self) -> String;

    /// Typed embedding-space identity for fail-closed vector binding.
    ///
    /// This is the full set of inputs that shaped the vector space — endpoint
    /// fingerprint, exact model, wire dialect, representation, instruction,
    /// preprocessing, and chunking version — not just a model label. Measured
    /// `dimensions` are filled in by whoever observed real vectors; a backend
    /// never claims them from configuration.
    ///
    /// The default marks the space `unclassified` so an adapter that forgets
    /// to override this can never be mistaken for a known dialect; every
    /// adapter in this crate overrides it.
    fn space(&self) -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new(LOCAL_ENDPOINT_FINGERPRINT, self.identity(), "unclassified")
    }
}

/// Production OpenAI-compatible embedding adapter.
///
/// This is deliberately a narrow wire contract: `POST /v1/embeddings` with
/// an array-valued `input`, followed by indexed, finite, homogeneous vectors.
/// It is shared by qualification and retrieval callers; model names never
/// select a parser, and malformed responses are withheld in full.
pub struct HttpEmbedBackend {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    bearer: Option<String>,
    extra_headers: Vec<(String, String)>,
}

/// Vercel AI Gateway v4 embedding adapter.
///
/// Vercel's specialty route is intentionally a separate dialect from
/// OpenAI-compatible `/v1/embeddings`: it uses the `values` envelope and
/// model-selection headers.  The caller must select this adapter explicitly;
/// model names never activate it implicitly.
pub struct VercelV4EmbedBackend {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    bearer: Option<String>,
    extra_headers: Vec<(String, String)>,
}

impl std::fmt::Debug for VercelV4EmbedBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VercelV4EmbedBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl VercelV4EmbedBackend {
    /// Build against the configured Vercel base URL.  The URL is still
    /// SSRF-vetted and pinned; the exact v4 route is selected explicitly.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        Self::new_with_policy(base_url, model, bearer, &SsrfPolicy::default())
    }

    /// Build with an explicit SSRF policy while retaining the Vercel v4
    /// envelope and timeout.
    pub fn new_with_policy(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
        policy: &SsrfPolicy,
    ) -> CoreResult<Self> {
        let (mut endpoint, client) = build_pinned_client_for_url(
            base_url,
            policy,
            &SystemResolver,
            std::time::Duration::from_millis(HTTP_EMBED_TIMEOUT_MS),
        )?;
        endpoint.set_path(VERCEL_V4_EMBEDDING_PATH);
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
            .header("ai-embedding-model-specification-version", "4")
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

#[derive(Debug, Deserialize)]
struct VercelV4EmbeddingResponse {
    embeddings: Vec<Vec<f64>>,
}

impl std::fmt::Debug for HttpEmbedBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpEmbedBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Rewrite `endpoint` to the concrete OpenAI-compatible embeddings route.
///
/// Kept as one function so the adapter and the config-only fingerprint path
/// cannot drift apart; see [`embedding_endpoint_for_dialect`].
fn apply_openai_embedding_path(endpoint: &mut reqwest::Url) {
    let base_path = endpoint.path().trim_end_matches('/');
    let embedding_path = if base_path.is_empty() {
        "/v1/embeddings".to_string()
    } else if base_path.ends_with("/v1") || base_path.contains("/v1/") {
        format!("{base_path}/embeddings")
    } else {
        format!("{base_path}/v1/embeddings")
    };
    endpoint.set_path(&embedding_path);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
}

/// The concrete endpoint a dialect will POST to, derived from a configured
/// base URL without resolving DNS, opening a client, or reading a credential.
///
/// Every embedding adapter normalizes its base URL before it fingerprints its
/// own space, so a fingerprint taken from the bare configured base URL can
/// never equal the one the adapter records — a plan would promise one
/// embedding space and the corpus would store another, with nothing in either
/// artifact revealing the disagreement. Both paths route through this function
/// so a plan, a lane, a probe, and a stored binding all name the same endpoint.
///
/// Returns `None` for a dialect this build cannot serve, so an unknown dialect
/// yields no fingerprint rather than a confidently wrong one.
pub fn embedding_endpoint_for_dialect(base_url: &str, dialect: &str) -> Option<String> {
    let mut endpoint = reqwest::Url::parse(base_url.trim()).ok()?;
    match dialect {
        // `OllamaClient` keeps the parsed base URL with its trailing slash
        // trimmed and appends routes per call, so the space it fingerprints is
        // the base itself.
        "ollama_embeddings" => Some(endpoint.as_str().trim_end_matches('/').to_string()),
        "openai_embeddings" => {
            apply_openai_embedding_path(&mut endpoint);
            Some(endpoint.to_string())
        }
        "vercel_v4_embeddings" => {
            endpoint.set_path(VERCEL_V4_EMBEDDING_PATH);
            endpoint.set_query(None);
            endpoint.set_fragment(None);
            Some(endpoint.to_string())
        }
        _ => None,
    }
}

/// Route the Vercel v4 embedding adapter posts to.
const VERCEL_V4_EMBEDDING_PATH: &str = "/v4/ai/embedding-model";

impl HttpEmbedBackend {
    /// Build the adapter against a base URL with an optional bearer token.
    /// The URL is SSRF-vetted and pinned using the same policy as chat and
    /// reranking clients.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        Self::new_with_policy(base_url, model, bearer, &SsrfPolicy::default())
    }

    /// Build the adapter using a caller-supplied SSRF policy. Qualification
    /// and product hosts use this to share the exact wire adapter while
    /// retaining their own egress policy.
    pub fn new_with_policy(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
        policy: &SsrfPolicy,
    ) -> CoreResult<Self> {
        let (mut endpoint, client) = build_pinned_client_for_url(
            base_url,
            policy,
            &SystemResolver,
            std::time::Duration::from_millis(HTTP_EMBED_TIMEOUT_MS),
        )?;
        apply_openai_embedding_path(&mut endpoint);
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

    fn apply_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        for (name, value) in &self.extra_headers {
            request = request.header(name, value);
        }
        if let Some(token) = &self.bearer {
            request = request.bearer_auth(token);
        }
        request
    }
}

#[derive(Debug, Deserialize)]
struct HttpEmbeddingResponse {
    data: Vec<HttpEmbeddingRow>,
}

#[derive(Debug, Deserialize)]
struct HttpEmbeddingRow {
    index: usize,
    embedding: Vec<f64>,
}

fn validate_http_embedding_rows(
    rows: Vec<HttpEmbeddingRow>,
    expected: usize,
) -> CoreResult<Vec<Vec<f32>>> {
    if rows.len() != expected {
        return Err(CoreError::Message(format!(
            "embedding response contract: expected {expected} vectors, received {}",
            rows.len()
        )));
    }
    let mut ordered: Vec<Option<Vec<f64>>> = vec![None; expected];
    let mut dimensions = None;
    for row in rows {
        if row.index >= expected {
            return Err(CoreError::Message(format!(
                "embedding response contract: index {} out of range for {expected} inputs",
                row.index
            )));
        }
        if ordered[row.index].is_some() {
            return Err(CoreError::Message(format!(
                "embedding response contract: duplicate index {}",
                row.index
            )));
        }
        if row.embedding.is_empty() {
            return Err(CoreError::Message(
                "embedding response contract: empty vector".into(),
            ));
        }
        if let Some(expected_dimensions) = dimensions {
            if expected_dimensions != row.embedding.len() {
                return Err(CoreError::Message(
                    "embedding response contract: heterogeneous dimensions".into(),
                ));
            }
        } else {
            dimensions = Some(row.embedding.len());
        }
        ordered[row.index] = Some(row.embedding);
    }
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            let vector = vector.ok_or_else(|| {
                CoreError::Message(format!(
                    "embedding response contract: missing index {index}"
                ))
            })?;
            let vector: Vec<f32> = vector.into_iter().map(|value| value as f32).collect();
            if vector.iter().any(|value| !value.is_finite()) {
                return Err(CoreError::Message(
                    "embedding response contract: every component must be finite".into(),
                ));
            }
            Ok(vector)
        })
        .collect()
}

#[async_trait]
impl EmbedBackend for HttpEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > HTTP_EMBED_MAX_BATCH {
            return Err(CoreError::Config(format!(
                "embedding request exceeds the {HTTP_EMBED_MAX_BATCH}-input batch bound"
            )));
        }
        if texts
            .iter()
            .any(|text| text.chars().count() > HTTP_EMBED_INPUT_CHAR_CAP)
        {
            return Err(CoreError::Config(format!(
                "embedding input exceeds the {HTTP_EMBED_INPUT_CHAR_CAP}-character bound"
            )));
        }
        let response = self
            .apply_headers(self.client.post(self.endpoint.clone()).json(&json!({
                "model": self.model,
                "input": texts,
            })))
            .send()
            .await
            .map_err(|error| CoreError::Message(format!("embedding transport: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "embedding endpoint returned HTTP {status}"
            )));
        }
        let body = response
            .json::<HttpEmbeddingResponse>()
            .await
            .map_err(|error| CoreError::Message(format!("embedding response contract: {error}")))?;
        validate_http_embedding_rows(body.data, texts.len())
    }

    fn identity(&self) -> String {
        self.model.clone()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new(
            crate::capability_qualification::fingerprint_endpoint(self.endpoint.as_str()),
            self.model.clone(),
            "openai_embeddings",
        )
    }
}

#[async_trait]
impl EmbedBackend for VercelV4EmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > HTTP_EMBED_MAX_BATCH {
            return Err(CoreError::Config(format!(
                "embedding request exceeds the {HTTP_EMBED_MAX_BATCH}-input batch bound"
            )));
        }
        if texts
            .iter()
            .any(|text| text.chars().count() > HTTP_EMBED_INPUT_CHAR_CAP)
        {
            return Err(CoreError::Config(format!(
                "embedding input exceeds the {HTTP_EMBED_INPUT_CHAR_CAP}-character bound"
            )));
        }
        let response = self
            .apply_headers(self.client.post(self.endpoint.clone()).json(&json!({
                "values": texts,
            })))
            .send()
            .await
            .map_err(|error| CoreError::Message(format!("embedding transport: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "embedding endpoint returned HTTP {status}"
            )));
        }
        let body = response
            .json::<VercelV4EmbeddingResponse>()
            .await
            .map_err(|error| CoreError::Message(format!("embedding response contract: {error}")))?;
        if body.embeddings.len() != texts.len() {
            return Err(CoreError::Message(format!(
                "embedding response contract: expected {} vectors, received {}",
                texts.len(),
                body.embeddings.len()
            )));
        }
        let mut dimensions = None;
        body.embeddings
            .into_iter()
            .map(|values| {
                if values.is_empty() {
                    return Err(CoreError::Message(
                        "embedding response contract: empty vector".into(),
                    ));
                }
                if let Some(expected) = dimensions {
                    if expected != values.len() {
                        return Err(CoreError::Message(
                            "embedding response contract: heterogeneous dimensions".into(),
                        ));
                    }
                } else {
                    dimensions = Some(values.len());
                }
                let vector: Vec<f32> = values.into_iter().map(|value| value as f32).collect();
                if vector.iter().any(|value| !value.is_finite()) {
                    return Err(CoreError::Message(
                        "embedding response contract: every component must be finite".into(),
                    ));
                }
                Ok(vector)
            })
            .collect()
    }

    fn identity(&self) -> String {
        self.model.clone()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new(
            crate::capability_qualification::fingerprint_endpoint(self.endpoint.as_str()),
            self.model.clone(),
            "vercel_v4_embeddings",
        )
    }
}

/// Weights for hybrid ranking.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HybridWeights {
    /// Keyword TF/IDF component weight.
    pub keyword: f32,
    /// Semantic cosine component weight (0 when no backend).
    pub semantic: f32,
    /// Recency (mtime) component weight.
    pub recency: f32,
}

impl Default for HybridWeights {
    /// Defaults revisited with live semantic recall (#346 / #347):
    /// keep keyword slightly ahead so exact terms still win; semantic at 0.35
    /// is now a real signal (embed-on-write + 5s query budget); recency soft.
    fn default() -> Self {
        Self {
            keyword: 0.55,
            semantic: 0.35,
            recency: 0.10,
        }
    }
}

impl HybridWeights {
    /// Renormalize so weights sum to 1.0; drop semantic if unused.
    pub fn normalized(self, has_semantic: bool) -> Self {
        let mut w = self;
        if !has_semantic {
            w.semantic = 0.0;
        }
        let sum = w.keyword + w.semantic + w.recency;
        if sum <= f32::EPSILON {
            return Self {
                keyword: 1.0,
                semantic: 0.0,
                recency: 0.0,
            };
        }
        Self {
            keyword: w.keyword / sum,
            semantic: w.semantic / sum,
            recency: w.recency / sum,
        }
    }
}

/// Cosine similarity; empty or mismatched dims → 0. Negative cosines clamped to 0.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= f32::EPSILON || nb <= f32::EPSILON {
        return 0.0;
    }
    (dot / (na.sqrt() * nb.sqrt())).clamp(0.0, 1.0)
}

/// Recency boost in 0..1 from unix mtime seconds (newer → closer to 1).
///
/// Uses a soft half-life of ~90 days: `1 / (1 + age_days / 90)`.
pub fn recency_boost(mtime_secs: i64, now_secs: i64) -> f32 {
    let age = (now_secs.saturating_sub(mtime_secs)).max(0) as f32;
    let age_days = age / 86_400.0;
    1.0 / (1.0 + age_days / 90.0)
}

/// Combine normalized keyword, semantic cosine, and recency into one score.
pub fn hybrid_score(
    keyword_raw: f32,
    keyword_max: f32,
    semantic_cos: f32,
    recency: f32,
    weights: HybridWeights,
) -> f32 {
    let w = weights.normalized(semantic_cos > 0.0 || weights.semantic > 0.0);
    let kw = if keyword_max > f32::EPSILON {
        (keyword_raw / keyword_max).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let sem = semantic_cos.clamp(0.0, 1.0);
    let rec = recency.clamp(0.0, 1.0);
    w.keyword * kw + w.semantic * sem + w.recency * rec
}

/// Local Ollama embeddings backend (network; opt-in only).
pub struct OllamaEmbedBackend {
    client: crate::chat::OllamaClient,
}

impl OllamaEmbedBackend {
    /// Wrap an existing Ollama client (model should support embeddings, e.g. nomic-embed-text).
    pub fn new(client: crate::chat::OllamaClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl EmbedBackend for OllamaEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for t in texts {
            out.push(self.client.embed(t).await?);
        }
        Ok(out)
    }

    fn identity(&self) -> String {
        // Configured model name; the Ollama embeddings wire does not echo a
        // served-model identity to verify against.
        self.client.model().to_string()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::new(
            crate::capability_qualification::fingerprint_endpoint(&self.client.base_url),
            self.client.model().to_string(),
            "ollama_embeddings",
        )
    }
}

/// Deterministic offline mock: fixed-dimension pseudo-vectors from text hash.
///
/// Similar token bags produce more similar vectors (bag-of-char buckets), so
/// hybrid tests can assert semantic ranking without network.
pub struct MockHashEmbedBackend {
    /// Vector dimension (default 32).
    pub dims: usize,
}

impl Default for MockHashEmbedBackend {
    fn default() -> Self {
        Self { dims: 32 }
    }
}

impl MockHashEmbedBackend {
    /// Create with dimension.
    pub fn new(dims: usize) -> Self {
        Self {
            dims: dims.clamp(8, 256),
        }
    }

    fn embed_one(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; self.dims];
        // Character-bucket features so "auth login password" ~ "authentication credentials"
        for ch in text.to_lowercase().chars() {
            if ch.is_alphanumeric() {
                let mut h = DefaultHasher::new();
                ch.hash(&mut h);
                let i = (h.finish() as usize) % self.dims;
                v[i] += 1.0;
            }
        }
        // Token hashes for whole words
        for tok in text.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
            if tok.is_empty() {
                continue;
            }
            let mut h = DefaultHasher::new();
            tok.hash(&mut h);
            let i = (h.finish() as usize) % self.dims;
            v[i] += 2.0;
        }
        // L2 normalize
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > f32::EPSILON {
            for x in &mut v {
                *x /= n;
            }
        }
        v
    }
}

#[async_trait]
impl EmbedBackend for MockHashEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| self.embed_one(t)).collect())
    }

    fn identity(&self) -> String {
        "mock-hash-embed (deterministic synthetic; tests only, not a capability)".into()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::synthetic(self.identity())
    }
}

/// Deterministic **async-friendly** embedder with genuine concept geometry (#346).
///
/// Unlike [`MockHashEmbedBackend`] (character/token bags that collapse without
/// shared keywords), this maps synonym groups onto shared basis directions so a
/// **paraphrase with zero keyword overlap** still scores high. The `embed` path
/// is genuinely async (`yield_now`) so it exercises the same budgeted
/// `block_on` path product Ollama uses — not a sync mock disguise.
pub struct ConceptEmbedBackend {
    /// Vector dimension (default 64; enough room for concept groups).
    pub dims: usize,
}

impl Default for ConceptEmbedBackend {
    fn default() -> Self {
        Self { dims: 64 }
    }
}

impl ConceptEmbedBackend {
    /// Create with dimension (clamped).
    pub fn new(dims: usize) -> Self {
        Self {
            dims: dims.clamp(16, 256),
        }
    }

    /// Synonym groups → shared basis index. Order matters for tests.
    fn concept_groups() -> &'static [&'static [&'static str]] {
        &[
            // 0 — relational DB choice (paraphrase test target)
            &[
                "postgres",
                "postgresql",
                "relational database",
                "sql database",
                "rdbms",
                "durable datastore",
            ],
            // 1 — auth
            &[
                "authentication",
                "login credentials",
                "sign-in",
                "authn",
                "passwordless sso",
            ],
            // 2 — billing
            &["invoice", "billing cycle", "payment refund", "chargeback"],
            // 3 — logging / ops (log-analysis reuse)
            &[
                "connection refused",
                "socket closed",
                "upstream unavailable",
                "econnrefused",
            ],
        ]
    }

    fn embed_one(&self, text: &str) -> Vec<f32> {
        let lower = text.to_lowercase();
        let mut v = vec![0.0f32; self.dims];
        let groups = Self::concept_groups();
        for (gi, phrases) in groups.iter().enumerate() {
            if gi >= self.dims {
                break;
            }
            for p in *phrases {
                if lower.contains(p) {
                    v[gi] += 1.0;
                }
            }
        }
        // Mild residual so empty concept texts are not zero-vectors (unique
        // id). Keep it outside the reserved concept basis: otherwise an
        // unrelated text whose hash lands on a concept dimension can become a
        // false semantic match.
        let mut h = DefaultHasher::new();
        lower.hash(&mut h);
        let residual_start = groups.len().min(self.dims);
        let residual_span = self.dims.saturating_sub(residual_start);
        if residual_span > 0 {
            let residual = residual_start + (h.finish() as usize) % residual_span;
            v[residual] += 0.05;
        }
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > f32::EPSILON {
            for x in &mut v {
                *x /= n;
            }
        }
        v
    }
}

#[async_trait]
impl EmbedBackend for ConceptEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        // Prove async path: yield so a 50ms throwaway runtime would flake under load;
        // product budget is seconds — this still finishes instantly offline.
        tokio::task::yield_now().await;
        Ok(texts.iter().map(|t| self.embed_one(t)).collect())
    }

    fn identity(&self) -> String {
        // Deliberately dimension-free so a dimension change surfaces as a
        // dimension-binding mismatch, not an identity mismatch.
        "concept-embed (deterministic synthetic; contract tests only, not a capability)".into()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        // Dimensions stay unmeasured here for the same reason `identity` omits
        // them: a dimension change must surface as dimension drift measured
        // from real vectors, not as a different space label.
        EmbeddingSpaceIdentity::synthetic(self.identity())
    }
}

/// Local in-process ONNX embeddings via **fastembed-rs** (#359).
///
/// Only compiled with `--features log-fastembed`. Downloads the small
/// `AllMiniLML6V2` model on first use (network); default `cargo test` stays
/// offline by using [`ConceptEmbedBackend`] instead.
#[cfg(feature = "log-fastembed")]
pub struct FastembedEmbedBackend {
    inner: std::sync::Mutex<fastembed::TextEmbedding>,
}

#[cfg(feature = "log-fastembed")]
impl FastembedEmbedBackend {
    /// Create with the default small local model (may download once).
    pub fn try_new() -> CoreResult<Self> {
        use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2).with_show_download_progress(false),
        )
        .map_err(|e| crate::error::CoreError::Message(format!("fastembed init: {e}")))?;
        Ok(Self {
            inner: std::sync::Mutex::new(model),
        })
    }

    /// Embed a batch (sync; called from async via spawn_blocking in trait impl).
    fn embed_batch(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        let mut g = self
            .inner
            .lock()
            .map_err(|_| crate::error::CoreError::Message("fastembed lock".into()))?;
        let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        g.embed(refs, None)
            .map_err(|e| crate::error::CoreError::Message(format!("fastembed: {e}")))
    }
}

#[cfg(feature = "log-fastembed")]
#[async_trait]
impl EmbedBackend for FastembedEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        // Yield so callers exercise the async budget path (same as ConceptEmbed).
        tokio::task::yield_now().await;
        // ONNX work is sync under a Mutex; fine for batch template embed at write time.
        self.embed_batch(texts)
    }

    fn identity(&self) -> String {
        LOCAL_LOG_EMBED_MODEL_ID.into()
    }

    fn space(&self) -> EmbeddingSpaceIdentity {
        // In-process ONNX: no endpoint, no egress, real (not synthetic) model.
        EmbeddingSpaceIdentity::local(LOCAL_LOG_EMBED_MODEL_ID, "local_onnx")
    }
}

/// Product default for **log template** embedding (#359).
///
/// When built with `log-fastembed` (desktop host default), returns local ONNX
/// via [`FastembedEmbedBackend`]. Without the feature (default `cargo test`),
/// returns `None` so callers use an injected offline backend (e.g. Concept).
///
/// Model id for `memory_embeddings` / template cache keys when ONNX is used:
/// [`LOCAL_LOG_EMBED_MODEL_ID`].
pub fn default_log_embed_backend() -> CoreResult<Option<std::sync::Arc<dyn EmbedBackend>>> {
    #[cfg(feature = "log-fastembed")]
    {
        let b = FastembedEmbedBackend::try_new()?;
        Ok(Some(std::sync::Arc::new(b)))
    }
    #[cfg(not(feature = "log-fastembed"))]
    {
        Ok(None)
    }
}

/// Model id stored with log template vectors when using local ONNX.
pub const LOCAL_LOG_EMBED_MODEL_ID: &str = "all-minilm-l6-v2-onnx";

/// Whether this build includes the local ONNX log embedder (desktop product).
pub fn log_fastembed_enabled() -> bool {
    cfg!(feature = "log-fastembed")
}

/// Current unix seconds for recency.
pub fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Stable content key for embedding cache (chunk text fingerprint).
pub fn chunk_content_key(text: &str) -> String {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}:{}", h.finish(), text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_test_gateway::{MockGateway, Response, Step};
    use serde_json::json;

    #[tokio::test]
    async fn http_backend_batches_and_restores_index_order() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "data": [
                {"index": 1, "embedding": [0.0, 1.0]},
                {"index": 0, "embedding": [1.0, 0.0]}
            ]
        })))])
        .await;
        let backend = HttpEmbedBackend::new(gateway.base_url(), "bge-m3", None).unwrap();
        let vectors = backend
            .embed(&["first".into(), "second".into()])
            .await
            .unwrap();
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        let request = gateway.requests().pop().expect("request");
        assert_eq!(request.path, "/v1/embeddings");
        let body = request.json_body().unwrap();
        assert_eq!(body["model"], "bge-m3");
        assert_eq!(body["input"], json!(["first", "second"]));
    }

    #[tokio::test]
    async fn http_backend_rejects_duplicate_missing_and_heterogeneous_rows() {
        let cases = [
            json!({
                "data": [
                    {"index": 0, "embedding": [0.0, 1.0]},
                    {"index": 0, "embedding": [1.0, 0.0]}
                ]
            }),
            json!({"data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 2, "embedding": [1.0, 0.0]}]}),
            json!({
                "data": [
                    {"index": 0, "embedding": [0.0, 1.0]},
                    {"index": 1, "embedding": [1.0]}
                ]
            }),
        ];
        for body in cases {
            let gateway =
                MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
            let backend = HttpEmbedBackend::new(gateway.base_url(), "bge-m3", None).unwrap();
            let error = backend
                .embed(&["first".into(), "second".into()])
                .await
                .expect_err("malformed embedding response must fail closed");
            assert!(error.to_string().contains("embedding response contract"));
        }
    }

    #[tokio::test]
    async fn http_backend_rejects_non_finite_after_float_conversion_and_bounds_batch() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
            &json!({"data": [{"index": 0, "embedding": [1.0e100]}]}),
        ))])
        .await;
        let backend = HttpEmbedBackend::new(gateway.base_url(), "bge-m3", None).unwrap();
        let error = backend
            .embed(&["one".into()])
            .await
            .expect_err("f32 overflow must fail closed");
        assert!(error.to_string().contains("finite"));

        let too_many = vec!["x".to_string(); HTTP_EMBED_MAX_BATCH + 1];
        let error = backend.embed(&too_many).await.expect_err("batch bound");
        assert!(error.to_string().contains("batch bound"));
        assert_eq!(gateway.request_count(), 1);
    }

    #[tokio::test]
    async fn http_backend_empty_batch_does_not_touch_the_gateway() {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
        let backend = HttpEmbedBackend::new(gateway.base_url(), "bge-m3", None).unwrap();
        assert!(backend.embed(&[]).await.unwrap().is_empty());
        assert_eq!(gateway.request_count(), 0);
    }

    #[tokio::test]
    async fn vercel_v4_backend_uses_specialty_envelope_and_headers() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "embeddings": [[0.25, 0.75], [0.5, 0.5]]
        })))])
        .await;
        let backend = VercelV4EmbedBackend::new(
            gateway.base_url(),
            "voyage/voyage-4",
            Some("secret-token".into()),
        )
        .unwrap();
        let vectors = backend
            .embed(&["first".into(), "second".into()])
            .await
            .unwrap();
        assert_eq!(vectors, vec![vec![0.25, 0.75], vec![0.5, 0.5]]);
        let request = gateway.requests().pop().expect("request");
        assert_eq!(request.path, "/v4/ai/embedding-model");
        assert_eq!(request.header("authorization"), Some("Bearer secret-token"));
        assert_eq!(
            request.header("ai-embedding-model-specification-version"),
            Some("4")
        );
        assert_eq!(request.header("ai-model-id"), Some("voyage/voyage-4"));
        let body = request.json_body().unwrap();
        assert_eq!(body["values"], json!(["first", "second"]));
        assert!(body.get("input").is_none());
        assert!(!format!("{backend:?}").contains("secret-token"));
    }

    #[tokio::test]
    async fn vercel_v4_backend_rejects_bad_cardinality_and_dimensions() {
        for body in [
            json!({"embeddings": [[0.1, 0.2]]}),
            json!({"embeddings": [[0.1, 0.2], [0.3]]}),
        ] {
            let gateway =
                MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
            let backend = VercelV4EmbedBackend::new(gateway.base_url(), "m", None).unwrap();
            let error = backend
                .embed(&["a".into(), "b".into()])
                .await
                .expect_err("specialty response must fail closed");
            assert!(error.to_string().contains("embedding response contract"));
        }
    }

    #[test]
    fn default_log_embed_backend_respects_feature_flag() {
        // Without log-fastembed (default cargo test): None so tests stay offline.
        // With the feature (desktop product): Some(ONNX).
        let got = default_log_embed_backend().expect("factory must not error when feature off");
        if log_fastembed_enabled() {
            assert!(
                got.is_some(),
                "product build must supply local ONNX backend"
            );
        } else {
            assert!(
                got.is_none(),
                "default cargo test must not download ONNX models"
            );
        }
    }

    #[test]
    fn cosine_identical_is_one() {
        let a = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-5);
    }

    #[test]
    fn recency_newer_higher() {
        let now = 1_700_000_000i64;
        let recent = recency_boost(now - 86_400, now);
        let old = recency_boost(now - 86_400 * 365, now);
        assert!(recent > old);
        assert!(recent <= 1.0 && old >= 0.0);
    }

    #[test]
    fn hybrid_keyword_only_when_no_semantic() {
        let w = HybridWeights::default().normalized(false);
        assert!(w.semantic.abs() < 1e-6);
        let s = hybrid_score(10.0, 10.0, 0.0, 0.5, HybridWeights::default());
        assert!(s > 0.0 && s <= 1.0);
    }

    #[tokio::test]
    async fn mock_embed_similar_texts_rank_higher() {
        let backend = MockHashEmbedBackend::new(32);
        let a = backend
            .embed(&[
                "authentication login password credentials".into(),
                "billing invoice payment refund".into(),
            ])
            .await
            .unwrap();
        let q = backend
            .embed(&["user auth credentials sign-in".into()])
            .await
            .unwrap();
        let cos_auth = cosine_similarity(&q[0], &a[0]);
        let cos_bill = cosine_similarity(&q[0], &a[1]);
        assert!(
            cos_auth > cos_bill,
            "auth={cos_auth} bill={cos_bill} — mock should prefer semantic neighbor"
        );
    }

    #[tokio::test]
    async fn concept_embed_residual_cannot_collide_with_reserved_concept_basis() {
        let backend = ConceptEmbedBackend::new(16);
        let reserved = ConceptEmbedBackend::concept_groups().len();
        let collision = (0..10_000)
            .map(|index| format!("unrelated residual candidate {index}"))
            .find(|text| {
                let mut hash = DefaultHasher::new();
                text.hash(&mut hash);
                (hash.finish() as usize) % backend.dims < reserved
            })
            .expect("deterministic residual collision fixture");

        let vectors = backend
            .embed(&[
                "econnrefused".into(),
                "connection refused".into(),
                collision,
            ])
            .await
            .unwrap();

        assert!(
            vectors[2][..reserved]
                .iter()
                .all(|component| component.abs() < f32::EPSILON),
            "unrelated residual occupied a reserved concept dimension"
        );
        assert!(
            cosine_similarity(&vectors[0], &vectors[1])
                > cosine_similarity(&vectors[0], &vectors[2]),
            "explicit concept geometry must outrank residual noise"
        );
    }
}

#[cfg(test)]
mod endpoint_identity_tests {
    use super::*;

    /// The fingerprint a caller can compute from configuration alone must be
    /// the one the built adapter reports.
    ///
    /// Adapters normalize the configured base URL into a concrete route before
    /// they fingerprint their space, so a fingerprint taken from the bare base
    /// URL disagrees with the stored one for byte-identical configuration —
    /// and nothing in either artifact reveals it. Port 9 (discard) is used so
    /// construction resolves a loopback literal without connecting.
    #[test]
    fn a_configured_endpoint_fingerprints_the_same_as_the_backend_that_serves_it() {
        for base in [
            "http://127.0.0.1:9",
            "http://127.0.0.1:9/",
            "http://127.0.0.1:9/v1",
            "http://127.0.0.1:9/proxy",
        ] {
            let backend = HttpEmbedBackend::new(base, "m", None).expect("build openai adapter");
            let from_config = embedding_endpoint_for_dialect(base, "openai_embeddings")
                .expect("known dialect has a known route");
            assert_eq!(
                backend.space().endpoint_fingerprint,
                crate::capability_qualification::fingerprint_endpoint(&from_config),
                "openai_embeddings disagreed for base {base}"
            );
        }
    }

    /// An unknown dialect has no known route, so no fingerprint is offered
    /// rather than a confidently wrong one taken from the bare base URL.
    #[test]
    fn an_unknown_dialect_yields_no_endpoint_rather_than_a_wrong_one() {
        assert!(embedding_endpoint_for_dialect("http://127.0.0.1:9", "not_a_dialect").is_none());
        assert!(embedding_endpoint_for_dialect("not a url", "openai_embeddings").is_none());
    }

    /// Ollama posts per-call routes off its stored base, so its space is the
    /// base itself with the trailing slash trimmed — the same string
    /// `OllamaClient` keeps.
    #[test]
    fn the_ollama_dialect_fingerprints_its_stored_base() {
        let from_config =
            embedding_endpoint_for_dialect("http://127.0.0.1:11434/", "ollama_embeddings")
                .expect("known dialect");
        assert_eq!(from_config, "http://127.0.0.1:11434");
    }
}
