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

/// Maximum events inspected in one analysis.
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

/// Physical rendering shape found in the event store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionRenderingKind {
    /// One durable event already holds a full stack (conventional multiline).
    ApplicationFullStack,
    /// Separately wrapped/emitted records (`[stderr]` or per-line timestamp stream).
    SeparatelyWrappedRecords,
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

/// Bounded family of occurrences sharing one normalized root signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFamilySummary {
    /// Normalized root signature.
    pub signature: String,
    /// Sum of raw records across occurrences.
    pub raw_record_count: u64,
    /// Sum of physical renderings across occurrences.
    pub rendering_episode_count: u64,
    /// Semantic occurrence count (never invented).
    pub occurrence_count: u64,
    /// Occurrences that include duplicate renderings.
    pub duplicate_rendering_occurrence_count: u64,
    /// Occurrences with incomplete citations or non-strong duplicates.
    pub uncertain_occurrence_count: u64,
    /// Amplification: raw_record_count / max(1, occurrence_count).
    pub amplification_x: u64,
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
    /// Events available under the suppression filter.
    pub events_available: u64,
    /// Events actually scanned.
    pub events_scanned: u64,
    /// Configured scan cap.
    pub event_scan_cap: usize,
    /// Raw exception-related records retained in renderings.
    pub raw_exception_record_count: u64,
    /// Physical rendering count.
    pub rendering_episode_count: u64,
    /// Semantic occurrence count.
    pub occurrence_count: u64,
    /// Occurrences with duplicate renderings.
    pub duplicate_rendering_occurrence_count: u64,
    /// Families before family cap.
    pub family_count_available: u64,
    /// Family output cap.
    pub family_cap: usize,
    /// Overall amplification across all occurrences.
    pub overall_amplification_x: u64,
    /// True when any cap truncated work.
    pub partial: bool,
    /// True when any occurrence is uncertain.
    pub uncertain: bool,
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
    let filter = EventQuery {
        excluded_template_ids: excluded_template_ids.to_vec(),
        sort_by_time: false,
        ..Default::default()
    };
    let events_available = query_event_count(corpus, &filter)?.total_matched;
    let mut events = Vec::new();
    let mut after_seq = None;
    while events.len() < EXCEPTION_EPISODE_EVENT_SCAN_CAP {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(CoreError::Cancelled);
        }
        let remaining = EXCEPTION_EPISODE_EVENT_SCAN_CAP - events.len();
        let page = query_event_rows(
            corpus,
            &EventQuery {
                after_seq,
                limit: remaining.min(MAX_EVENT_PAGE),
                ..filter.clone()
            },
        )?;
        if page.events.is_empty() {
            break;
        }
        after_seq = page.events.last().map(|event| event.seq);
        let full_page = page.events.len() == remaining.min(MAX_EVENT_PAGE);
        events.extend(page.events);
        if !full_page {
            break;
        }
    }
    Ok(analyze_bounded_events(events_available, &events))
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
    let (renderings, render_partial) = derive_render_episodes(events);
    let raw_exception_record_count = renderings
        .iter()
        .map(|rendering| rendering.citations.len() as u64)
        .sum();
    let rendering_episode_count = renderings.len() as u64;
    let occurrences = correlate_renderings(renderings);
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
            let amplification_x = if occurrence_count == 0 {
                0
            } else {
                raw_record_count / occurrence_count
            };
            ExceptionFamilySummary {
                signature,
                raw_record_count,
                rendering_episode_count,
                occurrence_count,
                duplicate_rendering_occurrence_count,
                uncertain_occurrence_count,
                amplification_x,
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

    let overall_amplification_x = if occurrence_count == 0 {
        0
    } else {
        raw_exception_record_count / occurrence_count
    };

    let scan_partial = events_available > events.len() as u64;
    let partial = scan_partial
        || render_partial
        || family_count_available > EXCEPTION_EPISODE_FAMILY_CAP as u64;

    let ranking_disclosure = format!(
        "ranking_basis: semantic_occurrence_count_not_raw_stack_volume\n\
         layer_raw_exception_records: {raw_exception_record_count}\n\
         layer_physical_renderings: {rendering_episode_count}\n\
         layer_semantic_occurrences: {occurrence_count}\n\
         layer_duplicate_rendering_occurrences: {duplicate_rendering_occurrence_count}\n\
         overall_amplification_x: {overall_amplification_x}\n\
         independent_incident_claim_forbidden: true\n\
         interpretation: wrappers and stack frames are supporting records of a rendering; \
         duplicate renderings are correlated only with multi-signal evidence; \
         order-only cross-source merge requires a strong execution key (thread or trace_id).\n"
    );

    ExceptionEpisodeAnalysis {
        schema_id: EXCEPTION_EPISODE_SCHEMA_ID.into(),
        schema_version: EXCEPTION_EPISODE_SCHEMA_VERSION,
        events_available,
        events_scanned: events.len() as u64,
        event_scan_cap: EXCEPTION_EPISODE_EVENT_SCAN_CAP,
        raw_exception_record_count,
        rendering_episode_count,
        occurrence_count,
        duplicate_rendering_occurrence_count,
        family_count_available,
        family_cap: EXCEPTION_EPISODE_FAMILY_CAP,
        overall_amplification_x,
        partial,
        uncertain,
        ranking_disclosure,
        families,
    }
}

/// Compact multi-line text for broad-triage brief inclusion.
pub fn format_exception_episode_brief_section(report: &ExceptionEpisodeAnalysis) -> String {
    let mut out = String::new();
    out.push_str("## Exception episode correlation\n");
    out.push_str(&format!(
        "schema_id: {}\nschema_version: {}\n\
         events_available: {}\nevents_scanned: {}\n\
         raw_exception_record_count: {}\n\
         physical_rendering_count: {}\n\
         semantic_occurrence_count: {}\n\
         duplicate_rendering_occurrence_count: {}\n\
         overall_amplification_x: {}\n\
         partial: {}\nuncertain: {}\n",
        report.schema_id,
        report.schema_version,
        report.events_available,
        report.events_scanned,
        report.raw_exception_record_count,
        report.rendering_episode_count,
        report.occurrence_count,
        report.duplicate_rendering_occurrence_count,
        report.overall_amplification_x,
        report.partial,
        report.uncertain
    ));
    out.push_str(&report.ranking_disclosure);
    out.push('\n');
    for family in report.families.iter().take(8) {
        out.push_str(&format!(
            "- signature={} occurrences={} raw_records={} renderings={} amplification_x={} duplicates={}\n",
            family.signature,
            family.occurrence_count,
            family.raw_record_count,
            family.rendering_episode_count,
            family.amplification_x,
            family.duplicate_rendering_occurrence_count
        ));
        for occ in family.occurrences.iter().take(2) {
            out.push_str(&format!(
                "  occurrence raw={} renderings={} duplicate={} confidence={:?}\n",
                occ.raw_record_count,
                occ.rendering_count,
                occ.duplicate_rendering,
                occ.correlation_confidence
            ));
            for c in occ.citations.iter().take(4) {
                out.push_str(&format!(
                    "    cite seq={} source={} template_id={}\n",
                    c.seq, c.source, c.template_id
                ));
            }
        }
    }
    out.push_str(
        "interpretation: do not treat raw stack-frame volume as independent incidents; \
         prefer semantic_occurrence_count and disclosed amplification.\n",
    );
    out
}

// ---------------------------------------------------------------------------
// Layer 2: physical renderings
// ---------------------------------------------------------------------------

fn derive_render_episodes(events: &[ExplorerEvent]) -> (Vec<RenderEpisode>, bool) {
    let mut episodes = Vec::new();
    // Per-source open separately-wrapped rendering (no global open).
    let mut open_wrap: BTreeMap<String, RenderEpisode> = BTreeMap::new();
    let mut partial = false;

    for event in events {
        let source = event.source.clone();
        let stderr = stderr_payload(&event.message);
        let payload = stderr.unwrap_or(event.message.as_str());
        let is_wrapped_line = stderr.is_some() || is_single_line_exception_record(event, payload);

        if is_wrapped_line {
            let signature = exception_signature(payload);
            let complete_stack = has_stack_frame(payload) && signature.is_some();
            if complete_stack {
                // Full stack arrived as one separately-wrapped payload.
                if let Some(open) = open_wrap.remove(&source) {
                    finish_episode(&mut episodes, Some(open), &mut partial);
                }
                if let Some(signature) = signature {
                    finish_episode(
                        &mut episodes,
                        Some(new_episode(
                            event,
                            signature,
                            ExceptionRenderingKind::SeparatelyWrappedRecords,
                        )),
                        &mut partial,
                    );
                }
            } else if let Some(signature) = signature {
                let is_cause = payload.trim_start().starts_with("Caused by:");
                let can_attach = open_wrap
                    .get(&source)
                    .is_some_and(|open| adjacent_compatible(open, event));
                if is_cause && can_attach {
                    let open = open_wrap.get_mut(&source).expect("checked");
                    attach(open, event);
                    // Prefer root-cause signature (matches app full-stack last exception).
                    open.signature = signature;
                } else if can_attach
                    && open_wrap
                        .get(&source)
                        .is_some_and(|o| o.signature == signature || is_stack_continuation(payload))
                {
                    // Same signature header re-open should finish prior and start new.
                    if looks_like_exception_header_line(payload)
                        && open_wrap
                            .get(&source)
                            .is_some_and(|o| o.signature != signature)
                    {
                        if let Some(open) = open_wrap.remove(&source) {
                            finish_episode(&mut episodes, Some(open), &mut partial);
                        }
                        open_wrap.insert(
                            source.clone(),
                            new_episode(
                                event,
                                signature,
                                ExceptionRenderingKind::SeparatelyWrappedRecords,
                            ),
                        );
                    } else if looks_like_exception_header_line(payload) {
                        // New header same stream → finish previous episode.
                        if let Some(open) = open_wrap.remove(&source) {
                            finish_episode(&mut episodes, Some(open), &mut partial);
                        }
                        open_wrap.insert(
                            source.clone(),
                            new_episode(
                                event,
                                signature,
                                ExceptionRenderingKind::SeparatelyWrappedRecords,
                            ),
                        );
                    } else if let Some(open) = open_wrap.get_mut(&source) {
                        attach(open, event);
                    }
                } else {
                    if let Some(open) = open_wrap.remove(&source) {
                        finish_episode(&mut episodes, Some(open), &mut partial);
                    }
                    open_wrap.insert(
                        source.clone(),
                        new_episode(
                            event,
                            signature,
                            ExceptionRenderingKind::SeparatelyWrappedRecords,
                        ),
                    );
                }
            } else if open_wrap
                .get(&source)
                .is_some_and(|open| adjacent_compatible(open, event))
                && (is_stack_continuation(payload) || is_wrapper_scaffold_line(payload))
            {
                // Frames and wrapper scaffolding attach without inventing a new signature.
                if let Some(open) = open_wrap.get_mut(&source) {
                    attach(open, event);
                }
            } else if open_wrap.get(&source).is_some_and(|open| {
                event.seq.saturating_sub(open.last_seq()) > MAX_ADJACENT_SEQ_GAP
            }) {
                if let Some(open) = open_wrap.remove(&source) {
                    finish_episode(&mut episodes, Some(open), &mut partial);
                }
            }
            continue;
        }

        // Non-wrapped: close any open wrap on this source, then maybe full-stack app record.
        if let Some(open) = open_wrap.remove(&source) {
            finish_episode(&mut episodes, Some(open), &mut partial);
        }
        if has_stack_frame(&event.message) {
            if let Some(signature) = exception_signature(&event.message) {
                finish_episode(
                    &mut episodes,
                    Some(new_episode(
                        event,
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
    (episodes, partial)
}

fn is_single_line_exception_record(event: &ExplorerEvent, payload: &str) -> bool {
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
        || (event.level.eq_ignore_ascii_case("error")
            && (p.starts_with("at ") || looks_like_exception_header_line(p)))
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
    signature: String,
    kind: ExceptionRenderingKind,
) -> RenderEpisode {
    RenderEpisode {
        signature,
        kind,
        source: event.source.clone(),
        service: event.service.clone(),
        host: event.host.clone(),
        thread: extract_thread(&event.message),
        trace_id: event.trace_id.clone(),
        first_ts: event.ts,
        last_ts: event.ts,
        wall_time: event.active_timestamp_basis.is_wall_clock(),
        citations: vec![citation(event)],
        complete: true,
    }
}

fn attach(episode: &mut RenderEpisode, event: &ExplorerEvent) {
    if episode.citations.len() >= EXCEPTION_EPISODE_RECORD_CAP {
        episode.complete = false;
        return;
    }
    episode.last_ts = event.ts;
    if episode.thread.is_none() {
        episode.thread = extract_thread(&event.message);
    }
    if episode.trace_id.is_none() {
        episode.trace_id = event.trace_id.clone();
    }
    episode.citations.push(citation(event));
}

fn citation(event: &ExplorerEvent) -> ExceptionEventCitation {
    ExceptionEventCitation {
        seq: event.seq,
        source: event.source.clone(),
        template_id: event.template_id,
    }
}

fn adjacent_compatible(episode: &RenderEpisode, event: &ExplorerEvent) -> bool {
    if episode.source != event.source
        || event.seq.saturating_sub(episode.last_seq()) > MAX_ADJACENT_SEQ_GAP
    {
        return false;
    }
    let thread = extract_thread(&event.message);
    if episode.thread.is_some() && thread.is_some() && episode.thread != thread {
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

fn correlate_renderings(
    renderings: Vec<RenderEpisode>,
) -> Vec<(String, ExceptionOccurrenceSummary)> {
    let mut occurrences: Vec<(String, Vec<RenderEpisode>, ExceptionCorrelationConfidence)> =
        Vec::new();
    for rendering in renderings {
        let candidate = occurrences.iter_mut().rev().find(|(signature, group, _)| {
            signature == &rendering.signature
                && group
                    .last()
                    .is_some_and(|prior| duplicate_evidence(prior, &rendering).is_some())
        });
        if let Some((_, group, confidence)) = candidate {
            if let Some(next_confidence) = group
                .last()
                .and_then(|prior| duplicate_evidence(prior, &rendering))
            {
                *confidence = stronger_confidence(*confidence, next_confidence);
                group.push(rendering);
                continue;
            }
        }
        occurrences.push((
            rendering.signature.clone(),
            vec![rendering],
            ExceptionCorrelationConfidence::Uncorrelated,
        ));
    }

    occurrences
        .into_iter()
        .map(|(signature, renderings, confidence)| {
            let mut citations = Vec::new();
            let mut seen = HashSet::new();
            let mut kinds = Vec::new();
            let mut complete = true;
            for rendering in &renderings {
                complete &= rendering.complete;
                if !kinds.contains(&rendering.kind) {
                    kinds.push(rendering.kind);
                }
                for citation in &rendering.citations {
                    if seen.insert(citation.clone()) {
                        citations.push(citation.clone());
                    }
                }
            }
            citations.sort_by_key(|citation| citation.seq);
            let first_seq = citations.first().map_or(0, |c| c.seq);
            let last_seq = citations.last().map_or(0, |c| c.seq);
            let summary = ExceptionOccurrenceSummary {
                first_seq,
                last_seq,
                raw_record_count: citations.len() as u64,
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
            };
            (signature, summary)
        })
        .collect()
}

fn stronger_confidence(
    a: ExceptionCorrelationConfidence,
    b: ExceptionCorrelationConfidence,
) -> ExceptionCorrelationConfidence {
    use ExceptionCorrelationConfidence::*;
    match (a, b) {
        (Strong, _) | (_, Strong) => Strong,
        (Moderate, _) | (_, Moderate) => Moderate,
        _ => Uncorrelated,
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

    let left_key = left.strong_execution_key();
    let right_key = right.strong_execution_key();
    let matching_execution_key = matches!((&left_key, &right_key), (Some(a), Some(b)) if a == b);
    let conflicting_execution_key = matches!((&left_key, &right_key), (Some(a), Some(b)) if a != b);
    if conflicting_execution_key {
        return None;
    }

    let both_wall = left.wall_time && right.wall_time;
    let wall_gap = left.last_ts.abs_diff(right.first_ts).min(
        left.first_ts
            .abs_diff(right.last_ts)
            .min(left.first_ts.abs_diff(right.first_ts)),
    );
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
// Signatures / payloads
// ---------------------------------------------------------------------------

fn stderr_payload(message: &str) -> Option<&str> {
    let position = message.find("[stderr]")?;
    if position > 256 {
        return None;
    }
    message.get(position + "[stderr]".len()..).map(str::trim)
}

fn has_stack_frame(message: &str) -> bool {
    message.lines().skip(1).any(is_stack_continuation)
}

fn is_stack_continuation(line: &str) -> bool {
    let line = line.trim();
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
        .unwrap_or(line)
        .trim();
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

fn extract_thread(message: &str) -> Option<String> {
    for key in ["thread=", "thread_id=", "threadId=", "tid="] {
        if let Some(start) = message.find(key) {
            let value = message.get(start + key.len()..).unwrap_or_default();
            let value = value
                .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ']' | ';'))
                .next()
                .unwrap_or_default()
                .trim_matches(['\"', '\'']);
            if !value.is_empty() {
                return Some(value.chars().take(96).collect());
            }
        }
    }
    for bracketed in message.split('[').skip(1) {
        let Some((value, _)) = bracketed.split_once(']') else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty()
            && !matches!(
                value.to_ascii_lowercase().as_str(),
                "stderr" | "stdout" | "error" | "warn" | "info" | "debug" | "fatal"
            )
        {
            return Some(value.chars().take(96).collect());
        }
    }
    None
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
        query_events, ActiveTimestampBasis, TimeQuality, TimestampProvenance,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
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
    fn dual_rendering_56x265_layers_and_amplification() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("in");
        fs::create_dir_all(&src).unwrap();
        write_dual_rendering_corpus(&src, 56);
        let (_cache, _id, corpus) = ingest_dir(&src);
        let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();

        assert!(
            analysis.raw_exception_record_count >= 56 * 265,
            "raw={}",
            analysis.raw_exception_record_count
        );
        // 56 dual-merged occurrences (allow 1 residual unpaired rendering).
        assert!(
            (55..=58).contains(&analysis.occurrence_count),
            "semantic occurrences must be ~56 dual-merged, got {}",
            analysis.occurrence_count
        );
        assert!(
            analysis.duplicate_rendering_occurrence_count >= 50,
            "duplicates={}",
            analysis.duplicate_rendering_occurrence_count
        );
        assert!(
            analysis.overall_amplification_x >= 200,
            "amp={} (expect large dual-render factor)",
            analysis.overall_amplification_x
        );
        assert!(
            analysis.rendering_episode_count > analysis.occurrence_count,
            "physical renderings must exceed semantic occurrences when dual-merged"
        );
        assert!(analysis
            .ranking_disclosure
            .contains("independent_incident_claim_forbidden"));
        assert!(analysis
            .ranking_disclosure
            .contains("semantic_occurrence_count"));

        let family = analysis.families.first().expect("family");
        assert!(
            (55..=58).contains(&family.occurrence_count),
            "family occurrences={}",
            family.occurrence_count
        );
        for occ in family.occurrences.iter().take(8) {
            assert!(!occ.citations.is_empty());
            for c in &occ.citations {
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
        eprintln!(
            "dual_rendering: raw={} renderings={} occurrences={} duplicates={} amp={}",
            analysis.raw_exception_record_count,
            analysis.rendering_episode_count,
            analysis.occurrence_count,
            analysis.duplicate_rendering_occurrence_count,
            analysis.overall_amplification_x
        );
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
}
