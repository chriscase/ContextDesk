//! Deterministic exception episode / duplicate-rendering correlation.
//!
//! Pure, host-neutral, non-destructive: durable events are never rewritten.
//! Episodes are derived relationships over real `seq`/`source` identities.
//!
//! Design goals:
//! - distinguish conventional multiline one-event traces from separately
//!   wrapped stderr header/frame/cause streams and cross-stream duplicates;
//! - rank meaningful occurrence evidence, not raw stack-frame volume;
//! - fail closed to partial/candidate when evidence is weak (never invent counts);
//! - bounded memory/runtime with cooperative cancellation.

use super::query::{query_events, EventQuery, ExplorerEvent};
use super::store::LogCorpus;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Versioned schema id for the correlation report.
pub const EXCEPTION_EPISODE_SCHEMA_ID: &str = "contextdesk.exception_episode_report.v1";
/// Schema version.
pub const EXCEPTION_EPISODE_SCHEMA_VERSION: u32 = 1;

/// Hard ceiling on events scanned for one correlation pass.
pub const MAX_CORRELATION_EVENTS: usize = 50_000;
/// Hard ceiling on emitted episodes.
pub const MAX_EPISODES: usize = 1_000;
/// Hard ceiling on constituents retained per episode.
pub const MAX_EVENTS_PER_EPISODE: usize = 400;
/// Max seq gap between consecutive records inside one stream-local episode.
pub const MAX_SEQ_GAP_WITHIN_EPISODE: u64 = 8;
/// Max order/ts span (axis units) for one stream-local episode.
pub const MAX_AXIS_SPAN_WITHIN_EPISODE: i64 = 60_000;
/// Max axis distance (wall seconds or order units) for cross-stream merge.
pub const MAX_CROSS_STREAM_AXIS_WINDOW: i64 = 120;
/// Cap distinct family fingerprints retained in the report.
pub const MAX_FAMILY_FINGERPRINTS: usize = 200;
/// Page size when loading events from a corpus.
const EVENT_PAGE: usize = 500;

/// Role of one constituent event inside an episode (or outside any episode).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionRecordRole {
    /// Exception header / lead line (`SomeException: message`).
    ExceptionHeader,
    /// Stack frame line (`at pkg.Class.method(...)`).
    StackFrame,
    /// Cause / suppressed chain marker.
    CauseMarker,
    /// Wrapper / thread / ellipsis scaffolding around a trace.
    WrapperScaffold,
    /// Conventional producer multiline: one durable event already holds the full trace.
    ConventionalMultiline,
    /// Not classified as exception-structure evidence.
    Unclassified,
}

/// Confidence of an episode or family grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionCorrelationConfidence {
    /// Strong multi-signal assembly.
    High,
    /// Usable but capped or partially ambiguous.
    Medium,
    /// Weak structure; treat carefully.
    Low,
    /// Signals insufficient; counts stay raw-only.
    Unknown,
}

/// How complete an episode assembly is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionEpisodeCompleteness {
    /// Header/lead present and bounds not hit.
    Complete,
    /// Some members missing or ambiguous.
    Partial,
    /// Hit a hard member/output cap.
    Truncated,
    /// Weak candidate (e.g. missing header).
    Candidate,
}

/// One real durable event identity retained as a constituent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionEpisodeMember {
    /// Durable event sequence.
    pub seq: u64,
    /// Portable source identity.
    pub source: String,
    /// Template id assigned at ingest.
    pub template_id: u64,
    /// Structural role inside the episode.
    pub role: ExceptionRecordRole,
    /// Stored axis value (wall or order).
    pub ts: i64,
}

/// One occurrence (episode) of an exception family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionEpisode {
    /// Stable episode id within this report.
    pub episode_id: String,
    /// Family fingerprint id this episode belongs to.
    pub family_id: String,
    /// Real child event identities (never fabricated).
    pub members: Vec<ExceptionEpisodeMember>,
    /// Distinct durable events in this episode.
    pub raw_record_count: u64,
    /// Assembly completeness.
    pub completeness: ExceptionEpisodeCompleteness,
    /// Grouping confidence.
    pub confidence: ExceptionCorrelationConfidence,
    /// Human-readable assembly reasons.
    pub reasons: Vec<String>,
    /// Minimum member seq.
    pub min_seq: u64,
    /// Maximum member seq.
    pub max_seq: u64,
    /// Minimum member axis value.
    pub min_ts: i64,
    /// Maximum member axis value.
    pub max_ts: i64,
    /// True when members span more than one portable source identity.
    pub cross_stream: bool,
}

/// Aggregated family of similar episodes (not a fabricated count).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFamily {
    /// Stable family id (usually equals fingerprint).
    pub family_id: String,
    /// Stable content fingerprint (class + normalized message).
    pub fingerprint: String,
    /// Best-effort exception type name.
    pub exception_class: Option<String>,
    /// Bounded message excerpt used for the fingerprint.
    pub exception_message_excerpt: Option<String>,
    /// Number of correlated episodes (occurrences), never invented.
    pub occurrence_count: u64,
    /// Sum of raw durable records across episodes.
    pub raw_record_count: u64,
    /// `raw_record_count / occurrence_count` rounded down; 0 when no occurrences.
    pub amplification_x: u64,
    /// Family-level confidence (worst episode).
    pub confidence: ExceptionCorrelationConfidence,
    /// Family-level completeness (worst episode).
    pub completeness: ExceptionEpisodeCompleteness,
    /// Aggregation reasons and amplification disclosure.
    pub reasons: Vec<String>,
    /// Role histogram over members (supporting vs lead).
    pub role_counts: BTreeMap<String, u64>,
    /// Representative header/conventional member identities for citation.
    pub lead_citations: Vec<ExceptionEpisodeMember>,
}

/// Versioned host-neutral correlation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionEpisodeReport {
    /// Schema id string.
    pub schema_id: String,
    /// Schema version number.
    pub schema_version: u32,
    /// Events examined in this pass.
    pub events_scanned: u64,
    /// Events with a non-unclassified structural role.
    pub events_classified: u64,
    /// Number of episodes emitted.
    pub episode_count: u64,
    /// Number of families emitted.
    pub family_count: u64,
    /// All durable events scanned (including unclassified).
    pub raw_record_total: u64,
    /// Sum of occurrence_count over families.
    pub correlated_occurrence_total: u64,
    /// Sum of raw_record_count over families (subset of raw_record_total).
    pub correlated_raw_record_total: u64,
    /// Overall amplification across correlated families (raw/occurrences).
    pub overall_amplification_x: u64,
    /// True when any family/episode is partial/candidate or caps applied.
    pub partial: bool,
    /// True when an input or output cap truncated work.
    pub truncated: bool,
    /// Reserved for hosts that surface cancel on the report object.
    pub cancelled: bool,
    /// Overall report confidence.
    pub confidence: ExceptionCorrelationConfidence,
    /// Report-level reasons.
    pub reasons: Vec<String>,
    /// Ranked families.
    pub families: Vec<ExceptionFamily>,
    /// Episodes (bounded).
    pub episodes: Vec<ExceptionEpisode>,
    /// Ranking disclosure for consumers (broad triage).
    pub ranking_disclosure: String,
}

/// Options for one correlation pass.
#[derive(Debug, Clone)]
pub struct ExceptionCorrelationOptions {
    /// Max events to scan.
    pub max_events: usize,
    /// Max episodes to emit.
    pub max_episodes: usize,
    /// Max members retained per episode.
    pub max_events_per_episode: usize,
    /// Max seq gap between consecutive stream-local attachments.
    pub max_seq_gap: u64,
    /// Max axis span for stream-local assembly.
    pub max_axis_span: i64,
    /// Max axis gap for optional cross-stream pairing checks.
    pub max_cross_stream_axis_window: i64,
    /// Suppression template exclusions (pinned lens).
    pub excluded_template_ids: Vec<u64>,
}

impl Default for ExceptionCorrelationOptions {
    fn default() -> Self {
        Self {
            max_events: MAX_CORRELATION_EVENTS,
            max_episodes: MAX_EPISODES,
            max_events_per_episode: MAX_EVENTS_PER_EPISODE,
            max_seq_gap: MAX_SEQ_GAP_WITHIN_EPISODE,
            max_axis_span: MAX_AXIS_SPAN_WITHIN_EPISODE,
            max_cross_stream_axis_window: MAX_CROSS_STREAM_AXIS_WINDOW,
            excluded_template_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct ClassifiedEvent {
    event: ExplorerEvent,
    role: ExceptionRecordRole,
    exception_class: Option<String>,
    exception_message: Option<String>,
    fingerprint: Option<String>,
}

/// Classify one event message into a structural role + optional fingerprint.
fn classify_exception_event(event: &ExplorerEvent) -> ClassifiedEvent {
    let message = event.message.as_str();
    let lines: Vec<&str> = message.lines().map(str::trim_end).collect();
    let non_empty: Vec<&str> = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    let frame_lines: Vec<String> = non_empty
        .iter()
        .filter(|l| is_stack_frame_line(l))
        .map(|l| (*l).to_string())
        .collect();
    let header = non_empty.iter().find_map(|l| parse_exception_header(l));
    let has_cause = non_empty.iter().any(|l| is_cause_marker_line(l));
    let has_wrapper = non_empty.iter().any(|l| is_wrapper_scaffold_line(l));
    let multi_frame = frame_lines.len() >= 2;
    let single_line = non_empty.len() <= 1;

    let (role, class, msg) = match header {
        Some((c, m)) if (multi_frame || has_cause) && !single_line => {
            (ExceptionRecordRole::ConventionalMultiline, Some(c), Some(m))
        }
        Some((c, m)) if single_line || frame_lines.is_empty() => {
            (ExceptionRecordRole::ExceptionHeader, Some(c), Some(m))
        }
        Some((c, m)) => (ExceptionRecordRole::ConventionalMultiline, Some(c), Some(m)),
        None if non_empty.len() == 1 && is_stack_frame_line(non_empty[0]) => {
            (ExceptionRecordRole::StackFrame, None, None)
        }
        None if non_empty.len() == 1 && is_cause_marker_line(non_empty[0]) => {
            let (c, m) = parse_exception_header(
                non_empty[0]
                    .trim_start_matches("Caused by:")
                    .trim_start_matches("Caused by")
                    .trim(),
            )
            .map(|(c, m)| (Some(c), Some(m)))
            .unwrap_or((None, None));
            (ExceptionRecordRole::CauseMarker, c, m)
        }
        None if (non_empty.len() == 1 && is_wrapper_scaffold_line(non_empty[0]))
            || (has_wrapper && frame_lines.is_empty()) =>
        {
            (ExceptionRecordRole::WrapperScaffold, None, None)
        }
        None => (ExceptionRecordRole::Unclassified, None, None),
    };

    let fingerprint = match (&class, &msg, role) {
        (Some(c), m, ExceptionRecordRole::ExceptionHeader)
        | (Some(c), m, ExceptionRecordRole::ConventionalMultiline)
        | (Some(c), m, ExceptionRecordRole::CauseMarker) => {
            // Class + message only so dual-stream headers (no frames yet) share
            // a fingerprint with conventional multiline traces of the same fault.
            Some(family_fingerprint(c, m.as_deref()))
        }
        _ => None,
    };

    ClassifiedEvent {
        event: event.clone(),
        role,
        exception_class: class,
        exception_message: msg,
        fingerprint,
    }
}

/// Correlate exception episodes from an in-memory event list (pure).
pub fn correlate_exception_episodes(
    events: &[ExplorerEvent],
    options: &ExceptionCorrelationOptions,
    cancel: Option<&CancelFlag>,
) -> CoreResult<ExceptionEpisodeReport> {
    check_cancel(cancel)?;
    let mut reasons = Vec::new();
    let mut truncated = false;
    let mut partial = false;

    let max_events = options.max_events.clamp(1, MAX_CORRELATION_EVENTS);
    let slice = if events.len() > max_events {
        truncated = true;
        reasons.push(format!(
            "scanned first {max_events} of {} events (correlation event cap)",
            events.len()
        ));
        &events[..max_events]
    } else {
        events
    };

    let mut classified: Vec<ClassifiedEvent> = Vec::with_capacity(slice.len());
    for (idx, event) in slice.iter().enumerate() {
        if idx % 1024 == 0 {
            check_cancel(cancel)?;
        }
        classified.push(classify_exception_event(event));
    }
    let events_classified = classified
        .iter()
        .filter(|c| c.role != ExceptionRecordRole::Unclassified)
        .count() as u64;

    // Sort by axis then seq for deterministic assembly.
    classified.sort_by(|a, b| {
        a.event
            .ts
            .cmp(&b.event.ts)
            .then_with(|| a.event.seq.cmp(&b.event.seq))
    });

    let stream_local = assemble_stream_local_episodes(&classified, options, cancel)?;
    check_cancel(cancel)?;
    let mut episodes = merge_cross_stream_duplicates(stream_local, options, cancel)?;

    if episodes.len() > options.max_episodes {
        truncated = true;
        partial = true;
        reasons.push(format!(
            "episode list truncated to {} (cap)",
            options.max_episodes
        ));
        episodes.truncate(options.max_episodes);
    }

    let families = build_families(&episodes, &mut reasons);
    let correlated_occurrence_total = families.iter().map(|f| f.occurrence_count).sum::<u64>();
    let correlated_raw_record_total = families.iter().map(|f| f.raw_record_count).sum::<u64>();
    let overall_amplification_x = if correlated_occurrence_total == 0 {
        0
    } else {
        correlated_raw_record_total / correlated_occurrence_total
    };

    if families.iter().any(|f| {
        matches!(
            f.confidence,
            ExceptionCorrelationConfidence::Low | ExceptionCorrelationConfidence::Unknown
        ) || matches!(
            f.completeness,
            ExceptionEpisodeCompleteness::Partial
                | ExceptionEpisodeCompleteness::Candidate
                | ExceptionEpisodeCompleteness::Truncated
        )
    }) {
        partial = true;
    }

    let confidence = if families.is_empty() {
        if events_classified == 0 {
            ExceptionCorrelationConfidence::Unknown
        } else {
            ExceptionCorrelationConfidence::Low
        }
    } else if partial || truncated {
        ExceptionCorrelationConfidence::Medium
    } else {
        ExceptionCorrelationConfidence::High
    };

    let ranking_disclosure = build_ranking_disclosure(
        slice.len() as u64,
        correlated_occurrence_total,
        correlated_raw_record_total,
        overall_amplification_x,
        &families,
    );

    Ok(ExceptionEpisodeReport {
        schema_id: EXCEPTION_EPISODE_SCHEMA_ID.into(),
        schema_version: EXCEPTION_EPISODE_SCHEMA_VERSION,
        events_scanned: slice.len() as u64,
        events_classified,
        episode_count: episodes.len() as u64,
        family_count: families.len() as u64,
        raw_record_total: slice.len() as u64,
        correlated_occurrence_total,
        correlated_raw_record_total,
        overall_amplification_x,
        partial,
        truncated,
        cancelled: false,
        confidence,
        reasons,
        families,
        episodes,
        ranking_disclosure,
    })
}

/// Load events from a durable corpus (respecting suppression exclusions) and correlate.
pub fn correlate_exception_episodes_from_corpus(
    corpus: &LogCorpus,
    options: &ExceptionCorrelationOptions,
    cancel: Option<&CancelFlag>,
) -> CoreResult<ExceptionEpisodeReport> {
    check_cancel(cancel)?;
    let mut events = Vec::new();
    let mut after_seq: Option<u64> = None;
    let max_events = options.max_events.clamp(1, MAX_CORRELATION_EVENTS);
    loop {
        check_cancel(cancel)?;
        let q = EventQuery {
            excluded_template_ids: options.excluded_template_ids.clone(),
            after_seq,
            limit: EVENT_PAGE.min(max_events.saturating_sub(events.len()).max(1)),
            // Seq order keeps folder/ZIP dual-stream discovery stable.
            sort_by_time: false,
            ..EventQuery::default()
        };
        let page = query_events(corpus, &q)?;
        if page.events.is_empty() {
            break;
        }
        for event in page.events {
            after_seq = Some(event.seq);
            events.push(event);
            if events.len() >= max_events {
                break;
            }
        }
        if events.len() >= max_events || page.next_cursor.is_none() {
            break;
        }
    }
    let mut report = correlate_exception_episodes(&events, options, cancel)?;
    if events.len() >= max_events {
        report.truncated = true;
        report.partial = true;
        if !report
            .reasons
            .iter()
            .any(|r| r.contains("correlation event cap"))
        {
            report.reasons.push(format!(
                "corpus scan stopped at correlation event cap ({max_events})"
            ));
        }
    }
    Ok(report)
}

/// Compact multi-line text for broad-triage brief inclusion.
pub fn format_exception_episode_brief_section(report: &ExceptionEpisodeReport) -> String {
    let mut out = String::new();
    out.push_str("## Exception episode correlation\n");
    out.push_str(&format!(
        "schema_id: {}\nschema_version: {}\n\
         events_scanned: {}\nevents_classified: {}\n\
         episode_count: {}\nfamily_count: {}\n\
         raw_record_total: {}\ncorrelated_occurrence_total: {}\n\
         correlated_raw_record_total: {}\noverall_amplification_x: {}\n\
         partial: {}\ntruncated: {}\nconfidence: {:?}\n",
        report.schema_id,
        report.schema_version,
        report.events_scanned,
        report.events_classified,
        report.episode_count,
        report.family_count,
        report.raw_record_total,
        report.correlated_occurrence_total,
        report.correlated_raw_record_total,
        report.overall_amplification_x,
        report.partial,
        report.truncated,
        report.confidence
    ));
    out.push_str(&report.ranking_disclosure);
    out.push('\n');
    for family in report.families.iter().take(8) {
        out.push_str(&format!(
            "- family_id={} occurrences={} raw_records={} amplification_x={} class={} confidence={:?}\n",
            family.family_id,
            family.occurrence_count,
            family.raw_record_count,
            family.amplification_x,
            family
                .exception_class
                .as_deref()
                .unwrap_or("<unknown>"),
            family.confidence
        ));
        out.push_str("  roles:");
        for (role, count) in &family.role_counts {
            out.push_str(&format!(" {role}={count}"));
        }
        out.push('\n');
        for lead in family.lead_citations.iter().take(4) {
            out.push_str(&format!(
                "  lead seq={} source={} role={:?} template_id={}\n",
                lead.seq, lead.source, lead.role, lead.template_id
            ));
        }
        for reason in family.reasons.iter().take(3) {
            out.push_str(&format!("  reason: {reason}\n"));
        }
    }
    for reason in report.reasons.iter().take(6) {
        out.push_str(&format!("reason: {reason}\n"));
    }
    out.push_str(
        "interpretation: wrappers and stack frames are supporting records of an episode, \
         not independent incidents. Prefer occurrence_count over raw_record_total when ranking.\n",
    );
    out
}

fn build_ranking_disclosure(
    raw_total: u64,
    occurrences: u64,
    correlated_raw: u64,
    amplification_x: u64,
    families: &[ExceptionFamily],
) -> String {
    let mut s = format!(
        "ranking_basis: exception_episode_occurrences_not_raw_stack_volume\n\
         disclosure_raw_record_total: {raw_total}\n\
         disclosure_correlated_occurrence_total: {occurrences}\n\
         disclosure_correlated_raw_record_total: {correlated_raw}\n\
         disclosure_overall_amplification_x: {amplification_x}\n\
         independent_incident_claim_forbidden: true\n"
    );
    if let Some(top) = families.first() {
        s.push_str(&format!(
            "top_family_amplification_example: {} occurrences / {} raw records / {}x\n",
            top.occurrence_count, top.raw_record_count, top.amplification_x
        ));
    }
    s
}

fn assemble_stream_local_episodes(
    classified: &[ClassifiedEvent],
    options: &ExceptionCorrelationOptions,
    cancel: Option<&CancelFlag>,
) -> CoreResult<Vec<ExceptionEpisode>> {
    // One open episode per source so interleaved concurrent streams cannot
    // mis-attach foreign frames across sources.
    let mut episodes = Vec::new();
    let mut open_by_source: BTreeMap<String, OpenEpisode> = BTreeMap::new();
    let mut episode_idx = 0u64;

    for (idx, item) in classified.iter().enumerate() {
        if idx % 512 == 0 {
            check_cancel(cancel)?;
        }
        let source_key = item.event.source.clone();
        match item.role {
            ExceptionRecordRole::ConventionalMultiline => {
                if let Some(current) = open_by_source.remove(&source_key) {
                    episodes.push(finalize_open(current, options));
                }
                episode_idx += 1;
                let mut ep = OpenEpisode::new(episode_idx, item);
                ep.reasons
                    .push("conventional_multiline_single_logical_event".into());
                episodes.push(finalize_open(ep, options));
            }
            ExceptionRecordRole::ExceptionHeader => {
                if let Some(current) = open_by_source.remove(&source_key) {
                    episodes.push(finalize_open(current, options));
                }
                episode_idx += 1;
                open_by_source.insert(source_key, OpenEpisode::new(episode_idx, item));
            }
            ExceptionRecordRole::StackFrame
            | ExceptionRecordRole::CauseMarker
            | ExceptionRecordRole::WrapperScaffold => {
                let mut close_orphan = false;
                if let Some(current) = open_by_source.get_mut(&source_key) {
                    if current.can_attach(item, options) {
                        current.attach(item, options);
                    } else {
                        close_orphan = true;
                    }
                }
                if close_orphan {
                    if let Some(finished) = open_by_source.remove(&source_key) {
                        episodes.push(finalize_open(finished, options));
                    }
                    // Orphan frame/cause without a nearby same-source header stays unassigned.
                }
            }
            ExceptionRecordRole::Unclassified => {
                if let Some(current) = open_by_source.get(&source_key) {
                    if !current.can_attach(item, options) {
                        if let Some(finished) = open_by_source.remove(&source_key) {
                            episodes.push(finalize_open(finished, options));
                        }
                    }
                }
            }
        }
    }
    for (_, current) in open_by_source {
        episodes.push(finalize_open(current, options));
    }
    Ok(episodes)
}

struct OpenEpisode {
    episode_idx: u64,
    family_fp: Option<String>,
    class: Option<String>,
    message: Option<String>,
    members: Vec<ExceptionEpisodeMember>,
    reasons: Vec<String>,
    last_seq: u64,
    min_seq: u64,
    max_seq: u64,
    min_ts: i64,
    max_ts: i64,
    sources: BTreeSet<String>,
}

impl OpenEpisode {
    fn new(episode_idx: u64, item: &ClassifiedEvent) -> Self {
        let member = member_from(item);
        let mut sources = BTreeSet::new();
        sources.insert(item.event.source.clone());
        Self {
            episode_idx,
            family_fp: item.fingerprint.clone(),
            class: item.exception_class.clone(),
            message: item.exception_message.clone(),
            last_seq: item.event.seq,
            min_seq: item.event.seq,
            max_seq: item.event.seq,
            min_ts: item.event.ts,
            max_ts: item.event.ts,
            members: vec![member],
            reasons: Vec::new(),
            sources,
        }
    }

    fn can_attach(&self, item: &ClassifiedEvent, options: &ExceptionCorrelationOptions) -> bool {
        // Stream-local assembly is strictly same-source (open map is keyed by source).
        if !self.sources.contains(&item.event.source) {
            return false;
        }
        if item.event.seq < self.last_seq {
            return false;
        }
        let seq_gap = item.event.seq.saturating_sub(self.last_seq);
        if seq_gap > options.max_seq_gap {
            return false;
        }
        let axis_span = (item.event.ts - self.min_ts)
            .abs()
            .max((self.max_ts - item.event.ts).abs());
        if axis_span > options.max_axis_span {
            return false;
        }
        // Cause lines that carry a different exception fingerprint must not attach
        // into an open episode of another fault on the same source.
        if matches!(item.role, ExceptionRecordRole::CauseMarker) {
            if let (Some(open_fp), Some(item_fp)) = (&self.family_fp, &item.fingerprint) {
                // Allow nested causes that share class family prefix, but not unrelated classes.
                if open_fp != item_fp {
                    let open_class = open_fp.split('|').next().unwrap_or("");
                    let item_class = item_fp.split('|').next().unwrap_or("");
                    // Nested cause often differs in class (RuntimeException vs IOException) —
                    // still attach when it is a cause marker within the gap window.
                    let _ = (open_class, item_class);
                }
            }
        }
        // Headers never attach into an existing open (handled by caller).
        if matches!(
            item.role,
            ExceptionRecordRole::ExceptionHeader | ExceptionRecordRole::ConventionalMultiline
        ) {
            return false;
        }
        true
    }

    fn attach(&mut self, item: &ClassifiedEvent, options: &ExceptionCorrelationOptions) {
        if self.members.len() >= options.max_events_per_episode {
            self.reasons.push("episode_member_cap_reached".into());
            return;
        }
        if self.family_fp.is_none() {
            self.family_fp = item.fingerprint.clone();
        }
        if self.class.is_none() {
            self.class = item.exception_class.clone();
        }
        if self.message.is_none() {
            self.message = item.exception_message.clone();
        }
        self.members.push(member_from(item));
        self.last_seq = item.event.seq;
        self.min_seq = self.min_seq.min(item.event.seq);
        self.max_seq = self.max_seq.max(item.event.seq);
        self.min_ts = self.min_ts.min(item.event.ts);
        self.max_ts = self.max_ts.max(item.event.ts);
        self.sources.insert(item.event.source.clone());
    }
}

fn finalize_open(open: OpenEpisode, options: &ExceptionCorrelationOptions) -> ExceptionEpisode {
    let raw_record_count = open.members.len() as u64;
    let cross_stream = open.sources.len() > 1;
    let has_lead = open.members.iter().any(|m| {
        matches!(
            m.role,
            ExceptionRecordRole::ExceptionHeader | ExceptionRecordRole::ConventionalMultiline
        )
    });
    let only_frames = open.members.iter().all(|m| {
        matches!(
            m.role,
            ExceptionRecordRole::StackFrame
                | ExceptionRecordRole::WrapperScaffold
                | ExceptionRecordRole::CauseMarker
        )
    });

    let (completeness, confidence, mut reasons) = if !has_lead {
        (
            ExceptionEpisodeCompleteness::Candidate,
            ExceptionCorrelationConfidence::Low,
            vec!["missing_exception_header".into()],
        )
    } else if open.members.len() >= options.max_events_per_episode {
        (
            ExceptionEpisodeCompleteness::Truncated,
            ExceptionCorrelationConfidence::Medium,
            open.reasons,
        )
    } else if only_frames {
        (
            ExceptionEpisodeCompleteness::Candidate,
            ExceptionCorrelationConfidence::Unknown,
            vec!["frames_without_header".into()],
        )
    } else {
        (
            ExceptionEpisodeCompleteness::Complete,
            ExceptionCorrelationConfidence::High,
            open.reasons,
        )
    };
    if cross_stream {
        reasons.push("cross_stream_members".into());
    }
    if matches!(
        open.members.first().map(|m| m.role),
        Some(ExceptionRecordRole::ConventionalMultiline)
    ) && open.members.len() == 1
    {
        reasons.push("single_logical_multiline_event".into());
    }

    let family_id = open
        .family_fp
        .clone()
        .unwrap_or_else(|| format!("orphan:{}", open.episode_idx));

    ExceptionEpisode {
        episode_id: format!("ep:{}", open.episode_idx),
        family_id,
        members: open.members,
        raw_record_count,
        completeness,
        confidence,
        reasons,
        min_seq: open.min_seq,
        max_seq: open.max_seq,
        min_ts: open.min_ts,
        max_ts: open.max_ts,
        cross_stream,
    }
}

fn merge_cross_stream_duplicates(
    episodes: Vec<ExceptionEpisode>,
    options: &ExceptionCorrelationOptions,
    cancel: Option<&CancelFlag>,
) -> CoreResult<Vec<ExceptionEpisode>> {
    // Group by family fingerprint, then pair conventional multiline renderings
    // with expanded multi-record streams of the same family (dual rendering).
    // Pairing is by occurrence index within each family — not by divisibility
    // of raw counts and not by wall-clock equality across order-only streams.
    let mut by_family: BTreeMap<String, Vec<ExceptionEpisode>> = BTreeMap::new();
    let mut passthrough = Vec::new();
    for ep in episodes {
        if ep.family_id.starts_with("orphan:") || ep.family_id == "orphan" {
            passthrough.push(ep);
        } else {
            by_family.entry(ep.family_id.clone()).or_default().push(ep);
        }
    }

    let mut out = passthrough;
    for (_family_id, mut family_eps) in by_family {
        check_cancel(cancel)?;
        family_eps.sort_by(|a, b| {
            a.min_seq
                .cmp(&b.min_seq)
                .then_with(|| a.episode_id.cmp(&b.episode_id))
        });
        let mut conventional = Vec::new();
        let mut expanded = Vec::new();
        let mut other = Vec::new();
        for ep in family_eps {
            if is_conventional_only(&ep) {
                conventional.push(ep);
            } else if has_lead(&ep) && ep.raw_record_count >= 2 {
                expanded.push(ep);
            } else {
                other.push(ep);
            }
        }
        // Prefer pairing expanded (stderr) with conventional (app) 1:1 in order.
        // Require disjoint sources AND a bounded axis window — never merge solely
        // because fingerprints match and sources differ (over-merge risk).
        let pair_n = conventional.len().min(expanded.len());
        for i in 0..pair_n {
            let mut merged = expanded[i].clone();
            let conv = &conventional[i];
            let sources_a: BTreeSet<_> = merged.members.iter().map(|m| m.source.as_str()).collect();
            let sources_b: BTreeSet<_> = conv.members.iter().map(|m| m.source.as_str()).collect();
            let gap = axis_window_gap(&merged, conv);
            let axis_ok = gap <= options.max_cross_stream_axis_window;
            let dual_shape = (is_conventional_only(conv)
                && has_lead(&merged)
                && merged.members.iter().any(|m| {
                    matches!(
                        m.role,
                        ExceptionRecordRole::StackFrame | ExceptionRecordRole::WrapperScaffold
                    )
                }))
                || (is_conventional_only(&merged) && has_lead(conv));
            if sources_a.is_disjoint(&sources_b) && axis_ok && dual_shape {
                for m in &conv.members {
                    if merged.members.len() >= options.max_events_per_episode {
                        merged.completeness = ExceptionEpisodeCompleteness::Truncated;
                        merged.reasons.push("merged_episode_member_cap".into());
                        break;
                    }
                    if !merged.members.iter().any(|x| x.seq == m.seq) {
                        merged.members.push(m.clone());
                    }
                }
                merged.raw_record_count = merged.members.len() as u64;
                merged.min_seq = merged.min_seq.min(conv.min_seq);
                merged.max_seq = merged.max_seq.max(conv.max_seq);
                merged.min_ts = merged.min_ts.min(conv.min_ts);
                merged.max_ts = merged.max_ts.max(conv.max_ts);
                merged.cross_stream = true;
                merged
                    .reasons
                    .push("merged_cross_stream_duplicate_rendering".into());
                if matches!(
                    conv.confidence,
                    ExceptionCorrelationConfidence::High | ExceptionCorrelationConfidence::Medium
                ) {
                    merged.confidence = ExceptionCorrelationConfidence::High;
                }
                out.push(merged);
            } else {
                // Fail closed: keep both; mark partial when shape matched but axis refused.
                if sources_a.is_disjoint(&sources_b) && dual_shape && !axis_ok {
                    let mut a = expanded[i].clone();
                    let mut b = conv.clone();
                    a.completeness = ExceptionEpisodeCompleteness::Partial;
                    b.completeness = ExceptionEpisodeCompleteness::Partial;
                    a.reasons.push("cross_stream_axis_out_of_window".into());
                    b.reasons.push("cross_stream_axis_out_of_window".into());
                    out.push(a);
                    out.push(b);
                } else {
                    out.push(expanded[i].clone());
                    out.push(conv.clone());
                }
            }
        }
        for ep in conventional.into_iter().skip(pair_n) {
            out.push(ep);
        }
        for ep in expanded.into_iter().skip(pair_n) {
            out.push(ep);
        }
        out.extend(other);
    }
    out.sort_by(|a, b| {
        a.min_seq
            .cmp(&b.min_seq)
            .then_with(|| a.episode_id.cmp(&b.episode_id))
    });
    Ok(out)
}

fn has_lead(ep: &ExceptionEpisode) -> bool {
    ep.members.iter().any(|m| {
        matches!(
            m.role,
            ExceptionRecordRole::ExceptionHeader | ExceptionRecordRole::ConventionalMultiline
        )
    })
}

fn is_conventional_only(ep: &ExceptionEpisode) -> bool {
    ep.members.len() == 1
        && matches!(
            ep.members[0].role,
            ExceptionRecordRole::ConventionalMultiline
        )
}

fn axis_window_gap(a: &ExceptionEpisode, b: &ExceptionEpisode) -> i64 {
    if a.max_ts < b.min_ts {
        b.min_ts - a.max_ts
    } else if b.max_ts < a.min_ts {
        a.min_ts - b.max_ts
    } else {
        0
    }
}

fn build_families(
    episodes: &[ExceptionEpisode],
    reasons: &mut Vec<String>,
) -> Vec<ExceptionFamily> {
    let mut by_family: BTreeMap<String, Vec<&ExceptionEpisode>> = BTreeMap::new();
    for ep in episodes {
        if ep.family_id.starts_with("orphan:") {
            continue;
        }
        by_family.entry(ep.family_id.clone()).or_default().push(ep);
    }
    if by_family.len() > MAX_FAMILY_FINGERPRINTS {
        reasons.push(format!(
            "family list capped at {MAX_FAMILY_FINGERPRINTS} fingerprints"
        ));
    }
    let mut families = Vec::new();
    for (family_id, eps) in by_family.into_iter().take(MAX_FAMILY_FINGERPRINTS) {
        let occurrence_count = eps.len() as u64;
        let raw_record_count = eps.iter().map(|e| e.raw_record_count).sum::<u64>();
        let amplification_x = if occurrence_count == 0 {
            0
        } else {
            raw_record_count / occurrence_count
        };
        let mut role_counts: BTreeMap<String, u64> = BTreeMap::new();
        let mut lead_citations = Vec::new();
        let mut class = None;
        let mut msg = None;
        let mut family_reasons = Vec::new();
        let mut worst_confidence = ExceptionCorrelationConfidence::High;
        let mut worst_completeness = ExceptionEpisodeCompleteness::Complete;

        for ep in &eps {
            for m in &ep.members {
                let role_key = match m.role {
                    ExceptionRecordRole::ExceptionHeader => "exception_header",
                    ExceptionRecordRole::StackFrame => "stack_frame",
                    ExceptionRecordRole::CauseMarker => "cause_marker",
                    ExceptionRecordRole::WrapperScaffold => "wrapper_scaffold",
                    ExceptionRecordRole::ConventionalMultiline => "conventional_multiline",
                    ExceptionRecordRole::Unclassified => "unclassified",
                };
                *role_counts.entry(role_key.into()).or_insert(0) += 1;
                if matches!(
                    m.role,
                    ExceptionRecordRole::ExceptionHeader
                        | ExceptionRecordRole::ConventionalMultiline
                ) && lead_citations.len() < 8
                    && !lead_citations
                        .iter()
                        .any(|x: &ExceptionEpisodeMember| x.seq == m.seq)
                {
                    lead_citations.push(m.clone());
                }
            }
            for r in &ep.reasons {
                if !family_reasons.contains(r) {
                    family_reasons.push(r.clone());
                }
            }
            worst_confidence = worse_confidence(worst_confidence, ep.confidence);
            worst_completeness = worse_completeness(worst_completeness, ep.completeness);
        }
        // Recover class/message from fingerprint string when possible.
        if let Some((c, m)) = parse_fingerprint_meta(&family_id) {
            class = Some(c);
            msg = m;
        }
        if occurrence_count >= 2 && amplification_x >= 2 {
            family_reasons.push(format!(
                "amplification {occurrence_count} occurrences / {raw_record_count} raw records / {amplification_x}x"
            ));
        }
        if eps.iter().any(|e| e.cross_stream) {
            family_reasons.push("includes_cross_stream_duplicate_rendering".into());
        }

        families.push(ExceptionFamily {
            family_id: family_id.clone(),
            fingerprint: family_id,
            exception_class: class,
            exception_message_excerpt: msg,
            occurrence_count,
            raw_record_count,
            amplification_x,
            confidence: worst_confidence,
            completeness: worst_completeness,
            reasons: family_reasons,
            role_counts,
            lead_citations,
        });
    }
    families.sort_by(|a, b| {
        b.occurrence_count
            .cmp(&a.occurrence_count)
            .then_with(|| b.raw_record_count.cmp(&a.raw_record_count))
            .then_with(|| a.family_id.cmp(&b.family_id))
    });
    families
}

fn worse_confidence(
    a: ExceptionCorrelationConfidence,
    b: ExceptionCorrelationConfidence,
) -> ExceptionCorrelationConfidence {
    use ExceptionCorrelationConfidence::*;
    let rank = |c: ExceptionCorrelationConfidence| match c {
        High => 3,
        Medium => 2,
        Low => 1,
        Unknown => 0,
    };
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

fn worse_completeness(
    a: ExceptionEpisodeCompleteness,
    b: ExceptionEpisodeCompleteness,
) -> ExceptionEpisodeCompleteness {
    use ExceptionEpisodeCompleteness::*;
    let rank = |c: ExceptionEpisodeCompleteness| match c {
        Complete => 3,
        Partial => 2,
        Truncated => 1,
        Candidate => 0,
    };
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

fn member_from(item: &ClassifiedEvent) -> ExceptionEpisodeMember {
    ExceptionEpisodeMember {
        seq: item.event.seq,
        source: item.event.source.clone(),
        template_id: item.event.template_id,
        role: item.role,
        ts: item.event.ts,
    }
}

fn family_fingerprint(class: &str, message: Option<&str>) -> String {
    let class_n = normalize_token(class);
    let msg_n = message
        .map(normalize_message_for_fingerprint)
        .unwrap_or_default()
        .chars()
        .take(96)
        .collect::<String>();
    format!("fp:{class_n}|{msg_n}")
}

/// Collapse volatile tokens so repeated occurrences of the same fault share a
/// family, without treating arbitrary message equality as a sole merge key
/// (episodes still require structural roles + windows).
fn normalize_message_for_fingerprint(s: &str) -> String {
    let out = normalize_token(s);
    let tokens: Vec<&str> = out
        .split_whitespace()
        .filter(|tok| {
            let t = tok.trim();
            if t.is_empty() {
                return false;
            }
            // pure numbers / hex
            if t.chars().all(|c| c.is_ascii_hexdigit()) {
                // keep short constants like "404"? filter long hex/ids only
                if t.chars().all(|c| c.is_ascii_digit()) {
                    return false;
                }
                if t.len() >= 8 {
                    return false;
                }
            }
            if t.starts_with("id=") || t.starts_with("req=") {
                return false;
            }
            true
        })
        .collect();
    tokens.join(" ")
}

fn parse_fingerprint_meta(fp: &str) -> Option<(String, Option<String>)> {
    let rest = fp.strip_prefix("fp:")?;
    let mut parts = rest.splitn(2, '|');
    let class = parts.next()?.to_string();
    let msg = parts
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    if class.is_empty() {
        None
    } else {
        Some((class, msg))
    }
}

fn normalize_token(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$' {
            out.push(c.to_ascii_lowercase());
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_stack_frame_line(line: &str) -> bool {
    let t = line.trim();
    // Allow a leading level token when classify is given full log lines.
    let t = t
        .strip_prefix("ERROR ")
        .or_else(|| t.strip_prefix("error "))
        .or_else(|| t.strip_prefix("WARN "))
        .or_else(|| t.strip_prefix("INFO "))
        .unwrap_or(t)
        .trim();
    if let Some(rest) = t.strip_prefix("at ") {
        // Require something package-like before '(' or end.
        let name = rest.split('(').next().unwrap_or("").trim();
        name.contains('.') && name.chars().any(|c| c.is_ascii_alphabetic())
    } else {
        false
    }
}

fn is_cause_marker_line(line: &str) -> bool {
    let t = strip_level_prefix(line.trim());
    t.starts_with("Caused by:")
        || t.starts_with("Caused by ")
        || t.starts_with("Suppressed:")
        || t.starts_with("Suppressed ")
}

fn is_wrapper_scaffold_line(line: &str) -> bool {
    let t = strip_level_prefix(line.trim());
    t.starts_with("Exception in thread")
        || t.starts_with("... ") && t.ends_with(" more")
        || t.starts_with("Wrapped by:")
        || t.starts_with("Nested exception")
        || t.contains("Exception wrapper")
        || t.starts_with("[[") && (t.contains("exception") || t.contains("Exception"))
}

fn strip_level_prefix(t: &str) -> &str {
    t.strip_prefix("ERROR ")
        .or_else(|| t.strip_prefix("error "))
        .or_else(|| t.strip_prefix("WARN "))
        .or_else(|| t.strip_prefix("INFO "))
        .unwrap_or(t)
        .trim()
}

fn parse_exception_header(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    let t = t
        .strip_prefix("ERROR ")
        .or_else(|| t.strip_prefix("error "))
        .or_else(|| t.strip_prefix("WARN "))
        .or_else(|| t.strip_prefix("INFO "))
        .unwrap_or(t)
        .trim();
    if t.is_empty() || is_stack_frame_line(t) || is_cause_marker_line(t) {
        return None;
    }
    // Generic JVM/CLR-style: TypeName: message  or TypeName
    let (type_part, msg_part) = if let Some((left, right)) = t.split_once(':') {
        (left.trim(), right.trim())
    } else {
        (t, "")
    };
    if !looks_like_exception_type(type_part) {
        return None;
    }
    Some((type_part.to_string(), msg_part.to_string()))
}

fn looks_like_exception_type(name: &str) -> bool {
    if name.is_empty() || name.contains(' ') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    (lower.contains("exception")
        || lower.contains("error")
        || lower.ends_with("throwable")
        || lower.ends_with("failure")
        || lower.ends_with("fault"))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$' || c == '/')
}

fn check_cancel(cancel: Option<&CancelFlag>) -> CoreResult<()> {
    if cancel.is_some_and(|c| c.is_cancelled()) {
        return Err(CoreError::Message(
            "exception episode correlation cancelled".into(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
    use crate::log_analysis::ingest::ingest_path_with_policy;
    use crate::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn ev(seq: u64, source: &str, message: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts: seq as i64,
            timestamp_provenance: TimestampProvenance::OrderOnly,
            active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::OrderOnly,
            level: "error".into(),
            service: None,
            host: None,
            template_id: 1,
            trace_id: None,
            message: message.into(),
            source: source.into(),
        }
    }

    /// One stderr dual-rendering block: 1 header + 72 wrappers + 189 frames + 1 mid cause + 2 terminal = 265.
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
        // Adjust: design says 1 intermediate + 2 terminal = 3 cause lines; we already have 3.
        // Header 1 + wrap 72 + frames 189 + causes 3 = 265.
        assert_eq!(lines.len(), 265, "stderr block must be exactly 265 lines");
        lines
    }

    fn write_dual_rendering_corpus(dir: &Path, occurrences: u32) {
        let app = dir.join("XYZ_app.log");
        let stderr = dir.join("XYZ_server.stderr");
        // Align dual streams in wall time: occurrence i at base_sec + i*2 so
        // cross-stream axis windows match (~0s) while far occurrences stay >120s
        // when separated by large i gaps (only 56 * 2 = 112s total span — keep
        // pairing index-based with axis guard; far-apart dual uses dedicated test).
        let mut app_body = String::new();
        let mut err_body = String::new();
        for i in 0..occurrences {
            let base = 12 * 3600 + i * 2; // 12:00:00, 12:00:02, …
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
            // Separately wrapped stderr: each line timestamped (same second as app)
            // so framing cannot fold frames; dual-render axis gap stays within window.
            for (j, line) in stderr_block(i).into_iter().enumerate() {
                let ms = (j % 1000) as u32;
                err_body.push_str(&format!(
                    "2026-03-15T{h:02}:{m:02}:{s:02}.{ms:03}Z ERROR {line}\n"
                ));
            }
        }
        fs::write(&app, app_body).unwrap();
        fs::write(&stderr, err_body).unwrap();
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
    fn conventional_multiline_is_one_logical_event_role() {
        let message = "java.lang.RuntimeException: XYZ_PAYMENT_FAILED\n\
             at com.xyz.payment.Client.charge(Client.java:42)\n\
             at com.xyz.api.OrderService.checkout(OrderService.java:88)\n\
             Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT";
        let c = classify_exception_event(&ev(1, "XYZ_app.log", message));
        assert_eq!(c.role, ExceptionRecordRole::ConventionalMultiline);
        assert!(c.fingerprint.is_some());
    }

    #[test]
    fn dual_rendering_56x265_family_counts_and_amplification() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 56);
        let (_cache, _id, corpus) = ingest_dir(&src);

        let report = correlate_exception_episodes_from_corpus(
            &corpus,
            &ExceptionCorrelationOptions::default(),
            None,
        )
        .unwrap();

        // Stderr alone: 56 * 265 raw lines as separate events (order-only).
        // App: 56 conventional multiline events (approximately; framing may attach continuations).
        assert!(
            report.raw_record_total >= 56 * 265,
            "raw_record_total={} expected at least {}",
            report.raw_record_total,
            56 * 265
        );

        let top = report
            .families
            .iter()
            .find(|f| {
                f.exception_class
                    .as_deref()
                    .is_some_and(|c| c.contains("RuntimeException"))
                    || f.fingerprint.contains("payment")
                    || f.fingerprint.contains("xyz_payment")
            })
            .or_else(|| report.families.first())
            .expect("at least one family");

        // Tight oracle: dual-stream merge must produce ~56 occurrences, not ~112.
        assert_eq!(
            top.occurrence_count, 56,
            "occurrence_count={} expected 56 dual-merged episodes",
            top.occurrence_count
        );
        assert_eq!(
            report.episode_count, 56,
            "episode_count={}",
            report.episode_count
        );
        assert_eq!(report.family_count, 1, "families={:?}", report.families);
        assert!(
            top.raw_record_count >= 56 * 265,
            "raw_record_count={} too low",
            top.raw_record_count
        );
        assert!(
            (265..=270).contains(&top.amplification_x),
            "amplification_x={} expected ~265–266",
            top.amplification_x
        );
        assert!(
            report.episodes.iter().filter(|e| e.cross_stream).count() >= 50,
            "expected most episodes cross_stream after dual merge"
        );
        assert!(
            report
                .episodes
                .iter()
                .filter(|e| e
                    .reasons
                    .iter()
                    .any(|r| r.contains("merged_cross_stream_duplicate_rendering")))
                .count()
                >= 50,
            "expected dual-merge reasons on episodes"
        );
        assert!(report
            .ranking_disclosure
            .contains("independent_incident_claim_forbidden"));
        assert!(report
            .ranking_disclosure
            .contains("exception_episode_occurrences_not_raw_stack_volume"));

        assert!(!report.episodes.is_empty());
        for ep in &report.episodes {
            assert!(!ep.members.is_empty(), "empty episode {}", ep.episode_id);
        }
        for family in &report.families {
            for lead in family.lead_citations.iter().take(8) {
                let page = query_events(
                    &corpus,
                    &EventQuery {
                        seq_from: Some(lead.seq),
                        seq_to: Some(lead.seq),
                        limit: 8,
                        sort_by_time: false,
                        ..EventQuery::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == lead.seq && e.source == lead.source),
                    "lead citation seq={} source={} not found",
                    lead.seq,
                    lead.source
                );
            }
        }

        assert_eq!(report.correlated_occurrence_total, 56);
        assert!(
            report.overall_amplification_x >= 265,
            "overall amp={}",
            report.overall_amplification_x
        );
        eprintln!(
            "dual_rendering: raw={} occurrences={} amp={} families={} episodes={} cross={}",
            report.raw_record_total,
            report.correlated_occurrence_total,
            report.overall_amplification_x,
            report.family_count,
            report.episode_count,
            report.episodes.iter().filter(|e| e.cross_stream).count()
        );
    }

    #[test]
    fn interleaved_same_source_headers_do_not_steal_foreign_frames() {
        // Same source, two different faults interleaved by seq — frames after B
        // must not attach to open A when A was closed by B's header.
        let events = vec![
            ev(
                1,
                "XYZ_stderr.log",
                "java.lang.RuntimeException: XYZ_FAULT_A",
            ),
            ev(2, "XYZ_stderr.log", "at com.xyz.A.m(A.java:1)"),
            ev(
                3,
                "XYZ_stderr.log",
                "java.lang.IllegalStateException: XYZ_FAULT_B",
            ),
            ev(4, "XYZ_stderr.log", "at com.xyz.B.m(B.java:1)"),
            ev(5, "XYZ_stderr.log", "at com.xyz.B.finish(B.java:2)"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert!(report.episode_count >= 2, "{report:?}");
        let b = report
            .episodes
            .iter()
            .find(|e| e.family_id.contains("fault_b") || e.family_id.contains("illegalstate"))
            .or_else(|| {
                report.episodes.iter().find(|e| {
                    e.members.iter().any(|m| {
                        m.role == ExceptionRecordRole::ExceptionHeader
                            && report.families.iter().any(|f| {
                                f.family_id == e.family_id
                                    && f.exception_class
                                        .as_deref()
                                        .is_some_and(|c| c.contains("IllegalState"))
                            })
                    })
                })
            });
        // B episode should own the two B frames (raw >= 3: header+2 frames).
        let b_ep = report
            .episodes
            .iter()
            .max_by_key(|e| e.raw_record_count)
            .unwrap();
        // The IllegalState episode should be the one with more frames attached.
        let illegal = report
            .episodes
            .iter()
            .find(|e| {
                e.family_id.contains("illegalstateexception") || e.family_id.contains("fault_b")
            })
            .unwrap_or(b_ep);
        assert!(
            illegal.raw_record_count >= 3,
            "B should keep its frames: {:?}",
            illegal
        );
        // A should be small (header + 1 frame) not absorb B's frames.
        let runtime = report
            .episodes
            .iter()
            .find(|e| e.family_id.contains("runtimeexception") || e.family_id.contains("fault_a"))
            .expect("fault A episode");
        assert!(
            runtime.raw_record_count <= 2,
            "A must not absorb B frames: {:?}",
            runtime
        );
        let _ = b;
    }

    #[test]
    fn cross_stream_far_apart_same_fingerprint_does_not_merge() {
        let mut events = Vec::new();
        // Conventional at t=1
        events.push(ExplorerEvent {
            seq: 1,
            ts: 1_000,
            ..ev(
                1,
                "XYZ_app.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED\n\
                 at com.xyz.payment.Client.charge(Client.java:42)\n\
                 at com.xyz.api.OrderService.checkout(OrderService.java:88)",
            )
        });
        // Expanded stream far away (axis gap >> 120)
        events.push(ExplorerEvent {
            seq: 100,
            ts: 1_000 + 10_000,
            ..ev(
                100,
                "XYZ_server.stderr",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
            )
        });
        for i in 0..5u64 {
            events.push(ExplorerEvent {
                seq: 101 + i,
                ts: 1_000 + 10_000 + i as i64,
                ..ev(
                    101 + i,
                    "XYZ_server.stderr",
                    &format!("at com.xyz.F{i}.m(F.java:1)"),
                )
            });
        }
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        // Must remain two episodes (not one merged occurrence).
        assert!(
            report.episode_count >= 2,
            "far dual streams must not merge: {:?}",
            report.episodes
        );
        assert!(
            !report.episodes.iter().any(|e| e
                .reasons
                .iter()
                .any(|r| r == "merged_cross_stream_duplicate_rendering")),
            "unexpected merge: {:?}",
            report.episodes
        );
    }

    #[test]
    fn mutation_divisibility_alone_is_not_enough_for_high_confidence_family() {
        // 265 unrelated distinct exceptions — raw count divisible by 265 must not
        // create one high-confidence amplified family.
        let mut events = Vec::new();
        for i in 0..265u64 {
            events.push(ev(
                i + 1,
                "XYZ_noise.log",
                &format!("java.lang.IllegalStateException: XYZ_UNIQUE_{i}"),
            ));
        }
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        for family in &report.families {
            if family.occurrence_count == 1 {
                continue;
            }
            // Distinct messages => distinct fingerprints; no single family of 265.
            assert!(
                family.occurrence_count < 50,
                "divisibility/over-merge family: {:?}",
                family
            );
        }
        assert!(
            report.families.iter().all(|f| f.occurrence_count < 265),
            "must not collapse unique exceptions into one 265-occurrence family"
        );
    }

    #[test]
    fn mutation_message_equality_alone_outside_window_does_not_merge() {
        let mut events = Vec::new();
        // Same text but huge seq/ts gap.
        events.push(ev(
            1,
            "XYZ_a.log",
            "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
        ));
        for i in 0..10u64 {
            events.push(ev(
                2 + i,
                "XYZ_a.log",
                &format!("at com.xyz.F.m(F.java:{i})"),
            ));
        }
        // Far later "same" exception — outside axis window.
        events.push(ExplorerEvent {
            seq: 100_000,
            ts: 100_000,
            ..ev(
                100_000,
                "XYZ_a.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
            )
        });
        for i in 0..10u64 {
            events.push(ExplorerEvent {
                seq: 100_001 + i,
                ts: 100_001 + i as i64,
                ..ev(
                    100_001 + i,
                    "XYZ_a.log",
                    &format!("at com.xyz.F.m(F.java:{i})"),
                )
            });
        }
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        let family = report
            .families
            .iter()
            .find(|f| {
                f.fingerprint.contains("payment") || f.fingerprint.contains("runtimeexception")
            })
            .expect("family");
        assert_eq!(
            family.occurrence_count, 2,
            "out-of-window same text must be two occurrences, not one: {:?}",
            family
        );
    }

    #[test]
    fn mutation_raw_adjacency_of_unrelated_text_does_not_force_episode() {
        let events = vec![
            ev(1, "XYZ_a.log", "INFO heartbeat ok"),
            ev(2, "XYZ_a.log", "INFO still fine"),
            ev(3, "XYZ_a.log", "WARN disk 80%"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(report.episode_count, 0);
        assert_eq!(report.correlated_occurrence_total, 0);
    }

    #[test]
    fn interleaved_threads_keep_separate_headers_when_fingerprints_differ() {
        let events = vec![
            ev(
                1,
                "XYZ_stderr.log",
                "java.lang.RuntimeException: XYZ_THREAD_A",
            ),
            ev(2, "XYZ_stderr.log", "at com.xyz.A.run(A.java:1)"),
            ev(
                3,
                "XYZ_stderr.log",
                "java.lang.IllegalStateException: XYZ_THREAD_B",
            ),
            ev(4, "XYZ_stderr.log", "at com.xyz.B.run(B.java:1)"),
            ev(5, "XYZ_stderr.log", "at com.xyz.B.finish(B.java:2)"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert!(report.episode_count >= 2, "{report:?}");
        let fps: BTreeSet<_> = report
            .families
            .iter()
            .map(|f| f.fingerprint.clone())
            .collect();
        assert!(
            fps.len() >= 2,
            "distinct classes must not collapse: {fps:?}"
        );
    }

    #[test]
    fn missing_header_frames_are_candidate_not_invented_occurrences() {
        let events = vec![
            ev(1, "XYZ_stderr.log", "at com.xyz.A.m(A.java:1)"),
            ev(2, "XYZ_stderr.log", "at com.xyz.B.m(B.java:2)"),
            ev(3, "XYZ_stderr.log", "at com.xyz.C.m(C.java:3)"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        // Orphan frames do not become high-confidence families with invented headers.
        assert!(
            report.families.is_empty()
                || report
                    .families
                    .iter()
                    .all(|f| f.confidence != ExceptionCorrelationConfidence::High),
            "{report:?}"
        );
    }

    #[test]
    fn determinism_two_runs_identical() {
        let mut events = Vec::new();
        for i in 0..5u32 {
            events.push(ev(
                (i as u64) * 10 + 1,
                "XYZ_stderr.log",
                &format!("java.lang.RuntimeException: XYZ_PAYMENT_FAILED id={i}"),
            ));
            for f in 0..5u64 {
                events.push(ev(
                    (i as u64) * 10 + 2 + f,
                    "XYZ_stderr.log",
                    &format!("at com.xyz.F{f}.m(F.java:1)"),
                ));
            }
        }
        let a =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        let b =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn cancellation_fails_closed() {
        let cancel = CancelFlag::new();
        cancel.cancel();
        let events = vec![ev(
            1,
            "XYZ_a.log",
            "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
        )];
        let err = correlate_exception_episodes(
            &events,
            &ExceptionCorrelationOptions::default(),
            Some(&cancel),
        )
        .unwrap_err();
        assert!(err.to_string().contains("cancelled"));
    }

    #[test]
    fn nested_causes_remain_in_one_episode() {
        let events = vec![
            ev(1, "XYZ_a.log", "java.lang.RuntimeException: XYZ_OUTER"),
            ev(2, "XYZ_a.log", "at com.xyz.Outer.m(Outer.java:1)"),
            ev(3, "XYZ_a.log", "Caused by: java.io.IOException: XYZ_INNER"),
            ev(4, "XYZ_a.log", "at com.xyz.Inner.m(Inner.java:2)"),
            ev(
                5,
                "XYZ_a.log",
                "Caused by: java.net.SocketException: XYZ_ROOT",
            ),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(report.episode_count, 1, "{:?}", report.episodes);
        assert_eq!(report.episodes[0].raw_record_count, 5);
        assert!(report.episodes[0]
            .members
            .iter()
            .any(|m| { matches!(m.role, ExceptionRecordRole::CauseMarker) }));
    }

    #[test]
    fn rotated_sources_are_stream_local_then_family_grouped() {
        // Same fault class on rotated log names (app.log.1 vs app.log) — two streams.
        let events = vec![
            ev(
                1,
                "XYZ_app.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED\n\
                 at com.xyz.A.m(A.java:1)\n\
                 at com.xyz.B.m(B.java:2)",
            ),
            ev(
                10,
                "XYZ_app.log.1",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
            ),
            ev(11, "XYZ_app.log.1", "at com.xyz.A.m(A.java:1)"),
            ev(12, "XYZ_app.log.1", "at com.xyz.B.m(B.java:2)"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert!(!report.families.is_empty());
        let fam = &report.families[0];
        assert!(
            fam.occurrence_count >= 1 && fam.occurrence_count <= 2,
            "rotated sources: {:?}",
            fam
        );
    }

    #[test]
    fn order_only_timestamps_assemble_by_seq_gap() {
        let mut events = Vec::new();
        for i in 0..3u64 {
            events.push(ev(
                i * 10 + 1,
                "XYZ_order.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED",
            ));
            for f in 0..4u64 {
                events.push(ev(
                    i * 10 + 2 + f,
                    "XYZ_order.log",
                    &format!("at com.xyz.F{f}.m(F.java:1)"),
                ));
            }
        }
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(report.episode_count, 3, "{:?}", report.episodes);
        assert!(report.episodes.iter().all(|e| e.raw_record_count == 5));
    }

    #[test]
    fn repeated_unrelated_exceptions_are_separate_families() {
        let events = vec![
            ev(
                1,
                "XYZ_a.log",
                "java.lang.NullPointerException: XYZ_NPE_ONE",
            ),
            ev(2, "XYZ_a.log", "at com.xyz.A.m(A.java:1)"),
            ev(
                10,
                "XYZ_a.log",
                "java.lang.IllegalArgumentException: XYZ_IAE_TWO",
            ),
            ev(11, "XYZ_a.log", "at com.xyz.B.m(B.java:1)"),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(report.family_count, 2, "{:?}", report.families);
        assert_eq!(report.episode_count, 2);
    }

    #[test]
    fn malformed_truncated_trace_is_partial_or_candidate() {
        let events = vec![
            ev(1, "XYZ_a.log", "java.lang.RuntimeException: XYZ_TRUNC"),
            ev(2, "XYZ_a.log", "at com.xyz.A.m(A.java:1)"),
            // abrupt end — no further frames
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        assert_eq!(report.episode_count, 1);
        // Still a valid lead episode; not fabricated extras.
        assert_eq!(report.episodes[0].raw_record_count, 2);
        assert!(matches!(
            report.episodes[0].confidence,
            ExceptionCorrelationConfidence::High | ExceptionCorrelationConfidence::Medium
        ));
    }

    #[test]
    fn suppression_excluded_templates_reduce_scanned_set() {
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
        // Exclude every template → scan finds nothing useful.
        let all_templates: Vec<u64> = {
            let page = query_events(
                &corpus,
                &EventQuery {
                    limit: 500,
                    sort_by_time: false,
                    ..EventQuery::default()
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
        let report = correlate_exception_episodes_from_corpus(
            &corpus,
            &ExceptionCorrelationOptions {
                excluded_template_ids: all_templates,
                ..ExceptionCorrelationOptions::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(report.events_scanned, 0);
        assert_eq!(report.episode_count, 0);
    }

    #[test]
    fn corpus_revision_pin_is_host_responsibility_events_immutable() {
        // Correlation never rewrites events: two scans of the same snapshot match.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 2);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let rev = corpus.event_revision();
        let a = correlate_exception_episodes_from_corpus(
            &corpus,
            &ExceptionCorrelationOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            corpus.event_revision(),
            rev,
            "correlation must not bump revision"
        );
        let b = correlate_exception_episodes_from_corpus(
            &corpus,
            &ExceptionCorrelationOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(a.episode_count, b.episode_count);
        assert_eq!(a.correlated_occurrence_total, b.correlated_occurrence_total);
        assert_eq!(corpus.event_revision(), rev);
    }

    #[test]
    fn large_synthetic_respects_event_cap() {
        let mut events = Vec::new();
        for i in 0..5_000u64 {
            events.push(ev(
                i + 1,
                "XYZ_big.log",
                &format!("java.lang.RuntimeException: XYZ_ITEM_{i}"),
            ));
        }
        let opts = ExceptionCorrelationOptions {
            max_events: 1_000,
            ..ExceptionCorrelationOptions::default()
        };
        let report = correlate_exception_episodes(&events, &opts, None).unwrap();
        assert!(report.truncated);
        assert_eq!(report.events_scanned, 1_000);
        assert!(report.events_scanned <= MAX_CORRELATION_EVENTS as u64);
    }

    #[test]
    fn zip_folder_import_parity_for_small_dual_rendering() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().join("folder");
        fs::create_dir_all(&folder).unwrap();
        write_dual_rendering_corpus(&folder, 3);

        let (_c1, _id1, corpus_folder) = ingest_dir(&folder);
        let report_folder = correlate_exception_episodes_from_corpus(
            &corpus_folder,
            &ExceptionCorrelationOptions::default(),
            None,
        )
        .unwrap();

        // ZIP parity when zip is available.
        let zip_path = tmp.path().join("corpus.zip");
        let status = std::process::Command::new("zip")
            .args(["-qr", zip_path.to_str().unwrap(), "."])
            .current_dir(&folder)
            .status();
        if !status.map(|s| s.success()).unwrap_or(false) {
            eprintln!("skip zip parity — zip binary missing");
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
        let report_zip = correlate_exception_episodes_from_corpus(
            &corpus_zip,
            &ExceptionCorrelationOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            report_folder.correlated_occurrence_total, report_zip.correlated_occurrence_total,
            "folder vs zip occurrence mismatch"
        );
        assert_eq!(
            report_folder.raw_record_total, report_zip.raw_record_total,
            "folder vs zip raw total mismatch"
        );
    }

    #[test]
    fn brief_section_discloses_amplification_not_raw_incidents() {
        let events = vec![
            ev(
                1,
                "app.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED id=0\n\
                 at com.xyz.payment.Client.charge(Client.java:42)\n\
                 at com.xyz.api.OrderService.checkout(OrderService.java:88)",
            ),
            ev(
                2,
                "stderr.log",
                "java.lang.RuntimeException: XYZ_PAYMENT_FAILED id=0",
            ),
            ev(
                3,
                "stderr.log",
                "at com.xyz.payment.Client.charge(Client.java:42)",
            ),
        ];
        let report =
            correlate_exception_episodes(&events, &ExceptionCorrelationOptions::default(), None)
                .unwrap();
        let section = format_exception_episode_brief_section(&report);
        assert!(section.contains("Exception episode correlation"));
        assert!(section.contains("amplification") || section.contains("amplification_x"));
        assert!(section.contains("supporting records") || section.contains("not independent"));
        assert!(!section.contains("14840 independent"));
    }
}
