//! Execution harness for the retrieval-ablation lab.
//!
//! Model-side surface (`ra_import_case`, `RaRetrievalAdapter`,
//! `run_mode_for_case`) sees ONLY the case `import/` tree and `queries.json`.
//! Evaluator-side surface (`ra_observe_corpus`) additionally reads the truth
//! manifest and probes the corpus through production read APIs; nothing it
//! learns ever flows back into model-visible state.
//!
//! The structured/keyword baseline runs through the production event search
//! (`cd_core::log_analysis::search_events_advanced`) over a corpus produced
//! by the production import pipeline (`ingest_path_with_policy`). Future
//! BGE-M3 / reranker adapters implement `RaRetrievalAdapter` against the SAME
//! run-record contract without touching truth data, queries, evidence
//! identities or scoring.

use super::*;
use std::path::Path;

use cd_core::log_analysis::import_preview::{preview_import_plan, verify_import_plan};
use cd_core::log_analysis::ingest::ingest_path_with_policy_selection_and_observer;
use cd_core::log_analysis::{
    analyze_exception_episodes, query_event_count, query_event_rows, search_events_advanced,
    EventQuery, EventSearchQuery, LogCorpus, LogEmbedPolicy, SearchMatchMode, MAX_EVENT_PAGE,
};
use cd_core::process_progress::NoopProcessProgress;

pub const RA_BASELINE_ENGINE_KIND: &str =
    "cd-core.log_analysis.search_events_advanced (one literal search per plan term, deduplicated union)";
pub const RA_BASELINE_RANKING: &str =
    "chronological(ts,seq) union of per-term literal matches, truncated to k — the order the product presents";

/// An imported case corpus. Holds the isolated cache root alive.
pub struct RaImportedCase {
    pub case_id: String,
    pub cache: tempfile::TempDir,
    pub corpus_id: String,
    pub events_imported: u64,
    pub files_imported: u64,
    pub import_partial: bool,
    pub import_ms: u64,
}

impl RaImportedCase {
    pub fn open(&self) -> LabResult<LogCorpus> {
        Ok(LogCorpus::open(self.cache.path(), &self.corpus_id)?)
    }
}

/// Import one case's `import/` tree through the reviewed production pipeline
/// (preview → plan verification → selection-bound ingest — the same flow the
/// desktop LogPane and CLI default import use) into an isolated cache root.
/// Keyword-only policy: no embeddings, no network.
pub fn ra_import_case(case_id: &str, import_root: &Path) -> LabResult<RaImportedCase> {
    ra_import_case_with_embedding(case_id, import_root, None, "none")
}

/// Import with an optional embedding backend so the semantic lane can run
/// over the identical import tree (corpus identity is the source tree, not
/// the vectors).
pub fn ra_import_case_with_embedding(
    case_id: &str,
    import_root: &Path,
    embed: Option<std::sync::Arc<dyn cd_core::embed::EmbedBackend>>,
    embed_model_id: &str,
) -> LabResult<RaImportedCase> {
    let cache = tempfile::tempdir()?;
    let policy = if embed.is_some() {
        LogEmbedPolicy {
            mode: cd_core::log_analysis::LogEmbedMode::Local,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: embed_model_id.into(),
            defer_above_source_bytes: None,
        }
    } else {
        LogEmbedPolicy::default()
    };
    let started = std::time::Instant::now();
    let plan = preview_import_plan(import_root, None)?;
    let selected = plan
        .report
        .selected_identities()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let selection = verify_import_plan(
        import_root,
        plan.plan_version,
        &plan.plan_token,
        &selected,
        None,
    )?;
    let report = ingest_path_with_policy_selection_and_observer(
        cache.path(),
        import_root,
        case_id,
        &policy,
        embed,
        &NoopProcessProgress,
        None,
        &selection,
    )?;
    let import_ms = started.elapsed().as_millis() as u64;
    Ok(RaImportedCase {
        case_id: case_id.to_string(),
        cache,
        corpus_id: report.corpus_id.clone(),
        events_imported: report.stats.lines,
        files_imported: report.stats.files as u64,
        import_partial: report.stats.partial,
        import_ms,
    })
}

// ---------------------------------------------------------------------------
// Mode adapter contract
// ---------------------------------------------------------------------------

/// Host-neutral retrieval adapter. One implementation per ablation mode; the
/// run-record schema is the wire contract, so an adapter may equally be an
/// out-of-process tool that emits the same JSON.
pub trait RaRetrievalAdapter {
    fn mode(&self) -> RaMode;
    /// `Ok(manifest)` when the capability can execute in this build and
    /// environment; `Err(reason)` marks FUTURE_CAPABILITY_UNAVAILABLE.
    fn availability(&self) -> Result<RaEngineManifest, String>;
    fn run_query(&self, corpus: &LogCorpus, query: &RaQuery, k: u64) -> LabResult<RaQueryRun>;
    fn call_counts(&self) -> RaCallCounts;
}

/// The production structured/keyword baseline.
pub struct RaStructuredKeywordAdapter {
    pub contextdesk_sha: String,
}

impl RaRetrievalAdapter for RaStructuredKeywordAdapter {
    fn mode(&self) -> RaMode {
        RaMode::StructuredKeyword
    }

    fn availability(&self) -> Result<RaEngineManifest, String> {
        Ok(RaEngineManifest {
            kind: RA_BASELINE_ENGINE_KIND.into(),
            contextdesk_sha: self.contextdesk_sha.clone(),
            ranking: RA_BASELINE_RANKING.into(),
            model_identity: None,
            reranker_identity: None,
            deterministic: true,
        })
    }

    fn run_query(&self, corpus: &LogCorpus, query: &RaQuery, k: u64) -> LabResult<RaQueryRun> {
        // The production literal search is a full-phrase substring match, so a
        // multi-term plan runs as one production search PER TERM — exactly the
        // bounded per-probe searches an investigator issues — and the results
        // merge in the same chronological (ts, seq) order the product
        // presents, truncated to k.
        let plan = &query.keyword_plan;
        let started = std::time::Instant::now();
        let mut merged: std::collections::BTreeMap<u64, (i64, RaCandidate)> =
            std::collections::BTreeMap::new();
        let mut scanned = 0u64;
        let mut any_partial = false;
        let mut matched_total = Some(0u64);
        for term in &plan.terms {
            let filter = EventQuery {
                levels: plan.level.iter().cloned().collect(),
                sources: plan.sources.clone(),
                services: plan.services.clone(),
                time_from: plan.time_from,
                time_to: plan.time_to,
                ..Default::default()
            };
            let search = EventSearchQuery {
                query: Some(term.clone()),
                filter,
                semantic: false,
                k: k as usize,
                match_mode: SearchMatchMode::Literal,
                case_sensitive: false,
            };
            let result = search_events_advanced(corpus, &search, None)?;
            scanned = scanned.saturating_add(result.scanned);
            any_partial |= result.partial;
            matched_total = match (matched_total, result.total_matched, plan.terms.len()) {
                // Exact only for single-term plans; unions overlap, so multi-
                // term totals are unknown rather than fabricated.
                (Some(_), Some(total), 1) => Some(total),
                _ => None,
            };
            for hit in result.hits {
                merged.entry(hit.event.seq).or_insert_with(|| {
                    (
                        hit.event.ts,
                        RaCandidate {
                            rank: 0,
                            seq: hit.event.seq,
                            source: hit.event.source.clone(),
                            ts: hit.event.ts,
                            timestamp_provenance: format!("{:?}", hit.event.timestamp_provenance),
                            level: Some(hit.event.level.clone()),
                            template_id: Some(hit.event.template_id),
                            score: Some(f64::from(hit.score)),
                            content: hit.event.message.clone(),
                        },
                    )
                });
            }
        }
        let runtime_ms = started.elapsed().as_millis() as u64;
        let mut ordered: Vec<(i64, RaCandidate)> = merged.into_values().collect();
        ordered.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.seq.cmp(&b.1.seq)));
        if ordered.len() as u64 > k {
            any_partial = true;
            ordered.truncate(k as usize);
        }
        let candidates = ordered
            .into_iter()
            .enumerate()
            .map(|(index, (_, mut candidate))| {
                candidate.rank = index as u64 + 1;
                candidate
            })
            .collect();
        Ok(RaQueryRun {
            query_id: query.query_id.clone(),
            k_requested: k,
            matched_total,
            scanned,
            partial: any_partial,
            runtime_ms: Some(runtime_ms),
            candidates,
        })
    }

    fn call_counts(&self) -> RaCallCounts {
        RaCallCounts::measured_zero()
    }
}

/// Executable hybrid adapters over the shared production hybrid retrieval
/// seam (`cd_core::log_analysis::hybrid_search_events`). The SAME run-record
/// contract, truth, queries, evidence identities and scoring apply; only the
/// engine differs. A run whose optional lanes degraded below the intended
/// mode FAILS instead of silently reporting narrower results under a wider
/// label (that would be the M12 false green).
pub struct RaHybridAdapter {
    pub mode: RaMode,
    pub embed: std::sync::Arc<dyn cd_core::embed::EmbedBackend>,
    pub embed_identity: String,
    pub rerank: Option<std::sync::Arc<dyn cd_core::rerank::RerankBackend>>,
    pub reranker_identity: Option<String>,
    pub contextdesk_sha: String,
    embedding_calls: std::sync::atomic::AtomicU64,
    rerank_calls: std::sync::atomic::AtomicU64,
}

impl RaHybridAdapter {
    pub fn embedding(
        embed: std::sync::Arc<dyn cd_core::embed::EmbedBackend>,
        embed_identity: &str,
        contextdesk_sha: &str,
    ) -> Self {
        Self {
            mode: RaMode::HybridEmbedding,
            embed,
            embed_identity: embed_identity.into(),
            rerank: None,
            reranker_identity: None,
            contextdesk_sha: contextdesk_sha.into(),
            embedding_calls: std::sync::atomic::AtomicU64::new(0),
            rerank_calls: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn reranked(
        embed: std::sync::Arc<dyn cd_core::embed::EmbedBackend>,
        embed_identity: &str,
        rerank: std::sync::Arc<dyn cd_core::rerank::RerankBackend>,
        contextdesk_sha: &str,
    ) -> Self {
        let reranker_identity = rerank.identity();
        Self {
            mode: RaMode::HybridEmbeddingReranked,
            embed,
            embed_identity: embed_identity.into(),
            rerank: Some(rerank),
            reranker_identity: Some(reranker_identity),
            contextdesk_sha: contextdesk_sha.into(),
            embedding_calls: std::sync::atomic::AtomicU64::new(0),
            rerank_calls: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl RaRetrievalAdapter for RaHybridAdapter {
    fn mode(&self) -> RaMode {
        self.mode
    }

    fn availability(&self) -> Result<RaEngineManifest, String> {
        Ok(RaEngineManifest {
            kind: "cd-core.log_analysis.hybrid_search_events".into(),
            contextdesk_sha: self.contextdesk_sha.clone(),
            ranking: "merge: semantic score DESC then (ts, seq); optional rerank reorders top-n with pre-rerank tiebreak".into(),
            model_identity: Some(self.embed_identity.clone()),
            reranker_identity: self.reranker_identity.clone(),
            deterministic: true,
        })
    }

    fn run_query(&self, corpus: &LogCorpus, query: &RaQuery, k: u64) -> LabResult<RaQueryRun> {
        use cd_core::log_analysis::{HybridModeUsed, HybridOptions};
        let plan = &query.keyword_plan;
        let options = HybridOptions {
            keyword_terms: plan.terms.clone(),
            semantic_query: Some(query.question.clone()),
            filter: EventQuery {
                levels: plan.level.iter().cloned().collect(),
                sources: plan.sources.clone(),
                services: plan.services.clone(),
                time_from: plan.time_from,
                time_to: plan.time_to,
                ..Default::default()
            },
            k: k as usize,
            ..HybridOptions::default()
        };
        let started = std::time::Instant::now();
        let outcome = cd_core::log_analysis::hybrid_search_events(
            corpus,
            &options,
            Some(self.embed.as_ref()),
            self.rerank.as_deref(),
            None,
        )?;
        let runtime_ms = started.elapsed().as_millis() as u64;
        let intended = match self.mode {
            RaMode::HybridEmbedding => HybridModeUsed::HybridEmbedding,
            RaMode::HybridEmbeddingReranked => HybridModeUsed::HybridEmbeddingReranked,
            other => return Err(format!("RaHybridAdapter cannot execute {other}").into()),
        };
        if outcome.mode_used != intended {
            return Err(format!(
                "{} degraded to {} ({}); refusing to mislabel narrower results",
                self.mode,
                outcome.mode_used.as_str(),
                outcome
                    .degradations
                    .iter()
                    .map(|d| d.code.clone())
                    .collect::<Vec<_>>()
                    .join("+")
            )
            .into());
        }
        self.embedding_calls.fetch_add(
            outcome.telemetry.embedding_calls.unwrap_or(0),
            std::sync::atomic::Ordering::SeqCst,
        );
        self.rerank_calls.fetch_add(
            outcome.telemetry.rerank_calls.unwrap_or(0),
            std::sync::atomic::Ordering::SeqCst,
        );
        let candidates = outcome
            .candidates
            .iter()
            .map(|candidate| RaCandidate {
                rank: candidate.final_rank,
                seq: candidate.seq,
                source: candidate.source.clone(),
                ts: candidate.ts,
                timestamp_provenance: candidate.timestamp_provenance.clone(),
                level: Some(candidate.level.clone()),
                template_id: Some(candidate.template_id),
                score: Some(match candidate.rerank_score {
                    Some(score) => f64::from(score),
                    None => f64::from(candidate.pre_rerank_score),
                }),
                content: candidate.message.clone(),
            })
            .collect();
        Ok(RaQueryRun {
            query_id: query.query_id.clone(),
            k_requested: k,
            matched_total: outcome.keyword_matched_total,
            scanned: outcome.scanned,
            partial: outcome.partial,
            runtime_ms: Some(runtime_ms),
            candidates,
        })
    }

    fn call_counts(&self) -> RaCallCounts {
        RaCallCounts {
            embedding_calls: Some(
                self.embedding_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
            ),
            rerank_calls: Some(self.rerank_calls.load(std::sync::atomic::Ordering::SeqCst)),
            provider_calls: Some(0),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
        }
    }
}

/// Declared-but-unavailable capability adapters. They exist so the mode
/// roster is complete and the report can only ever say
/// FUTURE_CAPABILITY_UNAVAILABLE — never silently substitute.
pub struct RaUnavailableAdapter {
    pub mode: RaMode,
    pub reason: &'static str,
    pub intended_engine: &'static str,
}

pub fn ra_future_adapters() -> Vec<RaUnavailableAdapter> {
    vec![
        RaUnavailableAdapter {
            mode: RaMode::HybridEmbedding,
            reason: "not_implemented: no production-grade embedding model is wired (BGE-M3 lane pending); the deterministic ConceptEmbedBackend is contract-validation only and must never be reported as the capability",
            intended_engine: "cd-core.log_analysis.search_events_advanced(semantic=true) + EmbedBackend=bge-m3",
        },
        RaUnavailableAdapter {
            mode: RaMode::HybridEmbeddingReranked,
            reason: "not_implemented: no reranking stage exists in the retrieval path (Qwen reranker lane pending; capability_qualification::RerankerContract is a probe, not a retrieval stage)",
            intended_engine: "hybrid_embedding + reranker=qwen over the same candidate contract",
        },
        RaUnavailableAdapter {
            mode: RaMode::FullMultistage,
            reason: "requires_live_provider: bounded multi-stage triage (cd_core::agent::run_multi_stage_broad_triage) needs a ChatBackend; this deterministic suite validates its gates via the production triage rubric only",
            intended_engine: "cd-core.agent.run_multi_stage_broad_triage over BroadLogTriageBrief",
        },
    ]
}

/// Execute one mode for one case, producing the run record.
#[allow(clippy::too_many_arguments)]
pub fn run_mode_for_case(
    adapter: &dyn RaRetrievalAdapter,
    imported: &RaImportedCase,
    queries: &RaQuerySet,
    tier: &str,
    seed: u64,
    events_expected: u64,
    import_tree_sha256: &str,
    generation_ms: Option<u64>,
) -> LabResult<RaRunRecord> {
    let engine = match adapter.availability() {
        Ok(engine) => engine,
        Err(reason) => {
            return Ok(unavailable_run_record(
                adapter.mode(),
                &reason,
                "",
                imported,
                queries,
                tier,
                seed,
                events_expected,
                import_tree_sha256,
            ));
        }
    };
    let corpus = imported.open()?;
    let mut runs = Vec::new();
    for query in &queries.queries {
        runs.push(adapter.run_query(&corpus, query, RA_K)?);
    }
    Ok(RaRunRecord {
        schema_id: RA_RUN_RECORD_SCHEMA_ID.into(),
        schema_version: RA_RUN_RECORD_SCHEMA_VERSION,
        suite_id: RA_SUITE_ID.into(),
        suite_version: RA_SUITE_VERSION,
        case_id: queries.case_id.clone(),
        tier_claimed: tier.into(),
        mode: adapter.mode(),
        mode_status: RaModeStatus::executed(),
        engine,
        corpus: RaCorpusStamp {
            tier_requested: tier.into(),
            seed,
            generator_version: RA_GENERATOR_VERSION.into(),
            truth_schema_id: RA_TRUTH_SCHEMA_ID.into(),
            events_expected,
            events_imported: imported.events_imported,
            files: imported.files_imported,
            bytes: 0,
            import_tree_sha256: import_tree_sha256.into(),
            generation_ms,
            import_ms: Some(imported.import_ms),
        },
        calls: adapter.call_counts(),
        queries: runs,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn unavailable_run_record(
    mode: RaMode,
    reason: &str,
    intended_engine: &str,
    imported: &RaImportedCase,
    queries: &RaQuerySet,
    tier: &str,
    seed: u64,
    events_expected: u64,
    import_tree_sha256: &str,
) -> RaRunRecord {
    RaRunRecord {
        schema_id: RA_RUN_RECORD_SCHEMA_ID.into(),
        schema_version: RA_RUN_RECORD_SCHEMA_VERSION,
        suite_id: RA_SUITE_ID.into(),
        suite_version: RA_SUITE_VERSION,
        case_id: queries.case_id.clone(),
        tier_claimed: tier.into(),
        mode,
        mode_status: RaModeStatus::unavailable(reason),
        engine: RaEngineManifest {
            kind: if intended_engine.is_empty() {
                "unavailable".into()
            } else {
                intended_engine.into()
            },
            contextdesk_sha: "unavailable".into(),
            ranking: "unavailable".into(),
            model_identity: None,
            reranker_identity: None,
            deterministic: true,
        },
        corpus: RaCorpusStamp {
            tier_requested: tier.into(),
            seed,
            generator_version: RA_GENERATOR_VERSION.into(),
            truth_schema_id: RA_TRUTH_SCHEMA_ID.into(),
            events_expected,
            events_imported: imported.events_imported,
            files: imported.files_imported,
            bytes: 0,
            import_tree_sha256: import_tree_sha256.into(),
            generation_ms: None,
            import_ms: Some(imported.import_ms),
        },
        calls: RaCallCounts {
            embedding_calls: None,
            rerank_calls: None,
            provider_calls: None,
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
        },
        queries: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Evaluator-side corpus observation
// ---------------------------------------------------------------------------

/// Probe the imported corpus against the truth manifest through production
/// read APIs. Evaluator-side only.
pub fn ra_observe_corpus(
    truth: &RaTruthManifest,
    imported: &RaImportedCase,
) -> LabResult<RaObservedCorpus> {
    let corpus = imported.open()?;

    let mut sources = BTreeMap::new();
    for source in truth.expected.sources.keys() {
        let query = EventQuery {
            sources: vec![source.clone()],
            ..Default::default()
        };
        let count = query_event_count(&corpus, &query)?;
        sources.insert(source.clone(), count.total_matched);
    }

    // Excluded files must contribute zero events under their identity.
    let mut exclusions_honored = true;
    let mut exclusion_detail = String::new();
    for excluded in &truth.expected.excluded_files {
        let query = EventQuery {
            sources: vec![excluded.clone()],
            ..Default::default()
        };
        let count = query_event_count(&corpus, &query)?;
        if count.total_matched > 0 {
            exclusions_honored = false;
            exclusion_detail = format!(
                "excluded file {excluded} contributed {} events",
                count.total_matched
            );
            break;
        }
    }

    // Case-sensitive token census through the production keyword filter.
    let mut token_census = BTreeMap::new();
    for group in &truth.evidence_groups {
        let query = EventQuery {
            keyword: Some(group.token.clone()),
            ..Default::default()
        };
        let engine_count = query_event_count(&corpus, &query)?.total_matched;
        let exact = if group.expected_token_records <= RA_CENSUS_EXACT_CAP {
            let mut exact_count = 0u64;
            let mut after_seq: Option<u64> = None;
            let mut after_ts: Option<i64> = None;
            loop {
                let page_query = EventQuery {
                    keyword: Some(group.token.clone()),
                    limit: MAX_EVENT_PAGE,
                    after_seq,
                    after_ts,
                    ..Default::default()
                };
                let page = query_event_rows(&corpus, &page_query)?;
                for event in &page.events {
                    if event.message.contains(&group.token) {
                        exact_count += 1;
                    }
                }
                match (page.next_cursor, page.next_ts) {
                    (Some(cursor), ts) => {
                        after_seq = Some(cursor);
                        after_ts = ts;
                    }
                    _ => break,
                }
            }
            Some(exact_count)
        } else {
            None
        };
        token_census.insert(
            group.group_id.clone(),
            RaTokenCensus {
                exact,
                lower_bound: engine_count,
            },
        );
    }

    // Secret scan over the durable store's message text.
    let mut secret_hits_in_store = Vec::new();
    for secret in &truth.privacy.secret_tokens {
        let query = EventQuery {
            keyword: Some(secret.clone()),
            ..Default::default()
        };
        if query_event_count(&corpus, &query)?.total_matched > 0 {
            secret_hits_in_store.push(secret.clone());
        }
    }

    let geometry = if expected_geometry(truth).is_some() {
        let analysis = analyze_exception_episodes(&corpus, &[])?;
        Some(RaObservedGeometry {
            raw_exception_records: analysis.raw_exception_record_count,
            application_exception_records: analysis.application_exception_record_count,
            stderr_exception_records: analysis.stderr_exception_record_count,
            occurrence_count: analysis.occurrence_count,
            partial: analysis.partial,
        })
    } else {
        None
    };

    Ok(RaObservedCorpus {
        events_imported: imported.events_imported,
        files_imported: imported.files_imported,
        sources,
        token_census,
        secret_hits_in_store,
        exclusions_honored,
        exclusion_detail,
        geometry,
        import_ms: Some(imported.import_ms),
    })
}
