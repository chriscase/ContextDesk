//! Hermetic adversarial gates for the multi-model reviewer pipeline.
//!
//! Every payload here is structural, not semantic: candidate ids, claim ids,
//! and evidence ids are opaque tokens (`k1`, `o-k1`, `e:k1:1`) chosen so no
//! gate depends on an incident word, a log term, or a fixture sentence.
//! Renaming every string leaves the host invariants unchanged — that is the
//! property under test, not the wording of any exploit.
//!
//! Backends are scripted (`ScriptedBackend`); no network, no provider, no
//! model download. The investigator and synthesizer share one scripted
//! backend (its response sequence is `[finding_1, finding_2, …, answer]`); the
//! reviewer has its own.

use std::sync::atomic::{AtomicBool, Ordering};

use cd_core::agent::{ChatBackend, ScriptedBackend};
use cd_core::chat::ChatCompletion;
use cd_core::error::CoreError;
use cd_core::investigation_answer::{AnswerBindingV1, LogSnapshotRevisionV1};
use cd_core::log_analysis::SearchEvidenceIdentity;
use cd_core::multi_model::{
    render_review_markdown, run_review_pipeline, DegradationReason, ExecutedMode, InvestigationRole,
    MultiModelBackends, MultiModelBudget, MultiModelOutcome, MultiModelRoleIds,
    ReviewPipelineInputs, StageOutcomeKind, StageProgressEvent,
};
use cd_core::tool_host::BroadLogTriageCandidate;

// ---------------------------------------------------------------------------
// Opaque fixtures
// ---------------------------------------------------------------------------

fn identity(seq: u64, source: &str) -> SearchEvidenceIdentity {
    SearchEvidenceIdentity {
        seq,
        source: source.into(),
        citation_source: None,
        template_id: seq,
    }
}

/// Candidate `group_id` with one identity per seq. `source` is host-owned.
fn candidate(group_id: &str, seqs: &[u64]) -> BroadLogTriageCandidate {
    BroadLogTriageCandidate {
        group_id: group_id.into(),
        structural_kind: "template",
        model_text: format!("bounded brief for {group_id}"),
        evidence: seqs.iter().map(|s| identity(*s, "src/a.log")).collect(),
    }
}

fn evidence_id(group_id: &str, seq: u64) -> String {
    format!("e:{group_id}:{seq}")
}

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 4,
        template_analysis_revision: 5,
        suppression_revision: 6,
    }
}

fn binding() -> AnswerBindingV1 {
    AnswerBindingV1 {
        session_id: "s".into(),
        turn_id: "s::t".into(),
        corpus_id: "c".into(),
        revision: revision(),
        // Overwritten per-ledger by the pipeline.
        ledger_digest: String::new(),
    }
}

fn completion(content: String) -> ChatCompletion {
    ChatCompletion {
        content,
        tool_calls: vec![],
        finish_reason: "stop".into(),
        telemetry: Default::default(),
    }
}

/// A candidate-finding proposal citing this candidate's own evidence ids.
fn finding_json(group_id: &str, seqs: &[u64]) -> String {
    let obs = seqs
        .iter()
        .map(|s| {
            format!(
                r#"{{"claim_id":"o-{g}-{s}","text":"observation for {g}","evidence_ids":["{e}"]}}"#,
                g = group_id,
                s = s,
                e = evidence_id(group_id, *s)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{group_id}","observations":[{obs}],"causal_candidates":[{{"claim_id":"cc-{group_id}","text":"a candidate cause for {group_id}","evidence_ids":["{e}"]}}]}}"#,
        e = evidence_id(group_id, seqs[0])
    )
}

/// A review proposal referencing existing ids only.
fn review_json(gaps: &str, contradictions: &str) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.review.v1","evidence_gaps":[{gaps}],"contradictions":[{contradictions}]}}"#
    )
}

/// A final answer proposal naming every candidate and citing its own ids.
fn answer_json(groups: &[(&str, &[u64])]) -> String {
    let cands = groups
        .iter()
        .map(|(g, seqs)| {
            let obs = seqs
                .iter()
                .map(|s| {
                    format!(
                        r#"{{"claim_id":"ao-{g}-{s}","text":"answer observation {g}","evidence_ids":["{e}"]}}"#,
                        e = evidence_id(g, *s)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(r#"{{"candidate_id":"{g}","observations":[{obs}]}}"#)
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(r#"{{"schema":"contextdesk.investigation_answer.v1","candidates":[{cands}]}}"#)
}

fn role_ids() -> MultiModelRoleIds {
    MultiModelRoleIds {
        investigator_profile: "p-inv".into(),
        investigator_model: "m-inv".into(),
        reviewer_profile: "p-rev".into(),
        reviewer_model: "m-rev".into(),
        synthesizer_profile: "p-inv".into(),
        synthesizer_model: "m-inv".into(),
    }
}

struct RunResult {
    outcome: MultiModelOutcome,
    stages: Vec<StageProgressEvent>,
}

/// Drive the pipeline with a scripted investigator/synthesizer backend and a
/// scripted reviewer backend, capturing stage-progress events.
fn run_with(
    investigator: Vec<ChatCompletion>,
    reviewer: Vec<ChatCompletion>,
    candidates: &[BroadLogTriageCandidate],
    budget: MultiModelBudget,
) -> RunResult {
    let inv = ScriptedBackend::new(investigator);
    let rev = ScriptedBackend::new(reviewer);
    run_with_backends(&inv, &rev, candidates, budget)
}

fn run_with_backends(
    inv: &dyn ChatBackend,
    rev: &dyn ChatBackend,
    candidates: &[BroadLogTriageCandidate],
    budget: MultiModelBudget,
) -> RunResult {
    let backends = MultiModelBackends {
        investigator: inv,
        reviewer: rev,
        synthesizer: inv,
    };
    let mut stages = Vec::new();
    let inputs = ReviewPipelineInputs {
        user_text: "q",
        candidates,
        binding: binding(),
        budget,
        role_ids: role_ids(),
        deadline_ms: 0,
        started_at: None,
        cancel: None,
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let outcome = rt
        .block_on(run_review_pipeline(&backends, inputs, &mut |e| stages.push(e)))
        .expect("pipeline never returns a raw Err");
    RunResult { outcome, stages }
}

/// Standard two-candidate happy path: both findings valid, review valid, answer valid.
fn happy_backends() -> (Vec<ChatCompletion>, Vec<ChatCompletion>) {
    let investigator = vec![
        completion(finding_json("k1", &[1])),
        completion(finding_json("k2", &[2])),
        completion(answer_json(&[("k1", &[1]), ("k2", &[2])])),
    ];
    let reviewer = vec![completion(review_json(
        r#"{"gap_id":"g1","candidate_id":"k1","text":"a gap","related_evidence_ids":["e:k1:1"]}"#,
        r#"{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"o-k1-1","candidate_b":"k2","claim_b_id":"o-k2-2","text":"a conflict","evidence_ids":["e:k1:1","e:k2:2"]}"#,
    ))];
    (investigator, reviewer)
}

fn two_candidates() -> Vec<BroadLogTriageCandidate> {
    vec![candidate("k1", &[1]), candidate("k2", &[2])]
}

fn expect_completed(outcome: &MultiModelOutcome) -> (&cd_core::investigation_answer::AnswerEnvelopeV1, &str, ExecutedMode) {
    match outcome {
        MultiModelOutcome::Completed {
            envelope,
            content,
            telemetry,
            ..
        } => (envelope, content.as_str(), telemetry.executed_mode),
        other => panic!("expected Completed, got {}", outcome_label(other)),
    }
}

fn outcome_label(outcome: &MultiModelOutcome) -> &'static str {
    match outcome {
        MultiModelOutcome::Completed { .. } => "Completed",
        MultiModelOutcome::FailedClosed { .. } => "FailedClosed",
        MultiModelOutcome::NotEligible => "NotEligible",
        MultiModelOutcome::Cancelled => "Cancelled",
        MultiModelOutcome::Deadline => "Deadline",
        MultiModelOutcome::ProviderFailed(_) => "ProviderFailed",
    }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

#[test]
fn happy_path_reviews_and_synthesizes_a_host_validated_answer() {
    let (inv, rev) = happy_backends();
    let RunResult { outcome, stages } = run_with(inv, rev, &two_candidates(), MultiModelBudget::default());
    let (envelope, content, executed) = expect_completed(&outcome);
    assert_eq!(executed, ExecutedMode::Review);
    // The final answer is host-validated and Cause-free (no establishment).
    assert!(!envelope.answer.root_cause_established);
    assert_eq!(envelope.answer.candidates.len(), 2);
    assert_eq!(envelope.binding.corpus_id, "c");
    assert_eq!(envelope.binding.revision, revision());
    // Visible text is the host projection, never raw JSON.
    assert!(content.starts_with("# Investigation answer"));
    assert!(serde_json::from_str::<serde_json::Value>(content.trim()).is_err());
    // The reviewer stage ran and completed.
    assert!(stages.iter().any(|s| s.role == InvestigationRole::Reviewer
        && s.outcome == Some(StageOutcomeKind::Completed)));
    // Telemetry: three roles executed, review contributed.
    if let MultiModelOutcome::Completed { telemetry, review, .. } = &outcome {
        assert_eq!(telemetry.executed_mode, ExecutedMode::Review);
        assert!(telemetry.degradation.is_none());
        assert!(review.is_some());
        assert!(telemetry
            .stages
            .iter()
            .any(|s| s.role == InvestigationRole::Reviewer && s.outcome == StageOutcomeKind::Completed));
    }
}

#[test]
fn a_forged_reviewer_citation_degrades_and_never_becomes_authority() {
    let (inv, _) = happy_backends();
    // Reviewer cites an evidence id the host never created, then (after its one
    // correction) an id from the wrong candidate. Both are rejected.
    let reviewer = vec![
        completion(review_json(
            r#"{"gap_id":"g1","candidate_id":"k1","text":"x","related_evidence_ids":["e:ghost:9"]}"#,
            "",
        )),
        completion(review_json(
            r#"{"gap_id":"g1","candidate_id":"k1","text":"x","related_evidence_ids":["e:k2:2"]}"#,
            "",
        )),
    ];
    let RunResult { outcome, stages } = run_with(inv, reviewer, &two_candidates(), MultiModelBudget::default());
    let (envelope, _, executed) = expect_completed(&outcome);
    // Answer still produced (synthesis without review), degraded honestly.
    assert_eq!(executed, ExecutedMode::ReviewDegraded);
    assert!(!envelope.answer.root_cause_established);
    if let MultiModelOutcome::Completed { telemetry, review, .. } = &outcome {
        assert_eq!(
            telemetry.degradation,
            Some(DegradationReason::ReviewerSemanticInvalid)
        );
        assert!(review.is_none(), "an invalid review never reaches the outcome");
    }
    assert!(stages.iter().any(|s| s.role == InvestigationRole::Reviewer
        && s.outcome == Some(StageOutcomeKind::SemanticInvalid)));
}

#[test]
fn candidate_permutation_yields_a_byte_identical_answer() {
    // Two candidate orders, same scripted content per candidate.
    let base = |groups: &[(&str, &[u64])]| {
        let inv = groups
            .iter()
            .map(|(g, s)| completion(finding_json(g, s)))
            .chain(std::iter::once(completion(answer_json(&[("k1", &[1]), ("k2", &[2])]))))
            .collect::<Vec<_>>();
        let rev = vec![completion(review_json("", ""))];
        (inv, rev)
    };
    // Note: the synthesizer answer names candidates in a fixed order; the host
    // renderer sorts candidates by id, so display is order-independent.
    let (inv_a, rev_a) = base(&[("k1", &[1]), ("k2", &[2])]);
    let a = run_with(inv_a, rev_a, &[candidate("k1", &[1]), candidate("k2", &[2])], MultiModelBudget::default());
    let (inv_b, rev_b) = base(&[("k2", &[2]), ("k1", &[1])]);
    let b = run_with(inv_b, rev_b, &[candidate("k2", &[2]), candidate("k1", &[1])], MultiModelBudget::default());
    let (_, content_a, _) = expect_completed(&a.outcome);
    let (_, content_b, _) = expect_completed(&b.outcome);
    assert_eq!(content_a, content_b, "candidate order must not change the rendered answer");
}

#[test]
fn conflicting_and_colluding_reviewers_never_establish_a_cause() {
    // Reviewer emits a contradiction between the two candidates; the answer
    // has causal_candidates but no host Cause role, so nothing is established.
    let (inv, rev) = happy_backends();
    let (envelope, content, _) = {
        let RunResult { outcome, .. } = run_with(inv, rev, &two_candidates(), MultiModelBudget::default());
        let (e, c, ex) = expect_completed(&outcome);
        (e.clone(), c.to_string(), ex)
    };
    assert!(!envelope.answer.root_cause_established);
    assert!(content.contains("- Root cause established: no"));
    // Even if the answer proposed initiating_causes, a Neutral ledger role
    // forces them Withheld — colluding agreement cannot establish.
    let inv2 = vec![
        completion(finding_json("k1", &[1])),
        completion(finding_json("k2", &[2])),
        completion(
            r#"{"schema":"contextdesk.investigation_answer.v1","candidates":[{"candidate_id":"k1","initiating_causes":[{"claim_id":"r1","text":"claimed root","evidence_ids":["e:k1:1"]}]},{"candidate_id":"k2","observations":[{"claim_id":"o2","text":"x","evidence_ids":["e:k2:2"]}]}]}"#
                .to_string(),
        ),
    ];
    let rev2 = vec![completion(review_json("", ""))];
    let RunResult { outcome, .. } = run_with(inv2, rev2, &two_candidates(), MultiModelBudget::default());
    let (envelope, content, _) = expect_completed(&outcome);
    assert!(!envelope.answer.root_cause_established, "no Cause role → never established");
    assert!(content.contains("**[withheld]**"), "a claimed root renders withheld: {content}");
}

#[test]
fn a_provider_failure_in_the_reviewer_stage_degrades_not_fails() {
    struct FailBackend;
    #[async_trait::async_trait]
    impl ChatBackend for FailBackend {
        async fn complete(
            &self,
            _m: &[cd_core::chat::ChatMessage],
            _t: &[cd_core::tools::ToolSpec],
        ) -> Result<ChatCompletion, CoreError> {
            Err(CoreError::ProviderHttp {
                operation: "stream".into(),
                status: 429,
                status_line: "429 Too Many Requests".into(),
                body: "{}".into(),
            })
        }
    }
    let (inv, _) = happy_backends();
    let inv = ScriptedBackend::new(inv);
    let RunResult { outcome, .. } = run_with_backends(&inv, &FailBackend, &two_candidates(), MultiModelBudget::default());
    let (_, _, executed) = expect_completed(&outcome);
    assert_eq!(executed, ExecutedMode::ReviewDegraded);
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        assert_eq!(telemetry.degradation, Some(DegradationReason::ReviewerProviderFailed));
    }
}

#[test]
fn a_provider_failure_in_a_required_stage_is_a_typed_provider_outcome() {
    struct FailFirst {
        calls: AtomicBool,
    }
    #[async_trait::async_trait]
    impl ChatBackend for FailFirst {
        async fn complete(
            &self,
            _m: &[cd_core::chat::ChatMessage],
            _t: &[cd_core::tools::ToolSpec],
        ) -> Result<ChatCompletion, CoreError> {
            self.calls.store(true, Ordering::SeqCst);
            Err(CoreError::ProviderHttp {
                operation: "stream".into(),
                status: 500,
                status_line: "500 Internal Server Error".into(),
                body: "{}".into(),
            })
        }
    }
    let inv = FailFirst { calls: AtomicBool::new(false) };
    let rev = ScriptedBackend::new(vec![completion(review_json("", ""))]);
    let RunResult { outcome, .. } = run_with_backends(&inv, &rev, &two_candidates(), MultiModelBudget::default());
    assert!(matches!(outcome, MultiModelOutcome::ProviderFailed(_)));
}

#[test]
fn budget_that_cannot_fit_a_reviewer_call_degrades_deterministically() {
    // Only enough rounds for two investigators + one synthesis; no reviewer.
    let (inv, rev) = happy_backends();
    let budget = MultiModelBudget {
        max_total_provider_rounds: 3,
        ..MultiModelBudget::default()
    };
    let RunResult { outcome, stages } = run_with(inv, rev, &two_candidates(), budget);
    let (_, _, executed) = expect_completed(&outcome);
    assert_eq!(executed, ExecutedMode::ReviewDegraded);
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        assert_eq!(telemetry.degradation, Some(DegradationReason::BudgetRoundsInsufficient));
    }
    assert!(stages
        .iter()
        .any(|s| s.role == InvestigationRole::Reviewer && s.outcome == Some(StageOutcomeKind::Skipped)));
}

#[test]
fn a_usage_char_ceiling_that_cannot_fit_a_reviewer_call_degrades() {
    let (inv, rev) = happy_backends();
    let budget = MultiModelBudget {
        max_context_chars_total: Some(1), // absurdly small; reviewer cannot fit
        ..MultiModelBudget::default()
    };
    let RunResult { outcome, .. } = run_with(inv, rev, &two_candidates(), budget);
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        assert_eq!(telemetry.degradation, Some(DegradationReason::BudgetUsageInsufficient));
    } else {
        panic!("expected a degraded completion");
    }
}

#[test]
fn fewer_than_two_valid_findings_is_not_eligible_or_fails_closed() {
    // One candidate → NotEligible; the caller runs the existing path.
    let RunResult { outcome, .. } = run_with(
        vec![completion(finding_json("k1", &[1]))],
        vec![],
        &[candidate("k1", &[1])],
        MultiModelBudget::default(),
    );
    assert!(matches!(outcome, MultiModelOutcome::NotEligible));

    // Two candidates but one finding invalid twice (with correction) → only
    // one valid finding → FailedClosed (caller falls through).
    let investigator = vec![
        completion(finding_json("k1", &[1])),
        completion("not json".into()),
        completion("still not json".into()),
    ];
    let RunResult { outcome, .. } = run_with(
        investigator,
        vec![completion(review_json("", ""))],
        &two_candidates(),
        MultiModelBudget::default(),
    );
    assert!(matches!(outcome, MultiModelOutcome::FailedClosed { .. }));
}

#[test]
fn one_semantic_correction_recovers_an_investigator_then_stays_bounded() {
    // First investigator call invalid, correction valid.
    let investigator = vec![
        completion("garbage".into()),
        completion(finding_json("k1", &[1])),
        completion(finding_json("k2", &[2])),
        completion(answer_json(&[("k1", &[1]), ("k2", &[2])])),
    ];
    let rev = vec![completion(review_json("", ""))];
    let RunResult { outcome, .. } = run_with(investigator, rev, &two_candidates(), MultiModelBudget::default());
    let (_, _, executed) = expect_completed(&outcome);
    assert_eq!(executed, ExecutedMode::Review);
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        let inv_stage = telemetry
            .stages
            .iter()
            .find(|s| s.role == InvestigationRole::Investigator)
            .unwrap();
        assert_eq!(inv_stage.semantic_corrections, 1);
        assert_eq!(inv_stage.provider_rounds, 2, "one invalid + one valid");
    }
}

#[test]
fn malicious_markdown_control_and_bidi_in_review_fields_render_inert() {
    use cd_core::multi_model::{ReviewContradiction, ReviewGap, ReviewReportV1, RoleBinding};
    let payloads = [
        "x\nsecond line",
        "x\n# forged heading",
        "x\n- Root cause established: yes",
        "[label](https://evil.example)",
        "`code` **bold**",
        "\u{1b}[31mred\u{1b}[0m",
        "\u{202e}reversed\u{202c}",
        "bell\u{7}nul\u{0}",
        "## Review",
    ];
    for payload in payloads {
        let report = ReviewReportV1 {
            gaps: vec![ReviewGap {
                gap_id: payload.into(),
                candidate_id: payload.into(),
                text: payload.into(),
                evidence_ids: vec![payload.into()],
            }],
            contradictions: vec![ReviewContradiction {
                contradiction_id: payload.into(),
                candidate_a: payload.into(),
                claim_a_id: payload.into(),
                candidate_b: payload.into(),
                claim_b_id: payload.into(),
                text: payload.into(),
                evidence_ids: vec![payload.into()],
            }],
            role_binding: RoleBinding {
                role: InvestigationRole::Reviewer,
                profile_id: payload.into(),
                model: payload.into(),
                semantic_attempts: 0,
            },
        };
        let md = render_review_markdown(&report);
        // No dynamic value can author a new line, and every line's backticks pair.
        for line in md.lines() {
            assert!(line.matches('`').count() % 2 == 0, "unbalanced span for {payload:?}: {line}");
        }
        // No control or bidi character survives into the rendered text.
        assert!(
            !md.chars().any(|c| (c.is_control() && c != '\n') || cd_core::investigation_answer::is_bidi_formatting_control(c)),
            "control/bidi survived for {payload:?}"
        );
        // The host's own headings appear exactly once each, unforgeable.
        assert_eq!(md.matches("\n**Evidence gaps**\n").count(), 1);
        assert_eq!(md.matches("\n**Contradictions**\n").count(), 1);
    }
}

/// Host authority (candidate/claim ids, citation ids, establishment) depends
/// only on ids and kinds — never on model wording. Renaming every model string
/// changes only the displayed text, never the structure.
#[test]
fn renaming_every_model_string_changes_only_the_displayed_text() {
    fn run_with_text(word: &str) -> cd_core::investigation_answer::AnswerEnvelopeV1 {
        let finding = |g: &str, s: u64| {
            format!(
                r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{g}","observations":[{{"claim_id":"o-{g}","text":"{word} {g}","evidence_ids":["e:{g}:{s}"]}}]}}"#
            )
        };
        let answer = format!(
            r#"{{"schema":"contextdesk.investigation_answer.v1","candidates":[{{"candidate_id":"k1","observations":[{{"claim_id":"ao-k1","text":"{word} one","evidence_ids":["e:k1:1"]}}]}},{{"candidate_id":"k2","observations":[{{"claim_id":"ao-k2","text":"{word} two","evidence_ids":["e:k2:2"]}}]}}]}}"#
        );
        let inv = vec![
            completion(finding("k1", 1)),
            completion(finding("k2", 2)),
            completion(answer),
        ];
        let rev = vec![completion(review_json("", ""))];
        let RunResult { outcome, .. } = run_with(inv, rev, &two_candidates(), MultiModelBudget::default());
        match outcome {
            MultiModelOutcome::Completed { envelope, .. } => *envelope,
            other => panic!("expected Completed, got {}", outcome_label(&other)),
        }
    }
    let a = run_with_text("alpha");
    let b = run_with_text("zzz-renamed");
    // Ids, kinds, citations, and establishment are identical; only text differs.
    let skeleton = |e: &cd_core::investigation_answer::AnswerEnvelopeV1| {
        let cands = e
            .answer
            .candidates
            .iter()
            .map(|c| {
                let claims = c
                    .claims
                    .iter()
                    .map(|cl| (cl.claim_id.clone(), cl.claim_kind, cl.evidence_ids.clone(), cl.status))
                    .collect::<Vec<_>>();
                (c.candidate_id.clone(), claims)
            })
            .collect::<Vec<_>>();
        let cites = e
            .answer
            .canonical_citations
            .iter()
            .map(|c| (c.evidence_id.clone(), c.candidate_id.clone()))
            .collect::<Vec<_>>();
        (cands, cites, e.answer.root_cause_established)
    };
    assert_eq!(skeleton(&a), skeleton(&b));
    // But the text did differ.
    assert_ne!(a.answer.candidates[0].claims[0].text, b.answer.candidates[0].claims[0].text);
}

/// The typed envelope and the typed event round-trip byte-exact through JSON,
/// while the visible content is Markdown, never re-entry.
#[test]
fn typed_answer_persists_byte_exact_and_visible_text_is_markdown() {
    let (inv, rev) = happy_backends();
    let RunResult { outcome, .. } = run_with(inv, rev, &two_candidates(), MultiModelBudget::default());
    let (envelope, content, _) = expect_completed(&outcome);
    let json = serde_json::to_string(envelope).unwrap();
    let back: cd_core::investigation_answer::AnswerEnvelopeV1 = serde_json::from_str(&json).unwrap();
    assert_eq!(&back, envelope);
    let event = cd_core::events::StreamEvent::InvestigationAnswer { envelope: envelope.clone() };
    let ev_json = serde_json::to_string(&event).unwrap();
    let ev_back: cd_core::events::StreamEvent = serde_json::from_str(&ev_json).unwrap();
    match ev_back {
        cd_core::events::StreamEvent::InvestigationAnswer { envelope: got } => assert_eq!(&got, envelope),
        other => panic!("typed event changed shape: {other:?}"),
    }
    assert!(serde_json::from_str::<serde_json::Value>(content.trim()).is_err());
}

#[test]
fn rendered_review_is_stable_under_gap_and_contradiction_ordering() {
    use cd_core::multi_model::{ReviewContradiction, ReviewGap, ReviewReportV1, RoleBinding};
    let rb = RoleBinding {
        role: InvestigationRole::Reviewer,
        profile_id: "p".into(),
        model: "m".into(),
        semantic_attempts: 0,
    };
    let gap = |id: &str| ReviewGap {
        gap_id: id.into(),
        candidate_id: "k1".into(),
        text: "t".into(),
        evidence_ids: vec![],
    };
    let con = |id: &str| ReviewContradiction {
        contradiction_id: id.into(),
        candidate_a: "k1".into(),
        claim_a_id: "a".into(),
        candidate_b: "k2".into(),
        claim_b_id: "b".into(),
        text: "t".into(),
        evidence_ids: vec![],
    };
    let a = ReviewReportV1 {
        gaps: vec![gap("g1"), gap("g2")],
        contradictions: vec![con("x1"), con("x2")],
        role_binding: rb.clone(),
    };
    let b = ReviewReportV1 {
        gaps: vec![gap("g2"), gap("g1")],
        contradictions: vec![con("x2"), con("x1")],
        role_binding: rb,
    };
    assert_eq!(render_review_markdown(&a), render_review_markdown(&b));
}
