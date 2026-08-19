//! Honest comparison reports. No readiness badges, no force-ranking.

use crate::canonical::{to_canonical_json, to_pretty_json};
use crate::error::{BenchError, BenchResult};
use crate::gold::{
    align_run, latest_gold_for, GoldAlignment, GoldReference, GOLD_ALIGNMENT_NOT_CORRECTNESS,
    GOLD_IS_HUMAN_BENCHMARK,
};
use crate::privacy::gate_share_safe_text;
use crate::types::{
    Adjudication, Case, DimensionVerdict, FairnessClass, Observed, PrivacyClass, ReviewPhase,
    RubricDimension, RunStatus, ScoreReview, SourceKind, StrategyIdentity, TriageRun,
    REPORT_SCHEMA_V2,
};

pub use crate::review::{blinded_run_view, BlindedRunView};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

type VersionPairKey = (String, SourceKind, Observed<String>, String, String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BacktestReport {
    pub schema_id: String,
    pub privacy: PrivacyClass,
    pub rubric_versions: Vec<String>,
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
    pub partial_scored_runs: u64,
    pub withheld_scored_runs: u64,
    pub withheld_adjudications: u64,
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
    /// Present only when a gold reference matches this task and snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gold: Option<GroupGold>,
}

/// Scenario-level gold provenance. Alignment stays per-run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupGold {
    pub gold_id: String,
    pub version: u64,
    pub package_id: String,
    pub accepted_decision_id: String,
    pub accepted_decision_revision: u64,
    pub evidence_anchors: Vec<String>,
    pub human_acceptance: HumanAcceptance,
    pub notes: Vec<String>,
}

/// Human acceptance of the decision that produced the gold reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanAcceptance {
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunSummary {
    pub run_id: String,
    pub strategy_name: String,
    pub strategy_version: Observed<String>,
    /// Exact provider-profile/model identities in an owner-only report.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_identities: Vec<String>,
    /// Stable model fingerprints in a share-safe report.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_fingerprints: Vec<String>,
    pub source_kind: SourceKind,
    pub status: RunStatus,
    pub fairness: String,
    pub comparison_eligible: bool,
    pub score_visibility: ScoreVisibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    pub scores: Vec<ReportedDimension>,
    /// Independent of helpfulness/`scores`. Omitted when no gold exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gold_alignment: Option<GoldAlignment>,
}

/// Distinguishes “nobody scored this” from “a score exists but is redacted.”
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreVisibility {
    Scored,
    Partial,
    Unscored,
    Withheld,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    pub rubric_version: String,
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
    pub source_kind: SourceKind,
    pub strategy_build: Observed<String>,
    pub older_version: String,
    pub newer_version: String,
    pub older_run_id: String,
    pub newer_run_id: String,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub rubric_version: String,
    pub older_status: RunStatus,
    pub newer_status: RunStatus,
    pub older_fairness: String,
    pub newer_fairness: String,
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

/// Model attribution recovered from a validated owner-only run envelope.
///
/// Exact identities are emitted only in owner-only reports. Share-safe
/// reports use the fingerprints instead, so comparison rows remain useful
/// without exposing provider/model identity.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunAttribution {
    pub model_identities: Vec<String>,
    pub model_fingerprints: Vec<String>,
}

pub fn build_report(
    runs: &[TriageRun],
    adjudications: &[Adjudication],
    scores: &[ScoreReview],
    cases: &[Case],
    privacy: PrivacyClass,
) -> BenchResult<BacktestReport> {
    build_report_with_attribution(
        runs,
        adjudications,
        scores,
        cases,
        &BTreeMap::new(),
        privacy,
    )
}

/// Build a report while retaining validated provider/model attribution for
/// live ContextDesk runs. Callers that only have [`TriageRun`] rows should use
/// [`build_report`], which preserves the historical source-neutral behavior.
pub fn build_report_with_attribution(
    runs: &[TriageRun],
    adjudications: &[Adjudication],
    scores: &[ScoreReview],
    cases: &[Case],
    attribution: &BTreeMap<String, RunAttribution>,
    privacy: PrivacyClass,
) -> BenchResult<BacktestReport> {
    build_report_with_gold(
        runs,
        adjudications,
        scores,
        cases,
        attribution,
        privacy,
        &[],
    )
}

/// Build a report, optionally aligning runs against versioned gold references.
///
/// Gold alignment is independent of helpfulness scores and never treats
/// agreement as correctness. When `golds` is empty the serialized report keeps
/// the historical v2 shape (no gold keys).
pub fn build_report_with_gold(
    runs: &[TriageRun],
    adjudications: &[Adjudication],
    scores: &[ScoreReview],
    cases: &[Case],
    attribution: &BTreeMap<String, RunAttribution>,
    privacy: PrivacyClass,
    golds: &[GoldReference],
) -> BenchResult<BacktestReport> {
    let mut runs: Vec<TriageRun> = runs.to_vec();
    runs.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    let mut all_adjudications: Vec<Adjudication> = adjudications.to_vec();
    all_adjudications.sort_by(|a, b| a.adjudication_id.cmp(&b.adjudication_id));
    let mut adjudications = all_adjudications.clone();
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
    let withheld_adjudications = all_adjudications
        .iter()
        .filter(|adj| {
            !adjudications
                .iter()
                .any(|visible| visible.adjudication_id == adj.adjudication_id)
        })
        .count() as u64;

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
    let mut gold_used = false;
    for ((task_id, snapshot_id, case_id), group_runs) in &groups_map {
        let gold = latest_gold_for(golds, task_id, snapshot_id);
        gold_used |= gold.is_some();
        let mut summaries = Vec::new();
        for run in group_runs {
            let eligible = matches!(run.fairness, FairnessClass::SameSnapshot);
            if !eligible {
                // Still listed; not force-ranked.
            }
            summaries.push(run_summary(
                run,
                &adjudications,
                &all_adjudications,
                attribution.get(&run.run_id),
                privacy,
                gold,
            ));
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
            gold: gold.map(group_gold),
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

    let version_pairs = version_pairs(&runs, &adjudications, &incomparable);
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
        withheld_adjudications,
    );

    let mut notes = vec![
        "Comparisons are valid only for the same evaluation task and evidence snapshot.".into(),
        "Unscored means no stored score exists. Withheld means a score exists but this privacy class cannot show it.".into(),
        "Failed and partial runs are listed; they are not treated as zero.".into(),
        "Version pairs skip incomparable fairness/snapshot pairs and refuse a non-completed baseline.".into(),
        "Scores are never pooled across rubric versions.".into(),
        "This report does not assign readiness, qualification, or routing badges.".into(),
        "Disagreement is preserved per reviewer; scores are never silently averaged.".into(),
        "This report is a projection over stored records. It does not execute strategies or create judgments.".into(),
        "Public-SDK mock, replay, and live same-snapshot runs join comparisons from the same stored run records as imported strategies; this report only projects persisted records and never executes a strategy.".into(),
    ];
    if gold_used {
        notes.push(GOLD_IS_HUMAN_BENCHMARK.into());
        notes.push(GOLD_ALIGNMENT_NOT_CORRECTNESS.into());
        notes.push("Helpfulness scores and gold alignment are independent observations.".into());
        notes.push("Human acceptance names the decision that produced the gold; it is not a model correctness claim.".into());
    }

    let report = BacktestReport {
        schema_id: REPORT_SCHEMA_V2.into(),
        privacy,
        rubric_versions: unique(adjudications.iter().map(|a| a.rubric_version.clone())),
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

/// Recover model attribution from the adapter's canonical owner-only envelope.
///
/// The report crate deliberately treats the envelope as an opaque JSON
/// boundary: malformed or unrelated raw output simply has no attribution.
/// Only bounded provider/model values that carry no markup are admitted into
/// a rendered report.
///
/// Attribution is recovered **only** from a record that is recognisably the
/// adapter's owner-only envelope (`sdk_run_id` plus a replay or exact model
/// slots). Arbitrary imported raw output that merely happens to contain a
/// `slots` array is not a proof of anything, so it yields no attribution
/// rather than an invented model identity.
pub fn extract_owner_model_attribution(raw_output: &[u8]) -> Option<RunAttribution> {
    let value: serde_json::Value = serde_json::from_slice(raw_output).ok()?;
    if !is_adapter_owner_only_envelope(&value) {
        return None;
    }
    let slots = value.get("slots")?.as_array()?;
    let mut identities = BTreeSet::new();
    for slot in slots {
        let Some(model) = slot.get("model").and_then(serde_json::Value::as_object) else {
            continue;
        };
        let Some(profile_id) = model.get("profile_id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(model_id) = model.get("model_id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if safe_report_identity(profile_id) && safe_report_identity(model_id) {
            identities.insert(format!("{profile_id}::{model_id}"));
        }
    }

    let fingerprints = value
        .get("fingerprints")
        .and_then(|fingerprints| fingerprints.get("models"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|fingerprint| safe_model_fingerprint(fingerprint))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();

    if identities.is_empty() && fingerprints.is_empty() {
        None
    } else {
        Some(RunAttribution {
            model_identities: identities.into_iter().collect(),
            model_fingerprints: fingerprints.into_iter().collect(),
        })
    }
}

/// Recognise the adapter's canonical owner-only run envelope.
///
/// This mirrors the blinding check in [`crate::review`]: a record that names
/// an SDK run and carries either the authoritative replay or exact model
/// slots is the adapter's own output, not a third-party import.
pub(crate) fn is_adapter_owner_only_envelope(value: &serde_json::Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let has_sdk_run_identity = record
        .get("sdk_run_id")
        .is_some_and(serde_json::Value::is_string);
    let carries_full_replay = record
        .get("replay")
        .is_some_and(serde_json::Value::is_object);
    let carries_exact_models = record
        .get("slots")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|slots| {
            slots
                .iter()
                .any(|slot| slot.get("model").is_some_and(serde_json::Value::is_object))
        });
    has_sdk_run_identity && (carries_full_replay || carries_exact_models)
}

/// Admit only bounded, markup-free identity text into a rendered report.
///
/// The renderer escapes every value it emits, so this is the second of two
/// independent defences: a value carrying table, code-span, or HTML syntax is
/// refused outright rather than rendered as escaped markup.
pub(crate) fn safe_report_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| !c.is_control() && !matches!(c, '|' | '`' | '<' | '>' | '&' | '"' | '\\'))
}

fn safe_model_fingerprint(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("mdf-") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Escape one dynamic value before it is placed in the markdown report.
///
/// The report is rendered as HTML in some surfaces and deliberately emits raw
/// `<br>` separators, so every value that came from a record must be escaped
/// here. Backticks and pipes become HTML entities too: a value can neither
/// close the code span it sits in nor split a table cell. Control characters
/// — including newlines — collapse to a space.
///
/// The tradeoff is deliberate: a value containing markup renders as visible
/// escaped text rather than as markup. Nothing is dropped or redacted, and a
/// well-formed identity is returned unchanged.
///
/// A backslash is deliberately **not** escaped. With `<`, `>`, backtick and
/// pipe already neutralised a backslash cannot reconstruct markup, and
/// rewriting it would hide the literal `c:\users` substring that
/// [`crate::privacy`] scans rendered share-safe text for.
pub(crate) fn escape_report_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '`' => out.push_str("&#96;"),
            '|' => out.push_str("&#124;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

pub fn render_report_markdown(report: &BacktestReport) -> BenchResult<String> {
    let esc = escape_report_value;
    let mut out = String::new();
    out.push_str("# Triage bench comparison report\n\n");
    out.push_str(&format!("Schema: `{}`\n\n", esc(&report.schema_id)));
    out.push_str(&format!("Privacy: `{}`\n\n", esc(report.privacy.as_str())));
    out.push_str(&format!(
        "Rubric versions: {}\n\n",
        if report.rubric_versions.is_empty() {
            "`none`".into()
        } else {
            report
                .rubric_versions
                .iter()
                .map(|v| format!("`{}`", esc(v)))
                .collect::<Vec<_>>()
                .join(", ")
        }
    ));
    out.push_str("## Counts\n\n");
    out.push_str(&format!(
        "- cases: {}\n- groups: {}\n- runs: {} (scored {}, partial-scored {}, unscored {}, withheld {}, failed {}, partial {}, unscorable {})\n- withheld adjudications: {}\n- incomparable pairs: {}\n- version pairs: {}\n- adjudications: {}\n\n",
        report.counts.cases,
        report.counts.groups,
        report.counts.runs,
        report.counts.scored,
        report.counts.partial_scored_runs,
        report.counts.unscored,
        report.counts.withheld_scored_runs,
        report.counts.failed,
        report.counts.partial,
        report.counts.unscorable,
        report.counts.withheld_adjudications,
        report.counts.incomparable_pairs,
        report.counts.version_pairs,
        report.counts.adjudications
    ));
    if !report.cases.is_empty() {
        out.push_str("## Cases\n\n");
        for case in &report.cases {
            match &case.title {
                Some(title) => out.push_str(&format!(
                    "- `{}` ({}) — {}\n",
                    esc(&case.case_id),
                    esc(&case.lifecycle),
                    esc(title)
                )),
                None => out.push_str(&format!(
                    "- `{}` ({})\n",
                    esc(&case.case_id),
                    esc(&case.lifecycle)
                )),
            }
        }
        out.push('\n');
    }
    out.push_str("## Honesty notes\n\n");
    for note in &report.notes {
        out.push_str(&format!("- {}\n", esc(note)));
    }
    out.push_str("\n## Groups (same task + snapshot)\n\n");
    for group in &report.groups {
        out.push_str(&format!(
            "### task `{}` snapshot `{}`\n\n",
            esc(&group.task_id),
            esc(&group.snapshot_id)
        ));
        out.push_str(
            "| run | strategy | model(s) | version | source | status | fairness | scored |\n",
        );
        out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for run in &group.runs {
            let version = match &run.strategy_version {
                Observed::Unknown => "unknown".to_string(),
                Observed::Known(v) => v.clone(),
            };
            let models = if !run.model_identities.is_empty() {
                run.model_identities
                    .iter()
                    .map(|model| format!("`{}`", esc(model)))
                    .collect::<Vec<_>>()
                    .join("<br>")
            } else if !run.model_fingerprints.is_empty() {
                run.model_fingerprints
                    .iter()
                    .map(|fingerprint| format!("`{}`", esc(fingerprint)))
                    .collect::<Vec<_>>()
                    .join("<br>")
            } else {
                "unknown".into()
            };
            out.push_str(&format!(
                "| `{}` | {} | {} | {} | {} | {} | {} | {} |\n",
                esc(&run.run_id),
                esc(&run.strategy_name),
                models,
                esc(&version),
                esc(run.source_kind.as_str()),
                esc(run.status.as_str()),
                esc(&run.fairness),
                esc(run.score_visibility.as_str())
            ));
        }
        out.push('\n');
        if let Some(gold) = &group.gold {
            out.push_str(&format!(
                "Gold reference `{}` v{} (human acceptance: {}; decision `{}`). Alignment is not a correctness verdict.\n\n",
                esc(&gold.gold_id),
                gold.version,
                esc(&gold.human_acceptance.status),
                esc(&gold.accepted_decision_id)
            ));
            out.push_str("| run | gold alignment | helpfulness |\n| --- | --- | --- |\n");
            for run in &group.runs {
                let alignment = run
                    .gold_alignment
                    .as_ref()
                    .map(|row| row.status.as_str())
                    .unwrap_or("unknown");
                out.push_str(&format!(
                    "| `{}` | {} | {} |\n",
                    esc(&run.run_id),
                    esc(alignment),
                    esc(run.score_visibility.as_str())
                ));
            }
            out.push('\n');
        }
    }
    if !report.incomparable.is_empty() {
        out.push_str("## Incomparable pairs\n\n");
        for pair in &report.incomparable {
            out.push_str(&format!(
                "- `{}` vs `{}`: {} — {}\n",
                esc(&pair.left_run_id),
                esc(&pair.right_run_id),
                esc(&pair.reason),
                esc(&pair.detail)
            ));
        }
        out.push('\n');
    }
    if !report.version_pairs.is_empty() {
        out.push_str("## Strategy version pairs\n\n");
        for pair in &report.version_pairs {
            out.push_str(&format!(
                "- {} source `{}` build `{}` `{}` → `{}` (case `{}`, task `{}`)\n",
                esc(&pair.strategy_name),
                esc(pair.source_kind.as_str()),
                esc(&format!("{:?}", pair.strategy_build)),
                esc(&pair.older_version),
                esc(&pair.newer_version),
                esc(&pair.case_id),
                esc(&pair.task_id)
            ));
            out.push_str(&format!(
                "  - drill-down: older run `{}` adjudications {}; newer run `{}` adjudications {}\n",
                esc(&pair.older_run_id),
                pair.older_adjudication_ids
                    .iter()
                    .map(|id| esc(id))
                    .collect::<Vec<_>>()
                    .join(", "),
                esc(&pair.newer_run_id),
                pair.newer_adjudication_ids
                    .iter()
                    .map(|id| esc(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            for dim in &pair.dimensions {
                out.push_str(&format!(
                    "  - {}: {}\n",
                    esc(dim.dimension.as_str()),
                    esc(&dim.change)
                ));
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
        rubric_versions: &report.rubric_versions,
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
        rubric_versions: &'a [String],
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

impl ScoreVisibility {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scored => "scored",
            Self::Partial => "partial",
            Self::Unscored => "unscored",
            Self::Withheld => "withheld",
        }
    }
}

fn report_counts(
    groups: &[ComparisonGroup],
    cases: &[CaseBrief],
    incomparable: &[IncomparablePair],
    version_pairs: &[VersionPair],
    adjudications: usize,
    withheld_adjudications: u64,
) -> ReportCounts {
    let runs: Vec<&RunSummary> = groups.iter().flat_map(|g| g.runs.iter()).collect();
    ReportCounts {
        cases: cases.len() as u64,
        groups: groups.len() as u64,
        runs: runs.len() as u64,
        scored: runs
            .iter()
            .filter(|r| r.score_visibility == ScoreVisibility::Scored)
            .count() as u64,
        partial_scored_runs: runs
            .iter()
            .filter(|r| r.score_visibility == ScoreVisibility::Partial)
            .count() as u64,
        unscored: runs
            .iter()
            .filter(|r| r.score_visibility == ScoreVisibility::Unscored)
            .count() as u64,
        withheld_scored_runs: runs
            .iter()
            .filter(|r| r.score_visibility == ScoreVisibility::Withheld)
            .count() as u64,
        withheld_adjudications,
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

fn group_gold(gold: &GoldReference) -> GroupGold {
    GroupGold {
        gold_id: gold.gold_id.clone(),
        version: gold.version,
        package_id: gold.package_id.clone(),
        accepted_decision_id: gold.accepted_decision_id.clone(),
        accepted_decision_revision: gold.accepted_decision_revision,
        evidence_anchors: gold.evidence_anchors.clone(),
        human_acceptance: HumanAcceptance {
            status: "accepted".into(),
        },
        notes: gold.notes.clone(),
    }
}

fn run_summary(
    run: &TriageRun,
    visible: &[Adjudication],
    all: &[Adjudication],
    attribution: Option<&RunAttribution>,
    privacy: PrivacyClass,
    gold: Option<&GoldReference>,
) -> RunSummary {
    let related: Vec<&Adjudication> = visible.iter().filter(|a| a.run_id == run.run_id).collect();
    let mut scores = Vec::new();
    for dimension in RubricDimension::all() {
        let mut verdicts = Vec::new();
        for adj in &related {
            if let Some(outcome) = adj.outcome(dimension) {
                verdicts.push(ReviewerVerdict {
                    adjudication_id: adj.adjudication_id.clone(),
                    reviewer: (privacy == PrivacyClass::OwnerOnly).then(|| adj.reviewer.clone()),
                    rubric_version: adj.rubric_version.clone(),
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
        model_identities: if privacy == PrivacyClass::OwnerOnly {
            attribution
                .map(|attribution| attribution.model_identities.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        model_fingerprints: if privacy == PrivacyClass::ShareSafe {
            attribution
                .map(|attribution| attribution.model_fingerprints.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        source_kind: run.source_kind,
        status: run.status,
        fairness: run.fairness.as_str().to_string(),
        comparison_eligible: matches!(run.fairness, FairnessClass::SameSnapshot),
        score_visibility: score_visibility(run, visible, all),
        operator: (privacy == PrivacyClass::OwnerOnly).then(|| run.operator.clone()),
        scores,
        gold_alignment: gold.map(|gold| align_run(run, Some(gold))),
    }
}

fn numeric_dimensions(adjudications: &[&Adjudication], run_id: &str) -> BTreeSet<RubricDimension> {
    adjudications
        .iter()
        .filter(|adj| adj.run_id == run_id)
        .flat_map(|adj| adj.outcomes.iter())
        .filter_map(|outcome| {
            matches!(outcome.verdict, DimensionVerdict::Score { .. }).then_some(outcome.dimension)
        })
        .collect()
}

fn score_visibility(
    run: &TriageRun,
    visible: &[Adjudication],
    all: &[Adjudication],
) -> ScoreVisibility {
    let world = numeric_dimensions(&all.iter().collect::<Vec<_>>(), &run.run_id);
    let shown = numeric_dimensions(&visible.iter().collect::<Vec<_>>(), &run.run_id);
    if shown.len() == RubricDimension::all().len() {
        ScoreVisibility::Scored
    } else if !shown.is_empty() {
        ScoreVisibility::Partial
    } else if !world.is_empty() {
        ScoreVisibility::Withheld
    } else {
        ScoreVisibility::Unscored
    }
}

fn fairness_incomparable(runs: &[TriageRun]) -> Vec<IncomparablePair> {
    let mut pairs = Vec::new();
    for i in 0..runs.len() {
        for j in (i + 1)..runs.len() {
            let Some((reason, detail)) =
                fairness_incomparable_reason(&runs[i].fairness, &runs[j].fairness)
            else {
                continue;
            };
            pairs.push(IncomparablePair {
                left_run_id: runs[i].run_id.clone(),
                right_run_id: runs[j].run_id.clone(),
                reason: reason.into(),
                detail,
            });
        }
    }
    pairs
}

fn fairness_incomparable_reason(
    left: &FairnessClass,
    right: &FairnessClass,
) -> Option<(&'static str, String)> {
    match (left, right) {
        (FairnessClass::SameSnapshot, FairnessClass::SameSnapshot) => None,
        (FairnessClass::UnknownVisibility, FairnessClass::UnknownVisibility) => Some((
            "unknown_visibility",
            "both runs have unknown evidence visibility".into(),
        )),
        (
            FairnessClass::ExtraEvidence { description: left },
            FairnessClass::ExtraEvidence { description: right },
        ) if left == right => Some((
            "extra_evidence",
            format!("both runs used declared extra evidence: {left}"),
        )),
        (
            FairnessClass::ExtraEvidence { description: left },
            FairnessClass::ExtraEvidence { description: right },
        ) => Some((
            "extra_evidence_description_mismatch",
            format!("left extra evidence={left}; right extra evidence={right}"),
        )),
        _ => Some((
            "fairness_class_mismatch",
            format!(
                "left fairness={}; right fairness={}",
                fairness_detail(left),
                fairness_detail(right)
            ),
        )),
    }
}

fn fairness_detail(fairness: &FairnessClass) -> String {
    match fairness {
        FairnessClass::SameSnapshot => "same_snapshot".into(),
        FairnessClass::UnknownVisibility => "unknown_visibility".into(),
        FairnessClass::ExtraEvidence { description } => {
            format!("extra_evidence({description})")
        }
    }
}

fn version_pairs(
    runs: &[TriageRun],
    adjudications: &[Adjudication],
    incomparable: &[IncomparablePair],
) -> Vec<VersionPair> {
    let incomparable_ids: BTreeSet<(String, String)> = incomparable
        .iter()
        .map(|p| ordered_run_ids(&p.left_run_id, &p.right_run_id))
        .collect();
    let mut by_key: BTreeMap<VersionPairKey, Vec<&TriageRun>> = BTreeMap::new();
    for run in runs {
        if let Observed::Known(_) = &run.strategy.version {
            by_key
                .entry((
                    run.strategy.name.clone(),
                    run.source_kind,
                    run.strategy.build.clone(),
                    run.task_id.clone(),
                    run.snapshot_id.clone(),
                ))
                .or_default()
                .push(run);
        }
    }
    let mut pairs = Vec::new();
    for ((name, source_kind, strategy_build, task_id, snapshot_id), group) in by_key {
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
            if !version_pair_eligible(older, newer, &incomparable_ids) {
                continue;
            }
            let older_rubrics = rubric_versions_for(older, adjudications);
            let newer_rubrics = rubric_versions_for(newer, adjudications);
            for rubric_version in older_rubrics.intersection(&newer_rubrics) {
                let mut dimensions = Vec::new();
                for dimension in RubricDimension::all() {
                    let left = numeric_score(older, dimension, adjudications, rubric_version);
                    let right = numeric_score(newer, dimension, adjudications, rubric_version);
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
                    source_kind,
                    strategy_build: strategy_build.clone(),
                    older_version: older_v.clone(),
                    newer_version: newer_v.clone(),
                    older_run_id: older.run_id.clone(),
                    newer_run_id: newer.run_id.clone(),
                    case_id: older.case_id.clone(),
                    task_id: task_id.clone(),
                    snapshot_id: snapshot_id.clone(),
                    rubric_version: rubric_version.clone(),
                    older_status: older.status,
                    newer_status: newer.status,
                    older_fairness: older.fairness.as_str().to_string(),
                    newer_fairness: newer.fairness.as_str().to_string(),
                    older_adjudication_ids: adjudication_ids(older, adjudications, rubric_version),
                    newer_adjudication_ids: adjudication_ids(newer, adjudications, rubric_version),
                    dimensions,
                });
            }
        }
    }
    pairs.sort_by(|a, b| {
        (
            &a.strategy_name,
            &a.source_kind,
            &a.strategy_build,
            &a.task_id,
            &a.rubric_version,
            &a.older_version,
            &a.newer_version,
        )
            .cmp(&(
                &b.strategy_name,
                &b.source_kind,
                &b.strategy_build,
                &b.task_id,
                &b.rubric_version,
                &b.older_version,
                &b.newer_version,
            ))
    });
    pairs
}

fn ordered_run_ids(left: &str, right: &str) -> (String, String) {
    if left <= right {
        (left.into(), right.into())
    } else {
        (right.into(), left.into())
    }
}

fn version_pair_eligible(
    older: &TriageRun,
    newer: &TriageRun,
    incomparable: &BTreeSet<(String, String)>,
) -> bool {
    if older.status != RunStatus::Completed || newer.status != RunStatus::Completed {
        return false;
    }
    if !matches!(older.fairness, FairnessClass::SameSnapshot)
        || !matches!(newer.fairness, FairnessClass::SameSnapshot)
    {
        return false;
    }
    !incomparable.contains(&ordered_run_ids(&older.run_id, &newer.run_id))
}

fn rubric_versions_for(run: &TriageRun, adjudications: &[Adjudication]) -> BTreeSet<String> {
    adjudications
        .iter()
        .filter(|a| a.run_id == run.run_id)
        .map(|a| a.rubric_version.clone())
        .collect()
}

fn adjudication_ids(
    run: &TriageRun,
    adjudications: &[Adjudication],
    rubric_version: &str,
) -> Vec<String> {
    unique(
        adjudications
            .iter()
            .filter(|a| a.run_id == run.run_id && a.rubric_version == rubric_version)
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
    rubric_version: &str,
) -> Option<u8> {
    let preferred_phase = match dimension {
        RubricDimension::DiagnosisCorrectness => ReviewPhase::Diagnosis,
        _ => ReviewPhase::Support,
    };
    let mut values = Vec::new();
    for adj in adjudications.iter().filter(|a| {
        a.run_id == run.run_id
            && a.rubric_version == rubric_version
            && a.phase == Some(preferred_phase)
    }) {
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

    #[test]
    fn share_safe_attribution_accepts_only_opaque_model_fingerprints() {
        let raw = serde_json::json!({
            "sdk_run_id": "cdrun-fixture",
            "replay": {},
            "slots": [],
            "fingerprints": {
                "models": [
                    "profile:provider::model:exact",
                    "mdf-not-a-digest",
                    format!("mdf-{}", "a".repeat(64))
                ]
            }
        });
        let attribution = extract_owner_model_attribution(raw.to_string().as_bytes())
            .expect("valid opaque fingerprint should be retained");
        assert_eq!(
            attribution.model_fingerprints,
            vec![format!("mdf-{}", "a".repeat(64))]
        );
        assert!(attribution.model_identities.is_empty());
    }

    #[test]
    fn attribution_is_refused_for_raw_output_that_is_not_an_adapter_envelope() {
        // An imported human/web/other-product artifact can be shaped like the
        // adapter envelope without being one. Without the SDK run identity it
        // proves nothing, so it must contribute no model attribution at all.
        let forged = serde_json::json!({
            "slots": [{"model": {"profile_id": "profile:forged", "model_id": "model:forged"}}],
            "fingerprints": {"models": [format!("mdf-{}", "b".repeat(64))]}
        });
        assert!(extract_owner_model_attribution(forged.to_string().as_bytes()).is_none());
    }

    #[test]
    fn attribution_refuses_identities_carrying_report_markup() {
        let hostile = serde_json::json!({
            "sdk_run_id": "cdrun-fixture",
            "slots": [
                {"model": {"profile_id": "profile:`<img src=x onerror=alert(1)>`",
                           "model_id": "model:ok"}},
                {"model": {"profile_id": "profile:clean", "model_id": "model:clean"}}
            ]
        });
        let attribution = extract_owner_model_attribution(hostile.to_string().as_bytes())
            .expect("the clean slot still yields attribution");
        assert_eq!(
            attribution.model_identities,
            vec!["profile:clean::model:clean".to_string()]
        );
    }

    #[test]
    fn report_values_cannot_break_out_of_a_code_span_or_table_cell() {
        let hostile = "a`b|c<script>d&e\ng";
        let escaped = escape_report_value(hostile);
        for forbidden in ['`', '|', '<', '>', '\n'] {
            assert!(
                !escaped.contains(forbidden),
                "{forbidden:?} survived escaping in {escaped}"
            );
        }
        assert!(escaped.contains("&#96;"));
        assert!(escaped.contains("&#124;"));
        assert!(escaped.contains("&lt;script&gt;"));
        assert_eq!(
            escape_report_value("profile:live::model:live"),
            "profile:live::model:live"
        );
    }

    #[test]
    fn escaping_does_not_hide_a_private_path_from_the_share_safe_scan() {
        // Escaping must never launder a value past the privacy gate. The
        // scanner looks for a literal `c:\users`, so the backslash survives.
        let escaped = escape_report_value("C:\\Users\\alex\\notes.md");
        assert!(escaped.contains("C:\\Users"), "{escaped}");
        assert!(crate::privacy::gate_share_safe_text(&escaped).is_err());
        assert!(
            crate::privacy::gate_share_safe_text(&escape_report_value("/home/alex/notes.md"))
                .is_err()
        );
        assert!(crate::privacy::gate_share_safe_text(&escape_report_value(
            "task-abcdef0123456789"
        ))
        .is_ok());
    }

    #[test]
    fn share_safe_rows_carry_fingerprints_and_never_exact_identities() {
        // The share-safe projection of a comparison row must stay useful:
        // the opaque model fingerprint survives so two rows can be told
        // apart, while the exact provider/model identity never appears.
        let fingerprint = format!("mdf-{}", "d".repeat(64));
        let mut run = dummy_run("run-share", "task-1", "snap-1");
        run.privacy = PrivacyClass::ShareSafe;
        run.source_kind = SourceKind::ContextdeskSdk;
        let attribution = BTreeMap::from([(
            run.run_id.clone(),
            RunAttribution {
                model_identities: vec!["profile:secret::model:secret".into()],
                model_fingerprints: vec![fingerprint.clone()],
            },
        )]);

        let share_safe = build_report_with_attribution(
            std::slice::from_ref(&run),
            &[],
            &[],
            &[],
            &attribution,
            PrivacyClass::ShareSafe,
        )
        .expect("share-safe report builds");
        let row = &share_safe.groups[0].runs[0];
        assert_eq!(row.model_fingerprints, vec![fingerprint.clone()]);
        assert!(row.model_identities.is_empty());
        let markdown = render_report_markdown(&share_safe).expect("share-safe markdown");
        assert!(markdown.contains(&fingerprint));
        assert!(!markdown.contains("profile:secret::model:secret"));
        let json = render_report_json(&share_safe).expect("share-safe json");
        assert!(!json.contains("profile:secret"));

        let owner_only = build_report_with_attribution(
            std::slice::from_ref(&run),
            &[],
            &[],
            &[],
            &attribution,
            PrivacyClass::OwnerOnly,
        )
        .expect("owner-only report builds");
        let row = &owner_only.groups[0].runs[0];
        assert_eq!(
            row.model_identities,
            vec!["profile:secret::model:secret".to_string()]
        );
        assert!(row.model_fingerprints.is_empty());
    }

    #[test]
    fn a_crafted_strategy_name_cannot_inject_markup_into_the_report() {
        let mut run = dummy_run("run-hostile", "task-1", "snap-1");
        run.strategy.name = "evil`|<img src=x onerror=alert(1)>".into();
        let report = build_report(
            std::slice::from_ref(&run),
            &[],
            &[],
            &[],
            PrivacyClass::OwnerOnly,
        )
        .expect("report builds");
        let markdown = render_report_markdown(&report).expect("markdown renders");
        assert!(!markdown.contains("<img"));
        assert!(!markdown.contains("evil`"));
        assert!(markdown.contains("&lt;img src=x onerror=alert(1)&gt;"));
        // The row must still be one table row: the crafted pipe cannot add a
        // column, so the header and the row keep the same cell count.
        let header = markdown
            .lines()
            .find(|line| line.starts_with("| run |"))
            .expect("table header");
        let row = markdown
            .lines()
            .find(|line| line.contains("run-hostile"))
            .expect("table row");
        assert_eq!(header.matches('|').count(), row.matches('|').count());
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
