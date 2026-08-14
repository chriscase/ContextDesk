//! Aggregate summaries over many ledger runs.

use serde::{Deserialize, Serialize};

use super::schema::{
    ComparisonCaveat, LedgerRunRecord, LedgerSourceKind, MetricF64, MetricU64, ObservationBool,
    TokenUsage, VerdictDimension, VerdictStatus, AGGREGATE_SCHEMA_ID, AGGREGATE_SCHEMA_VERSION,
};

/// Aggregate summary for one model/gateway grouping key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LedgerAggregateSummary {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Grouping key (`exact:…` / `pseudonym:…` / `unknown`).
    pub group_key: String,
    /// Display label for the group.
    pub display_label: String,
    /// Provenance cohort; diagnostic observations and historical rows never mix.
    pub source_kind: LedgerSourceKind,
    /// Number of runs in this aggregate.
    pub run_count: u64,
    /// Total requests across runs (unknown if any run omitted the count).
    pub request_count: MetricU64,
    /// Aggregated token usage.
    pub tokens: TokenUsage,
    /// Aggregated reported cost.
    pub reported_cost: MetricF64,
    /// Median elapsed milliseconds across runs with known elapsed.
    pub median_elapsed_ms: MetricU64,
    /// Pass / fail / inconclusive counts per diagnostic dimension.
    pub gateway_model: DimensionCounts,
    /// Product workflow dimension counts.
    pub product_workflow: DimensionCounts,
    /// Answers-useful dimension counts.
    pub answers_useful: DimensionCounts,
    /// Known true/false and unknown deadline observations.
    pub deadline_exceeded: BooleanCounts,
    /// Known true/false and unknown cancellation observations.
    pub cancelled: BooleanCounts,
    /// Runs whose cleanup failed.
    pub cleanup_failed_runs: u64,
    /// Distinct failure category codes observed.
    pub failure_categories: Vec<String>,
    /// Confidence caveats for this aggregate.
    pub caveats: Vec<ComparisonCaveat>,
}

/// Pass/fail/inconclusive counters for one verdict dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct DimensionCounts {
    /// Measured passes.
    pub pass: u64,
    /// Measured failures.
    pub fail: u64,
    /// Unmeasured / inconclusive.
    pub inconclusive: u64,
}

/// Counts for a boolean observation without collapsing unknown into false.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct BooleanCounts {
    /// Sources that explicitly reported true.
    pub true_count: u64,
    /// Sources that explicitly reported false.
    pub false_count: u64,
    /// Sources that omitted the observation.
    pub unknown: u64,
}

impl BooleanCounts {
    fn record(&mut self, value: ObservationBool) {
        match value {
            ObservationBool::Known(true) => self.true_count += 1,
            ObservationBool::Known(false) => self.false_count += 1,
            ObservationBool::Unknown => self.unknown += 1,
        }
    }
}

impl DimensionCounts {
    fn record(&mut self, status: VerdictStatus) {
        match status {
            VerdictStatus::Pass => self.pass += 1,
            VerdictStatus::Fail => self.fail += 1,
            VerdictStatus::Inconclusive => self.inconclusive += 1,
        }
    }

    /// Pass rate among measured (pass+fail) runs only. `None` when nothing
    /// measured — never invents 0% from inconclusive-only data.
    pub fn measured_pass_rate(self) -> Option<f64> {
        let measured = self.pass + self.fail;
        if measured == 0 {
            None
        } else {
            Some((self.pass as f64) / (measured as f64))
        }
    }
}

/// Aggregate runs sharing the same model grouping key.
pub fn aggregate_runs(runs: &[LedgerRunRecord]) -> Vec<LedgerAggregateSummary> {
    let mut groups: Vec<(String, Vec<&LedgerRunRecord>)> = Vec::new();
    for run in runs {
        let key = run_group_key(run);
        if let Some((_, bucket)) = groups.iter_mut().find(|(k, _)| *k == key) {
            bucket.push(run);
        } else {
            groups.push((key, vec![run]));
        }
    }
    groups.sort_by(|a, b| a.0.cmp(&b.0));

    groups
        .into_iter()
        .map(|(group_key, bucket)| summarize_group(group_key, &bucket))
        .collect()
}

pub(crate) fn run_group_key(run: &LedgerRunRecord) -> String {
    let model = match &run.model {
        super::schema::IdentityLabel::Unknown => format!("unknown-run:{}", run.run_id),
        _ => run.model.grouping_key(),
    };
    let gateway = match &run.gateway {
        super::schema::IdentityLabel::Unknown => format!("unknown-run:{}", run.run_id),
        _ => run.gateway.grouping_key(),
    };
    format!("{}:{gateway}:{model}", run.source_kind.as_str())
}

fn summarize_group(group_key: String, runs: &[&LedgerRunRecord]) -> LedgerAggregateSummary {
    let display_label = runs
        .first()
        .map(|r| r.model.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let source_kind = runs
        .first()
        .map(|run| run.source_kind)
        .unwrap_or(LedgerSourceKind::LedgerRun);

    let mut gateway_model = DimensionCounts::default();
    let mut product_workflow = DimensionCounts::default();
    let mut answers_useful = DimensionCounts::default();
    let mut deadline_exceeded = BooleanCounts::default();
    let mut cancelled = BooleanCounts::default();
    let mut cleanup_failed_runs = 0u64;
    let mut failure_categories: Vec<String> = Vec::new();
    let mut elapsed_known: Vec<u64> = Vec::new();
    let mut caveats: Vec<ComparisonCaveat> = Vec::new();

    for run in runs {
        gateway_model.record(run.verdict(VerdictDimension::GatewayModel));
        product_workflow.record(run.verdict(VerdictDimension::ProductWorkflow));
        answers_useful.record(run.verdict(VerdictDimension::AnswersUseful));
        deadline_exceeded.record(run.deadline_exceeded);
        cancelled.record(run.cancelled);
        if matches!(run.cleanup, super::schema::CleanupStatus::Failed) {
            cleanup_failed_runs += 1;
        }
        for category in &run.failure_categories {
            if !failure_categories.iter().any(|c| c == &category.code) {
                failure_categories.push(category.code.clone());
            }
        }
        if let Some(ms) = run.elapsed_ms.known() {
            elapsed_known.push(ms);
        }
        for caveat in &run.caveats {
            if !caveats.iter().any(|c| c.code == caveat.code) {
                caveats.push(caveat.clone());
            }
        }
    }
    failure_categories.sort();
    caveats.sort_by(|a, b| a.code.cmp(&b.code));

    let request_count = MetricU64::sum_all(runs.iter().map(|r| r.request_count));
    let tokens = TokenUsage {
        input: MetricU64::sum_all(runs.iter().map(|r| r.tokens.input)),
        output: MetricU64::sum_all(runs.iter().map(|r| r.tokens.output)),
        reasoning: MetricU64::sum_all(runs.iter().map(|r| r.tokens.reasoning)),
        cached: MetricU64::sum_all(runs.iter().map(|r| r.tokens.cached)),
        total: MetricU64::sum_all(runs.iter().map(|r| r.tokens.total)),
    };
    let reported_cost = MetricF64::sum_all(runs.iter().map(|r| r.reported_cost));
    let median_elapsed_ms = median_u64(&mut elapsed_known);

    // Aggregate honesty caveats — never emit verified/readiness language.
    caveats.push(ComparisonCaveat {
        code: "aggregate_not_readiness".into(),
        detail: "aggregates compare share-safe diagnostic evidence only; they never certify model readiness".into(),
    });
    if matches!(reported_cost, MetricF64::Unknown)
        || matches!(tokens.total, MetricU64::Unknown) && matches!(tokens.input, MetricU64::Unknown)
    {
        caveats.push(ComparisonCaveat {
            code: "cost_or_tokens_unknown".into(),
            detail: "at least one run omitted cost or token usage; aggregate cost/token fields stay unknown rather than zero-filled".into(),
        });
    }

    LedgerAggregateSummary {
        schema_id: AGGREGATE_SCHEMA_ID.to_string(),
        schema_version: AGGREGATE_SCHEMA_VERSION,
        group_key,
        display_label,
        source_kind,
        run_count: runs.len() as u64,
        request_count,
        tokens,
        reported_cost,
        median_elapsed_ms,
        gateway_model,
        product_workflow,
        answers_useful,
        deadline_exceeded,
        cancelled,
        cleanup_failed_runs,
        failure_categories,
        caveats,
    }
}

fn median_u64(values: &mut [u64]) -> MetricU64 {
    if values.is_empty() {
        return MetricU64::Unknown;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        MetricU64::Known(values[mid])
    } else {
        // Even count: mean of the two central values, truncated to u64.
        let a = values[mid - 1];
        let b = values[mid];
        MetricU64::Known(a.saturating_add(b) / 2)
    }
}
