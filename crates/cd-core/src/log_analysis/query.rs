//! Paged/keyset event query, facets, and event-level search for Log Explorer (#482).
//!
//! Semantic search stays **template-first** (template vectors → template_ids → events).
//! Hard page caps keep IPC and UI virtualization safe.

use super::search::{search_logs, SearchLogsQuery};
use super::store::{LogCorpus, LogEvent};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Hard max rows per page (IPC / virtualization).
pub const MAX_EVENT_PAGE: usize = 500;

/// Default page size when caller omits limit.
pub const DEFAULT_EVENT_PAGE: usize = 100;

/// Default number of source identities returned by the dedicated catalog.
pub const DEFAULT_SOURCE_CATALOG_PAGE: usize = 100;

/// Hard max source identities per catalog page.
pub const MAX_SOURCE_CATALOG_PAGE: usize = 200;

/// Hard max case-insensitive substring length for source-catalog search.
pub const MAX_SOURCE_CATALOG_SEARCH_CHARS: usize = 256;

/// Hard max serialized source identity accepted as a catalog cursor.
pub const MAX_SOURCE_CATALOG_CURSOR_BYTES: usize = 4_096;

/// Default number of fixed summary buckets used by the Explorer navigator.
pub const DEFAULT_TIMELINE_BUCKETS: usize = 96;

/// Hard cap on timeline summary buckets returned across IPC.
pub const MAX_TIMELINE_BUCKETS: usize = 256;

/// Hard cap on source-scoped lanes in one shared-axis timeline response.
pub const MAX_SHARED_TIMELINE_LANES: usize = 4;

/// Hard cap on source names accepted for one shared-axis lane.
pub const MAX_SHARED_TIMELINE_LANE_SOURCES: usize = 64;

/// The shared-axis contract always returns these five canonical severity series.
pub const SHARED_TIMELINE_SEVERITY_SERIES: usize = 5;

/// Maximum number of dense count cells in one shared-axis response:
/// one total series, five canonical severity series, and four lane series.
pub const MAX_SHARED_TIMELINE_COUNT_CELLS: usize =
    MAX_TIMELINE_BUCKETS * (1 + SHARED_TIMELINE_SEVERITY_SERIES + MAX_SHARED_TIMELINE_LANES);

/// Minimum unix ts treated as plausible wall-clock (2000-01-01).
pub const MIN_WALL_TS: i64 = 946_684_800;

/// How timestamps should be presented for a corpus or event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeQuality {
    /// Parsed / wall-clock timestamps.
    Wall,
    /// Mix of wall and synthetic order.
    Mixed,
    /// Sequence-as-ts only — never show as unlabeled calendar time.
    #[default]
    OrderOnly,
}

impl TimeQuality {
    /// Label for UI (honest presentation).
    pub fn label(self) -> &'static str {
        match self {
            Self::Wall => "wall clock",
            Self::Mixed => "mixed time quality",
            Self::OrderOnly => "order only (not calendar time)",
        }
    }
}

/// Classify a single timestamp.
pub fn classify_ts(ts: i64) -> TimeQuality {
    if ts >= MIN_WALL_TS {
        TimeQuality::Wall
    } else {
        TimeQuality::OrderOnly
    }
}

/// Classify corpus-level time quality from stats or a sample of events.
pub fn corpus_time_quality(corpus: &LogCorpus) -> TimeQuality {
    if let Ok(meta) = corpus.meta() {
        if let Some(stats) = meta.stats {
            if let (Some(min), Some(max)) = (stats.ts_min, stats.ts_max) {
                let min_q = classify_ts(min);
                let max_q = classify_ts(max);
                return match (min_q, max_q) {
                    (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
                    (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
                    _ => TimeQuality::Mixed,
                };
            }
        }
    }
    // Sample first page of events by seq.
    let page = query_events(
        corpus,
        &EventQuery {
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap_or_else(|_| EventPage {
        events: vec![],
        next_cursor: None,
        next_ts: None,
        prev_cursor: None,
        prev_ts: None,
        total_matched: 0,
        time_quality: TimeQuality::OrderOnly,
    });
    if page.events.is_empty() {
        return TimeQuality::OrderOnly;
    }
    let wall = page
        .events
        .iter()
        .filter(|e| e.time_quality == TimeQuality::Wall)
        .count();
    let n = page.events.len();
    if wall == n {
        TimeQuality::Wall
    } else if wall == 0 {
        TimeQuality::OrderOnly
    } else {
        TimeQuality::Mixed
    }
}

/// Filter + page parameters for explorer event queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventQuery {
    /// Inclusive start unix secs (or order ts).
    pub time_from: Option<i64>,
    /// Exclusive end.
    pub time_to: Option<i64>,
    /// Inclusive stable event-sequence lower bound.
    pub seq_from: Option<u64>,
    /// Inclusive stable event-sequence upper bound.
    pub seq_to: Option<u64>,
    /// Exact levels (OR). Empty = any.
    #[serde(default)]
    pub levels: Vec<String>,
    /// Source file basenames (OR). Empty = any.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Services (OR). Empty = any.
    #[serde(default)]
    pub services: Vec<String>,
    /// Hosts (OR). Empty = any.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Optional template id filter.
    pub template_id: Option<u64>,
    /// Optional template ids (OR) — used by semantic → events path.
    #[serde(default)]
    pub template_ids: Vec<u64>,
    /// Optional trace id exact match.
    pub trace_id: Option<String>,
    /// Keyword substring (case-insensitive) on redacted message.
    pub keyword: Option<String>,
    /// Keyset: with `after_ts` when `sort_by_time` — composite (ts, seq);
    /// without ts, seq-only (`seq > after_seq`).
    pub after_seq: Option<u64>,
    /// Keyset time cursor for time-sorted pages (pair with `after_seq`).
    pub after_ts: Option<i64>,
    /// Keyset: return rows with seq **less than** this (reverse / seq sort).
    pub before_seq: Option<u64>,
    /// Keyset time cursor for reverse time-sorted pages (pair with `before_seq`).
    pub before_ts: Option<i64>,
    /// Max rows (clamped to [`MAX_EVENT_PAGE`]).
    pub limit: usize,
    /// Sort by timestamp then seq (default true). When false, seq only.
    #[serde(default = "default_true")]
    pub sort_by_time: bool,
}

fn default_true() -> bool {
    true
}

impl Default for EventQuery {
    fn default() -> Self {
        Self {
            time_from: None,
            time_to: None,
            seq_from: None,
            seq_to: None,
            levels: vec![],
            sources: vec![],
            services: vec![],
            hosts: vec![],
            template_id: None,
            template_ids: vec![],
            trace_id: None,
            keyword: None,
            after_seq: None,
            after_ts: None,
            before_seq: None,
            before_ts: None,
            limit: 0,
            sort_by_time: true,
        }
    }
}

/// Bounded, filter-aware input for the Explorer timeline navigator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummaryQuery {
    /// Uses the same predicates as the visible Explorer rows. Paging cursors
    /// and page limits are intentionally ignored.
    #[serde(default)]
    pub filter: EventQuery,
    /// Desired maximum number of buckets, clamped to
    /// [`MAX_TIMELINE_BUCKETS`].
    #[serde(default = "default_timeline_buckets")]
    pub max_buckets: usize,
}

fn default_timeline_buckets() -> usize {
    DEFAULT_TIMELINE_BUCKETS
}

impl Default for TimelineSummaryQuery {
    fn default() -> Self {
        Self {
            filter: EventQuery::default(),
            max_buckets: DEFAULT_TIMELINE_BUCKETS,
        }
    }
}

/// One non-empty fixed-width summary bucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummaryBucket {
    /// Zero-based position in the complete fixed-width span.
    pub index: u32,
    /// Inclusive timestamp (wall-clock seconds or explicit order value).
    pub start: i64,
    /// Exclusive timestamp/order bound.
    pub end: i64,
    /// Events in this bucket.
    pub count: u64,
    /// Bounded naturally by the finite level values in this bucket.
    pub by_level: BTreeMap<String, u64>,
}

/// Fixed-size corpus overview for navigation. Empty buckets are represented by
/// their index, not materialized as event rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummary {
    /// Reliability of the filtered result's timestamps.
    pub time_quality: TimeQuality,
    /// Inclusive first timestamp/order value, or none when empty.
    pub span_from: Option<i64>,
    /// Exclusive final timestamp/order value, or none when empty.
    pub span_to: Option<i64>,
    /// Width of each bucket in timestamp/order units.
    pub bucket_width: i64,
    /// Number of slots across the complete span, including implicit empties.
    pub bucket_count: usize,
    /// Exact number of events matched by the supplied filters.
    pub total_matched: u64,
    /// Non-empty buckets only, ordered by index.
    pub buckets: Vec<TimelineSummaryBucket>,
}

/// One source-scoped lane requested on the global shared timeline axis.
///
/// An empty source list deliberately describes an empty lane; it never widens
/// to all sources. Source scopes are intersected with `filter.sources` when the
/// global filter already restricts sources.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineLaneScope {
    /// Exact source names (OR) for this lane.
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Bounded input for one global timeline axis plus source-scoped lane tracks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineSummaryQuery {
    /// Uses the same predicates as visible Explorer rows. Paging cursors and
    /// page limits are intentionally ignored.
    #[serde(default)]
    pub filter: EventQuery,
    /// Desired bucket count, clamped to [`MAX_TIMELINE_BUCKETS`].
    #[serde(default = "default_timeline_buckets")]
    pub max_buckets: usize,
    /// Source-scoped lanes projected onto the one global axis.
    #[serde(default)]
    pub lanes: Vec<SharedTimelineLaneScope>,
}

impl Default for SharedTimelineSummaryQuery {
    fn default() -> Self {
        Self {
            filter: EventQuery::default(),
            max_buckets: DEFAULT_TIMELINE_BUCKETS,
            lanes: Vec::new(),
        }
    }
}

/// Fixed canonical severity identities for a shared timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharedTimelineSeverity {
    /// Fatal and error events.
    Error,
    /// Warning events.
    Warn,
    /// Informational events.
    Info,
    /// Debug and trace events.
    Debug,
    /// Unknown and arbitrary custom levels.
    Other,
}

impl SharedTimelineSeverity {
    /// Stable display/serialization order for the fixed response shape.
    pub const ALL: [Self; SHARED_TIMELINE_SEVERITY_SERIES] = [
        Self::Error,
        Self::Warn,
        Self::Info,
        Self::Debug,
        Self::Other,
    ];

    fn index(self) -> usize {
        match self {
            Self::Error => 0,
            Self::Warn => 1,
            Self::Info => 2,
            Self::Debug => 3,
            Self::Other => 4,
        }
    }

    fn from_index(index: i64) -> Option<Self> {
        Self::ALL.get(usize::try_from(index).ok()?).copied()
    }
}

/// One explicit slot on the global fixed-width axis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineAxisBucket {
    /// Zero-based index shared by every returned series and lane.
    pub index: u32,
    /// Inclusive timestamp (wall-clock seconds or explicit order value).
    pub start: i64,
    /// Exclusive timestamp/order bound.
    pub end: i64,
}

/// One canonical severity series with an explicit value for every axis slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineSeveritySeries {
    /// Canonical identity of this fixed series.
    pub severity: SharedTimelineSeverity,
    /// Dense counts indexed exactly like `SharedTimelineSummary.buckets`.
    pub counts: Vec<u64>,
}

/// One requested source lane projected onto the global axis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineLaneSummary {
    /// Stable zero-based position in the request.
    pub lane_index: u8,
    /// Number of unique requested sources remaining after intersection with an
    /// active global source filter.
    pub source_count: usize,
    /// Honest quality of timestamps actually present in this lane. Empty lanes
    /// use `OrderOnly` because no wall-clock evidence exists.
    pub time_quality: TimeQuality,
    /// Exact events matched in this lane.
    pub total_matched: u64,
    /// Dense counts indexed exactly like `SharedTimelineSummary.buckets`.
    pub counts: Vec<u64>,
}

/// One bounded response for a global timeline and up to four source lanes.
///
/// All count vectors are dense and have exactly `bucket_count` entries, making
/// zero-valued gaps explicit. The response contains exactly five severity
/// series and no event bodies or unbounded level map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTimelineSummary {
    /// Reliability of the globally filtered timestamps.
    pub time_quality: TimeQuality,
    /// Inclusive first timestamp/order value, or none when empty.
    pub span_from: Option<i64>,
    /// Exclusive final timestamp/order value, or none when empty.
    pub span_to: Option<i64>,
    /// Width shared by every bucket, series, and lane.
    pub bucket_width: i64,
    /// Number of explicit slots on the shared axis.
    pub bucket_count: usize,
    /// Exact events matched by the global filter.
    pub total_matched: u64,
    /// Every axis slot, including gaps.
    pub buckets: Vec<SharedTimelineAxisBucket>,
    /// Dense total event counts for every axis slot.
    pub counts: Vec<u64>,
    /// Exactly five series in Error, Warn, Info, Debug, Other order.
    pub severity_series: Vec<SharedTimelineSeveritySeries>,
    /// At most [`MAX_SHARED_TIMELINE_LANES`] dense source-lane series.
    pub lanes: Vec<SharedTimelineLaneSummary>,
}

/// One explorer event row (redacted message + honest time quality).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerEvent {
    /// Event sequence.
    pub seq: u64,
    /// Stored ts (wall or order).
    pub ts: i64,
    /// How to present `ts`.
    pub time_quality: TimeQuality,
    /// Level.
    pub level: String,
    /// Service.
    pub service: Option<String>,
    /// Host.
    pub host: Option<String>,
    /// Template id.
    pub template_id: u64,
    /// Trace id.
    pub trace_id: Option<String>,
    /// Redacted message.
    pub message: String,
    /// Source path/basename.
    pub source: String,
}

impl From<LogEvent> for ExplorerEvent {
    fn from(e: LogEvent) -> Self {
        Self {
            seq: e.seq,
            ts: e.ts,
            time_quality: classify_ts(e.ts),
            level: e.level,
            service: e.service,
            host: e.host,
            template_id: e.template_id,
            trace_id: e.trace_id,
            message: e.message,
            source: e.source,
        }
    }
}

/// Authoritative redacted source representation for one event.
///
/// This is deliberately separate from [`ExplorerEvent`]: normal pages, search,
/// tools, and model context do not receive this content automatically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EventOriginalRepresentation {
    /// The corpus captured a bounded redacted source representation.
    Available {
        /// Honest UI label; this is not the unredacted source byte stream.
        label: String,
        /// Redacted source text after documented encoding/line-ending normalization.
        text: String,
        /// Source bytes after one trailing LF and optional CR were removed.
        source_byte_count: u64,
        /// Complete redacted character count before storage bounding.
        redacted_char_count: u64,
        /// Characters present in `text`.
        stored_char_count: u64,
        /// Whether a suffix is unavailable because of the storage bound.
        truncated: bool,
        /// Whether invalid UTF-8 was normalized to replacement characters.
        encoding_normalized: bool,
        /// Whether secret redaction changed or blocked the source record.
        redaction_applied: bool,
    },
    /// Legacy or otherwise uncaptured event.
    Unavailable {
        /// Stable, honest explanation suitable for a future inspector.
        reason: String,
    },
}

/// Fetch the separately stored authoritative redacted source for one event.
///
/// A missing event remains an error. A valid event from an older corpus is a
/// successful `Unavailable` result so clients never reconstruct or mislabel it.
pub fn query_event_original(
    corpus: &LogCorpus,
    seq: u64,
) -> CoreResult<EventOriginalRepresentation> {
    corpus.with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT original_redacted, original_source_bytes, original_redacted_chars, \
                        original_truncated, original_encoding_normalized, \
                        original_redaction_applied \
                 FROM events WHERE seq = ? LIMIT 1",
            )
            .map_err(duck_err)?;
        let mut rows = stmt.query(duckdb::params![seq as i64]).map_err(duck_err)?;
        let Some(row) = rows.next().map_err(duck_err)? else {
            return Err(CoreError::Message(format!("event seq {seq} not found")));
        };
        let text: Option<String> = row.get(0).map_err(duck_err)?;
        let source_byte_count: Option<i64> = row.get(1).map_err(duck_err)?;
        let redacted_char_count: Option<i64> = row.get(2).map_err(duck_err)?;
        let truncated: Option<bool> = row.get(3).map_err(duck_err)?;
        let encoding_normalized: Option<bool> = row.get(4).map_err(duck_err)?;
        let redaction_applied: Option<bool> = row.get(5).map_err(duck_err)?;

        let (
            Some(text),
            Some(source_byte_count),
            Some(redacted_char_count),
            Some(truncated),
            Some(encoding_normalized),
            Some(redaction_applied),
        ) = (
            text,
            source_byte_count,
            redacted_char_count,
            truncated,
            encoding_normalized,
            redaction_applied,
        )
        else {
            return Ok(EventOriginalRepresentation::Unavailable {
                reason: "Original representation unavailable for this corpus".into(),
            });
        };
        if source_byte_count < 0 || redacted_char_count < 0 {
            return Ok(EventOriginalRepresentation::Unavailable {
                reason: "Original representation metadata is invalid for this event".into(),
            });
        }
        let stored_char_count = text.chars().count() as u64;
        Ok(EventOriginalRepresentation::Available {
            label: "Original (redacted)".into(),
            text,
            source_byte_count: source_byte_count as u64,
            redacted_char_count: redacted_char_count as u64,
            stored_char_count,
            truncated,
            encoding_normalized,
            redaction_applied,
        })
    })
}

/// Paged result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// Rows (≤ limit), always in ascending display order (`ts`/`seq` ASC).
    pub events: Vec<ExplorerEvent>,
    /// Pass as `after_seq` for the **newer** page. Set only when newer matching
    /// rows are known to exist (or this is a reverse page with a newer bound).
    pub next_cursor: Option<u64>,
    /// Pass as `after_ts` with `next_cursor` when time-sorted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ts: Option<i64>,
    /// Pass as `before_seq` for the **older** page. Set only when older matching
    /// rows are known to exist (or this is a forward page with an older bound).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_cursor: Option<u64>,
    /// Pass as `before_ts` with `prev_cursor` when time-sorted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_ts: Option<i64>,
    /// Approximate total matching under filters (COUNT).
    pub total_matched: u64,
    /// Corpus/window time quality hint.
    pub time_quality: TimeQuality,
}

/// Facet counts under the same filters (except the faceted dimension itself).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFacets {
    /// Source → count.
    pub sources: BTreeMap<String, u64>,
    /// Level → count.
    pub levels: BTreeMap<String, u64>,
    /// Service → count (empty key = unset).
    pub services: BTreeMap<String, u64>,
    /// Host → count.
    pub hosts: BTreeMap<String, u64>,
    /// Corpus time quality.
    pub time_quality: TimeQuality,
}

/// One stable full-path identity in the corpus source catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSourceCatalogEntry {
    /// Exact source value stored on events (relative path, never basename-only).
    pub source: String,
    /// Exact number of events attributed to this source.
    pub event_count: u64,
}

/// Bounded request for the dedicated corpus source catalog.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LogSourceCatalogQuery {
    /// Optional case-insensitive literal substring over the full relative path.
    pub search: Option<String>,
    /// Exclusive full-path keyset cursor returned by the preceding page.
    pub cursor: Option<String>,
    /// Requested page size. Zero selects [`DEFAULT_SOURCE_CATALOG_PAGE`].
    pub limit: usize,
}

/// One deterministic page of distinct source identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSourceCatalogPage {
    /// Full relative paths in deterministic ascending lexical order.
    pub sources: Vec<LogSourceCatalogEntry>,
    /// Exclusive keyset cursor for the next page, present only when more exist.
    pub next_cursor: Option<String>,
    /// Exact distinct-source count under the current search, before the cursor.
    pub total_matched: u64,
}

/// Event-level search hit (keyword, regex, or via template-semantic).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchHit {
    /// Matching event.
    pub event: ExplorerEvent,
    /// Score (keyword fraction or inherited semantic).
    pub score: f32,
    /// How the hit was found (`keyword`, `regex`, `template_semantic`).
    pub match_kind: String,
    /// Template id when from semantic path.
    pub template_id: Option<u64>,
    /// Bounded match excerpt (message slice around first hit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

/// How the free-text query is interpreted (#523).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMatchMode {
    /// Substring / token keyword match (default).
    #[default]
    Literal,
    /// Linear-time regex (`regex` crate — no backtracking).
    Regex,
}

/// Hard caps for advanced / regex search (#523).
pub const MAX_SEARCH_PATTERN_LEN: usize = 256;
/// Max events scanned for regex (work budget) before returning partial results.
pub const MAX_REGEX_SCAN_EVENTS: usize = 50_000;
/// Max characters in a returned excerpt.
pub const MAX_SEARCH_EXCERPT_LEN: usize = 160;

/// Search query for explorer (events, not just templates).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchQuery {
    /// Free-text query (literal or regex depending on `match_mode`).
    pub query: Option<String>,
    /// Structured filters (reuses EventQuery fields conceptually).
    #[serde(default)]
    pub filter: EventQuery,
    /// Prefer template-semantic ranking when embed present.
    pub semantic: bool,
    /// Max event hits (clamped).
    pub k: usize,
    /// Literal vs regex interpretation of `query`.
    #[serde(default)]
    pub match_mode: SearchMatchMode,
    /// Case-sensitive matching (literal and regex). Default false.
    #[serde(default)]
    pub case_sensitive: bool,
}

/// Result of an advanced search with honesty flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchResult {
    /// Hits (≤ k).
    pub hits: Vec<EventSearchHit>,
    /// Composite cursor for the next chronological result page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<u64>,
    /// Timestamp paired with `next_cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ts: Option<i64>,
    /// Exact total for SQL-backed literal search; unavailable for bounded scans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_matched: Option<u64>,
    /// True when scan/work/result caps truncated the result set.
    pub partial: bool,
    /// Human-readable diagnostic (invalid pattern, cancelled, capped, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// True only when a cooperative cancellation request stopped this search.
    #[serde(default)]
    pub cancelled: bool,
    /// Events actually scanned under the work budget (regex path).
    pub scanned: u64,
}

/// Query a bounded timeline summary directly in DuckDB.
///
/// This deliberately returns counts rather than event bodies. Its memory and
/// IPC footprint are bounded by [`MAX_TIMELINE_BUCKETS`] regardless of corpus
/// size, and it honors the same filter predicates as [`query_events`].
pub fn query_timeline_summary(
    corpus: &LogCorpus,
    q: &TimelineSummaryQuery,
) -> CoreResult<TimelineSummary> {
    let max_buckets = q.max_buckets.clamp(1, MAX_TIMELINE_BUCKETS);
    let (where_sql, binds) = build_where(&q.filter);
    let bounds_sql = format!("SELECT MIN(ts), MAX(ts), COUNT(*) FROM events WHERE {where_sql}");

    let (min_ts, max_ts, total_matched) = corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&bounds_sql).map_err(duck_err)?;
        stmt.query_row(params_ref(&binds).as_slice(), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(duck_err)
    })?;

    let (Some(min_ts), Some(max_ts)) = (min_ts, max_ts) else {
        return Ok(TimelineSummary {
            time_quality: TimeQuality::OrderOnly,
            span_from: None,
            span_to: None,
            bucket_width: 1,
            bucket_count: 0,
            total_matched: 0,
            buckets: Vec::new(),
        });
    };

    let inclusive_span = max_ts.saturating_sub(min_ts).saturating_add(1).max(1);
    let bucket_width = inclusive_span
        .saturating_add(max_buckets as i64 - 1)
        .checked_div(max_buckets as i64)
        .unwrap_or(1)
        .max(1);
    let bucket_count = inclusive_span
        .saturating_add(bucket_width - 1)
        .checked_div(bucket_width)
        .unwrap_or(1)
        .clamp(1, max_buckets as i64) as usize;

    let bucket_sql = format!(
        "SELECT CAST(FLOOR((ts - ?) / CAST(? AS DOUBLE)) AS BIGINT) AS bucket_index, \
         level, COUNT(*) \
         FROM events WHERE {where_sql} \
         GROUP BY bucket_index, level ORDER BY bucket_index, level"
    );
    let mut bucket_binds = vec![Value::BigInt(min_ts), Value::BigInt(bucket_width)];
    bucket_binds.extend(binds);

    let grouped = corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&bucket_sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params_ref(&bucket_binds).as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    })?;

    let mut by_index: BTreeMap<u32, TimelineSummaryBucket> = BTreeMap::new();
    for (raw_index, level, count) in grouped {
        if raw_index < 0 || raw_index as usize >= bucket_count {
            return Err(CoreError::Message(
                "duckdb: timeline bucket fell outside computed span".into(),
            ));
        }
        let index = raw_index as u32;
        let start = min_ts.saturating_add(raw_index.saturating_mul(bucket_width));
        let end = start
            .saturating_add(bucket_width)
            .min(max_ts.saturating_add(1));
        let bucket = by_index
            .entry(index)
            .or_insert_with(|| TimelineSummaryBucket {
                index,
                start,
                end,
                count: 0,
                by_level: BTreeMap::new(),
            });
        bucket.count = bucket.count.saturating_add(count.max(0) as u64);
        bucket.by_level.insert(level, count.max(0) as u64);
    }

    let time_quality = match (classify_ts(min_ts), classify_ts(max_ts)) {
        (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
        (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
        _ => TimeQuality::Mixed,
    };

    Ok(TimelineSummary {
        time_quality,
        span_from: Some(min_ts),
        span_to: Some(max_ts.saturating_add(1)),
        bucket_width,
        bucket_count,
        total_matched: total_matched.max(0) as u64,
        buckets: by_index.into_values().collect(),
    })
}

/// Query one bounded global timeline axis with canonical severity and source
/// lane series.
///
/// The API is additive; [`query_timeline_summary`] keeps its sparse legacy
/// response unchanged. Each SQL grouping is bounded by the bucket/series caps,
/// while the returned dense arrays make gaps explicit.
///
/// This core-only contract does not expose cooperative cancellation. True
/// cancellation requires host/IPC lifecycle wiring around DuckDB execution;
/// callers must not present the bounded response as cancellable until that
/// integration exists.
pub fn query_shared_timeline_summary(
    corpus: &LogCorpus,
    q: &SharedTimelineSummaryQuery,
) -> CoreResult<SharedTimelineSummary> {
    validate_shared_timeline_query(q)?;
    let max_buckets = q.max_buckets.clamp(1, MAX_TIMELINE_BUCKETS);
    let lane_sources = q
        .lanes
        .iter()
        .map(|lane| intersect_lane_sources(&q.filter.sources, &lane.sources))
        .collect::<Vec<_>>();
    let (where_sql, binds) = build_where(&q.filter);
    let bounds_sql = format!("SELECT MIN(ts), MAX(ts), COUNT(*) FROM events WHERE {where_sql}");
    let (min_ts, max_ts, total_matched) = corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&bounds_sql).map_err(duck_err)?;
        stmt.query_row(params_ref(&binds).as_slice(), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(duck_err)
    })?;

    let (Some(min_ts), Some(max_ts)) = (min_ts, max_ts) else {
        return Ok(empty_shared_timeline(lane_sources));
    };
    let (span_to, bucket_width, bucket_count) = shared_timeline_axis(min_ts, max_ts, max_buckets)?;
    let buckets = (0..bucket_count)
        .map(|index| {
            let start = min_ts.saturating_add((index as i64).saturating_mul(bucket_width));
            SharedTimelineAxisBucket {
                index: index as u32,
                start,
                end: start.saturating_add(bucket_width).min(span_to),
            }
        })
        .collect::<Vec<_>>();

    let severity_sql = format!(
        "SELECT CAST(FLOOR((ts - ?) / CAST(? AS DOUBLE)) AS BIGINT) AS bucket_index, \
         CASE \
           WHEN lower(level) IN ('fatal', 'critical', 'crit', 'severe', 'error', 'err') THEN 0 \
           WHEN lower(level) IN ('warning', 'warn') THEN 1 \
           WHEN lower(level) IN ('info', 'notice') THEN 2 \
           WHEN lower(level) IN ('debug', 'trace') THEN 3 \
           ELSE 4 \
         END AS severity_index, \
         COUNT(*) \
         FROM events WHERE {where_sql} \
         GROUP BY bucket_index, severity_index \
         ORDER BY bucket_index, severity_index"
    );
    let mut severity_binds = vec![Value::BigInt(min_ts), Value::BigInt(bucket_width)];
    severity_binds.extend(binds);
    let grouped_severity = corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&severity_sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params_ref(&severity_binds).as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    })?;

    let mut counts = vec![0_u64; bucket_count];
    let mut severity_counts: [Vec<u64>; SHARED_TIMELINE_SEVERITY_SERIES] =
        std::array::from_fn(|_| vec![0_u64; bucket_count]);
    for (raw_index, raw_severity, raw_count) in grouped_severity {
        let index = checked_timeline_bucket(raw_index, bucket_count)?;
        let severity = SharedTimelineSeverity::from_index(raw_severity).ok_or_else(|| {
            CoreError::Message("duckdb: shared timeline severity fell outside fixed series".into())
        })?;
        let count = raw_count.max(0) as u64;
        counts[index] = counts[index].saturating_add(count);
        severity_counts[severity.index()][index] =
            severity_counts[severity.index()][index].saturating_add(count);
    }

    let mut lanes = Vec::with_capacity(lane_sources.len());
    for (lane_index, sources) in lane_sources.iter().enumerate() {
        lanes.push(query_shared_timeline_lane(
            corpus,
            &q.filter,
            sources,
            lane_index,
            min_ts,
            bucket_width,
            bucket_count,
        )?);
    }

    let time_quality = match (classify_ts(min_ts), classify_ts(max_ts)) {
        (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
        (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
        _ => TimeQuality::Mixed,
    };
    let severity_series = SharedTimelineSeverity::ALL
        .into_iter()
        .map(|severity| SharedTimelineSeveritySeries {
            severity,
            counts: std::mem::take(&mut severity_counts[severity.index()]),
        })
        .collect();

    Ok(SharedTimelineSummary {
        time_quality,
        span_from: Some(min_ts),
        span_to: Some(span_to),
        bucket_width,
        bucket_count,
        total_matched: total_matched.max(0) as u64,
        buckets,
        counts,
        severity_series,
        lanes,
    })
}

fn validate_shared_timeline_query(q: &SharedTimelineSummaryQuery) -> CoreResult<()> {
    if q.lanes.len() > MAX_SHARED_TIMELINE_LANES {
        return Err(CoreError::Message(format!(
            "shared timeline lane cap exceeded: {} requested, maximum is {}",
            q.lanes.len(),
            MAX_SHARED_TIMELINE_LANES
        )));
    }
    for (index, lane) in q.lanes.iter().enumerate() {
        if lane.sources.len() > MAX_SHARED_TIMELINE_LANE_SOURCES {
            return Err(CoreError::Message(format!(
                "shared timeline lane {index} source cap exceeded: {} requested, maximum is {}",
                lane.sources.len(),
                MAX_SHARED_TIMELINE_LANE_SOURCES
            )));
        }
    }
    Ok(())
}

fn intersect_lane_sources(global: &[String], requested: &[String]) -> Vec<String> {
    let mut sources = Vec::with_capacity(requested.len());
    for source in requested {
        if sources.contains(source) {
            continue;
        }
        if global.is_empty() || global.contains(source) {
            sources.push(source.clone());
        }
    }
    sources
}

fn shared_timeline_axis(
    min_ts: i64,
    max_ts: i64,
    max_buckets: usize,
) -> CoreResult<(i64, i64, usize)> {
    let span_to = max_ts.checked_add(1).ok_or_else(|| {
        CoreError::Message("shared timeline cannot represent an exclusive i64::MAX bound".into())
    })?;
    let inclusive_span = max_ts.saturating_sub(min_ts).saturating_add(1).max(1);
    let bucket_width = inclusive_span
        .saturating_add(max_buckets as i64 - 1)
        .checked_div(max_buckets as i64)
        .unwrap_or(1)
        .max(1);
    let bucket_count = inclusive_span
        .saturating_add(bucket_width - 1)
        .checked_div(bucket_width)
        .unwrap_or(1)
        .clamp(1, max_buckets as i64) as usize;
    Ok((span_to, bucket_width, bucket_count))
}

fn checked_timeline_bucket(raw_index: i64, bucket_count: usize) -> CoreResult<usize> {
    if raw_index < 0 || raw_index as usize >= bucket_count {
        return Err(CoreError::Message(
            "duckdb: shared timeline bucket fell outside global axis".into(),
        ));
    }
    Ok(raw_index as usize)
}

fn query_shared_timeline_lane(
    corpus: &LogCorpus,
    global_filter: &EventQuery,
    sources: &[String],
    lane_index: usize,
    min_ts: i64,
    bucket_width: i64,
    bucket_count: usize,
) -> CoreResult<SharedTimelineLaneSummary> {
    let mut counts = vec![0_u64; bucket_count];
    if sources.is_empty() {
        return Ok(SharedTimelineLaneSummary {
            lane_index: lane_index as u8,
            source_count: 0,
            time_quality: TimeQuality::OrderOnly,
            total_matched: 0,
            counts,
        });
    }

    let mut filter = global_filter.clone();
    filter.sources = sources.to_vec();
    let (where_sql, binds) = build_where(&filter);
    let lane_sql = format!(
        "SELECT CAST(FLOOR((ts - ?) / CAST(? AS DOUBLE)) AS BIGINT) AS bucket_index, \
         COUNT(*), MIN(ts), MAX(ts) \
         FROM events WHERE {where_sql} \
         GROUP BY bucket_index ORDER BY bucket_index"
    );
    let mut lane_binds = vec![Value::BigInt(min_ts), Value::BigInt(bucket_width)];
    lane_binds.extend(binds);
    let grouped = corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&lane_sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params_ref(&lane_binds).as_slice(), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    })?;

    let mut total_matched = 0_u64;
    let mut lane_min = None;
    let mut lane_max = None;
    for (raw_index, raw_count, bucket_min, bucket_max) in grouped {
        let index = checked_timeline_bucket(raw_index, bucket_count)?;
        let count = raw_count.max(0) as u64;
        counts[index] = counts[index].saturating_add(count);
        total_matched = total_matched.saturating_add(count);
        lane_min = Some(lane_min.map_or(bucket_min, |value: i64| value.min(bucket_min)));
        lane_max = Some(lane_max.map_or(bucket_max, |value: i64| value.max(bucket_max)));
    }
    let time_quality = match (lane_min, lane_max) {
        (Some(min), Some(max)) => match (classify_ts(min), classify_ts(max)) {
            (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
            (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
            _ => TimeQuality::Mixed,
        },
        _ => TimeQuality::OrderOnly,
    };

    Ok(SharedTimelineLaneSummary {
        lane_index: lane_index as u8,
        source_count: sources.len(),
        time_quality,
        total_matched,
        counts,
    })
}

fn empty_shared_timeline(lane_sources: Vec<Vec<String>>) -> SharedTimelineSummary {
    SharedTimelineSummary {
        time_quality: TimeQuality::OrderOnly,
        span_from: None,
        span_to: None,
        bucket_width: 1,
        bucket_count: 0,
        total_matched: 0,
        buckets: Vec::new(),
        counts: Vec::new(),
        severity_series: SharedTimelineSeverity::ALL
            .into_iter()
            .map(|severity| SharedTimelineSeveritySeries {
                severity,
                counts: Vec::new(),
            })
            .collect(),
        lanes: lane_sources
            .into_iter()
            .enumerate()
            .map(|(lane_index, sources)| SharedTimelineLaneSummary {
                lane_index: lane_index as u8,
                source_count: sources.len(),
                time_quality: TimeQuality::OrderOnly,
                total_matched: 0,
                counts: Vec::new(),
            })
            .collect(),
    }
}

/// Query events with SQL filters + keyset pagination.
///
/// When `sort_by_time` is true, keyset uses composite `(ts, seq)` via
/// `after_ts`+`after_seq` so multi-file corpora (file-order seq, overlapping
/// wall times) do not drop rows on Load more. Seq-only keyset is used when
/// sorting by seq.
pub fn query_events(corpus: &LogCorpus, q: &EventQuery) -> CoreResult<EventPage> {
    query_events_with_additional_keyword(corpus, q, None)
}

/// Query events while requiring an additional case-insensitive message
/// substring. Advanced Find uses this to intersect its literal query with the
/// independently active Filter keyword without widening either predicate.
fn query_events_with_additional_keyword(
    corpus: &LogCorpus,
    q: &EventQuery,
    additional_keyword: Option<&str>,
) -> CoreResult<EventPage> {
    let limit = if q.limit == 0 {
        DEFAULT_EVENT_PAGE
    } else {
        q.limit.clamp(1, MAX_EVENT_PAGE)
    };

    let (mut where_sql, mut binds) = build_where(q);
    if let Some(keyword) = additional_keyword {
        let keyword = keyword.trim();
        if !keyword.is_empty() {
            where_sql.push_str(" AND lower(message) LIKE ?");
            binds.push(Value::Text(format!("%{}%", keyword.to_lowercase())));
        }
    }
    // Reverse page: only `before_*` (no `after_*`) — fetch the adjacent older
    // window via DESC + reverse so ASC LIMIT does not return corpus head (#538).
    let reverse_page = q.before_seq.is_some() && q.after_seq.is_none();
    let order = if reverse_page {
        if q.sort_by_time {
            "ts DESC, seq DESC"
        } else {
            "seq DESC"
        }
    } else if q.sort_by_time {
        "ts ASC, seq ASC"
    } else {
        "seq ASC"
    };
    let mut page_where = where_sql.clone();
    let mut page_binds = binds.clone();

    if q.sort_by_time {
        // Composite keyset matching ORDER BY ts, seq. Seq-only under time sort
        // silently drops multi-file rows — refuse (#504).
        if q.after_seq.is_some() && q.after_ts.is_none() {
            return Err(CoreError::Message(
                "time-sorted query requires after_ts with after_seq (composite keyset); \
                 seq-only cursor is refused to prevent silent row drops"
                    .into(),
            ));
        }
        if q.before_seq.is_some() && q.before_ts.is_none() {
            return Err(CoreError::Message(
                "time-sorted query requires before_ts with before_seq (composite keyset)".into(),
            ));
        }
        if let (Some(ats), Some(aseq)) = (q.after_ts, q.after_seq) {
            page_where.push_str(" AND (ts > ? OR (ts = ? AND seq > ?))");
            page_binds.push(Value::BigInt(ats));
            page_binds.push(Value::BigInt(ats));
            page_binds.push(Value::BigInt(aseq as i64));
        }
        if let (Some(bts), Some(bseq)) = (q.before_ts, q.before_seq) {
            page_where.push_str(" AND (ts < ? OR (ts = ? AND seq < ?))");
            page_binds.push(Value::BigInt(bts));
            page_binds.push(Value::BigInt(bts));
            page_binds.push(Value::BigInt(bseq as i64));
        }
    } else {
        if let Some(after) = q.after_seq {
            page_where.push_str(" AND seq > ?");
            page_binds.push(Value::BigInt(after as i64));
        }
        if let Some(before) = q.before_seq {
            page_where.push_str(" AND seq < ?");
            page_binds.push(Value::BigInt(before as i64));
        }
    }

    let count_sql = format!("SELECT COUNT(*) FROM events WHERE {where_sql}");
    // Fetch one lookahead row so an exact-limit final page is a known boundary
    // instead of advertising a cursor that requires an empty probe (#640).
    let fetch_limit = limit.saturating_add(1);
    let sql = format!(
        "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source \
         FROM events WHERE {page_where} ORDER BY {order} LIMIT {fetch_limit}"
    );

    let (total_matched, mut events) = corpus.with_connection(|conn| {
        let total_matched: i64 = {
            let mut stmt = conn.prepare(&count_sql).map_err(duck_err)?;
            bind_and_query_row_i64(&mut stmt, &binds)?
        };
        let mut stmt = conn.prepare(&sql).map_err(duck_err)?;
        let events = bind_and_map_events(&mut stmt, &page_binds)?;
        Ok((total_matched, events))
    })?;

    let has_more_in_query_direction = events.len() > limit;
    if reverse_page {
        events.reverse();
        if has_more_in_query_direction {
            // DESC fetched the adjacent window plus one older row. After
            // reversing to display order, discard that oldest lookahead.
            events.remove(0);
        }
    } else if has_more_in_query_direction {
        events.truncate(limit);
    }

    let has_older_bound = q.after_seq.is_some();
    let has_newer_bound = q.before_seq.is_some();
    let newer_available = if reverse_page {
        has_newer_bound && !events.is_empty()
    } else {
        has_more_in_query_direction
    };
    let older_available = if reverse_page {
        has_more_in_query_direction
    } else {
        has_older_bound && !events.is_empty()
    };

    let (next_cursor, next_ts) = if newer_available {
        let last = events.last();
        (
            last.map(|e| e.seq),
            if q.sort_by_time {
                last.map(|e| e.ts)
            } else {
                None
            },
        )
    } else {
        (None, None)
    };
    let (prev_cursor, prev_ts) = if older_available {
        let first = events.first();
        (
            first.map(|e| e.seq),
            if q.sort_by_time {
                first.map(|e| e.ts)
            } else {
                None
            },
        )
    } else {
        (None, None)
    };
    let tq = if events.is_empty() {
        corpus_time_quality_from_meta(corpus)
    } else {
        summarize_event_quality(&events)
    };

    Ok(EventPage {
        events,
        next_cursor,
        next_ts,
        prev_cursor,
        prev_ts,
        total_matched: total_matched.max(0) as u64,
        time_quality: tq,
    })
}

fn corpus_time_quality_from_meta(corpus: &LogCorpus) -> TimeQuality {
    if let Ok(meta) = corpus.meta() {
        if let Some(stats) = meta.stats {
            if let (Some(min), Some(max)) = (stats.ts_min, stats.ts_max) {
                let a = classify_ts(min);
                let b = classify_ts(max);
                return match (a, b) {
                    (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
                    (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
                    _ => TimeQuality::Mixed,
                };
            }
        }
    }
    TimeQuality::OrderOnly
}

fn summarize_event_quality(events: &[ExplorerEvent]) -> TimeQuality {
    let wall = events
        .iter()
        .filter(|e| e.time_quality == TimeQuality::Wall)
        .count();
    if wall == events.len() {
        TimeQuality::Wall
    } else if wall == 0 {
        TimeQuality::OrderOnly
    } else {
        TimeQuality::Mixed
    }
}

/// Facets under filters (sources/levels/services/hosts).
pub fn query_facets(corpus: &LogCorpus, q: &EventQuery) -> CoreResult<LogFacets> {
    let (where_sql, binds) = build_where(q);

    let mut facets = LogFacets {
        time_quality: corpus_time_quality_from_meta(corpus),
        ..Default::default()
    };

    corpus.with_connection(|conn| {
        for (col, map) in [
            ("source", &mut facets.sources),
            ("level", &mut facets.levels),
            ("COALESCE(service, '')", &mut facets.services),
            ("COALESCE(host, '')", &mut facets.hosts),
        ] {
            let sql = format!(
                "SELECT {col} AS k, COUNT(*) AS c FROM events WHERE {where_sql} GROUP BY 1 ORDER BY c DESC LIMIT 200"
            );
            let mut stmt = conn.prepare(&sql).map_err(duck_err)?;
            let rows = bind_and_map_kv(&mut stmt, &binds)?;
            for (k, c) in rows {
                map.insert(k, c);
            }
        }
        Ok(())
    })?;
    Ok(facets)
}

/// Query the complete, corpus-scoped source inventory independently of facets.
///
/// Sources are grouped by their exact stored relative path and ordered by the
/// database's deterministic default binary collation. The cursor is the last
/// full path returned and is exclusive. Before advancing, it must still exist
/// under the same search predicate; a stale or search-mismatched cursor fails
/// explicitly rather than returning a plausible page with silently skipped
/// sources.
pub fn query_source_catalog(
    corpus: &LogCorpus,
    q: &LogSourceCatalogQuery,
) -> CoreResult<LogSourceCatalogPage> {
    let limit = if q.limit == 0 {
        DEFAULT_SOURCE_CATALOG_PAGE
    } else if q.limit <= MAX_SOURCE_CATALOG_PAGE {
        q.limit
    } else {
        return Err(CoreError::Message(format!(
            "source catalog page limit {} exceeds maximum {}",
            q.limit, MAX_SOURCE_CATALOG_PAGE
        )));
    };

    let search = normalize_source_catalog_search(q.search.as_deref())?;
    let cursor = validate_source_catalog_cursor(q.cursor.as_deref())?;
    let mut base_clauses = vec!["1=1".to_string()];
    let mut base_binds = Vec::new();
    if let Some(search) = &search {
        base_clauses.push("contains(lower(source), ?)".into());
        base_binds.push(Value::Text(search.clone()));
    }
    let base_where = base_clauses.join(" AND ");

    corpus.with_connection(|conn| {
        if let Some(cursor) = cursor {
            let cursor_sql =
                format!("SELECT COUNT(*) FROM events WHERE {base_where} AND source = ?");
            let mut cursor_binds = base_binds.clone();
            cursor_binds.push(Value::Text(cursor.to_string()));
            let mut stmt = conn.prepare(&cursor_sql).map_err(duck_err)?;
            let cursor_count = bind_and_query_row_i64(&mut stmt, &cursor_binds)?;
            if cursor_count == 0 {
                return Err(CoreError::Message(
                    "source catalog cursor is not present under the current corpus search".into(),
                ));
            }
        }

        let total_sql = format!(
            "SELECT COUNT(*) FROM (SELECT source FROM events WHERE {base_where} GROUP BY source)"
        );
        let mut total_stmt = conn.prepare(&total_sql).map_err(duck_err)?;
        let total_matched = bind_and_query_row_i64(&mut total_stmt, &base_binds)?.max(0) as u64;

        let mut page_where = base_where;
        let mut page_binds = base_binds;
        if let Some(cursor) = cursor {
            page_where.push_str(" AND source > ?");
            page_binds.push(Value::Text(cursor.to_string()));
        }
        page_binds.push(Value::BigInt((limit + 1) as i64));
        let page_sql = format!(
            "SELECT source, COUNT(*) AS event_count \
             FROM events WHERE {page_where} \
             GROUP BY source ORDER BY source ASC LIMIT ?"
        );
        let mut page_stmt = conn.prepare(&page_sql).map_err(duck_err)?;
        let mut rows = bind_and_map_source_catalog(&mut page_stmt, &page_binds)?;
        let has_more = rows.len() > limit;
        if has_more {
            rows.truncate(limit);
        }
        let next_cursor = has_more
            .then(|| rows.last().map(|entry| entry.source.clone()))
            .flatten();

        Ok(LogSourceCatalogPage {
            sources: rows,
            next_cursor,
            total_matched,
        })
    })
}

fn normalize_source_catalog_search(search: Option<&str>) -> CoreResult<Option<String>> {
    let Some(search) = search else {
        return Ok(None);
    };
    let search = search.trim();
    if search.is_empty() {
        return Ok(None);
    }
    if search.contains('\0') {
        return Err(CoreError::Message(
            "source catalog search must not contain NUL".into(),
        ));
    }
    let chars = search.chars().count();
    if chars > MAX_SOURCE_CATALOG_SEARCH_CHARS {
        return Err(CoreError::Message(format!(
            "source catalog search length {chars} exceeds maximum {MAX_SOURCE_CATALOG_SEARCH_CHARS}"
        )));
    }
    Ok(Some(search.to_lowercase()))
}

fn validate_source_catalog_cursor(cursor: Option<&str>) -> CoreResult<Option<&str>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.is_empty() || cursor.contains('\0') {
        return Err(CoreError::Message(
            "source catalog cursor must be a non-empty source path without NUL".into(),
        ));
    }
    if cursor.len() > MAX_SOURCE_CATALOG_CURSOR_BYTES {
        return Err(CoreError::Message(format!(
            "source catalog cursor exceeds maximum {} bytes",
            MAX_SOURCE_CATALOG_CURSOR_BYTES
        )));
    }
    Ok(Some(cursor))
}

/// Keyword / regex / optional template-semantic → **events** (template-first for semantic).
///
/// Prefer [`search_events_advanced`] when partial/capped diagnostics matter.
pub fn search_events(
    corpus: &LogCorpus,
    q: &EventSearchQuery,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<Vec<EventSearchHit>> {
    Ok(search_events_advanced(corpus, q, embed)?.hits)
}

/// Advanced search with partial/capped honesty and regex safety (#523).
pub fn search_events_advanced(
    corpus: &LogCorpus,
    q: &EventSearchQuery,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<EventSearchResult> {
    search_events_advanced_with_cancel(corpus, q, embed, None)
}

fn search_cancelled(cancel: Option<&dyn Fn() -> bool>) -> bool {
    cancel.is_some_and(|is_cancelled| is_cancelled())
}

fn cancelled_search_result(hits: Vec<EventSearchHit>, scanned: u64) -> EventSearchResult {
    EventSearchResult {
        hits,
        next_cursor: None,
        next_ts: None,
        total_matched: None,
        partial: true,
        diagnostic: Some("cancelled".into()),
        cancelled: true,
        scanned,
    }
}

/// Advanced search with cooperative cancellation checked between bounded work
/// units and within event scans. A cancelled result is terminal and offers no
/// continuation cursor.
pub fn search_events_advanced_with_cancel(
    corpus: &LogCorpus,
    q: &EventSearchQuery,
    embed: Option<&dyn EmbedBackend>,
    cancel: Option<&dyn Fn() -> bool>,
) -> CoreResult<EventSearchResult> {
    let k = if q.k == 0 {
        50
    } else {
        q.k.clamp(1, MAX_EVENT_PAGE)
    };
    let mut hits: Vec<EventSearchHit> = Vec::new();
    let mut partial = false;
    let mut diagnostic: Option<String> = None;
    let mut scanned = 0u64;
    let mut next_cursor = None;
    let mut next_ts = None;
    let mut total_matched = None;
    let mut last_scanned: Option<(i64, u64)> = None;

    if search_cancelled(cancel) {
        return Ok(cancelled_search_result(hits, scanned));
    }

    // Semantic: templates first, then pull events for top templates under filters.
    // Disabled when match_mode is regex (semantic is template similarity, not regex).
    if q.semantic && q.match_mode != SearchMatchMode::Regex {
        let tq = SearchLogsQuery {
            query: q.query.clone(),
            time_from: q.filter.time_from,
            time_to: q.filter.time_to,
            level: q.filter.levels.first().cloned(),
            service: q.filter.services.first().cloned(),
            trace_id: q.filter.trace_id.clone(),
            semantic: true,
            k: k.min(40),
        };
        let template_hits = search_logs(corpus, &tq, embed)?;
        if search_cancelled(cancel) {
            return Ok(cancelled_search_result(hits, scanned));
        }
        let mut template_ids: Vec<u64> = template_hits.iter().map(|h| h.template_id).collect();
        template_ids.truncate(20);
        if !template_ids.is_empty() {
            let mut fq = q.filter.clone();
            fq.template_ids = template_ids.clone();
            fq.limit = k;
            let page = query_events(corpus, &fq)?;
            if search_cancelled(cancel) {
                return Ok(cancelled_search_result(hits, scanned));
            }
            let score_by_tid: std::collections::HashMap<u64, f32> = template_hits
                .iter()
                .map(|h| (h.template_id, h.score))
                .collect();
            for e in page.events {
                if search_cancelled(cancel) {
                    return Ok(cancelled_search_result(hits, scanned));
                }
                let score = score_by_tid.get(&e.template_id).copied().unwrap_or(0.1);
                hits.push(EventSearchHit {
                    template_id: Some(e.template_id),
                    event: e,
                    score,
                    match_kind: "template_semantic".into(),
                    excerpt: None,
                });
            }
        }
    }

    if let Some(ref raw) = q.query {
        let pattern = raw.trim();
        if !pattern.is_empty() {
            if pattern.len() > MAX_SEARCH_PATTERN_LEN {
                return Ok(EventSearchResult {
                    hits: vec![],
                    next_cursor: None,
                    next_ts: None,
                    total_matched: Some(0),
                    partial: false,
                    diagnostic: Some(format!(
                        "pattern exceeds max length ({MAX_SEARCH_PATTERN_LEN} characters)"
                    )),
                    cancelled: false,
                    scanned: 0,
                });
            }

            match q.match_mode {
                SearchMatchMode::Regex => {
                    let re = compile_bounded_regex(pattern, q.case_sensitive)?;
                    // Scan pages under active filters; regex itself runs in trusted core.
                    let mut after_seq = q.filter.after_seq;
                    let mut after_ts = q.filter.after_ts;
                    let mut pages = 0usize;
                    loop {
                        if search_cancelled(cancel) {
                            return Ok(cancelled_search_result(hits, scanned));
                        }
                        if hits.len() >= k || scanned >= MAX_REGEX_SCAN_EVENTS as u64 {
                            if hits.len() >= k || scanned >= MAX_REGEX_SCAN_EVENTS as u64 {
                                partial = true;
                                diagnostic = Some(if hits.len() >= k {
                                    format!("result cap reached ({k})")
                                } else {
                                    format!(
                                        "scan work cap reached ({MAX_REGEX_SCAN_EVENTS} events)"
                                    )
                                });
                            }
                            break;
                        }
                        let remaining_budget =
                            (MAX_REGEX_SCAN_EVENTS as u64).saturating_sub(scanned) as usize;
                        let page_limit = remaining_budget.clamp(1, MAX_EVENT_PAGE);
                        let mut fq = q.filter.clone();
                        fq.limit = page_limit;
                        fq.after_seq = after_seq;
                        fq.after_ts = after_ts;
                        fq.before_seq = None;
                        fq.before_ts = None;
                        fq.sort_by_time = true;
                        let page = query_events(corpus, &fq)?;
                        if search_cancelled(cancel) {
                            return Ok(cancelled_search_result(hits, scanned));
                        }
                        if page.events.is_empty() {
                            break;
                        }
                        for e in page.events {
                            if search_cancelled(cancel) {
                                return Ok(cancelled_search_result(hits, scanned));
                            }
                            scanned += 1;
                            last_scanned = Some((e.ts, e.seq));
                            if let Some(m) = re.find(&e.message) {
                                if hits.iter().any(|h| h.event.seq == e.seq) {
                                    continue;
                                }
                                let excerpt = excerpt_around(&e.message, m.start(), m.end());
                                hits.push(EventSearchHit {
                                    template_id: Some(e.template_id),
                                    event: e,
                                    score: 1.0,
                                    match_kind: "regex".into(),
                                    excerpt: Some(excerpt),
                                });
                                if hits.len() >= k {
                                    partial = true;
                                    diagnostic = Some(format!("result cap reached ({k})"));
                                    break;
                                }
                            }
                        }
                        pages += 1;
                        if page.next_cursor.is_none() || pages > 500 {
                            if pages > 500 {
                                partial = true;
                                diagnostic = Some("page iteration safety cap reached".into());
                            }
                            break;
                        }
                        after_seq = page.next_cursor;
                        after_ts = page.next_ts;
                    }
                }
                SearchMatchMode::Literal => {
                    let mut fq = q.filter.clone();
                    if q.case_sensitive {
                        // SQL path is case-insensitive LIKE; fall back to scan for case-sensitive.
                        let mut after_seq = q.filter.after_seq;
                        let mut after_ts = q.filter.after_ts;
                        loop {
                            if search_cancelled(cancel) {
                                return Ok(cancelled_search_result(hits, scanned));
                            }
                            if hits.len() >= k || scanned >= MAX_REGEX_SCAN_EVENTS as u64 {
                                partial = true;
                                break;
                            }
                            let page_limit = (MAX_REGEX_SCAN_EVENTS as u64)
                                .saturating_sub(scanned)
                                .min(MAX_EVENT_PAGE as u64)
                                .max(1) as usize;
                            let mut page_q = fq.clone();
                            page_q.limit = page_limit;
                            page_q.after_seq = after_seq;
                            page_q.after_ts = after_ts;
                            page_q.before_seq = None;
                            page_q.before_ts = None;
                            page_q.sort_by_time = true;
                            let page = query_events(corpus, &page_q)?;
                            if search_cancelled(cancel) {
                                return Ok(cancelled_search_result(hits, scanned));
                            }
                            if page.events.is_empty() {
                                break;
                            }
                            for e in page.events {
                                if search_cancelled(cancel) {
                                    return Ok(cancelled_search_result(hits, scanned));
                                }
                                scanned += 1;
                                last_scanned = Some((e.ts, e.seq));
                                if let Some(idx) = e.message.find(pattern) {
                                    if hits.iter().any(|h| h.event.seq == e.seq) {
                                        continue;
                                    }
                                    hits.push(EventSearchHit {
                                        template_id: Some(e.template_id),
                                        event: e.clone(),
                                        score: 1.0,
                                        match_kind: "keyword".into(),
                                        excerpt: Some(excerpt_around(
                                            &e.message,
                                            idx,
                                            idx + pattern.len(),
                                        )),
                                    });
                                    if hits.len() >= k {
                                        partial = true;
                                        break;
                                    }
                                }
                            }
                            if page.next_cursor.is_none() {
                                break;
                            }
                            after_seq = page.next_cursor;
                            after_ts = page.next_ts;
                        }
                    } else {
                        fq.limit = k;
                        let page =
                            query_events_with_additional_keyword(corpus, &fq, Some(pattern))?;
                        if search_cancelled(cancel) {
                            return Ok(cancelled_search_result(hits, scanned));
                        }
                        if !q.semantic {
                            total_matched = Some(page.total_matched);
                        }
                        scanned = page.events.len() as u64;
                        let kw_l = pattern.to_lowercase();
                        let tokens: Vec<&str> = kw_l
                            .split(|c: char| !c.is_alphanumeric())
                            .filter(|t| t.len() > 1)
                            .collect();
                        for e in page.events {
                            let msg_l = e.message.to_lowercase();
                            let mut hit_n = 0usize;
                            for t in &tokens {
                                if msg_l.contains(t) {
                                    hit_n += 1;
                                }
                            }
                            let score = if tokens.is_empty() {
                                if msg_l.contains(&kw_l) {
                                    1.0
                                } else {
                                    0.0
                                }
                            } else {
                                hit_n as f32 / tokens.len() as f32
                            };
                            if score <= 0.0 {
                                continue;
                            }
                            if hits.iter().any(|h| h.event.seq == e.seq) {
                                continue;
                            }
                            let excerpt = msg_l
                                .find(&kw_l)
                                .map(|idx| excerpt_around(&e.message, idx, idx + pattern.len()));
                            hits.push(EventSearchHit {
                                template_id: Some(e.template_id),
                                event: e,
                                score,
                                match_kind: "keyword".into(),
                                excerpt,
                            });
                        }
                        if hits.len() >= k {
                            partial = true;
                            diagnostic = Some(format!("result cap reached ({k})"));
                        }
                    }
                }
            }
        }
    }

    if q.semantic {
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.event.seq.cmp(&b.event.seq))
        });
    } else {
        hits.sort_by(|a, b| {
            a.event
                .ts
                .cmp(&b.event.ts)
                .then_with(|| a.event.seq.cmp(&b.event.seq))
        });
    }
    hits.truncate(k);
    if !q.semantic && partial {
        if let Some(last) = hits.last() {
            next_cursor = Some(last.event.seq);
            next_ts = Some(last.event.ts);
        } else if let Some((ts, seq)) = last_scanned {
            next_cursor = Some(seq);
            next_ts = Some(ts);
        }
    }
    Ok(EventSearchResult {
        hits,
        next_cursor,
        next_ts,
        total_matched,
        partial,
        diagnostic,
        cancelled: false,
        scanned,
    })
}

/// Compile a linear-time regex with size/syntax validation before any corpus scan.
fn compile_bounded_regex(pattern: &str, case_sensitive: bool) -> CoreResult<regex::Regex> {
    if pattern.len() > MAX_SEARCH_PATTERN_LEN {
        return Err(CoreError::Message(format!(
            "regex pattern exceeds max length ({MAX_SEARCH_PATTERN_LEN})"
        )));
    }
    // Reject empty and absurdly nested constructs early via build errors.
    let mut builder = regex::RegexBuilder::new(pattern);
    builder.case_insensitive(!case_sensitive);
    // Size limit on compiled automaton (bytes) — bounds memory for adversarial patterns.
    builder.size_limit(1 << 20); // 1 MiB
    builder.dfa_size_limit(1 << 20);
    builder
        .build()
        .map_err(|e| CoreError::Message(format!("invalid regex (validated before scan): {e}")))
}

fn excerpt_around(message: &str, start: usize, end: usize) -> String {
    let start = start.min(message.len());
    let end = end.min(message.len()).max(start);
    let pad = 40usize;
    let from_byte = start.saturating_sub(pad);
    let to_byte = (end + pad).min(message.len());
    // Char-safe window via char_indices (avoid panicking string_slice).
    let chars: Vec<(usize, char)> = message.char_indices().collect();
    let from_i = chars
        .iter()
        .rposition(|(i, _)| *i <= from_byte)
        .unwrap_or(0);
    let to_i = chars
        .iter()
        .position(|(i, _)| *i >= to_byte)
        .unwrap_or(chars.len());
    let slice: String = chars[from_i..to_i].iter().map(|(_, c)| *c).collect();
    let mut s = String::new();
    if from_i > 0 {
        s.push('…');
    }
    s.push_str(&slice);
    if to_i < chars.len() {
        s.push('…');
    }
    if s.chars().count() > MAX_SEARCH_EXCERPT_LEN {
        s = s.chars().take(MAX_SEARCH_EXCERPT_LEN).collect();
        s.push('…');
    }
    s
}

// ── Stable event neighborhood (Find / bookmark / agent seek) ────────────────

/// Max events before/after the target in a neighborhood fetch.
pub const MAX_NEIGHBORHOOD_RADIUS: usize = 200;
/// Default radius on each side of the target.
pub const DEFAULT_NEIGHBORHOOD_RADIUS: usize = 50;

/// Whether the target was resolved and how it relates to active filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetResolveStatus {
    /// Target exists and matches the active filter set.
    Found,
    /// Target exists in the corpus but is excluded by current filters.
    HiddenByFilter,
    /// No event with this stable seq in the corpus.
    Missing,
}

/// Request a bounded window around a stable event identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventNeighborhoodQuery {
    /// Stable event sequence to resolve.
    pub target_seq: u64,
    /// Events strictly before the target (clamped).
    #[serde(default = "default_neighborhood_radius")]
    pub before: usize,
    /// Events strictly after the target (clamped).
    #[serde(default = "default_neighborhood_radius")]
    pub after: usize,
    /// Active filters (same semantics as [`EventQuery`]).
    #[serde(default)]
    pub filter: EventQuery,
    /// Sort by time then seq (default true).
    #[serde(default = "default_true")]
    pub sort_by_time: bool,
}

fn default_neighborhood_radius() -> usize {
    DEFAULT_NEIGHBORHOOD_RADIUS
}

impl Default for EventNeighborhoodQuery {
    fn default() -> Self {
        Self {
            target_seq: 0,
            before: DEFAULT_NEIGHBORHOOD_RADIUS,
            after: DEFAULT_NEIGHBORHOOD_RADIUS,
            filter: EventQuery::default(),
            sort_by_time: true,
        }
    }
}

/// Bounded neighborhood around a stable target event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventNeighborhood {
    /// Resolution of the requested target.
    pub status: TargetResolveStatus,
    /// The target event when present (even if hidden by filters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ExplorerEvent>,
    /// Ascending window: older … target (if found under filters) … newer.
    pub events: Vec<ExplorerEvent>,
    /// Index of the target inside `events` when status is Found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_index: Option<usize>,
    /// Forward keyset seq for continuing newer paging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<u64>,
    /// Forward keyset ts paired with `next_cursor` when time-sorted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ts: Option<i64>,
    /// Reverse keyset seq for continuing older paging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_cursor: Option<u64>,
    /// Reverse keyset ts paired with `prev_cursor` when time-sorted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_ts: Option<i64>,
    /// Total events matching the active filter (not neighborhood size).
    pub total_matched: u64,
    /// Total events in the corpus (unfiltered).
    pub corpus_total: u64,
    /// Time-quality summary for the returned window.
    pub time_quality: TimeQuality,
}

/// Resolve a stable event identity and return a bounded neighborhood.
///
/// Does **not** scan from corpus start: looks up `target_seq` directly, then
/// fetches `before`/`after` via composite keyset queries. Distinguishes
/// missing vs hidden-by-filter. Offline and bounded; never returns absolute paths.
pub fn query_event_neighborhood(
    corpus: &LogCorpus,
    q: &EventNeighborhoodQuery,
) -> CoreResult<EventNeighborhood> {
    let before = q.before.clamp(0, MAX_NEIGHBORHOOD_RADIUS);
    let after = q.after.clamp(0, MAX_NEIGHBORHOOD_RADIUS);
    let corpus_total = corpus.event_count() as u64;

    // 1) Direct identity lookup — indexed by seq, not a full corpus scan.
    let Some(target) = fetch_event_by_seq(corpus, q.target_seq)? else {
        return Ok(EventNeighborhood {
            status: TargetResolveStatus::Missing,
            target: None,
            events: vec![],
            target_index: None,
            next_cursor: None,
            next_ts: None,
            prev_cursor: None,
            prev_ts: None,
            total_matched: 0,
            corpus_total,
            time_quality: corpus_time_quality_from_meta(corpus),
        });
    };

    // 2) Does the target match active filters?
    let mut filter = q.filter.clone();
    filter.sort_by_time = q.sort_by_time;
    let matches_filter = event_matches_filter(&target, &filter);

    if !matches_filter {
        // Hidden: still return the target alone so callers can explain / reveal.
        return Ok(EventNeighborhood {
            status: TargetResolveStatus::HiddenByFilter,
            target: Some(target),
            events: vec![],
            target_index: None,
            next_cursor: None,
            next_ts: None,
            prev_cursor: None,
            prev_ts: None,
            total_matched: count_matched(corpus, &filter)?,
            corpus_total,
            time_quality: corpus_time_quality_from_meta(corpus),
        });
    }

    // 3) Older side: reverse keyset ending at target.
    let older_page = if before > 0 {
        let mut oq = filter.clone();
        oq.before_seq = Some(target.seq);
        oq.before_ts = if q.sort_by_time {
            Some(target.ts)
        } else {
            None
        };
        oq.after_seq = None;
        oq.after_ts = None;
        oq.limit = before;
        oq.sort_by_time = q.sort_by_time;
        query_events(corpus, &oq)?
    } else {
        EventPage {
            events: vec![],
            next_cursor: None,
            next_ts: None,
            prev_cursor: None,
            prev_ts: None,
            total_matched: 0,
            time_quality: TimeQuality::OrderOnly,
        }
    };
    let mut older = older_page.events;

    // 4) Newer side: forward keyset starting after target.
    let newer = if after > 0 {
        let mut nq = filter.clone();
        nq.after_seq = Some(target.seq);
        nq.after_ts = if q.sort_by_time {
            Some(target.ts)
        } else {
            None
        };
        nq.before_seq = None;
        nq.before_ts = None;
        nq.limit = after;
        nq.sort_by_time = q.sort_by_time;
        query_events(corpus, &nq)?
    } else {
        EventPage {
            events: vec![],
            next_cursor: None,
            next_ts: None,
            prev_cursor: None,
            prev_ts: None,
            total_matched: 0,
            time_quality: TimeQuality::OrderOnly,
        }
    };

    // Directional cursors from the outer edges when more data may exist.
    let (prev_cursor, prev_ts) = if older_page.prev_cursor.is_some() {
        (older_page.prev_cursor, older_page.prev_ts)
    } else if !older.is_empty() && older.len() == before {
        (
            older.first().map(|e| e.seq),
            if q.sort_by_time {
                older.first().map(|e| e.ts)
            } else {
                None
            },
        )
    } else {
        (None, None)
    };
    let (next_cursor, next_ts) = (newer.next_cursor, newer.next_ts);

    let mut events = Vec::with_capacity(older.len() + 1 + newer.events.len());
    events.append(&mut older);
    let target_index = events.len();
    events.push(target.clone());
    events.extend(newer.events);

    let tq = summarize_event_quality(&events);
    let total_matched = count_matched(corpus, &filter)?;

    Ok(EventNeighborhood {
        status: TargetResolveStatus::Found,
        target: Some(target),
        events,
        target_index: Some(target_index),
        next_cursor,
        next_ts,
        prev_cursor,
        prev_ts,
        total_matched,
        corpus_total,
        time_quality: tq,
    })
}

pub(crate) fn fetch_event_by_seq(
    corpus: &LogCorpus,
    seq: u64,
) -> CoreResult<Option<ExplorerEvent>> {
    corpus.with_connection(|conn| {
        let sql =
            "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source \
                   FROM events WHERE seq = ? LIMIT 1";
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let binds = [Value::BigInt(seq as i64)];
        let mut rows = bind_and_map_events(&mut stmt, &binds)?;
        Ok(rows.pop())
    })
}

pub(crate) fn fetch_events_by_seqs(
    corpus: &LogCorpus,
    seqs: &[u64],
) -> CoreResult<Vec<ExplorerEvent>> {
    if seqs.is_empty() {
        return Ok(vec![]);
    }
    let mut unique = seqs.to_vec();
    unique.sort_unstable();
    unique.dedup();
    corpus.with_connection(|conn| {
        let mut events = Vec::with_capacity(unique.len());
        for chunk in unique.chunks(MAX_EVENT_PAGE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source \
                 FROM events WHERE seq IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql).map_err(duck_err)?;
            let binds = chunk
                .iter()
                .map(|seq| Value::BigInt(*seq as i64))
                .collect::<Vec<_>>();
            events.extend(bind_and_map_events(&mut stmt, &binds)?);
        }
        Ok(events)
    })
}

fn count_matched(corpus: &LogCorpus, filter: &EventQuery) -> CoreResult<u64> {
    let (where_sql, binds) = build_where(filter);
    let count_sql = format!("SELECT COUNT(*) FROM events WHERE {where_sql}");
    corpus.with_connection(|conn| {
        let mut stmt = conn.prepare(&count_sql).map_err(duck_err)?;
        let n = bind_and_query_row_i64(&mut stmt, &binds)?;
        Ok(n.max(0) as u64)
    })
}

fn event_matches_filter(event: &ExplorerEvent, filter: &EventQuery) -> bool {
    if let Some(from) = filter.time_from {
        if event.ts < from {
            return false;
        }
    }
    if let Some(to) = filter.time_to {
        if event.ts >= to {
            return false;
        }
    }
    if let Some(from) = filter.seq_from {
        if event.seq < from {
            return false;
        }
    }
    if let Some(to) = filter.seq_to {
        if event.seq > to {
            return false;
        }
    }
    if let Some(tid) = filter.template_id {
        if event.template_id != tid {
            return false;
        }
    }
    if !filter.template_ids.is_empty() && !filter.template_ids.contains(&event.template_id) {
        return false;
    }
    if !filter.levels.is_empty() {
        let lvl = event.level.to_ascii_lowercase();
        if !filter.levels.iter().any(|l| l.eq_ignore_ascii_case(&lvl)) {
            return false;
        }
    }
    if !filter.sources.is_empty() && !filter.sources.iter().any(|s| s == &event.source) {
        return false;
    }
    if !filter.services.is_empty() {
        let svc = event.service.clone().unwrap_or_default();
        if !filter.services.iter().any(|s| s == &svc) {
            return false;
        }
    }
    if !filter.hosts.is_empty() {
        let host = event.host.clone().unwrap_or_default();
        if !filter.hosts.iter().any(|h| h == &host) {
            return false;
        }
    }
    if let Some(ref tid) = filter.trace_id {
        if event.trace_id.as_deref() != Some(tid.as_str()) {
            return false;
        }
    }
    if let Some(ref kw) = filter.keyword {
        let kw = kw.trim();
        if !kw.is_empty() && !event.message.to_lowercase().contains(&kw.to_lowercase()) {
            return false;
        }
    }
    true
}

// ── SQL builders (parameterized) ────────────────────────────────────────────

use duckdb::types::Value;

/// Builds WHERE clause with `?` placeholders and binds in **appearance order**.
fn build_where(q: &EventQuery) -> (String, Vec<Value>) {
    let mut clauses = vec!["1=1".to_string()];
    let mut binds: Vec<Value> = Vec::new();

    if let Some(from) = q.time_from {
        clauses.push("ts >= ?".into());
        binds.push(Value::BigInt(from));
    }
    if let Some(to) = q.time_to {
        clauses.push("ts < ?".into());
        binds.push(Value::BigInt(to));
    }
    if let Some(from) = q.seq_from {
        clauses.push("seq >= ?".into());
        binds.push(Value::BigInt(from as i64));
    }
    if let Some(to) = q.seq_to {
        clauses.push("seq <= ?".into());
        binds.push(Value::BigInt(to as i64));
    }
    if let Some(tid) = q.template_id {
        clauses.push("template_id = ?".into());
        binds.push(Value::BigInt(tid as i64));
    }
    if !q.template_ids.is_empty() {
        let placeholders: Vec<_> = q.template_ids.iter().map(|_| "?").collect();
        clauses.push(format!("template_id IN ({})", placeholders.join(",")));
        for tid in &q.template_ids {
            binds.push(Value::BigInt(*tid as i64));
        }
    }
    if !q.levels.is_empty() {
        let placeholders: Vec<_> = q.levels.iter().map(|_| "?").collect();
        clauses.push(format!("level IN ({})", placeholders.join(",")));
        for l in &q.levels {
            binds.push(Value::Text(l.clone()));
        }
    }
    if !q.sources.is_empty() {
        let placeholders: Vec<_> = q.sources.iter().map(|_| "?").collect();
        clauses.push(format!("source IN ({})", placeholders.join(",")));
        for s in &q.sources {
            binds.push(Value::Text(s.clone()));
        }
    }
    if !q.services.is_empty() {
        let placeholders: Vec<_> = q.services.iter().map(|_| "?").collect();
        clauses.push(format!(
            "COALESCE(service, '') IN ({})",
            placeholders.join(",")
        ));
        for s in &q.services {
            binds.push(Value::Text(s.clone()));
        }
    }
    if !q.hosts.is_empty() {
        let placeholders: Vec<_> = q.hosts.iter().map(|_| "?").collect();
        clauses.push(format!(
            "COALESCE(host, '') IN ({})",
            placeholders.join(",")
        ));
        for h in &q.hosts {
            binds.push(Value::Text(h.clone()));
        }
    }
    if let Some(ref tid) = q.trace_id {
        clauses.push("trace_id = ?".into());
        binds.push(Value::Text(tid.clone()));
    }
    if let Some(ref kw) = q.keyword {
        if !kw.trim().is_empty() {
            clauses.push("lower(message) LIKE ?".into());
            binds.push(Value::Text(format!("%{}%", kw.to_lowercase())));
        }
    }

    (clauses.join(" AND "), binds)
}

fn params_ref(values: &[Value]) -> Vec<&dyn duckdb::ToSql> {
    values.iter().map(|v| v as &dyn duckdb::ToSql).collect()
}

fn bind_and_query_row_i64(stmt: &mut duckdb::Statement<'_>, values: &[Value]) -> CoreResult<i64> {
    stmt.query_row(params_ref(values).as_slice(), |r| r.get::<_, i64>(0))
        .map_err(duck_err)
}

fn bind_and_map_events(
    stmt: &mut duckdb::Statement<'_>,
    values: &[Value],
) -> CoreResult<Vec<ExplorerEvent>> {
    let rows = stmt
        .query_map(params_ref(values).as_slice(), |r| {
            Ok(LogEvent {
                seq: r.get::<_, i64>(0)? as u64,
                ts: r.get(1)?,
                level: r.get(2)?,
                service: r.get(3)?,
                host: r.get(4)?,
                template_id: r.get::<_, i64>(5)? as u64,
                params: {
                    let s: String = r.get(6)?;
                    serde_json::from_str(&s).unwrap_or_default()
                },
                trace_id: r.get(7)?,
                message: r.get(8)?,
                source: r.get(9)?,
            })
        })
        .map_err(duck_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(ExplorerEvent::from(row.map_err(duck_err)?));
    }
    Ok(out)
}

fn bind_and_map_kv(
    stmt: &mut duckdb::Statement<'_>,
    values: &[Value],
) -> CoreResult<Vec<(String, u64)>> {
    let rows = stmt
        .query_map(params_ref(values).as_slice(), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        })
        .map_err(duck_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(duck_err)?);
    }
    Ok(out)
}

fn bind_and_map_source_catalog(
    stmt: &mut duckdb::Statement<'_>,
    values: &[Value],
) -> CoreResult<Vec<LogSourceCatalogEntry>> {
    let rows = stmt
        .query_map(params_ref(values).as_slice(), |row| {
            Ok(LogSourceCatalogEntry {
                source: row.get(0)?,
                event_count: row.get::<_, i64>(1)?.max(0) as u64,
            })
        })
        .map_err(duck_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(duck_err)?);
    }
    Ok(out)
}

fn duck_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Message(format!("duckdb: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::log_analysis::ingest::ingest_path;
    use std::io::Write;

    fn multi_source_fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut api = std::fs::File::create(logs.join("api.log")).unwrap();
        let mut worker = std::fs::File::create(logs.join("worker.log")).unwrap();
        for i in 0..40 {
            writeln!(
                api,
                r#"{{"ts":{},"level":"error","service":"api","host":"h1","trace_id":"trace-api","message":"auth failure user {}"}}"#,
                1_700_000_000 + i,
                i
            )
            .unwrap();
            writeln!(
                worker,
                r#"{{"ts":{},"level":"info","service":"worker","host":"h2","message":"job completed id={}"}}"#,
                1_700_000_100 + i,
                i
            )
            .unwrap();
        }
        let mut plain = std::fs::File::create(logs.join("plain.log")).unwrap();
        for i in 0..10 {
            writeln!(plain, "plain line without timestamp {i}").unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(&cache, &logs, "fixture", Some(&backend), "c").unwrap();
        (dir, report.corpus_id)
    }

    fn shared_timeline_fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("api.log"),
            concat!(
                "{\"ts\":1700000000,\"level\":\"error\",\"message\":\"api failed\"}\n",
                "{\"ts\":1700000004,\"level\":\"warn\",\"message\":\"api retry\"}\n",
            ),
        )
        .unwrap();
        std::fs::write(
            logs.join("worker.log"),
            concat!(
                "{\"ts\":1700000009,\"level\":\"info\",\"message\":\"worker done\"}\n",
                "{\"ts\":1700000009,\"level\":\"debug\",\"message\":\"worker detail\"}\n",
                "{\"ts\":1700000009,\"level\":\"audit\",\"message\":\"worker custom\"}\n",
            ),
        )
        .unwrap();
        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &logs, "shared-timeline", None, "none").unwrap();
        (dir, report.corpus_id)
    }

    fn high_cardinality_source_catalog_fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::create(&cache, "source-catalog").unwrap();
        let corpus_id = corpus.id().to_string();
        corpus
            .with_connection(|conn| {
                conn.execute_batch("BEGIN TRANSACTION").map_err(duck_err)?;
                let mut seq = 0_i64;
                for index in 1..=241 {
                    let source = format!("services/service-{index:03}/application.log");
                    conn.execute(
                        "INSERT INTO events \
                         (seq, ts, level, service, host, template_id, params, trace_id, message, source) \
                         VALUES (?1, ?2, 'info', NULL, NULL, 0, '[]', NULL, 'event', ?3)",
                        duckdb::params![seq, 1_700_000_000_i64 + seq, source],
                    )
                    .map_err(duck_err)?;
                    seq += 1;
                }
                conn.execute(
                    "INSERT INTO events \
                     (seq, ts, level, service, host, template_id, params, trace_id, message, source) \
                     VALUES (?1, ?2, 'error', NULL, NULL, 0, '[]', NULL, 'second event', ?3)",
                    duckdb::params![
                        seq,
                        1_700_000_000_i64 + seq,
                        "services/service-001/application.log"
                    ],
                )
                .map_err(duck_err)?;
                conn.execute_batch("COMMIT").map_err(duck_err)?;
                Ok(())
            })
            .unwrap();
        (dir, corpus_id)
    }

    #[test]
    fn original_representation_preserves_formats_but_stays_out_of_event_pages() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let secret = "sk-abcdefghijklmnop";
        std::fs::write(
            logs.join("json.jsonl"),
            format!(
                r#"{{"message":"visible-json","RAW_ONLY_SENTINEL":{{"order":[3,2,1]}},"token":"{secret}","unicode":"東京"}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            logs.join("logfmt.log"),
            format!(r#"level=warn msg="visible logfmt" custom=kept token={secret}"#),
        )
        .unwrap();
        std::fs::write(
            logs.join("syslog.log"),
            format!("<34>Oct 11 22:14:15 host app: visible syslog token={secret}"),
        )
        .unwrap();
        std::fs::write(
            logs.join("plain.log"),
            format!("ERROR visible plain punctuation!? token={secret}"),
        )
        .unwrap();
        let invalid = b"level=info msg=visible-invalid custom=caf\xc3\xa9-\xff";
        std::fs::write(logs.join("invalid.log"), invalid).unwrap();

        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &logs, "originals", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let page = query_events(
            &corpus,
            &EventQuery {
                sort_by_time: false,
                limit: 20,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.events.len(), 5);

        let originals = page
            .events
            .iter()
            .map(|event| {
                (
                    event.source.clone(),
                    query_event_original(&corpus, event.seq).unwrap(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        let available_text = |source: &str| match originals.get(source).unwrap() {
            EventOriginalRepresentation::Available { text, .. } => text.as_str(),
            other => panic!("{source} should have an original representation: {other:?}"),
        };

        let json = available_text("json.jsonl");
        assert!(json.contains(r#""RAW_ONLY_SENTINEL":{"order":[3,2,1]}"#));
        assert!(json.contains(r#""unicode":"東京""#));
        assert!(!json.contains(secret));
        assert!(available_text("logfmt.log").contains("custom=kept"));
        assert!(available_text("syslog.log").contains("app: visible syslog"));
        assert!(available_text("plain.log").contains("punctuation!?"));
        assert!(!available_text("logfmt.log").contains(secret));
        assert!(!available_text("syslog.log").contains(secret));
        assert!(!available_text("plain.log").contains(secret));
        match originals.get("invalid.log").unwrap() {
            EventOriginalRepresentation::Available {
                text,
                source_byte_count,
                encoding_normalized,
                ..
            } => {
                assert!(text.contains("café-�"));
                assert_eq!(*source_byte_count, invalid.len() as u64);
                assert!(*encoding_normalized);
            }
            other => panic!("invalid UTF-8 source should be normalized: {other:?}"),
        }

        let ordinary_page_json = serde_json::to_string(&page).unwrap();
        assert!(!ordinary_page_json.contains("RAW_ONLY_SENTINEL"));
        assert!(!ordinary_page_json.contains("custom=kept"));
        assert!(!ordinary_page_json.contains(secret));
    }

    #[test]
    fn original_representation_exposes_oversized_record_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let line = format!(
            "INFO {}",
            "ordinary payload ".repeat(super::super::redact_log::MAX_ORIGINAL_REDACTED_BYTES / 8)
        );
        std::fs::write(logs.join("oversized.log"), &line).unwrap();
        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &logs, "oversized-original", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();

        match query_event_original(&corpus, 0).unwrap() {
            EventOriginalRepresentation::Available {
                text,
                source_byte_count,
                redacted_char_count,
                stored_char_count,
                truncated,
                ..
            } => {
                assert!(truncated);
                assert_eq!(source_byte_count, line.len() as u64);
                assert_eq!(redacted_char_count, line.chars().count() as u64);
                assert!(stored_char_count < redacted_char_count);
                assert!(text.len() <= super::super::redact_log::MAX_ORIGINAL_REDACTED_BYTES);
            }
            other => panic!("oversized source should remain explicitly bounded: {other:?}"),
        }
    }

    #[test]
    fn timeline_summary_is_fixed_size_sparse_and_filter_aware() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).expect("open corpus");

        let mixed = query_timeline_summary(
            &corpus,
            &TimelineSummaryQuery {
                max_buckets: 12,
                ..Default::default()
            },
        )
        .expect("mixed summary");
        assert_eq!(mixed.total_matched, 90);
        assert_eq!(mixed.time_quality, TimeQuality::Mixed);
        assert!(mixed.bucket_count <= 12);
        assert!(mixed.buckets.len() <= mixed.bucket_count);
        assert!(
            mixed.buckets.len() < mixed.bucket_count,
            "the wide mixed-time span should keep empty buckets implicit"
        );

        let errors = query_timeline_summary(
            &corpus,
            &TimelineSummaryQuery {
                filter: EventQuery {
                    levels: vec!["error".into()],
                    ..Default::default()
                },
                max_buckets: 7,
            },
        )
        .expect("filtered summary");
        assert_eq!(errors.total_matched, 40);
        assert_eq!(errors.time_quality, TimeQuality::Wall);
        assert!(errors.bucket_count <= 7);
        assert_eq!(
            errors
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            40
        );
        assert!(errors
            .buckets
            .iter()
            .all(|bucket| bucket.by_level.keys().all(|level| level == "error")));
    }

    #[test]
    fn timeline_summary_caps_requested_buckets_and_handles_empty_filters() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).expect("open corpus");

        let capped = query_timeline_summary(
            &corpus,
            &TimelineSummaryQuery {
                max_buckets: usize::MAX,
                ..Default::default()
            },
        )
        .expect("capped summary");
        assert!(capped.bucket_count <= MAX_TIMELINE_BUCKETS);
        assert!(capped.buckets.len() <= MAX_TIMELINE_BUCKETS);

        let empty = query_timeline_summary(
            &corpus,
            &TimelineSummaryQuery {
                filter: EventQuery {
                    keyword: Some("definitely absent marker".into()),
                    ..Default::default()
                },
                max_buckets: 32,
            },
        )
        .expect("empty summary");
        assert_eq!(empty.total_matched, 0);
        assert_eq!(empty.bucket_count, 0);
        assert!(empty.buckets.is_empty());
        assert_eq!(empty.span_from, None);
        assert_eq!(empty.span_to, None);
    }

    #[test]
    fn shared_timeline_uses_one_dense_axis_for_severities_and_source_lanes() {
        let (dir, id) = shared_timeline_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let summary = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                max_buckets: 5,
                lanes: vec![
                    SharedTimelineLaneScope {
                        sources: vec!["api.log".into()],
                    },
                    SharedTimelineLaneScope {
                        sources: vec!["worker.log".into()],
                    },
                    SharedTimelineLaneScope {
                        sources: vec!["api.log".into(), "worker.log".into()],
                    },
                    SharedTimelineLaneScope {
                        sources: vec!["missing.log".into()],
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(summary.time_quality, TimeQuality::Wall);
        assert_eq!(summary.span_from, Some(1_700_000_000));
        assert_eq!(summary.span_to, Some(1_700_000_010));
        assert_eq!(summary.bucket_width, 2);
        assert_eq!(summary.bucket_count, 5);
        assert_eq!(summary.total_matched, 5);
        assert_eq!(summary.counts, vec![1, 0, 1, 0, 3]);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| bucket.index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| (bucket.start, bucket.end))
                .collect::<Vec<_>>(),
            vec![
                (1_700_000_000, 1_700_000_002),
                (1_700_000_002, 1_700_000_004),
                (1_700_000_004, 1_700_000_006),
                (1_700_000_006, 1_700_000_008),
                (1_700_000_008, 1_700_000_010),
            ]
        );

        assert_eq!(
            summary.severity_series.len(),
            SHARED_TIMELINE_SEVERITY_SERIES
        );
        assert_eq!(
            summary
                .severity_series
                .iter()
                .map(|series| series.severity)
                .collect::<Vec<_>>(),
            SharedTimelineSeverity::ALL
        );
        let severity_counts = |severity| {
            &summary
                .severity_series
                .iter()
                .find(|series| series.severity == severity)
                .unwrap()
                .counts
        };
        assert_eq!(
            severity_counts(SharedTimelineSeverity::Error),
            &vec![1, 0, 0, 0, 0]
        );
        assert_eq!(
            severity_counts(SharedTimelineSeverity::Warn),
            &vec![0, 0, 1, 0, 0]
        );
        assert_eq!(
            severity_counts(SharedTimelineSeverity::Info),
            &vec![0, 0, 0, 0, 1]
        );
        assert_eq!(
            severity_counts(SharedTimelineSeverity::Debug),
            &vec![0, 0, 0, 0, 1]
        );
        assert_eq!(
            severity_counts(SharedTimelineSeverity::Other),
            &vec![0, 0, 0, 0, 1],
            "an arbitrary custom level must collapse into the bounded Other series"
        );

        assert_eq!(summary.lanes.len(), 4);
        assert_eq!(summary.lanes[0].counts, vec![1, 0, 1, 0, 0]);
        assert_eq!(summary.lanes[1].counts, vec![0, 0, 0, 0, 3]);
        assert_eq!(summary.lanes[2].counts, summary.counts);
        assert_eq!(summary.lanes[2].source_count, 2);
        assert_eq!(summary.lanes[3].counts, vec![0, 0, 0, 0, 0]);
        assert_eq!(summary.lanes[3].total_matched, 0);
        assert_eq!(summary.lanes[3].time_quality, TimeQuality::OrderOnly);
        assert!(summary
            .severity_series
            .iter()
            .all(|series| series.counts.len() == summary.bucket_count));
        assert!(summary
            .lanes
            .iter()
            .all(|lane| lane.counts.len() == summary.bucket_count));
    }

    #[test]
    fn shared_timeline_intersects_lane_sources_with_the_global_filter() {
        let (dir, id) = shared_timeline_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let summary = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                filter: EventQuery {
                    sources: vec!["api.log".into()],
                    ..Default::default()
                },
                max_buckets: 5,
                lanes: vec![
                    SharedTimelineLaneScope {
                        sources: vec!["api.log".into(), "worker.log".into()],
                    },
                    SharedTimelineLaneScope {
                        sources: vec!["worker.log".into()],
                    },
                    SharedTimelineLaneScope { sources: vec![] },
                ],
            },
        )
        .unwrap();

        assert_eq!(summary.total_matched, 2);
        assert_eq!(summary.lanes[0].source_count, 1);
        assert_eq!(summary.lanes[0].total_matched, 2);
        assert_eq!(summary.lanes[0].counts, summary.counts);
        assert_eq!(summary.lanes[1].source_count, 0);
        assert_eq!(summary.lanes[1].total_matched, 0);
        assert!(summary.lanes[1].counts.iter().all(|count| *count == 0));
        assert_eq!(summary.lanes[2].source_count, 0);
        assert_eq!(summary.lanes[2].total_matched, 0);
    }

    #[test]
    fn shared_timeline_canonical_severity_aliases_match_the_ui_contract() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::create(&cache, "severity-aliases").unwrap();
        let aliases = [
            ("fatal", SharedTimelineSeverity::Error),
            ("critical", SharedTimelineSeverity::Error),
            ("crit", SharedTimelineSeverity::Error),
            ("severe", SharedTimelineSeverity::Error),
            ("error", SharedTimelineSeverity::Error),
            ("err", SharedTimelineSeverity::Error),
            ("warning", SharedTimelineSeverity::Warn),
            ("warn", SharedTimelineSeverity::Warn),
            ("info", SharedTimelineSeverity::Info),
            ("notice", SharedTimelineSeverity::Info),
            ("debug", SharedTimelineSeverity::Debug),
            ("trace", SharedTimelineSeverity::Debug),
            ("audit", SharedTimelineSeverity::Other),
            ("unknown", SharedTimelineSeverity::Other),
        ];
        corpus
            .with_connection(|conn| {
                for (seq, (level, _)) in aliases.iter().enumerate() {
                    conn.execute(
                        "INSERT INTO events \
                         (seq, ts, level, service, host, template_id, params, trace_id, message, source) \
                         VALUES (?1, ?2, ?3, NULL, NULL, 0, '[]', NULL, ?3, 'aliases.log')",
                        duckdb::params![seq as i64, 1_700_000_000_i64, level],
                    )
                    .map_err(duck_err)?;
                }
                Ok(())
            })
            .unwrap();

        let summary =
            query_shared_timeline_summary(&corpus, &SharedTimelineSummaryQuery::default()).unwrap();
        assert_eq!(summary.bucket_count, 1);
        assert_eq!(summary.total_matched, aliases.len() as u64);
        for severity in SharedTimelineSeverity::ALL {
            let expected = aliases
                .iter()
                .filter(|(_, expected)| *expected == severity)
                .count() as u64;
            let series = summary
                .severity_series
                .iter()
                .find(|series| series.severity == severity)
                .unwrap();
            assert_eq!(
                series.counts,
                vec![expected],
                "{severity:?} aliases must match the UI's canonical mapping"
            );
        }
    }

    #[test]
    fn shared_timeline_preserves_mixed_and_order_only_time_honesty() {
        let (dir, id) = multi_source_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let mixed = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                max_buckets: 12,
                lanes: vec![
                    SharedTimelineLaneScope {
                        sources: vec!["api.log".into()],
                    },
                    SharedTimelineLaneScope {
                        sources: vec!["plain.log".into()],
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(mixed.time_quality, TimeQuality::Mixed);
        assert_eq!(mixed.lanes[0].time_quality, TimeQuality::Wall);
        assert_eq!(mixed.lanes[1].time_quality, TimeQuality::OrderOnly);

        let order_only = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                filter: EventQuery {
                    sources: vec!["plain.log".into()],
                    ..Default::default()
                },
                max_buckets: 4,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(order_only.time_quality, TimeQuality::OrderOnly);
        assert_eq!(order_only.total_matched, 10);
        assert_eq!(order_only.counts.iter().sum::<u64>(), 10);
    }

    #[test]
    fn shared_timeline_enforces_bucket_lane_source_and_response_caps() {
        let (dir, id) = shared_timeline_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let capped = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                max_buckets: usize::MAX,
                lanes: (0..MAX_SHARED_TIMELINE_LANES)
                    .map(|_| SharedTimelineLaneScope {
                        sources: vec!["api.log".into()],
                    })
                    .collect(),
                ..Default::default()
            },
        )
        .unwrap();
        let explicit_cap = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                max_buckets: MAX_TIMELINE_BUCKETS,
                lanes: (0..MAX_SHARED_TIMELINE_LANES)
                    .map(|_| SharedTimelineLaneScope {
                        sources: vec!["api.log".into()],
                    })
                    .collect(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(capped, explicit_cap);
        assert!(capped.bucket_count <= MAX_TIMELINE_BUCKETS);
        assert_eq!(capped.lanes.len(), MAX_SHARED_TIMELINE_LANES);
        assert_eq!(
            capped.severity_series.len(),
            SHARED_TIMELINE_SEVERITY_SERIES
        );
        let dense_cells = capped.counts.len()
            + capped
                .severity_series
                .iter()
                .map(|series| series.counts.len())
                .sum::<usize>()
            + capped
                .lanes
                .iter()
                .map(|lane| lane.counts.len())
                .sum::<usize>();
        assert!(dense_cells <= MAX_SHARED_TIMELINE_COUNT_CELLS);

        let too_many_lanes = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                lanes: (0..=MAX_SHARED_TIMELINE_LANES)
                    .map(|_| SharedTimelineLaneScope::default())
                    .collect(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(too_many_lanes.to_string().contains("lane cap exceeded"));

        let too_many_sources = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                lanes: vec![SharedTimelineLaneScope {
                    sources: (0..=MAX_SHARED_TIMELINE_LANE_SOURCES)
                        .map(|index| format!("source-{index}.log"))
                        .collect(),
                }],
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(too_many_sources.to_string().contains("source cap exceeded"));
    }

    #[test]
    fn shared_timeline_empty_filter_keeps_fixed_series_and_requested_lanes() {
        let (dir, id) = shared_timeline_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let empty = query_shared_timeline_summary(
            &corpus,
            &SharedTimelineSummaryQuery {
                filter: EventQuery {
                    keyword: Some("absent timeline marker".into()),
                    ..Default::default()
                },
                lanes: vec![SharedTimelineLaneScope {
                    sources: vec!["api.log".into()],
                }],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(empty.bucket_count, 0);
        assert!(empty.buckets.is_empty());
        assert!(empty.counts.is_empty());
        assert_eq!(empty.severity_series.len(), SHARED_TIMELINE_SEVERITY_SERIES);
        assert!(empty
            .severity_series
            .iter()
            .all(|series| series.counts.is_empty()));
        assert_eq!(empty.lanes.len(), 1);
        assert_eq!(empty.lanes[0].source_count, 1);
        assert!(empty.lanes[0].counts.is_empty());
        assert_eq!(empty.lanes[0].total_matched, 0);
    }

    #[test]
    fn query_page_caps_and_filters() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).expect("open corpus");
        let page = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["error".into()],
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!page.events.is_empty());
        assert!(page.events.len() <= 10);
        assert!(page.events.iter().all(|e| e.level == "error"));
        assert!(page.total_matched >= page.events.len() as u64);
        // Full page ⇒ next cursor present with composite ts.
        if page.events.len() == 10 {
            assert!(page.next_cursor.is_some());
            assert!(page.next_ts.is_some());
        }

        let exact = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["error".into()],
                limit: page.total_matched as usize,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(exact.events.len() as u64, exact.total_matched);
        assert!(
            exact.next_cursor.is_none() && exact.next_ts.is_none(),
            "an exact-limit final page must be a known boundary"
        );
        assert!(
            exact.prev_cursor.is_none() && exact.prev_ts.is_none(),
            "an initial page cannot have older matching rows"
        );

        let next = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["error".into()],
                after_seq: page.next_cursor,
                after_ts: page.next_ts,
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        if let (Some(cseq), Some(cts)) = (page.next_cursor, page.next_ts) {
            for e in &next.events {
                assert!(
                    e.ts > cts || (e.ts == cts && e.seq > cseq),
                    "time-sort keyset must advance past ({cts},{cseq}); got seq={} ts={}",
                    e.seq,
                    e.ts
                );
            }
        }

        let big = query_events(
            &corpus,
            &EventQuery {
                limit: 10_000,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(big.events.len() <= MAX_EVENT_PAGE);
        // Partial last page must not offer another page.
        if (big.events.len() as u64) < big.total_matched.min(MAX_EVENT_PAGE as u64) {
            // when total fits in one page
        }
        if big.events.len() < big.total_matched as usize && big.events.len() == MAX_EVENT_PAGE {
            assert!(big.next_cursor.is_some());
        } else if big.events.len() < MAX_EVENT_PAGE {
            assert!(
                big.next_cursor.is_none(),
                "partial page must not set next_cursor"
            );
            assert!(big.next_ts.is_none());
        }

        let api_only = query_events(
            &corpus,
            &EventQuery {
                sources: vec!["api.log".into()],
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!api_only.events.is_empty());
        assert!(api_only.events.iter().all(|e| e.source.contains("api")));
    }

    #[test]
    fn sequence_range_is_inclusive_and_composes_with_structured_filters() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let api = query_events(
            &corpus,
            &EventQuery {
                sources: vec!["api.log".into()],
                services: vec!["api".into()],
                hosts: vec!["h1".into()],
                limit: 10,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(api.events.len() >= 4);
        let seq_from = api.events[1].seq;
        let seq_to = api.events[3].seq;
        let template_id = api.events[1].template_id;

        let ranged = query_events(
            &corpus,
            &EventQuery {
                seq_from: Some(seq_from),
                seq_to: Some(seq_to),
                sources: vec!["api.log".into()],
                services: vec!["api".into()],
                hosts: vec!["h1".into()],
                template_id: Some(template_id),
                trace_id: Some("trace-api".into()),
                limit: 20,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            ranged
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![seq_from, api.events[2].seq, seq_to]
        );
        assert_eq!(ranged.total_matched, 3);
        assert!(ranged
            .events
            .iter()
            .all(|event| event.template_id == template_id
                && event.trace_id.as_deref() == Some("trace-api")));
    }

    #[test]
    fn multi_source_lane_filter_pages_complete() {
        // Each "lane" is a source-group filter; page each to end under time sort.
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        for src in ["api.log", "worker.log"] {
            let mut seen = std::collections::HashSet::new();
            let mut after_seq = None;
            let mut after_ts = None;
            let mut total;
            loop {
                let page = query_events(
                    &corpus,
                    &EventQuery {
                        sources: vec![src.into()],
                        limit: 7,
                        sort_by_time: true,
                        after_seq,
                        after_ts,
                        ..Default::default()
                    },
                )
                .unwrap();
                total = page.total_matched;
                for e in &page.events {
                    assert!(
                        e.source.contains(src.trim_end_matches(".log"))
                            || e.source == src
                            || e.source.ends_with(src),
                        "source filter leak: {}",
                        e.source
                    );
                    assert!(seen.insert(e.seq), "dup seq {}", e.seq);
                }
                if page.next_cursor.is_none() {
                    break;
                }
                after_seq = page.next_cursor;
                after_ts = page.next_ts;
            }
            assert_eq!(
                seen.len() as u64,
                total,
                "lane {src}: paged union must match total_matched"
            );
            assert!(total > 0, "lane {src} empty");
        }
    }

    #[test]
    fn time_sort_refuses_seq_only_cursor() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let err = query_events(
            &corpus,
            &EventQuery {
                sort_by_time: true,
                after_seq: Some(1),
                after_ts: None,
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            format!("{err}").contains("after_ts"),
            "must refuse seq-only under time sort: {err}"
        );
    }

    /// Multi-file late-ts-first ingest: seq order ≠ wall time. Time-sorted
    /// paging with composite keyset must return every event exactly once.
    #[test]
    fn query_time_sort_pages_complete() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        // Lexical walk: late.log before early.log would be wrong; force order
        // by creating a_late then b_early so ingest assigns early seqs to late ts.
        let mut late = std::fs::File::create(logs.join("a_late.log")).unwrap();
        for i in 0..4 {
            writeln!(
                late,
                r#"{{"ts":{},"level":"info","service":"late","message":"late {i}"}}"#,
                2_000_000_000 + i
            )
            .unwrap();
        }
        let mut early = std::fs::File::create(logs.join("b_early.log")).unwrap();
        for i in 0..4 {
            writeln!(
                early,
                r#"{{"ts":{},"level":"info","service":"early","message":"early {i}"}}"#,
                1_700_000_000 + i
            )
            .unwrap();
        }
        // Overlapping wall ts across sources (same ts, different seq).
        let mut mid = std::fs::File::create(logs.join("c_mid.log")).unwrap();
        for i in 0..4 {
            writeln!(
                mid,
                r#"{{"ts":{},"level":"info","service":"mid","message":"mid {i}"}}"#,
                1_700_000_001 + i // overlaps early timestamps
            )
            .unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = ingest_path(&cache, &logs, "keyset", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();

        let limit = 4usize;
        let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut after_seq: Option<u64> = None;
        let mut after_ts: Option<i64> = None;
        let mut pages = 0usize;
        let mut total_matched;
        loop {
            let page = query_events(
                &corpus,
                &EventQuery {
                    limit,
                    sort_by_time: true,
                    after_seq,
                    after_ts,
                    ..Default::default()
                },
            )
            .unwrap();
            total_matched = page.total_matched;
            pages += 1;
            assert!(pages < 50, "pagination did not terminate (cursor bug?)");
            for e in &page.events {
                assert!(seen.insert(e.seq), "duplicate seq {} across pages", e.seq);
            }
            // Events within a page are ordered by (ts, seq)
            for w in page.events.windows(2) {
                let a = &w[0];
                let b = &w[1];
                assert!(
                    a.ts < b.ts || (a.ts == b.ts && a.seq < b.seq),
                    "page not ordered by (ts,seq): ({},{}) then ({},{})",
                    a.ts,
                    a.seq,
                    b.ts,
                    b.seq
                );
            }
            if page.next_cursor.is_none() {
                assert!(page.next_cursor.is_none());
                assert!(page.next_ts.is_none());
                break;
            }
            assert_eq!(
                page.events.len(),
                limit,
                "a continuation cursor requires a full visible page"
            );
            assert!(page.next_cursor.is_some() && page.next_ts.is_some());
            after_seq = page.next_cursor;
            after_ts = page.next_ts;
        }

        assert_eq!(
            seen.len() as u64,
            total_matched,
            "union of pages must equal total_matched; seen={} total={} (seq-only keyset would drop late-ts early-seq rows)",
            seen.len(),
            total_matched
        );
        assert!(
            total_matched >= 12,
            "fixture should have ≥12 events, got {total_matched}"
        );
        // Prove we would have failed under seq-only keyset: early-seq late-ts
        // events must appear in the union.
        let late_present = corpus.with_events(|evs| {
            evs.iter()
                .filter(|e| e.source.contains("a_late"))
                .all(|e| seen.contains(&e.seq))
        });
        assert!(
            late_present,
            "all late-file events must appear in paged results"
        );
    }

    /// #538: reverse keyset must return the adjacent older window, not corpus head.
    #[test]
    fn query_reverse_before_cursor_is_adjacent_older_window() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();

        let first = query_events(
            &corpus,
            &EventQuery {
                limit: 10,
                sort_by_time: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(first.events.len(), 10);
        assert!(first.next_cursor.is_some() && first.next_ts.is_some());
        assert!(
            first.prev_cursor.is_none() && first.prev_ts.is_none(),
            "the initial page is the known start of the matched range"
        );

        let second = query_events(
            &corpus,
            &EventQuery {
                limit: 10,
                sort_by_time: true,
                after_seq: first.next_cursor,
                after_ts: first.next_ts,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(second.events.len(), 10);
        let second_first = second.events.first().unwrap();

        // Reverse from the second page head must recover the first page's last rows.
        let older = query_events(
            &corpus,
            &EventQuery {
                limit: 10,
                sort_by_time: true,
                before_seq: Some(second_first.seq),
                before_ts: Some(second_first.ts),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(older.events.len(), 10, "adjacent older page size");
        // Ascending order after reverse-fetch.
        for w in older.events.windows(2) {
            assert!(
                w[0].ts < w[1].ts || (w[0].ts == w[1].ts && w[0].seq < w[1].seq),
                "older page must be ASC"
            );
        }
        // Must be exactly the first page contents (adjacent), not corpus head drift.
        let first_seqs: Vec<u64> = first.events.iter().map(|e| e.seq).collect();
        let older_seqs: Vec<u64> = older.events.iter().map(|e| e.seq).collect();
        assert_eq!(
            older_seqs, first_seqs,
            "before-cursor reverse page must equal the preceding forward page"
        );
        // No overlap with second page.
        let second_seqs: std::collections::HashSet<u64> =
            second.events.iter().map(|e| e.seq).collect();
        for s in &older_seqs {
            assert!(!second_seqs.contains(s), "overlap seq {s}");
        }
    }

    /// Owner regression: job-7f3a=13, ERROR=7, AND=4 (#523).
    #[test]
    fn owner_filter_intersection_job_7f3a_and_error() {
        let workspace = tempfile::tempdir().unwrap();
        let cache = workspace.path().join("cache");
        let import = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/log-lab/scenarios/checkout-cascade/import");
        let report = ingest_path(&cache, &import, "checkout-cascade", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();

        let keyword = query_events(
            &corpus,
            &EventQuery {
                keyword: Some("job-7f3a".into()),
                limit: MAX_EVENT_PAGE,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            keyword.total_matched, 13,
            "job-7f3a keyword hits must be 13, got {}",
            keyword.total_matched
        );

        let errors = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["error".into()],
                limit: MAX_EVENT_PAGE,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            errors.total_matched, 7,
            "ERROR rows must be 7, got {}",
            errors.total_matched
        );

        let both = query_events(
            &corpus,
            &EventQuery {
                keyword: Some("job-7f3a".into()),
                levels: vec!["error".into()],
                limit: MAX_EVENT_PAGE,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            both.total_matched, 4,
            "job-7f3a AND ERROR must be 4 (not 7 or 13), got {}",
            both.total_matched
        );
        // Toggling level must not drop keyword.
        assert!(
            both.events
                .iter()
                .all(|e| e.level.eq_ignore_ascii_case("error")
                    && e.message.to_lowercase().contains("job-7f3a")),
            "intersection rows must satisfy both predicates"
        );
    }

    #[test]
    fn facets_list_sources_and_levels() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let f = query_facets(&corpus, &EventQuery::default()).unwrap();
        assert!(f.sources.keys().any(|s| s.contains("api")));
        assert!(f.levels.keys().any(|l| l == "error"));
        assert!(matches!(
            f.time_quality,
            TimeQuality::Wall | TimeQuality::Mixed | TimeQuality::OrderOnly
        ));
    }

    #[test]
    fn source_catalog_pages_all_241_full_paths_without_gaps_or_duplicates() {
        let (dir, id) = high_cardinality_source_catalog_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let mut cursor = None;
        let mut sources = Vec::new();
        let mut pages = 0;

        loop {
            let page = query_source_catalog(
                &corpus,
                &LogSourceCatalogQuery {
                    cursor: cursor.clone(),
                    limit: 37,
                    ..Default::default()
                },
            )
            .unwrap();
            pages += 1;
            assert_eq!(page.total_matched, 241);
            assert!(page.sources.len() <= 37);
            assert!(page
                .sources
                .windows(2)
                .all(|pair| pair[0].source < pair[1].source));
            if let Some(next) = &page.next_cursor {
                assert_eq!(
                    Some(next.as_str()),
                    page.sources.last().map(|entry| entry.source.as_str()),
                    "continuation must be the last returned full-path identity"
                );
            }
            sources.extend(page.sources);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
            assert!(pages < 20, "source catalog pagination did not terminate");
        }

        assert_eq!(pages, 7);
        assert_eq!(sources.len(), 241);
        assert!(sources
            .windows(2)
            .all(|pair| pair[0].source < pair[1].source));
        assert_eq!(
            sources
                .iter()
                .map(|entry| entry.source.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            241
        );
        assert!(sources
            .iter()
            .any(|entry| entry.source == "services/service-241/application.log"));
        assert_eq!(
            sources
                .iter()
                .find(|entry| entry.source == "services/service-001/application.log")
                .map(|entry| entry.event_count),
            Some(2)
        );
        assert!(
            sources
                .iter()
                .all(|entry| entry.source.ends_with("/application.log")),
            "duplicate basenames must remain distinct by full relative path"
        );

        let repeated_first = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                limit: 37,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(repeated_first.sources, sources[..37]);
    }

    #[test]
    fn source_catalog_search_is_case_insensitive_literal_and_cursor_safe() {
        let (dir, id) = high_cardinality_source_catalog_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let matched = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                search: Some("SERVICE-241/APPLICATION".into()),
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(matched.total_matched, 1);
        assert_eq!(
            matched.sources,
            vec![LogSourceCatalogEntry {
                source: "services/service-241/application.log".into(),
                event_count: 1,
            }]
        );
        assert_eq!(matched.next_cursor, None);

        let wildcard_literal = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                search: Some("%_".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(wildcard_literal.total_matched, 0);

        let first = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let error = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                search: Some("service-241".into()),
                cursor: first.next_cursor,
                limit: 1,
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("not present under the current corpus search"),
            "{error}"
        );
    }

    #[test]
    fn source_catalog_rejects_unbounded_or_invalid_requests() {
        let (dir, id) = high_cardinality_source_catalog_fixture();
        let corpus = LogCorpus::open(&dir.path().join("cache"), &id).unwrap();
        let defaults: LogSourceCatalogQuery =
            serde_json::from_str("{}").expect("omitted IPC fields use bounded defaults");
        let default_page = query_source_catalog(&corpus, &defaults).unwrap();
        assert_eq!(default_page.sources.len(), DEFAULT_SOURCE_CATALOG_PAGE);
        assert_eq!(default_page.total_matched, 241);
        assert!(default_page.next_cursor.is_some());

        for query in [
            LogSourceCatalogQuery {
                limit: MAX_SOURCE_CATALOG_PAGE + 1,
                ..Default::default()
            },
            LogSourceCatalogQuery {
                search: Some("x".repeat(MAX_SOURCE_CATALOG_SEARCH_CHARS + 1)),
                ..Default::default()
            },
            LogSourceCatalogQuery {
                cursor: Some(String::new()),
                ..Default::default()
            },
            LogSourceCatalogQuery {
                cursor: Some("missing/source.log".into()),
                ..Default::default()
            },
            LogSourceCatalogQuery {
                cursor: Some("x".repeat(MAX_SOURCE_CATALOG_CURSOR_BYTES + 1)),
                ..Default::default()
            },
        ] {
            assert!(
                query_source_catalog(&corpus, &query).is_err(),
                "request must fail closed: {query:?}"
            );
        }
    }

    #[test]
    fn time_quality_wall_vs_order() {
        assert_eq!(classify_ts(1_700_000_000), TimeQuality::Wall);
        assert_eq!(classify_ts(42), TimeQuality::OrderOnly);
        assert_eq!(classify_ts(0), TimeQuality::OrderOnly);
    }

    #[test]
    fn search_events_keyword_and_template_semantic() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let backend = ConceptEmbedBackend::new(64);

        let kw = search_events(
            &corpus,
            &EventSearchQuery {
                query: Some("auth failure".into()),
                semantic: false,
                k: 20,
                filter: EventQuery::default(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(
            !kw.is_empty(),
            "keyword search must hit auth failure events"
        );
        assert!(kw.iter().all(|h| h.match_kind == "keyword"));
        assert!(kw
            .iter()
            .any(|h| h.event.message.to_lowercase().contains("auth")));

        let sem = search_events(
            &corpus,
            &EventSearchQuery {
                query: Some("login authentication denied".into()),
                semantic: true,
                k: 20,
                filter: EventQuery::default(),
                ..Default::default()
            },
            Some(&backend),
        )
        .unwrap();
        for h in &sem {
            assert!(
                h.match_kind == "template_semantic" || h.match_kind == "keyword",
                "unexpected kind {}",
                h.match_kind
            );
        }
        let _ = sem;
    }

    #[test]
    fn advanced_find_intersects_independent_keyword_filter_in_all_modes() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let keyword_filter = EventQuery {
            keyword: Some("user 1".into()),
            ..Default::default()
        };

        let literal = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some("auth failure".into()),
                semantic: false,
                k: 50,
                filter: keyword_filter.clone(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(literal.total_matched, Some(11));
        assert_eq!(literal.hits.len(), 11);

        let case_sensitive = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some("auth failure".into()),
                semantic: false,
                k: 50,
                filter: keyword_filter.clone(),
                case_sensitive: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(case_sensitive.hits.len(), 11);

        let regex = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some(r"auth failure user \d+".into()),
                semantic: false,
                k: 50,
                filter: keyword_filter.clone(),
                match_mode: SearchMatchMode::Regex,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(regex.hits.len(), 11);

        let backend = ConceptEmbedBackend::new(64);
        let semantic = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some("login authentication denied".into()),
                semantic: true,
                k: 50,
                filter: keyword_filter,
                ..Default::default()
            },
            Some(&backend),
        )
        .unwrap();
        assert!(!semantic.hits.is_empty());

        for result in [&literal, &case_sensitive, &regex, &semantic] {
            assert!(
                result
                    .hits
                    .iter()
                    .all(|hit| hit.event.message.to_lowercase().contains("user 1")),
                "active Filter keyword must constrain every Find mode"
            );
        }
    }

    #[test]
    fn regex_search_validates_syntax_and_escapes_metacharacters() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();

        let bad = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some("(".into()),
                match_mode: SearchMatchMode::Regex,
                semantic: false,
                k: 20,
                ..Default::default()
            },
            None,
        );
        assert!(bad.is_err(), "invalid regex must fail before scan");
        let err = bad.unwrap_err().to_string();
        assert!(err.contains("invalid regex"), "{err}");

        // Literal metacharacters escaped in regex.
        let hits = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some(r"auth failure user \d+".into()),
                match_mode: SearchMatchMode::Regex,
                semantic: false,
                k: 20,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(
            !hits.hits.is_empty(),
            "regex should match auth failure lines"
        );
        assert!(hits.hits.iter().all(|h| h.match_kind == "regex"));
        assert!(hits.hits.iter().any(|h| h.excerpt.is_some()));

        // Adversarial repetition compiles (linear engine) and does not hang.
        let adv = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some(r"(a+)+$".into()),
                match_mode: SearchMatchMode::Regex,
                semantic: false,
                k: 5,
                ..Default::default()
            },
            None,
        );
        // May be invalid in rust regex (no backrefs/complex) or empty hits — must not panic.
        assert!(adv.is_ok() || adv.is_err());
    }

    #[test]
    fn advanced_find_cancellation_stops_scan_and_returns_terminal_honesty() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let checks = std::cell::Cell::new(0usize);
        let cancel = || {
            let next = checks.get() + 1;
            checks.set(next);
            next >= 8
        };

        let result = search_events_advanced_with_cancel(
            &corpus,
            &EventSearchQuery {
                query: Some(r"user \d+".into()),
                match_mode: SearchMatchMode::Regex,
                semantic: false,
                k: 50,
                ..Default::default()
            },
            None,
            Some(&cancel),
        )
        .unwrap();

        assert!(result.cancelled);
        assert!(result.partial);
        assert_eq!(result.diagnostic.as_deref(), Some("cancelled"));
        assert!(result.scanned > 0 && result.scanned < 90);
        assert_eq!(result.next_cursor, None);
        assert_eq!(result.next_ts, None);
    }

    #[test]
    fn search_result_cursor_pages_literal_without_gaps_or_duplicates() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let mut after_seq = None;
        let mut after_ts = None;
        let mut seen = Vec::new();
        let mut pages = 0;

        loop {
            let result = search_events_advanced(
                &corpus,
                &EventSearchQuery {
                    query: Some("auth failure".into()),
                    semantic: false,
                    k: 7,
                    filter: EventQuery {
                        after_seq,
                        after_ts,
                        sort_by_time: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                None,
            )
            .unwrap();
            assert_eq!(result.total_matched, Some(40));
            for pair in result.hits.windows(2) {
                assert!(
                    pair[0].event.ts < pair[1].event.ts
                        || (pair[0].event.ts == pair[1].event.ts
                            && pair[0].event.seq < pair[1].event.seq)
                );
            }
            seen.extend(result.hits.iter().map(|hit| hit.event.seq));
            pages += 1;
            match (result.next_cursor, result.next_ts) {
                (Some(seq), Some(ts)) => {
                    after_seq = Some(seq);
                    after_ts = Some(ts);
                }
                (None, None) => break,
                cursors => panic!("incomplete composite search cursor: {cursors:?}"),
            }
            assert!(pages < 20, "search cursor failed to reach end");
        }

        assert_eq!(pages, 6);
        assert_eq!(seen.len(), 40);
        let unique: std::collections::HashSet<_> = seen.iter().copied().collect();
        assert_eq!(unique.len(), seen.len());
    }

    #[test]
    fn search_result_cursor_pages_regex_without_gaps_or_duplicates() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let mut after_seq = None;
        let mut after_ts = None;
        let mut seen = Vec::new();

        for _ in 0..20 {
            let result = search_events_advanced(
                &corpus,
                &EventSearchQuery {
                    query: Some(r"auth failure user \d+".into()),
                    match_mode: SearchMatchMode::Regex,
                    semantic: false,
                    k: 9,
                    filter: EventQuery {
                        after_seq,
                        after_ts,
                        sort_by_time: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                None,
            )
            .unwrap();
            seen.extend(result.hits.iter().map(|hit| hit.event.seq));
            match (result.next_cursor, result.next_ts) {
                (Some(seq), Some(ts)) => {
                    after_seq = Some(seq);
                    after_ts = Some(ts);
                }
                (None, None) => break,
                cursors => panic!("incomplete composite regex cursor: {cursors:?}"),
            }
        }

        assert_eq!(seen.len(), 40);
        let unique: std::collections::HashSet<_> = seen.iter().copied().collect();
        assert_eq!(unique.len(), seen.len());
    }

    #[test]
    fn regex_rejects_oversized_pattern() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let huge = "a".repeat(MAX_SEARCH_PATTERN_LEN + 10);
        let r = search_events_advanced(
            &corpus,
            &EventSearchQuery {
                query: Some(huge),
                match_mode: SearchMatchMode::Regex,
                semantic: false,
                k: 10,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(r.hits.is_empty());
        assert!(r.diagnostic.as_deref().unwrap_or("").contains("max length"));
    }

    #[test]
    fn neighborhood_resolves_target_without_scanning_from_start() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let all = query_events(
            &corpus,
            &EventQuery {
                limit: 200,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(all.events.len() >= 10, "fixture too small");
        let target = &all.events[all.events.len() / 2];

        let nb = query_event_neighborhood(
            &corpus,
            &EventNeighborhoodQuery {
                target_seq: target.seq,
                before: 5,
                after: 5,
                filter: EventQuery::default(),
                sort_by_time: true,
            },
        )
        .unwrap();
        assert_eq!(nb.status, TargetResolveStatus::Found);
        assert_eq!(nb.target.as_ref().map(|e| e.seq), Some(target.seq));
        let idx = nb.target_index.expect("target index");
        assert_eq!(nb.events[idx].seq, target.seq);
        assert!(idx <= 5);
        assert!(nb.events.len() <= 11);
        assert!(nb.corpus_total >= nb.total_matched);
        // Window is ordered ascending by time/seq.
        for w in nb.events.windows(2) {
            assert!(
                w[0].ts < w[1].ts || (w[0].ts == w[1].ts && w[0].seq < w[1].seq),
                "neighborhood not ordered"
            );
        }
    }

    #[test]
    fn neighborhood_distinguishes_missing_and_hidden_by_filter() {
        let (dir, id) = multi_source_fixture();
        let cache = dir.path().join("cache");
        let corpus = LogCorpus::open(&cache, &id).unwrap();
        let page = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["info".into()],
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let target = page.events.first().expect("info event under level filter");

        let missing = query_event_neighborhood(
            &corpus,
            &EventNeighborhoodQuery {
                target_seq: u64::MAX - 7,
                before: 3,
                after: 3,
                filter: EventQuery::default(),
                sort_by_time: true,
            },
        )
        .unwrap();
        assert_eq!(missing.status, TargetResolveStatus::Missing);
        assert!(missing.events.is_empty());
        assert!(missing.target.is_none());

        let hidden = query_event_neighborhood(
            &corpus,
            &EventNeighborhoodQuery {
                target_seq: target.seq,
                before: 3,
                after: 3,
                filter: EventQuery {
                    levels: vec!["error".into()],
                    ..Default::default()
                },
                sort_by_time: true,
            },
        )
        .unwrap();
        assert_eq!(hidden.status, TargetResolveStatus::HiddenByFilter);
        assert_eq!(hidden.target.as_ref().map(|e| e.seq), Some(target.seq));
        assert!(
            hidden.events.is_empty(),
            "hidden targets do not invent a filtered window"
        );
    }

    #[test]
    fn neighborhood_works_with_equal_timestamps_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("same_ts.log")).unwrap();
        let base = 1_700_000_100_i64;
        for i in 0..20 {
            writeln!(
                f,
                r#"{{"ts":{base},"level":"{}","service":"svc","message":"eq-ts event {i}"}}"#,
                if i == 10 { "error" } else { "info" },
            )
            .unwrap();
        }
        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &logs, "eq-ts", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let all = query_events(
            &corpus,
            &EventQuery {
                limit: 50,
                sort_by_time: true,
                ..Default::default()
            },
        )
        .unwrap();
        let target = all
            .events
            .iter()
            .find(|e| e.message.contains("event 10"))
            .unwrap();
        let nb = query_event_neighborhood(
            &corpus,
            &EventNeighborhoodQuery {
                target_seq: target.seq,
                before: 4,
                after: 4,
                filter: EventQuery::default(),
                sort_by_time: true,
            },
        )
        .unwrap();
        assert_eq!(nb.status, TargetResolveStatus::Found);
        assert!(nb.events.iter().any(|e| e.seq == target.seq));
        // Equal timestamps still order by seq around the target.
        let idx = nb.target_index.unwrap();
        if idx > 0 {
            assert!(nb.events[idx - 1].seq < target.seq);
        }
        if idx + 1 < nb.events.len() {
            assert!(nb.events[idx + 1].seq > target.seq);
        }
    }
}
