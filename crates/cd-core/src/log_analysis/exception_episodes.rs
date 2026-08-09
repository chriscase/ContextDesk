//! Bounded, derived exception-rendering analysis (v2 layers).
//!
//! Layers (never mutate durable events):
//! 1. **Raw records** — stored events that look exception-related.
//! 2. **Physical renderings** — app full-stack vs separately wrapped streams.
//! 3. **Application propagation chains** — multi-app wraps/rethrows with
//!    typed execution evidence and fail-closed boundaries.
//! 4. **Strongly supported derived episodes** — chain↔stderr unique matches
//!    (or single dual-render) under reciprocal/forced evidence only.
//! 5. **Families** — bounded signature buckets of retained correlation groups.
//!
//! Merge guards (fail closed):
//! - message equality, divisibility, adjacency, or rotation-family alone never
//!   merge episodes;
//! - order-only app-app grouping requires an exact unique execution anchor;
//! - thread alone never overrides a conflicting trace/request identifier;
//! - unkeyed nodes never transitively bridge conflicting keyed groups;
//! - suppression is applied only via excluded template ids at scan time;
//! - caps, cancellation, and revision are explicit partial/error paths;
//! - semantic totals are certified only when correlation + citations complete.

use crate::error::{CoreError, CoreResult};
use crate::log_analysis::{
    query_event_count, query_event_rows, EventQuery, ExplorerEvent, LogCorpus,
    SearchEvidenceIdentity, MAX_EVENT_PAGE,
};
use crate::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

/// Schema id for host-neutral reports (v2 semantics; additive fields only).
pub const EXCEPTION_EPISODE_SCHEMA_ID: &str = "contextdesk.exception_episode_report.v2";
/// Schema version (2 = typed completeness + certified strong derived episodes).
pub const EXCEPTION_EPISODE_SCHEMA_VERSION: u32 = 2;

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
/// Max wall-seconds spanning one application propagation chain.
const MAX_CHAIN_WALL_SECONDS: i64 = 5;
/// Max wall-seconds between a chain span and a supporting stderr rendering.
const MAX_CHAIN_STDERR_WALL_SECONDS: i64 = 5;
/// Max store rows walked when collecting exception candidates (independent of severity).
pub const EXCEPTION_EPISODE_ROW_WALK_CAP: usize = 250_000;
/// Max templates inspected for the independent structural-template inventory.
pub const EXCEPTION_EPISODE_STRUCTURAL_TEMPLATE_CAP: usize = 50_000;
/// Max independently expected structural identities retained for conservation.
pub const EXCEPTION_EPISODE_STRUCTURAL_IDENTITY_CAP: usize = 250_000;

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
/// Thread-local: safe for parallel unit tests. Not part of the production API.
#[cfg(test)]
pub(crate) fn set_test_candidate_cap_override(cap: usize) {
    TEST_CANDIDATE_CAP_OVERRIDE.with(|c| *c.borrow_mut() = cap);
}

/// Test-only: override row-walk cap (`0` restores production default).
#[cfg(test)]
pub(crate) fn set_test_row_walk_cap_override(cap: usize) {
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

#[cfg(not(test))]
fn invoke_episode_scan_page_hook(_page_index: usize) {}

/// Physical rendering shape found in the event store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionRenderingKind {
    /// One durable event already holds a full stack (conventional multiline).
    ApplicationFullStack,
    /// Separately wrapped/emitted records (`[stderr]` or per-line timestamp stream).
    SeparatelyWrappedRecords,
}

/// Role of one child event inside a physical rendering / retained correlation group.
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

/// Per-template projection onto certified semantic episodes (never borrows global counts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEpisodeProjection {
    /// Template id projected.
    pub template_id: u64,
    /// Certified episodes that contain this template (once each). `None` when uncertified.
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

/// One retained correlation group.
///
/// A group may be a strongly supported derived episode, a weaker multi-render
/// candidate, or one uncorrelated physical rendering. Consumers must not treat
/// a group as a semantic episode unless the enclosing report certifies semantic
/// counts and the group carries Strong correlation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionOccurrenceSummary {
    /// Stable derived episode id (deterministic over citation identity set).
    pub episode_id: String,
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
    /// Bounded evidence reason codes (e.g. same_request_anchor).
    pub reason_codes: Vec<String>,
    /// Bounded conflict codes (empty when no conflict on this claim).
    pub conflict_codes: Vec<String>,
    /// Propagation relation labels among members (e.g. SupportsSameExecution).
    pub relation_types: Vec<String>,
    /// Rendering kinds retained.
    pub rendering_kinds: Vec<ExceptionRenderingKind>,
    /// Exact child event identities (never fabricated).
    pub citations: Vec<ExceptionEventCitation>,
    /// False when a per-render record cap truncated citations.
    pub citations_complete: bool,
    /// Citations omitted due to caps (0 when complete).
    pub omitted_citation_count: u64,
    /// Local ambiguity components affecting this episode (0 when unique).
    pub ambiguity_count: u64,
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
    /// Retained correlation-group count (legacy field name for compatibility).
    pub semantic_occurrences: u64,
    /// `raw_exception_records / retained correlation groups` with remainder.
    pub raw_records_per_occurrence: ExceptionCountRatio,
    /// `stderr_exception_records / retained correlation groups` with remainder.
    pub stderr_records_per_occurrence: ExceptionCountRatio,
    /// `application_exception_records / retained correlation groups` with remainder.
    pub application_records_per_occurrence: ExceptionCountRatio,
    /// `physical_renderings / retained correlation groups` with remainder.
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
    /// Retained correlation-group count (legacy field name for compatibility).
    /// This is not an independent-incident count when semantic totals are uncertified.
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
    /// Retained correlation-group count (legacy field name for compatibility).
    /// This is not an independent-incident count when semantic totals are uncertified.
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
    /// Deprecated v1 alias: `scan_complete && renderings_complete && !partial`.
    /// Does **not** alone certify semantic episode totals — use
    /// `semantic_counts_certified` for host/model exact derived counts.
    pub counts_complete: bool,
    /// True when any occurrence is uncertain.
    pub uncertain: bool,
    /// Occurrences carrying one or more concrete refused-correlation conflicts.
    #[serde(default)]
    pub conflicting_occurrence_count: u64,
    /// Occurrences carrying a non-zero local candidate-component ambiguity count.
    #[serde(default)]
    pub ambiguous_occurrence_count: u64,
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
    /// Scan of candidate rows completed without row-walk / candidate caps.
    pub scan_complete: bool,
    /// Structural template coverage conservation certified for this analysis.
    pub structural_coverage_complete: bool,
    /// Physical rendering assembly completed without render/record caps.
    pub renderings_complete: bool,
    /// Propagation + chain↔stderr correlation completed without ambiguity.
    pub correlation_complete: bool,
    /// Every retained episode has complete citations (no truncated attachments).
    pub citations_complete: bool,
    /// Semantic/derived episode totals are certified for host/model exposure.
    pub semantic_counts_certified: bool,
    /// Strongly supported derived episode count (certified total when
    /// `semantic_counts_certified`; otherwise best-effort retained count).
    pub strong_derived_episode_count: u64,
    /// Physical renderings that stand alone (no multi-rendering claim).
    pub standalone_rendering_count: u64,
    /// Physical renderings left unresolved after correlation.
    pub unresolved_rendering_count: u64,
    /// Components left unresolved due to ambiguous partner choice.
    pub ambiguous_component_count: u64,
    /// Application propagation chain count retained before stderr matching.
    pub application_propagation_chain_count: u64,
    /// Independent inventory: structurally eligible event identities before rendering.
    ///
    /// On the product corpus path this is the **template-derived** expected set
    /// (not `filter(is_exception_candidate)`). Bounded in-memory analysis without
    /// a template catalog leaves this at 0 and withholds structural certification.
    pub eligible_structural_identity_count: u64,
    /// Alias: independently expected structural identities (template inventory).
    pub independently_expected_structural_identity_count: u64,
    /// Message-level candidates recognized by `is_exception_candidate`.
    pub message_candidate_identity_count: u64,
    /// Unique identities present in physical-rendering citations (pre-correlation).
    pub rendering_identity_count: u64,
    /// Unique identities present in the final occurrence citation union.
    pub covered_structural_identity_count: u64,
    /// Independent expected but missing from final citation union.
    pub missing_structural_identity_count: u64,
    /// Independent expected recognized by templates but rejected by message candidate predicate.
    pub candidate_predicate_miss_count: u64,
    /// Independent expected missing from physical-rendering citations.
    pub rendering_miss_count: u64,
    /// Duplicate identity citations across or within episodes.
    pub duplicate_structural_identity_count: u64,
    /// Cited identities not in the independent eligible set.
    pub unexpected_structural_identity_count: u64,
    /// Identities on templates classified as unknown/suspicious structural.
    pub unknown_suspicious_structural_identity_count: u64,
    /// True when template or identity inventory hit a retention cap.
    pub structural_inventory_capped: bool,
    /// Pre-correlation expected application full-stack record count.
    pub expected_application_stack_count: u64,
    /// Final-citation covered application full-stack record count.
    pub covered_application_stack_count: u64,
    /// Pre-correlation expected rendering-lead (header/cause) count.
    pub expected_header_cause_count: u64,
    /// Final-citation covered rendering-lead count.
    pub covered_header_cause_count: u64,
    /// Pre-correlation expected supporting (frame/scaffold) count.
    pub expected_frame_scaffold_count: u64,
    /// Final-citation covered supporting count.
    pub covered_frame_scaffold_count: u64,
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
    /// Bounded structural payload text for graph derivation (not model-facing).
    structural_payload: String,
    /// Request/correlation-like identifier extracted from payload (not model prose).
    request_id: Option<String>,
}

impl RenderEpisode {
    fn first_seq(&self) -> u64 {
        self.citations.first().map_or(0, |c| c.seq)
    }

    fn last_seq(&self) -> u64 {
        self.citations.last().map_or(0, |c| c.seq)
    }

    /// Canonical execution key for conflict detection / diagnostics.
    /// Request and trace take precedence over thread so a shared worker thread
    /// cannot hide mismatched request/trace anchors (P0-3).
    fn strong_execution_key(&self) -> Option<String> {
        // Fail closed: conflicted/malformed envelopes never contribute a key.
        if self.execution_key_conflict || self.envelope_malformed {
            return None;
        }
        if let Some(r) = &self.request_id {
            if !r.is_empty() {
                return Some(format!("req:{r}"));
            }
        }
        if let Some(t) = &self.trace_id {
            if !t.is_empty() {
                return Some(format!("trace:{t}"));
            }
        }
        if let Some(t) = &self.thread {
            if !t.is_empty() {
                return Some(format!("thread:{t}"));
            }
        }
        None
    }

    /// True when both sides carry unequal strong keys of the same kind family.
    fn strong_key_conflicts_with(&self, other: &Self) -> bool {
        match (self.strong_execution_key(), other.strong_execution_key()) {
            (Some(a), Some(b)) if a != b => {
                // Only same-prefix keys conflict (req: vs req:, trace: vs trace:).
                let ap = a.split_once(':').map(|(p, _)| p);
                let bp = b.split_once(':').map(|(p, _)| p);
                ap == bp
            }
            _ => false,
        }
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

    // Pin revisions before multi-page scan + independent template inventory.
    let pinned_event_revision = corpus.event_revision();
    let pinned_template_revision = corpus.template_analysis_revision();

    // Independent structural-template catalog (not message-candidate predicate).
    let excluded: HashSet<u64> = excluded_template_ids.iter().copied().collect();
    let mut structural_by_tid: HashMap<u64, StructuralTemplateRole> = HashMap::new();
    let mut template_inventory_capped = false;
    let mut templates_inspected = 0usize;
    for row in corpus.list_templates() {
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        if templates_inspected >= EXCEPTION_EPISODE_STRUCTURAL_TEMPLATE_CAP {
            template_inventory_capped = true;
            break;
        }
        templates_inspected = templates_inspected.saturating_add(1);
        let tid = row.info.template_id;
        if excluded.contains(&tid) {
            continue;
        }
        if let Some(role) = classify_structural_template_pattern(&row.info.pattern) {
            structural_by_tid.insert(tid, role);
        }
    }
    check_revisions(corpus, pinned_event_revision, pinned_template_revision)?;

    // Candidate scan is severity-independent: walk store rows under suppression.
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
    let mut independent_expected: HashSet<(u64, String)> = HashSet::new();
    let mut message_candidate_ids: HashSet<(u64, String)> = HashSet::new();
    let mut unknown_suspicious_identity_count = 0u64;
    let mut identity_inventory_capped = false;
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
            let id = (event.seq, event.source.clone());
            // Independent inventory: template-role membership, not message predicate.
            if let Some(role) = structural_by_tid.get(&event.template_id) {
                if independent_expected.len() < EXCEPTION_EPISODE_STRUCTURAL_IDENTITY_CAP {
                    independent_expected.insert(id.clone());
                    if *role == StructuralTemplateRole::UnknownSuspicious {
                        unknown_suspicious_identity_count =
                            unknown_suspicious_identity_count.saturating_add(1);
                    }
                } else if !independent_expected.contains(&id) {
                    identity_inventory_capped = true;
                }
            }
            if is_exception_candidate(&event) {
                message_candidate_ids.insert(id);
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
    let inventory_capped = template_inventory_capped || identity_inventory_capped;

    let candidate_scope = format!(
        "structure_based_exception_candidates_independent_of_severity; \
         independent_structural_template_inventory=true; \
         structural_templates={}/{}; \
         independently_expected={}/{}; \
         message_candidates={}; \
         inventory_capped={inventory_capped}; \
         rows_walked={rows_walked}/{row_walk_cap}; \
         candidates_retained={}/{candidate_cap}; \
         store_rows_under_suppression={store_total}; \
         store_eof={store_eof}; \
         candidate_cap_prevents_complete_totals={}",
        structural_by_tid.len(),
        EXCEPTION_EPISODE_STRUCTURAL_TEMPLATE_CAP,
        independent_expected.len(),
        EXCEPTION_EPISODE_STRUCTURAL_IDENTITY_CAP,
        message_candidate_ids.len(),
        candidates.len(),
        incomplete
    );
    // When caps prevent EOF proof, available count is a strict lower bound.
    let events_available = if incomplete {
        candidates.len() as u64 + 1
    } else {
        candidates.len() as u64
    };

    let seed = MatchingMeta {
        inventory_mode: StructuralInventoryMode::TemplateIndependent,
        independent_expected,
        message_candidate_ids,
        unknown_suspicious_identity_count,
        inventory_capped,
        ..MatchingMeta::default()
    };
    let mut analysis =
        analyze_bounded_events_cancellable(events_available, &candidates, &is_cancelled, seed)?;
    // Recheck pinned template revision after inventory + correlation.
    check_revisions(corpus, pinned_event_revision, pinned_template_revision)?;
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
    // Caps / unknown suspicious / inventory incompleteness withhold certification.
    if inventory_capped
        || analysis.unknown_suspicious_structural_identity_count > 0
        || analysis.candidate_predicate_miss_count > 0
        || analysis.rendering_miss_count > 0
    {
        analysis.structural_coverage_complete = false;
        analysis.semantic_counts_certified = false;
    }
    if incomplete {
        analysis.structural_coverage_complete = false;
        analysis.semantic_counts_certified = false;
    }
    // Recompute disclosure after partial flags settle.
    analysis.ranking_disclosure = build_ranking_disclosure(&analysis);
    Ok(analysis)
}

/// Role assigned by the independent structural-template classifier.
///
/// Deliberately separate from [`is_exception_candidate`]: may over-identify and
/// withhold certification, but must not share the message-parser blind spot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum StructuralTemplateRole {
    StackFrame,
    CauseSuppressed,
    WrapperScaffold,
    ExceptionHeaderOrFullStack,
    UnknownSuspicious,
}

/// Classify a persisted Drain template pattern as structural (template-only).
///
/// Uses pattern text with `<*>` wildcards — never calls [`is_exception_candidate`].
pub(crate) fn classify_structural_template_pattern(
    pattern: &str,
) -> Option<StructuralTemplateRole> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return None;
    }
    // Collapse wildcards to a stable token so line-prefix checks remain useful.
    let normalized = pattern.replace("<*>", "X");
    let mut saw_frame = false;
    let mut saw_cause = false;
    let mut saw_scaffold = false;
    let mut saw_header = false;
    for line in normalized.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("at ")
            || line.starts_with("... ")
            || line.contains(" at X")
            || (line.contains(" at ") && line.contains(".java:"))
        {
            saw_frame = true;
            continue;
        }
        if template_line_starts_with_structural_marker(line, "Caused by:")
            || template_line_starts_with_structural_marker(line, "Suppressed:")
            || line.starts_with("--- End of inner exception")
            || line.starts_with("File \"")
        {
            saw_cause = true;
            continue;
        }
        if line.starts_with("Exception in thread")
            || line.contains("Exception wrapper")
            || line.starts_with("Wrapped by:")
            || line.starts_with("Nested exception")
            || (line.starts_with("... ") && line.ends_with(" more"))
        {
            saw_scaffold = true;
            continue;
        }
        // Header / full-stack: dotted type token ending in Exception/Error/Throwable.
        if template_pattern_looks_like_exception_type_line(line) {
            saw_header = true;
        }
    }
    // Prefer specific roles over unknown.
    if saw_cause {
        return Some(StructuralTemplateRole::CauseSuppressed);
    }
    if saw_scaffold {
        return Some(StructuralTemplateRole::WrapperScaffold);
    }
    if saw_frame && !saw_header {
        return Some(StructuralTemplateRole::StackFrame);
    }
    if saw_header {
        return Some(StructuralTemplateRole::ExceptionHeaderOrFullStack);
    }
    if saw_frame {
        return Some(StructuralTemplateRole::StackFrame);
    }
    // Conservative over-identify: exception-ish keywords without clear role.
    // Prefer specific roles above; only fall through when structure is ambiguous.
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("exception")
        || lower.contains("stacktrace")
        || lower.contains("stack_trace")
        || lower.contains("throwable")
        || (lower.contains("[stderr]")
            && (lower.contains(" at ")
                || lower.contains("caused by")
                || lower.contains("error")
                || lower.contains("fail")))
    {
        return Some(StructuralTemplateRole::UnknownSuspicious);
    }
    None
}

/// Recognize a structural marker either at the payload boundary or after one
/// service-like template token. Some formatters retain a service identity in
/// the Drain pattern even after timestamp/level parsing. Keep the fallback
/// deliberately narrow: prose prefixes and arbitrary multi-word text must not
/// turn an ordinary ERROR template into exception support.
fn template_line_starts_with_structural_marker(line: &str, marker: &str) -> bool {
    let mut line = line.trim_start();
    for level in [
        "ERROR ", "error ", "WARN ", "warn ", "INFO ", "info ", "DEBUG ", "debug ", "FATAL ",
        "fatal ", "TRACE ", "trace ",
    ] {
        if let Some(rest) = line.strip_prefix(level) {
            line = rest.trim_start();
            break;
        }
    }
    if let Some(rest) = line.strip_prefix(STDERR_TOKEN) {
        line = rest.trim_start();
    }
    if line.starts_with('(') {
        if let Some(close) = line.find(')') {
            if close <= MAX_THREAD_TOKEN_CHARS {
                line = line.get(close + 1..).unwrap_or(line).trim_start();
            }
        }
    }
    if line.starts_with(marker) {
        return true;
    }
    let Some(marker_start) = line.find(marker) else {
        return false;
    };
    let prefix = line[..marker_start].trim_end();
    if prefix.is_empty() || prefix.len() > 96 || prefix.chars().any(char::is_whitespace) {
        return false;
    }
    // A real exception header may mention a cause marker later in the same
    // sentence. Header authority wins when the bounded prefix already carries
    // the typed exception token; only an envelope/service token may precede a
    // structural continuation marker.
    if template_pattern_looks_like_exception_type_line(prefix) {
        return false;
    }
    for ch in prefix.chars() {
        if ch.is_ascii_alphanumeric() {
            continue;
        }
        if matches!(ch, '-' | '_' | '.' | '/' | '=' | ':' | '[' | ']') {
            continue;
        }
        return false;
    }
    true
}

fn template_pattern_looks_like_exception_type_line(line: &str) -> bool {
    let line = line
        .strip_prefix("ERROR ")
        .or_else(|| line.strip_prefix("WARN "))
        .or_else(|| line.strip_prefix("INFO "))
        .or_else(|| line.strip_prefix("error "))
        .unwrap_or(line)
        .trim();
    let line = line
        .strip_prefix("[stderr]")
        .map(str::trim_start)
        .unwrap_or(line);
    let line = if line.starts_with('(') {
        line.find(')')
            .and_then(|i| line.get(i + 1..))
            .map(str::trim_start)
            .unwrap_or(line)
    } else {
        line
    };
    let line = line
        .strip_prefix("Caused by:")
        .map(str::trim_start)
        .unwrap_or(line);
    if line.starts_with("at ") {
        return false;
    }
    // Scan tokens for package.Type ending in Exception|Error|Throwable (ASCII case-insensitive).
    for raw in line.split_whitespace().take(8) {
        let token = raw.trim_matches(|c: char| matches!(c, ':' | ',' | '"' | '\'' | ';'));
        if token.is_empty() || token.len() > 256 {
            continue;
        }
        let base = token.rsplit('.').next().unwrap_or(token);
        let b = base.as_bytes();
        if ends_with_ascii_ignore_case(b, b"Exception")
            || ends_with_ascii_ignore_case(b, b"Error")
            || ends_with_ascii_ignore_case(b, b"Throwable")
        {
            return true;
        }
    }
    false
}

fn ends_with_ascii_ignore_case(hay: &[u8], needle: &[u8]) -> bool {
    if hay.len() < needle.len() {
        return false;
    }
    let start = hay.len() - needle.len();
    hay[start..]
        .iter()
        .zip(needle.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
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

/// How structural inventory was obtained for conservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum StructuralInventoryMode {
    /// No template catalog — structural certification must be withheld.
    #[default]
    Unavailable,
    /// Template-pattern inventory collected on the product corpus path.
    TemplateIndependent,
}

#[derive(Debug, Clone, Default)]
struct MatchingMeta {
    unpaired_renderings: u64,
    ambiguous: bool,
    ambiguous_components: u64,
    application_propagation_chains: u64,
    strong_derived_episodes: u64,
    standalone_renderings: u64,
    correlation_complete: bool,
    inventory_mode: StructuralInventoryMode,
    independent_expected: HashSet<(u64, String)>,
    message_candidate_ids: HashSet<(u64, String)>,
    unknown_suspicious_identity_count: u64,
    inventory_capped: bool,
    eligible_structural_identity_count: u64,
    independently_expected_structural_identity_count: u64,
    message_candidate_identity_count: u64,
    rendering_identity_count: u64,
    covered_structural_identity_count: u64,
    missing_structural_identity_count: u64,
    candidate_predicate_miss_count: u64,
    rendering_miss_count: u64,
    duplicate_structural_identity_count: u64,
    unexpected_structural_identity_count: u64,
    structural_coverage_complete: bool,
    expected_application_stack_count: u64,
    covered_application_stack_count: u64,
    expected_header_cause_count: u64,
    covered_header_cause_count: u64,
    expected_frame_scaffold_count: u64,
    covered_frame_scaffold_count: u64,
}

fn analyze_bounded_events_cancellable(
    events_available: u64,
    events: &[ExplorerEvent],
    is_cancelled: &dyn Fn() -> bool,
    seed_meta: MatchingMeta,
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

    // Message candidates among retained analysis events (always computed).
    let message_from_events: HashSet<(u64, String)> = ordered
        .iter()
        .filter(|e| is_exception_candidate(e))
        .map(|e| (e.seq, e.source.clone()))
        .collect();
    // Independent expected set: ONLY from template inventory when available.
    // Never derive "independent" from filter(is_exception_candidate) alone —
    // that shares the message-parser blind spot the company corpus exposes.
    let (eligible_identities, message_candidate_ids, inventory_available) =
        match seed_meta.inventory_mode {
            StructuralInventoryMode::TemplateIndependent => (
                seed_meta.independent_expected.clone(),
                if seed_meta.message_candidate_ids.is_empty() {
                    message_from_events
                } else {
                    seed_meta.message_candidate_ids.clone()
                },
                true,
            ),
            StructuralInventoryMode::Unavailable => {
                // Bounded path without template catalog: withhold structural cert.
                (HashSet::new(), message_from_events, false)
            }
        };
    let independently_expected = eligible_identities.len() as u64;
    let message_candidate_identity_count = message_candidate_ids.len() as u64;
    let candidate_predicate_miss_count = eligible_identities
        .iter()
        .filter(|k| !message_candidate_ids.contains(*k))
        .count() as u64;

    let (renderings, render_partial) = derive_render_episodes_cancellable(&ordered, is_cancelled)?;
    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    // Physical-rendering citation union (stage 2) — independent of final episodes.
    let mut rendering_union: HashSet<(u64, String)> = HashSet::new();
    let mut expected_app_stack = 0u64;
    let mut expected_header_cause = 0u64;
    let mut expected_frame_scaffold = 0u64;
    for r in &renderings {
        for c in &r.citations {
            rendering_union.insert((c.seq, c.source.clone()));
            if c.rendering_kind == ExceptionRenderingKind::ApplicationFullStack {
                expected_app_stack = expected_app_stack.saturating_add(1);
            }
            match c.role {
                ExceptionCitationRole::RenderingLead => {
                    expected_header_cause = expected_header_cause.saturating_add(1);
                }
                ExceptionCitationRole::SupportingRecord => {
                    expected_frame_scaffold = expected_frame_scaffold.saturating_add(1);
                }
            }
        }
    }
    let rendering_identity_count = rendering_union.len() as u64;
    let rendering_miss_count = eligible_identities
        .iter()
        .filter(|k| !rendering_union.contains(*k))
        .count() as u64;
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
    let (occurrences, mut match_meta) = correlate_renderings_cancellable(renderings, is_cancelled)?;
    // Stage 3: final occurrence citation union vs independent expected.
    let mut cite_union: HashSet<(u64, String)> = HashSet::new();
    let mut dup_cites = 0u64;
    let mut covered_app_stack = 0u64;
    let mut covered_header_cause = 0u64;
    let mut covered_frame_scaffold = 0u64;
    for (_, occ) in &occurrences {
        for c in &occ.citations {
            if !cite_union.insert((c.seq, c.source.clone())) {
                dup_cites = dup_cites.saturating_add(1);
            } else {
                if c.rendering_kind == ExceptionRenderingKind::ApplicationFullStack {
                    covered_app_stack = covered_app_stack.saturating_add(1);
                }
                match c.role {
                    ExceptionCitationRole::RenderingLead => {
                        covered_header_cause = covered_header_cause.saturating_add(1);
                    }
                    ExceptionCitationRole::SupportingRecord => {
                        covered_frame_scaffold = covered_frame_scaffold.saturating_add(1);
                    }
                }
            }
        }
    }
    let covered = cite_union.len() as u64;
    let missing = eligible_identities
        .iter()
        .filter(|k| !cite_union.contains(*k))
        .count() as u64;
    let unexpected = cite_union
        .iter()
        .filter(|k| !eligible_identities.contains(*k))
        .count() as u64;
    match_meta.inventory_mode = seed_meta.inventory_mode;
    match_meta.unknown_suspicious_identity_count = seed_meta.unknown_suspicious_identity_count;
    match_meta.inventory_capped = seed_meta.inventory_capped;
    match_meta.eligible_structural_identity_count = independently_expected;
    match_meta.independently_expected_structural_identity_count = independently_expected;
    match_meta.message_candidate_identity_count = message_candidate_identity_count;
    match_meta.rendering_identity_count = rendering_identity_count;
    match_meta.covered_structural_identity_count = covered;
    match_meta.missing_structural_identity_count = missing;
    match_meta.candidate_predicate_miss_count = candidate_predicate_miss_count;
    match_meta.rendering_miss_count = rendering_miss_count;
    match_meta.duplicate_structural_identity_count = dup_cites;
    match_meta.unexpected_structural_identity_count = unexpected;
    match_meta.expected_application_stack_count = expected_app_stack;
    match_meta.covered_application_stack_count = covered_app_stack;
    match_meta.expected_header_cause_count = expected_header_cause;
    match_meta.covered_header_cause_count = covered_header_cause;
    match_meta.expected_frame_scaffold_count = expected_frame_scaffold;
    match_meta.covered_frame_scaffold_count = covered_frame_scaffold;
    let role_conserved = expected_app_stack == covered_app_stack
        && expected_header_cause == covered_header_cause
        && expected_frame_scaffold == covered_frame_scaffold;
    // Structural coverage is complete only with a real independent template inventory.
    match_meta.structural_coverage_complete = inventory_available
        && !seed_meta.inventory_capped
        && seed_meta.unknown_suspicious_identity_count == 0
        && candidate_predicate_miss_count == 0
        && rendering_miss_count == 0
        && missing == 0
        && unexpected == 0
        && dup_cites == 0
        && covered == independently_expected
        && independently_expected > 0
        && role_conserved;
    let occurrence_count = occurrences.len() as u64;
    let duplicate_rendering_occurrence_count = occurrences
        .iter()
        .filter(|(_, occurrence)| occurrence.duplicate_rendering)
        .count() as u64;
    let strong_occurrence_count = occurrences
        .iter()
        .filter(|(_, o)| {
            o.duplicate_rendering
                && o.correlation_confidence == ExceptionCorrelationConfidence::Strong
        })
        .count() as u64;
    // Keep strong_derived aligned with Strong multi-rendering episodes only.
    match_meta.strong_derived_episodes = strong_occurrence_count;
    let uncertain = occurrences.iter().any(|(_, occurrence)| {
        !occurrence.citations_complete
            || (occurrence.duplicate_rendering
                && occurrence.correlation_confidence != ExceptionCorrelationConfidence::Strong)
    });
    let conflicting_occurrence_count = occurrences
        .iter()
        .filter(|(_, occurrence)| !occurrence.conflict_codes.is_empty())
        .count() as u64;
    let ambiguous_occurrence_count = occurrences
        .iter()
        .filter(|(_, occurrence)| occurrence.ambiguity_count > 0)
        .count() as u64;

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
        let strong_count = |family: &ExceptionFamilySummary| {
            family
                .occurrences
                .iter()
                .filter(|occurrence| {
                    occurrence.duplicate_rendering
                        && occurrence.correlation_confidence
                            == ExceptionCorrelationConfidence::Strong
                })
                .count()
        };
        strong_count(right)
            .cmp(&strong_count(left))
            .then_with(|| right.occurrence_count.cmp(&left.occurrence_count))
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
    let scan_complete = !scan_partial;
    let renderings_complete = !render_partial;
    // Deprecated v1 alias: scan + render completeness only (not semantic certification).
    let counts_complete = scan_complete && renderings_complete && !partial;
    let citations_complete = families
        .iter()
        .all(|f| f.occurrences.iter().all(|o| o.citations_complete));
    let correlation_complete = match_meta.correlation_complete && !match_meta.ambiguous;
    // P0-2/P0-3: independent structural conservation + Strong-only semantic cert.
    let structural_coverage_complete = counts_complete
        && citations_complete
        && match_meta.structural_coverage_complete
        && match_meta.unpaired_renderings == 0;
    let semantic_counts_certified = structural_coverage_complete
        && correlation_complete
        && citations_complete
        && !partial
        && match_meta.strong_derived_episodes > 0
        && match_meta.unpaired_renderings == 0
        && match_meta.strong_derived_episodes == strong_occurrence_count
        && match_meta.missing_structural_identity_count == 0
        && match_meta.unexpected_structural_identity_count == 0
        && match_meta.duplicate_structural_identity_count == 0
        && match_meta.candidate_predicate_miss_count == 0
        && match_meta.rendering_miss_count == 0
        && match_meta.unknown_suspicious_identity_count == 0
        && !match_meta.inventory_capped
        && match_meta.inventory_mode == StructuralInventoryMode::TemplateIndependent;

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
        conflicting_occurrence_count,
        ambiguous_occurrence_count,
        matching_policy:
            "v3_global_exact_anchor_component_preflight_plus_unique_chain_stderr_match; reused_anchor_components_unresolved".into(),
        matching_ambiguous: match_meta.ambiguous,
        pinned_event_revision: None,
        pinned_template_analysis_revision: None,
        ranking_disclosure: String::new(),
        families,
        scan_complete,
        structural_coverage_complete,
        renderings_complete,
        correlation_complete,
        citations_complete,
        semantic_counts_certified,
        strong_derived_episode_count: match_meta.strong_derived_episodes,
        standalone_rendering_count: match_meta.standalone_renderings,
        unresolved_rendering_count: match_meta.unpaired_renderings,
        ambiguous_component_count: match_meta.ambiguous_components,
        application_propagation_chain_count: match_meta.application_propagation_chains,
        eligible_structural_identity_count: match_meta.eligible_structural_identity_count,
        independently_expected_structural_identity_count: match_meta
            .independently_expected_structural_identity_count,
        message_candidate_identity_count: match_meta.message_candidate_identity_count,
        rendering_identity_count: match_meta.rendering_identity_count,
        covered_structural_identity_count: match_meta.covered_structural_identity_count,
        missing_structural_identity_count: match_meta.missing_structural_identity_count,
        candidate_predicate_miss_count: match_meta.candidate_predicate_miss_count,
        rendering_miss_count: match_meta.rendering_miss_count,
        duplicate_structural_identity_count: match_meta.duplicate_structural_identity_count,
        unexpected_structural_identity_count: match_meta.unexpected_structural_identity_count,
        unknown_suspicious_structural_identity_count: match_meta.unknown_suspicious_identity_count,
        structural_inventory_capped: match_meta.inventory_capped,
        expected_application_stack_count: match_meta.expected_application_stack_count,
        covered_application_stack_count: match_meta.covered_application_stack_count,
        expected_header_cause_count: match_meta.expected_header_cause_count,
        covered_header_cause_count: match_meta.covered_header_cause_count,
        expected_frame_scaffold_count: match_meta.expected_frame_scaffold_count,
        covered_frame_scaffold_count: match_meta.covered_frame_scaffold_count,
    };
    analysis.ranking_disclosure = build_ranking_disclosure(&analysis);
    Ok(analysis)
}

fn build_ranking_disclosure(report: &ExceptionEpisodeAnalysis) -> String {
    let amp = &report.amplification;
    let certified_semantic_count = if report.semantic_counts_certified && !report.partial {
        report.strong_derived_episode_count.to_string()
    } else {
        "withheld".into()
    };
    format!(
        "ranking_basis: strong_derived_episodes DESC, retained_correlation_groups DESC, raw_records DESC, signature ASC\n\
         candidate_scope: {}\n\
         layer_raw_exception_records: {}\n\
         layer_application_exception_records: {}\n\
         layer_stderr_exception_records: {}\n\
         layer_physical_renderings: {}\n\
         layer_unpaired_renderings: {}\n\
         layer_retained_correlation_groups: {}\n\
         layer_certified_semantic_episodes: {}\n\
         layer_duplicate_rendering_occurrences: {}\n\
         layer_application_propagation_chains: {}\n\
         layer_strong_derived_episodes: {}\n\
         layer_standalone_renderings: {}\n\
         layer_unresolved_renderings: {}\n\
         layer_ambiguous_components: {}\n\
         layer_conflicting_occurrences: {}\n\
         layer_ambiguous_occurrences: {}\n\
         amplification_raw_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_stderr_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_application_records_per_occurrence: {}/{} = {} rem {} integral={}\n\
         amplification_renderings_per_occurrence: {}/{} = {} rem {} integral={}\n\
         scan_complete: {}\n\
         renderings_complete: {}\n\
         correlation_complete: {}\n\
         citations_complete: {}\n\
         structural_coverage_complete: {}\n\
         semantic_counts_certified: {}\n\
         counts_complete: {} (deprecated v1 alias: scan+render complete, not semantic certification)\n\
         conservation_stage1_independently_expected: {}\n\
         conservation_stage1_message_candidates: {}\n\
         conservation_stage1_candidate_predicate_misses: {}\n\
         conservation_stage2_rendering_identities: {}\n\
         conservation_stage2_rendering_misses: {}\n\
         conservation_stage3_final_unique_citations: {}\n\
         conservation_stage3_missing: {}\n\
         conservation_stage3_unexpected: {}\n\
         conservation_stage3_duplicates: {}\n\
         unknown_suspicious_structural_identities: {}\n\
         structural_inventory_capped: {}\n\
         matching_policy: {}\n\
         matching_ambiguous: {}\n\
         independent_incident_claim_forbidden: true\n\
         interpretation: wrappers and stack frames are supporting records of a rendering; \
         application multi-renderings form propagation chains under typed execution evidence; \
         chain↔stderr matching is forced/reciprocal-unique only. \
         Order-only app-app grouping requires an exact unique execution anchor. \
         Structural inventory is template-derived (not is_exception_candidate). \
         Exact semantic totals may be exposed only when semantic_counts_certified=true. \
         When partial or uncertified, do not present derived episode totals as corpus-wide incidents.\n",
        report.candidate_scope,
        report.raw_exception_record_count,
        report.application_exception_record_count,
        report.stderr_exception_record_count,
        report.rendering_episode_count,
        report.unpaired_rendering_count,
        report.occurrence_count,
        certified_semantic_count,
        report.duplicate_rendering_occurrence_count,
        report.application_propagation_chain_count,
        report.strong_derived_episode_count,
        report.standalone_rendering_count,
        report.unresolved_rendering_count,
        report.ambiguous_component_count,
        report.conflicting_occurrence_count,
        report.ambiguous_occurrence_count,
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
        report.scan_complete,
        report.renderings_complete,
        report.correlation_complete,
        report.citations_complete,
        report.structural_coverage_complete,
        report.semantic_counts_certified,
        report.counts_complete,
        report.independently_expected_structural_identity_count,
        report.message_candidate_identity_count,
        report.candidate_predicate_miss_count,
        report.rendering_identity_count,
        report.rendering_miss_count,
        report.covered_structural_identity_count,
        report.missing_structural_identity_count,
        report.unexpected_structural_identity_count,
        report.duplicate_structural_identity_count,
        report.unknown_suspicious_structural_identity_count,
        report.structural_inventory_capped,
        report.matching_policy,
        report.matching_ambiguous,
    )
}

/// Project one template onto certified semantic episodes (at most once per episode).
pub fn project_template_onto_episodes(
    report: &ExceptionEpisodeAnalysis,
    template_id: u64,
) -> TemplateEpisodeProjection {
    if report.partial || !report.counts_complete || !report.semantic_counts_certified {
        return TemplateEpisodeProjection {
            template_id,
            occurrence_count: None,
            lead_occurrence_count: None,
            supporting_only_occurrence_count: None,
            complete: false,
            incomplete_reason: Some(
                "semantic episode totals are partial, incomplete, or uncertified; template projection withheld"
                    .into(),
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
    let semantic_line = if report.semantic_counts_certified && !report.partial {
        format!(
            "semantic_counts_certified: true\n\
             strongly_supported_derived_episodes: {}\n\
             semantic_occurrence_count: {}\n",
            report.strong_derived_episode_count, report.strong_derived_episode_count
        )
    } else {
        format!(
            "semantic_counts_certified: false\n\
             strongly_supported_derived_episodes_uncertified: {}\n\
             semantic_occurrence_count: withheld\n\
             limitation: exact semantic/derived episode totals are not certified; \
use raw/rendering and unresolved/ambiguous counts only\n",
            report.strong_derived_episode_count
        )
    };
    out.push_str(&format!(
        "schema_id: {}\nschema_version: {}\n\
         independent_incident_claim_forbidden: true\n\
         scan_complete: {}\nrenderings_complete: {}\ncorrelation_complete: {}\n\
         citations_complete: {}\nstructural_coverage_complete: {}\n\
         counts_complete: {} (deprecated v1 alias)\npartial: {}\nuncertain: {}\nmatching_ambiguous: {}\n\
         raw_exception_record_count: {}\n\
         application_exception_record_count: {}\n\
         stderr_exception_record_count: {}\n\
         physical_rendering_count: {}\n\
         application_propagation_chain_count: {}\n\
         unpaired_rendering_count: {}\n\
         standalone_rendering_count: {}\n\
         unresolved_rendering_count: {}\n\
         ambiguous_component_count: {}\n\
         conflicting_occurrence_count: {}\n\
         ambiguous_occurrence_count: {}\n\
         duplicate_rendering_occurrence_count: {}\n\
         amplification_raw_records_per_occurrence: {}/{} = {} rem {}\n\
         amplification_stderr_records_per_occurrence: {}/{} = {} rem {}\n\
         amplification_renderings_per_occurrence: {}/{} = {} rem {}\n\
         matching_policy: {}\n{}",
        report.schema_id,
        report.schema_version,
        report.scan_complete,
        report.renderings_complete,
        report.correlation_complete,
        report.citations_complete,
        report.structural_coverage_complete,
        report.counts_complete,
        report.partial,
        report.uncertain,
        report.matching_ambiguous,
        report.raw_exception_record_count,
        report.application_exception_record_count,
        report.stderr_exception_record_count,
        report.rendering_episode_count,
        report.application_propagation_chain_count,
        report.unpaired_rendering_count,
        report.standalone_rendering_count,
        report.unresolved_rendering_count,
        report.ambiguous_component_count,
        report.conflicting_occurrence_count,
        report.ambiguous_occurrence_count,
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
        report.matching_policy,
        semantic_line,
    ));
    for family in report.families.iter().take(4) {
        let famp = &family.amplification;
        let strong_derived = family
            .occurrences
            .iter()
            .filter(|occurrence| {
                occurrence.duplicate_rendering
                    && occurrence.correlation_confidence == ExceptionCorrelationConfidence::Strong
            })
            .count() as u64;
        let non_strong_groups = family.occurrence_count.saturating_sub(strong_derived);
        let sig = {
            let mut s: String = family.signature.chars().take(96).collect();
            if family.signature.chars().count() > 96 {
                s.push('…');
            }
            s
        };
        out.push_str(&format!(
            "- signature={sig} retained_correlation_groups={} strong_derived_episodes={} \
             non_strong_groups={} raw={} app={} stderr={} \
             raw_per_group={}/{}={} rem{} duplicate_render_groups={}\n",
            family.occurrence_count,
            strong_derived,
            non_strong_groups,
            family.raw_record_count,
            family.application_record_count,
            family.stderr_record_count,
            famp.raw_records_per_occurrence.numerator,
            famp.raw_records_per_occurrence.denominator,
            famp.raw_records_per_occurrence.quotient,
            famp.raw_records_per_occurrence.remainder,
            family.duplicate_rendering_occurrence_count
        ));
    }
    out.push_str(
        "note: occurrenceCount and semanticOccurrences are legacy JSON names for retained correlation groups; \
         raw records ≠ renderings ≠ retained groups ≠ strongly supported derived episodes ≠ independent incidents; \
         amplification ratios include remainders; \
         counts_complete is independent of ratio_integral; \
         semantic totals require semantic_counts_certified.\n",
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
                let is_cause = template_line_starts_with_structural_marker(payload, "Caused by:");
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
    let mut structural_payload = env.structural_payload.clone();
    // Bound retained payload for graph derivation.
    if structural_payload.len() > 8_192 {
        structural_payload.truncate(8_192);
    }
    let request_id = extract_request_like_id(&structural_payload)
        .or_else(|| extract_request_like_id(&event.message));
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
        structural_payload,
        request_id,
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
    if episode.request_id.is_none() {
        episode.request_id = extract_request_like_id(&env.structural_payload)
            .or_else(|| extract_request_like_id(&event.message));
    }
    episode.citations.push(citation(
        event,
        episode.kind,
        ExceptionCitationRole::SupportingRecord,
    ));
    // Append structural payload for multi-line stderr assembly (bounded).
    if episode.structural_payload.len() < 8_192 {
        if !episode.structural_payload.is_empty() {
            episode.structural_payload.push('\n');
        }
        let add = env.structural_payload.as_str();
        let remain = 8_192 - episode.structural_payload.len();
        let take = add
            .char_indices()
            .take_while(|(i, _)| *i < remain)
            .map(|(i, c)| i + c.len_utf8())
            .last()
            .unwrap_or(0)
            .min(add.len());
        if let Some(chunk) = add.get(..take) {
            episode.structural_payload.push_str(chunk);
        }
    }
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
// Layer 3–4: application propagation chains + chain↔stderr episodes
// ---------------------------------------------------------------------------

/// Exception-graph summary derived from one physical rendering's payload text.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct ExceptionGraphSummary {
    /// Ordered exception types outer → root (lowercased).
    exception_types: Vec<String>,
    /// Normalized root detail (after type).
    root_detail: String,
    /// Root signature string (type + detail).
    root_signature: String,
    /// First top-frame class.method per cause level (bounded).
    top_frames: Vec<String>,
    /// Propagation-site key (outermost top frame, or signature fallback).
    propagation_site: String,
    /// True when types + at least one frame were recovered.
    complete: bool,
}

/// Typed execution signals with provenance/scope (never inject raw ids into prose).
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct TypedExecutionSignals {
    trace_id: Option<String>,
    request_id: Option<String>,
    host: Option<String>,
    process: Option<String>,
    /// Source-scoped thread identity (explicit or parenthesized).
    thread: Option<String>,
    service: Option<String>,
    source: String,
    /// Logger/class bracket text — never a strong thread identity.
    logger: Option<String>,
    wall_time: bool,
    first_ts: i64,
    last_ts: i64,
    execution_key_conflict: bool,
    envelope_malformed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum LinkConfidence {
    ExactExecutionAnchor,
    StrongMultiSignal,
    Candidate,
}

fn derive_exception_graph(message: &str, fallback_signature: &str) -> ExceptionGraphSummary {
    let mut types = Vec::new();
    let mut top_frames = Vec::new();
    let mut pending_frame_slot = false;
    for line in message.lines() {
        let trimmed = line.trim();
        if let Some(sig) = exception_signature_line(trimmed) {
            let (ty, detail) = split_signature_type_detail(&sig);
            types.push(ty);
            if !detail.is_empty() {
                // keep last detail as root detail candidate
            }
            pending_frame_slot = true;
            continue;
        }
        if pending_frame_slot {
            if let Some(frame) = extract_top_frame_key(trimmed) {
                top_frames.push(frame);
                pending_frame_slot = false;
            }
        }
    }
    let root_signature = if fallback_signature.is_empty() {
        types.last().cloned().unwrap_or_default()
    } else {
        fallback_signature.to_string()
    };
    let (root_ty, root_detail) = split_signature_type_detail(&root_signature);
    if types.is_empty() && !root_ty.is_empty() {
        types.push(root_ty);
    }
    let propagation_site = top_frames
        .first()
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if root_signature.is_empty() {
                "unknown_site".into()
            } else {
                format!("sig:{root_signature}")
            }
        });
    let complete = !types.is_empty() && !top_frames.is_empty();
    ExceptionGraphSummary {
        exception_types: types,
        root_detail,
        root_signature,
        top_frames,
        propagation_site,
        complete,
    }
}

fn split_signature_type_detail(sig: &str) -> (String, String) {
    if let Some((ty, detail)) = sig.split_once(':') {
        (ty.trim().to_string(), detail.trim().to_string())
    } else {
        (sig.trim().to_string(), String::new())
    }
}

fn extract_top_frame_key(line: &str) -> Option<String> {
    let line = line.trim();
    let rest = line.strip_prefix("at ")?.trim();
    // com.foo.Bar.method(File.java:1) → com.foo.Bar.method
    let head = rest.split('(').next()?.trim();
    if head.is_empty() {
        return None;
    }
    Some(head.chars().take(160).collect())
}

fn signals_from_rendering(r: &RenderEpisode) -> TypedExecutionSignals {
    TypedExecutionSignals {
        trace_id: r.trace_id.clone().filter(|s| !s.is_empty()),
        request_id: r.request_id.clone().filter(|s| !s.is_empty()),
        host: r.host.clone().filter(|s| !s.is_empty()),
        process: None,
        thread: r.thread.clone().filter(|s| !s.is_empty()),
        service: r.service.clone().filter(|s| !s.is_empty()),
        source: r.source.clone(),
        logger: None,
        wall_time: r.wall_time,
        first_ts: r.first_ts,
        last_ts: r.last_ts,
        execution_key_conflict: r.execution_key_conflict,
        envelope_malformed: r.envelope_malformed,
    }
}

/// Global-scope conflict (trace/request) always rejects. Source-scoped thread
/// conflicts only within the same source.
fn execution_signals_conflict(a: &TypedExecutionSignals, b: &TypedExecutionSignals) -> bool {
    if a.execution_key_conflict
        || b.execution_key_conflict
        || a.envelope_malformed
        || b.envelope_malformed
    {
        return true;
    }
    if let (Some(x), Some(y)) = (&a.trace_id, &b.trace_id) {
        if x != y {
            return true;
        }
    }
    if let (Some(x), Some(y)) = (&a.request_id, &b.request_id) {
        if x != y {
            return true;
        }
    }
    // Thread never overrides a conflicting trace: if both have traces that match
    // but threads differ, still ok for cross-source; same-source thread mismatch rejects.
    if a.source == b.source {
        if let (Some(x), Some(y)) = (&a.thread, &b.thread) {
            if x != y {
                return true;
            }
        }
    }
    if let (Some(x), Some(y)) = (&a.host, &b.host) {
        if x != y {
            return true;
        }
    }
    if let (Some(x), Some(y)) = (&a.service, &b.service) {
        if x != y {
            return true;
        }
    }
    false
}

fn matching_global_anchor(a: &TypedExecutionSignals, b: &TypedExecutionSignals) -> bool {
    matches!((&a.trace_id, &b.trace_id), (Some(x), Some(y)) if x == y)
        || matches!((&a.request_id, &b.request_id), (Some(x), Some(y)) if x == y)
}

fn execution_conflict_codes(a: &TypedExecutionSignals, b: &TypedExecutionSignals) -> Vec<String> {
    let mut codes = Vec::new();
    if a.execution_key_conflict || b.execution_key_conflict {
        codes.push("conflicting_envelope_execution_key".into());
    }
    if a.envelope_malformed || b.envelope_malformed {
        codes.push("malformed_execution_envelope".into());
    }
    if matches!((&a.trace_id, &b.trace_id), (Some(x), Some(y)) if x != y) {
        codes.push("conflicting_trace_anchor".into());
    }
    if matches!((&a.request_id, &b.request_id), (Some(x), Some(y)) if x != y) {
        codes.push("conflicting_request_anchor".into());
    }
    if a.source == b.source && matches!((&a.thread, &b.thread), (Some(x), Some(y)) if x != y) {
        codes.push("conflicting_source_scoped_thread".into());
    }
    if matches!((&a.host, &b.host), (Some(x), Some(y)) if x != y) {
        codes.push("conflicting_host".into());
    }
    if matches!((&a.service, &b.service), (Some(x), Some(y)) if x != y) {
        codes.push("conflicting_service".into());
    }
    codes
}

fn same_scoped_thread_host(a: &TypedExecutionSignals, b: &TypedExecutionSignals) -> bool {
    match (&a.thread, &b.thread) {
        (Some(x), Some(y)) if x == y => {}
        _ => return false,
    }
    // Host: if both present must match; if either missing, allow only when threads match.
    match (&a.host, &b.host) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    }
}

fn graphs_structurally_related(a: &ExceptionGraphSummary, b: &ExceptionGraphSummary) -> bool {
    if a.root_signature.is_empty() || b.root_signature.is_empty() {
        return false;
    }
    // Same normalized root signature (type + detail).
    if a.root_signature == b.root_signature {
        return true;
    }
    // Cause-chain suffix compatibility (one ordered type sequence ends with the other).
    if !a.exception_types.is_empty()
        && !b.exception_types.is_empty()
        && (is_type_suffix(&a.exception_types, &b.exception_types)
            || is_type_suffix(&b.exception_types, &a.exception_types))
    {
        return true;
    }
    // Shared root type alone is insufficient without detail or suffix (P1).
    // Package-prefix / single common word alone is Candidate at most — not structural.
    false
}

fn is_type_suffix(longer: &[String], shorter: &[String]) -> bool {
    if shorter.len() > longer.len() {
        return false;
    }
    longer[longer.len() - shorter.len()..] == shorter[..]
}

fn wall_span_ok(a: &TypedExecutionSignals, b: &TypedExecutionSignals, max_secs: i64) -> bool {
    if !(a.wall_time && b.wall_time) {
        return false;
    }
    interval_gap(a.first_ts, a.last_ts, b.first_ts, b.last_ts) <= max_secs as u64
}

fn chain_wall_span_ok(members: &[&RenderEpisode], candidate: &RenderEpisode) -> bool {
    if members.is_empty() {
        return true;
    }
    if !candidate.wall_time || members.iter().any(|m| !m.wall_time) {
        return false;
    }
    let mut lo = candidate.first_ts.min(candidate.last_ts);
    let mut hi = candidate.first_ts.max(candidate.last_ts);
    for m in members {
        lo = lo.min(m.first_ts.min(m.last_ts));
        hi = hi.max(m.first_ts.max(m.last_ts));
    }
    hi.abs_diff(lo) <= MAX_CHAIN_WALL_SECONDS as u64
}

/// Bounded global preflight for an exact request/trace component.
///
/// The old local loop accepted every exact-anchor neighbour and selected the
/// earliest one.  That is deterministic but not a proof that there is only one
/// execution partition.  A real propagation chain may visit a site once; a
/// reused identifier creates two candidates for at least one site.  Inspect the
/// whole component before any local growth and withhold the merge in that case.
///
/// This deliberately remains conservative: an unparseable site is made unique
/// per rendering by `derive_exception_graph`, so it cannot manufacture a
/// repeated-site proof.  Such input may remain a one-member chain, but cannot
/// gain a semantic count without a unique stderr match and full conservation.
fn exact_anchor_component_is_unique(
    seed: usize,
    app_idxs: &[usize],
    renderings: &[RenderEpisode],
    graphs: &[ExceptionGraphSummary],
    signals: &[TypedExecutionSignals],
) -> bool {
    let mut members = Vec::new();
    for &candidate in app_idxs {
        if execution_signals_conflict(&signals[seed], &signals[candidate])
            || !matching_global_anchor(&signals[seed], &signals[candidate])
            || !graphs_structurally_related(&graphs[seed], &graphs[candidate])
        {
            continue;
        }
        // Wall-clock exact-anchor chains still have a bounded execution window.
        // Order-only inputs are allowed here only because their exact anchor is
        // subsequently required again for chain↔stderr matching.
        if renderings[seed].wall_time
            && renderings[candidate].wall_time
            && !wall_span_ok(&signals[seed], &signals[candidate], MAX_CHAIN_WALL_SECONDS)
        {
            continue;
        }
        members.push(candidate);
    }
    let mut sites = HashSet::new();
    members
        .into_iter()
        .all(|idx| sites.insert(graphs[idx].propagation_site.clone()))
}

/// One-to-one / multi-app propagation correlation (v2).
///
/// Builds application propagation chains under fail-closed execution boundaries,
/// then matches each chain uniquely to at most one stderr rendering. Ambiguity
/// remains unresolved (never arbitrary choice).
fn correlate_renderings_cancellable(
    renderings: Vec<RenderEpisode>,
    is_cancelled: &dyn Fn() -> bool,
) -> CoreResult<(Vec<(String, ExceptionOccurrenceSummary)>, MatchingMeta)> {
    let n = renderings.len();
    let graphs: Vec<ExceptionGraphSummary> = renderings
        .iter()
        .map(|r| {
            let mut g = derive_exception_graph(&r.structural_payload, &r.signature);
            if g.exception_types.is_empty() {
                let (ty, detail) = split_signature_type_detail(&r.signature);
                if !ty.is_empty() {
                    g.exception_types.push(ty);
                }
                g.root_detail = detail;
                g.root_signature = r.signature.clone();
            }
            if g.propagation_site.starts_with("sig:") || g.propagation_site == "unknown_site" {
                // Distinct site per rendering identity when frames unavailable.
                g.propagation_site =
                    format!("render:{}:{}:{}", r.source, r.first_seq(), r.kind as u8);
            }
            g
        })
        .collect();
    let signals: Vec<TypedExecutionSignals> =
        renderings.iter().map(signals_from_rendering).collect();

    let mut app_idxs: Vec<usize> = Vec::new();
    let mut wrap_idxs: Vec<usize> = Vec::new();
    for (i, r) in renderings.iter().enumerate() {
        match r.kind {
            ExceptionRenderingKind::ApplicationFullStack => app_idxs.push(i),
            ExceptionRenderingKind::SeparatelyWrappedRecords => wrap_idxs.push(i),
        }
    }
    app_idxs.sort_by(|&a, &b| {
        renderings[a]
            .first_ts
            .cmp(&renderings[b].first_ts)
            .then_with(|| renderings[a].first_seq().cmp(&renderings[b].first_seq()))
            .then_with(|| renderings[a].source.cmp(&renderings[b].source))
            .then_with(|| a.cmp(&b))
    });
    wrap_idxs.sort_by(|&a, &b| {
        renderings[a]
            .first_ts
            .cmp(&renderings[b].first_ts)
            .then_with(|| renderings[a].first_seq().cmp(&renderings[b].first_seq()))
            .then_with(|| renderings[a].source.cmp(&renderings[b].source))
            .then_with(|| a.cmp(&b))
    });

    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }

    // --- Build app propagation chains (no unrestricted union-find) ---
    let mut assigned_app = vec![false; n];
    let mut chains: Vec<Vec<usize>> = Vec::new();
    let mut ambiguous_components = 0u64;

    for &seed in &app_idxs {
        if assigned_app[seed] {
            continue;
        }
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let mut chain = vec![seed];
        assigned_app[seed] = true;
        let mut chain_sites = vec![graphs[seed].propagation_site.clone()];
        let mut chain_trace = signals[seed].trace_id.clone();
        // A named request/trace is evidence, not a licence to choose an
        // arbitrary partition.  Before an exact-anchor component may grow,
        // prove that every member has a distinct propagation site.  Repeated
        // sites under one anchor are the observable shape of a reused id (two
        // executions on the same worker path); leave that whole component
        // unresolved instead of letting input order select one chain.
        let exact_component_unique =
            exact_anchor_component_is_unique(seed, &app_idxs, &renderings, &graphs, &signals);
        if !exact_component_unique {
            ambiguous_components = ambiguous_components.saturating_add(1);
        }
        loop {
            let mut candidates: Vec<(usize, LinkConfidence)> = Vec::new();
            for &other in &app_idxs {
                if assigned_app[other] {
                    continue;
                }
                if execution_signals_conflict(&signals[seed], &signals[other]) {
                    // Also check against every chain member.
                }
                if chain
                    .iter()
                    .any(|&m| execution_signals_conflict(&signals[m], &signals[other]))
                {
                    continue;
                }
                // Unkeyed must not bridge two conflicting keyed groups: if chain
                // has a trace and other has a different trace, already refused.
                // If other is unkeyed and chain has trace, allow only with
                // multi-signal structural + unique reciprocal (not as bridge to
                // another keyed node — enforced by never adding a second key).
                if let Some(ct) = &chain_trace {
                    if let Some(ot) = &signals[other].trace_id {
                        if ct != ot {
                            continue;
                        }
                    }
                }
                // Structural relation with at least one chain member.
                let structural = chain
                    .iter()
                    .any(|&m| graphs_structurally_related(&graphs[m], &graphs[other]));
                if !structural {
                    continue;
                }
                // Distinct propagation site (repeated site closes chain).
                if chain_sites.contains(&graphs[other].propagation_site) {
                    continue;
                }
                // Wall span bound for wall-clock members.
                let member_refs: Vec<&RenderEpisode> =
                    chain.iter().map(|&i| &renderings[i]).collect();
                let all_wall =
                    member_refs.iter().all(|m| m.wall_time) && renderings[other].wall_time;
                let any_order_only =
                    member_refs.iter().any(|m| !m.wall_time) || !renderings[other].wall_time;

                let matching_thread = chain.iter().any(|&m| {
                    matches!(
                        (&signals[m].thread, &signals[other].thread),
                        (Some(a), Some(b)) if a == b
                    )
                });
                // Exact unique execution anchors for app-app: trace / request /
                // correlation only. Thread alone is never ExactExecutionAnchor
                // and never authorizes OrderOnly app-app grouping.
                let exact_anchor = chain
                    .iter()
                    .any(|&m| matching_global_anchor(&signals[m], &signals[other]));
                if exact_anchor && !exact_component_unique {
                    // Global component inspection found an alternative
                    // execution partition for this identifier.  Do not let a
                    // local earliest-record choice collapse it.
                    continue;
                }
                if any_order_only && !exact_anchor {
                    // OrderOnly: thread / wall multi-signal fallback forbidden.
                    continue;
                }
                if all_wall && !chain_wall_span_ok(&member_refs, &renderings[other]) {
                    continue;
                }

                let conf = if exact_anchor {
                    LinkConfidence::ExactExecutionAnchor
                } else if all_wall
                    && chain
                        .iter()
                        .any(|&m| same_scoped_thread_host(&signals[m], &signals[other]))
                {
                    // Wall multi-signal fallback (host+thread+structural); never OrderOnly.
                    LinkConfidence::StrongMultiSignal
                } else if all_wall && matching_thread {
                    // Same thread without host still needs structural (already gated)
                    // and unique reciprocal — not ExactExecutionAnchor.
                    LinkConfidence::StrongMultiSignal
                } else {
                    continue;
                };

                // Candidate-only links (not exact/strong) never collapse.
                if matches!(conf, LinkConfidence::Candidate) {
                    continue;
                }
                candidates.push((other, conf));
            }
            if candidates.is_empty() {
                break;
            }
            // Unique reciprocal: among candidates, prefer those for which this
            // chain is the unique eligible partner in the local window.
            let mut forced: Vec<(usize, LinkConfidence)> = Vec::new();
            for &(cand, conf) in &candidates {
                // Exact anchors are eligible only after the bounded global
                // component check above proved a unique site partition.
                // Thread-only / multi-signal wall fallback still requires a
                // reciprocal candidate.
                if matches!(conf, LinkConfidence::ExactExecutionAnchor) {
                    forced.push((cand, conf));
                    continue;
                }
                let rivals = count_rival_chains_for_app(
                    cand,
                    &chain,
                    &chains,
                    &app_idxs,
                    &assigned_app,
                    &renderings,
                    &graphs,
                    &signals,
                );
                if rivals == 0 {
                    forced.push((cand, conf));
                }
            }
            if forced.is_empty() {
                if candidates.len() > 1 {
                    ambiguous_components += 1;
                }
                break;
            }
            // Deterministic: take earliest by ts/seq among forced.
            forced.sort_by(|a, b| {
                renderings[a.0]
                    .first_ts
                    .cmp(&renderings[b.0].first_ts)
                    .then_with(|| {
                        renderings[a.0]
                            .first_seq()
                            .cmp(&renderings[b.0].first_seq())
                    })
                    .then_with(|| a.0.cmp(&b.0))
            });
            let (pick, _) = forced[0];
            // If pick introduces a new trace into an unkeyed chain, set it; if
            // chain already keyed and pick unkeyed, ok; never second key.
            if chain_trace.is_none() {
                chain_trace = signals[pick].trace_id.clone();
            }
            chain.push(pick);
            chain_sites.push(graphs[pick].propagation_site.clone());
            assigned_app[pick] = true;
        }
        chains.push(chain);
    }

    if is_cancelled() {
        return Err(CoreError::Cancelled);
    }

    // --- Match chains to stderr (unique 1:1) ---
    let mut paired = vec![false; n];
    let mut occurrences: Vec<(String, ExceptionOccurrenceSummary)> = Vec::new();
    let mut used_wrap = vec![false; n];
    let mut strong_derived = 0u64;
    let mut matching_ambiguous = ambiguous_components > 0;

    // Precompute wrap eligibility per chain.
    let mut chain_wrap_edges: Vec<Vec<(usize, ExceptionCorrelationConfidence)>> =
        vec![Vec::new(); chains.len()];
    for (ci, chain) in chains.iter().enumerate() {
        for &wi in &wrap_idxs {
            if let Some(conf) = chain_stderr_evidence(chain, wi, &renderings, &graphs, &signals) {
                chain_wrap_edges[ci].push((wi, conf));
            }
        }
        chain_wrap_edges[ci].sort_by(|a, b| {
            let rank = |c: ExceptionCorrelationConfidence| match c {
                ExceptionCorrelationConfidence::Strong => 0u8,
                ExceptionCorrelationConfidence::Moderate => 1u8,
                ExceptionCorrelationConfidence::Uncorrelated => 2u8,
            };
            rank(a.1)
                .cmp(&rank(b.1))
                .then_with(|| {
                    renderings[a.0]
                        .first_seq()
                        .cmp(&renderings[b.0].first_seq())
                })
                .then_with(|| a.0.cmp(&b.0))
        });
    }

    // Ambiguity: chain with ≥2 wrap partners or wrap with ≥2 chain partners.
    let mut wrap_deg: BTreeMap<usize, u64> = BTreeMap::new();
    for edges in &chain_wrap_edges {
        if edges.len() >= 2 {
            matching_ambiguous = true;
            ambiguous_components += 1;
        }
        for &(wi, _) in edges {
            *wrap_deg.entry(wi).or_default() += 1;
        }
    }
    for deg in wrap_deg.values() {
        if *deg >= 2 {
            matching_ambiguous = true;
            ambiguous_components += 1;
            break;
        }
    }

    // Forced unique edges only (degree 1 on both sides among remaining).
    let mut chain_matched = vec![false; chains.len()];
    // Iterate chains in stable order.
    let mut chain_order: Vec<usize> = (0..chains.len()).collect();
    chain_order.sort_by(|&a, &b| {
        let sa = chains[a]
            .iter()
            .map(|&i| renderings[i].first_seq())
            .min()
            .unwrap_or(0);
        let sb = chains[b]
            .iter()
            .map(|&i| renderings[i].first_seq())
            .min()
            .unwrap_or(0);
        sa.cmp(&sb).then_with(|| a.cmp(&b))
    });

    for &ci in &chain_order {
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        // Eligible unused wraps with unique reverse degree among unmatched chains.
        let mut unique_partners: Vec<(usize, ExceptionCorrelationConfidence)> = Vec::new();
        for &(wi, conf) in &chain_wrap_edges[ci] {
            if used_wrap[wi] {
                continue;
            }
            // Count other unmatched chains that also list this wrap.
            let mut reverse = 0u32;
            for &cj in &chain_order {
                if cj == ci || chain_matched[cj] {
                    continue;
                }
                if chain_wrap_edges[cj].iter().any(|(w, _)| *w == wi) {
                    reverse += 1;
                }
            }
            if reverse == 0 {
                unique_partners.push((wi, conf));
            }
        }
        if unique_partners.len() == 1 {
            let (wi, conf) = unique_partners[0];
            // Also ensure this chain has only this unique partner among unused.
            let other_unique = chain_wrap_edges[ci]
                .iter()
                .filter(|(w, _)| !used_wrap[*w] && *w != wi)
                .filter(|(w, _)| {
                    let mut reverse = 0u32;
                    for &cj in &chain_order {
                        if cj == ci || chain_matched[cj] {
                            continue;
                        }
                        if chain_wrap_edges[cj].iter().any(|(ww, _)| ww == w) {
                            reverse += 1;
                        }
                    }
                    reverse == 0
                })
                .count();
            if other_unique > 0 {
                matching_ambiguous = true;
                ambiguous_components += 1;
                continue;
            }
            // P0-3: form multi-rendering episodes for Strong or Moderate unique matches,
            // but only Strong increments the strong derived count / certifies.
            if conf == ExceptionCorrelationConfidence::Uncorrelated {
                continue;
            }
            used_wrap[wi] = true;
            chain_matched[ci] = true;
            let mut group: Vec<RenderEpisode> = chains[ci]
                .iter()
                .map(|&i| {
                    paired[i] = true;
                    renderings[i].clone()
                })
                .collect();
            paired[wi] = true;
            group.push(renderings[wi].clone());
            let signature = episode_signature_for_group(&group, &graphs, &chains[ci], wi);
            occurrences.push((signature, occurrence_from_renderings(group, conf)));
            if conf == ExceptionCorrelationConfidence::Strong {
                strong_derived += 1;
            }
        } else if unique_partners.len() > 1 {
            matching_ambiguous = true;
            ambiguous_components += 1;
        }
    }

    // Unmatched chains of multiple apps still form multi-app episodes without stderr
    // only when chain length > 1 with strong internal evidence — but without stderr
    // they are not "duplicate_rendering" dual; count as multi-rendering occurrences
    // with Moderate confidence. For semantic certification of the real-format oracle,
    // stderr match is required; leave multi-app-only as unpaired members if no stderr.
    // Prefer: emit chain as one occurrence when len>1 even without stderr (still multi).
    for (ci, chain) in chains.iter().enumerate() {
        if chain_matched[ci] {
            continue;
        }
        if chain.len() > 1 {
            let mut group: Vec<RenderEpisode> = Vec::new();
            for &i in chain {
                paired[i] = true;
                group.push(renderings[i].clone());
            }
            let signature = group
                .last()
                .map(|r| r.signature.clone())
                .unwrap_or_default();
            // Multi-app without unique stderr: unresolved semantic certification.
            occurrences.push((
                signature,
                occurrence_from_renderings(group, ExceptionCorrelationConfidence::Moderate),
            ));
            // Not strong_derived for certification (no SupportsSameExecution stderr).
        }
    }

    // Classic 1:1 dual for remaining unpaired single apps ↔ wraps (backward compat).
    let mut rem_apps: Vec<usize> = app_idxs.iter().copied().filter(|&i| !paired[i]).collect();
    let mut rem_wraps: Vec<usize> = wrap_idxs.iter().copied().filter(|&i| !paired[i]).collect();
    rem_apps.sort();
    rem_wraps.sort();
    let (dual_pairs, dual_ambig) =
        bipartite_unique_duals(&rem_apps, &rem_wraps, &renderings, &|| is_cancelled())?;
    if dual_ambig {
        matching_ambiguous = true;
        ambiguous_components += 1;
    }
    for (ai, wi, conf) in dual_pairs {
        if conf == ExceptionCorrelationConfidence::Uncorrelated {
            continue;
        }
        paired[ai] = true;
        paired[wi] = true;
        let group = vec![renderings[ai].clone(), renderings[wi].clone()];
        let signature = renderings[ai].signature.clone();
        occurrences.push((signature, occurrence_from_renderings(group, conf)));
        // P0-3: only Strong confidence increments strong_derived / can certify.
        if conf == ExceptionCorrelationConfidence::Strong {
            strong_derived += 1;
        }
    }

    // Standalone unpaired renderings.
    let mut standalone = 0u64;
    let mut unpaired = 0u64;
    for (idx, rendering) in renderings.iter().enumerate() {
        if paired[idx] {
            continue;
        }
        unpaired += 1;
        standalone += 1;
        let signature = rendering.signature.clone();
        occurrences.push((
            signature,
            occurrence_from_renderings(
                vec![rendering.clone()],
                ExceptionCorrelationConfidence::Uncorrelated,
            ),
        ));
    }

    annotate_unresolved_occurrences(&mut occurrences, &renderings, &graphs, &signals);

    occurrences.sort_by(|a, b| {
        a.1.first_seq
            .cmp(&b.1.first_seq)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.last_seq.cmp(&b.1.last_seq))
    });

    let has_moderate = occurrences.iter().any(|(_, o)| {
        o.duplicate_rendering
            && o.correlation_confidence == ExceptionCorrelationConfidence::Moderate
    });
    // Complete only when no ambiguity, no unpaired renderings, no Moderate multi-claims.
    let correlation_complete = !matching_ambiguous && unpaired == 0 && !has_moderate;
    Ok((
        occurrences,
        MatchingMeta {
            unpaired_renderings: unpaired,
            ambiguous: matching_ambiguous,
            ambiguous_components,
            application_propagation_chains: chains.len() as u64,
            strong_derived_episodes: strong_derived,
            standalone_renderings: standalone,
            correlation_complete,
            inventory_mode: StructuralInventoryMode::Unavailable,
            independent_expected: HashSet::new(),
            message_candidate_ids: HashSet::new(),
            unknown_suspicious_identity_count: 0,
            inventory_capped: false,
            eligible_structural_identity_count: 0,
            independently_expected_structural_identity_count: 0,
            message_candidate_identity_count: 0,
            rendering_identity_count: 0,
            covered_structural_identity_count: 0,
            missing_structural_identity_count: 0,
            candidate_predicate_miss_count: 0,
            rendering_miss_count: 0,
            duplicate_structural_identity_count: 0,
            unexpected_structural_identity_count: 0,
            structural_coverage_complete: false,
            expected_application_stack_count: 0,
            covered_application_stack_count: 0,
            expected_header_cause_count: 0,
            covered_header_cause_count: 0,
            expected_frame_scaffold_count: 0,
            covered_frame_scaffold_count: 0,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn count_rival_chains_for_app(
    cand: usize,
    current_chain: &[usize],
    existing_chains: &[Vec<usize>],
    app_idxs: &[usize],
    assigned_app: &[bool],
    renderings: &[RenderEpisode],
    graphs: &[ExceptionGraphSummary],
    signals: &[TypedExecutionSignals],
) -> u32 {
    // Count other seeds that could form a competing chain claiming cand.
    // Simplified: count other unassigned apps that share exact anchor or same
    // thread with cand and are structurally related, outside current chain.
    let mut rivals = 0u32;
    for &other in app_idxs {
        if other == cand || assigned_app[other] || current_chain.contains(&other) {
            continue;
        }
        if execution_signals_conflict(&signals[cand], &signals[other]) {
            continue;
        }
        if !graphs_structurally_related(&graphs[cand], &graphs[other]) {
            continue;
        }
        let linked = matching_global_anchor(&signals[cand], &signals[other])
            || (renderings[cand].wall_time
                && renderings[other].wall_time
                && same_scoped_thread_host(&signals[cand], &signals[other])
                && wall_span_ok(&signals[cand], &signals[other], MAX_CHAIN_WALL_SECONDS));
        if linked {
            rivals += 1;
        }
    }
    let _ = existing_chains;
    rivals
}

fn chain_stderr_evidence(
    chain: &[usize],
    wrap_idx: usize,
    renderings: &[RenderEpisode],
    graphs: &[ExceptionGraphSummary],
    signals: &[TypedExecutionSignals],
) -> Option<ExceptionCorrelationConfidence> {
    let wrap = &renderings[wrap_idx];
    let wrap_sig = &signals[wrap_idx];
    let wrap_graph = &graphs[wrap_idx];
    if wrap.signature.is_empty() {
        return None;
    }
    // Global signal conflicts with any chain member refuse.
    for &mi in chain {
        if execution_signals_conflict(&signals[mi], wrap_sig) {
            return None;
        }
    }
    // Signature/graph compatibility with any member.
    // Prefer exact signature / root match; structural package-prefix alone is
    // insufficient when every chain would match every stderr.
    let exact_sig = chain.iter().any(|&mi| {
        renderings[mi].signature == wrap.signature
            || graphs[mi].root_signature == wrap_graph.root_signature
            || graphs[mi].root_signature == wrap.signature
            || renderings[mi].signature == wrap_graph.root_signature
    });
    let structural = chain
        .iter()
        .any(|&mi| graphs_structurally_related(&graphs[mi], wrap_graph));
    let matching_request = chain.iter().any(|&mi| {
        matches!(
            (&signals[mi].request_id, &wrap_sig.request_id),
            (Some(a), Some(b)) if a == b
        )
    });
    let exact_anchor = chain
        .iter()
        .any(|&mi| matching_global_anchor(&signals[mi], wrap_sig))
        || matching_request;
    if !(exact_sig || matching_request || (structural && exact_anchor)) {
        return None;
    }
    // Package-prefix structural alone is not enough without a request/trace anchor.
    if !exact_sig && !exact_anchor {
        return None;
    }
    // Unequal explicit threads across sources refuse unless a stronger global
    // anchor (trace/request) matches — prevents worker-A app dual-pairing to
    // worker-B stderr on signature alone.
    let conflicting_threads = chain.iter().any(|&mi| {
        matches!(
            (&signals[mi].thread, &wrap_sig.thread),
            (Some(a), Some(b)) if a != b
        )
    });
    if conflicting_threads && !exact_anchor {
        return None;
    }

    let chain_wall = chain.iter().all(|&i| renderings[i].wall_time) && wrap.wall_time;
    let chain_order_only = chain.iter().any(|&i| !renderings[i].wall_time) || !wrap.wall_time;
    // Cross-source thread equality is optional (different pools); matching thread
    // strengthens. Asymmetric source-scoped threads do not conflict (handled above).
    let matching_thread = chain.iter().any(|&mi| {
        matches!(
            (&signals[mi].thread, &wrap_sig.thread),
            (Some(a), Some(b)) if a == b
        )
    });

    if chain_order_only {
        // Order-only chain↔stderr: Strong only with shared request/trace/correlation
        // anchor on both sides. Thread alone is never ExactExecutionAnchor (P0-3).
        if exact_anchor {
            return Some(ExceptionCorrelationConfidence::Strong);
        }
        return None;
    }

    // Wall path: require close wall between wrap and chain span.
    let mut lo = wrap.first_ts.min(wrap.last_ts);
    let mut hi = wrap.first_ts.max(wrap.last_ts);
    for &mi in chain {
        lo = lo.min(renderings[mi].first_ts.min(renderings[mi].last_ts));
        hi = hi.max(renderings[mi].first_ts.max(renderings[mi].last_ts));
    }
    // Gap from wrap interval to chain interval.
    let chain_lo = chain
        .iter()
        .map(|&i| renderings[i].first_ts.min(renderings[i].last_ts))
        .min()
        .unwrap_or(lo);
    let chain_hi = chain
        .iter()
        .map(|&i| renderings[i].first_ts.max(renderings[i].last_ts))
        .max()
        .unwrap_or(hi);
    let gap = interval_gap(chain_lo, chain_hi, wrap.first_ts, wrap.last_ts);
    if gap > MAX_CHAIN_STDERR_WALL_SECONDS as u64 {
        return None;
    }
    // Exact request/trace/correlation anchor → Strong.
    if exact_anchor {
        return Some(ExceptionCorrelationConfidence::Strong);
    }
    // Same explicit thread on both sides + exact signature + wall: Strong under
    // reciprocal uniqueness (handled by caller). App thread alone must never
    // authorize unkeyed or differently keyed stderr (P0-3).
    if matching_thread && exact_sig {
        return Some(ExceptionCorrelationConfidence::Strong);
    }
    // Asymmetric or conflicting threads without global anchor: refuse.
    let chain_has_thread = chain.iter().any(|&i| signals[i].thread.is_some());
    if chain_has_thread || wrap_sig.thread.is_some() {
        return None;
    }
    // Both unkeyed + wall-close + graph: Moderate (non-certifying).
    if chain_wall {
        return Some(ExceptionCorrelationConfidence::Moderate);
    }
    None
}

fn episode_signature_for_group(
    group: &[RenderEpisode],
    graphs: &[ExceptionGraphSummary],
    chain: &[usize],
    wrap_idx: usize,
) -> String {
    // Prefer stderr root signature when present; else last chain member.
    if !group.is_empty() {
        if let Some(w) = group
            .iter()
            .find(|r| r.kind == ExceptionRenderingKind::SeparatelyWrappedRecords)
        {
            if !w.signature.is_empty() {
                return w.signature.clone();
            }
        }
    }
    if let Some(&last) = chain.last() {
        if !graphs[last].root_signature.is_empty() {
            return graphs[last].root_signature.clone();
        }
        return renderings_sig_fallback(group);
    }
    let _ = wrap_idx;
    renderings_sig_fallback(group)
}

fn renderings_sig_fallback(group: &[RenderEpisode]) -> String {
    group
        .last()
        .map(|r| r.signature.clone())
        .unwrap_or_default()
}

/// Classic bipartite dual matching for leftover single apps (max-cardinality Kuhn).
type DualMatchPairs = Vec<(usize, usize, ExceptionCorrelationConfidence)>;
fn bipartite_unique_duals(
    apps: &[usize],
    wraps: &[usize],
    renderings: &[RenderEpisode],
    is_cancelled: &dyn Fn() -> bool,
) -> CoreResult<(DualMatchPairs, bool)> {
    let n_l = apps.len();
    let n_r = wraps.len();
    if n_l == 0 || n_r == 0 {
        return Ok((Vec::new(), false));
    }
    let mut adj: Vec<Vec<(usize, u8, u64, ExceptionCorrelationConfidence)>> = vec![Vec::new(); n_l];
    for (li, &app_idx) in apps.iter().enumerate() {
        if is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        for (ri, &wrap_idx) in wraps.iter().enumerate() {
            let Some(confidence) = duplicate_evidence(&renderings[app_idx], &renderings[wrap_idx])
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
    let ambiguous = bipartite_degrees_allow_alternate_max_matchings(&adj, n_r);
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
    let mut pairs = Vec::new();
    for (ri, li_opt) in mt_r.iter().enumerate() {
        let Some(li) = *li_opt else {
            continue;
        };
        let conf = adj[li]
            .iter()
            .find(|(r, _, _, _)| *r == ri)
            .map(|(_, _, _, c)| *c)
            .unwrap_or(ExceptionCorrelationConfidence::Moderate);
        pairs.push((apps[li], wraps[ri], conf));
    }
    Ok((pairs, ambiguous))
}

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
    let mut omitted = 0u64;
    for rendering in &renderings {
        complete &= rendering.complete;
        if !rendering.complete {
            omitted = omitted.saturating_add(1);
        }
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
    // Deterministic episode id from ordered citation identities.
    let episode_id = {
        let mut parts: Vec<String> = citations
            .iter()
            .map(|c| format!("{}:{}", c.source, c.seq))
            .collect();
        parts.sort();
        let joined = parts.join("|");
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in joined.as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("ep-{hash:016x}")
    };
    let mut reason_codes = Vec::new();
    let mut relation_types = Vec::new();
    match confidence {
        ExceptionCorrelationConfidence::Strong => {
            reason_codes.push("strong_correlation".into());
            relation_types.push("SupportsSameExecution".into());
        }
        ExceptionCorrelationConfidence::Moderate => {
            reason_codes.push("moderate_correlation".into());
            relation_types.push("CandidateSupportsSameExecution".into());
        }
        ExceptionCorrelationConfidence::Uncorrelated => {
            reason_codes.push("uncorrelated_standalone".into());
        }
    }
    if renderings.len() > 1 {
        reason_codes.push("multi_rendering".into());
    }
    // Record the actual evidence path, rather than leaving consumers to infer
    // it from a blanket confidence label.  These are bounded enum-like strings
    // and do not expose request/trace values.
    let mut has_request = false;
    let mut has_trace = false;
    let mut has_thread_wall = false;
    for (left_i, left) in renderings.iter().enumerate() {
        let left_signals = signals_from_rendering(left);
        for right in renderings.iter().skip(left_i + 1) {
            let right_signals = signals_from_rendering(right);
            has_request |= matches!(
                (&left_signals.request_id, &right_signals.request_id),
                (Some(a), Some(b)) if a == b
            );
            has_trace |= matches!(
                (&left_signals.trace_id, &right_signals.trace_id),
                (Some(a), Some(b)) if a == b
            );
            has_thread_wall |= left.wall_time
                && right.wall_time
                && matches!(
                    (&left_signals.thread, &right_signals.thread),
                    (Some(a), Some(b)) if a == b
                );
        }
    }
    if has_request {
        reason_codes.push("shared_request_anchor".into());
    }
    if has_trace {
        reason_codes.push("shared_trace_anchor".into());
    }
    if has_thread_wall {
        reason_codes.push("shared_thread_wall_window".into());
    }
    if confidence == ExceptionCorrelationConfidence::Moderate {
        reason_codes.push("unkeyed_wall_window".into());
    }
    ExceptionOccurrenceSummary {
        episode_id,
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
        reason_codes,
        conflict_codes: Vec::new(),
        relation_types,
        rendering_kinds: kinds,
        citations,
        citations_complete: complete,
        omitted_citation_count: omitted,
        ambiguity_count: 0,
    }
}

/// Attach observable refusal/ambiguity details to standalone occurrences.
///
/// A conflict must not disappear merely because the fail-closed matcher kept
/// the rendering standalone.  Likewise, a rendering left out of a component
/// with more than one viable neighbour needs an occurrence-local ambiguity
/// count, not only a report-wide boolean.
fn annotate_unresolved_occurrences(
    occurrences: &mut [(String, ExceptionOccurrenceSummary)],
    renderings: &[RenderEpisode],
    graphs: &[ExceptionGraphSummary],
    signals: &[TypedExecutionSignals],
) {
    for (_, occurrence) in occurrences {
        if occurrence.rendering_count != 1 {
            continue;
        }
        let Some(first) = occurrence.citations.first() else {
            continue;
        };
        let Some(index) = renderings.iter().position(|rendering| {
            rendering.citations.first().is_some_and(|citation| {
                citation.seq == first.seq && citation.source == first.source
            })
        }) else {
            continue;
        };
        let mut conflicts = HashSet::new();
        let mut viable_neighbours = 0u64;
        for (other_index, other) in renderings.iter().enumerate() {
            if other_index == index || other.signature != renderings[index].signature {
                continue;
            }
            for code in execution_conflict_codes(&signals[index], &signals[other_index]) {
                conflicts.insert(code);
            }
            if !execution_signals_conflict(&signals[index], &signals[other_index])
                && graphs_structurally_related(&graphs[index], &graphs[other_index])
                && (matching_global_anchor(&signals[index], &signals[other_index])
                    || duplicate_evidence(&renderings[index], other).is_some())
            {
                viable_neighbours = viable_neighbours.saturating_add(1);
            }
        }
        let mut ordered_conflicts: Vec<String> = conflicts.into_iter().collect();
        ordered_conflicts.sort();
        if !ordered_conflicts.is_empty() {
            occurrence
                .reason_codes
                .push("correlation_refused_on_conflict".into());
            occurrence.conflict_codes = ordered_conflicts;
        }
        if viable_neighbours > 1 {
            occurrence
                .reason_codes
                .push("ambiguous_candidate_component".into());
            occurrence.ambiguity_count = viable_neighbours;
        }
    }
}

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
    if left.signature != right.signature {
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

    // Global anchors (request/trace) take precedence over thread keys.
    let matching_request = matches!(
        (&left.request_id, &right.request_id),
        (Some(a), Some(b)) if a == b
    );
    let conflicting_request = matches!(
        (&left.request_id, &right.request_id),
        (Some(a), Some(b)) if a != b
    );
    let matching_trace = matches!(
        (&left.trace_id, &right.trace_id),
        (Some(a), Some(b)) if a == b
    );
    let conflicting_trace = matches!(
        (&left.trace_id, &right.trace_id),
        (Some(a), Some(b)) if a != b
    );
    if conflicting_request || conflicting_trace {
        return None;
    }
    // Legacy strong_execution_key must not let thread hide req/trace conflicts.
    if left.strong_key_conflicts_with(right) {
        return None;
    }
    let exact_global_anchor = matching_request || matching_trace;
    let matching_thread = matches!(
        (&left.thread, &right.thread),
        (Some(a), Some(b)) if a == b
    );
    let conflicting_thread = matches!(
        (&left.thread, &right.thread),
        (Some(a), Some(b)) if a != b
    );
    // Same-source unequal threads always conflict; cross-source only without global anchor.
    if conflicting_thread && (left.source == right.source || !exact_global_anchor) {
        return None;
    }

    let both_wall = left.wall_time && right.wall_time;
    let wall_gap = interval_gap(left.first_ts, left.last_ts, right.first_ts, right.last_ts);
    let close_wall = both_wall && wall_gap <= MAX_DUPLICATE_WALL_SECONDS as u64;

    // Order-only: require exact global request/trace anchor (never thread alone).
    if !both_wall {
        if exact_global_anchor {
            return Some(ExceptionCorrelationConfidence::Strong);
        }
        return None;
    }

    // Wall-clock path: kinds differ + close wall already established.
    if !close_wall {
        return None;
    }
    if exact_global_anchor {
        return Some(ExceptionCorrelationConfidence::Strong);
    }
    // Matching thread on both sides + wall: Strong (reciprocal uniqueness by caller).
    if matching_thread {
        return Some(ExceptionCorrelationConfidence::Strong);
    }
    // Moderate: wall-close dual kinds, neither side carries a global/thread key.
    let left_keyed = left.request_id.is_some() || left.trace_id.is_some() || left.thread.is_some();
    let right_keyed =
        right.request_id.is_some() || right.trace_id.is_some() || right.thread.is_some();
    if !left_keyed && !right_keyed {
        return Some(ExceptionCorrelationConfidence::Moderate);
    }
    // Asymmetric or non-matching keys never authorize a dual claim (P0-3).
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
        return parse_non_stderr_envelope(message, explicit_thread);
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

/// Non-stderr WildFly-style envelope: optional LEVEL, optional `[logger]`,
/// optional `(thread)`, then structural payload.
///
/// Logger bracket text is never treated as a thread identity.
fn parse_non_stderr_envelope(message: &str, explicit_thread: Option<String>) -> ExceptionEnvelope {
    let (first_line, remaining_lines) = split_first_line(message);
    let mut rest = first_line.trim_start();
    // Optional level token.
    for level in [
        "ERROR ", "error ", "WARN ", "warn ", "INFO ", "info ", "DEBUG ", "debug ", "FATAL ",
        "fatal ", "TRACE ", "trace ",
    ] {
        if let Some(after) = rest.strip_prefix(level) {
            rest = after.trim_start();
            break;
        }
    }
    // Optional [logger] — capture but never promote to thread.
    let mut _logger: Option<String> = None;
    if rest.starts_with('[') {
        if let Some(close) = rest.find(']') {
            let inner = rest.get(1..close).unwrap_or("");
            // Reject stream-ish tokens already handled elsewhere; keep generic logger.
            if inner != "stderr"
                && !inner.is_empty()
                && inner.chars().count() <= MAX_THREAD_TOKEN_CHARS
            {
                _logger = Some(inner.to_string());
            }
            rest = rest.get(close + 1..).unwrap_or("").trim_start();
        }
    }
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
    let execution_key_conflict =
        matches!((&explicit_thread, &parenthesized_thread), (Some(a), Some(b)) if a != b);
    ExceptionEnvelope {
        structural_payload: structural,
        stream: None,
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
    let mut chars = token.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    // Reject method-call / source-location shapes: must not look like `Foo.java:12`
    // as a sole paren group used for execution identity (still allow pool-N-thread-M
    // and WildFly `default task-1` with internal spaces).
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | ' '))
        && !token.chars().all(|c| c.is_whitespace())
}

fn is_valid_explicit_thread_token(token: &str) -> bool {
    // Explicit thread= values stay space-free (token boundary is whitespace).
    is_valid_thread_identity_token(token) && !token.chars().any(|c| c.is_whitespace())
}

/// Extract request/correlation/transaction/trace identifiers for execution anchors.
///
/// Only explicitly named keys. Bare `id=` is never an exact global execution anchor.
/// Values are corpus-local digests (`req:…`) — never injected into model prose.
fn extract_request_like_id(message: &str) -> Option<String> {
    // Exact global anchors only: explicitly named request/correlation/transaction/trace.
    // Bare `id=` is never promoted (object/error/status noise).
    for key in [
        "request_id=",
        "requestId=",
        "correlation_id=",
        "correlationId=",
        "transaction_id=",
        "transactionId=",
        "trace_id=",
        "traceId=",
    ] {
        if let Some(start) = message.find(key) {
            if start > MAX_ENVELOPE_PREFIX_BYTES.saturating_mul(4) {
                continue;
            }
            let value = message.get(start + key.len()..).unwrap_or_default();
            let value = value
                .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ']' | ';' | ')' | '"'))
                .next()
                .unwrap_or_default()
                .trim_matches(['"', '\'']);
            if value.is_empty() || value.chars().count() > MAX_THREAD_TOKEN_CHARS {
                continue;
            }
            if !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
            {
                continue;
            }
            return Some(format!("req:{value}"));
        }
    }
    None
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
            if !is_valid_explicit_thread_token(value) {
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
        || template_line_starts_with_structural_marker(line, "Caused by:")
        || template_line_starts_with_structural_marker(line, "Suppressed:")
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
        query_events, ActiveTimestampBasis, LogEvent, TemplateInfo, TemplateRow, TimeQuality,
        TimestampProvenance, MAX_EVENT_PAGE,
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
            "XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-{i}"
        ));
        for w in 0..72 {
            lines.push(format!(
                "Exception wrapper XYZ_WRAP#{w} for payment failure request_id=req-{i}"
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
                "{ts} ERROR XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-{i}\n"
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
        // OrderOnly + matching thread alone must NOT form a dual (P0-3).
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
        let thread_only = analyze_bounded_events(2, &[a.clone(), b.clone()]);
        assert_eq!(
            thread_only.duplicate_rendering_occurrence_count, 0,
            "OrderOnly thread alone is not ExactExecutionAnchor"
        );
        assert_eq!(thread_only.strong_derived_episode_count, 0);

        // OrderOnly + shared request_id does form Strong dual.
        let a_req = order_event(
            1,
            "app.log",
            "request_id=req-xyz xyz.TimeoutException: upstream XYZ\n at xyz.Net.call(Net.java:20)",
        );
        let b_req = order_event(
            2,
            "stderr.log",
            "request_id=req-xyz [stderr] xyz.TimeoutException: upstream XYZ",
        );
        let with_req = analyze_bounded_events(2, &[a_req, b_req]);
        assert_eq!(with_req.occurrence_count, 1);
        assert_eq!(with_req.duplicate_rendering_occurrence_count, 1);
        assert_eq!(with_req.strong_derived_episode_count, 1);

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
                &format!("request_id=r{i} java.lang.RuntimeException: XYZ_SHARED\n at com.xyz.A.m(A.java:1)"),
            ));
            events.push(event(
                i * 10 + 2,
                t,
                "stderr.log",
                &format!("[stderr] request_id=r{i} java.lang.RuntimeException: XYZ_SHARED"),
            ));
            events.push(event(
                i * 10 + 3,
                t,
                "stderr.log",
                &format!("[stderr] request_id=r{i} at com.xyz.A.m(A.java:1)"),
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
        let withheld = project_template_onto_episodes(&analysis, 7777);
        assert!(!withheld.complete, "{withheld:?}");
        assert_eq!(withheld.occurrence_count, None);
        let mut certified = analysis.clone();
        certified.semantic_counts_certified = true;
        let proj = project_template_onto_episodes(&certified, 7777);
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
        let withheld = project_template_onto_episodes(&analysis, 7777);
        assert!(!withheld.complete, "{withheld:?}");
        assert_eq!(withheld.occurrence_count, None);
        let mut certified = analysis.clone();
        certified.semantic_counts_certified = true;
        let proj = project_template_onto_episodes(&certified, 7777);
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
            &format!("[stderr] ({thread}) java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-0"),
        ));
        let mut seq = 2u64;
        for w in 0..72u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!(
                    "[stderr] ({thread}) Exception wrapper XYZ_WRAP#{w} for payment failure request_id=req-0"
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
                "thread={thread} java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-0\n at com.xyz.payment.Client.charge(Client.java:42)\n Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT\n at com.xyz.net.Http.execute(Http.java:15)"
            ),
        ));
        let mut seq = 2u64;
        events.push(event(
            seq,
            100,
            "XYZ_server.stderr",
            &format!("[stderr] ({thread}) java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-0"),
        ));
        seq += 1;
        for w in 0..72u32 {
            events.push(event(
                seq,
                100,
                "XYZ_server.stderr",
                &format!(
                    "[stderr] ({thread}) Exception wrapper XYZ_WRAP#{w} for payment failure request_id=req-0"
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

    // ─── P0 v2 propagation / honesty mutations ─────────────────────────────

    #[test]
    fn p0_generic_bracketed_logger_is_not_thread_identity() {
        let env = parse_exception_envelope(
            "ERROR [com.foo.Logger] java.lang.RuntimeException: XYZ_L\n at com.foo.A.m(A.java:1)",
        );
        assert!(env.effective_thread().is_none());
        assert!(!env.is_stderr_stream());
        let with_task = parse_exception_envelope(
            "ERROR [com.foo.Logger] (default task-9) java.lang.RuntimeException: XYZ_L\n at com.foo.A.m(A.java:1)",
        );
        assert_eq!(with_task.effective_thread(), Some("default task-9"));
    }

    #[test]
    fn p0_unkeyed_never_bridges_conflicting_trace_groups() {
        let events = [
            event(
                1,
                100,
                "app.log",
                "java.lang.RuntimeException: XYZ_BRIDGE\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                101,
                "app.log",
                "java.lang.RuntimeException: XYZ_BRIDGE\n at com.xyz.B.m(B.java:1)",
            ),
            event(
                3,
                102,
                "app.log",
                "java.lang.RuntimeException: XYZ_BRIDGE\n at com.xyz.C.m(C.java:1)",
            ),
        ];
        let mut e0 = events[0].clone();
        e0.trace_id = Some("trace-A".into());
        let mut e1 = events[1].clone();
        e1.trace_id = None; // unkeyed middle
        let mut e2 = events[2].clone();
        e2.trace_id = Some("trace-C".into());
        let analysis = analyze_bounded_events(3, &[e0, e1, e2]);
        // Must not form one transitive chain across conflicting traces.
        assert!(
            analysis.occurrence_count >= 2,
            "unkeyed must not bridge A and C (got {})",
            analysis.occurrence_count
        );
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
    }

    #[test]
    fn p0_conflicting_trace_same_thread_refuses_merge() {
        let mut a = event(
            1,
            100,
            "app.log",
            "thread=worker-1 java.lang.RuntimeException: XYZ_T\n at com.xyz.A.m(A.java:1)",
        );
        let mut b = event(
            2,
            101,
            "app.log",
            "thread=worker-1 java.lang.RuntimeException: XYZ_T\n at com.xyz.B.m(B.java:1)",
        );
        a.trace_id = Some("trace-A".into());
        b.trace_id = Some("trace-B".into());
        let analysis = analyze_bounded_events(2, &[a, b]);
        assert_eq!(
            analysis.occurrence_count, 2,
            "conflicting traces on same thread must stay separate"
        );
        assert!(
            analysis.conflicting_occurrence_count > 0
                && analysis
                    .families
                    .iter()
                    .flat_map(|family| &family.occurrences)
                    .any(|occurrence| occurrence
                        .conflict_codes
                        .iter()
                        .any(|code| code == "conflicting_trace_anchor")),
            "refused trace conflict must reach the public occurrence DTO"
        );
    }

    #[test]
    fn p0_reused_exact_anchor_duplicate_site_is_unresolved_and_annotated() {
        // Two otherwise-identical executions reused the same named id.  The
        // global component has duplicate propagation sites, so a local earliest
        // choice would be arbitrary and must not create a multi-app episode.
        let mut events = Vec::new();
        for execution in 0..2u64 {
            for (site, seq) in [("A", 1 + execution * 2), ("B", 2 + execution * 2)] {
                events.push(event(
                    seq,
                    100 + seq as i64,
                    "app.log",
                    &format!(
                        "request_id=reused-7 java.lang.RuntimeException: XYZ_REUSED\n at com.xyz.{site}.Handler.handle(H.java:1)"
                    ),
                ));
            }
        }
        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert!(analysis.matching_ambiguous);
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
        assert_eq!(analysis.occurrence_count, 4);
        assert!(
            analysis.ambiguous_occurrence_count > 0
                && analysis
                    .families
                    .iter()
                    .flat_map(|family| &family.occurrences)
                    .any(|occurrence| occurrence.ambiguity_count > 0
                        && occurrence
                            .reason_codes
                            .iter()
                            .any(|code| code == "ambiguous_candidate_component")),
            "reused-anchor ambiguity must be visible on affected DTO occurrences"
        );
    }

    #[test]
    fn p0_stray_app_only_named_id_never_certifies_a_semantic_episode() {
        // An id present only on application records cannot be mistaken for a
        // cross-rendering execution proof.  This covers request-id text copied
        // into an application error template.
        let events = [
            event(
                1,
                100,
                "app.log",
                "request_id=template-default java.lang.RuntimeException: XYZ_STRAY\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                101,
                "app.log",
                "request_id=template-default java.lang.RuntimeException: XYZ_STRAY\n at com.xyz.B.m(B.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(2, &events);
        assert!(!analysis.semantic_counts_certified);
        assert_eq!(analysis.strong_derived_episode_count, 0);
    }

    #[test]
    fn p0_stray_stderr_only_named_id_never_certifies_a_semantic_episode() {
        // Conversely, an identifier that occurs only in separately wrapped
        // stderr records must not create an application execution chain.
        let events = [
            event(
                1,
                100,
                "stderr-a.log",
                "[stderr] request_id=template-default java.lang.RuntimeException: XYZ_STRAY\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                101,
                "stderr-b.log",
                "[stderr] request_id=template-default java.lang.RuntimeException: XYZ_STRAY\n at com.xyz.B.m(B.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(2, &events);
        assert!(!analysis.semantic_counts_certified);
        assert_eq!(analysis.strong_derived_episode_count, 0);
        assert_eq!(analysis.application_propagation_chain_count, 0);
    }

    #[test]
    fn exception_episode_report_additive_fields_deserialize_when_absent() {
        let analysis = analyze_bounded_events(
            1,
            &[event(
                1,
                1,
                "app.log",
                "java.lang.RuntimeException: XYZ_COMPAT\n at com.xyz.A.m(A.java:1)",
            )],
        );
        let mut value = serde_json::to_value(&analysis).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("conflictingOccurrenceCount");
        object.remove("ambiguousOccurrenceCount");
        let decoded: ExceptionEpisodeAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.conflicting_occurrence_count, 0);
        assert_eq!(decoded.ambiguous_occurrence_count, 0);
    }

    #[test]
    fn p0_repeated_propagation_site_splits_execution_boundary() {
        // Same thread + same site twice → two executions (worker reuse).
        let events = vec![
            event(
                1,
                100,
                "app.log",
                "thread=worker-1 request_id=req-1 java.lang.RuntimeException: XYZ_R\n at com.xyz.site.Handler.handle(H.java:1)",
            ),
            event(
                2,
                110,
                "app.log",
                "thread=worker-1 request_id=req-2 java.lang.RuntimeException: XYZ_R\n at com.xyz.site.Handler.handle(H.java:1)",
            ),
        ];
        let analysis = analyze_bounded_events(2, &events);
        assert_eq!(
            analysis.occurrence_count, 2,
            "repeated propagation site must create two execution boundaries"
        );
    }

    #[test]
    fn p0_semantic_counts_certified_false_when_unpaired_remain() {
        // Single app without dual partner → uncertified semantic totals.
        let events = vec![event(
            1,
            100,
            "app.log",
            "java.lang.RuntimeException: XYZ_SOLO\n at com.xyz.A.m(A.java:1)",
        )];
        let analysis = analyze_bounded_events(1, &events);
        assert!(!analysis.semantic_counts_certified);
        assert_eq!(analysis.standalone_rendering_count, 1);
        assert!(analysis
            .ranking_disclosure
            .contains("independent_incident_claim_forbidden: true"));
        assert!(analysis
            .ranking_disclosure
            .contains("semantic_counts_certified: false"));
        let projection = project_template_onto_episodes(&analysis, 101);
        assert!(!projection.complete);
        assert_eq!(projection.occurrence_count, None);
        assert!(projection
            .incomplete_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("uncertified")));
    }

    #[test]
    fn strong_episode_ranking_beats_more_uncertified_standalone_groups() {
        fn app(seq: u64, ts: i64, family: &str, request: &str) -> ExplorerEvent {
            event(
                seq,
                ts,
                "application.log",
                &format!(
                    "request_id={request} java.lang.IllegalArgumentException: {family}\n at sample.module.Entry.run(Entry.java:1)"
                ),
            )
        }
        fn wrapped(seq: u64, ts: i64, family: &str, request: &str) -> Vec<ExplorerEvent> {
            vec![
                event(
                    seq,
                    ts,
                    "wrapped.log",
                    &format!(
                        "[stderr] (worker-{request}) request_id={request} java.lang.IllegalArgumentException: {family}"
                    ),
                ),
                event(
                    seq + 1,
                    ts,
                    "wrapped.log",
                    &format!(
                        "[stderr] (worker-{request}) request_id={request} at sample.module.Entry.run(Entry.java:1)"
                    ),
                ),
            ]
        }

        let mut events = vec![app(1, 10, "family_one", "one-strong")];
        events.extend(wrapped(2, 10, "family_one", "one-strong"));
        for (offset, request) in ["one-a", "one-b", "one-c"].into_iter().enumerate() {
            events.push(app(
                10 + offset as u64,
                100 + offset as i64 * 100,
                "family_one",
                request,
            ));
        }
        for (index, request) in ["two-a", "two-b"].into_iter().enumerate() {
            let seq = 100 + index as u64 * 10;
            let ts = 1_000 + index as i64 * 100;
            events.push(app(seq, ts, "family_two", request));
            events.extend(wrapped(seq + 1, ts, "family_two", request));
        }

        let analysis = analyze_bounded_events(events.len() as u64, &events);
        assert!(!analysis.semantic_counts_certified);
        let ranked_signatures: Vec<&str> = analysis
            .families
            .iter()
            .map(|family| family.signature.as_str())
            .collect();
        assert_eq!(ranked_signatures.len(), 2, "{ranked_signatures:?}");
        assert!(ranked_signatures[0].contains("family_two"));
        let first = &analysis.families[0];
        let second = &analysis.families[1];
        let strong = |family: &ExceptionFamilySummary| {
            family
                .occurrences
                .iter()
                .filter(|group| {
                    group.duplicate_rendering
                        && group.correlation_confidence == ExceptionCorrelationConfidence::Strong
                })
                .count()
        };
        assert_eq!(strong(first), 2);
        assert_eq!(strong(second), 1);
        assert!(second.occurrence_count > first.occurrence_count);

        let brief = format_exception_episode_brief_section(&analysis);
        assert!(brief.contains("semantic_occurrence_count: withheld"));
        assert!(brief.contains("retained_correlation_groups="));
        assert!(brief.contains("strong_derived_episodes="));
        assert!(!brief.contains(" occurrences="));
        assert!(!brief.contains("raw_per_occ="));
    }

    #[test]
    fn p0_extract_request_like_id_is_corpus_local() {
        // Bare id= is never an exact global anchor.
        assert_eq!(
            extract_request_like_id("RuntimeException: fail id=42 hop=3"),
            None
        );
        assert_eq!(
            extract_request_like_id("msg correlation_id=abc-9 more"),
            Some("req:abc-9".into())
        );
        assert_eq!(
            extract_request_like_id("request_id=req-77 payment failed"),
            Some("req:req-77".into())
        );
        assert_eq!(
            extract_request_like_id("trace_id=tr-1 java.lang.RuntimeException: x"),
            Some("req:tr-1".into())
        );
    }

    #[test]
    fn p0_seven_progressive_wraps_form_one_chain_root_mutation_splits() {
        // Seven progressive app layers: shared thread + request id + progressive
        // sites + compatible root signatures form one multi-rendering chain.
        // Mutating only the last layer's root type splits that member out.
        let mut events = Vec::new();
        for layer in 0..7u64 {
            // Outer wraps share root cause type for dual-stable signatures; sites differ.
            let body = format!(
                "thread=worker-7 request_id=req-77 java.lang.RuntimeException: XYZ_PAYMENT_FAILED hop={layer}\n\
\tat com.xyz.layer{layer}.Handler.handle(Handler{layer}.java:{line})\n\
\tat com.xyz.layer{layer}.Bridge.invoke(Bridge{layer}.java:{line2})\n\
\tCaused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-77\n\
\tat com.xyz.net.Http.execute(Http.java:15)",
                layer = layer,
                line = 10 + layer,
                line2 = 20 + layer,
            );
            events.push(event(layer + 1, 1_700_000_100, "app.log", &body));
        }
        let baseline = analyze_bounded_events(events.len() as u64, &events);
        let max_renderings = baseline
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .map(|o| o.rendering_count)
            .max()
            .unwrap_or(0);
        assert_eq!(
            max_renderings, 7,
            "seven progressive wraps must form one 7-rendering chain (occ={} max_r={})",
            baseline.occurrence_count, max_renderings
        );
        assert_eq!(baseline.occurrence_count, 1);

        // Mutate only layer 6: incompatible root/cause + distinct site family.
        events[6].message =
            "thread=worker-7 request_id=req-77 java.lang.IllegalStateException: XYZ_OTHER hop=6\n\
\tat com.other.site.Handler.handle(H.java:1)\n\
\tat com.other.site.Bridge.invoke(B.java:2)\n\
\tCaused by: java.lang.IllegalStateException: XYZ_OTHER\n\
\tat com.other.net.X.run(X.java:1)"
                .into();
        let mutated = analyze_bounded_events(events.len() as u64, &events);
        let max_after = mutated
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .map(|o| o.rendering_count)
            .max()
            .unwrap_or(0);
        assert!(
            max_after < 7,
            "mutating the last layer root/site must break the 7-member chain (max_r={max_after})"
        );
        assert!(
            mutated.occurrence_count >= 2,
            "root mutation must yield a split (occ={})",
            mutated.occurrence_count
        );
    }

    #[test]
    fn p0_order_only_app_app_without_exact_anchor_stays_separate() {
        let a = order_event(
            1,
            "app.log",
            "java.lang.RuntimeException: XYZ_OO\n at com.xyz.A.m(A.java:1)",
        );
        let b = order_event(
            2,
            "app.log",
            "java.lang.RuntimeException: XYZ_OO\n at com.xyz.B.m(B.java:1)",
        );
        let analysis = analyze_bounded_events(2, &[a, b]);
        assert_eq!(
            analysis.occurrence_count, 2,
            "OrderOnly app-app without exact unique execution anchor must not group"
        );
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
    }

    /// P0-10 product path: OrderOnly + matching thread + distinct sites + no
    /// trace/request/correlation must NOT form one episode (thread alone is not
    /// an ExactExecutionAnchor; OrderOnly multi-signal fallback is forbidden).
    #[test]
    fn p0_order_only_same_thread_without_request_or_trace_stays_separate() {
        let a = order_event(
            1,
            "app.log",
            "thread=worker-1 java.lang.RuntimeException: XYZ_TH\n at com.xyz.siteA.Handler.handle(A.java:1)",
        );
        let b = order_event(
            2,
            "app.log",
            "thread=worker-1 java.lang.RuntimeException: XYZ_TH\n at com.xyz.siteB.Handler.handle(B.java:1)",
        );
        let analysis = analyze_bounded_events(2, &[a, b]);
        assert_eq!(
            analysis.occurrence_count, 2,
            "OrderOnly same-thread app-app without request/trace must stay separate (got occ={})",
            analysis.occurrence_count
        );
        assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);
        let max_r = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .map(|o| o.rendering_count)
            .max()
            .unwrap_or(0);
        assert_eq!(
            max_r, 1,
            "thread-alone OrderOnly must not collapse into multi-rendering episode"
        );

        // Parenthesized WildFly task thread form (not thread= key).
        let c = order_event(
            3,
            "app.log",
            "ERROR [XYZ_app] (default task-1) java.lang.RuntimeException: XYZ_TASK\n at com.xyz.layer0.Handler.handle(H.java:1)",
        );
        let d = order_event(
            4,
            "app.log",
            "ERROR [XYZ_app] (default task-1) java.lang.RuntimeException: XYZ_TASK\n at com.xyz.layer1.Handler.handle(H.java:1)",
        );
        let paren = analyze_bounded_events(2, &[c, d]);
        assert_eq!(
            paren.occurrence_count, 2,
            "OrderOnly parenthesized task-thread alone must not form one episode"
        );
    }

    #[test]
    fn p0_one_stderr_two_app_chains_remains_unresolved() {
        // Two distinct request-anchored app chains, one compatible stderr → unresolved.
        let events = vec![
            event(
                1,
                10,
                "app.log",
                "thread=tA request_id=req-1 java.lang.RuntimeException: XYZ_AMB\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                11,
                "app.log",
                "thread=tB request_id=req-2 java.lang.RuntimeException: XYZ_AMB\n at com.xyz.B.m(B.java:1)",
            ),
            event(
                3,
                12,
                "stderr.log",
                "[stderr] (pool-1) java.lang.RuntimeException: XYZ_AMB",
            ),
            event(
                4,
                12,
                "stderr.log",
                "[stderr] (pool-1) at com.xyz.A.m(A.java:1)",
            ),
        ];
        // Make stderr compatible with both via matching id absent → signature only.
        // Without unique request match, must not absorb both chains into one episode with stderr.
        let analysis = analyze_bounded_events(4, &events);
        // Either ambiguous flag or no dual that includes both apps + one stderr.
        let duals_with_two_apps = analysis
            .families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .filter(|o| o.rendering_count >= 3)
            .count();
        assert_eq!(
            duals_with_two_apps, 0,
            "one stderr must never absorb two executions"
        );
    }

    #[test]
    fn production_public_api_has_no_scan_test_hooks() {
        // Structural proof: production `mod.rs` re-exports must not include test
        // mutation hooks / guards. Scan source with line splits (no byte indexing).
        let mod_src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/log_analysis/mod.rs"
        ));
        let episode_src = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/log_analysis/exception_episodes.rs"
        ));
        let mut in_export = false;
        let mut export_block = String::new();
        for line in mod_src.lines() {
            if line.contains("pub use exception_episodes::{") {
                in_export = true;
            }
            if in_export {
                export_block.push_str(line);
                export_block.push('\n');
                if line.contains("};") {
                    break;
                }
            }
        }
        assert!(
            !export_block.is_empty(),
            "exception_episodes re-export block must exist"
        );
        for forbidden in [
            "set_test_candidate_cap_override",
            "set_test_row_walk_cap_override",
            "set_episode_scan_page_hook_for_test",
            "TestScanOverrideGuard",
            "TEST_CANDIDATE_CAP_OVERRIDE",
            "TEST_ROW_WALK_CAP_OVERRIDE",
            "EPISODE_SCAN_PAGE_HOOK",
        ] {
            assert!(
                !export_block.contains(forbidden),
                "production re-export must not expose {forbidden}"
            );
        }
        // Each setter/guard definition must be cfg(test)-gated.
        let lines: Vec<&str> = episode_src.lines().collect();
        for needle in [
            "pub(crate) fn set_test_candidate_cap_override",
            "pub(crate) fn set_test_row_walk_cap_override",
            "pub(crate) fn set_episode_scan_page_hook_for_test",
            "pub(crate) struct TestScanOverrideGuard",
        ] {
            let idx = lines
                .iter()
                .position(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("expected {needle} definition"));
            let window_start = idx.saturating_sub(3);
            let before = lines[window_start..=idx].join("\n");
            assert!(
                before.contains("#[cfg(test)]"),
                "{needle} must be preceded by #[cfg(test)] within 3 lines"
            );
        }
        let _ = analyze_bounded_events as fn(u64, &[ExplorerEvent]) -> ExceptionEpisodeAnalysis;
        let _ = EXCEPTION_EPISODE_SCHEMA_ID;
    }

    #[test]
    fn p0_moderate_never_increments_strong_or_certifies() {
        // Wall-close dual without request/trace → Moderate path stays unresolved
        // for strong count (if paired at all, not strong-derived).
        let events = vec![
            event(
                1,
                100,
                "app.log",
                "java.lang.RuntimeException: XYZ_MOD\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                100,
                "stderr.log",
                "[stderr] java.lang.RuntimeException: XYZ_MOD",
            ),
            event(3, 100, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ];
        let a = analyze_bounded_events(3, &events);
        assert_eq!(
            a.strong_derived_episode_count, 0,
            "Moderate dual must not increment strong_derived"
        );
        assert!(!a.semantic_counts_certified);
        // With Strong anchor it certifies one.
        let events2 = vec![
            event(
                1,
                100,
                "app.log",
                "request_id=r1 java.lang.RuntimeException: XYZ_MOD\n at com.xyz.A.m(A.java:1)",
            ),
            event(
                2,
                100,
                "stderr.log",
                "[stderr] request_id=r1 java.lang.RuntimeException: XYZ_MOD",
            ),
            event(
                3,
                100,
                "stderr.log",
                "[stderr] request_id=r1 at com.xyz.A.m(A.java:1)",
            ),
        ];
        let b = analyze_bounded_events(3, &events2);
        assert_eq!(b.strong_derived_episode_count, 1);
        // Bounded path has no template catalog → structural cert withheld; correlation may complete.
        assert!(b.semantic_counts_certified || b.correlation_complete);
        assert!(!b.semantic_counts_certified || b.structural_coverage_complete);
    }

    #[test]
    fn independent_structural_template_classifier_is_not_message_candidate() {
        // Pattern is structural; message that would be assigned this template is not a candidate.
        assert_eq!(
            classify_structural_template_pattern("at com.xyz.payment.<*>.invoke(<*>.java:<*>)"),
            Some(StructuralTemplateRole::StackFrame)
        );
        assert_eq!(
            classify_structural_template_pattern(
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=<*>"
            ),
            Some(StructuralTemplateRole::ExceptionHeaderOrFullStack)
        );
        assert_eq!(
            classify_structural_template_pattern(
                "XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=<*>"
            ),
            Some(StructuralTemplateRole::ExceptionHeaderOrFullStack)
        );
        assert_eq!(
            classify_structural_template_pattern("Caused by: java.io.IOException: <*>"),
            Some(StructuralTemplateRole::CauseSuppressed)
        );
        assert_eq!(
            classify_structural_template_pattern(
                "unit-7 Caused by: opaque.runtime.Q7Exception: <*>"
            ),
            Some(StructuralTemplateRole::CauseSuppressed),
            "a retained service token must not promote structural support into its own incident candidate"
        );
        assert_eq!(
            classify_structural_template_pattern("[unit] Suppressed: opaque detail <*>"),
            Some(StructuralTemplateRole::CauseSuppressed)
        );
        for pattern in [
            "<*> Caused by: opaque.runtime.Q7Token: detail <*> ",
            "ERROR Caused by: opaque.runtime.Q7Token: detail <*> ",
            "[stderr] (lane-9) Caused by: opaque.runtime.Q7Token: detail <*> ",
            "logger Suppressed: opaque.runtime.Q7Token: detail <*> ",
        ] {
            assert_eq!(
                classify_structural_template_pattern(pattern),
                Some(StructuralTemplateRole::CauseSuppressed),
                "structural role changed for {pattern:?}"
            );
        }
        assert_eq!(
            classify_structural_template_pattern(
                "Exception wrapper XYZ_WRAP#<*> for payment failure"
            ),
            Some(StructuralTemplateRole::WrapperScaffold)
        );
        // Non-structural ops line.
        assert_eq!(
            classify_structural_template_pattern("heartbeat ok unrelated_id=<*>"),
            None
        );
        assert_eq!(
            classify_structural_template_pattern("user note: Caused by: routine explanation"),
            None,
            "multi-word prose before the marker must not be treated as structural support"
        );
        assert_eq!(
            classify_structural_template_pattern(
                "opaque.runtime.Q7Exception: Caused by: downstream detail <*>"
            ),
            Some(StructuralTemplateRole::ExceptionHeaderOrFullStack),
            "a typed header that later mentions a cause marker must remain a lead"
        );
        let ghost = event(
            99,
            100,
            "ghost.log",
            "INFO status: worker idle heartbeat ok unrelated",
        );
        assert!(
            !is_exception_candidate(&ghost),
            "ghost message must bypass is_exception_candidate"
        );
    }

    #[test]
    fn product_path_structural_template_bypassing_message_candidate_withholds_cert() {
        // Required mutation: persisted structural template + message that fails
        // is_exception_candidate → independent_expected > message_candidates,
        // candidate_predicate_misses > 0, structural + semantic cert false.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 2);
        let (_cache, _id, corpus) = ingest_dir(&src);

        let structural_tid = 9_001_001u64;
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: structural_tid,
                    pattern: "at com.xyz.payment.<*>.invoke(<*>.java:<*>)".into(),
                    token_count: 6,
                    count: 1,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_000_100,
                    severity: 3,
                    example: "at com.xyz.payment.StackFrame0.invoke(StackFrame0.java:1)".into(),
                },
                content_hash: format!("sha256:struct-{structural_tid}"),
                vector: None,
            }])
            .unwrap();
        corpus
            .push_events(&[LogEvent {
                seq: 50_000_001,
                ts: 1_700_000_500,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "INFO".into(),
                service: Some("ghost".into()),
                host: Some("ghost-host".into()),
                template_id: structural_tid,
                params: vec![],
                trace_id: None,
                message: "INFO status: worker idle heartbeat ok unrelated".into(),
                source: "ghost.stderr".into(),
            }])
            .unwrap();
        corpus.flush().unwrap();

        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert!(
            analysis.independently_expected_structural_identity_count
                > analysis.message_candidate_identity_count,
            "independently_expected ({}) must exceed message_candidates ({})",
            analysis.independently_expected_structural_identity_count,
            analysis.message_candidate_identity_count
        );
        assert!(
            analysis.candidate_predicate_miss_count > 0,
            "candidate_predicate_misses must be > 0"
        );
        assert!(
            !analysis.structural_coverage_complete,
            "structural_coverage_complete must be false"
        );
        assert!(
            !analysis.semantic_counts_certified,
            "semantic_counts_certified must be false"
        );
        // Anti-regression: filter(is_exception_candidate) as "eligible" would hide this miss.
        assert!(
            analysis
                .ranking_disclosure
                .contains("candidate_predicate_misses")
                || analysis.candidate_predicate_miss_count > 0
        );
    }

    #[test]
    fn product_path_suppression_removes_identity_from_independent_and_citations() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 1);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let full = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert!(full.independently_expected_structural_identity_count > 0);

        // Suppress every template → independent inventory and citations empty.
        let all_tids: Vec<u64> = corpus
            .list_templates()
            .into_iter()
            .map(|t| t.info.template_id)
            .collect();
        let suppressed = analyze_exception_episodes(&corpus, &all_tids).unwrap();
        assert_eq!(
            suppressed.independently_expected_structural_identity_count,
            0
        );
        assert_eq!(suppressed.message_candidate_identity_count, 0);
        assert_eq!(suppressed.covered_structural_identity_count, 0);
        assert_eq!(suppressed.events_scanned, 0);
    }

    #[test]
    fn product_path_template_revision_drift_during_inventory_fails_closed() {
        // Product scan pins template revision before inventory and rechecks after
        // inventory + correlation. Concurrent template upsert mid-walk fails closed.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 4);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let pinned_event = corpus.event_revision();
        let pinned_template = corpus.template_analysis_revision();
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: 9_999_888,
                    pattern: "pre-scan drift <*>".into(),
                    token_count: 2,
                    count: 1,
                    first_seen: 1,
                    last_seen: 2,
                    severity: 0,
                    example: "drift".into(),
                },
                content_hash: "sha256:prescan-drift".into(),
                vector: None,
            }])
            .unwrap();
        assert_ne!(corpus.template_analysis_revision(), pinned_template);
        let err = check_revisions(&corpus, pinned_event, pinned_template).unwrap_err();
        assert!(
            err.to_string().contains("template analysis revision"),
            "expected template revision fail-closed, got {err}"
        );

        // Mid-scan: page hook mutates templates while product walk holds a pin.
        let _guard = TestScanOverrideGuard::acquire();
        let corpus_ptr: *const LogCorpus = &corpus;
        set_episode_scan_page_hook_for_test(Some(Box::new(move |page| {
            if page == 0 {
                // SAFETY: corpus lives for the duration of this test; hook runs
                // only while analyze_exception_episodes borrows it.
                let corpus = unsafe { &*corpus_ptr };
                let _ = corpus.upsert_templates([TemplateRow {
                    info: TemplateInfo {
                        template_id: 9_999_889,
                        pattern: "mid-scan drift <*>".into(),
                        token_count: 2,
                        count: 1,
                        first_seen: 1,
                        last_seen: 2,
                        severity: 0,
                        example: "mid".into(),
                    },
                    content_hash: "sha256:mid-drift".into(),
                    vector: None,
                }]);
            }
        })));
        let err = analyze_exception_episodes(&corpus, &[]).unwrap_err();
        assert!(
            err.to_string().contains("template analysis revision")
                || err.to_string().contains("revision changed"),
            "mid-scan template drift must fail closed, got {err}"
        );
    }

    #[test]
    fn product_path_dual_rendering_independent_inventory_matches_final_citations() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 4);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
        assert_eq!(
            analysis.independently_expected_structural_identity_count,
            analysis.covered_structural_identity_count
        );
        assert_eq!(analysis.candidate_predicate_miss_count, 0);
        assert_eq!(analysis.rendering_miss_count, 0);
        assert_eq!(analysis.missing_structural_identity_count, 0);
        assert_eq!(analysis.duplicate_structural_identity_count, 0);
        assert_eq!(analysis.unexpected_structural_identity_count, 0);
        assert_eq!(analysis.unknown_suspicious_structural_identity_count, 0);
        assert!(analysis.structural_coverage_complete);
        assert!(analysis.semantic_counts_certified);
        // Three conservation stages are disclosed.
        assert!(analysis
            .ranking_disclosure
            .contains("conservation_stage1_independently_expected"));
        assert!(analysis
            .ranking_disclosure
            .contains("conservation_stage2_rendering_identities"));
        assert!(analysis
            .ranking_disclosure
            .contains("conservation_stage3_final_unique_citations"));
    }
}
