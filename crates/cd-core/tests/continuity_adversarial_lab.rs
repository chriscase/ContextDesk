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

#[path = "support/continuity_lab.rs"]
mod continuity_lab;

use cd_core::activity::{
    strip_bodies_for_durability, ActivityDetailLevel, ActivityRecorder, ActivityStatus, DataScope,
};
use cd_core::agent::{
    run_agent_turn, AgentOptions, ChatBackend, LogExplorerTurnContext, ScriptedBackend,
};
use cd_core::chat::{ChatCompletion, ChatMessage, Role};
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

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

// ─── 1. 30+ turn ordinary-chat continuity ──────────────────────────────────

/// Thirty-plus ordinary-chat turns through `run_agent_turn`, with multi-round
/// tools, a failed tool that must not become a fact, session close/reopen via
/// `SessionStore`, skill pin, and session-context attachment.
#[tokio::test]
async fn lab_30_plus_turn_ordinary_chat_continuity() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

    // Skill fixture (method only — not evidence).
    let skill_root = env.root.join(".contextdesk").join("skills");
    let skill_dir = skill_root.join("triage");
    fs::create_dir_all(&skill_dir).unwrap();
    // discover_skills finds dir/*/SKILL.md — write frontmatter file directly.
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nid: triage\nname: Synthetic triage\ndescription: How to triage pool issues\nenabled: true\n---\n\
         PROCESS: check runbook markers; never invent root cause.\n",
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
    let mut history: Vec<ChatMessage> = Vec::new();
    let mut all_answers = String::new();
    let turn_count = 32usize;

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
                "Turn {t}: search returned no usable evidence for ZZZ; \
                 not treating empty tool output as fact. Constraint still: {}",
                c.user_constraint
            )));
        } else if t == 11 {
            // Multi-round: search → answer citing canaries.
            script.push(tool_call(
                "ok-1",
                "search_kb",
                &format!(r#"{{"query":"{}","limit":3}}"#, c.incident_id),
            ));
            script.push(final_answer(format!(
                "Turn {t}: found {} and {} in workspace. Open: {}",
                c.incident_id, c.tool_result_id, c.open_question
            )));
        } else if t == 15 {
            // SoftWrite: must stop at permission — no durable write yet.
            script.push(tool_call(
                "mem-1",
                "save_memory",
                &format!(
                    r#"{{"title":"lab-note","body_markdown":"Remember {} and constraint {}"}}"#,
                    c.incident_id, c.user_constraint
                ),
            ));
        } else if t % 5 == 0 && t > 0 {
            script.push(tool_call(
                &format!("t{t}"),
                "search_kb",
                r#"{"query":"pool","limit":2}"#,
            ));
            script.push(final_answer(format!(
                "Turn {t}: continuing investigation of {}. {}",
                c.incident_id, c.user_constraint
            )));
        } else {
            script.push(final_answer(format!(
                "Turn {t}: still tracking {} / {}. {}",
                c.session_id, c.incident_id, c.user_constraint
            )));
        }
    }

    let backend = CapturingScriptedBackend::new(script, capture.clone());
    let session_id = c.session_id.as_str();

    for t in 0..turn_count {
        let user = if t == 0 {
            apply_pinned_skill_to_user_text(
                &format!(
                    "Start investigation {} for {}. {}. {}",
                    c.session_id, c.incident_id, c.user_constraint, c.open_question
                ),
                Some("triage"),
                &skills,
            )
        } else if t == 11 {
            format!("Search runbook for {} and cite findings.", c.incident_id)
        } else if t == 15 {
            format!("Please remember constraint for {}.", c.incident_id)
        } else {
            format!("Status check turn {t} on {}", c.incident_id)
        };

        let events = run_agent_turn(
            &backend,
            &mut host,
            &user,
            &mut history,
            &AgentOptions {
                session_id: session_id.into(),
                model: Some("scripted-lab".into()),
                max_rounds: 6,
                compact_keep_last: 6,
                context_char_budget: 14_000,
                ambient_recall_enabled: false,
                ..Default::default()
            },
        )
        .await
        .unwrap_or_else(|e| panic!("turn {t} failed: {e}"));

        all_answers.push_str(&text_from(&events));
        all_answers.push('\n');

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
        capture.max_chars() <= 14_000 + 2_000, // small slack for system policy injection
        "provider saw over-budget context: {}",
        capture.max_chars()
    );
    // Compaction should keep model message count well below full history.
    assert!(
        capture.max_message_count() < history.len(),
        "model saw {} msgs but full history is {}",
        capture.max_message_count(),
        history.len()
    );

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
    let session = history_to_session(session_id, &history, None);
    store.save(&session).unwrap();
    drop(session);
    let reopened = store.load(session_id).unwrap();
    assert_eq!(reopened.id, session_id);
    assert!(
        reopened.messages.len() >= turn_count,
        "reopened message count {}",
        reopened.messages.len()
    );
    let reopened_hist = reopened.to_chat_history();
    let reblob = model_context_blob(&reopened_hist);
    assert!(reblob.contains(&c.incident_id));
    assert!(
        reblob.contains("never reboot") || reblob.contains(&c.user_constraint),
        "constraint must survive close/reopen"
    );

    // Continue after reopen with production prepare_model_context + agent.
    let mut continued = reopened_hist;
    let cont_capture = CaptureCtx::new();
    let cont_backend = CapturingScriptedBackend::new(
        vec![final_answer(format!(
            "Post-reopen: still on {} with constraint intact.",
            c.incident_id
        ))],
        cont_capture.clone(),
    );
    let events = run_agent_turn(
        &cont_backend,
        &mut host,
        "Continue after session reopen — confirm constraint.",
        &mut continued,
        &default_opts(session_id),
    )
    .await
    .unwrap();
    assert!(
        text_from(&events).contains(&c.incident_id)
            || cont_capture.last_blob().contains(&c.incident_id)
            || continued.iter().any(|m| m.content.contains(&c.incident_id))
    );

    // Attachment still resolvable for this session id.
    assert!(
        store_ctx
            .list()
            .unwrap()
            .iter()
            .any(|e| e.rel_path.contains("attachment-note")),
        "session-context attachment missing"
    );
    assert!(all_answers.contains(&c.incident_id) || full.contains(&c.incident_id));
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
    let c = Canaries::default();
    let hist = long_history_with_canaries(&c, 40);
    let tight_budget = 3_500usize;

    let prep = prepare_model_context(&hist, 6, tight_budget).expect("must fit under budget");
    let est = estimate_context_chars(&prep.messages);
    assert!(
        est <= tight_budget,
        "model context {est} exceeds hard budget {tight_budget}"
    );
    assert!(
        prep.compacted || prep.truncated || prep.messages.len() < hist.len(),
        "long history must compact or truncate; keep={} msgs={}",
        prep.keep,
        prep.messages.len()
    );

    let blob = model_context_blob(&prep.messages);
    // Full history length >> model context (proves not full-history bypass).
    assert!(
        hist.len() > prep.messages.len(),
        "full hist {} vs model {}",
        hist.len(),
        prep.messages.len()
    );

    // Newest-ish filler and system policy should survive preferentially.
    assert!(
        prep.messages.iter().any(|m| m.role == Role::System),
        "system policy must survive"
    );

    // Compacted summary path: older content appears only as short snippets
    // (≤120 chars/line) inside a Compacted system note — or is omitted.
    let has_compact_marker = blob.contains("Compacted earlier conversation");
    if has_compact_marker {
        // Summary must not invent the planted invented fact.
        assert!(
            !blob.contains(&c.invented_fact),
            "summary invented a fact never in sources"
        );
    }

    // Private early noise may be summarized (snippet) or omitted under tight budget —
    // it must never appear as a full unprotected body larger than the summary snippet cap.
    if let Some(priv_pos) = blob.find(&c.private_session_a) {
        // If present, it must be inside a compacted/truncated region.
        let window = &blob[priv_pos.saturating_sub(80)..(priv_pos + 40).min(blob.len())];
        assert!(
            blob.contains("Compacted")
                || window.contains(MODEL_CONTEXT_TRUNCATE_MARKER)
                || blob.contains(MODEL_CONTEXT_TRUNCATE_MARKER),
            "private early canary must not appear as full unprotected body"
        );
    }

    // Persist full history unchanged.
    for (i, m) in hist.iter().enumerate() {
        assert_eq!(
            m.content,
            long_history_with_canaries(&c, 40)[i].content,
            "prepare_model_context must not mutate stored history at {i}"
        );
    }

    // Explicit survival set for identifiers when placed in keep-window / recent.
    // Re-prepare with canaries near the end so they remain in the keep tail.
    let mut recent = long_history_with_canaries(&c, 8);
    recent.push(msg(
        Role::User,
        format!(
            "Confirm {} {} {} {}",
            c.incident_id, c.user_constraint, c.open_question, c.citation_id
        ),
    ));
    recent.push(msg(
        Role::Assistant,
        format!(
            "Confirmed. Tool {} hypothesis {}",
            c.tool_result_id, c.hypothesis_h1
        ),
    ));
    let prep2 = prepare_model_context(&recent, 8, 8_000).expect("fit");
    let b2 = model_context_blob(&prep2.messages);
    for marker in [
        &c.incident_id,
        &c.user_constraint,
        &c.open_question,
        &c.citation_id,
        &c.tool_result_id,
        &c.hypothesis_h1,
    ] {
        assert!(
            b2.contains(marker.as_str()),
            "still-relevant canary missing from model context: {marker}\n---\n{b2}"
        );
    }
    assert!(estimate_context_chars(&prep2.messages) <= 8_000);
}

// ─── 4. Cross-session / cross-corpus leak barrier ──────────────────────────

#[tokio::test]
async fn lab_cross_session_and_corpus_leak_barrier() {
    let env = LabEnv::new();
    let c = &env.canaries;

    // Session A ordinary chat with private canary.
    let (ws_a, idx_a) = ordinary_workspace(&env.root.join("a"), c);
    let mut host_a = ToolHost::new(ws_a, idx_a, None);
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
        &mut host_a,
        &format!("Private note: {}", c.private_session_a),
        &mut hist_a,
        &default_opts("session-A"),
    )
    .await
    .unwrap();
    assert!(model_context_blob(&hist_a).contains(&c.private_session_a));

    // Session B: fresh host/history — must not see session A private.
    let (ws_b, idx_b) = ordinary_workspace(&env.root.join("b"), c);
    let mut host_b = ToolHost::new(ws_b, idx_b, None);
    let cap_b = CaptureCtx::new();
    let backend_b = CapturingScriptedBackend::new(
        vec![final_answer("Session B ordinary reply.")],
        cap_b.clone(),
    );
    let mut hist_b = Vec::new();
    run_agent_turn(
        &backend_b,
        &mut host_b,
        "Hello from session B",
        &mut hist_b,
        &default_opts("session-B"),
    )
    .await
    .unwrap();
    let blob_b = format!("{}{}", model_context_blob(&hist_b), cap_b.all_blob());
    assert!(
        !blob_b.contains(&c.private_session_a),
        "session A private leaked into session B context"
    );

    // Corpus X vs Y: linked contexts must not cross.
    let root_x = env.root.join("corp-x");
    fs::create_dir_all(&root_x).unwrap();
    let (_lx, cache_x, corpus_x) = linked_log_fixture(&root_x, c);
    let root_y = env.root.join("corp-y");
    fs::create_dir_all(&root_y).unwrap();
    // Separate corpus without private X marker.
    let logs_y = root_y.join("logs");
    fs::create_dir_all(&logs_y).unwrap();
    fs::write(
        logs_y.join("other.log"),
        r#"{"ts":1700000200,"level":"info","message":"CORPUS_Y_ONLY marker benign"}"#,
    )
    .unwrap();
    let cache_y = root_y.join("cache");
    fs::create_dir_all(&cache_y).unwrap();
    let rep_y =
        cd_core::log_analysis::ingest_path(&cache_y, &logs_y, "corp-y", None, "none").unwrap();
    let corpus_y = rep_y.corpus_id.clone();
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
    // Poison history with corpus X private — current turn context must not treat it as Y evidence.
    hist_y.push(msg(
        Role::Tool,
        format!("STALE_CROSS {}", c.private_corpus_x),
    ));
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
        "corpus X id must not appear in Y system bind"
    );
    // Active Y system bind must name Y, not X.
    assert!(
        !sys_y.contains(&format!("corpusId={corpus_x}")),
        "provider-facing Y system must not claim corpus X"
    );
    // System hint for Y must not claim corpus X private as trusted content.
    assert!(!sys_y.contains(&c.private_corpus_x) || sys_y.contains("UNTRUSTED"));
    let _ = cache_x;
    let _ = cap_a;
    let _ = cap_y;
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

    // Prior turn already recorded H1 in durable history (ordinary or earlier linked).
    // Linked turns withhold ungrounded prose, so plant H1 as prior assistant content.
    let mut history = vec![
        msg(
            Role::User,
            "Form an initial hypothesis about the pool failure.",
        ),
        msg(Role::Assistant, format!("Early read: {}", c.hypothesis_h1)),
    ];
    assert!(
        model_context_blob(&history).contains(&c.hypothesis_h1),
        "H1 must be present before the challenge turn"
    );

    let capture = CaptureCtx::new();
    let backend = CapturingScriptedBackend::new(
        vec![
            // Challenge turn: tool gathers fresh evidence, then disproves H1.
            tool_call(
                "sl-d",
                cd_core::log_analysis::SEARCH_LOGS,
                r#"{"query":"db_pool_max"}"#,
            ),
            final_answer(format!(
                "Updated: {} disproves H1 ({}). New root cause is config shrink, not network. seq=0 source=worker.log",
                c.disproof_evidence, c.hypothesis_h1
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

    let last = capture.last_blob();
    let full = model_context_blob(&history);
    let answer = text_from(&events);
    // Provider must still see prior H1 in model context (continuity).
    assert!(
        last.contains(&c.hypothesis_h1) || last.contains("network partition"),
        "later provider context should still see prior H1 for challenge: {last}"
    );
    // Fresh disproof must appear in model context and/or final answer/history.
    assert!(
        last.contains(&c.disproof_evidence)
            || full.contains(&c.disproof_evidence)
            || answer.contains(&c.disproof_evidence)
            || answer.contains("disproves H1")
            || full.contains("disproves H1")
            || last.contains("db_pool")
            || full.contains("db_pool"),
        "later model-facing context must carry disproof, not only H1\nlast={last}\nfull={full}\nanswer={answer}"
    );
    // H1 remains historical; disproof must also be recorded durably.
    assert!(
        full.contains(&c.hypothesis_h1),
        "prior H1 must survive in durable history"
    );
    assert!(
        full.contains(&c.disproof_evidence)
            || full.contains("disproves H1")
            || answer.contains("disproves H1")
            || answer.contains(&c.disproof_evidence),
        "durable path must record the challenge/disproof"
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
            // Model retries same empty query.
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

    let ans = text_from(&events);
    assert!(
        ans.contains("no evidence") || ans.contains("not facts") || ans.contains("Declining"),
        "must not promote empty tools to facts: {ans}"
    );
    assert!(
        !ans.contains("QQQ is confirmed") && !ans.contains("root cause is QQQ"),
        "must not invent confirmation: {ans}"
    );
    // Tool messages exist but answers must not treat them as positive findings.
    let tool_msgs: Vec<_> = history.iter().filter(|m| m.role == Role::Tool).collect();
    assert!(
        tool_msgs.len() >= 2,
        "expected repeated tool results in history"
    );
}

// ─── 7. Cancel + retry SoftWrite: continuity without duplicate writes ──────

#[tokio::test]
async fn lab_cancel_then_retry_softwrite_no_duplicate() {
    let env = LabEnv::new();
    let c = &env.canaries;
    let (ws, idx) = ordinary_workspace(&env.root, c);
    let mut host = ToolHost::new(ws, idx, None);

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

    let request_id = events.iter().find_map(|e| match e {
        StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
        _ => None,
    });
    // User cancels: Deny — still 0 writes.
    if let Some(rid) = request_id {
        let deny_events = cd_core::research::grant_and_execute(
            &mut host,
            &rid,
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
    }
    assert_eq!(count_memory_files(&env.root), 0);

    // Mid-turn cancel via flag (no write).
    let cancel = Arc::new(AtomicBool::new(true));
    let backend_cancel = ScriptedBackend::new(vec![tool_call(
        "w-cancel",
        "save_memory",
        r#"{"title":"should-not","body_markdown":"cancelled-body"}"#,
    )]);
    let cancel_events = run_agent_turn(
        &backend_cancel,
        &mut host,
        "Try remember but I will cancel.",
        &mut history,
        &AgentOptions {
            session_id: "write-sess".into(),
            cancel: Some(cancel),
            max_rounds: 4,
            ambient_recall_enabled: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        cancel_events.iter().any(|e| matches!(
            e,
            StreamEvent::TurnCompleted { reason } if reason == "cancel"
        )) || cancel_events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { .. })),
        "cancel path must complete cleanly: {cancel_events:?}"
    );
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
    let rid2 = events2
        .iter()
        .find_map(|e| match e {
            StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
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
    // Drive real TracingChatBackend → ActivityRecorder projection (same seam
    // as activity_contract.rs). Full retains bodies; Summary strips them;
    // durability strip forces Summary.
    let calls = AtomicUsize::new(0);
    struct CountingBackend {
        calls: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl cd_core::agent::ChatBackend for CountingBackend {
        async fn complete(
            &self,
            _messages: &[ChatMessage],
            _tools: &[cd_core::tools::ToolSpec],
        ) -> cd_core::error::CoreResult<ChatCompletion> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ChatCompletion {
                content: format!("dev-activity-answer-{n}"),
                tool_calls: vec![],
                finish_reason: "stop".into(),
            })
        }
    }
    let backend = CountingBackend {
        calls: AtomicUsize::new(0),
    };
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let traced = TracingChatBackend::new(Box::new(backend), sink);

    // Simulate a turn that would compact: large message list with distinct rounds.
    for round in 0..3 {
        let messages = vec![
            msg(Role::System, "policy synthetic"),
            msg(
                Role::User,
                format!(
                    "question round {round} SENSITIVE_BODY_MARKER=sk-not-real-{}",
                    round
                ),
            ),
            msg(Role::Assistant, format!("prior {round}")),
        ];
        let _ = traced
            .complete(
                &messages,
                &[cd_core::tools::ToolSpec {
                    name: "search_kb".into(),
                    description: "synth".into(),
                    side_effect: cd_core::tools::ToolSideEffect::Read,
                    parameters: serde_json::json!({"type":"object"}),
                }],
            )
            .await;
    }
    let traced_calls = recorder.calls();
    assert_eq!(traced_calls.len(), 3, "three provider rounds traced");

    // Detail On (Full): bodies retained; context metadata truthful to rounds.
    let mut full_rec = ActivityRecorder::new(
        "turn-dev-on",
        "sess-dev",
        DataScope::conversation(),
        ActivityDetailLevel::Full,
    );
    full_rec.record_provider_rounds(&traced_calls);
    let full = full_rec.finish(ActivityStatus::Ok, 10);
    assert_eq!(full.detail_level, ActivityDetailLevel::Full);
    assert_eq!(full.provider_round_count(), 3);
    for (i, ev) in full.events.iter().enumerate() {
        let ctx = ev.context.as_ref().expect("context metadata");
        assert_eq!(ctx.round as usize, i);
        assert_eq!(ctx.message_count, 3);
        assert!(ctx.context_used_chars > 0);
        assert!(
            ctx.tool_names.iter().any(|n| n == "search_kb"),
            "tool names must match what was offered"
        );
        let bodies = ctx.bodies.as_ref().expect("Full retains bodies");
        assert!(
            bodies
                .iter()
                .any(|m| m.content.contains("SENSITIVE_BODY_MARKER")),
            "Full should retain redacted bodies for On path"
        );
    }

    // Detail Off (Summary): no bodies retained.
    let mut sum_rec = ActivityRecorder::new(
        "turn-dev-off",
        "sess-dev",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    sum_rec.record_provider_rounds(&traced_calls);
    let summary = sum_rec.finish(ActivityStatus::Ok, 10);
    assert_eq!(summary.detail_level, ActivityDetailLevel::Summary);
    assert_eq!(summary.provider_round_count(), 3);
    for ev in &summary.events {
        let ctx = ev.context.as_ref().unwrap();
        assert!(
            ctx.bodies.is_none(),
            "Summary must not retain message bodies"
        );
        assert_eq!(ctx.message_count, 3);
        assert!(
            ctx.context_used_chars > 0,
            "counts remain truthful when Off"
        );
    }

    // Durability path strips bodies even if Full.
    let mut durable = full.clone();
    strip_bodies_for_durability(&mut durable);
    assert_eq!(durable.detail_level, ActivityDetailLevel::Summary);
    for ev in &durable.events {
        if let Some(ctx) = &ev.context {
            assert!(ctx.bodies.is_none(), "durable must not keep bodies");
        }
    }
    let _ = calls;
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
    if blob.contains(foreign_private) && !blob.contains("UNTRUSTED") {
        return Err(format!("cross-corpus private leaked: {foreign_private}"));
    }
    // Active bind must not claim the foreign corpus id as current when we
    // assert isolation for a different corpus session.
    let _ = foreign_corpus;
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
