//! Hermetic acceptance for the deterministic multi-source context brain.
//!
//! Drives shipped `context_plan` + `run_agent_turn` with scripted providers.
//! Synthetic fixtures only — Preference `cobalt-window` kind-filter gap and
//! quality oracle (relevant included / irrelevant excluded).

use cd_core::activity::{ActivityDetailLevel, ActivityRecorder, ActivityStatus, DataScope};
use cd_core::agent::{run_agent_turn, AgentOptions, LogExplorerTurnContext, ScriptedBackend};
use cd_core::branding::Branding;
use cd_core::chat::{ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg};
use cd_core::context_plan::{
    apply_model_relevance, attachments_from_entries, build_context_plan, ContextInventorySnapshot,
    ContextPlanBudget, MemoryRecordSnapshot, RelevanceStrategy, WorkspaceHitSnapshot,
};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::memory::{
    attach_durable_memory_to_host, Kind, MemoryConfig, MemoryDraft, MemoryWriteOp, Status,
};
use cd_core::sessions::{
    estimate_context_chars, prepare_model_context, Session, SessionStore, StoredMessage,
};
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::{DeveloperDetailKind, RecordingTurnTrace, TurnTraceObserver};
use cd_core::workspace::Workspace;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn final_answer(text: &str) -> ChatCompletion {
    ChatCompletion {
        content: text.into(),
        tool_calls: vec![],
        finish_reason: "stop".into(),
    }
}

fn tool_call(id: &str, name: &str, args: &str) -> ChatCompletion {
    ChatCompletion {
        content: String::new(),
        tool_calls: vec![ToolCallMsg {
            id: id.into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.into(),
            },
        }],
        finish_reason: "tool_calls".into(),
    }
}

/// Captures provider-facing messages.
struct CaptureBackend {
    script: Mutex<std::collections::VecDeque<ChatCompletion>>,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}

impl CaptureBackend {
    fn new(responses: Vec<ChatCompletion>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(responses.into()),
            seen: Mutex::new(Vec::new()),
        })
    }
    fn all_blob(&self) -> String {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .flat_map(|r| r.iter().map(|m| m.content.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[async_trait::async_trait]
impl cd_core::agent::ChatBackend for CaptureBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        _tools: &[cd_core::tools::ToolSpec],
    ) -> cd_core::error::CoreResult<ChatCompletion> {
        self.seen.lock().unwrap().push(messages.to_vec());
        self.script
            .lock()
            .map_err(|_| cd_core::error::CoreError::Message("lock".into()))?
            .pop_front()
            .ok_or_else(|| cd_core::error::CoreError::Message("script exhausted".into()))
    }
}

#[test]
fn quality_oracle_relevant_preference_included_irrelevant_excluded() {
    // Answer string NOT planted in user prompt — only codename query.
    let user = "What is the saved GUI demo codename?";
    assert!(!user.contains("cobalt-window"));
    let records = vec![
        MemoryRecordSnapshot {
            id: "memory:pref-1".into(),
            kind: Kind::Preference,
            title: "cobalt-window".into(),
            content: "GUI demo codename is cobalt-window".into(),
            status: Status::Active,
        },
        MemoryRecordSnapshot {
            id: "memory:noise-1".into(),
            kind: Kind::Fact,
            title: "coffee-roast".into(),
            content: "unrelated coffee bean roast profiles".into(),
            status: Status::Active,
        },
    ];
    let snap = ContextInventorySnapshot {
        session_id: "s".into(),
        turn_id: "t".into(),
        user_text: user.into(),
        history_message_count: 1,
        history_text: String::new(),
        history_keep: 4,
        memory_records: records,
        memory_hits: vec![],
        ..Default::default()
    };
    let plan = build_context_plan(
        &snap,
        ContextPlanBudget::default(),
        RelevanceStrategy::DeterministicOnly,
    );
    assert!(
        plan.included().any(|c| {
            c.memory_kind.as_deref() == Some("preference")
                && (c.label.contains("cobalt")
                    || c.snippet.as_deref().unwrap_or("").contains("cobalt-window"))
        }),
        "relevant Preference must be included: {}",
        plan.context_used_summary
    );
    assert!(
        !plan.included().any(|c| c.label.contains("coffee")),
        "irrelevant fact must not be included"
    );
    assert!(
        !plan.context_used_summary.contains("coffee-roast")
            || plan.context_used_summary.contains("cobalt")
    );
}

#[test]
fn kind_filter_gap_preference_still_in_plan() {
    // Narrow kinds as model would request — inventory ignores this.
    let records = vec![MemoryRecordSnapshot {
        id: "memory:cw".into(),
        kind: Kind::Preference,
        title: "cobalt-window".into(),
        content: "codename cobalt-window for GUI demo".into(),
        status: Status::Active,
    }];
    let snap = ContextInventorySnapshot {
        session_id: "s".into(),
        turn_id: "t".into(),
        user_text: "GUI demo codename please".into(),
        memory_records: records,
        history_message_count: 1,
        history_text: String::new(),
        history_keep: 4,
        ..Default::default()
    };
    let plan = build_context_plan(
        &snap,
        ContextPlanBudget::default(),
        RelevanceStrategy::DeterministicOnly,
    );
    let pref = plan
        .candidates
        .iter()
        .find(|c| c.memory_kind.as_deref() == Some("preference"))
        .expect("Preference candidate");
    assert!(
        pref.reasons
            .iter()
            .any(|r| r.as_str() == "memory_kind_eligible" || r.as_str() == "included_by_rank"),
        "must record host eligibility, not model kinds: {:?}",
        pref.reasons
    );
}

#[tokio::test]
async fn ordinary_turn_surfaces_context_plan_trail_and_preference() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("readme.md"), "workspace note\n").unwrap();
    let ws = Workspace::new("ctx-brain", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let branding = Branding::embedded();
    attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
    let store = host.durable_memory_store().expect("memory store");
    let now = cd_core::embed::now_unix_secs();
    let mut pref = MemoryDraft::new(
        Kind::Preference,
        "The GUI demo codename is cobalt-window for acceptance.",
    );
    pref.title = "cobalt-window".into();
    store.put(MemoryWriteOp::Insert(pref), now).unwrap();

    let provider = CaptureBackend::new(vec![final_answer(
        "The codename appears in durable preference memory.",
    )]);
    let sink = Arc::new(RecordingTurnTrace::with_developer_detail(
        std::time::Instant::now(),
        Arc::new(|_e| {}),
    ));
    let mut history = Vec::new();
    let user = "What is the saved GUI demo codename?";
    assert!(!user.contains("cobalt-window"));

    let events = run_agent_turn(
        provider.as_ref(),
        &mut host,
        user,
        &mut history,
        &AgentOptions {
            session_id: "brain-sess".into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            compact_keep_last: 6,
            developer_trace: Some(TurnTraceObserver::new(sink.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let trail = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::SearchTrail { steps } => Some(steps.join("|")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("||");
    assert!(
        trail.contains("context_plan:"),
        "turn must emit context_plan trail: {trail}"
    );
    assert!(
        trail.contains("context_used:"),
        "context used summary required: {trail}"
    );

    // Provider-facing messages MUST contain cobalt-window (not just trail text).
    let provider_blob = provider.all_blob();
    assert!(
        provider_blob.to_lowercase().contains("cobalt-window")
            || provider_blob.to_lowercase().contains("cobalt"),
        "model-facing provider context must include preference content: {provider_blob}"
    );

    // Developer detail On: context_plan contributor recorded before provider.
    let dev = sink.developer_events();
    assert!(
        dev.iter().any(|e| {
            e.kind == DeveloperDetailKind::ContextProvenance
                && e.label.to_lowercase().contains("context_plan")
        }),
        "Developer detail must include context_plan provenance: {:?}",
        dev.iter().map(|e| &e.label).collect::<Vec<_>>()
    );
    let plan_event = dev
        .iter()
        .find(|event| event.label == "Context: context_plan")
        .expect("ordinary context-plan provenance");
    let plan_payload: serde_json::Value = serde_json::from_str(&plan_event.request[0].content)
        .expect("ordinary context-plan provenance JSON");
    assert_ne!(
        plan_payload["facts"]["turn_id"], "brain-sess",
        "a defaulted turn id must be freshly allocated, never copied from session id"
    );
    assert_eq!(plan_payload["facts"]["application"], "model_facing");
    assert_eq!(plan_payload["facts"]["model_facing"], true);
    assert_eq!(plan_event.status, "model_facing");

    // Activity projection retains context_used / plan steps in label or detail.
    let mut rec = ActivityRecorder::new(
        "t1",
        "brain-sess",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    rec.record_stream_events(&events);
    let record = rec.finish(ActivityStatus::Ok, 10);
    assert!(
        record.events.iter().any(|e| {
            e.label.contains("Context used")
                || e.detail
                    .as_deref()
                    .is_some_and(|d| d.contains("context_used:") || d.contains("context_plan:"))
        }),
        "Activity must surface context plan/used: {:?}",
        record.events.iter().map(|e| &e.label).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn attachment_body_via_tool_not_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("ws.md"), "ws\n").unwrap();
    let ws = Workspace::new("att", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let base = root.join(".contextdesk");
    host.set_session_context_base(Some(base.clone()));
    host.set_active_session_id(Some("att-sess".into()));
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        "att-sess",
        cd_core::session_context::SessionContextCaps::default(),
    )
    .unwrap();
    const BODY: &str = "cascade failure token ATTACH-ONLY-9z";
    store
        .import_bytes("note.txt", format!("{BODY}\n").as_bytes())
        .unwrap();

    let backend = CaptureBackend::new(vec![
        tool_call(
            "a1",
            "search_kb",
            r#"{"query":"cascade failure","limit":4}"#,
        ),
        final_answer("Answered from tool evidence only."),
    ]);
    let mut history = Vec::new();
    let user = "Search session pack for cascade notes.";
    assert!(!user.contains(BODY));
    let events = run_agent_turn(
        backend.as_ref(),
        &mut host,
        user,
        &mut history,
        &AgentOptions {
            session_id: "att-sess".into(),
            ambient_recall_enabled: false,
            max_rounds: 4,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::Tool { name, ok: Some(true), .. } if name == "search_kb"
    )));
    let tool = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        tool.contains(BODY) || tool.contains("note.txt"),
        "attachment body must reach Role::Tool: {tool}"
    );
}

#[test]
fn fail_closed_relevance_and_cli_trail_shape() {
    let snap = ContextInventorySnapshot {
        session_id: "s".into(),
        turn_id: "t".into(),
        user_text: "x".into(),
        history_message_count: 1,
        history_text: "h".into(),
        history_keep: 2,
        workspace_hits: vec![WorkspaceHitSnapshot {
            path: "a.md".into(),
            snippet: "x fact".into(),
            score: 0.9,
        }],
        ..Default::default()
    };
    let det = build_context_plan(
        &snap,
        ContextPlanBudget::default(),
        RelevanceStrategy::DeterministicOnly,
    );
    let failed = apply_model_relevance(det.clone(), None);
    assert!(failed.relevance_failed_closed);
    let steps = failed.trail_steps();
    assert!(steps.iter().any(|s| s.starts_with("context_plan:")));
    assert!(steps.iter().any(|s| s.starts_with("context_used:")));
}

#[test]
fn attachments_from_entries_no_io() {
    let entries = vec![cd_core::session_context::SessionContextEntry {
        rel_path: "f.txt".into(),
        name: "f.txt".into(),
        size: 12,
    }];
    let atts = attachments_from_entries(&entries);
    assert_eq!(atts.len(), 1);
    assert!(atts[0].body_preview.is_none());
}

#[tokio::test]
async fn continuity_thirty_turns_with_plan_trail() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("runbook.md"), "pool floor decision\n").unwrap();
    let ws = Workspace::new("cont", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let branding = Branding::embedded();
    attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();

    let mut script = Vec::new();
    for i in 0..32 {
        script.push(final_answer(&format!("ack turn {i}")));
    }
    let backend = ScriptedBackend::new(script);
    let mut history = Vec::new();
    let mut saw_plan = false;
    for t in 0..32 {
        let events = run_agent_turn(
            &backend,
            &mut host,
            &format!("status {t}"),
            &mut history,
            &AgentOptions {
                session_id: "long".into(),
                ambient_recall_enabled: true,
                max_rounds: 2,
                compact_keep_last: 4,
                context_char_budget: 12_000,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if events.iter().any(|e| matches!(
            e,
            StreamEvent::SearchTrail { steps } if steps.iter().any(|s| s.contains("context_plan") || s.contains("context_used"))
        )) {
            saw_plan = true;
        }
    }
    assert!(history.len() >= 32);
    assert!(
        saw_plan,
        "expected context_plan trail on ordinary ambient turns"
    );
}

#[tokio::test]
async fn session_reopen_preserves_plan_eligible_memory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("ws.md"), "ws\n").unwrap();
    let ws = Workspace::new("reopen", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let branding = Branding::embedded();
    attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
    let store = host.durable_memory_store().unwrap();
    let now = cd_core::embed::now_unix_secs();
    let mut pref = MemoryDraft::new(Kind::Preference, "codename cobalt-window reopen proof");
    pref.title = "cobalt-window".into();
    store.put(MemoryWriteOp::Insert(pref), now).unwrap();

    let backend = CaptureBackend::new(vec![
        final_answer("noted constraint never reboot production"),
        final_answer("after reopen still know cobalt-window"),
    ]);
    let mut history = Vec::new();
    let sid = "reopen-sess";
    run_agent_turn(
        backend.as_ref(),
        &mut host,
        "Remember CONSTRAINT: never reboot production hosts. GUI codename?",
        &mut history,
        &AgentOptions {
            session_id: sid.into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let sess_dir = root.join("sessions");
    let sstore = SessionStore::new(&sess_dir);
    sstore.ensure().unwrap();
    let mut sess = Session::new("reopen");
    sess.id = sid.into();
    for (i, m) in history.iter().enumerate() {
        let role = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => "tool",
        };
        sess.messages.push(StoredMessage {
            id: format!("m{i}"),
            role: role.into(),
            content: m.content.clone(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
    }
    sstore.save(&sess).unwrap();
    let loaded = sstore.load(sid).unwrap();
    assert_eq!(loaded.id, sid);
    let mut continued = loaded.to_chat_history();
    assert!(continued.len() >= 2);

    let cap2 = CaptureBackend::new(vec![final_answer("still tracking")]);
    let events = run_agent_turn(
        cap2.as_ref(),
        &mut host,
        "Continue after reopen — what is the GUI codename?",
        &mut continued,
        &AgentOptions {
            session_id: sid.into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let trail = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::SearchTrail { steps } => Some(steps.join("|")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("||");
    let blob = format!("{}{}", cap2.all_blob(), trail);
    assert!(
        blob.to_lowercase().contains("cobalt") || trail.contains("preference"),
        "reopen turn must still surface preference via plan/provider: {blob}"
    );
    assert!(
        continued.iter().any(|m| m.content.contains("never reboot")
            || m.content.contains("CONSTRAINT")
            || m.content.contains("codename")),
        "durable history must survive SessionStore round-trip"
    );
}

#[test]
fn hard_budget_compaction_with_context_plan_history_candidate() {
    let mut hist = vec![ChatMessage {
        role: Role::System,
        content: "policy".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    for i in 0..80 {
        hist.push(ChatMessage {
            role: Role::User,
            content: format!("filler user {i} {}", "x".repeat(120)),
            tool_call_id: None,
            tool_calls: None,
        });
        hist.push(ChatMessage {
            role: Role::Assistant,
            content: format!("filler asst {i} {}", "y".repeat(120)),
            tool_call_id: None,
            tool_calls: None,
        });
    }
    hist.push(ChatMessage {
        role: Role::User,
        content: "OPEN_Q: true root cause? CONSTRAINT: never reboot".into(),
        tool_call_id: None,
        tool_calls: None,
    });
    let budget = 4_000usize;
    let prep = prepare_model_context(&hist, 4, budget).expect("fit");
    assert!(estimate_context_chars(&prep.messages) <= budget);
    assert!(hist.len() > prep.messages.len());

    let snap = ContextInventorySnapshot {
        session_id: "s".into(),
        turn_id: "t".into(),
        user_text: "OPEN_Q true root cause".into(),
        history_text: prep
            .messages
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        history_message_count: hist.len(),
        history_keep: prep.keep,
        history_compacted: prep.compacted
            || prep
                .messages
                .iter()
                .any(|m| m.content.contains("Compacted")),
        ..Default::default()
    };
    let plan = build_context_plan(
        &snap,
        ContextPlanBudget::default(),
        RelevanceStrategy::DeterministicOnly,
    );
    assert!(
        plan.included()
            .any(|c| c.family == cd_core::context_plan::ContextSourceFamily::ConversationHistory),
        "history window must be in plan after compaction"
    );
}

#[tokio::test]
async fn disproof_replaces_stale_hypothesis_with_fresh_tool_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let logs = root.join("logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(
        logs.join("worker.log"),
        r#"{"ts":1700000100,"level":"error","message":"DISPROOF: db_pool_max 32 to 4 not network"}
{"ts":1700000101,"level":"info","message":"job-7f3a pool exhausted"}
"#,
    )
    .unwrap();
    let cache = root.join("cache");
    fs::create_dir_all(&cache).unwrap();
    let report =
        cd_core::log_analysis::ingest_path(&cache, &logs, "disproof", None, "none").unwrap();
    let ws = Workspace::new("dis", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    host.set_log_analysis(true, Some(cache));
    host.set_active_log_corpus(Some(report.corpus_id.clone()));

    let mut history = vec![
        ChatMessage {
            role: Role::User,
            content: "Form hypothesis".into(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::Assistant,
            content: "HYPOTHESIS_H1: network partition caused pool exhaustion".into(),
            tool_call_id: None,
            tool_calls: None,
        },
    ];
    let backend = CaptureBackend::new(vec![
        tool_call(
            "sl1",
            cd_core::log_analysis::SEARCH_LOGS,
            r#"{"query":"db_pool_max"}"#,
        ),
        final_answer("Updated: config shrink disproves H1 at seq=0 source=worker.log"),
    ]);
    let ctx =
        LogExplorerTurnContext::new("w", report.corpus_id.as_str(), "sources=worker.log").unwrap();
    let trace = Arc::new(RecordingTurnTrace::with_developer_detail(
        Instant::now(),
        Arc::new(|_| {}),
    ));
    let events = run_agent_turn(
        backend.as_ref(),
        &mut host,
        "Challenge H1 with fresh log evidence",
        &mut history,
        &AgentOptions {
            session_id: "disproof".into(),
            turn_id: "turn-disproof-001".into(),
            log_explorer_context: Some(ctx),
            max_rounds: 6,
            ambient_recall_enabled: false,
            developer_trace: Some(TurnTraceObserver::new(trace.clone())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let tools: String = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        tools.contains("DISPROOF") || tools.contains("db_pool") || tools.contains("pool"),
        "tool evidence must carry disproof: {tools}"
    );
    assert!(
        history.iter().any(|m| m.content.contains("HYPOTHESIS_H1")),
        "prior H1 remains in history"
    );

    let trail = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::SearchTrail { steps } => Some(steps.join("|")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("||");
    assert!(
        trail.contains("context_inventory_only:not_model_facing"),
        "linked candidate scan must be explicitly inventory-only: {trail}"
    );
    assert!(
        !trail.contains("context_plan_inject:"),
        "linked turns must not inject ordinary context plan content: {trail}"
    );
    assert!(
        !trail.contains("context_used:"),
        "inventory-only linked candidates must never be called Context used: {trail}"
    );
    assert!(
        !backend.all_blob().contains("Host context inventory"),
        "linked provider request must use its evidence-gated path, not plan injection"
    );

    let developer_events = trace.developer_events();
    let context_plan = developer_events
        .iter()
        .find(|event| {
            event.kind == DeveloperDetailKind::ContextProvenance
                && event.label == "Context: context_plan"
        })
        .expect("linked context-plan developer event");
    assert_eq!(context_plan.status, "inventory_only_not_model_facing");
    let payload: serde_json::Value = serde_json::from_str(&context_plan.request[0].content)
        .expect("context-plan provenance JSON");
    let facts = &payload["facts"];
    assert_eq!(facts["turn_id"], "turn-disproof-001");
    assert_ne!(facts["turn_id"], "disproof");
    assert_eq!(facts["application"], "inventory_only");
    assert_eq!(facts["model_facing"], false);
    assert!(facts.get("inventory_summary").is_some());
    assert!(facts.get("context_used_summary").is_none());

    // This shared projection feeds both desktop Activity and CLI Activity.
    let mut recorder = ActivityRecorder::new(
        "turn-disproof-001",
        "disproof",
        DataScope::log_corpus(report.corpus_id),
        ActivityDetailLevel::Summary,
    );
    recorder.record_stream_events(&events);
    let record = recorder.finish(ActivityStatus::Ok, 10);
    assert!(record
        .events
        .iter()
        .any(|event| event.label == "Context inventory only (not model-facing)"));
    assert!(record.events.iter().all(|event| {
        !event.label.contains("Context used")
            && !event
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("context_used:"))
    }));
}

#[tokio::test]
async fn cross_session_no_private_leak() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("ws.md"), "ws\n").unwrap();
    let sess_dir = root.join("sessions");
    let sstore = SessionStore::new(&sess_dir);
    sstore.ensure().unwrap();

    let ws = Workspace::new("leak", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let private = "PRIVATE_SESS_A=secret-marker-should-not-leak";
    let cap_a = CaptureBackend::new(vec![final_answer(&format!("A holds {private}"))]);
    let mut hist_a = Vec::new();
    run_agent_turn(
        cap_a.as_ref(),
        &mut host,
        &format!("Private note: {private}"),
        &mut hist_a,
        &AgentOptions {
            session_id: "session-A".into(),
            ambient_recall_enabled: false,
            max_rounds: 2,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut sess_a = Session::new("A");
    sess_a.id = "session-A".into();
    for (i, m) in hist_a.iter().enumerate() {
        sess_a.messages.push(StoredMessage {
            id: format!("a{i}"),
            role: "user".into(),
            content: m.content.clone(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
    }
    // store only user content with private for durable leak check
    sess_a.messages.push(StoredMessage {
        id: "priv".into(),
        role: "user".into(),
        content: private.into(),
        tools: None,
        citations: None,
        trail: None,
        meta: None,
    });
    sstore.save(&sess_a).unwrap();

    let mut sess_b = Session::new("B");
    sess_b.id = "session-B".into();
    sstore.save(&sess_b).unwrap();
    let loaded_b = sstore.load("session-B").unwrap();
    assert!(
        !loaded_b
            .to_chat_history()
            .iter()
            .any(|m| m.content.contains(private)),
        "SessionStore B must not contain A private"
    );

    let cap_b = CaptureBackend::new(vec![final_answer("hello B")]);
    let mut hist_b = loaded_b.to_chat_history();
    run_agent_turn(
        cap_b.as_ref(),
        &mut host,
        "Hello from session B",
        &mut hist_b,
        &AgentOptions {
            session_id: "session-B".into(),
            ambient_recall_enabled: false,
            max_rounds: 2,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        !cap_b.all_blob().contains(private) && !hist_b.iter().any(|m| m.content.contains(private)),
        "session A private must not leak into B provider/history"
    );
}

#[test]
fn inventory_never_probes_unauthorized_connectors() {
    use cd_core::context_plan::ConnectorSlotSnapshot;
    let snap = ContextInventorySnapshot {
        session_id: "s".into(),
        turn_id: "t".into(),
        user_text: "search confluence".into(),
        optional_connectors: vec![ConnectorSlotSnapshot {
            name: "confluence".into(),
            authorized: false,
        }],
        history_message_count: 1,
        history_text: "h".into(),
        history_keep: 2,
        ..Default::default()
    };
    let plan = build_context_plan(
        &snap,
        ContextPlanBudget::default(),
        RelevanceStrategy::DeterministicOnly,
    );
    assert!(plan
        .side_effects_forbidden
        .iter()
        .any(|s| s == "keychain_read" || s == "connector_network"));
    assert!(plan.candidates.iter().any(|c| {
        c.family == cd_core::context_plan::ContextSourceFamily::OptionalConnector
            && c.disposition == cd_core::context_plan::CandidateDisposition::Deferred
    }));
}

#[tokio::test]
async fn multi_source_unique_tokens_reach_provider_not_prompt() {
    // Tokens appear ONLY in their source artifacts — not user prompt, not final answer.
    const MEM_TOKEN: &str = "MEMONLY_token_q7x9";
    const WS_TOKEN: &str = "WSONLY_token_m3k2";
    const ATT_TOKEN: &str = "ATTONLY_token_p8n4";
    const SEL_TOKEN: &str = "SELONLY_token_r5v6";
    const NOISE_TOKEN: &str = "NOISEONLY_token_z1z1";

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(
        root.join("runbook.md"),
        format!("workspace note mentions {WS_TOKEN} for allowlisted search\n"),
    )
    .unwrap();
    let ws = Workspace::new("multi", vec![root.to_path_buf()]);
    let idx = KeywordIndex::build(&ws).unwrap();
    let mut host = ToolHost::new(ws, idx, None);
    let branding = Branding::embedded();
    attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
    let store = host.durable_memory_store().unwrap();
    let now = cd_core::embed::now_unix_secs();
    let mut pref = MemoryDraft::new(
        Kind::Preference,
        format!("relevant preference for investigation pack body {MEM_TOKEN}"),
    );
    pref.title = "investigation preference".into();
    store.put(MemoryWriteOp::Insert(pref), now).unwrap();
    let mut noise = MemoryDraft::new(Kind::Fact, format!("unrelated {NOISE_TOKEN} coffee"));
    noise.title = "coffee-noise".into();
    store.put(MemoryWriteOp::Insert(noise), now).unwrap();

    let base = root.join(".contextdesk");
    host.set_session_context_base(Some(base.clone()));
    host.set_active_session_id(Some("multi-sess".into()));
    let sess = cd_core::session_context::SessionContextStore::open(
        &base,
        "multi-sess",
        cd_core::session_context::SessionContextCaps::default(),
    )
    .unwrap();
    sess.import_bytes(
        "pack-note.txt",
        format!("attachment pack carries {ATT_TOKEN}\n").as_bytes(),
    )
    .unwrap();

    let provider = CaptureBackend::new(vec![final_answer("I will answer from host context only.")]);
    // Prompt contains NONE of the unique tokens.
    // Query shares topical terms with sources but never the unique tokens.
    let user = "Summarize relevant preference, workspace, and pack notes for this investigation.";
    assert!(!user.contains(MEM_TOKEN) && !user.contains(WS_TOKEN) && !user.contains(ATT_TOKEN));
    assert!(!user.contains(NOISE_TOKEN) && !user.contains(SEL_TOKEN));

    let mut history = Vec::new();
    let events = run_agent_turn(
        provider.as_ref(),
        &mut host,
        user,
        &mut history,
        &AgentOptions {
            session_id: "multi-sess".into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            applied_skill_ids: vec!["triage-skill".into()],
            user_selection: Some(format!(
                "client highlight for investigation mentions {SEL_TOKEN}"
            )),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let trail = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::SearchTrail { steps } => Some(steps.join("|")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("||");
    assert!(
        trail.contains("context_plan:"),
        "plan trail required: {trail}"
    );
    assert!(
        trail.contains("context_included:") || trail.contains("context_used:"),
        "included/used steps: {trail}"
    );
    assert!(
        trail.contains("context_plan_inject:") || trail.contains("context_included:"),
        "injection or inclusion required: {trail}"
    );

    let blob = provider.all_blob();
    // Relevant tokens from memory / workspace / attachment / selection must reach provider.
    assert!(
        blob.contains(MEM_TOKEN),
        "memory token must reach provider: {blob}"
    );
    assert!(
        blob.contains(WS_TOKEN),
        "workspace token must reach provider: {blob}"
    );
    assert!(
        blob.contains(ATT_TOKEN),
        "attachment token must reach provider: {blob}"
    );
    assert!(
        blob.contains(SEL_TOKEN),
        "user_selection token must reach provider: {blob}"
    );
    // Skill pin should appear in plan trail or provider as skill id.
    assert!(
        trail.contains("pinned_skill")
            || trail.contains("triage-skill")
            || blob.contains("triage-skill"),
        "pinned skill must be inventoried: trail={trail}"
    );
    // Irrelevant noise should not be forced into provider context.
    assert!(
        !blob.contains(NOISE_TOKEN),
        "irrelevant noise token must not appear in provider context: {blob}"
    );
}
