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

#[test]
fn normalize_partial_subprocess_exits_ten_and_preserves_parseable_outputs() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("in");
    write_tree(&input); // includes a binary source the preview cannot normalize
    let out = tmp.path().join("out");
    let asserted = bin()
        .args([
            "--json",
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
            "--fail-on-partial",
        ])
        .assert()
        .code(10);

    let envelope: serde_json::Value =
        serde_json::from_slice(&asserted.get_output().stdout).expect("completed JSON envelope");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["partial"], true);
    assert_eq!(envelope["data"]["fail_on_partial"], true);
    let report: serde_json::Value = serde_json::from_slice(
        &fs::read(out.join("normalization-report.json")).expect("published report"),
    )
    .expect("parseable report");
    assert_eq!(report["partial"], true);
    assert!(out.join("manifest.json").is_file());
    let source = fs::read_dir(out.join("sources"))
        .unwrap()
        .next()
        .expect("published source")
        .unwrap()
        .path();
    bin()
        .args(["normalized", "validate", source.to_str().unwrap()])
        .assert()
        .success();
}

#[test]
fn truncated_preview_subprocess_exits_ten_and_preserves_artifacts() {
    let tmp = TempDir::new().unwrap();
    let input = tmp.path().join("many");
    fs::create_dir_all(&input).unwrap();
    for index in 0..=cd_core::log_analysis::import_preview::MAX_IMPORT_PREVIEW_ITEMS {
        fs::write(
            input.join(format!("source-{index:05}.log")),
            format!("2026-01-01T00:00:00Z INFO event {index}\n"),
        )
        .unwrap();
    }
    let out = tmp.path().join("out");
    let asserted = bin()
        .args([
            "--json",
            "normalize",
            input.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
            "--fail-on-partial",
        ])
        .assert()
        .code(10);

    let envelope: serde_json::Value =
        serde_json::from_slice(&asserted.get_output().stdout).expect("completed JSON envelope");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["partial"], true);
    assert_eq!(
        envelope["data"]["sources_selected"],
        cd_core::log_analysis::import_preview::MAX_IMPORT_PREVIEW_ITEMS as u64
    );
    let report: serde_json::Value = serde_json::from_slice(
        &fs::read(out.join("normalization-report.json")).expect("published report"),
    )
    .expect("parseable report");
    assert_eq!(report["partial"], true);
    assert!(out.join("manifest.json").is_file());
    assert!(out.join("sources").is_dir());
}

#[test]
fn company_timestamp_fixture_normalizes_to_self_validating_w3c_output() {
    let tmp = TempDir::new().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/log-lab/scenarios/company-timestamp-diversity/import");
    let out = tmp.path().join("out");
    bin()
        .args([
            "normalize",
            fixture.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();

    bin()
        .args(["normalized", "validate", out.to_str().unwrap()])
        .assert()
        .success();
    for entry in fs::read_dir(out.join("sources")).unwrap() {
        let text = fs::read_to_string(entry.unwrap().path()).unwrap();
        for line in text.lines().skip(1) {
            let event: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_ne!(
                event.get("traceId").and_then(serde_json::Value::as_str),
                Some("trace-company-ts-shared")
            );
        }
    }
}

/// Structural: normalize path must not *call* provider or secret-store APIs.
#[test]
fn normalize_command_source_has_no_provider_or_keychain() {
    let src = include_str!("../src/commands/normalize.rs");
    let workflow = include_str!("../../cd-workflow/src/normalize.rs");
    let inspect_src = include_str!("../src/commands/normalized.rs");
    let inspect_workflow = include_str!("../../cd-workflow/src/normalized.rs");
    for text in [src, workflow, inspect_src, inspect_workflow] {
        // Call sites / types — not prose mentioning the prohibition.
        assert!(!text.contains("secret_store("));
        assert!(!text.contains("SecretStore"));
        assert!(!text.contains("KeychainSecretStore"));
        assert!(!text.contains("provider_profile"));
        assert!(!text.contains("ProviderClient"));
        assert!(!text.contains("chat_completion"));
    }
}

#[test]
fn normalized_validate_and_summarize_accept_file_or_directory() {
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
        ])
        .assert()
        .success();

    let validated = bin()
        .args(["--json", "normalized", "validate", out.to_str().unwrap()])
        .assert()
        .success();
    let envelope: serde_json::Value =
        serde_json::from_slice(&validated.get_output().stdout).expect("pure JSON envelope");
    assert_eq!(envelope["schema_version"], 1);
    assert_eq!(envelope["command"], "normalized");
    assert_eq!(
        envelope["data"]["schema_id"],
        "contextdesk.normalized_validation.v1"
    );
    assert_eq!(envelope["data"]["ok"], true);
    assert!(envelope["data"]["files_examined"].as_u64().unwrap_or(0) >= 1);
    for file in envelope["data"]["files"].as_array().unwrap() {
        assert!(!file["path"].as_str().unwrap().starts_with('/'));
    }

    let source_file = fs::read_dir(out.join("sources"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let summarized = bin()
        .args([
            "--jsonl",
            "normalized",
            "summarize",
            source_file.to_str().unwrap(),
        ])
        .assert()
        .success();
    let line = String::from_utf8(summarized.get_output().stdout.clone()).unwrap();
    assert_eq!(line.lines().count(), 1, "JSONL purity: exactly one object");
    let progress = String::from_utf8_lossy(&summarized.get_output().stderr);
    assert!(progress.contains("Discover / read"));
    assert!(progress.contains("Validate"));
    assert!(progress.contains("Completed"));
    let envelope: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(
        envelope["data"]["schema_id"],
        "contextdesk.normalized_summary.v1"
    );
    assert_eq!(envelope["data"]["input_kind"], "file");
}

#[test]
fn normalized_mutation_returns_stable_nonconforming_exit_and_report() {
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
        ])
        .assert()
        .success();
    let source_file = fs::read_dir(out.join("sources"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(source_file)
        .unwrap();
    use std::io::Write as _;
    writeln!(file, "{{}}").unwrap();

    let checked = bin()
        .args(["--json", "normalized", "validate", out.to_str().unwrap()])
        .assert()
        .code(9);
    let envelope: serde_json::Value =
        serde_json::from_slice(&checked.get_output().stdout).expect("pure JSON envelope");
    assert_eq!(envelope["ok"], true, "inspection itself completed");
    assert_eq!(envelope["data"]["ok"], false, "content is non-conforming");
    assert!(envelope["data"]["diagnostics_total"].as_u64().unwrap_or(0) > 0);
}

#[test]
fn normalized_help_and_fail_on_partial_are_public() {
    bin()
        .args(["normalized", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("validate"))
        .stdout(predicate::str::contains("summarize"));
    bin()
        .args(["normalize", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--fail-on-partial"));
}

#[test]
fn state_free_commands_ignore_broken_unrelated_state_and_write_nothing() {
    let tmp = TempDir::new().unwrap();
    let poisoned_home = tmp.path().join("home-is-a-file");
    let poisoned_data = tmp.path().join("data-is-a-file");
    let bad_project = tmp.path().join("bad-project.toml");
    let bad_app = tmp.path().join("bad-app.json");
    fs::write(&poisoned_home, b"unchanged-home").unwrap();
    fs::write(&poisoned_data, b"unchanged-data").unwrap();
    fs::write(&bad_project, b"not = [valid").unwrap();
    fs::write(&bad_app, b"{not-json").unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/normalized-log-events/valid/minimal.jsonl");

    for command in [
        vec!["normalized", "validate", fixture.to_str().unwrap()],
        vec!["capabilities"],
    ] {
        let mut invocation = bin();
        invocation
            .env("HOME", &poisoned_home)
            .args(["--data-dir", poisoned_data.to_str().unwrap()])
            .args(["--config", bad_project.to_str().unwrap()])
            .args(["--app-config", bad_app.to_str().unwrap()])
            .arg("--json")
            .args(command)
            .assert()
            .success();
    }

    let input = tmp.path().join("raw");
    write_tree(&input);
    let output = tmp.path().join("normalized-out");
    bin()
        .env("HOME", &poisoned_home)
        .args(["--data-dir", poisoned_data.to_str().unwrap()])
        .args(["--config", bad_project.to_str().unwrap()])
        .args(["--app-config", bad_app.to_str().unwrap()])
        .args([
            "--json",
            "normalize",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
        ])
        .assert()
        .success();

    assert_eq!(fs::read(poisoned_home).unwrap(), b"unchanged-home");
    assert_eq!(fs::read(poisoned_data).unwrap(), b"unchanged-data");
    assert_eq!(fs::read(bad_project).unwrap(), b"not = [valid");
    assert_eq!(fs::read(bad_app).unwrap(), b"{not-json");
    assert!(output.join("manifest.json").is_file());
}
