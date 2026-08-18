use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use async_trait::async_trait;
use cd_triage_runtime::{
    cancel, canonical_request_fingerprint, replay, triage, triage_with_policy, TriageEngine,
    TriageEngineFailure, TriageEventSink, TriageExecutionTerminal, TriageRuntimeError,
    ValidatedTriageRequest,
};
use cd_triage_sdk::{
    ModelRef, PacketPrivacyBoundary, TriageAttemptStatus, TriageCancellationV1,
    TriageContractError, TriageContributorRole, TriagePolicySelectionV2, TriageReconciliationV1,
    TriageReplayV1, TriageRequestOverridesV1, TriageRequestV2, TriageResultKind, TriageResultV2,
    TriageRoleAttemptV1, TriageRunEventPayloadV2, TriageRunEventV2, TriageScopeV1,
    TriageSlotKindV2, TriageTerminalDispositionV1, TriageValidationState,
    TRIAGE_CANCELLATION_SCHEMA_V1, TRIAGE_POLICY_SCHEMA_V2, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_REQUEST_SCHEMA_V2, TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2,
};
use serde_json::{json, Map, Value};

fn block_on<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn model() -> ModelRef {
    ModelRef {
        profile_id: "profile:primary".into(),
        model_id: "openai/gpt-oss-120b".into(),
    }
}

fn standard_request() -> TriageRequestV2 {
    request(TriagePolicySelectionV2::Standard { model: model() })
}

fn inline_request_with_document(document: Value) -> TriageRequestV2 {
    request(TriagePolicySelectionV2::Inline {
        schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
        document,
    })
}

fn inline_request() -> TriageRequestV2 {
    inline_request_with_document(json!({
        "schema_id": TRIAGE_POLICY_SCHEMA_V2,
        "settings": {"alpha": 1, "beta": 2}
    }))
}

fn saved_request() -> TriageRequestV2 {
    request(TriagePolicySelectionV2::Saved {
        policy_id: "policy:incident".into(),
        policy_revision: 7,
    })
}

fn request(policy: TriagePolicySelectionV2) -> TriageRequestV2 {
    TriageRequestV2 {
        schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
        run_id: "run:runtime:1".into(),
        privacy: PacketPrivacyBoundary::OwnerOnly,
        task: "Determine the most defensible incident root cause.".into(),
        scope: TriageScopeV1 {
            corpus_id: "corpus:runtime:1".into(),
            corpus_revision: Some(4),
            source_ids: vec!["source:api".into()],
        },
        policy,
        overrides: TriageRequestOverridesV1 {
            deadline_ms: Some(30_000),
            max_provider_calls: Some(8),
        },
        cancellation_id: "cancel:runtime:1".into(),
    }
}

#[derive(Clone, Copy)]
enum TerminalFixture {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

fn reconciliation() -> TriageReconciliationV1 {
    TriageReconciliationV1 {
        state: "honest_partial".into(),
        configured_role_slots: 1,
        completed_role_slots: 1,
        distinct_models: 1,
        distinct_gateways: 1,
        supported_claim_ids: Vec::new(),
        conflict_ids: Vec::new(),
        gap_ids: vec!["gap:root-cause".into()],
        root_cause_established: false,
    }
}

fn partial_result(run_id: &str) -> TriageResultV2 {
    TriageResultV2 {
        schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        kind: TriageResultKind::HonestPartial,
        validation_state: TriageValidationState::Partial,
        packet_id: "packet:runtime:1".into(),
        reconciliation: reconciliation(),
        answer: None,
        accepted_evidence_ids: Vec::new(),
        reason_codes: vec!["root_cause_not_established".into()],
    }
}

fn event(run_id: &str, sequence: u64, event: TriageRunEventPayloadV2) -> TriageRunEventV2 {
    TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        sequence,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    }
}

fn replay_for(request: &TriageRequestV2, terminal: TerminalFixture) -> TriageReplayV1 {
    let fingerprint = canonical_request_fingerprint(request).unwrap();
    let run_id = request.run_id.as_str();
    let result = partial_result(run_id);
    let terminal_event = match terminal {
        TerminalFixture::Completed => TriageRunEventPayloadV2::Completed {
            result: Box::new(result),
        },
        TerminalFixture::Failed => TriageRunEventPayloadV2::Failed {
            category: "provider_unavailable".into(),
            partial_result: Some(Box::new(result)),
        },
        TerminalFixture::TimedOut => TriageRunEventPayloadV2::TimedOut {
            category: "whole_turn_deadline".into(),
            partial_result: Some(Box::new(result)),
        },
        TerminalFixture::Cancelled => TriageRunEventPayloadV2::Cancelled {
            cancellation_id: request.cancellation_id.clone(),
            partial_result: Some(Box::new(result)),
        },
    };
    TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: run_id.into(),
        request_fingerprint: fingerprint.clone(),
        events: vec![
            event(
                run_id,
                0,
                TriageRunEventPayloadV2::RunStarted {
                    request_fingerprint: fingerprint,
                    policy_fingerprint: "sha256:policy-fixture".into(),
                },
            ),
            event(
                run_id,
                1,
                TriageRunEventPayloadV2::PacketReady {
                    packet_id: "packet:runtime:1".into(),
                    packet_digest: "sha256:packet-fixture".into(),
                    evidence_count: 2,
                },
            ),
            event(
                run_id,
                2,
                TriageRunEventPayloadV2::RoleAttempt {
                    attempt: TriageRoleAttemptV1 {
                        attempt_id: "attempt:standard:1".into(),
                        role_slot_id: "standard-finalizer".into(),
                        role: TriageSlotKindV2::Finalizer,
                        model: Some(model()),
                        status: TriageAttemptStatus::Completed,
                        reason_codes: Vec::new(),
                        elapsed_ms: 10,
                        input_chars: 50,
                        output_chars: 20,
                        physical_provider_calls: None,
                        semantic_corrections: None,
                        terminal_disposition: Some(TriageTerminalDispositionV1::Completed),
                    },
                },
            ),
            event(
                run_id,
                3,
                TriageRunEventPayloadV2::Reconciliation {
                    summary: reconciliation(),
                },
            ),
            event(
                run_id,
                4,
                TriageRunEventPayloadV2::Validation {
                    passed: false,
                    reason_codes: vec!["root_cause_not_established".into()],
                },
            ),
            event(run_id, 5, terminal_event),
        ],
    }
}

struct MockEngine {
    replay: TriageReplayV1,
    calls: Arc<Mutex<Vec<&'static str>>>,
    cancellation_calls: Arc<AtomicUsize>,
}

impl MockEngine {
    fn new(replay: TriageReplayV1) -> Self {
        Self {
            replay,
            calls: Arc::new(Mutex::new(Vec::new())),
            cancellation_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl TriageEngine for MockEngine {
    type Preflight = &'static str;

    async fn preflight(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<Self::Preflight, TriageEngineFailure> {
        assert!(request.fingerprint().starts_with("sha256:"));
        self.calls.lock().unwrap().push("preflight");
        Ok("authorized")
    }

    async fn execute(
        &self,
        request: ValidatedTriageRequest,
        preflight: Self::Preflight,
        mut events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure> {
        assert_eq!(preflight, "authorized");
        assert_eq!(request.request().run_id, self.replay.run_id);
        self.calls.lock().unwrap().push("execute");
        if let Some(sink) = &mut events {
            for event in &self.replay.events {
                sink.emit(event)?;
            }
        }
        Ok(self.replay.clone())
    }

    fn cancel(&self, _cancellation: &TriageCancellationV1) -> Result<(), TriageEngineFailure> {
        self.cancellation_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct CancellableEngine {
    replay: TriageReplayV1,
    started: AtomicBool,
    cancelled: AtomicBool,
}

#[async_trait]
impl TriageEngine for CancellableEngine {
    type Preflight = ();

    async fn preflight(
        &self,
        _request: &ValidatedTriageRequest,
    ) -> Result<Self::Preflight, TriageEngineFailure> {
        Ok(())
    }

    async fn execute(
        &self,
        _request: ValidatedTriageRequest,
        _preflight: Self::Preflight,
        _events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure> {
        std::future::poll_fn(|_| {
            self.started.store(true, Ordering::SeqCst);
            if self.cancelled.load(Ordering::SeqCst) {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
        Ok(self.replay.clone())
    }

    fn cancel(&self, _cancellation: &TriageCancellationV1) -> Result<(), TriageEngineFailure> {
        self.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn canonical_fingerprint_is_recursive_and_semantic() {
    let mut left_nested = Map::new();
    left_nested.insert("beta".into(), json!(2));
    left_nested.insert("alpha".into(), json!(1));
    let mut left = Map::new();
    left.insert("settings".into(), Value::Object(left_nested));
    left.insert("schema_id".into(), json!(TRIAGE_POLICY_SCHEMA_V2));

    let mut right_nested = Map::new();
    right_nested.insert("alpha".into(), json!(1));
    right_nested.insert("beta".into(), json!(2));
    let mut right = Map::new();
    right.insert("schema_id".into(), json!(TRIAGE_POLICY_SCHEMA_V2));
    right.insert("settings".into(), Value::Object(right_nested));

    let left_request = inline_request_with_document(Value::Object(left));
    let right_request = inline_request_with_document(Value::Object(right));
    let left_fingerprint = canonical_request_fingerprint(&left_request).unwrap();
    assert_eq!(
        left_fingerprint,
        canonical_request_fingerprint(&right_request).unwrap()
    );
    assert_eq!(left_fingerprint.len(), "sha256:".len() + 64);
    assert_eq!(
        canonical_request_fingerprint(&standard_request()).unwrap(),
        "sha256:fc59e4c71f00eb9f8811adcae0ff53d87747d4d48d08e97b5f004eea58b88efc"
    );

    let mut different_run = standard_request();
    different_run.run_id = "run:runtime:derived".into();
    assert_eq!(
        canonical_request_fingerprint(&standard_request()).unwrap(),
        canonical_request_fingerprint(&different_run).unwrap()
    );

    let mut changed = right_request;
    changed.task.push_str(" Include the deployment boundary.");
    assert_ne!(
        left_fingerprint,
        canonical_request_fingerprint(&changed).unwrap()
    );
}

#[test]
fn validated_request_can_only_expose_its_validated_identity() {
    let request = standard_request();
    let validated = ValidatedTriageRequest::new(request.clone()).unwrap();
    assert_eq!(validated.request(), &request);
    assert_eq!(
        validated.fingerprint(),
        canonical_request_fingerprint(&request).unwrap()
    );

    let mut invalid = request;
    invalid.task.clear();
    assert!(matches!(
        ValidatedTriageRequest::new(invalid),
        Err(TriageRuntimeError::InvalidRequest(
            TriageContractError::InvalidField("task")
        ))
    ));
}

#[test]
fn standard_facade_preflights_then_executes_and_streams_provisional_events() {
    let request = standard_request();
    let validated = ValidatedTriageRequest::new(request.clone()).unwrap();
    let replay = replay_for(&request, TerminalFixture::Completed);
    let event_count = replay.events.len();
    let engine = MockEngine::new(replay);
    let streamed = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&streamed);
    let sink = TriageEventSink::new(&validated, move |event| {
        captured.lock().unwrap().push(event.sequence);
    });

    let execution = block_on(triage(&engine, request, Some(sink))).unwrap();
    assert!(matches!(
        execution.terminal(),
        TriageExecutionTerminal::Completed { .. }
    ));
    assert_eq!(
        engine.calls.lock().unwrap().as_slice(),
        ["preflight", "execute"]
    );
    assert_eq!(streamed.lock().unwrap().len(), event_count);
}

#[test]
fn policy_facade_accepts_saved_and_inline_requests() {
    for request in [saved_request(), inline_request()] {
        let replay = replay_for(&request, TerminalFixture::Completed);
        let engine = MockEngine::new(replay);
        block_on(triage_with_policy(&engine, request, None)).unwrap();
        assert_eq!(
            engine.calls.lock().unwrap().as_slice(),
            ["preflight", "execute"]
        );
    }
}

#[test]
fn dispatch_guards_fail_before_preflight() {
    let standard = standard_request();
    let standard_engine = MockEngine::new(replay_for(&standard, TerminalFixture::Completed));
    assert_eq!(
        block_on(triage_with_policy(&standard_engine, standard, None)).unwrap_err(),
        TriageRuntimeError::ConfiguredPolicyRequired
    );
    assert!(standard_engine.calls.lock().unwrap().is_empty());

    let inline = inline_request();
    let inline_engine = MockEngine::new(replay_for(&inline, TerminalFixture::Completed));
    assert_eq!(
        block_on(triage(&inline_engine, inline, None)).unwrap_err(),
        TriageRuntimeError::StandardPolicyRequired
    );
    assert!(inline_engine.calls.lock().unwrap().is_empty());

    let mut invalid_inline = inline_request();
    invalid_inline.task.clear();
    let invalid_engine = MockEngine::new(replay_for(&inline_request(), TerminalFixture::Completed));
    assert!(matches!(
        block_on(triage(&invalid_engine, invalid_inline, None)),
        Err(TriageRuntimeError::InvalidRequest(
            TriageContractError::InvalidField("task")
        ))
    ));
    assert!(invalid_engine.calls.lock().unwrap().is_empty());
}

#[test]
fn mismatched_event_sink_fails_before_preflight() {
    let request = standard_request();
    let mut other = request.clone();
    other.run_id = "run:runtime:other".into();
    let other = ValidatedTriageRequest::new(other).unwrap();
    let sink = TriageEventSink::new(&other, |_| {});
    let engine = MockEngine::new(replay_for(&request, TerminalFixture::Completed));

    assert_eq!(
        block_on(triage(&engine, request, Some(sink))).unwrap_err(),
        TriageRuntimeError::EventSinkRequestMismatch
    );
    assert!(engine.calls.lock().unwrap().is_empty());
}

#[test]
fn typed_terminal_preserves_all_four_states_and_partial_results() {
    let request = standard_request();
    let completed = replay(
        request.clone(),
        replay_for(&request, TerminalFixture::Completed),
    )
    .unwrap();
    assert!(matches!(
        completed.terminal(),
        TriageExecutionTerminal::Completed { result }
            if result.kind == TriageResultKind::HonestPartial
    ));

    let failed = replay(
        request.clone(),
        replay_for(&request, TerminalFixture::Failed),
    )
    .unwrap();
    assert!(matches!(
        failed.terminal(),
        TriageExecutionTerminal::Failed {
            category,
            partial_result: Some(result),
        } if category == "provider_unavailable" && result.kind == TriageResultKind::HonestPartial
    ));

    let timed_out = replay(
        request.clone(),
        replay_for(&request, TerminalFixture::TimedOut),
    )
    .unwrap();
    assert!(matches!(
        timed_out.terminal(),
        TriageExecutionTerminal::TimedOut {
            category,
            partial_result: Some(result),
        } if category == "whole_turn_deadline" && result.kind == TriageResultKind::HonestPartial
    ));

    let cancelled = replay(
        request.clone(),
        replay_for(&request, TerminalFixture::Cancelled),
    )
    .unwrap();
    assert!(matches!(
        cancelled.terminal(),
        TriageExecutionTerminal::Cancelled {
            cancellation_id,
            partial_result: Some(result),
        } if cancellation_id == &request.cancellation_id
            && result.kind == TriageResultKind::HonestPartial
    ));
}

#[test]
fn replay_refuses_run_fingerprint_and_terminal_identity_mismatches() {
    let request = standard_request();

    let mut wrong_run = replay_for(&request, TerminalFixture::Completed);
    wrong_run.run_id = "run:runtime:other".into();
    for event in &mut wrong_run.events {
        event.run_id = wrong_run.run_id.clone();
        if let TriageRunEventPayloadV2::Completed { result } = &mut event.event {
            result.run_id = wrong_run.run_id.clone();
        }
    }
    assert_eq!(
        replay(request.clone(), wrong_run).unwrap_err(),
        TriageRuntimeError::ReplayRunIdentityMismatch
    );

    let mut wrong_fingerprint = replay_for(&request, TerminalFixture::Completed);
    wrong_fingerprint.request_fingerprint = "sha256:different-request".into();
    if let TriageRunEventPayloadV2::RunStarted {
        request_fingerprint,
        ..
    } = &mut wrong_fingerprint.events[0].event
    {
        *request_fingerprint = wrong_fingerprint.request_fingerprint.clone();
    }
    assert_eq!(
        replay(request.clone(), wrong_fingerprint).unwrap_err(),
        TriageRuntimeError::ReplayRequestFingerprintMismatch
    );

    let mut wrong_terminal = replay_for(&request, TerminalFixture::Completed);
    if let TriageRunEventPayloadV2::Completed { result } =
        &mut wrong_terminal.events.last_mut().unwrap().event
    {
        result.run_id = "run:runtime:other".into();
    }
    assert_eq!(
        replay(request, wrong_terminal).unwrap_err(),
        TriageRuntimeError::InvalidReplay(TriageContractError::RunIdentityMismatch)
    );
}

#[test]
fn replay_refuses_cross_event_packet_model_reconciliation_and_validation_drift() {
    let request = standard_request();

    let mut wrong_packet = replay_for(&request, TerminalFixture::Completed);
    if let TriageRunEventPayloadV2::PacketReady { packet_id, .. } =
        &mut wrong_packet.events[1].event
    {
        *packet_id = "packet:runtime:other".into();
    }
    assert_eq!(
        replay(request.clone(), wrong_packet).unwrap_err(),
        TriageRuntimeError::PacketIdentityMismatch
    );

    let mut wrong_model = replay_for(&request, TerminalFixture::Completed);
    if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &mut wrong_model.events[2].event {
        attempt.model = Some(ModelRef {
            profile_id: "profile:other".into(),
            model_id: "openai/gpt-oss-120b".into(),
        });
    }
    assert_eq!(
        replay(request.clone(), wrong_model).unwrap_err(),
        TriageRuntimeError::StandardAttemptBindingMismatch
    );

    let mut wrong_reconciliation = replay_for(&request, TerminalFixture::Completed);
    if let TriageRunEventPayloadV2::Completed { result } =
        &mut wrong_reconciliation.events.last_mut().unwrap().event
    {
        result.reconciliation.state = "different_but_valid".into();
    }
    assert_eq!(
        replay(request.clone(), wrong_reconciliation).unwrap_err(),
        TriageRuntimeError::ReconciliationMismatch
    );

    let mut wrong_validation = replay_for(&request, TerminalFixture::Completed);
    if let TriageRunEventPayloadV2::Validation { passed, .. } =
        &mut wrong_validation.events[4].event
    {
        *passed = true;
    }
    assert_eq!(
        replay(request, wrong_validation).unwrap_err(),
        TriageRuntimeError::ValidationResultMismatch
    );

    let configured_request = inline_request();
    let mut preliminary_cancel = replay_for(&configured_request, TerminalFixture::Cancelled);
    if let TriageRunEventPayloadV2::RoleAttempt { attempt } =
        &mut preliminary_cancel.events[2].event
    {
        attempt.role_slot_id = "contributor-observation".into();
        attempt.role = TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor);
    }
    preliminary_cancel.events[3].event = TriageRunEventPayloadV2::PreliminaryReconciliation {
        summary: reconciliation(),
    };
    preliminary_cancel.events.remove(4);
    preliminary_cancel.events[4].sequence = 4;
    if let TriageRunEventPayloadV2::Cancelled {
        partial_result: Some(result),
        ..
    } = &mut preliminary_cancel.events[4].event
    {
        result.reconciliation.state = "different_but_valid".into();
    }
    assert_eq!(
        replay(configured_request, preliminary_cancel).unwrap_err(),
        TriageRuntimeError::ReconciliationMismatch
    );
}

#[test]
fn post_validation_cancel_or_deadline_can_only_downgrade_the_terminal() {
    let request = standard_request();
    for terminal in [TerminalFixture::Cancelled, TerminalFixture::TimedOut] {
        let mut interrupted = replay_for(&request, terminal);
        if let TriageRunEventPayloadV2::Validation { passed, .. } = &mut interrupted.events[4].event
        {
            *passed = true;
        }
        match &mut interrupted.events[5].event {
            TriageRunEventPayloadV2::Cancelled {
                partial_result: Some(result),
                ..
            } => {
                result.validation_state = TriageValidationState::Failed;
                result.reason_codes.push("cancelled".into());
            }
            TriageRunEventPayloadV2::TimedOut {
                category,
                partial_result: Some(result),
            } => {
                *category = "deadline".into();
                result.validation_state = TriageValidationState::Failed;
                result.reason_codes.push("deadline".into());
            }
            _ => unreachable!(),
        }
        replay(request.clone(), interrupted)
            .expect("a typed interruption may supersede a passed validation checkpoint");
    }

    let mut failed = replay_for(&request, TerminalFixture::Failed);
    if let TriageRunEventPayloadV2::Validation { passed, .. } = &mut failed.events[4].event {
        *passed = true;
    }
    if let TriageRunEventPayloadV2::Failed {
        partial_result: Some(result),
        ..
    } = &mut failed.events[5].event
    {
        result.validation_state = TriageValidationState::Failed;
        result.reason_codes.push("cancelled".into());
    }
    assert_eq!(
        replay(request, failed).unwrap_err(),
        TriageRuntimeError::ValidationResultMismatch
    );
}

#[test]
fn replay_refuses_malformed_order_and_cancellation_identity() {
    let request = standard_request();
    let mut malformed = replay_for(&request, TerminalFixture::Completed);
    malformed.events[2].sequence = 99;
    assert_eq!(
        replay(request.clone(), malformed).unwrap_err(),
        TriageRuntimeError::InvalidReplay(TriageContractError::NonContiguousSequence)
    );

    let mut wrong_cancel = replay_for(&request, TerminalFixture::Cancelled);
    if let TriageRunEventPayloadV2::Cancelled {
        cancellation_id, ..
    } = &mut wrong_cancel.events.last_mut().unwrap().event
    {
        *cancellation_id = "cancel:runtime:other".into();
    }
    assert_eq!(
        replay(request, wrong_cancel).unwrap_err(),
        TriageRuntimeError::CancellationIdentityMismatch
    );
}

#[test]
fn cancellation_is_validated_before_engine_dispatch() {
    let request = standard_request();
    let validated = ValidatedTriageRequest::new(request.clone()).unwrap();
    let engine = MockEngine::new(replay_for(&request, TerminalFixture::Completed));
    let valid = TriageCancellationV1 {
        schema_id: TRIAGE_CANCELLATION_SCHEMA_V1.into(),
        run_id: request.run_id.clone(),
        cancellation_id: request.cancellation_id.clone(),
    };
    cancel(&engine, &validated, &valid).unwrap();
    assert_eq!(engine.cancellation_calls.load(Ordering::SeqCst), 1);

    let mut wrong_request = valid.clone();
    wrong_request.run_id = "run:runtime:other".into();
    assert_eq!(
        cancel(&engine, &validated, &wrong_request).unwrap_err(),
        TriageRuntimeError::CancellationRequestMismatch
    );
    assert_eq!(engine.cancellation_calls.load(Ordering::SeqCst), 1);

    let mut invalid = valid;
    invalid.schema_id = "contextdesk.triage.cancellation.v0".into();
    assert!(matches!(
        cancel(&engine, &validated, &invalid),
        Err(TriageRuntimeError::InvalidCancellation(_))
    ));
    assert_eq!(engine.cancellation_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn cancellation_can_run_concurrently_with_execution() {
    let request = standard_request();
    let validated = ValidatedTriageRequest::new(request.clone()).unwrap();
    let cancellation = TriageCancellationV1 {
        schema_id: TRIAGE_CANCELLATION_SCHEMA_V1.into(),
        run_id: request.run_id.clone(),
        cancellation_id: request.cancellation_id.clone(),
    };
    let engine = Arc::new(CancellableEngine {
        replay: replay_for(&request, TerminalFixture::Cancelled),
        started: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    });
    let worker_engine = Arc::clone(&engine);
    let worker =
        std::thread::spawn(move || block_on(triage(worker_engine.as_ref(), request, None)));

    while !engine.started.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    cancel(engine.as_ref(), &validated, &cancellation).unwrap();
    let execution = worker.join().unwrap().unwrap();
    assert!(matches!(
        execution.terminal(),
        TriageExecutionTerminal::Cancelled { .. }
    ));
}

#[test]
fn event_sink_rejects_invalid_events_without_forwarding() {
    let request = standard_request();
    let validated = ValidatedTriageRequest::new(request.clone()).unwrap();
    let seen = Arc::new(AtomicUsize::new(0));
    let captured = Arc::clone(&seen);
    let mut sink = TriageEventSink::new(&validated, move |_| {
        captured.fetch_add(1, Ordering::SeqCst);
    });
    let mut invalid = replay_for(&request, TerminalFixture::Completed).events[0].clone();
    invalid.schema_id = "contextdesk.triage.run_event.v1".into();
    assert!(sink.emit(&invalid).is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 0);

    let first = replay_for(&request, TerminalFixture::Completed).events[0].clone();
    let mut wrong_run = first.clone();
    wrong_run.run_id = "run:runtime:other".into();
    assert!(sink.emit(&wrong_run).is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 0);

    let mut wrong_fingerprint = first.clone();
    if let TriageRunEventPayloadV2::RunStarted {
        request_fingerprint,
        ..
    } = &mut wrong_fingerprint.event
    {
        *request_fingerprint = "sha256:other-request".into();
    }
    assert!(sink.emit(&wrong_fingerprint).is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 0);

    sink.emit(&first).unwrap();
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert!(sink.emit(&first).is_err());
    assert_eq!(seen.load(Ordering::SeqCst), 1);
}
