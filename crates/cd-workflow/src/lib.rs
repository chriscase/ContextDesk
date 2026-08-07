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

pub mod chat;
pub mod import;
pub mod logging_quality;
pub mod normalize;
pub mod normalized;
pub mod provider;
pub mod provider_telemetry;
pub mod retrieval;
pub mod session;
pub mod timezone;
pub mod tools;
pub mod turn;

/// Re-export core context plan types at the shared workflow boundary.
pub use cd_core::context_plan::{
    apply_model_relevance, build_context_plan, CandidateDisposition, ContextCandidate,
    ContextInventorySnapshot, ContextPlan, ContextPlanBudget, ContextReasonCode,
    ContextSourceFamily, RelevanceStrategy,
};
