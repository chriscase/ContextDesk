//! Deterministic single-corpus **noise / suppression candidates** (#815).
//!
//! This module proposes exact-template candidates for **human review only**.
//! It never activates suppression, never mutates events/templates/findings/
//! bookmarks, and never labels a template “confirmed noise.”
//!
//! Scoring uses corpus facts only (counts, share, sources, time span, levels).
//! Severity is evidence, not truth: ERROR-heavy templates may appear with
//! disclosed risk fields and a conservative score penalty.
//!
//! Cross-corpus learning is explicitly out of scope.

use super::redact_log::redact_message;
use super::suppression::{load_suppression_document, SuppressionLevelCount, SuppressionTimeSpan};
use super::{LogCorpus, TimeQuality};
use crate::error::{CoreError, CoreResult};
use crate::incident_evidence::contains_forbidden_sentinel;
use crate::redact::redact_candidate;
use duckdb::Connection;
use serde::Serialize;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// ─── Hard caps ───────────────────────────────────────────────────────────────

/// Default maximum candidates returned in one report.
pub const DEFAULT_NOISE_CANDIDATE_CAP: usize = 16;
/// Absolute maximum candidates (hard ceiling).
pub const MAX_NOISE_CANDIDATES: usize = 32;
/// Default representatives per candidate.
pub const DEFAULT_NOISE_REPRESENTATIVE_CAP: usize = 3;
/// Absolute representatives per candidate.
pub const MAX_NOISE_REPRESENTATIVES: usize = 5;
/// Max UTF-8 bytes of one redacted representative excerpt.
pub const MAX_NOISE_REPRESENTATIVE_EXCERPT_BYTES: usize = 512;
/// Max UTF-8 bytes of one pattern display line.
pub const MAX_NOISE_PATTERN_BYTES: usize = 256;
/// Max level buckets retained per candidate.
pub const MAX_NOISE_LEVEL_BUCKETS: usize = 16;
/// Minimum corpus events before any candidate is proposed (empty/tiny corpora).
pub const MIN_CORPUS_EVENTS_FOR_CANDIDATES: u64 = 20;
/// Minimum events on a template before it can be proposed.
pub const MIN_TEMPLATE_EVENTS_FOR_CANDIDATE: u64 = 10;
/// Minimum corpus share (basis points: 1 = 0.01%) for proposal, unless absolute count is large.
pub const MIN_SHARE_BPS_FOR_CANDIDATE: u64 = 50; // 0.5%
/// Absolute event floor that may override share for very large corpora.
pub const LARGE_COUNT_OVERRIDE: u64 = 500;
/// Maximum template fact rows retained from the aggregate query.
pub const MAX_TEMPLATES_SCANNED: usize = 4_096;
/// Hard upper bound on the exact serialized JSON report body.
pub const MAX_NOISE_REPORT_BYTES: usize = 96 * 1024;
/// Maximum wall-clock time granted to the bounded database query pass.
pub const MAX_NOISE_QUERY_DURATION: Duration = Duration::from_secs(30);
/// Fixed maximum database statements in one detector pass.
pub const MAX_NOISE_QUERY_COUNT: usize = 4;
/// Minimum proposal score for active (non-already-suppressed) candidates after
/// component scoring and severity penalty. Below this floor the template is
/// eligible by count/share but not ranked as a proposal (reduces weak ties).
pub const MIN_PROPOSAL_SCORE: u32 = 12;

// ─── Reason codes ────────────────────────────────────────────────────────────

/// Stable machine reason codes attached to each candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoiseCandidateReasonCode {
    /// High absolute event count among unsuppressed events.
    HighFrequency,
    /// Material share of the unsuppressed corpus.
    HighCorpusShare,
    /// Same template observed across many sources.
    MultiSourceRepetition,
    /// Events span a large fraction of the corpus time range (not a short burst).
    TemporallyPersistent,
    /// Level distribution dominated by INFO (or unset).
    LevelDominatedInfo,
    /// Level distribution dominated by WARN/WARNING.
    LevelDominatedWarn,
    /// Template still has material ERROR/FATAL volume — proposed only with risk disclosure.
    RepetitiveErrorRisky,
    /// Events appear steady rather than concentrated in a short window.
    SteadyBackground,
    /// Template is already enabled in the pinned suppression document.
    AlreadySuppressed,
}

impl NoiseCandidateReasonCode {
    /// Snake-case wire/display id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HighFrequency => "high_frequency",
            Self::HighCorpusShare => "high_corpus_share",
            Self::MultiSourceRepetition => "multi_source_repetition",
            Self::TemporallyPersistent => "temporally_persistent",
            Self::LevelDominatedInfo => "level_dominated_info",
            Self::LevelDominatedWarn => "level_dominated_warn",
            Self::RepetitiveErrorRisky => "repetitive_error_risky",
            Self::SteadyBackground => "steady_background",
            Self::AlreadySuppressed => "already_suppressed",
        }
    }

    fn human_phrase(self) -> &'static str {
        match self {
            Self::HighFrequency => "high event frequency",
            Self::HighCorpusShare => "material share of the corpus",
            Self::MultiSourceRepetition => "repetition across multiple sources",
            Self::TemporallyPersistent => "activity spanning a large portion of the time range",
            Self::LevelDominatedInfo => "mostly informational levels",
            Self::LevelDominatedWarn => "mostly warning levels",
            Self::RepetitiveErrorRisky => {
                "material ERROR/FATAL volume — review carefully; not confirmed noise"
            }
            Self::SteadyBackground => "steady background rather than a short burst",
            Self::AlreadySuppressed => "already enabled in the active suppression policy",
        }
    }
}

// ─── Public DTOs ─────────────────────────────────────────────────────────────

/// Caller options for one proposal pass.
#[derive(Debug, Clone)]
pub struct NoiseCandidateOptions {
    /// Max candidates to return (clamped to [`MAX_NOISE_CANDIDATES`]).
    pub max_candidates: usize,
    /// Max redacted representatives per candidate.
    pub max_representatives: usize,
    /// When true, include templates already enabled in the active suppression lens
    /// (marked `already_suppressed`); default false excludes them from the ranked list
    /// but still reports their ids separately.
    pub include_already_suppressed: bool,
}

impl Default for NoiseCandidateOptions {
    fn default() -> Self {
        Self {
            max_candidates: DEFAULT_NOISE_CANDIDATE_CAP,
            max_representatives: DEFAULT_NOISE_REPRESENTATIVE_CAP,
            include_already_suppressed: false,
        }
    }
}

/// One bounded redacted representative for human review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseCandidateRepresentative {
    /// Stable event sequence within the corpus.
    pub seq: u64,
    /// Relative source identity (never an absolute path requirement).
    pub source: String,
    /// Timestamp or order value for the representative.
    pub timestamp: i64,
    /// Whether `timestamp` is a wall clock or an ingest-order coordinate.
    pub time_quality: TimeQuality,
    /// Bounded level label.
    pub level: String,
    /// Secret-scrubbed excerpt; never raw credentials.
    pub redacted_excerpt: String,
}

/// One exact-template **proposal** for human preview/activation (#671).
///
/// Wording is intentionally proposal-only. This is never “confirmed noise.”
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseCandidate {
    /// Corpus-local exact template id.
    pub template_id: u64,
    /// Trusted content hash / fingerprint of the template definition.
    pub template_fingerprint: String,
    /// Bounded pattern text (may be truncated).
    pub pattern: String,
    /// Deterministic integer score (higher = stronger *proposal* signal).
    pub score: u32,
    /// Exact event count for this template in the declared `share_basis`.
    pub event_count: u64,
    /// Share in basis points (100 = 1.00%) using `share_basis`.
    pub corpus_share_bps: u64,
    /// Distinct sources.
    pub source_count: u64,
    /// Inclusive time span of matches.
    ///
    /// Wall-clock and order coordinates are deliberately separate. A mixed
    /// template never receives a fabricated shared duration.
    pub time_quality: TimeQuality,
    /// Inclusive wall-clock span when wall-clock records are present.
    pub wall_time_span: Option<SuppressionTimeSpan>,
    /// Inclusive sequence/order span when order-only records are present.
    pub order_span: Option<SuppressionTimeSpan>,
    /// Level histogram (bounded).
    pub level_counts: Vec<SuppressionLevelCount>,
    /// Exact count represented by levels beyond the displayed histogram cap.
    pub other_level_count: u64,
    /// True when `other_level_count` contains one or more omitted level labels.
    pub level_counts_truncated: bool,
    /// ERROR + FATAL event count (disclosed; severity is evidence).
    pub error_or_fatal_count: u64,
    /// WARN + WARNING event count.
    pub warn_count: u64,
    /// INFO (and empty) event count.
    pub info_count: u64,
    /// Stable reason codes.
    pub reason_codes: Vec<NoiseCandidateReasonCode>,
    /// Human-readable explanation composed from reason codes + facts.
    pub explanation: String,
    /// True when an enabled #671 rule already excludes this template.
    pub already_suppressed: bool,
    /// Denominator used by `corpus_share_bps`.
    pub share_basis: &'static str,
    /// Label for UIs: always a candidate, never confirmed noise.
    pub proposal_kind: &'static str,
    /// Bounded redacted representatives.
    pub representatives: Vec<NoiseCandidateRepresentative>,
}

/// Full detector report for one corpus pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseCandidateReport {
    /// Corpus identity for this pass.
    pub corpus_id: String,
    /// Unsuppressed event count used as the share denominator.
    pub unsuppressed_event_count: u64,
    /// Raw corpus event count (including suppressed).
    pub corpus_event_count: u64,
    /// Suppression document revision observed (read-only).
    pub suppression_revision: u64,
    /// Event revision observed for the coherent database snapshot.
    pub event_revision: u64,
    /// Deterministic template-metadata revision observed.
    pub template_analysis_revision: u64,
    /// Enabled template ids under the active policy (sorted).
    pub already_suppressed_template_ids: Vec<u64>,
    /// Honest time quality of the corpus sample used for span math.
    pub time_quality: TimeQuality,
    /// Honest time quality before the active suppression lens is applied.
    pub raw_time_quality: TimeQuality,
    /// Ranked proposals (score DESC, template_id ASC).
    pub candidates: Vec<NoiseCandidate>,
    /// Templates considered by the aggregate query before ranking/caps.
    pub templates_scanned: u64,
    /// Whether the candidate list was truncated by the hard cap.
    pub truncated: bool,
    /// More eligible candidates existed than the caller cap.
    pub candidate_cap_truncated: bool,
    /// More templates existed than the bounded aggregate retained.
    pub template_scan_truncated: bool,
    /// The hard report byte budget stopped candidate construction.
    pub response_bytes_truncated: bool,
    /// Ranked template ids omitted because trusted metadata was unavailable.
    pub metadata_missing_template_ids: Vec<u64>,
    /// Database statements used by this report (hard-capped).
    pub database_query_count: usize,
    /// Explicit product wording for hosts/UIs.
    pub disclaimer: &'static str,
    /// Whether generation was cancelled early.
    pub cancelled: bool,
}

impl NoiseCandidateReport {
    /// Product disclaimer constant.
    pub const DISCLAIMER: &'static str = "\
These are noise/suppression *candidates* for human review only. \
Nothing was auto-suppressed. Activation requires explicit preview and approval \
via the durable noise policy (#671). Severity alone does not define noise.";
}

// ─── Internal fact row ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TemplateFacts {
    template_id: u64,
    event_count: u64,
    source_count: u64,
    error_or_fatal_count: u64,
    warn_count: u64,
    info_count: u64,
    wall_event_count: u64,
    wall_first_ts: Option<i64>,
    wall_last_ts: Option<i64>,
    wall_distinct_buckets: u64,
    wall_peak_bucket_events: u64,
    order_event_count: u64,
    order_first: Option<i64>,
    order_last: Option<i64>,
}

// ─── Pure scoring (unit-testable without I/O) ────────────────────────────────

fn scaled_ratio(numerator: u64, denominator: u64, scale: u64) -> u64 {
    if denominator == 0 {
        return 0;
    }
    let value = (u128::from(numerator) * u128::from(scale)) / u128::from(denominator);
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// Score one template from measured facts. Pure function — no I/O.
///
/// # Contract
///
/// Components (integer, max 100 before penalty):
/// - **volume** (0–40): from corpus share basis points
/// - **time coverage** (0–15): span coverage relative to the corpus
/// - **repetition stability** (0–10): no single coarse bucket dominates
/// - **breadth** (0–20): distinct sources
/// - **level profile** (0–15): dominance of a single non-error level
///
/// Severity penalty (applied after components):
/// - error_or_fatal share ≥ 50% → score = score × 50 / 100
/// - error_or_fatal share ≥ 10% → subtract 15 (floor 0)
/// - pure rare severe (count < MIN and high error share) → not eligible (caller filters)
///
/// Tie-break for ranking is **not** part of score; callers sort by
/// `(score DESC, template_id ASC)`.
pub fn score_noise_candidate_facts(
    facts: &TemplateNoiseFacts,
    corpus_unsuppressed: u64,
    corpus_time_span: Option<(i64, i64)>,
) -> (u32, Vec<NoiseCandidateReasonCode>) {
    let mut reasons = Vec::new();
    let share_bps = scaled_ratio(facts.event_count, corpus_unsuppressed, 10_000);

    // Volume 0–40: 100 bps (1%) → 4 points, cap 40 at 10%+
    let volume = ((share_bps.min(1_000)) / 25).min(40) as u32;
    if facts.event_count >= LARGE_COUNT_OVERRIDE || share_bps >= 200 {
        reasons.push(NoiseCandidateReasonCode::HighFrequency);
    }
    if share_bps >= MIN_SHARE_BPS_FOR_CANDIDATE {
        reasons.push(NoiseCandidateReasonCode::HighCorpusShare);
    }

    // Breadth 0–20
    let breadth = facts.source_count.min(10).saturating_mul(2) as u32;
    if facts.source_count >= 3 {
        reasons.push(NoiseCandidateReasonCode::MultiSourceRepetition);
    }

    // Time coverage 0–15 plus repetition stability 0–10.
    let persistence = persistence_component(facts, corpus_time_span, &mut reasons);
    let repetition_stability =
        repetition_stability_component(facts, corpus_time_span, &mut reasons);

    // Level profile 0–15: modal non-error fraction.
    let stability = stability_component(facts, &mut reasons);

    let mut score = volume
        .saturating_add(breadth)
        .saturating_add(persistence)
        .saturating_add(repetition_stability)
        .saturating_add(stability);

    let error_share_bps = scaled_ratio(facts.error_or_fatal_count, facts.event_count, 10_000);
    if error_share_bps >= 5_000 {
        score = score.saturating_mul(50) / 100;
        reasons.push(NoiseCandidateReasonCode::RepetitiveErrorRisky);
    } else if error_share_bps >= 1_000 {
        score = score.saturating_sub(15);
        reasons.push(NoiseCandidateReasonCode::RepetitiveErrorRisky);
    }

    reasons.sort();
    reasons.dedup();
    (score, reasons)
}

/// Public pure fact view for tests and scoring.
#[derive(Debug, Clone)]
pub struct TemplateNoiseFacts {
    /// Exact template id.
    pub template_id: u64,
    /// Events matching the template in the scanned set.
    pub event_count: u64,
    /// Distinct source identities.
    pub source_count: u64,
    /// Earliest match timestamp/order.
    pub first_ts: i64,
    /// Latest match timestamp/order.
    pub last_ts: i64,
    /// ERROR + FATAL count.
    pub error_or_fatal_count: u64,
    /// WARN + WARNING count.
    pub warn_count: u64,
    /// INFO / empty level count.
    pub info_count: u64,
    /// Distinct coarse time buckets (60s) for burst vs steady.
    pub distinct_buckets: u64,
    /// Largest event count observed in one coarse wall-clock bucket.
    pub peak_bucket_events: u64,
}

fn persistence_component(
    facts: &TemplateNoiseFacts,
    corpus_time_span: Option<(i64, i64)>,
    reasons: &mut Vec<NoiseCandidateReasonCode>,
) -> u32 {
    let Some((corpus_first, corpus_last)) = corpus_time_span else {
        // Order-only and mixed clock domains have no truthful shared duration.
        return 0;
    };
    let span = facts.last_ts.saturating_sub(facts.first_ts).max(0) as u64;
    let corpus_span = corpus_last.saturating_sub(corpus_first).max(0) as u64;
    if corpus_span == 0 || span == 0 {
        return 0;
    }

    let span_coverage = scaled_ratio(span, corpus_span, 100);
    let corpus_minutes = corpus_span.saturating_div(60).saturating_add(1);
    let bucket_coverage = scaled_ratio(facts.distinct_buckets, corpus_minutes, 100);

    // Persistence is relative to this corpus, not an absolute bucket count.
    if span_coverage >= 70 && bucket_coverage >= 20 {
        reasons.push(NoiseCandidateReasonCode::TemporallyPersistent);
        15
    } else if span_coverage >= 70 {
        reasons.push(NoiseCandidateReasonCode::TemporallyPersistent);
        12
    } else if span_coverage >= 40 && bucket_coverage >= 10 {
        9
    } else if span_coverage >= 40 {
        7
    } else if span_coverage >= 20 {
        4
    } else {
        // Short incident bursts remain weak persistence evidence.
        1
    }
}

fn repetition_stability_component(
    facts: &TemplateNoiseFacts,
    corpus_time_span: Option<(i64, i64)>,
    reasons: &mut Vec<NoiseCandidateReasonCode>,
) -> u32 {
    if corpus_time_span.is_none()
        || facts.event_count == 0
        || facts.distinct_buckets < 4
        || facts.peak_bucket_events == 0
    {
        return 0;
    }
    let peak_share_bps = scaled_ratio(facts.peak_bucket_events, facts.event_count, 10_000);
    if peak_share_bps <= 2_500 {
        reasons.push(NoiseCandidateReasonCode::SteadyBackground);
        10
    } else if peak_share_bps <= 5_000 {
        6
    } else {
        0
    }
}

fn stability_component(
    facts: &TemplateNoiseFacts,
    reasons: &mut Vec<NoiseCandidateReasonCode>,
) -> u32 {
    if facts.event_count == 0 {
        return 0;
    }
    let info_share = scaled_ratio(facts.info_count, facts.event_count, 100);
    let warn_share = scaled_ratio(facts.warn_count, facts.event_count, 100);
    if info_share >= 70 {
        reasons.push(NoiseCandidateReasonCode::LevelDominatedInfo);
        15
    } else if warn_share >= 70 {
        reasons.push(NoiseCandidateReasonCode::LevelDominatedWarn);
        12
    } else if info_share + warn_share >= 70 {
        reasons.push(NoiseCandidateReasonCode::LevelDominatedInfo);
        10
    } else {
        4
    }
}

/// Whether pure facts clear the eligibility gate (before score rank).
pub fn template_eligible_for_noise_candidate(
    facts: &TemplateNoiseFacts,
    corpus_unsuppressed: u64,
) -> bool {
    if corpus_unsuppressed < MIN_CORPUS_EVENTS_FOR_CANDIDATES {
        return false;
    }
    if facts.event_count < MIN_TEMPLATE_EVENTS_FOR_CANDIDATE
        && !(facts.event_count >= 5 && facts.source_count >= 3)
    {
        return false;
    }
    let share_bps = scaled_ratio(facts.event_count, corpus_unsuppressed, 10_000);
    if share_bps < MIN_SHARE_BPS_FOR_CANDIDATE && facts.event_count < LARGE_COUNT_OVERRIDE {
        return false;
    }
    // Rare severe: high error share + low absolute count → never propose.
    if facts.error_or_fatal_count > 0
        && facts.event_count < MIN_TEMPLATE_EVENTS_FOR_CANDIDATE
        && facts.error_or_fatal_count.saturating_mul(2) >= facts.event_count
    {
        return false;
    }
    // Pure rare ERROR (count very small relative to corpus)
    if facts.error_or_fatal_count == facts.event_count
        && facts.event_count < MIN_TEMPLATE_EVENTS_FOR_CANDIDATE
    {
        return false;
    }
    // Novel rare: count 1–3 with high severity signal
    if facts.event_count <= 3 && facts.error_or_fatal_count > 0 {
        return false;
    }
    true
}

fn build_explanation(
    reasons: &[NoiseCandidateReasonCode],
    facts: &TemplateNoiseFacts,
    share_bps: u64,
    score: u32,
) -> String {
    let mut parts = Vec::new();
    parts.push(format!(
        "Proposal score {score} from corpus facts only (not confirmed noise)."
    ));
    parts.push(format!(
        "events={}, share_bps={}, sources={}, error_or_fatal={}, warn={}.",
        facts.event_count,
        share_bps,
        facts.source_count,
        facts.error_or_fatal_count,
        facts.warn_count
    ));
    if !reasons.is_empty() {
        let phrases = reasons
            .iter()
            .map(|r| r.human_phrase())
            .collect::<Vec<_>>()
            .join("; ");
        parts.push(format!("Reasons: {phrases}."));
    }
    parts.push("Human preview and activation via durable suppression policy required.".into());
    parts.join(" ")
}

// ─── Detector entry point ────────────────────────────────────────────────────

/// Propose bounded exact-template noise/suppression candidates for one corpus.
///
/// Read-only: does not mutate suppression policy, events, or templates.
pub fn propose_noise_candidates(
    corpus: &LogCorpus,
    options: &NoiseCandidateOptions,
) -> CoreResult<NoiseCandidateReport> {
    propose_noise_candidates_with_cancel(corpus, options, None)
}

/// Same as [`propose_noise_candidates`] with optional cooperative cancellation.
pub fn propose_noise_candidates_with_cancel(
    corpus: &LogCorpus,
    options: &NoiseCandidateOptions,
    cancel: Option<&AtomicBool>,
) -> CoreResult<NoiseCandidateReport> {
    if cancelled(cancel) {
        return Ok(empty_report(corpus, true));
    }

    let max_candidates = options.max_candidates.clamp(1, MAX_NOISE_CANDIDATES);
    let max_reps = options
        .max_representatives
        .clamp(1, MAX_NOISE_REPRESENTATIVES);

    let policy = load_suppression_document(corpus)?;
    let suppressed_ids = policy.enabled_template_ids()?;
    let suppressed_set: HashSet<u64> = suppressed_ids.iter().copied().collect();
    let deadline = Instant::now() + MAX_NOISE_QUERY_DURATION;
    let pinned_template_revision = corpus.template_analysis_revision();
    let query_budget = QueryBudget::default();

    let snapshot_result = corpus.with_connection(|connection| {
        with_query_watchdog(connection, cancel, deadline, || {
            let event_revision = corpus.event_revision();
            let snapshot = load_template_facts(
                connection,
                &suppressed_ids,
                options.include_already_suppressed,
                cancel,
                deadline,
                &query_budget,
            )?;
            Ok((event_revision, snapshot))
        })
    });
    let (event_revision, snapshot) = match snapshot_result {
        Ok(value) => value,
        Err(_) if cancelled(cancel) => {
            return Ok(empty_report_with_meta(
                corpus,
                policy.revision,
                suppressed_ids,
                0,
                0,
                TimeQuality::OrderOnly,
                TimeQuality::OrderOnly,
                corpus.event_revision(),
                pinned_template_revision,
                query_budget.used(),
                true,
            ));
        }
        Err(error) => return Err(error),
    };

    if cancelled(cancel) {
        return Ok(empty_report_with_meta(
            corpus,
            policy.revision,
            suppressed_ids,
            snapshot.unsuppressed_event_count,
            snapshot.corpus_event_count,
            snapshot.time_quality,
            snapshot.raw_time_quality,
            event_revision,
            pinned_template_revision,
            query_budget.used(),
            true,
        ));
    }

    let templates_scanned = snapshot.facts.len() as u64;
    let mut scored: Vec<RankedCandidate> = Vec::new();
    for facts in snapshot.facts {
        let already_suppressed = suppressed_set.contains(&facts.template_id);
        if already_suppressed && !options.include_already_suppressed {
            continue;
        }
        if already_suppressed && facts.event_count == 0 {
            continue;
        }

        let candidate_quality = candidate_time_quality(&facts);
        let score_span = if snapshot.time_quality == TimeQuality::Wall
            && candidate_quality == TimeQuality::Wall
            && !already_suppressed
        {
            snapshot.wall_time_span
        } else if snapshot.raw_time_quality == TimeQuality::Wall
            && candidate_quality == TimeQuality::Wall
            && already_suppressed
        {
            snapshot.raw_wall_time_span
        } else {
            None
        };
        let pure = pure_facts(&facts);
        let share_denominator = if already_suppressed {
            snapshot.corpus_event_count
        } else {
            snapshot.unsuppressed_event_count
        };
        if !already_suppressed && !template_eligible_for_noise_candidate(&pure, share_denominator) {
            continue;
        }

        let (mut score, mut reasons) =
            score_noise_candidate_facts(&pure, share_denominator, score_span);
        if already_suppressed {
            reasons.push(NoiseCandidateReasonCode::AlreadySuppressed);
            reasons.sort();
            reasons.dedup();
            score = score.saturating_div(2);
        } else if score < MIN_PROPOSAL_SCORE {
            continue;
        }
        scored.push(RankedCandidate {
            score,
            facts,
            reasons,
            already_suppressed,
        });
    }

    scored.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.facts.template_id.cmp(&right.facts.template_id))
    });
    let candidate_cap_truncated = scored.len() > max_candidates;
    let metadata_pool_cap = max_candidates.saturating_add(MAX_NOISE_CANDIDATES);
    scored.truncate(metadata_pool_cap);

    let metadata_ids = scored
        .iter()
        .map(|candidate| candidate.facts.template_id)
        .collect::<Vec<_>>();
    let metadata = corpus.template_candidate_metadata(&metadata_ids, 256, 4_096);
    if corpus.template_analysis_revision() != pinned_template_revision {
        return Err(CoreError::Message(
            "stale noise candidate snapshot: template metadata changed".into(),
        ));
    }

    let mut metadata_missing_template_ids = Vec::new();
    let mut selected = Vec::with_capacity(max_candidates);
    for candidate in scored {
        let Some((fingerprint, _)) = metadata.get(&candidate.facts.template_id) else {
            metadata_missing_template_ids.push(candidate.facts.template_id);
            continue;
        };
        if safe_template_fingerprint(fingerprint).is_none() {
            metadata_missing_template_ids.push(candidate.facts.template_id);
            continue;
        }
        selected.push(candidate);
        if selected.len() == max_candidates {
            break;
        }
    }
    let selected_ids = selected
        .iter()
        .map(|candidate| candidate.facts.template_id)
        .collect::<Vec<_>>();

    let details_result = corpus.with_connection(|connection| {
        with_query_watchdog(connection, cancel, deadline, || {
            let current_revision = corpus.event_revision();
            if current_revision != event_revision {
                return Err(CoreError::Message(
                    "stale noise candidate snapshot: events changed".into(),
                ));
            }
            let levels =
                load_level_counts(connection, &selected_ids, cancel, deadline, &query_budget)?;
            let representatives = load_representatives(
                connection,
                &selected_ids,
                max_reps,
                cancel,
                deadline,
                &query_budget,
            )?;
            Ok((levels, representatives))
        })
    });
    let (levels_by_template, representatives_by_template) = match details_result {
        Ok(value) => value,
        Err(_) if cancelled(cancel) => {
            return Ok(empty_report_with_meta(
                corpus,
                policy.revision,
                suppressed_ids,
                snapshot.unsuppressed_event_count,
                snapshot.corpus_event_count,
                snapshot.time_quality,
                snapshot.raw_time_quality,
                event_revision,
                pinned_template_revision,
                query_budget.used(),
                true,
            ));
        }
        Err(error) => return Err(error),
    };

    if corpus.event_revision() != event_revision {
        return Err(CoreError::Message(
            "stale noise candidate snapshot: events changed".into(),
        ));
    }
    if corpus.template_analysis_revision() != pinned_template_revision {
        return Err(CoreError::Message(
            "stale noise candidate snapshot: template metadata changed".into(),
        ));
    }
    let current_policy = load_suppression_document(corpus)?;
    if current_policy.revision != policy.revision
        || current_policy.enabled_template_ids()? != suppressed_ids
    {
        return Err(CoreError::Message(
            "stale noise candidate snapshot: suppression policy changed".into(),
        ));
    }

    let mut candidates = Vec::with_capacity(selected.len());
    for ranked in selected {
        let template_id = ranked.facts.template_id;
        let Some((fingerprint, raw_pattern)) = metadata.get(&template_id) else {
            continue;
        };
        let pure = pure_facts(&ranked.facts);
        let share_denominator = if ranked.already_suppressed {
            snapshot.corpus_event_count
        } else {
            snapshot.unsuppressed_event_count
        };
        let share_bps = scaled_ratio(pure.event_count, share_denominator, 10_000).min(10_000);
        let representatives = representatives_by_template
            .get(&template_id)
            .cloned()
            .unwrap_or_default();
        let level_distribution = levels_by_template
            .get(&template_id)
            .cloned()
            .unwrap_or_default();
        if level_distribution.displayed.is_empty() {
            return Err(CoreError::Message(format!(
                "noise candidate {template_id} has no level distribution"
            )));
        }
        let represented_level_count = level_distribution
            .displayed
            .iter()
            .fold(level_distribution.other_count, |total, level| {
                total.saturating_add(level.count)
            });
        if represented_level_count != pure.event_count {
            return Err(CoreError::Message(format!(
                "noise candidate {template_id} level distribution is incomplete"
            )));
        }
        let Some(template_fingerprint) = safe_template_fingerprint(fingerprint) else {
            continue;
        };
        let candidate = NoiseCandidate {
            template_id,
            template_fingerprint,
            pattern: safe_display_text(raw_pattern, MAX_NOISE_PATTERN_BYTES),
            score: ranked.score,
            event_count: pure.event_count,
            corpus_share_bps: share_bps,
            source_count: pure.source_count,
            time_quality: candidate_time_quality(&ranked.facts),
            wall_time_span: optional_span(ranked.facts.wall_first_ts, ranked.facts.wall_last_ts),
            order_span: optional_span(ranked.facts.order_first, ranked.facts.order_last),
            level_counts: level_distribution.displayed,
            other_level_count: level_distribution.other_count,
            level_counts_truncated: level_distribution.other_count > 0,
            error_or_fatal_count: pure.error_or_fatal_count,
            warn_count: pure.warn_count,
            info_count: pure.info_count,
            reason_codes: ranked.reasons.clone(),
            explanation: build_explanation(&ranked.reasons, &pure, share_bps, ranked.score),
            already_suppressed: ranked.already_suppressed,
            share_basis: if ranked.already_suppressed {
                "raw_corpus"
            } else {
                "unsuppressed_corpus"
            },
            proposal_kind: "suppression_candidate",
            representatives,
        };
        candidates.push(candidate);
    }

    let mut report = NoiseCandidateReport {
        corpus_id: corpus.id().to_string(),
        unsuppressed_event_count: snapshot.unsuppressed_event_count,
        corpus_event_count: snapshot.corpus_event_count,
        suppression_revision: policy.revision,
        event_revision,
        template_analysis_revision: pinned_template_revision,
        already_suppressed_template_ids: suppressed_ids,
        time_quality: snapshot.time_quality,
        raw_time_quality: snapshot.raw_time_quality,
        candidates,
        templates_scanned,
        truncated: candidate_cap_truncated || snapshot.template_scan_truncated,
        candidate_cap_truncated,
        template_scan_truncated: snapshot.template_scan_truncated,
        response_bytes_truncated: false,
        metadata_missing_template_ids,
        database_query_count: query_budget.used(),
        disclaimer: NoiseCandidateReport::DISCLAIMER,
        cancelled: false,
    };
    enforce_serialized_report_limit(&mut report)?;
    Ok(report)
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn empty_report(corpus: &LogCorpus, cancelled: bool) -> NoiseCandidateReport {
    empty_report_with_meta(
        corpus,
        0,
        Vec::new(),
        0,
        0,
        TimeQuality::OrderOnly,
        TimeQuality::OrderOnly,
        corpus.event_revision(),
        corpus.template_analysis_revision(),
        0,
        cancelled,
    )
}

#[allow(clippy::too_many_arguments)]
fn empty_report_with_meta(
    corpus: &LogCorpus,
    suppression_revision: u64,
    already_suppressed_template_ids: Vec<u64>,
    unsuppressed_event_count: u64,
    corpus_event_count: u64,
    time_quality: TimeQuality,
    raw_time_quality: TimeQuality,
    event_revision: u64,
    template_analysis_revision: u64,
    database_query_count: usize,
    cancelled: bool,
) -> NoiseCandidateReport {
    NoiseCandidateReport {
        corpus_id: corpus.id().to_string(),
        unsuppressed_event_count,
        corpus_event_count,
        suppression_revision,
        event_revision,
        template_analysis_revision,
        already_suppressed_template_ids,
        time_quality,
        raw_time_quality,
        candidates: Vec::new(),
        templates_scanned: 0,
        truncated: false,
        candidate_cap_truncated: false,
        template_scan_truncated: false,
        response_bytes_truncated: false,
        metadata_missing_template_ids: Vec::new(),
        database_query_count,
        disclaimer: NoiseCandidateReport::DISCLAIMER,
        cancelled,
    }
}

fn bound_text(value: &str, max_bytes: usize) -> String {
    let one_line = value.replace(['\r', '\n'], " ");
    if one_line.len() <= max_bytes {
        return one_line;
    }
    let keep = max_bytes.saturating_sub('…'.len_utf8());
    format!("{}…", crate::text::truncate_bytes(&one_line, keep))
}

fn redact_excerpt(message: &str) -> String {
    // Match suppression-preview posture: full scrub via redact_candidate; blocked
    // credential-dominant lines become a typed placeholder (never raw payload).
    let scrubbed = redact_message(message);
    let r = redact_candidate(&scrubbed);
    let text = if r.blocked {
        "[credential-dominant event redacted]".to_string()
    } else {
        r.text
    };
    bound_text(&text, MAX_NOISE_REPRESENTATIVE_EXCERPT_BYTES)
}

fn safe_excerpt(message: &str) -> String {
    let redacted = redact_excerpt(message);
    if contains_forbidden_sentinel(&redacted) {
        "[protected evaluator marker omitted]".into()
    } else {
        redacted
    }
}

fn redact_display_text(value: &str, max_bytes: usize) -> String {
    let scrubbed = redact_message(value);
    let redacted = redact_candidate(&scrubbed);
    if redacted.blocked {
        "[sensitive display text redacted]".into()
    } else {
        bound_text(&redacted.text, max_bytes)
    }
}

fn safe_display_text(value: &str, max_bytes: usize) -> String {
    let redacted = redact_display_text(value, max_bytes);
    if contains_forbidden_sentinel(&redacted) {
        "[protected evaluator marker omitted]".into()
    } else {
        redacted
    }
}

fn safe_template_fingerprint(value: &str) -> Option<String> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.chars().any(char::is_control)
        || contains_forbidden_sentinel(value)
    {
        return None;
    }
    let redacted = redact_display_text(value, 256);
    (redacted == value).then_some(redacted)
}

#[derive(Debug)]
struct RankedCandidate {
    score: u32,
    facts: TemplateFacts,
    reasons: Vec<NoiseCandidateReasonCode>,
    already_suppressed: bool,
}

#[derive(Debug)]
struct TemplateFactsSnapshot {
    corpus_event_count: u64,
    unsuppressed_event_count: u64,
    template_scan_truncated: bool,
    time_quality: TimeQuality,
    wall_time_span: Option<(i64, i64)>,
    raw_time_quality: TimeQuality,
    raw_wall_time_span: Option<(i64, i64)>,
    facts: Vec<TemplateFacts>,
}

#[derive(Debug, Default)]
struct QueryBudget {
    used: Cell<usize>,
}

impl QueryBudget {
    fn begin(&self, cancel: Option<&AtomicBool>, deadline: Instant) -> CoreResult<()> {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "noise candidate generation cancelled".into(),
            ));
        }
        if Instant::now() >= deadline {
            return Err(CoreError::Message(format!(
                "noise candidate database work exceeded {:?}",
                MAX_NOISE_QUERY_DURATION
            )));
        }
        let used = self.used.get();
        if used >= MAX_NOISE_QUERY_COUNT {
            return Err(CoreError::Message(format!(
                "noise candidate database query limit exceeded ({MAX_NOISE_QUERY_COUNT})"
            )));
        }
        self.used.set(used + 1);
        Ok(())
    }

    fn used(&self) -> usize {
        self.used.get()
    }
}

fn load_template_facts(
    connection: &Connection,
    suppressed_ids: &[u64],
    include_already_suppressed: bool,
    cancel: Option<&AtomicBool>,
    deadline: Instant,
    query_budget: &QueryBudget,
) -> CoreResult<TemplateFactsSnapshot> {
    query_budget.begin(cancel, deadline)?;
    let suppressed_sql = sql_u64_list(suppressed_ids);
    let active_predicate = if suppressed_ids.is_empty() {
        "TRUE".to_string()
    } else {
        format!("template_id NOT IN ({suppressed_sql})")
    };
    let stats_sql = format!(
        r#"
        SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN active_timestamp_basis
                IN ('explicit_wall', 'resolved_local') THEN 1 ELSE 0 END), 0),
            MIN(CASE WHEN active_timestamp_basis
                IN ('explicit_wall', 'resolved_local') THEN ts END),
            MAX(CASE WHEN active_timestamp_basis
                IN ('explicit_wall', 'resolved_local') THEN ts END),
            COALESCE(SUM(CASE WHEN {active_predicate}
                THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN {active_predicate}
                AND active_timestamp_basis IN ('explicit_wall', 'resolved_local')
                THEN 1 ELSE 0 END), 0),
            MIN(CASE WHEN {active_predicate}
                AND active_timestamp_basis IN ('explicit_wall', 'resolved_local')
                THEN ts END),
            MAX(CASE WHEN {active_predicate}
                AND active_timestamp_basis IN ('explicit_wall', 'resolved_local')
                THEN ts END)
        FROM events
        "#
    );
    let (
        total,
        raw_wall,
        raw_wall_min,
        raw_wall_max,
        unsuppressed,
        unsuppressed_wall,
        unsuppressed_wall_min,
        unsuppressed_wall_max,
    ) = connection
        .query_row(&stats_sql, [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|error| CoreError::Message(format!("noise candidate corpus stats: {error}")))?;
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "noise candidate generation cancelled".into(),
        ));
    }

    query_budget.begin(cancel, deadline)?;
    let reserved_suppressed = if include_already_suppressed {
        suppressed_ids.len().min(MAX_TEMPLATES_SCANNED)
    } else {
        0
    };
    let active_template_limit = MAX_TEMPLATES_SCANNED.saturating_sub(reserved_suppressed);
    let active_window_limit = active_template_limit.saturating_add(1);
    let suppressed_union_sql = if include_already_suppressed && !suppressed_ids.is_empty() {
        format!(
            "UNION
             SELECT DISTINCT template_id
             FROM events
             WHERE template_id IN ({suppressed_sql})"
        )
    } else {
        String::new()
    };
    let sql = format!(
        r#"
        WITH active_template_counts AS (
            SELECT template_id, COUNT(*) AS event_count
            FROM events
            WHERE {active_predicate}
            GROUP BY template_id
        ),
        active_window AS (
            SELECT template_id, event_count
            FROM active_template_counts
            ORDER BY event_count DESC, template_id ASC
            LIMIT {active_window_limit}
        ),
        selection_meta AS (
            SELECT COUNT(*) > {active_template_limit} AS template_scan_truncated
            FROM active_window
        ),
        selected_active AS (
            SELECT template_id
            FROM active_window
            ORDER BY event_count DESC, template_id ASC
            LIMIT {active_template_limit}
        ),
        candidate_ids AS (
            SELECT template_id
            FROM selected_active
            {suppressed_union_sql}
        ),
        wall_buckets AS (
            SELECT events.template_id,
                   CAST(FLOOR(ts / 60.0) AS BIGINT) AS minute_bucket,
                   COUNT(*) AS bucket_events
            FROM events
            INNER JOIN candidate_ids
                ON candidate_ids.template_id = events.template_id
            WHERE active_timestamp_basis IN ('explicit_wall', 'resolved_local')
            GROUP BY events.template_id, minute_bucket
        ),
        wall_bucket_stats AS (
            SELECT template_id,
                   COUNT(*) AS wall_distinct_buckets,
                   MAX(bucket_events) AS wall_peak_bucket_events
            FROM wall_buckets
            GROUP BY template_id
        ),
        per_template AS (
            SELECT
                events.template_id,
                COUNT(*) AS event_count,
                COUNT(DISTINCT source) AS source_count,
                COALESCE(SUM(CASE WHEN lower(level) IN ('error', 'fatal') THEN 1 ELSE 0 END), 0)
                    AS error_or_fatal_count,
                COALESCE(SUM(CASE WHEN lower(level) IN ('warn', 'warning') THEN 1 ELSE 0 END), 0)
                    AS warn_count,
                COALESCE(SUM(CASE WHEN lower(level) IN ('info', '') OR level IS NULL THEN 1 ELSE 0 END), 0)
                    AS info_count,
                COALESCE(SUM(CASE WHEN active_timestamp_basis
                    IN ('explicit_wall', 'resolved_local') THEN 1 ELSE 0 END), 0)
                    AS wall_event_count,
                MIN(CASE WHEN active_timestamp_basis
                    IN ('explicit_wall', 'resolved_local') THEN ts END) AS wall_first_ts,
                MAX(CASE WHEN active_timestamp_basis
                    IN ('explicit_wall', 'resolved_local') THEN ts END) AS wall_last_ts,
                COALESCE(MAX(wall_bucket_stats.wall_distinct_buckets), 0)
                    AS wall_distinct_buckets,
                COALESCE(MAX(wall_bucket_stats.wall_peak_bucket_events), 0)
                    AS wall_peak_bucket_events,
                COALESCE(SUM(CASE WHEN active_timestamp_basis
                    NOT IN ('explicit_wall', 'resolved_local')
                    OR active_timestamp_basis IS NULL THEN 1 ELSE 0 END), 0)
                    AS order_event_count,
                MIN(CASE WHEN active_timestamp_basis
                    NOT IN ('explicit_wall', 'resolved_local')
                    OR active_timestamp_basis IS NULL THEN seq END) AS order_first,
                MAX(CASE WHEN active_timestamp_basis
                    NOT IN ('explicit_wall', 'resolved_local')
                    OR active_timestamp_basis IS NULL THEN seq END) AS order_last
            FROM events
            INNER JOIN candidate_ids
                ON candidate_ids.template_id = events.template_id
            LEFT JOIN wall_bucket_stats
                ON wall_bucket_stats.template_id = events.template_id
            GROUP BY events.template_id
        )
        SELECT per_template.template_id, per_template.event_count,
               per_template.source_count, per_template.error_or_fatal_count,
               per_template.warn_count, per_template.info_count,
               per_template.wall_event_count, per_template.wall_first_ts,
               per_template.wall_last_ts, per_template.wall_distinct_buckets,
               per_template.wall_peak_bucket_events,
               per_template.order_event_count, per_template.order_first,
               per_template.order_last, selection_meta.template_scan_truncated
        FROM selection_meta
        LEFT JOIN per_template ON TRUE
        ORDER BY per_template.event_count DESC NULLS LAST,
                 per_template.template_id ASC NULLS LAST
        "#
    );

    let mut facts = Vec::new();
    let mut template_scan_truncated = false;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::Message(format!("noise aggregate prepare: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, bool>(14)?,
            ))
        })
        .map_err(|error| CoreError::Message(format!("noise aggregate query: {error}")))?;
    for row in rows {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "noise candidate generation cancelled".into(),
            ));
        }
        let (
            template_id,
            event_count,
            source_count,
            error_or_fatal_count,
            warn_count,
            info_count,
            wall_event_count,
            wall_first_ts,
            wall_last_ts,
            wall_distinct_buckets,
            wall_peak_bucket_events,
            order_event_count,
            order_first,
            order_last,
            scan_truncated,
        ) = row.map_err(|error| CoreError::Message(format!("noise aggregate row: {error}")))?;
        template_scan_truncated |= scan_truncated;
        let Some(template_id) = template_id else {
            continue;
        };
        facts.push(TemplateFacts {
            template_id: u64::try_from(template_id)
                .map_err(|_| CoreError::Message("negative template id".into()))?,
            event_count: event_count.unwrap_or(0).max(0) as u64,
            source_count: source_count.unwrap_or(0).max(0) as u64,
            error_or_fatal_count: error_or_fatal_count.unwrap_or(0).max(0) as u64,
            warn_count: warn_count.unwrap_or(0).max(0) as u64,
            info_count: info_count.unwrap_or(0).max(0) as u64,
            wall_event_count: wall_event_count.unwrap_or(0).max(0) as u64,
            wall_first_ts,
            wall_last_ts,
            wall_distinct_buckets: wall_distinct_buckets.unwrap_or(0).max(0) as u64,
            wall_peak_bucket_events: wall_peak_bucket_events.unwrap_or(0).max(0) as u64,
            order_event_count: order_event_count.unwrap_or(0).max(0) as u64,
            order_first,
            order_last,
        });
    }

    let corpus_total = total.max(0) as u64;
    let unsuppressed = unsuppressed.max(0) as u64;
    let time_quality = match (unsuppressed as i64, unsuppressed_wall.max(0)) {
        (0, _) | (_, 0) => TimeQuality::OrderOnly,
        (t, w) if t == w => TimeQuality::Wall,
        _ => TimeQuality::Mixed,
    };
    let wall_time_span = match (unsuppressed_wall_min, unsuppressed_wall_max) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    let raw_time_quality = match (total.max(0), raw_wall.max(0)) {
        (0, _) | (_, 0) => TimeQuality::OrderOnly,
        (t, w) if t == w => TimeQuality::Wall,
        _ => TimeQuality::Mixed,
    };
    let raw_wall_time_span = match (raw_wall_min, raw_wall_max) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    Ok(TemplateFactsSnapshot {
        corpus_event_count: corpus_total,
        unsuppressed_event_count: unsuppressed,
        template_scan_truncated,
        time_quality,
        wall_time_span,
        raw_time_quality,
        raw_wall_time_span,
        facts,
    })
}

#[derive(Debug, Clone, Default)]
struct LevelDistribution {
    displayed: Vec<SuppressionLevelCount>,
    other_count: u64,
}

fn load_level_counts(
    connection: &Connection,
    template_ids: &[u64],
    cancel: Option<&AtomicBool>,
    deadline: Instant,
    query_budget: &QueryBudget,
) -> CoreResult<HashMap<u64, LevelDistribution>> {
    if template_ids.is_empty() {
        return Ok(HashMap::new());
    }
    query_budget.begin(cancel, deadline)?;
    let ids = sql_u64_list(template_ids);
    let sql = format!(
        r#"
        WITH counts AS (
            SELECT template_id, COALESCE(level, '') AS level, COUNT(*) AS count
            FROM events
            WHERE template_id IN ({ids})
            GROUP BY template_id, level
        ),
        ranked AS (
            SELECT template_id, level, count,
                   ROW_NUMBER() OVER (
                       PARTITION BY template_id
                       ORDER BY count DESC, level ASC
                   ) AS level_rank
            FROM counts
        )
        SELECT template_id,
               CASE WHEN level_rank <= {MAX_NOISE_LEVEL_BUCKETS}
                    THEN level ELSE '' END AS displayed_level,
               SUM(count) AS count,
               level_rank > {MAX_NOISE_LEVEL_BUCKETS} AS is_other
        FROM ranked
        GROUP BY template_id, is_other, displayed_level
        ORDER BY template_id ASC, is_other ASC, displayed_level ASC
        "#
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::Message(format!("noise level prepare: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })
        .map_err(|error| CoreError::Message(format!("noise level query: {error}")))?;
    let mut by_template: HashMap<u64, LevelDistribution> = HashMap::new();
    for row in rows {
        let (template_id, level, count, is_other) =
            row.map_err(|error| CoreError::Message(format!("noise level row: {error}")))?;
        let template_id = u64::try_from(template_id)
            .map_err(|_| CoreError::Message("negative template id".into()))?;
        let count = count.max(0) as u64;
        if is_other {
            by_template.entry(template_id).or_default().other_count = count;
            continue;
        }
        let level = if level.is_empty() {
            "<unset>".into()
        } else {
            safe_display_text(&level, 64)
        };
        by_template
            .entry(template_id)
            .or_default()
            .displayed
            .push(SuppressionLevelCount { level, count });
    }
    Ok(by_template)
}

fn load_representatives(
    connection: &Connection,
    template_ids: &[u64],
    limit: usize,
    cancel: Option<&AtomicBool>,
    deadline: Instant,
    query_budget: &QueryBudget,
) -> CoreResult<HashMap<u64, Vec<NoiseCandidateRepresentative>>> {
    if template_ids.is_empty() {
        return Ok(HashMap::new());
    }
    query_budget.begin(cancel, deadline)?;
    let ids = sql_u64_list(template_ids);
    let limit = limit.clamp(1, MAX_NOISE_REPRESENTATIVES);
    let sql = format!(
        r#"
        WITH bounded AS (
            SELECT template_id, seq, ts,
                   LEFT(source, 512) AS source,
                   LEFT(level, 256) AS level,
                   LEFT(message, 4096) AS message,
                   active_timestamp_basis
            FROM events
            WHERE template_id IN ({ids})
        ),
        per_source AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                       PARTITION BY template_id, source
                       ORDER BY seq ASC, ts ASC, level ASC,
                                message ASC, active_timestamp_basis ASC
                   ) AS source_rank
            FROM bounded
        ),
        ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                       PARTITION BY template_id
                       ORDER BY source_rank ASC, source ASC, seq ASC, ts ASC,
                                level ASC, message ASC,
                                active_timestamp_basis ASC
                   ) AS candidate_rank
            FROM per_source
        )
        SELECT template_id, seq, ts, source, level, message,
               active_timestamp_basis
        FROM ranked
        WHERE candidate_rank <= {limit}
        ORDER BY template_id ASC, candidate_rank ASC
        "#
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::Message(format!("noise rep prepare: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|error| CoreError::Message(format!("noise rep query: {error}")))?;
    let mut by_template: HashMap<u64, Vec<NoiseCandidateRepresentative>> = HashMap::new();
    for row in rows {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "noise candidate generation cancelled".into(),
            ));
        }
        let (template_id, seq, ts, source, level, message, active_timestamp_basis) =
            row.map_err(|error| CoreError::Message(format!("noise rep row: {error}")))?;
        let template_id = u64::try_from(template_id)
            .map_err(|_| CoreError::Message("negative template id".into()))?;
        by_template
            .entry(template_id)
            .or_default()
            .push(NoiseCandidateRepresentative {
                seq: u64::try_from(seq)
                    .map_err(|_| CoreError::Message("negative event seq".into()))?,
                source: safe_display_text(&source, 256),
                timestamp: ts,
                time_quality: match active_timestamp_basis.as_deref() {
                    Some("explicit_wall" | "resolved_local") => TimeQuality::Wall,
                    _ => TimeQuality::OrderOnly,
                },
                level: safe_display_text(&level, 64),
                redacted_excerpt: safe_excerpt(&message),
            });
    }
    Ok(by_template)
}

fn candidate_time_quality(facts: &TemplateFacts) -> TimeQuality {
    match (facts.wall_event_count, facts.order_event_count) {
        (0, _) => TimeQuality::OrderOnly,
        (_, 0) => TimeQuality::Wall,
        _ => TimeQuality::Mixed,
    }
}

fn pure_facts(facts: &TemplateFacts) -> TemplateNoiseFacts {
    TemplateNoiseFacts {
        template_id: facts.template_id,
        event_count: facts.event_count,
        source_count: facts.source_count,
        first_ts: facts.wall_first_ts.unwrap_or(0),
        last_ts: facts.wall_last_ts.unwrap_or(0),
        error_or_fatal_count: facts.error_or_fatal_count,
        warn_count: facts.warn_count,
        info_count: facts.info_count,
        distinct_buckets: facts.wall_distinct_buckets,
        peak_bucket_events: facts.wall_peak_bucket_events,
    }
}

fn optional_span(first: Option<i64>, last: Option<i64>) -> Option<SuppressionTimeSpan> {
    match (first, last) {
        (Some(from), Some(to)) => Some(SuppressionTimeSpan { from, to }),
        _ => None,
    }
}

fn sql_u64_list(values: &[u64]) -> String {
    if values.is_empty() {
        "NULL".into()
    } else {
        values
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn serialized_report_len(report: &NoiseCandidateReport) -> CoreResult<usize> {
    serde_json::to_vec(report)
        .map(|bytes| bytes.len())
        .map_err(|error| CoreError::Message(format!("serialize noise candidate report: {error}")))
}

fn enforce_serialized_report_limit(report: &mut NoiseCandidateReport) -> CoreResult<()> {
    if serialized_report_len(report)? <= MAX_NOISE_REPORT_BYTES {
        return Ok(());
    }
    report.response_bytes_truncated = true;
    report.truncated = true;
    while serialized_report_len(report)? > MAX_NOISE_REPORT_BYTES {
        if report.candidates.pop().is_none() {
            return Err(CoreError::Message(format!(
                "noise candidate report metadata exceeds {MAX_NOISE_REPORT_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

fn with_query_watchdog<T>(
    connection: &Connection,
    cancel: Option<&AtomicBool>,
    deadline: Instant,
    operation: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
    let completed = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);
    let interrupt = connection.interrupt_handle();
    let result = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !completed.load(Ordering::SeqCst) {
                if cancelled(cancel) {
                    interrupt.interrupt();
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                if Instant::now() >= deadline {
                    timed_out.store(true, Ordering::SeqCst);
                    interrupt.interrupt();
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let result = operation();
        completed.store(true, Ordering::SeqCst);
        result
    });
    if timed_out.load(Ordering::SeqCst) {
        return Err(CoreError::Message(format!(
            "noise candidate database work exceeded {:?}",
            MAX_NOISE_QUERY_DURATION
        )));
    }
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "noise candidate generation cancelled".into(),
        ));
    }
    result
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::suppression::{
        activate_template_suppression, preview_template_suppression, ActivateSuppressionPreview,
        NewSuppressionPreview, SuppressionRuleOrigin,
    };
    use crate::log_analysis::{
        ActiveTimestampBasis, LogEvent, TemplateInfo, TemplateRow, TimestampProvenance,
    };
    use std::sync::Arc;
    use tempfile::tempdir;

    fn wall_event(
        seq: u64,
        ts: i64,
        level: &str,
        template_id: u64,
        message: &str,
        source: &str,
    ) -> LogEvent {
        LogEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: level.into(),
            service: Some("svc".into()),
            host: Some("host".into()),
            template_id,
            params: vec![],
            trace_id: None,
            message: message.into(),
            source: source.into(),
        }
    }

    fn order_event(
        seq: u64,
        level: &str,
        template_id: u64,
        message: &str,
        source: &str,
    ) -> LogEvent {
        let mut event = wall_event(seq, seq as i64, level, template_id, message, source);
        event.timestamp_provenance = TimestampProvenance::OrderOnly;
        event.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        event
    }

    fn upsert_template(
        corpus: &LogCorpus,
        template_id: u64,
        pattern: &str,
        count: u64,
        severity: u8,
    ) {
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: pattern.into(),
                    token_count: pattern.split_whitespace().count(),
                    count,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000 + count as i64,
                    severity,
                    example: pattern.into(),
                },
                content_hash: format!("fp-{template_id}"),
                vector: None,
            }])
            .unwrap();
    }

    fn corpus_with(
        name: &str,
        templates: &[(u64, &str, u64, u8)],
        events: Vec<LogEvent>,
    ) -> (tempfile::TempDir, Arc<LogCorpus>) {
        let dir = tempdir().unwrap();
        let cache = dir.path().join("cache");
        let corpus = Arc::new(LogCorpus::create(&cache, name).unwrap());
        for (id, pattern, count, sev) in templates {
            upsert_template(&corpus, *id, pattern, *count, *sev);
        }
        if !events.is_empty() {
            corpus.push_events(&events).unwrap();
        }
        corpus.flush().unwrap();
        (dir, corpus)
    }

    #[test]
    fn steady_repetitive_info_is_proposed() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..80 {
            events.push(wall_event(
                seq,
                1_700_000_000 + (i * 60),
                "INFO",
                1,
                "heartbeat ok",
                if i % 2 == 0 { "a.log" } else { "b.log" },
            ));
            seq += 1;
        }
        // Filler so corpus is large enough and share is meaningful.
        for i in 0..100 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                2,
                "other message",
                "c.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "steady-info",
            &[(1, "heartbeat ok", 80, 1), (2, "other message", 40, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(
            !report.disclaimer.contains("confirmed noise") || report.disclaimer.contains("not")
        );
        assert!(report.disclaimer.contains("candidates"));
        assert!(report.candidates.iter().any(|c| c.template_id == 1));
        let hit = report
            .candidates
            .iter()
            .find(|c| c.template_id == 1)
            .unwrap();
        assert!(hit.score > 0);
        assert!(
            hit.reason_codes
                .contains(&NoiseCandidateReasonCode::HighFrequency)
                || hit
                    .reason_codes
                    .contains(&NoiseCandidateReasonCode::HighCorpusShare)
        );
        assert_eq!(hit.proposal_kind, "suppression_candidate");
        assert!(
            !hit.explanation.to_lowercase().contains("confirmed noise")
                || hit.explanation.contains("not confirmed")
        );
    }

    #[test]
    fn repetitive_error_is_proposed_with_risk_disclosure() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..60 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 30,
                "ERROR",
                7,
                "connection reset by peer",
                "api.log",
            ));
            seq += 1;
        }
        for i in 0..60 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                8,
                "ok",
                "other.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "risky-error",
            &[(7, "connection reset by peer", 60, 4), (8, "ok", 60, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let hit = report
            .candidates
            .iter()
            .find(|c| c.template_id == 7)
            .expect("repetitive ERROR should still be proposable with risk flags");
        assert!(hit.error_or_fatal_count >= 60);
        assert!(hit
            .reason_codes
            .contains(&NoiseCandidateReasonCode::RepetitiveErrorRisky));
        assert!(hit.explanation.contains("ERROR") || hit.explanation.contains("error_or_fatal"));
    }

    #[test]
    fn rare_severe_is_not_proposed() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..100 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                1,
                "chatter",
                "a.log",
            ));
            seq += 1;
        }
        // Rare severe: 2 ERROR events on unique template
        events.push(wall_event(
            seq,
            1_700_000_500,
            "ERROR",
            99,
            "UNIQUE_SEVERE_INCIDENT token=abc",
            "db.log",
        ));
        seq += 1;
        events.push(wall_event(
            seq,
            1_700_000_501,
            "FATAL",
            99,
            "UNIQUE_SEVERE_INCIDENT token=abc",
            "db.log",
        ));
        let (_dir, corpus) = corpus_with(
            "rare-severe",
            &[
                (1, "chatter", 100, 1),
                (99, "UNIQUE_SEVERE_INCIDENT token=<*>", 2, 5),
            ],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(
            report.candidates.iter().all(|c| c.template_id != 99),
            "rare severe must not be proposed: {:?}",
            report.candidates
        );
    }

    #[test]
    fn bursty_incident_ranks_below_steady_background() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        // Steady background: template 1 across long span, many buckets
        for i in 0..100 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 120,
                "INFO",
                1,
                "steady chatter",
                "steady.log",
            ));
            seq += 1;
        }
        // Bursty peer: same INFO severity, all in 30 seconds. The score
        // difference must come from temporal shape rather than severity.
        for i in 0..40 {
            events.push(wall_event(
                seq,
                1_700_050_000 + i,
                "INFO",
                2,
                "burst chatter",
                "burst.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "burst-vs-steady",
            &[(1, "steady chatter", 100, 1), (2, "burst chatter", 100, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let steady = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("steady candidate");
        let burst = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 2)
            .expect("equal-volume burst candidate");
        assert!(
            steady.score > burst.score,
            "steady score {} should exceed equal-volume burst {}",
            steady.score,
            burst.score
        );
        assert!(steady
            .reason_codes
            .contains(&NoiseCandidateReasonCode::SteadyBackground));
        assert!(!burst
            .reason_codes
            .contains(&NoiseCandidateReasonCode::SteadyBackground));
    }

    #[test]
    fn multi_source_repetition_sets_reason() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        let sources = ["s1.log", "s2.log", "s3.log", "s4.log"];
        for i in 0..40 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 10,
                "INFO",
                3,
                "multi source noise",
                sources[i as usize % sources.len()],
            ));
            seq += 1;
        }
        for i in 0..20 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                4,
                "filler",
                "f.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "multi-source",
            &[(3, "multi source noise", 40, 1), (4, "filler", 20, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let hit = report
            .candidates
            .iter()
            .find(|c| c.template_id == 3)
            .expect("multi-source candidate");
        assert!(hit.source_count >= 3);
        assert!(hit
            .reason_codes
            .contains(&NoiseCandidateReasonCode::MultiSourceRepetition));
    }

    #[test]
    fn already_suppressed_is_distinguished_and_policy_untouched() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..50 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 10,
                "INFO",
                5,
                "suppress me",
                "a.log",
            ));
            seq += 1;
        }
        for i in 0..50 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                6,
                "keep me",
                "b.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "already-suppressed",
            &[(5, "suppress me", 50, 1), (6, "keep me", 50, 1)],
            events,
        );
        let before = load_suppression_document(&corpus).unwrap();
        let preview = preview_template_suppression(
            &corpus,
            before.revision,
            NewSuppressionPreview {
                name: "hide suppress me".into(),
                rationale: "test".into(),
                template_id: 5,
                origin: SuppressionRuleOrigin::Human,
            },
        )
        .unwrap();
        let activated = activate_template_suppression(
            &corpus,
            preview.rule_revision,
            ActivateSuppressionPreview {
                preview_token: preview.token,
            },
        )
        .unwrap();
        let after_activate = load_suppression_document(&corpus).unwrap();
        assert_eq!(after_activate.revision, activated.revision);

        let report = propose_noise_candidates(
            &corpus,
            &NoiseCandidateOptions {
                include_already_suppressed: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(report.already_suppressed_template_ids.contains(&5));
        let suppressed = report
            .candidates
            .iter()
            .find(|c| c.template_id == 5)
            .expect("include_already_suppressed must disclose the enabled template");
        assert!(suppressed.already_suppressed);
        assert_eq!(suppressed.share_basis, "raw_corpus");
        assert_eq!(suppressed.corpus_share_bps, 5_000);
        assert!(suppressed.corpus_share_bps <= 10_000);
        assert!(suppressed
            .reason_codes
            .contains(&NoiseCandidateReasonCode::AlreadySuppressed));
        let active = report
            .candidates
            .iter()
            .find(|c| c.template_id == 6)
            .expect("unsuppressed peer remains a candidate");
        assert_eq!(active.share_basis, "unsuppressed_corpus");
        assert_eq!(active.corpus_share_bps, 10_000);
        // Default path excludes already-suppressed from ranked list.
        let active_only =
            propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(active_only.candidates.iter().all(|c| c.template_id != 5));

        let final_doc = load_suppression_document(&corpus).unwrap();
        assert_eq!(
            final_doc.revision, after_activate.revision,
            "detector must not mutate suppression revision"
        );
        assert_eq!(final_doc.rules.len(), after_activate.rules.len());
    }

    #[test]
    fn active_lens_time_quality_ignores_suppressed_order_only_rows() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..100 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 60,
                "INFO",
                1,
                "steady wall heartbeat",
                "wall.log",
            ));
            seq += 1;
        }
        for _ in 0..50 {
            events.push(order_event(
                seq,
                "INFO",
                2,
                "unresolved chatter",
                "order.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "active-time-quality",
            &[
                (1, "steady wall heartbeat", 100, 1),
                (2, "unresolved chatter", 50, 1),
            ],
            events,
        );
        let before = load_suppression_document(&corpus).unwrap();
        let preview = preview_template_suppression(
            &corpus,
            before.revision,
            NewSuppressionPreview {
                name: "hide unresolved test chatter".into(),
                rationale: "active time-quality regression".into(),
                template_id: 2,
                origin: SuppressionRuleOrigin::Human,
            },
        )
        .unwrap();
        activate_template_suppression(
            &corpus,
            preview.rule_revision,
            ActivateSuppressionPreview {
                preview_token: preview.token,
            },
        )
        .unwrap();

        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert_eq!(report.raw_time_quality, TimeQuality::Mixed);
        assert_eq!(report.time_quality, TimeQuality::Wall);
        let active = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("active wall candidate");
        assert!(active
            .reason_codes
            .contains(&NoiseCandidateReasonCode::TemporallyPersistent));
        assert!(active
            .reason_codes
            .contains(&NoiseCandidateReasonCode::SteadyBackground));
    }

    #[test]
    fn equal_score_orders_by_template_id_asc() {
        // Two templates with identical measurable facts (except id) so scores
        // tie; the shipped detector must order template_id ASC on that tie.
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..50i64 {
            let ts = 1_700_000_000 + i * 60;
            let src = if i % 2 == 0 { "a.log" } else { "b.log" };
            // Higher id first in insertion order — sort must still put 10 before 20.
            events.push(wall_event(seq, ts, "INFO", 20, "twin pattern", src));
            seq += 1;
            events.push(wall_event(seq, ts, "INFO", 10, "twin pattern", src));
            seq += 1;
        }
        // Filler so share is equal for 10 and 20 and corpus clears eligibility.
        for i in 0..30i64 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                30,
                "filler",
                "c.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "equal-score",
            &[
                (10, "twin pattern", 50, 1),
                (20, "twin pattern", 50, 1),
                (30, "filler", 30, 1),
            ],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let twins: Vec<_> = report
            .candidates
            .iter()
            .filter(|c| c.template_id == 10 || c.template_id == 20)
            .collect();
        assert_eq!(
            twins.len(),
            2,
            "both equal-volume twins must be proposed: {:?}",
            report
                .candidates
                .iter()
                .map(|c| (c.template_id, c.score))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            twins[0].score, twins[1].score,
            "fixture must produce equal scores through the shipped scorer: {} vs {}",
            twins[0].score, twins[1].score
        );
        assert_eq!(
            twins[0].template_id, 10,
            "tie-break must be template_id ASC"
        );
        assert_eq!(twins[1].template_id, 20);
        // Positions in the full ranked list must also respect the same order.
        let pos10 = report
            .candidates
            .iter()
            .position(|c| c.template_id == 10)
            .unwrap();
        let pos20 = report
            .candidates
            .iter()
            .position(|c| c.template_id == 20)
            .unwrap();
        assert!(
            pos10 < pos20,
            "shipped sort must place template 10 before 20 on equal score: pos10={pos10} pos20={pos20}"
        );
    }

    #[test]
    fn secret_bearing_representatives_are_redacted() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        // Use secret shapes the trusted redactor always scrubs (AWS key id + sk-proj).
        // Compose the synthetic markers at runtime so repository secret scanners do not
        // mistake the redaction fixture for a committed credential.
        let aws_marker = ["AKIAIOSFODNN7", "EXAMPLE"].concat();
        let project_marker = ["sk-proj-abcdefghijkl", "mnopqrstuvwxyz012345"].concat();
        let secret_line = format!("auth aws={aws_marker} key={project_marker}");
        for i in 0..30 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 10,
                "INFO",
                11,
                &secret_line,
                "sec.log",
            ));
            seq += 1;
        }
        for i in 0..30 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                12,
                "filler",
                "f.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "secrets",
            &[(11, "auth aws=<*> key=<*>", 30, 1), (12, "filler", 30, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let hit = report
            .candidates
            .iter()
            .find(|c| c.template_id == 11)
            .expect("secret-bearing high-frequency template");
        assert!(!hit.representatives.is_empty());
        for rep in &hit.representatives {
            assert!(
                !rep.redacted_excerpt.contains(&aws_marker),
                "raw AWS key leaked: {}",
                rep.redacted_excerpt
            );
            assert!(
                !rep.redacted_excerpt.contains(&project_marker),
                "raw sk-proj leaked: {}",
                rep.redacted_excerpt
            );
        }
    }

    #[test]
    fn every_outbound_text_field_excludes_evaluator_markers_and_sensitive_fingerprints() {
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "outbound-safety").unwrap();
        corpus
            .upsert_templates([
                TemplateRow {
                    info: TemplateInfo {
                        template_id: 1,
                        pattern: "evaluator_truth expected answer".into(),
                        token_count: 3,
                        count: 40,
                        first_seen: 1_700_000_000,
                        last_seen: 1_700_000_039,
                        severity: 1,
                        example: "example".into(),
                    },
                    content_hash: "fp-safe".into(),
                    vector: None,
                },
                TemplateRow {
                    info: TemplateInfo {
                        template_id: 2,
                        pattern: "ordinary chatter".into(),
                        token_count: 2,
                        count: 40,
                        first_seen: 1_700_000_000,
                        last_seen: 1_700_000_039,
                        severity: 1,
                        example: "example".into(),
                    },
                    content_hash: "evaluator_truth-fingerprint".into(),
                    vector: None,
                },
            ])
            .unwrap();
        let mut events = Vec::new();
        let mut seq = 1u64;
        for template_id in [1, 2] {
            for i in 0..40 {
                events.push(wall_event(
                    seq,
                    1_700_000_000 + i,
                    "evaluator_truth",
                    template_id,
                    "answer_key=evaluator_truth",
                    "evaluator_truth.log",
                ));
                seq += 1;
            }
        }
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(report.metadata_missing_template_ids.contains(&2));
        let wire = serde_json::to_string(&report).unwrap().to_ascii_lowercase();
        assert!(!wire.contains("evaluator_truth"));
        assert!(!wire.contains("answer_key"));
        assert!(!wire.contains("evaluator-truth"));
    }

    #[test]
    fn empty_and_small_corpora_yield_no_candidates() {
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "empty").unwrap();
        let empty = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(empty.candidates.is_empty());
        assert_eq!(empty.corpus_event_count, 0);

        let mut events = vec![wall_event(1, 1_700_000_000, "INFO", 1, "tiny", "a.log")];
        for i in 2..=5 {
            events.push(wall_event(
                i,
                1_700_000_000 + i as i64,
                "INFO",
                1,
                "tiny",
                "a.log",
            ));
        }
        let (_dir2, small) = corpus_with("small", &[(1, "tiny", 5, 1)], events);
        let report = propose_noise_candidates(&small, &NoiseCandidateOptions::default()).unwrap();
        assert!(
            report.candidates.is_empty(),
            "small corpora must not invent candidates: {:?}",
            report.candidates
        );
    }

    #[test]
    fn extreme_counts_remain_bounded() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        // Many templates with moderate volume; ensure cap holds.
        for tid in 1..=40u64 {
            for j in 0..20u64 {
                events.push(wall_event(
                    seq,
                    1_700_000_000 + (tid * 100 + j) as i64,
                    "INFO",
                    tid,
                    &format!("family {tid}"),
                    "bulk.log",
                ));
                seq += 1;
            }
        }
        // patterns need distinct — use dynamic upsert
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "extreme").unwrap();
        for tid in 1..=40u64 {
            upsert_template(&corpus, tid, &format!("family {tid}"), 20, 1);
        }
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();
        let report = propose_noise_candidates(
            &corpus,
            &NoiseCandidateOptions {
                max_candidates: 8,
                max_representatives: 2,
                include_already_suppressed: false,
            },
        )
        .unwrap();
        assert!(report.candidates.len() <= 8);
        assert_eq!(report.templates_scanned, 40);
        for c in &report.candidates {
            assert!(c.representatives.len() <= 2);
            assert!(c.pattern.len() <= MAX_NOISE_PATTERN_BYTES + 4);
        }
    }

    #[test]
    fn aggregate_preselection_uses_current_event_counts_not_stale_template_counts() {
        let dir = tempdir().unwrap();
        let corpus =
            LogCorpus::create(&dir.path().join("cache"), "authoritative-preselection").unwrap();
        corpus
            .upsert_templates((1..=4_097u64).map(|template_id| TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: format!("pattern {template_id}"),
                    token_count: 2,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: format!("pattern {template_id}"),
                },
                content_hash: format!("fp-{template_id}"),
                vector: None,
            }))
            .unwrap();
        let mut events = (1..=4_096u64)
            .map(|template_id| {
                wall_event(
                    template_id,
                    1_700_000_000 + template_id as i64,
                    "INFO",
                    template_id,
                    "singleton",
                    "bulk.log",
                )
            })
            .collect::<Vec<_>>();
        events.extend((0..1_000u64).map(|offset| {
            wall_event(
                4_097 + offset,
                1_700_010_000 + offset as i64,
                "INFO",
                4_097,
                "actual dominant template",
                if offset % 2 == 0 {
                    "dominant-a.log"
                } else {
                    "dominant-b.log"
                },
            )
        }));
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(report.template_scan_truncated);
        assert_eq!(report.templates_scanned, MAX_TEMPLATES_SCANNED as u64);
        assert!(report
            .candidates
            .iter()
            .any(|candidate| candidate.template_id == 4_097));
    }

    #[test]
    fn order_only_candidates_never_invent_wall_clock_persistence() {
        let mut events = Vec::new();
        for seq in 1..=80 {
            events.push(order_event(
                seq,
                "INFO",
                1,
                "order-only heartbeat",
                if seq % 2 == 0 { "a.log" } else { "b.log" },
            ));
        }
        for seq in 81..=120 {
            events.push(order_event(seq, "INFO", 2, "filler", "c.log"));
        }
        let (_dir, corpus) = corpus_with(
            "order-only-noise",
            &[(1, "order-only heartbeat", 80, 1), (2, "filler", 40, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert_eq!(report.time_quality, TimeQuality::OrderOnly);
        let candidate = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("high-volume order-only template remains reviewable");
        assert_eq!(candidate.time_quality, TimeQuality::OrderOnly);
        assert!(candidate.wall_time_span.is_none());
        assert!(candidate.order_span.is_some());
        assert!(!candidate
            .reason_codes
            .contains(&NoiseCandidateReasonCode::TemporallyPersistent));
        assert!(!candidate
            .reason_codes
            .contains(&NoiseCandidateReasonCode::SteadyBackground));
        assert!(candidate
            .representatives
            .iter()
            .all(|representative| representative.time_quality == TimeQuality::OrderOnly));
    }

    #[test]
    fn mixed_candidates_keep_wall_and_order_spans_separate_without_temporal_score() {
        let mut events = Vec::new();
        let mut seq = 1;
        for i in 0..40 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 120,
                "INFO",
                1,
                "mixed heartbeat",
                "wall.log",
            ));
            seq += 1;
        }
        for _ in 0..40 {
            events.push(order_event(seq, "INFO", 1, "mixed heartbeat", "order.log"));
            seq += 1;
        }
        for i in 0..40 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                2,
                "filler",
                "filler.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with(
            "mixed-noise",
            &[(1, "mixed heartbeat", 80, 1), (2, "filler", 40, 1)],
            events,
        );
        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert_eq!(report.time_quality, TimeQuality::Mixed);
        let candidate = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("mixed high-volume template remains reviewable");
        assert_eq!(candidate.time_quality, TimeQuality::Mixed);
        assert!(candidate.wall_time_span.is_some());
        assert!(candidate.order_span.is_some());
        assert!(!candidate
            .reason_codes
            .contains(&NoiseCandidateReasonCode::TemporallyPersistent));
        assert!(!candidate
            .reason_codes
            .contains(&NoiseCandidateReasonCode::SteadyBackground));
        assert!(candidate
            .representatives
            .iter()
            .any(|representative| representative.time_quality == TimeQuality::Wall));
        assert!(candidate
            .representatives
            .iter()
            .any(|representative| representative.time_quality == TimeQuality::OrderOnly));
    }

    #[test]
    fn duplicate_sequences_cannot_multiply_or_destabilize_representatives() {
        let mut events = Vec::new();
        for index in 0..45u64 {
            events.push(wall_event(
                index % 3 + 1,
                1_700_000_000 + index as i64,
                "INFO",
                1,
                &format!("duplicate-seq row {index:02}"),
                if index % 2 == 0 { "a.log" } else { "b.log" },
            ));
        }
        for index in 0..20u64 {
            events.push(wall_event(
                100 + index,
                1_700_001_000 + index as i64,
                "INFO",
                2,
                "filler",
                "filler.log",
            ));
        }
        let (_dir, corpus) = corpus_with(
            "duplicate-sequences",
            &[(1, "duplicate-seq", 45, 1), (2, "filler", 20, 1)],
            events,
        );
        let options = NoiseCandidateOptions {
            max_candidates: 8,
            max_representatives: MAX_NOISE_REPRESENTATIVES,
            include_already_suppressed: false,
        };
        let first = propose_noise_candidates(&corpus, &options).unwrap();
        let second = propose_noise_candidates(&corpus, &options).unwrap();
        let first_representatives = &first
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("dominant duplicate-sequence template")
            .representatives;
        let second_representatives = &second
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("repeat dominant duplicate-sequence template")
            .representatives;
        assert_eq!(first_representatives.len(), MAX_NOISE_REPRESENTATIVES);
        assert_eq!(first_representatives, second_representatives);
    }

    #[test]
    fn exact_suppressed_denominator_includes_templates_beyond_scan_cap() {
        const TOTAL_TEMPLATES: u64 = 12_000;
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "suppressed-beyond-cap").unwrap();
        corpus
            .upsert_templates((1..=TOTAL_TEMPLATES).map(|template_id| TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: format!("pattern {template_id}"),
                    token_count: 2,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_000,
                    severity: 1,
                    example: format!("pattern {template_id}"),
                },
                content_hash: format!("fp-{template_id}"),
                vector: None,
            }))
            .unwrap();
        let events = (1..=TOTAL_TEMPLATES)
            .map(|template_id| {
                wall_event(
                    template_id,
                    1_700_000_000 + template_id as i64,
                    "INFO",
                    template_id,
                    "singleton",
                    "bulk.log",
                )
            })
            .collect::<Vec<_>>();
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let before = load_suppression_document(&corpus).unwrap();
        let preview = preview_template_suppression(
            &corpus,
            before.revision,
            NewSuppressionPreview {
                name: "hide outside aggregate cap".into(),
                rationale: "denominator regression".into(),
                template_id: TOTAL_TEMPLATES,
                origin: SuppressionRuleOrigin::Human,
            },
        )
        .unwrap();
        activate_template_suppression(
            &corpus,
            preview.rule_revision,
            ActivateSuppressionPreview {
                preview_token: preview.token,
            },
        )
        .unwrap();

        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert_eq!(report.corpus_event_count, TOTAL_TEMPLATES);
        assert_eq!(report.unsuppressed_event_count, TOTAL_TEMPLATES - 1);
        assert_eq!(report.templates_scanned, MAX_TEMPLATES_SCANNED as u64);
        assert!(report.template_scan_truncated);
    }

    #[test]
    fn missing_template_fingerprint_is_disclosed_not_fabricated() {
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "missing-fingerprint").unwrap();
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 1,
                    pattern: "heartbeat".into(),
                    token_count: 1,
                    count: 40,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_039,
                    severity: 1,
                    example: "heartbeat".into(),
                },
                content_hash: String::new(),
                vector: None,
            }])
            .unwrap();
        let events = (1..=40)
            .map(|seq| {
                wall_event(
                    seq,
                    1_700_000_000 + seq as i64,
                    "INFO",
                    1,
                    "heartbeat",
                    "app.log",
                )
            })
            .collect::<Vec<_>>();
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let report = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert!(report.candidates.is_empty());
        assert_eq!(report.metadata_missing_template_ids, vec![1]);
    }

    #[test]
    fn report_budget_and_final_level_queries_remain_bounded_at_high_cardinality() {
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "bounded-report").unwrap();
        let long_pattern = "p\"\\\t".repeat(MAX_NOISE_PATTERN_BYTES);
        corpus
            .upsert_templates((1..=200u64).map(|template_id| TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: format!("{long_pattern}-{template_id}"),
                    token_count: 1,
                    count: 32,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_031,
                    severity: 1,
                    example: "example".into(),
                },
                content_hash: format!("fp-{template_id}"),
                vector: Some(vec![template_id as f32; 128]),
            }))
            .unwrap();
        let long_message = "x\"\\\t".repeat(MAX_NOISE_REPRESENTATIVE_EXCERPT_BYTES);
        let mut events = Vec::with_capacity(6_400);
        let mut seq = 1u64;
        for template_id in 1..=200u64 {
            for level_index in 0..32u64 {
                events.push(wall_event(
                    seq,
                    1_700_000_000 + level_index as i64,
                    &format!("LEVEL-{level_index:02}-{}", "l".repeat(80)),
                    template_id,
                    &long_message,
                    &format!("source-{level_index:02}-{}.log", "s".repeat(260)),
                ));
                seq += 1;
            }
        }
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let report = propose_noise_candidates(
            &corpus,
            &NoiseCandidateOptions {
                max_candidates: MAX_NOISE_CANDIDATES,
                max_representatives: MAX_NOISE_REPRESENTATIVES,
                include_already_suppressed: false,
            },
        )
        .unwrap();
        assert!(report.candidate_cap_truncated);
        assert!(report.response_bytes_truncated);
        assert!(report.truncated);
        assert!(report.candidates.len() < MAX_NOISE_CANDIDATES);
        assert!(report.candidates.iter().all(|candidate| {
            !candidate.level_counts.is_empty()
                && candidate.level_counts_truncated
                && candidate.other_level_count > 0
                && candidate
                    .level_counts
                    .iter()
                    .fold(candidate.other_level_count, |total, level| {
                        total.saturating_add(level.count)
                    })
                    == candidate.event_count
        }));
        assert_eq!(report.database_query_count, MAX_NOISE_QUERY_COUNT);
        assert!(serialized_report_len(&report).unwrap() <= MAX_NOISE_REPORT_BYTES);
    }

    #[test]
    fn cancellation_returns_partial_or_empty_without_panic() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..50 {
            events.push(wall_event(seq, 1_700_000_000 + i, "INFO", 1, "x", "a.log"));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with("cancel", &[(1, "x", 50, 1)], events);
        let flag = AtomicBool::new(true);
        let report = propose_noise_candidates_with_cancel(
            &corpus,
            &NoiseCandidateOptions::default(),
            Some(&flag),
        )
        .unwrap();
        assert!(report.cancelled);
    }

    #[test]
    fn cancellation_interrupts_active_duckdb_work() {
        let connection = Connection::open_in_memory().unwrap();
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(20));
                cancel.store(true, Ordering::SeqCst);
            });
            let result = with_query_watchdog(
                &connection,
                Some(&cancel),
                Instant::now() + Duration::from_secs(5),
                || {
                    connection
                        .query_row(
                            "SELECT SUM(left_range.i * right_range.i)
                             FROM range(0, 1000000) AS left_range(i)
                             CROSS JOIN range(0, 1000000) AS right_range(i)",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| {
                            CoreError::Message(format!("long cancellation query: {error}"))
                        })
                },
            );
            assert!(result.is_err(), "active query must be interrupted");
        });
        assert!(cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn deadline_interrupts_active_duckdb_work() {
        let connection = Connection::open_in_memory().unwrap();
        let result = with_query_watchdog(
            &connection,
            None,
            Instant::now() + Duration::from_millis(20),
            || {
                connection
                    .query_row(
                        "SELECT SUM(left_range.i * right_range.i)
                         FROM range(0, 1000000) AS left_range(i)
                         CROSS JOIN range(0, 1000000) AS right_range(i)",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| CoreError::Message(format!("long deadline query: {error}")))
            },
        );
        let error = result.expect_err("active query must hit the bounded deadline");
        assert!(error.to_string().contains("exceeded"));
    }

    #[test]
    fn deadline_between_statements_prevents_the_next_query_from_starting() {
        let connection = Connection::open_in_memory().unwrap();
        let budget = QueryBudget::default();
        let deadline = Instant::now() + Duration::from_millis(20);
        let result = with_query_watchdog(&connection, None, deadline, || {
            budget.begin(None, deadline)?;
            let _: i64 = connection
                .query_row("SELECT 1", [], |row| row.get(0))
                .map_err(|error| CoreError::Message(format!("first bounded query: {error}")))?;
            std::thread::sleep(Duration::from_millis(40));
            budget.begin(None, deadline)?;
            connection
                .query_row("SELECT 2", [], |row| row.get::<_, i64>(0))
                .map_err(|error| CoreError::Message(format!("second bounded query: {error}")))
        });
        let error = result.expect_err("expired deadline must block statement two");
        assert!(error.to_string().contains("exceeded"));
        assert_eq!(budget.used(), 1);
    }

    #[test]
    fn detector_is_deterministic_on_fixed_corpus() {
        let mut events = Vec::new();
        let mut seq = 1u64;
        for i in 0..60 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i * 15,
                "INFO",
                1,
                "det",
                if i % 3 == 0 { "a.log" } else { "b.log" },
            ));
            seq += 1;
        }
        for i in 0..40 {
            events.push(wall_event(
                seq,
                1_700_000_000 + i,
                "INFO",
                2,
                "other",
                "c.log",
            ));
            seq += 1;
        }
        let (_dir, corpus) = corpus_with("det", &[(1, "det", 60, 1), (2, "other", 40, 1)], events);
        let a = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        let b = propose_noise_candidates(&corpus, &NoiseCandidateOptions::default()).unwrap();
        assert_eq!(a.candidates, b.candidates);
        assert_eq!(a.suppression_revision, b.suppression_revision);
    }

    #[test]
    fn reopened_handles_share_template_identity_revision_and_snapshot() {
        let events = (1..=40)
            .map(|seq| {
                wall_event(
                    seq,
                    1_700_000_000 + seq as i64,
                    "INFO",
                    1,
                    "heartbeat",
                    "app.log",
                )
            })
            .collect::<Vec<_>>();
        let (dir, corpus) = corpus_with("shared-template-map", &[(1, "heartbeat", 40, 1)], events);
        let reopened = LogCorpus::open(&dir.path().join("cache"), corpus.id()).unwrap();
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 1,
                    pattern: "heartbeat updated".into(),
                    token_count: 2,
                    count: 40,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_040,
                    severity: 1,
                    example: "heartbeat updated".into(),
                },
                content_hash: "fp-updated".into(),
                vector: None,
            }])
            .unwrap();
        corpus.set_template_vector(1, vec![1.0, 0.0]).unwrap();
        assert!(reopened.list_templates()[0].vector.is_none());
        assert!(reopened
            .search_templates(&[1.0, 0.0], 1, None)
            .unwrap()
            .is_empty());

        let report =
            propose_noise_candidates(&reopened, &NoiseCandidateOptions::default()).unwrap();
        let candidate = report
            .candidates
            .iter()
            .find(|candidate| candidate.template_id == 1)
            .expect("shared candidate");
        assert_eq!(candidate.template_fingerprint, "fp-updated");
        assert_eq!(candidate.pattern, "heartbeat updated");
        assert_eq!(
            report.template_analysis_revision,
            corpus.template_analysis_revision()
        );
    }

    #[test]
    fn scale_250k_is_bounded_deterministic_and_timed() {
        // Deterministic synthetic 250k fixture (in-process; no company data).
        let dir = tempdir().unwrap();
        let corpus = LogCorpus::create(&dir.path().join("cache"), "scale-250k").unwrap();
        // 5 templates: dominant INFO (200k), secondary INFO (40k), tertiary (9.5k),
        // repetitive ERROR (400), rare severe (100).
        let plan: &[(u64, &str, u64, &str, u8)] = &[
            (1, "dominant heartbeat", 200_000, "INFO", 1),
            (2, "secondary metrics", 40_000, "INFO", 1),
            (3, "tertiary access", 9_500, "INFO", 1),
            (4, "repetitive connection reset", 400, "ERROR", 4),
            (5, "RARE_SEVERE_ONLY", 100, "ERROR", 5),
        ];
        for (id, pattern, count, _, sev) in plan {
            upsert_template(&corpus, *id, pattern, *count, *sev);
        }
        let mut events = Vec::with_capacity(250_000);
        let mut seq = 1u64;
        let started_gen = std::time::Instant::now();
        for (id, pattern, count, level, _) in plan {
            for i in 0..*count {
                let source = match id {
                    1 => format!("hb-{}.log", i % 8),
                    2 => format!("met-{}.log", i % 4),
                    3 => "access.log".into(),
                    4 => "api.log".into(),
                    _ => "rare.log".into(),
                };
                // Spread dominant across time; rare severe clustered.
                let ts = if *id == 5 {
                    1_700_900_000 + i as i64
                } else {
                    1_700_000_000 + (i as i64) * if *id == 1 { 3 } else { 1 }
                };
                events.push(wall_event(seq, ts, level, *id, pattern, &source));
                seq += 1;
            }
        }
        assert_eq!(events.len(), 250_000);
        // Push in chunks to keep memory reasonable.
        for chunk in events.chunks(25_000) {
            corpus.push_events(chunk).unwrap();
        }
        corpus.flush().unwrap();
        let gen_ms = started_gen.elapsed().as_millis();

        let detect_started = std::time::Instant::now();
        let first = propose_noise_candidates(
            &corpus,
            &NoiseCandidateOptions {
                max_candidates: 16,
                max_representatives: 3,
                include_already_suppressed: false,
            },
        )
        .unwrap();
        let detect_ms = detect_started.elapsed().as_millis();
        let second = propose_noise_candidates(
            &corpus,
            &NoiseCandidateOptions {
                max_candidates: 16,
                max_representatives: 3,
                include_already_suppressed: false,
            },
        )
        .unwrap();

        assert_eq!(first.corpus_event_count, 250_000);
        assert_eq!(first.candidates, second.candidates);
        assert!(first.candidates.len() <= 16);
        for c in &first.candidates {
            assert!(c.representatives.len() <= 3);
        }
        assert!(
            first.candidates.iter().any(|c| c.template_id == 1),
            "dominant should be proposed: {:?}",
            first
                .candidates
                .iter()
                .map(|c| c.template_id)
                .collect::<Vec<_>>()
        );
        assert!(
            first.candidates.iter().all(|c| c.template_id != 5),
            "rare severe (100 events, 100% ERROR) must not dominate proposals: {:?}",
            first.candidates
        );
        // Soft timing: one-machine observation only — record, do not fail on slow CI.
        eprintln!(
            "PASS noise-candidates-250k events=250000 candidates={} detect_ms={detect_ms} \
             gen_push_ms={gen_ms} (one-machine observation; not a universal claim)",
            first.candidates.len()
        );
        assert!(
            detect_ms < 120_000,
            "detector took {detect_ms}ms on 250k; investigate pathological SQL"
        );
    }

    #[test]
    fn pure_score_contract_volume_and_error_penalty() {
        let base = TemplateNoiseFacts {
            template_id: 1,
            event_count: 1_000,
            source_count: 1,
            first_ts: 0,
            last_ts: 10_000,
            error_or_fatal_count: 0,
            warn_count: 0,
            info_count: 1_000,
            distinct_buckets: 10,
            peak_bucket_events: 100,
        };
        let (info_score, info_reasons) =
            score_noise_candidate_facts(&base, 2_000, Some((0, 10_000)));
        let mut risky = base.clone();
        risky.error_or_fatal_count = 1_000;
        risky.info_count = 0;
        let (err_score, err_reasons) =
            score_noise_candidate_facts(&risky, 2_000, Some((0, 10_000)));
        assert!(
            err_score < info_score,
            "ERROR-heavy must score below INFO-heavy equal volume: err={err_score} info={info_score}"
        );
        assert!(err_reasons.contains(&NoiseCandidateReasonCode::RepetitiveErrorRisky));
        assert!(
            info_reasons.contains(&NoiseCandidateReasonCode::HighFrequency)
                || info_reasons.contains(&NoiseCandidateReasonCode::HighCorpusShare)
        );

        let sparse_info = TemplateNoiseFacts {
            event_count: 100,
            info_count: 1,
            warn_count: 0,
            error_or_fatal_count: 99,
            ..base
        };
        let (_, sparse_reasons) =
            score_noise_candidate_facts(&sparse_info, 2_000, Some((0, 10_000)));
        assert!(!sparse_reasons.contains(&NoiseCandidateReasonCode::LevelDominatedInfo));
    }

    #[test]
    fn scoring_handles_extreme_counts_without_overflow_or_panic() {
        let facts = TemplateNoiseFacts {
            template_id: u64::MAX,
            event_count: u64::MAX,
            source_count: u64::MAX,
            first_ts: i64::MIN,
            last_ts: i64::MAX,
            error_or_fatal_count: u64::MAX,
            warn_count: u64::MAX,
            info_count: u64::MAX,
            distinct_buckets: u64::MAX,
            peak_bucket_events: u64::MAX,
        };
        let (score, reasons) =
            score_noise_candidate_facts(&facts, u64::MAX, Some((i64::MIN, i64::MAX)));
        assert!(score <= 100);
        assert_eq!(scaled_ratio(u64::MAX, u64::MAX, 10_000), 10_000);
        assert!(reasons.contains(&NoiseCandidateReasonCode::RepetitiveErrorRisky));
        assert!(template_eligible_for_noise_candidate(&facts, u64::MAX));
    }

    #[test]
    fn rare_eligibility_gate() {
        let rare = TemplateNoiseFacts {
            template_id: 9,
            event_count: 2,
            source_count: 1,
            first_ts: 0,
            last_ts: 1,
            error_or_fatal_count: 2,
            warn_count: 0,
            info_count: 0,
            distinct_buckets: 1,
            peak_bucket_events: 2,
        };
        assert!(!template_eligible_for_noise_candidate(&rare, 10_000));
        let big = TemplateNoiseFacts {
            template_id: 1,
            event_count: 500,
            source_count: 2,
            first_ts: 0,
            last_ts: 1000,
            error_or_fatal_count: 0,
            warn_count: 0,
            info_count: 500,
            distinct_buckets: 5,
            peak_bucket_events: 100,
        };
        assert!(template_eligible_for_noise_candidate(&big, 10_000));
    }
}
