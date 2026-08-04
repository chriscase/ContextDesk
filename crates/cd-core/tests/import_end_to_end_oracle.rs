//! Neutral end-to-end acceptance oracle for reviewed folder and ZIP imports.
//!
//! This exercises the same preview, verified-selection ingest, durable event,
//! and source-catalog path used by the desktop host. Fixtures are synthetic
//! and producer-neutral.

use std::io::Write;
use std::path::Path;

use cd_core::log_analysis::import_preview::{
    preview_import_plan, verify_import_plan, ImportItemRole, ImportItemStatus, ImportPreviewReason,
    ImportPreviewReport,
};
use cd_core::log_analysis::ingest::ingest_path_with_policy_selection_and_observer;
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::{
    query_source_catalog, ActiveTimestampBasis, LogEmbedPolicy, LogSourceCatalogQuery,
    TimestampProvenance,
};
use cd_core::process_progress::NoopProcessProgress;

const CURRENT: &str = "service.log";
const NUMERIC_ROTATION: &str = "service.log.1";
const TIMESTAMP_ROTATION: &str = "service-20260729-120000.log";
const NESTED_A: &str = "nested/node-a/service.log";
const NESTED_B: &str = "nested/node-b/service.log";
const MALFORMED: &str = "malformed.log";
const XML: &str = "diagnostic-report.xml";
const HTML: &str = "status-page.html";
const PROSE: &str = "operator-notes.txt";

const CURRENT_BODY: &[u8] = b"\
2026-07-29 09:14:05,125 DEBUG sending: SELECT record_id\n\
FROM event_records\n\
WHERE active = true\n\
2026-07-29 09:14:06,250 INFO statement completed\n";
const NUMERIC_BODY: &[u8] = b"2026-07-28 09:14:05,123 INFO previous numeric rotation\n";
const TIMESTAMP_BODY: &[u8] = b"2026-07-29 12:00:00,000 WARN timestamp rotation retained\n";
const NESTED_A_BODY: &[u8] = b"2026-07-29 10:00:00,000 INFO nested source alpha\n";
const NESTED_B_BODY: &[u8] = b"2026-07-29 10:00:01,000 INFO nested source beta\n";
const MALFORMED_LINE: &str =
    "2026-07-29 09:14:05,12 INFO [component.worker] (main) malformed fraction";
const XML_BODY: &[u8] = b"<?xml version=\"1.0\"?><report><entry>summary</entry></report>\n";
const HTML_BODY: &[u8] = b"<!doctype html><html><body><p>summary</p></body></html>\n";
const PROSE_BODY: &[u8] = b"Operator guidance and explanatory prose only.\n";

fn members() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (CURRENT, CURRENT_BODY.to_vec()),
        (NUMERIC_ROTATION, NUMERIC_BODY.to_vec()),
        (TIMESTAMP_ROTATION, TIMESTAMP_BODY.to_vec()),
        (NESTED_A, NESTED_A_BODY.to_vec()),
        (NESTED_B, NESTED_B_BODY.to_vec()),
        (MALFORMED, format!("{MALFORMED_LINE}\n").into_bytes()),
        (XML, XML_BODY.to_vec()),
        (HTML, HTML_BODY.to_vec()),
        (PROSE, PROSE_BODY.to_vec()),
    ]
}

fn write_folder(root: &Path, entries: &[(&str, Vec<u8>)]) {
    for (identity, body) in entries {
        let path = root.join(identity);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(path, body).expect("write fixture source");
    }
}

fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
    let file = std::fs::File::create(path).expect("create fixture archive");
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (identity, body) in entries {
        writer.start_file(*identity, options).expect("start member");
        writer.write_all(body).expect("write member");
    }
    writer.finish().expect("finish fixture archive");
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewItemFact {
    identity: String,
    bytes: u64,
    status: ImportItemStatus,
    role: ImportItemRole,
    selected: bool,
    format_id: Option<String>,
    group_id: Option<String>,
    reasons: Vec<ImportPreviewReason>,
}

fn preview_facts(report: &ImportPreviewReport) -> Vec<PreviewItemFact> {
    report
        .items
        .iter()
        .map(|item| PreviewItemFact {
            identity: item.identity.clone(),
            bytes: item.bytes,
            status: item.status,
            role: item.role,
            selected: item.selected,
            format_id: item.format_id.clone(),
            group_id: item.group_id.clone(),
            reasons: item.reasons.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EventFact {
    source: String,
    message: String,
    level: String,
    timestamp_provenance: TimestampProvenance,
    active_timestamp_basis: ActiveTimestampBasis,
    unresolved_local_timestamp: Option<String>,
}

#[derive(Debug)]
struct ImportFacts {
    events: Vec<EventFact>,
    catalog: Vec<(String, u64)>,
}

fn reviewed_import(cache: &Path, source: &Path, name: &str) -> ImportFacts {
    let plan = preview_import_plan(source, None).expect("preview import plan");
    let selected = plan
        .report
        .selected_identities()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let selection =
        verify_import_plan(source, plan.plan_version, &plan.plan_token, &selected, None)
            .expect("verify reviewed selection");
    let report = ingest_path_with_policy_selection_and_observer(
        cache,
        source,
        name,
        &LogEmbedPolicy::default(),
        None,
        &NoopProcessProgress,
        None,
        &selection,
    )
    .expect("reviewed import");
    let corpus = LogCorpus::open(cache, &report.corpus_id).expect("open imported corpus");
    let mut events = corpus.with_events(|events| {
        events
            .iter()
            .map(|event| EventFact {
                source: event.source.clone(),
                message: event.message.clone(),
                level: event.level.clone(),
                timestamp_provenance: event.timestamp_provenance,
                active_timestamp_basis: event.active_timestamp_basis,
                unresolved_local_timestamp: event.unresolved_local_timestamp.clone(),
            })
            .collect::<Vec<_>>()
    });
    events.sort_by(|left, right| {
        (&left.source, &left.message, &left.level).cmp(&(
            &right.source,
            &right.message,
            &right.level,
        ))
    });
    let catalog = query_source_catalog(
        &corpus,
        &LogSourceCatalogQuery {
            search: None,
            cursor: None,
            limit: 100,
        },
    )
    .expect("query durable source catalog");
    assert_eq!(catalog.next_cursor, None);
    assert_eq!(catalog.sources.len() as u64, catalog.total_matched);
    ImportFacts {
        events,
        catalog: catalog
            .sources
            .into_iter()
            .map(|source| (source.source, source.event_count))
            .collect(),
    }
}

fn message_starts_with_calendar(value: &str) -> bool {
    let value = value.trim_start().as_bytes();
    value.len() >= 10
        && value.get(4) == Some(&b'-')
        && value.get(7) == Some(&b'-')
        && value
            .get(..4)
            .is_some_and(|year| year.iter().all(u8::is_ascii_digit))
}

#[test]
fn reviewed_folder_and_zip_import_share_one_strict_durable_oracle() {
    let temp = tempfile::tempdir().expect("temporary root");
    let folder = temp.path().join("source-folder");
    std::fs::create_dir_all(&folder).expect("create source folder");
    let entries = members();
    write_folder(&folder, &entries);
    let archive = temp.path().join("source-archive.zip");
    write_zip(&archive, &entries);

    let folder_plan = preview_import_plan(&folder, None).expect("folder preview");
    let archive_plan = preview_import_plan(&archive, None).expect("archive preview");
    assert_eq!(
        preview_facts(&folder_plan.report),
        preview_facts(&archive_plan.report)
    );
    assert_eq!(folder_plan.report.groups, archive_plan.report.groups);
    assert_eq!(folder_plan.report.counts, archive_plan.report.counts);

    let expected_selected = vec![
        MALFORMED,
        NESTED_A,
        NESTED_B,
        TIMESTAMP_ROTATION,
        CURRENT,
        NUMERIC_ROTATION,
    ];
    assert_eq!(folder_plan.report.selected_identities(), expected_selected);
    assert_eq!(archive_plan.report.selected_identities(), expected_selected);

    for (identity, reason) in [
        (XML, ImportPreviewReason::XmlEventParsingUnsupported),
        (HTML, ImportPreviewReason::HtmlEventParsingUnsupported),
        (PROSE, ImportPreviewReason::InsufficientEventEvidence),
    ] {
        for report in [&folder_plan.report, &archive_plan.report] {
            let item = report
                .items
                .iter()
                .find(|item| item.identity == identity)
                .expect("supporting source stays visible");
            assert_eq!(item.status, ImportItemStatus::Supporting);
            assert_eq!(item.role, ImportItemRole::Attachment);
            assert!(!item.selected);
            assert!(item.reasons.contains(&reason));
        }
    }

    let root_family = folder_plan
        .report
        .groups
        .iter()
        .find(|group| group.stem == CURRENT)
        .expect("current and rotated sources form a family");
    assert_eq!(
        root_family.member_identities,
        vec![TIMESTAMP_ROTATION, CURRENT, NUMERIC_ROTATION]
    );

    let folder_import = reviewed_import(&temp.path().join("cache-folder"), &folder, "folder");
    let archive_import = reviewed_import(&temp.path().join("cache-archive"), &archive, "archive");
    assert_eq!(folder_import.events, archive_import.events);
    assert_eq!(folder_import.catalog, archive_import.catalog);

    let expected_catalog = vec![
        (MALFORMED.to_string(), 1),
        (NESTED_A.to_string(), 1),
        (NESTED_B.to_string(), 1),
        (TIMESTAMP_ROTATION.to_string(), 1),
        (CURRENT.to_string(), 2),
        (NUMERIC_ROTATION.to_string(), 1),
    ];
    assert_eq!(folder_import.catalog, expected_catalog);
    assert!(folder_import
        .catalog
        .iter()
        .all(|(source, _)| source != XML && source != HTML && source != PROSE));

    for event in &folder_import.events {
        if event.timestamp_provenance != TimestampProvenance::OrderOnly {
            assert!(
                !message_starts_with_calendar(&event.message),
                "recognized timestamp remained in Message: {event:?}"
            );
        }
    }

    let sql_events = folder_import
        .events
        .iter()
        .filter(|event| event.source == CURRENT && event.message.contains("SELECT record_id"))
        .collect::<Vec<_>>();
    assert_eq!(sql_events.len(), 1, "SQL statement must be one event");
    assert!(sql_events[0].message.contains("\nFROM event_records"));
    assert!(sql_events[0].message.contains("\nWHERE active = true"));

    let malformed = folder_import
        .events
        .iter()
        .find(|event| event.source == MALFORMED)
        .expect("malformed source event retained");
    assert_eq!(
        malformed.timestamp_provenance,
        TimestampProvenance::OrderOnly
    );
    assert_eq!(
        malformed.active_timestamp_basis,
        ActiveTimestampBasis::OrderOnly
    );
    assert_eq!(malformed.unresolved_local_timestamp, None);
    assert_eq!(malformed.message, MALFORMED_LINE);
}
