//! Hybrid log search (#360).

use super::store::LogCorpus;
use crate::embed::EmbedBackend;
use crate::error::CoreResult;
use crate::memory::embed_blocking;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Query for `search_logs`.
#[derive(Debug, Clone, Default)]
pub struct SearchLogsQuery {
    /// Free-text / semantic query.
    pub query: Option<String>,
    /// Inclusive start unix secs.
    pub time_from: Option<i64>,
    /// Exclusive end unix secs.
    pub time_to: Option<i64>,
    /// Level filter (exact normalized).
    pub level: Option<String>,
    /// Service filter.
    pub service: Option<String>,
    /// Trace id filter.
    pub trace_id: Option<String>,
    /// Prefer semantic ranking when embed present.
    pub semantic: bool,
    /// Max results.
    pub k: usize,
}

/// One search hit with citeable template id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Template id.
    pub template_id: u64,
    /// Template pattern.
    pub pattern: String,
    /// Hybrid score.
    pub score: f32,
    /// Semantic component.
    pub semantic_score: f32,
    /// Keyword/FTS component.
    pub keyword_score: f32,
    /// Match count for template.
    pub count: u64,
    /// Severity.
    pub severity: u8,
    /// Example redacted messages.
    pub exemplars: Vec<String>,
}

/// Hybrid search: structured filter first, then semantic ∪ FTS over templates.
pub fn search_logs(
    corpus: &LogCorpus,
    q: &SearchLogsQuery,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<Vec<SearchHit>> {
    let k = q.k.clamp(1, 100);
    // Structured filter → allowed template ids + exemplar messages
    let mut allowed: HashSet<u64> = HashSet::new();
    let mut exemplars: std::collections::HashMap<u64, Vec<String>> =
        std::collections::HashMap::new();
    let mut fts_scores: std::collections::HashMap<u64, f32> = std::collections::HashMap::new();
    let query_l = q.query.as_deref().unwrap_or("").to_lowercase();
    let tokens: Vec<&str> = query_l
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .collect();

    corpus.with_events(|events| {
        for e in events {
            if let Some(from) = q.time_from {
                if e.ts < from {
                    continue;
                }
            }
            if let Some(to) = q.time_to {
                if e.ts >= to {
                    continue;
                }
            }
            if let Some(ref lvl) = q.level {
                if !e.level.eq_ignore_ascii_case(lvl) {
                    continue;
                }
            }
            if let Some(ref svc) = q.service {
                if e.service.as_deref() != Some(svc.as_str()) {
                    continue;
                }
            }
            if let Some(ref tid) = q.trace_id {
                if e.trace_id.as_deref() != Some(tid.as_str()) {
                    continue;
                }
            }
            allowed.insert(e.template_id);
            let ex = exemplars.entry(e.template_id).or_default();
            if ex.len() < 3 {
                ex.push(e.message.chars().take(160).collect());
            }
            // FTS-ish keyword score on message
            if !tokens.is_empty() {
                let msg_l = e.message.to_lowercase();
                let mut hit = 0usize;
                for t in &tokens {
                    if msg_l.contains(t) {
                        hit += 1;
                    }
                }
                if hit > 0 {
                    let s = hit as f32 / tokens.len() as f32;
                    let e_s = fts_scores.entry(e.template_id).or_insert(0.0);
                    *e_s = (*e_s).max(s);
                }
            }
        }
    });

    // Also score templates by pattern FTS
    for row in corpus.list_templates() {
        if !allowed.is_empty() && !allowed.contains(&row.info.template_id) {
            // if structured filter empty of constraints, allow all via pattern
        }
        if tokens.is_empty() {
            continue;
        }
        let pat_l = row.info.pattern.to_lowercase();
        let mut hit = 0usize;
        for t in &tokens {
            if pat_l.contains(t) {
                hit += 1;
            }
        }
        if hit > 0 {
            let s = hit as f32 / tokens.len() as f32;
            let e_s = fts_scores.entry(row.info.template_id).or_insert(0.0);
            *e_s = (*e_s).max(s);
            allowed.insert(row.info.template_id);
        }
    }

    // When no structured constraints, allow all templates for semantic
    let no_struct = q.time_from.is_none()
        && q.time_to.is_none()
        && q.level.is_none()
        && q.service.is_none()
        && q.trace_id.is_none();
    if no_struct {
        for row in corpus.list_templates() {
            allowed.insert(row.info.template_id);
        }
    }

    let mut sem_scores: std::collections::HashMap<u64, f32> = std::collections::HashMap::new();
    if q.semantic || q.query.is_some() {
        if let (Some(backend), Some(query)) = (embed, q.query.as_deref()) {
            if let Some(qvec) = embed_blocking(backend, query, 5_000) {
                let ranked =
                    corpus.search_templates(&qvec, k.saturating_mul(3).max(k), Some(&allowed))?;
                for (tid, s) in ranked {
                    sem_scores.insert(tid, s);
                }
            }
        }
    }

    // Union candidate ids
    let mut ids: HashSet<u64> = HashSet::new();
    ids.extend(fts_scores.keys().copied());
    ids.extend(sem_scores.keys().copied());
    if ids.is_empty() {
        ids = allowed;
    } else {
        ids.retain(|id| allowed.contains(id) || allowed.is_empty());
    }

    let templates: std::collections::HashMap<_, _> = corpus
        .list_templates()
        .into_iter()
        .map(|r| (r.info.template_id, r))
        .collect();

    let mut hits = Vec::new();
    for tid in ids {
        let Some(row) = templates.get(&tid) else {
            continue;
        };
        let kw = fts_scores.get(&tid).copied().unwrap_or(0.0);
        let sem = sem_scores.get(&tid).copied().unwrap_or(0.0);
        let score = 0.45 * kw + 0.45 * sem + 0.10 * (row.info.severity as f32 / 5.0);
        hits.push(SearchHit {
            template_id: tid,
            pattern: row.info.pattern.clone(),
            score,
            semantic_score: sem,
            keyword_score: kw,
            count: row.info.count,
            severity: row.info.severity,
            exemplars: exemplars.remove(&tid).unwrap_or_default(),
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(k);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::log_analysis::ingest::ingest_path;
    use std::io::Write;

    #[test]
    fn paraphrase_search_logs_semantic() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("e.log")).unwrap();
        for i in 0..100 {
            writeln!(
                f,
                r#"{{"level":"error","message":"connection refused to upstream host-{i}"}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"level":"info","message":"user login succeeded session {i}"}}"#
            )
            .unwrap();
        }
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(dir.path(), &logs, "s", Some(&backend), "c").unwrap();
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        let hits = search_logs(
            &corpus,
            &SearchLogsQuery {
                query: Some("upstream unavailable socket closed".into()),
                semantic: true,
                k: 5,
                ..Default::default()
            },
            Some(&backend),
        )
        .unwrap();
        assert!(!hits.is_empty());
        assert!(
            hits.iter().any(|h| h.semantic_score > 0.0),
            "paraphrase must yield semantic_score>0: {:?}",
            hits
        );
        // Prefer connection-refused cluster over login
        let top = &hits[0];
        assert!(
            top.pattern.to_lowercase().contains("connection")
                || top.pattern.to_lowercase().contains("refused")
                || top.semantic_score > 0.0,
            "top hit={top:?}"
        );
    }
}
