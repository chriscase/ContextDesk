//! Host-grounded fast triage: making a fast or inexpensive chat model useful
//! without trusting its formatting or its causal judgement.
//!
//! The preserved research this implements ([`docs/planning/GPT_OSS_FAST_TRIAGE_INTEGRATION_V1.md`])
//! found something specific. A fast model qualified for generation, prompted
//! JSON, native tool calls, continuation, streaming, and cancellation — so its
//! product failures were **not** transport failures. What it did instead was
//! withhold the true initiating cause, promote a downstream failure into a
//! cause, or pull an independent telemetry finding into the main chain. And the
//! same model answered a direct, complete-timeline request correctly.
//!
//! The difference was evidence handoff, not intelligence. So this route changes
//! the handoff and then checks the result:
//!
//! * **[`packet`]** — the host hands over the *complete* permitted evidence
//!   packet in one bounded request: every candidate group plus the host-owned
//!   linked timeline, with literal host ids, a typed role vocabulary, host
//!   scope, and host chronology ordinals. Nothing is minted here; the packet is
//!   derived from the immutable evidence ledger and carries its own identity.
//! * **[`terminal`]** — only explicitly typed output is parsed, and the visible
//!   answer, the reasoning channel, tool calls, and terminal state stay apart.
//!   Malformed prose is never guessed into a pass and reasoning is structurally
//!   unable to reach a renderer.
//! * **[`validate`]** — local, host-decidable checks: permitted ids, root
//!   support, symptom promotion, independent/noise isolation, chronology, role
//!   coverage, contradictions, citation completeness, packet identity, and a
//!   non-empty visible answer. Where the host holds no role evidence the checks
//!   abstain and say so rather than passing.
//! * **[`prompt`]** — exactly one bounded, category-specific correction written
//!   by the host. The rejected proposal is never replayed as truth.
//! * **[`route`]** — a typed outcome: verified fast answer, honest partial, or
//!   escalation requested with the unchanged host packet and failure
//!   categories, plus at most one visible escalation to an explicitly
//!   configured and authorized fallback.
//! * **[`selection`]** — and none of it runs unless exact persisted
//!   profile/model/workflow evidence says so. Never a model name, never a
//!   gateway URL, never a global badge.
//!
//! Authority is unchanged throughout:
//! [`crate::investigation_answer::validate_model_answer`] remains the validator
//! and the host ledger remains the only source of ids. This module adds a
//! handoff and a set of local checks — not a second truth engine, not a second
//! HTTP client, and not a second scoring system.

pub mod neighborhood;
pub mod packet;
pub mod prompt;
pub mod route;
pub mod selection;
pub mod telemetry;
pub mod terminal;
pub mod validate;

pub use neighborhood::{
    classify_neighborhood, clock_compatibility_from_time_quality, FastTriageClockCompatibility,
    FastTriageEvidenceCategory, FastTriageNeighborhood, FastTriageNeighborhoodBudget,
    NeighborhoodRow,
};
pub use packet::{
    evidence_role_label, FastTriageEvidenceScope, FastTriagePacketInputs, FastTriagePacketRow,
    FastTriagePacketV1, FastTriageRoleEvidence, FAST_TRIAGE_PACKET_SCHEMA_V1,
};
pub use prompt::{
    correction_instruction, fast_triage_contract_fingerprint, fast_triage_evidence_block,
    fast_triage_messages, fast_triage_system_contract,
};
pub use route::{
    run_fast_triage_route, FastTriageBudget, FastTriageFallback, FastTriageInputs,
    FastTriageRouteOutcome, FastTriageStageEvent, FAST_TRIAGE_MAX_CORRECTIONS,
    FAST_TRIAGE_MAX_ESCALATION_ATTEMPTS,
};
pub use selection::{
    select_fast_triage_route, FastTriageRoleBinding, FastTriageRouteRecord,
    FastTriageRouteRejection, FastTriageRouteRequest, FastTriageRouteSelection,
    FastTriageRouteVerdict, FastTriageWorkflowContract, SelectedFastRoute,
};
pub use telemetry::{
    FastTriageAttemptOutcome, FastTriageAttemptTelemetry, FastTriageEscalationState,
    FastTriageEscalationTelemetry, FastTriageOutcomeLabel, FastTriagePacketTelemetry,
    FastTriageStage, FastTriageTelemetryV1, FAST_TRIAGE_TELEMETRY_SCHEMA_V1,
};
pub use terminal::{FastTriageTerminal, FastTriageTerminalState, FastTriageToolCallRef};
pub use validate::{validate_fast_answer, FastTriageFailureCategory, FastTriageValidation};
