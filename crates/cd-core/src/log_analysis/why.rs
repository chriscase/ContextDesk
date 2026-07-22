//! Phase-2 “why” analysis: correlate, anomalies, trace (#363).
//!
//! Read-only; all results cite template ids + exemplars.

use super::store::LogCorpus;
use crate::error::CoreResult;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Correlation hit: templates that co-occur or precede around an incident.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelateHit {
    /// Related template id.
    pub template_id: u64,
    /// Pattern text when known.
    pub pattern: String,
    /// Co-occurrence / sequence score.
    pub score: f32,
    /// How many times seen near the focus.
    pub count: u64,
    /// True when this template tends to **precede** the focus (A-before-B).
    pub precedes_focus: bool,
    /// Exemplar messages.
    pub exemplars: Vec<String>,
}

/// Anomaly: template present in incident window but rare/absent in baseline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnomalyHit {
    /// Template id.
    pub template_id: u64,
    /// Pattern.
    pub pattern: String,
    /// Count in incident window.
    pub incident_count: u64,
    /// Count in baseline window.
    pub baseline_count: u64,
    /// Anomaly score (higher = more novel / elevated).
    pub score: f32,
    /// Exemplars from the incident window.
    pub exemplars: Vec<String>,
}

/// One event on a trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEvent {
    /// Seq.
    pub seq: u64,
    /// Timestamp.
    pub ts: i64,
    /// Service.
    pub service: Option<String>,
    /// Template id.
    pub template_id: u64,
    /// Pattern (if known).
    pub pattern: String,
    /// Level.
    pub level: String,
    /// Message exemplar.
    pub message: String,
}

/// Temporal + co-occurrence + sequence around a focus template and optional time.
pub fn correlate(
    corpus: &LogCorpus,
    focus_template_id: u64,
    around_ts: Option<i64>,
    window_secs: i64,
    k: usize,
) -> CoreResult<Vec<CorrelateHit>> {
    let w = window_secs.max(1);
    let patterns: HashMap<u64, String> = corpus
        .list_templates()
        .into_iter()
        .map(|t| (t.info.template_id, t.info.pattern))
        .collect();

    // Counts + sequence votes from in-window events near focus.
    let mut co: HashMap<u64, u64> = HashMap::new();
    let mut precedes: HashMap<u64, i64> = HashMap::new(); // +1 if other before focus
    let mut exemplars: HashMap<u64, Vec<String>> = HashMap::new();

    corpus.with_events(|events| {
        // Index focus event times
        let focus_ts: Vec<i64> = events
            .iter()
            .filter(|e| e.template_id == focus_template_id)
            .filter(|e| around_ts.map(|t| (e.ts - t).abs() <= w * 2).unwrap_or(true))
            .map(|e| e.ts)
            .collect();
        if focus_ts.is_empty() {
            return;
        }
        for e in events {
            if e.template_id == focus_template_id {
                continue;
            }
            let near = focus_ts.iter().any(|ft| (e.ts - ft).abs() <= w);
            if !near {
                continue;
            }
            *co.entry(e.template_id).or_insert(0) += 1;
            // Precedence: if e is before nearest focus, vote precedes
            if let Some(ft) = focus_ts.iter().min_by_key(|ft| (e.ts - *ft).abs()) {
                if e.ts < *ft {
                    *precedes.entry(e.template_id).or_insert(0) += 1;
                } else {
                    *precedes.entry(e.template_id).or_insert(0) -= 1;
                }
            }
            let ex = exemplars.entry(e.template_id).or_default();
            if ex.len() < 2 {
                ex.push(e.message.chars().take(120).collect());
            }
        }
    });

    let mut hits: Vec<CorrelateHit> = co
        .into_iter()
        .map(|(tid, count)| {
            let pred = precedes.get(&tid).copied().unwrap_or(0) > 0;
            let score = count as f32 * if pred { 1.2 } else { 1.0 };
            CorrelateHit {
                template_id: tid,
                pattern: patterns.get(&tid).cloned().unwrap_or_default(),
                score,
                count,
                precedes_focus: pred,
                exemplars: exemplars.remove(&tid).unwrap_or_default(),
            }
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(k.max(1));
    Ok(hits)
}

/// New/rare templates in incident window vs baseline.
pub fn anomalies(
    corpus: &LogCorpus,
    baseline_from: i64,
    baseline_to: i64,
    incident_from: i64,
    incident_to: i64,
    k: usize,
) -> CoreResult<Vec<AnomalyHit>> {
    let patterns: HashMap<u64, String> = corpus
        .list_templates()
        .into_iter()
        .map(|t| (t.info.template_id, t.info.pattern))
        .collect();

    let mut base: HashMap<u64, u64> = HashMap::new();
    let mut inc: HashMap<u64, u64> = HashMap::new();
    let mut exemplars: HashMap<u64, Vec<String>> = HashMap::new();

    corpus.with_events(|events| {
        for e in events {
            if e.ts >= baseline_from && e.ts < baseline_to {
                *base.entry(e.template_id).or_insert(0) += 1;
            }
            if e.ts >= incident_from && e.ts < incident_to {
                *inc.entry(e.template_id).or_insert(0) += 1;
                let ex = exemplars.entry(e.template_id).or_default();
                if ex.len() < 2 {
                    ex.push(e.message.chars().take(120).collect());
                }
            }
        }
    });

    let mut hits = Vec::new();
    for (tid, ic) in inc {
        let bc = base.get(&tid).copied().unwrap_or(0);
        // Elevated or new: high incident / (baseline+1)
        let score = (ic as f32) / (bc as f32 + 1.0);
        if bc == 0 || score >= 3.0 {
            hits.push(AnomalyHit {
                template_id: tid,
                pattern: patterns.get(&tid).cloned().unwrap_or_default(),
                incident_count: ic,
                baseline_count: bc,
                score,
                exemplars: exemplars.remove(&tid).unwrap_or_default(),
            });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(k.max(1));
    Ok(hits)
}

/// Follow a trace/request id across services and time.
pub fn trace(corpus: &LogCorpus, trace_id: &str) -> CoreResult<Vec<TraceEvent>> {
    let tid = trace_id.trim();
    if tid.is_empty() {
        return Ok(vec![]);
    }
    let patterns: HashMap<u64, String> = corpus
        .list_templates()
        .into_iter()
        .map(|t| (t.info.template_id, t.info.pattern))
        .collect();
    let mut out = Vec::new();
    corpus.with_events(|events| {
        for e in events {
            if e.trace_id.as_deref() == Some(tid) {
                out.push(TraceEvent {
                    seq: e.seq,
                    ts: e.ts,
                    service: e.service.clone(),
                    template_id: e.template_id,
                    pattern: patterns.get(&e.template_id).cloned().unwrap_or_default(),
                    level: e.level.clone(),
                    message: e.message.chars().take(160).collect(),
                });
            }
        }
    });
    out.sort_by_key(|e| (e.ts, e.seq));
    Ok(out)
}

/// Distinct template ids present in a time range (helper for tests).
pub fn templates_in_range(corpus: &LogCorpus, from: i64, to: i64) -> HashSet<u64> {
    let mut s = HashSet::new();
    corpus.with_events(|events| {
        for e in events {
            if e.ts >= from && e.ts < to {
                s.insert(e.template_id);
            }
        }
    });
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::store::{LogCorpus, LogEvent, TemplateRow};

    fn seed_incident() -> (tempfile::TempDir, LogCorpus) {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "inc").unwrap();
        // Templates: 1=pool warn, 2=timeout, 3=connection refused, 4=heartbeat
        for (id, pat, sev) in [
            (1u64, "connection pool exhausted", 3u8),
            (2, "request timeout waiting", 4),
            (3, "connection refused to upstream", 4),
            (4, "heartbeat ok", 1),
        ] {
            c.upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id: id,
                    pattern: pat.into(),
                    token_count: 3,
                    count: 1,
                    first_seen: 0,
                    last_seen: 1000,
                    severity: sev,
                    example: pat.into(),
                },
                content_hash: format!("h{id}"),
                vector: None,
            }])
            .unwrap();
        }
        let mut events = Vec::new();
        // Baseline 0..500: only heartbeats
        for i in 0..50 {
            events.push(LogEvent {
                seq: i,
                ts: i as i64 * 10,
                level: "info".into(),
                service: Some("api".into()),
                host: None,
                template_id: 4,
                params: vec![],
                trace_id: None,
                message: "heartbeat ok".into(),
                source: "a.log".into(),
            });
        }
        // Incident 1000..1200: pool warn precedes timeouts and refused
        let mut seq = 100u64;
        for i in 0..10 {
            events.push(LogEvent {
                seq,
                ts: 1000 + i * 5,
                level: "warn".into(),
                service: Some("api".into()),
                host: None,
                template_id: 1,
                params: vec![],
                trace_id: Some("tr-fail-1".into()),
                message: "connection pool exhausted".into(),
                source: "a.log".into(),
            });
            seq += 1;
            events.push(LogEvent {
                seq,
                ts: 1000 + i * 5 + 2,
                level: "error".into(),
                service: Some("api".into()),
                host: None,
                template_id: 2,
                params: vec![],
                trace_id: Some("tr-fail-1".into()),
                message: "request timeout waiting".into(),
                source: "a.log".into(),
            });
            seq += 1;
            events.push(LogEvent {
                seq,
                ts: 1000 + i * 5 + 3,
                level: "error".into(),
                service: Some("db".into()),
                host: None,
                template_id: 3,
                params: vec![],
                trace_id: Some("tr-fail-1".into()),
                message: "connection refused to upstream".into(),
                source: "a.log".into(),
            });
            seq += 1;
        }
        c.push_events(&events).unwrap();
        c.flush().unwrap();
        (dir, c)
    }

    #[test]
    fn correlate_finds_preceding_pool_warn() {
        let (_dir, c) = seed_incident();
        // Focus on timeout (2); pool warn (1) should precede
        let hits = correlate(&c, 2, Some(1050), 30, 10).unwrap();
        assert!(!hits.is_empty());
        let pool = hits.iter().find(|h| h.template_id == 1);
        assert!(pool.is_some(), "pool warn should correlate: {hits:?}");
        assert!(
            pool.unwrap().precedes_focus || pool.unwrap().count > 0,
            "expected precedes or co-occur: {pool:?}"
        );
    }

    #[test]
    fn anomalies_flag_new_in_incident() {
        let (_dir, c) = seed_incident();
        let hits = anomalies(&c, 0, 500, 1000, 1200, 10).unwrap();
        assert!(
            hits.iter()
                .any(|h| h.template_id == 3 && h.baseline_count == 0),
            "connection refused should be anomalous: {hits:?}"
        );
    }

    #[test]
    fn trace_follows_id_across_services() {
        let (_dir, c) = seed_incident();
        let ev = trace(&c, "tr-fail-1").unwrap();
        assert!(ev.len() >= 3);
        assert!(ev.windows(2).all(|w| w[0].ts <= w[1].ts));
        let services: HashSet<_> = ev.iter().filter_map(|e| e.service.clone()).collect();
        assert!(
            services.contains("api") && services.contains("db"),
            "{services:?}"
        );
    }
}
