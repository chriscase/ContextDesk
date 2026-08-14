//! Versioned **extension contracts** for future multi-model triage and retrieval.
//!
//! These types and pure validators document and check durable, provider-neutral
//! envelopes. They **map** to existing host concepts
//! ([`crate::investigation_answer`], [`crate::fast_triage::packet`],
//! [`crate::capability_qualification`], [`crate::embedding_space`]) without
//! replacing production chat, turn, or qualification paths.
//!
//! # Authority
//!
//! Host-owned: evidence ids, roles, chronology, packet digests, citations,
//! budgets, and final acceptance. Models may only propose against permitted
//! opaque ids. Model/product **names never imply compatibility**.
//!
//! # Non-claims
//!
//! No readiness badges. No universal provider/model compatibility. Omission is
//! the default for negotiation; unsupported dialects fail closed.

#![allow(missing_docs)] // Schema field names are the external contract surface.

pub mod negotiation;
pub mod outcomes;
pub mod packet;
pub mod privacy;
pub mod roles;
pub mod validate;

pub use negotiation::{
    negotiation_supports, CapabilityKind, CapabilityRequest, NegotiationDialect,
    NegotiationProfileV1, NegotiationVerdict, NEGOTIATION_SCHEMA_V1,
};
pub use outcomes::{parse_role_outcome, RoleOutcomeState, RoleOutcomeV1, ROLE_OUTCOME_SCHEMA_V1};
pub use packet::{
    parse_evidence_packet, EvidencePacketV1, PacketPrivacyBoundary, TimeQualityLabel,
    EVIDENCE_PACKET_SCHEMA_V1,
};
pub use privacy::{scan_share_safe_text, PrivacyFinding, PRIVACY_FORBIDDEN_SUBSTRINGS};
pub use roles::{
    parse_role_capability, ExtensionRole, RoleCapabilityV1, ROLE_CAPABILITY_SCHEMA_V1,
};
pub use validate::{
    validate_evidence_packet_json, validate_negotiation_json, validate_role_capability_json,
    validate_role_outcome_json, ExtensionContractError,
};
