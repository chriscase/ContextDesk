//! Provider-neutral cost/reliability ledger for gateway diagnostics.
//!
//! This lane aggregates **already share-safe** diagnostic reports, manifests,
//! and documented historical benchmark rows so operators can compare models
//! over time. It never makes live gateway calls, never invents observations,
//! and never emits readiness/`verified` badges from aggregates.
//!
//! Missing cost or token fields stay explicitly unknown — never coerced
//! to zero. [`VerdictStatus::Inconclusive`] stays distinct from pass and fail.
//!
//! Independent of the Luna tool-continuation hardening lane: owner-local Luna
//! reports may be imported later via the documented offline path without
//! committing raw captures (see `docs/benchmarks/GATEWAY_COST_RELIABILITY_LEDGER_V1.md`).

mod aggregate;
mod compare;
mod ingest;
mod redact;
mod schema;

pub use aggregate::{aggregate_runs, BooleanCounts, LedgerAggregateSummary};
pub use compare::{
    build_comparison_report, emit_comparison_json, render_comparison_text, ComparisonReport,
    ModelComparisonRow,
};
pub use ingest::{
    ingest_diagnostic_bundle, ingest_historical_row, ingest_json_value, ingest_path, IngestError,
    IngestSource,
};
pub use redact::{assert_share_safe_ledger_json, redact_ledger_run, LedgerRedactionError};
pub use schema::{
    CleanupStatus, ComparisonCaveat, FailureCategory, IdentityLabel, LedgerRunRecord,
    LedgerSourceKind, MetricF64, MetricU64, ObservationBool, TokenUsage, VerdictDimension,
    VerdictStatus, AGGREGATE_SCHEMA_ID, AGGREGATE_SCHEMA_VERSION, COMPARISON_SCHEMA_ID,
    COMPARISON_SCHEMA_VERSION, LEDGER_SCHEMA_ID, LEDGER_SCHEMA_VERSION, MAX_LEDGER_RUNS,
};

#[cfg(test)]
mod tests;
