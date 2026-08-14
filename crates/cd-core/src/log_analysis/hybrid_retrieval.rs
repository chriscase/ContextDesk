//! Hybrid event retrieval: always-available structured/keyword baseline,
//! optionally widened by a semantic embedding lane and optionally reordered
//! by a rerank stage.
//!
//! Host-neutral contract. The current product integration exposes role
//! diagnostics through the CLI; desktop and benchmark execution adapters are
//! intentionally not claimed until they are wired and measured.
//!
//! 1. The structured/keyword lane always runs and is always usable — absence
//!    or failure of any optional role degrades gracefully and is recorded in
//!    `degradations`, never inflated into an error.
//! 2. The semantic lane runs only when an [`EmbedBackend`] is supplied AND
//!    the corpus actually holds embedded templates AND the stored embedding
//!    binding (model identity + vector dimensions) matches the query backend
//!    (the production honesty gates); otherwise the outcome says why.
//! 3. The rerank stage runs over a **candidate pool that is deliberately
//!    broader than the final K** ([`HybridOptions::rerank_candidate_depth`]):
//!    reranking only the rows that already fit in K can reorder them but can
//!    never recover a relevant row that fused just outside K. One bounded
//!    request scores the pool; the result is then truncated to K. Pre-rerank
//!    ranks and scores are retained in diagnostics.
//!    Exact-phrase, structured-filter, and chronology-boundary rows are
//!    **pinned anchors**: a rerank may reorder them but may never evict them
//!    from the final K. Anchor promotion is reported, never silent.
//! 4. Merge and deduplication are deterministic: candidates deduplicate by
//!    `seq` and order by reciprocal-rank fusion across the lanes
//!    (`RRF_K = 60`; ties by ts ASC, seq ASC) before rerank, and by
//!    (rerank score DESC, pre-rerank rank ASC) after. Fusion never lets one
//!    lane evict the other wholesale: presence in any lane contributes.
//! 5. Identity is preserved end to end: corpus id, event/template revisions
//!    (stale revision fails closed with a retryable error), source, seq,
//!    timestamp provenance.
//! 6. Telemetry is measured, never guessed: call counts are `Some(n)`
//!    (measured) and unknown values stay `None`. Similarity scores mean
//!    retrieval relevance — never proof of causation.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use crate::rerank::{
    rerank_blocking, validate_rerank_scores, RerankBackend, RERANK_DEFAULT_TIMEOUT_MS,
    RERANK_MAX_DOCUMENTS,
};

use super::query::{search_events_advanced_with_cancel, EventQuery, EventSearchQuery};
use super::store::LogCorpus;
use super::SearchMatchMode;

/// Reciprocal-rank-fusion constant (the standard k=60): fused score is the
/// sum over lanes of `1 / (RRF_K + lane_rank)`. Deterministic and
/// parameter-light; documented in the engine manifest of benchmark runs.
pub const RRF_K: f64 = 60.0;

/// Retrieval mode actually used for one hybrid search, after degradations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HybridModeUsed {
    /// Only the always-available structured/keyword lane produced results.
    StructuredKeyword,
    /// Keyword plus the semantic embedding lane.
    HybridEmbedding,
    /// Keyword plus embeddings, reordered by the rerank stage.
    HybridEmbeddingReranked,
}

impl HybridModeUsed {
    /// Stable snake_case label used in DTOs and reports.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StructuredKeyword => "structured_keyword",
            Self::HybridEmbedding => "hybrid_embedding",
            Self::HybridEmbeddingReranked => "hybrid_embedding_reranked",
        }
    }
}

/// Where a merged candidate came from (diagnostics; a candidate may have
/// several origins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "lane")]
pub enum HybridOrigin {
    /// Matched the literal production search for `terms[term_index]`.
    Keyword {
        /// Index into `HybridOptions::keyword_terms`.
        term_index: usize,
    },
    /// Returned by the production semantic template search with this score.
    Semantic {
        /// Hybrid similarity score reported by the production search.
        score: f32,
    },
}

/// One merged, deduplicated retrieval candidate with full identity and
/// pre/post-rerank diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridCandidate {
    /// Durable event sequence identity within the corpus.
    pub seq: u64,
    /// Full relative source identity (never basename-only).
    pub source: String,
    /// Event timestamp (or ingest-order value for order-only records).
    pub ts: i64,
    /// Timestamp provenance label (explicit wall / unresolved local / order-only).
    pub timestamp_provenance: String,
    /// Severity level as imported.
    pub level: String,
    /// Drain template id.
    pub template_id: u64,
    /// Redacted message text.
    pub message: String,
    /// Every lane that produced this candidate.
    pub origins: Vec<HybridOrigin>,
    /// Rank in the deterministic merged order BEFORE any rerank (1-based).
    pub pre_rerank_rank: u64,
    /// Reciprocal-rank-fusion score before any rerank.
    pub pre_rerank_score: f32,
    /// 1-based rank within the keyword lane union, when present there.
    pub keyword_lane_rank: Option<u64>,
    /// 1-based rank within the semantic lane, when present there.
    pub semantic_lane_rank: Option<u64>,
    /// Score assigned by the rerank stage, when it ran and covered this row.
    pub rerank_score: Option<f32>,
    /// Why this row is pinned into the final K, when it is. A pinned row may
    /// be reordered by rerank but never evicted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<HybridAnchorKind>,
    /// True when this row was outside the reranked top-K and was restored
    /// because it is a pinned anchor. Always reported, never silent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub anchor_promoted: bool,
    /// Final 1-based rank after optional reranking.
    pub final_rank: u64,
}

/// Why a candidate is pinned into the final K.
///
/// Anchors exist because a relevance reranker scores *topical similarity to
/// the query text*. That signal is genuinely useful, but it is blind to three
/// things an investigator depends on: an exact literal match, an explicitly
/// requested structured constraint, and the chronological boundaries of the
/// window under examination. Letting a similarity score silently drop those
/// rows trades a checkable fact for a model opinion, so it is not allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HybridAnchorKind {
    /// The row's message literally contains one of the keyword terms.
    ExactPhrase,
    /// The row satisfies a structured constraint the caller explicitly asked
    /// for (level, source, service, or time window).
    Structured,
    /// The row is the earliest or latest row in the candidate pool, so the
    /// answer can still state the boundaries of the window it looked at.
    Chronology,
}

impl HybridAnchorKind {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExactPhrase => "exact_phrase",
            Self::Structured => "structured",
            Self::Chronology => "chronology",
        }
    }
}

/// Measured execution telemetry. `Some(0)` is a measured zero; `None` means
/// unknown and must stay unknown downstream.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HybridTelemetry {
    /// Measured embedding requests (`Some(0)` = measured zero).
    pub embedding_calls: Option<u64>,
    /// Wall-clock time spent in the semantic lane, when it ran.
    pub embedding_latency_ms: Option<u64>,
    /// Configured embedding model identity, when the lane ran.
    pub embedding_model: Option<String>,
    /// Measured rerank requests (`Some(0)` = measured zero).
    pub rerank_calls: Option<u64>,
    /// Wall-clock time spent in the rerank stage, when it ran.
    pub rerank_latency_ms: Option<u64>,
    /// Configured reranker identity, when the stage produced scores.
    pub rerank_model: Option<String>,
    /// Explicit wire dialect of the reranker that produced scores. Reported
    /// from the adapter, never inferred from an endpoint or a model name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerank_dialect: Option<String>,
    /// Documents actually submitted to the rerank stage (the bounded candidate
    /// pool, which is deliberately wider than the final K).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerank_pool_size: Option<u64>,
    /// Merged candidates retained before rerank and truncation to K.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_pool_size: Option<u64>,
    /// Pinned anchors restored into the final K after reranking (`Some(0)` is
    /// a measured zero: the rerank kept every anchor on its own).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchors_promoted: Option<u64>,
    /// Tokens in, when a backend reports them; no backend in this repository
    /// does today, so this stays `None` (never fabricated).
    pub tokens_in: Option<u64>,
    /// Tokens out, when reported (see `tokens_in`).
    pub tokens_out: Option<u64>,
    /// Cost, when reported (see `tokens_in`).
    pub cost_usd: Option<f64>,
}

/// A degradation that left the search usable but narrower than requested.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridDegradation {
    /// Stable machine code: `embedding_backend_absent`,
    /// `corpus_not_embedded`, `embedding_model_mismatch`,
    /// `embedding_space_legacy_unbound`, `embedding_space_drift`,
    /// `embedding_lane_failed`, `rerank_backend_absent`,
    /// `rerank_failed_or_timed_out`, `rerank_invalid_response`.
    pub code: String,
    /// Human-readable explanation of what degraded and what still ran.
    pub detail: String,
}

/// The complete result of one hybrid retrieval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridOutcome {
    /// Corpus identity the search ran against.
    pub corpus_id: String,
    /// Event revision pinned for the whole search (stale = fail closed).
    pub event_revision: u64,
    /// Template-analysis revision pinned for the whole search.
    pub template_analysis_revision: u64,
    /// Mode that ACTUALLY executed after degradations.
    pub mode_used: HybridModeUsed,
    /// Final ordered candidates (post-rerank when the stage ran).
    pub candidates: Vec<HybridCandidate>,
    /// Measured telemetry; unknown values stay unknown.
    pub telemetry: HybridTelemetry,
    /// Degradations that narrowed the search without failing it.
    pub degradations: Vec<HybridDegradation>,
    /// True when any lane was truncated by k or its scan bounds.
    pub partial: bool,
    /// Engine-reported exact total for single-term keyword plans; unions of
    /// several terms overlap, so their exact total is unknown (`None`).
    pub keyword_matched_total: Option<u64>,
    /// Events scanned across all lanes (engine-reported).
    pub scanned: u64,
}

#[derive(Debug, Clone)]
/// Tunables for one hybrid retrieval. Defaults mirror the benchmark contract
/// (k = 50).
pub struct HybridOptions {
    /// Literal production searches, one per term (deduplicated union).
    pub keyword_terms: Vec<String>,
    /// Natural-language text for the semantic lane (embedded as the query).
    pub semantic_query: Option<String>,
    /// Structured filter applied to every lane (levels/sources/services/time).
    pub filter: EventQuery,
    /// Final candidate budget (1..=500, the production search page bound).
    /// This is what the caller receives.
    pub k: usize,
    /// How many merged candidates enter the rerank pool, **before** truncation
    /// to `k`. Clamped to `[k, RERANK_MAX_DOCUMENTS]`, so it is never narrower
    /// than the final budget: reranking only the rows that already fit in `k`
    /// can reorder them but can never recover a relevant row that fused just
    /// outside `k`.
    pub rerank_candidate_depth: usize,
    /// Wall-clock budget for the single rerank request.
    pub rerank_timeout_ms: u64,
}

impl Default for HybridOptions {
    fn default() -> Self {
        Self {
            keyword_terms: Vec::new(),
            semantic_query: None,
            filter: EventQuery::default(),
            k: 50,
            // Twice the final budget, still inside the one-request document
            // bound: wide enough to promote a near-miss, narrow enough to stay
            // one bounded call.
            rerank_candidate_depth: 100,
            rerank_timeout_ms: RERANK_DEFAULT_TIMEOUT_MS,
        }
    }
}

/// Embedding decorator that measures real calls without changing behavior.
/// When the corpus binding pins an expected dimension count, it also records
/// (without altering) any returned vector whose dimensions diverge, so the
/// caller can withhold structurally incomparable semantic results with a
/// typed reason instead of silently scoring them as zero.
struct CountingEmbed<'a> {
    inner: &'a dyn EmbedBackend,
    calls: AtomicU64,
    ok_calls: AtomicU64,
    expected_dims: Option<u32>,
    dims_mismatch: AtomicBool,
}

#[async_trait::async_trait]
impl<'a> EmbedBackend for CountingEmbed<'a> {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self.inner.embed(texts).await;
        if let Ok(vectors) = &result {
            self.ok_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(expected) = self.expected_dims {
                if vectors.iter().any(|vector| vector.len() as u32 != expected) {
                    self.dims_mismatch.store(true, Ordering::SeqCst);
                }
            }
        }
        result
    }

    fn identity(&self) -> String {
        self.inner.identity()
    }

    fn space(&self) -> crate::embedding_space::EmbeddingSpaceIdentity {
        // A measuring decorator must be transparent to the binding gates: it
        // observes calls, it does not define a different vector space.
        self.inner.space()
    }
}

/// Typed reason when the stored embedding binding cannot be honestly compared
/// against the query backend; `None` means every binding check passed and the
/// semantic lane may run (dimensions are then verified again against the
/// vectors the query backend actually returns).
///
/// Two gates run, in this order, and both fail closed:
///
/// 1. The **measured dimension** gate — stored vectors with no single positive
///    dimension count cannot pin any geometry.
/// 2. The **typed embedding-space** gate
///    ([`crate::embedding_space::evaluate_space_binding`]) — legacy corpora
///    (no typed space) and any drifting identity field are refused. The
///    free-form `model_id` is still compared as a defence in depth for stores
///    written before the typed space existed alongside it.
fn embedding_binding_mismatch(
    status: &super::store::CorpusEmbeddingStatus,
    query_identity: &str,
    query_space: &crate::embedding_space::EmbeddingSpaceIdentity,
) -> Option<(String, String)> {
    if status.embedded_dims.is_none_or(|dims| dims == 0) {
        return Some((
            "embedding_model_mismatch".into(),
            "stored template vectors have no single valid dimension binding; re-run template \
             re-analysis before semantic retrieval; structured/keyword results kept"
                .into(),
        ));
    }
    let verdict =
        crate::embedding_space::evaluate_space_binding(status.space.as_ref(), query_space);
    if !verdict.is_bound() {
        return Some((verdict.code().to_string(), verdict.detail()));
    }
    match status
        .model_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        None => Some((
            "embedding_model_mismatch".into(),
            "stored template vectors carry no model identity (legacy corpus); re-run template \
             re-analysis to bind them before semantic retrieval; structured/keyword results kept"
                .into(),
        )),
        Some(stored) if stored != query_identity => Some((
            "embedding_model_mismatch".into(),
            format!(
                "stored template vectors were produced by `{stored}` but the query backend is \
                 `{query_identity}`; vectors from different models are not comparable; \
                 structured/keyword results kept"
            ),
        )),
        Some(_) => None,
    }
}

#[cfg(test)]
std::thread_local! {
    #[allow(clippy::type_complexity)]
    static HYBRID_STAGE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&str)>>> =
        const { std::cell::RefCell::new(None) };
}

/// Test-only: observe stage boundaries (`"merged"`, `"reranked"`) so tests
/// can mutate the corpus mid-flight and prove stale-revision behavior.
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(crate) fn set_hybrid_stage_hook_for_test(hook: Option<Box<dyn FnMut(&str)>>) {
    HYBRID_STAGE_HOOK.with(|cell| *cell.borrow_mut() = hook);
}

#[cfg(test)]
fn invoke_hybrid_stage_hook(stage: &str) {
    HYBRID_STAGE_HOOK.with(|cell| {
        if let Some(hook) = cell.borrow_mut().as_mut() {
            hook(stage);
        }
    });
}

#[cfg(not(test))]
fn invoke_hybrid_stage_hook(_stage: &str) {}

fn check_hybrid_revisions(
    corpus: &LogCorpus,
    pinned_event: u64,
    pinned_template: u64,
) -> CoreResult<()> {
    if corpus.event_revision() != pinned_event {
        return Err(CoreError::Message(
            "log corpus event revision changed during hybrid retrieval; retry".into(),
        ));
    }
    if corpus.template_analysis_revision() != pinned_template {
        return Err(CoreError::Message(
            "log template analysis revision changed during hybrid retrieval; retry".into(),
        ));
    }
    Ok(())
}

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.is_some_and(CancelFlag::is_cancelled)
}

/// Whether the caller asked for any structured constraint. Only an explicitly
/// requested constraint creates a structured anchor; pinning rows for a filter
/// nobody asked for would pin the whole corpus.
fn filter_is_structured(filter: &EventQuery) -> bool {
    !filter.levels.is_empty()
        || !filter.sources.is_empty()
        || !filter.services.is_empty()
        || filter.time_from.is_some()
        || filter.time_to.is_some()
}

/// Assign pinned anchors over the candidate pool, in place.
///
/// Precedence is exact phrase, then structured, then chronology, so a row that
/// qualifies several ways reports the strongest reason. Chronology pins only
/// the earliest and latest rows in the pool — enough for an answer to state
/// the boundaries of the window it examined, without pinning the middle.
fn assign_anchors(pool: &mut [HybridCandidate], options: &HybridOptions) {
    let terms: Vec<String> = options
        .keyword_terms
        .iter()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    let structured = filter_is_structured(&options.filter);
    for candidate in pool.iter_mut() {
        let message = candidate.message.to_lowercase();
        candidate.anchor = if terms.iter().any(|term| message.contains(term)) {
            Some(HybridAnchorKind::ExactPhrase)
        } else if structured {
            // Every pooled row already passed the requested filter on every
            // lane, so presence in the pool IS the structured evidence.
            Some(HybridAnchorKind::Structured)
        } else {
            None
        };
    }
    if pool.is_empty() {
        return;
    }
    let mut chronological: Vec<usize> = (0..pool.len()).collect();
    chronological.sort_by_key(|index| (pool[*index].ts, pool[*index].seq));
    for boundary in [
        chronological.first().copied(),
        chronological.last().copied(),
    ]
    .into_iter()
    .flatten()
    {
        if pool[boundary].anchor.is_none() {
            pool[boundary].anchor = Some(HybridAnchorKind::Chronology);
        }
    }
}

/// Outcome of applying the rerank stage to a candidate pool.
pub(crate) struct RerankStageOutcome {
    /// Final candidates, already truncated to `k` and ranked.
    pub candidates: Vec<HybridCandidate>,
    /// Whether the stage actually reordered anything.
    pub reranked: bool,
    /// Pinned anchors restored into the final K after reranking.
    pub anchors_promoted: u64,
}

/// Apply the rerank stage to a candidate pool and truncate to `k`.
///
/// This is a **pure function** on purpose: the guarantee that an invalid,
/// timed-out, or cancelled rerank leaves the pre-rerank order byte-identical
/// is the whole point of the stage, and it is only checkable if the ordering
/// decision does not also own the transport.
///
/// * `scores == None` — the call failed, timed out, or was cancelled. The
///   pre-rerank pool is truncated to `k` and returned unchanged: no
///   `rerank_score` is set on any row, so the bytes are identical to a run
///   with no reranker at all.
/// * `scores == Some(invalid)` — a response that cannot be aligned one-to-one
///   with the submitted documents is treated exactly like a failure.
/// * `scores == Some(valid)` — rows are reordered by (score DESC, pre-rerank
///   rank ASC); pinned anchors that fall outside `k` displace the
///   worst-reranked non-anchor rows and are marked `anchor_promoted`.
pub(crate) fn apply_rerank_stage(
    pool: Vec<HybridCandidate>,
    submitted: usize,
    scores: Option<Vec<f32>>,
    k: usize,
) -> RerankStageOutcome {
    let truncate_pre_rerank = |mut pool: Vec<HybridCandidate>| {
        pool.truncate(k);
        for (index, candidate) in pool.iter_mut().enumerate() {
            candidate.final_rank = index as u64 + 1;
        }
        RerankStageOutcome {
            candidates: pool,
            reranked: false,
            anchors_promoted: 0,
        }
    };

    let Some(scores) = scores else {
        return truncate_pre_rerank(pool);
    };
    if submitted > pool.len() || validate_rerank_scores(&scores, submitted).is_err() {
        return truncate_pre_rerank(pool);
    }

    let mut pool = pool;
    for (candidate, score) in pool.iter_mut().zip(scores.iter()) {
        candidate.rerank_score = Some(*score);
    }
    // Only the submitted prefix was scored; unscored rows keep their
    // pre-rerank position behind it.
    let mut scored: Vec<HybridCandidate> = pool.drain(..submitted).collect();
    scored.sort_by(|a, b| {
        b.rerank_score
            .unwrap_or(f32::NEG_INFINITY)
            .total_cmp(&a.rerank_score.unwrap_or(f32::NEG_INFINITY))
            .then(a.pre_rerank_rank.cmp(&b.pre_rerank_rank))
    });
    scored.append(&mut pool);

    // Select the reranked top-K, then restore any pinned anchor that fell out
    // by displacing the worst-reranked non-anchor selection.
    let mut selected: Vec<usize> = (0..scored.len().min(k)).collect();
    let mut anchors_promoted = 0u64;
    let missing_anchors: Vec<usize> = (k..scored.len())
        .filter(|index| scored[*index].anchor.is_some())
        .collect();
    for anchor in missing_anchors {
        let Some(position) = selected
            .iter()
            .rposition(|index| scored[*index].anchor.is_none())
        else {
            // Every selected row is itself an anchor; there is nothing to
            // displace and no honest way to fit more into K.
            break;
        };
        selected.remove(position);
        // Keep the reranked order among the final set.
        let insert_at = selected.partition_point(|index| *index < anchor);
        selected.insert(insert_at, anchor);
        anchors_promoted += 1;
    }

    let promoted_positions: std::collections::BTreeSet<usize> = selected
        .iter()
        .copied()
        .filter(|index| *index >= k)
        .collect();
    let mut candidates: Vec<HybridCandidate> = selected
        .into_iter()
        .map(|index| {
            let mut candidate = scored[index].clone();
            candidate.anchor_promoted = promoted_positions.contains(&index);
            candidate
        })
        .collect();
    for (index, candidate) in candidates.iter_mut().enumerate() {
        candidate.final_rank = index as u64 + 1;
    }
    RerankStageOutcome {
        candidates,
        reranked: true,
        anchors_promoted,
    }
}

/// Run one hybrid retrieval over an imported corpus.
///
/// `embed`/`rerank` are OPTIONAL roles: `None` (or a failing backend) leaves
/// the structured/keyword baseline usable and records the degradation.
pub fn hybrid_search_events(
    corpus: &LogCorpus,
    options: &HybridOptions,
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    cancel: Option<&CancelFlag>,
) -> CoreResult<HybridOutcome> {
    let k = options.k.clamp(1, 500);
    // The rerank pool is deliberately at least as wide as the final budget: a
    // pool narrower than K could only reorder rows that already fit, never
    // recover one that fused just outside it.
    let candidate_depth = options
        .rerank_candidate_depth
        .max(k)
        .clamp(1, RERANK_MAX_DOCUMENTS);
    let pinned_event = corpus.event_revision();
    let pinned_template = corpus.template_analysis_revision();
    let cancel_probe = || cancelled(cancel);

    let mut degradations: Vec<HybridDegradation> = Vec::new();
    let mut telemetry = HybridTelemetry {
        // The keyword lane never embeds/reranks: measured zeros until a lane
        // actually runs.
        embedding_calls: Some(0),
        rerank_calls: Some(0),
        ..HybridTelemetry::default()
    };

    // ---- keyword lane (always) -------------------------------------------
    let mut merged: std::collections::BTreeMap<u64, HybridCandidate> =
        std::collections::BTreeMap::new();
    let mut scanned = 0u64;
    let mut partial = false;
    let mut keyword_matched_total = Some(0u64);
    for (term_index, term) in options.keyword_terms.iter().enumerate() {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        let search = EventSearchQuery {
            query: Some(term.clone()),
            filter: options.filter.clone(),
            semantic: false,
            // Each lane returns up to the pool depth, not the final K, so the
            // pool the reranker sees is genuinely wider than the answer.
            k: candidate_depth,
            match_mode: SearchMatchMode::Literal,
            case_sensitive: false,
        };
        let result =
            search_events_advanced_with_cancel(corpus, &search, None, Some(&cancel_probe))?;
        if result.cancelled {
            return Err(CoreError::Cancelled);
        }
        scanned = scanned.saturating_add(result.scanned);
        partial |= result.partial;
        keyword_matched_total = match (keyword_matched_total, result.total_matched) {
            (Some(_), Some(total)) if options.keyword_terms.len() == 1 => Some(total),
            _ => None,
        };
        for hit in result.hits {
            merged
                .entry(hit.event.seq)
                .and_modify(|existing| existing.origins.push(HybridOrigin::Keyword { term_index }))
                .or_insert_with(|| HybridCandidate {
                    seq: hit.event.seq,
                    source: hit.event.source.clone(),
                    ts: hit.event.ts,
                    timestamp_provenance: format!("{:?}", hit.event.timestamp_provenance),
                    level: hit.event.level.clone(),
                    template_id: hit.event.template_id,
                    message: hit.event.message.clone(),
                    origins: vec![HybridOrigin::Keyword { term_index }],
                    pre_rerank_rank: 0,
                    pre_rerank_score: 0.0,
                    keyword_lane_rank: None,
                    semantic_lane_rank: None,
                    rerank_score: None,
                    anchor: None,
                    anchor_promoted: false,
                    final_rank: 0,
                });
        }
    }
    // Keyword lane ranks: the chronological union order the product presents.
    {
        let mut keyword_ordered: Vec<(i64, u64)> = merged.values().map(|c| (c.ts, c.seq)).collect();
        keyword_ordered.sort();
        for (rank, (_, seq)) in keyword_ordered.into_iter().enumerate() {
            if let Some(candidate) = merged.get_mut(&seq) {
                candidate.keyword_lane_rank = Some(rank as u64 + 1);
            }
        }
    }

    // ---- semantic lane (optional) ----------------------------------------
    let mut semantic_ran = false;
    match (embed, options.semantic_query.as_deref()) {
        (None, Some(_)) => degradations.push(HybridDegradation {
            code: "embedding_backend_absent".into(),
            detail: "no embedding backend configured; structured/keyword results only".into(),
        }),
        (Some(_), None) | (None, None) => {}
        (Some(backend), Some(question)) => {
            let embedding_binding = corpus.embedding_status();
            if embedding_binding.embedded_templates == 0 {
                degradations.push(HybridDegradation {
                    code: "corpus_not_embedded".into(),
                    detail: "corpus has no embedded templates; the production honesty gate keeps semantic ranking off".into(),
                });
            } else if let Some((code, detail)) = embedding_binding_mismatch(
                &embedding_binding,
                &backend.identity(),
                &backend.space(),
            ) {
                degradations.push(HybridDegradation { code, detail });
            } else if cancelled(cancel) {
                return Err(CoreError::Cancelled);
            } else {
                let counting = CountingEmbed {
                    inner: backend,
                    calls: AtomicU64::new(0),
                    ok_calls: AtomicU64::new(0),
                    expected_dims: embedding_binding.embedded_dims,
                    dims_mismatch: AtomicBool::new(false),
                };
                let search = EventSearchQuery {
                    query: Some(question.to_string()),
                    filter: options.filter.clone(),
                    semantic: true,
                    k: candidate_depth,
                    match_mode: SearchMatchMode::Literal,
                    case_sensitive: false,
                };
                let started = std::time::Instant::now();
                match search_events_advanced_with_cancel(
                    corpus,
                    &search,
                    Some(&counting),
                    Some(&cancel_probe),
                ) {
                    Err(error) => degradations.push(HybridDegradation {
                        code: "embedding_lane_failed".into(),
                        detail: format!(
                            "semantic lane failed; structured/keyword results kept: {error}"
                        ),
                    }),
                    Ok(result) if result.cancelled => return Err(CoreError::Cancelled),
                    Ok(result) => {
                        // The production search degrades embedding outages
                        // internally (keyword fallback); the semantic lane
                        // only counts as EXECUTED when at least one embedding
                        // call actually succeeded AND every returned vector
                        // matched the stored dimension binding. Mismatched
                        // dimensions cosine to zero structurally, so merging
                        // that lane would misreport a semantic mode that never
                        // contributed a comparable signal.
                        if counting.dims_mismatch.load(Ordering::SeqCst) {
                            degradations.push(HybridDegradation {
                                code: "embedding_model_mismatch".into(),
                                detail: format!(
                                    "query backend `{}` returned vectors whose dimensions diverge from the {} stored dimensions; semantic results withheld; structured/keyword results kept",
                                    counting.identity(),
                                    embedding_binding
                                        .embedded_dims
                                        .map(|dims| dims.to_string())
                                        .unwrap_or_else(|| "unknown".into()),
                                ),
                            });
                        } else if counting.ok_calls.load(Ordering::SeqCst) == 0 {
                            degradations.push(HybridDegradation {
                                code: "embedding_lane_failed".into(),
                                detail: "embedding backend produced no successful call; structured/keyword results kept".into(),
                            });
                        } else {
                            semantic_ran = true;
                            // Backend-known identity of the lane that actually
                            // executed — never a configuration backfill.
                            telemetry.embedding_model = Some(counting.identity());
                        }
                        telemetry.embedding_latency_ms = Some(started.elapsed().as_millis() as u64);
                        scanned = scanned.saturating_add(result.scanned);
                        partial |= result.partial;
                        let mergeable_hits = if semantic_ran {
                            result.hits
                        } else {
                            Vec::new()
                        };
                        for (index, hit) in mergeable_hits.into_iter().enumerate() {
                            let lane_rank = index as u64 + 1;
                            let origin = HybridOrigin::Semantic { score: hit.score };
                            merged
                                .entry(hit.event.seq)
                                .and_modify(|existing| {
                                    existing.origins.push(origin.clone());
                                    if existing.semantic_lane_rank.is_none() {
                                        existing.semantic_lane_rank = Some(lane_rank);
                                    }
                                })
                                .or_insert_with(|| HybridCandidate {
                                    seq: hit.event.seq,
                                    source: hit.event.source.clone(),
                                    ts: hit.event.ts,
                                    timestamp_provenance: format!(
                                        "{:?}",
                                        hit.event.timestamp_provenance
                                    ),
                                    level: hit.event.level.clone(),
                                    template_id: hit.event.template_id,
                                    message: hit.event.message.clone(),
                                    origins: vec![origin],
                                    pre_rerank_rank: 0,
                                    pre_rerank_score: 0.0,
                                    keyword_lane_rank: None,
                                    semantic_lane_rank: Some(lane_rank),
                                    rerank_score: None,
                                    anchor: None,
                                    anchor_promoted: false,
                                    final_rank: 0,
                                });
                        }
                    }
                }
                let calls = counting.calls.load(Ordering::SeqCst);
                telemetry.embedding_calls = Some(calls);
            }
        }
    }

    // ---- deterministic merge order (reciprocal-rank fusion) ---------------
    let mut ordered: Vec<HybridCandidate> = merged.into_values().collect();
    for candidate in &mut ordered {
        let mut fused = 0.0f64;
        if let Some(rank) = candidate.keyword_lane_rank {
            fused += 1.0 / (RRF_K + rank as f64);
        }
        if let Some(rank) = candidate.semantic_lane_rank {
            fused += 1.0 / (RRF_K + rank as f64);
        }
        candidate.pre_rerank_score = fused as f32;
    }
    ordered.sort_by(|a, b| {
        b.pre_rerank_score
            .total_cmp(&a.pre_rerank_score)
            .then(a.ts.cmp(&b.ts))
            .then(a.seq.cmp(&b.seq))
    });
    // The candidate POOL is retained at `candidate_depth`, deliberately wider
    // than the final K, so the optional rerank stage can promote a row that
    // fused just outside K. Truncation to K happens after that stage.
    if ordered.len() > candidate_depth {
        partial = true;
        ordered.truncate(candidate_depth);
    }
    for (index, candidate) in ordered.iter_mut().enumerate() {
        candidate.pre_rerank_rank = index as u64 + 1;
        candidate.final_rank = candidate.pre_rerank_rank;
    }
    assign_anchors(&mut ordered, options);
    telemetry.candidate_pool_size = Some(ordered.len() as u64);
    // Everything the pool holds beyond K is dropped from the answer, so a pool
    // wider than K is itself a partial result.
    partial |= ordered.len() > k;
    invoke_hybrid_stage_hook("merged");
    check_hybrid_revisions(corpus, pinned_event, pinned_template)?;

    // ---- rerank stage (optional) ------------------------------------------
    let mut rerank_ran = false;
    match rerank {
        None => {
            if semantic_ran {
                degradations.push(HybridDegradation {
                    code: "rerank_backend_absent".into(),
                    detail: "no rerank backend configured; merged order is final".into(),
                });
            }
            let stage = apply_rerank_stage(ordered, 0, None, k);
            ordered = stage.candidates;
        }
        Some(_) if ordered.is_empty() => {
            // There is no candidate identity to align with a score. Avoid an
            // empty provider request and do not credit a reranker for work it
            // could not contribute.
        }
        Some(backend) => {
            if cancelled(cancel) {
                return Err(CoreError::Cancelled);
            }
            let submitted = ordered.len().min(RERANK_MAX_DOCUMENTS);
            let pool: Vec<String> = ordered
                .iter()
                .take(submitted)
                .map(|candidate| candidate.message.clone())
                .collect();
            let query_text = options
                .semantic_query
                .clone()
                .unwrap_or_else(|| options.keyword_terms.join(" "));
            let started = std::time::Instant::now();
            let scores = rerank_blocking(backend, &query_text, &pool, options.rerank_timeout_ms);
            telemetry.rerank_latency_ms = Some(started.elapsed().as_millis() as u64);
            telemetry.rerank_calls = Some(1);
            telemetry.rerank_pool_size = Some(submitted as u64);
            match &scores {
                None => degradations.push(HybridDegradation {
                    code: "rerank_failed_or_timed_out".into(),
                    detail: format!(
                        "rerank call failed, was cancelled, or exceeded {} ms; pre-rerank order kept byte for byte",
                        options.rerank_timeout_ms
                    ),
                }),
                Some(values) if validate_rerank_scores(values, submitted).is_err() => {
                    degradations.push(HybridDegradation {
                        code: "rerank_invalid_response".into(),
                        detail: "rerank response did not contain exactly one finite score per submitted document; pre-rerank order kept byte for byte".into(),
                    });
                }
                Some(_) => {}
            }
            let stage = apply_rerank_stage(ordered, submitted, scores, k);
            rerank_ran = stage.reranked;
            if rerank_ran {
                telemetry.rerank_model = Some(backend.identity());
                telemetry.rerank_dialect = Some(backend.dialect().to_string());
                telemetry.anchors_promoted = Some(stage.anchors_promoted);
            }
            ordered = stage.candidates;
        }
    }
    invoke_hybrid_stage_hook("reranked");
    check_hybrid_revisions(corpus, pinned_event, pinned_template)?;
    if cancelled(cancel) {
        return Err(CoreError::Cancelled);
    }

    let mode_used = match (semantic_ran, rerank_ran) {
        (true, true) => HybridModeUsed::HybridEmbeddingReranked,
        (true, false) => HybridModeUsed::HybridEmbedding,
        // Rerank without a semantic lane is still keyword evidence reordered:
        // the semantic capability did not run, so the mode says so.
        (false, true) => HybridModeUsed::StructuredKeyword,
        (false, false) => HybridModeUsed::StructuredKeyword,
    };

    Ok(HybridOutcome {
        corpus_id: corpus.id().to_string(),
        event_revision: pinned_event,
        template_analysis_revision: pinned_template,
        mode_used,
        candidates: ordered,
        telemetry,
        degradations,
        partial,
        keyword_matched_total,
        scanned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
    use crate::log_analysis::ingest::ingest_path_with_policy;
    use crate::rerank::ScriptedRerankBackend;
    use std::sync::Arc;

    struct FailingEmbed;
    #[async_trait::async_trait]
    impl EmbedBackend for FailingEmbed {
        async fn embed(&self, _texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            Err(CoreError::Message("synthetic embedding outage".into()))
        }

        fn identity(&self) -> String {
            // Matches the concept-embedded fixtures' stored binding so the
            // outage test exercises the lane-failure path, not the identity
            // gate in front of it.
            ConceptEmbedBackend::default().identity()
        }

        fn space(&self) -> crate::embedding_space::EmbeddingSpaceIdentity {
            // Same reason as `identity`: bind to the fixture's stored space so
            // the outage path is what is under test.
            ConceptEmbedBackend::default().space()
        }
    }

    struct DifferentIdentityEmbed {
        calls: std::sync::atomic::AtomicU64,
    }

    #[async_trait::async_trait]
    impl EmbedBackend for DifferentIdentityEmbed {
        async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(texts.iter().map(|_| vec![1.0; 64]).collect())
        }

        fn identity(&self) -> String {
            "different-vector-space (deterministic synthetic; tests only)".into()
        }
    }

    struct StallingRerank;
    #[async_trait::async_trait]
    impl RerankBackend for StallingRerank {
        async fn rerank(&self, _q: &str, _d: &[String]) -> CoreResult<Vec<f32>> {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            Ok(Vec::new())
        }
        fn identity(&self) -> String {
            "stalling-test".into()
        }
    }

    #[derive(Clone, Copy)]
    enum InvalidRerankResponse {
        TooFew,
        TooMany,
        NotANumber,
        Infinite,
    }

    struct InvalidRerank(InvalidRerankResponse);

    #[async_trait::async_trait]
    impl RerankBackend for InvalidRerank {
        async fn rerank(&self, _q: &str, documents: &[String]) -> CoreResult<Vec<f32>> {
            let mut scores = vec![0.5; documents.len()];
            match self.0 {
                InvalidRerankResponse::TooFew => {
                    scores.pop();
                }
                InvalidRerankResponse::TooMany => scores.push(0.4),
                InvalidRerankResponse::NotANumber => scores[0] = f32::NAN,
                InvalidRerankResponse::Infinite => scores[0] = f32::INFINITY,
            }
            Ok(scores)
        }

        fn identity(&self) -> String {
            "invalid-rerank-test".into()
        }
    }

    struct CountingRerank {
        calls: std::sync::atomic::AtomicU64,
    }

    #[async_trait::async_trait]
    impl RerankBackend for CountingRerank {
        async fn rerank(&self, _q: &str, documents: &[String]) -> CoreResult<Vec<f32>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![0.0; documents.len()])
        }

        fn identity(&self) -> String {
            "counting-rerank-test".into()
        }
    }

    fn write_fixture(dir: &std::path::Path) {
        let mut lines = String::new();
        for index in 0..24u32 {
            let message = match index {
                4 => "warehouse shipment alpha-token dispatched".to_string(),
                9 => "billing beta-token retry scheduled".to_string(),
                14 => "combined alpha-token beta-token correlation row".to_string(),
                19 => "storage saturation gamma-token free space collapsing".to_string(),
                _ => format!("routine heartbeat lane={} ok", index % 3),
            };
            lines.push_str(&format!(
                "{{\"ts\":{},\"level\":\"info\",\"service\":\"hyb\",\"host\":\"hyb-01.example\",\"trace_id\":\"trace-{index:04}\",\"message\":\"{message}\"}}\n",
                1_735_732_800 + i64::from(index) * 30
            ));
        }
        std::fs::write(dir.join("app.jsonl"), lines).expect("fixture");
    }

    fn fixture(embedded: bool) -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let src = tempfile::tempdir().expect("src");
        write_fixture(src.path());
        let (policy, backend): (LogEmbedPolicy, Option<Arc<dyn EmbedBackend>>) = if embedded {
            (
                LogEmbedPolicy {
                    mode: LogEmbedMode::Local,
                    cloud_content_leaves_machine: false,
                    cloud_base_url: None,
                    model_id: "concept-embed-test".into(),
                    defer_above_source_bytes: None,
                },
                Some(Arc::new(ConceptEmbedBackend::default())),
            )
        } else {
            (LogEmbedPolicy::default(), None)
        };
        let report = ingest_path_with_policy(cache.path(), src.path(), "hyb", &policy, backend)
            .expect("ingest");
        (cache, report.corpus_id)
    }

    fn options(terms: &[&str], semantic: Option<&str>) -> HybridOptions {
        HybridOptions {
            keyword_terms: terms.iter().map(|t| t.to_string()).collect(),
            semantic_query: semantic.map(str::to_string),
            ..HybridOptions::default()
        }
    }

    #[test]
    fn keyword_lane_deduplicates_and_is_deterministic() {
        let (cache, corpus_id) = fixture(false);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let opts = options(&["alpha-token", "beta-token"], None);
        let first = hybrid_search_events(&corpus, &opts, None, None, None).expect("first");
        let second = hybrid_search_events(&corpus, &opts, None, None, None).expect("second");
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap(),
            "merge and dedup must be deterministic"
        );
        assert_eq!(first.mode_used, HybridModeUsed::StructuredKeyword);
        let combined: Vec<_> = first
            .candidates
            .iter()
            .filter(|c| c.message.contains("correlation row"))
            .collect();
        assert_eq!(combined.len(), 1, "dual-term match deduplicates by seq");
        assert_eq!(
            combined[0].origins.len(),
            2,
            "both keyword origins retained"
        );
        assert_eq!(first.telemetry.embedding_calls, Some(0));
        assert_eq!(first.telemetry.rerank_calls, Some(0));
        assert!(first.telemetry.tokens_in.is_none(), "unknown stays unknown");
        let ranks: Vec<u64> = first.candidates.iter().map(|c| c.final_rank).collect();
        assert_eq!(ranks, (1..=ranks.len() as u64).collect::<Vec<_>>());
    }

    #[test]
    fn optional_roles_absent_or_failing_leave_baseline_usable() {
        // (a) semantic requested, no backend configured.
        let (cache, corpus_id) = fixture(false);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let opts = options(&["alpha-token"], Some("shipment problems"));
        let outcome = hybrid_search_events(&corpus, &opts, None, None, None).expect("no backend");
        assert_eq!(outcome.mode_used, HybridModeUsed::StructuredKeyword);
        assert!(!outcome.candidates.is_empty());
        assert!(outcome
            .degradations
            .iter()
            .any(|d| d.code == "embedding_backend_absent"));

        // (b) backend present but corpus never embedded: honesty gate.
        let concept = ConceptEmbedBackend::default();
        let outcome =
            hybrid_search_events(&corpus, &opts, Some(&concept), None, None).expect("not embedded");
        assert_eq!(outcome.mode_used, HybridModeUsed::StructuredKeyword);
        assert!(outcome
            .degradations
            .iter()
            .any(|d| d.code == "corpus_not_embedded"));

        // (c) embedded corpus, failing backend at query time.
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let outcome = hybrid_search_events(&corpus, &opts, Some(&FailingEmbed), None, None)
            .expect("failing backend degrades");
        assert_eq!(outcome.mode_used, HybridModeUsed::StructuredKeyword);
        assert!(!outcome.candidates.is_empty(), "baseline stays usable");
        assert!(outcome
            .degradations
            .iter()
            .any(|d| d.code == "embedding_lane_failed"));
    }

    #[test]
    fn semantic_binding_mismatches_fail_closed_without_model_credit() {
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let opts = options(&["alpha-token"], Some("storage saturation free space"));

        let different = DifferentIdentityEmbed {
            calls: std::sync::atomic::AtomicU64::new(0),
        };
        let identity_mismatch =
            hybrid_search_events(&corpus, &opts, Some(&different), None, None).unwrap();
        assert_eq!(
            identity_mismatch.mode_used,
            HybridModeUsed::StructuredKeyword
        );
        assert_eq!(
            different.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "known identity mismatches must be rejected before model work"
        );
        assert!(
            identity_mismatch
                .degradations
                .iter()
                .any(|d| d.code == "embedding_space_drift"),
            "a foreign vector space must be refused by the typed space gate: {:?}",
            identity_mismatch.degradations
        );
        assert!(identity_mismatch
            .degradations
            .iter()
            .any(|d| d.detail.contains("model") && d.detail.contains("dialect")));
        assert!(identity_mismatch.telemetry.embedding_model.is_none());

        // Concept identities deliberately do not encode dimensions, so this
        // reaches the measured query-vector dimension gate.
        let wrong_dims = ConceptEmbedBackend::new(32);
        let dimension_mismatch =
            hybrid_search_events(&corpus, &opts, Some(&wrong_dims), None, None).unwrap();
        assert_eq!(
            dimension_mismatch.mode_used,
            HybridModeUsed::StructuredKeyword
        );
        assert!(dimension_mismatch
            .degradations
            .iter()
            .any(|d| d.code == "embedding_model_mismatch"));
        assert!(dimension_mismatch.telemetry.embedding_model.is_none());
        assert!(!dimension_mismatch
            .candidates
            .iter()
            .any(|candidate| candidate
                .origins
                .iter()
                .any(|origin| matches!(origin, HybridOrigin::Semantic { .. }))));
    }

    #[test]
    fn semantic_lane_and_rerank_keep_prererank_diagnostics() {
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let concept = ConceptEmbedBackend::default();
        let opts = options(&["alpha-token"], Some("storage saturation free space"));

        let plain = hybrid_search_events(&corpus, &opts, Some(&concept), None, None)
            .expect("semantic lane");
        assert_eq!(plain.mode_used, HybridModeUsed::HybridEmbedding);
        assert!(
            plain.telemetry.embedding_calls.unwrap_or(0) > 0,
            "measured calls"
        );
        assert!(plain.candidates.iter().any(|c| c
            .origins
            .iter()
            .any(|o| matches!(o, HybridOrigin::Semantic { .. }))));

        let reranked = hybrid_search_events(
            &corpus,
            &opts,
            Some(&concept),
            Some(&ScriptedRerankBackend),
            None,
        )
        .expect("reranked");
        assert_eq!(reranked.mode_used, HybridModeUsed::HybridEmbeddingReranked);
        assert_eq!(reranked.telemetry.rerank_calls, Some(1));
        assert!(reranked
            .telemetry
            .rerank_model
            .as_deref()
            .unwrap()
            .contains("synthetic"));
        for candidate in &reranked.candidates {
            assert!(candidate.pre_rerank_rank >= 1, "pre-rerank rank retained");
            assert!(
                candidate.rerank_score.is_some(),
                "score recorded for reranked prefix"
            );
        }
        let mut expected = reranked.candidates.clone();
        expected.sort_by(|a, b| {
            b.rerank_score
                .unwrap()
                .total_cmp(&a.rerank_score.unwrap())
                .then(a.pre_rerank_rank.cmp(&b.pre_rerank_rank))
        });
        assert_eq!(
            reranked
                .candidates
                .iter()
                .map(|c| c.seq)
                .collect::<Vec<_>>(),
            expected.iter().map(|c| c.seq).collect::<Vec<_>>(),
            "final order is rerank score desc with pre-rerank tiebreak"
        );

        // Rerank failure/timeout keeps the pre-rerank order and records it.
        let mut timed = opts.clone();
        timed.rerank_timeout_ms = 50;
        let degraded =
            hybrid_search_events(&corpus, &timed, Some(&concept), Some(&StallingRerank), None)
                .expect("degraded rerank");
        assert_eq!(degraded.mode_used, HybridModeUsed::HybridEmbedding);
        assert!(degraded
            .degradations
            .iter()
            .any(|d| d.code == "rerank_failed_or_timed_out"));
        assert_eq!(
            degraded
                .candidates
                .iter()
                .map(|c| c.seq)
                .collect::<Vec<_>>(),
            plain.candidates.iter().map(|c| c.seq).collect::<Vec<_>>(),
            "pre-rerank order kept on failure"
        );
        assert!(
            degraded.telemetry.rerank_model.is_none(),
            "no model credit on failure"
        );
    }

    #[test]
    fn invalid_rerank_shapes_keep_the_exact_pre_rerank_order() {
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let concept = ConceptEmbedBackend::default();
        let mut opts = options(&["alpha-token"], Some("storage saturation free space"));
        opts.rerank_candidate_depth = 4;
        let plain = hybrid_search_events(&corpus, &opts, Some(&concept), None, None)
            .expect("pre-rerank baseline");
        let expected_ids = plain
            .candidates
            .iter()
            .map(|candidate| candidate.seq)
            .collect::<Vec<_>>();

        for invalid in [
            InvalidRerankResponse::TooFew,
            InvalidRerankResponse::TooMany,
            InvalidRerankResponse::NotANumber,
            InvalidRerankResponse::Infinite,
        ] {
            let outcome = hybrid_search_events(
                &corpus,
                &opts,
                Some(&concept),
                Some(&InvalidRerank(invalid)),
                None,
            )
            .expect("invalid rerank response degrades");
            assert_eq!(outcome.mode_used, HybridModeUsed::HybridEmbedding);
            assert_eq!(outcome.telemetry.rerank_calls, Some(1));
            assert!(outcome.telemetry.rerank_model.is_none());
            assert!(outcome
                .degradations
                .iter()
                .any(|degradation| degradation.code == "rerank_invalid_response"));
            assert_eq!(
                outcome
                    .candidates
                    .iter()
                    .map(|candidate| candidate.seq)
                    .collect::<Vec<_>>(),
                expected_ids,
                "an unalignable response must not change candidate order"
            );
            assert!(outcome
                .candidates
                .iter()
                .all(|candidate| candidate.rerank_score.is_none()));
        }
    }

    #[test]
    fn empty_candidate_set_never_calls_or_credits_the_reranker() {
        let (cache, corpus_id) = fixture(false);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let backend = CountingRerank {
            calls: std::sync::atomic::AtomicU64::new(0),
        };
        let outcome = hybrid_search_events(
            &corpus,
            &HybridOptions::default(),
            None,
            Some(&backend),
            None,
        )
        .expect("empty retrieval remains usable");

        assert!(outcome.candidates.is_empty());
        assert_eq!(backend.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(outcome.telemetry.rerank_calls, Some(0));
        assert!(outcome.telemetry.rerank_model.is_none());
    }

    /// A synthetic candidate pool with fully controlled scores, so the ordering
    /// contract can be exercised without a corpus in the way.
    fn pooled_candidate(seq: u64, anchor: Option<HybridAnchorKind>) -> HybridCandidate {
        HybridCandidate {
            seq,
            source: "pool.log".into(),
            ts: 1_700_000_000 + seq as i64,
            timestamp_provenance: "ExplicitWall".into(),
            level: "info".into(),
            template_id: seq,
            message: format!("row {seq}"),
            origins: vec![HybridOrigin::Keyword { term_index: 0 }],
            pre_rerank_rank: seq,
            pre_rerank_score: 1.0 / seq as f32,
            keyword_lane_rank: Some(seq),
            semantic_lane_rank: None,
            rerank_score: None,
            anchor,
            anchor_promoted: false,
            final_rank: seq,
        }
    }

    #[test]
    fn a_rerank_pool_wider_than_k_can_promote_a_row_that_fused_outside_k() {
        // Pool of 6, final K of 3. Rank 6 is the most relevant to the query, a
        // row a pool capped at K could never have recovered.
        let pool: Vec<HybridCandidate> = (1..=6).map(|seq| pooled_candidate(seq, None)).collect();
        let scores = vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.9];
        let stage = apply_rerank_stage(pool, 6, Some(scores), 3);
        assert!(stage.reranked);
        assert_eq!(
            stage
                .candidates
                .iter()
                .map(|candidate| candidate.seq)
                .collect::<Vec<_>>(),
            vec![6, 5, 4],
            "the k+1..pool tail must be able to reach the answer"
        );
        assert_eq!(
            stage.candidates.len(),
            3,
            "the answer is still truncated to K"
        );
        assert_eq!(stage.anchors_promoted, 0);
        let ranks: Vec<u64> = stage
            .candidates
            .iter()
            .map(|candidate| candidate.final_rank)
            .collect();
        assert_eq!(ranks, vec![1, 2, 3]);
    }

    #[test]
    fn pinned_anchors_survive_a_rerank_that_would_have_evicted_them() {
        // Rank 5 is an exact-phrase anchor the reranker scores lowest of all.
        let pool: Vec<HybridCandidate> = (1..=6)
            .map(|seq| pooled_candidate(seq, (seq == 5).then_some(HybridAnchorKind::ExactPhrase)))
            .collect();
        let scores = vec![0.9, 0.8, 0.7, 0.6, 0.01, 0.5];
        let stage = apply_rerank_stage(pool, 6, Some(scores), 3);
        assert!(stage.reranked);
        assert_eq!(stage.anchors_promoted, 1, "the promotion is reported");
        let seqs: Vec<u64> = stage
            .candidates
            .iter()
            .map(|candidate| candidate.seq)
            .collect();
        assert!(
            seqs.contains(&5),
            "an exact-phrase anchor may be reordered but never evicted: {seqs:?}"
        );
        assert_eq!(seqs.len(), 3, "promotion displaces, it does not widen K");
        let promoted = stage
            .candidates
            .iter()
            .find(|candidate| candidate.seq == 5)
            .expect("anchor present");
        assert!(promoted.anchor_promoted, "promotion is never silent");
        assert_eq!(promoted.anchor, Some(HybridAnchorKind::ExactPhrase));
        // The displaced row is the worst-reranked non-anchor selection.
        assert!(
            !seqs.contains(&3),
            "worst-reranked non-anchor is displaced: {seqs:?}"
        );
    }

    #[test]
    fn a_refused_rerank_keeps_the_pre_rerank_order_byte_for_byte() {
        let pool: Vec<HybridCandidate> = (1..=6).map(|seq| pooled_candidate(seq, None)).collect();
        let baseline = apply_rerank_stage(pool.clone(), 0, None, 3);
        let baseline_bytes = serde_json::to_vec(&baseline.candidates).expect("baseline serializes");
        assert!(!baseline.reranked);

        // Every refusal reason — transport failure, timeout, cancellation
        // (all surface as `None`), and every unalignable score vector — must
        // produce exactly these bytes.
        let refusals: Vec<Option<Vec<f32>>> = vec![
            None,
            Some(vec![0.9, 0.8, 0.7, 0.6, 0.5]),
            Some(vec![0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]),
            Some(vec![f32::NAN, 0.8, 0.7, 0.6, 0.5, 0.4]),
            Some(vec![f32::INFINITY, 0.8, 0.7, 0.6, 0.5, 0.4]),
        ];
        for (index, scores) in refusals.into_iter().enumerate() {
            let submitted = if scores.is_none() { 0 } else { 6 };
            let outcome = apply_rerank_stage(pool.clone(), submitted, scores, 3);
            assert!(!outcome.reranked, "refusal {index} must not claim a rerank");
            assert_eq!(outcome.anchors_promoted, 0);
            assert_eq!(
                serde_json::to_vec(&outcome.candidates).expect("serializes"),
                baseline_bytes,
                "refusal {index} changed the pre-rerank bytes"
            );
            assert!(outcome
                .candidates
                .iter()
                .all(|candidate| candidate.rerank_score.is_none()));
        }
    }

    #[test]
    fn a_pool_of_only_anchors_is_never_widened_past_k() {
        let pool: Vec<HybridCandidate> = (1..=5)
            .map(|seq| pooled_candidate(seq, Some(HybridAnchorKind::Structured)))
            .collect();
        let stage = apply_rerank_stage(pool, 5, Some(vec![0.1, 0.2, 0.3, 0.4, 0.5]), 2);
        assert_eq!(
            stage.candidates.len(),
            2,
            "K is a hard budget even when every row is pinned"
        );
    }

    #[test]
    fn anchors_cover_exact_phrase_structured_and_chronology_rows() {
        let mut pool: Vec<HybridCandidate> =
            (1..=4).map(|seq| pooled_candidate(seq, None)).collect();
        pool[1].message = "warehouse shipment alpha-token dispatched".into();
        let mut opts = options(&["alpha-token"], None);
        assign_anchors(&mut pool, &opts);
        assert_eq!(pool[1].anchor, Some(HybridAnchorKind::ExactPhrase));
        // Chronology boundaries are pinned so an answer can still state the
        // window it examined; the interior is not.
        assert_eq!(pool[0].anchor, Some(HybridAnchorKind::Chronology));
        assert_eq!(pool[3].anchor, Some(HybridAnchorKind::Chronology));
        assert_eq!(pool[2].anchor, None);

        // An explicitly requested structured constraint pins every pooled row,
        // because passing that filter is what put the row in the pool.
        opts.filter.levels = vec!["error".into()];
        let mut structured: Vec<HybridCandidate> =
            (1..=4).map(|seq| pooled_candidate(seq, None)).collect();
        assign_anchors(&mut structured, &opts);
        assert!(structured
            .iter()
            .all(|candidate| candidate.anchor == Some(HybridAnchorKind::Structured)));

        // With no terms and no filter, only the chronology boundaries pin.
        let mut unconstrained: Vec<HybridCandidate> =
            (1..=4).map(|seq| pooled_candidate(seq, None)).collect();
        assign_anchors(&mut unconstrained, &options(&[], None));
        assert_eq!(
            unconstrained
                .iter()
                .filter(|candidate| candidate.anchor.is_some())
                .count(),
            2
        );
    }

    #[test]
    fn the_rerank_pool_is_never_narrower_than_k_and_is_reported() {
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let concept = ConceptEmbedBackend::default();
        let mut opts = options(&["alpha-token"], Some("storage saturation free space"));
        opts.k = 3;
        // A caller asking for a pool narrower than K gets K: a narrower pool
        // could only reorder rows that already fit.
        opts.rerank_candidate_depth = 1;
        let outcome = hybrid_search_events(
            &corpus,
            &opts,
            Some(&concept),
            Some(&ScriptedRerankBackend),
            None,
        )
        .expect("reranked");
        assert!(outcome.candidates.len() <= 3);
        let pool = outcome
            .telemetry
            .candidate_pool_size
            .expect("pool measured");
        assert!(pool >= outcome.candidates.len() as u64);
        assert!(outcome.telemetry.rerank_pool_size.expect("submitted") >= 1);
        assert_eq!(
            outcome.telemetry.rerank_dialect.as_deref(),
            Some(crate::rerank::RERANK_DIALECT_SYNTHETIC),
            "the dialect that actually parsed is reported, never inferred"
        );
        assert!(
            outcome.telemetry.anchors_promoted.is_some(),
            "a rerank that ran must report a measured promotion count, not silence"
        );
    }

    #[test]
    fn cancellation_fails_closed() {
        let (cache, corpus_id) = fixture(false);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let cancel = CancelFlag::new();
        cancel.cancel();
        let error = hybrid_search_events(
            &corpus,
            &options(&["alpha-token"], None),
            None,
            None,
            Some(&cancel),
        )
        .expect_err("pre-cancelled flag must fail closed");
        assert!(matches!(error, CoreError::Cancelled));
    }

    #[test]
    fn stale_template_revision_fails_closed_with_retry_error() {
        let (cache, corpus_id) = fixture(true);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).expect("open");
        let cache_path = cache.path().to_path_buf();
        let corpus_for_hook = corpus_id.clone();
        super::set_hybrid_stage_hook_for_test(Some(Box::new(move |stage: &str| {
            if stage == "merged" {
                // A concurrent template-metadata upsert bumps the shared
                // template-analysis revision clock mid-search.
                let handle = LogCorpus::open(&cache_path, &corpus_for_hook).expect("hook corpus");
                let before = handle.template_analysis_revision();
                let row = handle
                    .list_templates()
                    .into_iter()
                    .next()
                    .expect("at least one template");
                handle.upsert_templates([row]).expect("upsert");
                assert_ne!(
                    handle.template_analysis_revision(),
                    before,
                    "metadata upsert must publish a new template revision"
                );
            }
        })));
        let result =
            hybrid_search_events(&corpus, &options(&["alpha-token"], None), None, None, None);
        super::set_hybrid_stage_hook_for_test(None);
        let error = result.expect_err("stale revision must fail closed");
        assert!(
            error.to_string().contains("revision changed"),
            "retryable stale-revision error, got: {error}"
        );
    }
}
