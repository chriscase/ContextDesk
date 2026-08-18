//! Host-neutral application/workflow layer.
//!
//! `cd-core` owns domain primitives and engines (parsing, storage, retrieval,
//! the tool host, the provider transport). Neither the Tauri desktop app nor
//! the CLI should re-derive production behavior above those primitives —
//! that orchestration belongs here, once, so both adapters call the same
//! code and can never quietly drift into "parallel implementations that
//! merely look equivalent."
//!
//! Every public function in this crate takes only `cd_core` types (or plain
//! values) as input — no Tauri `State`, no `tauri::Window`, no webview
//! concept anywhere. A caller supplies whatever host-specific glue it needs
//! (config-dir resolution, progress rendering, permission prompts) and this
//! crate does the rest identically for every host.

pub mod capability_qualification;
pub mod chat;
/// Workflow-layer resolution of the host-grounded fast-triage runtime.
pub mod fast_triage;
pub mod import;
pub mod logging_quality;
pub mod multi_model;
pub mod normalize;
pub mod normalized;
pub mod provider;
pub mod provider_telemetry;
pub mod retrieval;
pub mod retrieval_diagnostic;
pub mod session;
pub mod timezone;
pub mod tools;
/// Host-neutral Triage Policy V2 compilation and deterministic mock/replay seam.
pub mod triage;
/// Trusted application-state resolution for the V2 production runner.
pub mod triage_host;
/// Trusted-host, default-off adapter for the currently supported V2
/// contributor-only production subset.
pub mod triage_production;
/// Host-neutral asynchronous runner for the canonical Triage Policy V2 graph.
pub mod triage_production_runner;
/// Host-neutral exact-role qualification using the production backend and
/// packet/validator seams.
pub mod triage_role_qualification;
/// Public-runtime adapter over the trusted V2 host and production runner.
pub mod triage_runtime_host;
pub mod turn;

/// Re-export core context plan types at the shared workflow boundary.
pub use cd_core::context_plan::{
    apply_model_relevance, build_context_plan, CandidateDisposition, ContextCandidate,
    ContextInventorySnapshot, ContextPlan, ContextPlanBudget, ContextReasonCode,
    ContextSourceFamily, RelevanceStrategy,
};
