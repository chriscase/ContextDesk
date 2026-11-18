//! #790: shipping ingest/package/query paths preserve typed source severity.
//! No original-record recovery is involved: assertions use persisted event data.

use cd_core::log_analysis::{
    export_corpus_zip, import_corpus_zip_path, ingest_path,
    query::{query_events, EventQuery, ExplorerEvent},
    LogCorpus,
};
use serde_json::json;

fn events(corpus: &LogCorpus, levels: Vec<String>) -> Vec<ExplorerEvent> {
    query_events(
        corpus,
        &EventQuery {
            levels,
            limit: 20,
            sort_by_time: false,
            ..Default::default()
        },
    )
    .expect("query persisted events")
    .events
}

fn assert_severity(corpus: &LogCorpus) {
    let all = events(corpus, vec![]);
    assert_eq!(all.len(), 3);

    let debug = events(corpus, vec!["debug".into()]);
    assert_eq!(debug.len(), 1);
    assert_eq!(debug[0].severity.severity_text.as_deref(), Some("DEBUG5"));
    assert_eq!(debug[0].severity.source_severity, Some(json!("DEBUG5")));
    assert_eq!(debug[0].severity.severity_number, Some(5));
    assert_eq!(debug[0].severity.provenance, "source_declared");
    assert!(!debug[0].severity.severity_inferred);

    let errors = events(corpus, vec!["error".into()]);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].severity.source_severity, Some(json!(50)));
    assert_eq!(errors[0].severity.severity_text, None);
    assert_eq!(errors[0].severity.severity_number, Some(17));
    assert_eq!(errors[0].severity.provenance, "schema_mapped");
    assert!(!errors[0].severity.severity_inferred);

    // The same numeric scalar without Pino schema evidence is not an error.
    let unknown = events(corpus, vec!["unknown".into()]);
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].severity.source_severity, Some(json!(50)));
    assert_eq!(unknown[0].severity.severity_number, None);
    assert_eq!(unknown[0].severity.provenance, "ambiguous");
    assert!(all.iter().all(|event| event.severity.is_valid()));
}

#[test]
fn typed_severity_survives_ingest_package_import_reopen_and_level_filters() {
    let temp = tempfile::tempdir().expect("fixture directory");
    let source = temp.path().join("synthetic.jsonl");
    let source_bytes = concat!(
        "{\"time\":1700000000000,\"level\":\"DEBUG5\",\"message\":\"synthetic verbose event\"}\n",
        "{\"time\":1700000001000,\"level\":50,\"pid\":42,\"hostname\":\"fixture\",\"msg\":\"synthetic error event\"}\n",
        "{\"time\":1700000002000,\"level\":50,\"message\":\"synthetic unknown scale\"}\n"
    );
    std::fs::write(&source, source_bytes).expect("write source");
    let cache = temp.path().join("source-cache");
    let report =
        ingest_path(&cache, &source, "severity fixture", None, "none").expect("production ingest");
    assert_eq!(report.stats.lines, 3);
    let corpus = LogCorpus::open(&cache, &report.corpus_id).expect("open ingested corpus");
    assert_severity(&corpus);
    let before = events(&corpus, vec![]);
    drop(corpus);

    let package = temp.path().join("severity.cdlog.zip");
    export_corpus_zip(&cache, &report.corpus_id, &package).expect("production package export");
    let destination = temp.path().join("import-cache");
    let imported =
        import_corpus_zip_path(&destination, &package).expect("production package import");
    let imported_corpus =
        LogCorpus::open(&destination, &imported.corpus_id).expect("open imported package");
    assert_severity(&imported_corpus);
    drop(imported_corpus);
    let reopened =
        LogCorpus::open(&destination, &imported.corpus_id).expect("reopen imported package");
    assert_severity(&reopened);
    let after = events(&reopened, vec![]);
    for (original, roundtripped) in before.iter().zip(after.iter()) {
        assert_eq!(original.seq, roundtripped.seq);
        assert_eq!(original.level, roundtripped.level);
        assert_eq!(original.severity, roundtripped.severity);
    }
    assert_eq!(
        std::fs::read_to_string(source).expect("read unchanged input"),
        source_bytes
    );
}
