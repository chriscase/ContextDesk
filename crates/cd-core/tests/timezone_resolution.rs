use cd_core::log_analysis::{
    parse_line, SourceTimezoneDeclaration, SourceTimezoneResolver, TimestampResolution,
    TimezoneDeclarationBasis, TimezoneResolutionScope, UnresolvedTimestampReason,
    TIMEZONE_DECLARATION_SCHEMA_VERSION,
};

const SOURCE: &str = "company/server.log";

fn resolver(zone: &str) -> SourceTimezoneResolver {
    SourceTimezoneResolver::new(SourceTimezoneDeclaration {
        schema_version: TIMEZONE_DECLARATION_SCHEMA_VERSION,
        source: SOURCE.into(),
        iana_timezone: zone.into(),
        basis: TimezoneDeclarationBasis::UserDeclared,
        declared_at: 1_753_833_600,
        applied_revision: 12,
    })
    .unwrap()
}

#[test]
fn owner_jboss_and_elasticsearch_examples_resolve_from_user_iana_declaration() {
    let jboss = parse_line(
        "2021-03-05 02:53:53,654 ERROR [org.jboss.remoting.remote.connection] (webworker I/O-175) JBREM000200: Remote connection failed: Java.io.IOException: synthetic peer reset.",
        None,
        101,
    );
    let elasticsearch = parse_line(
        "[2021-03-04 21:00:05,324][INFO][node        ][BK0WEDM.example] initializing...",
        None,
        102,
    );
    let resolver = resolver("America/New_York");
    let preview = resolver
        .preview(
            &TimezoneResolutionScope {
                corpus_id: "company-corpus".into(),
                event_revision: 11,
            },
            [(SOURCE, &jboss), (SOURCE, &elasticsearch)],
        )
        .unwrap();

    assert_eq!(preview.affected_records, 2);
    assert_eq!(preview.first_resolved_instant, Some(1_614_909_605));
    assert_eq!(preview.last_resolved_instant, Some(1_614_930_833));
    assert_eq!(preview.dst_fold_count, 0);
    assert_eq!(preview.dst_gap_count, 0);
    assert_eq!(preview.unsupported_timestamp_count, 0);
}

#[test]
fn owner_cet_example_is_not_upgraded_when_calendar_precision_is_incomplete() {
    let cet = parse_line("2021-03-05T00:06,350 CET. INFO: REDACTED", None, 103);
    let result = resolver("Europe/Berlin").resolve(SOURCE, &cet).unwrap();

    assert_eq!(
        result,
        TimestampResolution::Unresolved {
            reason: UnresolvedTimestampReason::UnsupportedLocalTimestampShape
        }
    );
    assert_eq!(cet.ts, Some(103));
    assert_eq!(
        cet.unresolved_local_timestamp.as_deref(),
        Some("2021-03-05T00:06,350 CET")
    );
}

#[test]
fn mixed_explicit_and_offsetless_records_preserve_explicit_instant() {
    let explicit = parse_line(
        "2021-03-05 02:53:53,654+01:00 ERROR [org.jboss.Clock] (worker) explicit",
        None,
        200,
    );
    let offsetless = parse_line(
        "2021-03-05 02:53:53,654 ERROR [org.jboss.Clock] (worker) offsetless",
        None,
        201,
    );
    let resolver = resolver("America/New_York");

    assert_eq!(
        resolver.resolve(SOURCE, &explicit).unwrap(),
        TimestampResolution::ExistingWallClock {
            unix_seconds: 1_614_909_233
        }
    );
    let TimestampResolution::Resolved {
        unix_seconds,
        provenance,
    } = resolver.resolve(SOURCE, &offsetless).unwrap()
    else {
        panic!("offsetless record should resolve");
    };
    assert_eq!(unix_seconds, 1_614_930_833);
    assert_eq!(provenance.basis, TimezoneDeclarationBasis::UserDeclared);
    assert_eq!(provenance.applied_revision, 12);
}

#[test]
fn generic_local_datetime_message_resolves_after_user_iana_declaration() {
    let record = parse_line(
        "2021-03-05 02:53:53,654 INFO  - service initialized",
        None,
        202,
    );
    assert_eq!(record.ts, Some(202));
    assert_eq!(record.message, "service initialized");
    assert_eq!(
        record.unresolved_local_timestamp.as_deref(),
        Some("2021-03-05 02:53:53,654")
    );

    let TimestampResolution::Resolved {
        unix_seconds,
        provenance,
    } = resolver("America/New_York")
        .resolve(SOURCE, &record)
        .unwrap()
    else {
        panic!("recognized local timestamp should resolve after timezone selection");
    };
    assert_eq!(unix_seconds, 1_614_930_833);
    assert_eq!(provenance.basis, TimezoneDeclarationBasis::UserDeclared);
}
