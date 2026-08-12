//! Versioned ledger schemas for one diagnostic run and aggregate summaries.

use serde::{Deserialize, Serialize};

/// Wire schema id for a single ingested diagnostic run.
pub const LEDGER_SCHEMA_ID: &str = "contextdesk.gateway_cost_ledger.v1";
/// Schema version for [`LedgerRunRecord`].
pub const LEDGER_SCHEMA_VERSION: u32 = 1;

/// Wire schema id for aggregate summaries over many runs.
pub const AGGREGATE_SCHEMA_ID: &str = "contextdesk.gateway_cost_ledger_aggregate.v1";
/// Schema version for aggregate summaries.
pub const AGGREGATE_SCHEMA_VERSION: u32 = 1;

/// Wire schema id for deterministic comparison reports.
pub const COMPARISON_SCHEMA_ID: &str = "contextdesk.gateway_cost_ledger_comparison.v1";
/// Schema version for comparison reports.
pub const COMPARISON_SCHEMA_VERSION: u32 = 1;

/// Hard limits for untrusted ledger inputs. These are deliberately far above
/// normal diagnostic values while still preventing corrupt evidence from
/// becoming plausible-looking aggregates.
pub const MAX_LEDGER_INPUT_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum number of run records accepted by one CLI aggregation.
pub const MAX_LEDGER_RUNS: usize = 10_000;
/// Maximum array/object entries accepted in untrusted JSON.
pub const MAX_LEDGER_COLLECTION_ITEMS: usize = 2_048;
/// Maximum UTF-8 bytes accepted in any input string.
pub const MAX_LEDGER_STRING_BYTES: usize = 16 * 1024;
/// Maximum request count accepted for one run.
pub const MAX_REQUEST_COUNT: u64 = 10_000_000;
/// Maximum token count accepted for one metric.
pub const MAX_TOKEN_COUNT: u64 = 1_000_000_000_000;
/// Maximum one-run elapsed time accepted by the ledger.
pub const MAX_ELAPSED_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
/// Maximum configured deadline accepted by the ledger.
pub const MAX_DEADLINE_SECS: u64 = 7 * 24 * 60 * 60;
/// Maximum reported USD cost accepted for one run or aggregate.
pub const MAX_REPORTED_COST: f64 = 1_000_000.0;
/// Upper bound for Unix milliseconds (9999-12-31T23:59:59.999Z).
pub const MAX_UNIX_TIMESTAMP_MS: u64 = 253_402_300_799_999;

/// A numeric counter that may be known or explicitly unknown.
///
/// Missing provider usage must deserialize as [`MetricU64::Unknown`], never as
/// zero. A genuine reported `0` is [`MetricU64::Known`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum MetricU64 {
    /// No authoritative value was present in the share-safe source.
    #[default]
    Unknown,
    /// Exact reported value (including a genuine zero).
    Known(u64),
}

impl MetricU64 {
    /// Construct from an optional report field.
    pub fn from_option(value: Option<u64>) -> Self {
        match value {
            Some(v) => Self::Known(v),
            None => Self::Unknown,
        }
    }

    /// Known value when present.
    pub fn known(self) -> Option<u64> {
        match self {
            Self::Known(v) => Some(v),
            Self::Unknown => None,
        }
    }

    /// Sum only when every input is known; otherwise unknown.
    pub fn sum_all(values: impl IntoIterator<Item = Self>) -> Self {
        let mut any = false;
        let mut sum = 0u64;
        for value in values {
            any = true;
            match value {
                Self::Known(v) => match sum.checked_add(v) {
                    Some(next) => sum = next,
                    None => return Self::Unknown,
                },
                Self::Unknown => return Self::Unknown,
            }
        }
        if any {
            Self::Known(sum)
        } else {
            Self::Unknown
        }
    }
}

/// A floating cost that may be known or explicitly unknown.
///
/// Same honesty rule as [`MetricU64`]: absent ≠ zero.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum MetricF64 {
    /// No authoritative cost was present.
    #[default]
    Unknown,
    /// Exact reported cost (including a genuine `0.0`).
    Known(f64),
}

/// A boolean observation that preserves missing evidence separately from a
/// genuine observed `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum ObservationBool {
    /// The source did not report the value.
    #[default]
    Unknown,
    /// The source explicitly reported true or false.
    Known(bool),
}

impl ObservationBool {
    /// Construct from an optional source value without zero/false filling.
    pub fn from_option(value: Option<bool>) -> Self {
        value.map_or(Self::Unknown, Self::Known)
    }
}

/// Typed provenance cohort. Historical documentation is never silently
/// combined with observed diagnostic traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerSourceKind {
    /// Observed output from the share-safe gateway diagnostic.
    DiagnosticBundle,
    /// A documented historical benchmark row; never treated as live traffic.
    HistoricalBenchmarkRow,
    /// An already-shaped ledger record imported from another ledger artifact.
    LedgerRun,
}

impl LedgerSourceKind {
    /// Stable wire/display label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DiagnosticBundle => "diagnostic_bundle",
            Self::HistoricalBenchmarkRow => "historical_benchmark_row",
            Self::LedgerRun => "ledger_run",
        }
    }
}

impl MetricF64 {
    /// Known value when present and finite.
    pub fn known(self) -> Option<f64> {
        match self {
            Self::Known(v) if v.is_finite() && v >= 0.0 => Some(v),
            _ => None,
        }
    }

    /// Sum only when every input is known and finite; otherwise unknown.
    pub fn sum_all(values: impl IntoIterator<Item = Self>) -> Self {
        let mut any = false;
        let mut sum = 0.0_f64;
        for value in values {
            any = true;
            match value {
                Self::Known(v) if v.is_finite() && (0.0..=MAX_REPORTED_COST).contains(&v) => {
                    sum += v
                }
                _ => return Self::Unknown,
            }
        }
        if any && sum.is_finite() {
            Self::Known(sum)
        } else {
            Self::Unknown
        }
    }
}

/// How a model or gateway identity is recorded.
///
/// Diagnostic observations retain only supplied share-safe pseudonyms.
/// Exact labels are limited to an explicit public allowlist for typed,
/// documented historical rows. Otherwise identity is explicit unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IdentityLabel {
    /// Public exact label from a typed documented historical row.
    Exact {
        /// Share-safe exact label (e.g. a public catalog id from fixtures).
        value: String,
    },
    /// Stable pseudonym from a share-safe diagnostic report.
    Pseudonym {
        /// Pseudonym string (never the private profile/model literal).
        value: String,
    },
    /// No usable identity was present after redaction.
    Unknown,
}

impl IdentityLabel {
    /// Stable grouping key for comparison rows.
    pub fn grouping_key(&self) -> String {
        match self {
            Self::Exact { value } => format!("exact:{value}"),
            Self::Pseudonym { value } => format!("pseudonym:{value}"),
            Self::Unknown => "unknown".to_string(),
        }
    }

    /// Display label for CLI/GUI projections.
    pub fn display(&self) -> &str {
        match self {
            Self::Exact { value } | Self::Pseudonym { value } => value.as_str(),
            Self::Unknown => "unknown",
        }
    }
}

/// Typed diagnostic dimension verdict. Inconclusive is never collapsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictStatus {
    /// Dimension measured and passed.
    Pass,
    /// Dimension measured and failed.
    Fail,
    /// Dimension unmeasured or insufficient evidence.
    Inconclusive,
}

impl VerdictStatus {
    /// Parse from gateway-diagnose status strings.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pass" => Self::Pass,
            "fail" => Self::Fail,
            _ => Self::Inconclusive,
        }
    }
}

/// One diagnostic verdict dimension tracked by the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictDimension {
    /// Direct gateway/model contract.
    GatewayModel,
    /// Product workflow path.
    ProductWorkflow,
    /// Scorer-applicable answer usefulness.
    AnswersUseful,
}

impl VerdictDimension {
    /// Stable wire / report label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GatewayModel => "gateway_model",
            Self::ProductWorkflow => "product_workflow",
            Self::AnswersUseful => "answers_useful",
        }
    }
}

/// Token usage for one run. Each field is independently unknownable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct TokenUsage {
    /// Input / prompt tokens.
    pub input: MetricU64,
    /// Output / completion tokens.
    pub output: MetricU64,
    /// Reasoning tokens when reported.
    pub reasoning: MetricU64,
    /// Cached prompt tokens when reported.
    pub cached: MetricU64,
    /// Total tokens when reported.
    pub total: MetricU64,
}

/// Cleanup outcome for disposable corpora/sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupStatus {
    /// All created disposable state was removed without failure.
    Ok,
    /// At least one cleanup failure was recorded (details redacted).
    Failed,
    /// Source did not report cleanup.
    Unknown,
}

/// A coarse, share-safe failure category (never a raw provider body).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct FailureCategory {
    /// Stable category code (e.g. `timeout`, `usefulness_gap`).
    pub code: String,
}

/// Explicit confidence caveat attached to a comparison/aggregate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ComparisonCaveat {
    /// Stable caveat code.
    pub code: String,
    /// Human-readable caveat (share-safe).
    pub detail: String,
}

/// One versioned ledger record for a single diagnostic run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LedgerRunRecord {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Stable run id from the source report or historical row.
    pub run_id: String,
    /// Provenance kind for this record.
    pub source_kind: LedgerSourceKind,
    /// Relative or logical source reference (never a private absolute path).
    pub source_ref: String,
    /// Optional build / release identity already present in the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_identity: Option<String>,
    /// Optional start timestamp (unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<u64>,
    /// Optional finish timestamp (unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_unix_ms: Option<u64>,
    /// Model identity under the source cohort's disclosure policy.
    pub model: IdentityLabel,
    /// Gateway identity under the source cohort's disclosure policy.
    pub gateway: IdentityLabel,
    /// Role hint when present (`chat`, `embedding`, `reranker`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_hint: Option<String>,
    /// Diagnostic level when present (`basic`, `extended`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// Requests made during the run.
    pub request_count: MetricU64,
    /// Token usage; absent fields stay unknown.
    pub tokens: TokenUsage,
    /// Reported monetary cost when present; otherwise unknown.
    pub reported_cost: MetricF64,
    /// Whole-run elapsed milliseconds when measurable.
    pub elapsed_ms: MetricU64,
    /// Configured deadline in seconds when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_secs: Option<u64>,
    /// Whether the whole-run deadline was exceeded.
    pub deadline_exceeded: ObservationBool,
    /// Whether the run was cancelled.
    pub cancelled: ObservationBool,
    /// Cleanup status for disposable state.
    pub cleanup: CleanupStatus,
    /// Coarse failure categories (share-safe).
    pub failure_categories: Vec<FailureCategory>,
    /// Gateway/model dimension verdict.
    pub gateway_model: VerdictStatus,
    /// Product workflow dimension verdict.
    pub product_workflow: VerdictStatus,
    /// Answers-useful dimension verdict.
    pub answers_useful: VerdictStatus,
    /// Case classification labels when present (share-safe).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub case_classifications: Vec<String>,
    /// Provenance / confidence notes carried on the run itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caveats: Vec<ComparisonCaveat>,
}

impl LedgerRunRecord {
    /// Construct an empty shell with required schema fields filled.
    pub fn blank(run_id: impl Into<String>, source_kind: LedgerSourceKind) -> Self {
        Self {
            schema_id: LEDGER_SCHEMA_ID.to_string(),
            schema_version: LEDGER_SCHEMA_VERSION,
            run_id: run_id.into(),
            source_kind,
            source_ref: String::new(),
            build_identity: None,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            model: IdentityLabel::Unknown,
            gateway: IdentityLabel::Unknown,
            role_hint: None,
            level: None,
            request_count: MetricU64::Unknown,
            tokens: TokenUsage::default(),
            reported_cost: MetricF64::Unknown,
            elapsed_ms: MetricU64::Unknown,
            deadline_secs: None,
            deadline_exceeded: ObservationBool::Unknown,
            cancelled: ObservationBool::Unknown,
            cleanup: CleanupStatus::Unknown,
            failure_categories: Vec::new(),
            gateway_model: VerdictStatus::Inconclusive,
            product_workflow: VerdictStatus::Inconclusive,
            answers_useful: VerdictStatus::Inconclusive,
            case_classifications: Vec::new(),
            caveats: Vec::new(),
        }
    }

    /// Verdict for a named dimension.
    pub fn verdict(&self, dimension: VerdictDimension) -> VerdictStatus {
        match dimension {
            VerdictDimension::GatewayModel => self.gateway_model,
            VerdictDimension::ProductWorkflow => self.product_workflow,
            VerdictDimension::AnswersUseful => self.answers_useful,
        }
    }
}
