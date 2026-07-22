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
        // Mild residual so empty concept texts are not zero-vectors (unique id)
        let mut h = DefaultHasher::new();
        lower.hash(&mut h);
        let residual = (h.finish() as usize) % self.dims;
        v[residual] += 0.05;
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
}
