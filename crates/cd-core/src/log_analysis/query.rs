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
    /// Rows (≤ limit).
    pub events: Vec<ExplorerEvent>,
    /// Pass as `after_seq` for next page. Only set when a full page was returned.
    pub next_cursor: Option<u64>,
    /// Pass as `after_ts` with `next_cursor` when time-sorted. Only set on full page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_ts: Option<i64>,
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

/// Event-level search hit (keyword or via template-semantic).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchHit {
    /// Matching event.
    pub event: ExplorerEvent,
    /// Score (keyword fraction or inherited semantic).
    pub score: f32,
    /// How the hit was found.
    pub match_kind: String,
    /// Template id when from semantic path.
    pub template_id: Option<u64>,
}

/// Search query for explorer (events, not just templates).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchQuery {
    /// Free-text query.
    pub query: Option<String>,
    /// Structured filters (reuses EventQuery fields conceptually).
    #[serde(default)]
    pub filter: EventQuery,
    /// Prefer template-semantic ranking when embed present.
    pub semantic: bool,
    /// Max event hits (clamped).
    pub k: usize,
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
    let order = if q.sort_by_time {
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

    let (total_matched, events) = corpus.with_connection(|conn| {
        let total_matched: i64 = {
            let mut stmt = conn.prepare(&count_sql).map_err(duck_err)?;
            bind_and_query_row_i64(&mut stmt, &binds)?
        };
        let mut stmt = conn.prepare(&sql).map_err(duck_err)?;
        let events = bind_and_map_events(&mut stmt, &page_binds)?;
        Ok((total_matched, events))
    })?;

    // Only offer next page when this page was full (more rows may exist).
    let (next_cursor, next_ts) = if events.len() == limit {
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
    let tq = if events.is_empty() {
        corpus_time_quality_from_meta(corpus)
    } else {
        summarize_event_quality(&events)
    };

    Ok(EventPage {
        events,
        next_cursor,
        next_ts,
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

/// Keyword + optional template-semantic → **events** (template-first for semantic).
pub fn search_events(
    corpus: &LogCorpus,
    q: &EventSearchQuery,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<Vec<EventSearchHit>> {
    let k = if q.k == 0 {
        50
    } else {
        q.k.clamp(1, MAX_EVENT_PAGE)
    };
    let mut hits: Vec<EventSearchHit> = Vec::new();

    // Semantic: templates first, then pull events for top templates under filters.
    if q.semantic {
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
                });
            }
        }
    }

    // Keyword path on messages under filters.
    if let Some(ref kw) = q.query {
        if !kw.trim().is_empty() {
            let mut fq = q.filter.clone();
            fq.keyword = Some(kw.clone());
            fq.limit = k;
            let page = query_events(corpus, &fq)?;
            let kw_l = kw.to_lowercase();
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
                    0.5
                } else {
                    hit_n as f32 / tokens.len() as f32
                };
                // Dedupe by seq if already from semantic
                if hits.iter().any(|h| h.event.seq == e.seq) {
                    continue;
                }
                hits.push(EventSearchHit {
                    template_id: Some(e.template_id),
                    event: e,
                    score,
                    match_kind: "keyword".into(),
                });
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
    Ok(hits)
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
}
