//! Frozen fixture + compatibility suite for
//! `contextdesk.normalized_log_events.v1`.
//!
//! Every file under `fixtures/normalized-log-events/valid/` must validate
//! cleanly and every file under `invalid/` must be rejected — with the file
//! set discovered from disk rather than listed here, so a fixture cannot be
//! added without being exercised or deleted without failing.
//!
//! These fixtures are the language-neutral conformance corpus (#826: "Rust,
//! TypeScript/Node, and Python examples exercise the same versioned capability
//! contract"). The Node and Python producer examples under
//! `examples/normalized-log-producers/` validate the exact same bytes, so a
//! future SDK extraction inherits a shared test corpus instead of three
//! independent interpretations of the spec.

use std::collections::BTreeSet;
use std::path::PathBuf;

use cd_core::normalized_log_events::{
    validate_file, NormalizedLogDiagnosticCode, NORMALIZED_LOG_EVENTS_READER_VERSION,
    NORMALIZED_LOG_EVENTS_SCHEMA_ID,
};

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/normalized-log-events")
}

fn read_dir_sorted(sub: &str) -> Vec<(String, String)> {
    let dir = fixtures_root().join(sub);
    let mut out: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let body = std::fs::read_to_string(entry.path()).expect("read fixture");
            (name, body)
        })
        .collect();
    out.sort();
    out
}

#[test]
fn every_valid_fixture_validates_cleanly() {
    let fixtures = read_dir_sorted("valid");
    assert!(!fixtures.is_empty(), "valid fixture set must not be empty");
    for (name, body) in &fixtures {
        let report = validate_file(body);
        assert!(
            report.ok,
            "valid/{name} must validate; diagnostics: {:?}",
            report.diagnostics
        );
        assert!(
            report.events_validated >= 1,
            "valid/{name} should contain at least one event"
        );
        assert!(
            report.error_samples.is_empty(),
            "a clean file must produce no error samples"
        );
    }
}

#[test]
fn every_invalid_fixture_is_rejected() {
    let fixtures = read_dir_sorted("invalid");
    assert!(
        !fixtures.is_empty(),
        "invalid fixture set must not be empty"
    );
    for (name, body) in &fixtures {
        let report = validate_file(body);
        assert!(
            !report.ok,
            "invalid/{name} must be rejected but validated cleanly"
        );
        assert!(
            !report.diagnostics.is_empty(),
            "invalid/{name} must say why it was rejected"
        );
    }
}

/// Each invalid fixture isolates one rule; pin the code so a fixture cannot
/// start failing for an unrelated reason and still look "covered".
#[test]
fn invalid_fixtures_fail_for_the_reason_they_are_named_for() {
    let expected: &[(&str, NormalizedLogDiagnosticCode)] = &[
        (
            "guessed-instant-unresolved.jsonl",
            NormalizedLogDiagnosticCode::InstantNotPermitted,
        ),
        (
            "guessed-instant-order-only.jsonl",
            NormalizedLogDiagnosticCode::InstantNotPermitted,
        ),
        (
            "instant-without-offset.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "instant-negative-zero-offset.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "producer-resolved-without-timezone.jsonl",
            NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
        ),
        (
            "producer-resolved-without-local-text.jsonl",
            NormalizedLogDiagnosticCode::LocalTextRequired,
        ),
        (
            "source-explicit-claiming-timezone.jsonl",
            NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
        ),
        (
            "wall-basis-without-instant.jsonl",
            NormalizedLogDiagnosticCode::TimeBasisInconsistent,
        ),
        (
            "order-basis-with-instant.jsonl",
            NormalizedLogDiagnosticCode::TimeBasisInconsistent,
        ),
        (
            "sequence-gap.jsonl",
            NormalizedLogDiagnosticCode::SequenceNotContiguous,
        ),
        (
            "sequence-restart.jsonl",
            NormalizedLogDiagnosticCode::SequenceNotContiguous,
        ),
        (
            "severity-number-out-of-range.jsonl",
            NormalizedLogDiagnosticCode::SeverityNumberOutOfRange,
        ),
        (
            "span-id-in-trace-slot.jsonl",
            NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
        ),
        (
            "zero-trace-id.jsonl",
            NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
        ),
        (
            "duplicate-correlation-class.jsonl",
            NormalizedLogDiagnosticCode::DuplicateCorrelationClass,
        ),
        (
            "empty-canonical.jsonl",
            NormalizedLogDiagnosticCode::CanonicalInvalid,
        ),
        (
            "wrong-schema-id.jsonl",
            NormalizedLogDiagnosticCode::SchemaIdInvalid,
        ),
        (
            "reader-too-old.jsonl",
            NormalizedLogDiagnosticCode::ReaderTooOld,
        ),
        (
            "forbidden-sentinel.jsonl",
            NormalizedLogDiagnosticCode::ForbiddenSentinel,
        ),
        (
            "malformed-event-line.jsonl",
            NormalizedLogDiagnosticCode::EventMalformed,
        ),
        (
            "missing-header.jsonl",
            NormalizedLogDiagnosticCode::MissingHeader,
        ),
        (
            "reserved-key-ts.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "reserved-key-timestamp.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "reserved-key-at-timestamp.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "instant-offset-hours-out-of-range.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "instant-offset-minutes-out-of-range.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "producer-resolved-fake-timezone.jsonl",
            NormalizedLogDiagnosticCode::ResolvedTimezoneInvalid,
        ),
        (
            "severity-inferred-claims-high-confidence.jsonl",
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
        ),
        (
            "severity-declared-claims-low-confidence.jsonl",
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
        ),
        (
            "severity-absent-carrying-raw.jsonl",
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
        ),
        (
            "severity-schema-mapped-claims-low.jsonl",
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
        ),
        (
            "trace-id-holding-span-value.jsonl",
            NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
        ),
        (
            "span-id-holding-trace-value.jsonl",
            NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
        ),
        (
            "trace-id-uppercase.jsonl",
            NormalizedLogDiagnosticCode::TraceIdentifierMalformed,
        ),
        (
            "attribute-nesting-too-deep.jsonl",
            NormalizedLogDiagnosticCode::DepthExceeded,
        ),
        (
            "canary-forbidden-sentinel-in-canonical.jsonl",
            NormalizedLogDiagnosticCode::ForbiddenSentinel,
        ),
        (
            "reserved-key-at-t.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "reserved-key-event-time.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "nested-timestamp-alias.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "duplicate-json-key.jsonl",
            NormalizedLogDiagnosticCode::EventMalformed,
        ),
        (
            "instant-invalid-calendar.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "observed-invalid-calendar.jsonl",
            NormalizedLogDiagnosticCode::InstantMalformed,
        ),
        (
            "header-reserved-timestamp-alias.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "header-duplicate-json-key.jsonl",
            NormalizedLogDiagnosticCode::HeaderMalformed,
        ),
        (
            "deep-nested-timestamp-alias.jsonl",
            NormalizedLogDiagnosticCode::ReservedKeyPresent,
        ),
        (
            "duplicate-json-key-escaped.jsonl",
            NormalizedLogDiagnosticCode::EventMalformed,
        ),
        (
            "absent-severity-canonical.jsonl",
            NormalizedLogDiagnosticCode::SeverityProvenanceInconsistent,
        ),
        (
            "producer-resolved-empty-local-text.jsonl",
            NormalizedLogDiagnosticCode::LocalTextRequired,
        ),
        (
            "attributes-not-object.jsonl",
            NormalizedLogDiagnosticCode::EventMalformed,
        ),
        (
            "canonical-truncated-wrong-type.jsonl",
            NormalizedLogDiagnosticCode::EventMalformed,
        ),
    ];

    let on_disk: BTreeSet<String> = read_dir_sorted("invalid")
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let pinned: BTreeSet<String> = expected
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();
    assert_eq!(
        on_disk, pinned,
        "every invalid fixture must pin the code it is named for"
    );

    for (name, code) in expected {
        let body = std::fs::read_to_string(fixtures_root().join("invalid").join(name))
            .expect("read fixture");
        let report = validate_file(&body);
        let found: Vec<_> = report.diagnostics.iter().map(|d| d.code).collect();
        assert!(
            found.contains(code),
            "invalid/{name} should report {code:?} but reported {found:?}"
        );
    }
}

/// The guessed-instant guard, stated once over the whole corpus.
#[test]
fn no_valid_fixture_carries_an_instant_without_provenance() {
    for (name, body) in read_dir_sorted("valid") {
        for (index, line) in body.lines().enumerate().skip(1) {
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("valid/{name} line {}: {error}", index + 1));
            let Some(time) = value.get("time") else {
                continue;
            };
            let resolution = time
                .get("resolution")
                .and_then(|r| r.as_str())
                .unwrap_or("");
            let has_instant = time.get("instant").is_some();
            match resolution {
                "source_explicit" => assert!(has_instant),
                "producer_resolved" => {
                    assert!(has_instant);
                    assert!(
                        time.get("resolvedTimezone").is_some() && time.get("localText").is_some(),
                        "valid/{name}: a producer-resolved instant must carry its provenance"
                    );
                }
                "unresolved" | "order_only" => assert!(
                    !has_instant,
                    "valid/{name}: {resolution} must never carry an instant"
                ),
                other => panic!("valid/{name}: unknown resolution {other}"),
            }
        }
    }
}

/// Compatibility matrix, exercised rather than only documented.
#[test]
fn compatibility_matrix_holds() {
    let base = std::fs::read_to_string(fixtures_root().join("valid/minimal.jsonl")).expect("read");

    // 1. Same major, same reader version -> accepted.
    assert!(validate_file(&base).ok);

    // 2. An unknown ADDITIVE field on a known line is tolerated: serde ignores
    //    it, matching the bundle rule that additive optional fields are
    //    allowed and unknown ones ignored.
    let additive = base.replace(
        "\"sourceSeq\":0",
        "\"sourceSeq\":0,\"futureOptionalField\":{\"anything\":true}",
    );
    assert_ne!(additive, base, "the additive mutation must actually apply");
    assert!(
        validate_file(&additive).ok,
        "an unknown additive field must not break a v1 reader"
    );

    // 3. A higher minReaderVersion -> refused whole, never partly understood.
    let newer = base.replace(
        "\"minReaderVersion\":1",
        &format!(
            "\"minReaderVersion\":{}",
            NORMALIZED_LOG_EVENTS_READER_VERSION + 1
        ),
    );
    let report = validate_file(&newer);
    assert!(!report.ok);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == NormalizedLogDiagnosticCode::ReaderTooOld));

    // 4. A different major schema id -> refused, not best-effort parsed.
    let other_major = base.replace(
        NORMALIZED_LOG_EVENTS_SCHEMA_ID,
        "contextdesk.normalized_log_events.v2",
    );
    let report = validate_file(&other_major);
    assert!(!report.ok);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == NormalizedLogDiagnosticCode::SchemaIdInvalid));
}

#[test]
fn fixtures_are_byte_stable_and_newline_terminated() {
    for sub in ["valid", "invalid"] {
        for (name, body) in read_dir_sorted(sub) {
            if body.is_empty() {
                continue; // missing-header.jsonl is deliberately empty
            }
            assert!(
                body.ends_with('\n'),
                "{sub}/{name} must end with a newline so appends stay line-aligned"
            );
            assert!(
                !body.contains("\r\n"),
                "{sub}/{name} must use LF endings for byte stability"
            );
        }
    }
}

#[test]
fn no_fixture_contains_a_real_looking_secret_or_host_path() {
    for sub in ["valid", "invalid"] {
        for (name, body) in read_dir_sorted(sub) {
            for needle in ["/Users/", "AKIA", "ghp_", "-----BEGIN"] {
                assert!(
                    !body.contains(needle),
                    "{sub}/{name} must stay synthetic and shareable ({needle})"
                );
            }
        }
    }
}

#[test]
fn every_fixture_is_already_in_canonical_form() {
    // The corpus is the shared cross-language reference, so it should BE the
    // canonical bytes rather than merely canonicalize to them. Otherwise a
    // byte-comparison across languages is comparing formatting accidents.
    use cd_core::normalized_log_events::canonicalize_stream;
    for sub in ["valid", "invalid"] {
        for (name, body) in read_dir_sorted(sub) {
            if body.trim().is_empty() {
                continue;
            }
            let mut out = Vec::new();
            if canonicalize_stream(std::io::Cursor::new(body.as_bytes()), &mut out).is_err() {
                // invalid/ deliberately contains non-JSON lines.
                continue;
            }
            assert_eq!(
                String::from_utf8(out).expect("utf8"),
                body,
                "{sub}/{name} is not already canonical"
            );
        }
    }
}
