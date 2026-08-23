//! Hermetic Investigation Team qualification lab (issue #726 core slice).
//!
//! Drives the shipped `cd_core::investigation_team_qualification` scorer,
//! fingerprint, and report builders. No mocks, no network, no Keychain.

use cd_core::capability_qualification::fingerprint_endpoint;
use cd_core::investigation_answer::EvidenceRole;
use cd_core::investigation_team_qualification::{
    failure_reason, parse_report, pipeline_fingerprint, policy_budget_identity,
    provider_facing_json, qualify, render_json, render_markdown, AttemptClaim, AttemptRecord,
    AttemptStatus, CitationRecord, EvaluatorTruth, InvestigationTeamRole, MemberBinding,
    ProviderFacingDocument, ProviderFacingInput, QualificationInput, ToolCallRecord, SCHEMA_ID,
    SUITE_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

const PROFILE_NIMBUS: &str = "xid-profile-nimbus";
const PROFILE_VEGA: &str = "xid-profile-vega";
const MODEL_ORION: &str = "xid-model-orion";
const MODEL_VEGA: &str = "xid-model-vega";
const MODEL_UNRELATED: &str = "xid-model-unrelated-inventory";
const EV_VELVET: &str = "xid-ev-velvet";
const EV_QUARTZ: &str = "xid-ev-quartz";
const SRC_VELVET: &str = "xid-src-velvet";
const SRC_QUARTZ: &str = "xid-src-quartz";
const TIME_VELVET: &str = "t-velvet-1";
const TIME_QUARTZ: &str = "t-quartz-1";
const ATTEMPT_ORION: &str = "xid-attempt-orion";
const ATTEMPT_VEGA: &str = "xid-attempt-vega";

const LEAK_TRUTH: &str = "evaluator_truth";
const LEAK_ANSWER_KEY: &str = "answer_key";
const LEAK_TOKEN: &str = "sk-heldoutzz9token";
const LEAK_ENDPOINT: &str = "https://heldout-gateway.internal.test/v1";
const LEAK_REVIEW_ENDPOINT: &str = "https://heldout-reviewer.internal.test/v1";
const LEAK_PATH: &str = "/opt/heldout/vault/secret.txt";
const LEAK_USERS: &str = "/Users/heldout/secret.txt";
const LEAK_BEARER: &str = "Bearer heldout-secret-value";
const LEAK_ALIAS: &str = "flash-heldout-alias";

const LEAK_TOKENS: &[&str] = &[
    LEAK_TRUTH,
    LEAK_ANSWER_KEY,
    LEAK_TOKEN,
    LEAK_ENDPOINT,
    LEAK_REVIEW_ENDPOINT,
    LEAK_PATH,
    LEAK_USERS,
    LEAK_BEARER,
    LEAK_ALIAS,
    MODEL_UNRELATED,
];

fn investigator() -> MemberBinding {
    let mut member = MemberBinding::from_deployment(
        InvestigationTeamRole::Investigator,
        PROFILE_NIMBUS,
        MODEL_ORION,
        LEAK_ENDPOINT,
    )
    .expect("investigator member");
    member.display_alias = Some(LEAK_ALIAS.into());
    member
}

fn reviewer() -> MemberBinding {
    MemberBinding::from_deployment(
        InvestigationTeamRole::Reviewer,
        PROFILE_VEGA,
        MODEL_VEGA,
        LEAK_REVIEW_ENDPOINT,
    )
    .expect("reviewer member")
}

fn truth() -> EvaluatorTruth {
    EvaluatorTruth {
        required_evidence_ids: BTreeSet::from([EV_VELVET.into(), EV_QUARTZ.into()]),
        required_sources: BTreeMap::from([
            (EV_VELVET.into(), SRC_VELVET.into()),
            (EV_QUARTZ.into(), SRC_QUARTZ.into()),
        ]),
        required_times: BTreeMap::from([
            (EV_VELVET.into(), TIME_VELVET.into()),
            (EV_QUARTZ.into(), TIME_QUARTZ.into()),
        ]),
        forbidden_provider_tokens: BTreeSet::from([
            LEAK_TRUTH.into(),
            LEAK_ANSWER_KEY.into(),
            LEAK_TOKEN.into(),
        ]),
    }
}

fn packet() -> Vec<ProviderFacingDocument> {
    vec![
        ProviderFacingDocument {
            id: EV_VELVET.into(),
            text: "opaque velvet packet line".into(),
        },
        ProviderFacingDocument {
            id: EV_QUARTZ.into(),
            text: "opaque quartz packet line".into(),
        },
    ]
}

fn citation(evidence: &str, source: &str, time: &str) -> CitationRecord {
    CitationRecord {
        evidence_id: evidence.into(),
        source_id: source.into(),
        time_anchor: time.into(),
        role: EvidenceRole::Supporting,
    }
}

fn completed_attempt(
    id: &str,
    role: InvestigationTeamRole,
    profile: &str,
    model: &str,
    endpoint: &str,
) -> AttemptRecord {
    AttemptRecord {
        attempt_id: id.into(),
        role,
        model_id: model.into(),
        profile_id: profile.into(),
        endpoint_fingerprint: fingerprint_endpoint(endpoint),
        status: AttemptStatus::Completed,
        completion_claimed: true,
        claims: vec![AttemptClaim {
            text: "velvet and quartz both cited".into(),
            evidence_ids: vec![EV_VELVET.into(), EV_QUARTZ.into()],
        }],
        tool_calls: vec![ToolCallRecord {
            name: "cd_qualify_lookup".into(),
            evidence_ids: vec![EV_VELVET.into(), EV_QUARTZ.into()],
        }],
        citations: vec![
            citation(EV_VELVET, SRC_VELVET, TIME_VELVET),
            citation(EV_QUARTZ, SRC_QUARTZ, TIME_QUARTZ),
        ],
        latency_ms: 40,
        resource_units: 12,
    }
}

fn opaque_input() -> QualificationInput {
    QualificationInput {
        schema_id: SCHEMA_ID.into(),
        current_suite_version: SUITE_VERSION.into(),
        suite_version: SUITE_VERSION.into(),
        observed_at: 1_777_000_000,
        stale: false,
        policy_budget_identity: policy_budget_identity(8, 100),
        max_tool_calls: 8,
        resource_budget: 100,
        members: vec![investigator(), reviewer()],
        provider_facing: ProviderFacingInput {
            question: "Which opaque packet lines are required?".into(),
            evidence_packet: packet(),
        },
        truth: truth(),
        attempts: vec![
            completed_attempt(
                ATTEMPT_ORION,
                InvestigationTeamRole::Investigator,
                PROFILE_NIMBUS,
                MODEL_ORION,
                LEAK_ENDPOINT,
            ),
            completed_attempt(
                ATTEMPT_VEGA,
                InvestigationTeamRole::Reviewer,
                PROFILE_VEGA,
                MODEL_VEGA,
                LEAK_REVIEW_ENDPOINT,
            ),
        ],
    }
}

fn reverse_bags(mut input: QualificationInput) -> QualificationInput {
    input.members.reverse();
    input.provider_facing.evidence_packet.reverse();
    input.attempts.reverse();
    for attempt in &mut input.attempts {
        attempt.claims.reverse();
        attempt.tool_calls.reverse();
        attempt.citations.reverse();
        for claim in &mut attempt.claims {
            claim.evidence_ids.reverse();
        }
        for tool in &mut attempt.tool_calls {
            tool.evidence_ids.reverse();
        }
    }
    input.truth.required_evidence_ids = input
        .truth
        .required_evidence_ids
        .iter()
        .rev()
        .cloned()
        .collect();
    input
}

fn assert_no_leaks(text: &str) {
    for token in LEAK_TOKENS {
        assert!(!text.contains(token), "export leaked `{token}`: {text}");
    }
}

type Mutate = fn(&mut QualificationInput);

struct ProjectionRow {
    name: &'static str,
    mutate: Mutate,
    expect_ok: bool,
    reason: Option<&'static str>,
    prove: Option<fn(&cd_core::investigation_team_qualification::QualificationReport)>,
}

struct TamperRow {
    name: &'static str,
    mutate_json: fn(&str) -> String,
}

fn projection_matrix() -> Vec<ProjectionRow> {
    vec![
        ProjectionRow {
            name: "truth_leakage_into_provider_facing",
            mutate: |input| {
                input.provider_facing.question = format!("see {LEAK_TRUTH} {LEAK_ANSWER_KEY}");
            },
            expect_ok: false,
            reason: Some(failure_reason::TRUTH_LEAKAGE),
            prove: None,
        },
        ProjectionRow {
            name: "persuasive_hallucination_fluent_without_evidence",
            mutate: |input| {
                input.attempts[0].citations.clear();
                input.attempts[0].claims[0].evidence_ids.clear();
                input.attempts[0].claims[0].text =
                    "fluent confident answer with no validated evidence".into();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                assert!(!report.axes.quality.contract_met);
                assert!(report.attempt_scores[0].fluent_without_evidence);
                assert!(report
                    .attempts
                    .iter()
                    .any(|row| row.status == AttemptStatus::Completed));
            }),
        },
        ProjectionRow {
            name: "alias_confusion_does_not_transfer_identity",
            mutate: |input| {
                input.members[1].display_alias = input.members[0].display_alias.clone();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                let ids: Vec<_> = report
                    .fingerprint
                    .members
                    .iter()
                    .map(|member| member.model_id.as_str())
                    .collect();
                assert!(ids.contains(&MODEL_ORION));
                assert!(ids.contains(&MODEL_VEGA));
                assert_ne!(
                    report.fingerprint.members[0].subject_storage_id,
                    report.fingerprint.members[1].subject_storage_id
                );
            }),
        },
        ProjectionRow {
            name: "crossed_deployment_identity",
            mutate: |input| {
                input.attempts[0].endpoint_fingerprint = fingerprint_endpoint(LEAK_REVIEW_ENDPOINT);
            },
            expect_ok: false,
            reason: Some(failure_reason::CROSSED_FINGERPRINT),
            prove: None,
        },
        ProjectionRow {
            name: "stale_suite_claim",
            mutate: |input| {
                input.suite_version =
                    "contextdesk.investigation_team_qualification.suite.v0".into();
                input.stale = false;
            },
            expect_ok: false,
            reason: Some(failure_reason::STALE_SUITE_CLAIM),
            prove: None,
        },
        ProjectionRow {
            name: "partial_execution_preserved",
            mutate: |input| {
                input.attempts[1].status = AttemptStatus::Partial;
                input.attempts[1].completion_claimed = false;
                input.attempts[1].claims.clear();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                assert!(report
                    .attempts
                    .iter()
                    .any(|row| row.status == AttemptStatus::Partial));
            }),
        },
        ProjectionRow {
            name: "cancellation_preserved",
            mutate: |input| {
                input.attempts[1].status = AttemptStatus::Cancelled;
                input.attempts[1].completion_claimed = false;
                input.attempts[1].claims.clear();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                assert!(report
                    .attempts
                    .iter()
                    .any(|row| row.status == AttemptStatus::Cancelled));
            }),
        },
        ProjectionRow {
            name: "timeout_preserved",
            mutate: |input| {
                input.attempts[1].status = AttemptStatus::TimedOut;
                input.attempts[1].completion_claimed = false;
                input.attempts[1].claims.clear();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                assert!(report
                    .attempts
                    .iter()
                    .any(|row| row.status == AttemptStatus::TimedOut));
                assert_eq!(
                    report.axes.speed.metrics.get("timed_out_attempts").copied(),
                    Some(1)
                );
            }),
        },
        ProjectionRow {
            name: "same_subject_two_roles",
            mutate: |input| {
                let shared = input.members[0].clone();
                input.members[1].profile_id = shared.profile_id.clone();
                input.members[1].model_id = shared.model_id.clone();
                input.members[1].endpoint_fingerprint = shared.endpoint_fingerprint.clone();
                input.members[1].deployment_url = shared.deployment_url.clone();
                input.attempts[1].profile_id = shared.profile_id.clone();
                input.attempts[1].model_id = shared.model_id.clone();
                input.attempts[1].endpoint_fingerprint = shared.endpoint_fingerprint.clone();
            },
            expect_ok: true,
            reason: None,
            prove: Some(|report| {
                assert_eq!(report.fingerprint.members.len(), 2);
                assert_eq!(
                    report.fingerprint.members[0].subject_storage_id,
                    report.fingerprint.members[1].subject_storage_id
                );
                let roles: Vec<_> = report
                    .fingerprint
                    .members
                    .iter()
                    .map(|member| member.role)
                    .collect();
                assert!(roles.contains(&InvestigationTeamRole::Investigator));
                assert!(roles.contains(&InvestigationTeamRole::Reviewer));
            }),
        },
        ProjectionRow {
            name: "duplicate_role_identities",
            mutate: |input| {
                input.members[1].role = InvestigationTeamRole::Investigator;
            },
            expect_ok: false,
            reason: Some(failure_reason::DUPLICATE_ROLE_IDENTITY),
            prove: None,
        },
        ProjectionRow {
            name: "invalid_metrics_empty_citation",
            mutate: |input| {
                input.attempts[0].citations[0].evidence_id.clear();
            },
            expect_ok: false,
            reason: Some(failure_reason::INVALID_METRICS),
            prove: None,
        },
        ProjectionRow {
            name: "dishonest_completion",
            mutate: |input| {
                input.attempts[1].status = AttemptStatus::Cancelled;
                input.attempts[1].completion_claimed = true;
            },
            expect_ok: false,
            reason: Some(failure_reason::DISHONEST_COMPLETION),
            prove: None,
        },
        ProjectionRow {
            name: "unknown_fields_on_input",
            mutate: |_| {},
            expect_ok: false,
            reason: Some(failure_reason::UNKNOWN_FIELD),
            prove: None,
        },
    ]
}

fn tamper_matrix() -> Vec<TamperRow> {
    vec![
        TamperRow {
            name: "report_tampering_quality_axis",
            mutate_json: |json| json.replacen("\"contract_met\":true", "\"contract_met\":false", 1),
        },
        TamperRow {
            name: "report_unknown_field",
            mutate_json: |json| json.replacen("{", "{\"heldout_extra\":true,", 1),
        },
        TamperRow {
            name: "report_fingerprint_digest_tamper",
            mutate_json: |json| {
                let report = parse_report(json).expect("baseline");
                json.replace(&report.fingerprint.digest, &"a".repeat(64))
            },
        },
    ]
}

#[test]
fn happy_path_scores_separate_axes_and_redacts_exports() {
    let report = qualify(opaque_input()).expect("qualify");
    assert!(report.axes.capability.contract_met);
    assert!(report.axes.quality.contract_met);
    assert!(report.axes.speed.contract_met);
    assert!(report.axes.resource.contract_met);
    assert_eq!(report.attempts.len(), 2);
    assert!(!report.fingerprint.stale);
    let json = render_json(&report).expect("json");
    let markdown = render_markdown(&report).expect("markdown");
    assert_no_leaks(&json);
    assert_no_leaks(&markdown);
    assert!(!json.to_ascii_lowercase().contains("best model"));
    assert!(markdown.contains("does not declare a universal best model"));
    let provider = provider_facing_json(&opaque_input()).expect("provider");
    assert_no_leaks(&provider);
    assert!(!provider.contains(LEAK_TRUTH));
    let round_trip = parse_report(&json).expect("parse");
    assert_eq!(round_trip, report);
}

#[test]
fn same_model_subject_in_two_roles_qualifies_and_fingerprints_both() {
    let mut input = opaque_input();
    let shared = investigator();
    let mut review = reviewer();
    review.profile_id = shared.profile_id.clone();
    review.model_id = shared.model_id.clone();
    review.endpoint_fingerprint = shared.endpoint_fingerprint.clone();
    review.deployment_url = shared.deployment_url.clone();
    input.members = vec![shared.clone(), review];
    input.attempts[1].profile_id = shared.profile_id.clone();
    input.attempts[1].model_id = shared.model_id.clone();
    input.attempts[1].endpoint_fingerprint = shared.endpoint_fingerprint.clone();

    let report = qualify(input).expect("split-role pipeline may share one subject");
    let roles: Vec<_> = report
        .fingerprint
        .members
        .iter()
        .map(|member| member.role)
        .collect();
    assert!(roles.contains(&InvestigationTeamRole::Investigator));
    assert!(roles.contains(&InvestigationTeamRole::Reviewer));
    assert_eq!(report.fingerprint.members.len(), 2);
    assert_eq!(
        report.fingerprint.members[0].subject_storage_id,
        report.fingerprint.members[1].subject_storage_id
    );
    assert_eq!(
        report.fingerprint.members[0].subject_storage_id,
        shared.subject().storage_id()
    );
    assert_eq!(
        report
            .attempts
            .iter()
            .map(|row| row.role)
            .collect::<Vec<_>>(),
        vec![
            InvestigationTeamRole::Investigator,
            InvestigationTeamRole::Reviewer
        ]
    );
}

#[test]
fn equivalent_reorder_is_byte_identical() {
    let left = qualify(opaque_input()).expect("left");
    let right = qualify(reverse_bags(opaque_input())).expect("right");
    assert_eq!(
        pipeline_fingerprint(&opaque_input()).unwrap().digest,
        pipeline_fingerprint(&reverse_bags(opaque_input()))
            .unwrap()
            .digest
    );
    assert_eq!(render_json(&left).unwrap(), render_json(&right).unwrap());
    assert_eq!(
        render_markdown(&left).unwrap(),
        render_markdown(&right).unwrap()
    );
}

#[test]
fn stale_marked_non_current_suite_is_scored_but_not_current() {
    let mut input = opaque_input();
    input.suite_version = "contextdesk.investigation_team_qualification.suite.v0".into();
    input.stale = true;
    let report = qualify(input).expect("stale allowed when flagged");
    assert!(report.fingerprint.stale);
    assert_ne!(report.fingerprint.suite_version, SUITE_VERSION);
}

#[test]
fn provider_facing_type_cannot_name_evaluator_truth() {
    let schema = serde_json::to_value(opaque_input().provider_facing).unwrap();
    let encoded = schema.to_string();
    assert!(!encoded.contains("required_evidence_ids"));
    assert!(!encoded.contains("forbidden_provider_tokens"));
    assert!(!encoded.contains("evaluator"));
}

#[test]
fn projection_matrix_drives_shipped_scorer() {
    for row in projection_matrix() {
        if row.name == "unknown_fields_on_input" {
            let json = serde_json::to_string(&opaque_input()).unwrap();
            let injected = json.replacen('{', r#"{"heldout_extra":true,"#, 1);
            let parsed: Result<QualificationInput, _> = serde_json::from_str(&injected);
            assert!(parsed.is_err(), "{}", row.name);
            let err = parsed.unwrap_err().to_string();
            assert!(
                err.contains("unknown field") || err.contains(failure_reason::UNKNOWN_FIELD),
                "{}: {err}",
                row.name
            );
            continue;
        }
        let mut input = opaque_input();
        (row.mutate)(&mut input);
        let result = qualify(input);
        if row.expect_ok {
            let report = result.unwrap_or_else(|err| panic!("{}: {err}", row.name));
            if let Some(prove) = row.prove {
                prove(&report);
            }
            let json = render_json(&report).expect(row.name);
            let markdown = render_markdown(&report).expect(row.name);
            assert_no_leaks(&json);
            assert_no_leaks(&markdown);
        } else {
            let err = result.expect_err(row.name).to_string();
            let reason = row.reason.expect("reason");
            assert!(
                err.contains(reason),
                "{} expected {reason} in {err}",
                row.name
            );
        }
    }
}

#[test]
fn tamper_matrix_revalidates_assembled_reports() {
    let baseline = render_json(&qualify(opaque_input()).unwrap()).unwrap();
    for row in tamper_matrix() {
        let mutated = (row.mutate_json)(&baseline);
        let err = parse_report(&mutated).expect_err(row.name).to_string();
        assert!(
            err.contains(failure_reason::TAMPERED_AGGREGATES)
                || err.contains(failure_reason::UNKNOWN_FIELD)
                || err.contains(failure_reason::CROSSED_FINGERPRINT)
                || err.contains("unknown field"),
            "{}: {err}",
            row.name
        );
    }
}

#[test]
fn member_from_deployment_reuses_shared_endpoint_fingerprint() {
    let member = investigator();
    assert_eq!(
        member.endpoint_fingerprint,
        fingerprint_endpoint(LEAK_ENDPOINT)
    );
    assert_eq!(
        member.subject().endpoint_fingerprint,
        member.endpoint_fingerprint
    );
}
