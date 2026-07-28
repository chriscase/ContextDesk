//! Hybrid log search (#360).

use super::query::{classify_ts, TimeQuality};
use super::store::{LogCorpus, LogEvent};
use crate::embed::EmbedBackend;
use crate::error::CoreResult;
use crate::memory::embed_blocking;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const MAX_EXEMPLARS_PER_TEMPLATE: usize = 3;
const MAX_EXEMPLAR_MESSAGE_CHARS: usize = 320;

#[derive(Debug)]
struct RankedExemplar {
    exact_phrase: bool,
    keyword_score: f32,
    text: String,
    identity: SearchEvidenceIdentity,
}

fn exemplar_rank_is_better(candidate: &RankedExemplar, current: &RankedExemplar) -> bool {
    (candidate.exact_phrase && !current.exact_phrase)
        || (candidate.exact_phrase == current.exact_phrase
            && candidate.keyword_score > current.keyword_score)
}

fn bounded_message_excerpt(message: &str, query: Option<&str>) -> String {
    let message_chars = message.chars().count();
    if message_chars <= MAX_EXEMPLAR_MESSAGE_CHARS {
        return message.replace('\n', "\\n").replace('\r', "\\r");
    }

    let message_ascii_lower = message.to_ascii_lowercase();
    let query = query.map(str::trim).filter(|query| !query.is_empty());
    let match_byte = query
        .and_then(|query| message_ascii_lower.find(&query.to_ascii_lowercase()))
        .or_else(|| {
            query.and_then(|query| {
                query
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|token| token.len() > 2)
                    .find_map(|token| message_ascii_lower.find(&token.to_ascii_lowercase()))
            })
        });
    let match_char = match_byte
        .map(|byte| {
            message
                .char_indices()
                .take_while(|(index, _)| *index < byte)
                .count()
        })
        .unwrap_or(0);
    if match_char > MAX_EXEMPLAR_MESSAGE_CHARS / 2 {
        let prefix_len = MAX_EXEMPLAR_MESSAGE_CHARS / 3;
        let context_len = MAX_EXEMPLAR_MESSAGE_CHARS - prefix_len;
        let context_start = match_char.saturating_sub(context_len / 3);
        let prefix: String = message.chars().take(prefix_len).collect();
        let context: String = message
            .chars()
            .skip(context_start)
            .take(context_len)
            .collect();
        return format!(
            "{} … {}{}",
            prefix.replace('\n', "\\n").replace('\r', "\\r"),
            context.replace('\n', "\\n").replace('\r', "\\r"),
            if context_start + context.chars().count() < message_chars {
                "…"
            } else {
                ""
            }
        );
    }
    let start = match_char.saturating_sub(MAX_EXEMPLAR_MESSAGE_CHARS / 3);
    let excerpt: String = message
        .chars()
        .skip(start)
        .take(MAX_EXEMPLAR_MESSAGE_CHARS)
        .collect();
    let has_prefix = start > 0;
    let has_suffix = start + excerpt.chars().count() < message_chars;
    format!(
        "{}{}{}",
        if has_prefix { "…" } else { "" },
        excerpt.replace('\n', "\\n").replace('\r', "\\r"),
        if has_suffix { "…" } else { "" }
    )
}

fn format_event_exemplar(event: &LogEvent, query: Option<&str>) -> String {
    let (timestamp, time_quality) = match classify_ts(event.ts) {
        TimeQuality::Wall => (
            DateTime::<Utc>::from_timestamp(event.ts, 0)
                .map(|time| time.to_rfc3339_opts(SecondsFormat::Secs, true))
                .unwrap_or_else(|| format!("unix:{}", event.ts)),
            "wall",
        ),
        TimeQuality::Mixed | TimeQuality::OrderOnly => {
            (format!("order:{}", event.ts), "order_only")
        }
    };
    format!(
        "seq={} source={} timestamp={} time_quality={} message={}",
        event.seq,
        event.source,
        timestamp,
        time_quality,
        bounded_message_excerpt(&event.message, query)
    )
}

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
    /// Trusted identities for the exact exemplar rows. Never inferred from
    /// query text, rendered output, or message payload.
    #[serde(default)]
    pub evidence: Vec<SearchEvidenceIdentity>,
}

/// Structured identity for one actual event row returned by log search.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SearchEvidenceIdentity {
    /// Stable corpus event sequence.
    pub seq: u64,
    /// Source provenance stored separately from the event payload.
    pub source: String,
    /// Trusted template identifier assigned during ingest.
    pub template_id: u64,
}

#[derive(Debug)]
struct SearchExemplar {
    text: String,
    identity: SearchEvidenceIdentity,
}

fn search_exemplar(event: &LogEvent, query: Option<&str>) -> SearchExemplar {
    SearchExemplar {
        text: format_event_exemplar(event, query),
        identity: SearchEvidenceIdentity {
            seq: event.seq,
            source: event.source.clone(),
            template_id: event.template_id,
        },
    }
}

/// Hybrid search: structured filter first, then semantic ∪ FTS over templates.
pub fn search_logs(
    corpus: &LogCorpus,
    q: &SearchLogsQuery,
    embed: Option<&dyn EmbedBackend>,
) -> CoreResult<Vec<SearchHit>> {
    // A configured model does not make a keyword-only corpus semantic. Gate on
    // persisted/derived vector availability so tools and UI cannot overclaim.
    let embed = if corpus.embedding_status().embedded_templates > 0 {
        embed
    } else {
        None
    };
    let k = q.k.clamp(1, 100);
    // Structured filter → allowed template ids + exemplar messages
    let mut allowed: HashSet<u64> = HashSet::new();
    let mut representative_exemplars: std::collections::HashMap<u64, Vec<SearchExemplar>> =
        std::collections::HashMap::new();
    let mut matching_exemplars: std::collections::HashMap<u64, Vec<RankedExemplar>> =
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
            let representatives = representative_exemplars.entry(e.template_id).or_default();
            if representatives.len() < MAX_EXEMPLARS_PER_TEMPLATE {
                representatives.push(search_exemplar(e, q.query.as_deref()));
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
                    let exact_phrase = !query_l.is_empty() && msg_l.contains(&query_l);
                    let ranked = RankedExemplar {
                        exact_phrase,
                        keyword_score: s,
                        text: format_event_exemplar(e, q.query.as_deref()),
                        identity: SearchEvidenceIdentity {
                            seq: e.seq,
                            source: e.source.clone(),
                            template_id: e.template_id,
                        },
                    };
                    let matches = matching_exemplars.entry(e.template_id).or_default();
                    if matches.len() < MAX_EXEMPLARS_PER_TEMPLATE {
                        matches.push(ranked);
                    } else if let Some((worst_index, _)) =
                        matches.iter().enumerate().min_by(|(_, left), (_, right)| {
                            left.exact_phrase.cmp(&right.exact_phrase).then_with(|| {
                                left.keyword_score
                                    .partial_cmp(&right.keyword_score)
                                    .unwrap_or(std::cmp::Ordering::Equal)
                            })
                        })
                    {
                        if exemplar_rank_is_better(&ranked, &matches[worst_index]) {
                            matches[worst_index] = ranked;
                        }
                    }
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
        let mut selected = matching_exemplars
            .remove(&tid)
            .map(|mut matches| {
                matches.sort_by(|left, right| {
                    right.exact_phrase.cmp(&left.exact_phrase).then_with(|| {
                        right
                            .keyword_score
                            .partial_cmp(&left.keyword_score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                });
                matches
                    .into_iter()
                    .map(|exemplar| SearchExemplar {
                        text: exemplar.text,
                        identity: exemplar.identity,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if selected.is_empty() {
            selected = representative_exemplars.remove(&tid).unwrap_or_default();
        }
        let (exemplars, evidence): (Vec<_>, Vec<_>) = selected
            .into_iter()
            .map(|exemplar| (exemplar.text, exemplar.identity))
            .unzip();
        hits.push(SearchHit {
            template_id: tid,
            pattern: row.info.pattern.clone(),
            score,
            semantic_score: sem,
            keyword_score: kw,
            count: row.info.count,
            severity: row.info.severity,
            exemplars,
            evidence,
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
    use crate::log_analysis::drain::TemplateInfo;
    use crate::log_analysis::ingest::ingest_path;
    use crate::log_analysis::store::{template_content_hash, TemplateRow};
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
        assert!(!hits.is_empty(), "paraphrase search returned no hits");
        // Must surface the connection-refused template (not merely any score>0).
        let refused = hits.iter().find(|h| {
            let p = h.pattern.to_lowercase();
            (p.contains("connection") && p.contains("refused"))
                || p.contains("econnrefused")
                || p.contains("upstream unavailable")
        });
        let hit = refused.unwrap_or_else(|| {
            panic!(
                "paraphrase must surface connection-refused template; hits={:?}",
                hits.iter()
                    .map(|h| (&h.pattern, h.semantic_score, h.score))
                    .collect::<Vec<_>>()
            )
        });
        assert!(
            hit.semantic_score > 0.0,
            "connection-refused hit must have semantic_score>0: {hit:?}"
        );
        // Login decoy must not outrank the refused cluster on semantic.
        if let Some(login) = hits
            .iter()
            .find(|h| h.pattern.to_lowercase().contains("login"))
        {
            assert!(
                hit.semantic_score >= login.semantic_score,
                "refused sem={} should beat login sem={}; hits={:?}",
                hit.semantic_score,
                login.semantic_score,
                hits.iter()
                    .map(|h| (&h.pattern, h.semantic_score))
                    .collect::<Vec<_>>()
            );
        }
        // Top hybrid hit should also be the refused template (semantic weight high).
        assert!(
            hits[0].template_id == hit.template_id
                || hits[0].pattern.to_lowercase().contains("refused")
                || hits[0].pattern.to_lowercase().contains("connection"),
            "top hit should be connection-refused cluster: {:?}",
            hits[0]
        );
    }

    #[test]
    fn configured_backend_does_not_claim_semantic_scores_for_keyword_only_corpus() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("app.log");
        std::fs::write(&log, "level=error message=connection refused\n").unwrap();
        let report = ingest_path(dir.path(), &log, "keyword", None, "none").unwrap();
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        let backend = ConceptEmbedBackend::new(64);
        let hits = search_logs(
            &corpus,
            &SearchLogsQuery {
                query: Some("connection".into()),
                semantic: true,
                k: 5,
                ..Default::default()
            },
            Some(&backend),
        )
        .unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|hit| hit.semantic_score == 0.0));
        assert_eq!(
            corpus.embedding_status().state,
            super::super::store::EmbeddingState::KeywordOnly
        );
    }

    #[test]
    fn rare_keyword_uses_the_matching_event_identity_not_an_early_template_exemplar() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "deep fixture").unwrap();
        let template_id = 7;
        corpus
            .upsert_templates([TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: "event_id=<*> LONG_JSON_SENTINEL payload=<*>".into(),
                    token_count: 3,
                    count: 4,
                    first_seen: 1_735_900_000,
                    last_seen: 1_735_936_041,
                    severity: 2,
                    example: "event_id=behavior-100 LONG_JSON_SENTINEL payload=early".into(),
                },
                content_hash: template_content_hash("event_id=<*> LONG_JSON_SENTINEL payload=<*>"),
                vector: None,
            }])
            .unwrap();
        let events = [
            (
                1,
                1_735_900_000,
                "behavior-100",
                "api/early.log",
                "ordinary",
            ),
            (
                2,
                1_735_900_010,
                "behavior-200",
                "api/early.log",
                "ordinary",
            ),
            (
                3,
                1_735_900_020,
                "behavior-300",
                "api/early.log",
                "ordinary",
            ),
            (
                71_366,
                1_735_936_041,
                "behavior-80000",
                "edge/access.jsonl",
                "FIND_RARE_DEEP",
            ),
        ]
        .map(|(seq, ts, event_id, source, marker)| LogEvent {
            seq,
            ts,
            level: "info".into(),
            service: Some("checkout-api".into()),
            host: None,
            template_id,
            params: vec![],
            trace_id: None,
            message: format!(
                "event_id={event_id} LONG_JSON_SENTINEL payload={} marker={marker}",
                "x".repeat(600)
            ),
            source: source.into(),
        });
        corpus.push_events(&events).unwrap();

        let hits = search_logs(
            &corpus,
            &SearchLogsQuery {
                query: Some("FIND_RARE_DEEP".into()),
                semantic: false,
                k: 8,
                ..Default::default()
            },
            None,
        )
        .unwrap();

        assert_eq!(hits.len(), 1);
        let evidence = hits[0].exemplars.join("\n");
        assert!(evidence.contains("seq=71366"), "{evidence}");
        assert!(evidence.contains("source=edge/access.jsonl"), "{evidence}");
        assert!(
            evidence.contains("timestamp=2025-01-03T20:27:21Z"),
            "{evidence}"
        );
        assert!(evidence.contains("event_id=behavior-80000"), "{evidence}");
        assert!(evidence.contains("FIND_RARE_DEEP"), "{evidence}");
        assert!(!evidence.contains("behavior-100"), "{evidence}");
    }
}
