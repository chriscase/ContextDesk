use cd_core::log_analysis::{
    import_preview::{preview_import_plan, ImportItemStatus},
    ingest_path,
};
use sha2::{Digest, Sha256};

#[test]
fn html_pre_records_keep_raw_source_digest_and_shared_time_semantics() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("report.html");
    let raw = include_bytes!("../../../fixtures/import-html/pre.html");
    std::fs::write(&path, raw).unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    assert_eq!(plan.report.items[0].status, ImportItemStatus::Review);
    assert!(plan.report.items[0]
        .format_id
        .as_deref()
        .unwrap()
        .starts_with("html:"));
    let report = ingest_path(&temp.path().join("cache"), &path, "html", None, "none").unwrap();
    assert_eq!(report.stats.lines, 2);
    assert_eq!(report.stats.source_bytes, raw.len() as u64);
    assert_eq!(report.stats.format_counts.get("html_derived"), Some(&2));
    assert_eq!(
        report.source_digests[0].content_digest,
        format!("sha256:{:x}", Sha256::digest(raw))
    );
    assert_eq!(report.source_digests[0].byte_length, raw.len() as u64);
    assert_eq!(std::fs::read(&path).unwrap(), raw);
    assert_eq!(report.confidence.counts.wall, 1);
}

#[test]
fn ambiguous_html_stays_supporting_with_passive_readable_excerpt() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("report.log");
    std::fs::write(
        &path,
        include_bytes!("../../../fixtures/import-html/document.html"),
    )
    .unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    let item = &plan.report.items[0];
    assert_eq!(item.status, ImportItemStatus::Supporting);
    assert!(!item.selected);
    let text = item.representative.as_deref().unwrap();
    assert!(text.contains("System status"));
    assert!(!text.contains("never execute"));
    assert!(!text.contains("secret-style"));
    assert!(ingest_path(&temp.path().join("cache"), &path, "html", None, "none").is_err());
}

#[test]
fn misleading_extension_does_not_select_html_parser() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("ordinary.html");
    std::fs::write(
        &path,
        include_bytes!("../../../fixtures/import-html/misleading.html"),
    )
    .unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    assert_ne!(plan.report.items[0].status, ImportItemStatus::Supporting);
    let report = ingest_path(&temp.path().join("cache"), &path, "ordinary", None, "none").unwrap();
    assert_eq!(report.stats.lines, 1);
    assert!(!report.stats.format_counts.contains_key("html_derived"));
}

#[test]
fn html_table_original_is_exact_raw_row_not_flattened_parser_text() {
    use cd_core::log_analysis::{
        query::query_event_original, query::EventOriginalRepresentation, LogCorpus,
    };
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("table.html");
    let raw = include_str!("../../../fixtures/import-html/table.html");
    std::fs::write(&path, raw).unwrap();
    let cache = temp.path().join("cache");
    let report = ingest_path(&cache, &path, "table", None, "none").unwrap();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let events = corpus.with_events(|events| events.to_vec());
    assert_eq!(events.len(), 2);
    for event in &events {
        let EventOriginalRepresentation::Available { text, .. } =
            query_event_original(&corpus, event.seq).unwrap()
        else {
            panic!("original missing")
        };
        assert!(text.starts_with("<tr><td>"));
        assert!(text.ends_with("</td></tr>"));
        assert!(raw.contains(&text));
        assert!(!event.message.contains("<td>"));
    }
}

#[test]
fn html_offsetless_and_absent_times_are_not_promoted_to_wall_clock() {
    use cd_core::log_analysis::LogCorpus;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("local.html");
    std::fs::write(&path, "<html><body><pre>2026-01-02 03:04:05 INFO local clock\nINFO missing clock\n</pre></body></html>").unwrap();
    let cache = temp.path().join("cache");
    let report = ingest_path(&cache, &path, "local", None, "none").unwrap();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    corpus.with_events(|events| {
        assert_eq!(events.len(), 2);
        let local = events
            .iter()
            .find(|e| e.message.contains("local clock"))
            .unwrap();
        assert!(local.unresolved_local_timestamp.is_some());
        let missing = events
            .iter()
            .find(|e| e.message.contains("missing clock"))
            .unwrap();
        assert!(missing.unresolved_local_timestamp.is_none());
        assert_eq!(
            serde_json::to_value(local.timestamp_provenance).unwrap(),
            "unresolved_local"
        );
        assert_eq!(
            serde_json::to_value(missing.timestamp_provenance).unwrap(),
            "order_only"
        );
    });
}

#[test]
fn html_zip_member_uses_same_bounded_parser_and_member_provenance() {
    use cd_core::log_analysis::LogCorpus;
    use std::io::Write;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bundle.zip");
    let raw = include_bytes!("../../../fixtures/import-html/pre.html");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
    zip.start_file("diagnostics/report.html", options).unwrap();
    zip.write_all(raw).unwrap();
    zip.finish().unwrap();
    let preview = preview_import_plan(&path, None).unwrap();
    assert!(preview
        .report
        .items
        .iter()
        .any(|i| i.status == ImportItemStatus::Review
            && i.format_id
                .as_deref()
                .is_some_and(|f| f.starts_with("html:"))));
    let cache = temp.path().join("cache");
    let report = ingest_path(&cache, &path, "zip", None, "none").unwrap();
    assert_eq!(report.stats.format_counts.get("html_derived"), Some(&2));
    assert_eq!(report.source_digests[0].byte_length, raw.len() as u64);
    assert_eq!(
        report.source_digests[0].content_digest,
        format!("sha256:{:x}", Sha256::digest(raw))
    );
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    corpus.with_events(|events| {
        assert!(events
            .iter()
            .all(|e| e.source.contains("diagnostics/report.html")))
    });
}

#[test]
fn stylesheet_visibility_is_unverified_not_an_empty_complete_document() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("styled.html");
    std::fs::write(&path, "<html><head><style>pre{display:none}</style></head><body><pre>2026-01-02T03:04:05Z INFO hidden event</pre></body></html>").unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    assert_eq!(plan.report.items[0].status, ImportItemStatus::Supporting);
    assert!(!plan.report.items[0].selected);
    assert!(plan.report.items[0]
        .representative
        .as_deref()
        .unwrap_or("")
        .is_empty());
    assert!(ingest_path(&temp.path().join("cache"), &path, "styled", None, "none").is_err());
}

#[test]
fn html_original_does_not_restore_private_data_removed_by_decoding_or_projection() {
    use cd_core::log_analysis::{
        query::{query_event_original, EventOriginalRepresentation},
        LogCorpus,
    };
    for (idx,raw) in [
        "<pre>INFO password&#61;test-only-value</pre>",
        "<table><tr><th>Level</th><th>Message</th></tr><tr><td>ERROR</td><td>password&#61;test-only-value</td></tr></table>",
        "<table><tr><th>Level</th><th>Message</th></tr><tr data-fixture='test-only-value'><td>INFO</td><td>safe message</td></tr></table>"
    ].into_iter().enumerate() {
        let tmp=tempfile::tempdir().unwrap();
        let input=tmp.path().join(format!("case{idx}.html"));std::fs::write(&input,raw).unwrap();
        let cache=tmp.path().join("cache");let r=ingest_path(&cache,&input,"private",None,"none").unwrap();
        let corpus=LogCorpus::open(&cache,&r.corpus_id).unwrap();
        let seq=corpus.with_events(|e|e[0].seq);
        let EventOriginalRepresentation::Available{text,source_byte_count,redaction_applied,..}=query_event_original(&corpus,seq).unwrap() else {panic!("missing original disposition")};
        assert!(redaction_applied && text.contains("withheld"));
        assert!(!text.contains("test-only-value"));
        assert!(source_byte_count>0);
        assert_eq!(r.source_digests[0].content_digest,format!("sha256:{:x}",Sha256::digest(raw.as_bytes())));
    }
}
