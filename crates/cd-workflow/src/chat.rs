//! The shared chat entry point — "ChatWorkflow" for both Tauri and the CLI.
//!
//! This ties together pieces that already exist in `cd_core` and pieces
//! extracted elsewhere in this crate: [`crate::provider::resolve_turn_inputs`]
//! resolves the profile; [`crate::turn`] binds a linked corpus and drives one
//! provider round via `cd_core::research::research_turn_with_cancel_and_context`
//! (itself unmodified — never reimplemented); [`cd_core::sessions::SessionStore`]
//! is the SAME durable transcript store the desktop app already uses, so a
//! session started in the GUI can continue from the CLI and vice versa; and
//! [`cd_core::keychain_store::KeychainSecretStore`] is the SAME OS keychain
//! access, so a provider configured in the GUI works immediately from the
//! CLI with no separate credential setup.
//!
//! One piece here is genuinely new, not extracted: `cd_core::research`'s
//! turn functions surface a mid-turn `PermissionRequired` event and stop for
//! that tool call — the desktop app resumes it as a *separate* follow-up
//! command once the renderer's permission modal returns a decision. A CLI
//! process can prompt synchronously instead, so this module adds a small
//! bounded grant-and-continue loop around the turn call. It is new
//! orchestration this workflow needed and no host needed before, not a
//! rename of existing behavior — call it out as such rather than presenting
//! it as an extraction.

use crate::provider::{resolve_turn_inputs, ResolvedTurnInputs};
use crate::turn::{bind_linked_corpus, run_linked_turn, run_ordinary_turn, unbind_linked_corpus};
use cd_core::chat::{ChatMessage, Role};
use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::{Session, SessionStore, StoredMessage};
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::TurnTraceSink;
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Bound on synchronous grant-and-continue rounds within one workflow call —
/// a person answering three permission prompts in a row for one question is
/// already an unusual turn; a fourth pending request ends the turn honestly
/// rather than prompting forever.
pub const MAX_PERMISSION_ROUNDS: usize = 3;

/// One chat request, host-neutral.
pub struct ChatWorkflowRequest<'a> {
    /// Corpus to ground this turn in, if any. `None` runs an ordinary,
    /// unlinked turn.
    pub corpus_id: Option<&'a str>,
    /// Explicit provider profile id, if the caller wants to override the
    /// active/default profile for this turn only.
    pub explicit_profile_id: Option<&'a str>,
    /// Explicit per-turn chat model override.
    pub chat_model_override: Option<&'a str>,
    /// Construct the exact same bounded, redacted conversation and grounded
    /// log context a real turn would, but guarantee no provider request
    /// occurs (see `cd_core::research`'s `..._and_trace` entry point for the
    /// exact mechanism). Session/corpus resolution and binding happen
    /// exactly as normal; only persistence is skipped — see
    /// [`run_chat_workflow`].
    pub dry_run: bool,
    /// Capture every backend call this turn makes — real, or under
    /// `dry_run`, synthetic — for the caller to render at whatever trace
    /// level it wants. `None` costs nothing extra: no wrapping backend is
    /// constructed at all.
    pub trace_sink: Option<Arc<dyn TurnTraceSink>>,
}

/// Outcome of one workflow call.
pub struct ChatWorkflowOutcome {
    /// The session this turn ran against (existing or newly created).
    pub session_id: String,
    /// Every stream event across every internal permission round.
    pub events: Vec<StreamEvent>,
    /// Convenience: the concatenation of every `TextDelta` chunk.
    pub final_text: String,
    /// Resolved provider profile id this turn used — a real request under
    /// this identity for an ordinary call, or the identity a real turn
    /// would have used, for a dry run.
    pub provider_profile_id: String,
    /// Resolved chat model id, same caveat as `provider_profile_id`.
    pub chat_model: String,
    /// The linked corpus's event revision at bind time, if this turn was
    /// corpus-linked.
    pub corpus_revision: Option<u64>,
    /// Total messages in this session's chat history after the turn
    /// (system preamble + every prior + new turn) — a trace summary's
    /// "history count."
    pub history_messages: usize,
}

fn role_str(role: &Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
        Role::Tool => "tool",
    }
}

fn stored_from_chat(message: &ChatMessage) -> StoredMessage {
    StoredMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: role_str(&message.role).to_string(),
        content: message.content.clone(),
        tools: None,
        citations: None,
        trail: None,
        meta: None,
    }
}

fn has_pending_permission(events: &[StreamEvent]) -> Option<(String, String, Value)> {
    events.iter().find_map(|event| match event {
        StreamEvent::PermissionRequired {
            request_id,
            tool_name,
            arguments,
            ..
        } => Some((request_id.clone(), tool_name.clone(), arguments.clone())),
        _ => None,
    })
}

/// Run one chat turn end to end: resolve the profile, load or create the
/// session, bind the corpus if linked, drive the turn (resuming through up
/// to [`MAX_PERMISSION_ROUNDS`] synchronous permission prompts), persist the
/// new messages, and unbind. This is the one entry point a thin Tauri
/// adapter and a thin CLI adapter should both call — never a copy of its
/// internals.
///
/// `request.dry_run` changes exactly one thing about this sequence:
/// **nothing is persisted**. Profile resolution, session load/creation,
/// corpus binding, and context assembly all happen exactly as they would for
/// a real turn — a dry run inspects the real machinery, it does not take a
/// separate path through it — but `sessions.save` is never called, so a dry
/// run against an existing session can never silently add a stray empty
/// "assistant reply" to that session's durable history, and a dry run with
/// no `--session` never creates one at all.
#[allow(clippy::too_many_arguments)]
pub async fn run_chat_workflow(
    host: &mut ToolHost,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    sessions: &SessionStore,
    cache_root: &Path,
    session_id: Option<&str>,
    user_text: &str,
    request: ChatWorkflowRequest<'_>,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    mut decide_permission: impl FnMut(&str, &str, &str, &str, &str) -> PermissionDecision,
) -> CoreResult<ChatWorkflowOutcome> {
    let resolved: ResolvedTurnInputs = resolve_turn_inputs(
        secrets,
        cfg,
        request.explicit_profile_id,
        request.chat_model_override,
    )
    .map_err(CoreError::Message)?;

    let mut session = match session_id {
        Some(id) => sessions.load(id)?,
        None => Session::new(cd_core::sessions::title_from_prompt(user_text, 40)),
    };
    if let Some(corpus_id) = request.corpus_id {
        session.set_linked_corpus_id(Some(corpus_id.to_string()));
    }
    let session_id = session.id.clone();

    let mut history = session.to_chat_history();
    let before_len = history.len();

    let binding = match request.corpus_id {
        Some(corpus_id) => Some(bind_linked_corpus(host, cache_root, corpus_id)?),
        None => None,
    };

    let mut all_events = Vec::new();
    let mut rounds = 0usize;
    // A concrete, always-present sink lets each loop iteration reborrow the
    // SAME `&mut dyn FnMut`, which the borrow checker tracks precisely across
    // iterations; matching `live` fresh inside the loop does not, because
    // the option's inner lifetime is fixed by the outer signature rather
    // than shrinkable per loop turn — so it is unwrapped exactly once here,
    // before the loop, into a plain `&mut dyn FnMut` that gets reborrowed
    // per iteration instead.
    let mut noop_sink = |_event: StreamEvent| {};
    let live_sink: &mut (dyn FnMut(StreamEvent) + Send) = match live {
        Some(sink) => sink,
        None => &mut noop_sink,
    };
    loop {
        let events = if let Some(corpus_id) = request.corpus_id {
            run_linked_turn(
                host,
                &resolved,
                user_text,
                &mut history,
                &session_id,
                corpus_id,
                cancel.clone(),
                Some(&mut *live_sink),
                request.dry_run,
                request.trace_sink.clone(),
            )
            .await
        } else {
            run_ordinary_turn(
                host,
                &resolved,
                user_text,
                &mut history,
                &session_id,
                cancel.clone(),
                Some(&mut *live_sink),
                request.dry_run,
                request.trace_sink.clone(),
            )
            .await
        };
        let events = match events {
            Ok(events) => events,
            Err(error) => {
                if let Some(binding) = binding {
                    unbind_linked_corpus(host, binding);
                }
                return Err(error);
            }
        };
        all_events.extend(events.iter().cloned());

        let Some((request_id, tool_name, arguments)) = has_pending_permission(&events) else {
            break;
        };
        if rounds >= MAX_PERMISSION_ROUNDS {
            break;
        }
        rounds += 1;
        let (target, reason, preview, risk) = events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired {
                    target,
                    reason,
                    preview,
                    risk,
                    ..
                } => Some((
                    target.clone(),
                    reason.clone(),
                    preview.clone(),
                    risk.clone(),
                )),
                _ => None,
            })
            .unwrap_or_default();
        let decision = decide_permission(&tool_name, &target, &reason, &preview, &risk);
        let grant_events = cd_core::research::grant_and_execute(
            host,
            &request_id,
            decision,
            None,
            &tool_name,
            &arguments,
            Some(&mut history),
        )
        .await?;
        all_events.extend(grant_events);
    }

    let corpus_revision = binding.as_ref().map(|b| b.revision);
    if let Some(binding) = binding {
        unbind_linked_corpus(host, binding);
    }

    // A dry run has zero persistent side effects: it inspects the real
    // machinery without ever writing what that inspection produced. The
    // turn's (empty) synthetic reply is never appended to `session` and
    // `sessions.save` is never called — an existing session named with
    // `--session` is read for its real history but left byte-for-byte
    // unchanged on disk, and no session file is created when none existed.
    if !request.dry_run {
        for message in &history[before_len..] {
            session.messages.push(stored_from_chat(message));
        }
        session.maybe_auto_title_from_first_user();
        session.touch();
        sessions.ensure()?;
        sessions.save(&session)?;
    }

    let final_text = all_events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");

    Ok(ChatWorkflowOutcome {
        session_id,
        events: all_events,
        provider_profile_id: resolved.profile.id.clone(),
        chat_model: resolved.profile.chat_model.clone(),
        corpus_revision,
        history_messages: history.len(),
        final_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::index::KeywordIndex;
    use cd_core::keychain_store::MemorySecretStore;
    use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
    use cd_core::workspace::Workspace;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Genuine SSE frames — a plain JSON body with a top-level `finish_reason`
    /// would be misparsed as an SSE finish-only frame by `complete_stream_cb`
    /// and silently drop the content (verified by reading the real parser).
    const SSE_BODY: &str =
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n";

    /// End to end, offline: a `ChatWorkflowRequest` with no linked corpus
    /// reaches a real `OpenAiCompatibleClient` HTTP call (via
    /// `run_ordinary_turn` -> `research_turn_with_cancel_and_context` ->
    /// `backend_for`) against a local `wiremock` server standing in for the
    /// provider, and the resulting text and session persistence are exactly
    /// what a thin CLI or Tauri adapter would need to render.
    #[tokio::test]
    async fn run_chat_workflow_completes_an_ordinary_turn_against_a_mock_provider() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(SSE_BODY, "text/event-stream"),
            )
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        let secrets = MemorySecretStore::new();
        secrets.set("test/fake/api_key", "sk-test-key").unwrap();

        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.api_key_ref = Some("test/fake/api_key".into());
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = false;

        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };

        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            None,
            "hi there",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: false,
                trace_sink: None,
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::Deny,
        )
        .await
        .expect("chat workflow should complete against the mocked provider");

        assert_eq!(outcome.final_text, "hello from the mock model");
        assert!(outcome.events.iter().any(
            |event| matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")
        ));

        // A brand-new session has no system message yet, so the agent loop
        // injects one ahead of the user turn (`agent.rs`'s
        // `history.push(... Role::System ...)` for empty history) — that
        // becomes part of the persisted transcript alongside the user
        // message and the assistant reply.
        let saved = sessions
            .load(&outcome.session_id)
            .expect("session persisted");
        assert_eq!(
            saved.messages.len(),
            3,
            "system preamble + user turn + assistant reply"
        );
        assert_eq!(saved.messages[0].role, "system");
        assert_eq!(saved.messages[1].role, "user");
        assert_eq!(saved.messages[1].content, "hi there");
        assert_eq!(saved.messages[2].role, "assistant");
        assert_eq!(saved.messages[2].content, "hello from the mock model");
    }

    /// A dry run against an *existing* session must leave that session's
    /// saved file byte-for-byte untouched — not merely "no new session
    /// created," but "the one the caller pointed at is not mutated either."
    #[tokio::test]
    async fn dry_run_never_persists_and_never_touches_an_existing_session() {
        // Deliberately no Mock mounted for /v1/chat/completions: if the dry
        // run were to make a real request, `run_ordinary_turn` would either
        // get wiremock's default 404 (surfacing as a provider error) or, if
        // this profile were misconfigured to skip that path, silently
        // succeed with unexpected content — either way the assertions below
        // would catch it.
        let server = MockServer::start().await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        let secrets = MemorySecretStore::new();
        secrets.set("test/fake/api_key", "sk-test-key").unwrap();

        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.api_key_ref = Some("test/fake/api_key".into());
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = false;

        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };

        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        // Seed a real, pre-existing session the dry run will point at.
        let mut existing = cd_core::sessions::Session::new("existing".to_string());
        existing.messages.push(cd_core::sessions::StoredMessage {
            id: "m1".into(),
            role: "user".into(),
            content: "previously said this".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        sessions.ensure().unwrap();
        sessions.save(&existing).unwrap();
        let before = std::fs::read(sessions_dir.path().join(format!("{}.json", existing.id)))
            .expect("session file exists before the dry run");

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            Some(&existing.id),
            "dry run question",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: true,
                trace_sink: None,
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::Deny,
        )
        .await
        .expect("dry run must complete without a real provider request");

        assert_eq!(outcome.session_id, existing.id);
        assert_eq!(
            outcome.final_text, "",
            "the dry-run backend never produces real content"
        );
        assert!(outcome.events.iter().any(
            |event| matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")
        ));
        assert_eq!(outcome.provider_profile_id, cfg.providers.active_id.clone().unwrap());
        assert_eq!(outcome.chat_model, "test-model");

        let after = std::fs::read(sessions_dir.path().join(format!("{}.json", existing.id)))
            .expect("session file still exists after the dry run");
        assert_eq!(
            before, after,
            "a dry run must not mutate the existing session file at all"
        );

        let reloaded = sessions.load(&existing.id).unwrap();
        assert_eq!(
            reloaded.messages.len(),
            1,
            "the dry run's own (empty) turn must never be appended"
        );
    }
}
