//! Hermetic tests for extension-contract v1 pure validators + fixtures.
//!
//! Drives `cd_core::extension_contract` entry points — not a reimplementation
//! of production turn paths. No network or credentials.

use cd_core::extension_contract::{
    negotiation_supports, validate_evidence_packet_json, validate_negotiation_json,
    validate_role_capability_json, validate_role_outcome_json, CapabilityKind, CapabilityRequest,
    ExtensionContractError, ExtensionRole, NegotiationDialect, NegotiationVerdict,
    RoleCapabilityV1, EVIDENCE_PACKET_SCHEMA_V1, ROLE_CAPABILITY_SCHEMA_V1,
};
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // repo root
    path.push("fixtures/extension-contract/v1");
    path.push(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("missing fixture {}: {e}", path.display());
    })
}

#[test]
fn good_evidence_packet_accepts_and_maps_production_schemas() {
    let p = validate_evidence_packet_json(&fixture("evidence_packet.good.json")).unwrap();
    assert_eq!(p.schema_id, EVIDENCE_PACKET_SCHEMA_V1);
    assert!(p
        .maps_to_schemas
        .iter()
        .any(|s| s == "contextdesk.fast_triage.packet.v1"));
    assert_eq!(p.evidence.len(), 3);
}

#[test]
fn unknown_fields_fail_closed() {
    let err =
        validate_evidence_packet_json(&fixture("evidence_packet.unknown_fields.json")).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::Parse { .. }),
        "deny_unknown_fields must fail parse, got {err}"
    );
}

#[test]
fn malformed_evidence_ids_fail_closed() {
    let err =
        validate_evidence_packet_json(&fixture("evidence_packet.malformed_ids.json")).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::MalformedIdentity { .. }),
        "got {err}"
    );
}

#[test]
fn dimension_without_dialect_fails_closed() {
    let err = validate_evidence_packet_json(&fixture("evidence_packet.dimension_mismatch.json"))
        .unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::DimensionSpaceMismatch { .. }),
        "got {err}"
    );
}

#[test]
fn privacy_leak_in_share_safe_packet_fails_closed() {
    let err = validate_evidence_packet_json(&fixture("privacy.forbidden_leak.json")).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::PrivacyLeak { .. }),
        "got {err}"
    );
}

#[test]
fn role_capability_good_and_builtin_matrix() {
    let cap = validate_role_capability_json(&fixture("role_capability.good.json")).unwrap();
    assert_eq!(cap.role, ExtensionRole::ObservationExtractor);
    for role in ExtensionRole::all() {
        let b = RoleCapabilityV1::builtin(*role);
        assert_eq!(b.schema_id, ROLE_CAPABILITY_SCHEMA_V1);
        b.validate().unwrap_or_else(|e| panic!("{role:?}: {e}"));
    }
}

#[test]
fn mutation_model_name_as_capability_fails_closed() {
    let err =
        validate_role_capability_json(&fixture("role_capability.model_name.json")).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::ModelNameAsCompatibility { .. }),
        "got {err}"
    );
}

#[test]
fn unknown_capability_tokens_fail_closed_without_a_model_name_denylist() {
    let mut cap = RoleCapabilityV1::builtin(ExtensionRole::ObservationExtractor);
    cap.required_capabilities = vec!["future_product_123".into()];
    assert!(matches!(
        cap.validate(),
        Err(ExtensionContractError::ModelNameAsCompatibility { .. })
    ));
}

#[test]
fn finalizer_and_reviewer_are_distinct_roles() {
    assert_ne!(ExtensionRole::Finalizer, ExtensionRole::Reviewer);
    assert_eq!(
        ExtensionRole::parse("finalizer"),
        Some(ExtensionRole::Finalizer)
    );
    assert_eq!(
        ExtensionRole::parse("reviewer"),
        Some(ExtensionRole::Reviewer)
    );
    assert_eq!(ExtensionRole::parse("synthesizer_reviewer"), None);
}

#[test]
fn outcomes_supported_and_budget_exhausted() {
    validate_role_outcome_json(&fixture("outcome.supported.json")).unwrap();
    validate_role_outcome_json(&fixture("outcome.budget_exhausted.json")).unwrap();
}

#[test]
fn outcome_reason_codes_are_unique_and_content_free() {
    let mut value: serde_json::Value =
        serde_json::from_str(&fixture("outcome.supported.json")).unwrap();
    value["reason_codes"] = serde_json::json!(["same", "same"]);
    assert!(matches!(
        validate_role_outcome_json(&value.to_string()),
        Err(ExtensionContractError::MalformedIdentity { .. })
    ));
}

#[test]
fn mutation_root_cause_without_host_authority_fails() {
    let mut v: serde_json::Value =
        serde_json::from_str(&fixture("outcome.supported.json")).unwrap();
    v["root_cause_established"] = serde_json::json!(true);
    let err = validate_role_outcome_json(&v.to_string()).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::RootCauseWithoutHostAuthority),
        "got {err}"
    );
}

#[test]
fn negotiation_omit_default_accepts() {
    validate_negotiation_json(&fixture("negotiation.omit_default.json")).unwrap();
}

#[test]
fn mutation_unsupported_dialect_require_json_object_fails() {
    let err =
        validate_negotiation_json(&fixture("negotiation.unsupported_dialect.json")).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::NegotiationRefused { .. }),
        "got {err}"
    );
}

#[test]
fn negotiation_prefer_on_unsupported_omits_without_refuse() {
    // Prefer json_object on Ollama → omit, not refuse.
    assert_eq!(
        negotiation_supports(
            NegotiationDialect::Ollama,
            "chat_completions",
            CapabilityKind::JsonObject,
            CapabilityRequest::Prefer,
        ),
        NegotiationVerdict::Omitted
    );
    assert!(matches!(
        negotiation_supports(
            NegotiationDialect::Ollama,
            "chat_completions",
            CapabilityKind::JsonObject,
            CapabilityRequest::Require,
        ),
        NegotiationVerdict::Refused { .. }
    ));
}

#[test]
fn malformed_effort_level_no_silent_clamp() {
    let raw = r#"{
      "schema_id": "contextdesk.extension.negotiation.v1",
      "dialect": "openai_compatible",
      "surface": "chat_completions",
      "capabilities": [
        { "kind": "reasoning_effort", "request": "require", "value": "ultra" }
      ]
    }"#;
    let err = validate_negotiation_json(raw).unwrap_err();
    assert!(
        matches!(err, ExtensionContractError::MalformedIdentity { .. }),
        "got {err}"
    );
}

#[test]
fn schema_ids_are_stable() {
    assert_eq!(
        EVIDENCE_PACKET_SCHEMA_V1,
        "contextdesk.extension.evidence_packet.v1"
    );
    assert_eq!(
        ROLE_CAPABILITY_SCHEMA_V1,
        "contextdesk.extension.role_capability.v1"
    );
}

#[test]
fn docs_and_fixtures_exist() {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    root.pop();
    root.pop();
    for rel in [
        "docs/design/EXTENSION_CONTRACT_V1.md",
        "docs/design/EXTENSION_CONTRACT_ROADMAP_V1.md",
        "fixtures/extension-contract/v1/evidence_packet.good.json",
    ] {
        let p = root.join(rel);
        assert!(p.is_file(), "missing {rel}");
    }
    let doc = std::fs::read_to_string(root.join("docs/design/EXTENSION_CONTRACT_V1.md")).unwrap();
    assert!(doc.contains("No readiness badges"));
    assert!(doc.contains("never imply compatibility"));
    assert!(
        doc.to_ascii_lowercase().contains("fail closed")
            || doc.contains("fail-closed")
            || doc.contains("Fail closed")
    );
}
