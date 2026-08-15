//! Regression tests for the fail-closed batch-corpus import result contract.
//!
//! Every input is synthetic: member bodies come from `fixtures/import-outcome`
//! and archives are assembled at test time into temporary directories. No
//! private corpora, credentials, gateways, or provider calls are involved.
//!
//! The three questions under test are the ones an operator actually asks after
//! a bad batch import:
//!
//! 1. *Which member broke?* — a corrupt archive member must be named by its
//!    portable identity (`bundles/inner.zip`, or `middle.zip!/broken.zip` when
//!    it is nested), not surface as a bare `zip open:` string.
//! 2. *Did the good members survive?* — a defect in one member must not be
//!    reported in a way that implies its neighbours were lost.
//! 3. *Where exactly?* — malformed JSON Lines records must be located by line,
//!    without the record text ever reaching the report.

use std::io::Write;
use std::path::{Path, PathBuf};

use cd_core::log_analysis::import_outcome::{
    ImportDefectCode, ImportDefectSeverity, ImportOutcomeClass, IMPORT_OUTCOME_SCHEMA_ID,
};
use cd_core::log_analysis::ingest::ingest_path_with_outcome;
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::LogEmbedPolicy;
use cd_core::process_progress::NoopProcessProgress;

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

/// Run the real ingest path and return its outcome contract.
fn import(cache: &Path, source: &Path, name: &str) -> cd_core::log_analysis::ImportOutcomeReport {
    let (_result, outcome) = ingest_path_with_outcome(
        cache,
        source,
        name,
        &LogEmbedPolicy::default(),
        None,
        &NoopProcessProgress,
        None,
        None,
        None,
    );
    assert!(
        outcome.invariants_hold(),
        "outcome violated its own contract: {outcome:?}"
    );
    assert_eq!(outcome.schema_id, IMPORT_OUTCOME_SCHEMA_ID);
    outcome
}

/// Nothing anywhere in a report may carry a source record.
///
/// Asserted against the serialized JSON rather than individual fields so a
/// future field that leaks payload fails here rather than silently shipping.
fn assert_no_payload(outcome: &cd_core::log_analysis::ImportOutcomeReport, forbidden: &[&str]) {
    let json = serde_json::to_string(outcome).expect("serialize outcome");
    for needle in forbidden {
        assert!(
            !json.contains(needle),
            "report leaked source payload {needle:?}: {json}"
        );
    }
}

#[test]
fn corrupt_nested_archive_member_is_named_and_nothing_is_published() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let outer = root.path().join("outer.zip");

    // A corrupt inner container beside a member that would otherwise import.
    std::fs::write(
        &outer,
        zip_bytes(&[
            ("neighbour-alpha.log", &member_body("neighbour-alpha.log")),
            (
                "bundles/inner.zip",
                b"PK\x03\x04 not a real central directory",
            ),
        ]),
    )
    .unwrap();

    let outcome = import(&cache, &outer, "nested-corrupt");

    // Fail-closed: a corrupt member rejects the whole import.
    assert_eq!(outcome.class, ImportOutcomeClass::Rejected);
    assert!(!outcome.published);
    assert!(outcome.corpus_id.is_none());
    assert!(
        LogCorpus::list_ids(&cache).unwrap().is_empty(),
        "a rejected import must not publish a corpus"
    );

    // Useful: the exact member is named, with its archive chain intact.
    let defect = outcome
        .defects
        .iter()
        .find(|d| d.severity == ImportDefectSeverity::Fatal)
        .expect("rejected outcome must carry a fatal defect");
    // The engine's portable identity for a member of the *selected* archive is
    // its in-archive relative path — the same string the import preview shows —
    // so the report names `bundles/inner.zip`, directory included.
    assert_eq!(
        defect.source.identity, "bundles/inner.zip",
        "the failing member must be named, not just 'a zip failed'"
    );
    assert_eq!(defect.source.member, "inner.zip");
    assert_eq!(
        defect.source.archive_depth, 0,
        "a member of the selected archive is depth 0; the root is not named"
    );
    assert!(
        matches!(
            defect.code,
            ImportDefectCode::ArchiveUnreadable | ImportDefectCode::NestedArchiveStagingFailed
        ),
        "unexpected code {:?}",
        defect.code
    );

    // The summary an operator reads says all three things.
    let summary = outcome.render_summary();
    assert!(summary.contains("REJECTED"), "{summary}");
    assert!(summary.contains("bundles/inner.zip"), "{summary}");
    assert!(summary.contains("nothing was published"), "{summary}");
}

#[test]
fn deeply_nested_member_keeps_its_full_chain() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let outer = root.path().join("outer.zip");

    // outer.zip -> middle.zip -> broken.zip (three containers).
    let middle = zip_bytes(&[("broken.zip", b"PK\x03\x04 truncated")]);
    std::fs::write(&outer, zip_bytes(&[("middle.zip", &middle)])).unwrap();

    let outcome = import(&cache, &outer, "deep-nested");

    assert_eq!(outcome.class, ImportOutcomeClass::Rejected);
    let defect = outcome
        .defects
        .iter()
        .find(|d| d.severity == ImportDefectSeverity::Fatal)
        .expect("fatal defect");
    assert_eq!(defect.source.identity, "middle.zip!/broken.zip");
    assert_eq!(
        defect.source.archive_chain,
        vec!["middle.zip"],
        "the nested container level must survive into the locator"
    );
    assert_eq!(defect.source.member, "broken.zip");
    assert_eq!(defect.source.archive_depth, 1);
    assert!(
        defect.source.is_nested(),
        "a member of an archive inside the selected archive is nested"
    );
}

#[test]
fn malformed_jsonl_records_are_located_and_neighbours_still_import() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let archive = root.path().join("bundle.zip");

    let malformed = member_body("malformed.jsonl");
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("logs/malformed.jsonl", &malformed),
            (
                "logs/neighbour-alpha.log",
                &member_body("neighbour-alpha.log"),
            ),
            (
                "logs/neighbour-beta.jsonl",
                &member_body("neighbour-beta.jsonl"),
            ),
        ]),
    )
    .unwrap();

    let outcome = import(&cache, &archive, "malformed-jsonl");

    // A malformed record degrades the corpus; it does not reject it. The class
    // must still not be `complete` — that is the whole point of the contract.
    assert_eq!(outcome.class, ImportOutcomeClass::Partial);
    assert!(outcome.published);
    let corpus_id = outcome.corpus_id.clone().expect("partial still publishes");

    // Exactly the two malformed physical lines, and nothing else.
    assert_eq!(outcome.counts.records_malformed, 2);
    let defect = outcome
        .defects
        .iter()
        .find(|d| d.code == ImportDefectCode::MalformedStructuredRecord)
        .expect("malformed record defect");
    assert_eq!(defect.source.identity, "logs/malformed.jsonl");
    assert_eq!(defect.severity, ImportDefectSeverity::Degraded);
    assert_eq!(defect.occurrences, 2, "both bad records counted");

    // Located at the first bad line, with the byte offset of that line's start.
    let location = defect.location.expect("record location");
    assert_eq!(location.line, 2);
    let first_line_len = malformed
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("fixture has newlines")
        + 1;
    assert_eq!(location.byte_offset, first_line_len as u64);

    // The neighbouring members imported. Their records are in the corpus and no
    // defect is attributed to them.
    let corpus = LogCorpus::open(&cache, &corpus_id).expect("open published corpus");
    assert!(
        corpus.event_count() > 0,
        "neighbouring members must still produce events"
    );
    for neighbour in ["neighbour-alpha.log", "neighbour-beta.jsonl"] {
        assert!(
            !outcome.defects.iter().any(|d| d.source.member == neighbour),
            "clean neighbour {neighbour} must carry no defect: {:?}",
            outcome.defects
        );
    }

    // The valid records inside the malformed member are kept, not discarded
    // wholesale: a located defect is not a dropped member.
    assert!(
        outcome.counts.records_imported >= 8,
        "records from every member should survive, got {}",
        outcome.counts.records_imported
    );

    // No payload from any record — including the malformed ones — anywhere.
    assert_no_payload(
        &outcome,
        &[
            "first record parses",
            "unterminated object",
            "last record parses",
            "structured neighbour",
            "neighbour alpha",
        ],
    );
}

#[test]
fn clean_archive_is_complete_and_defect_free() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let archive = root.path().join("clean.zip");
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("neighbour-alpha.log", &member_body("neighbour-alpha.log")),
            ("neighbour-beta.jsonl", &member_body("neighbour-beta.jsonl")),
        ]),
    )
    .unwrap();

    let outcome = import(&cache, &archive, "clean");

    assert_eq!(outcome.class, ImportOutcomeClass::Complete);
    assert!(outcome.published);
    assert!(outcome.corpus_id.is_some());
    assert!(outcome.defects.is_empty());
    assert!(outcome.defect_counts.is_empty());
    assert_eq!(outcome.counts.records_malformed, 0);
    assert_eq!(outcome.counts.sources_failed, 0);
    assert_eq!(outcome.counts.sources_excluded, 0);
    assert_eq!(outcome.counts.sources_imported, 2);

    let summary = outcome.render_summary();
    assert!(summary.contains("COMPLETE"), "{summary}");
}

#[test]
fn excluded_member_downgrades_the_class_and_is_named() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let archive = root.path().join("mixed.zip");
    // A NUL-bearing member is excluded as binary; its neighbour imports.
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("neighbour-alpha.log", &member_body("neighbour-alpha.log")),
            ("telemetry.bin", b"\x00\x01\x02\x00 binary blob \x00"),
        ]),
    )
    .unwrap();

    let outcome = import(&cache, &archive, "mixed");

    assert_eq!(
        outcome.class,
        ImportOutcomeClass::Partial,
        "an excluded member must never read as complete"
    );
    let defect = outcome
        .defects
        .iter()
        .find(|d| d.code == ImportDefectCode::MemberBinary)
        .expect("binary exclusion is reported as a located defect");
    assert_eq!(defect.source.identity, "telemetry.bin");
    assert_eq!(defect.severity, ImportDefectSeverity::Degraded);
}

#[test]
fn identical_sources_produce_identical_manifest_digests() {
    let bodies: &[(&str, &[u8])] = &[
        ("logs/malformed.jsonl", &member_body("malformed.jsonl")),
        (
            "logs/neighbour-alpha.log",
            &member_body("neighbour-alpha.log"),
        ),
    ];

    let mut digests = Vec::new();
    for run in 0..2 {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let archive = root.path().join("bundle.zip");
        std::fs::write(&archive, zip_bytes(bodies)).unwrap();
        let outcome = import(&cache, &archive, &format!("determinism-{run}"));
        digests.push(outcome.manifest_digest);
    }

    assert_eq!(
        digests[0], digests[1],
        "the same synthetic source must yield the same manifest digest across runs"
    );
    assert!(digests[0].starts_with("sha256:"), "{}", digests[0]);
}

#[test]
fn secret_bearing_member_names_are_scrubbed_in_the_report() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let archive = root.path().join("bundle.zip");
    // A filename carrying a credential-shaped token, and a private-host-shaped
    // container name. Both are structural identity, and both must be scrubbed.
    std::fs::write(
        &archive,
        zip_bytes(&[
            ("neighbour-alpha.log", &member_body("neighbour-alpha.log")),
            ("sk-abcdefghijklmnopqrst.bin", b"\x00 binary \x00"),
        ]),
    )
    .unwrap();

    let outcome = import(&cache, &archive, "secret-name");

    assert_eq!(outcome.class, ImportOutcomeClass::Partial);
    let json = serde_json::to_string(&outcome).expect("serialize");
    assert!(
        !json.contains("abcdefghijklmnopqrst"),
        "credential-shaped member name reached the report: {json}"
    );
}

#[test]
fn machine_json_and_operator_summary_agree() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    let archive = root.path().join("bundle.zip");
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

    let outcome = import(&cache, &archive, "both-surfaces");
    let json = outcome.to_json();

    assert_eq!(json["schemaId"], IMPORT_OUTCOME_SCHEMA_ID);
    assert_eq!(json["class"], "partial");
    assert_eq!(json["published"], true);
    assert_eq!(
        json["defectCounts"]["malformed_structured_record"], 2,
        "per-code totals are machine readable: {json}"
    );
    assert_eq!(
        json["privacy"]["redactionMode"], "identity_structural_only",
        "the report states its own privacy mode"
    );

    // The same facts appear in the operator text.
    let summary = outcome.render_summary();
    assert!(summary.contains("PARTIAL"), "{summary}");
    assert!(summary.contains("malformed_structured_record"), "{summary}");
    assert!(summary.contains("logs/malformed.jsonl"), "{summary}");
    assert!(
        summary.contains(&outcome.manifest_digest),
        "summary cites the manifest digest: {summary}"
    );
}

/// The preview walk runs *before* ingest, and it is where a corrupt nested
/// container is actually detected — so it is where the original "which member?"
/// question was going unanswered.
///
/// Calling the ingest entry point directly skips this stage entirely, which is
/// how the first version of these tests passed while the real command still
/// printed a bare `zip open:` with nothing named.
#[test]
fn a_preview_stage_rejection_still_names_the_member() {
    use cd_core::log_analysis::import_outcome::ImportOutcomeReport;
    use cd_core::log_analysis::import_preview::preview_import_plan;

    let root = tempfile::tempdir().unwrap();
    let outer = root.path().join("mixed.zip");
    std::fs::write(
        &outer,
        zip_bytes(&[
            ("logs/app.log", &member_body("neighbour-alpha.log")),
            (
                "bundles/inner.zip",
                b"PK\x03\x04 not a real central directory",
            ),
        ]),
    )
    .unwrap();

    let error = preview_import_plan(&outer, None)
        .expect_err("a corrupt nested container must fail the preview");

    let outcome = ImportOutcomeReport::rejected_from_error(&error);
    assert!(outcome.invariants_hold(), "{outcome:?}");
    assert_eq!(outcome.class, ImportOutcomeClass::Rejected);
    assert!(!outcome.published);

    let defect = outcome
        .defects
        .iter()
        .find(|d| d.severity == ImportDefectSeverity::Fatal)
        .expect("fatal defect");
    assert_eq!(
        defect.source.identity, "bundles/inner.zip",
        "a preview-stage rejection must name the member, not '[import root]'"
    );
    assert_eq!(
        defect.code,
        ImportDefectCode::ArchiveUnreadable,
        "an annotated failure is known to be an unreadable container"
    );
}

/// The marker used to carry the identity out must not reach the operator, and
/// the engine's original wording must survive in front of it so existing
/// callers that match on the message keep working.
#[test]
fn the_carried_identity_never_leaks_into_the_message() {
    use cd_core::log_analysis::import_outcome::strip_member_annotation;
    use cd_core::log_analysis::import_preview::preview_import_plan;

    let root = tempfile::tempdir().unwrap();
    let outer = root.path().join("mixed.zip");
    std::fs::write(
        &outer,
        zip_bytes(&[("bundles/inner.zip", b"PK\x03\x04 truncated")]),
    )
    .unwrap();

    let error = preview_import_plan(&outer, None).expect_err("must fail");
    let raw = error.to_string();
    let shown = strip_member_annotation(&raw);

    assert!(
        !shown.contains("[member="),
        "the transport marker must not reach the operator: {shown}"
    );
    assert!(
        shown.contains("zip open") || shown.contains("zip archive"),
        "the engine's own wording must survive: {shown}"
    );
    // An unannotated message is returned untouched.
    assert_eq!(strip_member_annotation("plain failure"), "plain failure");
    // Fail-closed: a malformed or nested frame is cut, never returned raw.
    for leaky in [
        "zip open: missing end record [member=]",
        "zip open: missing end record [member=foo [member=sk-abcdefghijklmnopqrst]]",
        "zip open: missing end record [member=x] [member=secret]",
    ] {
        let sealed = strip_member_annotation(leaky);
        assert!(
            !sealed.contains("[member="),
            "fail-open seal leaked marker from {leaky:?}: {sealed}"
        );
    }
}
