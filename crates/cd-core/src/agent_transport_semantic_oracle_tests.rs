//! Transport-retry vs semantic-attempt oracle — candidate/comparison stage.
//!
//! `run_multi_stage_broad_triage` and `MultiStageTriageOutcome` are private,
//! so these tests live inside the `agent` module (hooked via `#[path]` at the
//! bottom of `agent.rs`). Unlike the sibling `mod tests`, every provider
//! round here crosses a REAL wire: the exact production
//! `research::backend_for` OpenAI-compatible backend against a scripted
//! wiremock provider, so the bounded 429 transport budget, the candidate
//! attempt cap, and the comparison attempt cap are exercised together.
//!
//! Tests whose doc comment says `RED (known gap at base)` are expected to
//! FAIL on the audited base commit; each is paired with a green control so a
//! degenerate implementation cannot pass the pair.

use super::*;
use crate::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use crate::research::backend_for;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{method, path as url_path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

#[derive(Clone, Copy)]
enum OracleWireStep {
    RateLimited { retry_after: &'static str },
    Answer(&'static str),
}

struct OracleSequenceResponder {
    calls: Arc<AtomicUsize>,
    steps: Vec<OracleWireStep>,
}

impl Respond for OracleSequenceResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .get(index)
            .copied()
            .unwrap_or_else(|| *self.steps.last().expect("non-empty script"));
        match step {
            OracleWireStep::RateLimited { retry_after } => ResponseTemplate::new(429)
                .set_body_string(r#"{"error":{"message":"provider rate limited"}}"#)
                .insert_header("retry-after", retry_after),
            OracleWireStep::Answer(content) => ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_json(serde_json::json!({
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content}
                    }]
                })),
        }
    }
}

async fn mount_oracle_steps(server: &MockServer, steps: Vec<OracleWireStep>) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(url_path("/v1/chat/completions"))
        .respond_with(OracleSequenceResponder {
            calls: calls.clone(),
            steps,
        })
        .mount(server)
        .await;
    calls
}

async fn wire_backend(base_url: &str) -> Box<dyn ChatBackend> {
    backend_for(
        &ProviderProfile {
            id: "oracle-openai-compatible".into(),
            label: "oracle OpenAI-compatible".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: base_url.into(),
            api_key_ref: None,
            chat_model: "oracle-test-model".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities::chat_remote(),
            local_only: true,
            deadline_preference: Default::default(),
        },
        None,
    )
    .await
    .expect("backend construction")
}

fn oracle_candidate(group_id: &str, seq: u64) -> crate::tool_host::BroadLogTriageCandidate {
    let source = format!("{group_id}.log");
    let identity = crate::log_analysis::SearchEvidenceIdentity {
        seq,
        source,
        citation_source: None,
        template_id: seq,
    };
    crate::tool_host::BroadLogTriageCandidate {
        group_id: group_id.into(),
        structural_kind: "trace",
        model_text: format!(
            "source_kind: deterministic_broad_log_candidate\ngroup_id: {group_id}\n- seq={seq} source={} template_id={seq}\n",
            identity.source
        ),
        evidence: vec![identity.clone()],
        evidence_excerpts: std::collections::HashMap::from([(
            identity,
            format!("bounded evidence for {group_id}"),
        )]),
    }
}

const DRAFT_ALPHA: &str = r#"{"schema":"contextdesk.candidate_assessment.v1","candidate_id":"trace:alpha","classification":"supporting_evidence","analysis":"trace alpha is an operational incident","evidence_seqs":[11]}"#;
const DRAFT_BRAVO: &str = r#"{"schema":"contextdesk.candidate_assessment.v1","candidate_id":"trace:bravo","classification":"supporting_evidence","analysis":"trace bravo is an operational incident","evidence_seqs":[22]}"#;
const COMPARISON_VALID: &str = r#"{"schema":"contextdesk.investigation_answer.v1","candidates":[{"candidate_id":"trace:alpha","observations":[{"claim_id":"a","text":"observed","evidence_ids":["e:trace:alpha:11"]}]},{"candidate_id":"trace:bravo","observations":[{"claim_id":"b","text":"observed","evidence_ids":["e:trace:bravo:22"]}]}]}"#;

fn two_candidates() -> Vec<crate::tool_host::BroadLogTriageCandidate> {
    vec![
        oracle_candidate("trace:alpha", 11),
        oracle_candidate("trace:bravo", 22),
    ]
}

async fn run_two_candidate_triage(
    backend: &dyn ChatBackend,
    opts: &AgentOptions,
) -> (
    CoreResult<MultiStageTriageOutcome>,
    Vec<crate::context_budgeting::ContextBudgetTelemetry>,
) {
    let clock = TurnClock::new(opts.effective_deadline_plan(), None);
    let candidates = two_candidates();
    let mut contexts = Vec::new();
    let outcome = run_multi_stage_broad_triage(
        backend,
        "triage this broad corpus",
        opts,
        &clock,
        MultiStageTriageEvidence {
            candidates: &candidates,
            comparison_context: None,
            binding: crate::investigation_answer::AnswerBindingV1 {
                session_id: "s".into(),
                turn_id: "t".into(),
                corpus_id: "c".into(),
                revision: crate::investigation_answer::LogSnapshotRevisionV1 {
                    event_revision: 1,
                    template_analysis_revision: 2,
                    suppression_revision: 3,
                },
                ledger_digest: String::new(),
            },
        },
        &mut |signal| {
            if let MultiStageHostSignal::Context(telemetry) = signal {
                contexts.push(telemetry);
            }
        },
    )
    .await;
    (outcome, contexts)
}

/// Scenario 1/9 at the candidate stage: two 429s inside the FIRST candidate
/// call are transport attempts within that candidate's first (and only)
/// semantic attempt. No correction attempt is spent, no candidate is
/// rejected, and `provider_rounds` counts completed analyses only.
#[tokio::test]
async fn candidate_stage_transport_retries_stay_within_one_candidate_attempt() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(
        &server,
        vec![
            OracleWireStep::RateLimited { retry_after: "0" },
            OracleWireStep::RateLimited { retry_after: "0" },
            OracleWireStep::Answer(DRAFT_ALPHA),
            OracleWireStep::Answer(DRAFT_BRAVO),
            OracleWireStep::Answer(COMPARISON_VALID),
        ],
    )
    .await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        ..Default::default()
    };
    let (outcome, contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        5,
        "3 transport attempts for candidate alpha + 1 for bravo + 1 comparison"
    );
    match outcome.expect("triage completes") {
        MultiStageTriageOutcome::Completed {
            accepted_groups,
            rejected_groups,
            provider_rounds,
            ..
        } => {
            assert_eq!(accepted_groups, vec!["trace:alpha", "trace:bravo"]);
            assert!(
                rejected_groups.is_empty(),
                "no candidate was rejected by a rate limit"
            );
            assert_eq!(
                provider_rounds, 3,
                "provider rounds count completed analyses, never transport attempts"
            );
            assert_eq!(contexts.len(), provider_rounds);
        }
        other => panic!("expected completed triage, got {other:?}"),
    }
}

/// Comparison-stage variant: a 429 retry inside the comparison call recovers
/// within the SAME comparison attempt — the strict first-attempt validation
/// still applies to the recovered response.
#[tokio::test]
async fn comparison_stage_transport_retry_stays_within_the_first_comparison_attempt() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(
        &server,
        vec![
            OracleWireStep::Answer(DRAFT_ALPHA),
            OracleWireStep::Answer(DRAFT_BRAVO),
            OracleWireStep::RateLimited { retry_after: "0" },
            OracleWireStep::Answer(COMPARISON_VALID),
        ],
    )
    .await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        ..Default::default()
    };
    let (outcome, contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;

    assert_eq!(wire_calls.load(Ordering::SeqCst), 4);
    match outcome.expect("triage completes") {
        MultiStageTriageOutcome::Completed {
            provider_rounds, ..
        } => {
            assert_eq!(provider_rounds, 3);
            assert_eq!(contexts.len(), 3);
        }
        other => panic!("expected completed triage, got {other:?}"),
    }
}

/// Scenario 2 at the candidate stage, green half: exhausted 429s are NOT a
/// rejected candidate and NOT an invalid analysis. It must never surface
/// `FailedClosed` (which the caller maps to `linked_invalid_grounded_answer`),
/// and whichever way the failure reaches the caller — the raw error base
/// produced, or the typed `ProviderFailed` its RED sibling demands — the
/// surfaced message still names the rate limit and still borrows no
/// analysis vocabulary.
#[tokio::test]
async fn candidate_stage_429_exhaustion_never_rejects_the_candidate() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(
        &server,
        vec![OracleWireStep::RateLimited { retry_after: "0" }],
    )
    .await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        ..Default::default()
    };
    let (outcome, contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "the bounded transport budget is spent exactly once — no per-candidate replay"
    );
    assert_eq!(
        contexts.len(),
        1,
        "only the one entered candidate call published context telemetry"
    );
    match outcome {
        Ok(MultiStageTriageOutcome::FailedClosed { reason, .. }) => panic!(
            "an exhausted rate limit must never be classified as failed candidate \
             validation (got FailedClosed({reason:?}))"
        ),
        Ok(MultiStageTriageOutcome::Completed { .. }) => {
            panic!("an exhausted rate limit cannot complete a triage")
        }
        Ok(MultiStageTriageOutcome::ProviderFailed(error)) => {
            assert_provider_rate_limit_language(&error);
        }
        Ok(other) => panic!("unexpected typed outcome: {other:?}"),
        Err(error) => assert_provider_rate_limit_language(&error),
    }
}

/// Both the typed and the raw form must name the rate limit and must not
/// borrow the vocabulary of a failed analysis.
fn assert_provider_rate_limit_language(error: &CoreError) {
    let message = error.to_string();
    assert!(
        message.contains("HTTP 429"),
        "the surfaced error must keep naming the rate limit, got {message:?}"
    );
    let lowered = message.to_ascii_lowercase();
    for forbidden in ["candidate", "rejected", "evidence", "invalid", "analysis"] {
        assert!(
            !lowered.contains(forbidden),
            "rate-limit exhaustion must not borrow analysis vocabulary \
             ({forbidden:?} in {message:?})"
        );
    }
}

/// Scenario 2 at the candidate stage, RED half.
///
/// RED (known gap at base): a provider failure inside
/// `run_multi_stage_broad_triage` is `?`-propagated (agent.rs candidate and
/// comparison loops), and the call site `.await?`s it — so an exhausted rate
/// limit aborts the whole turn as a raw `Err` instead of the typed
/// provider-failure terminal every other linked provider failure receives
/// (`terminal_linked_provider_failure`). The contract pinned here: the
/// outcome must be a typed classification the caller can convert into an
/// explicit provider/rate-limit event stream. Paired green control:
/// `candidate_stage_429_exhaustion_never_rejects_the_candidate`.
#[tokio::test]
async fn candidate_stage_429_exhaustion_is_a_typed_provider_outcome_not_an_escaped_err() {
    let server = MockServer::start().await;
    let _wire_calls = mount_oracle_steps(
        &server,
        vec![OracleWireStep::RateLimited { retry_after: "0" }],
    )
    .await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        ..Default::default()
    };
    let (outcome, _contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;

    assert!(
        outcome.is_ok(),
        "RED (known gap at base): candidate-stage provider exhaustion must resolve to a \
         typed MultiStageTriageOutcome (so the caller can emit an explicit \
         provider/rate-limit terminal like the single-stage path does) — instead the \
         error escaped the whole turn: {:?}",
        outcome.err()
    );
}

/// Scenario 5 at the candidate stage, green control: a cancellation that is
/// already visible when the provider round starts is a typed `Cancelled`
/// outcome. (This is the pair that keeps the RED test below honest: an
/// implementation that never cancels fails this one.)
#[tokio::test]
async fn candidate_stage_pre_set_cancellation_is_a_typed_cancelled_outcome() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(&server, vec![OracleWireStep::Answer(DRAFT_ALPHA)]).await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        cancel: Some(Arc::new(AtomicBool::new(true))),
        ..Default::default()
    };
    let (outcome, _contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;
    assert!(
        matches!(outcome, Ok(MultiStageTriageOutcome::Cancelled)),
        "a pre-set cancel flag must be a typed Cancelled outcome, got {outcome:?}"
    );
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        0,
        "a cancelled turn contacts no provider"
    );
}

/// Scenario 5 at the candidate stage, RED half.
///
/// RED (known gap at base): when cancellation lands while a provider call is
/// in flight, the transport notices first (its cancel poll) and returns
/// `Err("cancelled")` — which the candidate loop `?`-propagates instead of
/// classifying, so the SAME user action produces `Ok(Cancelled)` or an
/// escaped raw `Err` depending on which poll loop wins a 10ms-vs-20ms race.
/// The single-stage loop already classifies this exact error string as a
/// clean cancel (agent.rs `Err(e) if e.to_string().contains("cancelled")`).
/// This test forces the transport-wins arm deterministically with a scripted
/// backend that flips the flag itself and returns the transport's error.
#[tokio::test]
async fn candidate_stage_mid_flight_cancellation_is_cancelled_not_an_escaped_err() {
    struct TransportNoticesCancelBackend {
        cancel: Arc<AtomicBool>,
    }

    #[async_trait]
    impl ChatBackend for TransportNoticesCancelBackend {
        async fn complete(
            &self,
            _messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> CoreResult<ChatCompletion> {
            // Cancellation arrives mid-flight; the transport's cancel-aware
            // backoff observes it first and returns its "cancelled" error.
            self.cancel.store(true, Ordering::SeqCst);
            Err(CoreError::Message("cancelled".into()))
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let backend = TransportNoticesCancelBackend {
        cancel: cancel.clone(),
    };
    let opts = AgentOptions {
        max_rounds: 7,
        cancel: Some(cancel),
        ..Default::default()
    };
    let (outcome, _contexts) = run_two_candidate_triage(&backend, &opts).await;

    assert!(
        matches!(outcome, Ok(MultiStageTriageOutcome::Cancelled)),
        "RED (known gap at base): a cancellation observed by the transport mid-flight \
         must classify as the same typed Cancelled outcome as one observed by the turn \
         wrapper — instead the transport's error escaped the turn: {outcome:?}"
    );
}

/// Scenario 6 at the candidate stage: the whole-turn deadline stays
/// authoritative while the transport is parked in a 60-second Retry-After
/// backoff — typed `Deadline`, no further wire attempt, prompt return.
#[tokio::test]
async fn deadline_expiring_during_backoff_is_a_typed_deadline_outcome() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(
        &server,
        vec![OracleWireStep::RateLimited { retry_after: "60" }],
    )
    .await;

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 7,
        deadline_ms: 400,
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let (outcome, _contexts) = run_two_candidate_triage(backend.as_ref(), &opts).await;
    let elapsed = started.elapsed();

    assert!(
        matches!(outcome, Ok(MultiStageTriageOutcome::Deadline)),
        "deadline during backoff is a typed Deadline outcome, got {outcome:?}"
    );
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "the deadline must prevent any further transport attempt"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "the 400ms whole-turn deadline is authoritative over the 60s backoff, took {elapsed:?}"
    );
}

/// Scenario 6/10 — the SINGLE-STAGE path (the fallback the multi-stage path
/// defers to) obeys the same transport semantics: a whole-turn deadline
/// expiring during 429 backoff terminates as typed `budget_time`, never as a
/// completed or invalid analysis, with no further wire attempt.
#[tokio::test]
async fn single_stage_deadline_during_backoff_terminates_as_budget_time() {
    let server = MockServer::start().await;
    let wire_calls = mount_oracle_steps(
        &server,
        vec![OracleWireStep::RateLimited { retry_after: "60" }],
    )
    .await;

    let dir = tempfile::tempdir().expect("workspace dir");
    let workspace = crate::workspace::Workspace::new("t", vec![dir.path().to_path_buf()]);
    let index = crate::index::KeywordIndex::build(&workspace).expect("index");
    let mut host = crate::tool_host::ToolHost::new(workspace, index, None);

    let backend = wire_backend(&server.uri()).await;
    let opts = AgentOptions {
        max_rounds: 2,
        deadline_ms: 400,
        session_id: "oracle-single-stage-deadline".into(),
        ..Default::default()
    };
    let mut history = Vec::new();
    let started = std::time::Instant::now();
    let events = run_agent_turn(backend.as_ref(), &mut host, "hi there", &mut history, &opts)
        .await
        .expect("a deadline is a typed terminal event stream");
    let elapsed = started.elapsed();

    assert_eq!(wire_calls.load(Ordering::SeqCst), 1);
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "the 400ms deadline is authoritative over the 60s backoff, took {elapsed:?}"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::Error { code, .. } if code == "budget_time")));
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "budget_time")));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. })),
        "no answer text may be fabricated for a deadline-terminated turn"
    );
}
