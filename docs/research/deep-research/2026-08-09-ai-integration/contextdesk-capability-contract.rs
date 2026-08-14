//! Suggested ContextDesk model/gateway capability contract.
//!
//! This is an integration sketch, not a drop-in replacement for current types.
//! It intentionally keeps model role, HTTP dialect, evidence, and workflow
//! suitability separate.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ModelRole {
    ChatText,
    ChatVision,
    EmbeddingDense,
    EmbeddingSparse,
    EmbeddingMultiVector,
    Reranker,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TransportDialect {
    OpenAiChatCompletions,
    OpenAiEmbeddings,
    TeiEmbed,
    TeiRerank,
    VllmScore,
    VllmRerank,
    JinaRerankV1,
    CohereRerankV1,
    CohereRerankV2,
    VoyageRerankV1,
    QwenCloudRerank,
    Custom(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLevel {
    Unknown,
    NameHint,
    UpstreamDocumented,
    RouteObserved,
    WorkflowVerified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Degraded,
    Fail,
    Untested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserFacingStatus {
    Discovered,
    Compatible,
    Verified,
    Degraded,
    WrongRole,
    TemporarilyUnavailable,
    VerificationStale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonMode {
    None,
    PromptOnly,
    JsonObject,
    JsonSchemaLoose,
    JsonSchemaStrict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreSemantic {
    Cosine,
    DotProduct,
    DotProductUnitNormalized,
    SparseLexical,
    ColbertLateInteraction,
    RawLogit,
    LogitDifference,
    SigmoidLogitDifference,
    NormalizedYesProbability,
    ProviderRelevanceScore,
    ProviderNormalized,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepresentationKind {
    Dense,
    Sparse,
    MultiVector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderContract {
    PositionalVerified,
    IndexedVerified,
    SortedByScore,
    AlignedWithInput,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TruncationDirection {
    Left,
    Right,
    DocumentFirst,
    HeadAndTail,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteContract {
    pub path: String,
    pub method: String,
    pub dialect: TransportDialect,
    pub evidence: EvidenceLevel,
    pub status: CheckStatus,
    pub request_schema_fingerprint: Option<String>,
    pub response_schema_fingerprint: Option<String>,
    pub content_type: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingContract {
    pub representation: RepresentationKind,
    pub route: RouteContract,
    pub dimension: Option<usize>,
    pub supported_dimensions: Vec<usize>,
    pub finite_values_verified: bool,
    pub normalized_requested: Option<bool>,
    pub observed_l2_norm_min: Option<f64>,
    pub observed_l2_norm_max: Option<f64>,
    pub observed_l2_norm_mean: Option<f64>,
    pub score_semantic: ScoreSemantic,
    pub query_instruction: Option<String>,
    pub document_instruction: Option<String>,
    pub prompt_name: Option<String>,
    pub tokenizer_fingerprint: Option<String>,
    pub order_contract: OrderContract,
    pub max_batch_items_observed: Option<usize>,
    pub max_batch_tokens_observed: Option<u64>,
    pub max_item_tokens_observed: Option<u64>,
    pub duplicate_cosine_similarity: Option<f64>,
    pub duplicate_max_abs_difference: Option<f64>,
    pub truncation: Option<TruncationContract>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RerankContract {
    pub route: RouteContract,
    pub score_field: Option<String>,
    pub score_semantic: ScoreSemantic,
    pub higher_is_better: Option<bool>,
    pub observed_score_min: Option<f64>,
    pub observed_score_max: Option<f64>,
    pub order_contract: OrderContract,
    pub input_index_verified: bool,
    pub returns_documents: Option<bool>,
    pub top_k_supported: Option<bool>,
    pub raw_score_toggle_supported: Option<bool>,
    pub instruction: Option<String>,
    pub instruction_hash: Option<String>,
    pub max_documents_observed: Option<usize>,
    pub max_pair_tokens_observed: Option<u64>,
    pub max_request_tokens_observed: Option<u64>,
    pub truncation: Option<TruncationContract>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolContract {
    pub request_accepted: bool,
    pub native_single_call: bool,
    pub forced_call: bool,
    pub automatic_call: bool,
    pub tool_result_continuation: bool,
    pub parallel_calls: bool,
    pub strict_arguments: bool,
    pub arguments_may_be_object_not_string: bool,
    pub stream_arguments_fragmented: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamContract {
    pub route: RouteContract,
    pub event_framing: String,
    pub terminal_marker: Option<String>,
    pub terminal_finish_reason_observed: bool,
    pub usage_event_observed: bool,
    pub reasoning_field: Option<String>,
    pub cancellation_verified: bool,
    pub mixed_content_tool_finish_event_observed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TruncationContract {
    pub server_truncation_supported: Option<bool>,
    pub application_owns_truncation: bool,
    pub direction: TruncationDirection,
    pub silent_truncation_observed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowVerification {
    pub workflow_id: String,
    pub status: UserFacingStatus,
    pub required_roles: Vec<ModelRole>,
    pub required_checks: Vec<String>,
    pub missing_or_degraded: Vec<String>,
    pub verified_at_unix: Option<i64>,
    pub expires_at_unix: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationIdentity {
    pub schema_version: String,
    pub probe_suite_version: String,
    pub profile_id: String,
    pub endpoint_fingerprint: String,
    pub auth_scope_fingerprint: Option<String>,
    pub exact_catalog_model_id: String,
    pub discovery_metadata_hash: Option<String>,
    pub likely_upstream_model_id: Option<String>,
    pub upstream_match_confidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationRecord {
    pub identity: VerificationIdentity,
    pub name_hint_role: Option<ModelRole>,
    pub name_hint_catalog_version: Option<String>,
    pub documented_roles: Vec<ModelRole>,
    pub observed_roles: Vec<ModelRole>,
    pub routes: Vec<RouteContract>,
    pub json_mode: JsonMode,
    pub tools: Option<ToolContract>,
    pub stream: Option<StreamContract>,
    pub embeddings: Vec<EmbeddingContract>,
    pub rerankers: Vec<RerankContract>,
    pub declared_context_tokens: Option<u64>,
    pub observed_context_lower_bound: Option<u64>,
    pub observed_output_limit_lower_bound: Option<u64>,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub workflows: Vec<WorkflowVerification>,
    pub server_hints: BTreeMap<String, String>,
    pub redacted_evidence_hashes: Vec<String>,
    pub last_success_at_unix: Option<i64>,
    pub last_failure_at_unix: Option<i64>,
    pub last_failure_class: Option<String>,
    pub retry_after_until_unix: Option<i64>,
    pub verified_at_unix: Option<i64>,
    pub expires_at_unix: Option<i64>,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

impl VerificationRecord {
    /// A route outage should not erase previously verified semantic evidence.
    pub fn mark_temporarily_unavailable(
        &mut self,
        now_unix: i64,
        failure_class: impl Into<String>,
        retry_after_until_unix: Option<i64>,
    ) {
        self.last_failure_at_unix = Some(now_unix);
        self.last_failure_class = Some(failure_class.into());
        self.retry_after_until_unix = retry_after_until_unix;
        for workflow in &mut self.workflows {
            if workflow.status == UserFacingStatus::Verified
                || workflow.status == UserFacingStatus::Compatible
            {
                workflow.status = UserFacingStatus::TemporarilyUnavailable;
            }
        }
    }

    /// Identity-defining changes invalidate verification immediately.
    pub fn mark_stale(&mut self, reason: impl Into<String>) {
        self.stale = true;
        self.stale_reason = Some(reason.into());
        for workflow in &mut self.workflows {
            workflow.status = UserFacingStatus::VerificationStale;
        }
    }
}
