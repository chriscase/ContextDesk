//! Minimum owner-only answer envelope types referenced by `TriageResultV2`.
//!
//! Validation, ledger construction, and model-proposal parsing stay in
//! `cd-core::investigation_answer`. These structs are the persistable wire
//! shape only.

use serde::{Deserialize, Serialize};

/// Stable schema for model proposals and validated answers.
pub const SCHEMA_V1: &str = "contextdesk.investigation_answer.v1";

/// Exact log-analysis snapshot which grounds one typed answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LogSnapshotRevisionV1 {
    /// Event-store revision.
    pub event_revision: u64,
    /// Template-analysis revision.
    pub template_analysis_revision: u64,
    /// Suppression revision.
    pub suppression_revision: u64,
}

/// Kind of a host-validated claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimKind {
    /// Host-grounded observation.
    Observation,
    /// Downstream symptom.
    Symptom,
    /// Causal candidate.
    CausalCandidate,
    /// Initiating cause.
    InitiatingCause,
    /// Competing explanation.
    CompetingExplanation,
    /// Missing evidence.
    MissingEvidence,
}

/// Host-assigned evidence role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRole {
    /// Host-classified initiating cause evidence.
    Cause,
    /// Supporting evidence.
    Supporting,
    /// Downstream symptom evidence.
    Symptom,
    /// Neutral evidence.
    Neutral,
}

/// Host-assigned claim status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    /// Supported by host evidence.
    Supported,
    /// Unsupported.
    Unsupported,
    /// Withheld.
    Withheld,
}

/// One host-validated claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationClaimV1 {
    /// Claim identity.
    pub claim_id: String,
    /// Claim kind.
    pub claim_kind: ClaimKind,
    /// Claim text.
    pub text: String,
    /// Candidate this claim belongs to.
    pub candidate_id: String,
    /// Cited host evidence ids.
    pub evidence_ids: Vec<String>,
    /// Host status.
    pub status: ClaimStatus,
}

/// One host-validated candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationCandidateV1 {
    /// Candidate identity.
    pub candidate_id: String,
    /// Claims in this candidate.
    pub claims: Vec<InvestigationClaimV1>,
}

/// Host-owned canonical citation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalCitationV1 {
    /// Evidence identity.
    pub evidence_id: String,
    /// Candidate identity.
    pub candidate_id: String,
    /// Source label.
    pub source_label: String,
    /// Locator.
    pub locator: String,
    /// Corpus identity.
    pub corpus_id: String,
    /// Snapshot revision.
    pub revision: LogSnapshotRevisionV1,
    /// Host-owned bounded excerpt.
    pub content: String,
}

/// Host-validated investigation answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationAnswerV1 {
    /// Schema id.
    pub schema: String,
    /// Candidates.
    pub candidates: Vec<InvestigationCandidateV1>,
    /// Canonical citations.
    pub canonical_citations: Vec<CanonicalCitationV1>,
    /// Whether a root cause was established.
    pub root_cause_established: bool,
}

/// Host-owned evidence row, immutable for the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEvidenceEntry {
    /// Evidence identity.
    pub evidence_id: String,
    /// Candidate identity.
    pub candidate_id: String,
    /// Source label.
    pub source_label: String,
    /// Locator.
    pub locator: String,
    /// Corpus identity.
    pub corpus_id: String,
    /// Snapshot revision.
    pub revision: LogSnapshotRevisionV1,
    /// Host role.
    pub role: EvidenceRole,
    /// Host-owned bounded excerpt; never supplied by the model.
    pub content: String,
}

/// Host-authored binding for one answer envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerBindingV1 {
    /// Session identity.
    pub session_id: String,
    /// Turn identity.
    pub turn_id: String,
    /// Corpus identity.
    pub corpus_id: String,
    /// Snapshot revision.
    pub revision: LogSnapshotRevisionV1,
    /// Ledger digest.
    pub ledger_digest: String,
}

/// Persistable authoritative state for later host-only CLI/GUI/session lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerEnvelopeV1 {
    /// Turn binding.
    pub binding: AnswerBindingV1,
    /// Host evidence rows.
    pub evidence: Vec<HostEvidenceEntry>,
    /// Validated answer.
    pub answer: InvestigationAnswerV1,
    /// Semantic attempt count.
    pub semantic_attempts: u8,
}
