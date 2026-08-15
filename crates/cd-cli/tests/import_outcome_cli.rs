//! CLI-surface regression tests for the fail-closed import result contract.
//!
//! `crates/cd-core/tests/import_outcome_contract.rs` proves the engine-side
//! classification; this file proves the compiled `contextdesk` binary's OWN
//! projection of it — the `--json` envelope (including the optional error
//! `details` document) and the operator prose — and that the two surfaces
//! state the same facts.
//!
//! Every input is synthetic: member bodies come from `fixtures/import-outcome`
//! and archives are assembled at test time into temporary directories. No
//! private corpora, credentials, gateways, or provider calls are involved.

use assert_cmd::Command;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Every invocation gets its own library via `--data-dir`.
///
/// `$HOME` alone is not isolation: `dirs::home_dir()` reads it on Unix but
/// uses `FOLDERID_Profile` on Windows and ignores it entirely, so on Windows
/// these tests would all share the real user profile — and, because the
/// workspace suite runs with `RUST_TEST_THREADS=4` off Linux, they would race
/// each other's corpora ("expected 1 corpus, found 5"). `--data-dir` is the
/// documented cross-platform seam: it bypasses `dirs::home_dir()` and makes
/// `config_dir` exactly this directory. `HOME` stays set so a Unix-only path
/// that still consults it cannot escape to the real profile either.
fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd.arg("--data-dir").arg(home);
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

fn corpus_ids(home: &Path) -> Vec<String> {
    let list = cli(home)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("run contextdesk corpus list");
    let envelope = parse_envelope(&list.stdout);
    envelope["data"]["corpora"]
        .as_array()
        .expect("corpora array")
        .iter()
        .map(|corpus| corpus["id"].as_str().expect("corpus id").to_string())
        .collect()
}

/// A defective-but-publishable source: one member with malformed JSON Lines
/// records beside a clean neighbour.
fn defective_archive(dir: &Path) -> PathBuf {
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

/// A source the engine must reject outright: a corrupt nested container
/// beside a member that would otherwise import.
fn rejected_archive(dir: &Path) -> PathBuf {
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

/// A partial import's `--json` envelope must carry the full typed outcome —
/// class, located defects with record positions, complete per-code totals —
/// and the operator prose must state the same facts, while the corpus is
/// really published.
#[test]
fn partial_import_reports_located_details_in_json_and_prose() {
    let source = tempfile::tempdir().unwrap();
    let archive = defective_archive(source.path());

    // JSON surface.
    let json_home = tempfile::tempdir().unwrap();
    let import = cli(json_home.path())
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import");
    assert!(
        import.status.success(),
        "a defective-but-publishable source still exits 0: {}",
        String::from_utf8_lossy(&import.stderr)
    );
    let envelope = parse_envelope(&import.stdout);
    assert_eq!(envelope["ok"], true);
    let data = &envelope["data"];
    let outcome = &data["outcome"];
    assert_eq!(outcome["class"], "partial");
    assert_eq!(outcome["published"], true);
    assert_eq!(outcome["schemaId"], "contextdesk.import_outcome.v1");
    assert_eq!(
        outcome["corpusId"], data["corpus_id"],
        "the typed outcome and the legacy summary must name the same corpus"
    );
    // The legacy bool reflects failed or policy-excluded sources only; a
    // malformed-records-only run leaves it false. A script keying on the bool
    // alone would misread this run as complete — the typed class is the
    // authoritative verdict, which is exactly what this test pins.
    assert_eq!(data["partial"], false);
    assert_eq!(outcome["counts"]["recordsMalformed"], 2);

    let defects = outcome["defects"].as_array().expect("defects array");
    let malformed = defects
        .iter()
        .find(|d| d["code"] == "malformed_structured_record")
        .expect("located malformed-record defect");
    assert_eq!(malformed["source"]["identity"], "logs/malformed.jsonl");
    assert_eq!(malformed["severity"], "degraded");
    assert_eq!(
        malformed["location"]["line"], 2,
        "the first bad record is located by line: {malformed}"
    );
    assert_eq!(
        malformed["occurrences"], 2,
        "both bad records are counted on one coalesced entry"
    );
    assert_eq!(
        outcome["defectCounts"]["malformed_structured_record"], 2,
        "per-code totals stay complete: {outcome}"
    );
    assert_eq!(
        outcome["privacy"]["redactionMode"],
        "identity_structural_only"
    );

    // Structural identity only — no record payload may reach the wire.
    let wire = String::from_utf8_lossy(&import.stdout);
    for payload in [
        "first record parses",
        "unterminated object",
        "last record parses",
        "neighbour alpha",
    ] {
        assert!(
            !wire.contains(payload),
            "import envelope leaked record payload {payload:?}: {wire}"
        );
    }

    // Published means published: the corpus is really in the library.
    let ids = corpus_ids(json_home.path());
    assert_eq!(
        ids.len(),
        1,
        "a partial import publishes exactly one corpus"
    );
    assert_eq!(Some(ids[0].as_str()), outcome["corpusId"].as_str());

    // Operator prose states the same facts as the machine document.
    let text_home = tempfile::tempdir().unwrap();
    let text = cli(text_home.path())
        .args(["import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import (text)");
    assert!(text.status.success());
    let stdout = String::from_utf8_lossy(&text.stdout);
    assert!(
        stdout.contains("Import complete with defects (PARTIAL)"),
        "the headline must not say plain 'complete' for a partial corpus: {stdout}"
    );
    // Assert the wording either side of the dash, not the dash itself: the
    // human renderer normalizes typography to ASCII when `ascii_from_env()`
    // is on, and that defaults to `cfg!(windows)`, so this headline's em dash
    // (`push_ascii_typography`, U+2014) reaches a Windows operator as "-".
    // The rendered prose is the only surface affected — the `--json` envelope
    // and the rejection message asserted below carry the em dash verbatim.
    assert!(
        stdout.contains("PARTIAL") && stdout.contains("a corpus was published but"),
        "{stdout}"
    );
    for fact in [
        "logs/malformed.jsonl",
        "malformed_structured_record",
        "at line 2",
    ] {
        assert!(
            stdout.contains(fact),
            "prose must state the same fact {fact:?} the JSON carries: {stdout}"
        );
    }
}

/// Intentional filtering is not a defect: a NUL-bearing member the default
/// preselection drops as unsupported never reaches ingest, records no defect,
/// and must not downgrade the class — the clean neighbours still make a
/// `complete` import.
#[test]
fn intentional_preview_filtering_never_downgrades_the_class() {
    let source = tempfile::tempdir().unwrap();
    let archive = source.path().join("clean-plus-binary.zip");
    std::fs::write(
        &archive,
        zip_bytes(&[
            (
                "logs/neighbour-alpha.log",
                &member_body("neighbour-alpha.log"),
            ),
            (
                "logs/neighbour-beta.jsonl",
                &member_body("neighbour-beta.jsonl"),
            ),
            ("telemetry.bin", b"\x00\x01\x02\x00 binary blob \x00"),
        ]),
    )
    .unwrap();

    let home = tempfile::tempdir().unwrap();
    let import = cli(home.path())
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import");
    assert!(
        import.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&import.stderr)
    );
    let envelope = parse_envelope(&import.stdout);
    let data = &envelope["data"];
    assert_eq!(data["outcome"]["class"], "complete");
    assert_eq!(data["outcome"]["published"], true);
    assert_eq!(data["partial"], false);
    assert_eq!(
        data["sources_unsupported"], 1,
        "the filtered member is still counted, as intentional filtering: {data}"
    );
    assert!(
        data["outcome"]["defects"]
            .as_array()
            .expect("defects")
            .is_empty(),
        "an intentionally filtered member must not appear as a defect: {data}"
    );
}

/// A rejected import exits non-zero with `ok:false`, carries the same typed
/// outcome document under `error.details` (class `rejected`, nothing
/// published, no corpus id, the failing member named), really publishes
/// nothing, and the operator prose names the same member without leaking the
/// annotation marker.
#[test]
fn rejected_import_names_the_member_and_publishes_nothing() {
    let source = tempfile::tempdir().unwrap();
    let archive = rejected_archive(source.path());

    // JSON surface.
    let home = tempfile::tempdir().unwrap();
    let import = cli(home.path())
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import");
    assert_eq!(
        import.status.code(),
        Some(70),
        "a corrupt archive is an internal-category failure, not success: {}",
        String::from_utf8_lossy(&import.stderr)
    );
    let envelope = parse_envelope(&import.stdout);
    assert_eq!(envelope["ok"], false);
    assert!(envelope["data"].is_null(), "a failure carries no data");
    let error = &envelope["error"];
    assert_eq!(error["kind"], "internal");
    let message = error["message"].as_str().expect("error message");
    assert!(
        message.contains("failing source: bundles/inner.zip"),
        "the message names the member that stopped the run: {message}"
    );
    assert!(
        message.contains("nothing was published — the library is unchanged"),
        "{message}"
    );
    assert!(
        !message.contains("[member="),
        "the identity-transport marker must never reach a caller: {message}"
    );

    // The optional typed details document — same facts a success would carry.
    let details = &error["details"];
    assert_eq!(details["schemaId"], "contextdesk.import_outcome.v1");
    assert_eq!(details["class"], "rejected");
    assert_eq!(details["published"], false);
    assert!(
        details.get("corpusId").is_none_or(Value::is_null),
        "a rejected outcome must not name a corpus: {details}"
    );
    assert_eq!(details["counts"]["sourcesImported"], 0);
    assert_eq!(details["counts"]["recordsImported"], 0);
    let defects = details["defects"].as_array().expect("defects array");
    let fatal = defects
        .iter()
        .find(|d| d["severity"] == "fatal")
        .expect("a rejection carries a fatal defect");
    assert_eq!(fatal["source"]["identity"], "bundles/inner.zip");
    assert!(
        fatal["code"] == "archive_unreadable" || fatal["code"] == "nested_archive_staging_failed",
        "unexpected code: {fatal}"
    );

    // No publication means no corpus — not a corpus with zero events.
    assert!(
        corpus_ids(home.path()).is_empty(),
        "a rejected import must leave the library unchanged"
    );

    // Operator prose (text mode) states the same verdict and member.
    let text = cli(home.path())
        .args(["import", archive.to_str().unwrap()])
        .output()
        .expect("run contextdesk import (text)");
    assert_eq!(text.status.code(), Some(70));
    let stderr = String::from_utf8_lossy(&text.stderr);
    assert!(
        stderr.contains("failing source: bundles/inner.zip"),
        "prose must name the same member the JSON details name: {stderr}"
    );
    assert!(
        stderr.contains("nothing was published — the library is unchanged"),
        "{stderr}"
    );
    assert!(!stderr.contains("[member="), "{stderr}");
    assert!(
        corpus_ids(home.path()).is_empty(),
        "the text-mode rejection must publish nothing either"
    );
}
