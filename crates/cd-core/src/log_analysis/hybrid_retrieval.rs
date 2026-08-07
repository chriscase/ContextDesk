//! Hybrid event retrieval: always-available structured/keyword baseline,
//! optionally widened by a semantic embedding lane and optionally reordered
//! by a rerank stage.
//!
//! Contract (host-neutral; CLI, desktop, and the retrieval-ablation benchmark
//! all consume this seam):
//!
//! 1. The structured/keyword lane always runs and is always usable — absence
//!    or failure of any optional role degrades gracefully and is recorded in
//!    `degradations`, never inflated into an error.
//! 2. The semantic lane runs only when an [`EmbedBackend`] is supplied AND
//!    the corpus actually holds embedded templates (the production honesty
//!    gate); otherwise the outcome says why.
//! 3. The rerank stage reorders only the top [`HybridOptions::rerank_top_n`]
//!    merged candidates in ONE bounded request; pre-rerank ranks and scores
//!    are retained in diagnostics.
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

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use crate::rerank::{
    rerank_blocking, RerankBackend, RERANK_DEFAULT_TIMEOUT_MS, RERANK_MAX_DOCUMENTS,
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
    /// Final 1-based rank after optional reranking.
    pub final_rank: u64,
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
    /// `corpus_not_embedded`, `embedding_lane_failed`, `rerank_backend_absent`,
    /// `rerank_failed_or_timed_out`.
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
    pub k: usize,
    /// How many merged candidates the optional rerank stage may reorder.
    pub rerank_top_n: usize,
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
            rerank_top_n: 50,
            rerank_timeout_ms: RERANK_DEFAULT_TIMEOUT_MS,
        }
    }
}

/// Embedding decorator that measures real calls without changing behavior.
struct CountingEmbed<'a> {
    inner: &'a dyn EmbedBackend,
    calls: AtomicU64,
    ok_calls: AtomicU64,
}

#[async_trait::async_trait]
impl<'a> EmbedBackend for CountingEmbed<'a> {
    async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self.inner.embed(texts).await;
        if result.is_ok() {
            self.ok_calls.fetch_add(1, Ordering::SeqCst);
        }
        result
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
    let rerank_top_n = options.rerank_top_n.clamp(1, RERANK_MAX_DOCUMENTS).min(k);
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
            k,
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
            if corpus.embedding_status().embedded_templates == 0 {
                degradations.push(HybridDegradation {
                    code: "corpus_not_embedded".into(),
                    detail: "corpus has no embedded templates; the production honesty gate keeps semantic ranking off".into(),
                });
            } else if cancelled(cancel) {
                return Err(CoreError::Cancelled);
            } else {
                let counting = CountingEmbed {
                    inner: backend,
                    calls: AtomicU64::new(0),
                    ok_calls: AtomicU64::new(0),
                };
                let search = EventSearchQuery {
                    query: Some(question.to_string()),
                    filter: options.filter.clone(),
                    semantic: true,
                    k,
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
                        // call actually succeeded.
                        if counting.ok_calls.load(Ordering::SeqCst) == 0 {
                            degradations.push(HybridDegradation {
                                code: "embedding_lane_failed".into(),
                                detail: "embedding backend produced no successful call; structured/keyword results kept".into(),
                            });
                        } else {
                            semantic_ran = true;
                        }
                        telemetry.embedding_latency_ms = Some(started.elapsed().as_millis() as u64);
                        scanned = scanned.saturating_add(result.scanned);
                        partial |= result.partial;
                        for (index, hit) in result.hits.into_iter().enumerate() {
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
    if ordered.len() > k {
        partial = true;
        ordered.truncate(k);
    }
    for (index, candidate) in ordered.iter_mut().enumerate() {
        candidate.pre_rerank_rank = index as u64 + 1;
        candidate.final_rank = candidate.pre_rerank_rank;
    }
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
        }
        Some(backend) => {
            if cancelled(cancel) {
                return Err(CoreError::Cancelled);
            }
            let top: Vec<String> = ordered
                .iter()
                .take(rerank_top_n)
                .map(|candidate| candidate.message.clone())
                .collect();
            let query_text = options
                .semantic_query
                .clone()
                .unwrap_or_else(|| options.keyword_terms.join(" "));
            let started = std::time::Instant::now();
            let scores = rerank_blocking(backend, &query_text, &top, options.rerank_timeout_ms);
            telemetry.rerank_latency_ms = Some(started.elapsed().as_millis() as u64);
            telemetry.rerank_calls = Some(1);
            match scores {
                None => degradations.push(HybridDegradation {
                    code: "rerank_failed_or_timed_out".into(),
                    detail: format!(
                        "rerank call failed or exceeded {} ms; pre-rerank order kept",
                        options.rerank_timeout_ms
                    ),
                }),
                Some(scores) => {
                    rerank_ran = true;
                    telemetry.rerank_model = Some(backend.identity());
                    for (candidate, score) in ordered.iter_mut().zip(scores.iter()) {
                        candidate.rerank_score = Some(*score);
                    }
                    // Reorder ONLY the reranked prefix; ties break on the
                    // retained pre-rerank rank for determinism.
                    let mut prefix: Vec<HybridCandidate> = ordered.drain(..top.len()).collect();
                    prefix.sort_by(|a, b| {
                        b.rerank_score
                            .unwrap_or(f32::NEG_INFINITY)
                            .total_cmp(&a.rerank_score.unwrap_or(f32::NEG_INFINITY))
                            .then(a.pre_rerank_rank.cmp(&b.pre_rerank_rank))
                    });
                    prefix.append(&mut ordered);
                    ordered = prefix;
                    for (index, candidate) in ordered.iter_mut().enumerate() {
                        candidate.final_rank = index as u64 + 1;
                    }
                }
            }
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
