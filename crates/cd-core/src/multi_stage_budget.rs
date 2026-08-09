//! Host-owned multi-stage admission budget (issue #869).
//!
//! Protects final comparison/synthesis with an explicit time and provider-round
//! reserve before another candidate investigation is admitted. Compatible
//! models may still be slow or verbose; orchestration timeout is not a
//! compatibility failure.
//!
//! Policy identity: [`MULTI_STAGE_BUDGET_POLICY_V1`].

use crate::router::TurnDeadlinePlan;
use serde::{Deserialize, Serialize};

/// Stable policy identity for diagnostics and quality-unit fingerprints.
pub const MULTI_STAGE_BUDGET_POLICY_V1: &str = "contextdesk.multi_stage_budget.v1";

/// Why a candidate was not admitted, or why the loop stopped early.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionDenial {
    /// Remaining whole-turn time is at or below the synthesis reserve.
    TimeReserve,
    /// Remaining provider rounds cannot fit this candidate plus final synthesis.
    RoundReserve,
    /// Cancel was observed before issuing the call.
    Cancelled,
    /// Whole-turn deadline already elapsed.
    Deadline,
}

impl AdmissionDenial {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TimeReserve => "time_reserve",
            Self::RoundReserve => "round_reserve",
            Self::Cancelled => "cancelled",
            Self::Deadline => "deadline",
        }
    }

    /// Host-authored operator detail (no model names).
    pub fn detail(self) -> &'static str {
        match self {
            Self::TimeReserve => {
                "remaining turn time is at or below the protected final-synthesis reserve; \
                 further candidates were not admitted"
            }
            Self::RoundReserve => {
                "remaining provider rounds cannot fit another candidate plus final synthesis"
            }
            Self::Cancelled => "turn cancelled before admitting the next candidate",
            Self::Deadline => "whole-turn deadline already elapsed",
        }
    }
}

/// Snapshot used for admission decisions (injected time, no wall I/O).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionSnapshot {
    /// Whole-turn remaining milliseconds (`None` = unlimited).
    pub remaining_total_ms: Option<u64>,
    /// Provider rounds already issued this multi-stage path.
    pub used_rounds: usize,
    /// Whole-turn provider-round ceiling.
    pub max_rounds: usize,
    /// Whether cancel is already set.
    pub cancelled: bool,
}

/// Computed reserve for one turn plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SynthesisReserve {
    /// Policy that produced this reserve.
    pub policy_id: &'static str,
    /// Milliseconds held back for final comparison/synthesis.
    pub time_reserve_ms: u64,
    /// Provider rounds held back for final comparison/synthesis (always ≥ 1
    /// when a multi-stage comparison is required).
    pub round_reserve: usize,
}

/// Compute the protected final-synthesis reserve from the whole-turn plan.
///
/// Rules (provider-agnostic):
/// - unlimited turns (`total_ms == 0`) reserve **0** time (round reserve still applies);
/// - otherwise reserve half the synthesizing-phase budget, floored by one quarter
///   of the whole turn, and never more than half the whole turn;
/// - always leave at least 1 ms of the turn unreserved when `total_ms > 0` so a
///   short explicit deadline remains usable;
/// - always reserve **1** provider round for final comparison.
pub fn synthesis_reserve(plan: &TurnDeadlinePlan) -> SynthesisReserve {
    if plan.total_ms == 0 {
        return SynthesisReserve {
            policy_id: MULTI_STAGE_BUDGET_POLICY_V1,
            time_reserve_ms: 0,
            round_reserve: 1,
        };
    }
    let from_phase = plan.synthesizing_ms.saturating_div(2).max(1);
    let from_total = plan.total_ms.saturating_div(4).max(1);
    let half_turn = plan.total_ms.saturating_div(2).max(1);
    let mut time_reserve_ms = from_phase.min(half_turn).max(from_total.min(half_turn));
    // Never reserve the entire turn.
    if time_reserve_ms >= plan.total_ms {
        time_reserve_ms = plan.total_ms.saturating_sub(1);
    }
    SynthesisReserve {
        policy_id: MULTI_STAGE_BUDGET_POLICY_V1,
        time_reserve_ms,
        round_reserve: 1,
    }
}

/// Whether one more candidate investigation may be issued.
///
/// Requires room for **this candidate round + reserved synthesis rounds** and
/// remaining wall time strictly greater than the time reserve (so synthesis
/// keeps a positive protected budget).
pub fn admit_candidate(
    snapshot: AdmissionSnapshot,
    reserve: SynthesisReserve,
) -> Result<(), AdmissionDenial> {
    if snapshot.cancelled {
        return Err(AdmissionDenial::Cancelled);
    }
    if snapshot.remaining_total_ms == Some(0) {
        return Err(AdmissionDenial::Deadline);
    }
    // used + 1 (this candidate) + round_reserve (synthesis) <= max_rounds
    let needed = snapshot
        .used_rounds
        .saturating_add(1)
        .saturating_add(reserve.round_reserve);
    if needed > snapshot.max_rounds {
        return Err(AdmissionDenial::RoundReserve);
    }
    if let Some(remaining) = snapshot.remaining_total_ms {
        if remaining <= reserve.time_reserve_ms {
            return Err(AdmissionDenial::TimeReserve);
        }
    }
    Ok(())
}

/// Cap for one candidate provider call so it cannot spend the synthesis reserve.
///
/// Returns `None` when the turn has no whole-turn deadline. Returns `Some(0)`
/// when the call must not be issued (deadline or reserve already binding).
pub fn candidate_operation_cap_ms(
    remaining_total_ms: Option<u64>,
    phase_cap_ms: u64,
    reserve: SynthesisReserve,
) -> Option<u64> {
    let remaining = remaining_total_ms?;
    let unprotected = remaining.saturating_sub(reserve.time_reserve_ms);
    Some(unprotected.min(phase_cap_ms))
}

/// Cap for final synthesis: uses remaining whole-turn time and phase, no extra reserve.
pub fn synthesis_operation_cap_ms(
    remaining_total_ms: Option<u64>,
    phase_cap_ms: u64,
) -> Option<u64> {
    let remaining = remaining_total_ms?;
    Some(remaining.min(phase_cap_ms))
}

/// Whether comparison may still run given drafts and budget after early stop.
pub fn can_run_comparison(
    draft_count: usize,
    snapshot: AdmissionSnapshot,
    reserve: SynthesisReserve,
) -> bool {
    if draft_count < 2 {
        return false;
    }
    if snapshot.cancelled {
        return false;
    }
    if snapshot.remaining_total_ms == Some(0) {
        return false;
    }
    // Need at least one remaining round for comparison.
    if snapshot.used_rounds.saturating_add(1) > snapshot.max_rounds {
        return false;
    }
    // Comparison may spend the reserved time — only refuse when already zero.
    let _ = reserve;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::TurnDeadlinePlan;

    fn plan(total: u64) -> TurnDeadlinePlan {
        TurnDeadlinePlan {
            total_ms: total,
            choosing_ms: total / 4,
            retrieving_ms: total / 3,
            synthesizing_ms: total / 2,
            explicit: true,
        }
    }

    #[test]
    fn policy_id_is_stable() {
        assert_eq!(
            MULTI_STAGE_BUDGET_POLICY_V1,
            "contextdesk.multi_stage_budget.v1"
        );
        let r = synthesis_reserve(&plan(120_000));
        assert_eq!(r.policy_id, MULTI_STAGE_BUDGET_POLICY_V1);
        assert_eq!(r.round_reserve, 1);
        assert!(r.time_reserve_ms > 0);
        assert!(r.time_reserve_ms < 120_000);
    }

    #[test]
    fn unlimited_turn_reserves_zero_time() {
        let r = synthesis_reserve(&plan(0));
        assert_eq!(r.time_reserve_ms, 0);
        assert_eq!(r.round_reserve, 1);
    }

    #[test]
    fn refuse_when_time_at_reserve() {
        let r = synthesis_reserve(&plan(100));
        let snap = AdmissionSnapshot {
            remaining_total_ms: Some(r.time_reserve_ms),
            used_rounds: 0,
            max_rounds: 8,
            cancelled: false,
        };
        assert_eq!(admit_candidate(snap, r), Err(AdmissionDenial::TimeReserve));
    }

    #[test]
    fn refuse_when_rounds_cannot_fit_synthesis() {
        let r = synthesis_reserve(&plan(120_000));
        let snap = AdmissionSnapshot {
            remaining_total_ms: Some(60_000),
            used_rounds: 7,
            max_rounds: 8, // only 1 left — needed for synthesis, not another candidate
            cancelled: false,
        };
        assert_eq!(admit_candidate(snap, r), Err(AdmissionDenial::RoundReserve));
    }

    #[test]
    fn admit_when_time_and_rounds_allow() {
        let r = synthesis_reserve(&plan(120_000));
        let snap = AdmissionSnapshot {
            remaining_total_ms: Some(r.time_reserve_ms.saturating_add(5_000)),
            used_rounds: 0,
            max_rounds: 8,
            cancelled: false,
        };
        assert!(admit_candidate(snap, r).is_ok());
    }

    #[test]
    fn candidate_cap_protects_reserve() {
        let r = SynthesisReserve {
            policy_id: MULTI_STAGE_BUDGET_POLICY_V1,
            time_reserve_ms: 30_000,
            round_reserve: 1,
        };
        assert_eq!(
            candidate_operation_cap_ms(Some(50_000), 40_000, r),
            Some(20_000)
        );
        assert_eq!(candidate_operation_cap_ms(Some(30_000), 40_000, r), Some(0));
        assert_eq!(candidate_operation_cap_ms(None, 40_000, r), None);
    }

    #[test]
    fn comparison_allowed_with_two_drafts_and_one_round() {
        let r = synthesis_reserve(&plan(120_000));
        let snap = AdmissionSnapshot {
            remaining_total_ms: Some(10),
            used_rounds: 2,
            max_rounds: 3,
            cancelled: false,
        };
        assert!(can_run_comparison(2, snap, r));
        assert!(!can_run_comparison(1, snap, r));
    }

    #[test]
    fn cancel_and_deadline_block_admission() {
        let r = synthesis_reserve(&plan(120_000));
        assert_eq!(
            admit_candidate(
                AdmissionSnapshot {
                    remaining_total_ms: Some(60_000),
                    used_rounds: 0,
                    max_rounds: 8,
                    cancelled: true,
                },
                r
            ),
            Err(AdmissionDenial::Cancelled)
        );
        assert_eq!(
            admit_candidate(
                AdmissionSnapshot {
                    remaining_total_ms: Some(0),
                    used_rounds: 0,
                    max_rounds: 8,
                    cancelled: false,
                },
                r
            ),
            Err(AdmissionDenial::Deadline)
        );
    }
}
