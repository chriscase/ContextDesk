//! Safety acceptance for the `cd-normalized-log-lab` CLI.
//!
//! The tool's value depends on being safe to point at real evidence, so these
//! test the refusals rather than the happy path: it must not mutate input,
//! must not overwrite output, must not print a filesystem path or a payload,
//! and must not open a socket.

use std::io::Write;
use std::process::Command;

use cd_core::normalized_log_events::MAX_DIAGNOSTICS;

fn lab() -> Command {
    // Built by the same `cargo test` invocation; resolve the binary next to
    // the test executable rather than shelling out to cargo again.
    let mut path = std::env::current_exe().expect("test exe");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.push("cd_normalized_log_lab");
    Command::new(path)
}

fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture(rel: &str) -> std::path::PathBuf {
    repo_root().join("fixtures/normalized-log-events").join(rel)
}

#[test]
fn validate_exits_zero_for_a_conforming_file() {
    let output = lab()
        .arg("validate")
        .arg(fixture("valid/minimal.jsonl"))
        .output()
        .expect("run");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("conforming"));
}

#[test]
fn validate_exits_one_for_a_non_conforming_file_and_names_the_record() {
    let output = lab()
        .arg("validate")
        .arg(fixture("invalid/sequence-gap.jsonl"))
        .output()
        .expect("run");
    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("NOT conforming"));
    assert!(
        stdout.contains("record "),
        "a diagnostic must locate the record: {stdout}"
    );
}

#[test]
fn summarize_is_aggregate_only_and_prints_no_record_content() {
    let output = lab()
        .arg("summarize")
        .arg(fixture("invalid/forbidden-sentinel.jsonl"))
        .output()
        .expect("run");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("diagnostics:"));
    // The fixture's payload text must not appear anywhere in a summary.
    assert!(!stdout.contains("expected_diagnosis"));
    assert!(!stdout.contains("checkout step"));
}

#[test]
fn large_invalid_reports_disclose_exact_totals_but_bound_cli_output() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = dir.path().join("private-evidence.jsonl");
    let mut text = std::fs::read_to_string(fixture("valid/minimal.jsonl"))
        .expect("read valid header")
        .lines()
        .next()
        .expect("header")
        .to_string();
    let invalid_count = MAX_DIAGNOSTICS * 4;
    for _ in 0..invalid_count {
        text.push_str("\n{not-json-private-payload}");
    }
    text.push('\n');
    std::fs::write(&input, text).expect("write bounded-report input");

    let validate = lab()
        .arg("validate")
        .arg(&input)
        .output()
        .expect("validate");
    assert_eq!(validate.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&validate.stdout);
    assert!(stdout.contains(&format!("{invalid_count} diagnostic(s)")));
    assert!(stdout.contains(&format!(
        "showing first {MAX_DIAGNOSTICS} of {invalid_count} diagnostics"
    )));
    assert_eq!(
        stdout.matches("  record ").count(),
        MAX_DIAGNOSTICS,
        "the CLI must not render an unbounded finding list"
    );
    assert!(!stdout.contains("private-payload"));
    assert!(!stdout.contains("private-evidence"));

    let summarize = lab()
        .arg("summarize")
        .arg(&input)
        .output()
        .expect("summarize");
    assert_eq!(summarize.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&summarize.stdout);
    assert!(stdout.contains(&format!("diagnostics: {invalid_count}")));
    assert!(stdout.contains(&format!(
        "diagnostic sample: first {MAX_DIAGNOSTICS} of {invalid_count}"
    )));
    assert!(!stdout.contains("private-payload"));
    assert!(!stdout.contains("private-evidence"));
}

#[test]
fn no_output_ever_contains_a_filesystem_path() {
    // The input path is the one piece of host detail a shareable report must
    // not carry, and it is the easiest thing in the world to echo by accident.
    for (command, path) in [
        ("validate", fixture("invalid/sequence-gap.jsonl")),
        ("summarize", fixture("invalid/sequence-gap.jsonl")),
    ] {
        let output = lab().arg(command).arg(&path).output().expect("run");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !combined.contains("/Users/") && !combined.contains("fixtures/"),
            "{command} leaked a path: {combined}"
        );
    }
}

#[test]
fn a_missing_input_reports_the_error_kind_not_the_path() {
    let output = lab()
        .arg("validate")
        .arg("/nonexistent/secret-project/private.jsonl")
        .output()
        .expect("run");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("secret-project"));
    assert!(!stderr.contains("private.jsonl"));
}

#[test]
fn canonicalize_refuses_to_overwrite_and_leaves_the_original_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let out = dir.path().join("out.jsonl");
    std::fs::write(&out, b"PRE-EXISTING\n").expect("seed");

    let output = lab()
        .arg("canonicalize")
        .arg(fixture("valid/minimal.jsonl"))
        .arg(&out)
        .output()
        .expect("run");

    assert_eq!(output.status.code(), Some(2), "must refuse to clobber");
    assert_eq!(
        std::fs::read_to_string(&out).expect("read"),
        "PRE-EXISTING\n",
        "the existing file must be byte-identical afterwards"
    );
}

#[test]
fn canonicalize_never_mutates_its_input() {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = dir.path().join("in.jsonl");
    std::fs::copy(fixture("valid/minimal.jsonl"), &input).expect("copy");
    let before = std::fs::read(&input).expect("read");

    let out = dir.path().join("out.jsonl");
    let output = lab()
        .arg("canonicalize")
        .arg(&input)
        .arg(&out)
        .output()
        .expect("run");
    assert!(output.status.success(), "{output:?}");

    assert_eq!(
        std::fs::read(&input).expect("read"),
        before,
        "input must be byte-identical after canonicalizing"
    );
    assert!(out.exists());
}

#[test]
fn canonicalize_is_idempotent() {
    // Canonical form is only useful for byte comparison if running it twice
    // changes nothing.
    let dir = tempfile::tempdir().expect("tempdir");
    let once = dir.path().join("once.jsonl");
    let twice = dir.path().join("twice.jsonl");

    assert!(lab()
        .arg("canonicalize")
        .arg(fixture("valid/all-time-resolutions.jsonl"))
        .arg(&once)
        .output()
        .expect("run")
        .status
        .success());
    assert!(lab()
        .arg("canonicalize")
        .arg(&once)
        .arg(&twice)
        .output()
        .expect("run")
        .status
        .success());

    assert_eq!(
        std::fs::read(&once).expect("read"),
        std::fs::read(&twice).expect("read"),
        "canonicalizing a canonical file must be a no-op"
    );
}

#[test]
fn canonical_output_still_validates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let out = dir.path().join("out.jsonl");
    assert!(lab()
        .arg("canonicalize")
        .arg(fixture("valid/all-eleven-correlations.jsonl"))
        .arg(&out)
        .output()
        .expect("run")
        .status
        .success());

    let check = lab().arg("validate").arg(&out).output().expect("run");
    assert!(
        check.status.success(),
        "canonicalizing must preserve conformance: {}",
        String::from_utf8_lossy(&check.stdout)
    );
}

#[test]
fn usage_error_exits_two() {
    assert_eq!(lab().output().expect("run").status.code(), Some(2));
    assert_eq!(
        lab().arg("frobnicate").output().expect("run").status.code(),
        Some(2)
    );
}

#[test]
fn the_lab_opens_no_network_socket() {
    // Not a sandbox proof — a behavioral one. The binary is linked against a
    // crate that CAN make requests, so the guarantee worth testing is that the
    // tool completes normally with no resolver or route available.
    let dir = tempfile::tempdir().expect("tempdir");
    let input = dir.path().join("in.jsonl");
    let mut file = std::fs::File::create(&input).expect("create");
    file.write_all(
        std::fs::read(fixture("valid/minimal.jsonl"))
            .unwrap()
            .as_slice(),
    )
    .expect("write");
    drop(file);

    let output = lab()
        .arg("validate")
        .arg(&input)
        // Poison every proxy variable a client library might consult. If the
        // tool tried to reach the network it would hang or error; it does not.
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("HTTPS_PROXY", "http://127.0.0.1:1")
        .env("ALL_PROXY", "socks5://127.0.0.1:1")
        .env("NO_PROXY", "")
        .output()
        .expect("run");
    assert!(output.status.success(), "{output:?}");
}
