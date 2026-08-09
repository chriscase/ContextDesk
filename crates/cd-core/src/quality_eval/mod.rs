//! Hermetic model-and-retrieval quality-evaluation harness.
//!
//! This module records **quality** evidence only. It never mutates
//! [`crate::capability_qualification`] readiness stores, never resolves
//! credentials, and never contacts providers.
//!
//! # Evidence classes
//!
//! - **Compatibility** — out of scope; must remain untouched.
//! - **Retrieval quality** — deterministic IR metrics on frozen rankings.
//! - **Answer quality** — deterministic scoring of scripted (or later live) answers.
//! - **Orchestration quality** — reserved; fingerprint only in this milestone.
//! - **Live optional** — schema-ready, defaults to `not_scheduled`.
//!
//! # Authority order
//!
//! Host truth → deterministic scores → optional judge (advisory only).

pub mod answer_score;
pub mod export;
pub mod metrics;
pub mod run;
pub mod suite;
pub mod types;

pub use answer_score::{apply_judge_cannot_override, score_answer};
pub use export::{
    gate_export_text, normalize_for_stability, serialize_json, serialize_jsonl, write_export,
    ExportFormat,
};
pub use metrics::{round6, score_retrieval, validate_ranking};
pub use run::{
    hermetic_quality_unit, quality_units_are_gateway_scoped, run_hermetic_suite, HermeticRunOptions,
};
pub use suite::{
    assert_suite_digest, hex_sha256, known_document_ids, load_suite, resolve_suite_path,
    scan_privacy_text, scan_runtime_isolation, LoadedCase, LoadedSuite,
    PRIVACY_FORBIDDEN_SUBSTRINGS, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
pub use types::*;
