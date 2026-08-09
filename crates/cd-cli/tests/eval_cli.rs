//! Hermetic integration tests for `contextdesk eval` (state-free quality lab).
//!
//! Proves zero config/Keychain/network dependency, fail-closed suite handling,
//! stable JSON/JSONL, no-clobber output, and honest evidence labels.

use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

fn open_suite() -> PathBuf {
    repo_root().join("fixtures/quality-eval/open-v1")
}

fn parse_envelope(stdout: &[u8]) -> Value {
    serde_json::from_slice(stdout).expect("one JSON envelope")
}

#[test]
fn eval_suites_works_with_poisoned_home_and_impossible_config() {
    let poison = tempfile::tempdir().unwrap();
    let broken_home = poison.path().join("home-is-a-file");
    std::fs::write(&broken_home, b"must remain unchanged").unwrap();
    let missing_config = poison.path().join("no-such-config.json");
    let missing_data = poison.path().join("no-such-data-dir");

    let out = cli()
        .env("HOME", &broken_home)
        .current_dir(repo_root())
        .args([
            "--app-config",
            missing_config.to_str().unwrap(),
            "--data-dir",
            missing_data.to_str().unwrap(),
            "--json",
            "eval",
            "suites",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "eval suites must be state-free: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let env = parse_envelope(&out.stdout);
    assert_eq!(env["ok"], true);
    assert_eq!(env["command"], "eval");
    let data = &env["data"];
    assert_eq!(data["offline"], true);
    assert_eq!(data["credentials_read"], false);
    assert_eq!(data["network"], false);
    assert_eq!(data["evidence"]["compatibility_readiness"], "not_evaluated");
    assert_eq!(data["evidence"]["live_usefulness"], "not_evaluated");
    assert!(data["suites"].as_array().unwrap().iter().any(|s| {
        s["suite_id"] == "quality-eval-open-v1"
            || s["relative_path"] == "fixtures/quality-eval/open-v1"
    }));
    let text = out.stdout.to_vec();
    let s = String::from_utf8_lossy(&text);
    assert!(!s.contains("/Users/"), "absolute home path leaked: {s}");
    assert!(!s.to_ascii_lowercase().contains("sk-"));
    // Home file must not have been used as a directory.
    assert_eq!(
        std::fs::read(&broken_home).unwrap(),
        b"must remain unchanged"
    );
}

#[test]
fn eval_validate_and_run_default_suite() {
    let out = cli()
        .current_dir(repo_root())
        .args(["--json", "eval", "validate", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let env = parse_envelope(&out.stdout);
    assert_eq!(env["data"]["status"], "ok");
    assert!(env["data"]["suite_digest"].as_str().unwrap().len() == 64);
    assert_eq!(env["data"]["credentials_read"], false);

    let run = cli()
        .current_dir(repo_root())
        .args(["eval", "run", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "eval run text: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    let text = String::from_utf8_lossy(&run.stdout);
    assert!(text.contains("Hermetic quality evaluation"));
    assert!(text.contains("not evaluated"));
    assert!(text.contains("lexical overlap"));
    assert!(text.contains("Expectation accounting"));
    assert!(!text.contains("/Users/"));
}

#[test]
fn eval_run_json_and_jsonl_are_stable_and_parseable() {
    let json = cli()
        .current_dir(repo_root())
        .args(["--json", "eval", "run", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(json.status.success());
    let env = parse_envelope(&json.stdout);
    assert_eq!(env["ok"], true);
    let data = &env["data"];
    assert_eq!(data["schema_id"], "contextdesk.cli.eval.v1");
    assert_eq!(
        data["record"]["schema_id"],
        "contextdesk.quality_eval.run_record.v1"
    );
    assert_eq!(data["evidence"]["compatibility_readiness"], "not_evaluated");
    assert_eq!(
        data["record"]["evidence_classes"]["compatibility_untouched"],
        true
    );
    assert_eq!(data["record"]["judge"]["status"], "not_scheduled");
    // Second run byte-stable envelope data (digest + status).
    let json2 = cli()
        .current_dir(repo_root())
        .args(["--json", "eval", "run", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    let env2 = parse_envelope(&json2.stdout);
    assert_eq!(
        env["data"]["record"]["suite_digest"],
        env2["data"]["record"]["suite_digest"]
    );
    assert_eq!(env["data"]["status"], env2["data"]["status"]);

    let jsonl = cli()
        .current_dir(repo_root())
        .args(["--jsonl", "eval", "run", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(jsonl.status.success());
    let line = std::str::from_utf8(&jsonl.stdout)
        .unwrap()
        .lines()
        .next()
        .expect("jsonl line");
    let v: Value = serde_json::from_str(line).expect("jsonl object");
    // JSONL stream envelope wraps the payload.
    assert!(v.get("schema").is_some() || v.get("data").is_some() || v.get("ok").is_some());
}

#[test]
fn eval_run_output_no_clobber_and_force() {
    let dir = tempfile::tempdir().unwrap();
    let out_path = dir.path().join("report.json");

    let first = cli()
        .current_dir(repo_root())
        .args(["eval", "run", "--suite"])
        .arg(open_suite())
        .args(["--report-format", "json", "--output"])
        .arg(&out_path)
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(out_path.is_file());
    let first_bytes = std::fs::read(&out_path).unwrap();
    assert!(!first_bytes.is_empty());
    // File itself is the quality record JSON, not the CLI envelope.
    let record: Value = serde_json::from_slice(&first_bytes).unwrap();
    assert_eq!(
        record["schema_id"],
        "contextdesk.quality_eval.run_record.v1"
    );

    let second = cli()
        .current_dir(repo_root())
        .args(["eval", "run", "--suite"])
        .arg(open_suite())
        .args(["--report-format", "json", "--output"])
        .arg(&out_path)
        .output()
        .unwrap();
    assert!(
        !second.status.success(),
        "must refuse clobber without --force"
    );
    let err = String::from_utf8_lossy(&second.stderr);
    assert!(
        err.contains("already exists") || err.contains("force"),
        "unexpected error: {err}"
    );
    assert_eq!(std::fs::read(&out_path).unwrap(), first_bytes);

    let forced = cli()
        .current_dir(repo_root())
        .args(["eval", "run", "--suite"])
        .arg(open_suite())
        .args(["--report-format", "json", "--output"])
        .arg(&out_path)
        .arg("--force")
        .output()
        .unwrap();
    assert!(
        forced.status.success(),
        "{}",
        String::from_utf8_lossy(&forced.stderr)
    );
}

#[test]
fn empty_malformed_and_ambiguous_suite_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    let empty_out = cli()
        .args(["--json", "eval", "validate", "--suite"])
        .arg(&empty)
        .output()
        .unwrap();
    assert!(!empty_out.status.success());

    let malformed = dir.path().join("malformed");
    std::fs::create_dir(&malformed).unwrap();
    std::fs::write(malformed.join("suite.json"), b"{not json").unwrap();
    let bad = cli()
        .args(["--json", "eval", "run", "--suite"])
        .arg(&malformed)
        .output()
        .unwrap();
    assert!(!bad.status.success());

    // Ambiguous: path exists but is a file, not a suite directory.
    let file_suite = dir.path().join("not-a-dir");
    std::fs::write(&file_suite, b"x").unwrap();
    let file_out = cli()
        .args(["eval", "validate", "--suite"])
        .arg(&file_suite)
        .output()
        .unwrap();
    assert!(!file_out.status.success());
}

#[test]
fn accounting_is_deterministic_for_open_v1() {
    let out = cli()
        .current_dir(repo_root())
        .args(["--json", "eval", "run", "--suite"])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(out.status.success());
    let env = parse_envelope(&out.stdout);
    let acc = &env["data"]["accounting"];
    // OPEN v1 declares pass/fail expectations; both sides should be non-vacuous.
    assert!(acc["expected_pass_met"].as_u64().unwrap() > 0);
    assert!(acc["expected_fail_met"].as_u64().unwrap() > 0);
    assert_eq!(acc["expected_pass_missed"], 0);
    assert_eq!(acc["expected_fail_missed"], 0);
    assert_eq!(env["data"]["status"], "executed");
}

#[test]
fn eval_never_touches_qualification_store_path() {
    let data = tempfile::tempdir().unwrap();
    let qual = data.path().join("model-qualifications.json");
    std::fs::write(&qual, br#"{"schema_version":1,"by_key":{}}"#).unwrap();
    let before = std::fs::read(&qual).unwrap();

    let out = cli()
        .current_dir(repo_root())
        .env("HOME", data.path())
        .args([
            "--data-dir",
            data.path().to_str().unwrap(),
            "eval",
            "run",
            "--suite",
        ])
        .arg(open_suite())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(std::fs::read(&qual).unwrap(), before);
}

/// Smoke: binary --help lists eval.
#[test]
fn eval_appears_in_help() {
    cli()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("eval"));
}

#[test]
fn no_network_subprocess_required() {
    // Ensure eval run completes without any DNS-looking activity by using only
    // local fixtures; this is a process-level smoke, not a packet capture.
    let status = StdCommand::new(env!("CARGO_BIN_EXE_contextdesk"))
        .current_dir(repo_root())
        .args(["eval", "run", "--suite"])
        .arg(open_suite())
        .status()
        .unwrap();
    assert!(status.success());
}
