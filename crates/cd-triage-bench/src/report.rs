//! Honest comparison reports. No readiness badges, no force-ranking.

use crate::canonical::{to_canonical_json, to_pretty_json};
use crate::error::{BenchError, BenchResult};
use crate::privacy::gate_share_safe_text;
use crate::types::{
    Adjudication, Case, DimensionVerdict, FairnessClass, Observed, PrivacyClass, RubricDimension,
    RunStatus, ScoreReview, SourceKind, StrategyIdentity, TriageRun, REPORT_SCHEMA_V1, RUBRIC_V1,
};

pub use crate::review::{blinded_run_view, BlindedRunView};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BacktestReport {
    pub schema_id: String,
    pub privacy: PrivacyClass,
    pub rubric_version: String,
    pub generated_from: ReportIdentities,
    pub counts: ReportCounts,
    pub cases: Vec<CaseBrief>,
    pub groups: Vec<ComparisonGroup>,
    pub incomparable: Vec<IncomparablePair>,
    pub version_pairs: Vec<VersionPair>,
    pub notes: Vec<String>,
}

/// Small-n honesty: counts sit beside per-case groups. Not an aggregate score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportCounts {
    pub cases: u64,
    pub groups: u64,
    pub runs: u64,
    pub scored: u64,
    pub unscored: u64,
    pub failed: u64,
    pub partial: u64,
    pub unscorable: u64,
    pub incomparable_pairs: u64,
    pub version_pairs: u64,
    pub adjudications: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseBrief {
    pub case_id: String,
    pub lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportIdentities {
    pub case_ids: Vec<String>,
    pub task_ids: Vec<String>,
    pub snapshot_ids: Vec<String>,
    pub run_ids: Vec<String>,
    pub adjudication_ids: Vec<String>,
    pub score_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComparisonGroup {
    pub task_id: String,
    pub snapshot_id: String,
    pub case_id: String,
    pub runs: Vec<RunSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunSummary {
    pub run_id: String,
    pub strategy_name: String,
    pub strategy_version: Observed<String>,
    pub source_kind: SourceKind,
    pub status: RunStatus,
    pub fairness: String,
    pub comparison_eligible: bool,
    pub scored: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    pub scores: Vec<ReportedDimension>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportedDimension {
    pub dimension: RubricDimension,
    pub verdicts: Vec<ReviewerVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewerVerdict {
    pub adjudication_id: String,
    pub reviewer: String,
    pub verdict: DimensionVerdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomparablePair {
    pub left_run_id: String,
    pub right_run_id: String,
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionPair {
    pub strategy_name: String,
    pub older_version: String,
    pub newer_version: String,
    pub older_run_id: String,
    pub newer_run_id: String,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub older_adjudication_ids: Vec<String>,
    pub newer_adjudication_ids: Vec<String>,
    pub dimensions: Vec<VersionDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionDelta {
    pub dimension: RubricDimension,
    pub change: String,
}

pub fn build_report(
    runs: &[TriageRun],
    adjudications: &[Adjudication],
    scores: &[ScoreReview],
    cases: &[Case],
    privacy: PrivacyClass,
) -> BenchResult<BacktestReport> {
    let mut runs: Vec<TriageRun> = runs.to_vec();
    runs.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    let mut adjudications: Vec<Adjudication> = adjudications.to_vec();
    adjudications.sort_by(|a, b| a.adjudication_id.cmp(&b.adjudication_id));
    let mut scores: Vec<ScoreReview> = scores.to_vec();
    scores.sort_by(|a, b| a.score_id.cmp(&b.score_id));

    let mut cases: Vec<Case> = cases.to_vec();
    cases.sort_by(|a, b| a.case_id.cmp(&b.case_id));
    if privacy == PrivacyClass::ShareSafe {
        runs.retain(|r| r.privacy == PrivacyClass::ShareSafe);
        adjudications.retain(|a| a.privacy == PrivacyClass::ShareSafe);
        scores.retain(|s| s.privacy == PrivacyClass::ShareSafe);
        cases.retain(|c| c.privacy == PrivacyClass::ShareSafe);
    }

    let mut groups_map: BTreeMap<(String, String, String), Vec<TriageRun>> = BTreeMap::new();
    for run in &runs {
        groups_map
            .entry((
                run.task_id.clone(),
                run.snapshot_id.clone(),
                run.case_id.clone(),
            ))
            .or_default()
            .push(run.clone());
    }

    let mut groups = Vec::new();
    let mut incomparable = Vec::new();
    for ((task_id, snapshot_id, case_id), group_runs) in &groups_map {
        let mut summaries = Vec::new();
        for run in group_runs {
            let eligible = matches!(run.fairness, FairnessClass::SameSnapshot);
            if !eligible {
                // Still listed; not force-ranked.
            }
            summaries.push(run_summary(run, &adjudications, privacy));
        }
        summaries.sort_by(|a, b| a.run_id.cmp(&b.run_id));
        for pair in fairness_incomparable(group_runs) {
            incomparable.push(pair);
        }
        groups.push(ComparisonGroup {
            task_id: task_id.clone(),
            snapshot_id: snapshot_id.clone(),
            case_id: case_id.clone(),
            runs: summaries,
        });
    }

    // Same case, different snapshot/task → incomparable.
    let run_list: Vec<&TriageRun> = runs.iter().collect();
    for i in 0..run_list.len() {
        for j in (i + 1)..run_list.len() {
            let left = run_list[i];
            let right = run_list[j];
            if left.case_id == right.case_id
                && (left.task_id != right.task_id || left.snapshot_id != right.snapshot_id)
            {
                incomparable.push(IncomparablePair {
                    left_run_id: left.run_id.clone(),
                    right_run_id: right.run_id.clone(),
                    reason: "snapshot_or_task_mismatch".into(),
                    detail: format!(
                        "left task={} snapshot={}; right task={} snapshot={}",
                        left.task_id, left.snapshot_id, right.task_id, right.snapshot_id
                    ),
                });
            }
        }
    }
    incomparable.sort_by(|a, b| {
        (&a.left_run_id, &a.right_run_id, &a.reason).cmp(&(
            &b.left_run_id,
            &b.right_run_id,
            &b.reason,
        ))
    });
    incomparable.dedup();

    let version_pairs = version_pairs(&runs, &adjudications);
    let case_briefs = case_briefs(&cases, privacy);
    let identities = ReportIdentities {
        case_ids: unique(
            runs.iter()
                .map(|r| r.case_id.clone())
                .chain(cases.iter().map(|c| c.case_id.clone())),
        ),
        task_ids: unique(runs.iter().map(|r| r.task_id.clone())),
        snapshot_ids: unique(runs.iter().map(|r| r.snapshot_id.clone())),
        run_ids: unique(runs.iter().map(|r| r.run_id.clone())),
        adjudication_ids: unique(adjudications.iter().map(|a| a.adjudication_id.clone())),
        score_ids: unique(scores.iter().map(|s| s.score_id.clone())),
    };
    let counts = report_counts(
        &groups,
        &case_briefs,
        &incomparable,
        &version_pairs,
        adjudications.len(),
    );

    let notes = vec![
        "Comparisons are valid only for the same evaluation task and evidence snapshot.".into(),
        "Unscored, failed, and partial runs are listed; they are not treated as zero.".into(),
        "This report does not assign readiness, qualification, or routing badges.".into(),
        "Disagreement is preserved per reviewer; scores are never silently averaged.".into(),
        "This report is a projection over stored records. It does not execute strategies or create judgments.".into(),
        "SDK batch execution is out of scope until the public-SDK adapter (#879) exists.".into(),
    ];

    let report = BacktestReport {
        schema_id: REPORT_SCHEMA_V1.into(),
        privacy,
        rubric_version: RUBRIC_V1.into(),
        generated_from: identities,
        counts,
        cases: case_briefs,
        groups,
        incomparable,
        version_pairs,
        notes,
    };
    if privacy == PrivacyClass::ShareSafe {
        let json = to_canonical_json(&report)?;
        gate_share_safe_text(&json)?;
    }
    Ok(report)
}

pub fn render_report_json(report: &BacktestReport) -> BenchResult<String> {
    let text = to_pretty_json(report)?;
    if report.privacy == PrivacyClass::ShareSafe {
        gate_share_safe_text(&text)?;
    }
    Ok(text)
}

pub fn render_report_markdown(report: &BacktestReport) -> BenchResult<String> {
    let mut out = String::new();
    out.push_str("# Triage bench comparison report\n\n");
    out.push_str(&format!("Schema: `{}`\n\n", report.schema_id));
    out.push_str(&format!("Privacy: `{}`\n\n", report.privacy.as_str()));
    out.push_str(&format!("Rubric: `{}`\n\n", report.rubric_version));
    out.push_str("## Counts\n\n");
    out.push_str(&format!(
        "- cases: {}\n- groups: {}\n- runs: {} (scored {}, unscored {}, failed {}, partial {}, unscorable {})\n- incomparable pairs: {}\n- version pairs: {}\n- adjudications: {}\n\n",
        report.counts.cases,
        report.counts.groups,
        report.counts.runs,
        report.counts.scored,
        report.counts.unscored,
        report.counts.failed,
        report.counts.partial,
        report.counts.unscorable,
        report.counts.incomparable_pairs,
        report.counts.version_pairs,
        report.counts.adjudications
    ));
    if !report.cases.is_empty() {
        out.push_str("## Cases\n\n");
        for case in &report.cases {
            match &case.title {
                Some(title) => out.push_str(&format!(
                    "- `{}` ({}) — {title}\n",
                    case.case_id, case.lifecycle
                )),
                None => out.push_str(&format!("- `{}` ({})\n", case.case_id, case.lifecycle)),
            }
        }
        out.push('\n');
    }
    out.push_str("## Honesty notes\n\n");
    for note in &report.notes {
        out.push_str(&format!("- {note}\n"));
    }
    out.push_str("\n## Groups (same task + snapshot)\n\n");
    for group in &report.groups {
        out.push_str(&format!(
            "### task `{}` snapshot `{}`\n\n",
            group.task_id, group.snapshot_id
        ));
        out.push_str("| run | strategy | version | source | status | fairness | scored |\n");
        out.push_str("| --- | --- | --- | --- | --- | --- | --- |\n");
        for run in &group.runs {
            let version = match &run.strategy_version {
                Observed::Unknown => "unknown".to_string(),
                Observed::Known(v) => v.clone(),
            };
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} |\n",
                run.run_id,
                run.strategy_name,
                version,
                run.source_kind.as_str(),
                run.status.as_str(),
                run.fairness,
                if run.scored { "yes" } else { "unscored" }
            ));
        }
        out.push('\n');
    }
    if !report.incomparable.is_empty() {
        out.push_str("## Incomparable pairs\n\n");
        for pair in &report.incomparable {
            out.push_str(&format!(
                "- `{}` vs `{}`: {} — {}\n",
                pair.left_run_id, pair.right_run_id, pair.reason, pair.detail
            ));
        }
        out.push('\n');
    }
    if !report.version_pairs.is_empty() {
        out.push_str("## Strategy version pairs\n\n");
        for pair in &report.version_pairs {
            out.push_str(&format!(
                "- {} `{}` → `{}` (case `{}`, task `{}`)\n",
                pair.strategy_name,
                pair.older_version,
                pair.newer_version,
                pair.case_id,
                pair.task_id
            ));
            out.push_str(&format!(
                "  - drill-down: older run `{}` adjudications {}; newer run `{}` adjudications {}\n",
                pair.older_run_id,
                pair.older_adjudication_ids.join(", "),
                pair.newer_run_id,
                pair.newer_adjudication_ids.join(", ")
            ));
            for dim in &pair.dimensions {
                out.push_str(&format!("  - {}: {}\n", dim.dimension.as_str(), dim.change));
            }
        }
        out.push('\n');
    }
    if report.privacy == PrivacyClass::ShareSafe {
        gate_share_safe_text(&out)?;
    }
    Ok(out)
}

pub fn render_report_jsonl(report: &BacktestReport) -> BenchResult<String> {
    let mut lines = Vec::new();
    lines.push(to_canonical_json(&JsonlLine::Meta {
        schema_id: &report.schema_id,
        privacy: report.privacy,
        rubric_version: &report.rubric_version,
        generated_from: &report.generated_from,
        counts: &report.counts,
        notes: &report.notes,
    })?);
    for case in &report.cases {
        lines.push(to_canonical_json(&JsonlLine::Case { case })?);
    }
    for group in &report.groups {
        lines.push(to_canonical_json(&JsonlLine::Group { group })?);
    }
    for pair in &report.incomparable {
        lines.push(to_canonical_json(&JsonlLine::Incomparable { pair })?);
    }
    for pair in &report.version_pairs {
        lines.push(to_canonical_json(&JsonlLine::VersionPair { pair })?);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    if report.privacy == PrivacyClass::ShareSafe {
        gate_share_safe_text(&text)?;
    }
    Ok(text)
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum JsonlLine<'a> {
    Meta {
        schema_id: &'a str,
        privacy: PrivacyClass,
        rubric_version: &'a str,
        generated_from: &'a ReportIdentities,
        counts: &'a ReportCounts,
        notes: &'a [String],
    },
    Case {
        case: &'a CaseBrief,
    },
    Group {
        group: &'a ComparisonGroup,
    },
    Incomparable {
        pair: &'a IncomparablePair,
    },
    VersionPair {
        pair: &'a VersionPair,
    },
}

fn case_briefs(cases: &[Case], privacy: PrivacyClass) -> Vec<CaseBrief> {
    cases
        .iter()
        .map(|case| CaseBrief {
            case_id: case.case_id.clone(),
            lifecycle: case.lifecycle.as_str().to_string(),
            title: (privacy == PrivacyClass::OwnerOnly).then(|| case.title.clone()),
        })
        .collect()
}

fn report_counts(
    groups: &[ComparisonGroup],
    cases: &[CaseBrief],
    incomparable: &[IncomparablePair],
    version_pairs: &[VersionPair],
    adjudications: usize,
) -> ReportCounts {
    let runs: Vec<&RunSummary> = groups.iter().flat_map(|g| g.runs.iter()).collect();
    ReportCounts {
        cases: cases.len() as u64,
        groups: groups.len() as u64,
        runs: runs.len() as u64,
        scored: runs.iter().filter(|r| r.scored).count() as u64,
        unscored: runs.iter().filter(|r| !r.scored).count() as u64,
        failed: runs
            .iter()
            .filter(|r| r.status == RunStatus::Failed)
            .count() as u64,
        partial: runs
            .iter()
            .filter(|r| r.status == RunStatus::Partial)
            .count() as u64,
        unscorable: runs
            .iter()
            .filter(|r| r.status == RunStatus::Unscorable)
            .count() as u64,
        incomparable_pairs: incomparable.len() as u64,
        version_pairs: version_pairs.len() as u64,
        adjudications: adjudications as u64,
    }
}

fn unique(iter: impl Iterator<Item = String>) -> Vec<String> {
    let set: BTreeSet<String> = iter.collect();
    set.into_iter().collect()
}

fn run_summary(
    run: &TriageRun,
    adjudications: &[Adjudication],
    privacy: PrivacyClass,
) -> RunSummary {
    let related: Vec<&Adjudication> = adjudications
        .iter()
        .filter(|a| a.run_id == run.run_id)
        .collect();
    let mut scores = Vec::new();
    for dimension in RubricDimension::all() {
        let mut verdicts = Vec::new();
        for adj in &related {
            if let Some(outcome) = adj.outcome(dimension) {
                verdicts.push(ReviewerVerdict {
                    adjudication_id: adj.adjudication_id.clone(),
                    reviewer: adj.reviewer.clone(),
                    verdict: outcome.verdict.clone(),
                    rationale: (privacy == PrivacyClass::OwnerOnly)
                        .then(|| outcome.rationale.clone()),
                });
            }
        }
        verdicts.sort_by(|a, b| a.adjudication_id.cmp(&b.adjudication_id));
        scores.push(ReportedDimension {
            dimension,
            verdicts,
        });
    }
    RunSummary {
        run_id: run.run_id.clone(),
        strategy_name: run.strategy.name.clone(),
        strategy_version: run.strategy.version.clone(),
        source_kind: run.source_kind,
        status: run.status,
        fairness: run.fairness.as_str().to_string(),
        comparison_eligible: matches!(run.fairness, FairnessClass::SameSnapshot),
        scored: related.iter().any(|a| {
            a.outcomes
                .iter()
                .any(|o| matches!(o.verdict, DimensionVerdict::Score { .. }))
        }),
        operator: (privacy == PrivacyClass::OwnerOnly).then(|| run.operator.clone()),
        scores,
    }
}

fn fairness_incomparable(runs: &[TriageRun]) -> Vec<IncomparablePair> {
    let mut pairs = Vec::new();
    for i in 0..runs.len() {
        for j in (i + 1)..runs.len() {
            if runs[i].fairness.as_str() != runs[j].fairness.as_str() {
                pairs.push(IncomparablePair {
                    left_run_id: runs[i].run_id.clone(),
                    right_run_id: runs[j].run_id.clone(),
                    reason: "fairness_class_mismatch".into(),
                    detail: format!(
                        "{} vs {}",
                        runs[i].fairness.as_str(),
                        runs[j].fairness.as_str()
                    ),
                });
            }
        }
    }
    pairs
}

fn version_pairs(runs: &[TriageRun], adjudications: &[Adjudication]) -> Vec<VersionPair> {
    let mut by_key: BTreeMap<(String, String, String), Vec<&TriageRun>> = BTreeMap::new();
    for run in runs {
        if let Observed::Known(_) = &run.strategy.version {
            by_key
                .entry((
                    run.strategy.name.clone(),
                    run.task_id.clone(),
                    run.snapshot_id.clone(),
                ))
                .or_default()
                .push(run);
        }
    }
    let mut pairs = Vec::new();
    for ((name, task_id, snapshot_id), group) in by_key {
        let mut group = group;
        group.sort_by_key(|a| version_of(&a.strategy));
        for window in group.windows(2) {
            let older = window[0];
            let newer = window[1];
            let older_v = version_of(&older.strategy);
            let newer_v = version_of(&newer.strategy);
            if older_v == newer_v {
                continue;
            }
            let mut dimensions = Vec::new();
            for dimension in RubricDimension::all() {
                let left = numeric_score(older, dimension, adjudications);
                let right = numeric_score(newer, dimension, adjudications);
                let change = match (left, right) {
                    (Some(a), Some(b)) if b > a => "improved".to_string(),
                    (Some(a), Some(b)) if b < a => "regressed".to_string(),
                    (Some(a), Some(b)) if a == b => "unchanged".to_string(),
                    _ => "incomparable".to_string(),
                };
                dimensions.push(VersionDelta { dimension, change });
            }
            pairs.push(VersionPair {
                strategy_name: name.clone(),
                older_version: older_v,
                newer_version: newer_v,
                older_run_id: older.run_id.clone(),
                newer_run_id: newer.run_id.clone(),
                case_id: older.case_id.clone(),
                task_id: task_id.clone(),
                snapshot_id: snapshot_id.clone(),
                older_adjudication_ids: adjudication_ids(older, adjudications),
                newer_adjudication_ids: adjudication_ids(newer, adjudications),
                dimensions,
            });
        }
    }
    pairs.sort_by(|a, b| {
        (
            &a.strategy_name,
            &a.task_id,
            &a.older_version,
            &a.newer_version,
        )
            .cmp(&(
                &b.strategy_name,
                &b.task_id,
                &b.older_version,
                &b.newer_version,
            ))
    });
    pairs
}

fn adjudication_ids(run: &TriageRun, adjudications: &[Adjudication]) -> Vec<String> {
    unique(
        adjudications
            .iter()
            .filter(|a| a.run_id == run.run_id)
            .map(|a| a.adjudication_id.clone()),
    )
}

fn version_of(strategy: &StrategyIdentity) -> String {
    match &strategy.version {
        Observed::Known(v) => v.clone(),
        Observed::Unknown => "unknown".into(),
    }
}

fn numeric_score(
    run: &TriageRun,
    dimension: RubricDimension,
    adjudications: &[Adjudication],
) -> Option<u8> {
    let mut values = Vec::new();
    for adj in adjudications.iter().filter(|a| a.run_id == run.run_id) {
        if let Some(outcome) = adj.outcome(dimension) {
            if let DimensionVerdict::Score { value } = outcome.verdict {
                values.push(value);
            }
        }
    }
    if values.len() == 1 {
        values.first().copied()
    } else {
        // Disagreement is not averaged into a version delta.
        None
    }
}

/// Reject an attempt to fold two runs from different snapshots into one ranking.
pub fn reject_cross_snapshot_rank(left: &TriageRun, right: &TriageRun) -> BenchResult<()> {
    if left.task_id == right.task_id && left.snapshot_id == right.snapshot_id {
        Ok(())
    } else {
        Err(BenchError::CrossSnapshot(format!(
            "cannot rank {} against {} (task/snapshot differ)",
            left.run_id, right.run_id
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_snapshot_rank_is_rejected() {
        // Minimal shells; only ids matter here.
        let left = dummy_run("run-a", "task-1", "snap-1");
        let right = dummy_run("run-b", "task-1", "snap-2");
        assert!(reject_cross_snapshot_rank(&left, &right).is_err());
        assert!(reject_cross_snapshot_rank(&left, &left).is_ok());
    }

    fn dummy_run(run_id: &str, task_id: &str, snapshot_id: &str) -> TriageRun {
        TriageRun {
            schema_id: crate::types::RUN_SCHEMA_V1.into(),
            run_id: run_id.into(),
            privacy: PrivacyClass::OwnerOnly,
            case_id: "case-1".into(),
            task_id: task_id.into(),
            snapshot_id: snapshot_id.into(),
            strategy: StrategyIdentity {
                name: "x".into(),
                version: Observed::Unknown,
                build: Observed::Unknown,
            },
            source_kind: SourceKind::Human,
            prompt_workflow: crate::types::PromptWorkflow {
                completeness: crate::types::Completeness::Unknown,
                prompt: Observed::Unknown,
                workflow: Observed::Unknown,
            },
            raw_output: crate::types::RawOutput {
                digest: crate::types::ContentDigest::of_bytes(b"x"),
                byte_length: 1,
                encoding: "utf-8".into(),
            },
            claims: vec![],
            timing: Observed::Unknown,
            cost: Observed::Unknown,
            uncertainty: Observed::Unknown,
            fairness: FairnessClass::SameSnapshot,
            status: RunStatus::Completed,
            operator: "op".into(),
            importer: None,
            created_at: "2026-01-15T00:00:00Z".into(),
            near_duplicate_of: None,
        }
    }
}
