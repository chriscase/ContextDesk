//! Public, host-neutral triage wire contracts.
//!
//! This crate holds versioned request/event/result/replay DTOs and their
//! validators. It does not execute a turn, compile a policy, read a
//! filesystem, open a network connection, or touch credentials.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod answer;
pub mod model_ref;
pub mod privacy;
pub mod slot;
pub mod triage_sdk;

pub use answer::{
    AnswerBindingV1, AnswerEnvelopeV1, CanonicalCitationV1, ClaimKind, ClaimStatus, EvidenceRole,
    HostEvidenceEntry, InvestigationAnswerV1, InvestigationCandidateV1, InvestigationClaimV1,
    LogSnapshotRevisionV1, SCHEMA_V1,
};
pub use model_ref::{ModelRef, ModelRefError};
pub use privacy::{
    scan_share_safe_text, PacketPrivacyBoundary, PrivacyFinding, PRIVACY_FORBIDDEN_SUBSTRINGS,
};
pub use slot::{TriageContributorRole, TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2};
pub use triage_sdk::*;
