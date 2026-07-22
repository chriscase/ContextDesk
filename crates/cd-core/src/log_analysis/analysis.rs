//! cluster_problems + timeline (#361).

use super::store::LogCorpus;
use crate::error::CoreResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One problem cluster summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSummary {
    /// Cluster id (lowest template id).
    pub cluster_id: u64,
    /// Member template ids.
    pub template_ids: Vec<u64>,
    /// Representative pattern.
    pub label: String,
    /// Combined event count.
    pub count: u64,
    /// Max severity in cluster.
    pub severity: u8,
    /// Ranking score = severity × log(count) × anomaly hint.
    pub score: f32,
    /// Exemplar messages.
    pub exemplars: Vec<String>,
}

/// Timeline bucket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineBucket {
    /// Bucket start unix secs.
    pub start: i64,
    /// Bucket width secs.
    pub width: i64,
    /// Count of events in bucket.
    pub count: u64,
    /// Count by level.
    pub by_level: HashMap<String, u64>,
}

/// Cluster templates by pattern token Jaccard + severity.
pub fn cluster_problems(
    corpus: &LogCorpus,
    max_clusters: usize,
) -> CoreResult<Vec<ClusterSummary>> {
    let templates = corpus.list_templates();
    if templates.is_empty() {
        return Ok(vec![]);
    }
    // Greedy clustering: assign each template to first cluster with sim >= 0.4
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for (i, row) in templates.iter().enumerate() {
        let toks_i = tokenize(&row.info.pattern);
        let mut placed = false;
        for c in clusters.iter_mut() {
            let j = c[0];
            let toks_j = tokenize(&templates[j].info.pattern);
            if jaccard(&toks_i, &toks_j) >= 0.4 {
                c.push(i);
                placed = true;
                break;
            }
        }
        if !placed {
            clusters.push(vec![i]);
        }
    }

    // Exemplars from events
    let mut exemplars: HashMap<u64, Vec<String>> = HashMap::new();
    corpus.with_events(|events| {
        for e in events {
            let ex = exemplars.entry(e.template_id).or_default();
            if ex.len() < 2 {
                ex.push(e.message.chars().take(120).collect());
            }
        }
    });

    let mut out = Vec::new();
    for c in clusters {
        let mut tids = Vec::new();
        let mut count = 0u64;
        let mut severity = 0u8;
        let mut label = String::new();
        let mut ex = Vec::new();
        let mut min_id = u64::MAX;
        for &i in &c {
            let t = &templates[i];
            tids.push(t.info.template_id);
            count += t.info.count;
            severity = severity.max(t.info.severity);
            if label.is_empty() {
                label = t.info.pattern.clone();
            }
            min_id = min_id.min(t.info.template_id);
            if let Some(e) = exemplars.get(&t.info.template_id) {
                for s in e {
                    if ex.len() < 3 {
                        ex.push(s.clone());
                    }
                }
            }
        }
        let anomaly = if count <= 2 { 1.5 } else { 1.0 };
        let score = (severity as f32) * ((count as f32).ln_1p()) * anomaly;
        out.push(ClusterSummary {
            cluster_id: min_id,
            template_ids: tids,
            label,
            count,
            severity,
            score,
            exemplars: ex,
        });
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(max_clusters.max(1));
    Ok(out)
}

/// Frequency-over-time for events matching optional filters.
pub fn timeline(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
) -> CoreResult<Vec<TimelineBucket>> {
    let width = width_secs.max(1);
    let mut buckets: HashMap<i64, TimelineBucket> = HashMap::new();
    corpus.with_events(|events| {
        for e in events {
            if let Some(lvl) = level {
                if !e.level.eq_ignore_ascii_case(lvl) {
                    continue;
                }
            }
            if let Some(svc) = service {
                if e.service.as_deref() != Some(svc) {
                    continue;
                }
            }
            let start = (e.ts / width) * width;
            let b = buckets.entry(start).or_insert_with(|| TimelineBucket {
                start,
                width,
                count: 0,
                by_level: HashMap::new(),
            });
            b.count += 1;
            *b.by_level.entry(e.level.clone()).or_insert(0) += 1;
        }
    });
    let mut v: Vec<_> = buckets.into_values().collect();
    v.sort_by_key(|b| b.start);
    Ok(v)
}

fn tokenize(s: &str) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for t in s.split(|c: char| !c.is_alphanumeric() && c != '*') {
        if t.is_empty() || t == "<*>" {
            continue;
        }
        *m.entry(t.to_lowercase()).or_insert(0) += 1;
    }
    m
}

fn jaccard(a: &HashMap<String, usize>, b: &HashMap<String, usize>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut inter = 0usize;
    let mut union = 0usize;
    let mut keys: HashSet<&String> = a.keys().collect();
    keys.extend(b.keys());
    for k in keys {
        let ca = a.get(k).copied().unwrap_or(0);
        let cb = b.get(k).copied().unwrap_or(0);
        inter += ca.min(cb);
        union += ca.max(cb);
    }
    if union == 0 {
        0.0
    } else {
        inter as f32 / union as f32
    }
}

use std::collections::HashSet;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::ingest::ingest_path;
    use std::io::Write;

    #[test]
    fn clusters_and_timeline_on_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("x.log")).unwrap();
        for i in 0..200 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused {i}"}}"#,
                1000 + i
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"ts":{},"level":"info","service":"api","message":"heartbeat ok"}}"#,
                1000 + i
            )
            .unwrap();
        }
        let report = ingest_path(dir.path(), &logs, "a", None, "x").unwrap();
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        let clusters = cluster_problems(&corpus, 10).unwrap();
        assert!(!clusters.is_empty());
        assert!(clusters[0].count >= 1);
        let tl = timeline(&corpus, 50, None, Some("api")).unwrap();
        assert!(!tl.is_empty());
        let total: u64 = tl.iter().map(|b| b.count).sum();
        assert_eq!(total, corpus.event_count() as u64);
    }
}
