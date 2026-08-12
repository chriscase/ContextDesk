//! Ingest share-safe gateway diagnostic bundles and historical benchmark rows.

use std::fs;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use super::redact::{redact_ledger_run, reject_forbidden_fields, LedgerRedactionError};
use super::schema::{
    CleanupStatus, ComparisonCaveat, FailureCategory, IdentityLabel, LedgerRunRecord, MetricF64,
    MetricU64, TokenUsage, VerdictStatus, LEDGER_SCHEMA_ID, LEDGER_SCHEMA_VERSION,
};

/// Provenance labels for ingested records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestSource {
    /// `report.json` (+ optional `manifest.json`) from gateway diagnose.
    DiagnosticBundle,
    /// Documented historical benchmark row (committed share-safe JSON).
    HistoricalBenchmarkRow,
    /// Already-shaped ledger run JSON.
    LedgerRun,
}

impl IngestSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::DiagnosticBundle => "diagnostic_bundle",
            Self::HistoricalBenchmarkRow => "historical_benchmark_row",
            Self::LedgerRun => "ledger_run",
        }
    }
}

/// Ingest failures.
#[derive(Debug, Error)]
pub enum IngestError {
    /// Filesystem or IO failure.
    #[error("ledger ingest io error: {0}")]
    Io(#[from] std::io::Error),
    /// JSON parse failure.
    #[error("ledger ingest json error: {0}")]
    Json(#[from] serde_json::Error),
    /// Share-safe rejection / redaction failure.
    #[error(transparent)]
    Redaction(#[from] LedgerRedactionError),
    /// Unsupported or malformed document shape.
    #[error("ledger ingest rejected: {0}")]
    Rejected(String),
}

/// Labels that already appear in committed share-safe fixtures/docs and may
/// therefore be retained as exact identities. Anything else becomes a
/// pseudonym or unknown.
const SHARE_SAFE_EXACT_MODEL_LABELS: &[&str] = &[
    "deepseek/deepseek-v4-flash",
    "openai/gpt-oss-120b",
    "voyage/voyage-4",
    "voyage/rerank-2.5",
];

const SHARE_SAFE_EXACT_GATEWAY_LABELS: &[&str] = &[
    "Vercel AI Gateway",
    "vercel_ai_gateway",
    "mixed-role-catalog",
];

/// Ingest a path that is either a diagnostic bundle directory, a report JSON
/// file, a historical row JSON file, or a ledger run JSON file.
pub fn ingest_path(path: &Path) -> Result<Vec<LedgerRunRecord>, IngestError> {
    if path.is_dir() {
        return ingest_diagnostic_bundle(path);
    }
    let text = fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&text)?;
    let source_ref = logical_source_ref(path);
    Ok(vec![ingest_json_value(&value, &source_ref)?])
}

/// Ingest a gateway diagnose share-safe bundle (`report.json` + optional
/// `manifest.json`).
pub fn ingest_diagnostic_bundle(dir: &Path) -> Result<Vec<LedgerRunRecord>, IngestError> {
    let report_path = dir.join("report.json");
    if !report_path.is_file() {
        return Err(IngestError::Rejected(format!(
            "diagnostic bundle missing report.json under {}",
            logical_source_ref(dir)
        )));
    }
    let report_text = fs::read_to_string(&report_path)?;
    let report: Value = serde_json::from_str(&report_text)?;
    reject_forbidden_fields(&report)?;

    let manifest_path = dir.join("manifest.json");
    if manifest_path.is_file() {
        let manifest_text = fs::read_to_string(&manifest_path)?;
        let manifest: Value = serde_json::from_str(&manifest_text)?;
        reject_forbidden_fields(&manifest)?;
        validate_manifest_against_report(&manifest, &report_text, &report)?;
    }

    let mut run = map_gateway_diagnostic_report(
        &report,
        logical_source_ref(dir),
        IngestSource::DiagnosticBundle,
    )?;
    redact_ledger_run(&mut run);
    Ok(vec![run])
}

/// Ingest one documented historical benchmark row object.
pub fn ingest_historical_row(
    value: &Value,
    source_ref: &str,
) -> Result<LedgerRunRecord, IngestError> {
    reject_forbidden_fields(value)?;
    let mut run = map_historical_row(value, source_ref)?;
    redact_ledger_run(&mut run);
    Ok(run)
}

/// Ingest a JSON value, auto-detecting diagnostic report / historical row /
/// ledger run shapes.
pub fn ingest_json_value(value: &Value, source_ref: &str) -> Result<LedgerRunRecord, IngestError> {
    reject_forbidden_fields(value)?;
    let schema = value
        .get("schema_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut run = if schema == LEDGER_SCHEMA_ID {
        let mut parsed: LedgerRunRecord = serde_json::from_value(value.clone())?;
        if parsed.source_ref.is_empty() {
            parsed.source_ref = source_ref.to_string();
        }
        parsed
    } else if schema == "contextdesk.gateway_cost_ledger_historical_row.v1"
        || value.get("historical_row").and_then(|v| v.as_bool()) == Some(true)
        || value.get("documented_source").is_some()
    {
        map_historical_row(value, source_ref)?
    } else if schema == "contextdesk.gateway_diagnostic.v1"
        || (value.get("cases").is_some() && value.get("verdicts").is_some())
    {
        map_gateway_diagnostic_report(
            value,
            source_ref.to_string(),
            IngestSource::DiagnosticBundle,
        )?
    } else {
        return Err(IngestError::Rejected(format!(
            "unrecognized ledger ingest shape at {source_ref} (schema_id={schema:?})"
        )));
    };
    redact_ledger_run(&mut run);
    Ok(run)
}

fn validate_manifest_against_report(
    manifest: &Value,
    report_bytes: &str,
    report: &Value,
) -> Result<(), IngestError> {
    let manifest_run = manifest
        .get("run_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let report_run = report.get("run_id").and_then(|v| v.as_str()).unwrap_or("");
    if !manifest_run.is_empty() && !report_run.is_empty() && manifest_run != report_run {
        return Err(IngestError::Rejected(format!(
            "manifest run_id {manifest_run:?} does not match report run_id {report_run:?}"
        )));
    }
    if let Some(files) = manifest.get("files").and_then(|v| v.as_array()) {
        for file in files {
            let name = file.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name == "report.json" {
                if let Some(expected) = file.get("sha256").and_then(|v| v.as_str()) {
                    let actual = sha256_hex(report_bytes.as_bytes());
                    if !expected.is_empty() && expected != actual {
                        return Err(IngestError::Rejected(format!(
                            "manifest sha256 mismatch for report.json (expected {expected}, got {actual})"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct LooseVerdicts {
    #[serde(default)]
    gateway_model_status: Option<String>,
    #[serde(default)]
    product_workflow_status: Option<String>,
    #[serde(default)]
    answers_useful_status: Option<String>,
    #[serde(default)]
    gateway_model_compatible: Option<bool>,
    #[serde(default)]
    product_workflow_compatible: Option<bool>,
    #[serde(default)]
    answers_useful: Option<bool>,
}

fn map_gateway_diagnostic_report(
    report: &Value,
    source_ref: String,
    source: IngestSource,
) -> Result<LedgerRunRecord, IngestError> {
    let run_id = report
        .get("run_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown-run")
        .to_string();
    let mut run = LedgerRunRecord::blank(run_id, source.as_str());
    run.schema_id = LEDGER_SCHEMA_ID.to_string();
    run.schema_version = LEDGER_SCHEMA_VERSION;
    run.source_ref = source_ref;

    run.build_identity = report
        .get("build")
        .and_then(|b| b.get("long_version").or_else(|| b.get("version")))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    run.started_at_unix_ms = report.get("started_at_unix_ms").and_then(|v| v.as_u64());
    run.finished_at_unix_ms = report.get("finished_at_unix_ms").and_then(|v| v.as_u64());

    run.model = identity_from_report_fields(
        report.get("model_label").and_then(|v| v.as_str()),
        report.get("model_pseudonym").and_then(|v| v.as_str()),
        true,
    );
    run.gateway = identity_from_report_fields(
        report.get("gateway_label").and_then(|v| v.as_str()),
        report.get("profile_pseudonym").and_then(|v| v.as_str()),
        false,
    );

    run.role_hint = report
        .get("role_hint")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    run.level = report
        .get("level")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    run.request_count =
        MetricU64::from_option(report.get("requests_made").and_then(|v| v.as_u64()));
    run.tokens = tokens_from_value(report.get("usage").or_else(|| report.get("tokens")));
    run.reported_cost = cost_from_value(report);

    run.elapsed_ms = elapsed_from_report(report);
    run.deadline_secs = report.get("deadline_secs").and_then(|v| v.as_u64());
    run.deadline_exceeded = report
        .get("deadline_exceeded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    run.cancelled = report
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    run.cleanup = cleanup_from_value(report.get("cleanup"));

    let verdicts: LooseVerdicts = serde_json::from_value(
        report
            .get("verdicts")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default())),
    )?;
    run.gateway_model = status_from_loose(
        verdicts.gateway_model_status.as_deref(),
        verdicts.gateway_model_compatible,
    );
    run.product_workflow = status_from_loose(
        verdicts.product_workflow_status.as_deref(),
        verdicts.product_workflow_compatible,
    );
    run.answers_useful = status_from_loose(
        verdicts.answers_useful_status.as_deref(),
        verdicts.answers_useful,
    );

    if let Some(cases) = report.get("cases").and_then(|v| v.as_array()) {
        for case in cases {
            if let Some(classification) = case.get("classification").and_then(|v| v.as_str()) {
                run.case_classifications.push(classification.to_string());
            }
            push_case_failure_categories(&mut run, case);
        }
    }

    if run.deadline_exceeded {
        run.failure_categories.push(FailureCategory {
            code: "deadline_exceeded".into(),
        });
    }
    if run.cancelled {
        run.failure_categories.push(FailureCategory {
            code: "cancelled".into(),
        });
    }
    if matches!(run.cleanup, CleanupStatus::Failed) {
        run.failure_categories.push(FailureCategory {
            code: "cleanup_failed".into(),
        });
    }

    // Share-safe gateway diagnose reports omit cost/tokens today — record that
    // honesty caveat rather than inventing zeros.
    if matches!(run.reported_cost, MetricF64::Unknown)
        && matches!(run.tokens.input, MetricU64::Unknown)
        && matches!(run.tokens.output, MetricU64::Unknown)
        && matches!(run.tokens.total, MetricU64::Unknown)
    {
        run.caveats.push(ComparisonCaveat {
            code: "usage_not_reported".into(),
            detail:
                "source diagnostic report did not include cost or token usage; treated as unknown"
                    .into(),
        });
    }

    Ok(run)
}

fn map_historical_row(value: &Value, source_ref: &str) -> Result<LedgerRunRecord, IngestError> {
    let run_id = value
        .get("run_id")
        .and_then(|v| v.as_str())
        .unwrap_or("historical-unknown")
        .to_string();
    let mut run = LedgerRunRecord::blank(run_id, IngestSource::HistoricalBenchmarkRow.as_str());
    run.source_ref = value
        .get("documented_source")
        .and_then(|v| v.as_str())
        .unwrap_or(source_ref)
        .to_string();
    run.build_identity = value
        .get("source_build")
        .or_else(|| value.get("build_identity"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    run.model = identity_from_report_fields(
        value.get("model_label").and_then(|v| v.as_str()),
        value.get("model_pseudonym").and_then(|v| v.as_str()),
        true,
    );
    run.gateway = identity_from_report_fields(
        value.get("gateway_label").and_then(|v| v.as_str()),
        value.get("gateway_pseudonym").and_then(|v| v.as_str()),
        false,
    );
    run.role_hint = value
        .get("role_hint")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    run.level = value
        .get("level")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    run.request_count = MetricU64::from_option(value.get("request_count").and_then(|v| v.as_u64()));
    run.tokens = tokens_from_value(value.get("tokens").or_else(|| value.get("usage")));
    run.reported_cost = cost_from_value(value);
    run.elapsed_ms = MetricU64::from_option(value.get("elapsed_ms").and_then(|v| v.as_u64()));
    run.deadline_secs = value.get("deadline_secs").and_then(|v| v.as_u64());
    run.deadline_exceeded = value
        .get("deadline_exceeded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    run.cancelled = value
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    run.cleanup = match value.get("cleanup_status").and_then(|v| v.as_str()) {
        Some("ok") => CleanupStatus::Ok,
        Some("failed") => CleanupStatus::Failed,
        _ => CleanupStatus::Unknown,
    };
    run.gateway_model = VerdictStatus::parse(
        value
            .get("gateway_model_status")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    run.product_workflow = VerdictStatus::parse(
        value
            .get("product_workflow_status")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    run.answers_useful = VerdictStatus::parse(
        value
            .get("answers_useful_status")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    if let Some(categories) = value.get("failure_categories").and_then(|v| v.as_array()) {
        for category in categories {
            if let Some(code) = category.as_str() {
                run.failure_categories.push(FailureCategory {
                    code: code.to_string(),
                });
            } else if let Some(code) = category.get("code").and_then(|v| v.as_str()) {
                run.failure_categories.push(FailureCategory {
                    code: code.to_string(),
                });
            }
        }
    }
    if let Some(classes) = value.get("case_classifications").and_then(|v| v.as_array()) {
        for class in classes {
            if let Some(label) = class.as_str() {
                run.case_classifications.push(label.to_string());
            }
        }
    }
    run.caveats.push(ComparisonCaveat {
        code: "historical_documented_row".into(),
        detail:
            "row transcribed from a committed share-safe benchmark document; not a live observation"
                .into(),
    });
    Ok(run)
}

fn identity_from_report_fields(
    exact: Option<&str>,
    pseudonym: Option<&str>,
    is_model: bool,
) -> IdentityLabel {
    if let Some(label) = exact.map(str::trim).filter(|s| !s.is_empty()) {
        let allow = if is_model {
            SHARE_SAFE_EXACT_MODEL_LABELS
        } else {
            SHARE_SAFE_EXACT_GATEWAY_LABELS
        };
        if allow.contains(&label) {
            return IdentityLabel::Exact {
                value: label.to_string(),
            };
        }
        // Exact private labels are not retained — fall through to unknown
        // rather than invent a pseudonym from a secret identity.
        return IdentityLabel::Unknown;
    }
    if let Some(label) = pseudonym.map(str::trim).filter(|s| !s.is_empty()) {
        return IdentityLabel::Pseudonym {
            value: label.to_string(),
        };
    }
    IdentityLabel::Unknown
}

fn tokens_from_value(value: Option<&Value>) -> TokenUsage {
    let Some(value) = value else {
        return TokenUsage::default();
    };
    TokenUsage {
        input: MetricU64::from_option(
            value
                .get("input")
                .or_else(|| value.get("input_tokens"))
                .or_else(|| value.get("prompt_tokens"))
                .and_then(|v| v.as_u64()),
        ),
        output: MetricU64::from_option(
            value
                .get("output")
                .or_else(|| value.get("output_tokens"))
                .or_else(|| value.get("completion_tokens"))
                .and_then(|v| v.as_u64()),
        ),
        reasoning: MetricU64::from_option(
            value
                .get("reasoning")
                .or_else(|| value.get("reasoning_tokens"))
                .and_then(|v| v.as_u64()),
        ),
        cached: MetricU64::from_option(
            value
                .get("cached")
                .or_else(|| value.get("cached_tokens"))
                .and_then(|v| v.as_u64()),
        ),
        total: MetricU64::from_option(
            value
                .get("total")
                .or_else(|| value.get("total_tokens"))
                .and_then(|v| v.as_u64()),
        ),
    }
}

fn cost_from_value(value: &Value) -> MetricF64 {
    MetricF64::from_option(
        value
            .get("reported_cost")
            .or_else(|| value.get("cost"))
            .or_else(|| value.get("usage").and_then(|u| u.get("cost")))
            .and_then(|v| v.as_f64()),
    )
}

fn elapsed_from_report(report: &Value) -> MetricU64 {
    if let Some(ms) = report.get("elapsed_ms").and_then(|v| v.as_u64()) {
        return MetricU64::Known(ms);
    }
    match (
        report.get("started_at_unix_ms").and_then(|v| v.as_u64()),
        report.get("finished_at_unix_ms").and_then(|v| v.as_u64()),
    ) {
        (Some(start), Some(end)) if end >= start => MetricU64::Known(end - start),
        _ => {
            // Fall back to summing product-lane elapsed when present.
            let mut sum = 0u64;
            let mut any = false;
            if let Some(cases) = report.get("cases").and_then(|v| v.as_array()) {
                for case in cases {
                    if let Some(ms) = case
                        .get("product")
                        .and_then(|p| p.get("elapsed_ms"))
                        .and_then(|v| v.as_u64())
                    {
                        any = true;
                        sum = sum.saturating_add(ms);
                    }
                }
            }
            if any {
                MetricU64::Known(sum)
            } else {
                MetricU64::Unknown
            }
        }
    }
}

fn cleanup_from_value(value: Option<&Value>) -> CleanupStatus {
    let Some(value) = value else {
        return CleanupStatus::Unknown;
    };
    if let Some(status) = value.get("status").and_then(|v| v.as_str()) {
        return match status {
            "ok" => CleanupStatus::Ok,
            "failed" => CleanupStatus::Failed,
            _ => CleanupStatus::Unknown,
        };
    }
    let failures = value
        .get("failures")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if failures > 0 {
        CleanupStatus::Failed
    } else if value.get("corpora_removed").is_some() || value.get("sessions_removed").is_some() {
        CleanupStatus::Ok
    } else {
        CleanupStatus::Unknown
    }
}

fn status_from_loose(status: Option<&str>, legacy_bool: Option<bool>) -> VerdictStatus {
    if let Some(status) = status {
        return VerdictStatus::parse(status);
    }
    match legacy_bool {
        Some(true) => VerdictStatus::Pass,
        Some(false) => VerdictStatus::Fail,
        None => VerdictStatus::Inconclusive,
    }
}

fn push_case_failure_categories(run: &mut LedgerRunRecord, case: &Value) {
    let classification = case
        .get("classification")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match classification {
        "usefulness_gap" => run.failure_categories.push(FailureCategory {
            code: "usefulness_gap".into(),
        }),
        "gateway_or_model_likely" => run.failure_categories.push(FailureCategory {
            code: "gateway_or_model_likely".into(),
        }),
        "product_integration_likely" => run.failure_categories.push(FailureCategory {
            code: "product_integration_likely".into(),
        }),
        "retry_required" => run.failure_categories.push(FailureCategory {
            code: "retry_required".into(),
        }),
        _ => {}
    }
    for lane_name in ["direct", "product", "scorer"] {
        if let Some(lane) = case.get(lane_name) {
            let executed = lane
                .get("executed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let passed = lane
                .get("passed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if executed && !passed {
                if let Some(detail) = lane.get("detail").and_then(|v| v.as_str()) {
                    let summary =
                        crate::redact::ShareSafeRedactionPolicy::default().failure_summary(detail);
                    let code = summary
                        .split(';')
                        .next()
                        .unwrap_or(summary.as_str())
                        .trim()
                        .trim_start_matches("failure category: ")
                        .to_string();
                    if !code.is_empty() && !run.failure_categories.iter().any(|c| c.code == code) {
                        run.failure_categories.push(FailureCategory { code });
                    }
                }
            }
        }
    }
}

fn logical_source_ref(path: &Path) -> String {
    // Never emit absolute private paths into ledger records.
    let rendered = path.to_string_lossy().replace('\\', "/");
    if let Some(idx) = rendered.find("fixtures/") {
        return rendered.get(idx..).unwrap_or("input").to_string();
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "input".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve a fixture directory relative to the cd-core crate for hermetic tests.
#[cfg(test)]
pub(crate) fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/gateway-cost-ledger/v1")
}
