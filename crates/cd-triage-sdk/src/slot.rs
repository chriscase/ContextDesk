//! Minimum policy/slot contract types required by the public triage DTOs.

use serde::{Deserialize, Serialize};

/// Stable schema identifier for [`TriagePolicyV2`] documents.
///
/// The policy compiler itself stays in `cd-core`. This crate only publishes
/// the schema id and slot-kind vocabulary the wire contracts need.
pub const TRIAGE_POLICY_SCHEMA_V2: &str = "contextdesk.triage_policy.v2";

/// A contributor's bounded analytical role. Finalization and review are
/// deliberately separate slot types and cannot be disguised as contributors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageContributorRole {
    /// Extract host-grounded observations.
    ObservationExtractor,
    /// Analyze host-provided chronology without changing host ordinals.
    TimelineAnalyst,
    /// Propose symptoms, causal candidates, and competing explanations.
    CausalProposer,
    /// Identify contradictions between bounded candidates.
    ContradictionChecker,
    /// Identify evidence absent from the bounded packet.
    EvidenceGapFinder,
}

/// Kind of a policy slot, with finalizer/reviewer kept distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageSlotKindV2 {
    /// Initial bounded analytical contribution.
    Contributor(TriageContributorRole),
    /// Answer drafting from accepted reconciliation only.
    Finalizer,
    /// Conditional post-reconciliation review.
    Reviewer,
}
