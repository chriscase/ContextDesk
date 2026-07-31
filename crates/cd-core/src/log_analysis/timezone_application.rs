//! Durable preview/apply/clear workflow for source-local timezone declarations (#779).

use super::event_revision::{
    apply_event_timestamp_revision, EventRevisionMetadata, EventRevisionReport,
    EventTimestampUpdate, EVENT_REVISION_METADATA_SCHEMA_VERSION,
};
use super::parse::{ActiveTimestampBasis, LogFormat, ParsedLine, TimestampProvenance};
use super::store::LogCorpus;
use super::timezone_resolution::{
    SourceTimezoneDeclaration, SourceTimezoneResolver, TimestampResolution,
    TimezoneDeclarationBasis, TimezoneResolutionPreview, TimezoneResolutionScope,
    TIMEZONE_DECLARATION_SCHEMA_VERSION,
};
use crate::error::{CoreError, CoreResult};
use duckdb::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

const DECLARATIONS_KEY: &str = "sourceTimezoneDeclarations";

/// Durable timezone state and source counts for an existing corpus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneResolutionState {
    /// Exact corpus/revision snapshot.
    pub scope: TimezoneResolutionScope,
    /// Applied declarations keyed by portable source identity.
    pub declarations: BTreeMap<String, SourceTimezoneDeclaration>,
    /// Sources containing local timestamp evidence or a saved declaration.
    pub sources: Vec<TimezoneSourceStatus>,
}

/// Bounded source-level timestamp state used to reopen the review workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneSourceStatus {
    /// Portable source identity.
    pub source: String,
    /// Retained local timestamps still using ingest order.
    pub unresolved_local_records: u64,
    /// Retained local timestamps resolved by an explicit declaration.
    pub resolved_local_records: u64,
    /// Parser-proven wall-clock timestamps that declarations never rewrite.
    pub explicit_wall_clock_records: u64,
    /// Records without resolvable local calendar evidence.
    pub other_order_only_records: u64,
}

#[derive(Debug)]
struct StoredTimestampRecord {
    seq: u64,
    ts: i64,
    timestamp_provenance: TimestampProvenance,
    active_timestamp_basis: ActiveTimestampBasis,
    unresolved_local_timestamp: Option<String>,
}

fn revision_state(corpus: &LogCorpus) -> CoreResult<(u64, EventRevisionMetadata)> {
    corpus.with_connection(|connection| {
        let (revision, metadata_json) = connection
            .query_row(
                "SELECT current_revision, current_metadata_json
                 FROM event_revision_state
                 WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| {
                CoreError::Message(format!("read timezone revision state: {error}"))
            })?;
        let revision = u64::try_from(revision)
            .map_err(|_| CoreError::Message("invalid timezone event revision".into()))?;
        let metadata = if metadata_json == "{}" {
            EventRevisionMetadata {
                schema_version: EVENT_REVISION_METADATA_SCHEMA_VERSION,
                operation: "initial".into(),
                details: Value::Object(Map::new()),
            }
        } else {
            serde_json::from_str(&metadata_json).map_err(|_| {
                CoreError::Message("stored event revision metadata is invalid".into())
            })?
        };
        Ok((revision, metadata))
    })
}

fn declarations_from_details(
    details: &Value,
) -> CoreResult<BTreeMap<String, SourceTimezoneDeclaration>> {
    let Some(value) = details.get(DECLARATIONS_KEY) else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_value(value.clone())
        .map_err(|_| CoreError::Message("stored timezone declarations are invalid".into()))
}

fn metadata_with_declarations(
    current: EventRevisionMetadata,
    declarations: &BTreeMap<String, SourceTimezoneDeclaration>,
    operation: &str,
) -> CoreResult<EventRevisionMetadata> {
    let mut details = match current.details {
        Value::Object(details) => details,
        Value::Null => Map::new(),
        _ => {
            return Err(CoreError::Message(
                "stored event revision details are not an object".into(),
            ))
        }
    };
    details.insert(DECLARATIONS_KEY.into(), serde_json::to_value(declarations)?);
    Ok(EventRevisionMetadata {
        schema_version: EVENT_REVISION_METADATA_SCHEMA_VERSION,
        operation: operation.into(),
        details: Value::Object(details),
    })
}

fn parsed_record(record: &StoredTimestampRecord) -> ParsedLine {
    ParsedLine {
        ts: Some(record.ts),
        timestamp_provenance: record.timestamp_provenance,
        active_timestamp_basis: record.active_timestamp_basis,
        unresolved_local_timestamp: record.unresolved_local_timestamp.clone(),
        level: "unknown".into(),
        service: None,
        host: None,
        trace_id: None,
        message: String::new(),
        raw: String::new(),
        format: LogFormat::Plain,
    }
}

fn source_records(corpus: &LogCorpus, source: &str) -> CoreResult<Vec<StoredTimestampRecord>> {
    corpus.with_connection(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT seq, ts, timestamp_provenance, active_timestamp_basis,
                        unresolved_local_timestamp
                 FROM events
                 WHERE source = ?1
                 ORDER BY seq",
            )
            .map_err(|error| {
                CoreError::Message(format!("prepare timezone source scan: {error}"))
            })?;
        let rows = statement
            .query_map(params![source], |row| {
                let seq = row.get::<_, i64>(0)?;
                let provenance = row.get::<_, Option<String>>(2)?;
                let basis = row.get::<_, Option<String>>(3)?;
                Ok((
                    seq,
                    row.get::<_, i64>(1)?,
                    provenance,
                    basis,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|error| CoreError::Message(format!("scan timezone source: {error}")))?;
        let mut records = Vec::new();
        for row in rows {
            let (seq, ts, provenance, basis, unresolved_local_timestamp) =
                row.map_err(|error| {
                    CoreError::Message(format!("read timezone source event: {error}"))
                })?;
            records.push(StoredTimestampRecord {
                seq: u64::try_from(seq).map_err(|_| {
                    CoreError::Message("timezone source event sequence is invalid".into())
                })?,
                ts,
                timestamp_provenance: TimestampProvenance::from_storage_str(provenance.as_deref())
                    .ok_or_else(|| {
                        CoreError::Message("timezone source provenance is invalid".into())
                    })?,
                active_timestamp_basis: ActiveTimestampBasis::from_storage_str(basis.as_deref())
                    .ok_or_else(|| {
                        CoreError::Message("timezone source active basis is invalid".into())
                    })?,
                unresolved_local_timestamp,
            });
        }
        Ok(records)
    })
}

fn resolver_for(
    source: &str,
    iana_timezone: &str,
    declared_at: i64,
    applied_revision: u64,
) -> CoreResult<SourceTimezoneResolver> {
    SourceTimezoneResolver::new(SourceTimezoneDeclaration {
        schema_version: TIMEZONE_DECLARATION_SCHEMA_VERSION,
        source: source.into(),
        iana_timezone: iana_timezone.into(),
        basis: TimezoneDeclarationBasis::UserDeclared,
        declared_at,
        applied_revision,
    })
    .map_err(|error| CoreError::Message(error.to_string()))
}

/// Load durable declarations and current source-level timestamp counts.
pub fn load_timezone_resolution_state(
    cache_root: &Path,
    corpus_id: &str,
) -> CoreResult<TimezoneResolutionState> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let (event_revision, metadata) = revision_state(&corpus)?;
    let declarations = declarations_from_details(&metadata.details)?;
    let mut sources = corpus.with_connection(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT source,
                        SUM(CASE WHEN timestamp_provenance = 'unresolved_local'
                                  AND active_timestamp_basis = 'order_only'
                                 THEN 1 ELSE 0 END),
                        SUM(CASE WHEN timestamp_provenance = 'unresolved_local'
                                  AND active_timestamp_basis = 'resolved_local'
                                 THEN 1 ELSE 0 END),
                        SUM(CASE WHEN active_timestamp_basis = 'explicit_wall'
                                 THEN 1 ELSE 0 END),
                        SUM(CASE WHEN active_timestamp_basis
                                      IN ('order_only', 'legacy_unknown')
                                  AND timestamp_provenance <> 'unresolved_local'
                                 THEN 1 ELSE 0 END)
                 FROM events
                 GROUP BY source
                 ORDER BY source",
            )
            .map_err(|error| {
                CoreError::Message(format!("prepare timezone source status: {error}"))
            })?;
        let rows = statement
            .query_map([], |row| {
                Ok(TimezoneSourceStatus {
                    source: row.get(0)?,
                    unresolved_local_records: row.get::<_, i64>(1)?.max(0) as u64,
                    resolved_local_records: row.get::<_, i64>(2)?.max(0) as u64,
                    explicit_wall_clock_records: row.get::<_, i64>(3)?.max(0) as u64,
                    other_order_only_records: row.get::<_, i64>(4)?.max(0) as u64,
                })
            })
            .map_err(|error| CoreError::Message(format!("read timezone source status: {error}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Message(format!("decode timezone source status: {error}")))
    })?;
    sources.retain(|status| {
        status.unresolved_local_records > 0
            || status.resolved_local_records > 0
            || declarations.contains_key(&status.source)
    });
    Ok(TimezoneResolutionState {
        scope: TimezoneResolutionScope {
            corpus_id: corpus_id.into(),
            event_revision,
        },
        declarations,
        sources,
    })
}

/// Recompute a source-bound preview against one exact corpus revision.
pub fn preview_source_timezone(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
    iana_timezone: &str,
) -> CoreResult<TimezoneResolutionPreview> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let (current_revision, _) = revision_state(&corpus)?;
    if current_revision != expected_revision {
        return Err(CoreError::Message(format!(
            "stale timezone preview: expected revision {expected_revision}, current {current_revision}"
        )));
    }
    let applied_revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| CoreError::Message("timezone event revision overflow".into()))?;
    let resolver = resolver_for(source, iana_timezone, 0, applied_revision)?;
    let scope = TimezoneResolutionScope {
        corpus_id: corpus_id.into(),
        event_revision: expected_revision,
    };
    let records = source_records(&corpus, source)?;
    resolver
        .preview_owned(
            &scope,
            records
                .into_iter()
                .map(|record| (source, parsed_record(&record))),
        )
        .map_err(|error| CoreError::Message(error.to_string()))
}

/// Apply a previously previewed source timezone after exact recomputation.
pub fn apply_source_timezone(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
    iana_timezone: &str,
    preview_token: &str,
    declared_at: i64,
) -> CoreResult<EventRevisionReport> {
    apply_source_timezones(
        cache_root,
        corpus_id,
        expected_revision,
        &[SourceTimezoneApplyRequest {
            source: source.into(),
            iana_timezone: iana_timezone.into(),
            preview_token: preview_token.into(),
        }],
        declared_at,
    )
}

/// One source's share of a multi-source timezone application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceTimezoneApplyRequest {
    /// Portable source identity, exactly as stored on events.
    pub source: String,
    /// IANA zone this source's local timestamps should resolve under.
    pub iana_timezone: String,
    /// Fingerprint of the preview the user saw; recomputed and matched here.
    pub preview_token: String,
}

/// Apply reviewed timezone declarations across one or more sources as a
/// single atomic event revision.
///
/// Every source's preview is recomputed server-side and its token must still
/// match; a mismatch on any source fails the whole application before any
/// staging happens, so a stale preview can never be partially applied.
pub fn apply_source_timezones(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    requests: &[SourceTimezoneApplyRequest],
    declared_at: i64,
) -> CoreResult<EventRevisionReport> {
    if requests.is_empty() {
        return Err(CoreError::Message(
            "timezone apply requires at least one source".into(),
        ));
    }
    {
        let mut seen = std::collections::BTreeSet::new();
        for request in requests {
            if !seen.insert(request.source.as_str()) {
                return Err(CoreError::Message(format!(
                    "timezone apply lists source {:?} more than once",
                    request.source
                )));
            }
        }
    }
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let (current_revision, current_metadata) = revision_state(&corpus)?;
    if current_revision != expected_revision {
        return Err(CoreError::Message(format!(
            "stale timezone apply: expected revision {expected_revision}, current {current_revision}"
        )));
    }
    let applied_revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| CoreError::Message("timezone event revision overflow".into()))?;
    let mut declarations = declarations_from_details(&current_metadata.details)?;
    let mut updates = Vec::new();
    for request in requests {
        let source = request.source.as_str();
        let resolver = resolver_for(
            source,
            &request.iana_timezone,
            declared_at,
            applied_revision,
        )?;
        let preview = preview_source_timezone(
            cache_root,
            corpus_id,
            expected_revision,
            source,
            &request.iana_timezone,
        )?;
        if preview.declaration_fingerprint != request.preview_token {
            return Err(CoreError::Message(format!(
                "timezone preview token no longer matches source {source:?}, its zone, or the corpus revision"
            )));
        }
        let records = source_records(&corpus, source)?;
        for record in records {
            let parsed = parsed_record(&record);
            if let TimestampResolution::Resolved { unix_seconds, .. } = resolver
                .resolve(source, &parsed)
                .map_err(|error| CoreError::Message(error.to_string()))?
            {
                if record.ts == unix_seconds
                    && record.active_timestamp_basis == ActiveTimestampBasis::ResolvedLocal
                {
                    continue;
                }
                updates.push(EventTimestampUpdate {
                    seq: record.seq,
                    source: source.into(),
                    expected_ts: record.ts,
                    expected_active_timestamp_basis: record.active_timestamp_basis,
                    expected_timestamp_provenance: record.timestamp_provenance,
                    expected_unresolved_local_timestamp: record.unresolved_local_timestamp,
                    revised_ts: unix_seconds,
                    revised_active_timestamp_basis: ActiveTimestampBasis::ResolvedLocal,
                });
            }
        }
        declarations.insert(source.into(), resolver.declaration().clone());
    }
    let metadata =
        metadata_with_declarations(current_metadata, &declarations, "timezone_resolution.apply")?;
    apply_event_timestamp_revision(
        cache_root,
        corpus_id,
        expected_revision,
        metadata,
        updates,
        None,
    )
}

/// Clear one exact saved declaration and restore affected records to ingest order.
pub fn clear_source_timezone(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
    applied_revision: u64,
) -> CoreResult<EventRevisionReport> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let (current_revision, current_metadata) = revision_state(&corpus)?;
    if current_revision != expected_revision {
        return Err(CoreError::Message(format!(
            "stale timezone clear: expected revision {expected_revision}, current {current_revision}"
        )));
    }
    let mut declarations = declarations_from_details(&current_metadata.details)?;
    let declaration = declarations.get(source).ok_or_else(|| {
        CoreError::Message("no timezone declaration exists for this source".into())
    })?;
    if declaration.applied_revision != applied_revision {
        return Err(CoreError::Message(
            "timezone declaration revision no longer matches".into(),
        ));
    }
    let records = source_records(&corpus, source)?;
    let updates = records
        .into_iter()
        .filter(|record| {
            record.timestamp_provenance == TimestampProvenance::UnresolvedLocal
                && record.active_timestamp_basis == ActiveTimestampBasis::ResolvedLocal
        })
        .map(|record| EventTimestampUpdate {
            seq: record.seq,
            source: source.into(),
            expected_ts: record.ts,
            expected_active_timestamp_basis: ActiveTimestampBasis::ResolvedLocal,
            expected_timestamp_provenance: record.timestamp_provenance,
            expected_unresolved_local_timestamp: record.unresolved_local_timestamp,
            revised_ts: record.seq as i64,
            revised_active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
        })
        .collect::<Vec<_>>();
    declarations.remove(source);
    let metadata =
        metadata_with_declarations(current_metadata, &declarations, "timezone_resolution.clear")?;
    apply_event_timestamp_revision(
        cache_root,
        corpus_id,
        expected_revision,
        metadata,
        updates,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{corpus_time_quality, undo_event_revision, LogEvent, TimeQuality};
    use std::time::{Duration, Instant};

    fn fixture() -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "timezone application").unwrap();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 0,
                    ts: 0,
                    timestamp_provenance: TimestampProvenance::UnresolvedLocal,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: Some("2021-03-05 02:53:53,654".into()),
                    level: "error".into(),
                    service: Some("api".into()),
                    host: Some("host-a".into()),
                    template_id: 1,
                    params: vec![],
                    trace_id: None,
                    message: "local".into(),
                    source: "server/server.log".into(),
                },
                LogEvent {
                    seq: 1,
                    ts: 1_614_912_833,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: Some("api".into()),
                    host: Some("host-a".into()),
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "explicit".into(),
                    source: "server/server.log".into(),
                },
            ])
            .unwrap();
        corpus.flush().unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (cache, corpus_id)
    }

    fn two_source_fixture() -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "timezone multi apply").unwrap();
        let local = |seq: u64, source: &str, stamp: &str| LogEvent {
            seq,
            ts: seq as i64,
            timestamp_provenance: TimestampProvenance::UnresolvedLocal,
            active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
            unresolved_local_timestamp: Some(stamp.into()),
            level: "info".into(),
            service: Some("api".into()),
            host: Some("host-a".into()),
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: "local".into(),
            source: source.into(),
        };
        corpus
            .push_events(&[
                local(0, "a/app.log", "2021-03-05 02:53:53,654"),
                local(1, "b/app.log", "2021-03-05 03:10:00,000"),
            ])
            .unwrap();
        corpus.flush().unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (cache, corpus_id)
    }

    #[test]
    fn multi_source_apply_is_one_atomic_revision_and_fails_whole_on_any_stale_token() {
        let (cache, corpus_id) = two_source_fixture();
        let rev = load_timezone_resolution_state(cache.path(), &corpus_id)
            .unwrap()
            .scope
            .event_revision;
        let preview_a = preview_source_timezone(
            cache.path(),
            &corpus_id,
            rev,
            "a/app.log",
            "America/Chicago",
        )
        .unwrap();
        let preview_b =
            preview_source_timezone(cache.path(), &corpus_id, rev, "b/app.log", "Europe/Berlin")
                .unwrap();
        assert_eq!(preview_a.affected_records, 1);
        assert_eq!(preview_b.affected_records, 1);

        // A bad token on the SECOND source fails the whole apply before staging.
        let err = apply_source_timezones(
            cache.path(),
            &corpus_id,
            rev,
            &[
                SourceTimezoneApplyRequest {
                    source: "a/app.log".into(),
                    iana_timezone: "America/Chicago".into(),
                    preview_token: preview_a.declaration_fingerprint.clone(),
                },
                SourceTimezoneApplyRequest {
                    source: "b/app.log".into(),
                    iana_timezone: "Europe/Berlin".into(),
                    preview_token: "stale".into(),
                },
            ],
            1_700_000_000,
        )
        .unwrap_err();
        assert!(err.to_string().contains("b/app.log"), "err: {err}");
        let state = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        assert_eq!(state.scope.event_revision, rev, "nothing applied");
        assert!(state.declarations.is_empty());

        // Duplicate source listing is refused outright.
        let dup = apply_source_timezones(
            cache.path(),
            &corpus_id,
            rev,
            &[
                SourceTimezoneApplyRequest {
                    source: "a/app.log".into(),
                    iana_timezone: "America/Chicago".into(),
                    preview_token: preview_a.declaration_fingerprint.clone(),
                },
                SourceTimezoneApplyRequest {
                    source: "a/app.log".into(),
                    iana_timezone: "UTC".into(),
                    preview_token: preview_a.declaration_fingerprint.clone(),
                },
            ],
            1_700_000_000,
        )
        .unwrap_err();
        assert!(dup.to_string().contains("more than once"), "err: {dup}");

        // Both valid tokens: exactly one revision, both declarations saved,
        // both records resolved, and one undo restores everything.
        let report = apply_source_timezones(
            cache.path(),
            &corpus_id,
            rev,
            &[
                SourceTimezoneApplyRequest {
                    source: "a/app.log".into(),
                    iana_timezone: "America/Chicago".into(),
                    preview_token: preview_a.declaration_fingerprint,
                },
                SourceTimezoneApplyRequest {
                    source: "b/app.log".into(),
                    iana_timezone: "Europe/Berlin".into(),
                    preview_token: preview_b.declaration_fingerprint,
                },
            ],
            1_700_000_000,
        )
        .unwrap();
        assert_eq!(report.revision, rev + 1);
        assert_eq!(report.changed_events, 2);
        let state = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        assert_eq!(state.scope.event_revision, rev + 1);
        assert_eq!(state.declarations.len(), 2);
        assert_eq!(
            corpus_time_quality(&LogCorpus::open(cache.path(), &corpus_id).unwrap()),
            TimeQuality::Wall
        );
        undo_event_revision(cache.path(), &corpus_id, rev + 1, None).unwrap();
        let state = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        // Undo publishes forward as its own revision; the declarations and
        // record bases return to their pre-apply state.
        assert_eq!(state.scope.event_revision, rev + 2);
        assert!(state.declarations.is_empty());
        assert_eq!(
            corpus_time_quality(&LogCorpus::open(cache.path(), &corpus_id).unwrap()),
            TimeQuality::OrderOnly
        );
    }

    fn large_sparse_fixture() -> (tempfile::TempDir, String) {
        const EVENT_COUNT: i64 = 250_000;
        const LOCAL_SEQ: i64 = 125_000;
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "timezone sparse scale").unwrap();
        corpus
            .with_connection(|connection| {
                connection
                    .execute_batch(&format!(
                        r#"
                        INSERT INTO events (
                            seq, ts, level, service, host, template_id, params,
                            trace_id, message, source, original_redacted,
                            original_source_bytes, original_redacted_chars,
                            original_truncated, original_encoding_normalized,
                            original_redaction_applied, timestamp_provenance,
                            active_timestamp_basis, unresolved_local_timestamp
                        )
                        SELECT i,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN i ELSE 1700000000 + i END,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN 'error' ELSE 'info' END,
                               'service', 'host', i % 17, '[]', NULL,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN 'one unresolved local event'
                                    ELSE 'ordinary explicit event' END,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN 'server/server.log'
                                    ELSE 'bulk/bulk.log' END,
                               NULL, NULL, NULL, NULL, NULL, NULL,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN 'unresolved_local' ELSE 'explicit_wall' END,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN 'order_only' ELSE 'explicit_wall' END,
                               CASE WHEN i = {LOCAL_SEQ}
                                    THEN '2021-03-05 02:53:53,654' ELSE NULL END
                        FROM range(0, {EVENT_COUNT}) rows(i);
                        UPDATE event_revision_state
                           SET current_revision = 1,
                               previous_revision = NULL,
                               current_metadata_json = '{{}}',
                               previous_metadata_json = NULL,
                               event_count = {EVENT_COUNT},
                               wall_event_count = {EVENT_COUNT} - 1,
                               ts_min = {LOCAL_SEQ},
                               ts_max = 1700000000 + {EVENT_COUNT} - 1,
                               previous_event_count = NULL,
                               previous_wall_event_count = NULL,
                               previous_ts_min = NULL,
                               previous_ts_max = NULL
                         WHERE singleton = 1;
                        "#
                    ))
                    .map_err(|error| {
                        CoreError::Message(format!("seed sparse timezone scale corpus: {error}"))
                    })
            })
            .unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (cache, corpus_id)
    }

    #[test]
    fn preview_apply_reopen_and_clear_are_revision_bound_and_reversible() {
        let (cache, corpus_id) = fixture();
        let initial = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        assert_eq!(initial.scope.event_revision, 1);
        assert!(initial.declarations.is_empty());
        assert_eq!(initial.sources[0].unresolved_local_records, 1);
        assert_eq!(initial.sources[0].resolved_local_records, 0);

        let preview = preview_source_timezone(
            cache.path(),
            &corpus_id,
            initial.scope.event_revision,
            "server/server.log",
            "Europe/Berlin",
        )
        .unwrap();
        assert_eq!(preview.affected_records, 1);
        assert_eq!(preview.existing_wall_clock_records, 1);
        assert_eq!(preview.unchanged_order_only_records, 0);

        let applied = apply_source_timezone(
            cache.path(),
            &corpus_id,
            initial.scope.event_revision,
            "server/server.log",
            "Europe/Berlin",
            &preview.declaration_fingerprint,
            1_753_833_600,
        )
        .unwrap();
        assert_eq!(applied.revision, 2);
        assert_eq!(applied.changed_events, 1);

        let reopened = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        let declaration = reopened
            .declarations
            .get("server/server.log")
            .expect("durable declaration");
        assert_eq!(declaration.iana_timezone, "Europe/Berlin");
        assert_eq!(declaration.applied_revision, applied.revision);
        assert_eq!(reopened.sources[0].unresolved_local_records, 0);
        assert_eq!(reopened.sources[0].resolved_local_records, 1);
        assert_eq!(
            corpus_time_quality(&LogCorpus::open(cache.path(), &corpus_id).unwrap()),
            TimeQuality::Wall
        );

        let stale = apply_source_timezone(
            cache.path(),
            &corpus_id,
            initial.scope.event_revision,
            "server/server.log",
            "Europe/Berlin",
            &preview.declaration_fingerprint,
            1_753_833_601,
        )
        .unwrap_err();
        assert!(stale.to_string().contains("stale timezone apply"));

        let cleared = clear_source_timezone(
            cache.path(),
            &corpus_id,
            reopened.scope.event_revision,
            "server/server.log",
            declaration.applied_revision,
        )
        .unwrap();
        assert_eq!(cleared.revision, 3);
        let restored = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        assert!(restored.declarations.is_empty());
        assert_eq!(restored.sources[0].unresolved_local_records, 1);
        assert_eq!(restored.sources[0].resolved_local_records, 0);
        assert_eq!(
            corpus_time_quality(&LogCorpus::open(cache.path(), &corpus_id).unwrap()),
            TimeQuality::Mixed
        );

        let events = LogCorpus::open(cache.path(), &corpus_id)
            .unwrap()
            .with_events(|events| CoreResult::Ok(events.to_vec()))
            .unwrap();
        assert_eq!(events[0].ts, 0);
        assert_eq!(
            events[0].timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            events[0].active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly
        );
        assert_eq!(
            events[0].unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
        assert_eq!(events[1].ts, 1_614_912_833);
        assert_eq!(
            events[1].active_timestamp_basis,
            ActiveTimestampBasis::ExplicitWall
        );
    }

    #[test]
    fn one_row_timezone_apply_and_undo_in_250k_corpus_retain_one_row() {
        const LOCAL_SEQ: i64 = 125_000;
        const EVENT_COUNT: i64 = 250_000;
        let (cache, corpus_id) = large_sparse_fixture();
        let initial = load_timezone_resolution_state(cache.path(), &corpus_id).unwrap();
        assert_eq!(initial.scope.event_revision, 1);
        assert_eq!(initial.sources.len(), 1);
        assert_eq!(initial.sources[0].unresolved_local_records, 1);

        let preview = preview_source_timezone(
            cache.path(),
            &corpus_id,
            initial.scope.event_revision,
            "server/server.log",
            "Europe/Berlin",
        )
        .unwrap();
        assert_eq!(preview.affected_records, 1);

        let apply_started = Instant::now();
        let applied = apply_source_timezone(
            cache.path(),
            &corpus_id,
            initial.scope.event_revision,
            "server/server.log",
            "Europe/Berlin",
            &preview.declaration_fingerprint,
            1_753_833_600,
        )
        .unwrap();
        let apply_elapsed = apply_started.elapsed();
        assert_eq!(applied.changed_events, 1);
        assert_eq!(applied.event_count, EVENT_COUNT as u64);
        assert_eq!(applied.ts_min, Some(1_614_909_233));
        assert_eq!(applied.ts_max, Some(1_700_249_999));
        assert!(
            apply_elapsed < Duration::from_secs(10),
            "one-row apply exceeded bounded scale proof: {apply_elapsed:?}"
        );

        let applied_corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let retained = applied_corpus
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT
                            (SELECT COUNT(*) FROM events_previous),
                            (SELECT COUNT(*) FROM event_revision_timestamp_changes),
                            (SELECT COUNT(*) FROM information_schema.tables
                              WHERE table_name LIKE '__cd_event_revision_%'),
                            (SELECT COUNT(*) FROM events),
                            (SELECT COUNT(*) FROM events
                              WHERE active_timestamp_basis
                                    IN ('explicit_wall', 'resolved_local')),
                            (SELECT MIN(ts) FROM events),
                            (SELECT MAX(ts) FROM events),
                            (SELECT COUNT(*) FROM events
                              WHERE seq = ?1
                                AND source = 'server/server.log'
                                AND ts = 1614909233
                                AND active_timestamp_basis = 'resolved_local'),
                            (SELECT COUNT(*) FROM events
                              WHERE seq IN (0, 249999)
                                AND source = 'bulk/bulk.log'
                                AND ts = 1700000000 + seq
                                AND active_timestamp_basis = 'explicit_wall')",
                        params![LOCAL_SEQ],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, i64>(4)?,
                                row.get::<_, i64>(5)?,
                                row.get::<_, i64>(6)?,
                                row.get::<_, i64>(7)?,
                                row.get::<_, i64>(8)?,
                            ))
                        },
                    )
                    .map_err(|error| {
                        CoreError::Message(format!("inspect sparse timezone revision: {error}"))
                    })
            })
            .unwrap();
        assert_eq!(
            retained,
            (
                1,
                1,
                0,
                EVENT_COUNT,
                EVENT_COUNT,
                1_614_909_233,
                1_700_249_999,
                1,
                2
            ),
            "new revision must retain only the changed row and leave unrelated rows exact"
        );
        drop(applied_corpus);

        let undo_started = Instant::now();
        let undone = undo_event_revision(cache.path(), &corpus_id, applied.revision, None).unwrap();
        let undo_elapsed = undo_started.elapsed();
        assert_eq!(undone.changed_events, 1);
        assert_eq!(undone.event_count, EVENT_COUNT as u64);
        assert_eq!(undone.ts_min, Some(LOCAL_SEQ));
        assert_eq!(undone.ts_max, Some(1_700_249_999));
        assert!(
            undo_elapsed < Duration::from_secs(10),
            "one-row undo exceeded bounded scale proof: {undo_elapsed:?}"
        );
        eprintln!(
            "250k sparse timezone proof: apply={apply_elapsed:?} undo={undo_elapsed:?} retained_rows=1"
        );

        let restored = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let restored_state = restored
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT
                            (SELECT COUNT(*) FROM events),
                            (SELECT COUNT(*) FROM events
                              WHERE seq = ?1
                                AND source = 'server/server.log'
                                AND ts = ?1
                                AND active_timestamp_basis = 'order_only'
                                AND timestamp_provenance = 'unresolved_local'
                                AND unresolved_local_timestamp =
                                    '2021-03-05 02:53:53,654'),
                            (SELECT COUNT(*) FROM events
                              WHERE active_timestamp_basis
                                    IN ('explicit_wall', 'resolved_local')),
                            (SELECT MIN(ts) FROM events),
                            (SELECT MAX(ts) FROM events),
                            (SELECT COUNT(*) FROM information_schema.tables
                              WHERE table_name IN (
                                'events_previous',
                                'event_revision_timestamp_changes'
                              ))",
                        params![LOCAL_SEQ],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, i64>(4)?,
                                row.get::<_, i64>(5)?,
                            ))
                        },
                    )
                    .map_err(|error| {
                        CoreError::Message(format!("inspect sparse timezone undo: {error}"))
                    })
            })
            .unwrap();
        assert_eq!(
            restored_state,
            (EVENT_COUNT, 1, EVENT_COUNT - 1, LOCAL_SEQ, 1_700_249_999, 0)
        );
    }
}
