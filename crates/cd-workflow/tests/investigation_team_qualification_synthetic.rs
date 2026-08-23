//! Focused lab for the synthetic Investigation Team qualification runner.
//!
//! Drives [`cd_workflow::investigation_team_qualification_synthetic::execute_synthetic`],
//! which must call the shipped `execute` seam. No provider, network, or
//! filesystem persistence is constructed.

use cd_core::investigation_team_qualification::{
    failure_reason, InvestigationTeamRole, MemberBinding,
};
use cd_workflow::investigation_team_qualification::QualificationStatus;
use cd_workflow::investigation_team_qualification_synthetic::{
    execute_synthetic, SyntheticQualificationMode, SyntheticQualificationRequest,
};

const OBSERVED_AT: i64 = 1_777_000_000;
const SYNTHETIC_GATEWAY: &str = "https://xid-syn-gateway.example.test/v1";
const SYNTHETIC_MODULE: &str = include_str!("../src/investigation_team_qualification_synthetic.rs");

fn member(
    role: InvestigationTeamRole,
    profile: &str,
    model: &str,
    deployment: &str,
) -> MemberBinding {
    MemberBinding::from_deployment(role, profile, model, deployment).expect("synthetic member")
}

fn request(
    members: Vec<MemberBinding>,
    mode: SyntheticQualificationMode,
) -> SyntheticQualificationRequest {
    SyntheticQualificationRequest {
        members,
        observed_at: OBSERVED_AT,
        mode,
    }
}

fn single_member() -> MemberBinding {
    member(
        InvestigationTeamRole::Single,
        "xid-syn-profile-nimbus",
        "xid-syn-model-orion",
        SYNTHETIC_GATEWAY,
    )
}

#[test]
fn completed_synthetic_run_is_qualified() {
    let result = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("completed synthetic");
    assert_eq!(result.status, QualificationStatus::Qualified);
    assert_eq!(result.status.as_str(), "qualified");
}

#[test]
fn partial_synthetic_attempt_is_partial() {
    let result = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Partial,
    ))
    .expect("partial synthetic");
    assert_eq!(result.status, QualificationStatus::Partial);
    assert!(result.has_incomplete_attempt());
}

#[test]
fn stale_synthetic_suite_is_stale() {
    let result = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Stale,
    ))
    .expect("stale synthetic");
    assert_eq!(result.status, QualificationStatus::Stale);
    assert!(result.report.fingerprint.stale);
}

#[test]
fn fingerprint_preserves_exact_role_model_profile_and_endpoint() {
    let binding = single_member();
    let result = execute_synthetic(request(
        vec![binding.clone()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("fingerprint");
    assert_eq!(result.report.fingerprint.members.len(), 1);
    let row = &result.report.fingerprint.members[0];
    assert_eq!(row.role, binding.role);
    assert_eq!(row.profile_id, binding.profile_id);
    assert_eq!(row.model_id, binding.model_id);
    assert_eq!(row.endpoint_fingerprint, binding.endpoint_fingerprint);
}

#[test]
fn shared_model_subject_across_distinct_roles_remains_valid() {
    let profile = "xid-syn-profile-shared";
    let model = "xid-syn-model-shared";
    let investigator = member(
        InvestigationTeamRole::Investigator,
        profile,
        model,
        SYNTHETIC_GATEWAY,
    );
    let reviewer = member(
        InvestigationTeamRole::Reviewer,
        profile,
        model,
        SYNTHETIC_GATEWAY,
    );
    let result = execute_synthetic(request(
        vec![investigator.clone(), reviewer.clone()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("shared subject");
    assert_eq!(result.status, QualificationStatus::Qualified);
    assert_eq!(result.report.fingerprint.members.len(), 2);
    for expected in [&investigator, &reviewer] {
        let row = result
            .report
            .fingerprint
            .members
            .iter()
            .find(|member| member.role == expected.role)
            .expect("role present");
        assert_eq!(row.model_id, expected.model_id);
        assert_eq!(row.profile_id, expected.profile_id);
        assert_eq!(row.endpoint_fingerprint, expected.endpoint_fingerprint);
    }
}

#[test]
fn duplicate_roles_fail_closed() {
    let error = execute_synthetic(request(
        vec![
            single_member(),
            member(
                InvestigationTeamRole::Single,
                "xid-syn-profile-vega",
                "xid-syn-model-vega",
                "https://xid-syn-review.example.test/v1",
            ),
        ],
        SyntheticQualificationMode::Completed,
    ))
    .expect_err("duplicate roles");
    assert!(error
        .to_string()
        .contains(failure_reason::DUPLICATE_ROLE_IDENTITY));
}

#[test]
fn empty_members_fail_closed() {
    let error = execute_synthetic(request(vec![], SyntheticQualificationMode::Completed))
        .expect_err("empty members");
    assert!(error.to_string().contains("at least one pipeline member"));
}

#[test]
fn invalid_identity_fails_closed() {
    let mut binding = single_member();
    binding.profile_id.clear();
    let error = execute_synthetic(request(
        vec![binding],
        SyntheticQualificationMode::Completed,
    ))
    .expect_err("invalid identity");
    assert!(error.to_string().contains(failure_reason::INVALID_METRICS));
}

#[test]
fn invalid_timestamp_fails_closed() {
    let error = execute_synthetic(SyntheticQualificationRequest {
        members: vec![single_member()],
        observed_at: 0,
        mode: SyntheticQualificationMode::Completed,
    })
    .expect_err("invalid timestamp");
    assert!(error.to_string().contains("positive unix timestamp"));
}

#[test]
fn redacted_exports_omit_url_evaluator_truth_and_excerpts() {
    let result = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("exports");
    for body in [&result.redacted_json, &result.redacted_markdown] {
        assert!(!body.contains("https://"));
        assert!(!body.contains(SYNTHETIC_GATEWAY));
        assert!(!body.contains("evaluator_truth"));
        assert!(!body.contains("answer_key"));
        assert!(!body.contains("opaque synthetic packet line"));
        assert!(!body.contains("Which opaque packet lines are required?"));
    }
}

#[test]
fn identical_inputs_yield_identical_report_digests() {
    let first = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("first");
    let second = execute_synthetic(request(
        vec![single_member()],
        SyntheticQualificationMode::Completed,
    ))
    .expect("second");
    assert_eq!(first.fingerprint_digest(), second.fingerprint_digest());
    assert_eq!(first.redacted_json, second.redacted_json);
}

#[test]
fn synthetic_module_does_not_construct_a_provider_or_network_seam() {
    assert!(SYNTHETIC_MODULE.contains("execute(input)"));
    assert!(SYNTHETIC_MODULE.contains("investigation_team_qualification::{execute"));
    for forbidden in [
        "reqwest",
        "wiremock",
        "TcpStream",
        "UdpSocket",
        "std::net",
        "std::fs",
        "tokio::net",
        "OpenAiCompatibleClient",
        "OllamaClient",
        "Keychain",
        "tauri",
    ] {
        assert!(
            !SYNTHETIC_MODULE.contains(forbidden),
            "synthetic runner must not mention {forbidden}"
        );
    }
}
