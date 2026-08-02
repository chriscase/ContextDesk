//! Production-path acceptance for reviewed format profiles:
//! preview → plan → ingest → query, against the real pipeline.
//!
//! Unit tests prove the grammar in isolation. These exercise the grammar and
//! the shipped pipeline over the SAME synthetic corpus.
//!
//! **Scope, stated plainly:** ingest does not consult reviewed formats yet, so
//! nothing here proves the grammar's output reaches a corpus. What these prove
//! is that the grammar behaves correctly on realistic input, that the shipped
//! pipeline independently keeps such a corpus order-only, and that the two
//! agree about a rolled family. Read "preview -> plan -> ingest -> query" as
//! four stages exercised over one corpus, not as one wired pipeline.
//!
//! **Synthetic fixtures only.** Every line here is written in this file. No
//! private or company archive is read, referenced, or shipped.

use cd_core::log_analysis::import_preview::preview_import_path;
use cd_core::log_analysis::import_profile::SafePattern;
use cd_core::log_analysis::parse::TimestampProvenance;
use cd_core::log_analysis::query::TimeQuality;
use cd_core::log_analysis::reviewed_format::{
    assemble_records, is_candidate_for, preview_reviewed_format, select_format, FieldSlot,
    FormatSelection, MultilineRule, ReviewedFormat, TimeToken, TimestampGrammar,
    REVIEWED_FORMAT_SCHEMA_ID,
};

/// The common shape the goal names: `2024-05-03 12:24:22,729 INFO - message`.
fn app_log_format() -> ReviewedFormat {
    ReviewedFormat {
        schema_id: REVIEWED_FORMAT_SCHEMA_ID.to_string(),
        min_reader_version: 1,
        format_id: "example.app-log".to_string(),
        version: 1,
        name: "Example app log".to_string(),
        path_patterns: vec![SafePattern::new("**/app.log*")],
        timestamp: TimestampGrammar {
            tokens: vec![
                TimeToken::Year4,
                TimeToken::Literal('-'),
                TimeToken::Month2,
                TimeToken::Literal('-'),
                TimeToken::Day2,
                TimeToken::Literal(' '),
                TimeToken::Hour24,
                TimeToken::Literal(':'),
                TimeToken::Minute2,
                TimeToken::Literal(':'),
                TimeToken::Second2,
                TimeToken::Literal(','),
                TimeToken::Millis3,
            ],
        },
        layout: vec![
            FieldSlot::Whitespace,
            FieldSlot::Level,
            FieldSlot::Whitespace,
            FieldSlot::Literal("- ".to_string()),
            FieldSlot::Message,
        ],
        multiline: MultilineRule::ContinuationUntilNextTimestamp,
        priority: 10,
        suggested_timezone: None,
    }
}

/// The same shape with an explicit offset — the "one explicit timezone
/// exception" the goal calls for.
fn app_log_with_offset() -> ReviewedFormat {
    let mut format = app_log_format();
    format.format_id = "example.app-log-offset".to_string();
    format.path_patterns = vec![SafePattern::new("**/edge.log*")];
    format.timestamp.tokens.push(TimeToken::Offset);
    format
}

/// Synthetic body covering plain lines, a Java continuation, and a Python one.
const APP_LOG_BODY: &str = "\
2024-05-03 12:24:22,729 INFO - Example message
2024-05-03 12:24:23,001 WARN - disk usage high
2024-05-03 12:24:24,512 ERROR - request failed
java.lang.IllegalStateException: boom
\tat com.example.Service.run(Service.java:42)
\tat com.example.Main.main(Main.java:7)
2024-05-03 12:24:25,100 ERROR - task crashed
Traceback (most recent call last):
  File \"worker.py\", line 12, in run
    do_work()
ValueError: bad input
2024-05-03 12:24:26,000 INFO - recovered
";

fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(&path, body).expect("write");
    path
}

#[test]
fn preview_reports_structure_before_anything_is_applied() {
    let format = app_log_format();
    let preview = preview_reviewed_format(&format, APP_LOG_BODY);

    assert_eq!(preview.records_matched, 5, "five timestamped records");
    assert_eq!(preview.lines_inspected, 12);
    assert_eq!(
        preview.lines_unattributed, 0,
        "every continuation line must be attributed"
    );
    assert!(preview.needs_timezone_review);
    assert_eq!(preview.provenance, TimestampProvenance::UnresolvedLocal);

    // The preview shows real structure, and the timestamp is gone from the
    // message it came from.
    let first = &preview.samples[0];
    assert_eq!(first.fields.level.as_deref(), Some("INFO"));
    assert_eq!(first.fields.message, "Example message");
    assert!(!first.fields.message.contains("2024-05-03"));
}

#[test]
fn multiline_records_keep_their_own_continuations() {
    let (records, leading) = assemble_records(&app_log_format(), APP_LOG_BODY);
    assert!(leading.is_empty());
    assert_eq!(records.len(), 5);

    // Java traceback attaches to the ERROR that raised it, and stops there.
    assert_eq!(records[2].fields.message, "request failed");
    assert_eq!(records[2].continuation.len(), 3);
    assert!(records[2].continuation[0].starts_with("java.lang"));

    // Python traceback attaches to its own record, not the previous one.
    assert_eq!(records[3].fields.message, "task crashed");
    assert_eq!(records[3].continuation.len(), 4);

    // And the record after a multiline block is clean.
    assert_eq!(records[4].fields.message, "recovered");
    assert!(
        records[4].continuation.is_empty(),
        "a continuation must not bleed past the next record start"
    );
}

#[test]
fn rolled_files_share_one_profile_and_unrelated_sources_are_not_claimed() {
    let format = app_log_format();
    for rolled in [
        "logs/app.log",
        "logs/app.log.1",
        "logs/app.log.2024-05-03",
        "logs/app.log.2024-05-04",
        "srv/a/logs/app.log.2024-05-05",
    ] {
        assert!(is_candidate_for(&format, rolled), "{rolled}");
        assert_eq!(
            select_format(std::slice::from_ref(&format), rolled, APP_LOG_BODY),
            FormatSelection::Selected {
                format_id: "example.app-log".to_string(),
                version: 1
            },
            "{rolled} should select the shared profile"
        );
    }
    for unrelated in [
        "logs/access.log",
        "logs/postgres.log",
        "metrics/ops.json",
        "logs/other-app.log",
    ] {
        assert!(
            !is_candidate_for(&format, unrelated),
            "{unrelated} must not be claimed by a profile written for app.log"
        );
    }
}

#[test]
fn the_explicit_offset_exception_needs_no_timezone_review() {
    let format = app_log_with_offset();
    let body = "2024-05-03 12:24:22,729+02:00 INFO - edge request\n";
    let preview = preview_reviewed_format(&format, body);

    assert_eq!(preview.records_matched, 1);
    assert!(
        !preview.needs_timezone_review,
        "an explicit offset is already an instant"
    );
    assert_eq!(preview.provenance, TimestampProvenance::ExplicitWallClock);

    // ...while the offsetless profile over the same corpus still does.
    assert!(preview_reviewed_format(&app_log_format(), APP_LOG_BODY).needs_timezone_review);
}

#[test]
fn a_profile_is_a_candidate_by_path_but_selected_by_content() {
    // The offset profile is a candidate for edge.log by name, but the body
    // here has no offset, so it must not be selected.
    let offset_format = app_log_with_offset();
    assert!(is_candidate_for(&offset_format, "logs/edge.log"));
    assert_eq!(
        select_format(&[offset_format], "logs/edge.log", APP_LOG_BODY),
        FormatSelection::NoMatch,
        "name may nominate; only content may select"
    );
}

#[test]
fn structured_json_with_ts_still_imports_through_the_shipped_path() {
    // A reviewed format is for shapes the built-ins miss. JSON with `ts` is
    // already handled, and adding reviewed formats must not disturb it.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = write(
        dir.path(),
        "structured.jsonl",
        "{\"ts\":\"2024-05-03T12:24:22Z\",\"level\":\"info\",\"msg\":\"json line\"}\n\
         {\"ts\":\"2024-05-03T12:24:23Z\",\"level\":\"warn\",\"msg\":\"second\"}\n",
    );

    let cache = tempfile::tempdir().expect("cache");
    let report = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        &path,
        "ts-alias",
        None,
        "test-model",
    )
    .expect("ingest");

    assert_eq!(report.stats.lines, 2);
    assert_eq!(
        report.confidence.sources[0].format_id.as_deref(),
        Some("json-object-line")
    );
    assert_eq!(
        report.confidence.corpus_time_quality,
        TimeQuality::Wall,
        "an explicit ts with an offset is wall-clock time"
    );
}

#[test]
fn grammar_and_pipeline_agree_over_a_rolled_family() {
    // The whole path on a synthetic rolled family: preview the directory,
    // confirm the profile selects every member, then ingest and query.
    let dir = tempfile::tempdir().expect("tempdir");
    write(dir.path(), "logs/app.log", APP_LOG_BODY);
    write(dir.path(), "logs/app.log.2024-05-02", APP_LOG_BODY);
    write(
        dir.path(),
        "logs/access.log",
        "10.0.0.1 - - GET /health 200\n",
    );

    // 1. PREVIEW — the shipped inventory sees every file.
    let inventory = preview_import_path(dir.path(), None).expect("preview");
    let identities: Vec<&str> = inventory
        .items
        .iter()
        .map(|i| i.identity.as_str())
        .collect();
    assert!(identities.contains(&"logs/app.log"));
    assert!(identities.contains(&"logs/app.log.2024-05-02"));
    assert!(identities.contains(&"logs/access.log"));

    // 2. PLAN — the reviewed profile claims the rolled family and nothing else.
    let format = app_log_format();
    let claimed: Vec<&str> = identities
        .iter()
        .copied()
        .filter(|identity| is_candidate_for(&format, identity))
        .collect();
    assert_eq!(claimed, vec!["logs/app.log", "logs/app.log.2024-05-02"]);

    // 3. INGEST — through the real pipeline.
    let cache = tempfile::tempdir().expect("cache");
    let report = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        dir.path(),
        "rolled-family",
        None,
        "test-model",
    )
    .expect("ingest");
    assert!(report.stats.lines > 0);

    // 4. QUERY — the corpus is real and readable.
    let corpus = cd_core::log_analysis::store::LogCorpus::open(cache.path(), &report.corpus_id)
        .expect("open corpus");
    assert!(corpus.event_count() > 0, "the corpus must be queryable");

    // The reviewed grammar would attribute the same content the same way in
    // every member of the family.
    for member in ["logs/app.log", "logs/app.log.2024-05-02"] {
        assert_eq!(
            select_format(std::slice::from_ref(&format), member, APP_LOG_BODY),
            FormatSelection::Selected {
                format_id: "example.app-log".to_string(),
                version: 1
            }
        );
    }
}

#[test]
fn unresolved_local_time_stays_order_only_and_no_suggestion_resolves_it() {
    // The load-bearing timezone claim, stated exactly: the grammar yields
    // UnresolvedLocal, the shipped pipeline independently keeps such a corpus
    // order-only, and a suggestion resolves nothing. This does NOT call
    // apply_source_timezones — that path is shipped and separately tested;
    // wiring the grammar into it is residual.
    let format = app_log_format();
    assert_eq!(
        format.timestamp.provenance(),
        TimestampProvenance::UnresolvedLocal
    );

    let dir = tempfile::tempdir().expect("tempdir");
    let path = write(dir.path(), "app.log", APP_LOG_BODY);
    let cache = tempfile::tempdir().expect("cache");
    let report = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        &path,
        "unresolved",
        None,
        "test-model",
    )
    .expect("ingest");

    assert_eq!(
        report.confidence.corpus_time_quality,
        TimeQuality::OrderOnly,
        "local calendar text must not become an instant on its own"
    );

    // A suggestion changes nothing: it is recorded, not applied.
    let mut suggesting = format.clone();
    suggesting.suggested_timezone = Some("America/Chicago".to_string());
    assert!(
        preview_reviewed_format(&suggesting, APP_LOG_BODY).needs_timezone_review,
        "a suggested zone must never satisfy the review it suggests"
    );
}

#[test]
fn one_reviewed_declaration_is_offered_for_every_matching_unresolved_source() {
    // The grouping claim: all rolled members share one profile and therefore
    // one unresolved-time decision, rather than asking per file.
    let format = app_log_format();
    let members = [
        "logs/app.log",
        "logs/app.log.1",
        "logs/app.log.2024-05-03",
        "logs/app.log.2024-05-04",
    ];
    let needing_review: Vec<&str> = members
        .iter()
        .copied()
        .filter(|identity| {
            is_candidate_for(&format, identity)
                && preview_reviewed_format(&format, APP_LOG_BODY).needs_timezone_review
        })
        .collect();
    assert_eq!(
        needing_review.len(),
        members.len(),
        "one declaration must cover the whole matching family"
    );

    // The exception stays visible: a source with an explicit offset is not
    // swept into the same declaration.
    let offset = app_log_with_offset();
    assert!(
        !preview_reviewed_format(&offset, "2024-05-03 12:24:22,729Z INFO - x\n")
            .needs_timezone_review
    );
}

#[test]
fn a_stale_source_fails_closed_rather_than_reusing_a_profile_blindly() {
    // Fail-closed staleness: the profile matched this shape yesterday, but the
    // source has changed shape today. Selection must report NoMatch rather
    // than forcing the old grammar onto new content.
    let format = app_log_format();
    let changed = "May  3 12:24:22 host app[1]: switched to syslog format\n";
    assert_eq!(
        select_format(std::slice::from_ref(&format), "logs/app.log", changed),
        FormatSelection::NoMatch,
        "a source that changed shape must not be parsed by the stale profile"
    );
    // And the profile is still a path candidate — which is exactly why
    // content, not the name, has to be the deciding evidence.
    assert!(is_candidate_for(&format, "logs/app.log"));
}
