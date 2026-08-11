//! Bounded retrieval-quality diagnostic: executable lanes over one imported
//! corpus, scored against host-owned truth.
//!
//! # What this measures, and what it does not
//!
//! It measures **retrieval**: which rows a lane returns, in what order, under
//! fixed budgets. It does **not** measure whether an answer built from those
//! rows was useful — that is a different measurement with a different failure
//! mode, and the report keeps the two in separate sections so a retrieval
//! regression cannot hide behind a good-looking answer. Nothing here proves
//! live model usefulness or provider compatibility.
//!
//! # Real production paths only
//!
//! Every lane executes through code the product actually runs:
//!
//! * `keyword` and `dense` lanes call [`cd_core::tool_host::ToolHost::execute`]
//!   with `search_logs` — the same tool surface a model uses, including its
//!   suppression lens and its trusted evidence identities.
//! * the `hybrid_rrf` lane calls [`crate::retrieval::hybrid_search`], the
//!   production reciprocal-rank-fusion path.
//! * backends come from [`crate::retrieval::build_embedding_backend`] and
//!   [`crate::retrieval::build_rerank_backend`], so dialects, SSRF policy,
//!   egress consent, and protected-file credential resolution are the
//!   production ones.
//!
//! There is no diagnostic-only retrieval algorithm and no second HTTP client.
//! A lane that cannot run says so; it never falls back to a lookalike.
//!
//! # Share-safe by default
//!
//! A report carries corpus identity, revisions, budgets, metrics, fingerprints,
//! and stable machine codes. It never carries endpoints, credentials, headers,
//! raw response bodies, corpus text, usernames, or absolute paths. Row
//! identities are durable `seq` numbers, which are meaningless outside the
//! corpus that produced them.
//!
//! # Never changes behaviour
//!
//! This is measurement. It never writes configuration, defaults, or readiness
//! stores. A failed lane is reported as degraded or inconclusive — never as a
//! reason to change what the product does.

pub mod metrics;
pub mod probes;

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use cd_core::config::{AppConfig, RetrievalRoleModel};
use cd_core::embed::EmbedBackend;
use cd_core::embedding_space::EmbeddingSpaceIdentity;
use cd_core::error::{CoreError, CoreResult};
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{
    plan_reanalysis, EventQuery, HybridOptions, LogCorpus, ReanalysisLocality, ReanalysisPlan,
};
use cd_core::process_progress::CancelFlag;
use cd_core::rerank::{rerank_blocking, RerankBackend, RERANK_DEFAULT_TIMEOUT_MS};
use cd_core::tool_host::ToolHost;

use metrics::{mean, QueryTruth, RankingMetrics};
use probes::{RerankSemanticsProbe, VectorStabilityProbe};

/// Wire schema id for [`RetrievalDiagnosticReport`].
pub const RETRIEVAL_DIAGNOSTIC_SCHEMA_ID: &str = "contextdesk.retrieval_diagnostic.v1";
/// Wire schema version.
pub const RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION: u32 = 1;

/// Bounded budget for one probe call.
const PROBE_TIMEOUT_MS: u64 = 5_000;

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/// One executable retrieval configuration under comparison.
///
/// The six lanes are the cross product of three retrieval strategies and the
/// optional rerank stage, which is the smallest set that can separate "the
/// embedder helped" from "the reranker helped" from "they only help together".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLane {
    /// Structured/keyword baseline through `search_logs`.
    KeywordBaseline,
    /// Semantic template retrieval through `search_logs`.
    Dense,
    /// Production reciprocal-rank fusion of both lanes.
    HybridRrf,
    /// Keyword baseline with the rerank stage attached.
    KeywordBaselineRerank,
    /// Dense retrieval with the rerank stage attached.
    DenseRerank,
    /// Hybrid RRF with the rerank stage attached.
    HybridRrfRerank,
}

impl DiagnosticLane {
    /// Every lane, in stable report order.
    pub const ALL: [DiagnosticLane; 6] = [
        Self::KeywordBaseline,
        Self::Dense,
        Self::HybridRrf,
        Self::KeywordBaselineRerank,
        Self::DenseRerank,
        Self::HybridRrfRerank,
    ];

    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeywordBaseline => "keyword_baseline",
            Self::Dense => "dense",
            Self::HybridRrf => "hybrid_rrf",
            Self::KeywordBaselineRerank => "keyword_baseline_rerank",
            Self::DenseRerank => "dense_rerank",
            Self::HybridRrfRerank => "hybrid_rrf_rerank",
        }
    }

    /// Whether this lane needs the selected embedder.
    pub fn uses_embedder(self) -> bool {
        !matches!(self, Self::KeywordBaseline | Self::KeywordBaselineRerank)
    }

    /// Whether this lane attaches the optional reranker.
    pub fn uses_reranker(self) -> bool {
        matches!(
            self,
            Self::KeywordBaselineRerank | Self::DenseRerank | Self::HybridRrfRerank
        )
    }

    /// Whether this lane executes through the production RRF path rather than
    /// the `search_logs` tool surface.
    pub fn uses_rrf(self) -> bool {
        matches!(self, Self::HybridRrf | Self::HybridRrfRerank)
    }
}

/// Whether a lane produced a scoreable result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneStatus {
    /// Ran to completion and produced a ranking.
    Executed,
    /// Ran but degraded (an optional role did not contribute); the ranking is
    /// real but narrower than requested.
    Degraded,
    /// Could not run (missing role, refused egress, unbound corpus).
    Blocked,
    /// Cancelled mid-run.
    Cancelled,
}

impl LaneStatus {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::Degraded => "degraded",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
        }
    }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// Budgets held identical across every lane.
///
/// Holding these fixed is what makes the comparison meaningful: a lane that
/// simply looked at more rows is not a better lane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticBudgets {
    /// Final candidate budget every lane returns.
    pub candidate_k: u32,
    /// Rerank candidate pool depth, always at least `candidate_k`.
    pub rerank_candidate_depth: u32,
    /// Character budget for the packed context a lane's rows would fill.
    /// Measured and reported; this diagnostic does not build an answer.
    pub packed_context_chars: u32,
    /// Wall-clock budget for one rerank request.
    pub rerank_timeout_ms: u64,
}

impl Default for DiagnosticBudgets {
    fn default() -> Self {
        Self {
            candidate_k: 10,
            rerank_candidate_depth: 40,
            packed_context_chars: 8_000,
            rerank_timeout_ms: RERANK_DEFAULT_TIMEOUT_MS,
        }
    }
}

impl DiagnosticBudgets {
    /// Clamp to the bounds every production path enforces.
    pub fn normalized(&self) -> Self {
        let candidate_k = self.candidate_k.clamp(1, 100);
        Self {
            candidate_k,
            rerank_candidate_depth: self.rerank_candidate_depth.clamp(candidate_k, 100),
            packed_context_chars: self.packed_context_chars.clamp(256, 200_000),
            rerank_timeout_ms: self.rerank_timeout_ms.clamp(100, 60_000),
        }
    }
}

/// One query with its host-owned truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticQuery {
    /// Stable id used in the report.
    pub query_id: String,
    /// Natural-language question driving the semantic lanes.
    pub question: String,
    /// Literal terms driving the keyword lane.
    pub keyword_terms: Vec<String>,
    /// Structured filter applied identically to every lane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// Host-owned truth. Never sent to any provider.
    pub truth: QueryTruth,
}

/// Everything one diagnostic run needs.
#[derive(Debug, Clone)]
pub struct DiagnosticRequest {
    /// Corpus to run against.
    pub corpus_id: String,
    /// Queries with host truth.
    pub queries: Vec<DiagnosticQuery>,
    /// Budgets held fixed across lanes.
    pub budgets: DiagnosticBudgets,
    /// Lanes to attempt, in report order.
    pub lanes: Vec<DiagnosticLane>,
    /// Explicit acknowledgement that retrieval inputs may leave this machine.
    /// Required before any non-loopback role is constructed.
    pub egress_acknowledged: bool,
}

impl DiagnosticRequest {
    /// Every lane, default budgets.
    pub fn new(corpus_id: impl Into<String>, queries: Vec<DiagnosticQuery>) -> Self {
        Self {
            corpus_id: corpus_id.into(),
            queries,
            budgets: DiagnosticBudgets::default(),
            lanes: DiagnosticLane::ALL.to_vec(),
            egress_acknowledged: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Plan (dry run)
// ---------------------------------------------------------------------------

/// What a run would do, computed without constructing a backend, reading a
/// credential, or contacting an endpoint. Always safe to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticPlan {
    /// Always [`RETRIEVAL_DIAGNOSTIC_SCHEMA_ID`].
    pub schema_id: String,
    /// Corpus under test.
    pub corpus_id: String,
    /// Lanes that would be attempted.
    pub lanes: Vec<String>,
    /// Queries that would run.
    pub query_ids: Vec<String>,
    /// Budgets, already normalized.
    pub budgets: DiagnosticBudgets,
    /// Configured embedder model, when one is enabled.
    pub embedder_model: Option<String>,
    /// Configured embedder dialect, when set explicitly.
    pub embedder_dialect: Option<String>,
    /// Configured reranker model, when one is enabled.
    pub reranker_model: Option<String>,
    /// Configured reranker dialect, when set explicitly.
    pub reranker_dialect: Option<String>,
    /// True when any enabled role points at a non-loopback endpoint.
    pub requires_egress_consent: bool,
    /// Whether the caller already acknowledged egress.
    pub egress_acknowledged: bool,
    /// Re-analysis the corpus would need before the dense lanes can run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reanalysis: Option<ReanalysisPlan>,
    /// Lanes that cannot run as configured, with the reason.
    pub blocked_lanes: Vec<BlockedLane>,
}

/// A lane that cannot run, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedLane {
    /// Lane label.
    pub lane: String,
    /// Stable machine code.
    pub code: String,
    /// Share-safe explanation.
    pub detail: String,
}

/// Whether a configured role points off this machine.
///
/// Delegates to the retrieval factory's own classifier so a plan can never
/// promise a locality the factory would refuse.
fn role_is_remote(role: &RetrievalRoleModel) -> bool {
    crate::retrieval::retrieval_endpoint_is_remote(role)
}

fn enabled_role(role: Option<&RetrievalRoleModel>) -> Option<&RetrievalRoleModel> {
    role.filter(|role| role.enabled)
}

/// Compute the plan for a request. Reads configuration and corpus metadata
/// only: no backend, no credential, no network.
pub fn plan_diagnostic(
    cache_root: &Path,
    request: &DiagnosticRequest,
    config: &AppConfig,
) -> CoreResult<DiagnosticPlan> {
    let budgets = request.budgets.normalized();
    let embedding = enabled_role(config.retrieval.embedding.as_ref());
    let reranker = enabled_role(config.retrieval.reranker.as_ref());
    let requires_egress_consent = [embedding, reranker]
        .into_iter()
        .flatten()
        .any(role_is_remote);

    let mut blocked = Vec::new();
    for lane in &request.lanes {
        if lane.uses_embedder() && embedding.is_none() {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "embedding_role_unconfigured".into(),
                detail: "no embedding role is enabled; this lane cannot run".into(),
            });
        }
        if lane.uses_reranker() && reranker.is_none() {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "rerank_role_unconfigured".into(),
                detail: "no reranker role is enabled; this lane cannot run".into(),
            });
        }
        // Dialects are mandatory for the diagnostic on BOTH roles. A parser
        // chosen from a URL or a model name is a guess, and a benchmark built
        // on a guessed parser measures the guess.
        if lane.uses_embedder()
            && embedding.is_some_and(|role| role.dialect.as_deref().unwrap_or("").trim().is_empty())
        {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "embedding_dialect_not_explicit".into(),
                detail: "the embedding role has no explicit dialect; a diagnostic never infers a \
                         parser from an endpoint or a model name"
                    .into(),
            });
        }
        if lane.uses_reranker()
            && reranker.is_some_and(|role| role.dialect.as_deref().unwrap_or("").trim().is_empty())
        {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "rerank_dialect_not_explicit".into(),
                detail: "the reranker role has no explicit dialect; a diagnostic never infers a \
                         parser from an endpoint or a model name"
                    .into(),
            });
        }
        if requires_egress_consent && !request.egress_acknowledged && lane.uses_embedder() {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "retrieval_egress_not_acknowledged".into(),
                detail: "a configured role is remote and egress was not acknowledged; query and \
                         candidate text would leave this machine"
                    .into(),
            });
        }
    }

    // A re-analysis plan is only meaningful once an embedding space is known.
    let reanalysis = match embedding {
        None => None,
        Some(role) => {
            let space = configured_embedding_space(role);
            // Locality comes from the ROLE, not the space: an endpoint
            // fingerprint is deliberately one-way, so it cannot tell a
            // loopback endpoint from a remote one.
            let locality = if role_is_remote(role) {
                ReanalysisLocality::Remote {
                    endpoint_fingerprint: space.endpoint_fingerprint.clone(),
                }
            } else {
                ReanalysisLocality::Local
            };
            plan_reanalysis(cache_root, &request.corpus_id, &space, locality).ok()
        }
    };

    Ok(DiagnosticPlan {
        schema_id: RETRIEVAL_DIAGNOSTIC_SCHEMA_ID.into(),
        corpus_id: request.corpus_id.clone(),
        lanes: request
            .lanes
            .iter()
            .map(|lane| lane.as_str().into())
            .collect(),
        query_ids: request
            .queries
            .iter()
            .map(|query| query.query_id.clone())
            .collect(),
        budgets,
        embedder_model: embedding.map(|role| role.model.clone()),
        embedder_dialect: embedding.and_then(|role| role.dialect.clone()),
        reranker_model: reranker.map(|role| role.model.clone()),
        reranker_dialect: reranker.and_then(|role| role.dialect.clone()),
        requires_egress_consent,
        egress_acknowledged: request.egress_acknowledged,
        reanalysis,
        blocked_lanes: blocked,
    })
}

/// The embedding space a configured role would produce, without constructing
/// the backend. Dimensions stay unmeasured: only real vectors can fill them.
pub fn configured_embedding_space(role: &RetrievalRoleModel) -> EmbeddingSpaceIdentity {
    EmbeddingSpaceIdentity::new(
        cd_core::capability_qualification::fingerprint_endpoint(&role.base_url),
        role.model.clone(),
        role.dialect
            .clone()
            .unwrap_or_else(|| "unclassified".into()),
    )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/// Corpus identity every lane ran against, so two reports cannot be compared
/// across different corpora by accident.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticCorpusIdentity {
    /// Corpus id.
    pub corpus_id: String,
    /// Event revision pinned for the run.
    pub event_revision: u64,
    /// Template-analysis revision pinned for the run.
    pub template_analysis_revision: u64,
    /// Events in the corpus.
    pub event_count: u64,
    /// Templates in the corpus.
    pub template_count: u64,
    /// Templates carrying vectors.
    pub embedded_templates: u64,
    /// Share-safe label of the stored embedding space, when bound.
    pub stored_space_label: Option<String>,
    /// Stable fingerprint of the stored embedding space, when bound.
    pub stored_space_fingerprint: Option<String>,
}

/// Measured execution facts for one lane.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LaneExecutionFacts {
    /// Wall-clock time across every query in this lane.
    pub latency_ms: u64,
    /// Embedding requests measured (`Some(0)` is a measured zero).
    pub embedding_calls: Option<u64>,
    /// Rerank requests measured.
    pub rerank_calls: Option<u64>,
    /// Merged candidates retained before truncation to K.
    pub candidate_pool_size: Option<u64>,
    /// Documents submitted to the rerank stage.
    pub rerank_pool_size: Option<u64>,
    /// Pinned anchors restored into the final K after reranking.
    pub anchors_promoted: Option<u64>,
    /// Retrieval mode that ACTUALLY executed, after degradations.
    pub mode_used: Option<String>,
    /// Stable degradation/fallback codes, deduplicated.
    pub fallback_codes: Vec<String>,
    /// Characters the returned rows would contribute to a packed context,
    /// measured against the fixed budget.
    pub packed_context_chars: u64,
    /// True when the rows exceeded the packed-context budget.
    pub packed_context_exceeded: bool,
}

/// One lane's complete result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LaneReport {
    /// Lane label.
    pub lane: String,
    /// Whether the lane produced a scoreable result.
    pub status: LaneStatus,
    /// Which production entry point executed (`tool_host_search_logs` or
    /// `workflow_hybrid_rrf`), so a reader can tell what was measured.
    pub engine: String,
    /// Exact embedder model that actually ran, when one did.
    pub embedding_model: Option<String>,
    /// Exact embedder dialect that actually ran.
    pub embedding_dialect: Option<String>,
    /// Fingerprint of the embedding space that actually ran.
    pub embedding_space_fingerprint: Option<String>,
    /// Exact reranker model that produced scores, when it did.
    pub rerank_model: Option<String>,
    /// Exact reranker dialect that produced scores.
    pub rerank_dialect: Option<String>,
    /// Per-query metrics.
    pub queries: Vec<RankingMetrics>,
    /// Mean recall across queries; `None` when nothing was measured.
    pub mean_recall_at_k: Option<f64>,
    /// Mean nDCG across queries.
    pub mean_ndcg_at_k: Option<f64>,
    /// Mean MRR across queries.
    pub mean_mrr: Option<f64>,
    /// Mean mandatory-anchor retention across queries.
    pub mean_mandatory_anchor_retention: Option<f64>,
    /// Mean decoy contamination across queries.
    pub mean_decoy_contamination: Option<f64>,
    /// Measured execution facts.
    pub execution: LaneExecutionFacts,
    /// Share-safe reason when the lane is blocked or cancelled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<BlockedLane>,
}

/// Explicit evidence labels. Every one of these is a claim the report is
/// careful NOT to make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticEvidenceLabels {
    /// What the retrieval section measured.
    pub retrieval_quality: String,
    /// Answer usefulness is a separate measurement and was not made.
    pub answer_usefulness: String,
    /// Provider compatibility/readiness was not evaluated.
    pub compatibility_readiness: String,
    /// This report never changes defaults or readiness evidence.
    pub effect_on_product: String,
}

impl Default for DiagnosticEvidenceLabels {
    fn default() -> Self {
        Self {
            retrieval_quality:
                "measured on this corpus against host-owned truth, under fixed budgets".into(),
            answer_usefulness: "not_evaluated".into(),
            compatibility_readiness: "not_evaluated".into(),
            effect_on_product:
                "measurement only; no default, configuration, or readiness store was written".into(),
        }
    }
}

/// Overall verdict. A failure is degraded or inconclusive — never a reason to
/// change what the product does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticVerdict {
    /// Every requested lane executed and every probe held.
    Executed,
    /// Lanes ran, but at least one degraded or a probe reported a finding.
    Degraded,
    /// Too little executed to compare lanes at all.
    Inconclusive,
}

impl DiagnosticVerdict {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::Degraded => "degraded",
            Self::Inconclusive => "inconclusive",
        }
    }
}

/// The complete diagnostic report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrievalDiagnosticReport {
    /// Always [`RETRIEVAL_DIAGNOSTIC_SCHEMA_ID`].
    pub schema_id: String,
    /// Always [`RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Corpus identity every lane shared.
    pub corpus: DiagnosticCorpusIdentity,
    /// Budgets held fixed across lanes.
    pub budgets: DiagnosticBudgets,
    /// Per-lane results, in requested order.
    pub lanes: Vec<LaneReport>,
    /// Embedder contract probe, when an embedder was selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_stability: Option<VectorStabilityProbe>,
    /// Reranker contract probe, when a reranker was selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerank_semantics: Option<RerankSemanticsProbe>,
    /// Honest evidence labels.
    pub evidence: DiagnosticEvidenceLabels,
    /// Overall verdict.
    pub verdict: DiagnosticVerdict,
}

impl RetrievalDiagnosticReport {
    /// Whether the run produced a comparison worth reading.
    pub fn comparable(&self) -> bool {
        self.lanes
            .iter()
            .filter(|lane| matches!(lane.status, LaneStatus::Executed | LaneStatus::Degraded))
            .count()
            >= 2
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.is_some_and(CancelFlag::is_cancelled)
}

/// Bridge one async embed call onto a fresh runtime under a hard budget,
/// mirroring the production `embed_blocking` seam rather than adding a second
/// transport.
fn embed_batch_blocking(
    backend: &dyn EmbedBackend,
    texts: &[String],
    timeout_ms: u64,
) -> Option<Vec<Vec<f32>>> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                runtime
                    .block_on(async {
                        tokio::time::timeout(
                            std::time::Duration::from_millis(timeout_ms),
                            backend.embed(texts),
                        )
                        .await
                    })
                    .ok()?
                    .ok()
            })
            .join()
            .unwrap_or(None)
    })
}

/// Run the two contract probes against the selected roles.
///
/// Probes use synthetic strings only, so running them never sends corpus text
/// anywhere. They are skipped entirely when the corresponding role is absent.
pub fn run_probes(
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    timeout_ms: u64,
) -> (Option<VectorStabilityProbe>, Option<RerankSemanticsProbe>) {
    let vector = embed.map(|backend| {
        let space = backend.space();
        probes::probe_vector_stability(backend, &space, |texts| {
            embed_batch_blocking(backend, texts, timeout_ms)
        })
    });
    let rerank_probe = rerank.map(|backend| {
        probes::probe_rerank_semantics(backend, |query, documents| {
            rerank_blocking(backend, query, documents, timeout_ms)
        })
    });
    (vector, rerank_probe)
}

fn dedupe_preserving_order(seqs: impl IntoIterator<Item = u64>, limit: usize) -> Vec<u64> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for seq in seqs {
        if out.len() >= limit {
            break;
        }
        if seen.insert(seq) {
            out.push(seq);
        }
    }
    out
}

/// Execute one lane over every query and score it.
///
/// `host` is a real [`ToolHost`] with log analysis enabled; the caller decides
/// which optional roles are attached to it for this lane, so a lane never gets
/// a capability its configuration did not grant.
#[allow(clippy::too_many_arguments)]
async fn run_lane(
    lane: DiagnosticLane,
    host: &mut ToolHost,
    cache_root: &Path,
    request: &DiagnosticRequest,
    config: &AppConfig,
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    budgets: &DiagnosticBudgets,
    cancel: Option<&CancelFlag>,
) -> LaneReport {
    let started = std::time::Instant::now();
    let mut report = LaneReport {
        lane: lane.as_str().into(),
        status: LaneStatus::Executed,
        engine: if lane.uses_rrf() {
            "workflow_hybrid_rrf"
        } else {
            "tool_host_search_logs"
        }
        .into(),
        embedding_model: None,
        embedding_dialect: None,
        embedding_space_fingerprint: None,
        rerank_model: None,
        rerank_dialect: None,
        queries: Vec::new(),
        mean_recall_at_k: None,
        mean_ndcg_at_k: None,
        mean_mrr: None,
        mean_mandatory_anchor_retention: None,
        mean_decoy_contamination: None,
        execution: LaneExecutionFacts::default(),
        blocked_reason: None,
    };
    if lane.uses_embedder() {
        if let Some(role) = enabled_role(config.retrieval.embedding.as_ref()) {
            let space = configured_embedding_space(role);
            report.embedding_model = Some(role.model.clone());
            report.embedding_dialect = role.dialect.clone();
            report.embedding_space_fingerprint = Some(space.fingerprint());
        }
    }
    if lane.uses_reranker() {
        if let Some(role) = enabled_role(config.retrieval.reranker.as_ref()) {
            report.rerank_model = Some(role.model.clone());
            report.rerank_dialect = role.dialect.clone();
        }
    }

    let mut fallback_codes: BTreeSet<String> = BTreeSet::new();
    let mut degraded = false;
    let mut packed_chars = 0u64;

    for query in &request.queries {
        if cancelled(cancel) {
            report.status = LaneStatus::Cancelled;
            report.execution.latency_ms = started.elapsed().as_millis() as u64;
            return report;
        }
        let outcome = if lane.uses_rrf() {
            run_rrf_query(
                cache_root, request, embed, rerank, budgets, query, lane, cancel,
            )
        } else {
            run_tool_host_query(host, &request.corpus_id, budgets, query, lane).await
        };
        match outcome {
            Err(error) => {
                report.status = LaneStatus::Blocked;
                report.blocked_reason = Some(BlockedLane {
                    lane: lane.as_str().into(),
                    code: "lane_execution_failed".into(),
                    detail: redact(&error.to_string()),
                });
                report.execution.latency_ms = started.elapsed().as_millis() as u64;
                return report;
            }
            Ok(result) => {
                for code in result.fallback_codes {
                    degraded = true;
                    fallback_codes.insert(code);
                }
                if let Some(model) = result.embedding_model {
                    report.embedding_model = Some(model);
                }
                if let Some(model) = result.rerank_model {
                    report.rerank_model = Some(model);
                }
                if let Some(dialect) = result.rerank_dialect {
                    report.rerank_dialect = Some(dialect);
                }
                if result.mode_used.is_some() {
                    report.execution.mode_used = result.mode_used;
                }
                accumulate(
                    &mut report.execution.embedding_calls,
                    result.embedding_calls,
                );
                accumulate(&mut report.execution.rerank_calls, result.rerank_calls);
                report.execution.candidate_pool_size = max_opt(
                    report.execution.candidate_pool_size,
                    result.candidate_pool_size,
                );
                report.execution.rerank_pool_size =
                    max_opt(report.execution.rerank_pool_size, result.rerank_pool_size);
                accumulate(
                    &mut report.execution.anchors_promoted,
                    result.anchors_promoted,
                );
                packed_chars = packed_chars.saturating_add(result.packed_chars);
                report.queries.push(metrics::score_ranking(
                    &query.query_id,
                    &result.ranked_seqs,
                    &query.truth,
                    budgets.candidate_k,
                ));
            }
        }
    }

    report.execution.latency_ms = started.elapsed().as_millis() as u64;
    report.execution.fallback_codes = fallback_codes.into_iter().collect();
    report.execution.packed_context_chars = packed_chars;
    report.execution.packed_context_exceeded =
        packed_chars > u64::from(budgets.packed_context_chars);
    report.mean_recall_at_k = mean(report.queries.iter().map(|row| row.recall_at_k));
    report.mean_ndcg_at_k = mean(report.queries.iter().map(|row| row.ndcg_at_k));
    report.mean_mrr = mean(report.queries.iter().map(|row| row.mrr));
    report.mean_mandatory_anchor_retention = mean(
        report
            .queries
            .iter()
            .map(|row| row.mandatory_anchor_retention),
    );
    report.mean_decoy_contamination =
        mean(report.queries.iter().map(|row| row.decoy_contamination));
    if report.status == LaneStatus::Executed && degraded {
        report.status = LaneStatus::Degraded;
    }
    report
}

fn accumulate(slot: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *slot = Some(slot.unwrap_or(0).saturating_add(value));
    }
}

fn max_opt(slot: Option<u64>, value: Option<u64>) -> Option<u64> {
    match (slot, value) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, value) => value,
    }
}

/// One query's execution result, engine-agnostic.
struct LaneQueryOutcome {
    ranked_seqs: Vec<u64>,
    packed_chars: u64,
    fallback_codes: Vec<String>,
    embedding_calls: Option<u64>,
    rerank_calls: Option<u64>,
    candidate_pool_size: Option<u64>,
    rerank_pool_size: Option<u64>,
    anchors_promoted: Option<u64>,
    mode_used: Option<String>,
    embedding_model: Option<String>,
    rerank_model: Option<String>,
    rerank_dialect: Option<String>,
}

/// Execute one query through the REAL `search_logs` tool surface.
async fn run_tool_host_query(
    host: &mut ToolHost,
    corpus_id: &str,
    budgets: &DiagnosticBudgets,
    query: &DiagnosticQuery,
    lane: DiagnosticLane,
) -> CoreResult<LaneQueryOutcome> {
    let mut arguments = serde_json::json!({
        // Scope the tool explicitly to the corpus under test: a diagnostic
        // must never inherit whatever corpus the host happened to have open.
        "corpus": corpus_id,
        "query": query.question,
        "semantic": lane.uses_embedder(),
        "k": budgets.candidate_k,
    });
    if let Some(level) = &query.level {
        arguments["level"] = serde_json::Value::String(level.clone());
    }
    let result = host.execute("search_logs", &arguments, None).await?;
    if !result.ok {
        return Err(CoreError::Message(
            "search_logs did not complete for this lane".into(),
        ));
    }
    // Trusted, host-owned identities — never reconstructed from rendered text.
    let ranked_seqs = dedupe_preserving_order(
        result.log_evidence.iter().map(|identity| identity.seq),
        budgets.candidate_k as usize,
    );
    let mut fallback_codes = Vec::new();
    if lane.uses_reranker()
        && !result
            .detail_raw
            .contains("retrieval_reranker_applied: true")
    {
        fallback_codes.push("rerank_not_applied".into());
    }
    if lane.uses_embedder() && ranked_seqs.is_empty() {
        fallback_codes.push("semantic_lane_returned_nothing".into());
    }
    Ok(LaneQueryOutcome {
        packed_chars: result.detail_for_model.chars().count() as u64,
        ranked_seqs,
        fallback_codes,
        // The tool surface does not expose per-call provider counts; unknown
        // stays unknown rather than being fabricated as a measured zero.
        embedding_calls: None,
        rerank_calls: None,
        candidate_pool_size: None,
        rerank_pool_size: None,
        anchors_promoted: None,
        mode_used: Some(
            if lane.uses_embedder() {
                "tool_host_semantic"
            } else {
                "tool_host_keyword"
            }
            .into(),
        ),
        embedding_model: None,
        rerank_model: None,
        rerank_dialect: None,
    })
}

/// Execute one query through the production reciprocal-rank-fusion path.
#[allow(clippy::too_many_arguments)]
fn run_rrf_query(
    cache_root: &Path,
    request: &DiagnosticRequest,
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    budgets: &DiagnosticBudgets,
    query: &DiagnosticQuery,
    lane: DiagnosticLane,
    cancel: Option<&CancelFlag>,
) -> CoreResult<LaneQueryOutcome> {
    // A lane without a role must not silently inherit the configured one, so
    // the backend this lane is not entitled to is dropped here rather than
    // being passed and hopefully ignored.
    let embed = lane.uses_embedder().then_some(embed).flatten();
    let rerank = lane.uses_reranker().then_some(rerank).flatten();
    let options = HybridOptions {
        keyword_terms: query.keyword_terms.clone(),
        semantic_query: lane.uses_embedder().then(|| query.question.clone()),
        filter: EventQuery {
            levels: query.level.iter().cloned().collect(),
            ..EventQuery::default()
        },
        k: budgets.candidate_k as usize,
        rerank_candidate_depth: budgets.rerank_candidate_depth as usize,
        rerank_timeout_ms: budgets.rerank_timeout_ms,
    };
    let outcome = crate::retrieval::hybrid_search_with_backends(
        cache_root,
        &request.corpus_id,
        &options,
        embed,
        rerank,
        cancel,
    )?;
    let packed_chars = outcome
        .candidates
        .iter()
        .map(|candidate| candidate.message.chars().count() as u64)
        .sum();
    Ok(LaneQueryOutcome {
        ranked_seqs: outcome.candidates.iter().map(|c| c.seq).collect(),
        packed_chars,
        fallback_codes: outcome
            .degradations
            .iter()
            .map(|degradation| degradation.code.clone())
            .collect(),
        embedding_calls: outcome.telemetry.embedding_calls,
        rerank_calls: outcome.telemetry.rerank_calls,
        candidate_pool_size: outcome.telemetry.candidate_pool_size,
        rerank_pool_size: outcome.telemetry.rerank_pool_size,
        anchors_promoted: outcome.telemetry.anchors_promoted,
        mode_used: Some(outcome.mode_used.as_str().into()),
        embedding_model: outcome.telemetry.embedding_model,
        rerank_model: outcome.telemetry.rerank_model,
        rerank_dialect: outcome.telemetry.rerank_dialect,
    })
}

/// Strip anything that could carry an endpoint, a credential, or a path out of
/// a message that reaches the report.
///
/// This is the last line of defence, not the first: adapters already withhold
/// bodies and headers. It exists because an error string is the one place a
/// URL reliably leaks.
pub fn redact(message: &str) -> String {
    /// Tokens that introduce a credential. The token AFTER one of these is the
    /// secret itself, which is why matching the marker alone is not enough.
    const CREDENTIAL_MARKERS: [&str; 5] = ["bearer", "authorization", "api_key", "apikey", "token"];
    let mut out = String::with_capacity(message.len());
    let mut redact_next = false;
    for token in message.split_whitespace() {
        let lowered = token.to_ascii_lowercase();
        let marker = CREDENTIAL_MARKERS
            .iter()
            .any(|candidate| lowered.contains(candidate));
        let sensitive = redact_next
            || marker
            || lowered.contains("http://")
            || lowered.contains("https://")
            || token.starts_with('/')
            || token.starts_with("~/")
            || (token.len() > 2 && token.as_bytes()[1] == b':' && token.contains('\\'));
        redact_next = marker;
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(if sensitive { "[redacted]" } else { token });
    }
    out
}

/// Run the full diagnostic.
///
/// The caller supplies a real [`ToolHost`] factory so the lanes execute
/// through the same host the product uses. `attach_roles` is invoked per lane
/// with the roles that lane is allowed to use, so a lane can never borrow a
/// capability its configuration did not grant.
pub async fn run_diagnostic(
    cache_root: &Path,
    request: &DiagnosticRequest,
    config: &AppConfig,
    secrets: Option<&dyn SecretStore>,
    mut host_for_lane: impl FnMut(DiagnosticLane) -> CoreResult<ToolHost>,
    cancel: Option<&CancelFlag>,
) -> CoreResult<RetrievalDiagnosticReport> {
    let budgets = request.budgets.normalized();
    let plan = plan_diagnostic(cache_root, request, config)?;

    let corpus = LogCorpus::open(cache_root, &request.corpus_id)?;
    let binding = corpus.embedding_status();
    let identity = DiagnosticCorpusIdentity {
        corpus_id: request.corpus_id.clone(),
        event_revision: corpus.revision(),
        template_analysis_revision: corpus.template_revision(),
        event_count: corpus.event_count() as u64,
        template_count: binding.total_templates,
        embedded_templates: binding.embedded_templates,
        stored_space_label: binding
            .space
            .as_ref()
            .map(EmbeddingSpaceIdentity::report_label),
        stored_space_fingerprint: binding
            .space
            .as_ref()
            .map(EmbeddingSpaceIdentity::fingerprint),
    };
    drop(corpus);

    // Build the roles ONCE. Constructing per lane would read the configured
    // credential once per lane, turning a six-lane comparison into six
    // credential reads for no measurement benefit.
    let embed: Option<Arc<dyn EmbedBackend>> =
        match enabled_role(config.retrieval.embedding.as_ref()) {
            None => None,
            Some(role) => crate::retrieval::build_embedding_backend(role, secrets).ok(),
        };
    let rerank: Option<Arc<dyn RerankBackend>> =
        match enabled_role(config.retrieval.reranker.as_ref()) {
            None => None,
            Some(role) => crate::retrieval::build_rerank_backend(role, secrets).ok(),
        };
    let (vector_stability, rerank_semantics) = run_probes(
        embed.as_deref(),
        rerank.as_deref(),
        PROBE_TIMEOUT_MS.min(budgets.rerank_timeout_ms.max(PROBE_TIMEOUT_MS)),
    );

    let mut lanes = Vec::new();
    for lane in &request.lanes {
        if let Some(blocked) = plan
            .blocked_lanes
            .iter()
            .find(|blocked| blocked.lane == lane.as_str())
        {
            lanes.push(LaneReport {
                lane: lane.as_str().into(),
                status: LaneStatus::Blocked,
                engine: if lane.uses_rrf() {
                    "workflow_hybrid_rrf"
                } else {
                    "tool_host_search_logs"
                }
                .into(),
                embedding_model: None,
                embedding_dialect: None,
                embedding_space_fingerprint: None,
                rerank_model: None,
                rerank_dialect: None,
                queries: Vec::new(),
                mean_recall_at_k: None,
                mean_ndcg_at_k: None,
                mean_mrr: None,
                mean_mandatory_anchor_retention: None,
                mean_decoy_contamination: None,
                execution: LaneExecutionFacts::default(),
                blocked_reason: Some(blocked.clone()),
            });
            continue;
        }
        let mut host = host_for_lane(*lane)?;
        // Attach only what this lane is entitled to.
        if lane.uses_embedder() {
            if let (Some(backend), Some(role)) =
                (&embed, enabled_role(config.retrieval.embedding.as_ref()))
            {
                host.set_log_embed_backend(Some(Arc::clone(backend)), &role.model);
            }
        } else {
            host.set_log_embed_backend(None, "");
        }
        host.set_log_rerank_backend(if lane.uses_reranker() {
            rerank.as_ref().map(Arc::clone)
        } else {
            None
        });
        lanes.push(
            run_lane(
                *lane,
                &mut host,
                cache_root,
                request,
                config,
                embed.as_deref(),
                rerank.as_deref(),
                &budgets,
                cancel,
            )
            .await,
        );
    }

    let executed = lanes
        .iter()
        .filter(|lane| lane.status == LaneStatus::Executed)
        .count();
    let usable = lanes
        .iter()
        .filter(|lane| matches!(lane.status, LaneStatus::Executed | LaneStatus::Degraded))
        .count();
    let probes_healthy = vector_stability
        .as_ref()
        .map(VectorStabilityProbe::healthy)
        .unwrap_or(true)
        && rerank_semantics
            .as_ref()
            .map(RerankSemanticsProbe::healthy)
            .unwrap_or(true);
    let verdict = if usable < 2 {
        // Fewer than two usable lanes is not a comparison. Saying so is the
        // honest outcome; a single-lane "winner" would be meaningless.
        DiagnosticVerdict::Inconclusive
    } else if executed == lanes.len() && probes_healthy {
        DiagnosticVerdict::Executed
    } else {
        DiagnosticVerdict::Degraded
    };

    Ok(RetrievalDiagnosticReport {
        schema_id: RETRIEVAL_DIAGNOSTIC_SCHEMA_ID.into(),
        schema_version: RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
        corpus: identity,
        budgets,
        lanes,
        vector_stability,
        rerank_semantics,
        evidence: DiagnosticEvidenceLabels::default(),
        verdict,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_never_let_the_pool_be_narrower_than_k() {
        let budgets = DiagnosticBudgets {
            candidate_k: 20,
            rerank_candidate_depth: 5,
            packed_context_chars: 10,
            rerank_timeout_ms: 1,
        }
        .normalized();
        assert_eq!(budgets.candidate_k, 20);
        assert_eq!(budgets.rerank_candidate_depth, 20);
        assert_eq!(budgets.packed_context_chars, 256);
        assert_eq!(budgets.rerank_timeout_ms, 100);
    }

    #[test]
    fn lane_role_requirements_are_explicit() {
        assert!(!DiagnosticLane::KeywordBaseline.uses_embedder());
        assert!(!DiagnosticLane::KeywordBaseline.uses_reranker());
        assert!(DiagnosticLane::Dense.uses_embedder());
        assert!(DiagnosticLane::HybridRrf.uses_rrf());
        assert!(DiagnosticLane::KeywordBaselineRerank.uses_reranker());
        assert!(!DiagnosticLane::KeywordBaselineRerank.uses_embedder());
        assert!(DiagnosticLane::HybridRrfRerank.uses_embedder());
        assert!(DiagnosticLane::HybridRrfRerank.uses_reranker());
        assert!(DiagnosticLane::HybridRrfRerank.uses_rrf());
        assert_eq!(DiagnosticLane::ALL.len(), 6);
    }

    #[test]
    fn redaction_removes_endpoints_credentials_and_absolute_paths() {
        let dirty = "rerank transport: error sending request for url \
                     https://gateway.example/v1/rerank authorization Bearer sk-secret \
                     /Users/someone/.contextdesk/cache C:\\Users\\someone\\cache";
        let clean = redact(dirty);
        assert!(!clean.contains("https://"));
        assert!(!clean.contains("sk-secret"));
        assert!(!clean.contains("/Users/"));
        assert!(!clean.contains("C:\\Users"));
        assert!(clean.contains("[redacted]"));
        // The non-sensitive shape of the message survives, so the reason is
        // still readable.
        assert!(clean.contains("rerank"));
        assert!(clean.contains("transport:"));
    }

    #[test]
    fn evidence_labels_never_claim_answer_usefulness_or_readiness() {
        let labels = DiagnosticEvidenceLabels::default();
        assert_eq!(labels.answer_usefulness, "not_evaluated");
        assert_eq!(labels.compatibility_readiness, "not_evaluated");
        assert!(labels.effect_on_product.contains("measurement only"));
        assert!(!labels.retrieval_quality.contains("useful"));
    }

    #[test]
    fn a_single_usable_lane_is_inconclusive_not_a_winner() {
        // Encoded in `run_diagnostic`; asserted here on the same predicate the
        // report exposes so the rule cannot drift silently.
        let report = RetrievalDiagnosticReport {
            schema_id: RETRIEVAL_DIAGNOSTIC_SCHEMA_ID.into(),
            schema_version: RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
            corpus: DiagnosticCorpusIdentity {
                corpus_id: "c".into(),
                event_revision: 1,
                template_analysis_revision: 1,
                event_count: 1,
                template_count: 1,
                embedded_templates: 0,
                stored_space_label: None,
                stored_space_fingerprint: None,
            },
            budgets: DiagnosticBudgets::default(),
            lanes: vec![LaneReport {
                lane: "keyword_baseline".into(),
                status: LaneStatus::Executed,
                engine: "tool_host_search_logs".into(),
                embedding_model: None,
                embedding_dialect: None,
                embedding_space_fingerprint: None,
                rerank_model: None,
                rerank_dialect: None,
                queries: Vec::new(),
                mean_recall_at_k: None,
                mean_ndcg_at_k: None,
                mean_mrr: None,
                mean_mandatory_anchor_retention: None,
                mean_decoy_contamination: None,
                execution: LaneExecutionFacts::default(),
                blocked_reason: None,
            }],
            vector_stability: None,
            rerank_semantics: None,
            evidence: DiagnosticEvidenceLabels::default(),
            verdict: DiagnosticVerdict::Inconclusive,
        };
        assert!(!report.comparable());
    }

    #[test]
    fn remote_roles_are_classified_conservatively() {
        let role = |base_url: &str| RetrievalRoleModel {
            enabled: true,
            base_url: base_url.into(),
            model: "m".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
        };
        assert!(!role_is_remote(&role("http://127.0.0.1:11434")));
        assert!(!role_is_remote(&role("http://localhost:8080")));
        // `Url::host_str` keeps the brackets on an IPv6 literal, so `[::1]`
        // does not parse as an address and is classified remote. That is the
        // safe direction (it asks for consent it did not strictly need) and it
        // matches `cd_workflow::retrieval` exactly, so the diagnostic never
        // promises a lane the production factory will then refuse.
        assert!(role_is_remote(&role("http://[::1]:8080")));
        // A private address is still another machine.
        assert!(role_is_remote(&role("http://10.0.0.5:8080")));
        assert!(role_is_remote(&role("https://gateway.example")));
        // An unparseable endpoint is never assumed local.
        assert!(role_is_remote(&role("not a url")));
    }
}
