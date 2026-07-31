//! Reference producer for `contextdesk.normalized_log_events.v1` in Rust.
//!
//! Unlike the Node and Python references, this one does not reimplement the
//! validator — it calls `cd_core::normalized_log_events`, which IS the
//! authority. A Rust producer therefore has no opportunity to drift from the
//! contract, and this file only has to show how to *build* conforming events.
//!
//! Compile as an example against cd-core, or copy the shape into your own
//! exporter. The three time resolutions below are the ones a real producer
//! actually hits; the fourth (`order_only`) is for sources with no usable
//! timestamp at all.
//!
//! ```no_run
//! // cargo run -p cd-core --example normalized_log_producer
//! ```

use cd_core::normalized_log_events::{
    validate_file, EventTime, NormalizedLogEvent, NormalizedLogHeader, ProducerIdentity,
    ProducerRedactionClaim, Severity, TimeBasis, TimeResolution, NORMALIZED_LOG_EVENTS_SCHEMA_ID,
};

fn severity() -> Severity {
    Severity {
        number: Some(9),
        text: Some("INFO".into()),
        // The source's own typed value survives verbatim next to the
        // normalized number — a syslog PRI here.
        source: Some(serde_json::json!(6)),
        // Always emitted, so it can never be mistaken for source-declared.
        inferred: false,
    }
}

fn event(source_seq: u64, time: EventTime, message: &str, canonical: &str) -> NormalizedLogEvent {
    NormalizedLogEvent {
        source_seq,
        time,
        severity: severity(),
        message: message.into(),
        trace_id: None,
        span_id: None,
        correlations: Vec::new(),
        attributes: serde_json::Map::new(),
        logger: None,
        service: None,
        host: None,
        canonical: canonical.into(),
        canonical_truncated: false,
    }
}

fn main() {
    let header = NormalizedLogHeader {
        schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.into(),
        min_reader_version: 1,
        source_id: "checkout-api".into(),
        producer: ProducerIdentity {
            name: "rust-reference-producer".into(),
            version: "1.0.0".into(),
        },
        // Advisory only: ContextDesk re-redacts regardless of this claim.
        redaction: Some(ProducerRedactionClaim {
            credentials_removed: true,
            personal_data_removed: false,
            note: None,
        }),
        source_label: Some("checkout api".into()),
    };

    let events = vec![
        // The source carried its own explicit offset — the easy case.
        event(
            0,
            EventTime {
                basis: TimeBasis::Wall,
                resolution: TimeResolution::SourceExplicit,
                instant: Some("2026-01-01T00:00:00Z".into()),
                local_text: None,
                resolved_timezone: None,
                observed: None,
            },
            "explicit offset in the source",
            "2026-01-01T00:00:00Z INFO explicit offset in the source",
        ),
        // We knew the deployment's timezone, so we resolved it ourselves —
        // and must say so, keeping the original text and the zone we used.
        event(
            1,
            EventTime {
                basis: TimeBasis::Wall,
                resolution: TimeResolution::ProducerResolved,
                instant: Some("2026-01-01T00:00:00-06:00".into()),
                local_text: Some("2026-01-01 00:00:00".into()),
                resolved_timezone: Some("America/Chicago".into()),
                observed: None,
            },
            "producer resolved a zone-less local time",
            "2026-01-01 00:00:00 INFO producer resolved a zone-less local time",
        ),
        // We did NOT know the timezone. Emitting an instant here would be a
        // guess; the contract makes that unrepresentable, which is the point.
        event(
            2,
            EventTime {
                basis: TimeBasis::Order,
                resolution: TimeResolution::Unresolved,
                instant: None,
                local_text: Some("2026-01-01 00:00:00".into()),
                resolved_timezone: None,
                observed: None,
            },
            "local time we could not resolve",
            "2026-01-01 00:00:00 INFO local time we could not resolve",
        ),
    ];

    let mut text = serde_json::to_string(&header).expect("header");
    for item in &events {
        text.push('\n');
        text.push_str(&serde_json::to_string(item).expect("event"));
    }
    text.push('\n');

    // Always validate before shipping. Passing JSON Schema alone is not
    // conformance: cross-line rules (sequence contiguity) and the timestamp
    // legality matrix live here.
    let report = validate_file(&text);
    assert!(
        report.ok,
        "produced file must conform: {:?}",
        report.diagnostics
    );

    print!("{text}");
}
