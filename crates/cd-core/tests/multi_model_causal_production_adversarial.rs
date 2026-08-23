//! Hostile qualification of the **production** host-bounded causal pipeline.
//!
//! Drives shipped [`run_review_pipeline`] and [`build_fast_triage_packet`].
//! Does not re-implement [`validate_causal_synthesis`] / [`validate_model_answer`].

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use cd_core::agent::{build_fast_triage_packet, ChatBackend, ScriptedBackend};
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::error::CoreError;
use cd_core::fast_triage::{
    FastTriageClockCompatibility, FastTriageNeighborhoodBudget, FastTriagePacketV1,
};
use cd_core::investigation_answer::{
    AnswerBindingV1, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
};
use cd_core::log_analysis::SearchEvidenceIdentity;
use cd_core::multi_model::{
    run_review_pipeline, InvestigationRole, MultiModelBackends, MultiModelBudget,
    MultiModelOutcome, MultiModelRoleIds, ReviewPipelineInputs, StageOutcomeKind,
    StageProgressEvent,
};
use cd_core::tool_host::BroadLogTriageCandidate;
use cd_core::tools::ToolSpec;

fn identity(seq: u64, source: &str) -> SearchEvidenceIdentity {
    SearchEvidenceIdentity {
        seq,
        source: source.into(),
        citation_source: None,
        template_id: seq,
    }
}

fn candidate(group_id: &str, seqs: &[u64]) -> BroadLogTriageCandidate {
    let evidence = seqs
        .iter()
        .map(|s| identity(*s, "src/a.log"))
        .collect::<Vec<_>>();
    BroadLogTriageCandidate {
        group_id: group_id.into(),
        structural_kind: "template",
        model_text: format!("bounded brief for {group_id}"),
        evidence_excerpts: evidence
            .iter()
            .cloned()
            .map(|row| (row, format!("excerpt-{group_id}")))
            .collect(),
        evidence,
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

/// Criterion-3 fail-closed axes. `"reviewer_collusion"` remains required even
/// though production currently establishes on the collusion-only driver below.
const REQUIRED_FAIL_CLOSED_AXES: [&str; 14] = [
    "false_union",
    "wrong_candidate_claim",
    "duplicate_relation",
    "duplicate_evidence",
    "unknown_field_frequency",
    "unknown_field_chronology",
    "unknown_field_ordering",
    "injected_host_field",
    "symptom_promotion",
    "recovery_as_cause",
    "decoy_promotion",
    "missing_disproof",
    "reviewer_collusion",
    "causal_prose",
];

const THIS_LAB: &str = include_str!("multi_model_causal_production_adversarial.rs");

fn trigger_finding(group_id: &str, seq: u64, claim_id: &str) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{group_id}","causal_candidates":[{{"claim_id":"{claim_id}","text":"bounded trigger","evidence_ids":["{e}"]}}]}}"#,
        e = evidence_id(group_id, seq)
    )
}

fn trigger_finding_with_obs(
    group_id: &str,
    seq: u64,
    claim_id: &str,
    obs_seq: u64,
    obs_claim: &str,
) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{group_id}","observations":[{{"claim_id":"{obs_claim}","text":"bounded observation","evidence_ids":["{oe}"]}}],"causal_candidates":[{{"claim_id":"{claim_id}","text":"bounded trigger","evidence_ids":["{e}"]}}]}}"#,
        e = evidence_id(group_id, seq),
        oe = evidence_id(group_id, obs_seq)
    )
}

fn symptom_finding(group_id: &str, seq: u64, claim_id: &str) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{group_id}","symptoms":[{{"claim_id":"{claim_id}","text":"bounded symptom","evidence_ids":["{e}"]}}]}}"#,
        e = evidence_id(group_id, seq)
    )
}

fn symptom_finding_with_obs(
    group_id: &str,
    seq: u64,
    claim_id: &str,
    obs_seq: u64,
    obs_claim: &str,
) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.candidate_finding.v1","candidate_id":"{group_id}","observations":[{{"claim_id":"{obs_claim}","text":"bounded observation","evidence_ids":["{oe}"]}}],"symptoms":[{{"claim_id":"{claim_id}","text":"bounded symptom","evidence_ids":["{e}"]}}]}}"#,
        e = evidence_id(group_id, seq),
        oe = evidence_id(group_id, obs_seq)
    )
}

fn observation_answer(groups: &[(&str, u64)]) -> String {
    let cands = groups
        .iter()
        .map(|(g, seq)| {
            format!(
                r#"{{"candidate_id":"{g}","observations":[{{"claim_id":"ao-{g}","text":"bounded observation","evidence_ids":["{e}"]}}]}}"#,
                e = evidence_id(g, *seq)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(r#"{{"schema":"contextdesk.investigation_answer.v1","candidates":[{cands}]}}"#)
}

fn causal_answer(trigger_c: &str, trigger_seq: u64, symptom_c: &str, symptom_seq: u64) -> String {
    format!(
        r#"{{"schema":"contextdesk.investigation_answer.v1","candidates":[{{"candidate_id":"{trigger_c}","initiating_causes":[{{"claim_id":"root-{trigger_c}","text":"bounded initiating cause","evidence_ids":["{te}"]}}]}},{{"candidate_id":"{symptom_c}","symptoms":[{{"claim_id":"sym-{symptom_c}","text":"bounded propagated symptom","evidence_ids":["{se}"]}}]}}]}}"#,
        te = evidence_id(trigger_c, trigger_seq),
        se = evidence_id(symptom_c, symptom_seq)
    )
}

fn causal_proposal(
    trigger_c: &str,
    trigger_claim: &str,
    trigger_seq: u64,
    symptom_c: &str,
    symptom_claim: &str,
    symptom_seq: u64,
) -> String {
    format!(
        r#"{{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{{"kind":"initiating_trigger","candidate_id":"{trigger_c}","claim_id":"{trigger_claim}","evidence_ids":["{te}"],"note":"n1"}},{{"kind":"propagated_symptom","candidate_id":"{symptom_c}","claim_id":"{symptom_claim}","evidence_ids":["{se}"],"note":"n2"}}]}}"#,
        te = evidence_id(trigger_c, trigger_seq),
        se = evidence_id(symptom_c, symptom_seq)
    )
}

fn empty_review() -> String {
    r#"{"schema":"contextdesk.multi_model.review.v1","evidence_gaps":[],"contradictions":[]}"#
        .into()
}

fn colluding_review() -> String {
    r#"{"schema":"contextdesk.multi_model.review.v1","evidence_gaps":[],"contradictions":[{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"cc-k1","candidate_b":"k2","claim_b_id":"s-k2","text":"both agree this is the cause","evidence_ids":["e:k1:1","e:k2:2"]}]}"#.into()
}

fn colluding_review_on_observations() -> String {
    r#"{"schema":"contextdesk.multi_model.review.v1","evidence_gaps":[],"contradictions":[{"contradiction_id":"x-collude","candidate_a":"k1","claim_a_id":"o-k1","candidate_b":"k2","claim_b_id":"o-k2","text":"both agree this is the cause","evidence_ids":["e:k1:3","e:k2:4"]}]}"#.into()
}

fn causal_proposal_with_disproof() -> String {
    r#"{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"cc-k1","evidence_ids":["e:k1:1"],"note":"n1"},{"kind":"propagated_symptom","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"],"note":"n2"},{"kind":"disconfirmation","candidate_id":"k1","claim_id":"o-k1","evidence_ids":["e:k1:3"],"note":"n3"}]}"#.into()
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

fn two_candidates() -> Vec<BroadLogTriageCandidate> {
    vec![candidate("k1", &[1]), candidate("k2", &[2])]
}

fn host_packet(
    candidates: &[BroadLogTriageCandidate],
    bind: AnswerBindingV1,
) -> FastTriagePacketV1 {
    build_fast_triage_packet(
        candidates,
        None,
        bind,
        FastTriageClockCompatibility::OrderOnly,
        FastTriageNeighborhoodBudget::default(),
    )
    .expect("host packet")
}

struct RunResult {
    outcome: MultiModelOutcome,
    stages: Vec<StageProgressEvent>,
}

struct CountingBackend {
    inner: ScriptedBackend,
    calls: AtomicU32,
}

impl CountingBackend {
    fn new(responses: Vec<ChatCompletion>) -> Self {
        Self {
            inner: ScriptedBackend::new(responses),
            calls: AtomicU32::new(0),
        }
    }
    fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl ChatBackend for CountingBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<ChatCompletion, CoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.complete(messages, tools).await
    }
}

struct RunCfg<'a> {
    budget: MultiModelBudget,
    packet: Option<&'a FastTriagePacketV1>,
    deadline_ms: u64,
    cancel: Option<Arc<AtomicBool>>,
    started_paused: bool,
}

fn run_pipeline(
    inv: &dyn ChatBackend,
    rev: &dyn ChatBackend,
    candidates: &[BroadLogTriageCandidate],
    cfg: RunCfg<'_>,
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
        comparison_context: None,
        causal_packet: cfg.packet,
        binding: binding(),
        budget: cfg.budget,
        role_ids: role_ids(),
        deadline_ms: cfg.deadline_ms,
        started_at: None,
        cancel: cfg.cancel,
    };
    let mut builder = tokio::runtime::Builder::new_current_thread();
    builder.enable_all();
    if cfg.started_paused {
        builder.start_paused(true);
    }
    let rt = builder.build().unwrap();
    let outcome = rt
        .block_on(run_review_pipeline(&backends, inputs, &mut |event| {
            stages.push(event);
        }))
        .expect("pipeline never returns a raw Err");
    RunResult { outcome, stages }
}

fn run_default(
    investigator: Vec<ChatCompletion>,
    reviewer: Vec<ChatCompletion>,
    candidates: &[BroadLogTriageCandidate],
    packet: Option<&FastTriagePacketV1>,
) -> RunResult {
    let inv = ScriptedBackend::new(investigator);
    let rev = ScriptedBackend::new(reviewer);
    run_pipeline(
        &inv,
        &rev,
        candidates,
        RunCfg {
            budget: MultiModelBudget::default(),
            packet,
            deadline_ms: 0,
            cancel: None,
            started_paused: false,
        },
    )
}

fn established(outcome: &MultiModelOutcome) -> bool {
    match outcome {
        MultiModelOutcome::Completed { envelope, .. } => envelope.answer.root_cause_established,
        _ => false,
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

fn completed_content(outcome: &MultiModelOutcome) -> &str {
    match outcome {
        MultiModelOutcome::Completed { content, .. } => content.as_str(),
        other => panic!("expected Completed, got {}", outcome_label(other)),
    }
}

fn telemetry_json(outcome: &MultiModelOutcome) -> String {
    match outcome {
        MultiModelOutcome::Completed { telemetry, .. }
        | MultiModelOutcome::FailedClosed { telemetry, .. } => {
            serde_json::to_string(telemetry).expect("telemetry json")
        }
        _ => String::new(),
    }
}

fn valid_causal_scripts() -> (Vec<ChatCompletion>, Vec<ChatCompletion>) {
    (
        vec![
            completion(trigger_finding("k1", 1, "cc-k1")),
            completion(symptom_finding("k2", 2, "s-k2")),
            completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
            completion(causal_answer("k1", 1, "k2", 2)),
        ],
        vec![completion(empty_review())],
    )
}

fn rebuild_packet(
    packet: &FastTriagePacketV1,
    mutate: impl Fn(&mut HostEvidenceEntry, &mut AnswerBindingV1),
) -> FastTriagePacketV1 {
    let mut entries = packet.ledger().entries();
    let mut bind = packet.ledger().binding().clone();
    for entry in &mut entries {
        mutate(entry, &mut bind);
    }
    bind.ledger_digest = HostEvidenceLedger::digest(&entries);
    let ledger = HostEvidenceLedger::new(bind, entries).expect("rebuilt ledger");
    FastTriagePacketV1::from_ledger(
        ledger,
        packet.independent_candidate_id(),
        packet.timeline_complete(),
    )
}

#[test]
fn root_cause_requires_both_validators_on_the_shipped_pipeline() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());
    let (inv, rev) = valid_causal_scripts();
    let RunResult { outcome, stages } = run_default(inv, rev, &candidates, Some(&packet));
    assert!(established(&outcome));
    assert!(stages.iter().any(|stage| {
        stage.role == InvestigationRole::CausalSynthesizer
            && stage.outcome == Some(StageOutcomeKind::Completed)
    }));
    let content = completed_content(&outcome);
    assert!(content.starts_with("# Investigation answer"));
    assert!(content.contains("Root cause established: yes"));

    let inv_no_causal_claim = vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
        completion(observation_answer(&[("k1", 1), ("k2", 2)])),
    ];
    let withheld = run_default(
        inv_no_causal_claim,
        vec![completion(empty_review())],
        &candidates,
        Some(&packet),
    );
    assert!(!established(&withheld.outcome));
    let useful = completed_content(&withheld.outcome);
    assert!(useful.contains("# Investigation answer"));
    assert!(useful.contains("Root cause established: no"));
}

#[test]
fn missing_packet_stays_causal_neutral_with_a_useful_answer() {
    let candidates = two_candidates();
    let inv = vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(causal_answer("k1", 1, "k2", 2)),
    ];
    let RunResult { outcome, stages } =
        run_default(inv, vec![completion(empty_review())], &candidates, None);
    assert!(!established(&outcome));
    assert!(stages
        .iter()
        .all(|stage| stage.role != InvestigationRole::CausalSynthesizer));
    let content = completed_content(&outcome);
    assert!(content.contains("# Investigation answer"));
    assert!(!content.is_empty());
}

#[test]
fn hostile_packets_cannot_grant_authority() {
    let candidates = two_candidates();
    let honest = host_packet(&candidates, binding());
    let mut other_session = binding();
    other_session.session_id = "other-session".into();
    let mut other_turn = binding();
    other_turn.turn_id = "s::other-turn".into();
    let mut other_corpus = binding();
    other_corpus.corpus_id = "other-corpus".into();
    let mut stale_bind = binding();
    stale_bind.revision.event_revision = 1;
    let foreign = host_packet(&[candidate("k9", &[9]), candidate("k8", &[8])], binding());
    let structurally_altered = rebuild_packet(&honest, |entry, _| {
        if entry.evidence_id == "e:k1:1" {
            entry.locator = "seq=99".into();
        }
    });
    let identity_drifted = rebuild_packet(&honest, |entry, _| {
        if entry.evidence_id == "e:k1:1" {
            entry.source_label = "src/drift.log".into();
        }
    });
    let stale = host_packet(&candidates, stale_bind);

    let scripts = || {
        (
            vec![
                completion(trigger_finding("k1", 1, "cc-k1")),
                completion(symptom_finding("k2", 2, "s-k2")),
                completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
                completion(causal_answer("k1", 1, "k2", 2)),
            ],
            vec![completion(empty_review())],
        )
    };

    let cases: [(&str, FastTriagePacketV1); 8] = [
        ("cross-session", host_packet(&candidates, other_session)),
        ("cross-turn", host_packet(&candidates, other_turn)),
        ("cross-corpus", host_packet(&candidates, other_corpus)),
        ("stale-revision", stale),
        ("foreign-packet", foreign),
        ("structurally-altered", structurally_altered),
        ("identity-drifted", identity_drifted),
        ("wrong-revision-packet", {
            let mut bind = binding();
            bind.revision.template_analysis_revision = 99;
            host_packet(&candidates, bind)
        }),
    ];
    for (name, packet) in cases {
        let (inv, rev) = scripts();
        let RunResult { outcome, .. } = run_default(inv, rev, &candidates, Some(&packet));
        assert!(
            !established(&outcome),
            "{name} must not establish a root cause"
        );
    }

    let rejected = vec![
        candidate("k1", &[1]),
        candidate("k2", &[2]),
        candidate("k3", &[3]),
    ];
    let rejected_packet = host_packet(&rejected, binding());
    let inv = vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion("not-a-finding".into()),
        completion("still-not-a-finding".into()),
        completion(causal_proposal("k3", "cc-k3", 3, "k2", "s-k2", 2)),
        completion(observation_answer(&[("k1", 1), ("k2", 2)])),
    ];
    let RunResult { outcome, .. } = run_default(
        inv,
        vec![completion(empty_review())],
        &rejected,
        Some(&rejected_packet),
    );
    assert!(!established(&outcome));
}

#[test]
fn causal_proposal_mutations_fail_closed() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());
    let valid = causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2);
    let mutations: [(&str, String); 13] = [
        (
            "false_union",
            causal_proposal("k99", "cc-k1", 1, "k2", "s-k2", 2),
        ),
        (
            "wrong_candidate_claim",
            causal_proposal("k1", "s-k2", 1, "k2", "s-k2", 2),
        ),
        (
            "duplicate_relation",
            r#"{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"cc-k1","evidence_ids":["e:k1:1"]},{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"cc-k1","evidence_ids":["e:k1:1"]},{"kind":"propagated_symptom","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"]}]}"#.into(),
        ),
        (
            "duplicate_evidence",
            r#"{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"cc-k1","evidence_ids":["e:k1:1","e:k1:1"]},{"kind":"propagated_symptom","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"]}]}"#.into(),
        ),
        (
            "unknown_field_frequency",
            valid.replacen(r#""note":"n1""#, r#""note":"n1","frequency":9"#, 1),
        ),
        (
            "unknown_field_chronology",
            valid.replacen(r#""note":"n1""#, r#""note":"n1","earlier":true"#, 1),
        ),
        (
            "unknown_field_ordering",
            valid.replacen(r#""note":"n1""#, r#""note":"n1","ordering":0"#, 1),
        ),
        (
            "injected_host_field",
            valid.replacen(
                r#""schema":"#,
                r#""root_cause_established":true,"schema":"#,
                1,
            ),
        ),
        (
            "symptom_promotion",
            causal_proposal("k2", "s-k2", 2, "k2", "s-k2", 2),
        ),
        (
            "recovery_as_cause",
            r#"{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{"kind":"recovery","candidate_id":"k1","claim_id":"cc-k1","evidence_ids":["e:k1:1"]},{"kind":"propagated_symptom","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"]}]}"#.into(),
        ),
        (
            "decoy_promotion",
            r#"{"schema":"contextdesk.multi_model.causal_synthesis.v1","relations":[{"kind":"initiating_trigger","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"]},{"kind":"propagated_symptom","candidate_id":"k2","claim_id":"s-k2","evidence_ids":["e:k2:2"]}]}"#.into(),
        ),
        (
            "missing_disproof",
            causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2),
        ),
        (
            "causal_prose",
            "The initiating trigger is k1 because it happened first and more often.".into(),
        ),
    ];

    for (name, proposal) in mutations {
        let review = if name == "missing_disproof" {
            colluding_review()
        } else {
            empty_review()
        };
        let inv = vec![
            completion(trigger_finding("k1", 1, "cc-k1")),
            completion(symptom_finding("k2", 2, "s-k2")),
            completion(proposal),
            completion(causal_answer("k1", 1, "k2", 2)),
        ];
        let RunResult { outcome, .. } =
            run_default(inv, vec![completion(review)], &candidates, Some(&packet));
        assert!(
            !established(&outcome),
            "{name} must fail closed without establishment"
        );
        if let MultiModelOutcome::Completed { content, .. } = &outcome {
            assert!(
                !content.is_empty(),
                "{name} may still yield a useful answer"
            );
        }
    }
}

#[test]
fn required_fail_closed_axes_are_named_in_this_lab() {
    for axis in REQUIRED_FAIL_CLOSED_AXES {
        assert!(
            THIS_LAB.contains(axis),
            "required fail-closed axis {axis} must remain named in this lab"
        );
    }
    assert!(
        THIS_LAB.contains("fn reviewer_collusion"),
        "reviewer_collusion must remain a named production driver"
    );
    assert!(
        !THIS_LAB.contains("(\"reviewer_collusion\""),
        "do not put reviewer_collusion in the homogeneous !established table"
    );
    let theater = format!("{}{}{}", "not-a-", "causal-", "object");
    assert!(
        !THIS_LAB.contains(&theater),
        "do not theater-collusion with malformed JSON"
    );
}

/// Required fail-closed axis `reviewer_collusion`. Production currently fails
/// this axis: colluding review on an otherwise-valid proposal still
/// establishes. Recorded here; not a `!established` table row.
#[test]
fn reviewer_collusion() {
    let candidates = vec![candidate("k1", &[1, 3]), candidate("k2", &[2, 4])];
    let packet = host_packet(&candidates, binding());
    let inv = vec![
        completion(trigger_finding_with_obs("k1", 1, "cc-k1", 3, "o-k1")),
        completion(symptom_finding_with_obs("k2", 2, "s-k2", 4, "o-k2")),
        completion(causal_proposal_with_disproof()),
        completion(causal_answer("k1", 1, "k2", 2)),
    ];
    let RunResult { outcome, stages } = run_default(
        inv,
        vec![completion(colluding_review_on_observations())],
        &candidates,
        Some(&packet),
    );
    assert!(
        stages.iter().any(|stage| {
            stage.role == InvestigationRole::CausalSynthesizer
                && stage.outcome == Some(StageOutcomeKind::Completed)
        }),
        "collusion-only driver must reach a completed causal stage"
    );
    assert!(
        stages.iter().any(|stage| {
            stage.role == InvestigationRole::Synthesizer
                && stage.outcome == Some(StageOutcomeKind::Completed)
        }),
        "collusion-only driver must reach a completed synthesizer stage"
    );
    assert!(
        established(&outcome),
        "PRODUCTION CURRENTLY FAILS reviewer_collusion: otherwise-valid proposal + colluding review still sets root_cause_established=true"
    );
}

#[test]
fn shared_raw_claim_id_across_candidates_can_establish() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());
    let inv = vec![
        completion(trigger_finding("k1", 1, "q00aa")),
        completion(symptom_finding("k2", 2, "q00aa")),
        completion(causal_proposal("k1", "q00aa", 1, "k2", "q00aa", 2)),
        completion(causal_answer("k1", 1, "k2", 2)),
    ];
    let RunResult { outcome, .. } = run_default(
        inv,
        vec![completion(empty_review())],
        &candidates,
        Some(&packet),
    );
    assert!(established(&outcome));
}

#[test]
fn opaque_rename_and_permutation_preserve_authority() {
    let renamed = vec![candidate("z00a0", &[1]), candidate("z00a1", &[2])];
    let packet = host_packet(&renamed, binding());
    let inv = vec![
        completion(trigger_finding("z00a0", 1, "q00bb")),
        completion(symptom_finding("z00a1", 2, "q00cc")),
        completion(causal_proposal("z00a0", "q00bb", 1, "z00a1", "q00cc", 2)),
        completion(causal_answer("z00a0", 1, "z00a1", 2)),
    ];
    let a = run_default(
        inv,
        vec![completion(empty_review())],
        &renamed,
        Some(&packet),
    );
    assert!(established(&a.outcome));

    let permuted = vec![candidate("z00a1", &[2]), candidate("z00a0", &[1])];
    let packet_b = host_packet(&permuted, binding());
    let inv_b = vec![
        completion(symptom_finding("z00a1", 2, "q00cc")),
        completion(trigger_finding("z00a0", 1, "q00bb")),
        completion(causal_proposal("z00a0", "q00bb", 1, "z00a1", "q00cc", 2)),
        completion(causal_answer("z00a0", 1, "z00a1", 2)),
    ];
    let b = run_default(
        inv_b,
        vec![completion(empty_review())],
        &permuted,
        Some(&packet_b),
    );
    assert_eq!(established(&a.outcome), established(&b.outcome));
}

#[test]
fn malformed_exhaustion_provider_budget_timeout_cancel_preserve_final_reserve() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());

    let malformed = vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion("not-json".into()),
        completion("still-not-json".into()),
        completion(observation_answer(&[("k1", 1), ("k2", 2)])),
    ];
    let budget = MultiModelBudget {
        max_semantic_corrections_per_stage: 1,
        ..MultiModelBudget::default()
    };
    let inv = ScriptedBackend::new(malformed);
    let rev = ScriptedBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, stages } = run_pipeline(
        &inv,
        &rev,
        &candidates,
        RunCfg {
            budget,
            packet: Some(&packet),
            deadline_ms: 0,
            cancel: None,
            started_paused: false,
        },
    );
    assert!(!established(&outcome));
    assert!(stages.iter().any(|stage| {
        stage.role == InvestigationRole::CausalSynthesizer
            && stage.outcome == Some(StageOutcomeKind::SemanticInvalid)
    }));
    assert!(completed_content(&outcome).contains("# Investigation answer"));

    // Provider failure at the causal call: third synthesizer-shared call fails,
    // fourth is the reserved final answer.
    struct CausalProviderFail {
        calls: AtomicU32,
        answers: std::sync::Mutex<Vec<ChatCompletion>>,
    }
    #[async_trait::async_trait]
    impl ChatBackend for CausalProviderFail {
        async fn complete(
            &self,
            _m: &[ChatMessage],
            _t: &[ToolSpec],
        ) -> Result<ChatCompletion, CoreError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 2 {
                return Err(CoreError::ProviderHttp {
                    operation: "stream".into(),
                    status: 500,
                    status_line: "500 Internal Server Error".into(),
                    body: "{}".into(),
                });
            }
            self.answers
                .lock()
                .unwrap()
                .get(n as usize)
                .cloned()
                .ok_or_else(|| CoreError::Message("script exhausted".into()))
        }
    }
    let provider = CausalProviderFail {
        calls: AtomicU32::new(0),
        answers: std::sync::Mutex::new(vec![
            completion(trigger_finding("k1", 1, "cc-k1")),
            completion(symptom_finding("k2", 2, "s-k2")),
            completion("unused-causal".into()),
            completion(observation_answer(&[("k1", 1), ("k2", 2)])),
        ]),
    };
    let rev = ScriptedBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, stages } = run_pipeline(
        &provider,
        &rev,
        &candidates,
        RunCfg {
            budget: MultiModelBudget::default(),
            packet: Some(&packet),
            deadline_ms: 0,
            cancel: None,
            started_paused: false,
        },
    );
    assert!(!established(&outcome));
    assert!(stages.iter().any(|stage| {
        stage.role == InvestigationRole::CausalSynthesizer
            && stage.outcome == Some(StageOutcomeKind::ProviderFailed)
    }));
    assert!(completed_content(&outcome).contains("# Investigation answer"));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);

    let skip_budget = MultiModelBudget {
        max_total_provider_rounds: 5,
        max_semantic_corrections_per_stage: 1,
        ..MultiModelBudget::default()
    };
    let inv = CountingBackend::new(vec![
        completion("bad-k1".into()),
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion("bad-k2".into()),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(observation_answer(&[("k1", 1), ("k2", 2)])),
    ]);
    let rev = CountingBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, stages } = run_pipeline(
        &inv,
        &rev,
        &candidates,
        RunCfg {
            budget: skip_budget,
            packet: Some(&packet),
            deadline_ms: 0,
            cancel: None,
            started_paused: false,
        },
    );
    assert!(
        stages.iter().any(|stage| {
            stage.role == InvestigationRole::CausalSynthesizer
                && stage.outcome == Some(StageOutcomeKind::Skipped)
        }),
        "insufficient budget must skip causal synthesis to preserve the final-answer reserve"
    );
    let MultiModelOutcome::Completed {
        telemetry,
        content,
        envelope,
        ..
    } = &outcome
    else {
        panic!(
            "insufficient budget must still complete a useful answer, got {}",
            outcome_label(&outcome)
        );
    };
    let causal = telemetry
        .stages
        .iter()
        .find(|stage| stage.role == InvestigationRole::CausalSynthesizer)
        .expect("causal synthesizer telemetry");
    assert_eq!(causal.outcome, StageOutcomeKind::Skipped);
    assert_eq!(causal.provider_rounds, 0);
    let synth = telemetry
        .stages
        .iter()
        .find(|stage| stage.role == InvestigationRole::Synthesizer)
        .expect("synthesizer telemetry");
    assert_eq!(synth.outcome, StageOutcomeKind::Completed);
    assert!(stages
        .iter()
        .any(|stage| stage.role == InvestigationRole::Synthesizer && stage.started));
    assert!(!envelope.answer.root_cause_established);
    assert!(!content.is_empty());
    assert!(content.contains("# Investigation answer"));
    assert!(telemetry.total_provider_rounds <= 5);
    assert_eq!(rev.calls(), 0, "reviewer must also yield to the reserve");
    assert_eq!(inv.calls(), 5, "four investigator attempts + one synthesis");

    let inv_ok = CountingBackend::new(vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
        completion(observation_answer(&[("k1", 1), ("k2", 2)])),
    ]);
    struct SleepOnThird {
        calls: AtomicU32,
        inner: CountingBackend,
    }
    #[async_trait::async_trait]
    impl ChatBackend for SleepOnThird {
        async fn complete(
            &self,
            m: &[ChatMessage],
            t: &[ToolSpec],
        ) -> Result<ChatCompletion, CoreError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n >= 2 {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
            self.inner.complete(m, t).await
        }
    }
    let sleeper = SleepOnThird {
        calls: AtomicU32::new(0),
        inner: inv_ok,
    };
    let rev = ScriptedBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, stages } = run_pipeline(
        &sleeper,
        &rev,
        &candidates,
        RunCfg {
            budget: MultiModelBudget::default(),
            packet: Some(&packet),
            deadline_ms: 100,
            cancel: None,
            started_paused: true,
        },
    );
    assert!(
        matches!(outcome, MultiModelOutcome::Deadline),
        "expected Deadline, got {}",
        outcome_label(&outcome)
    );
    assert!(!established(&outcome));
    assert!(
        stages
            .iter()
            .any(|stage| stage.role == InvestigationRole::CausalSynthesizer && stage.started),
        "causal stage must have started before the turn deadline"
    );
    assert!(
        !stages
            .iter()
            .any(|stage| stage.role == InvestigationRole::Synthesizer && stage.started),
        "deadline must not spend the final-answer reserve"
    );

    let cancel = Arc::new(AtomicBool::new(false));
    struct CancelOnCausal {
        cancel: Arc<AtomicBool>,
        calls: AtomicU32,
        inner: ScriptedBackend,
    }
    #[async_trait::async_trait]
    impl ChatBackend for CancelOnCausal {
        async fn complete(
            &self,
            m: &[ChatMessage],
            t: &[ToolSpec],
        ) -> Result<ChatCompletion, CoreError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n >= 2 {
                self.cancel.store(true, Ordering::SeqCst);
                return Err(CoreError::ProviderHttp {
                    operation: "stream".into(),
                    status: 500,
                    status_line: "500 Internal Server Error".into(),
                    body: "{}".into(),
                });
            }
            self.inner.complete(m, t).await
        }
    }
    let cancelling = CancelOnCausal {
        cancel: cancel.clone(),
        calls: AtomicU32::new(0),
        inner: ScriptedBackend::new(vec![
            completion(trigger_finding("k1", 1, "cc-k1")),
            completion(symptom_finding("k2", 2, "s-k2")),
        ]),
    };
    let rev = ScriptedBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, .. } = run_pipeline(
        &cancelling,
        &rev,
        &candidates,
        RunCfg {
            budget: MultiModelBudget::default(),
            packet: Some(&packet),
            deadline_ms: 0,
            cancel: Some(cancel),
            started_paused: false,
        },
    );
    assert!(
        matches!(outcome, MultiModelOutcome::Cancelled),
        "expected Cancelled, got {}",
        outcome_label(&outcome)
    );
    assert!(!established(&outcome));
}

#[test]
fn telemetry_is_share_safe_and_names_stage_states() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());
    let (inv, rev) = valid_causal_scripts();
    let RunResult { outcome, .. } = run_default(inv, rev, &candidates, Some(&packet));
    let encoded = telemetry_json(&outcome);
    for needle in [
        "excerpt-k1",
        "excerpt-k2",
        "sk-",
        "password",
        "bearer ",
        "api_key",
    ] {
        assert!(
            !encoded.to_ascii_lowercase().contains(needle),
            "telemetry leaked {needle}"
        );
    }
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        let kinds: Vec<_> = telemetry.stages.iter().map(|s| s.outcome).collect();
        assert!(kinds.contains(&StageOutcomeKind::Completed));
        assert_eq!(telemetry.total_provider_rounds, 5);
    }
}

#[test]
fn exact_provider_calls_and_alternate_text_cannot_mint_authority() {
    let candidates = two_candidates();
    let packet = host_packet(&candidates, binding());
    let inv = CountingBackend::new(vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
        completion(causal_answer("k1", 1, "k2", 2)),
    ]);
    let rev = CountingBackend::new(vec![completion(empty_review())]);
    let RunResult { outcome, .. } = run_pipeline(
        &inv,
        &rev,
        &candidates,
        RunCfg {
            budget: MultiModelBudget::default(),
            packet: Some(&packet),
            deadline_ms: 0,
            cancel: None,
            started_paused: false,
        },
    );
    assert!(established(&outcome));
    assert_eq!(inv.calls(), 4, "two findings + causal + final answer");
    assert_eq!(rev.calls(), 1);
    if let MultiModelOutcome::Completed { telemetry, .. } = &outcome {
        assert_eq!(telemetry.total_provider_rounds, 5);
    }

    let swapped = vec![
        completion(trigger_finding("k1", 1, "cc-k1")),
        completion(symptom_finding("k2", 2, "s-k2")),
        completion(causal_answer("k1", 1, "k2", 2)),
        completion(causal_proposal("k1", "cc-k1", 1, "k2", "s-k2", 2)),
    ];
    let RunResult { outcome, .. } = run_default(
        swapped,
        vec![completion(empty_review())],
        &candidates,
        Some(&packet),
    );
    assert!(
        !established(&outcome),
        "swapping causal/answer payloads must not mint authority"
    );
}
