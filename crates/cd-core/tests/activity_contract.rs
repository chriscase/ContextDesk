//! Behavioural proof for the activity contract and its capture seam.
//!
//! Everything here drives the REAL capture path — a turn trace produced by
//! [`cd_core::turn_trace::TracingChatBackend`] wrapping a backend, projected
//! by [`cd_core::activity::ActivityRecorder`]. Nothing asserts on a
//! hand-built record where that would let the projection be wrong and the
//! test still pass.
//!
//! Every fixture is synthetic.

use cd_core::activity::{
    ActivityDetailLevel, ActivityOrigin, ActivityPhase, ActivityRecorder, ActivityStatus,
    ActivityStore, ActivityTrigger, DataScope, DataScopeKind, Determinism, PrivacyClass,
    MAX_ACTIVITY_EVENTS,
};
use cd_core::agent::ChatBackend;
use cd_core::chat::{ChatCompletion, ChatMessage, Role};
use cd_core::error::{CoreError, CoreResult};
use cd_core::tools::ToolSpec;
use cd_core::turn_trace::{RecordingTurnTrace, TracingChatBackend, TurnTraceSink};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const SESSION: &str = "session-synthetic";
const MESSAGE: &str = "message-synthetic";

fn msg(role: Role, content: &str) -> ChatMessage {
    ChatMessage {
        role,
        content: content.to_string(),
        tool_call_id: None,
        tool_calls: None,
    }
}

fn tool(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.to_string(),
        description: "synthetic".to_string(),
        side_effect: cd_core::tools::ToolSideEffect::Read,
        parameters: serde_json::json!({ "type": "object" }),
    }
}

/// A backend that answers a fixed number of rounds, then fails or succeeds.
struct ScriptedBackend {
    calls: AtomicUsize,
    fail_on: Option<usize>,
}

impl ScriptedBackend {
    fn ok() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_on: None,
        }
    }
    fn failing_on(round: usize) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_on: Some(round),
        }
    }
}

#[async_trait::async_trait]
impl ChatBackend for ScriptedBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        let round = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_on == Some(round) {
            // Deliberately carries something that must never survive.
            return Err(CoreError::Message(
                "upstream rejected token sk-synthetic-not-a-real-key".to_string(),
            ));
        }
        Ok(ChatCompletion {
            content: "answer".to_string(),
            tool_calls: Vec::new(),
            finish_reason: "stop".to_string(),
        })
    }
}

/// Drive `rounds` provider calls through the real tracing backend.
async fn traced_rounds(backend: ScriptedBackend, rounds: usize) -> Arc<RecordingTurnTrace> {
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let traced = TracingChatBackend::new(Box::new(backend), sink);
    for round in 0..rounds {
        let messages = vec![
            msg(Role::System, "you are a synthetic assistant"),
            msg(Role::User, &format!("question for round {round}")),
            msg(Role::Assistant, "prior synthetic answer"),
        ];
        let _ = traced
            .complete(&messages, &[tool("search_kb"), tool("read_file")])
            .await;
    }
    recorder
}

fn record_from(
    recorder: &RecordingTurnTrace,
    scope: DataScope,
    detail: ActivityDetailLevel,
    status: ActivityStatus,
) -> cd_core::activity::TurnActivityRecord {
    let mut builder = ActivityRecorder::new("turn-1", SESSION, scope, detail);
    builder.record_provider_rounds(&recorder.calls());
    builder.finish(status, 42)
}

// ---------------------------------------------------------------------
// Multi-round traces
// ---------------------------------------------------------------------

#[tokio::test]
async fn a_multi_round_turn_yields_one_ordered_event_per_round() {
    let recorder = traced_rounds(ScriptedBackend::ok(), 3).await;
    let record = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
        ActivityStatus::Ok,
    );

    assert_eq!(record.provider_round_count(), 3);
    assert_eq!(record.events.len(), 3);

    // Monotonic sequence, and ordering is `seq` rather than elapsed time —
    // three fast rounds can share a millisecond.
    let seqs: Vec<u64> = record.events.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, vec![0, 1, 2]);

    for (index, event) in record.events.iter().enumerate() {
        assert_eq!(event.turn_id, "turn-1");
        assert_eq!(event.operation_id, format!("provider-round-{index}"));
        assert_eq!(event.origin, ActivityOrigin::ProbabilisticModel);
        assert_eq!(event.determinism, Determinism::Probabilistic);
        assert_eq!(event.phase, ActivityPhase::Completed);
        assert_eq!(event.status, ActivityStatus::Ok);
        let context = event.context.as_ref().expect("provider round has context");
        assert_eq!(context.round as usize, index);
        assert_eq!(context.message_count, 3);
        assert!(context.context_used_chars > 0);
        assert_eq!(
            context.tool_names,
            vec!["search_kb".to_string(), "read_file".to_string()],
            "tool NAMES are captured; schemas are not"
        );
    }

    // The first round is caused by the user; later rounds are the host
    // continuing its own loop.
    assert_eq!(record.events[0].trigger, ActivityTrigger::UserMessage);
    assert_eq!(record.events[1].trigger, ActivityTrigger::HostPolicy);

    // Per-role shape without any bodies.
    let roles = &record.events[0].context.as_ref().unwrap().roles;
    let names: Vec<&str> = roles.iter().map(|r| r.role.as_str()).collect();
    assert_eq!(names, vec!["assistant", "system", "user"]);
    assert!(roles.iter().all(|r| r.chars > 0 && r.messages == 1));
    assert_eq!(
        record.total_context_chars(),
        3 * record.events[0]
            .context
            .as_ref()
            .unwrap()
            .context_used_chars
    );
}

// ---------------------------------------------------------------------
// Cancellation / error
// ---------------------------------------------------------------------

#[tokio::test]
async fn a_failed_round_is_recorded_as_failed_with_a_redacted_reason() {
    let recorder = traced_rounds(ScriptedBackend::failing_on(1), 2).await;
    let record = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
        ActivityStatus::Failed,
    );

    assert_eq!(record.events.len(), 2);
    assert_eq!(record.events[0].status, ActivityStatus::Ok);
    assert_eq!(record.events[1].status, ActivityStatus::Failed);

    let detail = record.events[1].detail.as_deref().unwrap_or_default();
    assert!(
        !detail.contains("sk-synthetic-not-a-real-key"),
        "a failure reason must be redacted before it reaches an activity \
         record; got: {detail}"
    );
    // Not merely "absent": the redaction marker must actually be there, so
    // this cannot pass because the detail was empty or the reason was
    // dropped wholesale.
    assert!(
        detail.contains("sk-***"),
        "the secret-shaped token must be REPLACED, not just missing; got: {detail}"
    );
    assert!(
        detail.contains("upstream rejected token"),
        "and the useful part of the reason must survive; got: {detail}"
    );
}

#[test]
fn cancellation_and_withholding_are_not_reported_as_success() {
    use cd_core::activity::status_for_turn_reason;
    assert_eq!(status_for_turn_reason("cancel"), ActivityStatus::Cancelled);
    assert_eq!(status_for_turn_reason("error"), ActivityStatus::Failed);
    // Every host-withheld reason must classify as withheld, not ok — the
    // list is shared with the product, never re-derived here.
    for reason in cd_core::events::WITHHELD_TURN_REASONS {
        assert_eq!(
            status_for_turn_reason(reason),
            ActivityStatus::Withheld,
            "{reason} must never read as a delivered answer"
        );
    }
}

// ---------------------------------------------------------------------
// Redaction and bounds
// ---------------------------------------------------------------------

#[tokio::test]
async fn the_default_detail_level_retains_no_prompt_bodies() {
    let recorder = traced_rounds(ScriptedBackend::ok(), 1).await;
    let record = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
        ActivityStatus::Ok,
    );

    let context = record.events[0].context.as_ref().unwrap();
    assert!(
        context.bodies.is_none(),
        "summary detail must keep no message bodies at all"
    );
    assert_eq!(record.events[0].privacy, PrivacyClass::Metadata);

    // And nothing anywhere in the serialized record contains the prompt.
    let json = serde_json::to_string(&record).expect("serialize");
    assert!(
        !json.contains("question for round"),
        "no prompt text may survive at the default detail level"
    );
    assert!(!json.contains("you are a synthetic assistant"));
    // Counts still make it auditable.
    assert!(context.context_used_chars > 0);
    assert_eq!(context.message_count, 3);
}

#[tokio::test]
async fn full_detail_retains_only_already_redacted_bounded_bodies() {
    let recorder = traced_rounds(ScriptedBackend::ok(), 1).await;
    let record = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Full,
        ActivityStatus::Ok,
    );

    let bodies = record.events[0]
        .context
        .as_ref()
        .unwrap()
        .bodies
        .as_ref()
        .expect("full detail retains bodies");
    assert_eq!(bodies.len(), 3);
    assert_eq!(record.events[0].privacy, PrivacyClass::RedactedContent);
    for body in bodies {
        assert!(body.char_count > 0);
        assert!(
            body.content.chars().count() <= cd_core::turn_trace::MAX_TRACED_MESSAGE_CHARS,
            "bodies stay length-bounded"
        );
    }
}

#[tokio::test]
async fn opting_into_bodies_cannot_be_done_by_hand_building_an_event() {
    // A caller that builds an event with bodies attached, on a Summary
    // recorder, must not be able to smuggle them in.
    let recorder = traced_rounds(ScriptedBackend::ok(), 1).await;
    let full = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Full,
        ActivityStatus::Ok,
    );
    let smuggled = full.events[0].clone();
    assert!(smuggled.context.as_ref().unwrap().bodies.is_some());

    let mut summary = ActivityRecorder::new(
        "turn-2",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    summary.push(smuggled);
    let record = summary.finish(ActivityStatus::Ok, 1);
    assert!(
        record.events[0].context.as_ref().unwrap().bodies.is_none(),
        "the recorder strips bodies at Summary regardless of what the \
         caller attached"
    );
}

#[test]
fn a_pathological_turn_is_bounded_and_says_that_it_was() {
    let mut recorder = ActivityRecorder::new(
        "turn-3",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    let overflow = 7;
    for index in 0..(MAX_ACTIVITY_EVENTS + overflow) {
        recorder.push(cd_core::activity::ActivityEvent {
            turn_id: String::new(),
            operation_id: format!("op-{index}"),
            seq: 0,
            elapsed_ms: Some(1),
            phase: ActivityPhase::Completed,
            status: ActivityStatus::Ok,
            origin: ActivityOrigin::DeterministicHost,
            determinism: Determinism::Deterministic,
            label: "x".repeat(5_000),
            detail: Some("y".repeat(50_000)),
            trigger: ActivityTrigger::HostPolicy,
            scope: DataScope::conversation(),
            evidence: Vec::new(),
            privacy: PrivacyClass::Metadata,
            context: None,
        });
    }
    let record = recorder.finish(ActivityStatus::Ok, 1);
    assert_eq!(record.events.len(), MAX_ACTIVITY_EVENTS);
    assert_eq!(record.dropped_events, overflow);
    assert!(
        record.is_truncated(),
        "a prefix must announce itself; a UI must not present it as whole"
    );
    assert_eq!(
        record.events[0].label.chars().count(),
        cd_core::activity::MAX_ACTIVITY_LABEL_CHARS
    );
    assert_eq!(
        record.events[0].detail.as_ref().unwrap().chars().count(),
        cd_core::activity::MAX_ACTIVITY_DETAIL_CHARS
    );
}

#[test]
fn a_hand_built_heuristic_event_cannot_claim_determinism() {
    let mut recorder = ActivityRecorder::new(
        "turn-4",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    recorder.push(cd_core::activity::ActivityEvent {
        turn_id: String::new(),
        operation_id: "rank".to_string(),
        seq: 0,
        elapsed_ms: Some(3),
        phase: ActivityPhase::Completed,
        status: ActivityStatus::Ok,
        origin: ActivityOrigin::RepeatableHeuristic,
        // The caller lies here on purpose.
        determinism: Determinism::Deterministic,
        label: "Ranked candidates".to_string(),
        detail: None,
        trigger: ActivityTrigger::HostPolicy,
        scope: DataScope::conversation(),
        evidence: Vec::new(),
        privacy: PrivacyClass::Metadata,
        context: None,
    });
    let record = recorder.finish(ActivityStatus::Ok, 1);
    assert_eq!(
        record.events[0].determinism,
        Determinism::Repeatable,
        "the recorder re-derives determinism from origin, so a heuristic \
         cannot be presented as a proof even if a caller asks it to be"
    );
}

// ---------------------------------------------------------------------
// No-trace path costs nothing
// ---------------------------------------------------------------------

#[tokio::test]
async fn a_turn_with_no_sink_records_nothing_and_wraps_nothing() {
    // The disabled shape: no tracing backend at all, exactly as the host
    // builds it when the inspector is off.
    let backend = ScriptedBackend::ok();
    let messages = vec![msg(Role::User, "synthetic question")];
    let direct = backend.complete(&messages, &[]).await.expect("completes");

    // The enabled shape over the same script.
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let traced = TracingChatBackend::new(Box::new(ScriptedBackend::ok()), sink);
    let through_trace = traced.complete(&messages, &[]).await.expect("completes");

    assert_eq!(direct.content, through_trace.content);
    assert_eq!(direct.finish_reason, through_trace.finish_reason);
    assert_eq!(direct.tool_calls.len(), through_trace.tool_calls.len());

    // And a recorder handed no calls produces an empty, honest record.
    let empty = record_from(
        &RecordingTurnTrace::new(),
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
        ActivityStatus::Ok,
    );
    assert!(empty.events.is_empty());
    assert_eq!(empty.provider_round_count(), 0);
    assert!(!empty.is_truncated());
}

// ---------------------------------------------------------------------
// Inspector on/off semantic equivalence
// ---------------------------------------------------------------------

#[tokio::test]
async fn inspector_on_and_off_send_the_provider_identical_requests() {
    // What the backend RECEIVES is the thing that must not change. This
    // captures it on both sides and compares.
    #[derive(Default)]
    struct Capturing {
        seen: std::sync::Mutex<Vec<(Vec<String>, Vec<String>)>>,
    }
    /// Newtype so the shared recorder can be handed to the wrapper AND kept
    /// by the test (the orphan rule forbids implementing the trait on
    /// `Arc<Capturing>` directly).
    struct Shared(Arc<Capturing>);
    #[async_trait::async_trait]
    impl ChatBackend for Shared {
        async fn complete(
            &self,
            messages: &[ChatMessage],
            tools: &[ToolSpec],
        ) -> CoreResult<ChatCompletion> {
            self.0.seen.lock().expect("seen").push((
                messages
                    .iter()
                    .map(|m| format!("{}:{}", m.role.as_str(), m.content))
                    .collect(),
                tools.iter().map(|t| t.name.clone()).collect(),
            ));
            Ok(ChatCompletion {
                content: "answer".to_string(),
                tool_calls: Vec::new(),
                finish_reason: "stop".to_string(),
            })
        }
    }

    let messages = vec![
        msg(Role::System, "system prompt"),
        msg(Role::User, "synthetic question"),
    ];
    let tools = vec![tool("search_kb")];

    // Inspector OFF: the bare backend, as the host uses it when the sink is
    // `None`.
    let off = Arc::new(Capturing::default());
    Shared(Arc::clone(&off))
        .complete(&messages, &tools)
        .await
        .expect("off");

    // Inspector ON: the same backend behind the tracing wrapper.
    let on = Arc::new(Capturing::default());
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let traced = TracingChatBackend::new(Box::new(Shared(Arc::clone(&on))), sink);
    traced.complete(&messages, &tools).await.expect("on");

    let off_seen = off.seen.lock().expect("off seen").clone();
    let on_seen = on.seen.lock().expect("on seen").clone();
    assert_eq!(
        off_seen, on_seen,
        "turning the inspector on must not change one byte of what the \
         provider is asked — same messages, same tools, same order"
    );
    assert_eq!(
        recorder.calls().len(),
        1,
        "and the observation still happened"
    );
}

// ---------------------------------------------------------------------
// Ordinary vs linked scope
// ---------------------------------------------------------------------

#[tokio::test]
async fn ordinary_and_linked_turns_differ_only_in_scope() {
    let recorder = traced_rounds(ScriptedBackend::ok(), 2).await;

    let ordinary = record_from(
        &recorder,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
        ActivityStatus::Ok,
    );
    let linked = record_from(
        &recorder,
        DataScope::log_corpus("corpus-synthetic"),
        ActivityDetailLevel::Summary,
        ActivityStatus::Ok,
    );

    assert_eq!(ordinary.scope.kind, DataScopeKind::Conversation);
    assert_eq!(ordinary.scope.id, None);
    assert_eq!(linked.scope.kind, DataScopeKind::LogCorpus);
    assert_eq!(linked.scope.id.as_deref(), Some("corpus-synthetic"));

    // Same projection otherwise: one inspector serves both.
    assert_eq!(ordinary.events.len(), linked.events.len());
    for (a, b) in ordinary.events.iter().zip(linked.events.iter()) {
        assert_eq!(a.operation_id, b.operation_id);
        assert_eq!(a.origin, b.origin);
        assert_eq!(a.status, b.status);
        assert_eq!(
            a.context.as_ref().map(|c| c.context_used_chars),
            b.context.as_ref().map(|c| c.context_used_chars)
        );
        assert_eq!(a.scope, ordinary.scope);
        assert_eq!(b.scope, linked.scope);
    }
}

#[test]
fn the_contract_is_not_log_specific() {
    // A workspace/memory/connector scope needs no contract change, which is
    // what keeps the same inspector usable beyond logs.
    for kind in [
        DataScopeKind::Workspace,
        DataScopeKind::Memory,
        DataScopeKind::Connector,
    ] {
        let scope = DataScope {
            kind,
            id: Some("id-synthetic".to_string()),
            label: "Synthetic source".to_string(),
        };
        let json = serde_json::to_string(&scope).expect("serialize");
        let back: DataScope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, scope);
    }
}

// ---------------------------------------------------------------------
// Store: bounds and deletion lifecycle
// ---------------------------------------------------------------------

#[test]
fn the_store_is_bounded_and_evicts_oldest_first() {
    let mut store = ActivityStore::with_capacity(3);
    for index in 0..5 {
        let record = ActivityRecorder::new(
            format!("turn-{index}"),
            SESSION,
            DataScope::conversation(),
            ActivityDetailLevel::Summary,
        )
        .finish(ActivityStatus::Ok, 1);
        store.insert(SESSION, &format!("msg-{index}"), record);
    }
    assert_eq!(store.len(), 3);
    assert!(store.get(SESSION, "msg-0").is_none(), "oldest evicted");
    assert!(store.get(SESSION, "msg-4").is_some(), "newest retained");
}

#[test]
fn re_recording_one_message_does_not_evict_an_unrelated_one() {
    let mut store = ActivityStore::with_capacity(2);
    let make = || {
        ActivityRecorder::new(
            "t",
            SESSION,
            DataScope::conversation(),
            ActivityDetailLevel::Summary,
        )
        .finish(ActivityStatus::Ok, 1)
    };
    store.insert(SESSION, "keep-me", make());
    store.insert(SESSION, "retried", make());
    // A retry of the same turn overwrites in place.
    store.insert(SESSION, "retried", make());
    assert_eq!(store.len(), 2);
    assert!(
        store.get(SESSION, "keep-me").is_some(),
        "a retried turn must not push an unrelated record out"
    );
}

#[test]
fn deleting_a_session_forgets_its_activity() {
    let mut store = ActivityStore::default();
    let make = |session: &str| {
        ActivityRecorder::new(
            "t",
            session,
            DataScope::conversation(),
            ActivityDetailLevel::Summary,
        )
        .finish(ActivityStatus::Ok, 1)
    };
    store.insert("session-a", MESSAGE, make("session-a"));
    store.insert("session-b", MESSAGE, make("session-b"));

    store.forget_session("session-a");
    assert!(store.get("session-a", MESSAGE).is_none());
    assert!(
        store.get("session-b", MESSAGE).is_some(),
        "deleting one chat must not take another chat's activity with it"
    );

    store.forget_message("session-b", MESSAGE);
    assert!(store.is_empty());
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

#[test]
fn capture_defaults_to_metadata_only_and_config_files_predating_it_load() {
    let defaults = cd_core::config::ActivitySettings::default();
    assert!(defaults.enabled, "an auditable turn is the default");
    assert!(
        !defaults.retain_context_bodies,
        "retaining prompt bodies is opt-in, never the default"
    );
    assert_eq!(defaults.detail_level(), ActivityDetailLevel::Summary);

    let full = cd_core::config::ActivitySettings {
        enabled: true,
        retain_context_bodies: true,
    };
    assert_eq!(full.detail_level(), ActivityDetailLevel::Full);

    // A config written before the field existed must still load.
    let legacy = serde_json::json!({});
    let settings: cd_core::config::ActivitySettings =
        serde_json::from_value(legacy).expect("absent settings default");
    assert!(settings.enabled);
    assert!(!settings.retain_context_bodies);
}

// ---------------------------------------------------------------------
// Stream-event projection (tools, permissions, retrieval) + durability
// ---------------------------------------------------------------------

#[test]
fn stream_tools_and_permissions_are_recorded_as_metadata_only() {
    use cd_core::events::{StreamEvent, ToolPhase};
    let mut rec = ActivityRecorder::new(
        "turn-stream",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    rec.record_stream_events(&[
        StreamEvent::Tool {
            id: "t1".into(),
            name: "search_logs".into(),
            phase: ToolPhase::Started,
            summary: "query".into(),
            detail: Some("should stay summary-safe".into()),
            ok: None,
        },
        StreamEvent::Tool {
            id: "t1".into(),
            name: "search_logs".into(),
            phase: ToolPhase::Finished,
            summary: "3 hits".into(),
            detail: None,
            ok: Some(true),
        },
        StreamEvent::PermissionRequired {
            request_id: "p1".into(),
            tool_name: "write_file".into(),
            target: "notes.md".into(),
            reason: "model wants to write SECRET sk-leaked-token-here".into(),
            preview: "draft body with sk-leaked-token-here".into(),
            risk: "local".into(),
            arguments: serde_json::json!({"path": "notes.md", "content": "sk-leaked"}),
        },
        StreamEvent::SearchTrail {
            steps: vec!["memory".into(), "workspace".into()],
        },
    ]);
    let finished = rec.finish(ActivityStatus::Ok, 50);
    assert!(
        finished
            .events
            .iter()
            .any(|e| e.operation_id.starts_with("tool-") && e.phase == ActivityPhase::Completed),
        "tool finish must be present"
    );
    let perm = finished
        .events
        .iter()
        .find(|e| e.operation_id.starts_with("permission-"))
        .expect("permission event");
    assert_eq!(perm.origin, ActivityOrigin::DeterministicHost);
    assert_eq!(perm.determinism, Determinism::Deterministic);
    assert_eq!(perm.status, ActivityStatus::Pending);
    // Reason/preview/arguments must not leak into detail.
    let detail = perm.detail.as_deref().unwrap_or("");
    assert!(
        !detail.contains("sk-leaked"),
        "permission detail must not carry secret-bearing preview: {detail}"
    );
    let retrieval = finished
        .events
        .iter()
        .find(|e| e.label.contains("Retrieval"))
        .expect("retrieval");
    assert_eq!(retrieval.origin, ActivityOrigin::RepeatableHeuristic);
    assert_eq!(retrieval.determinism, Determinism::Repeatable);
}

#[test]
fn shared_timeline_preserves_model_tool_model_order_and_separates_latency() {
    use cd_core::activity::ToolActivityKind;
    use cd_core::events::ToolPhase;
    use cd_core::turn_trace::{
        TracedCall, TracedHostEvent, TracedOutcome, TracedTimelineEntry, TracedTimelineItem,
    };
    let call = |seq, latency| TracedCall {
        seq,
        elapsed_ms: latency,
        tool_names: vec!["connector_read".into()],
        messages: vec![cd_core::turn_trace::TracedMessage {
            role: "user".into(),
            content: "synthetic".into(),
            char_count: 9,
            truncated: false,
        }],
        context_used_chars: 9,
        messages_capped: false,
        outcome: TracedOutcome::Completed {
            finish_reason: "stop".into(),
            tool_call_count: usize::from(seq == 0),
        },
    };
    let timeline = vec![
        TracedTimelineEntry {
            seq: 0,
            elapsed_ms: 100,
            item: TracedTimelineItem::ProviderCall(call(0, 87)),
        },
        TracedTimelineEntry {
            seq: 1,
            elapsed_ms: 110,
            item: TracedTimelineItem::HostEvent(TracedHostEvent::Tool {
                id: "tool-1".into(),
                name: "connector_read".into(),
                phase: ToolPhase::Started,
                ok: None,
                kind: ToolActivityKind::ExternalConnector,
            }),
        },
        TracedTimelineEntry {
            seq: 2,
            elapsed_ms: 140,
            item: TracedTimelineItem::HostEvent(TracedHostEvent::Tool {
                id: "tool-1".into(),
                name: "connector_read".into(),
                phase: ToolPhase::Finished,
                ok: Some(true),
                kind: ToolActivityKind::ExternalConnector,
            }),
        },
        TracedTimelineEntry {
            seq: 3,
            elapsed_ms: 250,
            item: TracedTimelineItem::ProviderCall(call(1, 105)),
        },
    ];
    let mut recorder = ActivityRecorder::new(
        "turn-order",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    recorder.record_timeline(&timeline);
    let record = recorder.finish(ActivityStatus::Ok, 250);
    assert_eq!(
        record
            .events
            .iter()
            .map(|event| event.origin)
            .collect::<Vec<_>>(),
        vec![
            ActivityOrigin::ProbabilisticModel,
            ActivityOrigin::ExternalConnector,
            ActivityOrigin::ExternalConnector,
            ActivityOrigin::ProbabilisticModel,
        ]
    );
    assert_eq!(record.events[0].elapsed_ms, Some(100));
    assert_eq!(
        record.events[0]
            .context
            .as_ref()
            .expect("provider context")
            .provider_latency_ms,
        Some(87),
        "per-call latency must not be relabelled as turn-relative elapsed"
    );
    assert_eq!(record.events[3].elapsed_ms, Some(250));
}

#[test]
fn permission_prompt_is_pending_until_an_actual_human_decision() {
    use cd_core::activity::ToolActivityKind;
    use cd_core::events::{StreamEvent, ToolPhase};
    use cd_core::permissions::PermissionDecision;
    let mut recorder = ActivityRecorder::new(
        "turn-permission",
        SESSION,
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    recorder.record_stream_events(&[
        StreamEvent::Tool {
            id: "write-1".into(),
            name: "save_memory".into(),
            phase: ToolPhase::Started,
            summary: "permission required".into(),
            detail: None,
            ok: None,
        },
        StreamEvent::PermissionRequired {
            request_id: "request-1".into(),
            tool_name: "save_memory".into(),
            target: "private target not retained".into(),
            reason: "private reason not retained".into(),
            preview: "private preview not retained".into(),
            risk: "local".into(),
            arguments: serde_json::json!({"secret": "not retained"}),
        },
        StreamEvent::Tool {
            id: "write-1".into(),
            name: "save_memory".into(),
            phase: ToolPhase::Finished,
            summary: "awaiting permission".into(),
            detail: None,
            ok: None,
        },
    ]);
    let mut record = recorder.finish(ActivityStatus::Pending, 20);
    assert!(record.events.iter().all(|event| {
        event.status == ActivityStatus::Pending
            && event.origin != ActivityOrigin::UserDecision
            && event.elapsed_ms.is_none()
    }));

    record.record_permission_resolution(
        "request-1",
        "save_memory",
        PermissionDecision::AllowOnce,
        ToolActivityKind::GovernedWrite,
        &[
            StreamEvent::Tool {
                id: "write-2".into(),
                name: "save_memory".into(),
                phase: ToolPhase::Started,
                summary: "not retained".into(),
                detail: Some("raw result not retained".into()),
                ok: None,
            },
            StreamEvent::Tool {
                id: "write-2".into(),
                name: "save_memory".into(),
                phase: ToolPhase::Finished,
                summary: "not retained".into(),
                detail: Some("raw result not retained".into()),
                ok: Some(true),
            },
        ],
    );
    let decision = record
        .events
        .iter()
        .find(|event| event.origin == ActivityOrigin::UserDecision)
        .expect("actual decision");
    assert_eq!(decision.status, ActivityStatus::Ok);
    assert_eq!(decision.elapsed_ms, None);
    let write = record
        .events
        .iter()
        .rev()
        .find(|event| event.origin == ActivityOrigin::GovernedWrite)
        .expect("governed write outcome");
    assert_eq!(write.status, ActivityStatus::Ok);
    assert!(
        write.detail.is_none(),
        "raw tool result must not be retained"
    );
}

#[test]
fn durable_journal_survives_restart_and_strips_bodies() {
    use cd_core::activity::{
        strip_bodies_for_durability, ContextMetadata, DurableActivityJournal, PrivacyClass,
    };
    let dir = tempfile::tempdir().unwrap();
    let journal = DurableActivityJournal::open(dir.path()).expect("open journal");

    let mut record = ActivityRecorder::new(
        "turn-d",
        "sess-d",
        DataScope::conversation(),
        ActivityDetailLevel::Full,
    )
    .finish(ActivityStatus::Ok, 9);
    record.message_id = Some("msg-d".into());
    // Inject a body that must not survive durability.
    if let Some(event) = record.events.first_mut() {
        event.privacy = PrivacyClass::RedactedContent;
        event.context = Some(ContextMetadata {
            round: 0,
            message_count: 1,
            context_used_chars: 12,
            messages_capped: false,
            tool_names: vec![],
            roles: vec![],
            provider_latency_ms: Some(4),
            bodies: Some(vec![cd_core::turn_trace::TracedMessage {
                role: "user".into(),
                content: "prompt body must not be durable".into(),
                char_count: 30,
                truncated: false,
            }]),
        });
    } else {
        // finish with no events — push a synthetic one via recorder properly
        let mut rec = ActivityRecorder::new(
            "turn-d",
            "sess-d",
            DataScope::conversation(),
            ActivityDetailLevel::Summary,
        );
        rec.push(cd_core::activity::ActivityEvent {
            turn_id: String::new(),
            operation_id: "op".into(),
            seq: 0,
            elapsed_ms: Some(1),
            phase: ActivityPhase::Completed,
            status: ActivityStatus::Ok,
            origin: ActivityOrigin::ProbabilisticModel,
            determinism: Determinism::Probabilistic,
            label: "Model request".into(),
            detail: None,
            trigger: ActivityTrigger::UserMessage,
            scope: DataScope::conversation(),
            evidence: vec![],
            privacy: PrivacyClass::RedactedContent,
            context: Some(ContextMetadata {
                round: 0,
                message_count: 1,
                context_used_chars: 12,
                messages_capped: false,
                tool_names: vec![],
                roles: vec![],
                provider_latency_ms: Some(4),
                bodies: Some(vec![cd_core::turn_trace::TracedMessage {
                    role: "user".into(),
                    content: "prompt body must not be durable".into(),
                    char_count: 30,
                    truncated: false,
                }]),
            }),
        });
        record = rec.finish(ActivityStatus::Ok, 9);
        record.message_id = Some("msg-d".into());
    }

    journal.save_record(&record).expect("save");

    // Fresh store — simulate restart.
    let mut store = ActivityStore::default();
    let n = journal.hydrate_store(&mut store).expect("hydrate");
    assert!(n >= 1, "hydrated {n}");
    let loaded = store.get("sess-d", "msg-d").expect("loaded");
    for e in &loaded.events {
        if let Some(ctx) = &e.context {
            assert!(ctx.bodies.is_none(), "durable load must strip bodies");
        }
        assert_ne!(e.privacy, PrivacyClass::RedactedContent);
    }

    // Secret-like content is refused.
    let mut bad = record.clone();
    bad.events[0].detail = Some("Authorization: Bearer sk-evil".into());
    assert!(journal.save_record(&bad).is_err());

    // Forget session removes file.
    journal.forget_session("sess-d").expect("forget");
    let mut store2 = ActivityStore::default();
    let n2 = journal.hydrate_store(&mut store2).expect("hydrate empty");
    assert_eq!(store2.get("sess-d", "msg-d"), None);
    let _ = n2;
    let _ = strip_bodies_for_durability;
}

#[test]
fn cancellation_status_is_not_ok() {
    assert_eq!(
        cd_core::activity::status_for_turn_reason("cancel"),
        ActivityStatus::Cancelled
    );
    assert_eq!(
        cd_core::activity::status_for_turn_reason("cancelled"),
        ActivityStatus::Cancelled
    );
    assert_ne!(
        cd_core::activity::status_for_turn_reason("cancel"),
        ActivityStatus::Ok
    );
}

#[test]
fn activity_and_customer_scopes_are_not_merged() {
    let log = DataScope::log_corpus("corpus-abc");
    let chat = DataScope::conversation();
    assert_ne!(log.kind, chat.kind);
    assert_eq!(log.kind, DataScopeKind::LogCorpus);
    // Correlation is scope id, not a shared wall clock.
    assert_eq!(log.id.as_deref(), Some("corpus-abc"));
    assert!(chat.id.is_none());
}

// ---------------------------------------------------------------------
// Product-path retirement: store + durable journal together
// ---------------------------------------------------------------------

#[test]
fn retire_session_activity_clears_memory_and_durable_journal() {
    use cd_core::activity::{
        retire_session_activity, ActivityRecorder, ActivityStatus, ActivityStore, DataScope,
        DurableActivityJournal,
    };
    let dir = tempfile::tempdir().unwrap();
    let journal = DurableActivityJournal::open(dir.path()).expect("journal");

    let mut rec = ActivityRecorder::new(
        "turn-retire",
        "sess-retire",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    rec.push(cd_core::activity::ActivityEvent {
        turn_id: String::new(),
        operation_id: "op".into(),
        seq: 0,
        elapsed_ms: Some(1),
        phase: ActivityPhase::Completed,
        status: ActivityStatus::Ok,
        origin: ActivityOrigin::DeterministicHost,
        determinism: Determinism::Deterministic,
        label: "Host work".into(),
        detail: None,
        trigger: ActivityTrigger::HostPolicy,
        scope: DataScope::conversation(),
        evidence: vec![],
        privacy: PrivacyClass::Metadata,
        context: None,
    });
    let mut record = rec.finish(ActivityStatus::Ok, 3);
    record.message_id = Some("msg-retire".into());
    journal.save_record(&record).expect("save durable");

    let mut store = ActivityStore::default();
    store.insert("sess-retire", "msg-retire", record.clone());
    assert!(store.get("sess-retire", "msg-retire").is_some());

    // Product path used by trash_chat_session / delete_chat_session.
    retire_session_activity(&mut store, dir.path(), "sess-retire");

    assert!(
        store.get("sess-retire", "msg-retire").is_none(),
        "memory store must forget the session"
    );
    let mut store2 = ActivityStore::default();
    let n = journal
        .hydrate_store(&mut store2)
        .expect("hydrate after retire");
    assert_eq!(
        store2.get("sess-retire", "msg-retire"),
        None,
        "durable journal must not rehydrate retired session (n={n})"
    );
    // File should be gone.
    let leftover: Vec<_> = std::fs::read_dir(dir.path().join("activity"))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(
        leftover.iter().all(|n| !n.contains("sess-retire")),
        "session sidecar must be removed: {leftover:?}"
    );
}

/// Structural product-path proof: host trash/delete must call the shared
/// retirement helper. Fails if delete only clears history and leaves activity.
#[test]
fn host_trash_and_delete_commands_call_retire_chat_session_activity() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../desktop/src-tauri/src/lib.rs"
    );
    let src =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read host lib.rs at {path}: {e}"));
    for fname in ["fn trash_chat_session", "fn delete_chat_session"] {
        let idx = src
            .find(fname)
            .unwrap_or_else(|| panic!("missing {fname} in host"));
        // Slice until the next tauri command or a blank-line+fn at column 0-ish.
        let rest = &src[idx..];
        let end = rest
            .match_indices("\n#[tauri::command]")
            .nth(1) // first is this fn's own attribute if present; take next command
            .map(|(i, _)| i)
            .or_else(|| {
                // Fallback: next "\nfn " after 80 chars
                rest[80..].find("\nfn ").map(|i| i + 80)
            })
            .unwrap_or(800.min(rest.len()));
        let body = &rest[..end.min(rest.len()).min(1500)];
        assert!(
            body.contains("retire_chat_session_activity"),
            "{fname} must call retire_chat_session_activity so activity is \
             not left behind; body was:\n{body}"
        );
    }
    // Shared helper must use the core retirement API (store + journal).
    assert!(
        src.contains("cd_core::activity::retire_session_activity")
            || src.contains("retire_session_activity("),
        "host must route through cd_core::activity::retire_session_activity"
    );
}
