//! Deterministic offline mock engine. No time, network, credentials, or FS.

use super::contracts::{
    request_fingerprint, sdk_run_id, slot_fingerprint, SdkEventPayload, SdkPolicySelection,
    SdkReconciliation, SdkRecordedOutcome, SdkReplay, SdkRunEvent, SdkShareSafeResult,
    SdkSlotRecord, SdkTerminal, MOCK_FINALIZER_SLOT, SDK_RECORDED_OUTCOME_SCHEMA_V1,
    TRIAGE_REPLAY_SCHEMA_V1, TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2,
    TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
};
use super::engine::{
    PublicTriageEngine, SdkCompileReport, SdkPreflightReport, SdkScriptedTerminal,
};
use crate::error::{BenchError, BenchResult};
use crate::packet::TaskPacket;
use crate::types::{Observed, PrivacyClass};

/// Hermetic mock that implements the public SDK seams.
#[derive(Debug, Clone, Default)]
pub struct MockTriageEngine;

impl PublicTriageEngine for MockTriageEngine {
    fn compile(&self, policy: &SdkPolicySelection) -> BenchResult<SdkCompileReport> {
        policy.model().validate()?;
        Ok(SdkCompileReport {
            policy_fingerprint: policy.fingerprint()?,
            slot_ids: vec![MOCK_FINALIZER_SLOT.into()],
        })
    }

    fn preflight(
        &self,
        policy: &SdkPolicySelection,
        compiled: &SdkCompileReport,
    ) -> BenchResult<SdkPreflightReport> {
        let expected = policy.fingerprint()?;
        if compiled.policy_fingerprint != expected {
            return Err(BenchError::Integrity(
                "preflight policy fingerprint does not match compile".into(),
            ));
        }
        Ok(SdkPreflightReport {
            accepted: true,
            reason_codes: Vec::new(),
        })
    }

    fn execute(
        &self,
        policy: &SdkPolicySelection,
        packet: &TaskPacket,
        script: SdkScriptedTerminal,
    ) -> BenchResult<SdkRecordedOutcome> {
        let compiled = self.compile(policy)?;
        if matches!(script, SdkScriptedTerminal::PreflightRejected) {
            return build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::Failed,
                "preflight_rejected",
                "failed",
                "failed",
                false,
                Vec::new(),
                vec!["preflight_rejected".into()],
            );
        }
        let preflight = self.preflight(policy, &compiled)?;
        if !preflight.accepted {
            return Err(BenchError::Schema("mock preflight rejected".into()));
        }
        match script {
            SdkScriptedTerminal::Completed => build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::Completed,
                "completed",
                "grounded_final",
                "passed",
                true,
                visible_ids(packet),
                vec!["mock_completed".into()],
            ),
            SdkScriptedTerminal::Partial => build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::Partial,
                "completed",
                "honest_partial",
                "partial",
                false,
                visible_ids(packet).into_iter().take(1).collect(),
                vec!["mock_partial".into()],
            ),
            SdkScriptedTerminal::Failed => build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::Failed,
                "failed",
                "honest_partial",
                "failed",
                false,
                Vec::new(),
                vec!["mock_failed".into()],
            ),
            SdkScriptedTerminal::TimedOut => build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::TimedOut,
                "timed_out",
                "honest_partial",
                "failed",
                false,
                Vec::new(),
                vec!["mock_timed_out".into()],
            ),
            SdkScriptedTerminal::Cancelled => build_outcome(
                policy,
                packet,
                &compiled,
                SdkTerminal::Cancelled,
                "cancelled",
                "honest_partial",
                "failed",
                false,
                Vec::new(),
                vec!["mock_cancelled".into()],
            ),
            SdkScriptedTerminal::PreflightRejected => unreachable!("handled above"),
        }
    }
}

fn visible_ids(packet: &TaskPacket) -> Vec<String> {
    packet
        .evidence
        .iter()
        .map(|item| item.item_id.clone())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_outcome(
    policy: &SdkPolicySelection,
    packet: &TaskPacket,
    compiled: &SdkCompileReport,
    terminal: SdkTerminal,
    slot_disposition: &str,
    result_kind: &str,
    validation_state: &str,
    slot_completed: bool,
    accepted_evidence_ids: Vec<String>,
    reason_codes: Vec<String>,
) -> BenchResult<SdkRecordedOutcome> {
    let model = policy.model().clone();
    let policy_fingerprint = compiled.policy_fingerprint.clone();
    let packet_fingerprint = packet.packet_id.clone();
    let corpus_fingerprint = packet.snapshot_id.clone();
    let request_fp = request_fingerprint(
        &packet.task_id,
        &packet.packet_id,
        &policy_fingerprint,
        &corpus_fingerprint,
    )?;
    let sdk_run_id = sdk_run_id(&request_fp, terminal);
    let slot_fp = slot_fingerprint(MOCK_FINALIZER_SLOT, "finalizer", slot_disposition, &model)?;
    let slot = SdkSlotRecord {
        slot_id: MOCK_FINALIZER_SLOT.into(),
        role: "finalizer".into(),
        disposition: slot_disposition.into(),
        fingerprint: slot_fp,
        model: model.clone(),
    };
    let completed_slots = u32::from(slot_completed);
    let reconciliation = SdkReconciliation {
        state: if slot_completed {
            "reconciled".into()
        } else {
            "incomplete".into()
        },
        configured_role_slots: 1,
        completed_role_slots: completed_slots,
        distinct_models: completed_slots,
        distinct_gateways: completed_slots,
        supported_claim_ids: accepted_evidence_ids.clone(),
        conflict_ids: Vec::new(),
        gap_ids: Vec::new(),
        root_cause_established: false,
    };
    let share_safe_result = SdkShareSafeResult {
        schema_id: TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2.into(),
        run_id: sdk_run_id.clone(),
        kind: result_kind.into(),
        validation_state: validation_state.into(),
        packet_id: packet.packet_id.clone(),
        reconciliation,
        accepted_evidence_ids,
        reason_codes: reason_codes.clone(),
    };
    let replay = build_replay(
        &sdk_run_id,
        &request_fp,
        &policy_fingerprint,
        packet,
        terminal,
        slot_disposition,
        &reason_codes,
    )?;
    let outcome = SdkRecordedOutcome {
        schema_id: SDK_RECORDED_OUTCOME_SCHEMA_V1.into(),
        privacy: PrivacyClass::ShareSafe,
        engine: "mock".into(),
        terminal,
        sdk_run_id,
        task_id: packet.task_id.clone(),
        snapshot_id: packet.snapshot_id.clone(),
        packet_id: packet.packet_id.clone(),
        packet_fingerprint,
        corpus_fingerprint,
        policy_fingerprint,
        request_fingerprint: request_fp,
        models: vec![model],
        slots: vec![slot],
        share_safe_result,
        replay,
        usage: Observed::Unknown,
        cost: Observed::Unknown,
    };
    outcome.validate()?;
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
fn build_replay(
    sdk_run_id: &str,
    request_fingerprint: &str,
    policy_fingerprint: &str,
    packet: &TaskPacket,
    terminal: SdkTerminal,
    slot_disposition: &str,
    reason_codes: &[String],
) -> BenchResult<SdkReplay> {
    let mut events = vec![
        event(
            sdk_run_id,
            0,
            SdkEventPayload::RunStarted {
                request_fingerprint: request_fingerprint.into(),
                policy_fingerprint: policy_fingerprint.into(),
            },
        ),
        event(
            sdk_run_id,
            1,
            SdkEventPayload::PacketReady {
                packet_id: packet.packet_id.clone(),
                packet_digest: packet.packet_id.clone(),
                evidence_count: packet.evidence.len() as u32,
            },
        ),
        event(
            sdk_run_id,
            2,
            SdkEventPayload::RoleAttempt {
                attempt_id: format!("attempt-{MOCK_FINALIZER_SLOT}"),
                role_slot_id: MOCK_FINALIZER_SLOT.into(),
                role: "finalizer".into(),
                status: slot_disposition.into(),
            },
        ),
        event(
            sdk_run_id,
            3,
            SdkEventPayload::Reconciliation {
                state: if matches!(terminal, SdkTerminal::Completed) {
                    "reconciled".into()
                } else {
                    "incomplete".into()
                },
            },
        ),
        event(
            sdk_run_id,
            4,
            SdkEventPayload::Validation {
                passed: matches!(terminal, SdkTerminal::Completed),
                reason_codes: reason_codes.to_vec(),
            },
        ),
    ];
    let terminal_event = match terminal {
        SdkTerminal::Completed | SdkTerminal::Partial => SdkEventPayload::Completed {
            result_schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
        },
        SdkTerminal::Failed => SdkEventPayload::Failed {
            category: reason_codes
                .first()
                .cloned()
                .unwrap_or_else(|| "mock_failed".into()),
        },
        SdkTerminal::TimedOut => SdkEventPayload::TimedOut {
            category: "mock_timed_out".into(),
        },
        SdkTerminal::Cancelled => SdkEventPayload::Cancelled {
            cancellation_id: format!("cancel-{sdk_run_id}"),
        },
    };
    events.push(event(sdk_run_id, 5, terminal_event));
    let replay = SdkReplay {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: sdk_run_id.into(),
        request_fingerprint: request_fingerprint.into(),
        events,
    };
    replay.validate()?;
    Ok(replay)
}

fn event(run_id: &str, sequence: u64, payload: SdkEventPayload) -> SdkRunEvent {
    SdkRunEvent {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        sequence,
        privacy: "owner_only".into(),
        event: payload,
    }
}
