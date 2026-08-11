//! Hermetic production-path suite for the host-grounded fast-triage route.
//!
//! Every test drives the **real** route driver
//! ([`cd_core::fast_triage::run_fast_triage_route`]) against a scripted
//! backend — never a second agent loop, a parallel validator, or a
//! diagnostic-only normalizer. There are no live providers, no credentials, no
//! keychain, no URLs, no private paths, and no generated bulk corpus: every
//! fixture is a handful of synthetic rows written inline so a reader can see
//! exactly what the host knew.
//!
//! The suite is organized around the two things that can go wrong with a fast
//! model — sloppy formatting and weak causal judgement — plus the honesty
//! properties the route owes an operator afterwards.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use cd_core::agent::ChatBackend;
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::error::{CoreError, CoreResult};
use cd_core::fast_triage::{
    run_fast_triage_route, FastTriageBudget, FastTriageClockCompatibility,
    FastTriageEscalationState, FastTriageEvidenceCategory, FastTriageFailureCategory,
    FastTriageFallback, FastTriageInputs, FastTriageNeighborhoodBudget, FastTriageOutcomeLabel,
    FastTriagePacketInputs, FastTriagePacketV1, FastTriageRouteOutcome, FastTriageRouteRecord,
    FastTriageRouteRejection, FastTriageRouteVerdict, FastTriageStage, FastTriageTelemetryV1,
    FastTriageWorkflowContract,
};
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    SCHEMA_V1,
};
use cd_core::tools::ToolSpec;
use serde_json::json;

// ---------------------------------------------------------------------------
// Scripted backend: records exactly what was sent, returns exactly what a
// fixture says. It is the only thing standing in for a provider.
// ---------------------------------------------------------------------------

enum Scripted {
    Content(String),
    Error(String),
    /// Sleep past the caller's deadline without ever answering.
    Stall,
    /// Set the shared cancel flag, then stall so the host's own flag — not
    /// provider error text — is what ends the attempt.
    CancelThenStall(Arc<AtomicBool>),
}

struct RecordingBackend {
    script: Mutex<std::collections::VecDeque<Scripted>>,
    calls: AtomicUsize,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}

impl RecordingBackend {
    fn new(script: Vec<Scripted>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            calls: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn content(bodies: &[&str]) -> Self {
        Self::new(
            bodies
                .iter()
                .map(|body| Scripted::Content((*body).to_string()))
                .collect(),
        )
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }

    fn request(&self, index: usize) -> Vec<ChatMessage> {
        self.seen
            .lock()
            .expect("seen")
            .get(index)
            .cloned()
            .unwrap_or_default()
    }

    /// The concatenated user-facing body of one recorded request.
    fn request_body(&self, index: usize) -> String {
        self.request(index)
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[async_trait]
impl ChatBackend for RecordingBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.seen.lock().expect("seen").push(messages.to_vec());
        let next = self.script.lock().expect("script").pop_front();
        match next {
            Some(Scripted::Content(body)) => {
                Ok(ChatCompletion::from_parts(body, Vec::new(), "stop"))
            }
            Some(Scripted::Error(message)) => Err(CoreError::Message(message)),
            Some(Scripted::Stall) => {
                tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
                Ok(ChatCompletion::from_parts("late", Vec::new(), "stop"))
            }
            Some(Scripted::CancelThenStall(flag)) => {
                flag.store(true, Ordering::Relaxed);
                tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
                Ok(ChatCompletion::from_parts("late", Vec::new(), "stop"))
            }
            None => Err(CoreError::Message("script exhausted".into())),
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture corpus: three candidate groups plus a separately scoped chronology.
// ---------------------------------------------------------------------------

const PROFILE: &str = "fixture-profile";
const MODEL: &str = "fixture-fast-model";
const FALLBACK_PROFILE: &str = "fixture-fallback-profile";
const FALLBACK_MODEL: &str = "fixture-fallback-model";

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 7,
        template_analysis_revision: 8,
        suppression_revision: 9,
    }
}

fn entry(
    candidate: &str,
    seq: u64,
    role: EvidenceRole,
    source: &str,
    content: &str,
) -> HostEvidenceEntry {
    HostEvidenceEntry {
        evidence_id: format!("e:{candidate}:{seq}"),
        candidate_id: candidate.into(),
        source_label: source.into(),
        locator: format!("seq={seq}"),
        corpus_id: "fixture-corpus".into(),
        revision: revision(),
        role,
        content: content.into(),
    }
}

fn ledger(entries: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
    let binding = AnswerBindingV1 {
        session_id: "fixture-session".into(),
        turn_id: "fixture-turn".into(),
        corpus_id: "fixture-corpus".into(),
        revision: revision(),
        ledger_digest: HostEvidenceLedger::digest(&entries),
    };
    HostEvidenceLedger::new(binding, entries).expect("fixture ledger")
}

/// The complete-timeline fixture the preserved research says a fast model can
/// answer correctly: one host-labelled initiating cause, one host-labelled
/// downstream symptom in a second group, and independent chronology that must
/// stay out of the chain.
fn complete_timeline_packet() -> FastTriagePacketV1 {
    packet_with_clock(FastTriageClockCompatibility::OrderOnly)
}

fn packet_with_clock(clock: FastTriageClockCompatibility) -> FastTriagePacketV1 {
    let entries = vec![
        entry(
            "trace:alpha",
            10,
            EvidenceRole::Cause,
            "app.log",
            "constraint violation on startup",
        ),
        entry(
            "trace:alpha",
            12,
            EvidenceRole::Neutral,
            "app.log",
            "retry scheduled",
        ),
        entry(
            "template:bravo",
            40,
            EvidenceRole::Symptom,
            "worker.log",
            "request rejected: dependency unavailable",
        ),
        entry(
            "global_timeline_context",
            11,
            EvidenceRole::Neutral,
            "app.log",
            "routine checkpoint written",
        ),
        entry(
            "global_timeline_context",
            41,
            EvidenceRole::Neutral,
            "metrics.log",
            "unrelated queue depth sample",
        ),
    ];
    FastTriagePacketV1::build(FastTriagePacketInputs {
        ledger: ledger(entries),
        independent_candidate_id: Some("global_timeline_context"),
        timeline_complete: true,
        clock,
        trace_correlated_candidates: &BTreeSet::from(["trace:alpha".to_string()]),
        neighborhood: FastTriageNeighborhoodBudget::default(),
    })
}

fn claim(id: &str, text: &str, evidence: &[&str]) -> serde_json::Value {
    json!({"claim_id": id, "text": text, "evidence_ids": evidence})
}

fn proposal(candidates: serde_json::Value) -> String {
    json!({"schema": SCHEMA_V1, "candidates": candidates}).to_string()
}

/// The answer a host would accept: the host-labelled cause is cited as a cause,
/// the host-labelled symptom stays a symptom, and the independent chronology is
/// only ever observed.
fn correct_answer() -> String {
    proposal(json!([
        {"candidate_id": "trace:alpha",
         "initiating_causes": [claim("c1", "startup constraint violation", &["e:trace:alpha:10"])],
         "observations": [claim("o1", "a retry followed", &["e:trace:alpha:12"])]},
        {"candidate_id": "template:bravo",
         "symptoms": [claim("s1", "requests rejected downstream", &["e:template:bravo:40"])]},
        {"candidate_id": "global_timeline_context",
         "observations": [
            claim("g1", "checkpoint written", &["e:global_timeline_context:11"]),
            claim("g2", "queue depth sampled", &["e:global_timeline_context:41"])
         ]},
    ]))
}

fn records() -> Vec<FastTriageRouteRecord> {
    vec![FastTriageRouteRecord {
        profile_id: PROFILE.into(),
        model_id: MODEL.into(),
        workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
        verdict: FastTriageRouteVerdict::Qualified,
        contract_fingerprint: cd_core::fast_triage::fast_triage_contract_fingerprint(),
    }]
}

struct Run<'a> {
    packet: &'a FastTriagePacketV1,
    records: Vec<FastTriageRouteRecord>,
    enabled: bool,
    profile_id: Option<&'a str>,
    model_id: Option<&'a str>,
    fallback: Option<FastTriageFallback>,
    deadline_ms: u64,
    cancel: Option<Arc<AtomicBool>>,
    max_corrections: u8,
}

impl<'a> Run<'a> {
    fn new(packet: &'a FastTriagePacketV1) -> Self {
        Self {
            packet,
            records: records(),
            enabled: true,
            profile_id: Some(PROFILE),
            model_id: Some(MODEL),
            fallback: None,
            deadline_ms: 0,
            cancel: None,
            max_corrections: 1,
        }
    }
}

/// Drive the real route and collect its stage events.
async fn drive(
    run: Run<'_>,
    primary: &RecordingBackend,
    fallback: Option<&RecordingBackend>,
) -> (FastTriageRouteOutcome, Vec<(FastTriageStage, bool)>) {
    let mut stages = Vec::new();
    let outcome = run_fast_triage_route(
        primary,
        fallback.map(|backend| backend as &dyn ChatBackend),
        FastTriageInputs {
            user_text: "what initiated this failure?",
            packet: run.packet,
            expected_packet_id: Some(run.packet.packet_id()),
            enabled: run.enabled,
            records: &run.records,
            profile_id: run.profile_id,
            model_id: run.model_id,
            fallback: run.fallback.as_ref(),
            budget: FastTriageBudget {
                deadline_ms: run.deadline_ms,
                max_corrections: run.max_corrections,
                ..FastTriageBudget::default()
            },
            started_at: None,
            cancel: run.cancel.clone(),
        },
        &mut |event| stages.push((event.stage, event.started)),
    )
    .await
    .expect("route driver must not propagate an error");
    (outcome, stages)
}

fn verified(outcome: &FastTriageRouteOutcome) -> (&str, &FastTriageTelemetryV1) {
    match outcome {
        FastTriageRouteOutcome::Verified {
            content, telemetry, ..
        } => (content.as_str(), telemetry),
        other => panic!("expected a verified answer, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 1. The answer the route exists to produce
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_complete_timeline_answer_is_verified_on_the_first_attempt() {
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::content(&[&correct_answer()]);
    let (outcome, stages) = drive(Run::new(&packet), &backend, None).await;

    let (content, telemetry) = verified(&outcome);
    assert_eq!(
        telemetry.outcome,
        FastTriageOutcomeLabel::VerifiedFastAnswer
    );
    assert_eq!(telemetry.provider_attempts, 1);
    assert!(!telemetry.correction_used);
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::NotRequested
    );
    assert_eq!(backend.calls(), 1);
    assert_eq!(
        stages,
        vec![
            (FastTriageStage::Primary, true),
            (FastTriageStage::Primary, false)
        ]
    );
    // The visible answer is the host's own projection of the validated
    // envelope, and it establishes the root because host cause-role evidence
    // supports it.
    assert!(content.contains("Root cause established: yes"));
    assert!(content.contains("e:trace:alpha:10"));
    assert!(!content.contains("<think>"));
}

#[tokio::test]
async fn the_request_carries_the_complete_packet_with_literal_host_ids() {
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::content(&[&correct_answer()]);
    drive(Run::new(&packet), &backend, None).await;

    let body = backend.request_body(0);
    for row in packet.rows() {
        assert!(
            body.contains(&row.evidence_id),
            "packet omitted host id {}",
            row.evidence_id
        );
    }
    // Typed role vocabulary and neighborhood vocabulary both reach the model.
    for expected in [
        "initiating_cause",
        "downstream_symptom",
        "unclassified",
        "context_category",
        "chronology_ordinal",
        "clock_compatibility",
    ] {
        assert!(body.contains(expected), "request omitted {expected}");
    }
}

// ---------------------------------------------------------------------------
// 2. Weak causal judgement — the failures the preserved research recorded
// ---------------------------------------------------------------------------

/// An answer that never places the host-labelled cause in a causal section.
fn omitted_trigger() -> String {
    proposal(json!([
        {"candidate_id": "trace:alpha",
         "observations": [claim("o1", "startup noise", &["e:trace:alpha:10", "e:trace:alpha:12"])]},
        {"candidate_id": "template:bravo",
         "symptoms": [claim("s1", "requests rejected", &["e:template:bravo:40"])]},
        {"candidate_id": "global_timeline_context",
         "observations": [claim("g1", "checkpoint", &["e:global_timeline_context:11"])]},
    ]))
}

/// An answer that promotes the host-labelled downstream symptom to a cause.
fn symptom_promoted() -> String {
    proposal(json!([
        {"candidate_id": "trace:alpha",
         "initiating_causes": [claim("c1", "constraint violation", &["e:trace:alpha:10"])]},
        {"candidate_id": "template:bravo",
         "causal_candidates": [claim("x1", "dependency unavailable caused it", &["e:template:bravo:40"])]},
        {"candidate_id": "global_timeline_context",
         "observations": [claim("g1", "checkpoint", &["e:global_timeline_context:11"])]},
    ]))
}

/// An answer that pulls independent telemetry into the causal chain.
fn independent_promoted() -> String {
    proposal(json!([
        {"candidate_id": "trace:alpha",
         "initiating_causes": [claim("c1", "constraint violation", &["e:trace:alpha:10"])]},
        {"candidate_id": "template:bravo",
         "symptoms": [claim("s1", "requests rejected", &["e:template:bravo:40"])]},
        {"candidate_id": "global_timeline_context",
         "symptoms": [claim("g1", "queue depth rose as a result", &["e:global_timeline_context:41"])]},
    ]))
}

#[tokio::test]
async fn each_recorded_causal_failure_is_caught_with_its_own_category() {
    for (name, body, expected) in [
        (
            "omitted trigger",
            omitted_trigger(),
            FastTriageFailureCategory::RoleCoverage,
        ),
        (
            "symptom promoted to cause",
            symptom_promoted(),
            FastTriageFailureCategory::SymptomPromotedToCause,
        ),
        (
            "independent telemetry promoted",
            independent_promoted(),
            FastTriageFailureCategory::IndependentEvidencePromoted,
        ),
    ] {
        let packet = complete_timeline_packet();
        // Two identical rejections: the bounded correction is consumed and the
        // route still refuses to pass it.
        let backend = RecordingBackend::content(&[&body, &body]);
        let (outcome, _) = drive(Run::new(&packet), &backend, None).await;
        let FastTriageRouteOutcome::EscalationRequested {
            categories,
            telemetry,
            ..
        } = &outcome
        else {
            panic!("{name}: expected an escalation request, got {outcome:?}");
        };
        assert!(
            categories.contains(&expected),
            "{name}: expected {expected:?}, got {categories:?}"
        );
        assert_eq!(telemetry.provider_attempts, 2, "{name}");
        assert!(telemetry.correction_used, "{name}");
    }
}

#[tokio::test]
async fn a_foreign_or_cross_candidate_id_never_reaches_an_answer() {
    // An id the host never minted, and an id the host minted for a *different*
    // candidate. Both are cited from a claim whose own candidate does not
    // permit them, which is the shape a fast model reaches for when it wants a
    // tidier story than the evidence supports.
    for (name, borrowed, expected) in [
        (
            "foreign id",
            "e:trace:alpha:9999",
            FastTriageFailureCategory::ForeignEvidenceId,
        ),
        (
            "cross-candidate id",
            "e:trace:alpha:12",
            FastTriageFailureCategory::CrossCandidateEvidence,
        ),
    ] {
        let packet = complete_timeline_packet();
        let body = proposal(json!([
            {"candidate_id": "trace:alpha",
             "initiating_causes": [claim("c1", "constraint violation", &["e:trace:alpha:10"])]},
            {"candidate_id": "template:bravo",
             "symptoms": [claim("s1", "requests rejected", &["e:template:bravo:40"])],
             "observations": [claim("o1", "borrowed evidence", &[borrowed])]},
            {"candidate_id": "global_timeline_context",
             "observations": [claim("g1", "checkpoint", &["e:global_timeline_context:11"])]},
        ]));
        let backend = RecordingBackend::content(&[&body, &body]);
        let (outcome, _) = drive(Run::new(&packet), &backend, None).await;
        let FastTriageRouteOutcome::EscalationRequested { categories, .. } = &outcome else {
            panic!("{name}: expected an escalation request, got {outcome:?}");
        };
        assert_eq!(categories, &[expected], "{name}");
    }
}

// ---------------------------------------------------------------------------
// 3. Sloppy formatting — never guessed into a pass
// ---------------------------------------------------------------------------

#[tokio::test]
async fn malformed_and_reasoning_only_terminals_are_distinct_and_never_pass() {
    for (name, body, expected) in [
        (
            "prose",
            "The initiating cause is clearly the startup error.".to_string(),
            FastTriageFailureCategory::MalformedTerminal,
        ),
        (
            "reasoning only",
            "<think>I should answer with JSON next turn</think>".to_string(),
            FastTriageFailureCategory::EmptyVisibleAnswer,
        ),
        (
            "empty",
            "   \n  ".to_string(),
            FastTriageFailureCategory::EmptyVisibleAnswer,
        ),
    ] {
        let packet = complete_timeline_packet();
        let backend = RecordingBackend::content(&[&body, &body]);
        let (outcome, _) = drive(Run::new(&packet), &backend, None).await;
        let FastTriageRouteOutcome::EscalationRequested {
            categories,
            telemetry,
            ..
        } = &outcome
        else {
            panic!("{name}: expected an escalation request, got {outcome:?}");
        };
        assert_eq!(categories, &[expected], "{name}");
        // Reasoning is accounted for, never carried.
        let serialized = serde_json::to_string(telemetry.as_ref()).expect("telemetry json");
        assert!(!serialized.contains("I should answer with JSON next turn"));
        if name == "reasoning only" {
            assert!(telemetry
                .attempts
                .iter()
                .all(|attempt| attempt.reasoning_present));
            assert!(telemetry
                .attempts
                .iter()
                .all(|attempt| attempt.reasoning_chars > 0));
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Exactly one bounded correction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_correction_can_succeed_and_is_host_authored_not_a_replay() {
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let backend = RecordingBackend::content(&[&rejected, &correct_answer()]);
    let (outcome, stages) = drive(Run::new(&packet), &backend, None).await;

    let (_, telemetry) = verified(&outcome);
    assert_eq!(
        telemetry.outcome,
        FastTriageOutcomeLabel::VerifiedAfterCorrection
    );
    assert!(telemetry.correction_used);
    assert_eq!(
        telemetry.correction_category,
        Some(FastTriageFailureCategory::SymptomPromotedToCause)
    );
    assert_eq!(telemetry.provider_attempts, 2);
    assert_eq!(
        stages,
        vec![
            (FastTriageStage::Primary, true),
            (FastTriageStage::Primary, false),
            (FastTriageStage::Correction, true),
            (FastTriageStage::Correction, false),
        ]
    );

    // The correction is the host's own instruction for one stable category …
    let corrected = backend.request_body(1);
    assert!(corrected.contains("HOST VALIDATION CATEGORY: symptom_promoted_to_cause"));
    assert!(
        corrected.contains(cd_core::fast_triage::correction_instruction(
            FastTriageFailureCategory::SymptomPromotedToCause
        ))
    );
    // … and the rejected proposal is never replayed as truth.
    assert!(!corrected.contains("dependency unavailable caused it"));
    assert!(!corrected.contains("\"claim_id\":\"x1\""));
    // Every other authorized input is byte-identical to the first request.
    let initial = backend.request(0);
    let retry = backend.request(1);
    assert_eq!(initial[0].content, retry[0].content, "contract changed");
    assert_eq!(initial[1].content, retry[1].content, "question changed");
    assert!(retry[2].content.contains(packet.packet_id()));
}

#[tokio::test]
async fn the_correction_is_bounded_at_one_however_config_is_set() {
    for requested in [1_u8, 3, 255] {
        let packet = complete_timeline_packet();
        let rejected = symptom_promoted();
        let backend =
            RecordingBackend::content(&[&rejected, &rejected, &rejected, &rejected, &rejected]);
        let mut run = Run::new(&packet);
        run.max_corrections = requested;
        let (outcome, _) = drive(run, &backend, None).await;
        assert!(matches!(
            outcome,
            FastTriageRouteOutcome::EscalationRequested { .. }
        ));
        assert_eq!(
            backend.calls(),
            2,
            "max_corrections={requested} must still send exactly one correction"
        );
    }
}

#[tokio::test]
async fn a_host_side_failure_never_earns_a_correction() {
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::content(&[&correct_answer()]);
    // A packet identity the host did not capture: the evidence changed under
    // the turn, so no provider call is issued at all.
    let mut stages = Vec::new();
    let outcome = run_fast_triage_route(
        &backend,
        None,
        FastTriageInputs {
            user_text: "q",
            packet: &packet,
            expected_packet_id: Some("a-different-packet-identity"),
            enabled: true,
            records: &records(),
            profile_id: Some(PROFILE),
            model_id: Some(MODEL),
            fallback: None,
            budget: FastTriageBudget::default(),
            started_at: None,
            cancel: None,
        },
        &mut |event| stages.push(event.stage),
    )
    .await
    .expect("route");
    let FastTriageRouteOutcome::Partial {
        categories,
        telemetry,
    } = &outcome
    else {
        panic!("expected an honest partial, got {outcome:?}");
    };
    assert_eq!(
        categories,
        &[FastTriageFailureCategory::PacketIdentityChanged]
    );
    assert_eq!(telemetry.provider_attempts, 0);
    assert_eq!(backend.calls(), 0, "a stale packet must not be sent");
    assert!(stages.is_empty());
}

// ---------------------------------------------------------------------------
// 5. Deadline and cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_deadline_ends_the_route_without_an_unvalidated_answer() {
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::new(vec![Scripted::Stall]);
    let mut run = Run::new(&packet);
    run.deadline_ms = 30;
    let (outcome, _) = drive(run, &backend, None).await;
    let FastTriageRouteOutcome::Deadline { telemetry } = &outcome else {
        panic!("expected a deadline, got {outcome:?}");
    };
    assert_eq!(telemetry.outcome, FastTriageOutcomeLabel::Deadline);
    // The attempt was issued, so it is counted honestly.
    assert_eq!(telemetry.provider_attempts, 1);
    assert!(!telemetry.outcome.is_verified());
}

#[tokio::test]
async fn cancellation_is_the_hosts_flag_not_provider_error_text() {
    // Cancelled before the route starts: no provider call at all.
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::content(&[&correct_answer()]);
    let flag = Arc::new(AtomicBool::new(true));
    let mut run = Run::new(&packet);
    run.cancel = Some(flag);
    let (outcome, _) = drive(run, &backend, None).await;
    assert!(matches!(outcome, FastTriageRouteOutcome::Cancelled { .. }));
    assert_eq!(backend.calls(), 0);

    // Cancelled mid-attempt: the host flag wins even though the transport is
    // still pending, and the outcome is Cancelled rather than ProviderFailed.
    let packet = complete_timeline_packet();
    let flag = Arc::new(AtomicBool::new(false));
    let backend = RecordingBackend::new(vec![Scripted::CancelThenStall(Arc::clone(&flag))]);
    let mut run = Run::new(&packet);
    run.cancel = Some(flag);
    let (outcome, _) = drive(run, &backend, None).await;
    let FastTriageRouteOutcome::Cancelled { telemetry } = &outcome else {
        panic!("expected cancellation, got {outcome:?}");
    };
    assert_eq!(telemetry.outcome, FastTriageOutcomeLabel::Cancelled);
    assert_eq!(backend.calls(), 1);
}

#[tokio::test]
async fn a_provider_failure_stays_a_provider_failure() {
    let packet = complete_timeline_packet();
    let backend = RecordingBackend::new(vec![Scripted::Error("upstream 503".into())]);
    let (outcome, _) = drive(Run::new(&packet), &backend, None).await;
    let FastTriageRouteOutcome::ProviderFailed { telemetry, .. } = &outcome else {
        panic!("expected a provider failure, got {outcome:?}");
    };
    assert_eq!(telemetry.outcome, FastTriageOutcomeLabel::ProviderFailed);
    // The provider's own wording never reaches share-safe telemetry.
    assert!(!telemetry.activity_detail().contains("upstream 503"));
}

// ---------------------------------------------------------------------------
// 6. Escalation: one, visible, with the unchanged packet
// ---------------------------------------------------------------------------

fn authorized_fallback() -> FastTriageFallback {
    FastTriageFallback {
        profile_id: FALLBACK_PROFILE.into(),
        model_id: FALLBACK_MODEL.into(),
        authorized: true,
    }
}

#[tokio::test]
async fn with_no_fallback_configured_the_unchanged_packet_is_handed_back() {
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let backend = RecordingBackend::content(&[&rejected, &rejected]);
    let (outcome, _) = drive(Run::new(&packet), &backend, None).await;

    let FastTriageRouteOutcome::EscalationRequested {
        packet: returned,
        categories,
        telemetry,
    } = &outcome
    else {
        panic!("expected an escalation request, got {outcome:?}");
    };
    assert_eq!(returned.packet_id(), packet.packet_id());
    assert_eq!(returned.rows(), packet.rows());
    assert!(!categories.is_empty());
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::NotConfigured
    );
    assert_eq!(
        telemetry.outcome,
        FastTriageOutcomeLabel::EscalationRequested
    );
}

#[tokio::test]
async fn an_unauthorized_fallback_is_never_called() {
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let primary = RecordingBackend::content(&[&rejected, &rejected]);
    let fallback = RecordingBackend::content(&[&correct_answer()]);
    let mut run = Run::new(&packet);
    run.fallback = Some(FastTriageFallback {
        authorized: false,
        ..authorized_fallback()
    });
    let (outcome, _) = drive(run, &primary, Some(&fallback)).await;

    let FastTriageRouteOutcome::EscalationRequested { telemetry, .. } = &outcome else {
        panic!("expected an escalation request, got {outcome:?}");
    };
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::NotAuthorized
    );
    assert_eq!(
        fallback.calls(),
        0,
        "a configured-but-unauthorized fallback must never receive the packet"
    );
    // The configured identity is still reported, so an operator can see what
    // *would* have been used.
    assert_eq!(
        telemetry.escalation.profile_id.as_deref(),
        Some(FALLBACK_PROFILE)
    );
}

#[tokio::test]
async fn an_authorized_escalation_succeeds_with_a_byte_identical_packet() {
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let primary = RecordingBackend::content(&[&rejected, &rejected]);
    let fallback = RecordingBackend::content(&[&correct_answer()]);
    let mut run = Run::new(&packet);
    run.fallback = Some(authorized_fallback());
    let (outcome, stages) = drive(run, &primary, Some(&fallback)).await;

    let (_, telemetry) = verified(&outcome);
    assert_eq!(
        telemetry.outcome,
        FastTriageOutcomeLabel::VerifiedAfterEscalation
    );
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::Succeeded
    );
    assert_eq!(
        telemetry.escalation.packet_id.as_deref(),
        Some(packet.packet_id())
    );
    assert_eq!(primary.calls(), 2);
    assert_eq!(fallback.calls(), 1, "escalation is exactly one attempt");
    assert_eq!(
        stages
            .iter()
            .filter(|(stage, _)| *stage == FastTriageStage::Escalation)
            .count(),
        2,
        "one started + one finished"
    );

    // The escalation received the *unchanged* packet: the evidence envelope and
    // the manifest are byte-identical to what the fast model saw.
    let sent_to_primary = primary.request(0);
    let sent_to_fallback = fallback.request(0);
    let evidence_of = |messages: &[ChatMessage]| {
        let body = messages[2].content.clone();
        let start = body.find("<<<UNTRUSTED_DATA:").expect("envelope");
        let end = body
            .find("Return only the completed JSON object")
            .unwrap_or(body.len());
        body[start..end].to_string()
    };
    assert_eq!(
        evidence_of(&sent_to_primary),
        evidence_of(&sent_to_fallback),
        "the escalated packet must be byte-identical, nonce included"
    );
    // And the escalation carries the host's failure category, not the proposal.
    assert!(fallback
        .request_body(0)
        .contains("HOST VALIDATION CATEGORY: symptom_promoted_to_cause"));
    assert!(!fallback
        .request_body(0)
        .contains("dependency unavailable caused it"));
}

#[tokio::test]
async fn a_failed_escalation_ends_the_run_honestly_without_a_second_correction() {
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let primary = RecordingBackend::content(&[&rejected, &rejected]);
    // Five bodies available; the route must consume exactly one.
    let fallback =
        RecordingBackend::content(&[&rejected, &rejected, &rejected, &rejected, &rejected]);
    let mut run = Run::new(&packet);
    run.fallback = Some(authorized_fallback());
    let (outcome, _) = drive(run, &primary, Some(&fallback)).await;

    let FastTriageRouteOutcome::Partial {
        categories,
        telemetry,
    } = &outcome
    else {
        panic!("expected an honest partial, got {outcome:?}");
    };
    assert!(categories.contains(&FastTriageFailureCategory::SymptomPromotedToCause));
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::Failed
    );
    assert_eq!(
        telemetry.outcome,
        FastTriageOutcomeLabel::PartialInconclusive
    );
    assert!(!telemetry.outcome.is_verified());
    assert_eq!(
        fallback.calls(),
        1,
        "a failed escalation must not loop or correct"
    );
    assert_eq!(telemetry.provider_attempts, 3);
}

#[tokio::test]
async fn the_route_cannot_switch_profile_or_gateway_on_its_own() {
    // A fallback backend is present, but nothing is configured. The route has
    // no way to reach it: a spare handle is not authorization.
    let packet = complete_timeline_packet();
    let rejected = symptom_promoted();
    let primary = RecordingBackend::content(&[&rejected, &rejected]);
    let unconfigured = RecordingBackend::content(&[&correct_answer()]);
    let (outcome, _) = drive(Run::new(&packet), &primary, Some(&unconfigured)).await;

    let FastTriageRouteOutcome::EscalationRequested { telemetry, .. } = &outcome else {
        panic!("expected an escalation request, got {outcome:?}");
    };
    assert_eq!(unconfigured.calls(), 0);
    assert_eq!(
        telemetry.escalation.state,
        FastTriageEscalationState::NotConfigured
    );
    assert!(telemetry.escalation.profile_id.is_none());
    // Every attempt in the run names the identity it actually used, and the
    // primary identity never changes mid-run.
    assert!(telemetry
        .attempts
        .iter()
        .all(|attempt| attempt.profile_id == PROFILE && attempt.model_id == MODEL));
}

// ---------------------------------------------------------------------------
// 7. Selection: exact persisted evidence only
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_route_without_exact_persisted_evidence_never_calls_a_provider() {
    let stale_fingerprint = FastTriageRouteRecord {
        contract_fingerprint: "stale".repeat(12),
        ..records().remove(0)
    };
    let other_model = FastTriageRouteRecord {
        model_id: format!("{MODEL}-turbo"),
        ..records().remove(0)
    };
    let unqualified = FastTriageRouteRecord {
        verdict: FastTriageRouteVerdict::Inconclusive,
        ..records().remove(0)
    };

    for (name, enabled, records, model, expected) in [
        (
            "disabled",
            false,
            records(),
            Some(MODEL),
            FastTriageRouteRejection::RouteDisabled,
        ),
        (
            "no evidence",
            true,
            Vec::new(),
            Some(MODEL),
            FastTriageRouteRejection::NoRecordForProfileModel,
        ),
        (
            "a near-identical model name",
            true,
            vec![other_model],
            Some(MODEL),
            FastTriageRouteRejection::NoRecordForProfileModel,
        ),
        (
            "an inconclusive verdict",
            true,
            vec![unqualified],
            Some(MODEL),
            FastTriageRouteRejection::VerdictNotQualified,
        ),
        (
            "a stale contract fingerprint",
            true,
            vec![stale_fingerprint],
            Some(MODEL),
            FastTriageRouteRejection::ContractFingerprintStale,
        ),
        (
            "an unknown turn identity",
            true,
            records(),
            None,
            FastTriageRouteRejection::TurnIdentityUnknown,
        ),
    ] {
        let packet = complete_timeline_packet();
        let backend = RecordingBackend::content(&[&correct_answer()]);
        let mut run = Run::new(&packet);
        run.enabled = enabled;
        run.records = records;
        run.model_id = model;
        let (outcome, stages) = drive(run, &backend, None).await;
        let FastTriageRouteOutcome::NotSelected {
            rejection,
            telemetry,
        } = &outcome
        else {
            panic!("{name}: expected non-selection, got {outcome:?}");
        };
        assert_eq!(*rejection, expected, "{name}");
        assert_eq!(backend.calls(), 0, "{name}: nothing may be sent");
        assert!(stages.is_empty(), "{name}");
        assert!(!telemetry.route_selected, "{name}");
        assert_eq!(telemetry.outcome, FastTriageOutcomeLabel::NotSelected);
    }
}

// ---------------------------------------------------------------------------
// 8. Bounded context neighborhood
// ---------------------------------------------------------------------------

#[tokio::test]
async fn clock_quality_decides_whether_cross_source_context_exists() {
    // `metrics.log` carries no focus row, so it is cross-source context.
    let incompatible = packet_with_clock(FastTriageClockCompatibility::OrderOnly);
    assert_eq!(
        incompatible
            .row("e:global_timeline_context:41")
            .map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::IndependentNoise)
    );
    assert_eq!(
        incompatible.neighborhood().withheld_clock_incompatible,
        1,
        "an unresolved clock must be reported, not silently applied"
    );

    let comparable = packet_with_clock(FastTriageClockCompatibility::ResolvedComparable);
    assert_eq!(
        comparable
            .row("e:global_timeline_context:41")
            .map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::CrossSourceTemporal)
    );
    assert_eq!(comparable.neighborhood().withheld_clock_incompatible, 0);

    // Same rows, different clock verdict — a different packet, so an escalation
    // cannot quietly re-derive one from the other.
    assert_ne!(incompatible.packet_id(), comparable.packet_id());

    // The model is told which one it got.
    let backend = RecordingBackend::content(&[&correct_answer()]);
    drive(Run::new(&incompatible), &backend, None).await;
    assert!(backend
        .request_body(0)
        .contains("\"clock_compatibility\":\"order_only\""));
}

#[tokio::test]
async fn same_source_context_keeps_preceding_and_recovery_anchors_apart() {
    // seq 11 sits between the cause (10) and the retry (12) in `app.log`, so it
    // is same-source context; its position is stated, never its meaning.
    let packet = complete_timeline_packet();
    let anchor = packet
        .row("e:global_timeline_context:11")
        .expect("neighbor row");
    assert!(matches!(
        anchor.context_category,
        FastTriageEvidenceCategory::PrecedingSameSource
            | FastTriageEvidenceCategory::FollowingSameSource
    ));
    // Trace grouping — not adjacency — is what marks a linked row.
    assert_eq!(
        packet
            .row("e:trace:alpha:12")
            .map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::Focus)
    );
    // Independent chronology may still never enter a causal chain, whatever
    // context category it earned.
    let backend = RecordingBackend::content(&[&independent_promoted(), &independent_promoted()]);
    let (outcome, _) = drive(Run::new(&packet), &backend, None).await;
    let FastTriageRouteOutcome::EscalationRequested { categories, .. } = &outcome else {
        panic!("expected an escalation request, got {outcome:?}");
    };
    assert!(categories.contains(&FastTriageFailureCategory::IndependentEvidencePromoted));
}

#[tokio::test]
async fn neighborhood_truncation_is_deterministic_and_reported() {
    let build = || {
        FastTriagePacketV1::build(FastTriagePacketInputs {
            ledger: ledger(vec![
                entry("g-a", 50, EvidenceRole::Neutral, "app.log", "focus"),
                entry("tl", 48, EvidenceRole::Neutral, "app.log", "near before"),
                entry("tl", 52, EvidenceRole::Neutral, "app.log", "near after"),
                entry("tl", 900, EvidenceRole::Neutral, "app.log", "far away"),
            ]),
            independent_candidate_id: Some("tl"),
            timeline_complete: false,
            clock: FastTriageClockCompatibility::OrderOnly,
            trace_correlated_candidates: &BTreeSet::new(),
            neighborhood: FastTriageNeighborhoodBudget {
                max_context_rows: 1,
                ..FastTriageNeighborhoodBudget::default()
            },
        })
    };
    let first = build();
    let second = build();
    assert_eq!(first.packet_id(), second.packet_id());
    assert_eq!(first.rows(), second.rows());
    assert_eq!(first.neighborhood().withheld_over_budget, 1);
    assert_eq!(first.neighborhood().withheld_out_of_radius, 1);
    // The nearer, lower-ordinal row wins the single context slot, every time.
    assert_eq!(
        first.row("e:tl:48").map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::PrecedingSameSource)
    );
    assert_eq!(
        first.row("e:tl:52").map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::IndependentNoise)
    );
    assert_eq!(
        first.row("e:tl:900").map(|row| row.context_category),
        Some(FastTriageEvidenceCategory::IndependentNoise)
    );
    // An incomplete chronology is disclosed as incomplete.
    assert!(!first.timeline_complete());
}

// ---------------------------------------------------------------------------
// 9. Share-safe telemetry, and determinism
// ---------------------------------------------------------------------------

/// Substrings that must never appear in any share-safe projection.
fn assert_share_safe(text: &str) {
    assert!(
        cd_core::quality_eval::scan_privacy_text(text).is_empty(),
        "privacy scan flagged the projection"
    );
    for forbidden in [
        // prompt / contract text
        "You are completing one bounded",
        "HOST-AUTHORED EVIDENCE MANIFEST",
        "HOST VALIDATION CATEGORY",
        "UNTRUSTED_DATA",
        // corpus text
        "constraint violation on startup",
        "request rejected: dependency unavailable",
        "routine checkpoint written",
        "unrelated queue depth sample",
        // source labels, locators, raw bodies
        "app.log",
        "worker.log",
        "metrics.log",
        "seq=",
        // reasoning
        "<think>",
        "</think>",
        "private chain of thought",
        // transport and credentials
        "http://",
        "https://",
        "Authorization",
        "api_key",
    ] {
        assert!(
            !text.contains(forbidden),
            "share-safe projection leaked {forbidden}"
        );
    }
}

#[tokio::test]
async fn telemetry_and_stage_details_are_share_safe_on_every_path() {
    let bodies = [
        correct_answer(),
        symptom_promoted(),
        "<think>private chain of thought</think>".to_string(),
        "prose that is not an answer".to_string(),
    ];
    for body in bodies {
        let packet = complete_timeline_packet();
        let primary = RecordingBackend::content(&[&body, &body]);
        let fallback = RecordingBackend::content(&[&body]);
        let mut details = Vec::new();
        let mut run = Run::new(&packet);
        run.fallback = Some(authorized_fallback());
        let outcome = run_fast_triage_route(
            &primary,
            Some(&fallback),
            FastTriageInputs {
                user_text: "what initiated this failure?",
                packet: run.packet,
                expected_packet_id: Some(packet.packet_id()),
                enabled: true,
                records: &run.records,
                profile_id: Some(PROFILE),
                model_id: Some(MODEL),
                fallback: run.fallback.as_ref(),
                budget: FastTriageBudget::default(),
                started_at: None,
                cancel: None,
            },
            &mut |event| details.push(event.detail),
        )
        .await
        .expect("route");

        assert_share_safe(&outcome.telemetry().activity_detail());
        for detail in &details {
            assert_share_safe(detail);
        }
        // The packet identity is a digest, so it is safe *and* present.
        assert!(outcome
            .telemetry()
            .activity_detail()
            .contains(packet.packet_id()));
    }
}

#[tokio::test]
async fn repeated_runs_of_the_same_fixture_produce_identical_outcomes() {
    let mut fingerprints = Vec::new();
    for _ in 0..3 {
        let packet = complete_timeline_packet();
        let rejected = symptom_promoted();
        let primary = RecordingBackend::content(&[&rejected, &correct_answer()]);
        let (outcome, stages) = drive(Run::new(&packet), &primary, None).await;
        let (content, telemetry) = verified(&outcome);
        fingerprints.push((
            content.to_string(),
            telemetry.activity_detail(),
            format!("{stages:?}"),
            primary.request_body(1),
        ));
    }
    // The evidence envelope uses a fresh nonce per run, so compare everything
    // except the request body's wrapper, which is compared for shape instead.
    let (first_content, first_telemetry, first_stages, first_request) = &fingerprints[0];
    for (content, telemetry, stages, request) in &fingerprints[1..] {
        assert_eq!(content, first_content, "visible answer must be stable");
        assert_eq!(telemetry, first_telemetry, "telemetry must be stable");
        assert_eq!(stages, first_stages, "stage sequence must be stable");
        assert_eq!(
            request.matches("<<<UNTRUSTED_DATA:").count(),
            first_request.matches("<<<UNTRUSTED_DATA:").count()
        );
        assert_eq!(
            request.contains("HOST VALIDATION CATEGORY: symptom_promoted_to_cause"),
            first_request.contains("HOST VALIDATION CATEGORY: symptom_promoted_to_cause")
        );
    }
}
