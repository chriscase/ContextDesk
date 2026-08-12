//! Typed multi-role outcome metadata (extension schema v1).
//!
//! Aligns with multi-model reconciliation states without replacing them.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Wire schema id for a single role outcome record.
pub const ROLE_OUTCOME_SCHEMA_V1: &str = "contextdesk.extension.role_outcome.v1";

/// Host-owned outcome state for one role attempt or reconciliation slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleOutcomeState {
    /// Bounded proposal has host support (not root establishment by itself).
    Supported,
    /// Overlap-tolerant disagreement: multiple supported readings remain open.
    Contested,
    /// Explicit abstention by the role.
    Abstained,
    /// Host recommends escalation (never automatic provider switch).
    EscalationRecommended,
    /// Required role did not complete (dropout).
    PartialRoleDropout,
    /// Host budget exhausted for this role/turn.
    BudgetExhausted,
    /// No usable model output; deterministic host baseline applies.
    DeterministicFallback,
    /// Role never started (unavailable / not scheduled).
    Unavailable,
    /// Insufficient evidence after partial completion.
    InsufficientEvidence,
}

impl RoleOutcomeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Contested => "contested",
            Self::Abstained => "abstained",
            Self::EscalationRecommended => "escalation_recommended",
            Self::PartialRoleDropout => "partial_role_dropout",
            Self::BudgetExhausted => "budget_exhausted",
            Self::DeterministicFallback => "deterministic_fallback",
            Self::Unavailable => "unavailable",
            Self::InsufficientEvidence => "insufficient_evidence",
        }
    }
}

/// One role's typed outcome metadata (share-safe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleOutcomeV1 {
    pub schema_id: String,
    /// Role token (must parse as ExtensionRole when used with role matrix).
    pub role: String,
    pub state: RoleOutcomeState,
    /// Echo of host packet_id the role was asked to use.
    pub packet_id: String,
    /// Corroboration count across independent contributors (host-computed).
    #[serde(default)]
    pub corroboration_count: u32,
    /// Distinct competing readings the host still holds open.
    #[serde(default)]
    pub open_readings: u32,
    /// True when host established root cause (only host validator may set true).
    #[serde(default)]
    pub root_cause_established: bool,
    /// Content-free reason tokens.
    #[serde(default)]
    pub reason_codes: Vec<String>,
    /// Latency/token labels only (never readiness).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_label_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget_label: Option<u32>,
}

pub fn parse_role_outcome(raw: &str) -> Result<RoleOutcomeV1, super::ExtensionContractError> {
    serde_json::from_str(raw).map_err(|e| super::ExtensionContractError::Parse {
        context: "role_outcome",
        detail: e.to_string(),
    })
}

impl RoleOutcomeV1 {
    pub fn validate(&self) -> Result<(), super::ExtensionContractError> {
        if self.schema_id != ROLE_OUTCOME_SCHEMA_V1 {
            return Err(super::ExtensionContractError::SchemaMismatch {
                expected: ROLE_OUTCOME_SCHEMA_V1.into(),
                got: self.schema_id.clone(),
            });
        }
        if self.packet_id.trim().is_empty() {
            return Err(super::ExtensionContractError::MalformedIdentity {
                field: "packet_id".into(),
                reason: "empty".into(),
            });
        }
        if super::roles::ExtensionRole::parse(&self.role).is_none() {
            return Err(super::ExtensionContractError::UnknownRole {
                role: self.role.clone(),
            });
        }
        let mut reason_codes = BTreeSet::new();
        if self.reason_codes.iter().any(|code| {
            code.trim().is_empty()
                || code.len() > 128
                || code.contains('/')
                || code.contains('\\')
                || code.contains("://")
                || code.chars().any(char::is_control)
                || !reason_codes.insert(code)
        }) {
            return Err(super::ExtensionContractError::MalformedIdentity {
                field: "reason_codes".into(),
                reason: "codes must be unique and content-free".into(),
            });
        }
        // Only deterministic host path may claim root cause established;
        // extension outcomes default false. True is reserved for host validator
        // mapping — fail closed if a pure extension fixture claims true without
        // host_support reason.
        if self.root_cause_established
            && !self
                .reason_codes
                .iter()
                .any(|c| c == "host_cause_role_validated")
        {
            return Err(super::ExtensionContractError::RootCauseWithoutHostAuthority);
        }
        if matches!(
            self.state,
            RoleOutcomeState::BudgetExhausted
                | RoleOutcomeState::PartialRoleDropout
                | RoleOutcomeState::Unavailable
                | RoleOutcomeState::DeterministicFallback
        ) && self.root_cause_established
        {
            return Err(super::ExtensionContractError::RootCauseWithoutHostAuthority);
        }
        Ok(())
    }
}
