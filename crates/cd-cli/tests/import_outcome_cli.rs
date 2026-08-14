//! CLI regression coverage for the fail-closed import outcome contract as it
//! crosses the compiled binary's own surfaces: `data.outcome` on the success
//! envelope, `error.details` on the failure envelope, and the text renderer —
//! which must agree with the machine output about the verdict.
//!
//! `crates/cd-core/tests/import_outcome_contract.rs` proves the engine
//! classification itself; this file proves the CLI's *presentation* of it,
//! especially the one distinction a script must never get wrong:
//! published-with-defects (`partial`, exit 0, corpus exists) versus
//! rejected (nonzero exit, nothing published).
//!
//! All inputs are synthetic member bodies from `fixtures/import-outcome`,
//! assembled into temporary archives at test time. No providers, credentials,
//! or private corpora are involved.

use assert_cmd::Command;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("stdout is one JSON envelope")
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/import-outcome")
}

fn member_body(name: &str) -> Vec<u8> {
    let path = fixture_root().join("members").join(name);
    std::fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "required synthetic fixture {} is missing: {error}",
            path.display()
        )
    })
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, body) in entries {
        zip.start_file(*name, options).expect("start zip member");
        zip.write_all(body).expect("write zip member");
    }
    zip.finish().expect("finish zip").into_inner()
}

/// An archive that publishes but cannot be complete: one JSON Lines member
/// carries two malformed records beside a clean neighbour.
fn write_partial_source(dir: &Path) -> PathBuf {
    let archive = dir.join("bundle.zip");
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("logs/malformed.jsonl", &member_body("malformed.jsonl")),
            (
                "logs/neighbour-alpha.log",
                &member_body("neighbour-alpha.log"),
            ),
        ]),
    )
    .unwrap();
    archive
}

/// An archive whose nested container is corrupt: the whole import is
/// rejected before anything can be published.
fn write_rejected_source(dir: &Path) -> PathBuf {
    let archive = dir.join("outer.zip");
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("logs/app.log", &member_body("neighbour-alpha.log")),
            (
                "bundles/inner.zip",
                b"PK\x03\x04 not a real central directory",
            ),
        ]),
    )
    .unwrap();
    archive
}

fn corpus_count(home: &Path) -> usize {
    let list = cli(home)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("run contextdesk corpus list");
    let envelope = parse_envelope(&list.stdout);
    envelope["data"]["corpora"]
        .as_array()
        .expect("corpora array")
        .len()
}

/// A partial import exits 0 and publishes, and the typed outcome document —
/// class, located defect, per-code totals, privacy statement — is present at
/// `data.outcome` in machine output while the operator text states the same
/// verdict, down to a byte-identical manifest digest.
#[test]
fn partial_import_reports_typed_outcome_in_json_and_text() {
    let json_home = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let archive = write_partial_source(source_dir.path());

    let json_out = cli(json_home.path())
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import --json");
    assert!(
        json_out.status.success(),
        "a partial import still publishes and exits 0; stderr: {}",
        String::from_utf8_lossy(&json_out.stderr)
    );
    let envelope = parse_envelope(&json_out.stdout);
    assert_eq!(envelope["ok"], true);

    let data = &envelope["data"];
    // The legacy bool only reflects source-level omissions; record-level
    // defects are exactly what it cannot see, which is why the typed class
    // below — not this bool — is the authority on partiality.
    assert_eq!(
        data["partial"], false,
        "malformed-record-only partiality is invisible to the legacy bool: {envelope}"
    );
    let outcome = &data["outcome"];
    assert_eq!(outcome["schemaId"], "contextdesk.import_outcome.v1");
    assert_eq!(outcome["class"], "partial");
    assert_eq!(outcome["published"], true);
    assert_eq!(
        outcome["corpusId"], data["corpus_id"],
        "the outcome names the same corpus the command published: {envelope}"
    );
    assert_eq!(
        outcome["defectCounts"]["malformed_structured_record"], 2,
        "complete per-code totals: {envelope}"
    );
    let defect = &outcome["defects"][0];
    assert_eq!(defect["code"], "malformed_structured_record");
    assert_eq!(defect["severity"], "degraded");
    assert_eq!(defect["source"]["identity"], "logs/malformed.jsonl");
    assert_eq!(defect["location"]["line"], 2);
    assert_eq!(
        outcome["privacy"]["redactionMode"], "identity_structural_only",
        "the report states its own redaction mode: {envelope}"
    );
    let digest = outcome["manifestDigest"]
        .as_str()
        .expect("manifest digest string");
    assert!(digest.starts_with("sha256:"), "{digest}");
    assert_eq!(
        corpus_count(json_home.path()),
        1,
        "published-with-defects means the corpus exists"
    );

    // The operator text for the same source says the same thing — the typed
    // headline, the located defect, and the identical deterministic digest.
    let text_home = tempfile::tempdir().unwrap();
    let text_out = cli(text_home.path())
        .args(["import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import (text)");
    assert!(
        text_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&text_out.stderr)
    );
    let stdout = String::from_utf8_lossy(&text_out.stdout);
    assert!(
        stdout.contains("Import complete with defects (PARTIAL)"),
        "headline must carry the typed verdict: {stdout}"
    );
    assert!(
        stdout.contains("Import outcome: PARTIAL"),
        "outcome summary block present: {stdout}"
    );
    assert!(stdout.contains("malformed_structured_record"), "{stdout}");
    assert!(stdout.contains("logs/malformed.jsonl"), "{stdout}");
    assert!(
        !stdout.contains("COMPLETE — every discovered source was imported"),
        "prose must never claim completeness for a partial corpus: {stdout}"
    );
    assert!(
        stdout.contains(digest),
        "operator text and machine JSON agree on the manifest digest {digest}: {stdout}"
    );
}

/// A rejected import publishes nothing, exits nonzero, and hands scripts the
/// same typed document on `error.details` — with the transport marker
/// stripped from the prose and the failing member named by its redacted
/// locator in both surfaces.
#[test]
fn rejected_import_carries_typed_details_and_publishes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let archive = write_rejected_source(source_dir.path());

    let out = cli(home.path())
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import --json");
    assert_eq!(
        out.status.code(),
        Some(70),
        "a corrupt container is an internal-category rejection; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let envelope = parse_envelope(&out.stdout);
    assert_eq!(envelope["ok"], false);
    let error = &envelope["error"];
    assert_eq!(error["kind"], "internal");

    let message = error["message"].as_str().expect("error message");
    assert!(
        message.contains("failing source: bundles/inner.zip (archive_unreadable)"),
        "prose names the member and code: {message}"
    );
    assert!(
        message.contains("nothing was published — the library is unchanged"),
        "prose states no publication: {message}"
    );
    assert!(
        !message.contains("[member="),
        "the engine's transport marker must never reach the operator: {message}"
    );

    let details = &error["details"];
    assert_eq!(details["schemaId"], "contextdesk.import_outcome.v1");
    assert_eq!(details["class"], "rejected");
    assert_eq!(details["published"], false);
    assert!(
        details.get("corpusId").is_none(),
        "a rejected report never names a corpus: {envelope}"
    );
    let defect = &details["defects"][0];
    assert_eq!(defect["severity"], "fatal");
    assert_eq!(defect["code"], "archive_unreadable");
    assert_eq!(defect["source"]["identity"], "bundles/inner.zip");
    assert_eq!(
        corpus_count(home.path()),
        0,
        "rejected means no publication at all"
    );

    // Text mode reaches the same operator facts on stderr.
    let text_home = tempfile::tempdir().unwrap();
    let text_out = cli(text_home.path())
        .args(["import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import (text)");
    assert!(!text_out.status.success());
    let stderr = String::from_utf8_lossy(&text_out.stderr);
    assert!(
        stderr.contains("failing source: bundles/inner.zip"),
        "text mode names the member: {stderr}"
    );
    assert!(
        stderr.contains("nothing was published"),
        "text mode states no publication: {stderr}"
    );
    assert!(!stderr.contains("[member="), "{stderr}");
    assert_eq!(corpus_count(text_home.path()), 0);
}

/// The one distinction automation must be able to make without parsing
/// prose: published-with-defects (exit 0, `data.outcome.published: true`,
/// corpus exists) versus rejected (nonzero exit,
/// `error.details.published: false`, no corpus).
#[test]
fn published_with_defects_and_rejected_are_machine_distinguishable() {
    let partial_home = tempfile::tempdir().unwrap();
    let rejected_home = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let partial_archive = write_partial_source(source_dir.path());
    let rejected_archive = write_rejected_source(source_dir.path());

    let partial = cli(partial_home.path())
        .args(["--json", "import", partial_archive.to_str().unwrap()])
        .output()
        .expect("run partial import");
    let rejected = cli(rejected_home.path())
        .args(["--json", "import", rejected_archive.to_str().unwrap()])
        .output()
        .expect("run rejected import");

    let partial_envelope = parse_envelope(&partial.stdout);
    let rejected_envelope = parse_envelope(&rejected.stdout);

    assert!(partial.status.success());
    assert_eq!(partial_envelope["data"]["outcome"]["published"], true);
    assert!(
        partial_envelope.get("error").is_none() || partial_envelope["error"].is_null(),
        "{partial_envelope}"
    );
    assert_eq!(corpus_count(partial_home.path()), 1);

    assert!(!rejected.status.success());
    assert_eq!(rejected_envelope["error"]["details"]["published"], false);
    assert!(
        rejected_envelope.get("data").is_none() || rejected_envelope["data"].is_null(),
        "{rejected_envelope}"
    );
    assert_eq!(corpus_count(rejected_home.path()), 0);

    // The class strings a script branches on are exactly the documented pair.
    assert_eq!(partial_envelope["data"]["outcome"]["class"], "partial");
    assert_eq!(rejected_envelope["error"]["details"]["class"], "rejected");
}
