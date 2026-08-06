//! Bounded, derived exception-rendering analysis (four layers).
//!
//! Layers (never mutate durable events):
//! 1. **Raw records** — stored events that look exception-related.
//! 2. **Renderings** — physical emission shapes (app full-stack vs separately
//!    wrapped line/stream records).
//! 3. **Occurrences (semantic episodes)** — one logical failure; may include
//!    multiple renderings only when evidence supports duplicate rendering.
//! 4. **Families** — bounded groups of occurrences sharing a root signature.
//!
//! Merge guards (fail closed):
//! - message equality, divisibility, adjacency, or rotation-family alone never
//!   merge occurrences;
//! - order-only cross-source merge requires a strong execution key (matching
//!   thread or trace_id);
//! - suppression is applied only via excluded template ids at scan time — hidden
//!   children never appear in citations;
//! - caps, cancellation, and revision are explicit partial/error paths.

use crate::error::{CoreError, CoreResult};
use crate::log_analysis::{
    query_event_count, query_event_rows, EventQuery, ExplorerEvent, LogCorpus,
    SearchEvidenceIdentity, MAX_EVENT_PAGE,
};
use crate::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

/// Schema id for host-neutral reports.
pub const EXCEPTION_EPISODE_SCHEMA_ID: &str = "contextdesk.exception_episode_report.v1";
/// Schema version.
pub const EXCEPTION_EPISODE_SCHEMA_VERSION: u32 = 1;

/// Maximum exception-candidate events retained in one analysis.
pub const EXCEPTION_EPISODE_EVENT_SCAN_CAP: usize = 50_000;
/// Maximum derived renderings retained before results become partial.
pub const EXCEPTION_EPISODE_RENDER_CAP: usize = 2_048;
/// Maximum records attached to one rendering.
pub const EXCEPTION_EPISODE_RECORD_CAP: usize = 400;
/// Maximum families returned after deterministic impact ranking.
pub const EXCEPTION_EPISODE_FAMILY_CAP: usize = 64;
/// Max seq gap for attaching line records into one stderr/line rendering.
const MAX_ADJACENT_SEQ_GAP: u64 = 8;
/// Max wall-seconds between adjacent records in one rendering.
const MAX_ADJACENT_WALL_SECONDS: i64 = 5;
/// Max seq gap when pairing two renderings of different kinds.
const MAX_DUPLICATE_SEQ_GAP: u64 = 512;
/// Max wall-seconds between dual-render pairings (tight: not mere same-hour).
const MAX_DUPLICATE_WALL_SECONDS: i64 = 2;
/// Max store rows walked when collecting exception candidates (independent of severity).
pub const EXCEPTION_EPISODE_ROW_WALK_CAP: usize = 250_000;

/// Effective candidate retention cap (test override when non-zero).
fn effective_candidate_cap() -> usize {
    #[cfg(test)]
    {
        let override_cap = TEST_CANDIDATE_CAP_OVERRIDE.with(|c| *c.borrow());
        if override_cap > 0 {
            return override_cap;
        }
    }
    EXCEPTION_EPISODE_EVENT_SCAN_CAP
}

/// Effective store row-walk cap (test override when non-zero).
fn effective_row_walk_cap() -> usize {
    #[cfg(test)]
    {
        let override_cap = TEST_ROW_WALK_CAP_OVERRIDE.with(|c| *c.borrow());
        if override_cap > 0 {
            return override_cap;
        }
    }
    EXCEPTION_EPISODE_ROW_WALK_CAP
}

// Thread-local so parallel unit tests cannot race caps/hooks.
#[cfg(test)]
std::thread_local! {
    static TEST_CANDIDATE_CAP_OVERRIDE: std::cell::RefCell<usize> = const { std::cell::RefCell::new(0) };
    static TEST_ROW_WALK_CAP_OVERRIDE: std::cell::RefCell<usize> = const { std::cell::RefCell::new(0) };
    #[allow(clippy::type_complexity)]
    static EPISODE_SCAN_PAGE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(usize)>>> =
        const { std::cell::RefCell::new(None) };
}

/// Test-only: override candidate retention cap (`0` restores production default).
///
/// Thread-local: safe for parallel unit tests.
#[cfg(test)]
fn set_test_candidate_cap_override(cap: usize) {
    TEST_CANDIDATE_CAP_OVERRIDE.with(|c| *c.borrow_mut() = cap);
}

/// Test-only: override row-walk cap (`0` restores production default).
#[cfg(test)]
fn set_test_row_walk_cap_override(cap: usize) {
    TEST_ROW_WALK_CAP_OVERRIDE.with(|c| *c.borrow_mut() = cap);
}

/// Test-only RAII reset for cap/hook overrides.
#[cfg(test)]
pub(crate) struct TestScanOverrideGuard {
    _private: (),
}

#[cfg(test)]
impl TestScanOverrideGuard {
    /// Clear prior overrides/hooks on this thread.
    pub(crate) fn acquire() -> Self {
        set_test_candidate_cap_override(0);
        set_test_row_walk_cap_override(0);
        set_episode_scan_page_hook_for_test(None);
        Self { _private: () }
    }
}

#[cfg(test)]
impl Drop for TestScanOverrideGuard {
    fn drop(&mut self) {
        set_test_candidate_cap_override(0);
        set_test_row_walk_cap_override(0);
        set_episode_scan_page_hook_for_test(None);
    }
}

/// Install or clear the test-only episode-scan page hook (thread-local).
///
/// The hook is not required to be `Send` — it runs on the analysis thread only.
#[cfg(test)]
pub(crate) fn set_episode_scan_page_hook_for_test(hook: Option<Box<dyn FnMut(usize)>>) {
    EPISODE_SCAN_PAGE_HOOK.with(|cell| *cell.borrow_mut() = hook);
}

#[cfg(test)]
fn invoke_episode_scan_page_hook(page_index: usize) {
    EPISODE_SCAN_PAGE_HOOK.with(|cell| {
        if let Some(hook) = cell.borrow_mut().as_mut() {
            hook(page_index);
        }
    });
}

/// Physical rendering shape found in the event store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionRenderingKind {
    /// One durable event already holds a full stack (conventional multiline).
    ApplicationFullStack,
    /// Separately wrapped/emitted records (`[stderr]` or per-line timestamp stream).
    SeparatelyWrappedRecords,
}

/// Role of one child event inside a physical rendering / semantic occurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionCitationRole {
    /// Exception type/header (lead) of one physical rendering.
    RenderingLead = 0,
    /// Stack frame, wrapper scaffold, nested-cause continuation, or other support.
    SupportingRecord = 1,
}

/// Exact identity of one underlying stored event.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionEventCitation {
    /// Durable event sequence.
    pub seq: u64,
    /// Portable source identity.
    pub source: String,
    /// Template id at ingest.
    pub template_id: u64,
    /// Role within its physical rendering (lead vs supporting).
    pub role: ExceptionCitationRole,
    /// Physical rendering kind that produced this citation.
    pub rendering_kind: ExceptionRenderingKind,
}

impl ExceptionEventCitation {
    /// Convert to the trusted broad-triage identity channel.
    pub fn as_search_identity(&self) -> SearchEvidenceIdentity {
        SearchEvidenceIdentity {
            seq: self.seq,
            source: self.source.clone(),
            citation_source: None,
            template_id: self.template_id,
        }
    }
}

/// Per-template projection onto semantic occurrences (never borrows global counts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEpisodeProjection {
    /// Template id projected.
    pub template_id: u64,
    /// Occurrences that contain this template (once each). `None` when incomplete.
    pub occurrence_count: Option<u64>,
    /// Occurrences where this template appears as a rendering lead.
    pub lead_occurrence_count: Option<u64>,
    /// Occurrences where this template appears only as supporting records.
    pub supporting_only_occurrence_count: Option<u64>,
    /// False when caps/partial prevent an exact projection.
    pub complete: bool,
    /// Human-readable reason when incomplete.
    pub incomplete_reason: Option<String>,
}

/// Strength of a correlation between separate physical renderings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionCorrelationConfidence {
    /// One rendering stands alone; no duplicate-rendering claim is made.
    Uncorrelated,
    /// Same signature, compatible scope, explicit wall time, and matching thread/trace.
    Strong,
    /// Same signature + wall adjacency with weaker scope (no conflicting execution key).
    Moderate,
}

/// One likely logical occurrence (semantic episode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionOccurrenceSummary {
    /// First cited seq.
    pub first_seq: u64,
    /// Last cited seq.
    pub last_seq: u64,
    /// Distinct durable records in this occurrence.
    pub raw_record_count: u64,
    /// Records from application full-stack renderings in this occurrence.
    pub application_record_count: u64,
    /// Records from separately wrapped renderings in this occurrence.
    pub stderr_record_count: u64,
    /// Number of physical renderings correlated into this occurrence.
    pub rendering_count: u64,
    /// True when more than one rendering was correlated.
    pub duplicate_rendering: bool,
    /// Confidence of the duplicate-rendering claim.
    pub correlation_confidence: ExceptionCorrelationConfidence,
    /// Rendering kinds retained.
    pub rendering_kinds: Vec<ExceptionRenderingKind>,
    /// Exact child event identities (never fabricated).
    pub citations: Vec<ExceptionEventCitation>,
    /// False when a per-render record cap truncated citations.
    pub citations_complete: bool,
}

/// Integer ratio with explicit remainder (never hides incomplete division).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionCountRatio {
    /// Numerator (e.g. raw records).
    pub numerator: u64,
    /// Denominator (e.g. semantic occurrences).
    pub denominator: u64,
    /// Floor division `numerator / denominator` (0 when denominator is 0).
    pub quotient: u64,
    /// `numerator % denominator` (0 when denominator is 0).
    pub remainder: u64,
}

impl ExceptionCountRatio {
    /// Build a ratio that always surfaces remainder.
    pub fn new(numerator: u64, denominator: u64) -> Self {
        if denominator == 0 {
            Self {
                numerator,
                denominator: 0,
                quotient: 0,
                remainder: 0,
            }
        } else {
            Self {
                numerator,
                denominator,
                quotient: numerator / denominator,
                remainder: numerator % denominator,
            }
        }
    }

    /// True when the ratio divides with no remainder.
    ///
    /// Denominator zero is exact only when the numerator is also zero (0/0).
    /// A positive numerator with zero denominator is **not** exact.
    pub fn is_exact(&self) -> bool {
        if self.denominator == 0 {
            self.numerator == 0
        } else {
            self.remainder == 0
        }
    }

    /// True when the ratio is an integral quotient over a positive denominator.
    pub fn ratio_integral(&self) -> bool {
        self.denominator > 0 && self.remainder == 0
    }
}

/// Typed amplification accounting (numerator/denominator + remainder).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionAmplificationMetrics {
    /// Total raw exception records retained in renderings.
    pub raw_exception_records: u64,
    /// Records belonging to application full-stack renderings.
    pub application_exception_records: u64,
    /// Records belonging to separately wrapped (stderr/line) renderings.
    pub stderr_exception_records: u64,
    /// Physical rendering count.
    pub physical_renderings: u64,
    /// Semantic occurrence count (denominator for per-occurrence ratios).
    pub semantic_occurrences: u64,
    /// `raw_exception_records / semantic_occurrences` with remainder.
    pub raw_records_per_occurrence: ExceptionCountRatio,
    /// `stderr_exception_records / semantic_occurrences` with remainder.
    pub stderr_records_per_occurrence: ExceptionCountRatio,
    /// `application_exception_records / semantic_occurrences` with remainder.
    pub application_records_per_occurrence: ExceptionCountRatio,
    /// `physical_renderings / semantic_occurrences` with remainder.
    pub renderings_per_occurrence: ExceptionCountRatio,
}

impl ExceptionAmplificationMetrics {
    fn from_counts(
        raw_exception_records: u64,
        application_exception_records: u64,
        stderr_exception_records: u64,
        physical_renderings: u64,
        semantic_occurrences: u64,
    ) -> Self {
        Self {
            raw_exception_records,
            application_exception_records,
            stderr_exception_records,
            physical_renderings,
            semantic_occurrences,
            raw_records_per_occurrence: ExceptionCountRatio::new(
                raw_exception_records,
                semantic_occurrences,
            ),
            stderr_records_per_occurrence: ExceptionCountRatio::new(
                stderr_exception_records,
                semantic_occurrences,
            ),
            application_records_per_occurrence: ExceptionCountRatio::new(
                application_exception_records,
                semantic_occurrences,
            ),
            renderings_per_occurrence: ExceptionCountRatio::new(
                physical_renderings,
                semantic_occurrences,
            ),
        }
    }
}

/// Bounded family of occurrences sharing one normalized root signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFamilySummary {
    /// Normalized root signature.
    pub signature: String,
    /// Sum of raw records across occurrences.
    pub raw_record_count: u64,
    /// Application full-stack records in this family.
    pub application_record_count: u64,
    /// Separately wrapped records in this family.
    pub stderr_record_count: u64,
    /// Sum of physical renderings across occurrences.
    pub rendering_episode_count: u64,
    /// Semantic occurrence count (never invented).
    pub occurrence_count: u64,
    /// Occurrences that include duplicate renderings.
    pub duplicate_rendering_occurrence_count: u64,
    /// Occurrences with incomplete citations or non-strong duplicates.
    pub uncertain_occurrence_count: u64,
    /// Typed amplification for this family (own numerator/denominator/remainder).
    pub amplification: ExceptionAmplificationMetrics,
    /// Occurrences retained for this family (bounded).
    pub occurrences: Vec<ExceptionOccurrenceSummary>,
}

/// Honest accounting for one bounded, non-destructive analysis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionEpisodeAnalysis {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Store rows walked while collecting exception candidates.
    pub rows_walked: u64,
    /// Configured max store rows walked.
    pub row_walk_cap: usize,
    /// Exception candidates available under the candidate predicate (when known).
    pub events_available: u64,
    /// Exception-candidate events retained for analysis.
    pub events_scanned: u64,
    /// Configured candidate retention cap.
    pub event_scan_cap: usize,
    /// Description of the candidate selection scope (not severity-only).
    pub candidate_scope: String,
    /// Raw exception-related records retained in renderings.
    pub raw_exception_record_count: u64,
    /// Application full-stack records.
    pub application_exception_record_count: u64,
    /// Separately wrapped (stderr/line) records.
    pub stderr_exception_record_count: u64,
    /// Physical rendering count.
    pub rendering_episode_count: u64,
    /// Unpaired physical renderings after matching.
    pub unpaired_rendering_count: u64,
    /// Semantic occurrence count.
    pub occurrence_count: u64,
    /// Occurrences with duplicate renderings.
    pub duplicate_rendering_occurrence_count: u64,
    /// Families before family cap.
    pub family_count_available: u64,
    /// Family output cap.
    pub family_cap: usize,
    /// Typed amplification metrics (never hides division remainder).
    pub amplification: ExceptionAmplificationMetrics,
    /// True when any cap truncated work — totals must not be treated as corpus-wide complete.
    pub partial: bool,
    /// `!partial`: retained counts cover the declared candidate scope completely.
    pub counts_complete: bool,
    /// True when any occurrence is uncertain.
    pub uncertain: bool,
    /// Matching policy name (honest about greedy vs global optimality).
    pub matching_policy: String,
    /// True when the matcher detected non-unique maximum matchings for a component.
    pub matching_ambiguous: bool,
    /// Event revision pinned at scan start (standalone CLI path).
    pub pinned_event_revision: Option<u64>,
    /// Template analysis revision pinned at scan start.
    pub pinned_template_analysis_revision: Option<u64>,
    /// Ranking / interpretation disclosure for hosts.
    pub ranking_disclosure: String,
    /// Ranked families.
    pub families: Vec<ExceptionFamilySummary>,
}

/// Alias retained for CLI/brief naming.
pub type ExceptionEpisodeReport = ExceptionEpisodeAnalysis;

#[derive(Debug, Clone)]
struct RenderEpisode {
    signature: String,
    kind: ExceptionRenderingKind,
    source: String,
    service: Option<String>,
    host: Option<String>,
    thread: Option<String>,
    /// True when explicit and parenthesized execution keys conflicted on a child.
    execution_key_conflict: bool,
    /// True when an envelope delimiter was malformed on a child.
    envelope_malformed: bool,
    trace_id: Option<String>,
    first_ts: i64,
    last_ts: i64,
    wall_time: bool,
    citations: Vec<ExceptionEventCitation>,
    complete: bool,
}

impl RenderEpisode {
    fn first_seq(&self) -> u64 {
        self.citations.first().map_or(0, |c| c.seq)
    }

    fn last_seq(&self) -> u64 {
        self.citations.last().map_or(0, |c| c.seq)
    }

    fn strong_execution_key(&self) -> Option<String> {
        // Fail closed: conflicted/malformed envelopes never contribute a key.
        if self.execution_key_conflict || self.envelope_malformed {
            return None;
        }
        if let Some(t) = &self.thread {
            if !t.is_empty() {
                return Some(format!("thread:{t}"));
            }
        }
        if let Some(t) = &self.trace_id {
            if !t.is_empty() {
                return Some(format!("trace:{t}"));
            }
        }
        None
    }
}

/// Recognized stream token on an exception envelope (exact `[stderr]` only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum EnvelopeStream {
    Stderr,
}

/// Private typed view of one message's exception envelope (single parser).
///
/// Shared by candidate detection, signature extraction, classification,
/// rendering construction, attachment compatibility, and execution-key use.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ExceptionEnvelope {
    /// Structural body after level / stream / parenthesized-thread prefixes.
    structural_payload: String,
    /// Exact stream marker when recognized (`[stderr]` only; not stdout / ish).
    stream: Option<EnvelopeStream>,
    /// Explicit `thread=` / `thread_id=` / `threadId=` / `tid=` evidence.
    explicit_thread: Option<String>,
    /// Bounded parenthesized thread immediately after `[stderr]`.
    parenthesized_thread: Option<String>,
    /// Explicit and parenthesized keys both present and unequal.
    execution_key_conflict: bool,
    /// Unbalanced / empty / invalid parenthesized thread delimiter state.
    malformed: bool,
}

impl ExceptionEnvelope {
    /// Effective thread for lane keys and correlation (None if conflict/malformed).
    fn effective_thread(&self) -> Option<&str> {
        if self.execution_key_conflict || self.malformed {
            return None;
        }
        self.explicit_thread
            .as_deref()
            .or(self.parenthesized_thread.as_deref())
    }

    fn is_stderr_stream(&self) -> bool {
        matches!(self.stream, Some(EnvelopeStream::Stderr))
    }

    /// True when attachment/correlation must refuse this envelope.
    fn fail_closed_for_attachment(&self) -> bool {
        self.execution_key_conflict || self.malformed
    }
}

/// Open separately-wrapped assembly key: source + typed thread evidence.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct WrapLaneKey {
    source: String,
    /// `None` = unkeyed plain stderr/stream lane on this source.
    thread: Option<String>,
}

/// Analyze one corpus while honoring an exact suppression lens.
pub fn analyze_exception_episodes(
    corpus: &LogCorpus,
    excluded_template_ids: &[u64],
) -> CoreResult<ExceptionEpisodeAnalysis> {
    analyze_exception_episodes_with_cancel(corpus, excluded_template_ids, None)
}

/// Cancellation-aware form used by deterministic broad triage.
pub fn analyze_exception_episodes_with_cancel(
    corpus: &LogCorpus,
    excluded_template_ids: &[u64],
    cancel: Option<&AtomicBool>,
) -> CoreResult<ExceptionEpisodeAnalysis> {
    let is_cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::SeqCst));
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }

    // Pin revisions before multi-page scan; fail closed on concurrent mutation.
    let pinned_event_revision = corpus.event_revision();
    let pinned_template_revision = corpus.template_analysis_revision();

    // Candidate scan is severity-independent: walk store rows and keep only
    // structure-based exception candidates (heads/causes/frames/wrappers).
    let filter = EventQuery {
        excluded_template_ids: excluded_template_ids.to_vec(),
        sort_by_time: false,
        ..Default::default()
    };
    let store_total = query_event_count(corpus, &filter)?.total_matched;
    check_revisions(corpus, pinned_event_revision, pinned_template_revision)?;

    let candidate_cap = effective_candidate_cap();
    let row_walk_cap = effective_row_walk_cap();
    let mut candidates = Vec::new();
    let mut rows_walked: u64 = 0;
    let mut after_seq = None;
    let mut walk_truncated = false;
    let mut candidate_truncated = false;
    let mut store_eof = false;
    let mut page_index: usize = 0;

    // Keep walking until EOF, row-walk cap, or a candidate beyond retention cap.
    // Filling the retention cap alone must NOT stop the walk: only a later
    // candidate (overflow) or proven EOF decides completeness.
    while rows_walked < row_walk_cap as u64 {
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        check_revisions(corpus, pinned_event_revision, pinned_template_revision)?;
        let walk_remaining = row_walk_cap as u64 - rows_walked;
        let page_limit = (walk_remaining as usize).min(MAX_EVENT_PAGE);
        let page = query_event_rows(
            corpus,
            &EventQuery {
                after_seq,
                limit: page_limit,
                ..filter.clone()
            },
        )?;
        #[cfg(test)]
        invoke_episode_scan_page_hook(page_index);
        page_index = page_index.saturating_add(1);

        if page.events.is_empty() {
            store_eof = true;
            break;
        }
        after_seq = page.events.last().map(|event| event.seq);
        let page_len = page.events.len() as u64;
        rows_walked += page_len;
        for event in page.events {
            if is_cancelled() {
                return Err(CoreError::Cancelled);
            }
            if is_exception_candidate(&event) {
                if candidates.len() < candidate_cap {
                    candidates.push(event);
                } else {
                    // Cap already full: any further candidate means incomplete.
                    candidate_truncated = true;
                    break;
                }
            }
        }
        if candidate_truncated {
            break;
        }
        if page_len < page_limit as u64 {
            store_eof = true;
            break;
        }
        if rows_walked >= row_walk_cap as u64 && store_total > rows_walked {
            walk_truncated = true;
            break;
        }
    }
    check_revisions(corpus, pinned_event_revision, pinned_template_revision)?;
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }

    // Fail closed whenever the candidate cap prevents proving EOF:
    // - overflow candidate after cap → candidate_truncated
    // - walk cap hit before store EOF → walk_truncated
    // - filled cap but exited without store_eof (should not happen with continued
    //   walk; retained as belt-and-suspenders)
    if candidates.len() == candidate_cap && !candidate_truncated && !store_eof && !walk_truncated {
        candidate_truncated = true;
    }
    // Exact CAP + proven store_eof with no overflow → complete totals allowed.
    let incomplete = walk_truncated || candidate_truncated;

    let candidate_scope = format!(
        "structure_based_exception_candidates_independent_of_severity; \
         rows_walked={rows_walked}/{row_walk_cap}; \
         candidates_retained={}/{candidate_cap}; \
         store_rows_under_suppression={store_total}; \
         store_eof={store_eof}; \
         candidate_cap_prevents_complete_totals={}",
        candidates.len(),
        incomplete
    );
    // When caps prevent EOF proof, available count is a strict lower bound.
    let events_available = if incomplete {
        candidates.len() as u64 + 1
    } else {
        candidates.len() as u64
    };

    let mut analysis = analyze_bounded_events_cancellable(
        events_available,
        &candidates,
        &is_cancelled,
        MatchingMeta::default(),
    )?;
    analysis.rows_walked = rows_walked;
    analysis.row_walk_cap = row_walk_cap;
    analysis.event_scan_cap = candidate_cap;
    analysis.candidate_scope = candidate_scope;
    analysis.pinned_event_revision = Some(pinned_event_revision);
    analysis.pinned_template_analysis_revision = Some(pinned_template_revision);
    if incomplete {
        analysis.partial = true;
        analysis.counts_complete = false;
        if !analysis.ranking_disclosure.contains("lower_bound") {
            analysis.candidate_scope.push_str(
                "; available_candidate_count_is_lower_bound=true; \
                 never_claim_complete_corpus_totals_under_candidate_cap_without_eof",
            );
        }
    }
    // Recompute disclosure after partial flags settle.
    analysis.ranking_disclosure = build_ranking_disclosure(&analysis);
    Ok(analysis)
}

fn check_revisions(corpus: &LogCorpus, pinned_event: u64, pinned_template: u64) -> CoreResult<()> {
    if corpus.event_revision() != pinned_event {
        return Err(CoreError::Message(
            "log corpus event revision changed during exception episode scan; retry".into(),
        ));
    }
    if corpus.template_analysis_revision() != pinned_template {
        return Err(CoreError::Message(
            "log template analysis revision changed during exception episode scan; retry".into(),
        ));
    }
    Ok(())
}

/// Structure-based exception candidate predicate (not severity / not English "error").
pub fn is_exception_candidate(event: &ExplorerEvent) -> bool {
    let message = event.message.as_str();
    let env = parse_exception_envelope(message);
    let payload = env.structural_payload.as_str();
    if exception_signature(payload).is_some() || exception_signature(message).is_some() {
        return true;
    }
    if has_stack_frame(message) || has_stack_frame(payload) {
        return true;
    }
    if payload.lines().any(|line| {
        let line = line.trim();
        is_stack_continuation(line)
            || is_wrapper_scaffold_line(line)
            || looks_like_exception_header_line(line)
    }) {
        return true;
    }
    // Separately wrapped stream marker with structural exception content only.
    if env.is_stderr_stream() {
        let p = payload.trim();
        if is_stack_continuation(p)
            || looks_like_exception_header_line(p)
            || is_wrapper_scaffold_line(p)
        {
            return true;
        }
    }
    false
}

/// CancelFlag adapter for hosts that already use process_progress cancel tokens.
pub fn analyze_exception_episodes_with_cancel_flag(
    corpus: &LogCorpus,
    excluded_template_ids: &[u64],
    cancel: Option<&CancelFlag>,
) -> CoreResult<ExceptionEpisodeAnalysis> {
    let atomic = cancel.map(CancelFlag::inner_arc);
    analyze_exception_episodes_with_cancel(
        corpus,
        excluded_template_ids,
        atomic.as_ref().map(|a| a.as_ref()),
    )
}

/// Pure analysis over an in-memory event list (tests + offline adapters).
pub fn analyze_bounded_events(
    events_available: u64,
    events: &[ExplorerEvent],
) -> ExceptionEpisodeAnalysis {
    analyze_bounded_events_cancellable(events_available, events, &|| false, MatchingMeta::default())
        .expect("non-cancellable bounded analysis")
}

#[derive(Debug, Clone, Default)]
struct MatchingMeta {
    unpaired_renderings: u64,
    ambiguous: bool,
}

fn analyze_bounded_events_cancellable(
    events_available: u64,
    events: &[ExplorerEvent],
    is_cancelled: &dyn Fn() -> bool,
    _seed_meta: MatchingMeta,
) -> CoreResult<ExceptionEpisodeAnalysis> {
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    // Stable physical derivation: sort by seq/source so input reorder cannot
    // regroup separately-wrapped streams differently before matching.
    let mut ordered: Vec<ExplorerEvent> = events.to_vec();
    ordered.sort_by(|a, b| {
        a.seq
            .cmp(&b.seq)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.ts.cmp(&b.ts))
    });
    let (renderings, render_partial) = derive_render_episodes_cancellable(&ordered, is_cancelled)?;
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    let application_exception_record_count = renderings
        .iter()
        .filter(|r| r.kind == ExceptionRenderingKind::ApplicationFullStack)
        .map(|r| r.citations.len() as u64)
        .sum();
    let stderr_exception_record_count = renderings
        .iter()
        .filter(|r| r.kind == ExceptionRenderingKind::SeparatelyWrappedRecords)
        .map(|r| r.citations.len() as u64)
        .sum();
    let raw_exception_record_count =
        application_exception_record_count + stderr_exception_record_count;
    let rendering_episode_count = renderings.len() as u64;
    let (occurrences, match_meta) = correlate_renderings_cancellable(renderings, is_cancelled)?;
    let occurrence_count = occurrences.len() as u64;
    let duplicate_rendering_occurrence_count = occurrences
        .iter()
        .filter(|(_, occurrence)| occurrence.duplicate_rendering)
        .count() as u64;
    let uncertain = occurrences.iter().any(|(_, occurrence)| {
        !occurrence.citations_complete
            || (occurrence.duplicate_rendering
                && occurrence.correlation_confidence != ExceptionCorrelationConfidence::Strong)
    });

    let mut grouped: BTreeMap<String, Vec<ExceptionOccurrenceSummary>> = BTreeMap::new();
    for (signature, occurrence) in occurrences {
        grouped.entry(signature).or_default().push(occurrence);
    }
    let family_count_available = grouped.len() as u64;
    let mut families = grouped
        .into_iter()
        .map(|(signature, occs)| {
            let raw_record_count = occs.iter().map(|o| o.raw_record_count).sum::<u64>();
            let application_record_count =
                occs.iter().map(|o| o.application_record_count).sum::<u64>();
            let stderr_record_count = occs.iter().map(|o| o.stderr_record_count).sum::<u64>();
            let rendering_episode_count = occs.iter().map(|o| o.rendering_count).sum::<u64>();
            let duplicate_rendering_occurrence_count =
                occs.iter().filter(|o| o.duplicate_rendering).count() as u64;
            let uncertain_occurrence_count = occs
                .iter()
                .filter(|o| {
                    !o.citations_complete
                        || (o.duplicate_rendering
                            && o.correlation_confidence != ExceptionCorrelationConfidence::Strong)
                })
                .count() as u64;
            let occurrence_count = occs.len() as u64;
            debug_assert_eq!(
                application_record_count + stderr_record_count,
                raw_record_count
            );
            let amplification = ExceptionAmplificationMetrics::from_counts(
                raw_record_count,
                application_record_count,
                stderr_record_count,
                rendering_episode_count,
                occurrence_count,
            );
            ExceptionFamilySummary {
                signature,
                raw_record_count,
                application_record_count,
                stderr_record_count,
                rendering_episode_count,
                occurrence_count,
                duplicate_rendering_occurrence_count,
                uncertain_occurrence_count,
                amplification,
                occurrences: occs,
            }
        })
        .collect::<Vec<_>>();
    families.sort_by(|left, right| {
        right
            .occurrence_count
            .cmp(&left.occurrence_count)
            .then_with(|| right.raw_record_count.cmp(&left.raw_record_count))
            .then_with(|| left.signature.cmp(&right.signature))
    });
    families.truncate(EXCEPTION_EPISODE_FAMILY_CAP);

    let amplification = ExceptionAmplificationMetrics::from_counts(
        raw_exception_record_count,
        application_exception_record_count,
        stderr_exception_record_count,
        rendering_episode_count,
        occurrence_count,
    );

    let scan_partial = events_available > events.len() as u64;
    let family_partial = family_count_available > EXCEPTION_EPISODE_FAMILY_CAP as u64;
    let partial = scan_partial || render_partial || family_partial;
    let counts_complete = !partial;

    let mut analysis = ExceptionEpisodeAnalysis {
        schema_id: EXCEPTION_EPISODE_SCHEMA_ID.into(),
        schema_version: EXCEPTION_EPISODE_SCHEMA_VERSION,
        rows_walked: events.len() as u64,
        row_walk_cap: EXCEPTION_EPISODE_ROW_WALK_CAP,
        events_available,
        events_scanned: events.len() as u64,
        event_scan_cap: EXCEPTION_EPISODE_EVENT_SCAN_CAP,
        candidate_scope: "in_memory_event_list".into(),
        raw_exception_record_count,
        application_exception_record_count,
        stderr_exception_record_count,
        rendering_episode_count,
        unpaired_rendering_count: match_meta.unpaired_renderings,
        occurrence_count,
        duplicate_rendering_occurrence_count,
        family_count_available,
        family_cap: EXCEPTION_EPISODE_FAMILY_CAP,
        amplification,
        partial,
        counts_complete,
        uncertain,
        matching_policy:
            "max_cardinality_bipartite_distance_ordered_dfs; not unique-optimum assignment".into(),
        matching_ambiguous: match_meta.ambiguous,
        pinned_event_revision: None,
        pinned_template_analysis_revision: None,
        ranking_disclosure: String::new(),
        families,
    };
    analysis.ranking_disclosure = build_ranking_disclosure(&analysis);
    Ok(analysis)
}

fn build_ranking_disclosure(report: &ExceptionEpisodeAnalysis) -> String {
    let amp = &report.amplification;
    format!(
        "ranking_basis: semantic_occurrence_count_not_raw_stack_volume\n\
         candidate_scope: {}\n\
         layer_raw_exception_records: {}\n\
         layer_application_exception_records: {}\n\
         layer_stderr_exception_records: {}\n\
         layer_physical_renderings: {}\n\
         layer_unpaired_renderings: {}\n\
         layer_semantic_occurrences: {}\n\
         layer_duplicate_rendering_occurrences: {}\n\
         amplification_raw_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_stderr_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_application_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_renderings_per_occurrence: {}/{} = {} rem {} integral={}\n\
         counts_complete: {}\n\
         matching_policy: {}\n\
         matching_ambiguous: {}\n\
         independent_incident_claim_forbidden: true\n\
         interpretation: wrappers and stack frames are supporting records of a rendering; \
         duplicate renderings use max-cardinality bipartite matching with distance-ordered DFS \
         (deterministic; not claimed as the unique global optimum when ambiguous). \
         Order-only cross-source merge requires a strong execution key. \
         When counts_complete=false/partial=true, counts must not be presented as corpus-wide totals.\n",
        report.candidate_scope,
        report.raw_exception_record_count,
        report.application_exception_record_count,
        report.stderr_exception_record_count,
        report.rendering_episode_count,
        report.unpaired_rendering_count,
        report.occurrence_count,
        report.duplicate_rendering_occurrence_count,
        amp.raw_records_per_occurrence.numerator,
        amp.raw_records_per_occurrence.denominator,
        amp.raw_records_per_occurrence.quotient,
        amp.raw_records_per_occurrence.remainder,
        amp.raw_records_per_occurrence.ratio_integral(),
        amp.stderr_records_per_occurrence.numerator,
        amp.stderr_records_per_occurrence.denominator,
        amp.stderr_records_per_occurrence.quotient,
        amp.stderr_records_per_occurrence.remainder,
        amp.stderr_records_per_occurrence.ratio_integral(),
        amp.application_records_per_occurrence.numerator,
        amp.application_records_per_occurrence.denominator,
        amp.application_records_per_occurrence.quotient,
        amp.application_records_per_occurrence.remainder,
        amp.application_records_per_occurrence.ratio_integral(),
        amp.renderings_per_occurrence.numerator,
        amp.renderings_per_occurrence.denominator,
        amp.renderings_per_occurrence.quotient,
        amp.renderings_per_occurrence.remainder,
        amp.renderings_per_occurrence.ratio_integral(),
        report.counts_complete,
        report.matching_policy,
        report.matching_ambiguous,
    )
}

/// Project one template onto semantic occurrences (at most once per occurrence).
pub fn project_template_onto_episodes(
    report: &ExceptionEpisodeAnalysis,
    template_id: u64,
) -> TemplateEpisodeProjection {
    if report.partial || !report.counts_complete {
        return TemplateEpisodeProjection {
            template_id,
            occurrence_count: None,
            lead_occurrence_count: None,
            supporting_only_occurrence_count: None,
            complete: false,
            incomplete_reason: Some(
                "analysis partial or incomplete; template occurrence projection withheld".into(),
            ),
        };
    }
    let mut occurrence_count = 0u64;
    let mut lead_occurrence_count = 0u64;
    let mut supporting_only_occurrence_count = 0u64;
    let mut any_incomplete_citation = false;
    for family in &report.families {
        for occ in &family.occurrences {
            if !occ.citations_complete {
                any_incomplete_citation = true;
            }
            let mut seen_lead = false;
            let mut seen_support = false;
            let mut seen = false;
            for c in &occ.citations {
                if c.template_id != template_id {
                    continue;
                }
                seen = true;
                match c.role {
                    ExceptionCitationRole::RenderingLead => seen_lead = true,
                    ExceptionCitationRole::SupportingRecord => seen_support = true,
                }
            }
            if seen {
                occurrence_count += 1;
                if seen_lead {
                    lead_occurrence_count += 1;
                } else if seen_support {
                    supporting_only_occurrence_count += 1;
                }
            }
        }
    }
    if any_incomplete_citation {
        return TemplateEpisodeProjection {
            template_id,
            occurrence_count: None,
            lead_occurrence_count: None,
            supporting_only_occurrence_count: None,
            complete: false,
            incomplete_reason: Some(
                "at least one occurrence has truncated citations; projection withheld".into(),
            ),
        };
    }
    TemplateEpisodeProjection {
        template_id,
        occurrence_count: Some(occurrence_count),
        lead_occurrence_count: Some(lead_occurrence_count),
        supporting_only_occurrence_count: Some(supporting_only_occurrence_count),
        complete: true,
        incomplete_reason: None,
    }
}

/// Compact multi-line text for broad-triage brief inclusion (byte-budget aware).
pub fn format_exception_episode_brief_section(report: &ExceptionEpisodeAnalysis) -> String {
    let mut out = String::new();
    out.push_str("## Exception episode correlation\n");
    let amp = &report.amplification;
    // Keep this section dense: full ranking_disclosure lives on the DTO for hosts
    // that need it; the brief only carries the triage-critical lines.
    out.push_str(&format!(
        "schema_id: {}\nschema_version: {}\n\
         independent_incident_claim_forbidden: true\n\
         counts_complete: {}\npartial: {}\nuncertain: {}\nmatching_ambiguous: {}\n\
         raw_exception_record_count: {}\n\
         application_exception_record_count: {}\n\
         stderr_exception_record_count: {}\n\
         physical_rendering_count: {}\n\
         unpaired_rendering_count: {}\n\
         semantic_occurrence_count: {}\n\
         duplicate_rendering_occurrence_count: {}\n\
         amplification_raw_records_per_occurrence: {}/{} = {} rem {}\n\
         amplification_stderr_records_per_occurrence: {}/{} = {} rem {}\n\
         amplification_renderings_per_occurrence: {}/{} = {} rem {}\n\
         matching_policy: {}\n",
        report.schema_id,
        report.schema_version,
        report.counts_complete,
        report.partial,
        report.uncertain,
        report.matching_ambiguous,
        report.raw_exception_record_count,
        report.application_exception_record_count,
        report.stderr_exception_record_count,
        report.rendering_episode_count,
        report.unpaired_rendering_count,
        report.occurrence_count,
        report.duplicate_rendering_occurrence_count,
        amp.raw_records_per_occurrence.numerator,
        amp.raw_records_per_occurrence.denominator,
        amp.raw_records_per_occurrence.quotient,
        amp.raw_records_per_occurrence.remainder,
        amp.stderr_records_per_occurrence.numerator,
        amp.stderr_records_per_occurrence.denominator,
        amp.stderr_records_per_occurrence.quotient,
        amp.stderr_records_per_occurrence.remainder,
        amp.renderings_per_occurrence.numerator,
        amp.renderings_per_occurrence.denominator,
        amp.renderings_per_occurrence.quotient,
        amp.renderings_per_occurrence.remainder,
        report.matching_policy
    ));
    for family in report.families.iter().take(4) {
        let famp = &family.amplification;
        let sig = {
            let mut s: String = family.signature.chars().take(96).collect();
            if family.signature.chars().count() > 96 {
                s.push('…');
            }
            s
        };
        out.push_str(&format!(
            "- signature={sig} occurrences={} raw={} app={} stderr={} \
             raw_per_occ={}/{}={} rem{} duplicates={}\n",
            family.occurrence_count,
            family.raw_record_count,
            family.application_record_count,
            family.stderr_record_count,
            famp.raw_records_per_occurrence.numerator,
            famp.raw_records_per_occurrence.denominator,
            famp.raw_records_per_occurrence.quotient,
            famp.raw_records_per_occurrence.remainder,
            family.duplicate_rendering_occurrence_count
        ));
        for occ in family.occurrences.iter().take(1) {
            out.push_str(&format!(
                "  occurrence raw={} app={} stderr={} renderings={} duplicate={}\n",
                occ.raw_record_count,
                occ.application_record_count,
                occ.stderr_record_count,
                occ.rendering_count,
                occ.duplicate_rendering
            ));
            for c in occ.citations.iter().take(2) {
                out.push_str(&format!(
                    "    cite seq={} source={} template_id={} role={:?}\n",
                    c.seq, c.source, c.template_id, c.role
                ));
            }
        }
    }
    out.push_str(
        "interpretation: do not treat raw stack-frame volume as independent incidents; \
         prefer semantic_occurrence_count and typed amplification ratios with remainders; \
         counts_complete is independent of ratio_integral.\n",
    );
    out
}

// ---------------------------------------------------------------------------
// Layer 2: physical renderings
// ---------------------------------------------------------------------------

fn derive_render_episodes_cancellable(
    events: &[ExplorerEvent],
    is_cancelled: &dyn Fn() -> bool,
) -> CoreResult<(Vec<RenderEpisode>, bool)> {
    let mut episodes = Vec::new();
    // Per execution-lane open separately-wrapped rendering (source + thread).
    let mut open_wrap: BTreeMap<WrapLaneKey, RenderEpisode> = BTreeMap::new();
    let mut partial = false;

    for (i, event) in events.iter().enumerate() {
        if i % 64 == 0 && is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let source = event.source.clone();
        let env = parse_exception_envelope(&event.message);
        let payload = env.structural_payload.as_str();
        let is_wrapped_line =
            env.is_stderr_stream() || is_single_line_exception_record(event, payload);
        let lane = wrap_lane_key(&source, &env);

        if is_wrapped_line {
            let signature = exception_signature(payload);
            let complete_stack = has_stack_frame(payload) && signature.is_some();

            // Conflicted/malformed envelopes never attach into an open lane.
            if env.fail_closed_for_attachment() {
                close_source_lanes(&mut open_wrap, &source, &mut episodes, &mut partial);
                if let Some(signature) = signature {
                    // Header/cause with a real signature can stand alone, but
                    // never joins another rendering under a conflicted key.
                    finish_episode(
                        &mut episodes,
                        Some(new_episode(
                            event,
                            &env,
                            signature,
                            ExceptionRenderingKind::SeparatelyWrappedRecords,
                        )),
                        &mut partial,
                    );
                }
                // Pure frames/scaffold under fail-closed keys are not attached.
                continue;
            }

            if complete_stack {
                // Full stack arrived as one separately-wrapped payload.
                if let Some(open) = open_wrap.remove(&lane) {
                    finish_episode(&mut episodes, Some(open), &mut partial);
                }
                if let Some(signature) = signature {
                    finish_episode(
                        &mut episodes,
                        Some(new_episode(
                            event,
                            &env,
                            signature,
                            ExceptionRenderingKind::SeparatelyWrappedRecords,
                        )),
                        &mut partial,
                    );
                }
            } else if let Some(signature) = signature {
                let is_cause = payload.trim_start().starts_with("Caused by:");
                let can_attach = open_wrap
                    .get(&lane)
                    .is_some_and(|open| adjacent_compatible(open, event, &env));
                if is_cause && can_attach {
                    let open = open_wrap.get_mut(&lane).expect("checked");
                    attach(open, event, &env);
                    // Prefer root-cause signature (matches app full-stack last exception).
                    open.signature = signature;
                } else if can_attach
                    && open_wrap
                        .get(&lane)
                        .is_some_and(|o| o.signature == signature || is_stack_continuation(payload))
                {
                    if looks_like_exception_header_line(payload)
                        && open_wrap
                            .get(&lane)
                            .is_some_and(|o| o.signature != signature)
                    {
                        if let Some(open) = open_wrap.remove(&lane) {
                            finish_episode(&mut episodes, Some(open), &mut partial);
                        }
                        open_wrap.insert(
                            lane.clone(),
                            new_episode(
                                event,
                                &env,
                                signature,
                                ExceptionRenderingKind::SeparatelyWrappedRecords,
                            ),
                        );
                    } else if looks_like_exception_header_line(payload) {
                        // New header same lane → finish previous episode.
                        if let Some(open) = open_wrap.remove(&lane) {
                            finish_episode(&mut episodes, Some(open), &mut partial);
                        }
                        open_wrap.insert(
                            lane.clone(),
                            new_episode(
                                event,
                                &env,
                                signature,
                                ExceptionRenderingKind::SeparatelyWrappedRecords,
                            ),
                        );
                    } else if let Some(open) = open_wrap.get_mut(&lane) {
                        attach(open, event, &env);
                    }
                } else {
                    if let Some(open) = open_wrap.remove(&lane) {
                        finish_episode(&mut episodes, Some(open), &mut partial);
                    }
                    open_wrap.insert(
                        lane.clone(),
                        new_episode(
                            event,
                            &env,
                            signature,
                            ExceptionRenderingKind::SeparatelyWrappedRecords,
                        ),
                    );
                }
            } else if open_wrap
                .get(&lane)
                .is_some_and(|open| adjacent_compatible(open, event, &env))
                && (is_stack_continuation(payload) || is_wrapper_scaffold_line(payload))
            {
                // Frames and wrapper scaffolding attach without inventing a new signature.
                if let Some(open) = open_wrap.get_mut(&lane) {
                    attach(open, event, &env);
                }
            } else if open_wrap.get(&lane).is_some_and(|open| {
                event.seq.saturating_sub(open.last_seq()) > MAX_ADJACENT_SEQ_GAP
            }) {
                if let Some(open) = open_wrap.remove(&lane) {
                    finish_episode(&mut episodes, Some(open), &mut partial);
                }
            }
            continue;
        }

        // Non-wrapped: close open wraps on this source (all thread lanes), then
        // maybe full-stack app record.
        close_source_lanes(&mut open_wrap, &source, &mut episodes, &mut partial);
        if has_stack_frame(&event.message) {
            if let Some(signature) = exception_signature(&event.message) {
                finish_episode(
                    &mut episodes,
                    Some(new_episode(
                        event,
                        &env,
                        signature,
                        ExceptionRenderingKind::ApplicationFullStack,
                    )),
                    &mut partial,
                );
            }
        }
    }
    for (_, open) in open_wrap {
        finish_episode(&mut episodes, Some(open), &mut partial);
    }
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    Ok((episodes, partial))
}

fn wrap_lane_key(source: &str, env: &ExceptionEnvelope) -> WrapLaneKey {
    WrapLaneKey {
        source: source.to_string(),
        thread: env.effective_thread().map(str::to_string),
    }
}

fn close_source_lanes(
    open_wrap: &mut BTreeMap<WrapLaneKey, RenderEpisode>,
    source: &str,
    episodes: &mut Vec<RenderEpisode>,
    partial: &mut bool,
) {
    let keys: Vec<WrapLaneKey> = open_wrap
        .keys()
        .filter(|k| k.source == source)
        .cloned()
        .collect();
    for key in keys {
        if let Some(open) = open_wrap.remove(&key) {
            finish_episode(episodes, Some(open), partial);
        }
    }
}

fn is_single_line_exception_record(_event: &ExplorerEvent, payload: &str) -> bool {
    // Separately timestamped stream lines: one logical line of exception structure
    // without embedding a full multi-frame stack in the same durable event.
    let lines = payload.lines().filter(|l| !l.trim().is_empty()).count();
    if lines > 1 {
        return false;
    }
    let p = payload.trim();
    is_stack_continuation(p)
        || looks_like_exception_header_line(p)
        || is_wrapper_scaffold_line(p)
        || p.starts_with("at ")
        || looks_like_exception_header_line(p)
}

fn is_wrapper_scaffold_line(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("Exception in thread")
        || t.contains("Exception wrapper")
        || t.starts_with("Wrapped by:")
        || t.starts_with("Nested exception")
        || (t.starts_with("... ") && t.ends_with(" more"))
}

fn finish_episode(
    episodes: &mut Vec<RenderEpisode>,
    episode: Option<RenderEpisode>,
    partial: &mut bool,
) {
    let Some(episode) = episode else { return };
    if episodes.len() < EXCEPTION_EPISODE_RENDER_CAP {
        episodes.push(episode);
    } else {
        *partial = true;
    }
}

fn new_episode(
    event: &ExplorerEvent,
    env: &ExceptionEnvelope,
    signature: String,
    kind: ExceptionRenderingKind,
) -> RenderEpisode {
    RenderEpisode {
        signature,
        kind,
        source: event.source.clone(),
        service: event.service.clone(),
        host: event.host.clone(),
        thread: env.effective_thread().map(str::to_string),
        execution_key_conflict: env.execution_key_conflict,
        envelope_malformed: env.malformed,
        trace_id: event.trace_id.clone(),
        first_ts: event.ts,
        last_ts: event.ts,
        wall_time: event.active_timestamp_basis.is_wall_clock(),
        citations: vec![citation(event, kind, ExceptionCitationRole::RenderingLead)],
        complete: true,
    }
}

fn attach(episode: &mut RenderEpisode, event: &ExplorerEvent, env: &ExceptionEnvelope) {
    if episode.citations.len() >= EXCEPTION_EPISODE_RECORD_CAP {
        episode.complete = false;
        return;
    }
    episode.last_ts = event.ts;
    if env.execution_key_conflict {
        episode.execution_key_conflict = true;
    }
    if env.malformed {
        episode.envelope_malformed = true;
    }
    if episode.thread.is_none() {
        episode.thread = env.effective_thread().map(str::to_string);
    }
    if episode.trace_id.is_none() {
        episode.trace_id = event.trace_id.clone();
    }
    episode.citations.push(citation(
        event,
        episode.kind,
        ExceptionCitationRole::SupportingRecord,
    ));
}

fn citation(
    event: &ExplorerEvent,
    rendering_kind: ExceptionRenderingKind,
    role: ExceptionCitationRole,
) -> ExceptionEventCitation {
    ExceptionEventCitation {
        seq: event.seq,
        source: event.source.clone(),
        template_id: event.template_id,
        role,
        rendering_kind,
    }
}

fn adjacent_compatible(
    episode: &RenderEpisode,
    event: &ExplorerEvent,
    env: &ExceptionEnvelope,
) -> bool {
    if episode.execution_key_conflict
        || episode.envelope_malformed
        || env.fail_closed_for_attachment()
    {
        return false;
    }
    if episode.source != event.source
        || event.seq.saturating_sub(episode.last_seq()) > MAX_ADJACENT_SEQ_GAP
    {
        return false;
    }
    let thread = env.effective_thread().map(str::to_string);
    if episode.thread.is_some() && thread.is_some() && episode.thread != thread {
        return false;
    }
    // Unkeyed open must not absorb a keyed event (and vice versa already separated by lane).
    if episode.thread.is_some() != thread.is_some() {
        return false;
    }
    if episode.wall_time && event.active_timestamp_basis.is_wall_clock() {
        event.ts.abs_diff(episode.last_ts) <= MAX_ADJACENT_WALL_SECONDS as u64
    } else {
        // Order-only: seq gap already enforced; allow attach within stream.
        true
    }
}

// ---------------------------------------------------------------------------
// Layer 3: semantic occurrences (duplicate-render correlation)
// ---------------------------------------------------------------------------

/// One-to-one duplicate-rendering matching via max-cardinality bipartite DFS.
///
/// Unlike reverse-insertion greedy, this reassigns along augmenting paths so a
/// locally preferred edge cannot permanently steal a partner that enables a
/// larger matching. Neighbor order is stable: stronger confidence, then smaller
/// axis distance, then seq/source ties. Policy is deterministic under input
/// reorder but is **not** claimed as the unique global optimum of all max
/// matchings; `matching_ambiguous` is set when alternate max-cardinality
/// choices were available.
fn correlate_renderings_cancellable(
    renderings: Vec<RenderEpisode>,
    is_cancelled: &dyn Fn() -> bool,
) -> CoreResult<(Vec<(String, ExceptionOccurrenceSummary)>, MatchingMeta)> {
    let n = renderings.len();
    let mut by_signature: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (idx, rendering) in renderings.iter().enumerate() {
        by_signature
            .entry(rendering.signature.clone())
            .or_default()
            .push(idx);
    }

    let mut paired = vec![false; n];
    let mut pairs: Vec<(String, usize, usize, ExceptionCorrelationConfidence)> = Vec::new();
    let mut matching_ambiguous = false;

    for (signature, indices) in &by_signature {
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let mut apps = Vec::new();
        let mut wraps = Vec::new();
        for &idx in indices {
            match renderings[idx].kind {
                ExceptionRenderingKind::ApplicationFullStack => apps.push(idx),
                ExceptionRenderingKind::SeparatelyWrappedRecords => wraps.push(idx),
            }
        }
        // Stable left/right order by first_seq/source.
        apps.sort_by(|&a, &b| {
            renderings[a]
                .first_seq()
                .cmp(&renderings[b].first_seq())
                .then_with(|| renderings[a].source.cmp(&renderings[b].source))
                .then_with(|| a.cmp(&b))
        });
        wraps.sort_by(|&a, &b| {
            renderings[a]
                .first_seq()
                .cmp(&renderings[b].first_seq())
                .then_with(|| renderings[a].source.cmp(&renderings[b].source))
                .then_with(|| a.cmp(&b))
        });

        let n_l = apps.len();
        let n_r = wraps.len();
        if n_l == 0 || n_r == 0 {
            continue;
        }

        // adj[l] = list of (right_local, conf_rank, distance, confidence) sorted by preference
        let mut adj: Vec<Vec<(usize, u8, u64, ExceptionCorrelationConfidence)>> =
            vec![Vec::new(); n_l];
        for (li, &app_idx) in apps.iter().enumerate() {
            for (ri, &wrap_idx) in wraps.iter().enumerate() {
                let Some(confidence) =
                    duplicate_evidence(&renderings[app_idx], &renderings[wrap_idx])
                else {
                    continue;
                };
                let conf_rank = match confidence {
                    ExceptionCorrelationConfidence::Strong => 0u8,
                    ExceptionCorrelationConfidence::Moderate => 1u8,
                    ExceptionCorrelationConfidence::Uncorrelated => 2u8,
                };
                let distance = axis_distance(&renderings[app_idx], &renderings[wrap_idx]);
                adj[li].push((ri, conf_rank, distance, confidence));
            }
            adj[li].sort_by(|a, b| {
                a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)).then_with(|| {
                    let wa = wraps[a.0];
                    let wb = wraps[b.0];
                    renderings[wa]
                        .first_seq()
                        .cmp(&renderings[wb].first_seq())
                        .then_with(|| renderings[wa].source.cmp(&renderings[wb].source))
                        .then_with(|| wa.cmp(&wb))
                })
            });
        }

        // Ambiguity on either bipartite side: any app with ≥2 compatible stderr
        // partners, or any stderr with ≥2 competing apps. Unique forced matchings
        // are exactly the graphs where every incident degree is ≤1.
        if bipartite_degrees_allow_alternate_max_matchings(&adj, n_r) {
            matching_ambiguous = true;
        }

        // Kuhn max-cardinality matching; mt_r[ri] = Some(li)
        let mut mt_r: Vec<Option<usize>> = vec![None; n_r];
        fn try_kuhn(
            v: usize,
            adj: &[Vec<(usize, u8, u64, ExceptionCorrelationConfidence)>],
            mt_r: &mut [Option<usize>],
            used: &mut [bool],
        ) -> bool {
            if used[v] {
                return false;
            }
            used[v] = true;
            for &(to, _, _, _) in &adj[v] {
                if mt_r[to].is_none() || try_kuhn(mt_r[to].expect("matched"), adj, mt_r, used) {
                    mt_r[to] = Some(v);
                    return true;
                }
            }
            false
        }
        for v in 0..n_l {
            let mut used = vec![false; n_l];
            let _ = try_kuhn(v, &adj, &mut mt_r, &mut used);
        }

        for (ri, li_opt) in mt_r.iter().enumerate() {
            let Some(li) = *li_opt else {
                continue;
            };
            let app_idx = apps[li];
            let wrap_idx = wraps[ri];
            let confidence = adj[li]
                .iter()
                .find(|(r, _, _, _)| *r == ri)
                .map(|(_, _, _, c)| *c)
                .unwrap_or(ExceptionCorrelationConfidence::Moderate);
            paired[app_idx] = true;
            paired[wrap_idx] = true;
            pairs.push((signature.clone(), app_idx, wrap_idx, confidence));
        }
    }

    let unpaired = paired.iter().filter(|p| !**p).count() as u64;
    let mut occurrences: Vec<(String, ExceptionOccurrenceSummary)> = Vec::new();
    for (signature, i_a, i_b, confidence) in pairs {
        let group = vec![renderings[i_a].clone(), renderings[i_b].clone()];
        occurrences.push((signature, occurrence_from_renderings(group, confidence)));
    }
    for (idx, rendering) in renderings.into_iter().enumerate() {
        if paired[idx] {
            continue;
        }
        let signature = rendering.signature.clone();
        occurrences.push((
            signature,
            occurrence_from_renderings(
                vec![rendering],
                ExceptionCorrelationConfidence::Uncorrelated,
            ),
        ));
    }
    occurrences.sort_by(|a, b| {
        a.1.first_seq
            .cmp(&b.1.first_seq)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.last_seq.cmp(&b.1.last_seq))
    });
    Ok((
        occurrences,
        MatchingMeta {
            unpaired_renderings: unpaired,
            ambiguous: matching_ambiguous,
        },
    ))
}

/// True when the bipartite edge set admits more than one maximum matching
/// candidate structure: any left degree ≥ 2 or any right degree ≥ 2.
fn bipartite_degrees_allow_alternate_max_matchings(
    adj: &[Vec<(usize, u8, u64, ExceptionCorrelationConfidence)>],
    n_r: usize,
) -> bool {
    let mut right_deg = vec![0usize; n_r];
    for list in adj {
        if list.len() >= 2 {
            return true;
        }
        for &(ri, _, _, _) in list {
            if ri < n_r {
                right_deg[ri] = right_deg[ri].saturating_add(1);
                if right_deg[ri] >= 2 {
                    return true;
                }
            }
        }
    }
    false
}

fn occurrence_from_renderings(
    renderings: Vec<RenderEpisode>,
    confidence: ExceptionCorrelationConfidence,
) -> ExceptionOccurrenceSummary {
    let mut citations = Vec::new();
    let mut seen = HashSet::new();
    let mut kinds = Vec::new();
    let mut complete = true;
    let mut application_record_count = 0u64;
    let mut stderr_record_count = 0u64;
    for rendering in &renderings {
        complete &= rendering.complete;
        if !kinds.contains(&rendering.kind) {
            kinds.push(rendering.kind);
        }
        let n = rendering.citations.len() as u64;
        match rendering.kind {
            ExceptionRenderingKind::ApplicationFullStack => application_record_count += n,
            ExceptionRenderingKind::SeparatelyWrappedRecords => stderr_record_count += n,
        }
        for citation in &rendering.citations {
            if seen.insert(citation.clone()) {
                citations.push(citation.clone());
            }
        }
    }
    citations.sort_by(|a, b| {
        a.seq
            .cmp(&b.seq)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.template_id.cmp(&b.template_id))
            .then_with(|| (a.role as u8).cmp(&(b.role as u8)))
    });
    let first_seq = citations.first().map_or(0, |c| c.seq);
    let last_seq = citations.last().map_or(0, |c| c.seq);
    ExceptionOccurrenceSummary {
        first_seq,
        last_seq,
        raw_record_count: citations.len() as u64,
        application_record_count,
        stderr_record_count,
        rendering_count: renderings.len() as u64,
        duplicate_rendering: renderings.len() > 1,
        correlation_confidence: if renderings.len() > 1 {
            confidence
        } else {
            ExceptionCorrelationConfidence::Uncorrelated
        },
        rendering_kinds: kinds,
        citations,
        citations_complete: complete,
    }
}

/// Honest axis distance: wall-interval gap when both sides have wall time;
/// otherwise seq gap (order-only path still requires execution keys elsewhere).
fn axis_distance(left: &RenderEpisode, right: &RenderEpisode) -> u64 {
    if left.wall_time && right.wall_time {
        interval_gap(left.first_ts, left.last_ts, right.first_ts, right.last_ts)
    } else if right.first_seq() >= left.last_seq() {
        right.first_seq().saturating_sub(left.last_seq())
    } else {
        left.first_seq().saturating_sub(right.last_seq())
    }
}

fn interval_gap(a0: i64, a1: i64, b0: i64, b1: i64) -> u64 {
    let (a_lo, a_hi) = if a0 <= a1 { (a0, a1) } else { (a1, a0) };
    let (b_lo, b_hi) = if b0 <= b1 { (b0, b1) } else { (b1, b0) };
    if a_hi < b_lo {
        b_lo.abs_diff(a_hi)
    } else if b_hi < a_lo {
        a_lo.abs_diff(b_hi)
    } else {
        0
    }
}

/// Multi-signal duplicate-rendering evidence. Message equality / adjacency /
/// divisibility alone never return Some.
fn duplicate_evidence(
    left: &RenderEpisode,
    right: &RenderEpisode,
) -> Option<ExceptionCorrelationConfidence> {
    // Must be different physical rendering kinds (app full-stack vs wrapped lines).
    if left.kind == right.kind {
        return None;
    }
    // Signatures already matched by caller; still refuse empty signatures.
    if left.signature.is_empty() || right.signature.is_empty() {
        return None;
    }

    let seq_gap = if right.first_seq() >= left.last_seq() {
        right.first_seq().saturating_sub(left.last_seq())
    } else {
        left.first_seq().saturating_sub(right.last_seq())
    };
    // Same-source far seq: refuse. Dual-file streams may land far apart in
    // ingest order, so cross-source uses wall/execution-key path only.
    if seq_gap > MAX_DUPLICATE_SEQ_GAP && left.source == right.source {
        return None;
    }

    // Conflicting labeled scope fails closed (both sides present and unequal).
    let conflicting_scope =
        (left.service.is_some() && right.service.is_some() && left.service != right.service)
            || (left.host.is_some() && right.host.is_some() && left.host != right.host);
    if conflicting_scope {
        return None;
    }

    // Fail closed when either rendering carried a conflicted/malformed envelope.
    if left.execution_key_conflict
        || right.execution_key_conflict
        || left.envelope_malformed
        || right.envelope_malformed
    {
        return None;
    }

    let left_key = left.strong_execution_key();
    let right_key = right.strong_execution_key();
    let matching_execution_key = matches!((&left_key, &right_key), (Some(a), Some(b)) if a == b);
    let conflicting_execution_key = matches!((&left_key, &right_key), (Some(a), Some(b)) if a != b);
    if conflicting_execution_key {
        return None;
    }

    let both_wall = left.wall_time && right.wall_time;
    let wall_gap = interval_gap(left.first_ts, left.last_ts, right.first_ts, right.last_ts);
    let close_wall = both_wall && wall_gap <= MAX_DUPLICATE_WALL_SECONDS as u64;

    // Order-only: require strong execution key (never adjacency alone).
    if !both_wall {
        if matching_execution_key {
            return Some(ExceptionCorrelationConfidence::Strong);
        }
        return None;
    }

    // Wall-clock path: kinds differ + close wall already established.
    if !close_wall {
        return None;
    }
    if matching_execution_key {
        return Some(ExceptionCorrelationConfidence::Strong);
    }
    // Moderate: wall-close dual kinds, neither side carries an execution key.
    // (Asymmetric keys fail closed; matching keys already returned Strong.)
    if left_key.is_none() && right_key.is_none() {
        return Some(ExceptionCorrelationConfidence::Moderate);
    }
    None
}

// ---------------------------------------------------------------------------
// Unified exception-envelope parse (single private entry)
// ---------------------------------------------------------------------------

const STDERR_TOKEN: &str = "[stderr]";
const MAX_ENVELOPE_PREFIX_BYTES: usize = 256;
const MAX_THREAD_TOKEN_CHARS: usize = 96;

/// Parse one message into the shared envelope view.
///
/// Anchored, fail-closed: exact `[stderr]` only; optional bounded `(thread)`
/// immediately after the stream token; explicit `thread=` keys; never invent
/// identity from free parentheses, method calls, `[stderr-ish]`, or stdout.
fn parse_exception_envelope(message: &str) -> ExceptionEnvelope {
    let explicit_thread = extract_explicit_thread_key(message);

    let Some((token_at, after_token)) = find_exact_stderr_token(message) else {
        return ExceptionEnvelope {
            structural_payload: message.to_string(),
            stream: None,
            explicit_thread,
            parenthesized_thread: None,
            execution_key_conflict: false,
            malformed: false,
        };
    };

    // Prefix before `[stderr]` is discarded for structural classification (level /
    // logger noise). Multi-line tails after the first line stay on the payload.
    let (first_line_after, remaining_lines) = split_first_line(after_token);
    let mut rest = first_line_after.trim_start();
    let mut parenthesized_thread = None;
    let mut malformed = false;

    if rest.starts_with('(') {
        match parse_parenthesized_thread_token(rest) {
            Ok((thread, after)) => {
                parenthesized_thread = Some(thread);
                rest = after.trim_start();
            }
            Err(()) => {
                malformed = true;
                // Leave structural text as-is (including the broken '(') so we
                // do not invent a thread or silently drop payload bytes.
            }
        }
    }

    let mut structural = rest.to_string();
    if !remaining_lines.is_empty() {
        if !structural.is_empty() {
            structural.push('\n');
        }
        structural.push_str(remaining_lines);
    }

    // Bound: refuse stream recognition when the token sits too deep.
    if token_at > MAX_ENVELOPE_PREFIX_BYTES {
        return ExceptionEnvelope {
            structural_payload: message.to_string(),
            stream: None,
            explicit_thread,
            parenthesized_thread: None,
            execution_key_conflict: false,
            malformed: false,
        };
    }

    let execution_key_conflict =
        matches!((&explicit_thread, &parenthesized_thread), (Some(a), Some(b)) if a != b);

    ExceptionEnvelope {
        structural_payload: structural,
        stream: Some(EnvelopeStream::Stderr),
        explicit_thread,
        parenthesized_thread,
        execution_key_conflict,
        malformed,
    }
}

/// Exact `[stderr]` only — not `[stdout]`, not `[stderr-ish]`.
fn find_exact_stderr_token(message: &str) -> Option<(usize, &str)> {
    let position = message.find(STDERR_TOKEN)?;
    // Guard against pathological long prefixes on the first line.
    if position > MAX_ENVELOPE_PREFIX_BYTES {
        return None;
    }
    let after = message.get(position + STDERR_TOKEN.len()..)?;
    Some((position, after))
}

fn split_first_line(text: &str) -> (&str, &str) {
    match text.find('\n') {
        Some(i) => {
            let first = text.get(..i).unwrap_or(text);
            let rest = text.get(i + 1..).unwrap_or("");
            (first, rest)
        }
        None => (text, ""),
    }
}

/// Parse `(pool-40-thread-1286)` immediately after `[stderr]`.
///
/// Fail closed on empty tokens, unbalanced delimiters, nested parens, spaces,
/// or characters that are not valid in a thread identity token.
fn parse_parenthesized_thread_token(s: &str) -> Result<(String, &str), ()> {
    debug_assert!(s.starts_with('('));
    let inner_start = 1usize;
    let close_rel = s
        .get(inner_start..)
        .and_then(|rest| rest.find(')'))
        .ok_or(())?;
    let inner = s.get(inner_start..inner_start + close_rel).ok_or(())?;
    if inner.is_empty() {
        return Err(());
    }
    if inner.contains('(') || inner.contains(')') {
        return Err(());
    }
    if !is_valid_thread_identity_token(inner) {
        return Err(());
    }
    let after = s.get(inner_start + close_rel + 1..).ok_or(())?;
    let token: String = inner.chars().take(MAX_THREAD_TOKEN_CHARS).collect();
    Ok((token, after))
}

fn is_valid_thread_identity_token(token: &str) -> bool {
    if token.is_empty() || token.chars().count() > MAX_THREAD_TOKEN_CHARS {
        return false;
    }
    if token.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let mut chars = token.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    // Reject method-call / source-location shapes: must not look like `Foo.java:12`
    // as a sole paren group used for execution identity (still allow pool-N-thread-M).
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
}

/// Explicit key=value thread evidence only (never free brackets / parentheses).
fn extract_explicit_thread_key(message: &str) -> Option<String> {
    for key in ["thread=", "thread_id=", "threadId=", "tid="] {
        if let Some(start) = message.find(key) {
            if start > MAX_ENVELOPE_PREFIX_BYTES {
                continue;
            }
            let value = message.get(start + key.len()..).unwrap_or_default();
            let value = value
                .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ']' | ';' | ')'))
                .next()
                .unwrap_or_default()
                .trim_matches(['\"', '\'']);
            if value.is_empty() {
                continue;
            }
            if !is_valid_thread_identity_token(value) {
                continue;
            }
            return Some(value.chars().take(MAX_THREAD_TOKEN_CHARS).collect());
        }
    }
    None
}

fn has_stack_frame(message: &str) -> bool {
    message.lines().skip(1).any(is_stack_continuation)
}

fn is_stack_continuation(line: &str) -> bool {
    let line = line.trim();
    // Also accept structural payload that is only a frame/cause line.
    line.starts_with("at ")
        || line.starts_with("... ")
        || line.starts_with("Caused by:")
        || line.starts_with("Suppressed:")
        || line.starts_with("File \"")
        || line.starts_with("--- End of inner exception")
}

fn looks_like_exception_header_line(line: &str) -> bool {
    exception_signature_line(line).is_some()
}

fn exception_signature(message: &str) -> Option<String> {
    // Prefer the root cause (last exception type line) for dual-render stability.
    let mut last = None;
    for line in message.lines() {
        if let Some(signature) = exception_signature_line(line) {
            last = Some(signature);
        }
    }
    // If only an outer wrapper type is present (XYZ_EXCEPTION: ...), also accept first.
    last.or_else(|| message.lines().find_map(exception_signature_line))
}

fn exception_signature_line(line: &str) -> Option<String> {
    let line = line.trim();
    let line = line
        .strip_prefix("ERROR ")
        .or_else(|| line.strip_prefix("error "))
        .or_else(|| line.strip_prefix("WARN "))
        .or_else(|| line.strip_prefix("INFO "))
        .unwrap_or(line)
        .trim();
    // Strip residual stream token if a caller passed an unparsed line.
    let line = line
        .strip_prefix(STDERR_TOKEN)
        .map(str::trim_start)
        .unwrap_or(line);
    // Strip a single parenthesized thread group if still present on the line.
    let line = if line.starts_with('(') {
        parse_parenthesized_thread_token(line)
            .map(|(_, after)| after.trim_start())
            .unwrap_or(line)
    } else {
        line
    };
    let line = line
        .strip_prefix("Caused by:")
        .map(str::trim_start)
        .unwrap_or(line);
    if line.starts_with("at ") || line.starts_with("File \"") {
        return None;
    }
    let bytes = line.as_bytes();
    for (start, _) in line.char_indices() {
        if start > 512 {
            break;
        }
        let first = bytes.get(start).copied()?;
        if !(first.is_ascii_alphabetic() || first == b'_') {
            continue;
        }
        let rest = line.get(start..)?;
        let end = rest
            .char_indices()
            .take_while(|(_, ch)| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '$'))
            .last()
            .map(|(offset, ch)| start + offset + ch.len_utf8())?;
        let token = line.get(start..end)?;
        if !looks_like_exception_type(token) {
            continue;
        }
        let following = line.get(end..)?.trim_start();
        if !following.is_empty() && !following.starts_with(':') {
            continue;
        }
        let detail = following.strip_prefix(':').unwrap_or(following).trim();
        let detail = normalize_signature_detail(detail);
        let token = token.to_ascii_lowercase();
        return Some(if detail.is_empty() {
            token
        } else {
            format!("{token}: {detail}")
        });
    }
    None
}

fn looks_like_exception_type(token: &str) -> bool {
    // Bare "Exception" / "Error" appear in prose ("Exception wrapper") — require
    // a qualified type or a longer *Exception name.
    if matches!(
        token,
        "Exception" | "Error" | "Failure" | "Panic" | "Throwable"
    ) {
        return false;
    }
    ["Exception", "Error", "Failure", "Panic", "Throwable"]
        .iter()
        .any(|suffix| token.ends_with(suffix))
}

fn normalize_signature_detail(detail: &str) -> String {
    detail
        .split_whitespace()
        .take(24)
        .map(|token| {
            // Collapse pure numeric / long hex ids only — keep XYZ_UNIQUE_0 distinct
            // from XYZ_UNIQUE_1 (token body is not pure digits).
            let pure_digit = token.chars().all(|c| c.is_ascii_digit());
            let long_hex = token.len() >= 8 && token.chars().all(|c| c.is_ascii_hexdigit());
            if pure_digit || long_hex {
                "<*>".to_string()
            } else if let Some((k, v)) = token.split_once('=') {
                if v.chars().any(|c| c.is_ascii_digit()) {
                    format!("{k}=<*>")
                } else {
                    token.to_string()
                }
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
    use crate::log_analysis::ingest::ingest_path_with_policy;
    use crate::log_analysis::{
        query_events, ActiveTimestampBasis, TimeQuality, TimestampProvenance, MAX_EVENT_PAGE,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn event(seq: u64, ts: i64, source: &str, message: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz-api".into()),
            host: Some("xyz-host".into()),
            template_id: seq + 100,
            trace_id: None,
            message: message.into(),
            source: source.into(),
        }
    }

    fn order_event(seq: u64, source: &str, message: &str) -> ExplorerEvent {
        let mut e = event(seq, seq as i64, source, message);
        e.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        e.time_quality = TimeQuality::OrderOnly;
        e.timestamp_provenance = TimestampProvenance::OrderOnly;
        e
    }

    fn stderr_block(i: u32) -> Vec<String> {
        let mut lines = Vec::with_capacity(265);
        lines.push(format!(
            "XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED id={i}"
        ));
        for w in 0..72 {
            lines.push(format!(
                "Exception wrapper XYZ_WRAP#{w} for payment failure id={i}"
            ));
        }
        for f in 0..189 {
            lines.push(format!(
                "at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{})",
                f + 1
            ));
        }
        lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
        lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
        lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
        assert_eq!(lines.len(), 265);
        lines
    }

    fn write_dual_rendering_corpus(dir: &Path, occurrences: u32) {
        let app = dir.join("XYZ_app.log");
        let stderr = dir.join("XYZ_server.stderr");
        let mut app_body = String::new();
        let mut err_body = String::new();
        for i in 0..occurrences {
            let base = 12 * 3600 + i * 2;
            let h = (base / 3600) % 24;
            let m = (base / 60) % 60;
            let s = base % 60;
            let ts = format!("2026-03-15T{h:02}:{m:02}:{s:02}.000Z");
            app_body.push_str(&format!(
                "{ts} ERROR XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED id={i}\n"
            ));
            app_body.push_str("  at com.xyz.payment.Client.charge(Client.java:42)\n");
            app_body.push_str("  at com.xyz.api.OrderService.checkout(OrderService.java:88)\n");
            app_body.push_str("  Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT\n");
            app_body.push_str("  at com.xyz.net.Http.execute(Http.java:15)\n");
            for (j, line) in stderr_block(i).into_iter().enumerate() {
                let ms = (j % 1000) as u32;
                err_body.push_str(&format!(
                    "2026-03-15T{h:02}:{m:02}:{s:02}.{ms:03}Z ERROR {line}\n"
                ));
            }
        }
        fs::write(app, app_body).unwrap();
        fs::write(stderr, err_body).unwrap();
    }

    fn ingest_dir(dir: &Path) -> (TempDir, String, LogCorpus) {
        let cache = TempDir::new().unwrap();
        let policy = LogEmbedPolicy {
            mode: LogEmbedMode::None,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: "test-none".into(),
            defer_above_source_bytes: None,
        };
        let report =
            ingest_path_with_policy(cache.path(), dir, "xyz-exception-lab", &policy, None).unwrap();
        let corpus = LogCorpus::open(cache.path(), &report.corpus_id).unwrap();
        (cache, report.corpus_id, corpus)
    }

    #[test]
    fn correlates_full_stack_and_wrapped_records_without_losing_citations() {
        let events = vec![
            event(1, 100, "xyz.log", "ERROR thread=xyz-worker xyz.TopException: request failed\n at xyz.Api.run(Api.java:10)\nCaused by: xyz.TimeoutException: upstream XYZ timed out request=123\n at xyz.Net.call(Net.java:20)"),
            event(2, 100, "xyz.log", "thread=xyz-worker [stderr] xyz.TopException: request failed"),
            event(3, 100, "xyz.log", "thread=xyz-worker [stderr] at xyz.Api.run(Api.java:10)"),
            event(4, 100, "xyz.log", "thread=xyz-worker [stderr] Caused by: xyz.TimeoutException: upstream XYZ timed out request=456"),
            event(5, 100, "xyz.log", "thread=xyz-worker [stderr] at xyz.Net.call(Net.java:20)"),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.raw_exception_record_count, 5);
        assert_eq!(analysis.rendering_episode_count, 2);
        assert_eq!(analysis.occurrence_count, 1);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 1);
        assert!(!analysis.partial);
        let family = &analysis.families[0];
        assert!(
            family.signature.contains("timeoutexception")
                || family.signature.contains("topexception")
        );
        let occurrence = &family.occurrences[0];
        assert_eq!(
            occurrence.correlation_confidence,
            ExceptionCorrelationConfidence::Strong
        );
        assert_eq!(
            occurrence
                .citations
                .iter()
                .map(|c| c.seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        assert!(occurrence.citations_complete);
    }

    #[test]
    fn refuses_same_signature_when_thread_or_time_evidence_conflicts() {
        let events = vec![
            event(
                1,
                100,
                "xyz.log",
                "thread=xyz-a xyz.TimeoutException: upstream XYZ\n at xyz.Net.call(Net.java:20)",
            ),
            event(
                2,
                100,
                "xyz.log",
                "thread=xyz-b [stderr] xyz.TimeoutException: upstream XYZ",
            ),
            event(
                3,
                100,
                "xyz.log",
                "thread=xyz-b [stderr] at xyz.Net.call(Net.java:20)",
            ),
            event(
                4,
                120,
                "xyz.log",
                "thread=xyz-a [stderr] xyz.TimeoutException: upstream XYZ",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.rendering_episode_count, 3);
        assert_eq!(analysis.occurrence_count, 3);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
    }

    #[test]
    fn order_only_adjacency_does_not_claim_duplicate_rendering() {
        let full = order_event(
            1,
            "xyz.log",
            "xyz.TimeoutException: upstream XYZ\n at xyz.Net.call(Net.java:20)",
        );
        let wrapped = order_event(2, "xyz.log", "[stderr] xyz.TimeoutException: upstream XYZ");
        let analysis = analyze_bounded_events(2, &[full, wrapped]);
        assert_eq!(analysis.occurrence_count, 2);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
    }

    #[test]
    fn order_only_cross_source_requires_strong_execution_key() {
        let mut a = order_event(
            1,
            "app.log",
            "thread=xyz-worker xyz.TimeoutException: upstream XYZ\n at xyz.Net.call(Net.java:20)",
        );
        let mut b = order_event(
            2,
            "stderr.log",
            "thread=xyz-worker [stderr] xyz.TimeoutException: upstream XYZ",
        );
        b.trace_id = None;
        a.trace_id = None;
        let with_key = analyze_bounded_events(2, &[a.clone(), b.clone()]);
        assert_eq!(with_key.occurrence_count, 1);
        assert_eq!(with_key.duplicate_rendering_occurrence_count, 1);

        let mut a2 = a;
        let mut b2 = b;
        a2.message = a2.message.replace("thread=xyz-worker ", "");
        b2.message = b2.message.replace("thread=xyz-worker ", "");
        let no_key = analyze_bounded_events(2, &[a2, b2]);
        assert_eq!(no_key.duplicate_rendering_occurrence_count, 0);
    }

    #[test]
    fn message_equality_alone_does_not_merge_unrelated_sources() {
        let events = vec![
            event(
                1,
                100,
                "a.log",
                "xyz.TimeoutException: same text\n at xyz.A.m(A.java:1)",
            ),
            event(
                50,
                5000,
                "b.log",
                "[stderr] xyz.TimeoutException: same text",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
        assert!(analysis.occurrence_count >= 2);
    }

    #[test]
    fn dual_rendering_56x265_exact_oracle() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 56);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();

        // Exact known oracle — no tolerance bands.
        assert_eq!(analysis.raw_exception_record_count, 14_896);
        assert_eq!(analysis.stderr_exception_record_count, 14_840);
        assert_eq!(analysis.application_exception_record_count, 56);
        assert_eq!(analysis.rendering_episode_count, 112);
        assert_eq!(analysis.occurrence_count, 56);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 56);
        assert!(!analysis.partial);
        assert!(analysis.counts_complete);
        assert!(analysis
            .ranking_disclosure
            .contains("independent_incident_claim_forbidden"));
        assert!(analysis
            .ranking_disclosure
            .contains("counts_complete: true"));

        let amp = &analysis.amplification;
        assert_eq!(amp.raw_records_per_occurrence.numerator, 14_896);
        assert_eq!(amp.raw_records_per_occurrence.denominator, 56);
        assert_eq!(amp.raw_records_per_occurrence.quotient, 266);
        assert_eq!(amp.raw_records_per_occurrence.remainder, 0);
        assert!(amp.raw_records_per_occurrence.ratio_integral());
        assert_eq!(amp.stderr_records_per_occurrence.quotient, 265);
        assert_eq!(amp.stderr_records_per_occurrence.remainder, 0);
        assert_eq!(amp.application_records_per_occurrence.quotient, 1);
        assert_eq!(amp.application_records_per_occurrence.remainder, 0);
        assert_eq!(amp.renderings_per_occurrence.quotient, 2);
        assert_eq!(amp.renderings_per_occurrence.remainder, 0);

        let family = analysis.families.first().expect("family");
        assert_eq!(family.occurrence_count, 56);
        assert_eq!(family.duplicate_rendering_occurrence_count, 56);
        assert_eq!(family.application_record_count, 56);
        assert_eq!(family.stderr_record_count, 14_840);
        assert_eq!(
            family.application_record_count + family.stderr_record_count,
            family.raw_record_count
        );
        assert_eq!(family.amplification.application_exception_records, 56);
        assert_eq!(family.amplification.stderr_exception_records, 14_840);
        assert_ne!(family.amplification.application_exception_records, 0);
        assert_ne!(family.amplification.stderr_exception_records, 0);
        // Complete single-family report: family totals match report totals.
        assert_eq!(
            family.application_record_count,
            analysis.application_exception_record_count
        );
        assert_eq!(
            family.stderr_record_count,
            analysis.stderr_exception_record_count
        );

        let mut all_cites: HashSet<(u64, String)> = HashSet::new();
        let mut cite_count = 0u64;
        for occ in &family.occurrences {
            assert_eq!(occ.rendering_count, 2, "each occ must be dual-render");
            assert!(occ.duplicate_rendering);
            assert_eq!(occ.raw_record_count, 266);
            assert!(occ
                .rendering_kinds
                .contains(&ExceptionRenderingKind::ApplicationFullStack));
            assert!(occ
                .rendering_kinds
                .contains(&ExceptionRenderingKind::SeparatelyWrappedRecords));
            // 1 app + 265 stderr
            let app_cites = occ
                .citations
                .iter()
                .filter(|c| c.source.contains("app") || c.source.contains("XYZ_app"))
                .count();
            let err_cites = occ.citations.len() - app_cites;
            // Sources may be basenames; count by kind via rendering sizes.
            assert_eq!(
                occ.citations.len(),
                266,
                "one application record + 265 stderr records"
            );
            let _ = (app_cites, err_cites);
            for c in &occ.citations {
                assert!(
                    all_cites.insert((c.seq, c.source.clone())),
                    "duplicate child citation seq={} source={}",
                    c.seq,
                    c.source
                );
                cite_count += 1;
                let page = query_events(
                    &corpus,
                    &EventQuery {
                        seq_from: Some(c.seq),
                        seq_to: Some(c.seq),
                        limit: 4,
                        sort_by_time: false,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == c.seq && e.source == c.source),
                    "missing cite seq={} source={}",
                    c.seq,
                    c.source
                );
            }
        }
        assert_eq!(cite_count, 14_896);
        assert_eq!(all_cites.len() as u64, 14_896);

        // Unrelated non-exception volume is not present in this corpus; all
        // scanned exception records are covered exactly once.
        eprintln!(
            "dual_rendering exact: raw={} stderr={} app={} renderings={} occurrences={} duplicates={} raw_per_occ={}/{}={} rem{}",
            analysis.raw_exception_record_count,
            analysis.stderr_exception_record_count,
            analysis.application_exception_record_count,
            analysis.rendering_episode_count,
            analysis.occurrence_count,
            analysis.duplicate_rendering_occurrence_count,
            amp.raw_records_per_occurrence.numerator,
            amp.raw_records_per_occurrence.denominator,
            amp.raw_records_per_occurrence.quotient,
            amp.raw_records_per_occurrence.remainder
        );
    }

    #[test]
    fn min_distance_pairs_same_signature_at_0s_2s_4s() {
        // Same signature, wall times 0/2/4 — exact-time partners beat window-only.
        let mut events = Vec::new();
        for (i, t) in [0i64, 2, 4].into_iter().enumerate() {
            let i = i as u64;
            events.push(event(
                i * 10 + 1,
                t,
                "app.log",
                "java.lang.RuntimeException: XYZ_SHARED\n at com.xyz.A.m(A.java:1)",
            ));
            events.push(event(
                i * 10 + 2,
                t,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_SHARED",
            ));
            events.push(event(
                i * 10 + 3,
                t,
                "stderr.log",
                "[stderr] at com.xyz.A.m(A.java:1)",
            ));
        }
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 3);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 3);
        assert_eq!(analysis.rendering_episode_count, 6);
        for occ in analysis.families.iter().flat_map(|f| f.occurrences.iter()) {
            assert_eq!(occ.rendering_count, 2);
            // Partner citations must share the same wall second (min distance 0).
            // first_seq is min cite; both renderings at same t have seqs near each other.
            assert!(occ.citations.len() >= 2);
        }
    }

    #[test]
    fn mutation_reverse_first_greedy_would_mispair_but_min_distance_is_exact() {
        // If we attached reverse-first (latest unmatched), stderr@0s would claim
        // app@2s (window-compatible) before app@0s. Min-distance ranking refuses that.
        let events = vec![
            event(
                1,
                0,
                "app.log",
                "java.lang.RuntimeException: XYZ_SHARED\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                2,
                "app.log",
                "java.lang.RuntimeException: XYZ_SHARED\n at com.xyz.A.m(A.java:1)",
            ),
            // stderr for t=0 arrives after both apps (insertion order traps reverse greedy)
            event(
                3,
                0,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_SHARED",
            ),
            event(4, 0, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(
                5,
                2,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_SHARED",
            ),
            event(6, 2, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 2);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 2);
        // Exact coverage: each occurrence has one app seq {1} or {2} with matching stderr.
        let mut app_seqs: BTreeSet<u64> = BTreeSet::new();
        for occ in analysis.families.iter().flat_map(|f| &f.occurrences) {
            assert_eq!(occ.rendering_count, 2);
            let apps: Vec<_> = occ
                .citations
                .iter()
                .filter(|c| c.source == "app.log")
                .map(|c| c.seq)
                .collect();
            assert_eq!(apps.len(), 1);
            app_seqs.insert(apps[0]);
            // Stderr cites must share the app's wall time partner: seq 1→stderr 3,4; seq 2→5,6
            let err: BTreeSet<u64> = occ
                .citations
                .iter()
                .filter(|c| c.source == "stderr.log")
                .map(|c| c.seq)
                .collect();
            if apps[0] == 1 {
                assert_eq!(err, BTreeSet::from([3, 4]));
            } else if apps[0] == 2 {
                assert_eq!(err, BTreeSet::from([5, 6]));
            } else {
                panic!("unexpected app seq {}", apps[0]);
            }
        }
        assert_eq!(app_seqs, BTreeSet::from([1, 2]));
    }

    #[test]
    fn reordered_input_yields_identical_pairings() {
        let mut events = vec![
            event(
                1,
                0,
                "app.log",
                "java.lang.RuntimeException: XYZ_A\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                0,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_A",
            ),
            event(
                3,
                2,
                "app.log",
                "java.lang.RuntimeException: XYZ_A\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                4,
                2,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_A",
            ),
        ];
        let forward = analyze_bounded_events(events.len() as u64, &events);
        events.reverse();
        let reversed = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(forward.occurrence_count, reversed.occurrence_count);
        assert_eq!(
            forward.duplicate_rendering_occurrence_count,
            reversed.duplicate_rendering_occurrence_count
        );
        assert_eq!(forward.amplification, reversed.amplification);
        // Pairing stability: same citation sets per occurrence (order-normalized).
        let cites = |a: &ExceptionEpisodeAnalysis| {
            a.families
                .iter()
                .flat_map(|f| f.occurrences.iter())
                .map(|o| {
                    let mut c: Vec<_> = o
                        .citations
                        .iter()
                        .map(|c| (c.seq, c.source.clone()))
                        .collect();
                    c.sort();
                    c
                })
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(cites(&forward), cites(&reversed));
    }

    #[test]
    fn simultaneous_threads_do_not_cross_pair() {
        let events = vec![
            event(
                1,
                100,
                "app.log",
                "thread=worker-a java.lang.RuntimeException: XYZ_T\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                100,
                "app.log",
                "thread=worker-b java.lang.RuntimeException: XYZ_T\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                3,
                100,
                "stderr.log",
                "thread=worker-a [stderr] java.lang.RuntimeException: XYZ_T",
            ),
            event(
                4,
                100,
                "stderr.log",
                "thread=worker-b [stderr] java.lang.RuntimeException: XYZ_T",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 2);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 2);
        for occ in analysis.families.iter().flat_map(|f| &f.occurrences) {
            let texts: Vec<String> = occ
                .citations
                .iter()
                .map(|c| format!("{}:{}", c.seq, c.source))
                .collect();
            // worker-a app(1) only with worker-a stderr(3); worker-b app(2) with stderr(4)
            let seqs: BTreeSet<u64> = occ.citations.iter().map(|c| c.seq).collect();
            assert!(
                seqs == BTreeSet::from([1, 3]) || seqs == BTreeSet::from([2, 4]),
                "cross-thread pairing forbidden: {texts:?}"
            );
        }
    }

    #[test]
    fn child_coverage_unique_and_complete_for_small_dual() {
        // Keep the same root signature on both renderings (no nested cause that
        // would retarget the stderr root type away from the application record).
        let events = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_PAY\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_PAY",
            ),
            event(3, 10, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(4, 10, "stderr.log", "[stderr] at com.xyz.B.m(B.java:2)"),
            // Unrelated negative: different signature, far wall time — must not join
            event(
                99,
                10_000,
                "other.log",
                "java.lang.IllegalStateException: XYZ_OTHER\n at com.xyz.B.m(B.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 1);
        let dual = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .find(|o| o.duplicate_rendering)
            .expect("dual");
        let mut seen = HashSet::new();
        for c in &dual.citations {
            assert!(seen.insert((c.seq, c.source.clone())));
        }
        assert_eq!(seen.len(), 4);
        assert!(seen.contains(&(1, "app.log".into())));
        assert!(seen.contains(&(2, "stderr.log".into())));
        assert!(!seen.iter().any(|(s, _)| *s == 99));
        // Negative remains a separate occurrence, not absorbed into dual coverage.
        assert!(analysis.occurrence_count >= 2);
        assert_eq!(analysis.raw_exception_record_count, 5);
    }

    #[test]
    fn scan_cap_after_unrelated_noise_finds_errors_or_marks_incomplete() {
        // 50_000 info lines then a dual-render exception pair. Structure-based
        // candidate walk should reach targets; if not, partial must disclose
        // incompleteness and never claim exact full-corpus totals.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        let mut noise = String::new();
        for i in 0..50_000u32 {
            noise.push_str(&format!(
                "2026-03-15T10:00:{:02}.{:03}Z INFO heartbeat ok n={i}\n",
                (i / 1000) % 60,
                i % 1000
            ));
        }
        fs::write(src.join("XYZ_noise.log"), noise).unwrap();
        let mut app = String::new();
        let mut err = String::new();
        app.push_str(
            "2026-03-15T12:00:00.000Z ERROR java.lang.RuntimeException: XYZ_LATE\n  at com.xyz.A.m(A.java:1)\n",
        );
        err.push_str("2026-03-15T12:00:00.000Z ERROR java.lang.RuntimeException: XYZ_LATE\n");
        err.push_str("2026-03-15T12:00:00.001Z ERROR at com.xyz.A.m(A.java:1)\n");
        fs::write(src.join("XYZ_app.log"), app).unwrap();
        fs::write(src.join("XYZ_server.stderr"), err).unwrap();
        let (_cache, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        if analysis.partial {
            assert!(
                !analysis.counts_complete,
                "partial results must not set counts_complete"
            );
            // Never present incomplete totals as the known dual oracle.
            assert_ne!(
                (
                    analysis.occurrence_count,
                    analysis.raw_exception_record_count,
                    analysis.partial
                ),
                (56, 14_896, false)
            );
        } else {
            assert!(analysis.occurrence_count >= 1);
            assert!(analysis.raw_exception_record_count >= 2);
            assert!(analysis.counts_complete);
        }
    }

    #[test]
    fn family_amplification_carries_real_app_and_stderr_counts() {
        let events = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_FAM_A\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_FAM_A",
            ),
            event(3, 10, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(4, 10, "stderr.log", "[stderr] at com.xyz.B.m(B.java:2)"),
            event(
                5,
                50,
                "app2.log",
                "java.lang.IllegalStateException: XYZ_FAM_B\n at com.xyz.C.m(C.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert!(analysis.families.len() >= 2);
        let fam_a = analysis
            .families
            .iter()
            .find(|f| f.duplicate_rendering_occurrence_count > 0)
            .expect("family A dual");
        let fam_b = analysis
            .families
            .iter()
            .find(|f| f.signature != fam_a.signature)
            .expect("family B");
        assert_eq!(
            fam_a.application_record_count + fam_a.stderr_record_count,
            fam_a.raw_record_count
        );
        assert_eq!(
            fam_b.application_record_count + fam_b.stderr_record_count,
            fam_b.raw_record_count
        );
        assert!(fam_a.amplification.application_exception_records > 0);
        assert!(fam_a.amplification.stderr_exception_records > 0);
        assert_ne!(
            fam_a.amplification.raw_records_per_occurrence,
            fam_b.amplification.raw_records_per_occurrence
        );
        assert_eq!(
            fam_a.amplification.application_exception_records
                + fam_b.amplification.application_exception_records,
            analysis.application_exception_record_count
        );
        assert_eq!(
            fam_a.amplification.stderr_exception_records
                + fam_b.amplification.stderr_exception_records,
            analysis.stderr_exception_record_count
        );
    }

    #[test]
    fn template_projection_is_per_family_not_global() {
        let mut events = Vec::new();
        for i in 0..3u64 {
            let t = (i * 2) as i64;
            events.push(event(
                i * 10 + 1,
                t,
                "app.log",
                "java.lang.RuntimeException: XYZ_PAY\n at com.xyz.A.m(A.java:1)",
            ));
            events.push(event(
                i * 10 + 2,
                t,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_PAY",
            ));
            events.push(event(
                i * 10 + 3,
                t,
                "stderr.log",
                "[stderr] at com.xyz.A.m(A.java:1)",
            ));
        }
        for i in 0..2u64 {
            let t = 100 + (i * 2) as i64;
            let base = 100 + i * 10;
            let mut app = event(
                base + 1,
                t,
                "app_b.log",
                "java.lang.IllegalStateException: XYZ_OTHER\n at com.xyz.Other.m(Other.java:1)",
            );
            app.template_id = 9001;
            let mut head = event(
                base + 2,
                t,
                "stderr_b.log",
                "[stderr] java.lang.IllegalStateException: XYZ_OTHER",
            );
            head.template_id = 9002;
            let mut frame = event(
                base + 3,
                t,
                "stderr_b.log",
                "[stderr] at com.xyz.Other.uniqueFrame(Other.java:99)",
            );
            frame.template_id = 7777;
            events.push(app);
            events.push(head);
            events.push(frame);
        }
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 5);
        let proj = project_template_onto_episodes(&analysis, 7777);
        assert!(proj.complete, "{proj:?}");
        assert_eq!(proj.occurrence_count, Some(2));
        assert_eq!(proj.supporting_only_occurrence_count, Some(2));
        assert_ne!(proj.occurrence_count, Some(5));
        assert_ne!(proj.occurrence_count, Some(3));
    }

    #[test]
    fn max_cardinality_matching_adversarial_windows_is_deterministic() {
        let events = vec![
            event(
                10,
                1,
                "app.log",
                "java.lang.RuntimeException: XYZ_AMB\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                30,
                3,
                "app.log",
                "java.lang.RuntimeException: XYZ_AMB\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                1,
                0,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_AMB",
            ),
            event(2, 0, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(
                11,
                1,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_AMB",
            ),
            event(12, 1, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let forward = analyze_bounded_events(events.len() as u64, &events);
        let mut reversed = events.clone();
        reversed.reverse();
        let backward = analyze_bounded_events(reversed.len() as u64, &reversed);
        assert_eq!(forward.duplicate_rendering_occurrence_count, 2);
        assert_eq!(backward.duplicate_rendering_occurrence_count, 2);
        assert_eq!(forward.occurrence_count, backward.occurrence_count);
        assert_eq!(forward.unpaired_rendering_count, 0);
        assert_eq!(backward.unpaired_rendering_count, 0);
        assert!(
            forward.matching_ambiguous || forward.matching_policy.contains("not unique"),
            "policy={}",
            forward.matching_policy
        );
        let cites = |a: &ExceptionEpisodeAnalysis| {
            a.families
                .iter()
                .flat_map(|f| f.occurrences.iter())
                .map(|o| {
                    let mut c: Vec<_> = o
                        .citations
                        .iter()
                        .map(|c| (c.seq, c.source.clone()))
                        .collect();
                    c.sort();
                    c
                })
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(cites(&forward), cites(&backward));
    }

    #[test]
    fn non_error_level_exceptions_are_candidates() {
        let mut info = event(
            1,
            10,
            "app.log",
            "java.lang.RuntimeException: XYZ_INFO\n at com.xyz.A.m(A.java:1)",
        );
        info.level = "info".into();
        let mut warn = event(
            2,
            20,
            "app2.log",
            "java.lang.IllegalStateException: XYZ_WARN\n at com.xyz.B.m(B.java:1)\n at com.xyz.C.m(C.java:2)",
        );
        warn.level = "warn".into();
        let mut unset = event(
            3,
            30,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_UNSET",
        );
        unset.level = String::new();
        let mut frame = event(4, 30, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)");
        frame.level = String::new();
        let mut prose = event(
            5,
            40,
            "noise.log",
            "there was an error processing the request",
        );
        prose.level = "error".into();

        assert!(is_exception_candidate(&info));
        assert!(is_exception_candidate(&warn));
        assert!(is_exception_candidate(&unset));
        assert!(is_exception_candidate(&frame));
        assert!(!is_exception_candidate(&prose));

        let analysis = analyze_bounded_events(5, &[info, warn, unset, frame, prose]);
        assert!(analysis.occurrence_count >= 2);
        assert!(analysis.raw_exception_record_count >= 3);
        assert!(analysis
            .families
            .iter()
            .all(|f| !f.signature.contains("processing the request")));
    }

    #[test]
    fn count_ratio_is_exact_only_when_denom_zero_and_num_zero() {
        assert!(ExceptionCountRatio::new(0, 0).is_exact());
        assert!(!ExceptionCountRatio::new(5, 0).is_exact());
        assert!(ExceptionCountRatio::new(10, 5).is_exact());
        assert!(!ExceptionCountRatio::new(11, 5).is_exact());
        assert_eq!(ExceptionCountRatio::new(11, 5).remainder, 1);
        assert!(!ExceptionCountRatio::new(11, 5).ratio_integral());
    }

    #[test]
    fn cancellation_mid_derive_returns_cancelled() {
        let mut events = Vec::new();
        for i in 0..500u64 {
            events.push(event(
                i + 1,
                i as i64,
                "app.log",
                &format!("java.lang.RuntimeException: XYZ_BURST_{i}\n at com.xyz.A.m(A.java:1)"),
            ));
        }
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let result = analyze_bounded_events_cancellable(
            events.len() as u64,
            &events,
            &|| {
                let n = checks.fetch_add(1, Ordering::SeqCst);
                n >= 3
            },
            MatchingMeta::default(),
        );
        assert!(matches!(result, Err(CoreError::Cancelled)));
    }

    #[test]
    fn ratio_non_integral_does_not_force_counts_incomplete() {
        let events = vec![
            event(
                1,
                10,
                "a.log",
                "java.lang.RuntimeException: XYZ_X\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                20,
                "b.log",
                "java.lang.RuntimeException: XYZ_Y\n at com.xyz.B.m(B.java:1)",
            ),
            event(
                3,
                30,
                "c.log",
                "java.lang.IllegalStateException: XYZ_Z\n at com.xyz.C.m(C.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(3, &events);
        assert!(analysis.counts_complete);
        assert!(!analysis.partial);
        assert_eq!(analysis.raw_exception_record_count, 3);
        assert_eq!(analysis.occurrence_count, 3);
    }

    #[test]
    fn conventional_multiline_is_one_application_rendering() {
        let e = event(
            1,
            100,
            "app.log",
            "java.lang.RuntimeException: XYZ_PAYMENT_FAILED\n\
             at com.xyz.payment.Client.charge(Client.java:42)\n\
             at com.xyz.api.OrderService.checkout(OrderService.java:88)",
        );
        let analysis = analyze_bounded_events(1, &[e]);
        assert_eq!(analysis.rendering_episode_count, 1);
        assert_eq!(analysis.occurrence_count, 1);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
        assert_eq!(analysis.raw_exception_record_count, 1);
    }

    #[test]
    fn nested_causes_in_one_rendering() {
        let events = vec![
            event(
                1,
                100,
                "a.log",
                "[stderr] java.lang.RuntimeException: XYZ_OUTER",
            ),
            event(2, 100, "a.log", "[stderr] at com.xyz.Outer.m(Outer.java:1)"),
            event(
                3,
                100,
                "a.log",
                "[stderr] Caused by: java.io.IOException: XYZ_INNER",
            ),
            event(4, 100, "a.log", "[stderr] at com.xyz.Inner.m(Inner.java:2)"),
        ];
        let analysis = analyze_bounded_events(4, &events);
        assert_eq!(analysis.rendering_episode_count, 1);
        assert_eq!(analysis.occurrence_count, 1);
        assert_eq!(analysis.raw_exception_record_count, 4);
    }

    #[test]
    fn suppression_excludes_templates_from_scan_and_citations() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        fs::write(
            src.join("XYZ_a.log"),
            "2026-03-15T12:00:00.000Z ERROR java.lang.RuntimeException: XYZ_PAYMENT_FAILED\n  at com.xyz.A.m(A.java:1)\n\
2026-03-15T12:00:01.000Z INFO heartbeat ok\n",
        )
        .unwrap();
        let (_cache, _id, corpus) = ingest_dir(&src);
        let all_templates: Vec<u64> = {
            let page = query_events(
                &corpus,
                &EventQuery {
                    limit: 500,
                    sort_by_time: false,
                    ..Default::default()
                },
            )
            .unwrap();
            page.events
                .iter()
                .map(|e| e.template_id)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        };
        let analysis = analyze_exception_episodes(&corpus, &all_templates).unwrap();
        assert_eq!(analysis.events_scanned, 0);
        assert_eq!(analysis.occurrence_count, 0);
        assert!(analysis
            .families
            .iter()
            .all(|f| f.occurrences.iter().all(|o| o.citations.is_empty())));
    }

    #[test]
    fn cancellation_returns_cancelled_error() {
        let cancel = AtomicBool::new(true);
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 1);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let err = analyze_exception_episodes_with_cancel(&corpus, &[], Some(&cancel)).unwrap_err();
        assert!(matches!(err, CoreError::Cancelled) || err.to_string().contains("cancel"));
    }

    #[test]
    fn corpus_revision_unchanged_by_analysis() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 2);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let rev = corpus.event_revision();
        let _ = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(corpus.event_revision(), rev);
    }

    #[test]
    fn concurrent_event_revision_change_fails_closed() {
        // Pin path: mutating the corpus between prepare-equivalent pin and scan
        // completion must not return a successful report.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 8);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let pinned_event = corpus.event_revision();
        let pinned_template = corpus.template_analysis_revision();
        // Simulate concurrent mutation by pushing an event after pin observation.
        corpus
            .push_events(&[crate::log_analysis::LogEvent {
                seq: 99_999,
                ts: 1_700_000_999,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "ERROR".into(),
                service: Some("mutator".into()),
                host: Some("mutator".into()),
                template_id: 42,
                params: vec![],
                trace_id: None,
                message: "java.lang.RuntimeException: XYZ_MUT\n at com.xyz.M.m(M.java:1)".into(),
                source: "mutator.log".into(),
            }])
            .unwrap();
        corpus.flush().unwrap();
        assert_ne!(corpus.event_revision(), pinned_event);
        // Direct check helper mirrors scan fail-closed contract.
        let err = check_revisions(&corpus, pinned_event, pinned_template).unwrap_err();
        assert!(err.to_string().contains("event revision changed"), "{err}");
    }

    #[test]
    fn bounded_record_cap_discloses_incomplete_citations() {
        let mut events = vec![event(
            1,
            100,
            "xyz.log",
            "[stderr] xyz.BurstException: XYZ burst",
        )];
        for seq in 2..=(EXCEPTION_EPISODE_RECORD_CAP as u64 + 5) {
            events.push(event(
                seq,
                100,
                "xyz.log",
                "[stderr] at xyz.Burst.run(Burst.java:10)",
            ));
        }
        let analysis = analyze_bounded_events(events.len() as u64 + 10, &events);
        assert!(analysis.uncertain || analysis.partial);
        let occurrence = &analysis.families[0].occurrences[0];
        assert_eq!(occurrence.citations.len(), EXCEPTION_EPISODE_RECORD_CAP);
        assert!(!occurrence.citations_complete);
    }

    #[test]
    fn mutation_divisibility_alone_does_not_create_family() {
        let mut events = Vec::new();
        for i in 0..265u64 {
            events.push(event(
                i + 1,
                100 + i as i64,
                "noise.log",
                &format!("xyz.IllegalStateException: XYZ_UNIQUE_{i}\n at xyz.A.m(A.java:1)"),
            ));
        }
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert!(analysis.families.iter().all(|f| f.occurrence_count < 50));
    }

    #[test]
    fn determinism_two_runs_identical() {
        let events = vec![
            event(
                1,
                100,
                "a.log",
                "xyz.TimeoutException: upstream XYZ\n at xyz.Net.call(Net.java:20)",
            ),
            event(
                2,
                100,
                "a.log",
                "thread=t1 [stderr] xyz.TimeoutException: upstream XYZ",
            ),
            event(
                3,
                100,
                "a.log",
                "thread=t1 [stderr] at xyz.Net.call(Net.java:20)",
            ),
        ];
        let a = analyze_bounded_events(3, &events);
        let b = analyze_bounded_events(3, &events);
        assert_eq!(a, b);
    }

    #[test]

    fn zip_folder_import_parity_small() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().join("folder");
        fs::create_dir_all(&folder).unwrap();
        write_dual_rendering_corpus(&folder, 3);
        let (_c1, _id1, corpus_folder) = ingest_dir(&folder);
        let report_folder = analyze_exception_episodes(&corpus_folder, &[]).unwrap();

        let zip_path = tmp.path().join("corpus.zip");
        let status = std::process::Command::new("zip")
            .args(["-qr", zip_path.to_str().unwrap(), "."])
            .current_dir(&folder)
            .status();
        if !status.map(|s| s.success()).unwrap_or(false) {
            eprintln!("skip zip parity");
            return;
        }
        let cache = TempDir::new().unwrap();
        let policy = LogEmbedPolicy {
            mode: LogEmbedMode::None,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: "test-none".into(),
            defer_above_source_bytes: None,
        };
        let report_ingest =
            ingest_path_with_policy(cache.path(), &zip_path, "xyz-zip", &policy, None).unwrap();
        let corpus_zip = LogCorpus::open(cache.path(), &report_ingest.corpus_id).unwrap();
        let report_zip = analyze_exception_episodes(&corpus_zip, &[]).unwrap();
        assert_eq!(report_folder.occurrence_count, report_zip.occurrence_count);
        assert_eq!(
            report_folder.raw_exception_record_count,
            report_zip.raw_exception_record_count
        );
    }

    /// One durable exception candidate per record (single-line header with type).
    fn write_n_exception_lines(path: &Path, n: usize, level: &str, id_prefix: &str) {
        let mut body = String::new();
        for i in 0..n {
            body.push_str(&format!(
                "2026-03-15T12:00:{:02}.{:03}Z {level} java.lang.RuntimeException: {id_prefix}_{i}\n",
                (i / 1000) % 60,
                i % 1000
            ));
        }
        fs::write(path, body).unwrap();
    }

    fn write_n_info_noise(path: &Path, n: usize) {
        let mut body = String::new();
        for i in 0..n {
            body.push_str(&format!(
                "2026-03-15T11:00:{:02}.{:03}Z INFO heartbeat ok n={i}\n",
                (i / 1000) % 60,
                i % 1000
            ));
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn candidate_cap_exact_eof_is_complete() {
        // Cap N with exactly N candidates and store EOF → complete.
        let _guard = TestScanOverrideGuard::acquire();
        let cap = 8usize;
        set_test_candidate_cap_override(cap);
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_n_exception_lines(&src.join("XYZ_e.log"), cap, "ERROR", "XYZ_CAP");
        let (_c, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(analysis.events_scanned as usize, cap);
        assert!(
            analysis.counts_complete,
            "scope={}",
            analysis.candidate_scope
        );
        assert!(!analysis.partial);
        assert!(analysis.candidate_scope.contains("store_eof=true"));
    }

    #[test]
    fn scan_test_controls_are_thread_local() {
        let _guard = TestScanOverrideGuard::acquire();
        set_test_candidate_cap_override(3);
        set_test_row_walk_cap_override(7);
        let hook_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook_calls_inner = std::sync::Arc::clone(&hook_calls);
        set_episode_scan_page_hook_for_test(Some(Box::new(move |_| {
            hook_calls_inner.fetch_add(1, Ordering::SeqCst);
        })));

        std::thread::spawn(|| {
            assert_eq!(effective_candidate_cap(), EXCEPTION_EPISODE_EVENT_SCAN_CAP);
            assert_eq!(effective_row_walk_cap(), EXCEPTION_EPISODE_ROW_WALK_CAP);
            invoke_episode_scan_page_hook(0);
        })
        .join()
        .expect("parallel test thread");

        assert_eq!(effective_candidate_cap(), 3);
        assert_eq!(effective_row_walk_cap(), 7);
        assert_eq!(hook_calls.load(Ordering::SeqCst), 0);
        invoke_episode_scan_page_hook(0);
        assert_eq!(hook_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn candidate_cap_exact_then_ordinary_rows_is_complete() {
        let _guard = TestScanOverrideGuard::acquire();
        let cap = 8usize;
        set_test_candidate_cap_override(cap);
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_n_exception_lines(&src.join("XYZ_e.log"), cap, "ERROR", "XYZ_CAP");
        write_n_info_noise(&src.join("XYZ_noise.log"), 40);
        let (_c, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(analysis.events_scanned as usize, cap);
        assert!(
            analysis.counts_complete && !analysis.partial,
            "ordinary rows after exact cap must not force incomplete: {}",
            analysis.candidate_scope
        );
    }

    #[test]
    fn candidate_cap_exact_then_later_exception_is_partial() {
        let _guard = TestScanOverrideGuard::acquire();
        let cap = 8usize;
        set_test_candidate_cap_override(cap);
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_n_exception_lines(&src.join("a_XYZ_e.log"), cap, "ERROR", "XYZ_CAP");
        write_n_info_noise(&src.join("b_XYZ_noise.log"), 20);
        write_n_exception_lines(&src.join("c_XYZ_late.log"), 1, "ERROR", "XYZ_LATE");
        let (_c, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(
            analysis.events_scanned as usize, cap,
            "scope={}",
            analysis.candidate_scope
        );
        assert!(analysis.partial);
        assert!(!analysis.counts_complete);
        assert!(
            analysis.candidate_scope.contains("lower_bound")
                || analysis.events_available > analysis.events_scanned,
            "scope={}",
            analysis.candidate_scope
        );
    }

    #[test]
    fn candidate_cap_at_page_boundary_vs_mid_page() {
        let _guard = TestScanOverrideGuard::acquire();
        // MAX_EVENT_PAGE = 500. Cap=500 fills exactly one page when every row is a candidate.
        let cap = MAX_EVENT_PAGE;
        set_test_candidate_cap_override(cap);

        // Page-boundary: exactly one full page of candidates + later overflow candidate.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("boundary");
        fs::create_dir_all(&src).unwrap();
        write_n_exception_lines(&src.join("a.log"), cap, "ERROR", "XYZ_PAGE");
        write_n_exception_lines(&src.join("b.log"), 1, "ERROR", "XYZ_AFTER_PAGE");
        let (_c, _id, corpus) = ingest_dir(&src);
        let boundary = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(boundary.events_scanned as usize, cap);
        assert!(
            boundary.partial && !boundary.counts_complete,
            "page-boundary overflow must be partial: {}",
            boundary.candidate_scope
        );

        // Mid-page: cap=3 with 5 candidates in a short file (overflow mid first page).
        set_test_candidate_cap_override(3);
        let src2 = tmp.path().join("mid");
        fs::create_dir_all(&src2).unwrap();
        write_n_exception_lines(&src2.join("m.log"), 5, "ERROR", "XYZ_MID");
        let (_c2, _id2, corpus2) = ingest_dir(&src2);
        let mid = analyze_exception_episodes(&corpus2, &[]).unwrap();
        assert_eq!(mid.events_scanned, 3, "scope={}", mid.candidate_scope);
        assert!(
            mid.partial && !mid.counts_complete,
            "scope={}",
            mid.candidate_scope
        );
    }

    #[test]
    fn scan_page_hook_cancels_after_first_fetched_page() {
        let _guard = TestScanOverrideGuard::acquire();
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("cancel");
        fs::create_dir_all(&src).unwrap();
        write_n_exception_lines(
            &src.join("exceptions.log"),
            MAX_EVENT_PAGE + 1,
            "ERROR",
            "XYZ_CANCEL",
        );
        let (_cache, _id, corpus) = ingest_dir(&src);
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_hook = Arc::clone(&cancel);
        set_episode_scan_page_hook_for_test(Some(Box::new(move |page| {
            if page == 0 {
                cancel_hook.store(true, Ordering::SeqCst);
            }
        })));
        let error = analyze_exception_episodes_with_cancel(&corpus, &[], Some(cancel.as_ref()))
            .expect_err("test-only page hook must cancel after the first fetched page");
        assert!(matches!(error, CoreError::Cancelled));
    }

    #[test]
    fn matching_ambiguous_both_bipartite_sides_and_unique_forced() {
        // two apps → one compatible stderr
        let two_apps_one_stderr = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_SIDE\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_SIDE\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                3,
                10,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_SIDE",
            ),
            event(4, 10, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let a = analyze_bounded_events(4, &two_apps_one_stderr);
        assert!(
            a.matching_ambiguous,
            "two apps competing for one stderr must be ambiguous"
        );

        // one app → two compatible stderr
        let one_app_two_stderr = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_SIDE2\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "s1.log",
                "[stderr] java.lang.RuntimeException: XYZ_SIDE2",
            ),
            event(3, 10, "s1.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(
                4,
                10,
                "s2.log",
                "[stderr] java.lang.RuntimeException: XYZ_SIDE2",
            ),
            event(5, 10, "s2.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let b = analyze_bounded_events(5, &one_app_two_stderr);
        assert!(
            b.matching_ambiguous,
            "one app with two stderr partners must be ambiguous"
        );

        // alternating-cycle: 2×2 complete bipartite (same wall, same signature)
        let cycle = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_CYC\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_CYC\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                3,
                10,
                "s1.log",
                "[stderr] java.lang.RuntimeException: XYZ_CYC",
            ),
            event(4, 10, "s1.log", "[stderr] at com.xyz.A.m(A.java:1)"),
            event(
                5,
                10,
                "s2.log",
                "[stderr] java.lang.RuntimeException: XYZ_CYC",
            ),
            event(6, 10, "s2.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let c = analyze_bounded_events(6, &cycle);
        assert!(
            c.matching_ambiguous,
            "alternating-cycle graph must be ambiguous"
        );

        // unique perfect: disjoint exact pairs at distinct times with only one edge each
        let unique = vec![
            event(
                1,
                10,
                "app.log",
                "java.lang.RuntimeException: XYZ_U1\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "s1.log",
                "[stderr] java.lang.RuntimeException: XYZ_U1",
            ),
            event(
                3,
                30,
                "app.log",
                "java.lang.RuntimeException: XYZ_U2\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                4,
                30,
                "s2.log",
                "[stderr] java.lang.RuntimeException: XYZ_U2",
            ),
        ];
        let d = analyze_bounded_events(4, &unique);
        // Different signatures → separate components each with degree 1.
        assert!(
            !d.matching_ambiguous,
            "unique forced pairs must not be marked ambiguous (got policy={})",
            d.matching_policy
        );
        assert_eq!(d.duplicate_rendering_occurrence_count, 2);
    }

    #[test]
    fn production_scan_reaches_info_exception_after_50k_ordinary_info() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_n_info_noise(&src.join("a_noise.log"), 50_001);
        // INFO-level exception after the noise (structure-based, not severity).
        fs::write(
            src.join("b_late.log"),
            "2026-03-15T14:00:00.000Z INFO java.lang.RuntimeException: XYZ_INFO_LATE\n  at com.xyz.Late.m(Late.java:1)\n",
        )
        .unwrap();
        let (_c, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert!(
            analysis.raw_exception_record_count >= 1,
            "must reach INFO exception after 50k ordinary INFO rows"
        );
        assert!(
            analysis.occurrence_count >= 1,
            "INFO exception must form an occurrence without severity filtering"
        );
        assert!(
            analysis.rows_walked > 50_000,
            "walk must pass the ordinary volume (walked={})",
            analysis.rows_walked
        );
        // Within 250k walk — should not be walk-truncated for this size.
        assert!(
            analysis.rows_walked <= EXCEPTION_EPISODE_ROW_WALK_CAP as u64,
            "walked={}",
            analysis.rows_walked
        );
    }

    #[test]
    fn template_projection_family_a_56_family_b_3_supporting_is_exactly_three() {
        // Family A: 56 dual occurrences (compact stderr, not 265).
        // Family B: 3 dual occurrences with unique supporting template_id=7777.
        let mut events = Vec::new();
        for i in 0..56u64 {
            let t = (i * 2) as i64;
            events.push(event(
                i * 10 + 1,
                t,
                "app_a.log",
                "java.lang.RuntimeException: XYZ_FAM_A\n at com.xyz.A.m(A.java:1)",
            ));
            events.push(event(
                i * 10 + 2,
                t,
                "err_a.log",
                "[stderr] java.lang.RuntimeException: XYZ_FAM_A",
            ));
            events.push(event(
                i * 10 + 3,
                t,
                "err_a.log",
                "[stderr] at com.xyz.A.m(A.java:1)",
            ));
        }
        for i in 0..3u64 {
            let t = 10_000 + (i * 2) as i64;
            let base = 10_000 + i * 10;
            let mut app = event(
                base + 1,
                t,
                "app_b.log",
                "java.lang.IllegalStateException: XYZ_FAM_B\n at com.xyz.B.m(B.java:1)",
            );
            app.template_id = 9001;
            let mut head = event(
                base + 2,
                t,
                "err_b.log",
                "[stderr] java.lang.IllegalStateException: XYZ_FAM_B",
            );
            head.template_id = 9002;
            let mut support = event(
                base + 3,
                t,
                "err_b.log",
                "[stderr] at com.xyz.B.uniqueSupport(B.java:99)",
            );
            support.template_id = 7777;
            events.push(app);
            events.push(head);
            events.push(support);
        }
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 59);
        let fam_a = analysis
            .families
            .iter()
            .find(|f| f.occurrence_count == 56)
            .expect("family A 56");
        let fam_b = analysis
            .families
            .iter()
            .find(|f| f.occurrence_count == 3)
            .expect("family B 3");
        assert_ne!(fam_a.signature, fam_b.signature);
        let proj = project_template_onto_episodes(&analysis, 7777);
        assert!(proj.complete, "{proj:?}");
        assert_eq!(proj.occurrence_count, Some(3));
        assert_eq!(proj.supporting_only_occurrence_count, Some(3));
        assert_ne!(proj.occurrence_count, Some(56));
        assert_ne!(proj.occurrence_count, Some(59));
    }

    // ─── WildFly / JBoss exception-envelope parser ─────────────────────────

    #[test]
    fn envelope_parses_exact_wildfly_prefixes_for_header_frame_cause_scaffold() {
        let header = parse_exception_envelope(
            "[stderr] (pool-40-thread-1286) java.lang.RuntimeException: XYZ_PAY",
        );
        assert_eq!(header.stream, Some(EnvelopeStream::Stderr));
        assert_eq!(
            header.parenthesized_thread.as_deref(),
            Some("pool-40-thread-1286")
        );
        assert_eq!(
            header.structural_payload,
            "java.lang.RuntimeException: XYZ_PAY"
        );
        assert!(looks_like_exception_header_line(&header.structural_payload));
        assert!(!header.execution_key_conflict && !header.malformed);

        let frame =
            parse_exception_envelope("[stderr] (pool-40-thread-1286) at com.xyz.A.m(A.java:1)");
        assert_eq!(frame.structural_payload, "at com.xyz.A.m(A.java:1)");
        assert!(is_stack_continuation(&frame.structural_payload));
        assert_eq!(frame.effective_thread(), Some("pool-40-thread-1286"));

        let cause = parse_exception_envelope(
            "[stderr] (pool-40-thread-1286) Caused by: java.io.IOException: XYZ_UP",
        );
        assert!(cause.structural_payload.starts_with("Caused by:"));
        assert!(is_stack_continuation(&cause.structural_payload));
        assert!(exception_signature(&cause.structural_payload).is_some());

        let scaffold = parse_exception_envelope(
            "ERROR [stderr] (pool-40-thread-1286) Exception wrapper XYZ_WRAP#0 for payment",
        );
        assert_eq!(scaffold.stream, Some(EnvelopeStream::Stderr));
        assert_eq!(
            scaffold.parenthesized_thread.as_deref(),
            Some("pool-40-thread-1286")
        );
        assert!(
            is_wrapper_scaffold_line(&scaffold.structural_payload),
            "payload={:?}",
            scaffold.structural_payload
        );
        assert!(!scaffold.malformed);
    }

    #[test]
    fn envelope_existing_thread_eq_and_plain_stderr_formats_remain_supported() {
        let keyed =
            parse_exception_envelope("thread=t1 [stderr] java.lang.RuntimeException: XYZ_PAY");
        assert_eq!(keyed.explicit_thread.as_deref(), Some("t1"));
        assert_eq!(keyed.stream, Some(EnvelopeStream::Stderr));
        assert_eq!(
            keyed.structural_payload,
            "java.lang.RuntimeException: XYZ_PAY"
        );
        assert_eq!(keyed.effective_thread(), Some("t1"));

        let plain = parse_exception_envelope("[stderr] java.lang.RuntimeException: XYZ_PAY");
        assert!(plain.explicit_thread.is_none());
        assert!(plain.parenthesized_thread.is_none());
        assert_eq!(plain.stream, Some(EnvelopeStream::Stderr));
        assert_eq!(
            plain.structural_payload,
            "java.lang.RuntimeException: XYZ_PAY"
        );

        // End-to-end: existing formats still dual-render.
        let events = vec![
            event(
                1,
                10,
                "app.log",
                "thread=t1 java.lang.RuntimeException: XYZ_PAY\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "stderr.log",
                "thread=t1 [stderr] java.lang.RuntimeException: XYZ_PAY",
            ),
            event(
                3,
                10,
                "stderr.log",
                "thread=t1 [stderr] at com.xyz.A.m(A.java:1)",
            ),
            event(
                4,
                20,
                "app2.log",
                "java.lang.RuntimeException: XYZ_PLAIN\n at com.xyz.B.m(B.java:1)",
            ),
            event(
                5,
                20,
                "stderr2.log",
                "[stderr] java.lang.RuntimeException: XYZ_PLAIN",
            ),
            event(6, 20, "stderr2.log", "[stderr] at com.xyz.B.m(B.java:1)"),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.occurrence_count, 2);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 2);
    }

    #[test]
    fn envelope_false_positive_and_malformed_prefix_table() {
        // Ordinary prose parentheses are not execution keys.
        let prose = parse_exception_envelope(
            "see (note) about java.lang.RuntimeException: XYZ in the docs",
        );
        assert!(prose.stream.is_none());
        assert!(prose.parenthesized_thread.is_none());
        assert!(prose.explicit_thread.is_none());
        assert!(!prose.malformed);

        // Method-call parentheses are not thread identity.
        let method =
            parse_exception_envelope("[stderr] at com.xyz.payment.Client.charge(Client.java:42)");
        assert_eq!(method.stream, Some(EnvelopeStream::Stderr));
        assert!(
            method.parenthesized_thread.is_none(),
            "method-call paren must not become thread: {method:?}"
        );
        assert_eq!(
            method.structural_payload,
            "at com.xyz.payment.Client.charge(Client.java:42)"
        );

        // [stderr-ish] is not the stderr stream token.
        let ish = parse_exception_envelope("[stderr-ish] java.lang.RuntimeException: XYZ");
        assert!(ish.stream.is_none(), "{ish:?}");

        // stdout is not treated as the stderr envelope stream.
        let stdout = parse_exception_envelope("[stdout] java.lang.RuntimeException: XYZ");
        assert!(stdout.stream.is_none(), "{stdout:?}");

        // Unbalanced parenthesized thread → malformed.
        let unbalanced = parse_exception_envelope(
            "[stderr] (pool-40-thread-1286 java.lang.RuntimeException: XYZ",
        );
        assert!(unbalanced.malformed, "{unbalanced:?}");
        assert!(unbalanced.parenthesized_thread.is_none());
        assert!(unbalanced.fail_closed_for_attachment());

        // Empty thread token → malformed.
        let empty = parse_exception_envelope("[stderr] () java.lang.RuntimeException: XYZ");
        assert!(empty.malformed, "{empty:?}");
        assert!(empty.parenthesized_thread.is_none());

        // Nested / invalid token → malformed.
        let nested = parse_exception_envelope(
            "[stderr] (pool-(bad)-thread) java.lang.RuntimeException: XYZ",
        );
        assert!(nested.malformed || nested.parenthesized_thread.is_none());
    }

    #[test]
    fn envelope_conflicting_execution_keys_never_attach_or_correlate() {
        // Explicit thread= differs from parenthesized pool thread on the same line.
        let env = parse_exception_envelope(
            "thread=worker-a [stderr] (pool-40-thread-1286) java.lang.RuntimeException: XYZ_C",
        );
        assert!(env.execution_key_conflict, "{env:?}");
        assert!(env.fail_closed_for_attachment());
        assert!(env.effective_thread().is_none());

        let events = vec![
            event(
                1,
                10,
                "app.log",
                "thread=worker-a java.lang.RuntimeException: XYZ_C\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                10,
                "stderr.log",
                "thread=worker-a [stderr] (pool-40-thread-1286) java.lang.RuntimeException: XYZ_C",
            ),
            event(
                3,
                10,
                "stderr.log",
                "thread=worker-a [stderr] (pool-40-thread-1286) at com.xyz.A.m(A.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        // Conflicted stderr must not dual-render with the app (fail closed).
        assert_eq!(
            analysis.duplicate_rendering_occurrence_count, 0,
            "conflicted keys must not claim duplicate rendering: {analysis:?}"
        );
        // No occurrence may cite both app and conflicted stderr children together.
        for occ in analysis.families.iter().flat_map(|f| &f.occurrences) {
            let seqs: BTreeSet<u64> = occ.citations.iter().map(|c| c.seq).collect();
            assert!(
                !(seqs.contains(&1) && (seqs.contains(&2) || seqs.contains(&3))),
                "cross-attach under conflict forbidden: {seqs:?}"
            );
        }
    }

    #[test]
    fn envelope_interleaved_same_signature_pool_threads_remain_isolated() {
        // Interleaved pool-A / pool-B WildFly-prefixed records, same signature.
        let events = vec![
            event(
                1,
                10,
                "stderr.log",
                "[stderr] (pool-A-thread-1) java.lang.RuntimeException: XYZ_INTER",
            ),
            event(
                2,
                10,
                "stderr.log",
                "[stderr] (pool-B-thread-2) java.lang.RuntimeException: XYZ_INTER",
            ),
            event(
                3,
                10,
                "stderr.log",
                "[stderr] (pool-A-thread-1) at com.xyz.A.m(A.java:1)",
            ),
            event(
                4,
                10,
                "stderr.log",
                "[stderr] (pool-B-thread-2) at com.xyz.B.m(B.java:1)",
            ),
            event(
                5,
                10,
                "stderr.log",
                "[stderr] (pool-A-thread-1) at com.xyz.A.n(A.java:2)",
            ),
            event(
                6,
                10,
                "stderr.log",
                "[stderr] (pool-B-thread-2) at com.xyz.B.n(B.java:2)",
            ),
        ];
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        // Two physical stderr renderings, never one mixed rendering.
        let stderr_occs: Vec<_> = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .filter(|o| {
                o.rendering_kinds
                    .contains(&ExceptionRenderingKind::SeparatelyWrappedRecords)
            })
            .collect();
        assert!(
            analysis.rendering_episode_count >= 2,
            "renderings={}",
            analysis.rendering_episode_count
        );
        for occ in &stderr_occs {
            let seqs: BTreeSet<u64> = occ.citations.iter().map(|c| c.seq).collect();
            let has_a = seqs.iter().any(|s| matches!(s, 1 | 3 | 5));
            let has_b = seqs.iter().any(|s| matches!(s, 2 | 4 | 6));
            assert!(
                !(has_a && has_b),
                "cross-thread citations forbidden: {seqs:?}"
            );
        }
        // Pool-A citations {1,3,5} and pool-B {2,4,6} must each appear in some
        // occurrence without mixing.
        let all_groups: Vec<BTreeSet<u64>> = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .map(|o| o.citations.iter().map(|c| c.seq).collect())
            .collect();
        assert!(
            all_groups
                .iter()
                .any(|g| g.is_superset(&BTreeSet::from([1, 3, 5])))
                || all_groups.iter().any(|g| *g == BTreeSet::from([1, 3, 5])),
            "pool-A must form one isolated rendering: {all_groups:?}"
        );
        assert!(
            all_groups
                .iter()
                .any(|g| g.is_superset(&BTreeSet::from([2, 4, 6])))
                || all_groups.iter().any(|g| *g == BTreeSet::from([2, 4, 6])),
            "pool-B must form one isolated rendering: {all_groups:?}"
        );
    }

    #[test]
    fn envelope_265_prefixed_stderr_stack_is_one_rendering_with_unique_citations() {
        let mut events = Vec::new();
        let thread = "pool-40-thread-1286";
        // Header
        events.push(event(
            1,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) java.lang.RuntimeException: XYZ_PAYMENT_FAILED id=0"),
        ));
        let mut seq = 2u64;
        for w in 0..72u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!(
                    "[stderr] ({thread}) Exception wrapper XYZ_WRAP#{w} for payment failure id=0"
                ),
            ));
            seq += 1;
        }
        for f in 0..189u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!("[stderr] ({thread}) at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{})", f + 1),
            ));
            seq += 1;
        }
        // 1 intermediate + 2 terminal causes = 3 (matches 1+72+189+3 = 265)
        events.push(event(
            seq,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT"),
        ));
        seq += 1;
        events.push(event(
            seq,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT"),
        ));
        seq += 1;
        events.push(event(
            seq,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT"),
        ));
        assert_eq!(events.len(), 265, "fixture must be exactly 265 records");

        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.stderr_exception_record_count, 265);
        assert_eq!(analysis.rendering_episode_count, 1);
        assert_eq!(analysis.occurrence_count, 1);
        let occ = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .next()
            .expect("occurrence");
        assert_eq!(occ.raw_record_count, 265);
        assert_eq!(occ.citations.len(), 265);
        let mut seen = HashSet::new();
        for c in &occ.citations {
            assert!(
                seen.insert((c.seq, c.source.clone())),
                "duplicate citation seq={} source={}",
                c.seq,
                c.source
            );
        }
        assert_eq!(seen.len(), 265);
    }

    #[test]
    fn envelope_app_plus_265_prefixed_stderr_still_dual_renders_once() {
        let mut events = Vec::new();
        let thread = "pool-40-thread-1286";
        // App carries the same explicit execution key as the WildFly stderr
        // lane so dual-render correlation (unchanged policy) can Strong-match.
        events.push(event(
            1,
            100,
            "XYZ_app.log",
            &format!(
                "thread={thread} java.lang.RuntimeException: XYZ_PAYMENT_FAILED id=0\n at com.xyz.payment.Client.charge(Client.java:42)\n Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT\n at com.xyz.net.Http.execute(Http.java:15)"
            ),
        ));
        let mut seq = 2u64;
        events.push(event(
            seq,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) java.lang.RuntimeException: XYZ_PAYMENT_FAILED id=0"),
        ));
        seq += 1;
        for w in 0..72u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!(
                    "[stderr] ({thread}) Exception wrapper XYZ_WRAP#{w} for payment failure id=0"
                ),
            ));
            seq += 1;
        }
        for f in 0..189u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!("[stderr] ({thread}) at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{})", f + 1),
            ));
            seq += 1;
        }
        for _ in 0..3u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!(
                    "[stderr] ({thread}) Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT"
                ),
            ));
            seq += 1;
        }
        assert_eq!(events.len(), 266); // 1 app + 265 stderr

        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert_eq!(analysis.application_exception_record_count, 1);
        assert_eq!(analysis.stderr_exception_record_count, 265);
        assert_eq!(analysis.rendering_episode_count, 2);
        assert_eq!(analysis.occurrence_count, 1);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 1);
        let occ = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .next()
            .expect("occurrence");
        assert!(occ.duplicate_rendering);
        assert_eq!(occ.raw_record_count, 266);
        assert_eq!(occ.citations.len(), 266);
        assert!(occ
            .rendering_kinds
            .contains(&ExceptionRenderingKind::ApplicationFullStack));
        assert!(occ
            .rendering_kinds
            .contains(&ExceptionRenderingKind::SeparatelyWrappedRecords));
    }
}
