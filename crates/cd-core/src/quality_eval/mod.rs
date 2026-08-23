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
pub mod diagnostic_score;
pub mod export;
pub mod live_known_answer;
pub mod live_known_answer_capture;
pub mod live_known_answer_run;
pub mod matrix;
pub mod metrics;
pub mod run;
pub mod suite;
pub mod types;

pub use answer_score::{apply_judge_cannot_override, score_answer};
pub use diagnostic_score::score_diagnostic_dimensions;
pub use export::{
    gate_export_text, normalize_for_stability, serialize_json, serialize_jsonl, write_export,
    ExportFormat,
};
pub use live_known_answer::{
    live_known_answer_prompt_set_hash, parse_live_known_answer_response,
    parse_live_known_answer_response_classified, prepare_live_known_answer_suite,
    score_live_known_answer_response, serialize_live_known_answer_prompt,
    validate_live_known_answer_canonical_response, LiveAnswerClaim, LiveCitation,
    LiveEvidenceDocument, LiveKnownAnswerPrompt, LiveKnownAnswerResponse,
    LiveKnownAnswerResponseFailure, LiveKnownAnswerScore, LiveResponseContract,
    PreparedLiveKnownAnswerCase, LIVE_KNOWN_ANSWER_PACKET_ID, LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID,
    LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES, LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID,
};
#[cfg(unix)]
pub use live_known_answer::{LiveKnownAnswerOpenedFile, LiveKnownAnswerOwnerDirectory};
pub use live_known_answer_capture::{
    build_live_known_answer_capture, live_known_answer_answer_score_sha256,
    live_known_answer_capture_sha256, parse_live_known_answer_capture_json,
    render_live_known_answer_capture_json, validate_live_known_answer_capture,
    LiveKnownAnswerCanonicalCapture, LiveKnownAnswerCanonicalScenario,
    LiveKnownAnswerCanonicalScenarioInput, LIVE_KNOWN_ANSWER_CAPTURE_MAX_BYTES,
    LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID,
};
pub use live_known_answer_run::{
    build_live_known_answer_run, live_known_answer_quality_unit, parse_live_known_answer_json,
    render_live_known_answer_json, render_live_known_answer_markdown,
    validate_live_known_answer_quality_unit, validate_live_known_answer_run,
    LiveKnownAnswerRunMetrics, LiveKnownAnswerRunReport, LiveKnownAnswerRunStatus,
    LiveKnownAnswerScenarioObservation, LiveKnownAnswerScenarioTelemetry,
    LIVE_KNOWN_ANSWER_JS_SAFE_MAX, LIVE_KNOWN_ANSWER_ORCHESTRATION_POLICY,
    LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS, LIVE_KNOWN_ANSWER_RUN_MAX_BYTES,
    LIVE_KNOWN_ANSWER_RUN_SCHEMA_ID,
};
pub use matrix::{matrix_summary_lines, matrix_summary_rows};
pub use metrics::{round6, score_retrieval, validate_ranking};
pub use run::{
    hermetic_quality_unit, judge_is_not_scheduled_pass, quality_units_are_gateway_scoped,
    run_hermetic_suite, HermeticRunOptions,
};
pub use suite::{
    assert_suite_digest, default_suite_path_from_manifest_dir, expectation_accounting, hex_sha256,
    known_document_ids, list_bundled_suites, load_embedded_open_v1_suite, load_suite,
    resolve_suite_path, scan_privacy_text, scan_runtime_isolation, ExpectationAccounting,
    LoadedCase, LoadedSuite, SuiteCatalogEntry, BUNDLED_OPEN_V1_RELATIVE,
    PRIVACY_FORBIDDEN_SUBSTRINGS, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
pub use types::*;
