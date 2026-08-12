//! Deterministic comparison report for CLI and future GUI use.

use serde::{Deserialize, Serialize};

use super::aggregate::{aggregate_runs, run_group_key, DimensionCounts, LedgerAggregateSummary};
use super::redact::assert_share_safe_ledger_json;
use super::schema::{
    ComparisonCaveat, LedgerRunRecord, LedgerSourceKind, MetricF64, MetricU64, ObservationBool,
    VerdictStatus, COMPARISON_SCHEMA_ID, COMPARISON_SCHEMA_VERSION,
};

/// One per-model row inside a comparison report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelComparisonRow {
    /// Model grouping / display identity.
    pub model: String,
    /// Gateway grouping/display identity.
    pub gateway: String,
    /// Evidence provenance cohort.
    pub source_kind: LedgerSourceKind,
    /// Grouping key.
    pub group_key: String,
    /// Runs contributing to this row.
    pub runs: Vec<RunSummary>,
    /// Aggregate over those runs.
    pub aggregate: LedgerAggregateSummary,
    /// Pass rates by diagnostic dimension (measured only).
    pub pass_rates: DimensionPassRates,
}

/// Compact per-run projection for comparison tables.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RunSummary {
    /// Run id.
    pub run_id: String,
    /// Source kind.
    pub source_kind: LedgerSourceKind,
    /// Source reference (logical, never private absolute path).
    pub source_ref: String,
    /// Gateway display label.
    pub gateway: String,
    /// Request count.
    pub request_count: MetricU64,
    /// Reported cost.
    pub reported_cost: MetricF64,
    /// Elapsed ms.
    pub elapsed_ms: MetricU64,
    /// Deadline exceeded?
    pub deadline_exceeded: ObservationBool,
    /// Cancelled?
    pub cancelled: ObservationBool,
    /// Cleanup status label.
    pub cleanup: String,
    /// Gateway/model verdict.
    pub gateway_model: VerdictStatus,
    /// Product workflow verdict.
    pub product_workflow: VerdictStatus,
    /// Answers useful verdict.
    pub answers_useful: VerdictStatus,
}

/// Measured pass rates; absent when a dimension has no measured runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct DimensionPassRates {
    /// Gateway/model measured pass rate in `[0,1]`, or unknown.
    pub gateway_model: Option<f64>,
    /// Product workflow measured pass rate.
    pub product_workflow: Option<f64>,
    /// Answers-useful measured pass rate.
    pub answers_useful: Option<f64>,
}

/// Deterministic comparison report suitable for CLI and future GUI.
///
/// Never contains the strings `verified` or readiness badges derived from
/// aggregates. Confidence caveats are always present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ComparisonReport {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Total runs ingested.
    pub run_count: u64,
    /// Per-model comparison rows, sorted by group key.
    pub models: Vec<ModelComparisonRow>,
    /// Report-wide confidence caveats.
    pub confidence_caveats: Vec<ComparisonCaveat>,
}

/// Build a deterministic comparison report from ingested runs.
pub fn build_comparison_report(runs: &[LedgerRunRecord]) -> ComparisonReport {
    let mut runs_sorted = runs.to_vec();
    runs_sorted.sort_by(|a, b| {
        a.model
            .grouping_key()
            .cmp(&b.model.grouping_key())
            .then_with(|| a.run_id.cmp(&b.run_id))
            .then_with(|| a.source_ref.cmp(&b.source_ref))
    });

    let aggregates = aggregate_runs(&runs_sorted);
    let mut models: Vec<ModelComparisonRow> = aggregates
        .into_iter()
        .map(|aggregate| {
            let group_key = aggregate.group_key.clone();
            let model_runs: Vec<RunSummary> = runs_sorted
                .iter()
                .filter(|r| run_group_key(r) == group_key)
                .map(run_summary)
                .collect();
            let pass_rates = DimensionPassRates {
                gateway_model: aggregate.gateway_model.measured_pass_rate(),
                product_workflow: aggregate.product_workflow.measured_pass_rate(),
                answers_useful: aggregate.answers_useful.measured_pass_rate(),
            };
            let gateway = model_runs
                .first()
                .map(|run| run.gateway.clone())
                .unwrap_or_else(|| "unknown".into());
            ModelComparisonRow {
                model: aggregate.display_label.clone(),
                gateway,
                source_kind: aggregate.source_kind,
                group_key,
                runs: model_runs,
                aggregate,
                pass_rates,
            }
        })
        .collect();
    models.sort_by(|a, b| a.group_key.cmp(&b.group_key));

    let mut confidence_caveats = vec![
        ComparisonCaveat {
            code: "share_safe_sources_only".into(),
            detail: "comparison uses only operator-selected share-safe diagnostic artifacts and documented historical rows; no gateway observation is invented".into(),
        },
        ComparisonCaveat {
            code: "no_readiness_claim_from_aggregate".into(),
            detail: "this report never certifies models or emits readiness claims from aggregates; inconclusive stays separate from fail and pass".into(),
        },
        ComparisonCaveat {
            code: "unknown_cost_is_not_zero".into(),
            detail: "missing cost or token fields remain unknown and are never zero-filled in aggregates".into(),
        },
        ComparisonCaveat {
            code: "provenance_cohorts_separate".into(),
            detail: "observed diagnostic artifacts and documented historical rows are never combined in one aggregate".into(),
        },
        ComparisonCaveat {
            code: "unknown_boolean_is_not_false".into(),
            detail: "missing deadline or cancellation observations remain unknown rather than false".into(),
        },
    ];

    let any_inconclusive = runs_sorted.iter().any(|r| {
        matches!(r.gateway_model, VerdictStatus::Inconclusive)
            || matches!(r.product_workflow, VerdictStatus::Inconclusive)
            || matches!(r.answers_useful, VerdictStatus::Inconclusive)
    });
    if any_inconclusive {
        confidence_caveats.push(ComparisonCaveat {
            code: "inconclusive_preserved".into(),
            detail: "at least one run has an inconclusive dimension; pass rates ignore inconclusive rather than counting them as fail".into(),
        });
    }

    confidence_caveats.sort_by(|a, b| a.code.cmp(&b.code));

    ComparisonReport {
        schema_id: COMPARISON_SCHEMA_ID.to_string(),
        schema_version: COMPARISON_SCHEMA_VERSION,
        run_count: runs_sorted.len() as u64,
        models,
        confidence_caveats,
    }
}

fn run_summary(run: &LedgerRunRecord) -> RunSummary {
    RunSummary {
        run_id: run.run_id.clone(),
        source_kind: run.source_kind,
        source_ref: run.source_ref.clone(),
        gateway: run.gateway.display().to_string(),
        request_count: run.request_count,
        reported_cost: run.reported_cost,
        elapsed_ms: run.elapsed_ms,
        deadline_exceeded: run.deadline_exceeded,
        cancelled: run.cancelled,
        cleanup: match run.cleanup {
            super::schema::CleanupStatus::Ok => "ok".into(),
            super::schema::CleanupStatus::Failed => "failed".into(),
            super::schema::CleanupStatus::Unknown => "unknown".into(),
        },
        gateway_model: run.gateway_model,
        product_workflow: run.product_workflow,
        answers_useful: run.answers_useful,
    }
}

/// Serialize a comparison report and enforce the share-safe emission gate.
pub fn emit_comparison_json(report: &ComparisonReport) -> Result<String, String> {
    let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    // Harden against accidental badge language.
    let lower = json.to_ascii_lowercase();
    for banned in ["\"verified\"", "readiness_badge", "ready_for_production"] {
        if lower.contains(banned) {
            return Err(format!(
                "comparison report refused to emit banned readiness language ({banned})"
            ));
        }
    }
    assert_share_safe_ledger_json(&json).map_err(|e| e.to_string())?;
    Ok(json)
}

/// Render a compact deterministic text table for CLI use.
pub fn render_comparison_text(report: &ComparisonReport) -> String {
    let mut out = String::new();
    out.push_str("Gateway cost/reliability ledger comparison\n");
    out.push_str(&format!(
        "schema={} v{}  runs={}\n",
        report.schema_id, report.schema_version, report.run_count
    ));
    out.push_str("NOTE: aggregates are evidence comparisons only — not readiness claims.\n\n");

    for model in &report.models {
        out.push_str(&format!(
            "model: {}  gateway: {}  source: {}\n",
            model.model,
            model.gateway,
            model.source_kind.as_str()
        ));
        out.push_str(&format!(
            "  runs={}  median_elapsed_ms={}  requests={}  cost={}\n",
            model.aggregate.run_count,
            metric_u64_label(model.aggregate.median_elapsed_ms),
            metric_u64_label(model.aggregate.request_count),
            metric_f64_label(model.aggregate.reported_cost),
        ));
        out.push_str(&format!(
            "  pass_rates: gateway_model={}  product_workflow={}  answers_useful={}\n",
            rate_label(model.pass_rates.gateway_model),
            rate_label(model.pass_rates.product_workflow),
            rate_label(model.pass_rates.answers_useful),
        ));
        out.push_str(&format!(
            "  dimension_counts: gateway_model={}  product_workflow={}  answers_useful={}\n",
            counts_label(model.aggregate.gateway_model),
            counts_label(model.aggregate.product_workflow),
            counts_label(model.aggregate.answers_useful),
        ));
        out.push_str(&format!(
            "  tokens: in={} out={} reason={} cached={} total={}\n",
            metric_u64_label(model.aggregate.tokens.input),
            metric_u64_label(model.aggregate.tokens.output),
            metric_u64_label(model.aggregate.tokens.reasoning),
            metric_u64_label(model.aggregate.tokens.cached),
            metric_u64_label(model.aggregate.tokens.total),
        ));
        if !model.aggregate.failure_categories.is_empty() {
            out.push_str(&format!(
                "  failure_categories: {}\n",
                model.aggregate.failure_categories.join(", ")
            ));
        }
        for run in &model.runs {
            out.push_str(&format!(
                "  - {} [{}] req={} elapsed={} cost={} gw={:?} product={:?} useful={:?} cleanup={} deadline_exceeded={} cancelled={}\n",
                run.run_id,
                run.source_kind.as_str(),
                metric_u64_label(run.request_count),
                metric_u64_label(run.elapsed_ms),
                metric_f64_label(run.reported_cost),
                run.gateway_model,
                run.product_workflow,
                run.answers_useful,
                run.cleanup,
                observation_bool_label(run.deadline_exceeded),
                observation_bool_label(run.cancelled),
            ));
        }
        out.push('\n');
    }

    out.push_str("Confidence caveats:\n");
    for caveat in &report.confidence_caveats {
        out.push_str(&format!("  - {}: {}\n", caveat.code, caveat.detail));
    }
    out
}

fn metric_u64_label(value: MetricU64) -> String {
    match value {
        MetricU64::Known(v) => v.to_string(),
        MetricU64::Unknown => "unknown".into(),
    }
}

fn metric_f64_label(value: MetricF64) -> String {
    match value {
        MetricF64::Known(v) => format!("{v}"),
        MetricF64::Unknown => "unknown".into(),
    }
}

fn observation_bool_label(value: ObservationBool) -> &'static str {
    match value {
        ObservationBool::Known(true) => "true",
        ObservationBool::Known(false) => "false",
        ObservationBool::Unknown => "unknown",
    }
}

fn rate_label(value: Option<f64>) -> String {
    match value {
        Some(v) => format!("{:.3}", v),
        None => "unknown".into(),
    }
}

fn counts_label(counts: DimensionCounts) -> String {
    format!(
        "pass={} fail={} inconclusive={}",
        counts.pass, counts.fail, counts.inconclusive
    )
}
