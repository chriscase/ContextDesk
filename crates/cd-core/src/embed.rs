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

use crate::error::CoreResult;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

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

// ---------------------------------------------------------------------------
// OpenAI-compatible production embeddings (`POST …/embeddings`)
// ---------------------------------------------------------------------------

/// Hard cap on texts per embeddings request (batch bound).
pub const EMBED_MAX_BATCH: usize = 64;

/// Default wall-clock budget for one embeddings HTTP call.
pub const EMBED_DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Character soft-cap per input text (bounds request size).
pub const EMBED_INPUT_CHAR_CAP: usize = 8_192;

/// Validate a finished embedding batch at the consumer boundary: one vector
/// per input, all finite, all the same non-zero dimension.
pub fn validate_embedding_batch(vectors: &[Vec<f32>], expected: usize) -> CoreResult<()> {
    use crate::error::CoreError;
    if vectors.len() != expected {
        return Err(CoreError::Message(format!(
            "embed response contract: expected {expected} vectors, received {}",
            vectors.len()
        )));
    }
    if vectors.is_empty() {
        return Ok(());
    }
    let dims = vectors[0].len();
    if dims == 0 {
        return Err(CoreError::Message(
            "embed response contract: empty vector dimensions".into(),
        ));
    }
    for (i, v) in vectors.iter().enumerate() {
        if v.len() != dims {
            return Err(CoreError::Message(format!(
                "embed response contract: heterogeneous dimensions at index {i} ({} vs {dims})",
                v.len()
            )));
        }
        if v.iter().any(|x| !x.is_finite()) {
            return Err(CoreError::Message(format!(
                "embed response contract: non-finite component at index {i}"
            )));
        }
    }
    Ok(())
}

/// Parse an OpenAI-compatible embeddings JSON body into input-order vectors.
///
/// Accepts either of:
/// - `{"data":[{"embedding":[…],"index":0},…]}` (indexed; reordered to input)
/// - `{"data":[{"embedding":[…]},…]}` (positional; must match input order)
///
/// Rejects missing/duplicate/out-of-range indexes, non-finite values, empty
/// vectors, and heterogeneous dimensions. Does not invent zero vectors.
pub fn parse_openai_embeddings_response(
    body: &serde_json::Value,
    expected: usize,
) -> CoreResult<Vec<Vec<f32>>> {
    use crate::error::CoreError;
    if expected == 0 {
        return Ok(Vec::new());
    }
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| CoreError::Message("embed response contract: missing data array".into()))?;
    if data.len() != expected {
        return Err(CoreError::Message(format!(
            "embed response contract: expected {expected} data rows, received {}",
            data.len()
        )));
    }
    let mut out: Vec<Option<Vec<f32>>> = vec![None; expected];
    let mut any_index = false;
    for (positional, row) in data.iter().enumerate() {
        let embedding = row
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| {
                CoreError::Message("embed response contract: missing embedding array".into())
            })?;
        let mut vec = Vec::with_capacity(embedding.len());
        for x in embedding {
            let f = x.as_f64().ok_or_else(|| {
                CoreError::Message("embed response contract: non-numeric component".into())
            })?;
            if !f.is_finite() {
                return Err(CoreError::Message(
                    "embed response contract: non-finite component".into(),
                ));
            }
            vec.push(f as f32);
        }
        if vec.is_empty() {
            return Err(CoreError::Message(
                "embed response contract: empty embedding vector".into(),
            ));
        }
        let slot = if let Some(idx_v) = row.get("index") {
            any_index = true;
            let idx = idx_v.as_u64().ok_or_else(|| {
                CoreError::Message("embed response contract: non-integer index".into())
            })? as usize;
            if idx >= expected {
                return Err(CoreError::Message(format!(
                    "embed response contract: index {idx} out of range for {expected} inputs"
                )));
            }
            idx
        } else {
            positional
        };
        if out[slot].is_some() {
            return Err(CoreError::Message(format!(
                "embed response contract: duplicate index {slot}"
            )));
        }
        out[slot] = Some(vec);
    }
    // If any row carried an index, every row must have resolved uniquely —
    // already enforced by duplicate/range checks above.
    let _ = any_index;
    let vectors: Vec<Vec<f32>> = out
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            v.ok_or_else(|| {
                CoreError::Message(format!(
                    "embed response contract: missing vector for index {i}"
                ))
            })
        })
        .collect::<CoreResult<_>>()?;
    validate_embedding_batch(&vectors, expected)?;
    Ok(vectors)
}

fn cap_embed_input(text: &str) -> String {
    if text.chars().count() <= EMBED_INPUT_CHAR_CAP {
        return text.to_string();
    }
    text.chars().take(EMBED_INPUT_CHAR_CAP).collect()
}

/// Production OpenAI-compatible embeddings backend (`POST {base}/embeddings`
/// or `{base}/v1/embeddings`). Batches inputs in one request, preserves
/// response order via index realignment, and fails closed on malformed
/// envelopes. Bearer credentials stay in memory only — never in `identity()`
/// or `Debug`.
pub struct OpenAiCompatibleEmbedBackend {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    bearer: Option<String>,
}

impl std::fmt::Debug for OpenAiCompatibleEmbedBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiCompatibleEmbedBackend")
            .field("endpoint", &self.endpoint.as_str())
            .field("model", &self.model)
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl OpenAiCompatibleEmbedBackend {
    /// Build against `base_url` (scheme+host+port, optional `/v1` prefix).
    /// The embeddings path is appended without dropping a trailing path
    /// segment. URL is SSRF-vetted.
    pub fn new(
        base_url: &str,
        model: impl Into<String>,
        bearer: Option<String>,
    ) -> CoreResult<Self> {
        use crate::error::CoreError;
        let policy = crate::ssrf::SsrfPolicy::default();
        let resolver = crate::ssrf::SystemResolver;
        let (url, client) = crate::ssrf::build_pinned_client_for_url(
            base_url,
            &policy,
            &resolver,
            std::time::Duration::from_millis(EMBED_DEFAULT_TIMEOUT_MS),
        )
        .map_err(|e| CoreError::Message(format!("embed endpoint SSRF: {e}")))?;
        let mut endpoint = url;
        let base_path = endpoint.path().trim_end_matches('/');
        // Preserve `/v1` when present; otherwise append `/v1/embeddings`.
        let embed_path = if base_path.ends_with("/v1") || base_path.ends_with("/embeddings") {
            if base_path.ends_with("/embeddings") {
                base_path.to_string()
            } else {
                format!("{base_path}/embeddings")
            }
        } else if base_path.is_empty() {
            "/v1/embeddings".to_string()
        } else {
            format!("{base_path}/v1/embeddings")
        };
        endpoint.set_path(&embed_path);
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        Ok(Self {
            client,
            endpoint,
            model: model.into(),
            bearer,
        })
    }

    /// Configured model id (same as [`EmbedBackend::identity`]).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Endpoint URL string for tests (never secrets). Prefer fingerprints in
    /// share-safe reports.
    pub fn endpoint_url(&self) -> &str {
        self.endpoint.as_str()
    }
}

#[async_trait]
impl EmbedBackend for OpenAiCompatibleEmbedBackend {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        use crate::error::CoreError;
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > EMBED_MAX_BATCH {
            return Err(CoreError::Config(format!(
                "embed request exceeds the {EMBED_MAX_BATCH}-input batch bound"
            )));
        }
        let capped: Vec<String> = texts.iter().map(|t| cap_embed_input(t)).collect();
        let body = serde_json::json!({
            "model": self.model,
            "input": capped,
        });
        let mut request = self.client.post(self.endpoint.clone()).json(&body);
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("embed transport: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            // Do not echo body — may quote inputs or credentials.
            return Err(CoreError::Message(format!(
                "embed endpoint returned HTTP {status}"
            )));
        }
        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| CoreError::Message(format!("embed response contract: {e}")))?;
        // Optional wire model echo: when present and non-empty, must match.
        if let Some(echo) = parsed.get("model").and_then(|m| m.as_str()) {
            if !echo.is_empty() && echo != self.model {
                return Err(CoreError::Message(format!(
                    "embed response contract: model identity mismatch (configured `{}`, wire `{echo}`)",
                    self.model
                )));
            }
        }
        parse_openai_embeddings_response(&parsed, texts.len())
    }

    fn identity(&self) -> String {
        self.model.clone()
    }
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

    #[test]
    fn parse_openai_embeddings_preserves_batch_order_and_indexes() {
        let body = serde_json::json!({
            "model": "bge-m3",
            "data": [
                {"index": 2, "embedding": [0.0, 1.0]},
                {"index": 0, "embedding": [1.0, 0.0]},
                {"index": 1, "embedding": [0.5, 0.5]},
            ]
        });
        let vectors = parse_openai_embeddings_response(&body, 3).unwrap();
        assert_eq!(
            vectors,
            vec![vec![1.0, 0.0], vec![0.5, 0.5], vec![0.0, 1.0]]
        );
    }

    #[test]
    fn parse_openai_embeddings_rejects_malformed_envelopes() {
        // duplicate index
        assert!(parse_openai_embeddings_response(
            &serde_json::json!({"data":[
                {"index":0,"embedding":[1.0]},
                {"index":0,"embedding":[2.0]},
            ]}),
            2
        )
        .is_err());
        // missing index
        assert!(parse_openai_embeddings_response(
            &serde_json::json!({"data":[{"index":0,"embedding":[1.0]}]}),
            2
        )
        .is_err());
        // heterogeneous dims
        assert!(parse_openai_embeddings_response(
            &serde_json::json!({"data":[
                {"embedding":[1.0, 0.0]},
                {"embedding":[1.0]},
            ]}),
            2
        )
        .is_err());
        // empty vector
        assert!(parse_openai_embeddings_response(
            &serde_json::json!({"data":[{"embedding":[]}]}),
            1
        )
        .is_err());
    }

    #[test]
    fn validate_embedding_batch_rejects_non_finite() {
        assert!(validate_embedding_batch(&[vec![1.0, f32::NAN]], 1).is_err());
        assert!(validate_embedding_batch(&[vec![1.0, 0.0]], 1).is_ok());
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
