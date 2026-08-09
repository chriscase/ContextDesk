//! Versioned wire types for the hermetic quality-evaluation harness.
//!
//! These types record **quality** evidence only. They never write
//! compatibility/readiness stores and never carry secrets or absolute paths.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Schema version for quality-evaluation records and fixtures.
pub const QUALITY_EVAL_SCHEMA_VERSION: &str = "contextdesk.quality_eval.v1";

/// Suite schema id.
pub const SUITE_SCHEMA_ID: &str = "contextdesk.quality_eval.suite.v1";

/// Case schema id.
pub const CASE_SCHEMA_ID: &str = "contextdesk.quality_eval.case.v1";

/// Run-record schema id.
pub const RUN_RECORD_SCHEMA_ID: &str = "contextdesk.quality_eval.run_record.v1";

/// Host-only truth schema id.
pub const TRUTH_SCHEMA_ID: &str = "contextdesk.quality_eval.truth.v1";

/// Model-visible runtime schema id.
pub const RUNTIME_SCHEMA_ID: &str = "contextdesk.quality_eval.runtime.v1";

/// Explicit lane / member lifecycle status. Unrun lanes are never passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneStatus {
    /// Lane ran to completion with a scored result.
    Executed,
    /// Lane attempted but failed a contract (invalid ranking, schema, etc.).
    Failed,
    /// Lane could not start (missing fixture, policy, capability).
    Blocked,
    /// Lane was cancelled mid-run.
    Cancelled,
    /// Lane was not scheduled in this run (optional live/judge paths).
    NotScheduled,
}

impl LaneStatus {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Executed => "executed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
            Self::NotScheduled => "not_scheduled",
        }
    }

    /// Whether this status may contribute a success claim.
    pub fn may_pass(self) -> bool {
        matches!(self, Self::Executed)
    }
}

/// Evaluation lane kinds implemented hermetically or reserved for live runners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationLane {
    /// Every candidate scores against the same frozen evidence packet.
    FixedPacket,
    /// Host-curated decisive packet establishing an answer upper bound.
    OraclePacket,
    /// Frozen product-path retrieval result through the same answer boundary.
    ProductPathFixture,
    /// Reserved: no retrieval (answer from question alone).
    NoRetrieval,
    /// Reserved: lexical/keyword retrieval.
    LexicalRetrieval,
    /// Reserved: embedding retrieval.
    EmbeddingRetrieval,
    /// Reserved: embedding shortlist + rerank.
    EmbeddingRerank,
    /// Reserved: product hybrid retrieval.
    ProductHybrid,
}

impl EvaluationLane {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FixedPacket => "fixed_packet",
            Self::OraclePacket => "oracle_packet",
            Self::ProductPathFixture => "product_path_fixture",
            Self::NoRetrieval => "no_retrieval",
            Self::LexicalRetrieval => "lexical_retrieval",
            Self::EmbeddingRetrieval => "embedding_retrieval",
            Self::EmbeddingRerank => "embedding_rerank",
            Self::ProductHybrid => "product_hybrid",
        }
    }
}

/// Task / role mode under evaluation (orthogonal to provider readiness roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    /// Linked triage / investigation synthesis.
    TriageInvestigation,
    /// Ordinary unlinked chat.
    OrdinaryChat,
    /// Ordinary chat with explicit text attachments.
    ChatWithTextAttachments,
    /// Embedding retrieval quality.
    Embedding,
    /// Reranking quality.
    Reranking,
    /// Reserved multimodal.
    MultimodalFuture,
}

impl TaskMode {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TriageInvestigation => "triage_investigation",
            Self::OrdinaryChat => "ordinary_chat",
            Self::ChatWithTextAttachments => "chat_with_text_attachments",
            Self::Embedding => "embedding",
            Self::Reranking => "reranking",
            Self::MultimodalFuture => "multimodal_future",
        }
    }
}

/// Gateway-scoped model subject. The same model id on two gateways is two subjects.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModelSubject {
    /// Local gateway / provider profile id (not a secret).
    pub gateway_profile_id: String,
    /// SHA-256 hex of normalized endpoint (never the raw private URL).
    pub endpoint_fingerprint: String,
    /// Exact model id as configured for this gateway.
    pub model_id: String,
}

impl ModelSubject {
    /// Compact storage id — two gateways never collapse.
    pub fn storage_id(&self) -> String {
        format!(
            "{}::{}::{}",
            self.gateway_profile_id.trim(),
            self.endpoint_fingerprint.trim(),
            self.model_id.trim()
        )
    }
}

/// Full quality-unit identity. A result never transfers across quality units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualityUnit {
    /// Build / commit identity when known (short SHA or `unknown`).
    pub build_identity: String,
    /// Gateway-scoped model subject.
    pub subject: ModelSubject,
    /// Task mode under evaluation.
    pub task_mode: TaskMode,
    /// SHA-256 of the prompt set used (or `hermetic_scripted` for fixtures).
    pub prompt_set_hash: String,
    /// Answer schema version consumed by scoring.
    pub answer_schema_version: String,
    /// Suite id + content digest binding.
    pub suite_id: String,
    /// SHA-256 of suite runtime+truth canonical bytes.
    pub suite_digest: String,
    /// Retrieval / packet mode label for this unit.
    pub retrieval_mode: String,
    /// Sampling configuration snapshot (hermetic: `deterministic_scripted`).
    pub sampling_config: String,
    /// Orchestration policy fingerprint (`none` for single-packet scoring).
    pub orchestration_policy_fingerprint: String,
    /// This crate's quality-eval schema version.
    pub quality_eval_schema_version: String,
}

impl QualityUnit {
    /// Compact storage id for evidence isolation.
    pub fn storage_id(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.build_identity,
            self.subject.storage_id(),
            self.task_mode.as_str(),
            self.prompt_set_hash,
            self.answer_schema_version,
            self.suite_digest,
            self.retrieval_mode,
            self.sampling_config,
            self.orchestration_policy_fingerprint,
            self.quality_eval_schema_version
        )
    }
}

/// One model-visible evidence document (stable id outside text when possible).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceDocument {
    /// Stable host identity (never an evaluator role label).
    pub id: String,
    /// Neutral model-visible text (no decoy/root-cause labels).
    pub text: String,
}

/// Frozen ranked retrieval list for hermetic or later live runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalRanking {
    /// Query id within the case.
    pub query_id: String,
    /// Ordered result document ids (rank 1 = first).
    pub ranked_ids: Vec<String>,
    /// Optional pre-rerank / upstream shortlist for delta metrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_ranked_ids: Option<Vec<String>>,
    /// Declared K budget for recall@k (defaults to ranked list length).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<u32>,
}

/// Model-visible evidence packet handed to answer scoring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidencePacket {
    /// Packet id (e.g. `fixed`, `oracle`, `product_path`).
    pub packet_id: String,
    /// Ordered evidence rows visible to the candidate answer.
    pub documents: Vec<EvidenceDocument>,
}

/// Host-only relevance / role truth for one query (never imported into runtime).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryTruth {
    /// Query id.
    pub query_id: String,
    /// User-facing question text (also present in runtime; truth may restate).
    pub question: String,
    /// Relevant document ids (set membership for recall).
    #[serde(default)]
    pub relevant_ids: Vec<String>,
    /// Graded gains per relevant id (default gain 1 when absent).
    #[serde(default)]
    pub graded_gains: BTreeMap<String, u8>,
    /// Must appear in top-k.
    #[serde(default)]
    pub must_include_ids: Vec<String>,
    /// Must not appear in top-k (decoys / foreign).
    #[serde(default)]
    pub must_exclude_ids: Vec<String>,
    /// Explicit foreign-incident ids (subset of must_exclude or larger).
    #[serde(default)]
    pub foreign_incident_ids: Vec<String>,
    /// K for must-include / must-exclude evaluation.
    #[serde(default = "default_k")]
    pub top_k: u32,
}

fn default_k() -> u32 {
    10
}

/// Host-only answer key for one task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerTruth {
    /// Task id within the case.
    pub task_id: String,
    /// Whether root cause is establishable from the packet under test.
    pub root_cause_establishable: bool,
    /// Token substrings that must appear in a correct causal claim set.
    #[serde(default)]
    pub required_fact_tokens: Vec<String>,
    /// Tokens that identify the true trigger when establishable.
    #[serde(default)]
    pub trigger_tokens: Vec<String>,
    /// Tokens that identify symptoms (must not be sole cause).
    #[serde(default)]
    pub symptom_tokens: Vec<String>,
    /// Tokens that identify recovery (must not be labeled as cause).
    #[serde(default)]
    pub recovery_tokens: Vec<String>,
    /// Tokens for an independent incident that must stay separate.
    #[serde(default)]
    pub independent_incident_tokens: Vec<String>,
    /// Evidence ids that must be cited when making causal claims.
    #[serde(default)]
    pub required_evidence_ids: Vec<String>,
    /// Evidence ids that must never be cited as support.
    #[serde(default)]
    pub forbidden_evidence_ids: Vec<String>,
    /// When true, a correct answer must abstain (cause not established).
    #[serde(default)]
    pub requires_abstention: bool,
    /// Forbidden conclusion tokens (fabrications).
    #[serde(default)]
    pub forbidden_conclusion_tokens: Vec<String>,
}

/// Full host-only truth for one case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseTruth {
    /// Schema identity.
    pub schema_id: String,
    /// Case id.
    pub case_id: String,
    /// Title for reports.
    pub title: String,
    /// Per-query retrieval truth.
    #[serde(default)]
    pub queries: Vec<QueryTruth>,
    /// Per-task answer truth.
    #[serde(default)]
    pub answers: Vec<AnswerTruth>,
    /// Incident ids used for foreign-leakage labeling (host-only names).
    #[serde(default)]
    pub incidents: BTreeMap<String, Vec<String>>,
}

/// Scripted candidate answer for hermetic evaluation (not live model output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateAnswer {
    /// Candidate id (e.g. `good`, `missing_citation`, `merged_incidents`).
    pub candidate_id: String,
    /// Task id this answer targets.
    pub task_id: String,
    /// Packet id this answer was produced against.
    pub packet_id: String,
    /// Whether the answer claims root cause is established.
    #[serde(default)]
    pub asserts_root_cause_established: bool,
    /// Structured claims with optional evidence citations.
    #[serde(default)]
    pub claims: Vec<AnswerClaim>,
    /// Free-text conclusion body used for token checks.
    #[serde(default)]
    pub conclusion: String,
    /// Confidence label: high | medium | low.
    #[serde(default)]
    pub confidence: String,
}

/// One structured claim in a candidate answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerClaim {
    /// Claim text.
    pub text: String,
    /// Cited evidence document ids.
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    /// Optional role: trigger | symptom | recovery | independent | observation | other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Model-visible runtime for one case (importable / scorable without truth).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseRuntime {
    /// Schema identity.
    pub schema_id: String,
    /// Case id.
    pub case_id: String,
    /// Corpus documents.
    pub documents: Vec<EvidenceDocument>,
    /// Questions (model-visible).
    pub questions: BTreeMap<String, String>,
    /// Frozen evidence packets.
    pub packets: Vec<EvidencePacket>,
    /// Frozen retrieval rankings for retrieval metrics (optional).
    #[serde(default)]
    pub rankings: Vec<RetrievalRanking>,
    /// Scripted candidate answers for hermetic answer scoring.
    #[serde(default)]
    pub candidates: Vec<CandidateAnswer>,
}

/// Suite manifest listing cases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuiteManifest {
    /// Schema identity.
    pub schema_id: String,
    /// Suite id.
    pub suite_id: String,
    /// Human title.
    pub title: String,
    /// Schema version string.
    pub schema_version: String,
    /// Case directory names relative to suite root.
    pub cases: Vec<String>,
}

/// Deterministic retrieval metrics for one ranking vs truth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetrievalMetrics {
    /// Query id.
    pub query_id: String,
    /// Recall at K.
    pub recall_at_k: f64,
    /// Mean reciprocal rank over relevant items (first hit).
    pub mrr: f64,
    /// nDCG at K (graded).
    pub ndcg_at_k: f64,
    /// Fraction of must-include ids present in top-k.
    pub must_include_recall: f64,
    /// Fraction of top-k that are must-exclude ids.
    pub must_exclude_rate: f64,
    /// Count of foreign-incident ids in top-k.
    pub foreign_incident_hits: u64,
    /// Upstream recall when upstream list present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_recall_at_k: Option<f64>,
    /// Final (post-rerank) recall when upstream present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_recall_at_k: Option<f64>,
    /// Lane status for this ranking score.
    pub status: LaneStatus,
    /// Typed failure reasons when status is failed/blocked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_reasons: Vec<String>,
}

/// One deterministic answer dimension outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerDimension {
    /// Dimension id.
    pub id: String,
    /// Whether this dimension passed.
    pub passed: bool,
    /// Machine-readable reason.
    pub reason: String,
}

/// Deterministic answer score for one candidate on one packet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerScore {
    /// Candidate id.
    pub candidate_id: String,
    /// Task id.
    pub task_id: String,
    /// Packet id.
    pub packet_id: String,
    /// Overall pass (all critical dimensions).
    pub passed: bool,
    /// Per-dimension results.
    pub dimensions: Vec<AnswerDimension>,
    /// Lane status.
    pub status: LaneStatus,
}

impl AnswerScore {
    /// Failed dimension ids.
    pub fn failed_ids(&self) -> Vec<&str> {
        self.dimensions
            .iter()
            .filter(|d| !d.passed)
            .map(|d| d.id.as_str())
            .collect()
    }
}

/// Optional judge metadata — defaults to not scheduled; never overrides host truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JudgeMetadata {
    /// Always explicit.
    pub status: LaneStatus,
    /// Protocol label when scheduled later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// Notes (never a pass override).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Default for JudgeMetadata {
    fn default() -> Self {
        Self {
            status: LaneStatus::NotScheduled,
            protocol: None,
            note: Some("optional_judge_not_scheduled_in_hermetic_milestone".into()),
        }
    }
}

/// Normalized hermetic run record for one suite execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QualityRunRecord {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: String,
    /// Suite id.
    pub suite_id: String,
    /// Suite content digest used for this run.
    pub suite_digest: String,
    /// Quality unit for this hermetic scripted subject.
    pub quality_unit: QualityUnit,
    /// Overall suite status (failed if any required lane failed).
    pub status: LaneStatus,
    /// Per-case results.
    pub cases: Vec<CaseRunResult>,
    /// Judge metadata (not scheduled in hermetic milestone).
    pub judge: JudgeMetadata,
    /// Evidence class markers for consumers.
    pub evidence_classes: EvidenceClassMarkers,
}

/// Explicit separation of evidence classes (quality never writes readiness).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceClassMarkers {
    /// Compatibility / readiness evidence was not modified.
    pub compatibility_untouched: bool,
    /// This record contains retrieval quality metrics.
    pub retrieval_quality: bool,
    /// This record contains answer quality metrics.
    pub answer_quality: bool,
    /// This record contains orchestration quality metrics.
    pub orchestration_quality: bool,
    /// Live optional evidence present.
    pub live_optional: bool,
}

impl Default for EvidenceClassMarkers {
    fn default() -> Self {
        Self {
            compatibility_untouched: true,
            retrieval_quality: true,
            answer_quality: true,
            orchestration_quality: false,
            live_optional: false,
        }
    }
}

/// Per-case run result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaseRunResult {
    /// Case id.
    pub case_id: String,
    /// Case title.
    pub title: String,
    /// Case-level status.
    pub status: LaneStatus,
    /// Retrieval metric rows.
    #[serde(default)]
    pub retrieval: Vec<RetrievalMetrics>,
    /// Answer scores (scripted candidates × packets).
    #[serde(default)]
    pub answers: Vec<AnswerScore>,
    /// Isolation / mutation contract findings for this case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub isolation_findings: Vec<String>,
}

/// Typed scoring failure reasons (stable strings for mutation tests).
pub mod failure_reason {
    /// Ranking contained duplicate ids.
    pub const DUPLICATE_RANK_IDS: &str = "duplicate_rank_ids";
    /// Ranking referenced unknown document ids.
    pub const UNKNOWN_RANK_IDS: &str = "unknown_rank_ids";
    /// Ranking was empty when truth required hits.
    pub const EMPTY_RANKING: &str = "empty_ranking";
    /// Invalid or incomplete ranking structure.
    pub const INVALID_RANKING: &str = "invalid_ranking";
    /// Answer missing required citation.
    pub const MISSING_REQUIRED_CITATION: &str = "missing_required_citation";
    /// Answer cited fabricated / unknown evidence id.
    pub const FABRICATED_CITATION: &str = "fabricated_citation";
    /// Answer cited forbidden evidence id.
    pub const FORBIDDEN_CITATION: &str = "forbidden_citation";
    /// Decoy selected as causal support.
    pub const DECOY_SELECTED: &str = "decoy_selected";
    /// Independent incidents merged into one cause.
    pub const MERGED_INDEPENDENT_INCIDENTS: &str = "merged_independent_incidents";
    /// Recovery labeled as cause.
    pub const RECOVERY_AS_CAUSE: &str = "recovery_as_cause";
    /// Symptom treated as sole root cause.
    pub const SYMPTOM_AS_SOLE_CAUSE: &str = "symptom_as_sole_cause";
    /// Unsupported certainty / failed abstention.
    pub const UNSUPPORTED_CERTAINTY: &str = "unsupported_certainty";
    /// Missing required decisive facts.
    pub const MISSING_DECISIVE_FACTS: &str = "missing_decisive_facts";
    /// Forbidden fabricated conclusion.
    pub const FORBIDDEN_CONCLUSION: &str = "forbidden_conclusion";
    /// Answer schema / contract incomplete.
    pub const INVALID_ANSWER_SCHEMA: &str = "invalid_answer_schema";
    /// Evaluator truth leaked into runtime data.
    pub const TRUTH_LEAKED_INTO_RUNTIME: &str = "truth_leaked_into_runtime";
    /// Suite digest mismatch.
    pub const SUITE_DIGEST_MISMATCH: &str = "suite_digest_mismatch";
    /// Model subjects incorrectly shared across gateways.
    pub const CROSS_GATEWAY_IDENTITY_COLLAPSE: &str = "cross_gateway_identity_collapse";
    /// Judge attempted to override deterministic failure.
    pub const JUDGE_OVERRIDE_REJECTED: &str = "judge_override_rejected";
    /// Absolute path or credential-shaped material in export.
    pub const EXPORT_PRIVACY_VIOLATION: &str = "export_privacy_violation";
    /// Citation fidelity: claim text unsupported by cited row.
    pub const CITATION_FIDELITY: &str = "citation_fidelity";
}
