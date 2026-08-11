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
    /// Include the raw ranked row identities each lane returned.
    ///
    /// Off by default. The identities are durable `seq` numbers, which are
    /// meaningless without the corpus that produced them — but they still say
    /// exactly which rows of someone's logs a query surfaced, which is more
    /// than a share-safe artifact should carry. Callers must obtain explicit,
    /// separate consent before setting this.
    pub include_raw: bool,
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
            include_raw: false,
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
        // Egress consent covers BOTH roles. A remote reranker receives the
        // candidate documents themselves, so a rerank lane leaks at least as
        // much as a dense one; gating only the embedder would let candidate
        // text leave the machine under an unacknowledged consent.
        let remote_role_for_lane = (lane.uses_embedder() && embedding.is_some_and(role_is_remote))
            || (lane.uses_reranker() && reranker.is_some_and(role_is_remote));
        if !request.egress_acknowledged && remote_role_for_lane {
            blocked.push(BlockedLane {
                lane: lane.as_str().into(),
                code: "retrieval_egress_not_acknowledged".into(),
                detail: "a role this lane needs is remote and egress was not acknowledged; query \
                         and candidate text would leave this machine"
                    .into(),
            });
        }
        // A private-network endpoint is refused by the shared SSRF policy that
        // chat also uses. Saying so here, before construction, is the
        // difference between an employer gateway that is explicitly not
        // permitted and one whose factory error was swallowed into a lane that
        // looks merely unconfigured.
        for (needed, role, role_name) in [
            (lane.uses_embedder(), embedding, "embedding"),
            (lane.uses_reranker(), reranker, "reranker"),
        ] {
            if needed
                && role.is_some_and(|role| {
                    classify_endpoint(&role.base_url) == EndpointLocality::PrivateNetwork
                })
            {
                blocked.push(BlockedLane {
                    lane: lane.as_str().into(),
                    code: "retrieval_private_network_not_permitted".into(),
                    detail: format!(
                        "the {role_name} role points at a private-network address; retrieval uses \
                         the same SSRF policy as chat, which refuses private ranges without an \
                         explicit deployment override"
                    ),
                });
            }
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
///
/// The endpoint is fingerprinted through
/// [`cd_core::embed::embedding_endpoint_for_dialect`], which is the same
/// normalization the adapter applies before reporting its own space. Taking
/// the fingerprint from the bare configured base URL instead would make this
/// value differ from the one the corpus stores for byte-identical
/// configuration — a plan would name one embedding space, reanalysis would
/// write another, and the mismatch would be invisible in both artifacts.
///
/// A dialect this build cannot serve has no known route, so the bare base URL
/// is used and the space stays `unclassified`; the diagnostic blocks such a
/// lane before it can be measured.
pub fn configured_embedding_space(role: &RetrievalRoleModel) -> EmbeddingSpaceIdentity {
    let dialect = role
        .dialect
        .clone()
        .unwrap_or_else(|| "unclassified".into());
    let endpoint = cd_core::embed::embedding_endpoint_for_dialect(&role.base_url, &dialect)
        .unwrap_or_else(|| role.base_url.clone());
    EmbeddingSpaceIdentity::new(
        cd_core::capability_qualification::fingerprint_endpoint(&endpoint),
        role.model.clone(),
        dialect,
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
    /// Suppression sidecar revision pinned for the run.
    ///
    /// Suppression decides which rows a query can see at all, so a suppression
    /// edit mid-run changes the corpus every later lane is measured against
    /// just as surely as an ingest does.
    pub suppression_revision: u64,
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
    /// Raw ranked row identities, present ONLY when the caller explicitly
    /// opted in. Absent by default so the report stays share-safe.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_rankings: Vec<RawRanking>,
}

/// The exact rows one lane returned for one query, in rank order.
///
/// Local-only: `seq` numbers are meaningless outside their corpus, but they
/// still identify which rows of someone's logs a query surfaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRanking {
    /// Query these rows answered.
    pub query_id: String,
    /// Durable event identities, rank 1 first.
    pub ranked_seqs: Vec<u64>,
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
    /// Whether the corpus held still for the whole run.
    pub corpus_stability: CorpusStability,
    /// Whether every published fingerprint describes the endpoint that ran.
    pub fingerprint_agreement: FingerprintAgreement,
    /// Honest evidence labels.
    pub evidence: DiagnosticEvidenceLabels,
    /// Overall verdict.
    pub verdict: DiagnosticVerdict,
}

/// Whether the corpus under test changed while it was being measured.
///
/// A retrieval comparison is only a comparison if every lane saw the same
/// corpus. An ingest, a re-analysis, or a suppression edit between lanes — or
/// between two queries of one lane — silently replaces the thing being
/// measured, and the per-lane numbers stay confidently wrong. The run pins all
/// three revisions up front and re-reads them before each lane, after each
/// lane, and once at the end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorpusStability {
    /// Event revision pinned when the run began.
    pub pinned_event_revision: u64,
    /// Template-analysis revision pinned when the run began.
    pub pinned_template_analysis_revision: u64,
    /// Suppression revision pinned when the run began.
    pub pinned_suppression_revision: u64,
    /// True when any pinned revision moved during the run.
    pub drifted: bool,
    /// Which revisions moved, share-safe. Empty when nothing drifted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drifted_fields: Vec<String>,
    /// Where the drift was first observed, share-safe. `None` when stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}

impl CorpusStability {
    /// Whether the run measured one unchanging corpus.
    pub fn stable(&self) -> bool {
        !self.drifted
    }
}

/// Whether the endpoint fingerprints published across the report describe the
/// same concrete endpoint and dialect that actually served the run.
///
/// The corpus stores the space its adapter reported; a plan computes one from
/// configuration; a lane publishes one per run. If those are derived
/// differently they can disagree for byte-identical configuration, and every
/// "does this corpus match this embedder" reading taken from the report is
/// then meaningless.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FingerprintAgreement {
    /// True when the configured space and the built backend's space matched.
    /// `None` when no embedding backend was built for this run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_matches_backend: Option<bool>,
    /// True when the corpus's stored space matched the backend that ran.
    /// `None` when the corpus has no stored space or no backend was built.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_matches_backend: Option<bool>,
    /// Share-safe notes on any disagreement. Empty when everything agreed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<String>,
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
// Corpus pinning
// ---------------------------------------------------------------------------

/// The three revisions that together decide what a query can see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CorpusPin {
    event: u64,
    template: u64,
    suppression: u64,
}

/// Read the pin without holding the corpus open.
///
/// The handle is dropped before returning so re-reading later observes what is
/// on disk now rather than what this process cached.
fn read_corpus_pin(cache_root: &Path, corpus_id: &str) -> CoreResult<CorpusPin> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    // A corpus with no suppression sidecar loads as revision zero, so an error
    // here means the sidecar exists and could not be read. Defaulting that to
    // zero would report a corpus whose visibility rules became unreadable
    // mid-run as perfectly stable — the exact silent drift this pin exists to
    // catch — so it is propagated instead.
    let suppression = cd_core::log_analysis::load_suppression_document(&corpus)?.revision;
    Ok(CorpusPin {
        event: corpus.revision(),
        template: corpus.template_revision(),
        suppression,
    })
}

impl CorpusPin {
    /// Names of the revisions that differ, share-safe and stable.
    fn drift_from(&self, pinned: &CorpusPin) -> Vec<String> {
        let mut fields = Vec::new();
        if self.event != pinned.event {
            fields.push("event_revision".to_string());
        }
        if self.template != pinned.template {
            fields.push("template_analysis_revision".to_string());
        }
        if self.suppression != pinned.suppression {
            fields.push("suppression_revision".to_string());
        }
        fields
    }
}

// ---------------------------------------------------------------------------
// Role construction
// ---------------------------------------------------------------------------

/// Why a role this run needed could not be built.
///
/// Kept as a value rather than a swallowed `Err` so the lanes that depend on
/// the role are blocked with the real reason instead of quietly running
/// without the capability they were supposed to be measuring.
#[derive(Debug, Clone)]
struct RoleFailure {
    code: &'static str,
    detail: String,
}

/// A role slot for this run: not needed, built, or failed.
enum RoleSlot<T: ?Sized> {
    /// No selected lane needs this role, so it was never constructed and no
    /// credential was read for it.
    NotRequired,
    /// Configuration does not enable this role.
    Unconfigured,
    /// Built successfully.
    Built(Arc<T>),
    /// Required but could not be built.
    Failed(RoleFailure),
}

impl<T: ?Sized> RoleSlot<T> {
    fn built(&self) -> Option<&Arc<T>> {
        match self {
            Self::Built(backend) => Some(backend),
            _ => None,
        }
    }

    fn failure(&self) -> Option<&RoleFailure> {
        match self {
            Self::Failed(failure) => Some(failure),
            _ => None,
        }
    }
}

/// Classify a configured endpoint against the retrieval egress policy.
///
/// Retrieval deliberately shares chat's [`cd_core::ssrf::SsrfPolicy::default`]:
/// loopback is allowed, private ranges are refused unless a caller opts in.
/// Stating that here — and blocking a private-address lane with a named code
/// before anything is constructed — is what keeps an employer gateway from
/// being either silently allowed or silently denied. Without it the factory
/// refuses the connection deep inside adapter construction, and a swallowed
/// error looks identical to "the role simply was not configured".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointLocality {
    /// Loopback: no egress, always permitted.
    Loopback,
    /// RFC1918 / CGNAT literal: another machine on a private network. Refused
    /// by the shared policy unless the deployment overrides it.
    PrivateNetwork,
    /// Anything else, including every DNS name: treated as public egress.
    PublicInternet,
}

fn classify_endpoint(base_url: &str) -> EndpointLocality {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        // Never assume an unparseable endpoint is local.
        return EndpointLocality::PublicInternet;
    };
    let Some(host) = url.host_str() else {
        return EndpointLocality::PublicInternet;
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return EndpointLocality::Loopback;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_loopback() => EndpointLocality::Loopback,
        Ok(std::net::IpAddr::V4(v4)) if v4.is_private() || is_cgnat(v4) => {
            EndpointLocality::PrivateNetwork
        }
        Ok(std::net::IpAddr::V6(v6)) if is_unique_local(v6) => EndpointLocality::PrivateNetwork,
        // A hostname cannot be classified without resolving it, and resolving
        // is network. Public is the conservative reading: it asks for consent
        // it may not have needed rather than skipping a consent it did.
        _ => EndpointLocality::PublicInternet,
    }
}

/// 100.64/10, which `Ipv4Addr::is_private` does not cover.
fn is_cgnat(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000
}

/// fc00::/7 unique-local addresses.
fn is_unique_local(ip: std::net::Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
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

/// Outcome of the contract probe sequence.
pub struct ProbeOutcome {
    /// Embedder probe, when an embedder was built and the probe completed.
    pub vector: Option<VectorStabilityProbe>,
    /// Reranker probe, when a reranker was built and the probe completed.
    pub rerank: Option<RerankSemanticsProbe>,
    /// True when cancellation cut the sequence short.
    pub cancelled: bool,
}

/// Run the two contract probes against the roles that were actually built.
///
/// Probes use synthetic strings only, so running them never sends corpus text
/// anywhere. They are skipped entirely when the corresponding role is absent.
///
/// Cancellation is checked before each probe AND between the two provider
/// calls inside a probe: each probe makes more than one request, and a cancel
/// that only took effect between whole probes would still let a cancelled run
/// issue a second request to a provider. A probe cut short is discarded rather
/// than reported, because a probe missing half its evidence would otherwise
/// read as a contract violation the provider never committed.
pub fn run_probes(
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    timeout_ms: u64,
    cancel: Option<&CancelFlag>,
) -> ProbeOutcome {
    let mut outcome = ProbeOutcome {
        vector: None,
        rerank: None,
        cancelled: false,
    };
    if cancelled(cancel) {
        outcome.cancelled = true;
        return outcome;
    }
    if let Some(backend) = embed {
        let space = backend.space();
        let cut_short = std::cell::Cell::new(false);
        let probe = probes::probe_vector_stability(backend, &space, |texts| {
            if cancelled(cancel) {
                cut_short.set(true);
                return None;
            }
            embed_batch_blocking(backend, texts, timeout_ms)
        });
        if cut_short.get() {
            outcome.cancelled = true;
            return outcome;
        }
        outcome.vector = Some(probe);
    }
    if cancelled(cancel) {
        outcome.cancelled = true;
        return outcome;
    }
    if let Some(backend) = rerank {
        let cut_short = std::cell::Cell::new(false);
        let probe = probes::probe_rerank_semantics(backend, |query, documents| {
            if cancelled(cancel) {
                cut_short.set(true);
                return None;
            }
            rerank_blocking(backend, query, documents, timeout_ms)
        });
        if cut_short.get() {
            outcome.cancelled = true;
            return outcome;
        }
        outcome.rerank = Some(probe);
    }
    outcome
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
        raw_rankings: Vec::new(),
    };
    // Identity comes from the backend that will actually serve this lane, not
    // from configuration. A lane that publishes a configured model and a
    // configured fingerprint while a different backend runs is the exact shape
    // of a report that looks measured and is not.
    if lane.uses_embedder() {
        if let Some(backend) = embed {
            let space = backend.space();
            report.embedding_model = Some(space.model.clone());
            report.embedding_dialect = Some(space.dialect.clone());
            report.embedding_space_fingerprint = Some(space.fingerprint());
        }
    }
    if lane.uses_reranker() {
        if let Some(backend) = rerank {
            report.rerank_model = Some(backend.identity());
            report.rerank_dialect = Some(backend.dialect().to_string());
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
                if request.include_raw {
                    report.raw_rankings.push(RawRanking {
                        query_id: query.query_id.clone(),
                        ranked_seqs: result.ranked_seqs,
                    });
                }
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

    // Pin BEFORE anything else so the identity the report publishes is the one
    // the first lane will actually see.
    let pinned = read_corpus_pin(cache_root, &request.corpus_id)?;
    let corpus = LogCorpus::open(cache_root, &request.corpus_id)?;
    let binding = corpus.embedding_status();
    let identity = DiagnosticCorpusIdentity {
        corpus_id: request.corpus_id.clone(),
        event_revision: pinned.event,
        template_analysis_revision: pinned.template,
        suppression_revision: pinned.suppression,
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
    let stored_space = binding.space.clone();
    drop(corpus);

    let mut stability = CorpusStability {
        pinned_event_revision: pinned.event,
        pinned_template_analysis_revision: pinned.template,
        pinned_suppression_revision: pinned.suppression,
        drifted: false,
        drifted_fields: Vec::new(),
        observed_at: None,
    };

    // A lane the plan already blocked will never execute, so the role it would
    // have needed is not required by this run. Deciding that here is what keeps
    // an unacknowledged-egress or private-network run from reading a credential
    // and opening a client for a lane that was never going to run.
    let runnable = |lane: &DiagnosticLane| {
        !plan
            .blocked_lanes
            .iter()
            .any(|blocked| blocked.lane == lane.as_str())
    };
    let needs_embed = request
        .lanes
        .iter()
        .any(|lane| lane.uses_embedder() && runnable(lane));
    let needs_rerank = request
        .lanes
        .iter()
        .any(|lane| lane.uses_reranker() && runnable(lane));

    // Cancellation before any provider work: a cancelled run must not read a
    // credential, construct a backend, or contact an endpoint. Checked here,
    // before construction, rather than inside the lane loop where the roles
    // would already have been built and probed.
    if cancelled(cancel) {
        return Ok(cancelled_report(
            request, budgets, identity, stability, &plan,
        ));
    }

    // Build ONLY the roles a runnable lane needs, and exactly once. Building
    // per lane would read the configured credential once per lane; building a
    // role no lane needs would read a credential for a capability this run is
    // not measuring.
    let embed_slot: RoleSlot<dyn EmbedBackend> = build_role_slot(
        needs_embed,
        enabled_role(config.retrieval.embedding.as_ref()),
        |role| crate::retrieval::build_embedding_backend(role, secrets),
        "embedding_backend_unavailable",
    );
    let rerank_slot: RoleSlot<dyn RerankBackend> = build_role_slot(
        needs_rerank,
        enabled_role(config.retrieval.reranker.as_ref()),
        |role| crate::retrieval::build_rerank_backend(role, secrets),
        "rerank_backend_unavailable",
    );

    let embed = embed_slot.built().cloned();
    let rerank = rerank_slot.built().cloned();

    // Fingerprints must describe the endpoint and dialect that actually ran,
    // not the ones configuration described.
    let backend_space = embed.as_ref().map(|backend| backend.space());
    let fingerprint_agreement = reconcile_fingerprints(
        enabled_role(config.retrieval.embedding.as_ref()),
        backend_space.as_ref(),
        stored_space.as_ref(),
    );

    // Probe only roles that were actually built, and stop between probes if
    // cancellation arrives.
    let probe_outcome = run_probes(
        embed.as_deref(),
        rerank.as_deref(),
        PROBE_TIMEOUT_MS.min(budgets.rerank_timeout_ms.max(PROBE_TIMEOUT_MS)),
        cancel,
    );
    let vector_stability = probe_outcome.vector;
    let rerank_semantics = probe_outcome.rerank;

    let mut lanes = Vec::new();
    for lane in &request.lanes {
        if cancelled(cancel) {
            lanes.push(lane_shell(*lane, LaneStatus::Cancelled, None));
            continue;
        }
        // Re-read the pin before every lane. A corpus that changed between
        // lanes makes the per-lane numbers incomparable, and comparing them is
        // the entire point of the run.
        note_drift(
            &mut stability,
            cache_root,
            &request.corpus_id,
            &pinned,
            &format!("before lane {}", lane.as_str()),
        );
        if stability.drifted {
            // Everything from here on would be measured against a different
            // corpus, so nothing further is claimed.
            lanes.push(lane_shell(
                *lane,
                LaneStatus::Blocked,
                Some(BlockedLane {
                    lane: lane.as_str().into(),
                    code: "corpus_changed_during_run".into(),
                    detail: "the corpus changed while the run was in progress; lanes measured \
                             before and after are not comparable"
                        .into(),
                }),
            ));
            continue;
        }
        // A role this lane needs failed to build. The lane is blocked with the
        // real reason: running it without the capability would produce numbers
        // that look like a measured comparison and are not one.
        let role_failure =
            (lane.uses_embedder().then(|| embed_slot.failure()).flatten()).or_else(|| {
                lane.uses_reranker()
                    .then(|| rerank_slot.failure())
                    .flatten()
            });
        if let Some(failure) = role_failure {
            lanes.push(lane_shell(
                *lane,
                LaneStatus::Blocked,
                Some(BlockedLane {
                    lane: lane.as_str().into(),
                    code: failure.code.into(),
                    detail: failure.detail.clone(),
                }),
            ));
            continue;
        }
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
                raw_rankings: Vec::new(),
            });
            continue;
        }
        let mut host = host_for_lane(*lane)?;
        // Attach only what this lane is entitled to.
        //
        // Both slots are cleared for a keyword lane, not just the log-specific
        // one: `ToolHost::log_embed_backend` falls back to the SHARED host
        // embedder when the log slot is empty, so clearing one alone would let
        // a keyword baseline silently borrow semantic retrieval from a host the
        // caller happened to configure — and the whole comparison would be
        // measuring a lane that does not exist.
        if lane.uses_embedder() {
            if let (Some(backend), Some(role)) =
                (&embed, enabled_role(config.retrieval.embedding.as_ref()))
            {
                host.set_log_embed_backend(Some(Arc::clone(backend)), &role.model);
            }
        } else {
            host.set_log_embed_backend(None, "");
            host.set_embed_backend(None);
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
                embed.as_deref(),
                rerank.as_deref(),
                &budgets,
                cancel,
            )
            .await,
        );
        // And again after the lane: a change that lands mid-lane is caught
        // before the next lane is measured against it.
        note_drift(
            &mut stability,
            cache_root,
            &request.corpus_id,
            &pinned,
            &format!("after lane {}", lane.as_str()),
        );
    }

    // One last read, so a change that landed after the final lane still
    // invalidates the run rather than being reported as a clean comparison.
    note_drift(
        &mut stability,
        cache_root,
        &request.corpus_id,
        &pinned,
        "after the final lane",
    );

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
    let verdict = if stability.drifted {
        // The lanes did not all measure the same corpus, so there is no
        // comparison to report regardless of how many lanes produced numbers.
        DiagnosticVerdict::Inconclusive
    } else if usable < 2 {
        // Fewer than two usable lanes is not a comparison. Saying so is the
        // honest outcome; a single-lane "winner" would be meaningless.
        DiagnosticVerdict::Inconclusive
    } else if executed == lanes.len() && probes_healthy && fingerprint_agreement.findings.is_empty()
    {
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
        corpus_stability: stability,
        fingerprint_agreement,
        evidence: DiagnosticEvidenceLabels::default(),
        verdict,
    })
}

/// Re-read the pin and record any drift.
///
/// An unreadable pin is treated as drift, not as "no change": the run cannot
/// prove the corpus held still, and a comparison that cannot prove its inputs
/// were identical is not a comparison. Swallowing the error here would report
/// a corpus that became unreadable mid-run as perfectly stable.
fn note_drift(
    stability: &mut CorpusStability,
    cache_root: &Path,
    corpus_id: &str,
    pinned: &CorpusPin,
    observed_at: &str,
) {
    if stability.drifted {
        return;
    }
    match read_corpus_pin(cache_root, corpus_id) {
        Ok(now) => {
            let drifted_fields = now.drift_from(pinned);
            if !drifted_fields.is_empty() {
                stability.drifted = true;
                stability.drifted_fields = drifted_fields;
                stability.observed_at = Some(observed_at.to_string());
            }
        }
        Err(_) => {
            stability.drifted = true;
            stability.drifted_fields = vec!["corpus_unreadable".to_string()];
            stability.observed_at = Some(observed_at.to_string());
        }
    }
}

/// An empty lane row in a known status, used for cancelled, drifted, and
/// role-failed lanes so every requested lane still appears in the report.
fn lane_shell(
    lane: DiagnosticLane,
    status: LaneStatus,
    blocked_reason: Option<BlockedLane>,
) -> LaneReport {
    LaneReport {
        lane: lane.as_str().into(),
        status,
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
        blocked_reason,
        raw_rankings: Vec::new(),
    }
}

/// A report for a run that was cancelled before any provider work happened.
///
/// Every requested lane is present and cancelled, so the artifact cannot be
/// read as a comparison that simply found nothing.
fn cancelled_report(
    request: &DiagnosticRequest,
    budgets: DiagnosticBudgets,
    corpus: DiagnosticCorpusIdentity,
    corpus_stability: CorpusStability,
    _plan: &DiagnosticPlan,
) -> RetrievalDiagnosticReport {
    RetrievalDiagnosticReport {
        schema_id: RETRIEVAL_DIAGNOSTIC_SCHEMA_ID.into(),
        schema_version: RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
        corpus,
        budgets,
        lanes: request
            .lanes
            .iter()
            .map(|lane| lane_shell(*lane, LaneStatus::Cancelled, None))
            .collect(),
        vector_stability: None,
        rerank_semantics: None,
        corpus_stability,
        fingerprint_agreement: FingerprintAgreement::default(),
        evidence: DiagnosticEvidenceLabels::default(),
        verdict: DiagnosticVerdict::Inconclusive,
    }
}

/// Build a role only when a runnable lane needs it, keeping the failure.
fn build_role_slot<T: ?Sized>(
    required: bool,
    role: Option<&RetrievalRoleModel>,
    build: impl FnOnce(&RetrievalRoleModel) -> CoreResult<Arc<T>>,
    failure_code: &'static str,
) -> RoleSlot<T> {
    let Some(role) = role else {
        return RoleSlot::Unconfigured;
    };
    if !required {
        return RoleSlot::NotRequired;
    }
    match build(role) {
        Ok(backend) => RoleSlot::Built(backend),
        // Never swallowed: a factory refusal (bad dialect, refused egress,
        // blocked private address, unreadable credential) is the reason the
        // dependent lanes cannot run, and reporting it as "unconfigured" would
        // hide a misconfiguration behind a status that looks deliberate.
        Err(error) => RoleSlot::Failed(RoleFailure {
            code: failure_code,
            detail: redact(&error.to_string()),
        }),
    }
}

/// Compare the configured, built, and stored embedding spaces.
///
/// All three are derived through the same endpoint normalization, so a
/// disagreement here is a real disagreement rather than an artefact of three
/// different ways of spelling the same endpoint.
fn reconcile_fingerprints(
    role: Option<&RetrievalRoleModel>,
    backend_space: Option<&EmbeddingSpaceIdentity>,
    stored_space: Option<&EmbeddingSpaceIdentity>,
) -> FingerprintAgreement {
    let mut agreement = FingerprintAgreement::default();
    let Some(backend_space) = backend_space else {
        return agreement;
    };
    let backend_fingerprint = backend_space.fingerprint();
    if let Some(role) = role {
        let configured = configured_embedding_space(role).fingerprint();
        let matches = configured == backend_fingerprint;
        agreement.configured_matches_backend = Some(matches);
        if !matches {
            agreement.findings.push(
                "the configured embedding space does not match the backend that was built; the                  endpoint or dialect the run used is not the one configuration describes"
                    .into(),
            );
        }
    }
    if let Some(stored) = stored_space {
        let matches = stored.fingerprint() == backend_fingerprint;
        agreement.stored_matches_backend = Some(matches);
        if !matches {
            agreement.findings.push(
                "the corpus's stored embedding space does not match the backend that ran; dense                  lanes compare vectors from different spaces until the corpus is re-analysed"
                    .into(),
            );
        }
    }
    agreement
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
                suppression_revision: 0,
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
                raw_rankings: Vec::new(),
            }],
            vector_stability: None,
            rerank_semantics: None,
            corpus_stability: CorpusStability {
                pinned_event_revision: 1,
                pinned_template_analysis_revision: 1,
                pinned_suppression_revision: 0,
                drifted: false,
                drifted_fields: Vec::new(),
                observed_at: None,
            },
            fingerprint_agreement: FingerprintAgreement::default(),
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
