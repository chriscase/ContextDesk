//! Neutral fixture matrix for parser + framer reliability.
//!
//! Every case is independently authored synthetic data under
//! `fixtures/parser-framing-matrix/`. No private corpora, no product
//! identifiers, and no LLM/provider dependencies.
//!
//! Properties under test:
//! 1. Recognized timestamp prefixes separate into ts/level/message — never
//!    reappear as a leading structured prefix in `message`.
//! 2. Unrecognized / ambiguous inputs stay order-only (or unresolved-local)
//!    without fabricating wall-clock instants.
//! 3. Continuations (stacks, SQL, `COMMIT;`, arbitrary flush-left text) stay
//!    attached to the timestamped lead record.
//! 4. Rotated filenames and nested folders keep portable source identities.
//! 5. Folder and ZIP transports discover the same identities and select the
//!    same event-bearing members.
//! 6. Binary / XML / empty inputs are unsupported or non-event, not selected
//!    as useful structured logs.
//! 7. Corpus-level acceptance: no supported matrix event puts a recognized
//!    wall/local timestamp prefix into `message`.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use cd_core::log_analysis::frame::frame_text;
use cd_core::log_analysis::import_preview::{
    event_importable, preview_import_plan, ImportItemStatus, ImportPreviewReason,
};
use cd_core::log_analysis::ingest::ingest_path_with_policy_and_observer;
use cd_core::log_analysis::{
    parse_line_with_fingerprint, query_events, ActiveTimestampBasis, EventQuery, ExplorerEvent,
    LogCorpus, LogEmbedPolicy, LogFormat, TimestampProvenance,
};
use cd_core::process_progress::NoopProcessProgress;

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/parser-framing-matrix")
}

fn read_fixture(rel: &str) -> String {
    let path = fixtures_root().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("read fixture {}: {error}", path.display());
    })
}

fn read_fixture_bytes(rel: &str) -> Vec<u8> {
    let path = fixtures_root().join(rel);
    std::fs::read(&path).unwrap_or_else(|error| {
        panic!("read fixture bytes {}: {error}", path.display());
    })
}

/// A recognized calendar prefix that must never reappear at the start of
/// `message` when the grammar claimed a structured timestamp.
fn message_leaks_leading_calendar(message: &str) -> bool {
    let bytes = message.as_bytes();
    if bytes.len() < 19 {
        return false;
    }
    bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4] == b'-'
        && bytes[5].is_ascii_digit()
        && bytes[6].is_ascii_digit()
        && bytes[7] == b'-'
        && bytes[8].is_ascii_digit()
        && bytes[9].is_ascii_digit()
        && matches!(bytes[10], b' ' | b'T')
        && bytes[11].is_ascii_digit()
        && bytes[12].is_ascii_digit()
        && bytes[13] == b':'
        && bytes[14].is_ascii_digit()
        && bytes[15].is_ascii_digit()
        && bytes[16] == b':'
        && bytes[17].is_ascii_digit()
        && bytes[18].is_ascii_digit()
}

fn assert_no_timestamp_prefix_in_message(line: &str, parsed: &cd_core::log_analysis::ParsedLine) {
    match parsed.timestamp_provenance {
        TimestampProvenance::ExplicitWallClock | TimestampProvenance::UnresolvedLocal => {
            assert!(
                !message_leaks_leading_calendar(&parsed.message),
                "structured timestamp must leave message without a leading calendar; line={line:?} message={:?}",
                parsed.message
            );
            if let Some(local) = parsed.unresolved_local_timestamp.as_deref() {
                assert!(
                    !parsed.message.starts_with(local),
                    "unresolved local source must not reappear as message prefix; line={line:?}"
                );
            }
        }
        TimestampProvenance::OrderOnly | TimestampProvenance::LegacyUnknown => {
            // Fail-closed / plain: the whole line may be the message.
        }
    }
}

// ---------------------------------------------------------------------
// Per-grammar precise separation
// ---------------------------------------------------------------------

#[test]
fn datetime_matrix_separates_zones_offsets_and_offsetless_locals() {
    let text = read_fixture("events-datetime.log");
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    assert!(lines.len() >= 5, "datetime fixture must stay populated");

    // Wall UTC named zone
    let utc = parse_line_with_fingerprint(lines[0], None, 1);
    assert_eq!(utc.fingerprint.format_id, Some("datetime-message-record"));
    assert_eq!(
        utc.parsed.timestamp_provenance,
        TimestampProvenance::ExplicitWallClock
    );
    assert_eq!(
        utc.parsed.active_timestamp_basis,
        ActiveTimestampBasis::ExplicitWall
    );
    assert_eq!(utc.parsed.level, "info");
    assert_eq!(utc.parsed.message, "wall named utc zone");
    assert_eq!(utc.parsed.unresolved_local_timestamp, None);
    assert_eq!(utc.parsed.ts, Some(1_773_576_000));

    // Wall numeric +00:00
    let plus = parse_line_with_fingerprint(lines[1], None, 2);
    assert_eq!(
        plus.parsed.timestamp_provenance,
        TimestampProvenance::ExplicitWallClock
    );
    assert_eq!(plus.parsed.level, "warn");
    assert_eq!(plus.parsed.message, "wall numeric offset");
    assert_eq!(plus.parsed.ts, Some(1_773_576_001));

    // Wall numeric -05:00 (same UTC second as 12:00:02Z)
    let minus = parse_line_with_fingerprint(lines[2], None, 3);
    assert_eq!(
        minus.parsed.timestamp_provenance,
        TimestampProvenance::ExplicitWallClock
    );
    assert_eq!(minus.parsed.level, "error");
    assert_eq!(minus.parsed.message, "wall minus five");
    assert_eq!(minus.parsed.ts, Some(1_773_576_002));

    // Offsetless local with level
    let local = parse_line_with_fingerprint(lines[3], None, 4);
    assert_eq!(
        local.parsed.timestamp_provenance,
        TimestampProvenance::UnresolvedLocal
    );
    assert_eq!(
        local.parsed.active_timestamp_basis,
        ActiveTimestampBasis::OrderOnly
    );
    assert_eq!(
        local.parsed.unresolved_local_timestamp.as_deref(),
        Some("2026-03-15 12:00:03,000")
    );
    assert_eq!(local.parsed.level, "info");
    assert_eq!(local.parsed.message, "offsetless local with level");
    assert_eq!(local.parsed.ts, Some(4));

    // ISO T fractional local
    let iso = parse_line_with_fingerprint(lines[4], None, 5);
    assert_eq!(
        iso.parsed.timestamp_provenance,
        TimestampProvenance::UnresolvedLocal
    );
    assert_eq!(
        iso.parsed.unresolved_local_timestamp.as_deref(),
        Some("2026-03-15T12:00:04.500")
    );
    assert_eq!(iso.parsed.level, "debug");
    assert_eq!(iso.parsed.message, "command completed");

    // GMT named zone (wall)
    if let Some(gmt_line) = lines.get(5) {
        let gmt = parse_line_with_fingerprint(gmt_line, None, 6);
        assert_eq!(
            gmt.parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(gmt.parsed.message, "wall named gmt zone");
        assert_eq!(gmt.parsed.level, "info");
    }

    for (index, line) in lines.iter().enumerate() {
        let parsed = parse_line_with_fingerprint(line, None, index as u64);
        assert_no_timestamp_prefix_in_message(line, &parsed.parsed);
    }
}

#[test]
fn wildfly_matrix_wall_offsets_and_short_fractions_fail_closed() {
    let text = read_fixture("events-wildfly.log");
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(lines.len(), 5);

    let offsetless = parse_line_with_fingerprint(lines[0], None, 10);
    assert_eq!(
        offsetless.fingerprint.format_id,
        Some("date-level-logger-thread-record")
    );
    assert_eq!(
        offsetless.parsed.timestamp_provenance,
        TimestampProvenance::UnresolvedLocal
    );
    assert_eq!(
        offsetless.parsed.unresolved_local_timestamp.as_deref(),
        Some("2026-03-15 12:00:00,123")
    );
    assert_eq!(offsetless.parsed.level, "info");
    assert_eq!(
        offsetless.parsed.message,
        "[org.example.Boot] (main) wildfly offsetless local"
    );
    assert_no_timestamp_prefix_in_message(lines[0], &offsetless.parsed);

    let with_z = parse_line_with_fingerprint(lines[1], None, 11);
    assert_eq!(
        with_z.parsed.timestamp_provenance,
        TimestampProvenance::ExplicitWallClock
    );
    assert_eq!(with_z.parsed.ts, Some(1_773_576_001));
    assert_eq!(
        with_z.parsed.message,
        "[org.example.Boot] (main) wildfly with z"
    );
    assert_no_timestamp_prefix_in_message(lines[1], &with_z.parsed);

    let plus_zero = parse_line_with_fingerprint(lines[2], None, 12);
    assert_eq!(
        plus_zero.parsed.timestamp_provenance,
        TimestampProvenance::ExplicitWallClock
    );
    assert_eq!(plus_zero.parsed.ts, Some(1_773_576_002));
    assert_eq!(
        plus_zero.parsed.message,
        "[org.example.Boot] (main) wildfly plus zero"
    );

    // Short and overlong fractions: fail closed as whole-line plain.
    for (index, line) in lines.iter().enumerate().skip(3) {
        let parsed = parse_line_with_fingerprint(line, None, 100 + index as u64);
        assert_eq!(
            parsed.fingerprint.format_id,
            Some("plain-line"),
            "malformed wildfly fraction must fail closed: {line}"
        );
        assert_eq!(parsed.parsed.format, LogFormat::Plain);
        assert_eq!(
            parsed.parsed.timestamp_provenance,
            TimestampProvenance::OrderOnly
        );
        assert_eq!(parsed.parsed.unresolved_local_timestamp, None);
        assert_eq!(parsed.parsed.message, *line);
        assert_eq!(parsed.parsed.ts, Some(100 + index as i64));
    }
}

#[test]
fn jsonl_and_logfmt_matrix_wall_and_epoch() {
    let jsonl = read_fixture("events.jsonl");
    for (index, line) in jsonl.lines().filter(|l| !l.is_empty()).enumerate() {
        let parsed = parse_line_with_fingerprint(line, None, index as u64);
        assert_eq!(parsed.fingerprint.format_id, Some("json-object-line"));
        assert_eq!(
            parsed.parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(
            parsed.parsed.active_timestamp_basis,
            ActiveTimestampBasis::ExplicitWall
        );
        assert!(
            !message_leaks_leading_calendar(&parsed.parsed.message),
            "jsonl message must not carry calendar prefix: {}",
            parsed.parsed.message
        );
        match index {
            0 => {
                assert_eq!(parsed.parsed.message, "jsonl wall z");
                assert_eq!(parsed.parsed.level, "info");
                assert_eq!(parsed.parsed.ts, Some(1_773_576_000));
            }
            1 => {
                assert_eq!(parsed.parsed.message, "jsonl numeric offset");
                assert_eq!(parsed.parsed.level, "warn");
                assert_eq!(parsed.parsed.ts, Some(1_773_576_000));
            }
            2 => {
                assert_eq!(parsed.parsed.message, "jsonl epoch seconds");
                assert_eq!(parsed.parsed.level, "error");
                assert_eq!(parsed.parsed.ts, Some(1_710_504_000));
            }
            _ => panic!("unexpected jsonl line index {index}"),
        }
    }

    let logfmt = read_fixture("events.logfmt");
    for (index, line) in logfmt.lines().filter(|l| !l.is_empty()).enumerate() {
        let parsed = parse_line_with_fingerprint(line, None, 50 + index as u64);
        assert_eq!(parsed.fingerprint.format_id, Some("logfmt-record"));
        assert_eq!(
            parsed.parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        match index {
            0 => {
                assert_eq!(parsed.parsed.message, "logfmt wall z");
                assert_eq!(parsed.parsed.ts, Some(1_773_576_000));
            }
            1 => {
                assert_eq!(parsed.parsed.message, "logfmt offset");
                assert_eq!(parsed.parsed.ts, Some(1_773_576_000));
            }
            2 => {
                assert_eq!(parsed.parsed.message, "logfmt epoch");
                assert_eq!(parsed.parsed.ts, Some(1_710_504_000));
            }
            _ => panic!("unexpected logfmt line index {index}"),
        }
        assert_no_timestamp_prefix_in_message(line, &parsed.parsed);
    }
}

// ---------------------------------------------------------------------
// Framing: stacks, SQL, COMMIT, arbitrary continuations
// ---------------------------------------------------------------------

#[test]
fn continuations_frame_as_three_timestamped_records() {
    let text = read_fixture("events-continuations.log");
    let records = frame_text(&text);
    assert_eq!(
        records.len(),
        3,
        "stack + sql/commit block + next event must be three logical records; got:\n{}",
        records
            .iter()
            .enumerate()
            .map(|(i, r)| format!("--- record {i} ---\n{r}"))
            .collect::<Vec<_>>()
            .join("\n")
    );

    assert!(
        records[0].contains("operation failed"),
        "lead error must open the first record"
    );
    assert!(
        records[0].contains("java.lang.RuntimeException: boom"),
        "stack must stay with the error lead"
    );
    assert!(
        records[0].contains("at org.example.Worker.run"),
        "stack frames must not split into standalone events"
    );
    assert!(
        records[0].contains("Caused by: java.sql.SQLException"),
        "caused-by chain must stay attached"
    );
    assert!(
        !records[0].contains("12:10:01"),
        "first record must not swallow the next timestamped lead"
    );

    assert!(records[1].contains("sending statement: SELECT id FROM items"));
    assert!(
        records[1].contains("WHERE active = 1"),
        "SQL WHERE must continue the timestamped SQL lead"
    );
    assert!(
        records[1].contains("ORDER BY id"),
        "SQL ORDER BY must continue the timestamped SQL lead"
    );
    assert!(
        records[1].contains("COMMIT;"),
        "COMMIT terminator must not become a standalone event"
    );
    assert!(
        records[1].contains("arbitrary producer note after terminator"),
        "arbitrary flush-left text after SQL must stay on the open record"
    );
    assert!(
        !records[1].contains("12:10:02"),
        "second record must stop at the next timestamp"
    );

    assert!(records[2].contains("next event after continuations"));
    assert!(
        !records[2].contains("COMMIT;"),
        "final event must not inherit prior continuations"
    );

    // Parse each framed record: only the first physical line is the parse unit
    // for structured fields; the joined text is the durable raw/message body
    // after framing. Assert the lead lines separate cleanly.
    let lead_lines = [
        "2026-03-15 12:10:00,000 ERROR [org.example.Worker] (thread-1) operation failed",
        "2026-03-15 12:10:01,000 INFO [org.example.Sql] (thread-1) sending statement: SELECT id FROM items",
        "2026-03-15 12:10:02,000 INFO [org.example.Sql] (thread-1) next event after continuations",
    ];
    for (index, lead) in lead_lines.iter().enumerate() {
        let parsed = parse_line_with_fingerprint(lead, None, index as u64);
        assert_eq!(
            parsed.fingerprint.format_id,
            Some("date-level-logger-thread-record")
        );
        assert_no_timestamp_prefix_in_message(lead, &parsed.parsed);
        assert!(
            !parsed.parsed.message.contains("2026-03-15"),
            "wildfly lead message must not retain the calendar: {}",
            parsed.parsed.message
        );
    }
}

// ---------------------------------------------------------------------
// Ambiguous / residual inputs
// ---------------------------------------------------------------------

#[test]
fn ambiguous_and_residual_inputs_stay_honest() {
    let text = read_fixture("ambiguous.log");
    for (index, line) in text.lines().filter(|l| !l.is_empty()).enumerate() {
        let parsed = parse_line_with_fingerprint(line, None, 200 + index as u64);
        // Never invent a wall-clock instant for residual/ambiguous shapes.
        assert_ne!(
            parsed.parsed.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock,
            "ambiguous residual must not fabricate wall clock: {line}"
        );
        assert_eq!(
            parsed.parsed.active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly,
            "ambiguous residual must remain order-only active basis: {line}"
        );

        if line.contains("America/Chicago") {
            // IANA named zones are residual: calendar may be retained as
            // unresolved-local evidence, but the zone name is not interpreted
            // as an offset and the active basis stays order-only.
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::UnresolvedLocal
            );
            assert_eq!(
                parsed.parsed.unresolved_local_timestamp.as_deref(),
                Some("2026-03-15 12:00:00,123")
            );
            assert!(
                parsed.parsed.message.contains("America/Chicago"),
                "unrecognized IANA zone remains visible in the payload rather than silently discarded"
            );
            assert_no_timestamp_prefix_in_message(line, &parsed.parsed);
        } else {
            // Pure prose / incomplete calendar / mid-line ISO stay whole-line.
            assert_eq!(parsed.parsed.message, line);
            assert_eq!(parsed.parsed.unresolved_local_timestamp, None);
            assert_eq!(
                parsed.parsed.timestamp_provenance,
                TimestampProvenance::OrderOnly
            );
        }
    }
}

// ---------------------------------------------------------------------
// Corpus-level acceptance: supported matrix must not put ts into message
// ---------------------------------------------------------------------

#[test]
fn supported_matrix_corpus_never_puts_timestamp_prefix_in_message() {
    let supported = [
        "events-datetime.log",
        "events-wildfly.log",
        "events.jsonl",
        "events.logfmt",
        "events-continuations.log",
        "rotated/app/XYZ_Server.log",
        "rotated/app/XYZ_Server.log.1",
        "rotated/app/XYZ_Server-2026-03-14_120000.log",
        "rotated/nested/deep/service.log",
    ];

    let mut checked = 0u64;
    for rel in supported {
        let text = read_fixture(rel);
        // Frame first so multi-line records are one unit, then parse each
        // physical lead line of the supported shapes (single-line fixtures
        // dominate; continuations lead lines are still checked via split).
        for (index, physical) in text.lines().enumerate() {
            if physical.is_empty() {
                continue;
            }
            // Only assert the no-leak property when the line itself is a
            // recognized structured start (not a stack/SQL continuation).
            let parsed = parse_line_with_fingerprint(physical, None, index as u64);
            match parsed.parsed.timestamp_provenance {
                TimestampProvenance::ExplicitWallClock | TimestampProvenance::UnresolvedLocal => {
                    assert_no_timestamp_prefix_in_message(physical, &parsed.parsed);
                    checked += 1;
                }
                TimestampProvenance::OrderOnly | TimestampProvenance::LegacyUnknown => {
                    // Continuations and fail-closed short fractions stay whole.
                }
            }
        }
    }
    assert!(
        checked >= 15,
        "corpus acceptance must exercise a broad supported set; checked={checked}"
    );
}

// ---------------------------------------------------------------------
// Rotated filenames + nested folders: identity preservation
// ---------------------------------------------------------------------

#[test]
fn rotated_and_nested_identities_are_preserved_on_preview() {
    let plan = preview_import_plan(&fixtures_root().join("rotated"), None)
        .expect("preview rotated tree");
    let identities: BTreeSet<String> = plan
        .report
        .items
        .iter()
        .map(|item| item.identity.clone())
        .collect();

    let expected = [
        "app/XYZ_Server.log",
        "app/XYZ_Server.log.1",
        "app/XYZ_Server-2026-03-14_120000.log",
        "nested/deep/service.log",
    ];
    for identity in expected {
        assert!(
            identities.contains(identity),
            "missing rotated/nested identity {identity}; have {identities:?}"
        );
    }

    for item in &plan.report.items {
        assert!(
            event_importable(item),
            "rotated synthetic logs must be event-importable: {} status={:?}",
            item.identity,
            item.status
        );
        assert!(
            matches!(
                item.status,
                ImportItemStatus::Ready | ImportItemStatus::Review | ImportItemStatus::RawFallback
            ),
            "rotated log must not be unsupported/ignored: {} {:?}",
            item.identity,
            item.status
        );
    }
}

#[test]
fn rotated_folder_ingest_preserves_source_identities_and_messages() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).expect("cache");
    let report = ingest_path_with_policy_and_observer(
        &cache,
        &fixtures_root().join("rotated"),
        "rotated-matrix",
        &LogEmbedPolicy::default(),
        None,
        &NoopProcessProgress,
        None,
    )
    .expect("ingest rotated tree");

    assert!(report.stats.lines >= 4, "four rotated members must ingest");
    let corpus = LogCorpus::open(&cache, &report.corpus_id).expect("open rotated corpus");
    let page = query_events(
        &corpus,
        &EventQuery {
            limit: 50,
            ..EventQuery::default()
        },
    )
    .expect("query events");

    let sources: BTreeSet<String> = page
        .events
        .iter()
        .map(|event| event.source.clone())
        .collect();
    for identity in [
        "app/XYZ_Server.log",
        "app/XYZ_Server.log.1",
        "app/XYZ_Server-2026-03-14_120000.log",
        "nested/deep/service.log",
    ] {
        assert!(
            sources.contains(identity),
            "ingest must preserve portable source identity {identity}; have {sources:?}"
        );
    }

    for event in &page.events {
        assert!(
            !message_leaks_leading_calendar(&event.message),
            "ingested rotated event must not put calendar into message: source={} message={}",
            event.source,
            event.message
        );
    }
}

// ---------------------------------------------------------------------
// Binary / XML / empty: unsupported or non-event
// ---------------------------------------------------------------------

#[test]
fn binary_xml_empty_are_not_selected_as_useful_logs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("mixed");
    std::fs::create_dir_all(&root).expect("mkdir");
    std::fs::write(root.join("empty.log"), read_fixture_bytes("empty.log")).unwrap();
    std::fs::write(root.join("binary.bin"), read_fixture_bytes("binary.bin")).unwrap();
    std::fs::write(root.join("config.xml"), read_fixture_bytes("config.xml")).unwrap();
    // Control: a real synthetic log must remain selectable.
    std::fs::write(
        root.join("control.log"),
        read_fixture_bytes("events-datetime.log"),
    )
    .unwrap();

    let plan = preview_import_plan(&root, None).expect("preview mixed");
    let by_id: std::collections::BTreeMap<_, _> = plan
        .report
        .items
        .iter()
        .map(|item| (item.identity.as_str(), item))
        .collect();

    let empty = by_id.get("empty.log").expect("empty.log discovered");
    assert_eq!(empty.status, ImportItemStatus::Unsupported);
    assert!(empty.reasons.contains(&ImportPreviewReason::EmptyContent));
    assert!(!event_importable(empty) || empty.status == ImportItemStatus::Unsupported);
    // Unsupported is still "selectable" in the ACL sense only when not Blocked;
    // event_importable requires role==Log. Empty is not a useful log role.
    assert!(
        !event_importable(empty),
        "empty must not be event-importable"
    );

    let binary = by_id.get("binary.bin").expect("binary.bin discovered");
    assert_eq!(binary.status, ImportItemStatus::Unsupported);
    assert!(binary.reasons.contains(&ImportPreviewReason::BinaryContent));
    assert!(!event_importable(binary));

    let xml = by_id.get("config.xml").expect("config.xml discovered");
    assert!(
        matches!(
            xml.status,
            ImportItemStatus::Supporting | ImportItemStatus::Unsupported
        ),
        "xml must not present as ready structured log: {:?}",
        xml.status
    );
    assert!(
        xml.reasons
            .contains(&ImportPreviewReason::XmlEventParsingUnsupported)
            || xml.status == ImportItemStatus::Unsupported,
        "xml reasons: {:?}",
        xml.reasons
    );
    assert!(!event_importable(xml));

    let control = by_id.get("control.log").expect("control.log discovered");
    assert!(
        event_importable(control),
        "control synthetic log must remain event-importable: {:?}",
        control.status
    );
}

// ---------------------------------------------------------------------
// Folder vs ZIP parity for this matrix
// ---------------------------------------------------------------------

fn matrix_members() -> Vec<(String, Vec<u8>)> {
    let mut members = Vec::new();
    for rel in [
        "events-datetime.log",
        "events-wildfly.log",
        "events.jsonl",
        "events.logfmt",
        "events-continuations.log",
        "ambiguous.log",
        "empty.log",
        "binary.bin",
        "config.xml",
        "rotated/app/XYZ_Server.log",
        "rotated/app/XYZ_Server.log.1",
        "rotated/app/XYZ_Server-2026-03-14_120000.log",
        "rotated/nested/deep/service.log",
    ] {
        members.push((rel.to_string(), read_fixture_bytes(rel)));
    }
    members
}

fn write_matrix_folder(root: &Path) -> PathBuf {
    let folder = root.join("matrix_folder");
    for (name, bytes) in matrix_members() {
        let path = folder.join(&name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir parent");
        }
        std::fs::write(path, bytes).expect("write member");
    }
    folder
}

fn write_matrix_zip(root: &Path) -> PathBuf {
    let path = root.join("matrix.zip");
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in matrix_members() {
        zip.start_file(name, options).expect("start member");
        zip.write_all(&bytes).expect("write member");
    }
    zip.finish().expect("finish zip");
    path
}

#[derive(Debug, PartialEq, Eq)]
struct PreviewParity {
    discovered: Vec<String>,
    event_importable: Vec<String>,
    statuses: Vec<(String, String)>,
}

fn preview_parity(path: &Path) -> PreviewParity {
    let plan = preview_import_plan(path, None).expect("preview");
    let mut discovered: Vec<String> = plan
        .report
        .items
        .iter()
        .map(|item| item.identity.clone())
        .collect();
    let mut event_importable_ids: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item))
        .map(|item| item.identity.clone())
        .collect();
    let mut statuses: Vec<(String, String)> = plan
        .report
        .items
        .iter()
        .map(|item| (item.identity.clone(), format!("{:?}", item.status)))
        .collect();
    discovered.sort();
    event_importable_ids.sort();
    statuses.sort();
    PreviewParity {
        discovered,
        event_importable: event_importable_ids,
        statuses,
    }
}

#[test]
fn folder_and_zip_preview_parity_for_parser_framing_matrix() {
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = write_matrix_folder(dir.path());
    let zip = write_matrix_zip(dir.path());

    let folder_facts = preview_parity(&folder);
    let zip_facts = preview_parity(&zip);

    assert_eq!(
        folder_facts.discovered, zip_facts.discovered,
        "folder/ZIP discovered identities must match"
    );
    assert_eq!(
        folder_facts.event_importable, zip_facts.event_importable,
        "folder/ZIP event-importable set must match"
    );
    assert_eq!(
        folder_facts.statuses, zip_facts.statuses,
        "folder/ZIP per-identity status must match"
    );

    // Rotated paths must appear with the same portable identity in both.
    for identity in [
        "rotated/app/XYZ_Server.log",
        "rotated/app/XYZ_Server.log.1",
        "rotated/app/XYZ_Server-2026-03-14_120000.log",
        "rotated/nested/deep/service.log",
    ] {
        assert!(
            folder_facts.discovered.iter().any(|id| id == identity),
            "missing identity {identity}"
        );
        assert!(
            folder_facts
                .event_importable
                .iter()
                .any(|id| id == identity),
            "rotated log must be event-importable: {identity}"
        );
    }

    // Non-logs must not be event-importable in either transport.
    for identity in ["empty.log", "binary.bin", "config.xml"] {
        assert!(
            !folder_facts
                .event_importable
                .iter()
                .any(|id| id == identity),
            "{identity} must not be event-importable"
        );
    }
}

#[test]
fn folder_and_zip_ingest_parity_for_structured_matrix_subset() {
    // Ingest only the structured event-bearing members so the comparison is
    // about parse/frame outcomes, not selection edge cases for binary/xml.
    let structured: Vec<(String, Vec<u8>)> = [
        "events-datetime.log",
        "events-wildfly.log",
        "events.jsonl",
        "events.logfmt",
        "events-continuations.log",
    ]
    .into_iter()
    .map(|rel| (rel.to_string(), read_fixture_bytes(rel)))
    .collect();

    let dir = tempfile::tempdir().expect("tempdir");
    let folder = dir.path().join("struct_folder");
    std::fs::create_dir_all(&folder).unwrap();
    for (name, bytes) in &structured {
        std::fs::write(folder.join(name), bytes).unwrap();
    }
    let zip_path = dir.path().join("struct.zip");
    {
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in &structured {
            zip.start_file(name.as_str(), options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    let cache_folder = dir.path().join("cache_folder");
    let cache_zip = dir.path().join("cache_zip");
    std::fs::create_dir_all(&cache_folder).unwrap();
    std::fs::create_dir_all(&cache_zip).unwrap();

    let folder_report = ingest_path_with_policy_and_observer(
        &cache_folder,
        &folder,
        "struct-folder",
        &LogEmbedPolicy::default(),
        None,
        &NoopProcessProgress,
        None,
    )
    .expect("folder ingest");
    let zip_report = ingest_path_with_policy_and_observer(
        &cache_zip,
        &zip_path,
        "struct-zip",
        &LogEmbedPolicy::default(),
        None,
        &NoopProcessProgress,
        None,
    )
    .expect("zip ingest");

    assert_eq!(folder_report.stats.lines, zip_report.stats.lines);

    let folder_corpus =
        LogCorpus::open(&cache_folder, &folder_report.corpus_id).expect("open folder corpus");
    let zip_corpus = LogCorpus::open(&cache_zip, &zip_report.corpus_id).expect("open zip corpus");
    let folder_events = query_events(
        &folder_corpus,
        &EventQuery {
            limit: 500,
            ..EventQuery::default()
        },
    )
    .expect("folder query");
    let zip_events = query_events(
        &zip_corpus,
        &EventQuery {
            limit: 500,
            ..EventQuery::default()
        },
    )
    .expect("zip query");

    assert_eq!(folder_events.events.len(), zip_events.events.len());

    // Compare portable fields independent of ingest sequence ids.
    let normalize = |events: &[ExplorerEvent]| {
        let mut rows: Vec<(String, String, String, String)> = events
            .iter()
            .map(|event| {
                (
                    event.source.clone(),
                    event.level.clone(),
                    event.message.clone(),
                    format!("{:?}", event.timestamp_provenance),
                )
            })
            .collect();
        rows.sort();
        rows
    };
    assert_eq!(
        normalize(&folder_events.events),
        normalize(&zip_events.events),
        "folder/ZIP ingested events must match on source/level/message/provenance"
    );

    for event in &folder_events.events {
        if matches!(
            event.timestamp_provenance,
            TimestampProvenance::ExplicitWallClock | TimestampProvenance::UnresolvedLocal
        ) {
            assert!(
                !message_leaks_leading_calendar(&event.message),
                "ingested event message must not start with a calendar: {}",
                event.message
            );
        }
    }
}
