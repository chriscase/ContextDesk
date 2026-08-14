//! Top-level parse + validate entry points for extension contracts.

use super::negotiation::NegotiationProfileV1;
use super::outcomes::RoleOutcomeV1;
use super::packet::EvidencePacketV1;
use super::roles::RoleCapabilityV1;

/// Fail-closed validation error for extension contracts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionContractError {
    Parse {
        context: &'static str,
        detail: String,
    },
    SchemaMismatch {
        expected: String,
        got: String,
    },
    MalformedIdentity {
        field: String,
        reason: String,
    },
    DuplicateEvidenceId {
        evidence_id: String,
    },
    EmptyEvidence,
    DimensionSpaceMismatch {
        reason: String,
    },
    PrivacyLeak {
        findings: Vec<String>,
    },
    ModelNameAsCompatibility {
        token: String,
    },
    RoleProhibitionsMissing {
        role: String,
    },
    UnknownRole {
        role: String,
    },
    RootCauseWithoutHostAuthority,
    UnsupportedDialect {
        dialect: String,
    },
    NegotiationRefused {
        reason: String,
    },
    DuplicateCapability {
        kind: String,
    },
    /// Unknown JSON fields under deny_unknown_fields surface as parse errors;
    /// this variant is reserved for explicit unknown-field policy tests.
    UnknownField {
        field: String,
    },
}

impl std::fmt::Display for ExtensionContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse { context, detail } => write!(f, "parse:{context}:{detail}"),
            Self::SchemaMismatch { expected, got } => {
                write!(f, "schema_mismatch:expected={expected},got={got}")
            }
            Self::MalformedIdentity { field, reason } => {
                write!(f, "malformed_identity:field={field},reason={reason}")
            }
            Self::DuplicateEvidenceId { evidence_id } => {
                write!(f, "duplicate_evidence_id:{evidence_id}")
            }
            Self::EmptyEvidence => write!(f, "empty_evidence"),
            Self::DimensionSpaceMismatch { reason } => {
                write!(f, "dimension_space_mismatch:{reason}")
            }
            Self::PrivacyLeak { findings } => {
                write!(f, "privacy_leak:{}", findings.join(";"))
            }
            Self::ModelNameAsCompatibility { token } => {
                write!(f, "model_name_as_compatibility:{token}")
            }
            Self::RoleProhibitionsMissing { role } => {
                write!(f, "role_prohibitions_missing:{role}")
            }
            Self::UnknownRole { role } => write!(f, "unknown_role:{role}"),
            Self::RootCauseWithoutHostAuthority => {
                write!(f, "root_cause_without_host_authority")
            }
            Self::UnsupportedDialect { dialect } => {
                write!(f, "unsupported_dialect:{dialect}")
            }
            Self::NegotiationRefused { reason } => write!(f, "negotiation_refused:{reason}"),
            Self::DuplicateCapability { kind } => write!(f, "duplicate_capability:{kind}"),
            Self::UnknownField { field } => write!(f, "unknown_field:{field}"),
        }
    }
}

impl std::error::Error for ExtensionContractError {}

/// Parse + validate an evidence packet JSON document.
pub fn validate_evidence_packet_json(
    raw: &str,
) -> Result<EvidencePacketV1, ExtensionContractError> {
    let packet = super::packet::parse_evidence_packet(raw)?;
    packet.validate()?;
    Ok(packet)
}

/// Parse + validate a role-capability JSON document.
pub fn validate_role_capability_json(
    raw: &str,
) -> Result<RoleCapabilityV1, ExtensionContractError> {
    let cap = super::roles::parse_role_capability(raw)?;
    cap.validate()?;
    Ok(cap)
}

/// Parse + validate a role outcome JSON document.
pub fn validate_role_outcome_json(raw: &str) -> Result<RoleOutcomeV1, ExtensionContractError> {
    let out = super::outcomes::parse_role_outcome(raw)?;
    out.validate()?;
    Ok(out)
}

/// Parse + validate a negotiation profile JSON document.
pub fn validate_negotiation_json(
    raw: &str,
) -> Result<NegotiationProfileV1, ExtensionContractError> {
    let profile: NegotiationProfileV1 =
        serde_json::from_str(raw).map_err(|e| ExtensionContractError::Parse {
            context: "negotiation",
            detail: e.to_string(),
        })?;
    profile.validate()?;
    Ok(profile)
}
