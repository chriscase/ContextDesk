//! Hermetic CLI lab for `contextdesk normalize` (offline, synthetic fixtures).

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use predicates::prelude::*;
use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;
use tempfile::TempDir;

fn bin() -> Command {
    Command::new(cargo_bin!("contextdesk"))
}

fn write_tree(root: &Path) {
    fs::create_dir_all(root.join("api")).unwrap();
    fs::create_dir_all(root.join("worker")).unwrap();
    fs::write(
        root.join("api/app.jsonl"),
        concat!(
            r#"{"ts":"2026-01-01T00:00:00Z","level":"INFO","msg":"hello"}"#,
            "\n",
            r#"{"ts":"2026-01-01T00:00:01+00:00","level":"ERROR","msg":"token=ghp_example_invalid_secret_marker_1234567890"}"#,
            "\n",
        ),
    )
    .unwrap();
    fs::write(
        root.join("worker/app.log"),
        "2021-03-05 02:53:53,654 INFO local worker\n  at worker.Handler.run(Handler.java:42)\n",
    )
    .unwrap();
    fs::write(
        root.join("worker/app.log.1"),
        "2021-03-04 01:00:00 INFO rotated older\n",
    )
    .unwrap();
    fs::write(root.join("noise.bin"), [0u8, 1, 2, 3, 255]).unwrap();
    fs::write(root.join("meta.xml"), "<root/>\n").unwrap();
}

#[test]
fn normalize_folder_produces_jsonl_manifest_report() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("in");
    write_tree(&input);
    let out = tmp.path().join("out");
    bin()
        .args([
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
            "--output-format",
            "jsonl",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("Normalization complete"))
        .stdout(predicate::str::contains("\n\nFiles written\n\n"));
    assert!(out.join("manifest.json").is_file());
    assert!(out.join("normalization-report.json").is_file());
    let sources: Vec<_> = fs::read_dir(out.join("sources"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert!(!sources.is_empty());
    // Each JSONL validates: header has schema id.
    for p in &sources {
        let text = fs::read_to_string(p).unwrap();
        let header = text.lines().next().unwrap();
        assert!(header.contains("contextdesk.normalized_log_events.v1"));
        // No invented UTC in unresolved events without timezone.
        for line in text.lines().skip(1) {
            if line.contains("\"resolution\":\"unresolved\"") {
                assert!(!line.contains("\"instant\":"), "{line}");
            }
        }
    }
}

#[test]
fn normalize_no_clobber() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("in");
    write_tree(&input);
    let out = tmp.path().join("out");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("keep.txt"), b"stay").unwrap();
    bin()
        .args([
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
            "--output-format",
            "jsonl",
        ])
        .assert()
        .failure();
    assert_eq!(fs::read(out.join("keep.txt")).unwrap(), b"stay");
}

#[test]
fn normalize_zip_parity_with_folder() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("in");
    write_tree(&input);
    let zip_path = tmp.path().join("in.zip");
    // zip CLI if available
    let status = StdCommand::new("zip")
        .args(["-qr", zip_path.to_str().unwrap(), "."])
        .current_dir(&input)
        .status();
    if !status.map(|s| s.success()).unwrap_or(false) {
        eprintln!("skip zip parity — zip binary missing");
        return;
    }
    let out_folder = tmp.path().join("out-folder");
    let out_zip = tmp.path().join("out-zip");
    bin()
        .args([
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out_folder.to_str().unwrap(),
            "--output-format",
            "jsonl",
        ])
        .assert()
        .success();
    bin()
        .args([
            "normalize",
            zip_path.to_str().unwrap(),
            "--output",
            out_zip.to_str().unwrap(),
            "--output-format",
            "jsonl",
        ])
        .assert()
        .success();
    let report_f: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(out_folder.join("normalization-report.json")).unwrap(),
    )
    .unwrap();
    let report_z: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(out_zip.join("normalization-report.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(report_f["events"], report_z["events"]);
}

#[test]
fn normalize_json_envelope_is_terminal_success() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("in");
    write_tree(&input);
    let out = tmp.path().join("out");
    let assert = bin()
        .args([
            "--json",
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
            "--output-format",
            "jsonl",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json envelope");
    assert_eq!(v["ok"], true);
    assert_eq!(v["command"], "normalize");
    assert!(v["data"]["events"].as_u64().unwrap_or(0) >= 1);
}

/// Structural: normalize path must not *call* provider or secret-store APIs.
#[test]
fn normalize_command_source_has_no_provider_or_keychain() {
    let src = include_str!("../src/commands/normalize.rs");
    let workflow = include_str!("../../cd-workflow/src/normalize.rs");
    for text in [src, workflow] {
        // Call sites / types — not prose mentioning the prohibition.
        assert!(!text.contains("secret_store("));
        assert!(!text.contains("SecretStore"));
        assert!(!text.contains("KeychainSecretStore"));
        assert!(!text.contains("provider_profile"));
        assert!(!text.contains("ProviderClient"));
        assert!(!text.contains("chat_completion"));
    }
}
