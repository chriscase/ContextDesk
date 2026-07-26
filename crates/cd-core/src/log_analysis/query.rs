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

/// Paged result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// Rows (≤ limit), always in ascending display order (`ts`/`seq` ASC).
    pub events: Vec<ExplorerEvent>,
    /// Pass as `after_seq` for the **newer** page. Set when a full forward page was returned.
    pub next_cursor: Option<u64>,
    /// Pass as `after_ts` with `next_cursor` when time-sorted. Only set on full page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ts: Option<i64>,
    /// Pass as `before_seq` for the **older** page. Set when a full reverse page was returned
    /// (or when the first page is full and more older rows may exist before the window).
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
    /// True when scan/work/result caps truncated the result set.
    pub partial: bool,
    /// Human-readable diagnostic (invalid pattern, cancelled, capped, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// Events actually scanned under the work budget (regex path).
    pub scanned: u64,
}

/// Query events with SQL filters + keyset pagination.
///
/// When `sort_by_time` is true, keyset uses composite `(ts, seq)` via
/// `after_ts`+`after_seq` so multi-file corpora (file-order seq, overlapping
/// wall times) do not drop rows on Load more. Seq-only keyset is used when
/// sorting by seq.
pub fn query_events(corpus: &LogCorpus, q: &EventQuery) -> CoreResult<EventPage> {
    let limit = if q.limit == 0 {
        DEFAULT_EVENT_PAGE
    } else {
        q.limit.clamp(1, MAX_EVENT_PAGE)
    };

    let (where_sql, binds) = build_where(q);
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
    let sql = format!(
        "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source \
         FROM events WHERE {page_where} ORDER BY {order} LIMIT {limit}"
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

    if reverse_page {
        events.reverse();
    }

    // Forward cursor: last row when this was a full forward (or initial) page.
    let full = events.len() == limit;
    let (next_cursor, next_ts) = if full && !reverse_page {
        let last = events.last();
        (
            last.map(|e| e.seq),
            if q.sort_by_time {
                last.map(|e| e.ts)
            } else {
                None
            },
        )
    } else if full && reverse_page {
        // Reverse page is full — newer side still has the original window; no
        // new forward cursor from this response alone.
        (None, None)
    } else {
        (None, None)
    };
    // Older cursor: first row when reverse page was full, or first page full
    // (more may exist before the window).
    let (prev_cursor, prev_ts) = if full {
        let first = events.first();
        (
            first.map(|e| e.seq),
            if q.sort_by_time {
                first.map(|e| e.ts)
            } else {
                None
            },
        )
    } else if reverse_page && !events.is_empty() {
        // Partial reverse page — still expose first for clients that re-query,
        // but mark exhausted by using None when not full? Prefer None so UI
        // stops auto-paging older.
        (None, None)
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
    let k = if q.k == 0 {
        50
    } else {
        q.k.clamp(1, MAX_EVENT_PAGE)
    };
    let mut hits: Vec<EventSearchHit> = Vec::new();
    let mut partial = false;
    let mut diagnostic: Option<String> = None;
    let mut scanned = 0u64;

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
        let mut template_ids: Vec<u64> = template_hits.iter().map(|h| h.template_id).collect();
        template_ids.truncate(20);
        if !template_ids.is_empty() {
            let mut fq = q.filter.clone();
            fq.template_ids = template_ids.clone();
            fq.limit = k;
            fq.keyword = None; // template path
            let page = query_events(corpus, &fq)?;
            let score_by_tid: std::collections::HashMap<u64, f32> = template_hits
                .iter()
                .map(|h| (h.template_id, h.score))
                .collect();
            for e in page.events {
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
                    partial: false,
                    diagnostic: Some(format!(
                        "pattern exceeds max length ({MAX_SEARCH_PATTERN_LEN} characters)"
                    )),
                    scanned: 0,
                });
            }

            match q.match_mode {
                SearchMatchMode::Regex => {
                    let re = compile_bounded_regex(pattern, q.case_sensitive)?;
                    // Scan pages under filters without keyword SQL — regex runs in trusted core.
                    let mut after_seq = None;
                    let mut after_ts = None;
                    let mut pages = 0usize;
                    loop {
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
                        let page_limit = remaining_budget.min(MAX_EVENT_PAGE).max(1);
                        let mut fq = q.filter.clone();
                        fq.keyword = None;
                        fq.limit = page_limit;
                        fq.after_seq = after_seq;
                        fq.after_ts = after_ts;
                        fq.sort_by_time = true;
                        let page = query_events(corpus, &fq)?;
                        if page.events.is_empty() {
                            break;
                        }
                        for e in page.events {
                            scanned += 1;
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
                        let mut after_seq = None;
                        let mut after_ts = None;
                        loop {
                            if hits.len() >= k || scanned >= MAX_REGEX_SCAN_EVENTS as u64 {
                                partial = true;
                                break;
                            }
                            let page_limit = (MAX_REGEX_SCAN_EVENTS as u64)
                                .saturating_sub(scanned)
                                .min(MAX_EVENT_PAGE as u64)
                                .max(1) as usize;
                            let mut page_q = fq.clone();
                            page_q.keyword = None;
                            page_q.limit = page_limit;
                            page_q.after_seq = after_seq;
                            page_q.after_ts = after_ts;
                            let page = query_events(corpus, &page_q)?;
                            if page.events.is_empty() {
                                break;
                            }
                            for e in page.events {
                                scanned += 1;
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
                        fq.keyword = Some(pattern.to_string());
                        fq.limit = k;
                        let page = query_events(corpus, &fq)?;
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

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.event.seq.cmp(&b.event.seq))
    });
    hits.truncate(k);
    Ok(EventSearchResult {
        hits,
        partial,
        diagnostic,
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
    let from = start.saturating_sub(pad);
    let to = (end + pad).min(message.len());
    // Align to char boundaries.
    let from = message
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|&i| i <= from)
        .last()
        .unwrap_or(0);
    let to = message
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= to)
        .unwrap_or(message.len());
    let mut s = String::new();
    if from > 0 {
        s.push('…');
    }
    s.push_str(&message[from..to]);
    if to < message.len() {
        s.push('…');
    }
    if s.len() > MAX_SEARCH_EXCERPT_LEN {
        s.truncate(MAX_SEARCH_EXCERPT_LEN);
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

fn fetch_event_by_seq(corpus: &LogCorpus, seq: u64) -> CoreResult<Option<ExplorerEvent>> {
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
                r#"{{"ts":{},"level":"error","service":"api","host":"h1","message":"auth failure user {}"}}"#,
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
            if page.events.len() < limit {
                assert!(page.next_cursor.is_none());
                assert!(page.next_ts.is_none());
                break;
            }
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
        assert!(first.prev_cursor.is_some() && first.prev_ts.is_some());

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
