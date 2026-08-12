//! Ingest share-safe gateway diagnostic bundles and historical benchmark rows.

use std::fs;
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use super::redact::{redact_ledger_run, reject_forbidden_fields, LedgerRedactionError};
use super::schema::{
    CleanupStatus, ComparisonCaveat, FailureCategory, IdentityLabel, LedgerRunRecord,
    LedgerSourceKind, MetricF64, MetricU64, ObservationBool, TokenUsage, VerdictStatus,
    LEDGER_SCHEMA_ID, LEDGER_SCHEMA_VERSION, MAX_DEADLINE_SECS, MAX_ELAPSED_MS,
    MAX_LEDGER_COLLECTION_ITEMS, MAX_LEDGER_INPUT_BYTES, MAX_LEDGER_STRING_BYTES,
    MAX_REPORTED_COST, MAX_REQUEST_COUNT, MAX_TOKEN_COUNT, MAX_UNIX_TIMESTAMP_MS,
};

/// Provenance labels for ingested records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestSource {
    /// `report.json` + verified `manifest.json` from gateway diagnose.
    DiagnosticBundle,
    /// Documented historical benchmark row (committed share-safe JSON).
    HistoricalBenchmarkRow,
    /// Already-shaped ledger run JSON.
    LedgerRun,
}

impl IngestSource {
    fn kind(self) -> LedgerSourceKind {
        match self {
            Self::DiagnosticBundle => LedgerSourceKind::DiagnosticBundle,
            Self::HistoricalBenchmarkRow => LedgerSourceKind::HistoricalBenchmarkRow,
            Self::LedgerRun => LedgerSourceKind::LedgerRun,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdentityDisclosurePolicy {
    /// Owner-local/live exact identity is never copied into share-safe output.
    DiagnosticPseudonymOnly,
    /// Only explicitly public labels in committed historical rows may remain exact.
    HistoricalPublicAllowlist,
}

/// Ingest a path that is either a diagnostic bundle directory, a report JSON
/// file, a historical row JSON file, or a ledger run JSON file.
pub fn ingest_path(path: &Path) -> Result<Vec<LedgerRunRecord>, IngestError> {
    if path.is_dir() {
        return ingest_diagnostic_bundle(path);
    }
    let text = read_bounded_text(path)?;
    let value: Value = serde_json::from_str(&text)?;
    validate_value_shape(&value, 0)?;
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
    let report_text = read_bounded_text(&report_path)?;
    let report: Value = serde_json::from_str(&report_text)?;
    validate_value_shape(&report, 0)?;
    reject_forbidden_fields(&report)?;

    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(IngestError::Rejected(
            "diagnostic bundle missing manifest.json integrity metadata".into(),
        ));
    }
    let manifest_text = read_bounded_text(&manifest_path)?;
    let manifest: Value = serde_json::from_str(&manifest_text)?;
    validate_value_shape(&manifest, 0)?;
    reject_forbidden_fields(&manifest)?;
    validate_manifest_against_report(&manifest, &report_text, &report)?;

    let mut run = map_gateway_diagnostic_report(
        &report,
        logical_source_ref(dir),
        IngestSource::DiagnosticBundle,
    )?;
    validate_ledger_run(&run)?;
    redact_ledger_run(&mut run);
    validate_ledger_run(&run)?;
    Ok(vec![run])
}

/// Ingest one documented historical benchmark row object.
pub fn ingest_historical_row(
    value: &Value,
    source_ref: &str,
) -> Result<LedgerRunRecord, IngestError> {
    reject_forbidden_fields(value)?;
    validate_value_shape(value, 0)?;
    let mut run = map_historical_row(value, source_ref)?;
    validate_ledger_run(&run)?;
    redact_ledger_run(&mut run);
    validate_ledger_run(&run)?;
    Ok(run)
}

/// Ingest a JSON value, auto-detecting diagnostic report / historical row /
/// ledger run shapes.
pub fn ingest_json_value(value: &Value, source_ref: &str) -> Result<LedgerRunRecord, IngestError> {
    validate_value_shape(value, 0)?;
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
        validate_ledger_run(&parsed)?;
        parsed
    } else if schema == "contextdesk.gateway_cost_ledger_historical_row.v1" {
        map_historical_row(value, source_ref)?
    } else if schema == "contextdesk.gateway_diagnostic.v1" {
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
    validate_ledger_run(&run)?;
    redact_ledger_run(&mut run);
    validate_ledger_run(&run)?;
    Ok(run)
}

fn read_bounded_text(path: &Path) -> Result<String, IngestError> {
    let size = fs::metadata(path)?.len();
    if size > MAX_LEDGER_INPUT_BYTES {
        return Err(IngestError::Rejected(format!(
            "input exceeds {} byte ledger limit",
            MAX_LEDGER_INPUT_BYTES
        )));
    }
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity((size.min(MAX_LEDGER_INPUT_BYTES)) as usize);
    file.take(MAX_LEDGER_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_LEDGER_INPUT_BYTES {
        return Err(IngestError::Rejected(format!(
            "input exceeds {} byte ledger limit",
            MAX_LEDGER_INPUT_BYTES
        )));
    }
    String::from_utf8(bytes)
        .map_err(|_| IngestError::Rejected("ledger input must be valid UTF-8".into()))
}

fn validate_value_shape(value: &Value, depth: usize) -> Result<(), IngestError> {
    if depth > 32 {
        return Err(IngestError::Rejected(
            "JSON nesting exceeds ledger limit".into(),
        ));
    }
    match value {
        Value::String(text) if text.len() > MAX_LEDGER_STRING_BYTES => Err(IngestError::Rejected(
            "string exceeds ledger input limit".into(),
        )),
        Value::Array(items) => {
            if items.len() > MAX_LEDGER_COLLECTION_ITEMS {
                return Err(IngestError::Rejected(
                    "array exceeds ledger item limit".into(),
                ));
            }
            for item in items {
                validate_value_shape(item, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            if map.len() > MAX_LEDGER_COLLECTION_ITEMS {
                return Err(IngestError::Rejected(
                    "object exceeds ledger field limit".into(),
                ));
            }
            for (key, child) in map {
                if key.len() > MAX_LEDGER_STRING_BYTES {
                    return Err(IngestError::Rejected(
                        "field name exceeds ledger limit".into(),
                    ));
                }
                validate_value_shape(child, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_manifest_against_report(
    manifest: &Value,
    report_bytes: &str,
    report: &Value,
) -> Result<(), IngestError> {
    if manifest.get("schema_id").and_then(Value::as_str)
        != Some("contextdesk.gateway_diagnostic_manifest.v1")
        || manifest.get("schema_version").and_then(Value::as_u64) != Some(1)
    {
        return Err(IngestError::Rejected(
            "unsupported diagnostic manifest schema".into(),
        ));
    }
    let manifest_run = manifest
        .get("run_id")
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IngestError::Rejected("diagnostic manifest run_id is missing".into()))?;
    let report_run = report
        .get("run_id")
        .and_then(|v| v.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IngestError::Rejected("diagnostic report run_id is missing".into()))?;
    if manifest_run != report_run {
        return Err(IngestError::Rejected(
            "manifest run_id does not match report run_id".into(),
        ));
    }
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            IngestError::Rejected("diagnostic manifest files must be an array".into())
        })?;
    let mut report_entry_seen = false;
    for file in files {
        let name = file.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name == "report.json" {
            if report_entry_seen {
                return Err(IngestError::Rejected(
                    "diagnostic manifest has duplicate report.json entries".into(),
                ));
            }
            report_entry_seen = true;
            let expected = file
                .get("sha256")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| IngestError::Rejected("manifest report sha256 is invalid".into()))?;
            let actual = sha256_hex(report_bytes.as_bytes());
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(IngestError::Rejected(
                    "manifest sha256 mismatch for report.json".into(),
                ));
            }
            let expected_bytes = file.get("bytes").and_then(Value::as_u64).ok_or_else(|| {
                IngestError::Rejected("manifest report byte count is invalid".into())
            })?;
            if expected_bytes != report_bytes.len() as u64 {
                return Err(IngestError::Rejected(
                    "manifest byte count mismatch for report.json".into(),
                ));
            }
        }
    }
    if !report_entry_seen {
        return Err(IngestError::Rejected(
            "diagnostic manifest is missing report.json integrity data".into(),
        ));
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
    if report.get("schema_id").and_then(Value::as_str) != Some("contextdesk.gateway_diagnostic.v1")
        || report.get("schema_version").and_then(Value::as_u64) != Some(2)
    {
        return Err(IngestError::Rejected(
            "unsupported gateway diagnostic schema".into(),
        ));
    }
    let run_id = required_string(report, "run_id")?;
    let mut run = LedgerRunRecord::blank(run_id, source.kind());
    run.schema_id = LEDGER_SCHEMA_ID.to_string();
    run.schema_version = LEDGER_SCHEMA_VERSION;
    run.source_ref = source_ref;

    if let Some(build) = report.get("build") {
        if !build.is_object() {
            return Err(IngestError::Rejected("build must be an object".into()));
        }
        let long_version = checked_optional_string(build, "long_version")?;
        let version = checked_optional_string(build, "version")?;
        if long_version.is_some() && version.is_some() && long_version != version {
            // The production report legitimately carries both a short version
            // and a long build identity; prefer the long identity in that
            // documented shape instead of treating them as aliases.
            run.build_identity = long_version;
        } else {
            run.build_identity = long_version.or(version);
        }
    }
    run.started_at_unix_ms = checked_optional_u64(
        report,
        &["started_at_unix_ms"],
        MAX_UNIX_TIMESTAMP_MS,
        "started_at_unix_ms",
    )?;
    run.finished_at_unix_ms = checked_optional_u64(
        report,
        &["finished_at_unix_ms"],
        MAX_UNIX_TIMESTAMP_MS,
        "finished_at_unix_ms",
    )?;

    let model_label = checked_optional_string(report, "model_label")?;
    let model_pseudonym = checked_optional_string(report, "model_pseudonym")?;
    run.model = identity_from_report_fields(
        model_label.as_deref(),
        model_pseudonym.as_deref(),
        true,
        IdentityDisclosurePolicy::DiagnosticPseudonymOnly,
    );
    let gateway_label = checked_optional_string(report, "gateway_label")?;
    let profile_pseudonym = checked_optional_string(report, "profile_pseudonym")?;
    run.gateway = identity_from_report_fields(
        gateway_label.as_deref(),
        profile_pseudonym.as_deref(),
        false,
        IdentityDisclosurePolicy::DiagnosticPseudonymOnly,
    );

    run.role_hint = checked_optional_string(report, "role_hint")?;
    run.level = checked_optional_string(report, "level")?;

    run.request_count = checked_metric_u64(
        report,
        &["requests_made"],
        MAX_REQUEST_COUNT,
        "requests_made",
    )?;
    run.tokens = tokens_from_value(report.get("usage").or_else(|| report.get("tokens")))?;
    run.reported_cost = cost_from_value(report)?;

    run.elapsed_ms = elapsed_from_report(report)?;
    run.deadline_secs = checked_optional_u64(
        report,
        &["deadline_secs"],
        MAX_DEADLINE_SECS,
        "deadline_secs",
    )?;
    run.deadline_exceeded = checked_observation_bool(report, "deadline_exceeded")?;
    run.cancelled = checked_observation_bool(report, "cancelled")?;
    run.cleanup = cleanup_from_value(report.get("cleanup"))?;

    let verdicts: LooseVerdicts = serde_json::from_value(
        report
            .get("verdicts")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default())),
    )?;
    run.gateway_model = status_from_loose(
        verdicts.gateway_model_status.as_deref(),
        verdicts.gateway_model_compatible,
    )?;
    run.product_workflow = status_from_loose(
        verdicts.product_workflow_status.as_deref(),
        verdicts.product_workflow_compatible,
    )?;
    run.answers_useful = status_from_loose(
        verdicts.answers_useful_status.as_deref(),
        verdicts.answers_useful,
    )?;

    if let Some(cases_value) = report.get("cases") {
        let cases = cases_value
            .as_array()
            .ok_or_else(|| IngestError::Rejected("cases must be an array".into()))?;
        for case in cases {
            if let Some(classification) = case.get("classification").and_then(|v| v.as_str()) {
                run.case_classifications.push(classification.to_string());
            }
            push_case_failure_categories(&mut run, case);
        }
    }

    if run.deadline_exceeded == ObservationBool::Known(true) {
        run.failure_categories.push(FailureCategory {
            code: "deadline_exceeded".into(),
        });
    }
    if run.cancelled == ObservationBool::Known(true) {
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
    if value.get("schema_id").and_then(Value::as_str)
        != Some("contextdesk.gateway_cost_ledger_historical_row.v1")
        || value.get("schema_version").and_then(Value::as_u64) != Some(1)
        || value.get("historical_row").and_then(Value::as_bool) != Some(true)
    {
        return Err(IngestError::Rejected(
            "unsupported historical ledger row schema".into(),
        ));
    }
    let run_id = required_string(value, "run_id")?;
    let mut run = LedgerRunRecord::blank(run_id, IngestSource::HistoricalBenchmarkRow.kind());
    run.source_ref = if value.get("documented_source").is_some() {
        required_string(value, "documented_source")?
    } else {
        source_ref.to_string()
    };
    let source_build = checked_optional_string(value, "source_build")?;
    let build_identity = checked_optional_string(value, "build_identity")?;
    if source_build.is_some() && build_identity.is_some() && source_build != build_identity {
        return Err(IngestError::Rejected(
            "conflicting aliases for build identity".into(),
        ));
    }
    run.build_identity = source_build.or(build_identity);

    let model_label = checked_optional_string(value, "model_label")?;
    let model_pseudonym = checked_optional_string(value, "model_pseudonym")?;
    run.model = identity_from_report_fields(
        model_label.as_deref(),
        model_pseudonym.as_deref(),
        true,
        IdentityDisclosurePolicy::HistoricalPublicAllowlist,
    );
    let gateway_label = checked_optional_string(value, "gateway_label")?;
    let gateway_pseudonym = checked_optional_string(value, "gateway_pseudonym")?;
    run.gateway = identity_from_report_fields(
        gateway_label.as_deref(),
        gateway_pseudonym.as_deref(),
        false,
        IdentityDisclosurePolicy::HistoricalPublicAllowlist,
    );
    run.role_hint = checked_optional_string(value, "role_hint")?;
    run.level = checked_optional_string(value, "level")?;
    run.request_count = checked_metric_u64(
        value,
        &["request_count"],
        MAX_REQUEST_COUNT,
        "request_count",
    )?;
    run.tokens = tokens_from_value(value.get("tokens").or_else(|| value.get("usage")))?;
    run.reported_cost = cost_from_value(value)?;
    run.elapsed_ms = checked_metric_u64(value, &["elapsed_ms"], MAX_ELAPSED_MS, "elapsed_ms")?;
    run.deadline_secs = checked_optional_u64(
        value,
        &["deadline_secs"],
        MAX_DEADLINE_SECS,
        "deadline_secs",
    )?;
    run.deadline_exceeded = checked_observation_bool(value, "deadline_exceeded")?;
    run.cancelled = checked_observation_bool(value, "cancelled")?;
    run.cleanup = checked_cleanup_status(value.get("cleanup_status"))?;
    run.gateway_model = checked_verdict_status(value.get("gateway_model_status"))?;
    run.product_workflow = checked_verdict_status(value.get("product_workflow_status"))?;
    run.answers_useful = checked_verdict_status(value.get("answers_useful_status"))?;
    if let Some(categories_value) = value.get("failure_categories") {
        let categories = categories_value
            .as_array()
            .ok_or_else(|| IngestError::Rejected("failure_categories must be an array".into()))?;
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
    if let Some(classes_value) = value.get("case_classifications") {
        let classes = classes_value
            .as_array()
            .ok_or_else(|| IngestError::Rejected("case_classifications must be an array".into()))?;
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
    policy: IdentityDisclosurePolicy,
) -> IdentityLabel {
    if policy == IdentityDisclosurePolicy::HistoricalPublicAllowlist {
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
        }
    }
    if let Some(label) = pseudonym.map(str::trim).filter(|s| !s.is_empty()) {
        return IdentityLabel::Pseudonym {
            value: label.to_string(),
        };
    }
    // Exact diagnostic identities are owner-local data. The share-safe ledger
    // never carries them; only an explicit pseudonym survives. Public exact
    // labels are limited to committed historical documentation above.
    IdentityLabel::Unknown
}

fn tokens_from_value(value: Option<&Value>) -> Result<TokenUsage, IngestError> {
    let Some(value) = value else {
        return Ok(TokenUsage::default());
    };
    if !value.is_object() {
        return Err(IngestError::Rejected(
            "usage/tokens must be an object".into(),
        ));
    }
    Ok(TokenUsage {
        input: checked_metric_u64(
            value,
            &["input", "input_tokens", "prompt_tokens"],
            MAX_TOKEN_COUNT,
            "input tokens",
        )?,
        output: checked_metric_u64(
            value,
            &["output", "output_tokens", "completion_tokens"],
            MAX_TOKEN_COUNT,
            "output tokens",
        )?,
        reasoning: checked_metric_u64(
            value,
            &["reasoning", "reasoning_tokens"],
            MAX_TOKEN_COUNT,
            "reasoning tokens",
        )?,
        cached: checked_metric_u64(
            value,
            &["cached", "cached_tokens"],
            MAX_TOKEN_COUNT,
            "cached tokens",
        )?,
        total: checked_metric_u64(
            value,
            &["total", "total_tokens"],
            MAX_TOKEN_COUNT,
            "total tokens",
        )?,
    })
}

fn cost_from_value(value: &Value) -> Result<MetricF64, IngestError> {
    let candidates = [
        value.get("reported_cost"),
        value.get("cost"),
        value.get("usage").and_then(|usage| usage.get("cost")),
    ];
    let mut observed = None;
    for raw in candidates.into_iter().flatten() {
        let cost = raw.as_f64().ok_or_else(|| {
            IngestError::Rejected("reported cost must be a finite non-negative number".into())
        })?;
        if !cost.is_finite() || !(0.0..=MAX_REPORTED_COST).contains(&cost) {
            return Err(IngestError::Rejected(format!(
                "reported cost must be between 0 and {MAX_REPORTED_COST}"
            )));
        }
        if let Some(previous) = observed {
            if previous != cost {
                return Err(IngestError::Rejected(
                    "conflicting aliases for reported cost".into(),
                ));
            }
        } else {
            observed = Some(cost);
        }
    }
    Ok(observed.map_or(MetricF64::Unknown, MetricF64::Known))
}

fn elapsed_from_report(report: &Value) -> Result<MetricU64, IngestError> {
    let direct = checked_metric_u64(report, &["elapsed_ms"], MAX_ELAPSED_MS, "elapsed_ms")?;
    if !matches!(direct, MetricU64::Unknown) {
        return Ok(direct);
    }
    match (
        report.get("started_at_unix_ms").and_then(|v| v.as_u64()),
        report.get("finished_at_unix_ms").and_then(|v| v.as_u64()),
    ) {
        (Some(start), Some(end)) if end >= start && end - start <= MAX_ELAPSED_MS => {
            Ok(MetricU64::Known(end - start))
        }
        (Some(start), Some(end)) if end < start => Err(IngestError::Rejected(
            "finished_at_unix_ms precedes started_at_unix_ms".into(),
        )),
        (Some(_), Some(_)) => Err(IngestError::Rejected(
            "timestamp-derived elapsed time exceeds ledger limit".into(),
        )),
        _ => {
            // Fall back to summing product-lane elapsed when present.
            let mut sum = 0u64;
            let mut any = false;
            if let Some(cases) = report.get("cases").and_then(|v| v.as_array()) {
                for case in cases {
                    if let Some(product) = case.get("product") {
                        let metric = checked_metric_u64(
                            product,
                            &["elapsed_ms"],
                            MAX_ELAPSED_MS,
                            "case product elapsed_ms",
                        )?;
                        if let MetricU64::Known(ms) = metric {
                            any = true;
                            sum = sum.checked_add(ms).ok_or_else(|| {
                                IngestError::Rejected("case elapsed time overflow".into())
                            })?;
                            if sum > MAX_ELAPSED_MS {
                                return Err(IngestError::Rejected(
                                    "summed case elapsed time exceeds ledger limit".into(),
                                ));
                            }
                        }
                    }
                }
            }
            if any {
                Ok(MetricU64::Known(sum))
            } else {
                Ok(MetricU64::Unknown)
            }
        }
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, IngestError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| IngestError::Rejected(format!("{key} must be a non-empty string")))?;
    if text.len() > MAX_LEDGER_STRING_BYTES {
        return Err(IngestError::Rejected(format!(
            "{key} exceeds ledger string limit"
        )));
    }
    Ok(text.to_string())
}

fn checked_optional_string(value: &Value, key: &str) -> Result<Option<String>, IngestError> {
    let Some(raw) = value.get(key) else {
        return Ok(None);
    };
    let text = raw
        .as_str()
        .ok_or_else(|| IngestError::Rejected(format!("{key} must be a string")))?
        .trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_LEDGER_STRING_BYTES {
        return Err(IngestError::Rejected(format!(
            "{key} exceeds ledger string limit"
        )));
    }
    Ok(Some(text.to_string()))
}

fn checked_optional_u64(
    value: &Value,
    keys: &[&str],
    max: u64,
    label: &str,
) -> Result<Option<u64>, IngestError> {
    let mut observed = None;
    for key in keys {
        let Some(raw) = value.get(*key) else {
            continue;
        };
        let number = raw.as_u64().ok_or_else(|| {
            IngestError::Rejected(format!("{label} must be a non-negative integer"))
        })?;
        if number > max {
            return Err(IngestError::Rejected(format!(
                "{label} exceeds ledger limit {max}"
            )));
        }
        if let Some(previous) = observed {
            if previous != number {
                return Err(IngestError::Rejected(format!(
                    "conflicting aliases for {label}"
                )));
            }
        } else {
            observed = Some(number);
        }
    }
    Ok(observed)
}

fn checked_metric_u64(
    value: &Value,
    keys: &[&str],
    max: u64,
    label: &str,
) -> Result<MetricU64, IngestError> {
    Ok(checked_optional_u64(value, keys, max, label)?.map_or(MetricU64::Unknown, MetricU64::Known))
}

fn checked_observation_bool(value: &Value, key: &str) -> Result<ObservationBool, IngestError> {
    let Some(raw) = value.get(key) else {
        return Ok(ObservationBool::Unknown);
    };
    raw.as_bool()
        .map(ObservationBool::Known)
        .ok_or_else(|| IngestError::Rejected(format!("{key} must be a boolean")))
}

fn cleanup_from_value(value: Option<&Value>) -> Result<CleanupStatus, IngestError> {
    let Some(value) = value else {
        return Ok(CleanupStatus::Unknown);
    };
    if !value.is_object() {
        return Err(IngestError::Rejected("cleanup must be an object".into()));
    }
    if let Some(raw_status) = value.get("status") {
        let status = raw_status
            .as_str()
            .ok_or_else(|| IngestError::Rejected("cleanup status must be a string".into()))?;
        return match status.trim().to_ascii_lowercase().as_str() {
            "ok" => Ok(CleanupStatus::Ok),
            "failed" => Ok(CleanupStatus::Failed),
            "unknown" => Ok(CleanupStatus::Unknown),
            _ => Err(IngestError::Rejected("invalid cleanup status".into())),
        };
    }
    let failures = value
        .get("failures")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    if failures > 0 {
        Ok(CleanupStatus::Failed)
    } else if value.get("corpora_removed").is_some() || value.get("sessions_removed").is_some() {
        Ok(CleanupStatus::Ok)
    } else {
        Ok(CleanupStatus::Unknown)
    }
}

fn status_from_loose(
    status: Option<&str>,
    legacy_bool: Option<bool>,
) -> Result<VerdictStatus, IngestError> {
    if let Some(status) = status {
        return match status.trim().to_ascii_lowercase().as_str() {
            "pass" => Ok(VerdictStatus::Pass),
            "fail" => Ok(VerdictStatus::Fail),
            "inconclusive" => Ok(VerdictStatus::Inconclusive),
            _ => Err(IngestError::Rejected("invalid verdict status".into())),
        };
    }
    Ok(match legacy_bool {
        Some(true) => VerdictStatus::Pass,
        Some(false) => VerdictStatus::Fail,
        None => VerdictStatus::Inconclusive,
    })
}

fn checked_cleanup_status(value: Option<&Value>) -> Result<CleanupStatus, IngestError> {
    let Some(value) = value else {
        return Ok(CleanupStatus::Unknown);
    };
    match value.as_str().map(str::trim).map(str::to_ascii_lowercase) {
        Some(status) if status == "ok" => Ok(CleanupStatus::Ok),
        Some(status) if status == "failed" => Ok(CleanupStatus::Failed),
        Some(status) if status == "unknown" => Ok(CleanupStatus::Unknown),
        _ => Err(IngestError::Rejected("invalid cleanup_status".into())),
    }
}

fn checked_verdict_status(value: Option<&Value>) -> Result<VerdictStatus, IngestError> {
    let Some(value) = value else {
        return Ok(VerdictStatus::Inconclusive);
    };
    match value.as_str().map(str::trim).map(str::to_ascii_lowercase) {
        Some(status) if status == "pass" => Ok(VerdictStatus::Pass),
        Some(status) if status == "fail" => Ok(VerdictStatus::Fail),
        Some(status) if status == "inconclusive" => Ok(VerdictStatus::Inconclusive),
        _ => Err(IngestError::Rejected("invalid verdict status".into())),
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

fn validate_ledger_run(run: &LedgerRunRecord) -> Result<(), IngestError> {
    if run.schema_id != LEDGER_SCHEMA_ID || run.schema_version != LEDGER_SCHEMA_VERSION {
        return Err(IngestError::Rejected(
            "unsupported ledger schema identity".into(),
        ));
    }
    for (label, text) in [
        ("run_id", run.run_id.as_str()),
        ("source_ref", run.source_ref.as_str()),
    ] {
        if text.trim().is_empty() || text.len() > MAX_LEDGER_STRING_BYTES {
            return Err(IngestError::Rejected(format!("invalid {label}")));
        }
    }
    if run.source_ref.starts_with('/')
        || run.source_ref.contains(":\\")
        || run.source_ref.contains(":/")
        || run.source_ref.contains("../")
    {
        return Err(IngestError::Rejected(
            "source_ref must be a logical share-safe reference".into(),
        ));
    }
    for optional in [
        run.build_identity.as_deref(),
        run.role_hint.as_deref(),
        run.level.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if optional.len() > MAX_LEDGER_STRING_BYTES {
            return Err(IngestError::Rejected("ledger string exceeds limit".into()));
        }
    }
    for identity in [&run.model, &run.gateway] {
        let value = match identity {
            IdentityLabel::Exact { value } | IdentityLabel::Pseudonym { value } => value,
            IdentityLabel::Unknown => continue,
        };
        if value.trim().is_empty() || value.len() > 512 {
            return Err(IngestError::Rejected("invalid identity label".into()));
        }
    }
    if let IdentityLabel::Exact { value } = &run.model {
        if run.source_kind != LedgerSourceKind::HistoricalBenchmarkRow
            || !SHARE_SAFE_EXACT_MODEL_LABELS.contains(&value.as_str())
        {
            return Err(IngestError::Rejected(
                "exact model identity is not allowed in this share-safe provenance cohort".into(),
            ));
        }
    }
    if let IdentityLabel::Exact { value } = &run.gateway {
        if run.source_kind != LedgerSourceKind::HistoricalBenchmarkRow
            || !SHARE_SAFE_EXACT_GATEWAY_LABELS.contains(&value.as_str())
        {
            return Err(IngestError::Rejected(
                "exact gateway identity is not allowed in this share-safe provenance cohort".into(),
            ));
        }
    }
    validate_metric(run.request_count, MAX_REQUEST_COUNT, "request_count")?;
    for (metric, label) in [
        (run.tokens.input, "input tokens"),
        (run.tokens.output, "output tokens"),
        (run.tokens.reasoning, "reasoning tokens"),
        (run.tokens.cached, "cached tokens"),
        (run.tokens.total, "total tokens"),
    ] {
        validate_metric(metric, MAX_TOKEN_COUNT, label)?;
    }
    validate_metric(run.elapsed_ms, MAX_ELAPSED_MS, "elapsed_ms")?;
    if let Some(deadline) = run.deadline_secs {
        if deadline > MAX_DEADLINE_SECS {
            return Err(IngestError::Rejected(
                "deadline_secs exceeds ledger limit".into(),
            ));
        }
    }
    if let MetricF64::Known(cost) = run.reported_cost {
        if !cost.is_finite() || !(0.0..=MAX_REPORTED_COST).contains(&cost) {
            return Err(IngestError::Rejected(
                "reported cost is outside ledger bounds".into(),
            ));
        }
    }
    for timestamp in [run.started_at_unix_ms, run.finished_at_unix_ms]
        .into_iter()
        .flatten()
    {
        if timestamp > MAX_UNIX_TIMESTAMP_MS {
            return Err(IngestError::Rejected(
                "timestamp exceeds ledger limit".into(),
            ));
        }
    }
    if let (Some(start), Some(finish)) = (run.started_at_unix_ms, run.finished_at_unix_ms) {
        if finish < start || finish - start > MAX_ELAPSED_MS {
            return Err(IngestError::Rejected(
                "invalid run timestamp interval".into(),
            ));
        }
    }
    if run.failure_categories.len() > MAX_LEDGER_COLLECTION_ITEMS
        || run.case_classifications.len() > MAX_LEDGER_COLLECTION_ITEMS
        || run.caveats.len() > MAX_LEDGER_COLLECTION_ITEMS
    {
        return Err(IngestError::Rejected(
            "ledger collection exceeds item limit".into(),
        ));
    }
    for text in run
        .failure_categories
        .iter()
        .map(|v| v.code.as_str())
        .chain(run.case_classifications.iter().map(String::as_str))
        .chain(
            run.caveats
                .iter()
                .flat_map(|v| [v.code.as_str(), v.detail.as_str()]),
        )
    {
        if text.len() > MAX_LEDGER_STRING_BYTES {
            return Err(IngestError::Rejected(
                "ledger text exceeds string limit".into(),
            ));
        }
    }
    Ok(())
}

fn validate_metric(metric: MetricU64, max: u64, label: &str) -> Result<(), IngestError> {
    if matches!(metric, MetricU64::Known(value) if value > max) {
        return Err(IngestError::Rejected(format!(
            "{label} exceeds ledger limit"
        )));
    }
    Ok(())
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
