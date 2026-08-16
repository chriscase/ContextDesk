//! ContextDesk public-SDK adapter for the triage bench (#879).
//!
//! The adapter drives named public seams (`compile`, `preflight`, `execute`,
//! `cancel`, `replay`, `evaluate`) against **published schema ids** from
//! `cd_core::triage_sdk`. It does not import `cd-core`, `cd-workflow`, Tauri,
//! a keychain, or any ContextDesk store. Default CI uses the deterministic
//! mock engine. Live provider execution is out of scope.

mod contracts;
mod engine;
mod materialize;
mod mock;
mod record;

pub use contracts::{
    ModelRef, SdkPolicySelection, SdkRecordedOutcome, SdkReplay, SdkShareSafeResult, SdkSlotRecord,
    SdkTerminal, MOCK_GATEWAY_PROFILE, MOCK_MODEL_ID, SDK_RECORDED_OUTCOME_SCHEMA_V1,
    TRIAGE_CANCELLATION_SCHEMA_V1, TRIAGE_REPLAY_SCHEMA_V1, TRIAGE_REQUEST_SCHEMA_V2,
    TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
};
pub use engine::{PublicTriageEngine, SdkCompileReport, SdkPreflightReport, SdkScriptedTerminal};
pub use materialize::{materialize_visible_packet, VisibilityRequest};
pub use mock::MockTriageEngine;
pub use record::{record_sdk_outcome, run_mock_task, SdkRunRequest, SdkStoredRun};
