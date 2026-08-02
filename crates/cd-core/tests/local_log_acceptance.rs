//! Opt-in, local-only acceptance for a user-owned log archive.
//!
//! The test contains no private path or payload and prints aggregate counts
//! only. It exercises the same reviewed selection, ingest, timezone, and
//! bounded Explorer query paths used by the desktop host.

use async_trait::async_trait;
use cd_core::agent::{run_agent_turn, AgentOptions, ChatBackend, LogExplorerTurnContext};
use cd_core::chat::{ChatCompletion, ChatMessage, FunctionCall, ToolCallMsg};
use cd_core::embed::{default_log_embed_backend_with_cache_dir, LOCAL_LOG_EMBED_MODEL_ID};
use cd_core::events::{StreamEvent, ToolPhase};
use cd_core::index::KeywordIndex;
use cd_core::log_analysis::import_preview::{
    event_importable, preview_import_plan, verify_import_plan,
};
use cd_core::log_analysis::{
    apply_source_timezones, cluster_problems, ingest_path_with_policy_selection_and_observer,
    load_timezone_resolution_state, preview_source_timezone, query_event_count, query_events,
    query_facets, query_source_catalog, query_timeline_summary, undo_event_revision,
    ActiveTimestampBasis, EmbeddingState, EventQuery, LogCorpus, LogEmbedMode, LogEmbedPolicy,
    LogSourceCatalogQuery, SourceTimezoneApplyRequest, TimelineSummaryQuery, TimestampProvenance,
    SEARCH_LOGS,
};
use cd_core::process_progress::NoopProcessProgress;
use cd_core::tool_host::ToolHost;
use cd_core::tools::{ToolSideEffect, ToolSpec};
use cd_core::workspace::Workspace;
use cd_core::CoreResult;
use std::env;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

const INPUT_ENV: &str = "CONTEXTDESK_PRIVATE_LOG_INPUT";
const TIMEZONE_ENV: &str = "CONTEXTDESK_PRIVATE_LOG_TIMEZONE";
const EMBED_ENV: &str = "CONTEXTDESK_PRIVATE_LOG_EMBED";

fn embed_none() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "local-log-acceptance-none".into(),
        defer_above_source_bytes: None,
    }
}

fn active_timestamp_counts(corpus: &LogCorpus) -> (u64, u64, u64) {
    let mut after_seq = None;
    let mut unresolved = 0u64;
    let mut resolved = 0u64;
    let mut explicit = 0u64;
    loop {
        let page = query_events(
            corpus,
            &EventQuery {
                after_seq,
                limit: 500,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .expect("page imported events");
        for event in &page.events {
            if event.timestamp_provenance == TimestampProvenance::UnresolvedLocal
                && event.active_timestamp_basis == ActiveTimestampBasis::OrderOnly
            {
                unresolved += 1;
            }
            if event.active_timestamp_basis == ActiveTimestampBasis::ResolvedLocal {
                resolved += 1;
            }
            if event.active_timestamp_basis == ActiveTimestampBasis::ExplicitWall {
                explicit += 1;
            }
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        assert_ne!(after_seq, Some(next), "event pagination must advance");
        after_seq = Some(next);
    }
    (unresolved, resolved, explicit)
}

fn marker_value(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)? + marker.len();
    let suffix = line.get(start..)?;
    if suffix.starts_with('"') {
        return serde_json::Deserializer::from_str(suffix)
            .into_iter::<String>()
            .next()?
            .ok();
    }
    let value = suffix
        .chars()
        .take_while(|character| {
            !character.is_whitespace() && !matches!(character, '"' | ',' | ')' | ']' | ';')
        })
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

fn first_trusted_log_identity(context: &str) -> Option<(u64, String)> {
    context.lines().find_map(|line| {
        let seq = marker_value(line, "seq=")?.parse::<u64>().ok()?;
        let source = marker_value(line, "source=")?;
        Some((seq, source))
    })
}

struct BroadBriefCitationBackend {
    cited_identity: Mutex<Option<(u64, String)>>,
}

struct ErrorSearchCitationBackend {
    calls: AtomicUsize,
    cited_identity: Mutex<Option<(u64, String)>>,
}

#[async_trait]
impl ChatBackend for ErrorSearchCitationBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let context = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        match call {
            0 => {
                assert!(tools.iter().any(|tool| tool.name == SEARCH_LOGS));
                assert!(tools
                    .iter()
                    .all(|tool| tool.side_effect == ToolSideEffect::Read));
                Ok(ChatCompletion {
                    content: String::new(),
                    tool_calls: vec![ToolCallMsg {
                        id: "local-error-search".into(),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: SEARCH_LOGS.into(),
                            arguments: serde_json::json!({
                                "level": "error",
                                "semantic": false,
                                "k": 8
                            })
                            .to_string(),
                        },
                    }],
                    finish_reason: "tool_calls".into(),
                })
            }
            1 => {
                assert!(tools.is_empty(), "validated evidence must close tools");
                assert!(context.contains("source_kind: log_templates"));
                let (seq, source) = first_trusted_log_identity(&context)
                    .expect("error search must return a trusted event identity");
                *self.cited_identity.lock().expect("citation lock") = Some((seq, source.clone()));
                Ok(ChatCompletion {
                    content: format!(
                        "Observation: the bounded ERROR search returned a concrete event \
                         (seq={seq} source=\"{source}\"). Inference: compare its template \
                         frequency and neighboring timeline before assigning a root cause."
                    ),
                    tool_calls: Vec::new(),
                    finish_reason: "stop".into(),
                })
            }
            _ => panic!("unexpected error-search provider call {call}"),
        }
    }
}

#[async_trait]
impl ChatBackend for BroadBriefCitationBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        assert!(
            tools
                .iter()
                .all(|tool| tool.side_effect == ToolSideEffect::Read),
            "linked archive chat must expose read tools only"
        );
        let context = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            context.contains("source_kind: deterministic_broad_log_triage"),
            "linked broad question must receive the deterministic triage brief"
        );
        let (seq, source) = first_trusted_log_identity(&context)
            .expect("broad triage must expose a trusted event identity");
        *self.cited_identity.lock().expect("citation lock") = Some((seq, source.clone()));
        Ok(ChatCompletion {
            content: format!(
                "Observation: the bounded triage identifies a concrete problem event \
                 (seq={seq} source=\"{source}\"). Inference: investigate that event's \
                 surrounding template and timeline before assigning a root cause."
            ),
            tool_calls: Vec::new(),
            finish_reason: "stop".into(),
        })
    }
}

#[tokio::test]
#[ignore = "requires a user-owned archive via CONTEXTDESK_PRIVATE_LOG_INPUT"]
async fn local_archive_reaches_timezone_and_explorer_evidence() {
    let input = PathBuf::from(env::var_os(INPUT_ENV).expect("private input env is required"));
    let timezone = env::var(TIMEZONE_ENV).unwrap_or_else(|_| "UTC".into());
    assert!(input.is_file(), "private input must be an existing file");

    let plan = preview_import_plan(&input, None).expect("preview private archive");
    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item))
        .map(|item| item.identity.clone())
        .collect();
    let selection =
        verify_import_plan(&input, plan.plan_version, &plan.plan_token, &selected, None)
            .expect("verify reviewed selection");

    let cache = tempfile::tempdir().expect("temporary acceptance cache");
    let product_embed = env::var(EMBED_ENV).as_deref() == Ok("1");
    let (policy, embed_backend) = if product_embed {
        let mut policy = LogEmbedPolicy::local_default();
        policy.model_id = LOCAL_LOG_EMBED_MODEL_ID.into();
        let model_cache = env::temp_dir().join("contextdesk-log-acceptance-model-cache");
        let backend = default_log_embed_backend_with_cache_dir(&model_cache)
            .expect("initialize product local log embedder")
            .expect("product embed acceptance requires the log-fastembed feature");
        (policy, Some(backend))
    } else {
        (embed_none(), None)
    };
    let report = ingest_path_with_policy_selection_and_observer(
        cache.path(),
        &input,
        "local-log-acceptance",
        &policy,
        embed_backend,
        &NoopProcessProgress,
        None,
        &selection,
    )
    .expect("selection-bound ingest");
    assert!(report.stats.lines > 0, "archive must publish events");
    assert_eq!(
        report.stats.failed_files, 0,
        "no selected source may fail ingest"
    );
    if product_embed {
        let expected_embedded = report
            .stats
            .templates
            .min(cd_core::log_analysis::ingest::BULK_EMBED_TEMPLATE_CAP);
        assert_eq!(
            report.stats.embedded, expected_embedded,
            "product path must embed every template admitted by the bulk SoftWrite cap"
        );
        assert_eq!(
            report.embedding.embedded_templates,
            expected_embedded as u64
        );
        assert_eq!(
            report.embedding.total_templates,
            report.stats.templates as u64
        );
        let expected_state = if expected_embedded == report.stats.templates {
            EmbeddingState::Complete
        } else {
            EmbeddingState::Partial
        };
        assert_eq!(report.embedding.state, expected_state);
        assert_eq!(
            report.embedding.reason.as_deref(),
            Some(if expected_state == EmbeddingState::Complete {
                "local_embedding_complete"
            } else {
                "template_cap_or_backend_failure"
            })
        );
        assert!(
            report.stats.embedded > 0,
            "product path must embed templates"
        );
    }

    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open imported corpus");
    let before = active_timestamp_counts(&corpus);
    let state = load_timezone_resolution_state(cache.path(), &report.corpus_id)
        .expect("load timezone state");
    let local_sources: Vec<_> = state
        .sources
        .iter()
        .filter(|source| source.unresolved_local_records > 0)
        .collect();
    assert!(
        !local_sources.is_empty(),
        "archive must expose local timestamp sources"
    );

    let requests: Vec<_> = local_sources
        .iter()
        .map(|source| {
            let preview = preview_source_timezone(
                cache.path(),
                &report.corpus_id,
                state.scope.event_revision,
                &source.source,
                &timezone,
            )
            .expect("preview source timezone");
            SourceTimezoneApplyRequest {
                source: source.source.clone(),
                iana_timezone: timezone.clone(),
                preview_token: preview.declaration_fingerprint,
            }
        })
        .collect();
    assert_eq!(requests.len(), local_sources.len());
    let applied = apply_source_timezones(
        cache.path(),
        &report.corpus_id,
        state.scope.event_revision,
        &requests,
        1_750_000_000,
    )
    .expect("atomically apply timezone to every local source");

    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("re-open revised corpus");
    let after = active_timestamp_counts(&corpus);
    assert_eq!(after.0, 0, "all unresolved local records must be resolved");
    assert_eq!(
        after.1, before.0,
        "every unresolved record must become resolved"
    );
    assert_eq!(
        after.2, before.2,
        "explicit wall-clock records must be preserved"
    );

    let undone = undo_event_revision(cache.path(), &report.corpus_id, applied.revision, None)
        .expect("undo common timezone application");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open rolled-back corpus");
    assert_eq!(
        active_timestamp_counts(&corpus),
        before,
        "undo must restore the exact pre-application timestamp bases"
    );
    let reapply_requests: Vec<_> = local_sources
        .iter()
        .map(|source| {
            let preview = preview_source_timezone(
                cache.path(),
                &report.corpus_id,
                undone.revision,
                &source.source,
                &timezone,
            )
            .expect("preview source timezone after undo");
            SourceTimezoneApplyRequest {
                source: source.source.clone(),
                iana_timezone: timezone.clone(),
                preview_token: preview.declaration_fingerprint,
            }
        })
        .collect();
    apply_source_timezones(
        cache.path(),
        &report.corpus_id,
        undone.revision,
        &reapply_requests,
        1_750_000_001,
    )
    .expect("reapply common timezone after undo");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open reapplied corpus");
    assert_eq!(
        active_timestamp_counts(&corpus),
        after,
        "reapply must reproduce the reviewed timestamp result"
    );

    let error_page = query_events(
        &corpus,
        &EventQuery {
            levels: vec!["error".into(), "fatal".into()],
            limit: 20,
            sort_by_time: false,
            ..Default::default()
        },
    )
    .expect("bounded structured Explorer evidence query");
    assert!(
        !error_page.events.is_empty(),
        "Explorer must return problem evidence"
    );
    assert!(error_page
        .events
        .iter()
        .all(|event| !event.source.is_empty()));
    let error_count = query_event_count(
        &corpus,
        &EventQuery {
            levels: vec!["error".into(), "fatal".into()],
            ..Default::default()
        },
    )
    .expect("exact problem-event count");
    assert!(error_count.total_matched >= error_page.events.len() as u64);
    let facets = query_facets(&corpus, &EventQuery::default()).expect("Explorer facets");
    assert_eq!(
        facets.levels.values().sum::<u64>(),
        report.stats.lines,
        "facets must account for every imported event"
    );
    let source_catalog = query_source_catalog(
        &corpus,
        &LogSourceCatalogQuery {
            search: None,
            cursor: None,
            limit: 200,
        },
    )
    .expect("source catalog");
    assert!(!source_catalog.sources.is_empty());
    assert_eq!(
        source_catalog.sources.len() as u64,
        source_catalog.total_matched,
        "this archive's source catalog must fit in one bounded page"
    );
    let clusters = cluster_problems(&corpus, 12).expect("bounded problem clustering");
    assert!(!clusters.is_empty(), "problem clustering must be useful");
    assert!(clusters.iter().any(|cluster| cluster.severity >= 4));
    let error_timeline = query_timeline_summary(
        &corpus,
        &TimelineSummaryQuery {
            filter: EventQuery {
                levels: vec!["error".into(), "fatal".into()],
                ..Default::default()
            },
            max_buckets: 48,
        },
    )
    .expect("bounded problem timeline");
    assert_eq!(error_timeline.total_matched, error_count.total_matched);
    assert!(!error_timeline.buckets.is_empty());

    let workspace_root = cache.path().join("empty-workspace");
    std::fs::create_dir(&workspace_root).expect("create isolated empty workspace");
    let mut host = ToolHost::new(
        Workspace::new("local-log-acceptance", vec![workspace_root]),
        KeywordIndex::new(),
        None,
    );
    host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    host.set_active_log_corpus(Some(report.corpus_id.clone()));
    host.set_log_corpus_scope(Some(report.corpus_id.clone()));
    host.pin_log_suppression_lens(&report.corpus_id)
        .expect("pin linked-chat suppression lens");
    let backend = BroadBriefCitationBackend {
        cited_identity: Mutex::new(None),
    };
    let context = LogExplorerTurnContext::new(
        "local-log-acceptance-window",
        &report.corpus_id,
        "All sources; reviewed timezone applied",
    )
    .expect("linked Explorer context");
    let mut history = Vec::new();
    let events = run_agent_turn(
        &backend,
        &mut host,
        "What problems do you see in these logs?",
        &mut history,
        &AgentOptions {
            session_id: "local-log-acceptance-chat".into(),
            model: Some("deterministic-tools-capable-fake".into()),
            provider_profile_id: Some("local-log-acceptance".into()),
            log_explorer_context: Some(context),
            max_rounds: 4,
            context_char_budget: 64 * 1024,
            ..Default::default()
        },
    )
    .await
    .expect("linked chat turn");
    assert!(events.iter().any(|event| matches!(
        event,
        StreamEvent::Tool {
            name,
            phase: ToolPhase::Finished,
            ok: Some(true),
            ..
        } if name == "broad_log_triage"
    )));
    let answer = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let cited_identity = backend
        .cited_identity
        .lock()
        .expect("citation lock")
        .clone()
        .expect("backend must cite a trusted identity");
    assert!(answer.contains(&format!(
        "seq={} source=\"{}\"",
        cited_identity.0, cited_identity.1
    )));
    assert!(events
        .iter()
        .any(|event| matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")));
    assert!(!events
        .iter()
        .any(|event| matches!(event, StreamEvent::Error { .. })));

    let search_backend = ErrorSearchCitationBackend {
        calls: AtomicUsize::new(0),
        cited_identity: Mutex::new(None),
    };
    let search_context = LogExplorerTurnContext::new(
        "local-log-error-search-window",
        &report.corpus_id,
        "All sources; ERROR and FATAL investigation",
    )
    .expect("linked error-search context");
    let mut search_history = Vec::new();
    let search_events = run_agent_turn(
        &search_backend,
        &mut host,
        "What are the most important errors in these logs?",
        &mut search_history,
        &AgentOptions {
            session_id: "local-log-acceptance-error-chat".into(),
            model: Some("deterministic-tools-capable-fake".into()),
            provider_profile_id: Some("local-log-acceptance".into()),
            log_explorer_context: Some(search_context),
            max_rounds: 4,
            context_char_budget: 64 * 1024,
            ..Default::default()
        },
    )
    .await
    .expect("linked error-search chat turn");
    assert_eq!(search_backend.calls.load(Ordering::SeqCst), 2);
    assert!(search_events.iter().any(|event| matches!(
        event,
        StreamEvent::Tool {
            name,
            phase: ToolPhase::Finished,
            ok: Some(true),
            ..
        } if name == SEARCH_LOGS
    )));
    let search_answer = search_events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let search_identity = search_backend
        .cited_identity
        .lock()
        .expect("citation lock")
        .clone()
        .expect("search backend must cite a trusted identity");
    assert!(search_answer.contains(&format!(
        "seq={} source=\"{}\"",
        search_identity.0, search_identity.1
    )));
    assert!(!search_events
        .iter()
        .any(|event| matches!(event, StreamEvent::Error { .. })));

    eprintln!(
        "LOCAL_LOG_ACCEPTANCE events={} timestamp_sources={} catalog_sources={} unresolved_before={} resolved_after={} explicit_preserved={} problem_events={} clusters={} evidence_hits={} product_embed={} rollback_reapply=true linked_chat_grounded=true linked_search_grounded=true",
        report.stats.lines,
        requests.len(),
        source_catalog.total_matched,
        before.0,
        after.1,
        after.2,
        error_count.total_matched,
        clusters.len(),
        error_page.events.len(),
        product_embed
    );
}
