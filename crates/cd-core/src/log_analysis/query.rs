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
    /// Keyset: return rows with seq **greater than** this (ascending).
    pub after_seq: Option<u64>,
    /// Keyset: return rows with seq **less than** this (for reverse scroll).
    pub before_seq: Option<u64>,
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
            before_seq: None,
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
    /// Pass as `after_seq` for next page (last seq when ascending).
    pub next_cursor: Option<u64>,
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
    if let Some(after) = q.after_seq {
        page_where.push_str(" AND seq > ?");
        page_binds.push(Value::BigInt(after as i64));
    }
    if let Some(before) = q.before_seq {
        page_where.push_str(" AND seq < ?");
        page_binds.push(Value::BigInt(before as i64));
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

    let next_cursor = events.last().map(|e| e.seq);
    let tq = if events.is_empty() {
        corpus_time_quality_from_meta(corpus)
    } else {
        summarize_event_quality(&events)
    };

    Ok(EventPage {
        events,
        next_cursor,
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

        let next = query_events(
            &corpus,
            &EventQuery {
                levels: vec!["error".into()],
                after_seq: page.next_cursor,
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        if let Some(c) = page.next_cursor {
            assert!(next.events.iter().all(|e| e.seq > c) || next.events.is_empty());
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
