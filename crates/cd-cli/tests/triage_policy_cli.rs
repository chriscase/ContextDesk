//! Process-level proof for the provider-free Triage Policy V2 CLI surface.

use assert_cmd::Command;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    ContributorSlotV2, RolePreflightV2, RoleQualificationV2, RoleRequirement,
    TriageContributorRole, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
    TriageSlotKindV2,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary")
}

fn model(profile_id: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile_id.into(),
        model_id: model_id.into(),
    }
}

fn standard(remote_allowed: bool) -> TriagePolicyV2 {
    TriagePolicyV2::standard(
        model("gateway-profile", "openai/gpt-oss-120b"),
        remote_allowed,
    )
}

fn enhanced_same_model() -> TriagePolicyV2 {
    let shared = model("gateway-profile", "openai/gpt-oss-120b");
    let mut policy = TriagePolicyV2::standard(shared.clone(), false);
    policy.mode = TriagePolicyMode::Enhanced;
    policy.contributors = vec![
        ContributorSlotV2 {
            slot_id: "observe".into(),
            role: TriageContributorRole::ObservationExtractor,
            model: shared.clone(),
            requirement: RoleRequirement::Required,
            allow_remote: false,
        },
        ContributorSlotV2 {
            slot_id: "challenge".into(),
            role: TriageContributorRole::ContradictionChecker,
            model: shared,
            requirement: RoleRequirement::Optional,
            allow_remote: false,
        },
    ];
    policy
        .finalizer
        .as_mut()
        .expect("standard finalizer")
        .slot_id = "finalize".into();
    policy
}

fn facts(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
    let mut roles = Vec::new();
    for contributor in &policy.contributors {
        roles.push(RolePreflightV2 {
            slot_id: contributor.slot_id.clone(),
            model: contributor.model.clone(),
            kind: TriageSlotKindV2::Contributor(contributor.role),
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        });
    }
    if let Some(finalizer) = &policy.finalizer {
        roles.push(RolePreflightV2 {
            slot_id: finalizer.slot_id.clone(),
            model: finalizer.model.clone(),
            kind: TriageSlotKindV2::Finalizer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        });
    }
    if let Some(reviewer) = &policy.reviewer {
        roles.push(RolePreflightV2 {
            slot_id: reviewer.slot_id.clone(),
            model: reviewer.model.clone(),
            kind: TriageSlotKindV2::Reviewer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        });
    }
    TriagePolicyPreflightV2 { roles }
}

fn write_inputs(
    dir: &Path,
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
) -> (PathBuf, PathBuf) {
    let policy_path = dir.join("policy.json");
    let preflight_path = dir.join("preflight.json");
    std::fs::write(
        &policy_path,
        serde_json::to_vec_pretty(policy).expect("policy JSON"),
    )
    .expect("write policy");
    std::fs::write(
        &preflight_path,
        serde_json::to_vec_pretty(preflight).expect("preflight JSON"),
    )
    .expect("write preflight");
    (policy_path, preflight_path)
}

fn invoke(action: &str, policy: &Path, preflight: &Path) -> std::process::Output {
    cli()
        .args(["--json", "triage-policy", action, "--policy"])
        .arg(policy)
        .arg("--preflight")
        .arg(preflight)
        .output()
        .expect("run CLI")
}

fn envelope(output: &std::process::Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("one JSON envelope")
}

#[test]
fn compile_accepts_exact_namespaced_model_id_without_state_or_network() {
    let temp = tempfile::tempdir().expect("tempdir");
    let policy = standard(false);
    let (policy_path, preflight_path) = write_inputs(temp.path(), &policy, &facts(&policy));
    let poison_home = temp.path().join("home-is-a-file");
    std::fs::write(&poison_home, b"unchanged").expect("poison home");

    let output = cli()
        .env("HOME", &poison_home)
        .args([
            "--app-config",
            "/definitely/missing/private-config.json",
            "--data-dir",
            "/definitely/missing/private-data",
            "--json",
            "triage-policy",
            "compile",
            "--policy",
        ])
        .arg(&policy_path)
        .arg("--preflight")
        .arg(&preflight_path)
        .output()
        .expect("run CLI");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = envelope(&output);
    assert_eq!(json["command"], "triage_policy");
    assert_eq!(json["data"]["accepted"], true);
    assert_eq!(json["data"]["privacy"], "owner_only");
    assert_eq!(json["data"]["mode"], "standard");
    assert_eq!(
        json["data"]["slots"][0]["model"]["model_id"],
        "openai/gpt-oss-120b"
    );
    assert_eq!(json["data"]["offline"]["network"], false);
    assert_eq!(json["data"]["offline"]["credentials_read"], false);
    assert_eq!(json["data"]["offline"]["app_config_accessed"], false);
    assert_eq!(
        std::fs::read(poison_home).expect("home bytes"),
        b"unchanged"
    );
}

#[test]
fn invalid_schema_returns_typed_non_ready_result() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut policy = standard(false);
    policy.schema_id = "contextdesk.triage_policy.v999".into();
    let (policy_path, preflight_path) = write_inputs(temp.path(), &policy, &facts(&policy));
    let output = invoke("validate", &policy_path, &preflight_path);
    assert_eq!(output.status.code(), Some(8));
    let json = envelope(&output);
    assert_eq!(
        json["ok"], true,
        "completed validation has a rejected verdict"
    );
    assert_eq!(json["data"]["accepted"], false);
    assert!(json["data"]["rejections"]
        .as_array()
        .expect("rejections")
        .iter()
        .any(|row| row["category"] == "schema_mismatch"));
}

#[test]
fn required_and_optional_dropout_are_visible_and_distinct() {
    let temp = tempfile::tempdir().expect("tempdir");
    let policy = enhanced_same_model();
    let mut optional_facts = facts(&policy);
    optional_facts
        .roles
        .iter_mut()
        .find(|fact| fact.slot_id == "challenge")
        .expect("optional fact")
        .available = false;
    let (policy_path, preflight_path) = write_inputs(temp.path(), &policy, &optional_facts);
    let optional = invoke("compile", &policy_path, &preflight_path);
    assert!(optional.status.success());
    let optional_json = envelope(&optional);
    let slots = optional_json["data"]["slots"].as_array().expect("slots");
    assert!(slots.iter().any(|slot| {
        slot["slot_id"] == "challenge" && slot["disposition"] == "optional_degraded"
    }));

    let mut required_facts = facts(&policy);
    required_facts
        .roles
        .iter_mut()
        .find(|fact| fact.slot_id == "observe")
        .expect("required fact")
        .available = false;
    let (policy_path, preflight_path) = write_inputs(temp.path(), &policy, &required_facts);
    let required = invoke("compile", &policy_path, &preflight_path);
    assert_eq!(required.status.code(), Some(8));
    let required_json = envelope(&required);
    assert_eq!(required_json["data"]["slots"].as_array().unwrap().len(), 3);
    assert!(required_json["data"]["slots"]
        .as_array()
        .unwrap()
        .iter()
        .any(|slot| {
            slot["slot_id"] == "observe" && slot["disposition"] == "required_rejected"
        }));
}

#[test]
fn egress_denial_and_same_model_independence_are_honest() {
    let temp = tempfile::tempdir().expect("tempdir");
    let denied_policy = standard(false);
    let mut denied_facts = facts(&denied_policy);
    denied_facts.roles[0].remote = true;
    let (policy_path, preflight_path) = write_inputs(temp.path(), &denied_policy, &denied_facts);
    let denied = invoke("validate", &policy_path, &preflight_path);
    assert_eq!(denied.status.code(), Some(8));
    let denied_json = envelope(&denied);
    assert!(denied_json["data"]["rejections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["category"] == "egress_denied"));

    let policy = enhanced_same_model();
    let (policy_path, preflight_path) = write_inputs(temp.path(), &policy, &facts(&policy));
    let accepted = invoke("compile", &policy_path, &preflight_path);
    assert!(accepted.status.success());
    let accepted_json = envelope(&accepted);
    let counts = &accepted_json["data"]["independence"];
    assert_eq!(counts["role_slots"], 3);
    assert_eq!(counts["distinct_model_refs"], 1);
    assert_eq!(counts["distinct_model_ids"], 1);
    assert_eq!(counts["distinct_gateways"], 1);
}

#[test]
fn owner_only_output_is_bounded_secret_free_and_does_not_echo_paths() {
    let temp = tempfile::tempdir().expect("tempdir");
    let secretish_dir = temp.path().join("owner-private-vck_not_a_real_secret");
    std::fs::create_dir(&secretish_dir).expect("private-looking dir");
    let policy = standard(false);
    let (policy_path, preflight_path) = write_inputs(&secretish_dir, &policy, &facts(&policy));
    let output = invoke("compile", &policy_path, &preflight_path);
    assert!(output.status.success());
    let rendered = String::from_utf8(output.stdout).expect("utf8");
    for forbidden in [
        temp.path().to_string_lossy().as_ref(),
        "owner-private-vck_not_a_real_secret",
        "authorization",
        "api_key",
        "endpoint",
        "provider_body",
        "prompt",
        "reasoning",
    ] {
        assert!(
            !rendered
                .to_ascii_lowercase()
                .contains(&forbidden.to_ascii_lowercase()),
            "bounded owner-only output leaked {forbidden}: {rendered}"
        );
    }

    std::fs::write(
        &policy_path,
        br#"{"unexpected_/Users/private/vck_not_a_real_secret":true}"#,
    )
    .expect("write malformed private input");
    let malformed = invoke("compile", &policy_path, &preflight_path);
    assert_eq!(malformed.status.code(), Some(1));
    let rendered = String::from_utf8(malformed.stdout).expect("malformed utf8");
    assert!(rendered.contains("malformed or contains unsupported fields"));
    assert!(!rendered.contains("/Users/private"));
    assert!(!rendered.contains("vck_not_a_real_secret"));
}

#[test]
fn example_is_standard_offline_and_progressive() {
    let output = cli()
        .args(["--json", "triage-policy", "example"])
        .output()
        .expect("run example");
    assert!(output.status.success());
    let json = envelope(&output);
    assert_eq!(json["data"]["mode"], "standard");
    assert_eq!(json["data"]["privacy"], "owner_only");
    assert_eq!(
        json["data"]["example_policy"]["schema_id"],
        "contextdesk.triage_policy.v2"
    );
    assert_eq!(json["data"]["offline"]["network"], false);

    let text = cli()
        .args(["--no-color", "triage-policy", "example"])
        .output()
        .expect("run text example");
    let text = String::from_utf8(text.stdout).expect("text utf8");
    assert!(text.contains("Standard is the permanent simple default"));
    assert!(text.contains("Output privacy: owner-only"));
    assert!(text.contains("Network: no"));
}

#[test]
fn store_save_list_and_clear_are_explicit_and_offline() {
    let temp = tempfile::tempdir().expect("tempdir");
    let policy_path = temp.path().join("policy.json");
    let store_path = temp.path().join("policies.json");
    std::fs::write(
        &policy_path,
        serde_json::to_vec_pretty(&standard(false)).expect("policy JSON"),
    )
    .expect("write policy");

    let saved = cli()
        .args(["--json", "triage-policy", "store", "save", "--store"])
        .arg(&store_path)
        .args(["--policy"])
        .arg(&policy_path)
        .args(["--policy-id", "demo"])
        .output()
        .expect("save policy");
    assert!(
        saved.status.success(),
        "{}",
        String::from_utf8_lossy(&saved.stderr)
    );
    let saved_json = envelope(&saved);
    assert_eq!(saved_json["data"]["action"], "store_save");
    assert_eq!(saved_json["data"]["saved_revision"], 1);
    assert_eq!(saved_json["data"]["active_policy_id"], "demo");
    assert_eq!(saved_json["data"]["offline"]["network"], false);

    let listed = cli()
        .args(["--json", "triage-policy", "store", "list", "--store"])
        .arg(&store_path)
        .output()
        .expect("list policies");
    assert!(listed.status.success());
    let listed_json = envelope(&listed);
    assert_eq!(
        listed_json["data"]["saved_policy_ids"],
        serde_json::json!(["demo"])
    );

    let cleared = cli()
        .args(["--json", "triage-policy", "store", "clear", "--store"])
        .arg(&store_path)
        .output()
        .expect("clear selection");
    assert!(cleared.status.success());
    let cleared_json = envelope(&cleared);
    assert!(cleared_json["data"]["active_policy_id"].is_null());
}
