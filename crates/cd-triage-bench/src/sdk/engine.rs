//! Named public SDK seams. The mock engine implements these; a future live
//! host would do the same without the bench importing cd-core.

use super::contracts::{SdkPolicySelection, SdkRecordedOutcome, SdkReplay, SdkShareSafeResult};
use crate::error::BenchResult;
use crate::packet::TaskPacket;

/// Scripted mock terminal. Live engines ignore this and use host outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SdkScriptedTerminal {
    Completed,
    Failed,
    Partial,
    TimedOut,
    Cancelled,
    PreflightRejected,
}

impl SdkScriptedTerminal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
            Self::PreflightRejected => "preflight_rejected",
        }
    }
}

/// Result of `compile` over a published policy selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkCompileReport {
    pub policy_fingerprint: String,
    pub slot_ids: Vec<String>,
}

/// Result of `preflight` over a compiled policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkPreflightReport {
    pub accepted: bool,
    pub reason_codes: Vec<String>,
}

/// Host-neutral public SDK seams used by the bench adapter.
pub trait PublicTriageEngine {
    /// Compile an already-supplied policy selection. No credentials or FS.
    fn compile(&self, policy: &SdkPolicySelection) -> BenchResult<SdkCompileReport>;

    /// Preflight the compiled policy. Rejection is a recorded failure, not a drop.
    fn preflight(
        &self,
        policy: &SdkPolicySelection,
        compiled: &SdkCompileReport,
    ) -> BenchResult<SdkPreflightReport>;

    /// Execute one materialized packet. Deterministic for the mock engine.
    fn execute(
        &self,
        policy: &SdkPolicySelection,
        packet: &TaskPacket,
        script: SdkScriptedTerminal,
    ) -> BenchResult<SdkRecordedOutcome>;

    /// Cooperative cancellation of one mock attempt. Still a recorded run.
    fn cancel(
        &self,
        policy: &SdkPolicySelection,
        packet: &TaskPacket,
    ) -> BenchResult<SdkRecordedOutcome> {
        self.execute(policy, packet, SdkScriptedTerminal::Cancelled)
    }

    /// Re-validate a recorded replay against published sequencing rules.
    fn replay(&self, outcome: &SdkRecordedOutcome) -> BenchResult<SdkReplay> {
        outcome.replay.validate()?;
        Ok(outcome.replay.clone())
    }

    /// Project the share-safe result and fail closed on a privacy scan.
    fn evaluate(&self, outcome: &SdkRecordedOutcome) -> BenchResult<SdkShareSafeResult> {
        outcome.share_safe_result.validate()?;
        Ok(outcome.share_safe_result.clone())
    }
}
