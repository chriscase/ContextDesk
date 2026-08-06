//! Hermetic CLI contract for `contextdesk logging-assessment`.

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn bin() -> Command {
    Command::new(cargo_bin!("contextdesk"))
}

fn write_fixture(root: &Path) {
    fs::create_dir_all(root.join("api")).unwrap();
    fs::write(
        root.join("api/app.jsonl"),
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","service":"api","trace_id":"abc","msg":"ok"}"#,
            "\n",
            r#"{"ts":"2026-01-01T12:00:01Z","level":"ERROR","service":"api","trace_id":"abc","msg":"fail"}"#,
            "\n",
        ),
    )
    .unwrap();
    fs::write(root.join("plain.log"), "no timestamp line\nanother\n").unwrap();
    fs::write(root.join("noise.bin"), [0u8, 1, 255]).unwrap();
}

fn corpus_id_from_import(data: &Path, input: &Path) -> String {
    let import = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "import",
            input.to_str().unwrap(),
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let import_json: Value = serde_json::from_slice(&import).unwrap();
    import_json["data"]["corpus_id"]
        .as_str()
        .expect("import returns corpus_id")
        .to_string()
}

#[test]
fn logging_assessment_json_contract_and_atomic_markdown_export() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let input = tmp.path().join("in");
    write_fixture(&input);
    let corpus_id = corpus_id_from_import(&data, &input);

    let assessed = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "logging-assessment",
            &corpus_id,
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: Value = serde_json::from_slice(&assessed).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["command"], "logging_assessment");
    let assessment = &envelope["data"]["assessment"];
    assert_eq!(
        assessment["schemaId"],
        "contextdesk.logging_quality_assessment.v1"
    );
    assert_eq!(assessment["schemaVersion"], 1);
    assert!(!assessment["limitations"].as_array().unwrap().is_empty());
    assert_eq!(
        assessment["metrics"]["storedLevel"]["severityProvenanceAvailable"],
        false
    );
    let dump = String::from_utf8_lossy(&assessed).to_lowercase();
    assert!(!dump.contains("is confirmed noise"));
    assert!(!dump.contains("confirmed as noise"));
    assert!(!dump.contains("engineering improvement plan"));
    assert!(!dump.contains("/users/"));
    assert!(!dump.contains("api_key"));
    assert!(!dump.contains("messagenewline"));
    assert!(!dump.contains("multilineheuristic"));

    // The short form uses the same current-corpus state written by import.
    // It must not create a second assessment implementation or require the
    // operator to copy an opaque id for the everyday path.
    let current = bin()
        .args(["--data-dir", data.to_str().unwrap(), "--json", "assess"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let current_envelope: Value = serde_json::from_slice(&current).unwrap();
    assert_eq!(
        current_envelope["data"]["assessment"]["corpus"]["id"],
        corpus_id
    );

    let plan = tmp.path().join("plan.md");
    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "logging-assessment",
            &corpus_id,
            "--report-format",
            "markdown",
            "--output",
            plan.to_str().unwrap(),
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\nExport\n"))
        .stdout(predicate::str::contains("Wrote"));
    let md = fs::read_to_string(&plan).unwrap();
    assert!(md.contains("Logging Quality Assessment"));
    assert!(md.contains("JSON is the source of truth"));
    assert!(md.contains("Measured fact"));
    assert!(!md.contains("Engineering Improvement Plan"));

    // Atomic noclobber
    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "logging-assessment",
            &corpus_id,
            "--report-format",
            "markdown",
            "--output",
            plan.to_str().unwrap(),
        ])
        .assert()
        .failure();

    // Missing corpus
    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "logging-assessment",
            "does-not-exist",
        ])
        .assert()
        .failure()
        .code(3);
}

#[test]
fn logging_assessment_human_text_lists_findings() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let input = tmp.path().join("in");
    write_fixture(&input);
    let corpus_id = corpus_id_from_import(&data, &input);

    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "logging-assessment",
            &corpus_id,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("Logging quality assessment"))
        .stdout(predicate::str::contains("\n\nFindings\n\n"));
}
