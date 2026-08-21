//! ContextDesk as one strategy among many, over the public SDK boundary.
//!
//! # What this crate is
//!
//! An **offline adapter** that turns a `cd-triage-bench` evidence snapshot and
//! evaluation task into a real [`cd_triage_sdk`] triage request, accepts a
//! validated public-SDK [`cd_triage_sdk::TriageReplayV1`] (from the
//! deterministic mock or an imported replay), and records the outcome as an
//! owner-only `cd_triage_bench::TriageRun`.
//!
//! # Boundary rules this crate holds
//!
//! * **Public contracts only.** Every DTO, schema id, bound, and validator
//!   comes from `cd-triage-sdk`; canonical request identity comes from
//!   `cd-triage-runtime`. The adapter declares no schema id, request-identity
//!   algorithm, or validator of its own — in particular the event stream is
//!   accepted or rejected by the real
//!   [`cd_triage_sdk::TriageReplayV1::validate`].
//! * **Pure default features.** The default dependency tree is
//!   `cd-triage-sdk` + `cd-triage-runtime` + `cd-triage-bench` (and their
//!   dependency-light leaves). No `cd-core`, `cd-workflow`, DuckDB, SQLite,
//!   keyring, `reqwest`, `tokio`, or Tauri. See
//!   `tests/dependency_direction.rs`.
//! * **No engine writes.** Nothing here writes a ContextDesk case,
//!   adjudication, score, qualification, readiness, routing, or private-store
//!   record. The bench owns cases, adjudication, and scoring.
//! * **Fail closed.** A widened packet, an out-of-order replay, an over-bound
//!   payload, or a share-safe projection that trips the real privacy scan is a
//!   refusal, never a repair or a redaction.
//!
//! # Honest limits
//!
//! * The host-neutral runtime facade exists, but this adapter does not call its
//!   live execution functions and has no host engine implementation.
//! * The default engine is a deterministic mock. It contacts no provider,
//!   holds no evidence bytes, and produces no model text. The `live` feature
//!   is a non-default placeholder and carries no engine dependency.
//! * Token usage and cost stay unknown. The public envelope reports neither,
//!   and unknown is not zero.
//!
//! # Pipeline
//!
//! ```text
//! Case + EvidenceSnapshot + EvaluationTask
//!   -> materialize_bounded_packet   (visibility fail-closed, twice)
//!   -> build_request                (real TriageRequestV2::validate)
//!   -> run_deterministic_mock | imported TriageReplayV1
//!   -> validate_public_replay       (real TriageReplayV1::validate)
//!   -> record_run                   (owner-only; real TriageRun::validate)
//!   -> project_share_safe           (explicit projection; real scan)
//! ```
//!
//! Replay ingest is **not** live execution. Usage and cost stay unknown.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod collab_export;
pub mod engine;
pub mod error;
pub mod fingerprint;
pub mod packet;
pub mod record;
pub mod replay;
pub mod request;
pub mod share_safe;

pub use collab_export::{
    project_strategy_package, StrategyLaneSpec, StrategyPackageOptions,
    BENCH_RUN_ARTIFACT_SCHEMA_V1, INTERACTION_TRACE_SCHEMA_V1, STRATEGY_PACKAGE_SCHEMA_V1,
};
pub use engine::{
    run_deterministic_mock, MockCorrection, MockEnginePlan, MockRunOutcome, MockSlotOutcome,
    MockSlotPlan, MockTerminalPlan, MockValidation, DETERMINISTIC_MOCK_REASON_CODE,
};
pub use error::{AdapterError, AdapterResult};
pub use fingerprint::fingerprint;
pub use packet::{materialize_bounded_packet, BoundedPacket};
pub use record::{
    record_run, HostExecutionProof, HostPacketEvidenceBinding, HostSourceBinding, OwnerOnlyRecord,
    RecordedContextDeskRun, RecordingContext, RunFingerprints, SlotProvenance, TerminalProvenance,
};
pub use replay::{
    decode_replay_json, record_live_public_replay, record_public_replay,
    validate_live_public_replay, validate_public_replay, ExecutionPacketState,
    ValidatedReplayOutcome,
};
pub use request::{build_live_request, build_request, BoundRequest};
pub use share_safe::{project_share_safe, ShareSafeAdapterRun, ShareSafeSlot};

use cd_triage_bench::{Case, EvaluationTask, EvidenceSnapshot};
use cd_triage_sdk::{TriagePolicySelectionV2, TriageRequestOverridesV1};

/// One offline run, end to end.
///
/// Convenience over the module functions; it adds no behaviour of its own and
/// every stage keeps its own fail-closed check.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterRun {
    /// The bounded packet the strategy was allowed to see.
    pub bounded: BoundedPacket,
    /// The validated public request.
    pub bound: BoundRequest,
    /// The validated public-SDK replay and its attempts.
    pub outcome: ValidatedReplayOutcome,
    /// The owner-only recorded bench run.
    pub recorded: RecordedContextDeskRun,
}

/// Run the whole offline pipeline for one bench task.
#[allow(clippy::too_many_arguments)]
pub fn run_offline(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    policy: TriagePolicySelectionV2,
    overrides: TriageRequestOverridesV1,
    cancellation_id: &str,
    plan: &MockEnginePlan,
    context: &RecordingContext,
) -> AdapterResult<AdapterRun> {
    let bounded = materialize_bounded_packet(case, snapshot, task)?;
    let bound = build_request(snapshot, task, &bounded, policy, overrides, cancellation_id)?;
    let mock = run_deterministic_mock(&bound, &bounded, plan)?;
    let outcome = validate_public_replay(mock.replay, &bound)?;
    let recorded = record_run(snapshot, task, &bound, &bounded, &outcome, context)?;
    Ok(AdapterRun {
        bounded,
        bound,
        outcome,
        recorded,
    })
}
