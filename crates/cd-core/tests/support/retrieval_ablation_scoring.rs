//! Deterministic scorer, partition logic and report model for the
//! retrieval-ablation lab. No LLM judge exists anywhere in this pipeline and
//! nothing here can turn a deterministic failure green.

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The only k the benchmark contract runs at; recall/precision are reported
/// at the fixed prefixes below. Substituting a lower k is a violation.
pub const RA_K: u64 = 50;
pub const RA_K_PREFIXES: [u64; 3] = [10, 25, 50];

// ---------------------------------------------------------------------------
// Violations (false-green surface)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RaViolation {
    /// Stable machine code, e.g. "V_TIER_SUBSTITUTION".
    pub code: String,
    pub detail: String,
}

impl RaViolation {
    pub fn new(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: detail.into(),
        }
    }
}

pub const V_SCHEMA: &str = "V_SCHEMA";
pub const V_TIER_SUBSTITUTION: &str = "V_TIER_SUBSTITUTION";
pub const V_K_SUBSTITUTION: &str = "V_K_SUBSTITUTION";
pub const V_MODE_MISLABEL: &str = "V_MODE_MISLABEL";
pub const V_UNAVAILABLE_AS_PASS: &str = "V_UNAVAILABLE_AS_PASS";
pub const V_IDENTITY_OMITTED: &str = "V_IDENTITY_OMITTED";
pub const V_PROVENANCE_OMITTED: &str = "V_PROVENANCE_OMITTED";
pub const V_TELEMETRY_UNKNOWN: &str = "V_TELEMETRY_UNKNOWN";
pub const V_IMPORT_MISMATCH: &str = "V_IMPORT_MISMATCH";
pub const V_TOKEN_CENSUS: &str = "V_TOKEN_CENSUS";
pub const V_EXCLUSION_VIOLATED: &str = "V_EXCLUSION_VIOLATED";
pub const V_SECRET_IN_RETRIEVED: &str = "V_SECRET_IN_RETRIEVED";
pub const V_SECRET_IN_STORE: &str = "V_SECRET_IN_STORE";
pub const V_GEOMETRY: &str = "V_GEOMETRY";
pub const V_NON_PROGRESS_DIVERGENCE: &str = "V_NON_PROGRESS_DIVERGENCE";
pub const V_COMPLETENESS_OVERCLAIM: &str = "V_COMPLETENESS_OVERCLAIM";
pub const V_DUPLICATE_TRIALS: &str = "V_DUPLICATE_TRIALS";
pub const V_TRUTH_LEAK: &str = "V_TRUTH_LEAK";
pub const V_BASELINE_REGRESSION: &str = "V_BASELINE_REGRESSION";
pub const V_DEGENERATE_STRATEGY: &str = "V_DEGENERATE_STRATEGY";

// ---------------------------------------------------------------------------
// Observed corpus facts (gathered evaluator-side through production reads)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaObservedCorpus {
    pub events_imported: u64,
    pub files_imported: u64,
    pub sources: BTreeMap<String, u64>,
    /// Case-sensitive exact census per group token. `None` when the group is
    /// too large for exact paging; then `lower_bound` holds the engine count.
    pub token_census: BTreeMap<String, RaTokenCensus>,
    /// Secret values found in the durable event store (message text).
    pub secret_hits_in_store: Vec<String>,
    /// Whether every declared excluded file stayed out of the source catalog.
    pub exclusions_honored: bool,
    pub exclusion_detail: String,
    pub geometry: Option<RaObservedGeometry>,
    pub import_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaTokenCensus {
    pub exact: Option<u64>,
    pub lower_bound: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaObservedGeometry {
    pub raw_exception_records: u64,
    pub application_exception_records: u64,
    pub stderr_exception_records: u64,
    pub occurrence_count: u64,
    pub partial: bool,
}

/// Expected exception geometry derived from what the builder emitted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaExpectedGeometry {
    pub application_exception_records: u64,
    pub stderr_exception_records: u64,
    pub occurrences: u64,
}

// ---------------------------------------------------------------------------
// Per-query and per-case scores
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaQueryScore {
    pub query_id: String,
    pub kind: String,
    pub answerable: bool,
    pub relevant_groups: u64,
    pub recall_at: BTreeMap<u64, f64>,
    pub precision_at: BTreeMap<u64, f64>,
    pub mrr: f64,
    pub ndcg_at: BTreeMap<u64, f64>,
    pub decoy_share_at_25: f64,
    pub contaminating_hits_at_25: u64,
    pub context_chars_at_25: u64,
    pub evidence_omitted_at_50: Vec<String>,
    pub matched_total: Option<u64>,
    pub partial: bool,
    pub candidate_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaCaseModeScore {
    pub case_id: String,
    pub mode: RaMode,
    pub partition: RaPartition,
    pub unavailable_reason: Option<String>,
    pub violations: Vec<RaViolation>,
    pub mean_recall_at_25_answerable: f64,
    pub mean_mrr_answerable: f64,
    pub max_decoy_share_at_25: f64,
    pub rare_trigger_recall_at_25: Option<f64>,
    pub role_coverage_at_50: BTreeMap<String, bool>,
    pub false_grouping_contaminations_at_25: u64,
    pub context_chars_total: u64,
    pub evidence_omitted_total: u64,
    pub runtime_ms_total: Option<u64>,
    pub queries: Vec<RaQueryScore>,
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaReport {
    pub schema_id: String,
    pub schema_version: u32,
    pub suite_id: String,
    pub suite_version: u32,
    pub contextdesk_sha: String,
    pub generator_version: String,
    pub truth_schema_id: String,
    pub seed: u64,
    pub tier_requested: String,
    pub tier_actual_events: u64,
    pub tier_expected_events: u64,
    pub corpus_identity_sha256: String,
    pub corpus_bytes: u64,
    pub generation_ms: Option<u64>,
    pub modes: Vec<RaModeSummary>,
    pub cases: Vec<RaCaseReport>,
    pub partition_counts: BTreeMap<String, u64>,
    pub disclosures: RaDisclosures,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaModeSummary {
    pub mode: RaMode,
    /// "executed" | "unavailable"
    pub status: String,
    pub unavailable_reason: Option<String>,
    pub mean_recall_at_25: Option<f64>,
    pub mean_rare_trigger_recall_at_25: Option<f64>,
    pub mean_decoy_share_at_25: Option<f64>,
    pub context_chars_total: Option<u64>,
    pub embedding_calls: Option<u64>,
    pub rerank_calls: Option<u64>,
    pub provider_calls: Option<u64>,
    pub runtime_ms_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaCaseReport {
    pub case_id: String,
    pub title: String,
    pub intended_probe: String,
    pub events_expected: u64,
    pub events_imported: u64,
    /// "observed_only" | "complete" — reports never claim completeness the
    /// truth does not allow.
    pub coverage_claim: String,
    pub corpus_completeness_truth: String,
    pub conservation_violations: Vec<RaViolation>,
    pub modes: Vec<RaCaseModeScore>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaDisclosures {
    pub k: u64,
    pub k_prefixes: Vec<u64>,
    pub noise_multiplier: u64,
    pub scale_caps: BTreeMap<String, u64>,
    pub census_exact_cap: u64,
    pub ranking_semantics: String,
    pub notes: Vec<String>,
}

impl RaReport {
    /// Deterministic projection for golden comparison: wall-clock fields are
    /// nulled; everything else must be byte-stable for a fixed
    /// (sha, suite, seed, tier, mode-set).
    pub fn normalized_for_golden(&self) -> RaReport {
        let mut normalized = self.clone();
        normalized.generation_ms = None;
        // The committed baseline pins the SHA it was produced at; regenerated
        // comparisons normalise it so every commit does not churn the golden.
        normalized.contextdesk_sha = "NORMALIZED".into();
        for mode in &mut normalized.modes {
            mode.runtime_ms_total = None;
        }
        for case in &mut normalized.cases {
            for mode in &mut case.modes {
                mode.runtime_ms_total = None;
                for query in &mut mode.queries {
                    // matched_total / partial stay: they are engine facts.
                    let _ = query;
                }
            }
        }
        normalized
    }

    /// The compact comparison projection for demonstrations.
    pub fn to_projection_markdown(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "# Retrieval ablation — {} tier ({} events)\n\n",
            self.tier_requested, self.tier_actual_events
        ));
        out.push_str(&format!(
            "ContextDesk `{}` · suite v{} · generator `{}` · seed `{}` · corpus `{}`\n\n",
            self.contextdesk_sha,
            self.suite_version,
            self.generator_version,
            self.seed,
            &self.corpus_identity_sha256[..16.min(self.corpus_identity_sha256.len())]
        ));
        out.push_str("| Mode | Recall@25 | Rare trigger | Decoy rate | Runtime |\n");
        out.push_str("|------|-----------|--------------|------------|---------|\n");
        for mode in &self.modes {
            let label = match mode.mode {
                RaMode::StructuredKeyword => "Structured + keyword",
                RaMode::HybridEmbedding => "+ semantic embedding",
                RaMode::HybridEmbeddingReranked => "+ reranking",
                RaMode::FullMultistage => "+ bounded multi-stage analysis",
            };
            if mode.status == "unavailable" {
                out.push_str(&format!(
                    "| {label} | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | — |\n"
                ));
            } else {
                out.push_str(&format!(
                    "| {label} | {} | {} | {} | {} |\n",
                    mode.mean_recall_at_25
                        .map_or("—".into(), |v| format!("{v:.3}")),
                    mode.mean_rare_trigger_recall_at_25
                        .map_or("—".into(), |v| format!("{v:.3}")),
                    mode.mean_decoy_share_at_25
                        .map_or("—".into(), |v| format!("{v:.3}")),
                    mode.runtime_ms_total
                        .map_or("—".into(), |v| format!("{v} ms")),
                ));
            }
        }
        out.push_str("\n## Partition\n\n");
        for (label, count) in &self.partition_counts {
            out.push_str(&format!("- {label}: {count}\n"));
        }
        out.push_str("\n## Cases\n\n");
        out.push_str("| Case | Probe | structured_keyword | Notes |\n|------|-------|--------------------|-------|\n");
        for case in &self.cases {
            let baseline = case
                .modes
                .iter()
                .find(|m| m.mode == RaMode::StructuredKeyword);
            let (partition, note) = match baseline {
                Some(score) => (
                    score.partition.as_str().to_string(),
                    format!(
                        "recall@25 {:.3}, decoy {:.3}{}",
                        score.mean_recall_at_25_answerable,
                        score.max_decoy_share_at_25,
                        if score.violations.is_empty() {
                            String::new()
                        } else {
                            format!(
                                ", violations: {}",
                                score
                                    .violations
                                    .iter()
                                    .map(|v| v.code.as_str())
                                    .collect::<Vec<_>>()
                                    .join("+")
                            )
                        }
                    ),
                ),
                None => ("—".into(), String::new()),
            };
            out.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                case.case_id, case.intended_probe, partition, note
            ));
        }
        out.push('\n');
        out
    }
}

// ---------------------------------------------------------------------------
// Matching and metrics
// ---------------------------------------------------------------------------

/// A candidate matches a group when its source is one of the group's sources
/// and its content carries the group token (case-sensitive, exactly as
/// generated; the engine itself searched case-insensitively).
pub fn candidate_matches_group(candidate: &RaCandidate, group: &RaEvidenceGroup) -> bool {
    group.sources.iter().any(|s| s == &candidate.source) && candidate.content.contains(&group.token)
}

fn dcg(gains: &[u8]) -> f64 {
    gains
        .iter()
        .enumerate()
        .map(|(index, gain)| f64::from(*gain) / ((index as f64) + 2.0).log2())
        .sum()
}

/// Golden reports must be byte-stable across parse/serialize cycles and
/// across platform libm ulp differences (CI runs three OSes): every reported
/// metric is rounded to six decimals at construction.
fn r6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

/// Score one query run against truth. Group-level: retrieving any rendering
/// of a group retrieves the group; the group's rank is its best candidate
/// rank.
pub fn score_query(
    truth: &RaTruthManifest,
    query_truth: &RaQueryTruth,
    query: &RaQuery,
    run: &RaQueryRun,
) -> RaQueryScore {
    let groups_by_id: BTreeMap<&str, &RaEvidenceGroup> = truth
        .evidence_groups
        .iter()
        .map(|group| (group.group_id.as_str(), group))
        .collect();

    // First rank (1-based) at which each relevant group is retrieved.
    let mut first_rank: BTreeMap<&str, u64> = BTreeMap::new();
    for relevant in &query_truth.relevant {
        if let Some(group) = groups_by_id.get(relevant.group_id.as_str()) {
            for candidate in &run.candidates {
                if candidate_matches_group(candidate, group) {
                    first_rank.insert(relevant.group_id.as_str(), candidate.rank);
                    break;
                }
            }
        }
    }

    let relevant_total = query_truth.relevant.len() as u64;
    let mut recall_at = BTreeMap::new();
    let mut precision_at = BTreeMap::new();
    let mut ndcg_at = BTreeMap::new();
    for k in RA_K_PREFIXES {
        let retrieved = query_truth
            .relevant
            .iter()
            .filter(|relevant| {
                first_rank
                    .get(relevant.group_id.as_str())
                    .is_some_and(|r| *r <= k)
            })
            .count() as u64;
        let recall = if relevant_total == 0 {
            // Unanswerable / no-expected-evidence queries have no recall
            // denominator; report 1.0 so means are not polluted, and rely on
            // precision/contamination for these.
            1.0
        } else {
            retrieved as f64 / relevant_total as f64
        };
        recall_at.insert(k, r6(recall));

        // Precision: fraction of top-k candidates that match any relevant
        // group of this query.
        let considered: Vec<&RaCandidate> = run.candidates.iter().filter(|c| c.rank <= k).collect();
        let matching = considered
            .iter()
            .filter(|candidate| {
                query_truth.relevant.iter().any(|relevant| {
                    groups_by_id
                        .get(relevant.group_id.as_str())
                        .is_some_and(|group| candidate_matches_group(candidate, group))
                })
            })
            .count() as u64;
        let precision = if considered.is_empty() {
            0.0
        } else {
            matching as f64 / considered.len() as f64
        };
        precision_at.insert(k, r6(precision));

        // nDCG over graded gains in retrieved order. Each relevant group's
        // gain counts exactly once, at its FIRST matching candidate — later
        // renderings of an already-retrieved group contribute zero, so nDCG
        // stays in [0, 1].
        if relevant_total > 0 {
            let mut gains_in_order: Vec<u8> = Vec::new();
            let mut credited: BTreeSet<&str> = BTreeSet::new();
            for candidate in &run.candidates {
                if candidate.rank > k {
                    break;
                }
                let gain = query_truth
                    .relevant
                    .iter()
                    .filter(|relevant| {
                        !credited.contains(relevant.group_id.as_str())
                            && groups_by_id
                                .get(relevant.group_id.as_str())
                                .is_some_and(|group| candidate_matches_group(candidate, group))
                    })
                    .max_by_key(|relevant| relevant.gain)
                    .map(|relevant| {
                        credited.insert(relevant.group_id.as_str());
                        relevant.gain
                    })
                    .unwrap_or(0);
                gains_in_order.push(gain);
            }
            let mut ideal: Vec<u8> = query_truth.relevant.iter().map(|r| r.gain).collect();
            ideal.sort_unstable_by(|a, b| b.cmp(a));
            ideal.truncate(k as usize);
            let ideal_dcg = dcg(&ideal);
            let value = if ideal_dcg == 0.0 {
                0.0
            } else {
                dcg(&gains_in_order) / ideal_dcg
            };
            ndcg_at.insert(k, r6(value.clamp(0.0, 1.0)));
        }
    }

    let mrr = r6(query_truth
        .relevant
        .iter()
        .filter_map(|relevant| first_rank.get(relevant.group_id.as_str()))
        .min()
        .map_or(0.0, |rank| 1.0 / *rank as f64));

    // Contamination at 25: candidates matching declared contaminating groups.
    let contaminating: Vec<&RaEvidenceGroup> = query_truth
        .contaminating_groups
        .iter()
        .filter_map(|group_id| groups_by_id.get(group_id.as_str()).copied())
        .collect();
    let top25: Vec<&RaCandidate> = run.candidates.iter().filter(|c| c.rank <= 25).collect();
    let contaminating_hits = top25
        .iter()
        .filter(|candidate| {
            contaminating
                .iter()
                .any(|group| candidate_matches_group(candidate, group))
        })
        .count() as u64;
    let decoy_share_at_25 = if top25.is_empty() {
        0.0
    } else {
        r6(contaminating_hits as f64 / top25.len() as f64)
    };

    let context_chars_at_25: u64 = top25.iter().map(|c| c.content.chars().count() as u64).sum();

    let evidence_omitted_at_50: Vec<String> = query_truth
        .relevant
        .iter()
        .filter(|relevant| {
            first_rank
                .get(relevant.group_id.as_str())
                .is_none_or(|r| *r > 50)
        })
        .map(|relevant| relevant.group_id.clone())
        .collect();

    RaQueryScore {
        query_id: query.query_id.clone(),
        kind: query.kind.clone(),
        answerable: query_truth.answerable,
        relevant_groups: relevant_total,
        recall_at,
        precision_at,
        mrr,
        ndcg_at,
        decoy_share_at_25,
        contaminating_hits_at_25: contaminating_hits,
        context_chars_at_25,
        evidence_omitted_at_50,
        matched_total: run.matched_total,
        partial: run.partial,
        candidate_count: run.candidates.len() as u64,
    }
}

// ---------------------------------------------------------------------------
// Run-record validation (mode contract, disclosure honesty)
// ---------------------------------------------------------------------------

pub fn validate_run_record(
    truth: &RaTruthManifest,
    queries: &RaQuerySet,
    record: &RaRunRecord,
) -> Vec<RaViolation> {
    let mut violations = Vec::new();
    if record.schema_id != RA_RUN_RECORD_SCHEMA_ID
        || record.schema_version != RA_RUN_RECORD_SCHEMA_VERSION
    {
        violations.push(RaViolation::new(
            V_SCHEMA,
            format!(
                "run record schema {}/{}",
                record.schema_id, record.schema_version
            ),
        ));
    }
    if record.case_id != truth.case_id || record.suite_id != truth.suite_id {
        violations.push(RaViolation::new(
            V_SCHEMA,
            "run record case/suite identity mismatch",
        ));
    }
    if record.engine.contextdesk_sha.trim().is_empty() {
        violations.push(RaViolation::new(
            V_IDENTITY_OMITTED,
            "engine.contextdesk_sha is empty — model/configuration identity must be recorded",
        ));
    }
    if record.corpus.generator_version != RA_GENERATOR_VERSION
        || record.corpus.truth_schema_id != RA_TRUTH_SCHEMA_ID
    {
        violations.push(RaViolation::new(
            V_PROVENANCE_OMITTED,
            "corpus stamp missing exact generator/truth-schema identity",
        ));
    }
    if record.corpus.seed != truth.seed {
        violations.push(RaViolation::new(
            V_PROVENANCE_OMITTED,
            format!(
                "corpus stamp seed {} differs from truth seed {}",
                record.corpus.seed, truth.seed
            ),
        ));
    }
    if record.tier_claimed != truth.tier || record.corpus.tier_requested != truth.tier {
        violations.push(RaViolation::new(
            V_TIER_SUBSTITUTION,
            format!(
                "claimed tier {} / requested {} vs truth tier {}",
                record.tier_claimed, record.corpus.tier_requested, truth.tier
            ),
        ));
    }
    if record.corpus.events_expected != truth.expected.events {
        violations.push(RaViolation::new(
            V_TIER_SUBSTITUTION,
            format!(
                "corpus stamp expects {} events but the {} tier truth expects {} — a different corpus was substituted",
                record.corpus.events_expected, truth.tier, truth.expected.events
            ),
        ));
    }
    if record.corpus.import_tree_sha256 != truth.import_tree_sha256 {
        violations.push(RaViolation::new(
            V_TIER_SUBSTITUTION,
            "import tree identity differs from the truth manifest's corpus identity",
        ));
    }

    match record.mode_status.state.as_str() {
        "executed" => {
            match record.mode {
                RaMode::StructuredKeyword => {
                    if record.engine.model_identity.is_some()
                        || record.engine.reranker_identity.is_some()
                    {
                        violations.push(RaViolation::new(
                            V_MODE_MISLABEL,
                            "structured_keyword must not carry model/reranker identity",
                        ));
                    }
                    for (label, value) in [
                        ("embedding_calls", record.calls.embedding_calls),
                        ("rerank_calls", record.calls.rerank_calls),
                        ("provider_calls", record.calls.provider_calls),
                    ] {
                        match value {
                            Some(0) => {}
                            Some(n) => violations.push(RaViolation::new(
                                V_MODE_MISLABEL,
                                format!("structured_keyword reported {label}={n}"),
                            )),
                            None => violations.push(RaViolation::new(
                                V_TELEMETRY_UNKNOWN,
                                format!("{label} omitted — omitted is unknown, not zero"),
                            )),
                        }
                    }
                }
                RaMode::HybridEmbedding | RaMode::HybridEmbeddingReranked => {
                    if record.engine.model_identity.is_none() {
                        violations.push(RaViolation::new(
                            V_MODE_MISLABEL,
                            "embedding mode executed without a model identity",
                        ));
                    }
                    if !matches!(record.calls.embedding_calls, Some(n) if n > 0) {
                        violations.push(RaViolation::new(
                            V_MODE_MISLABEL,
                            "embedding mode executed with zero/unknown embedding calls — results are baseline results relabeled",
                        ));
                    }
                    if record.mode == RaMode::HybridEmbeddingReranked
                        && (record.engine.reranker_identity.is_none()
                            || !matches!(record.calls.rerank_calls, Some(n) if n > 0))
                    {
                        violations.push(RaViolation::new(
                            V_MODE_MISLABEL,
                            "reranked mode executed without reranker identity/calls",
                        ));
                    }
                }
                RaMode::FullMultistage => {
                    if !matches!(record.calls.provider_calls, Some(n) if n > 0) {
                        violations.push(RaViolation::new(
                            V_MODE_MISLABEL,
                            "full_multistage executed with zero/unknown provider calls",
                        ));
                    }
                    if record.engine.model_identity.is_none() {
                        violations.push(RaViolation::new(
                            V_IDENTITY_OMITTED,
                            "full_multistage executed without a model identity",
                        ));
                    }
                }
            }

            // Query coverage and k honesty.
            let expected_ids: BTreeSet<&str> = queries
                .queries
                .iter()
                .map(|q| q.query_id.as_str())
                .collect();
            let ran_ids: BTreeSet<&str> =
                record.queries.iter().map(|q| q.query_id.as_str()).collect();
            if expected_ids != ran_ids {
                violations.push(RaViolation::new(
                    V_SCHEMA,
                    "executed mode did not run exactly the committed query set",
                ));
            }
            for run in &record.queries {
                if run.k_requested != RA_K {
                    violations.push(RaViolation::new(
                        V_K_SUBSTITUTION,
                        format!(
                            "{}: k={} requested (contract is {})",
                            run.query_id, run.k_requested, RA_K
                        ),
                    ));
                }
                if run.candidates.len() as u64 > RA_K {
                    violations.push(RaViolation::new(
                        V_DEGENERATE_STRATEGY,
                        format!(
                            "{}: more candidates than k — retrieve-everything is not a strategy",
                            run.query_id
                        ),
                    ));
                }
                let mut last_rank = 0;
                for candidate in &run.candidates {
                    if candidate.rank != last_rank + 1 {
                        violations.push(RaViolation::new(
                            V_SCHEMA,
                            format!(
                                "{}: candidate ranks must be contiguous from 1",
                                run.query_id
                            ),
                        ));
                        break;
                    }
                    last_rank = candidate.rank;
                }
            }
        }
        "unavailable" => {
            if record.mode_status.unavailable_reason.is_none() {
                violations.push(RaViolation::new(
                    V_SCHEMA,
                    "unavailable mode without a reason",
                ));
            }
            if !record.queries.is_empty() {
                violations.push(RaViolation::new(
                    V_UNAVAILABLE_AS_PASS,
                    "unavailable mode carries query results — unavailable never produces scores",
                ));
            }
        }
        other => violations.push(RaViolation::new(
            V_SCHEMA,
            format!("unknown mode state {other}"),
        )),
    }
    violations
}

// ---------------------------------------------------------------------------
// Conservation checks (corpus-level, mode-independent)
// ---------------------------------------------------------------------------

pub fn validate_conservation(
    truth: &RaTruthManifest,
    observed: &RaObservedCorpus,
) -> Vec<RaViolation> {
    let mut violations = Vec::new();
    if observed.events_imported != truth.expected.events {
        violations.push(RaViolation::new(
            V_IMPORT_MISMATCH,
            format!(
                "importer produced {} events, truth expects {}",
                observed.events_imported, truth.expected.events
            ),
        ));
    }
    for (source, expected) in &truth.expected.sources {
        match observed.sources.get(source) {
            Some(actual) if actual == expected => {}
            Some(actual) => violations.push(RaViolation::new(
                V_IMPORT_MISMATCH,
                format!("source {source}: {actual} events observed, {expected} expected"),
            )),
            None => violations.push(RaViolation::new(
                V_IMPORT_MISMATCH,
                format!("source {source} missing after import"),
            )),
        }
    }
    for source in observed.sources.keys() {
        if !truth.expected.sources.contains_key(source) {
            violations.push(RaViolation::new(
                V_IMPORT_MISMATCH,
                format!("unexpected source {source} appeared after import"),
            ));
        }
    }
    if !observed.exclusions_honored {
        violations.push(RaViolation::new(
            V_EXCLUSION_VIOLATED,
            observed.exclusion_detail.clone(),
        ));
    }
    for group in &truth.evidence_groups {
        match observed.token_census.get(&group.group_id) {
            Some(census) => match census.exact {
                Some(exact) if exact == group.expected_token_records => {}
                Some(exact) => violations.push(RaViolation::new(
                    V_TOKEN_CENSUS,
                    format!(
                        "group {}: {} token records observed, {} expected",
                        group.group_id, exact, group.expected_token_records
                    ),
                )),
                None => {
                    if census.lower_bound < group.expected_token_records {
                        violations.push(RaViolation::new(
                            V_TOKEN_CENSUS,
                            format!(
                                "group {}: engine lower bound {} below expected {}",
                                group.group_id, census.lower_bound, group.expected_token_records
                            ),
                        ));
                    }
                }
            },
            None => violations.push(RaViolation::new(
                V_TOKEN_CENSUS,
                format!("group {}: census missing", group.group_id),
            )),
        }
    }
    for secret in &observed.secret_hits_in_store {
        violations.push(RaViolation::new(
            V_SECRET_IN_STORE,
            format!(
                "secret-shaped value {} survived into the durable event store (known class: oracle R4)",
                &secret[..secret.len().min(24)]
            ),
        ));
    }
    if let (Some(expected), Some(observed_geometry)) =
        (expected_geometry(truth), observed.geometry.as_ref())
    {
        if observed_geometry.occurrence_count != expected.occurrences
            || observed_geometry.application_exception_records
                != expected.application_exception_records
            || observed_geometry.stderr_exception_records != expected.stderr_exception_records
        {
            violations.push(RaViolation::new(
                V_GEOMETRY,
                format!(
                    "exception geometry drifted: observed occ={} app={} stderr={} vs expected occ={} app={} stderr={}",
                    observed_geometry.occurrence_count,
                    observed_geometry.application_exception_records,
                    observed_geometry.stderr_exception_records,
                    expected.occurrences,
                    expected.application_exception_records,
                    expected.stderr_exception_records
                ),
            ));
        }
    }
    violations
}

/// Cases encode expected exception geometry implicitly through group raw /
/// occurrence accounting: exception-bearing groups are those whose raw
/// records exceed their token records (wrapped stderr) or that live in plain
/// sources with stack content. To stay schema-stable this derives from truth
/// alone; cases without exception content return `None`.
pub fn expected_geometry(truth: &RaTruthManifest) -> Option<RaExpectedGeometry> {
    match truth.case_id.as_str() {
        "rb06-duplicate-renderings" => {
            let g01 = truth
                .evidence_groups
                .iter()
                .find(|g| g.group_id.ends_with("-g01"))?;
            let g02 = truth
                .evidence_groups
                .iter()
                .find(|g| g.group_id.ends_with("-g02"))?;
            Some(RaExpectedGeometry {
                application_exception_records: 2,
                stderr_exception_records: g01.expected_raw_records - 1,
                occurrences: g01.expected_occurrences + g02.expected_occurrences,
            })
        }
        "rb07-interleaved" => Some(RaExpectedGeometry {
            application_exception_records: 6,
            stderr_exception_records: 0,
            occurrences: 6,
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Case/mode scoring and partition
// ---------------------------------------------------------------------------

pub fn score_case_mode(
    truth: &RaTruthManifest,
    queries: &RaQuerySet,
    record: &RaRunRecord,
    conservation_violations: &[RaViolation],
) -> RaCaseModeScore {
    let mut violations = validate_run_record(truth, queries, record);

    if record.mode_status.state == "unavailable" {
        let partition = if violations.is_empty() {
            RaPartition::FutureCapabilityUnavailable
        } else {
            RaPartition::RedRequiredFix
        };
        return RaCaseModeScore {
            case_id: truth.case_id.clone(),
            mode: record.mode,
            partition,
            unavailable_reason: record.mode_status.unavailable_reason.clone(),
            violations,
            mean_recall_at_25_answerable: 0.0,
            mean_mrr_answerable: 0.0,
            max_decoy_share_at_25: 0.0,
            rare_trigger_recall_at_25: None,
            role_coverage_at_50: BTreeMap::new(),
            false_grouping_contaminations_at_25: 0,
            context_chars_total: 0,
            evidence_omitted_total: 0,
            runtime_ms_total: None,
            queries: Vec::new(),
        };
    }

    violations.extend_from_slice(conservation_violations);

    // Secrets must never surface in retrieved candidate content.
    for secret in &truth.privacy.secret_tokens {
        for run in &record.queries {
            if run.candidates.iter().any(|c| c.content.contains(secret)) {
                violations.push(RaViolation::new(
                    V_SECRET_IN_RETRIEVED,
                    format!(
                        "secret value surfaced in retrieved context for {}",
                        run.query_id
                    ),
                ));
            }
        }
    }

    // Equivalent-query determinism (rb16 cosmetic variants, and generally any
    // queries sharing identical term sets modulo case/whitespace).
    let mut equivalence: BTreeMap<Vec<String>, Vec<(&str, BTreeSet<u64>)>> = BTreeMap::new();
    for query in &queries.queries {
        let mut key: Vec<String> = query
            .keyword_plan
            .terms
            .iter()
            .map(|t| t.trim().to_lowercase())
            .collect();
        key.sort();
        if let Some(run) = record.queries.iter().find(|r| r.query_id == query.query_id) {
            let seqs: BTreeSet<u64> = run.candidates.iter().map(|c| c.seq).collect();
            equivalence
                .entry(key)
                .or_default()
                .push((&query.query_id, seqs));
        }
    }
    for (key, entries) in &equivalence {
        if entries.len() > 1 {
            let first = &entries[0].1;
            for (query_id, seqs) in &entries[1..] {
                if seqs != first {
                    violations.push(RaViolation::new(
                        V_NON_PROGRESS_DIVERGENCE,
                        format!(
                            "queries {} and {} are cosmetically equivalent ({key:?}) but returned different evidence",
                            entries[0].0, query_id
                        ),
                    ));
                }
            }
        }
    }

    // Per-query scores.
    let mut query_scores = Vec::new();
    for query in &queries.queries {
        let Some(query_truth) = truth.per_query_relevance.get(&query.query_id) else {
            violations.push(RaViolation::new(
                V_SCHEMA,
                format!("no relevance truth for {}", query.query_id),
            ));
            continue;
        };
        let Some(run) = record.queries.iter().find(|r| r.query_id == query.query_id) else {
            continue;
        };
        query_scores.push(score_query(truth, query_truth, query, run));
    }

    // Degenerate strategies: an executed retrieval mode that returns nothing
    // anywhere cannot pass.
    let total_candidates: u64 = query_scores.iter().map(|q| q.candidate_count).sum();
    if total_candidates == 0 {
        violations.push(RaViolation::new(
            V_DEGENERATE_STRATEGY,
            "mode returned zero candidates for every query — return-nothing is not a strategy",
        ));
    }

    let answerable: Vec<&RaQueryScore> = query_scores.iter().filter(|q| q.answerable).collect();
    let mean_recall = if answerable.is_empty() {
        0.0
    } else {
        r6(answerable.iter().map(|q| q.recall_at[&25]).sum::<f64>() / answerable.len() as f64)
    };
    let mean_mrr = if answerable.is_empty() {
        0.0
    } else {
        r6(answerable.iter().map(|q| q.mrr).sum::<f64>() / answerable.len() as f64)
    };
    let max_decoy = r6(query_scores
        .iter()
        .map(|q| q.decoy_share_at_25)
        .fold(0.0, f64::max));
    let contaminations: u64 = query_scores
        .iter()
        .map(|q| q.contaminating_hits_at_25)
        .sum();
    let context_chars_total: u64 = query_scores.iter().map(|q| q.context_chars_at_25).sum();
    let evidence_omitted_total: u64 = query_scores
        .iter()
        .map(|q| q.evidence_omitted_at_50.len() as u64)
        .sum();

    // Rare-trigger recall: over broad+causal queries, fraction of trigger
    // groups retrieved at 25.
    let trigger_groups: Vec<&RaEvidenceGroup> = truth
        .evidence_groups
        .iter()
        .filter(|g| g.role == RaRole::Trigger)
        .collect();
    let rare_trigger_recall = if trigger_groups.is_empty() {
        None
    } else {
        let mut retrieved = 0u64;
        let mut total = 0u64;
        for query in &queries.queries {
            if query.kind != "broad" && query.kind != "causal" {
                continue;
            }
            let Some(query_truth) = truth.per_query_relevance.get(&query.query_id) else {
                continue;
            };
            let Some(run) = record.queries.iter().find(|r| r.query_id == query.query_id) else {
                continue;
            };
            for group in &trigger_groups {
                if !query_truth
                    .relevant
                    .iter()
                    .any(|r| r.group_id == group.group_id)
                {
                    continue;
                }
                total += 1;
                if run
                    .candidates
                    .iter()
                    .any(|c| c.rank <= 25 && candidate_matches_group(c, group))
                {
                    retrieved += 1;
                }
            }
        }
        if total == 0 {
            None
        } else {
            Some(r6(retrieved as f64 / total as f64))
        }
    };

    // Role coverage at 50 across all queries.
    let mut role_coverage: BTreeMap<String, bool> = BTreeMap::new();
    for group in &truth.evidence_groups {
        if group.role == RaRole::Decoy || group.role == RaRole::Neutral {
            continue;
        }
        let role = group.role.as_str().to_string();
        let covered = record.queries.iter().any(|run| {
            run.candidates
                .iter()
                .any(|c| c.rank <= 50 && candidate_matches_group(c, group))
        });
        let entry = role_coverage.entry(role).or_insert(false);
        *entry = *entry || covered;
    }

    let runtime_ms_total = record
        .queries
        .iter()
        .try_fold(0u64, |acc, run| run.runtime_ms.map(|ms| acc + ms));

    // Partition.
    let expectation = &truth.baseline_expectation;
    let partition = if !violations.is_empty() {
        RaPartition::RedRequiredFix
    } else if record.mode == RaMode::StructuredKeyword {
        let recall_ok = expectation
            .gates
            .min_recall_at_25
            .is_none_or(|floor| mean_recall + 1e-9 >= floor);
        let decoy_ok = expectation
            .gates
            .max_decoy_share_at_25
            .is_none_or(|cap| max_decoy <= cap + 1e-9);
        match expectation.class.as_str() {
            "pass" => {
                if recall_ok && decoy_ok {
                    RaPartition::PassOnBase
                } else {
                    RaPartition::RedRequiredFix
                }
            }
            "limitation" => {
                if recall_ok && decoy_ok {
                    RaPartition::BaselineLimitation
                } else {
                    RaPartition::RedRequiredFix
                }
            }
            other => {
                violations.push(RaViolation::new(
                    V_SCHEMA,
                    format!("unknown expectation class {other}"),
                ));
                RaPartition::RedRequiredFix
            }
        }
    } else {
        // Executed non-baseline modes classify on the same gates but never
        // inherit BASELINE_LIMITATION: a capability either meets the case's
        // floors or the case remains a limitation for it.
        if expectation
            .gates
            .min_recall_at_25
            .is_none_or(|floor| mean_recall + 1e-9 >= floor)
        {
            RaPartition::PassOnBase
        } else {
            RaPartition::BaselineLimitation
        }
    };

    // Baseline regression tripwire: a pass-class case whose recall collapses
    // to zero is flagged even if its floor was None.
    if record.mode == RaMode::StructuredKeyword
        && expectation.class == "pass"
        && !answerable.is_empty()
        && mean_recall == 0.0
        && partition == RaPartition::RedRequiredFix
    {
        violations.push(RaViolation::new(
            V_BASELINE_REGRESSION,
            "pass-class case retrieved none of its expected evidence",
        ));
    }

    RaCaseModeScore {
        case_id: truth.case_id.clone(),
        mode: record.mode,
        partition,
        unavailable_reason: None,
        violations,
        mean_recall_at_25_answerable: mean_recall,
        mean_mrr_answerable: mean_mrr,
        max_decoy_share_at_25: max_decoy,
        rare_trigger_recall_at_25: rare_trigger_recall,
        role_coverage_at_50: role_coverage,
        false_grouping_contaminations_at_25: contaminations,
        context_chars_total,
        evidence_omitted_total,
        runtime_ms_total,
        queries: query_scores,
    }
}

// ---------------------------------------------------------------------------
// Suite report assembly
// ---------------------------------------------------------------------------

pub struct RaCaseInputs {
    pub truth: RaTruthManifest,
    pub queries: RaQuerySet,
    pub observed: RaObservedCorpus,
    pub records: Vec<RaRunRecord>,
}

#[allow(clippy::too_many_arguments)]
pub fn assemble_report(
    contextdesk_sha: &str,
    suite: &RaSuiteManifest,
    cases: &[RaCaseInputs],
    generation_ms: Option<u64>,
) -> RaReport {
    let mut case_reports = Vec::new();
    let mut partition_counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut mode_rows: BTreeMap<RaMode, Vec<&RaCaseModeScore>> = BTreeMap::new();
    let mut mode_status: BTreeMap<RaMode, (String, Option<String>)> = BTreeMap::new();
    type RaCallTriple = (Option<u64>, Option<u64>, Option<u64>);
    let mut mode_calls: BTreeMap<RaMode, RaCallTriple> = BTreeMap::new();

    let mut scored: Vec<(usize, Vec<RaCaseModeScore>, Vec<RaViolation>)> = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let conservation = validate_conservation(&case.truth, &case.observed);
        // Trial-independence: identical duplicated run records must not be
        // counted as independent trials.
        let mut seen_digests = BTreeSet::new();
        let mut scores = Vec::new();
        for record in &case.records {
            let digest = super::super::sha256_bytes(
                serde_json::to_vec(record)
                    .expect("run record serialises")
                    .as_slice(),
            );
            let mut score = score_case_mode(&case.truth, &case.queries, record, &conservation);
            if !seen_digests.insert(digest) {
                score.violations.push(RaViolation::new(
                    V_DUPLICATE_TRIALS,
                    "identical run record counted twice",
                ));
                score.partition = RaPartition::RedRequiredFix;
            }
            scores.push(score);
        }
        scored.push((index, scores, conservation));
    }

    for (index, scores, conservation) in &scored {
        let case = &cases[*index];
        for score in scores {
            *partition_counts
                .entry(score.partition.as_str().to_string())
                .or_default() += 1;
        }
        case_reports.push(RaCaseReport {
            case_id: case.truth.case_id.clone(),
            title: case.truth.title.clone(),
            intended_probe: case.truth.intended_probe.clone(),
            events_expected: case.truth.expected.events,
            events_imported: case.observed.events_imported,
            coverage_claim: "observed_only".into(),
            corpus_completeness_truth: case.truth.known_counts.corpus_completeness.clone(),
            conservation_violations: conservation.clone(),
            modes: scores.clone(),
        });
    }
    for case_report in &case_reports {
        for score in &case_report.modes {
            mode_rows.entry(score.mode).or_default().push(score);
        }
    }
    for case in cases {
        for record in &case.records {
            let status = mode_status.entry(record.mode).or_insert_with(|| {
                (
                    record.mode_status.state.clone(),
                    record.mode_status.unavailable_reason.clone(),
                )
            });
            if record.mode_status.state == "unavailable" {
                *status = (
                    "unavailable".into(),
                    record.mode_status.unavailable_reason.clone(),
                );
            }
            let calls = mode_calls
                .entry(record.mode)
                .or_insert((Some(0), Some(0), Some(0)));
            fn add(acc: &mut Option<u64>, value: Option<u64>) {
                *acc = match (acc.as_ref(), value) {
                    (Some(a), Some(b)) => Some(a + b),
                    _ => None,
                };
            }
            add(&mut calls.0, record.calls.embedding_calls);
            add(&mut calls.1, record.calls.rerank_calls);
            add(&mut calls.2, record.calls.provider_calls);
        }
    }

    let modes = RaMode::ALL
        .iter()
        .map(|mode| {
            let rows = mode_rows.get(mode).cloned().unwrap_or_default();
            let (status, reason) = mode_status
                .get(mode)
                .cloned()
                .unwrap_or_else(|| ("unavailable".into(), Some("not_run".into())));
            if status == "unavailable" {
                RaModeSummary {
                    mode: *mode,
                    status,
                    unavailable_reason: reason,
                    mean_recall_at_25: None,
                    mean_rare_trigger_recall_at_25: None,
                    mean_decoy_share_at_25: None,
                    context_chars_total: None,
                    embedding_calls: None,
                    rerank_calls: None,
                    provider_calls: None,
                    runtime_ms_total: None,
                }
            } else {
                let mean = |extract: &dyn Fn(&RaCaseModeScore) -> f64| {
                    if rows.is_empty() {
                        0.0
                    } else {
                        r6(rows.iter().map(|row| extract(row)).sum::<f64>() / rows.len() as f64)
                    }
                };
                let rare: Vec<f64> = rows
                    .iter()
                    .filter_map(|r| r.rare_trigger_recall_at_25)
                    .collect();
                let calls = mode_calls.get(mode).cloned().unwrap_or((None, None, None));
                RaModeSummary {
                    mode: *mode,
                    status,
                    unavailable_reason: None,
                    mean_recall_at_25: Some(mean(&|r| r.mean_recall_at_25_answerable)),
                    mean_rare_trigger_recall_at_25: if rare.is_empty() {
                        None
                    } else {
                        Some(r6(rare.iter().sum::<f64>() / rare.len() as f64))
                    },
                    mean_decoy_share_at_25: Some(mean(&|r| r.max_decoy_share_at_25)),
                    context_chars_total: Some(rows.iter().map(|r| r.context_chars_total).sum()),
                    embedding_calls: calls.0,
                    rerank_calls: calls.1,
                    provider_calls: calls.2,
                    runtime_ms_total: rows
                        .iter()
                        .try_fold(0u64, |acc, row| row.runtime_ms_total.map(|ms| acc + ms)),
                }
            }
        })
        .collect();

    let scale_caps: BTreeMap<String, u64> = suite
        .cases
        .iter()
        .filter_map(|case| case.scale_cap.map(|cap| (case.case_id.clone(), cap)))
        .collect();

    RaReport {
        schema_id: RA_REPORT_SCHEMA_ID.into(),
        schema_version: RA_REPORT_SCHEMA_VERSION,
        suite_id: suite.suite_id.clone(),
        suite_version: suite.suite_version,
        contextdesk_sha: contextdesk_sha.into(),
        generator_version: suite.generator_version.clone(),
        truth_schema_id: suite.truth_schema_id.clone(),
        seed: suite.seed,
        tier_requested: suite.tier.clone(),
        tier_actual_events: cases.iter().map(|c| c.observed.events_imported).sum(),
        tier_expected_events: suite.total_events,
        corpus_identity_sha256: suite.corpus_identity_sha256.clone(),
        corpus_bytes: suite.total_bytes,
        generation_ms,
        modes,
        cases: case_reports,
        partition_counts,
        disclosures: RaDisclosures {
            k: RA_K,
            k_prefixes: RA_K_PREFIXES.to_vec(),
            noise_multiplier: suite.noise_multiplier,
            scale_caps,
            census_exact_cap: RA_CENSUS_EXACT_CAP,
            ranking_semantics: "non-semantic production search returns chronological (ts, seq) order; rank is presentation order, not relevance".into(),
            notes: vec![
                "unavailable capabilities are never scored, never substituted, and never counted as passing".into(),
                "coverage claims are observed_only unless truth marks the corpus complete".into(),
            ],
        },
    }
}

/// Exact-census paging cap: groups whose expected token records exceed this
/// are checked via the engine's total-match lower bound instead of exact
/// candidate paging (disclosed in the report).
pub const RA_CENSUS_EXACT_CAP: u64 = 2_000;

/// Coverage-claim honesty: `observed_only` is always allowed; `complete` is
/// allowed only when the truth marks the corpus complete. Reports default to
/// `observed_only`; this is the seam future lanes (and mutations) go through.
pub fn validate_coverage_claim(truth: &RaTruthManifest, claim: &str) -> Option<RaViolation> {
    match claim {
        "observed_only" => None,
        "complete" => {
            if truth.known_counts.corpus_completeness == "complete" {
                None
            } else {
                Some(RaViolation::new(
                    V_COMPLETENESS_OVERCLAIM,
                    format!(
                        "coverage claimed complete but truth marks the corpus {} with {} known missing reference(s)",
                        truth.known_counts.corpus_completeness,
                        truth.known_counts.known_missing_references
                    ),
                ))
            }
        }
        other => Some(RaViolation::new(
            V_SCHEMA,
            format!("unknown coverage claim `{other}`"),
        )),
    }
}

// ---------------------------------------------------------------------------
// Bridge to the production triage rubric (future full_multistage lane)
// ---------------------------------------------------------------------------

/// Map a retrieval-ablation truth manifest onto the production
/// `TriageKnownAnswerKey` so the existing ten-dimension rubric
/// (`cd_core::triage_quality::score_structured_triage_answer`) scores any
/// future full_multistage answer without new truth data.
pub fn ra_triage_key(truth: &RaTruthManifest) -> cd_core::triage_quality::TriageKnownAnswerKey {
    let trigger_token = truth
        .evidence_groups
        .iter()
        .find(|g| g.role == RaRole::Trigger)
        .map(|g| g.token.clone());
    let competing: Vec<String> = truth
        .evidence_groups
        .iter()
        .filter(|g| g.role == RaRole::Trigger)
        .skip(1)
        .map(|g| g.token.clone())
        .collect();
    let decoy_token = truth
        .evidence_groups
        .iter()
        .find(|g| g.role == RaRole::Decoy)
        .map(|g| g.token.clone());
    let symptom_tokens: Vec<String> = truth
        .evidence_groups
        .iter()
        .filter(|g| g.role == RaRole::Symptom)
        .map(|g| g.token.clone())
        .collect();
    let establishable = truth
        .incidents
        .iter()
        .any(|incident| incident.root_cause_status == "established");
    cd_core::triage_quality::TriageKnownAnswerKey {
        case_id: truth.case_id.clone(),
        time_quality_expected: truth.expected.time_quality.clone(),
        sources_present: truth.expected.sources.keys().cloned().collect(),
        sources_omitted: Vec::new(),
        decoy_earliest_error_message_token: decoy_token,
        true_trigger_message_token: if competing.is_empty() {
            trigger_token
        } else {
            None
        },
        competing_trigger_message_tokens: if competing.is_empty() {
            Vec::new()
        } else {
            truth
                .evidence_groups
                .iter()
                .filter(|g| g.role == RaRole::Trigger)
                .map(|g| g.token.clone())
                .collect()
        },
        symptom_message_tokens: symptom_tokens,
        root_cause_establishable: establishable,
        forbidden_claims: truth.forbidden_claims.clone(),
        required_disclosures: truth.permitted_uncertainty.clone(),
    }
}
