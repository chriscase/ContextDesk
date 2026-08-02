//! Cross-language conformance: the Node and Python reference producers must
//! agree with the Rust validator on every frozen fixture.
//!
//! #826 requires that "Rust, TypeScript/Node, and Python examples exercise the
//! same versioned capability contract". This test is what makes that true
//! rather than aspirational — it runs the other two implementations against the
//! same frozen corpus and fails if any of them disagrees about any file.
//!
//! It already caught one real divergence during development: the Python
//! reference accepted a file with a forbidden evaluator sentinel that Rust
//! rejected. The corpus is the definition of conformance, so the reference was
//! fixed rather than the corpus weakened.
//!
//! Skipped (not failed) when the interpreter is unavailable, so a machine
//! without Node or Python can still run the suite — but CI has both.

use std::path::PathBuf;
use std::process::Command;

/// Number of `.jsonl` fixtures on disk across valid/ and invalid/.
fn count_fixtures() -> usize {
    ["valid", "invalid"]
        .iter()
        .map(|sub| {
            std::fs::read_dir(repo_root().join("fixtures/normalized-log-events").join(sub))
                .expect("read fixture dir")
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
                .count()
        })
        .sum()
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn interpreter_available(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn run_conformance(program: &str, script: &str) {
    if !interpreter_available(program) {
        eprintln!("skipping cross-language check: {program} is unavailable");
        return;
    }
    let root = repo_root();
    let output = Command::new(program)
        .arg(root.join(script))
        .arg("--check")
        .arg(root.join("fixtures/normalized-log-events"))
        // Running the Python reference from inside the repo would otherwise
        // leave a __pycache__ directory in the working tree on every test run.
        // Preventing the artifact is better than gitignoring the litter.
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap_or_else(|error| panic!("run {program}: {error}"));

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{program} reference disagreed with the Rust validator.\n\
         stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        stdout.contains("0 disagreement(s)"),
        "{program} did not report agreement: {stdout}"
    );
    // Guard against a reference that silently checks nothing — and derive the
    // expected count from disk rather than hardcoding it, so adding a fixture
    // cannot leave a reference quietly checking a stale subset.
    let expected = count_fixtures();
    assert!(
        stdout.contains(&format!("{expected} fixtures checked")),
        "{program} must check the whole corpus of {expected}: {stdout}"
    );
}

#[test]
fn the_python_reference_agrees_with_the_rust_validator() {
    run_conformance(
        "python3",
        "examples/normalized-log-producers/python/produce_and_validate.py",
    );
}

#[test]
fn the_node_reference_agrees_with_the_rust_validator() {
    run_conformance(
        "node",
        "examples/normalized-log-producers/node/produce-and-validate.mjs",
    );
}

#[test]
fn every_reference_producer_emits_a_file_the_rust_validator_accepts() {
    // The other direction: what each reference PRODUCES must satisfy the
    // authority, not merely what it accepts.
    let root = repo_root();
    let cases = [
        (
            "python3",
            "examples/normalized-log-producers/python/produce_and_validate.py",
        ),
        (
            "node",
            "examples/normalized-log-producers/node/produce-and-validate.mjs",
        ),
    ];
    for (program, script) in cases {
        if !interpreter_available(program) {
            eprintln!("skipping emit check: {program} is unavailable");
            continue;
        }
        let output = Command::new(program)
            .arg(root.join(script))
            .arg("--emit")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap_or_else(|error| panic!("run {program}: {error}"));
        assert!(output.status.success(), "{program} --emit failed");
        let text = String::from_utf8_lossy(&output.stdout);
        let report = cd_core::normalized_log_events::validate_file(&text);
        assert!(
            report.ok,
            "{program} emitted a non-conforming file: {:?}",
            report.diagnostics
        );
        assert!(report.events_validated >= 3);
    }
}

#[test]
fn exact_line_bound_agrees_across_rust_node_and_python() {
    use cd_core::normalized_log_events::{
        canonicalize_stream, validate_file, validate_stream, MAX_NORMALIZED_LINE_BYTES,
    };

    let root = repo_root();
    let minimal =
        std::fs::read_to_string(root.join("fixtures/normalized-log-events/valid/minimal.jsonl"))
            .expect("minimal fixture");
    let mut lines = minimal.lines();
    let header = lines.next().expect("header");
    let mut event: serde_json::Value =
        serde_json::from_str(lines.next().expect("event")).expect("event json");
    event
        .as_object_mut()
        .unwrap()
        .insert("futurePadding".into(), serde_json::json!(""));
    let base = serde_json::to_string(&event).unwrap();
    event.as_object_mut().unwrap().insert(
        "futurePadding".into(),
        serde_json::json!("x".repeat(MAX_NORMALIZED_LINE_BYTES - base.len())),
    );
    let line = serde_json::to_string(&event).unwrap();
    assert_eq!(line.len(), MAX_NORMALIZED_LINE_BYTES);
    let dir = tempfile::tempdir().expect("tempdir");
    for (suffix, terminator) in [("lf", "\n"), ("crlf", "\r\n")] {
        let text = format!("{header}{terminator}{line}{terminator}");
        assert!(validate_file(&text).ok);
        assert!(
            validate_stream(std::io::Cursor::new(text.as_bytes()))
                .unwrap()
                .ok
        );
        let mut canonical = Vec::new();
        canonicalize_stream(std::io::Cursor::new(text.as_bytes()), &mut canonical)
            .expect("canonicalize exact bound");

        let input = dir.path().join(format!("exact-bound-{suffix}.jsonl"));
        std::fs::write(&input, text).expect("write exact-bound file");
        for (program, script) in [
            (
                "python3",
                "examples/normalized-log-producers/python/produce_and_validate.py",
            ),
            (
                "node",
                "examples/normalized-log-producers/node/produce-and-validate.mjs",
            ),
        ] {
            if !interpreter_available(program) {
                continue;
            }
            let output = Command::new(program)
                .arg(root.join(script))
                .arg("--validate")
                .arg(&input)
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .output()
                .unwrap_or_else(|error| panic!("run {program}: {error}"));
            assert!(
                output.status.success(),
                "{program} rejected exact {suffix} bound: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
