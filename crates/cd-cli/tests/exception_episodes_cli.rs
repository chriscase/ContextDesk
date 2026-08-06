//! Hermetic CLI contract for `contextdesk exception-episodes`.

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use predicates::prelude::*;
use std::fs;
use tempfile::TempDir;

fn bin() -> Command {
    Command::new(cargo_bin!("contextdesk"))
}

#[test]
fn exception_episodes_json_discloses_occurrence_vs_raw() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    // Compact dual-rendering sample (3 occurrences × 5 stderr lines + app multiline).
    let mut app = String::new();
    let mut err = String::new();
    for i in 0..3u32 {
        app.push_str(&format!(
            "2026-03-15T12:0{i}:00.000Z ERROR java.lang.RuntimeException: XYZ_PAYMENT_FAILED id={i}\n  at com.xyz.A.m(A.java:1)\n  at com.xyz.B.m(B.java:2)\n"
        ));
        for (j, line) in [
            format!("java.lang.RuntimeException: XYZ_PAYMENT_FAILED id={i}"),
            "Exception wrapper XYZ_WRAP".into(),
            "at com.xyz.A.m(A.java:1)".into(),
            "at com.xyz.B.m(B.java:2)".into(),
            "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into(),
        ]
        .into_iter()
        .enumerate()
        {
            err.push_str(&format!("2026-03-15T13:0{i}:0{j}.000Z ERROR {line}\n"));
        }
    }
    fs::write(src.join("XYZ_app.log"), app).unwrap();
    fs::write(src.join("XYZ_server.stderr"), err).unwrap();

    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "import",
            src.to_str().unwrap(),
        ])
        .assert()
        .success();

    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "exception-episodes",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["command"], "exception_episodes");
    let report = &envelope["data"]["report"];
    assert_eq!(
        report["schemaId"],
        "contextdesk.exception_episode_report.v2"
    );
    let occurrences = report["occurrenceCount"].as_u64().unwrap_or(0);
    let raw = report["rawExceptionRecordCount"].as_u64().unwrap_or(0);
    let renderings = report["renderingEpisodeCount"].as_u64().unwrap_or(0);
    assert!(raw > occurrences, "raw={raw} occurrences={occurrences}");
    assert!(
        renderings >= occurrences,
        "renderings={renderings} occurrences={occurrences}"
    );
    assert!(report["rankingDisclosure"]
        .as_str()
        .unwrap_or("")
        .contains("independent_incident_claim_forbidden"));
    // Alias
    bin()
        .args(["--data-dir", data.to_str().unwrap(), "--json", "episodes"])
        .assert()
        .success();
}

#[test]
fn exception_episodes_missing_corpus_is_user_error() {
    let tmp = TempDir::new().unwrap();
    bin()
        .args([
            "--data-dir",
            tmp.path().to_str().unwrap(),
            "exception-episodes",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no corpus"));
}
