//! cluster_problems + timeline (#361).

use super::store::LogCorpus;
use crate::error::{CoreError, CoreResult};
use duckdb::params;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// Maximum number of templates admitted to pairwise problem clustering.
///
/// Candidate selection remains deterministic and reserves capacity for rare
/// templates so a high-cardinality corpus cannot turn clustering into O(T²)
/// work or let frequent templates entirely hide rare severe anomalies.
pub const MAX_CLUSTER_TEMPLATE_CANDIDATES: usize = 512;

/// Maximum number of buckets returned by the agent-facing analysis timeline.
///
/// This is intentionally separate from the Explorer timeline DTOs. The agent
/// tool needs a fixed memory bound even when every event has a unique
/// timestamp.
pub const MAX_ANALYSIS_TIMELINE_BUCKETS: usize = 512;

const RARE_TEMPLATE_MAX_COUNT: u64 = 2;
const RARE_TEMPLATE_CANDIDATE_RESERVE: usize = 64;
const MAX_CLUSTER_EXEMPLARS: usize = 3;
const MAX_EXEMPLAR_CHARS: usize = 120;
const CLUSTER_SIMILARITY_THRESHOLD: f32 = 0.4;

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
    /// True when some available templates could not be assigned to a bounded
    /// prototype without weakening the similarity rule.
    #[serde(default)]
    pub partial: bool,
    /// Templates represented by the returned analysis before max-cluster
    /// result truncation.
    #[serde(default)]
    pub templates_considered: usize,
    /// Templates available in the corpus.
    #[serde(default)]
    pub templates_available: usize,
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

/// Bounded agent-facing timeline plus coarsening disclosure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineAnalysis {
    /// Normalized width requested by the caller (minimum one second).
    pub requested_width: i64,
    /// Width actually used to enforce [`MAX_ANALYSIS_TIMELINE_BUCKETS`].
    pub effective_width: i64,
    /// Whether the effective width is wider than the requested width.
    pub coarsened: bool,
    /// Exact number of events matching the optional filters.
    pub total_count: u64,
    /// Chronological occupied buckets, always bounded.
    pub buckets: Vec<TimelineBucket>,
}

/// Cluster templates by pattern token Jaccard + severity.
pub fn cluster_problems(
    corpus: &LogCorpus,
    max_clusters: usize,
) -> CoreResult<Vec<ClusterSummary>> {
    let all_templates = corpus.list_templates();
    if all_templates.is_empty() {
        return Ok(vec![]);
    }
    let templates_available = all_templates.len();
    let candidate_indices = select_cluster_candidate_indices(&all_templates);
    let candidate_tokens: Vec<_> = candidate_indices
        .iter()
        .map(|&index| tokenize(&all_templates[index].info.pattern))
        .collect();

    // Greedy clustering: assign each template to first cluster with sim >= 0.4
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for candidate_position in 0..candidate_indices.len() {
        let mut placed = false;
        for c in clusters.iter_mut() {
            let prototype_position = c[0];
            if jaccard(
                &candidate_tokens[candidate_position],
                &candidate_tokens[prototype_position],
            ) >= CLUSTER_SIMILARITY_THRESHOLD
            {
                c.push(candidate_position);
                placed = true;
                break;
            }
        }
        if !placed {
            clusters.push(vec![candidate_position]);
        }
    }

    let candidate_ids: HashSet<_> = candidate_indices
        .iter()
        .map(|&index| all_templates[index].info.template_id)
        .collect();
    let mut omitted_indices: Vec<_> = all_templates
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            (!candidate_ids.contains(&row.info.template_id)).then_some(index)
        })
        .collect();
    omitted_indices.sort_by(|&a, &b| template_impact_cmp(&all_templates[a], &all_templates[b]));

    // Candidate clustering stays O(512²). Every omitted template then makes a
    // single deterministic pass over at most 512 prototypes. It joins only an
    // eligible prototype, choosing the highest similarity and then the
    // earliest prototype for ties. Unmatched templates remain explicitly
    // disclosed instead of being silently folded into an unrelated family.
    let mut assigned_omitted = vec![Vec::<usize>::new(); clusters.len()];
    let mut unmatched_omitted = 0usize;
    for omitted_index in omitted_indices {
        let omitted_tokens = tokenize(&all_templates[omitted_index].info.pattern);
        let mut best: Option<(usize, f32)> = None;
        for (cluster_index, cluster) in clusters.iter().enumerate() {
            let prototype_position = cluster[0];
            let similarity = jaccard(&omitted_tokens, &candidate_tokens[prototype_position]);
            if similarity < CLUSTER_SIMILARITY_THRESHOLD {
                continue;
            }
            if best
                .as_ref()
                .map(|(_, best_similarity)| similarity > *best_similarity)
                .unwrap_or(true)
            {
                best = Some((cluster_index, similarity));
            }
        }
        if let Some((cluster_index, _)) = best {
            assigned_omitted[cluster_index].push(omitted_index);
        } else {
            unmatched_omitted += 1;
        }
    }
    let templates_considered = templates_available - unmatched_omitted;
    let partial = unmatched_omitted > 0;

    let mut out = Vec::new();
    for (cluster_index, c) in clusters.into_iter().enumerate() {
        let mut tids = Vec::new();
        let mut count = 0u64;
        let mut severity = 0u8;
        let mut label = String::new();
        let mut ex = Vec::new();
        let mut min_id = u64::MAX;
        let member_indices = c
            .into_iter()
            .map(|candidate_position| candidate_indices[candidate_position])
            .chain(assigned_omitted[cluster_index].iter().copied());
        for index in member_indices {
            let t = &all_templates[index];
            tids.push(t.info.template_id);
            count += t.info.count;
            severity = severity.max(t.info.severity);
            if label.is_empty() {
                label = t.info.pattern.clone();
            }
            min_id = min_id.min(t.info.template_id);
            let exemplar: String = t.info.example.chars().take(MAX_EXEMPLAR_CHARS).collect();
            if !exemplar.is_empty() && ex.len() < MAX_CLUSTER_EXEMPLARS && !ex.contains(&exemplar) {
                ex.push(exemplar);
            }
        }
        let score = problem_score(severity, count);
        out.push(ClusterSummary {
            cluster_id: min_id,
            template_ids: tids,
            label,
            count,
            severity,
            score,
            exemplars: ex,
            partial,
            templates_considered,
            templates_available,
        });
    }
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| b.severity.cmp(&a.severity))
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.cluster_id.cmp(&b.cluster_id))
    });
    out.truncate(max_clusters.max(1));
    Ok(out)
}

fn select_cluster_candidate_indices(templates: &[super::store::TemplateRow]) -> Vec<usize> {
    if templates.len() <= MAX_CLUSTER_TEMPLATE_CANDIDATES {
        return (0..templates.len()).collect();
    }

    let mut ranked: Vec<_> = (0..templates.len()).collect();
    ranked.sort_by(|&a, &b| template_impact_cmp(&templates[a], &templates[b]));

    let impact_slots =
        MAX_CLUSTER_TEMPLATE_CANDIDATES.saturating_sub(RARE_TEMPLATE_CANDIDATE_RESERVE);
    let mut selected_ids: HashSet<u64> = ranked
        .iter()
        .take(impact_slots)
        .map(|&index| templates[index].info.template_id)
        .collect();

    let mut rare: Vec<_> = templates
        .iter()
        .enumerate()
        .filter(|(_, row)| row.info.count <= RARE_TEMPLATE_MAX_COUNT)
        .map(|(index, _)| index)
        .collect();
    rare.sort_by(|&a, &b| {
        templates[b]
            .info
            .severity
            .cmp(&templates[a].info.severity)
            .then_with(|| template_impact_cmp(&templates[a], &templates[b]))
    });
    for index in rare {
        if selected_ids.len() >= MAX_CLUSTER_TEMPLATE_CANDIDATES {
            break;
        }
        selected_ids.insert(templates[index].info.template_id);
    }
    for &index in &ranked {
        if selected_ids.len() >= MAX_CLUSTER_TEMPLATE_CANDIDATES {
            break;
        }
        selected_ids.insert(templates[index].info.template_id);
    }

    let mut selected: Vec<_> = (0..templates.len())
        .filter(|&index| selected_ids.contains(&templates[index].info.template_id))
        .collect();
    selected.sort_by(|&a, &b| template_impact_cmp(&templates[a], &templates[b]));
    selected
}

fn template_impact_cmp(a: &super::store::TemplateRow, b: &super::store::TemplateRow) -> Ordering {
    problem_score(b.info.severity, b.info.count)
        .partial_cmp(&problem_score(a.info.severity, a.info.count))
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.info.severity.cmp(&a.info.severity))
        .then_with(|| b.info.count.cmp(&a.info.count))
        .then_with(|| a.info.template_id.cmp(&b.info.template_id))
}

fn problem_score(severity: u8, count: u64) -> f32 {
    let anomaly = if count <= RARE_TEMPLATE_MAX_COUNT {
        1.5
    } else {
        1.0
    };
    (severity as f32) * ((count as f32).ln_1p()) * anomaly
}

/// Frequency-over-time for events matching optional filters.
pub fn timeline(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
) -> CoreResult<Vec<TimelineBucket>> {
    Ok(timeline_summary(corpus, width_secs, level, service)?.buckets)
}

/// Frequency-over-time with the exact width/coarsening decision used by the
/// agent-facing timeline tool.
pub fn timeline_summary(
    corpus: &LogCorpus,
    width_secs: i64,
    level: Option<&str>,
    service: Option<&str>,
) -> CoreResult<TimelineAnalysis> {
    let requested_width = width_secs.max(1);
    let normalized_level = level.map(str::to_ascii_lowercase);
    corpus.with_connection(|conn| {
        let (min_ts, max_ts, total_count) = conn
            .query_row(
                r#"
                SELECT MIN(ts), MAX(ts), COUNT(*)
                FROM events
                WHERE (?1 IS NULL OR LOWER(level) = ?1)
                  AND (?2 IS NULL OR service = ?2)
                "#,
                params![normalized_level.as_deref(), service],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)? as u64,
                    ))
                },
            )
            .map_err(duck_error)?;
        let (Some(min_ts), Some(max_ts)) = (min_ts, max_ts) else {
            return Ok(TimelineAnalysis {
                requested_width,
                effective_width: requested_width,
                coarsened: false,
                total_count: 0,
                buckets: Vec::new(),
            });
        };
        let effective_width = bounded_timeline_width(min_ts, max_ts, requested_width);

        // `ts - (ts % width)` matches Rust's integer division semantics,
        // including truncation toward zero for order-only negative values.
        let mut stmt = conn
            .prepare(
                r#"
                SELECT ts - (ts % ?1) AS bucket_start,
                       level,
                       COUNT(*) AS event_count
                FROM events
                WHERE (?2 IS NULL OR LOWER(level) = ?2)
                  AND (?3 IS NULL OR service = ?3)
                GROUP BY 1, 2
                ORDER BY 1 ASC, 2 ASC
                "#,
            )
            .map_err(duck_error)?;
        let rows = stmt
            .query_map(
                params![effective_width, normalized_level.as_deref(), service],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                    ))
                },
            )
            .map_err(duck_error)?;

        let mut buckets = Vec::<TimelineBucket>::new();
        for row in rows {
            let (start, row_level, count) = row.map_err(duck_error)?;
            if buckets.last().map(|bucket| bucket.start) != Some(start) {
                buckets.push(TimelineBucket {
                    start,
                    width: effective_width,
                    count: 0,
                    by_level: HashMap::new(),
                });
            }
            let bucket = buckets.last_mut().ok_or_else(|| {
                CoreError::Message("timeline aggregate row had no destination bucket".into())
            })?;
            bucket.count += count;
            bucket.by_level.insert(row_level, count);
        }
        debug_assert!(buckets.len() <= MAX_ANALYSIS_TIMELINE_BUCKETS);
        debug_assert_eq!(
            buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
            total_count
        );
        Ok(TimelineAnalysis {
            requested_width,
            effective_width,
            coarsened: effective_width > requested_width,
            total_count,
            buckets,
        })
    })
}

fn bounded_timeline_width(min_ts: i64, max_ts: i64, requested_width: i64) -> i64 {
    if timeline_axis_bucket_count(min_ts, max_ts, requested_width) <= MAX_ANALYSIS_TIMELINE_BUCKETS
    {
        return requested_width;
    }

    // Find the smallest deterministic width that keeps the entire axis within
    // the cap. i128 arithmetic avoids overflow for mixed i64 extrema.
    let mut low = i128::from(requested_width) + 1;
    let mut high = i128::from(i64::MAX);
    while low < high {
        let mid = low + (high - low) / 2;
        if timeline_axis_bucket_count(min_ts, max_ts, mid as i64) <= MAX_ANALYSIS_TIMELINE_BUCKETS {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low as i64
}

fn timeline_axis_bucket_count(min_ts: i64, max_ts: i64, width: i64) -> usize {
    debug_assert!(width > 0);
    let width = i128::from(width);
    let bucket_start = |timestamp: i64| {
        let timestamp = i128::from(timestamp);
        timestamp - (timestamp % width)
    };
    let first = bucket_start(min_ts);
    let last = bucket_start(max_ts);
    let count = ((last - first) / width) + 1;
    usize::try_from(count).unwrap_or(usize::MAX)
}

fn duck_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Message(format!("duckdb timeline: {error}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::ingest::ingest_path;
    use crate::log_analysis::store::TemplateRow;
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

    #[test]
    fn cluster_candidates_are_bounded_and_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "bounded clustering").unwrap();
        corpus
            .upsert_templates(
                (1..=700).map(|id| template_row(id, &format!("uniquecomponent{id}"), 3, 100 + id)),
            )
            .unwrap();

        let first = cluster_problems(&corpus, 1_000).unwrap();
        let second = cluster_problems(&corpus, 1_000).unwrap();
        assert_eq!(first.len(), MAX_CLUSTER_TEMPLATE_CANDIDATES);
        let selected_ids: HashSet<_> = first.iter().map(|cluster| cluster.cluster_id).collect();
        assert_eq!(
            selected_ids,
            (189..=700).collect(),
            "the cap must retain the 512 highest-impact templates exactly"
        );
        assert!(first.iter().all(|cluster| {
            cluster.partial
                && cluster.templates_considered == MAX_CLUSTER_TEMPLATE_CANDIDATES
                && cluster.templates_available == 700
        }));
        assert_eq!(
            first
                .iter()
                .map(|cluster| (
                    cluster.cluster_id,
                    cluster.template_ids.clone(),
                    cluster.count,
                    cluster.severity
                ))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|cluster| (
                    cluster.cluster_id,
                    cluster.template_ids.clone(),
                    cluster.count,
                    cluster.severity
                ))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn rare_severe_template_survives_repetitive_error_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "rare severe").unwrap();
        let mut templates: Vec<_> = (1..=700)
            .map(|id| {
                template_row(
                    id,
                    &format!("connection refused shard <*> retry <*> group-{}", id % 3),
                    4,
                    50_000 + id,
                )
            })
            .collect();
        templates.push(template_row(
            9_999,
            "kernel panic unrecoverable allocator corruption",
            5,
            1,
        ));
        corpus.upsert_templates(templates).unwrap();

        let clusters = cluster_problems(&corpus, 10).unwrap();
        assert!(
            clusters
                .iter()
                .any(|cluster| cluster.template_ids.contains(&9_999)),
            "the reserved rare-severe candidate must remain visible"
        );
        let repetitive = clusters
            .iter()
            .find(|cluster| !cluster.template_ids.contains(&9_999))
            .expect("the repetitive error cluster remains represented");
        let expected_repetitive_count: u64 = (1..=700).map(|id| 50_000 + id).sum();
        assert_eq!(
            repetitive.count, expected_repetitive_count,
            "the linear assignment pass must restore the exact repetitive family count"
        );
        assert_eq!(repetitive.template_ids.len(), 700);
        assert!(!repetitive.partial);
        assert_eq!(repetitive.templates_considered, 701);
        assert_eq!(repetitive.templates_available, 701);
    }

    #[test]
    fn clustering_uses_persisted_template_examples_without_event_rows() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "template exemplars").unwrap();
        corpus
            .upsert_templates([template_row(7, "database timeout <*>", 4, 17)])
            .unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch("DROP TABLE events")
                    .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let clusters = cluster_problems(&corpus, 5).unwrap();
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].count, 17);
        assert_eq!(
            clusters[0].exemplars,
            vec!["redacted example for template 7"]
        );
    }

    #[test]
    fn cluster_summary_deserializes_pre_scope_metadata() {
        let summary: ClusterSummary = serde_json::from_value(serde_json::json!({
            "cluster_id": 7,
            "template_ids": [7],
            "label": "database timeout <*>",
            "count": 17,
            "severity": 4,
            "score": 9.5,
            "exemplars": ["database timeout after redaction"]
        }))
        .unwrap();

        assert!(!summary.partial);
        assert_eq!(summary.templates_considered, 0);
        assert_eq!(summary.templates_available, 0);
    }

    #[test]
    fn timeline_aggregates_scale_shaped_rows_with_filters() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "timeline scale").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    )
                    SELECT i + 1,
                           1700000000 + (i % 1000),
                           CASE WHEN i % 10 = 0 THEN 'error' ELSE 'info' END,
                           CASE WHEN i % 2 = 0 THEN 'api' ELSE 'worker' END,
                           'host-01',
                           (i % 25) + 1,
                           '[]',
                           NULL,
                           'bounded synthetic event',
                           'scale.log'
                    FROM range(250000) AS generated(i)
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let all = timeline_summary(&corpus, 100, None, None).unwrap();
        assert_eq!(all.requested_width, 100);
        assert_eq!(all.effective_width, 100);
        assert!(!all.coarsened);
        assert_eq!(all.total_count, 250_000);
        assert_eq!(all.buckets.len(), 10);
        assert_eq!(
            all.buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
            250_000
        );
        assert!(all
            .buckets
            .windows(2)
            .all(|pair| pair[0].start < pair[1].start));

        let api_errors = timeline_summary(&corpus, 100, Some("ERROR"), Some("api")).unwrap();
        assert!(!api_errors.coarsened);
        assert_eq!(api_errors.total_count, 25_000);
        assert_eq!(
            api_errors
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            25_000
        );
        assert!(api_errors.buckets.iter().all(|bucket| {
            bucket.by_level.len() == 1
                && bucket.by_level.get("error").copied() == Some(bucket.count)
        }));
        assert!(timeline(&corpus, 100, Some("error"), Some("worker"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn timeline_coarsens_250k_unique_timestamps_to_fixed_bound() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "unique timeline").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    )
                    SELECT i + 1,
                           i,
                           CASE WHEN i % 10 = 0 THEN 'error' ELSE 'info' END,
                           'api',
                           'host-01',
                           (i % 25) + 1,
                           '[]',
                           NULL,
                           'unique timestamp event',
                           'unique.log'
                    FROM range(250000) AS generated(i)
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let summary = timeline_summary(&corpus, 1, None, None).unwrap();
        assert_eq!(summary.requested_width, 1);
        assert_eq!(summary.effective_width, 489);
        assert!(summary.coarsened);
        assert_eq!(summary.total_count, 250_000);
        assert_eq!(summary.buckets.len(), MAX_ANALYSIS_TIMELINE_BUCKETS);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            250_000
        );
        assert!(summary
            .buckets
            .windows(2)
            .all(|pair| pair[0].start < pair[1].start));
    }

    #[test]
    fn timeline_preserves_truncating_bucket_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "negative timeline").unwrap();
        corpus
            .with_connection(|conn| {
                conn.execute_batch(
                    r#"
                    INSERT INTO events (
                        seq, ts, level, service, host, template_id, params,
                        trace_id, message, source
                    ) VALUES
                        (1, -3, 'warn', 'api', NULL, 1, '[]', NULL, 'a', 'x.log'),
                        (2, -2, 'error', 'api', NULL, 2, '[]', NULL, 'b', 'x.log'),
                        (3,  3, 'info', 'api', NULL, 3, '[]', NULL, 'c', 'x.log')
                    "#,
                )
                .map_err(duck_error)?;
                Ok(())
            })
            .unwrap();

        let summary = timeline_summary(&corpus, 2, None, None).unwrap();
        assert_eq!(summary.requested_width, 2);
        assert_eq!(summary.effective_width, 2);
        assert!(!summary.coarsened);
        assert_eq!(summary.total_count, 3);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| (bucket.start, bucket.count))
                .collect::<Vec<_>>(),
            vec![(-2, 2), (2, 1)]
        );
    }

    fn template_row(id: u64, pattern: &str, severity: u8, count: u64) -> TemplateRow {
        TemplateRow {
            info: TemplateInfo {
                template_id: id,
                pattern: pattern.to_string(),
                token_count: pattern.split_whitespace().count(),
                count,
                first_seen: 1_700_000_000,
                last_seen: 1_700_000_100,
                severity,
                example: format!("redacted example for template {id}"),
            },
            content_hash: format!("hash-{id}"),
            vector: None,
        }
    }
}
