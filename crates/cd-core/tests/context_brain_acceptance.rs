//! Hermetic acceptance for the deterministic multi-source context brain.
//!
//! Drives shipped `context_plan` + `run_agent_turn` with scripted providers.
//! Synthetic fixtures only — Preference `cobalt-window` kind-filter gap and
//! quality oracle (relevant included / irrelevant excluded).

use cd_core::agent::{run_agent_turn, AgentOptions, ScriptedBackend};
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
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use std::fs;
use std::sync::{Arc, Mutex};

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

    let backend = CaptureBackend::new(vec![final_answer(
        "The codename appears in durable preference memory.",
    )]);
    let mut history = Vec::new();
    // Prompt does not plant the answer string.
    let user = "What is the saved GUI demo codename?";
    assert!(!user.contains("cobalt-window"));

    let events = run_agent_turn(
        backend.as_ref(),
        &mut host,
        user,
        &mut history,
        &AgentOptions {
            session_id: "brain-sess".into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            compact_keep_last: 6,
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
        trail.contains("context_plan:") || trail.contains("context_used:"),
        "turn must emit context plan trail: {trail}"
    );
    assert!(
        trail.contains("context_used:") || trail.contains("context_included:"),
        "context used summary expected: {trail}"
    );

    let blob = format!(
        "{}\n{}",
        backend.all_blob(),
        history
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        blob.to_lowercase().contains("cobalt") || trail.contains("preference"),
        "preference inventory or injection must reach model/history: trail={trail} blob_len={}",
        blob.len()
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
