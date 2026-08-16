//! Map a public-SDK recorded outcome onto a bench `TriageRun`.

use super::contracts::{SdkPolicySelection, SdkRecordedOutcome, SdkTerminal};
use super::engine::{PublicTriageEngine, SdkScriptedTerminal};
use super::materialize::{materialize_visible_packet, VisibilityRequest};
use super::mock::MockTriageEngine;
use crate::error::{BenchError, BenchResult};
use crate::privacy::gate_share_safe_text;
use crate::store::{BenchStore, PutRunOutcome};
use crate::types::{
    Completeness, FairnessClass, Observed, PromptWorkflow, RawOutput, RunStatus, SourceKind,
    StrategyIdentity, TriageRun, RUN_SCHEMA_V1,
};

/// Inputs for one hermetic mock execution against a stored task.
pub struct SdkRunRequest<'a> {
    pub task_id: &'a str,
    pub script: SdkScriptedTerminal,
    pub operator: &'a str,
    pub created_at: &'a str,
    pub requested_item_ids: Option<&'a [String]>,
    pub policy: SdkPolicySelection,
}

impl<'a> SdkRunRequest<'a> {
    pub fn mock(task_id: &'a str, script: SdkScriptedTerminal) -> Self {
        Self {
            task_id,
            script,
            operator: "sdk-mock",
            created_at: "2026-01-15T08:00:00Z",
            requested_item_ids: None,
            policy: SdkPolicySelection::mock_standard(),
        }
    }
}

/// Bench store result of recording one SDK attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkStoredRun {
    pub run_id: String,
    pub outcome: SdkRecordedOutcome,
    pub duplicate: bool,
}

/// Snapshot → packet → mock engine → recorded run (offline).
pub fn run_mock_task(store: &BenchStore, request: SdkRunRequest<'_>) -> BenchResult<SdkStoredRun> {
    let task = store.get_task(request.task_id)?;
    let case = store.get_case(&task.case_id)?;
    let snapshot = store.get_snapshot(&task.snapshot_id)?;
    let packet = materialize_visible_packet(
        &case,
        &snapshot,
        &task,
        VisibilityRequest {
            requested_item_ids: request.requested_item_ids,
        },
    )?;
    let _ = store.materialize_packet(request.task_id)?;
    let engine = MockTriageEngine;
    let outcome = match request.script {
        SdkScriptedTerminal::Cancelled => engine.cancel(&request.policy, &packet)?,
        other => engine.execute(&request.policy, &packet, other)?,
    };
    if outcome.task_id != task.task_id || outcome.snapshot_id != task.snapshot_id {
        return Err(BenchError::CrossSnapshot(
            "SDK outcome is not bound to the materialized task snapshot".into(),
        ));
    }
    let _replay = engine.replay(&outcome)?;
    let share_safe = engine.evaluate(&outcome)?;
    let encoded = serde_json::to_string(&share_safe).map_err(BenchError::from_serde)?;
    gate_share_safe_text(&encoded)?;
    record_sdk_outcome(store, &outcome, request.operator, request.created_at)
}

/// Persist the recorded outcome as a `contextdesk_sdk` `TriageRun`.
pub fn record_sdk_outcome(
    store: &BenchStore,
    outcome: &SdkRecordedOutcome,
    operator: &str,
    created_at: &str,
) -> BenchResult<SdkStoredRun> {
    outcome.validate()?;
    let task = store.get_task(&outcome.task_id)?;
    if task.snapshot_id != outcome.snapshot_id {
        return Err(BenchError::CrossSnapshot(
            "SDK outcome snapshot does not match the stored task".into(),
        ));
    }
    let raw_bytes = outcome.to_canonical_bytes()?;
    let digest = store.put_blob(&raw_bytes)?;
    let status = match outcome.terminal {
        SdkTerminal::Completed => RunStatus::Completed,
        SdkTerminal::Failed => RunStatus::Failed,
        SdkTerminal::Partial => RunStatus::Partial,
        SdkTerminal::TimedOut => RunStatus::TimedOut,
        SdkTerminal::Cancelled => RunStatus::Cancelled,
    };
    let run = TriageRun {
        schema_id: RUN_SCHEMA_V1.into(),
        run_id: String::new(),
        privacy: outcome.privacy,
        case_id: task.case_id.clone(),
        task_id: task.task_id.clone(),
        snapshot_id: task.snapshot_id.clone(),
        strategy: StrategyIdentity {
            name: "contextdesk-sdk".into(),
            version: Observed::Known("public-contract-v2".into()),
            build: Observed::Known("mock".into()),
        },
        source_kind: SourceKind::ContextdeskSdk,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output: RawOutput {
            digest: digest.clone(),
            byte_length: raw_bytes.len() as u64,
            encoding: "utf-8".into(),
        },
        claims: outcome
            .share_safe_result
            .accepted_evidence_ids
            .iter()
            .map(|id| crate::types::ClaimedCitation {
                claim: format!("accepted evidence {id}"),
                evidence_item_id: Some(id.clone()),
                locator: None,
            })
            .collect(),
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status,
        operator: operator.into(),
        importer: Some("sdk-adapter-mock".into()),
        created_at: created_at.into(),
        near_duplicate_of: None,
    };
    let fingerprint = run.fingerprint()?;
    let mut run = run;
    run.run_id = format!("run-{fingerprint}");
    run.validate()?;
    let duplicate = match store.put_run(&run)? {
        PutRunOutcome::Created { .. } => false,
        PutRunOutcome::Duplicate { .. } => true,
    };
    Ok(SdkStoredRun {
        run_id: run.run_id,
        outcome: outcome.clone(),
        duplicate,
    })
}
