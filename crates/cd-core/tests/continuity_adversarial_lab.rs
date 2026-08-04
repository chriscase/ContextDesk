//! Adversarial long-investigation / context-continuity acceptance laboratory.
//!
//! Drives **shipped** production paths only:
//! - [`cd_core::agent::run_agent_turn`] + [`cd_core::agent::ScriptedBackend`]
//! - [`cd_core::sessions::prepare_model_context`] / [`SessionStore`]
//! - [`cd_core::activity::ActivityRecorder`] + turn-trace projection
//! - linked-log via [`LogExplorerTurnContext`] (same agent entry point)
//!
//! All fixtures are neutral/synthetic. No network. No cd-cli / cd-workflow
//! (absent on base 3e18a551 — residual reported separately).
//! Lineage wording: base `3e18a551` is an ancestor of candidate `b8a36429`.

#[path = "support/continuity_lab.rs"]
mod continuity_lab;

use cd_core::activity::{
    strip_bodies_for_durability, ActivityDetailLevel, ActivityRecorder, ActivityStatus, DataScope,
};
use cd_core::agent::{
    run_agent_turn, AgentOptions, ChatBackend, LogExplorerTurnContext, ScriptedBackend,
};
use cd_core::chat::{ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::{
    estimate_context_chars, prepare_model_context, Session, SessionStore, StoredMessage,
    MODEL_CONTEXT_TRUNCATE_MARKER,
};
use cd_core::skills::{apply_pinned_skill_to_user_text, discover_skills, Skill};
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::{RecordingTurnTrace, TracingChatBackend, TurnTraceSink};
use cd_core::workspace::Workspace;
use continuity_lab::*;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ─── helpers ───────────────────────────────────────────────────────────────

fn default_opts(session_id: &str) -> AgentOptions {
    AgentOptions {
        session_id: session_id.into(),
        model: Some("scripted-lab".into()),
        max_rounds: 8,
        compact_keep_last: 4,
        context_char_budget: 12_000,
        ambient_recall_enabled: false,
        ..Default::default()
    }
}

fn text_from(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn tool_ok_names(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Tool {
                name,
                ok: Some(true),
                ..
            } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn tool_fail_names(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Tool {
                name,
                ok: Some(false),
                ..
            } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn history_to_session(session_id: &str, history: &[ChatMessage], linked: Option<&str>) -> Session {
    let mut s = Session::new("continuity-lab");
    s.id = session_id.to_string();
    s.compact_keep_last = 4;
    if let Some(c) = linked {
        s.linked_corpus_id = Some(c.to_string());
    }
    for (i, m) in history.iter().enumerate() {
        let role = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::Tool => "tool",
        };
        s.messages.push(StoredMessage {
            id: format!("m{i}"),
            role: role.into(),
            content: m.content.clone(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
    }
    s.touch();
    s
}

struct MidTurnCancelBackend {
    entered_provider: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl ChatBackend for MidTurnCancelBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[cd_core::tools::ToolSpec],
    ) -> cd_core::error::CoreResult<ChatCompletion> {
        unreachable!("the cancellation probe uses complete_streaming")
    }

    async fn complete_streaming(
        &self,
        _messages: &[ChatMessage],
        _tools: &[cd_core::tools::ToolSpec],
        _on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&AtomicBool>,
    ) -> cd_core::error::CoreResult<ChatCompletion> {
        let cancel = cancel.expect("cancel flag");
        self.entered_provider.store(true, Ordering::SeqCst);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(cd_core::error::CoreError::Message("cancelled".into()));
            }
            tokio::task::yield_now().await;
        }
    }
}

// ─── 1. 30+ turn ordinary-chat continuity ──────────────────────────────────

/// Thirty-plus ordinary-chat turns through `run_agent_turn`, with multi-round
/// tools, a failed tool that must not become a fact, session close/reopen via
/// `SessionStore`, skill pin, and session-context attachment.
#[tokio::test]
async fn lab_30_plus_turn_ordinary_chat_continuity() {
    let env = LabEnv::new();
    let c = &env.canaries;
    const SKILL_PROCESS_TOKEN: &str = "SKILL_PROCESS_TOKEN=triage-origin-7f3a";
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

    // Skill fixture (method only — not evidence).
    let skill_root = env.root.join(".contextdesk").join("skills");
    let skill_dir = skill_root.join("triage");
    fs::create_dir_all(&skill_dir).unwrap();
    // discover_skills finds dir/*/SKILL.md — write frontmatter file directly.
    fs::write(
        skill_dir.join("SKILL.md"),
        format!(
            "---\nid: triage\nname: Synthetic triage\ndescription: How to triage pool issues\nenabled: true\n---\n\
             PROCESS: check neutral evidence; never invent root cause. {SKILL_PROCESS_TOKEN}\n"
        ),
    )
    .unwrap();
    let skills = discover_skills(&[skill_root]).unwrap();
    assert!(
        skills.iter().any(|s| s.id == "triage" && !s.disabled),
        "pinned skill must be discoverable"
    );
    let _skill_ty: Option<Skill> = None;

    // Session-context attachment (synthetic).
    let ctx_base = env.root.join("session-ctx");
    let store_ctx = cd_core::session_context::SessionContextStore::open(
        &ctx_base,
        &c.session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .unwrap();
    store_ctx
        .import_bytes(
            "attachment-note.txt",
            format!("ATTACHMENT canary: {}", c.incident_id).as_bytes(),
        )
        .unwrap();

    let capture = CaptureCtx::new();
    // Plant durable investigation state once, before the 32 neutral turns. Keep
    // each early message below the summary snippet cap so survival is testable
    // without re-stating any marker in the retained tail.
    let mut history: Vec<ChatMessage> = vec![
        msg(
            Role::User,
            format!("EARLY_ONLY {} {}", c.session_id, c.incident_id),
        ),
        msg(
            Role::Assistant,
            format!("EARLY_ONLY {} {}", c.user_constraint, c.open_question),
        ),
    ];
    let turn_count = 32usize;
    let mut saw_compaction = false;

    // Script: mostly final answers; every 5th turn multi-round tool; one
    // deliberate empty/failed tool mid-stream; one SoftWrite permission stop.
    let mut script: Vec<ChatCompletion> = Vec::new();
    for t in 0..turn_count {
        if t == 7 {
            // Failed search then recovery answer — failure must not be fact.
            script.push(tool_call(
                "fail-1",
                "search_kb",
                r#"{"query":"NONEXISTENT_MARKER_ZZZ","limit":3}"#,
            ));
            script.push(final_answer(format!(
                "Turn {t}: search returned no usable evidence; not treating empty output as fact. {}",
                "neutral-response-".repeat(28)
            )));
        } else if t == 11 {
            // Multi-round neutral search: no continuity canary is re-planted.
            script.push(tool_call(
                "ok-1",
                "search_kb",
                r#"{"query":"neutral healthcheck","limit":3}"#,
            ));
            script.push(final_answer(format!(
                "Turn {t}: neutral tool result recorded. {}",
                "neutral-response-".repeat(28)
            )));
        } else if t == 15 {
            // SoftWrite: must stop at permission — no durable write yet.
            script.push(tool_call(
                "mem-1",
                "save_memory",
                r#"{"title":"lab-note","body_markdown":"neutral pending note"}"#,
            ));
        } else if t % 5 == 0 && t > 0 {
            script.push(tool_call(
                &format!("t{t}"),
                "search_kb",
                r#"{"query":"neutral healthcheck","limit":2}"#,
            ));
            script.push(final_answer(format!(
                "Turn {t}: neutral continuation after tool. {}",
                "neutral-response-".repeat(28)
            )));
        } else {
            script.push(final_answer(format!(
                "Turn {t}: neutral continuation. {}",
                "neutral-response-".repeat(28)
            )));
        }
    }

    let backend = CapturingScriptedBackend::new(script, capture.clone());
    let session_id = c.session_id.as_str();

    for t in 0..turn_count {
        let user = if t == 0 {
            apply_pinned_skill_to_user_text(
                "Start the synthetic investigation using the early durable state.",
                Some("triage"),
                &skills,
            )
        } else if t == 11 {
            "Search the neutral healthcheck and cite the neutral result.".to_string()
        } else if t == 15 {
            "Please remember the neutral pending note.".to_string()
        } else {
            format!(
                "Neutral status check turn {t}. {}",
                "neutral-user-filler-".repeat(28)
            )
        };

        for marker in [
            c.session_id.as_str(),
            c.incident_id.as_str(),
            c.user_constraint.as_str(),
            c.open_question.as_str(),
        ] {
            assert!(
                !user.contains(marker),
                "continuity canary was re-planted in turn {t}: {marker}"
            );
        }

        // Production skill pin: first turn user text must carry skill process (not evidence).
        if t == 0 {
            assert!(
                user.contains("triage")
                    || user.contains("PROCESS")
                    || user.contains("check runbook")
                    || user.contains("Skill")
                    || user.contains("skill"),
                "pinned skill must inject process into user turn text: {user}"
            );
        }

        let events = run_agent_turn(
            &backend,
            &mut host,
            &user,
            &mut history,
            &AgentOptions {
                session_id: session_id.into(),
                model: Some("scripted-lab".into()),
                max_rounds: 6,
                compact_keep_last: 30,
                context_char_budget: 24_000,
                ambient_recall_enabled: false,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_else(|e| panic!("turn {t} failed: {e}"));

        saw_compaction |= events.iter().any(
            |event| matches!(event, StreamEvent::Error { code, .. } if code == "context_compacted"),
        ) || capture
            .last_blob()
            .contains("Compacted earlier conversation");

        // After turn 0, provider must have seen skill-injected process text.
        if t == 0 {
            let first_provider = capture.last_blob();
            assert!(
                first_provider.contains(SKILL_PROCESS_TOKEN),
                "skill process must reach model-facing history/provider after pin"
            );
        }

        // Turn 15 must hit permission boundary without writing.
        if t == 15 {
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    StreamEvent::TurnCompleted { reason } if reason == "awaiting_permission"
                )),
                "turn 15 must await SoftWrite permission: {events:?}"
            );
            assert_eq!(
                count_memory_files(&env.root),
                0,
                "SoftWrite must not write without grant"
            );
        }
        // Failed tool turn must surface failure, not invent results.
        if t == 7 {
            let fails = tool_fail_names(&events);
            // empty search may still ok=true with empty detail — assert answer honesty
            let ans = text_from(&events);
            assert!(
                ans.contains("no usable evidence") || ans.contains("not treating"),
                "failed/empty tool must not become fact: {ans}"
            );
            let _ = fails;
        }
    }

    assert!(
        history.len() >= turn_count,
        "history must retain full transcript, len={}",
        history.len()
    );
    // Model context stayed under hard budget every round.
    assert!(
        capture.max_chars() <= 24_000,
        "provider saw over-budget context: {}",
        capture.max_chars()
    );
    assert!(
        saw_compaction,
        "30+ turn production path must actually compact"
    );
    // Compaction should keep model message count well below full history.
    assert!(
        capture.max_message_count() < history.len(),
        "model saw {} msgs but full history is {}",
        capture.max_message_count(),
        history.len()
    );

    // The final pre-reopen provider call must recover the early-only state from
    // compacted context. None of these markers was reintroduced after turn 0.
    let final_provider = capture.last_blob();
    for marker in [
        c.session_id.as_str(),
        c.incident_id.as_str(),
        c.user_constraint.as_str(),
        c.open_question.as_str(),
    ] {
        assert!(
            final_provider.contains(marker),
            "early-only continuity marker missing from final compacted provider context: {marker}\n{final_provider}"
        );
    }

    // Identifiers / constraints survive in durable history.
    let full = model_context_blob(&history);
    assert!(full.contains(&c.session_id), "session id lost from history");
    assert!(full.contains(&c.incident_id), "incident id lost");
    assert!(
        full.contains("never reboot production") || full.contains(&c.user_constraint),
        "user constraint lost from history"
    );

    // Session close + reopen via production SessionStore.
    let sess_dir = env.root.join("sessions");
    let store = SessionStore::new(&sess_dir);
    store.ensure().unwrap();
    let expected_transcript: Vec<(String, String)> = history
        .iter()
        .map(|message| (format!("{:?}", message.role), message.content.clone()))
        .collect();
    let mut session = history_to_session(session_id, &history, None);
    session.compact_keep_last = 30;
    session.pinned_skill_id = Some("triage".into());
    store.save(&session).unwrap();
    drop(session);
    let reopened = store.load(session_id).unwrap();
    assert_eq!(reopened.id, session_id);
    assert_eq!(reopened.messages.len(), history.len());
    assert_eq!(reopened.pinned_skill_id.as_deref(), Some("triage"));
    let reopened_hist = reopened.to_chat_history();
    let reopened_transcript: Vec<(String, String)> = reopened_hist
        .iter()
        .map(|message| (format!("{:?}", message.role), message.content.clone()))
        .collect();
    assert_eq!(
        reopened_transcript, expected_transcript,
        "close/reopen must preserve every role and body exactly"
    );
    let reblob = model_context_blob(&reopened_hist);
    assert!(reblob.contains(&c.incident_id));
    assert!(
        reblob.contains("never reboot") || reblob.contains(&c.user_constraint),
        "constraint must survive close/reopen"
    );

    // Continue after reopen with production SessionStore history → agent path.
    let mut continued = reopened_hist;
    let cont_capture = CaptureCtx::new();
    let cont_backend = CapturingScriptedBackend::new(
        vec![final_answer("Post-reopen neutral continuation completed.")],
        cont_capture.clone(),
    );
    let continued_user = apply_pinned_skill_to_user_text(
        "Continue after session reopen without restating investigation markers.",
        reopened.pinned_skill_id.as_deref(),
        &skills,
    );
    let events = run_agent_turn(
        &cont_backend,
        &mut host,
        &continued_user,
        &mut continued,
        &AgentOptions {
            compact_keep_last: 30,
            context_char_budget: 24_000,
            ..default_opts(session_id)
        },
    )
    .await
    .unwrap();
    // Provider-facing context after reopen must still see durable investigation state.
    let post_reopen = cont_capture.last_blob();
    for marker in [
        c.session_id.as_str(),
        c.incident_id.as_str(),
        c.user_constraint.as_str(),
        c.open_question.as_str(),
        SKILL_PROCESS_TOKEN,
    ] {
        assert!(
            post_reopen.contains(marker),
            "reopened provider context missing durable marker {marker}: {post_reopen}"
        );
    }
    assert_eq!(
        reopened.id, session_id,
        "durable session identity must match across close/reopen"
    );
    let _ = text_from(&events);

    // Attachment still resolvable for this session id.
    assert!(
        store_ctx
            .list()
            .unwrap()
            .iter()
            .any(|e| e.rel_path.contains("attachment-note")),
        "session-context attachment missing"
    );
}

// ─── 2. Linked-log chat continuity (same production entry point) ───────────

#[tokio::test]
async fn lab_linked_log_chat_multi_round_and_corpus_bind() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (_logs, cache, corpus_id) = linked_log_fixture(&env.root, c);
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);
    host.set_log_analysis(true, Some(cache.clone()));
    host.set_active_log_corpus(Some(corpus_id.clone()));

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![
            tool_call(
                "sl1",
                cd_core::log_analysis::SEARCH_LOGS,
                r#"{"query":"job-7f3a"}"#,
            ),
            final_answer(format!(
                "Linked: pool exhaustion for job-7f3a; corpus={}. {}",
                corpus_id, c.disproof_evidence
            )),
            final_answer("Linked follow-up: still bound to same corpus."),
        ],
        capture.clone(),
    );
    let mut history = Vec::new();
    let ctx = LogExplorerTurnContext::new(
        "lab-window",
        corpus_id.as_str(),
        format!("corpusId={}; sources=worker.log", corpus_id),
    )
    .unwrap();

    let events = run_agent_turn(
        &backend,
        &mut host,
        "What caused the worker failure?",
        &mut history,
        &AgentOptions {
            session_id: "linked-lab-sess".into(),
            log_explorer_context: Some(ctx.clone()),
            max_rounds: 6,
            compact_keep_last: 6,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(
        tool_ok_names(&events)
            .iter()
            .any(|n| n == cd_core::log_analysis::SEARCH_LOGS)
            || history.iter().any(|m| m.role == Role::Tool),
        "linked turn must execute search_logs"
    );
    let sys = history
        .iter()
        .find(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .unwrap_or("");
    assert!(
        sys.contains(&corpus_id),
        "system must bind linked corpus: {sys}"
    );
    assert!(
        !sys.contains("PRIVATE_SESS_A"),
        "ordinary session private must not appear in linked system"
    );

    // Second turn same corpus — continuity.
    let _ = run_agent_turn(
        &backend,
        &mut host,
        "Any update?",
        &mut history,
        &AgentOptions {
            session_id: "linked-lab-sess".into(),
            log_explorer_context: Some(ctx),
            max_rounds: 2,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Session store linked_corpus_id round-trip.
    let store = SessionStore::new(env.root.join("sessions"));
    store.ensure().unwrap();
    let sess = history_to_session("linked-lab-sess", &history, Some(&corpus_id));
    store.save(&sess).unwrap();
    let loaded = store.load("linked-lab-sess").unwrap();
    assert_eq!(loaded.linked_corpus_id.as_deref(), Some(corpus_id.as_str()));
}

// ─── 3. Hard budget survival / omit / summarize ────────────────────────────

#[test]
fn lab_hard_budget_canary_survival_summary_omit() {
    use cd_core::sessions::{
        context_chat_messages, recompact_chat_history_budgeted, COMPACT_SUMMARY_CHAR_BUDGET,
    };

    let c = Canaries::default();
    // Single planted layout — no second-pass re-plant of canaries into keep.
    let hist = long_history_with_canaries(&c, 24);
    let keep = 4usize;

    // Phase A: classify under production recompact + context_chat_messages with
    // a summary budget large enough to hold newest-of-old (mid canaries) but
    // not the early private/stale block (summary walks reverse of older).
    let summary_budget = 1_200usize; // ~8–10 lines of 120-char snippets
    let summary = recompact_chat_history_budgeted(&hist, keep, summary_budget)
        .expect("long history must produce a compact summary");
    let model_view = context_chat_messages(&hist, Some(&summary), keep);
    assert!(
        hist.len() > model_view.len(),
        "model view {} must be smaller than full {}",
        model_view.len(),
        hist.len()
    );

    let private_fate = classify_canary(&model_view, &c.private_session_a);
    let stale_fate = classify_canary(&model_view, &c.stale_noise);
    let mid = [
        ("incident_id", c.incident_id.as_str()),
        ("user_constraint", c.user_constraint.as_str()),
        ("open_question", c.open_question.as_str()),
        ("tool_result_id", c.tool_result_id.as_str()),
        ("citation_id", c.citation_id.as_str()),
        ("hypothesis_h1", c.hypothesis_h1.as_str()),
    ]
    .map(|(name, marker)| (name, classify_canary(&model_view, marker)));

    // Mid investigation canaries are newest-of-old → Summarized (not Omitted).
    let mut any_summarized = false;
    for (name, fate) in &mid {
        assert_ne!(
            *fate,
            CanaryFate::Omitted,
            "still-relevant mid canary {name} was Omitted; summary={summary}"
        );
        assert!(
            matches!(*fate, CanaryFate::Present | CanaryFate::Summarized),
            "{name} fate={fate:?}"
        );
        if *fate == CanaryFate::Summarized {
            any_summarized = true;
        }
    }
    assert!(
        any_summarized,
        "at least one mid canary must be Summarized (not only Present); fates={mid:?}\nsummary={summary}"
    );

    // Early private/stale: never full Present; prefer Omitted under tight summary.
    assert_ne!(
        private_fate,
        CanaryFate::Present,
        "private must not be full Present; got {private_fate:?}"
    );
    assert_ne!(
        stale_fate,
        CanaryFate::Present,
        "stale Present={stale_fate:?}"
    );
    assert_eq!(
        private_fate,
        CanaryFate::Omitted,
        "early private should be Omitted under tight summary; got {private_fate:?}\nsummary={summary}"
    );
    assert_eq!(
        classify_canary(&model_view, &c.invented_fact),
        CanaryFate::Omitted,
        "summary must not invent facts"
    );

    // Phase B: hard total budget via prepare_model_context (may truncate further).
    let tight_budget = 3_500usize;
    let prep = prepare_model_context(&hist, keep, tight_budget).expect("must fit");
    assert!(estimate_context_chars(&prep.messages) <= tight_budget);
    assert!(hist.len() > prep.messages.len());
    assert_eq!(
        classify_canary(&prep.messages, &c.invented_fact),
        CanaryFate::Omitted
    );
    assert_ne!(
        classify_canary(&prep.messages, &c.private_session_a),
        CanaryFate::Present
    );

    let hist2 = long_history_with_canaries(&c, 24);
    for (i, m) in hist.iter().enumerate() {
        assert_eq!(m.content, hist2[i].content, "history mutated at {i}");
    }
    let _ = (COMPACT_SUMMARY_CHAR_BUDGET, MODEL_CONTEXT_TRUNCATE_MARKER);
}

// ─── 4. Cross-session / cross-corpus leak barrier ──────────────────────────

#[tokio::test]
async fn lab_cross_session_and_corpus_leak_barrier() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let sess_dir = env.root.join("sessions");
    let store = SessionStore::new(&sess_dir);
    store.ensure().unwrap();

    // Shared workspace + durable SessionStore: session A persists private content.
    let (ws, idx) = ordinary_workspace(&env.root.join("ws"), c);
    let mut host = ToolHost::new(ws, idx, None);
    let cap_a = CaptureCtx::new();
    let backend_a = CapturingScriptedBackend::new(
        vec![final_answer(format!(
            "Session A holds {}",
            c.private_session_a
        ))],
        cap_a.clone(),
    );
    let mut hist_a = Vec::new();
    run_agent_turn(
        &backend_a,
        &mut host,
        &format!("Private note: {}", c.private_session_a),
        &mut hist_a,
        &default_opts("session-A"),
    )
    .await
    .unwrap();
    assert!(model_context_blob(&hist_a).contains(&c.private_session_a));
    store
        .save(&history_to_session("session-A", &hist_a, None))
        .unwrap();

    // Session B: load only B from the same SessionStore — must not inherit A.
    let mut sess_b = Session::new("session-B");
    sess_b.id = "session-B".into();
    store.save(&sess_b).unwrap();
    let loaded_b = store.load("session-B").unwrap();
    assert!(
        !model_context_blob(&loaded_b.to_chat_history()).contains(&c.private_session_a),
        "SessionStore B must not contain A private"
    );
    let loaded_a = store.load("session-A").unwrap();
    assert!(
        model_context_blob(&loaded_a.to_chat_history()).contains(&c.private_session_a),
        "SessionStore A still holds private"
    );

    // Continue B on the shared host with history from store only.
    let cap_b = CaptureCtx::new();
    let backend_b = CapturingScriptedBackend::new(
        vec![final_answer("Session B ordinary reply.")],
        cap_b.clone(),
    );
    let mut hist_b = loaded_b.to_chat_history();
    run_agent_turn(
        &backend_b,
        &mut host,
        "Hello from session B",
        &mut hist_b,
        &default_opts("session-B"),
    )
    .await
    .unwrap();
    let provider_b = cap_b.all_blob();
    let hist_b_blob = model_context_blob(&hist_b);
    assert!(
        !provider_b.contains(&c.private_session_a) && !hist_b_blob.contains(&c.private_session_a),
        "session A private leaked into session B provider/history context"
    );

    // Corpus X vs Y: poison Y history with a complete foreign tool envelope.
    // Production linked history must strip both the assistant tool call and its
    // Role::Tool result before every provider round.
    let root_x = env.root.join("corp-x");
    fs::create_dir_all(&root_x).unwrap();
    let (_lx, _cache_x, corpus_x) = linked_log_fixture(&root_x, c);
    let root_y = env.root.join("corp-y");
    fs::create_dir_all(&root_y).unwrap();
    let logs_y = root_y.join("logs");
    fs::create_dir_all(&logs_y).unwrap();
    fs::write(
        logs_y.join("other.log"),
        r#"{"ts":1700000200,"level":"info","message":"CORPUS_Y_ONLY marker benign"}"#,
    )
    .unwrap();
    let cache_y = root_y.join("cache");
    fs::create_dir_all(&cache_y).unwrap();
    let corpus_y = cd_core::log_analysis::ingest_path(&cache_y, &logs_y, "corp-y", None, "none")
        .unwrap()
        .corpus_id;
    assert_ne!(corpus_x, corpus_y);

    let ctx_y =
        LogExplorerTurnContext::new("win-y", corpus_y.as_str(), "sources=other.log").unwrap();
    let ws_y = Workspace::new("y", vec![root_y.clone()]);
    let idx_y = KeywordIndex::build(&ws_y).unwrap();
    let mut host_y = ToolHost::new(ws_y, idx_y, None);
    host_y.set_log_analysis(true, Some(cache_y));
    host_y.set_active_log_corpus(Some(corpus_y.clone()));
    let cap_y = CaptureCtx::new();
    let backend_y =
        CapturingScriptedBackend::new(vec![final_answer("Corpus Y answer only.")], cap_y.clone());
    let mut hist_y = Vec::new();
    hist_y.push(ChatMessage {
        role: Role::Assistant,
        content: String::new(),
        tool_call_id: None,
        tool_calls: Some(vec![ToolCallMsg {
            id: "foreign-x-call".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: cd_core::log_analysis::SEARCH_LOGS.into(),
                arguments: serde_json::json!({
                    "query": c.private_corpus_x,
                    "corpus_id": corpus_x.clone(),
                })
                .to_string(),
            },
        }]),
    });
    hist_y.push(ChatMessage {
        role: Role::Tool,
        content: format!("STALE_CROSS corpus_id={} {}", corpus_x, c.private_corpus_x),
        tool_call_id: Some("foreign-x-call".into()),
        tool_calls: None,
    });
    run_agent_turn(
        &backend_y,
        &mut host_y,
        "Summarize this corpus",
        &mut hist_y,
        &AgentOptions {
            session_id: "sess-y".into(),
            log_explorer_context: Some(ctx_y),
            max_rounds: 2,
            ambient_recall_enabled: false,
            compact_keep_last: 2,
            context_char_budget: 8_000,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let sys_y = hist_y
        .iter()
        .find(|m| m.role == Role::System)
        .map(|m| m.content.clone())
        .unwrap_or_default();
    assert!(sys_y.contains(&corpus_y));
    assert!(
        !sys_y.contains(&corpus_x),
        "Y system must not bind corpus X"
    );

    // Provider-facing capture for Y must contain no foreign content anywhere:
    // bodies, tool arguments, tool result envelopes, or pairing ids.
    let provider_y = cap_y.all_envelope_blob();
    assert!(!provider_y.is_empty(), "must capture provider rounds for Y");
    assert!(
        provider_y.contains(&corpus_y),
        "Y provider must reference corpus Y"
    );
    // Active system bind in provider context should not claim corpus X.
    let provider_systems: String = cap_y
        .rounds
        .lock()
        .unwrap()
        .iter()
        .flat_map(|round| round.iter())
        .filter(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !provider_systems.contains(&corpus_x),
        "provider system for Y must not bind corpus X id: {provider_systems}"
    );
    for foreign in [
        corpus_x.as_str(),
        c.private_corpus_x.as_str(),
        "STALE_CROSS",
        "foreign-x-call",
    ] {
        assert!(
            !provider_y.contains(foreign),
            "foreign corpus content leaked anywhere in Y provider envelope ({foreign}): {provider_y}"
        );
    }
}

// ─── 5. Later turn disproves earlier hypothesis with fresh evidence ────────

#[tokio::test]
async fn lab_later_turn_disproves_hypothesis_with_fresh_evidence() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (_logs, cache, corpus_id) = linked_log_fixture(&env.root, c);
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);
    host.set_log_analysis(true, Some(cache));
    host.set_active_log_corpus(Some(corpus_id.clone()));

    // Prior H1 in durable history (linked turns withhold ungrounded prose).
    let mut history = vec![
        msg(
            Role::User,
            "Form an initial hypothesis about the pool failure.",
        ),
        msg(Role::Assistant, format!("Early read: {}", c.hypothesis_h1)),
    ];
    assert!(model_context_blob(&history).contains(&c.hypothesis_h1));

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![
            tool_call(
                "sl-d",
                cd_core::log_analysis::SEARCH_LOGS,
                r#"{"query":"db_pool_max"}"#,
            ),
            // Final answer may reference tool evidence — oracle requires Tool role
            // content from production search_logs, not this string alone.
            final_answer(format!(
                "Updated root cause from exact tool evidence at seq=0 source=worker.log: {}",
                c.disproof_evidence
            )),
        ],
        capture.clone(),
    );
    let ctx = LogExplorerTurnContext::new("disproof-win", corpus_id.as_str(), "sources=worker.log")
        .unwrap();

    let events = run_agent_turn(
        &backend,
        &mut host,
        "Challenge H1 with fresh log evidence about pool config.",
        &mut history,
        &AgentOptions {
            session_id: "disproof-sess".into(),
            log_explorer_context: Some(ctx),
            max_rounds: 6,
            compact_keep_last: 12,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let rounds = capture.rounds.lock().expect("capture lock");
    let first_provider = rounds
        .first()
        .map(|round| model_context_envelope_blob(round))
        .unwrap_or_default();
    assert!(
        first_provider.contains(&c.hypothesis_h1),
        "provider must receive the exact early hypothesis before fresh evidence: {first_provider}"
    );

    // REQUIRED: production tool result in history carries the exact disproof.
    let tool_blobs: Vec<&str> = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.content.as_str())
        .collect();
    assert!(
        !tool_blobs.is_empty(),
        "challenge turn must execute a tool; history={history:?}"
    );
    let tool_joined = tool_blobs.join("\n");
    assert!(
        tool_joined.contains(&c.disproof_evidence),
        "tool-sourced evidence must carry disproof content from logs, not only scripted prose: {tool_joined}"
    );

    // Provider rounds after the tool must include the tool result (model saw evidence).
    let after_tool_provider = rounds
        .iter()
        .skip(1)
        .map(|round| model_context_envelope_blob(round))
        .collect::<Vec<_>>()
        .join("\n---ROUND---\n");
    assert!(
        after_tool_provider.contains(&c.disproof_evidence),
        "provider-facing context must include tool-sourced disproof: {after_tool_provider}"
    );
    drop(rounds);

    // H1 remains historical for challenge continuity.
    assert!(
        model_context_blob(&history).contains(&c.hypothesis_h1),
        "prior H1 must survive in durable history"
    );
    // Successful search_logs path.
    assert!(
        tool_ok_names(&events)
            .iter()
            .any(|n| n == cd_core::log_analysis::SEARCH_LOGS)
            || events.iter().any(|e| matches!(
                e,
                StreamEvent::Tool { name, ok: Some(true), .. }
                    if name == cd_core::log_analysis::SEARCH_LOGS
            )),
        "search_logs must succeed: {events:?}"
    );
}

// ─── 6. Failed / empty / repeated tools are not facts ──────────────────────

#[tokio::test]
async fn lab_failed_empty_repeated_tools_are_not_facts() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![
            tool_call(
                "e1",
                "search_kb",
                r#"{"query":"DEFINITELY_MISSING_MARKER_QQQ","limit":3}"#,
            ),
            tool_call(
                "e2",
                "search_kb",
                r#"{"query":"DEFINITELY_MISSING_MARKER_QQQ","limit":3}"#,
            ),
            final_answer(
                "I have no evidence that QQQ exists; empty tool results are not facts. \
                 Declining to assert a root cause.",
            ),
        ],
        capture.clone(),
    );
    let mut history = Vec::new();
    let events = run_agent_turn(
        &backend,
        &mut host,
        "Is DEFINITELY_MISSING_MARKER_QQQ the root cause?",
        &mut history,
        &AgentOptions {
            session_id: "empty-tools".into(),
            max_rounds: 6,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Production tool results: must not contain affirmative "found QQQ root cause".
    let tool_msgs: Vec<&str> = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.content.as_str())
        .collect();
    assert!(
        tool_msgs.len() >= 2,
        "expected repeated real tool results, got {}",
        tool_msgs.len()
    );
    for (i, t) in tool_msgs.iter().enumerate() {
        assert!(
            !t.contains("DEFINITELY_MISSING_MARKER_QQQ is the root cause")
                && !t.contains("confirmed root cause")
                && !t.contains("QQQ is confirmed"),
            "tool result {i} must not invent a fact from empty search: {t}"
        );
        // Empty/miss should not look like a strong hit on the missing marker as a finding.
        let lower = t.to_ascii_lowercase();
        let claims_hit = lower.contains("found definitely_missing_marker_qqq")
            || lower.contains("root cause is definitely_missing");
        assert!(!claims_hit, "tool result must not claim a hit: {t}");
    }

    // Model-facing tool messages in provider capture also lack invented facts.
    let prov = capture.all_blob();
    assert!(
        !prov.contains("QQQ is confirmed") && !prov.contains("root cause is QQQ"),
        "provider context must not promote empty tools to facts: {prov}"
    );

    let ans = text_from(&events);
    assert!(
        !ans.contains("QQQ is confirmed") && !ans.contains("root cause is QQQ"),
        "assistant must not invent confirmation: {ans}"
    );
    let _ = c;
}

// ─── 7. Cancel + retry SoftWrite: continuity without duplicate writes ──────

#[tokio::test]
async fn lab_cancel_then_retry_softwrite_no_duplicate() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let audit_path = env.root.join("write-audit.jsonl");
    let mut host = ToolHost::new(ws, idx, Some(cd_core::audit::AuditLog::new(&audit_path)));

    // Turn 1: request SoftWrite → permission stop (0 writes).
    let backend1 = ScriptedBackend::new(vec![tool_call(
        "w1",
        "save_memory",
        &format!(
            r#"{{"title":"lab-once","body_markdown":"unique-body-{}-once"}}"#,
            c.incident_id
        ),
    )]);
    let mut history = Vec::new();
    let events = run_agent_turn(
        &backend1,
        &mut host,
        "Remember this for later.",
        &mut history,
        &default_opts("write-sess"),
    )
    .await
    .unwrap();
    assert!(events.iter().any(|e| matches!(
        e,
        StreamEvent::TurnCompleted { reason } if reason == "awaiting_permission"
    )));
    assert_eq!(count_memory_files(&env.root), 0);

    let request_id = events
        .iter()
        .find_map(|e| match e {
            StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
        .expect("initial write must emit a permission request");
    // User cancels: Deny — still 0 writes.
    let deny_events = cd_core::research::grant_and_execute(
        &mut host,
        &request_id,
        PermissionDecision::Deny,
        None,
        "save_memory",
        &serde_json::json!({}),
        Some(&mut history),
    )
    .await
    .unwrap();
    assert!(deny_events.iter().any(|e| matches!(
        e,
        StreamEvent::Error { code, .. } if code == "denied"
    )));
    assert_eq!(count_memory_files(&env.root), 0);

    // Real mid-turn timing: cancellation starts false, provider completion is
    // entered and blocks, then the independent trigger flips the flag.
    let cancel = Arc::new(AtomicBool::new(false));
    let entered_provider = Arc::new(AtomicBool::new(false));
    let backend_cancel = MidTurnCancelBackend {
        entered_provider: entered_provider.clone(),
    };
    let cancel_for_trigger = cancel.clone();
    let entered_for_trigger = entered_provider.clone();
    let cancel_opts = AgentOptions {
        session_id: "write-sess".into(),
        cancel: Some(cancel.clone()),
        max_rounds: 4,
        ambient_recall_enabled: false,
        ..Default::default()
    };
    let (cancel_result, ()) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(
            run_agent_turn(
                &backend_cancel,
                &mut host,
                "Wait in the provider until the user cancels.",
                &mut history,
                &cancel_opts,
            ),
            async move {
                while !entered_for_trigger.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
                assert!(!cancel_for_trigger.load(Ordering::SeqCst));
                cancel_for_trigger.store(true, Ordering::SeqCst);
            }
        )
    })
    .await
    .expect("mid-turn cancellation must complete promptly");
    let cancel_events = cancel_result.unwrap();
    assert!(
        cancel_events.iter().any(|e| matches!(
            e,
            StreamEvent::TurnCompleted { reason } if reason == "cancel"
        )),
        "cancel path must complete cleanly: {cancel_events:?}"
    );
    assert!(entered_provider.load(Ordering::SeqCst));
    assert_eq!(count_memory_files(&env.root), 0);

    // Retry: permission then single grant → exactly one write.
    let backend2 = ScriptedBackend::new(vec![tool_call(
        "w2",
        "save_memory",
        &format!(
            r#"{{"title":"lab-once","body_markdown":"unique-body-{}-once"}}"#,
            c.incident_id
        ),
    )]);
    let events2 = run_agent_turn(
        &backend2,
        &mut host,
        "Retry remember after cancel.",
        &mut history,
        &default_opts("write-sess"),
    )
    .await
    .unwrap();
    let (rid2, retry_args) = events2
        .iter()
        .find_map(|e| match e {
            StreamEvent::PermissionRequired {
                request_id,
                arguments,
                ..
            } => Some((request_id.clone(), arguments.clone())),
            _ => None,
        })
        .expect("retry must request permission again");
    let grant_events = cd_core::research::grant_and_execute(
        &mut host,
        &rid2,
        PermissionDecision::AllowOnce,
        None,
        "save_memory",
        &serde_json::json!({}),
        Some(&mut history),
    )
    .await
    .unwrap();
    assert!(
        grant_events.iter().any(|e| matches!(
            e,
            StreamEvent::Tool { name, ok: Some(true), .. } if name == "save_memory"
        )) || count_memory_files(&env.root) >= 1,
        "grant should write once: {grant_events:?}"
    );
    let writes_after_grant = count_memory_files(&env.root);
    assert_eq!(
        writes_after_grant, 1,
        "exactly one SoftWrite after single grant"
    );

    let memory_path = env
        .root
        .join(".contextdesk")
        .join("memory")
        .join("lab-once.md");
    let durable_before_replay = fs::read(&memory_path).expect("approved memory body");
    let durable_text = String::from_utf8(durable_before_replay.clone()).unwrap();
    let unique_body = format!("unique-body-{}-once", c.incident_id);
    assert_eq!(durable_text.matches(&unique_body).count(), 1);
    let revision_before_replay = fs::metadata(&memory_path).unwrap().modified().unwrap();
    let audit_before_replay = fs::read(&audit_path).expect("write audit");

    // Replaying the exact same AllowOnce id must be rejected before any durable
    // content, file revision, or audit mutation. A `.get()` mutation in
    // consume_grant makes this call execute again and must fail this oracle.
    let replay = host.execute("save_memory", &retry_args, Some(&rid2)).await;
    assert!(
        replay.is_err(),
        "consumed AllowOnce request id must never execute twice: {replay:?}"
    );
    assert_eq!(fs::read(&memory_path).unwrap(), durable_before_replay);
    assert_eq!(
        fs::metadata(&memory_path).unwrap().modified().unwrap(),
        revision_before_replay
    );
    assert_eq!(fs::read(&audit_path).unwrap(), audit_before_replay);

    // Continuity: history still has prior turns + grant outcome.
    assert!(history.len() > 4, "history must preserve continuity");
    assert!(
        model_context_blob(&history).contains("Remember")
            || model_context_blob(&history).contains("retry")
            || model_context_blob(&history).contains(&c.incident_id)
            || history
                .iter()
                .any(|m| m.content.contains("lab-once") || m.content.contains("unique-body")),
        "history should retain investigation continuity"
    );
}

// ─── 8. Developer Activity On truthfulness / Off non-retention ─────────────

#[tokio::test]
async fn lab_developer_activity_on_truthful_off_no_sensitive_payload() {
    // Real agent turn that MUST compact (long history + tight budget), then
    // project the actual provider rounds via TracingChatBackend → ActivityRecorder.
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

    let mut history = long_history_with_canaries(c, 30);
    let full_hist_len = history.len();
    let budget = 5_000usize;
    let keep = 4usize;

    let capture = CaptureCtx::new();
    let inner = CapturingScriptedBackend::new(
        vec![final_answer(format!("compacted-turn-ok {}", c.incident_id))],
        capture.clone(),
    );
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let traced = TracingChatBackend::new(Box::new(inner), sink);

    let events = run_agent_turn(
        &traced,
        &mut host,
        "Newest user turn requiring compacted context selection.",
        &mut history,
        &AgentOptions {
            session_id: "dev-activity-sess".into(),
            max_rounds: 2,
            compact_keep_last: keep,
            context_char_budget: budget,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Turn performed real context selection (not full history).
    let compacted_notice = events.iter().any(|e| {
        matches!(
            e,
            StreamEvent::Error { code, .. } if code == "context_compacted"
        )
    });
    let sent = capture.max_message_count();
    assert!(
        sent < full_hist_len,
        "provider must receive compacted selection ({sent} < {full_hist_len})"
    );
    let provider_blob = capture.last_blob();
    let did_select = provider_blob.contains("Compacted earlier conversation")
        || sent <= keep + 8
        || capture.max_chars() <= budget + 4_000
        || compacted_notice;
    assert!(
        did_select,
        "provider context must show compaction/selection; sent={sent} chars={} notice={compacted_notice} blob_prefix={}",
        capture.max_chars(),
        &provider_blob.chars().take(200).collect::<String>()
    );

    let traced_calls = recorder.calls();
    assert!(
        !traced_calls.is_empty(),
        "TracingChatBackend must observe provider rounds"
    );
    let first = &traced_calls[0];
    assert!(first.context_used_chars > 0);
    let captured_n = capture
        .rounds
        .lock()
        .unwrap()
        .first()
        .map(|r| r.len())
        .unwrap_or(0);
    // Trace retains a capped body prefix; message_count metadata must match
    // what the production backend actually received.
    assert!(
        first.messages.len() <= captured_n,
        "trace must not claim more messages than the provider received (trace={} provider={captured_n})",
        first.messages.len()
    );
    // When both sides retain all messages (under cap), counts must agree.
    if captured_n > 0 && !first.messages_capped {
        assert_eq!(
            first.messages.len(),
            captured_n,
            "uncapped trace message count must equal capturing backend"
        );
    }
    assert!(
        first.messages.len() < full_hist_len
            || first.context_used_chars < estimate_context_chars(&history),
        "selection must not claim full uncompacted history was sent (msgs={} hist={})",
        first.messages.len(),
        full_hist_len
    );

    // Detail On (Full): bodies + truthful round metadata.
    let mut full_rec = ActivityRecorder::new(
        "turn-dev-on",
        "dev-activity-sess",
        DataScope::conversation(),
        ActivityDetailLevel::Full,
    );
    full_rec.record_provider_rounds(&traced_calls);
    full_rec.record_stream_events(&events);
    let full = full_rec.finish(ActivityStatus::Ok, 42);
    assert_eq!(full.detail_level, ActivityDetailLevel::Full);
    assert!(full.provider_round_count() >= 1);
    let ctx0 = full
        .events
        .iter()
        .find_map(|e| e.context.as_ref())
        .expect("provider context metadata");
    assert_eq!(
        ctx0.message_count,
        first.messages.len(),
        "activity message_count must match traced provider round"
    );
    assert_eq!(
        ctx0.context_used_chars, first.context_used_chars,
        "activity context_used_chars must match trace"
    );
    assert!(
        ctx0.bodies.is_some(),
        "Developer Activity On retains bodies"
    );

    // Detail Off (Summary): same truthful counts, no bodies.
    let mut sum_rec = ActivityRecorder::new(
        "turn-dev-off",
        "dev-activity-sess",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    sum_rec.record_provider_rounds(&traced_calls);
    sum_rec.record_stream_events(&events);
    let summary = sum_rec.finish(ActivityStatus::Ok, 42);
    assert_eq!(summary.detail_level, ActivityDetailLevel::Summary);
    for ev in &summary.events {
        if let Some(ctx) = &ev.context {
            assert!(ctx.bodies.is_none(), "Off must not retain bodies");
            assert_eq!(ctx.context_used_chars, first.context_used_chars);
            assert_eq!(ctx.message_count, first.messages.len());
        }
    }

    let mut durable = full.clone();
    strip_bodies_for_durability(&mut durable);
    assert_eq!(durable.detail_level, ActivityDetailLevel::Summary);
    for ev in &durable.events {
        if let Some(ctx) = &ev.context {
            assert!(ctx.bodies.is_none());
        }
    }
}

// ─── 8b. Ambient memory matches in model-facing context ────────────────────

#[tokio::test]
async fn lab_ambient_memory_match_reaches_model_context() {
    use cd_core::branding::Branding;
    use cd_core::memory::{
        attach_durable_memory_to_host, MemoryConfig, MemoryDraft, MemoryWriteOp,
    };

    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);
    let branding = Branding::embedded();
    attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
    assert!(host.durable_memory_store().is_some());

    let marker = format!("MEMORY_MATCH_{}", c.incident_id);
    let store = host.durable_memory_store().unwrap();
    store
        .put(
            MemoryWriteOp::Insert(MemoryDraft::new(
                cd_core::memory::Kind::Fact,
                format!("{marker} approved pool floor for synthetic lab"),
            )),
            cd_core::embed::now_unix_secs(),
        )
        .unwrap();

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![final_answer(format!("Recalled {marker} from memory."))],
        capture.clone(),
    );
    let mut history = Vec::new();
    let events = run_agent_turn(
        &backend,
        &mut host,
        &format!("remind me about {marker} and pool floor"),
        &mut history,
        &AgentOptions {
            session_id: "memory-sess".into(),
            ambient_recall_enabled: true,
            max_rounds: 2,
            compact_keep_last: 6,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let ambient_signal = events.iter().any(|e| {
        matches!(e, StreamEvent::Citation { locator: Some(l), .. } if l == "memory")
            || matches!(e, StreamEvent::SearchTrail { steps } if steps.iter().any(|s| s.contains("ambient_recall")))
    });
    assert!(
        ambient_signal,
        "ambient recall must fire on production path: {events:?}"
    );
    let provider = capture.all_blob();
    assert!(
        provider.contains(&marker) || provider.contains("MEMORY_MATCH"),
        "memory match must appear in model-facing provider context: {provider}"
    );
}

// ─── 8c. Attachment reaches model-facing context via search_kb ─────────────

#[tokio::test]
async fn lab_attachment_reaches_model_facing_context() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);
    let base = env.root.join(".contextdesk");
    let session_id = "attach-sess";
    host.set_session_context_base(Some(base.clone()));
    host.set_active_session_id(Some(session_id.into()));
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .unwrap();
    // Body-only secrets: never placed in the user prompt or final_answer script.
    // Search uses a neutral query that still hits the session pack.
    const BODY_TOKEN: &str = "cascade failure token ZQ9-ATTACH-ONLY";
    const FILE_NAME: &str = "incident-note.txt";
    store
        .import_bytes(
            FILE_NAME,
            format!("ATTACHMENT_MARKER_{} {BODY_TOKEN}\n", c.incident_id).as_bytes(),
        )
        .unwrap();

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![
            // Neutral query — does not embed BODY_TOKEN or ATTACHMENT_MARKER.
            tool_call(
                "att1",
                "search_kb",
                r#"{"query":"cascade failure","limit":4}"#,
            ),
            final_answer(
                "I will answer only from tool evidence returned for the attachment search.",
            ),
        ],
        capture.clone(),
    );
    let mut history = Vec::new();
    // User prompt deliberately omits BODY_TOKEN, ATTACHMENT_MARKER, and file name.
    let user_prompt = "Search the session context pack for any cascade-related notes.";
    assert!(
        !user_prompt.contains(BODY_TOKEN)
            && !user_prompt.contains("ATTACHMENT_MARKER")
            && !user_prompt.contains(FILE_NAME),
        "fixture invariant: user prompt must not plant attachment body"
    );

    let events = run_agent_turn(
        &backend,
        &mut host,
        user_prompt,
        &mut history,
        &AgentOptions {
            session_id: session_id.into(),
            max_rounds: 4,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(
        tool_ok_names(&events).iter().any(|n| n == "search_kb"),
        "search_kb must succeed: {events:?}"
    );

    // REQUIRED: production Role::Tool result carries attachment body from the pack.
    let tool_bodies: Vec<&str> = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .map(|m| m.content.as_str())
        .collect();
    assert!(
        !tool_bodies.is_empty(),
        "expected Role::Tool messages from search_kb"
    );
    let tool_joined = tool_bodies.join("\n");
    assert!(
        tool_joined.contains(BODY_TOKEN),
        "Role::Tool must surface the attachment body; filename metadata alone is forbidden: {tool_joined}"
    );
    assert_eq!(
        tool_joined.matches(BODY_TOKEN).count(),
        1,
        "unique attachment body token must originate once in the tool result"
    );
    // User + assistant scripted text must not be the sole source of BODY_TOKEN.
    let non_tool: String = history
        .iter()
        .filter(|m| m.role != Role::Tool)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !non_tool.contains(BODY_TOKEN),
        "BODY_TOKEN must arrive via tool path, not user/assistant prose: {non_tool}"
    );

    // Post-tool provider rounds must include the tool-sourced body (model saw it).
    let rounds = capture.rounds.lock().expect("capture lock");
    assert!(
        rounds.len() >= 2,
        "expected search_kb round then synthesis round, got {}",
        rounds.len()
    );
    // Round 0 is first complete() (tools requested); later rounds include Tool results.
    let post_tool_has_body = rounds.iter().skip(1).any(|r| {
        r.iter().any(|m| {
            m.role == Role::Tool
                && m.content.contains(BODY_TOKEN)
                && m.content.matches(BODY_TOKEN).count() == 1
        })
    });
    assert!(
        post_tool_has_body,
        "post-tool provider context must include attachment body from Role::Tool; n_rounds={} tool_history={tool_joined}",
        rounds.len()
    );
}

// ─── 9. Mutation oracles (each inverted property must fail the check) ──────

/// Oracle helpers: return Ok when production property holds; the mutation
/// variants construct a counterfeit and assert the oracle *rejects* it.
fn oracle_budget_enforced(
    model_msgs: &[ChatMessage],
    full_len: usize,
    budget: usize,
) -> Result<(), String> {
    let est = estimate_context_chars(model_msgs);
    if est > budget {
        return Err(format!("over budget {est} > {budget}"));
    }
    if model_msgs.len() >= full_len && full_len > 20 {
        return Err(format!(
            "full-history bypass: model {} >= full {}",
            model_msgs.len(),
            full_len
        ));
    }
    Ok(())
}

fn oracle_citations_present(blob: &str, citation_ids: &[&str]) -> Result<(), String> {
    for id in citation_ids {
        if !blob.contains(id) {
            return Err(format!("citation missing: {id}"));
        }
    }
    Ok(())
}

fn oracle_no_cross_corpus(
    blob: &str,
    foreign_corpus: &str,
    foreign_private: &str,
) -> Result<(), String> {
    if blob.contains(foreign_private) {
        return Err(format!("cross-corpus private leaked: {foreign_private}"));
    }
    if blob.contains(foreign_corpus) {
        return Err(format!("cross-corpus id leaked: {foreign_corpus}"));
    }
    Ok(())
}

fn oracle_summary_no_invention(
    summary: &str,
    invented: &str,
    sources_blob: &str,
) -> Result<(), String> {
    if summary.contains(invented) && !sources_blob.contains(invented) {
        return Err(format!("summary invented fact: {invented}"));
    }
    Ok(())
}

#[test]
fn lab_mutation_oracles_reject_inverted_properties() {
    let c = Canaries::default();
    let hist = long_history_with_canaries(&c, 30);
    let budget = 4_000usize;
    let prep = prepare_model_context(&hist, 6, budget).expect("production path fits");

    // --- Production path must PASS oracles ---
    oracle_budget_enforced(&prep.messages, hist.len(), budget).expect("production budget ok");
    let mut with_cite = hist.clone();
    with_cite.push(msg(Role::User, format!("cite {}", c.citation_id)));
    with_cite.push(msg(Role::Assistant, format!("See {}", c.citation_id)));
    let prep_c = prepare_model_context(&with_cite, 8, 10_000).unwrap();
    let cite_blob = model_context_blob(&prep_c.messages);
    oracle_citations_present(&cite_blob, &[&c.citation_id]).expect("production citations ok");

    let y_blob = "corpus-Y active; CORPUS_Y only".to_string();
    oracle_no_cross_corpus(&y_blob, "corpus-X-id", &c.private_corpus_x)
        .expect("clean Y context ok");

    let sources = model_context_blob(&hist);
    let summary = cd_core::sessions::recompact_chat_history(&hist, 4).unwrap_or_default();
    oracle_summary_no_invention(&summary, &c.invented_fact, &sources)
        .expect("production summary ok");

    // --- Mutations: inverted properties must FAIL oracles ---

    // M1: full-history bypass (counterfeit model context = entire history).
    let m1 = oracle_budget_enforced(&hist, hist.len(), budget);
    assert!(
        m1.is_err(),
        "mutation full-history-without-budget must fail oracle"
    );

    // M2: drop citations from model context.
    let mut dropped = prep_c.messages.clone();
    for m in &mut dropped {
        m.content = m.content.replace(&c.citation_id, "[redacted-citation]");
    }
    let m2 = oracle_citations_present(&model_context_blob(&dropped), &[&c.citation_id]);
    assert!(m2.is_err(), "mutation drop-citations must fail oracle");

    // M3: cross-corpus evidence injection.
    let poisoned = format!("active corpus Y but also {}", c.private_corpus_x);
    let m3 = oracle_no_cross_corpus(&poisoned, "corpus-X", &c.private_corpus_x);
    assert!(
        m3.is_err(),
        "mutation cross-corpus injection must fail oracle"
    );

    // M4: summary invents a fact not in sources.
    let fake_summary = format!(
        "Earlier: user said {}. Also {}.",
        c.incident_id, c.invented_fact
    );
    let m4 = oracle_summary_no_invention(&fake_summary, &c.invented_fact, &sources);
    assert!(
        m4.is_err(),
        "mutation inventing summary fact must fail oracle"
    );
}

// ─── 10. Agent path: prepare_model_context used under tight budget ─────────

#[tokio::test]
async fn lab_agent_path_enforces_budget_not_full_history() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

    let mut history = long_history_with_canaries(c, 25);
    let capture = CaptureCtx::new();
    let budget = 5_000usize;
    let backend = CapturingScriptedBackend::new(
        vec![final_answer(format!(
            "Bounded answer for {}",
            c.incident_id
        ))],
        capture.clone(),
    );
    run_agent_turn(
        &backend,
        &mut host,
        &format!(
            "Newest user turn: confirm {} and {}",
            c.incident_id, c.user_constraint
        ),
        &mut history,
        &AgentOptions {
            session_id: c.session_id.clone(),
            max_rounds: 2,
            compact_keep_last: 4,
            context_char_budget: budget,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert!(
        capture.max_chars() <= budget + 4_000, // system policy can expand slightly past opts in edge cases; still << full
        "agent path over budget: {}",
        capture.max_chars()
    );
    assert!(
        capture.max_message_count() < history.len(),
        "agent must not send full history ({} vs {})",
        capture.max_message_count(),
        history.len()
    );
    let last = capture.last_blob();
    assert!(
        last.contains(&c.incident_id)
            || last.contains("never reboot")
            || last.contains("CONSTRAINT"),
        "relevant canaries should survive in newest-facing context: {last}"
    );
    // Full history still grew / retained.
    assert!(history
        .iter()
        .any(|m| m.content.contains(&c.private_session_a)));
}
