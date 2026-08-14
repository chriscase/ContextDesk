//! Hermetic cheap/fast-model contribution benchmark for host-grounded triage.
//!
#![allow(missing_docs)] // Fixture field names are the hermetic contract surface.
//!
//! This module measures whether a cheap model can contribute **bounded,
//! host-validated work** on fixed synthetic linked-log cases. It does **not**
//! contact providers, resolve credentials, or claim any live model is verified.
//!
//! # Authority
//!
//! * Evidence ids, roles, chronology, citations, and final acceptance remain
//!   host-owned via [`crate::fast_triage::FastTriagePacketV1`] and
//!   [`crate::fast_triage::validate_fast_answer`].
//! * Persuasive prose never earns credit without host validation.
//! * Latency/token fields on matrix rows are **labels only** — not readiness.
//!
//! # Paths
//!
//! * **Path A** — one scripted full answer through the real fast-triage
//!   validator.
//! * **Path B** — bounded role decomposition (extraction, causal proposal,
//!   contradiction/abstention check, optional reviewer) assembled by the host
//!   into one proposal, then the same validator.

pub mod assemble;
pub mod candidates;
pub mod cases;
pub mod matrix;
pub mod score;

pub use assemble::{assemble_role_decomposition, RoleDecompositionInputs};
pub use candidates::{
    path_a_candidate, path_b_roles, CandidateKind, CausalProposalRole, ContradictionRole,
    ExtractionRole, PathACandidate, PathBRoles, ReviewerRole, ScriptedCandidateSet,
};
pub use cases::{benchmark_case, list_case_ids, BenchmarkCase, CaseId};
pub use matrix::{
    golden_matrix, run_benchmark_matrix, BenchmarkMatrixRow, BenchmarkRunResult, GoldenExpectation,
    PathLabel, BENCHMARK_MATRIX_SCHEMA_V1,
};
pub use score::{
    score_path_a, score_path_b, ContributionCredit, ContributionVerdict, PathScore, RoleCredit,
};

/// Stable schema id for this hermetic benchmark surface.
pub const CHEAP_MODEL_FAST_TRIAGE_BENCHMARK_SCHEMA_V1: &str =
    "contextdesk.cheap_model_fast_triage_benchmark.v1";
