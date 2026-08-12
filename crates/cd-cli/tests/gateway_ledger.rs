//! Hermetic process coverage for the offline gateway cost/reliability ledger.

use assert_cmd::Command;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn cli(data_dir: &Path) -> Command {
    let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    command.args(["--data-dir", data_dir.to_str().expect("UTF-8 temp path")]);
    command.env("HOME", data_dir);
    command
}

fn fixture(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/gateway-cost-ledger/v1")
        .join(relative)
}

#[test]
fn process_cli_emits_deterministic_share_safe_provenance_cohorts() {
    let data = tempfile::tempdir().expect("data dir");
    let output = cli(data.path())
        .args([
            "--format",
            "json",
            "gateway",
            "ledger",
            "--input",
            fixture("deepseek").to_str().expect("fixture path"),
            "--input",
            fixture("historical/row-01.json")
                .to_str()
                .expect("fixture path"),
        ])
        .output()
        .expect("run ledger");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("JSON envelope");
    let serialized = serde_json::to_string(&envelope).expect("serialize envelope");
    assert!(serialized.contains("diagnostic_bundle"));
    assert!(serialized.contains("historical_benchmark_row"));
    assert!(serialized.contains("p-fixturemodel1"));
    assert!(!serialized.contains("Authorization"));
    assert!(!serialized.contains("Bearer "));
    assert!(!serialized.contains("https://"));
    assert!(!serialized.to_ascii_lowercase().contains("\"verified\""));
}

#[test]
fn rejected_input_error_does_not_disclose_the_private_input_path() {
    let data = tempfile::tempdir().expect("data dir");
    let private_dir = tempfile::tempdir().expect("private input dir");
    let input = private_dir.path().join("private-ledger-input.json");
    fs::write(
        &input,
        serde_json::to_vec(&serde_json::json!({
            "schema_id": "contextdesk.gateway_cost_ledger_historical_row.v1",
            "schema_version": 1,
            "historical_row": true,
            "documented_source": "documented-row",
            "run_id": "bad-cost",
            "reported_cost": -1
        }))
        .expect("serialize input"),
    )
    .expect("write input");

    let output = cli(data.path())
        .args([
            "--format",
            "json",
            "gateway",
            "ledger",
            "--input",
            input.to_str().expect("input path"),
        ])
        .output()
        .expect("run ledger");
    assert!(!output.status.success());
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(combined.contains("input #1"), "{combined}");
    assert!(
        !combined.contains(private_dir.path().to_str().unwrap()),
        "{combined}"
    );
}

#[test]
fn output_is_atomically_replaced_with_valid_share_safe_json() {
    let data = tempfile::tempdir().expect("data dir");
    let output_path = data.path().join("comparison.json");
    fs::write(&output_path, b"old-bytes").expect("seed old output");

    let output = cli(data.path())
        .args([
            "gateway",
            "ledger",
            "--input",
            fixture("mixed-role/with-usage")
                .to_str()
                .expect("fixture path"),
            "--out",
            output_path.to_str().expect("output path"),
        ])
        .output()
        .expect("run ledger");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let written = fs::read_to_string(&output_path).expect("published output");
    let parsed: Value = serde_json::from_str(&written).expect("valid comparison JSON");
    assert_eq!(
        parsed["schema_id"],
        "contextdesk.gateway_cost_ledger_comparison.v1"
    );
    assert!(!written.contains("old-bytes"));
    assert!(!written.contains("https://"));
}
