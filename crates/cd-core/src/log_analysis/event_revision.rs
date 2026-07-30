//! Atomic event-table revision foundation for log corpora (#780).
//!
//! The active `events` table remains queryable and unchanged while a complete
//! candidate table is built and validated. Publication is one DuckDB `COMMIT`
//! containing the active timestamp replacements, durable revision metadata,
//! and the retained one-step undo table. The active table identity and every
//! corpus-adjacent sidecar remain stable.

use super::store::{contained_exact_corpus_root, LogCorpus};
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::path::Path;

/// Metadata contract stored transactionally with one event revision.
pub const EVENT_REVISION_METADATA_SCHEMA_VERSION: u32 = 1;
/// Maximum serialized operation metadata retained in DuckDB.
pub const MAX_EVENT_REVISION_METADATA_BYTES: usize = 1024 * 1024;

const LOCK_DIRECTORY: &str = ".event-revision-locks";
const CANDIDATE_TABLE: &str = "__cd_event_revision_candidate";
const UPDATES_TABLE: &str = "__cd_event_revision_updates";
const PREVIOUS_TABLE: &str = "events_previous";
const MAX_OPERATION_BYTES: usize = 96;
const MAX_SOURCE_BYTES: usize = 4 * 1024;

/// One exact timestamp replacement.
///
/// `seq`, `source`, and `expected_ts` bind the update to the active event.
/// Every other event field, including the separately redacted original
/// representation, is copied and validated unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTimestampUpdate {
    /// Corpus-local stable sequence identity.
    pub seq: u64,
    /// Portable corpus-relative source identity.
    pub source: String,
    /// Timestamp/order value expected in the active revision.
    pub expected_ts: i64,
    /// Replacement timestamp produced by a separately validated resolver.
    pub revised_ts: i64,
}

/// Bounded derived metadata published with an event revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRevisionMetadata {
    /// Metadata schema understood by this build.
    pub schema_version: u32,
    /// Stable operation kind, such as a future timezone-resolution action.
    pub operation: String,
    /// Operation-specific derived state. It is size-bounded and JSON-only.
    #[serde(default)]
    pub details: Value,
}

/// Successful event-revision publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRevisionReport {
    /// Newly active durable event revision.
    pub revision: u64,
    /// Revision retained for one-step undo.
    pub previous_revision: u64,
    /// Exact number of timestamp replacements.
    pub changed_events: u64,
    /// Exact event count after publication.
    pub event_count: u64,
    /// Earliest active timestamp/order value.
    pub ts_min: Option<i64>,
    /// Latest active timestamp/order value.
    pub ts_max: Option<i64>,
}

struct EventRevisionGuard {
    _file: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventRevisionCheckpoint {
    CandidateReady,
    ActiveEventsChanged,
    BeforeCommit,
    UndoEventsChanged,
}

type FaultHook<'a> = Option<&'a dyn Fn(EventRevisionCheckpoint) -> CoreResult<()>>;

fn check_fault(hook: FaultHook<'_>, checkpoint: EventRevisionCheckpoint) -> CoreResult<()> {
    if let Some(hook) = hook {
        hook(checkpoint)?;
    }
    Ok(())
}

fn busy_error() -> CoreError {
    CoreError::Message(
        "event re-analysis is already in progress; retry after the active revision finishes".into(),
    )
}

fn revision_guard(corpus_root: &Path, corpus_id: &str) -> CoreResult<EventRevisionGuard> {
    let corpora_root = corpus_root
        .parent()
        .ok_or_else(|| CoreError::Message("event revision corpus root has no parent".into()))?;
    let lock_root = corpora_root.join(LOCK_DIRECTORY);
    std::fs::create_dir_all(&lock_root)
        .map_err(|error| CoreError::Message(format!("create event revision lock root: {error}")))?;
    let metadata = std::fs::symlink_metadata(&lock_root).map_err(|error| {
        CoreError::Message(format!("inspect event revision lock root: {error}"))
    })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(CoreError::Message(
            "event revision lock root must be a real directory".into(),
        ));
    }
    let file = open_regular_nofollow(&lock_root.join(format!("{corpus_id}.lock")))?;
    file.try_lock().map_err(|_| busy_error())?;
    Ok(EventRevisionGuard { _file: file })
}

fn open_regular_nofollow(path: &Path) -> CoreResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| CoreError::Message(format!("open event revision lock: {error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| CoreError::Message(format!("inspect event revision lock: {error}")))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(CoreError::Message(
            "event revision lock must be a regular non-symlink file".into(),
        ));
    }
    Ok(file)
}

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.is_some_and(CancelFlag::is_cancelled)
}

fn validate_metadata(metadata: &EventRevisionMetadata) -> CoreResult<String> {
    if metadata.schema_version != EVENT_REVISION_METADATA_SCHEMA_VERSION {
        return Err(CoreError::Message(format!(
            "unsupported event revision metadata schema {}",
            metadata.schema_version
        )));
    }
    if metadata.operation.is_empty()
        || metadata.operation.len() > MAX_OPERATION_BYTES
        || !metadata
            .operation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(CoreError::Message(
            "event revision operation must be 1-96 safe ASCII characters".into(),
        ));
    }
    let encoded = serde_json::to_string(metadata)?;
    if encoded.len() > MAX_EVENT_REVISION_METADATA_BYTES {
        return Err(CoreError::Message(format!(
            "event revision metadata exceeds {MAX_EVENT_REVISION_METADATA_BYTES} bytes"
        )));
    }
    Ok(encoded)
}

fn validate_update(update: &EventTimestampUpdate) -> CoreResult<()> {
    if update.seq > i64::MAX as u64 {
        return Err(CoreError::Message(
            "event revision sequence exceeds signed storage range".into(),
        ));
    }
    if update.source.is_empty()
        || update.source.len() > MAX_SOURCE_BYTES
        || update.source.contains('\0')
    {
        return Err(CoreError::Message(
            "event revision source identity is empty or too long".into(),
        ));
    }
    if update.expected_ts == update.revised_ts {
        return Err(CoreError::Message(
            "event revision update must change the timestamp".into(),
        ));
    }
    Ok(())
}

fn begin(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch("BEGIN TRANSACTION")
        .map_err(|error| CoreError::Message(format!("begin event revision: {error}")))
}

fn rollback(conn: &Connection) {
    let _ = conn.execute_batch("ROLLBACK");
}

fn ensure_revision_state(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS event_revision_state (
            singleton INTEGER PRIMARY KEY,
            current_revision BIGINT NOT NULL,
            previous_revision BIGINT,
            current_metadata_json VARCHAR NOT NULL,
            previous_metadata_json VARCHAR,
            event_count BIGINT NOT NULL,
            ts_min BIGINT,
            ts_max BIGINT,
            previous_event_count BIGINT,
            previous_ts_min BIGINT,
            previous_ts_max BIGINT
        );
        INSERT INTO event_revision_state
        SELECT 1, 0, NULL, '{}', NULL,
               stats.event_count, stats.ts_min, stats.ts_max,
               NULL, NULL, NULL
        FROM (
            SELECT COUNT(*) AS event_count, MIN(ts) AS ts_min, MAX(ts) AS ts_max
            FROM events
        ) stats
        WHERE NOT EXISTS (
            SELECT 1 FROM event_revision_state WHERE singleton = 1
        );
        "#,
    )
    .map_err(|error| CoreError::Message(format!("prepare event revision state: {error}")))?;
    Ok(())
}

fn current_revision(conn: &Connection) -> CoreResult<u64> {
    let revision = conn
        .query_row(
            "SELECT current_revision FROM event_revision_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CoreError::Message(format!("read event revision state: {error}")))?;
    u64::try_from(revision)
        .map_err(|_| CoreError::Message("event revision state is outside supported range".into()))
}

fn next_revision(current: u64) -> CoreResult<u64> {
    let next = current
        .checked_add(1)
        .ok_or_else(|| CoreError::Message("event revision overflow".into()))?;
    if next > i64::MAX as u64 {
        return Err(CoreError::Message("event revision overflow".into()));
    }
    Ok(next)
}

fn create_candidate(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(&format!(
        r#"
        DROP TABLE IF EXISTS {CANDIDATE_TABLE};
        DROP TABLE IF EXISTS {UPDATES_TABLE};
        CREATE TABLE {CANDIDATE_TABLE} (
            seq BIGINT NOT NULL,
            ts BIGINT NOT NULL,
            level VARCHAR NOT NULL,
            service VARCHAR,
            host VARCHAR,
            template_id BIGINT NOT NULL,
            params VARCHAR NOT NULL,
            trace_id VARCHAR,
            message VARCHAR NOT NULL,
            source VARCHAR NOT NULL,
            original_redacted VARCHAR,
            original_source_bytes BIGINT,
            original_redacted_chars BIGINT,
            original_truncated BOOLEAN,
            original_encoding_normalized BOOLEAN,
            original_redaction_applied BOOLEAN
        );
        INSERT INTO {CANDIDATE_TABLE}
        SELECT seq, ts, level, service, host, template_id, params, trace_id,
               message, source, original_redacted, original_source_bytes,
               original_redacted_chars, original_truncated,
               original_encoding_normalized, original_redaction_applied
        FROM events;
        CREATE TABLE {UPDATES_TABLE} (
            seq BIGINT NOT NULL,
            source VARCHAR NOT NULL,
            expected_ts BIGINT NOT NULL,
            revised_ts BIGINT NOT NULL,
            PRIMARY KEY (seq, source)
        );
        "#
    ))
    .map_err(|error| CoreError::Message(format!("stage event revision: {error}")))?;
    Ok(())
}

fn stage_updates<I>(conn: &Connection, updates: I, cancel: Option<&CancelFlag>) -> CoreResult<u64>
where
    I: IntoIterator<Item = EventTimestampUpdate>,
{
    let mut count = 0u64;
    let mut statement = conn
        .prepare(&format!(
            "INSERT INTO {UPDATES_TABLE} (seq, source, expected_ts, revised_ts)
             VALUES (?1, ?2, ?3, ?4)"
        ))
        .map_err(|error| CoreError::Message(format!("prepare event revision updates: {error}")))?;
    for update in updates {
        if count.is_multiple_of(1_024) && cancelled(cancel) {
            return Err(CoreError::Message(
                "event re-analysis cancelled before publication".into(),
            ));
        }
        validate_update(&update)?;
        statement
            .execute(params![
                update.seq as i64,
                update.source,
                update.expected_ts,
                update.revised_ts
            ])
            .map_err(|error| {
                CoreError::Message(format!(
                    "event revision repeats or cannot stage an event identity: {error}"
                ))
            })?;
        count = count
            .checked_add(1)
            .ok_or_else(|| CoreError::Message("event revision update count overflow".into()))?;
    }
    drop(statement);
    if count == 0 {
        return Err(CoreError::Message(
            "event revision requires at least one timestamp update".into(),
        ));
    }
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "event re-analysis cancelled before publication".into(),
        ));
    }
    Ok(count)
}

fn apply_and_validate_candidate(conn: &Connection, update_count: u64) -> CoreResult<()> {
    let exact_matches = conn
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM {UPDATES_TABLE} updates
                 JOIN events active
                   ON active.seq = updates.seq
                  AND active.source = updates.source
                  AND active.ts = updates.expected_ts"
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CoreError::Message(format!("validate event revision identities: {error}"))
        })?;
    if exact_matches != update_count as i64 {
        return Err(CoreError::Message(format!(
            "event revision identity conflict: expected {update_count} exact events, found {exact_matches}"
        )));
    }

    conn.execute(
        &format!(
            "UPDATE {CANDIDATE_TABLE} candidate
             SET ts = updates.revised_ts
             FROM {UPDATES_TABLE} updates
             WHERE candidate.seq = updates.seq
               AND candidate.source = updates.source
               AND candidate.ts = updates.expected_ts"
        ),
        [],
    )
    .map_err(|error| CoreError::Message(format!("apply staged event timestamps: {error}")))?;

    let identity_differences = conn
        .query_row(
            &format!(
                r#"
                SELECT COUNT(*) FROM (
                    (
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied
                        FROM events
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied
                        FROM {CANDIDATE_TABLE}
                    )
                    UNION ALL
                    (
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied
                        FROM {CANDIDATE_TABLE}
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied
                        FROM events
                    )
                )
                "#
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CoreError::Message(format!("validate event revision payloads: {error}"))
        })?;
    if identity_differences != 0 {
        return Err(CoreError::Message(
            "event revision changed non-timestamp event identity or payload".into(),
        ));
    }
    Ok(())
}

fn active_stats(conn: &Connection, table: &str) -> CoreResult<(u64, Option<i64>, Option<i64>)> {
    let (count, ts_min, ts_max) = conn
        .query_row(
            &format!("SELECT COUNT(*), MIN(ts), MAX(ts) FROM {table}"),
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(|error| CoreError::Message(format!("read event revision statistics: {error}")))?;
    let count = u64::try_from(count).map_err(|_| {
        CoreError::Message("event revision count is outside supported range".into())
    })?;
    Ok((count, ts_min, ts_max))
}

/// Stage, validate, and atomically publish exact timestamp replacements.
///
/// A conflict, cancellation, validation error, or publication error rolls the
/// DuckDB transaction back. The previous `events` table is retained for one
/// successful [`undo_event_revision`] call.
pub fn apply_event_timestamp_revision<I>(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    metadata: EventRevisionMetadata,
    updates: I,
    cancel: Option<&CancelFlag>,
) -> CoreResult<EventRevisionReport>
where
    I: IntoIterator<Item = EventTimestampUpdate>,
{
    apply_event_timestamp_revision_inner(
        cache_root,
        corpus_id,
        expected_revision,
        metadata,
        updates,
        cancel,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_event_timestamp_revision_inner<I>(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    metadata: EventRevisionMetadata,
    updates: I,
    cancel: Option<&CancelFlag>,
    fault: FaultHook<'_>,
) -> CoreResult<EventRevisionReport>
where
    I: IntoIterator<Item = EventTimestampUpdate>,
{
    let metadata_json = validate_metadata(&metadata)?;
    let corpus_root = contained_exact_corpus_root(cache_root, corpus_id)?;
    let _guard = revision_guard(&corpus_root, corpus_id)?;
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "event re-analysis cancelled before staging".into(),
        ));
    }
    let corpus = LogCorpus::open(cache_root, corpus_id)?;

    corpus.with_connection(|conn| {
        begin(conn)?;
        let result = (|| {
            ensure_revision_state(conn)?;
            let previous_revision = current_revision(conn)?;
            if previous_revision != expected_revision {
                return Err(CoreError::Message(format!(
                    "stale event revision: expected {expected_revision}, current {previous_revision}"
                )));
            }
            let revision = next_revision(previous_revision)?;
            create_candidate(conn)?;
            let changed_events = stage_updates(conn, updates, cancel)?;
            apply_and_validate_candidate(conn, changed_events)?;
            let (event_count, ts_min, ts_max) = active_stats(conn, CANDIDATE_TABLE)?;
            check_fault(fault, EventRevisionCheckpoint::CandidateReady)?;
            if cancelled(cancel) {
                return Err(CoreError::Message(
                    "event re-analysis cancelled before publication".into(),
                ));
            }

            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {PREVIOUS_TABLE};"
            ))
            .map_err(|error| {
                CoreError::Message(format!("remove obsolete event revision: {error}"))
            })?;
            conn.execute_batch(&format!(
                "CREATE TABLE {PREVIOUS_TABLE} AS
                     SELECT * FROM events;
                 UPDATE events active
                    SET ts = candidate.ts
                   FROM {CANDIDATE_TABLE} candidate
                  WHERE active.seq = candidate.seq
                    AND active.source = candidate.source;
                 DROP TABLE {CANDIDATE_TABLE};
                 DROP TABLE {UPDATES_TABLE};"
            ))
            .map_err(|error| CoreError::Message(format!("publish staged events: {error}")))?;
            conn.execute(
                "UPDATE event_revision_state
                 SET previous_revision = current_revision,
                     previous_metadata_json = current_metadata_json,
                     previous_event_count = event_count,
                     previous_ts_min = ts_min,
                     previous_ts_max = ts_max,
                     current_revision = ?1,
                     current_metadata_json = ?2,
                     event_count = ?3,
                     ts_min = ?4,
                     ts_max = ?5
                 WHERE singleton = 1",
                params![
                    revision as i64,
                    metadata_json,
                    event_count as i64,
                    ts_min,
                    ts_max
                ],
            )
            .map_err(|error| {
                CoreError::Message(format!("publish event revision metadata: {error}"))
            })?;
            check_fault(fault, EventRevisionCheckpoint::ActiveEventsChanged)?;
            check_fault(fault, EventRevisionCheckpoint::BeforeCommit)?;
            conn.execute_batch("COMMIT")
                .map_err(|error| CoreError::Message(format!("commit event revision: {error}")))?;
            corpus.publish_event_revision(revision);
            Ok(EventRevisionReport {
                revision,
                previous_revision,
                changed_events,
                event_count,
                ts_min,
                ts_max,
            })
        })();
        if result.is_err() {
            rollback(conn);
        }
        result
    })
}

/// Atomically restore the single retained prior event revision.
pub fn undo_event_revision(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    cancel: Option<&CancelFlag>,
) -> CoreResult<EventRevisionReport> {
    undo_event_revision_inner(cache_root, corpus_id, expected_revision, cancel, None)
}

fn undo_event_revision_inner(
    cache_root: &Path,
    corpus_id: &str,
    expected_revision: u64,
    cancel: Option<&CancelFlag>,
    fault: FaultHook<'_>,
) -> CoreResult<EventRevisionReport> {
    let corpus_root = contained_exact_corpus_root(cache_root, corpus_id)?;
    let _guard = revision_guard(&corpus_root, corpus_id)?;
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "event revision undo cancelled before publication".into(),
        ));
    }
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    corpus.with_connection(|conn| {
        begin(conn)?;
        let result = (|| {
            ensure_revision_state(conn)?;
            let current = current_revision(conn)?;
            if current != expected_revision {
                return Err(CoreError::Message(format!(
                    "stale event revision: expected {expected_revision}, current {current}"
                )));
            }
            let previous = conn
                .query_row(
                    "SELECT previous_revision
                     FROM event_revision_state
                     WHERE singleton = 1",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(|error| {
                    CoreError::Message(format!("read retained event revision: {error}"))
                })?
                .ok_or_else(|| {
                    CoreError::Message("no prior event revision is available to undo".into())
                })?;
            let previous = u64::try_from(previous).map_err(|_| {
                CoreError::Message("retained event revision is outside supported range".into())
            })?;
            if previous >= current {
                return Err(CoreError::Message(
                    "retained event revision is not older than the active revision".into(),
                ));
            }
            let revision = next_revision(current)?;
            let (event_count, ts_min, ts_max) = conn
                .query_row(
                    "SELECT previous_event_count, previous_ts_min, previous_ts_max
                     FROM event_revision_state
                     WHERE singleton = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .map_err(|error| {
                    CoreError::Message(format!("read retained event statistics: {error}"))
                })?;
            let event_count = event_count
                .and_then(|count| u64::try_from(count).ok())
                .ok_or_else(|| {
                    CoreError::Message("retained event count is unavailable or invalid".into())
                })?;
            let retained_stats = active_stats(conn, PREVIOUS_TABLE)?;
            if retained_stats != (event_count, ts_min, ts_max) {
                return Err(CoreError::Message(
                    "retained event revision does not match its published statistics".into(),
                ));
            }

            let active_stats = active_stats(conn, "events")?;
            let expected_current_stats = conn
                .query_row(
                    "SELECT event_count, ts_min, ts_max
                     FROM event_revision_state
                     WHERE singleton = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .map_err(|error| {
                    CoreError::Message(format!("read active event statistics: {error}"))
                })?;
            let expected_current_count = u64::try_from(expected_current_stats.0).map_err(|_| {
                CoreError::Message("active event count is outside supported range".into())
            })?;
            if active_stats
                != (
                    expected_current_count,
                    expected_current_stats.1,
                    expected_current_stats.2,
                )
            {
                return Err(CoreError::Message(
                    "active events changed after revision publication; undo refused".into(),
                ));
            }
            let changed_events = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*)
                         FROM events active
                         JOIN {PREVIOUS_TABLE} previous
                           ON active.seq = previous.seq
                          AND active.source = previous.source
                         WHERE active.ts <> previous.ts"
                    ),
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| {
                    CoreError::Message(format!("count retained timestamp changes: {error}"))
                })
                .and_then(|count| {
                    u64::try_from(count).map_err(|_| {
                        CoreError::Message(
                            "retained timestamp change count is outside supported range".into(),
                        )
                    })
                })?;
            conn.execute_batch(&format!(
                "DELETE FROM events;
                 INSERT INTO events
                 SELECT * FROM {PREVIOUS_TABLE};
                 DROP TABLE {PREVIOUS_TABLE};"
            ))
            .map_err(|error| {
                CoreError::Message(format!("restore retained event revision: {error}"))
            })?;
            conn.execute(
                "UPDATE event_revision_state
                 SET current_revision = ?1,
                     current_metadata_json = previous_metadata_json,
                     event_count = previous_event_count,
                     ts_min = previous_ts_min,
                     ts_max = previous_ts_max,
                     previous_revision = NULL,
                     previous_metadata_json = NULL,
                     previous_event_count = NULL,
                     previous_ts_min = NULL,
                     previous_ts_max = NULL
                 WHERE singleton = 1",
                params![revision as i64],
            )
            .map_err(|error| {
                CoreError::Message(format!("restore event revision metadata: {error}"))
            })?;
            check_fault(fault, EventRevisionCheckpoint::UndoEventsChanged)?;
            check_fault(fault, EventRevisionCheckpoint::BeforeCommit)?;
            conn.execute_batch("COMMIT").map_err(|error| {
                CoreError::Message(format!("commit event revision undo: {error}"))
            })?;
            corpus.publish_event_revision(revision);
            Ok(EventRevisionReport {
                revision,
                previous_revision: current,
                changed_events,
                event_count,
                ts_min,
                ts_max,
            })
        })();
        if result.is_err() {
            rollback(conn);
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{ingest_path, query_event_count, EventQuery};
    use std::collections::BTreeMap;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    fn fixture() -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let source = cache.path().join("app.log");
        std::fs::write(
            &source,
            "ts=1700000000 level=info msg=started\n\
             ts=1700000010 level=error msg=failed\n\
             ts=1700000020 level=warn msg=recovering\n",
        )
        .expect("write source");
        let report = ingest_path(
            cache.path(),
            &source,
            "event revision fixture",
            None,
            "none",
        )
        .unwrap();
        let root = cache.path().join("log_corpora").join(&report.corpus_id);
        std::fs::write(root.join("bookmarks.json"), b"bookmark-sidecar").unwrap();
        std::fs::write(root.join("suppression.json"), b"suppression-sidecar").unwrap();
        std::fs::write(
            root.join("operational-metrics-attachment.v1.json"),
            b"metrics-sidecar",
        )
        .unwrap();
        (cache, report.corpus_id)
    }

    fn root(cache: &Path, corpus_id: &str) -> PathBuf {
        cache.join("log_corpora").join(corpus_id)
    }

    fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        for entry in std::fs::read_dir(root).expect("read corpus root") {
            let entry = entry.expect("entry");
            if entry.file_type().expect("type").is_file() {
                files.insert(
                    entry.file_name().to_string_lossy().to_string(),
                    std::fs::read(entry.path()).expect("read corpus file"),
                );
            }
        }
        files
    }

    fn is_corpus_sidecar(name: &str) -> bool {
        !matches!(name, "events.duckdb" | "events.duckdb.wal")
    }

    fn metadata() -> EventRevisionMetadata {
        EventRevisionMetadata {
            schema_version: EVENT_REVISION_METADATA_SCHEMA_VERSION,
            operation: "test_timestamp_resolution".into(),
            details: serde_json::json!({
                "source": "app.log",
                "provenance": "user_declared"
            }),
        }
    }

    fn update(seq: u64, expected_ts: i64, revised_ts: i64) -> EventTimestampUpdate {
        EventTimestampUpdate {
            seq,
            source: "app.log".into(),
            expected_ts,
            revised_ts,
        }
    }

    fn event_snapshot(cache: &Path, corpus_id: &str) -> Vec<super::super::LogEvent> {
        let corpus = LogCorpus::open(cache, corpus_id).expect("open corpus");
        corpus
            .with_events(|events| CoreResult::Ok(events.to_vec()))
            .expect("events")
    }

    #[test]
    fn faults_before_and_during_publish_restore_exact_active_bytes() {
        for checkpoint in [
            EventRevisionCheckpoint::CandidateReady,
            EventRevisionCheckpoint::ActiveEventsChanged,
            EventRevisionCheckpoint::BeforeCommit,
        ] {
            let (cache, corpus_id) = fixture();
            let corpus_root = root(cache.path(), &corpus_id);
            let _already_open = LogCorpus::open(cache.path(), &corpus_id).unwrap();
            let bytes_before = snapshot(&corpus_root);
            let events_before = event_snapshot(cache.path(), &corpus_id);
            let fault = |actual| {
                if actual == checkpoint {
                    Err(CoreError::Message("injected event revision fault".into()))
                } else {
                    Ok(())
                }
            };
            let result = apply_event_timestamp_revision_inner(
                cache.path(),
                &corpus_id,
                0,
                metadata(),
                [update(1, 1_700_000_010, 1_700_003_610)],
                None,
                Some(&fault),
            );
            assert!(result.is_err(), "{checkpoint:?}");
            assert_eq!(snapshot(&corpus_root), bytes_before, "{checkpoint:?}");
            assert_eq!(
                serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
                serde_json::to_value(&events_before).unwrap(),
                "{checkpoint:?}"
            );
        }
    }

    #[test]
    fn cancellation_and_interrupted_publication_leave_no_active_change() {
        let (cache, corpus_id) = fixture();
        let corpus_root = root(cache.path(), &corpus_id);
        let bytes_before = snapshot(&corpus_root);
        let events_before = event_snapshot(cache.path(), &corpus_id);
        let cancel = CancelFlag::new();
        let mut yielded = 0usize;
        let cancel_from_iterator = cancel.clone();
        let updates = std::iter::from_fn(move || {
            yielded += 1;
            match yielded {
                1 => Some(update(0, 1_700_000_000, 1_700_003_600)),
                2 => {
                    cancel_from_iterator.cancel();
                    Some(update(1, 1_700_000_010, 1_700_003_610))
                }
                _ => None,
            }
        });
        let cancelled = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            0,
            metadata(),
            updates,
            Some(&cancel),
        );
        assert!(cancelled.is_err());
        assert_eq!(snapshot(&corpus_root), bytes_before);
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&events_before).unwrap()
        );

        let panic_hook = |checkpoint| {
            if checkpoint == EventRevisionCheckpoint::ActiveEventsChanged {
                panic!("simulated process interruption before commit");
            }
            Ok(())
        };
        let interrupted = catch_unwind(AssertUnwindSafe(|| {
            let _ = apply_event_timestamp_revision_inner(
                cache.path(),
                &corpus_id,
                0,
                metadata(),
                [update(1, 1_700_000_010, 1_700_003_610)],
                None,
                Some(&panic_hook),
            );
        }));
        assert!(interrupted.is_err());
        assert_eq!(snapshot(&corpus_root), bytes_before);
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&events_before).unwrap()
        );
    }

    #[test]
    fn successful_publish_preserves_identity_sidecars_and_supports_one_step_undo() {
        let (cache, corpus_id) = fixture();
        let corpus_root = root(cache.path(), &corpus_id);
        let events_before = event_snapshot(cache.path(), &corpus_id);
        let already_open = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let initial_window = query_event_count(
            &already_open,
            &EventQuery {
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_001_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(initial_window.total_matched, 3);
        let sidecars_before = snapshot(&corpus_root)
            .into_iter()
            .filter(|(name, _)| is_corpus_sidecar(name))
            .collect::<BTreeMap<_, _>>();

        let report = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            0,
            metadata(),
            [
                update(0, 1_700_000_000, 1_700_003_600),
                update(1, 1_700_000_010, 1_700_003_610),
            ],
            None,
        )
        .expect("publish revision");
        assert_eq!(report.revision, 1);
        assert_eq!(report.previous_revision, 0);
        assert_eq!(report.changed_events, 2);
        assert_eq!(report.event_count, 3);
        assert_eq!(report.ts_min, Some(1_700_000_020));
        assert_eq!(report.ts_max, Some(1_700_003_610));
        let revised_window = query_event_count(
            &already_open,
            &EventQuery {
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_001_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            revised_window.total_matched, 1,
            "an already-open corpus handle must reject its cached old time-window count"
        );

        let events_after = event_snapshot(cache.path(), &corpus_id);
        assert_eq!(events_after[0].ts, 1_700_003_600);
        assert_eq!(events_after[1].ts, 1_700_003_610);
        for (before, after) in events_before.iter().zip(&events_after) {
            assert_eq!(before.seq, after.seq);
            assert_eq!(before.source, after.source);
            assert_eq!(before.level, after.level);
            assert_eq!(before.service, after.service);
            assert_eq!(before.host, after.host);
            assert_eq!(before.template_id, after.template_id);
            assert_eq!(before.params, after.params);
            assert_eq!(before.trace_id, after.trace_id);
            assert_eq!(before.message, after.message);
        }
        let sidecars_after = snapshot(&corpus_root)
            .into_iter()
            .filter(|(name, _)| is_corpus_sidecar(name))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(sidecars_after, sidecars_before);

        let undone = undo_event_revision(cache.path(), &corpus_id, 1, None).expect("undo revision");
        assert_eq!(undone.revision, 2);
        assert_eq!(undone.previous_revision, 1);
        assert_eq!(undone.changed_events, 2);
        assert_eq!(undone.event_count, 3);
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&events_before).unwrap(),
            "undo must restore the complete prior event set"
        );
        let second_undo = undo_event_revision(cache.path(), &corpus_id, 2, None);
        assert!(second_undo
            .unwrap_err()
            .to_string()
            .contains("no prior event revision"));
    }

    #[test]
    fn undo_faults_restore_exact_revised_bytes_and_events() {
        for checkpoint in [
            EventRevisionCheckpoint::UndoEventsChanged,
            EventRevisionCheckpoint::BeforeCommit,
        ] {
            let (cache, corpus_id) = fixture();
            apply_event_timestamp_revision(
                cache.path(),
                &corpus_id,
                0,
                metadata(),
                [update(1, 1_700_000_010, 1_700_003_610)],
                None,
            )
            .expect("publish revision");
            let corpus_root = root(cache.path(), &corpus_id);
            let bytes_before = snapshot(&corpus_root);
            let events_before = event_snapshot(cache.path(), &corpus_id);
            let fault = |actual| {
                if actual == checkpoint {
                    Err(CoreError::Message("injected undo fault".into()))
                } else {
                    Ok(())
                }
            };
            let result = undo_event_revision_inner(cache.path(), &corpus_id, 1, None, Some(&fault));
            assert!(result.is_err(), "{checkpoint:?}");
            assert_eq!(snapshot(&corpus_root), bytes_before, "{checkpoint:?}");
            assert_eq!(
                serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
                serde_json::to_value(&events_before).unwrap(),
                "{checkpoint:?}"
            );
        }
    }

    #[test]
    fn concurrent_attempt_fails_visibly_without_racing_publication() {
        let (cache, corpus_id) = fixture();
        let cache_path = cache.path().to_path_buf();
        let worker_id = corpus_id.clone();
        let candidate_ready = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let worker_ready = Arc::clone(&candidate_ready);
        let worker_release = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            let hook = |checkpoint| {
                if checkpoint == EventRevisionCheckpoint::CandidateReady {
                    worker_ready.wait();
                    worker_release.wait();
                }
                Ok(())
            };
            apply_event_timestamp_revision_inner(
                &cache_path,
                &worker_id,
                0,
                metadata(),
                [update(0, 1_700_000_000, 1_700_003_600)],
                None,
                Some(&hook),
            )
        });

        candidate_ready.wait();
        let conflict = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            0,
            metadata(),
            [update(1, 1_700_000_010, 1_700_003_610)],
            None,
        )
        .unwrap_err();
        assert!(conflict
            .to_string()
            .contains("event re-analysis is already in progress"));
        release.wait();
        assert_eq!(worker.join().expect("worker").expect("publish").revision, 1);
    }

    #[test]
    fn identity_conflict_fails_before_publication() {
        let (cache, corpus_id) = fixture();
        let corpus_root = root(cache.path(), &corpus_id);
        let bytes_before = snapshot(&corpus_root);
        let conflict = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            0,
            metadata(),
            [update(1, 123, 1_700_003_610)],
            None,
        )
        .unwrap_err();
        assert!(conflict.to_string().contains("identity conflict"));
        assert_eq!(snapshot(&corpus_root), bytes_before);
    }
}
