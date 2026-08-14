//! ContextDesk core library.
//!
//! Hosts (desktop, server, embeds) depend on this crate for business logic.
//! Keep secrets and OS integration at the host boundary where needed;
//! pure policy and tools live here.

#![deny(missing_docs)]
// Fail CI (-D warnings) on new raw `&str` byte-index slicing unless scoped-allowed.
// Prefer `text::truncate_bytes` / `floor_char_boundary` for untrusted multi-byte text.
#![warn(clippy::string_slice)]

/// Source-agnostic activity contract for the Activity Inspector.
pub mod activity;
pub mod agent;
pub mod ai_probe;
pub mod audit;
pub mod branding;
pub mod build_identity;
pub mod capability_qualification;
pub mod chat;
/// Hermetic cheap/fast-model contribution benchmark for host-grounded triage.
/// Scripted candidates only — never live providers or readiness claims.
pub mod cheap_model_fast_triage_benchmark;
pub mod config;
pub mod confluence_ro;
pub mod connectors;
/// Shared synthesis headroom, evidence packing, and budget telemetry.
pub mod context_budgeting;
/// Deterministic multi-source context plan for ordinary chat turns.
pub mod context_plan;
/// Friendly whole-turn deadline parse/format and policy conversion.
pub mod deadline_controls;
pub mod discovery;
pub mod embed;
pub mod embedding_space;
pub mod error;
pub mod events;
/// Versioned extension contracts for future multi-model triage/retrieval
/// (docs + pure validators; does not redesign production turn paths).
pub mod extension_contract;
/// Host-grounded fast-triage route: complete evidence packet, typed-only
/// parsing, local validation, one bounded correction, one visible escalation.
pub mod fast_triage;
/// Provider-neutral cost/reliability ledger for share-safe gateway diagnostics.
pub mod gateway_cost_ledger;
pub mod git_source;
pub mod grok_auth;
pub mod harvest;
pub mod help;
pub mod home_source;
pub mod http_preset;
pub mod incident_evidence;
/// Deterministic ZIP pack/validate for Incident Evidence Bundle v1 (#765).
pub mod incident_evidence_archive;
pub mod index;
pub mod index_watch;
pub mod injection;
/// Strict host-validated typed investigation answers.
pub mod investigation_answer;
pub mod investigations;
/// Keychain / in-memory credential store (module name avoids gitignore `*secret*`).
pub mod keychain_store;
/// Provider-neutral linked multi-stage response contracts (reasoning wrappers,
/// fences, empty terminals, diagnostic categories).
pub mod linked_triage_contract;
pub mod log_analysis;
pub mod mcp_client;
pub mod memory;
pub mod memory_fs;
pub mod model_context;
pub mod model_curation;
/// Exact gateway-scoped model identity shared by policy and SDK contracts.
pub mod model_ref;
pub mod model_role_hints;
pub mod module_registry;
pub mod modules;
pub mod multi_model;
/// Multi-stage candidate admission budget (synthesis reserve, issue #869).
pub mod multi_stage_budget;
pub mod normalized_log_events;
pub mod object_store;
/// Typed OpenAI-compatible chat request modes and pure body builder.
pub mod openai_chat_contract;
pub mod paths;
pub mod permissions;
pub mod preflight;
pub mod probe;
pub mod process_progress;
pub mod provider_telemetry;
pub mod providers;
/// Hermetic model/retrieval quality-evaluation harness (issue #867).
pub mod quality_eval;
/// Provider-neutral reasoning-effort contract (opt-in; omit = provider default).
pub mod reasoning_effort;
pub mod redact;
pub mod rerank;
pub mod research;
pub mod router;
#[cfg(feature = "s3-object-store")]
pub mod s3_object_store;
/// Back-compat alias path used in docs.
pub use keychain_store as secrets;
pub mod news_sources;
pub mod session_context;
pub mod sessions;
pub mod skills;
pub mod sql_ro;
pub mod sse;
pub mod ssrf;
pub mod text;
pub mod tool_host;
pub mod tools;
/// Revisioned, non-secret storage for opt-in Triage Policy V2 documents.
pub mod triage_policy_store;
/// Hermetic broad-triage quality contract and structured rubric.
pub mod triage_quality;
/// Host-owned, exact-role qualification evidence for Triage Policy V2.
pub mod triage_role_qualification;
/// Versioned, host-neutral SDK request, event, result, cancellation, and replay contracts.
pub mod triage_sdk;
pub mod turn_trace;
pub mod vector_index;
pub mod web_research;
pub mod workspace;
pub mod workspace_backup;
pub mod x_search;

pub use branding::{Branding, DEFAULT_PRODUCT_NAME, DEFAULT_SLUG};
pub use build_identity::{BuildChannel, BuildIdentity};
pub use error::{CoreError, CoreResult};
pub use events::{StreamEvent, ToolPhase};
pub use investigations::{
    AddFindingInput, AddNoteInput, EditFindingInput, EditNoteInput, FindingItem, FindingKind,
    FindingLifecycle, HumanProvenance, InvestigationDocument, InvestigationStore,
    InvestigationSummary, NoteItem, ProposeFindingInput, ProposedFindingItem,
    ProposedFindingStatus, ResolvedInvestigationDocument, PROPOSE_FINDING_TOOL,
};
pub use permissions::{PermissionDecision, PermissionRequest, PermissionState};
pub use providers::{
    descriptor_for, ProviderConfig, ProviderDeadlinePreference, ProviderDescriptor, ProviderKind,
    ProviderProfile,
};
pub use router::AgentPhase;
pub use tools::{ToolSideEffect, ToolSpec};

/// Library version (cargo package version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Protocol version string.
pub const PROTOCOL_VERSION: &str = "cd.v1";
