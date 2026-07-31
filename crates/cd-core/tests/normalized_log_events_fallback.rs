//! Old-reader fallback: what a ContextDesk build that predates
//! `contextdesk.normalized_log_events.v1` actually does with one of these
//! files.
//!
//! The contract's whole safety story for older readers is "it degrades to
//! plain JSON lines with order-only time, and never fabricates an instant."
//! That is a claim about the *existing* ingest path, so asserting it inside
//! the contract module would prove nothing. These tests run the real
//! `ingest_path` and the real deterministic fingerprinter over a real
//! conforming file.
//!
//! There is no fast path. These tests are also the proof of that: the file is
//! imported by the ordinary raw path, exactly like any other JSON-lines log.

use std::io::Write;

use cd_core::log_analysis::format_profile::{fingerprint_format, FormatFingerprintOutcome};
use cd_core::log_analysis::query::TimeQuality;
use cd_core::normalized_log_events::{
    validate_file, Correlation, CorrelationClass, EventTime, NormalizedLogEvent,
    NormalizedLogHeader, ProducerIdentity, ProducerRedactionClaim, Severity, TimeBasis,
    TimeResolution, NORMALIZED_LOG_EVENTS_SCHEMA_ID,
};

fn header() -> NormalizedLogHeader {
    NormalizedLogHeader {
        schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.to_string(),
        min_reader_version: 1,
        source_id: "checkout-api".to_string(),
        producer: ProducerIdentity {
            name: "example-exporter".to_string(),
            version: "1.0.0".to_string(),
        },
        redaction: Some(ProducerRedactionClaim {
            credentials_removed: true,
            personal_data_removed: false,
            note: None,
        }),
        source_label: Some("checkout api".to_string()),
    }
}

fn event(seq: u64) -> NormalizedLogEvent {
    NormalizedLogEvent {
        source_seq: seq,
        time: EventTime {
            basis: TimeBasis::Wall,
            resolution: TimeResolution::SourceExplicit,
            instant: Some(format!("2026-01-01T00:00:{:02}Z", seq % 60)),
            local_text: None,
            resolved_timezone: None,
            observed: None,
        },
        severity: Severity {
            number: Some(9),
            text: Some("INFO".to_string()),
            source: Some(serde_json::json!(6)),
            inferred: false,
        },
        message: format!("checkout step {seq} completed"),
        trace_id: Some("4bf92f3577b34da6a3ce929d0e0e4736".to_string()),
        span_id: Some("00f067aa0ba902b7".to_string()),
        correlations: vec![Correlation {
            class: CorrelationClass::Request,
            value: format!("req-{seq}"),
        }],
        attributes: serde_json::Map::new(),
        logger: Some("checkout".to_string()),
        service: Some("checkout".to_string()),
        host: Some("api-7".to_string()),
        canonical: format!(
            "2026-01-01T00:00:{:02}Z INFO checkout step {seq} completed",
            seq % 60
        ),
        canonical_truncated: false,
    }
}

/// A conforming file: header line plus `count` events.
fn conforming_file(count: u64) -> String {
    let mut text = serde_json::to_string(&header()).expect("header");
    for seq in 0..count {
        text.push('\n');
        text.push_str(&serde_json::to_string(&event(seq)).expect("event"));
    }
    text.push('\n');
    text
}

#[test]
fn the_generated_file_is_conforming() {
    // Everything below is only meaningful if the input is actually valid.
    let report = validate_file(&conforming_file(5));
    assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
    assert_eq!(report.events_validated, 5);
}

#[test]
fn an_old_reader_fingerprints_every_line_as_plain_json_objects() {
    let text = conforming_file(5);
    for line in text.lines() {
        // `None` path: the fingerprinter must decide from content alone.
        let fingerprint = fingerprint_format(line, None);
        assert_eq!(
            fingerprint.outcome,
            FormatFingerprintOutcome::Matched,
            "line did not fingerprint cleanly: {line}"
        );
        assert_eq!(
            fingerprint.format_id,
            Some("json-object-line"),
            "an old reader must see ordinary JSON object lines"
        );
    }
}

#[test]
fn an_old_reader_imports_the_file_as_order_only_and_fabricates_no_instant() {
    // This is the load-bearing fallback test. A pre-contract build has no idea
    // what `time.instant` means; it must NOT promote it to wall-clock time,
    // because doing so would silently mix a producer's clock into a corpus
    // that never agreed to it.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("normalized.jsonl");
    let mut file = std::fs::File::create(&path).expect("create");
    file.write_all(conforming_file(12).as_bytes())
        .expect("write");
    drop(file);

    let cache = tempfile::tempdir().expect("cache");
    let report = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        &path,
        "old-reader-fallback",
        None,
        "test-model",
    )
    .expect("an old reader must still be able to import the file");

    assert!(
        report.stats.lines >= 12,
        "every event line should import as an ordinary event: {}",
        report.stats.lines
    );

    assert_eq!(
        report.confidence.corpus_time_quality,
        TimeQuality::OrderOnly,
        "an old reader must not treat the producer's instants as wall-clock time"
    );
    // In order-only mode ingest still records a span, but it is an ORDINAL
    // span (0..n), not a clock. The honest invariant is therefore not "no
    // span" — it is that nothing resembling the producer's instants leaked
    // into it. 2026-01-01T00:00:00Z is ~1_767_225_600 epoch seconds; an
    // order-only ordinal for a 12-event file cannot plausibly reach that.
    const EPOCH_2001: i64 = 978_307_200;
    for value in [report.stats.ts_min, report.stats.ts_max]
        .into_iter()
        .flatten()
    {
        assert!(
            value < EPOCH_2001,
            "an old reader must not derive a wall-clock instant from the \
             producer's `time.instant`; got {value}"
        );
    }
}

#[test]
fn the_old_reader_path_is_the_only_path_that_exists_today() {
    // Guards the goal's explicit instruction not to claim a fast path exists.
    // If someone later adds normalized-aware ingest, this test should be
    // deliberately updated as part of that slice — not silently deleted.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("normalized.jsonl");
    std::fs::write(&path, conforming_file(3)).expect("write");

    let cache = tempfile::tempdir().expect("cache");
    let report = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        &path,
        "no-fast-path",
        None,
        "test-model",
    )
    .expect("ingest");

    // The corpus is built by the raw path, so the format it recorded is the
    // generic JSON-lines grammar, not a normalized-events grammar.
    let sources = &report.confidence.sources;
    assert_eq!(sources.len(), 1);
    assert_eq!(
        sources[0].format_id.as_deref(),
        Some("json-object-line"),
        "there is no normalized-events ingest path yet; this must stay generic"
    );
}

#[test]
fn no_line_exceeds_what_the_raw_reader_accepts() {
    // The fallback would be a dead letter if a conforming normalized line could
    // be longer than the raw line limit.
    let text = conforming_file(50);
    for line in text.lines() {
        assert!(
            line.len() <= cd_core::normalized_log_events::MAX_NORMALIZED_LINE_BYTES,
            "line exceeds the contract bound"
        );
        assert!(
            line.len() <= cd_core::log_analysis::ingest::MAX_RAW_LOG_LINE_BYTES,
            "a conforming line must always fit the raw reader"
        );
    }
}

#[test]
fn an_unresolved_event_carries_no_instant_an_old_reader_could_misread() {
    // The unresolved case is where a careless design would leak a fabricated
    // instant to an old reader. There must be no instant field at all.
    let mut item = event(0);
    item.time = EventTime {
        basis: TimeBasis::Order,
        resolution: TimeResolution::Unresolved,
        instant: None,
        local_text: Some("2026-01-01 00:00:00".to_string()),
        resolved_timezone: None,
        observed: None,
    };
    let encoded = serde_json::to_string(&item).expect("encode");
    assert!(
        !encoded.contains("\"instant\""),
        "an unresolved event must not serialize an instant at all: {encoded}"
    );
    assert!(encoded.contains("\"localText\""));
    assert!(encoded.contains("\"resolution\":\"unresolved\""));
}

#[test]
fn a_producer_resolved_event_is_visibly_marked_for_any_reader() {
    let mut item = event(0);
    item.time = EventTime {
        basis: TimeBasis::Wall,
        resolution: TimeResolution::ProducerResolved,
        instant: Some("2026-01-01T00:00:00-06:00".to_string()),
        local_text: Some("2026-01-01 00:00:00".to_string()),
        resolved_timezone: Some("America/Chicago".to_string()),
        observed: None,
    };
    let encoded = serde_json::to_string(&item).expect("encode");
    // Even a reader that understands nothing else can see the resolution
    // string and the zone that produced the instant.
    assert!(encoded.contains("\"resolution\":\"producer_resolved\""));
    assert!(encoded.contains("\"resolvedTimezone\":\"America/Chicago\""));
    assert!(
        encoded.contains("\"localText\":\"2026-01-01 00:00:00\""),
        "the original local text must survive alongside the computed instant"
    );
}
