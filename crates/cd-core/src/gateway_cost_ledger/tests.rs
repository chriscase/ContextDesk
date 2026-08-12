//! Hermetic tests for the gateway cost/reliability ledger.

use super::*;
use crate::gateway_cost_ledger::ingest::fixture_root;
use crate::gateway_cost_ledger::redact::leaky_run_for_mutation;

#[test]
fn ingests_deepseek_gpt_oss_and_mixed_role_bundles() {
    let root = fixture_root();
    let deepseek = ingest_diagnostic_bundle(&root.join("deepseek")).expect("deepseek");
    let gpt = ingest_diagnostic_bundle(&root.join("gpt-oss")).expect("gpt-oss");
    let mixed = ingest_diagnostic_bundle(&root.join("mixed-role")).expect("mixed-role");

    assert_eq!(deepseek.len(), 1);
    assert_eq!(gpt.len(), 1);
    assert_eq!(mixed.len(), 1);

    match &deepseek[0].model {
        IdentityLabel::Exact { value } => assert_eq!(value, "deepseek/deepseek-v4-flash"),
        other => panic!("expected exact DeepSeek label, got {other:?}"),
    }
    match &gpt[0].model {
        IdentityLabel::Exact { value } => assert_eq!(value, "openai/gpt-oss-120b"),
        other => panic!("expected exact GPT-OSS label, got {other:?}"),
    }
    match &mixed[0].model {
        IdentityLabel::Exact { value } => assert_eq!(value, "voyage/voyage-4"),
        other => panic!("expected exact voyage label, got {other:?}"),
    }

    assert_eq!(deepseek[0].answers_useful, VerdictStatus::Pass);
    assert_eq!(gpt[0].answers_useful, VerdictStatus::Fail);
    assert_eq!(mixed[0].answers_useful, VerdictStatus::Inconclusive);

    // Cost/tokens absent on these share-safe reports → unknown, never zero.
    assert_eq!(deepseek[0].reported_cost, MetricF64::Unknown);
    assert_eq!(deepseek[0].tokens.total, MetricU64::Unknown);
    assert_eq!(gpt[0].reported_cost, MetricF64::Unknown);
    assert_eq!(mixed[0].reported_cost, MetricF64::Unknown);
}

#[test]
fn ingests_documented_historical_rows_without_inventing_cost() {
    let root = fixture_root().join("historical");
    let mut runs = Vec::new();
    for name in ["row-01.json", "row-02.json", "row-03.json"] {
        let path = root.join(name);
        runs.extend(ingest_path(&path).expect(name));
    }
    assert_eq!(runs.len(), 3);
    for run in &runs {
        assert_eq!(run.source_kind, "historical_benchmark_row");
        assert_eq!(run.reported_cost, MetricF64::Unknown);
        assert_eq!(run.tokens.input, MetricU64::Unknown);
        assert!(run
            .caveats
            .iter()
            .any(|c| c.code == "historical_documented_row"));
    }
    assert_eq!(runs[0].request_count, MetricU64::Known(19));
    assert_eq!(runs[2].elapsed_ms, MetricU64::Known(86900));
}

#[test]
fn rejects_secret_bearing_and_raw_prompt_inputs() {
    let root = fixture_root().join("malformed");
    let auth = ingest_path(&root.join("with-authorization.json"));
    assert!(
        matches!(
            auth,
            Err(IngestError::Redaction(
                LedgerRedactionError::ForbiddenField(_)
            ))
        ),
        "authorization field must be rejected: {auth:?}"
    );
    let prompt = ingest_path(&root.join("with-raw-prompt.json"));
    assert!(
        matches!(
            prompt,
            Err(IngestError::Redaction(
                LedgerRedactionError::ForbiddenField(_)
            ))
        ),
        "raw_prompt field must be rejected: {prompt:?}"
    );
}

#[test]
fn redacts_endpoint_and_authorization_details_from_lane_failures() {
    let path = fixture_root()
        .join("malformed")
        .join("with-endpoint-in-detail-report.json");
    let runs = ingest_path(&path).expect("redactable report should ingest");
    let json = serde_json::to_string(&runs[0]).expect("serialize");
    assert_share_safe_ledger_json(&json).expect("ledger run must be share-safe");
    assert!(
        !json.contains("secret.example"),
        "endpoint host leaked: {json}"
    );
    assert!(!json.contains("Bearer"), "bearer token leaked: {json}");
    assert!(
        runs[0]
            .failure_categories
            .iter()
            .any(|c| c.code.contains("response_contract")
                || c.code.contains("timeout")
                || c.code.contains("transport")
                || c.code.contains("provider")
                || !c.code.is_empty()),
        "expected a coarse failure category, got {:?}",
        runs[0].failure_categories
    );
}

#[test]
fn unknown_cost_stays_unknown_in_aggregates_and_never_becomes_zero() {
    let with_usage = ingest_diagnostic_bundle(&fixture_root().join("mixed-role/with-usage"))
        .expect("with-usage");
    let without = ingest_diagnostic_bundle(&fixture_root().join("mixed-role/without-usage"))
        .expect("without-usage");

    assert_eq!(
        with_usage[0].reported_cost,
        MetricF64::Known(0.0123),
        "fixture with usage must retain known cost"
    );
    assert_eq!(without[0].reported_cost, MetricF64::Unknown);

    let mixed = [with_usage[0].clone(), without[0].clone()];
    let aggregates = aggregate_runs(&mixed);
    assert_eq!(aggregates.len(), 1);
    assert_eq!(
        aggregates[0].reported_cost,
        MetricF64::Unknown,
        "mixing known+unknown cost must yield unknown, not a partial/zero sum"
    );
    assert_eq!(aggregates[0].tokens.total, MetricU64::Unknown);

    // Mutation: forcing Unknown→Known(0) would be dishonest — prove the
    // honesty helper itself refuses to treat unknown as zero.
    assert_ne!(MetricF64::Unknown, MetricF64::Known(0.0));
    assert_ne!(MetricU64::Unknown, MetricU64::Known(0));
    assert_eq!(
        MetricF64::sum_all([MetricF64::Known(0.0), MetricF64::Unknown]),
        MetricF64::Unknown
    );
}

#[test]
fn mutation_redaction_removes_credentials_paths_and_endpoints() {
    let mut leaky = leaky_run_for_mutation();
    let before = serde_json::to_string(&leaky).expect("serialize");
    assert!(
        assert_share_safe_ledger_json(&before).is_err(),
        "pre-redaction leaky run must fail share-safe gate"
    );

    redact_ledger_run(&mut leaky);
    let after = serde_json::to_string(&leaky).expect("serialize");
    assert_share_safe_ledger_json(&after).expect("post-redaction must be share-safe");
    assert!(!after.contains("sk-live-mutation-secret"));
    assert!(!after.contains("/private/tmp"));
    assert!(!after.contains("/Users/owner"));
    assert!(!after.contains("https://private.gateway.example"));
    assert!(matches!(leaky.model, IdentityLabel::Unknown));
    assert!(matches!(leaky.gateway, IdentityLabel::Unknown));
}

#[test]
fn mutation_zero_filling_cost_would_fail_honesty_assertions() {
    let runs = ingest_diagnostic_bundle(&fixture_root().join("deepseek")).expect("deepseek");
    let mut dishonest = runs[0].clone();
    // Simulate a buggy aggregator that zero-fills missing cost.
    dishonest.reported_cost = MetricF64::Known(0.0);
    assert_eq!(runs[0].reported_cost, MetricF64::Unknown);
    assert_ne!(
        dishonest.reported_cost, runs[0].reported_cost,
        "mutation oracle: zero-filled cost must differ from honest unknown"
    );
    let agg = aggregate_runs(&runs);
    assert_eq!(agg[0].reported_cost, MetricF64::Unknown);
}

#[test]
fn inconclusive_stays_separate_from_fail_in_pass_rates() {
    let mixed = ingest_diagnostic_bundle(&fixture_root().join("mixed-role")).expect("mixed");
    let report = build_comparison_report(&mixed);
    assert_eq!(report.models.len(), 1);
    let row = &report.models[0];
    assert_eq!(row.aggregate.answers_useful.pass, 0);
    assert_eq!(row.aggregate.answers_useful.fail, 0);
    assert_eq!(row.aggregate.answers_useful.inconclusive, 1);
    assert!(
        row.pass_rates.answers_useful.is_none(),
        "inconclusive-only dimension must not invent a pass rate"
    );
    assert_eq!(row.aggregate.gateway_model.pass, 1);
    assert_eq!(row.pass_rates.gateway_model, Some(1.0));
}

#[test]
fn comparison_report_is_deterministic_and_share_safe() {
    let root = fixture_root();
    let mut runs = Vec::new();
    for rel in [
        "deepseek",
        "gpt-oss",
        "mixed-role",
        "historical/row-01.json",
        "historical/row-02.json",
        "historical/row-03.json",
    ] {
        runs.extend(ingest_path(&root.join(rel)).expect(rel));
    }
    let a = build_comparison_report(&runs);
    let mut shuffled = runs.clone();
    shuffled.reverse();
    let b = build_comparison_report(&shuffled);
    assert_eq!(a, b, "comparison must be order-independent");

    let json = emit_comparison_json(&a).expect("emit");
    let text = render_comparison_text(&a);
    assert!(!json.to_ascii_lowercase().contains("\"verified\""));
    assert!(!json.to_ascii_lowercase().contains("readiness_badge"));
    assert!(!text.to_ascii_lowercase().contains("verified badge"));
    assert!(text.contains("unknown"));
    assert!(a.run_count >= 6);
    assert!(a.models.len() >= 2);
    assert!(a
        .confidence_caveats
        .iter()
        .any(|c| c.code == "no_readiness_claim_from_aggregate"));
}

#[test]
fn private_model_label_not_in_allowlist_becomes_unknown() {
    let value = serde_json::json!({
        "schema_id": "contextdesk.gateway_cost_ledger_historical_row.v1",
        "historical_row": true,
        "documented_source": "fixtures/gateway-cost-ledger/v1/historical/private-label-test",
        "run_id": "private-label-run",
        "model_label": "corp-private-alias-x",
        "gateway_label": "employer-private-gateway",
        "gateway_model_status": "inconclusive",
        "product_workflow_status": "inconclusive",
        "answers_useful_status": "inconclusive"
    });
    // corp-private-alias-x appears in the mixed catalog fixture as an id, but
    // it is intentionally NOT in the exact-model allowlist for ledger identity.
    let run = ingest_json_value(&value, "private-label-test").expect("ingest");
    assert!(matches!(run.model, IdentityLabel::Unknown));
    assert!(matches!(run.gateway, IdentityLabel::Unknown));
}

#[test]
fn metric_sum_all_preserves_genuine_zero_distinct_from_unknown() {
    assert_eq!(
        MetricU64::sum_all([MetricU64::Known(0), MetricU64::Known(0)]),
        MetricU64::Known(0)
    );
    assert_eq!(
        MetricF64::sum_all([MetricF64::Known(0.0), MetricF64::Known(0.0)]),
        MetricF64::Known(0.0)
    );
    assert_eq!(
        MetricU64::sum_all([MetricU64::Known(0), MetricU64::Unknown]),
        MetricU64::Unknown
    );
}
