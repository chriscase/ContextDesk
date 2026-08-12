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
        framed_storage_id(&[
            self.gateway_profile_id.trim(),
            self.endpoint_fingerprint.trim(),
            self.model_id.trim(),
        ])
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
        let subject_id = self.subject.storage_id();
        framed_storage_id(&[
            self.build_identity.as_str(),
            subject_id.as_str(),
            self.task_mode.as_str(),
            self.prompt_set_hash.as_str(),
            self.answer_schema_version.as_str(),
            self.suite_digest.as_str(),
            self.retrieval_mode.as_str(),
            self.sampling_config.as_str(),
            self.orchestration_policy_fingerprint.as_str(),
            self.quality_eval_schema_version.as_str(),
        ])
    }
}

fn framed_storage_id(parts: &[&str]) -> String {
    let mut output = String::new();
    for part in parts {
        use std::fmt::Write as _;
        let _ = write!(output, "{}:{part}", part.len());
    }
    output
}

/// One model-visible evidence document (stable id outside text when possible).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceDocument {
    /// Stable host identity (never an evaluator role label).
    pub id: String,
    /// Neutral model-visible text (no decoy/root-cause labels).
    pub text: String,
}

/// Frozen ranked retrieval list for hermetic or later live runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Optional ablation lane label (keyword, dense, hybrid, rerank, …).
    /// Informational for matrix summaries; never invents a retrieval pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_label: Option<String>,
}

/// Model-visible evidence packet handed to answer scoring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidencePacket {
    /// Packet id (e.g. `fixed`, `oracle`, `product_path`).
    pub packet_id: String,
    /// Ordered evidence rows visible to the candidate answer.
    pub documents: Vec<EvidenceDocument>,
}

/// Host-only relevance / role truth for one query (never imported into runtime).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /// Tokens that identify symptoms (must not be labeled as initiating trigger).
    #[serde(default)]
    pub symptom_tokens: Vec<String>,
    /// Tokens that identify recovery (must not be labeled as cause).
    #[serde(default)]
    pub recovery_tokens: Vec<String>,
    /// Tokens for an independent incident that must stay separate (not demoted
    /// into the main incident's trigger/symptom chain).
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
    /// Packet-specific establishability overrides. The same task can be
    /// answerable from a fixed/oracle packet but require abstention from an
    /// incomplete product-path packet.
    #[serde(default)]
    pub packet_overrides: BTreeMap<String, PacketAnswerTruth>,
    /// Forbidden conclusion tokens (fabrications).
    #[serde(default)]
    pub forbidden_conclusion_tokens: Vec<String>,
    /// Optional host-only diagnostic-honesty truth for gateway/tool/orchestration
    /// scripted envelopes attached to candidates of this task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<DiagnosticTruth>,
}

/// Host-only expectations for scripted diagnostic honesty envelopes.
///
/// Reuses production category labels from
/// [`crate::linked_triage_contract::LinkedTriageDiagnosticCategory`] where
/// applicable. Empty / absent truth means diagnostic dimensions are not scored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticTruth {
    /// Allowed values for `ScriptedDiagnostic.reported_category`.
    #[serde(default)]
    pub allowed_categories: Vec<String>,
    /// Expected usefulness policy label (e.g. `mixed_accounted`, `all_failed`,
    /// `any_success`). Empty skips policy equality.
    #[serde(default)]
    pub expected_usefulness_policy: String,
    /// When true, `claims_useful` may only be true under an honest policy given
    /// the attempt rows (mixed outcomes cannot claim universal usefulness).
    #[serde(default)]
    pub require_honest_usefulness: bool,
    /// When true, transport/auth/timeout attempt failures must not be reported
    /// as host-grounding refusal categories.
    #[serde(default)]
    pub separate_transport_from_grounding: bool,
    /// When true, tool steps that claim progress require citeable_hits > 0.
    #[serde(default)]
    pub require_citeable_on_tool_progress: bool,
    /// When true, a run of non-progress tool steps must end with withdrawal.
    #[serde(default)]
    pub require_tool_withdrawal_after_non_progress: bool,
    /// Role names that must appear; a `dropped` status without budget exhaustion
    /// fails role coverage.
    #[serde(default)]
    pub required_roles: Vec<String>,
    /// When true, `host_budget_exhausted` forbids `claims_useful`.
    #[serde(default)]
    pub budget_exhaustion_forbids_useful: bool,
    /// When true, export_text must pass the share-safe privacy scanner.
    #[serde(default)]
    pub require_share_safe_export: bool,
}

/// Host-only establishability truth for one evidence packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PacketAnswerTruth {
    /// Whether this packet establishes the initiating cause.
    pub root_cause_establishable: bool,
    /// Whether a correct answer must explicitly abstain from naming a cause.
    pub requires_abstention: bool,
}

/// Full host-only truth for one case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Host-only expected outcome for every scripted candidate id.
    ///
    /// This keeps mutation/good-fixture authority out of model-visible ids and
    /// avoids inferring evaluator intent from naming conventions.
    pub candidate_expectations: BTreeMap<String, CandidateExpectation>,
    /// Incident ids used for foreign-leakage labeling (host-only names).
    #[serde(default)]
    pub incidents: BTreeMap<String, Vec<String>>,
}

/// Host-only expected outcome for one scripted candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateExpectation {
    /// The candidate must satisfy every deterministic answer dimension.
    Pass,
    /// The candidate is an intentional mutation and must fail at least one
    /// deterministic answer dimension.
    Fail,
}

/// Scripted candidate answer for hermetic evaluation (not live model output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Optional scripted diagnostic honesty envelope (attempts, tools, roles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<ScriptedDiagnostic>,
}

/// One provider/semantic attempt row in a scripted diagnostic envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptedAttempt {
    /// Stable attempt id within the candidate.
    pub attempt_id: String,
    /// Host-owned failure/success class:
    /// `success` | `transport` | `auth` | `timeout` | `host_grounding` | `analysis` | `empty`.
    pub failure_class: String,
    /// Whether the attempt produced a successful evaluable analysis.
    #[serde(default)]
    pub succeeded: bool,
    /// Whether citeable analysis evidence was produced.
    #[serde(default)]
    pub citeable_evidence: bool,
}

/// One tool step in a scripted diagnostic envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptedToolStep {
    /// Stable step id.
    pub step_id: String,
    /// Tool kind label (`search`, `other`, …).
    #[serde(default)]
    pub kind: String,
    /// Count of citeable evidence hits returned.
    #[serde(default)]
    pub citeable_hits: u32,
    /// Whether the host treats this step as progress.
    #[serde(default)]
    pub progress: bool,
    /// Whether the host withdrew the tool after non-progress.
    #[serde(default)]
    pub withdrawn: bool,
}

/// One multi-model role outcome in a scripted diagnostic envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptedRoleOutcome {
    /// Role name (`investigator`, `reviewer`, `synthesizer`, …).
    pub role: String,
    /// `completed` | `dropped` | `budget_exhausted` | `transport_failed`.
    pub status: String,
}

/// Scripted diagnostic honesty envelope attached to a candidate answer.
///
/// This is fixture-authored; it reuses production category vocabulary and
/// privacy scanners. It is not a second agent pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ScriptedDiagnostic {
    /// Attempt rows for mixed pass/fail usefulness checks.
    #[serde(default)]
    pub attempts: Vec<ScriptedAttempt>,
    /// Tool steps for zero-cite / non-progress / withdrawal checks.
    #[serde(default)]
    pub tool_steps: Vec<ScriptedToolStep>,
    /// Multi-model role outcomes.
    #[serde(default)]
    pub roles: Vec<ScriptedRoleOutcome>,
    /// Host budget exhausted before all required work completed.
    #[serde(default)]
    pub host_budget_exhausted: bool,
    /// Category the diagnostic report claims (must match host truth allow-list).
    #[serde(default)]
    pub reported_category: String,
    /// Whether the report claims overall usefulness.
    #[serde(default)]
    pub claims_useful: bool,
    /// Usefulness policy label the report asserts.
    #[serde(default)]
    pub usefulness_policy: String,
    /// Share-safe export sample text (no secrets/paths/raw bodies).
    #[serde(default)]
    pub export_text: String,
}

/// One structured claim in a candidate answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /// Host-only scripted expectation when this score came from the hermetic
    /// fixture cage. Live candidate scores leave this unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_outcome: Option<CandidateExpectation>,
    /// Whether the scripted score matched the host-only expectation. Live
    /// candidate scores leave this unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expectation_met: Option<bool>,
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
            retrieval_quality: false,
            answer_quality: false,
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

/// One row in a deterministic candidate expectation matrix summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixRow {
    /// Case id.
    pub case_id: String,
    /// Candidate id.
    pub candidate_id: String,
    /// Host-only expected outcome label (`pass` / `fail` / `unset`).
    pub expected: String,
    /// Actual deterministic pass/fail.
    pub actual_passed: bool,
    /// Whether expectation was met.
    pub expectation_met: bool,
    /// Failed dimension ids (empty when pass).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_dimensions: Vec<String>,
    /// Failed dimension reasons (aligned loosely; may be shorter).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_reasons: Vec<String>,
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
    /// Independent incident demoted into the main incident's trigger/symptom chain.
    pub const INDEPENDENT_DEMOTED_INTO_MAIN: &str = "independent_demoted_into_main";
    /// Recovery labeled as cause.
    pub const RECOVERY_AS_CAUSE: &str = "recovery_as_cause";
    /// Symptom treated as sole root cause (no coexisting true trigger).
    pub const SYMPTOM_AS_SOLE_CAUSE: &str = "symptom_as_sole_cause";
    /// Symptom claim promoted to trigger role even when a true trigger is also present.
    pub const SYMPTOM_PROMOTED_TO_TRIGGER: &str = "symptom_promoted_to_trigger";
    /// Unsupported certainty / failed abstention.
    pub const UNSUPPORTED_CERTAINTY: &str = "unsupported_certainty";
    /// An abstention did not identify and cite the observed condition.
    pub const UNSUPPORTED_ABSTENTION: &str = "unsupported_abstention";
    /// An abstention used contradictory structured fields, confidence, or
    /// conclusion language instead of clearly stating the evidence limit.
    pub const INVALID_ABSTENTION_CONTRACT: &str = "invalid_abstention_contract";
    /// Missing required decisive facts.
    pub const MISSING_DECISIVE_FACTS: &str = "missing_decisive_facts";
    /// An establishable case received an answer that declined to identify it.
    pub const MISSED_ESTABLISHABLE_CAUSE: &str = "missed_establishable_cause";
    /// An asserted cause omitted a typed trigger claim.
    pub const MISSING_TRIGGER_ROLE: &str = "missing_trigger_role";
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
    /// Claim text had no significant lexical overlap with any cited row.
    pub const CITATION_LACKS_LEXICAL_OVERLAP: &str = "citation_lacks_lexical_overlap";
    /// Scripted candidate expectations were missing, duplicated, or did not
    /// match the deterministic score.
    pub const CANDIDATE_EXPECTATION_MISMATCH: &str = "candidate_expectation_mismatch";
    /// Runtime/truth fixture identities or references were structurally invalid.
    pub const INVALID_FIXTURE_CONTRACT: &str = "invalid_fixture_contract";
    /// Report claimed usefulness that the attempt rows do not support.
    pub const DISHONEST_ATTEMPT_USEFULNESS: &str = "dishonest_attempt_usefulness";
    /// Transport/auth/timeout failure mislabeled as host-grounding refusal.
    pub const TRANSPORT_MISLABELED_AS_GROUNDING: &str = "transport_mislabeled_as_grounding";
    /// Tool progress claimed with zero citeable evidence hits.
    pub const TOOL_ZERO_CITEABLE_EVIDENCE: &str = "tool_zero_citeable_evidence";
    /// Non-progress tool loop without host withdrawal.
    pub const TOOL_NON_PROGRESS_WITHOUT_WITHDRAWAL: &str = "tool_non_progress_without_withdrawal";
    /// Required multi-model role dropped without honest budget status.
    pub const ROLE_DROPOUT_WITHOUT_BUDGET: &str = "role_dropout_without_budget";
    /// Host budget exhaustion reported as useful completion.
    pub const BUDGET_EXHAUSTION_CLAIMED_USEFUL: &str = "budget_exhaustion_claimed_useful";
    /// Diagnostic category not in the host allow-list.
    pub const INVALID_DIAGNOSTIC_CATEGORY: &str = "invalid_diagnostic_category";
    /// Answer both asserts an established cause and uses abstention language.
    pub const CONTRADICTORY_CAUSE_ABSTENTION: &str = "contradictory_cause_abstention";
}
