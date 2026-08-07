//! Hybrid log search (#360).

use super::query::{classify_active_timestamp_basis, TimeQuality};
use super::store::{LogCorpus, LogEvent};
#[cfg(test)]
use super::{ActiveTimestampBasis, TimestampProvenance};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

const MAX_EXEMPLARS_PER_TEMPLATE: usize = 3;
const MAX_EXEMPLAR_MESSAGE_CHARS: usize = 320;
/// Maximum suppression predicates accepted by one analysis/search request.
pub const MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS: usize = 256;

pub(super) fn normalize_excluded_template_ids(
    excluded_template_ids: &[u64],
) -> CoreResult<BTreeSet<u64>> {
    if excluded_template_ids.len() > MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS {
        return Err(CoreError::Message(format!(
            "excluded template count {} exceeds maximum {}",
            excluded_template_ids.len(),
            MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS
        )));
    }
    if let Some(template_id) = excluded_template_ids
        .iter()
        .copied()
        .find(|template_id| *template_id > i64::MAX as u64)
    {
        return Err(CoreError::Message(format!(
            "excluded template id {template_id} exceeds signed storage range {}",
            i64::MAX
        )));
    }
    Ok(excluded_template_ids.iter().copied().collect())
}

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
    let (timestamp, time_quality) =
        match classify_active_timestamp_basis(event.active_timestamp_basis) {
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
    /// Optional bounded model-visible source reference.
    ///
    /// Deterministic broad triage uses this only when an exact source identity
    /// is too large for its bounded brief. Validation maps the reference back
    /// to `source`; ordinary search identities leave it unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_source: Option<String>,
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
            citation_source: None,
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
    search_logs_with_excluded_templates(corpus, q, embed, &[])
}

/// Hybrid search after applying an exact-template suppression lens.
pub fn search_logs_with_excluded_templates(
    corpus: &LogCorpus,
    q: &SearchLogsQuery,
    embed: Option<&dyn EmbedBackend>,
    excluded_template_ids: &[u64],
) -> CoreResult<Vec<SearchHit>> {
    let excluded = normalize_excluded_template_ids(excluded_template_ids)?;
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

    let persisted_events = corpus.load_all_events()?;
    {
        for e in &persisted_events {
            if excluded.contains(&e.template_id) {
                continue;
            }
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
                            citation_source: None,
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
    }

    // Also score templates by pattern FTS
    for row in corpus.list_templates() {
        if excluded.contains(&row.info.template_id) {
            continue;
        }
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
            if !excluded.contains(&row.info.template_id) {
                allowed.insert(row.info.template_id);
            }
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
    ids.retain(|id| !excluded.contains(id));

    let templates: std::collections::HashMap<_, _> = corpus
        .list_templates()
        .into_iter()
        .filter(|row| !excluded.contains(&row.info.template_id))
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
            .then_with(|| a.template_id.cmp(&b.template_id))
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
    fn search_logs_respects_k_and_does_not_scale_with_unrelated_corpus_size() {
        // Production search must not load/scan every event for an auxiliary dump.
        // Detail/identity volume is bounded by k (and exemplars), not total corpus size.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        // Unrelated noise: large corpus of non-matching lines.
        for i in 0..5_000 {
            writeln!(
                f,
                r#"{{"level":"info","message":"heartbeat ok pulse-{i}"}}"#
            )
            .unwrap();
        }
        // Few matching targets.
        for i in 0..20 {
            writeln!(
                f,
                r#"{{"level":"error","message":"connection refused upstream-{i}"}}"#
            )
            .unwrap();
        }
        let report = ingest_path(dir.path(), &logs, "k-bound", None, "none").unwrap();
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        let hits = search_logs(
            &corpus,
            &SearchLogsQuery {
                query: Some("connection refused".into()),
                semantic: false,
                k: 3,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(hits.len() <= 3, "k must cap hits, got {}", hits.len());
        let identity_count: usize = hits.iter().map(|h| h.evidence.len()).sum();
        // Exemplars per template are small (≤3); must not approach the 5k noise events.
        assert!(
            identity_count <= 3 * MAX_EXEMPLARS_PER_TEMPLATE,
            "identities must stay within exemplar bounds, got {identity_count}"
        );
        // Detail-like join of exemplars stays tiny vs corpus size.
        let detail_chars: usize = hits
            .iter()
            .flat_map(|h| h.exemplars.iter())
            .map(|e| e.chars().count())
            .sum();
        assert!(
            detail_chars < 20_000,
            "bounded search detail must not scale with noise corpus, detail_chars={detail_chars}"
        );
        assert!(
            !hits
                .iter()
                .any(|h| h.pattern.to_lowercase().contains("heartbeat")),
            "unrelated corpus templates must not enter matching hits"
        );
    }

    #[test]
    fn search_logs_module_has_no_dense_identity_dump_api() {
        // Guard against reintroducing production full-corpus auxiliary dumps.
        // Strip this test body so self-referential strings do not false-positive.
        let src = include_str!("search.rs");
        let prod = src
            .split("mod tests {")
            .next()
            .expect("production half of search.rs");
        assert!(
            !prod.contains("fn dense_identity"),
            "no dense_identity* production API"
        );
        assert!(
            !prod.contains("DENSE_IDENTITY_BUDGET"),
            "no dense identity budget constant"
        );
        assert!(
            !prod.contains("identity_rows:"),
            "search must not append synthetic identity_rows dumps"
        );
        // tool_host must not call a dense dump helper either
        let host = include_str!("../tool_host.rs");
        assert!(
            !host.contains("dense_identity") && !host.contains("identity_rows:"),
            "ToolHost search_logs must not append dense identity dumps"
        );
    }

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
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
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

    fn suppression_search_fixture() -> (tempfile::TempDir, LogCorpus) {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "suppression search").unwrap();
        corpus
            .upsert_templates([
                TemplateRow {
                    info: TemplateInfo {
                        template_id: 7,
                        pattern: "routine health check".into(),
                        token_count: 3,
                        count: 2,
                        first_seen: 100,
                        last_seen: 101,
                        severity: 1,
                        example: "routine health check".into(),
                    },
                    content_hash: template_content_hash("routine health check"),
                    vector: None,
                },
                TemplateRow {
                    info: TemplateInfo {
                        template_id: 8,
                        pattern: "database connection failed".into(),
                        token_count: 3,
                        count: 1,
                        first_seen: 102,
                        last_seen: 102,
                        severity: 4,
                        example: "database connection failed".into(),
                    },
                    content_hash: template_content_hash("database connection failed"),
                    vector: None,
                },
            ])
            .unwrap();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 1,
                    ts: 100,
                    timestamp_provenance: TimestampProvenance::OrderOnly,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: None,
                    level: "info".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 7,
                    params: vec![],
                    trace_id: None,
                    message: "routine health check".into(),
                    source: "api.log".into(),
                },
                LogEvent {
                    seq: 2,
                    ts: 101,
                    timestamp_provenance: TimestampProvenance::OrderOnly,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: None,
                    level: "info".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 7,
                    params: vec![],
                    trace_id: None,
                    message: "routine health check".into(),
                    source: "api.log".into(),
                },
                LogEvent {
                    seq: 3,
                    ts: 102,
                    timestamp_provenance: TimestampProvenance::OrderOnly,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: Some("db".into()),
                    host: None,
                    template_id: 8,
                    params: vec![],
                    trace_id: None,
                    message: "database connection failed".into(),
                    source: "db.log".into(),
                },
            ])
            .unwrap();
        (dir, corpus)
    }

    #[test]
    fn exact_template_exclusions_remove_search_candidates_and_evidence() {
        let (_dir, corpus) = suppression_search_fixture();
        let baseline = search_logs(
            &corpus,
            &SearchLogsQuery {
                k: 10,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(
            baseline
                .iter()
                .map(|hit| hit.template_id)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([7, 8])
        );

        let query = SearchLogsQuery {
            k: 10,
            ..Default::default()
        };
        let hidden_once = search_logs_with_excluded_templates(&corpus, &query, None, &[7]).unwrap();
        let hidden_with_duplicates =
            search_logs_with_excluded_templates(&corpus, &query, None, &[7, 7]).unwrap();

        assert_eq!(
            hidden_once
                .iter()
                .map(|hit| hit.template_id)
                .collect::<Vec<_>>(),
            vec![8]
        );
        assert_eq!(
            hidden_with_duplicates
                .iter()
                .map(|hit| hit.template_id)
                .collect::<Vec<_>>(),
            vec![8]
        );
        assert!(hidden_once
            .iter()
            .flat_map(|hit| &hit.evidence)
            .all(|identity| identity.template_id != 7));
    }

    #[test]
    fn empty_search_exclusions_preserve_default_behavior() {
        let (_dir, corpus) = suppression_search_fixture();
        let default_query = SearchLogsQuery {
            query: Some("database".into()),
            k: 10,
            ..Default::default()
        };
        let default_hits = search_logs(&corpus, &default_query, None).unwrap();
        let explicit_hits =
            search_logs_with_excluded_templates(&corpus, &default_query, None, &[]).unwrap();
        assert_eq!(
            serde_json::to_value(default_hits).unwrap(),
            serde_json::to_value(explicit_hits).unwrap()
        );
    }

    #[test]
    fn search_rejects_over_bound_exclusion_input() {
        let (_dir, corpus) = suppression_search_fixture();
        let error = search_logs_with_excluded_templates(
            &corpus,
            &SearchLogsQuery {
                k: 10,
                ..Default::default()
            },
            None,
            &(0..=MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS as u64).collect::<Vec<_>>(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("exceeds maximum 256"), "{error}");
    }

    #[test]
    fn search_rejects_template_ids_outside_signed_storage_range() {
        let (_dir, corpus) = suppression_search_fixture();
        let error = search_logs_with_excluded_templates(
            &corpus,
            &SearchLogsQuery {
                k: 10,
                ..Default::default()
            },
            None,
            &[u64::MAX],
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("exceeds signed storage range"),
            "{error}"
        );
    }
}
