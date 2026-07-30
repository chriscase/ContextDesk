//! Atomic event-table revision foundation for log corpora (#780).
//!
//! The active `events` table remains queryable and unchanged while a complete
//! candidate table is built and validated. Publication is one DuckDB `COMMIT`
//! containing the active timestamp replacements, durable revision metadata,
//! and the retained one-step undo table. The active table identity and every
//! corpus-adjacent sidecar remain stable.

use super::parse::{ActiveTimestampBasis, TimestampProvenance};
use super::query::TimeQuality;
use super::store::{contained_exact_corpus_root, LogCorpus};
use crate::error::{CoreError, CoreResult};
use crate::process_progress::CancelFlag;
use duckdb::{params, types::Value as DuckValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::path::Path;

/// Metadata contract stored transactionally with one event revision.
pub const EVENT_REVISION_METADATA_SCHEMA_VERSION: u32 = 1;
/// Retained timestamp-change evidence schema understood by this build.
pub const EVENT_REVISION_AUDIT_SCHEMA_VERSION: u32 = 1;
/// Maximum serialized operation metadata retained in DuckDB.
pub const MAX_EVENT_REVISION_METADATA_BYTES: usize = 1024 * 1024;

const LOCK_DIRECTORY: &str = ".event-revision-locks";
const CANDIDATE_TABLE: &str = "__cd_event_revision_candidate";
const UPDATES_TABLE: &str = "__cd_event_revision_updates";
const PREVIOUS_TABLE: &str = "events_previous";
const TIMESTAMP_CHANGES_TABLE: &str = "event_revision_timestamp_changes";
const MAX_OPERATION_BYTES: usize = 96;
const MAX_SOURCE_BYTES: usize = 4 * 1024;

/// One durable evidence hint that may be explained by the retained,
/// transactionally published timestamp-only revision.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct EventReferenceTimestampHint {
    pub(crate) seq: u64,
    pub(crate) source: String,
    pub(crate) timestamp_hint: i64,
    pub(crate) time_quality_hint: TimeQuality,
}

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
    /// Active interpretation expected in the active revision.
    pub expected_active_timestamp_basis: ActiveTimestampBasis,
    /// Immutable parser provenance expected in the active revision.
    pub expected_timestamp_provenance: TimestampProvenance,
    /// Immutable parser-recognized local timestamp expected in the active revision.
    pub expected_unresolved_local_timestamp: Option<String>,
    /// Replacement timestamp produced by a separately validated resolver.
    pub revised_ts: i64,
    /// Active interpretation published with `revised_ts`.
    pub revised_active_timestamp_basis: ActiveTimestampBasis,
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
    const MAX_LOCAL_TIMESTAMP_BYTES: usize = 256;
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
    let local_text_is_valid = update
        .expected_unresolved_local_timestamp
        .as_deref()
        .is_some_and(|value| {
            !value.is_empty() && value.len() <= MAX_LOCAL_TIMESTAMP_BYTES && !value.contains('\0')
        });
    let supported_transition = match update.expected_timestamp_provenance {
        TimestampProvenance::ExplicitWallClock => {
            update.expected_unresolved_local_timestamp.is_none()
                && update.expected_active_timestamp_basis == ActiveTimestampBasis::ExplicitWall
                && update.revised_active_timestamp_basis == ActiveTimestampBasis::ExplicitWall
        }
        TimestampProvenance::UnresolvedLocal => {
            local_text_is_valid
                && matches!(
                    (
                        update.expected_active_timestamp_basis,
                        update.revised_active_timestamp_basis
                    ),
                    (
                        ActiveTimestampBasis::OrderOnly,
                        ActiveTimestampBasis::ResolvedLocal
                    ) | (
                        ActiveTimestampBasis::ResolvedLocal,
                        ActiveTimestampBasis::ResolvedLocal | ActiveTimestampBasis::OrderOnly
                    )
                )
                && (update.expected_active_timestamp_basis != ActiveTimestampBasis::OrderOnly
                    || update.expected_ts == update.seq as i64)
                && (update.revised_active_timestamp_basis != ActiveTimestampBasis::OrderOnly
                    || update.revised_ts == update.seq as i64)
        }
        TimestampProvenance::OrderOnly | TimestampProvenance::LegacyUnknown => false,
    };
    if !supported_transition {
        return Err(CoreError::Message(
            "event revision active timestamp basis transition is unsupported".into(),
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
            wall_event_count BIGINT NOT NULL,
            ts_min BIGINT,
            ts_max BIGINT,
            previous_event_count BIGINT,
            previous_wall_event_count BIGINT,
            previous_ts_min BIGINT,
            previous_ts_max BIGINT
        );
        ALTER TABLE event_revision_state
            ADD COLUMN IF NOT EXISTS wall_event_count BIGINT;
        ALTER TABLE event_revision_state
            ADD COLUMN IF NOT EXISTS previous_wall_event_count BIGINT;
        INSERT INTO event_revision_state
        SELECT 1, 0, NULL, '{}', NULL,
               stats.event_count, stats.wall_event_count,
               stats.ts_min, stats.ts_max,
               NULL, NULL, NULL, NULL
        FROM (
            SELECT COUNT(*) AS event_count,
                   COALESCE(SUM(
                       CASE WHEN active_timestamp_basis
                                      IN ('explicit_wall', 'resolved_local')
                            THEN 1 ELSE 0 END
                   ), 0) AS wall_event_count,
                   MIN(ts) AS ts_min,
                   MAX(ts) AS ts_max
            FROM events
        ) stats
        WHERE NOT EXISTS (
            SELECT 1 FROM event_revision_state WHERE singleton = 1
        );
        UPDATE event_revision_state
        SET wall_event_count = (
            SELECT COALESCE(SUM(
                CASE WHEN active_timestamp_basis
                               IN ('explicit_wall', 'resolved_local')
                     THEN 1 ELSE 0 END
            ), 0)
            FROM events
        )
        WHERE wall_event_count IS NULL;
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
        CREATE TABLE {CANDIDATE_TABLE} AS SELECT * FROM events;
        CREATE TABLE {UPDATES_TABLE} (
            seq BIGINT NOT NULL,
            source VARCHAR NOT NULL,
            expected_ts BIGINT NOT NULL,
            expected_active_timestamp_basis VARCHAR NOT NULL,
            expected_timestamp_provenance VARCHAR NOT NULL,
            expected_unresolved_local_timestamp VARCHAR,
            revised_ts BIGINT NOT NULL,
            revised_active_timestamp_basis VARCHAR NOT NULL,
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
            "INSERT INTO {UPDATES_TABLE}
                (seq, source, expected_ts, expected_active_timestamp_basis,
                 expected_timestamp_provenance,
                 expected_unresolved_local_timestamp,
                 revised_ts, revised_active_timestamp_basis)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
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
                update.expected_active_timestamp_basis.as_storage_str(),
                update.expected_timestamp_provenance.as_storage_str(),
                update.expected_unresolved_local_timestamp.as_deref(),
                update.revised_ts,
                update.revised_active_timestamp_basis.as_storage_str(),
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
                  AND active.ts = updates.expected_ts
                  AND active.active_timestamp_basis =
                      updates.expected_active_timestamp_basis
                  AND active.timestamp_provenance =
                      updates.expected_timestamp_provenance
                  AND active.unresolved_local_timestamp IS NOT DISTINCT FROM
                      updates.expected_unresolved_local_timestamp"
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
             SET ts = updates.revised_ts,
                 active_timestamp_basis = updates.revised_active_timestamp_basis
             FROM {UPDATES_TABLE} updates
             WHERE candidate.seq = updates.seq
               AND candidate.source = updates.source
               AND candidate.ts = updates.expected_ts
               AND candidate.active_timestamp_basis =
                   updates.expected_active_timestamp_basis"
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
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM events
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM {CANDIDATE_TABLE}
                    )
                    UNION ALL
                    (
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM {CANDIDATE_TABLE}
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
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
    let invalid_timestamp_rows = conn
        .query_row(
            &format!(
                r#"
                SELECT COUNT(*)
                FROM {CANDIDATE_TABLE}
                WHERE NOT (
                    (timestamp_provenance = 'explicit_wall'
                     AND active_timestamp_basis = 'explicit_wall'
                     AND unresolved_local_timestamp IS NULL)
                    OR
                    (timestamp_provenance = 'unresolved_local'
                     AND active_timestamp_basis IN ('order_only', 'resolved_local')
                     AND unresolved_local_timestamp IS NOT NULL
                     AND unresolved_local_timestamp <> ''
                     AND length(unresolved_local_timestamp) <= 256
                     AND strpos(unresolved_local_timestamp, chr(0)) = 0)
                    OR
                    (timestamp_provenance = 'order_only'
                     AND active_timestamp_basis = 'order_only'
                     AND unresolved_local_timestamp IS NULL)
                    OR
                    (timestamp_provenance = 'legacy_unknown'
                     AND active_timestamp_basis IN ('legacy_unknown', 'order_only')
                     AND unresolved_local_timestamp IS NULL)
                )
                "#
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CoreError::Message(format!(
                "validate event revision timestamp provenance: {error}"
            ))
        })?;
    if invalid_timestamp_rows != 0 {
        return Err(CoreError::Message(
            "event revision candidate contains inconsistent timestamp provenance".into(),
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

fn active_wall_count(conn: &Connection, table: &str) -> CoreResult<u64> {
    let count = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(
                     CASE WHEN active_timestamp_basis IN ('explicit_wall', 'resolved_local')
                          THEN 1 ELSE 0 END
                 ), 0)
                 FROM {table}"
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CoreError::Message(format!("read event revision wall-clock count: {error}"))
        })?;
    u64::try_from(count).map_err(|_| {
        CoreError::Message("event revision wall-clock count is outside supported range".into())
    })
}

fn validate_retained_revision_integrity(
    conn: &Connection,
    current_revision: u64,
    previous_revision: u64,
) -> CoreResult<u64> {
    let schema_differences = conn
        .query_row(
            &format!(
                r#"
                SELECT COUNT(*) FROM (
                    (
                        SELECT column_name, data_type, ordinal_position
                        FROM information_schema.columns
                        WHERE table_schema = 'main' AND table_name = 'events'
                        EXCEPT ALL
                        SELECT column_name, data_type, ordinal_position
                        FROM information_schema.columns
                        WHERE table_schema = 'main' AND table_name = '{PREVIOUS_TABLE}'
                    )
                    UNION ALL
                    (
                        SELECT column_name, data_type, ordinal_position
                        FROM information_schema.columns
                        WHERE table_schema = 'main' AND table_name = '{PREVIOUS_TABLE}'
                        EXCEPT ALL
                        SELECT column_name, data_type, ordinal_position
                        FROM information_schema.columns
                        WHERE table_schema = 'main' AND table_name = 'events'
                    )
                )
                "#
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(1);
    if schema_differences != 0 {
        return Err(CoreError::Message(
            "retained event revision schema changed; undo refused".into(),
        ));
    }

    let immutable_differences = conn
        .query_row(
            &format!(
                r#"
                SELECT COUNT(*) FROM (
                    (
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM events
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM {PREVIOUS_TABLE}
                    )
                    UNION ALL
                    (
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM {PREVIOUS_TABLE}
                        EXCEPT ALL
                        SELECT seq, level, service, host, template_id, params,
                               trace_id, message, source, original_redacted,
                               original_source_bytes, original_redacted_chars,
                               original_truncated, original_encoding_normalized,
                               original_redaction_applied, timestamp_provenance,
                               unresolved_local_timestamp
                        FROM events
                    )
                )
                "#
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            CoreError::Message(format!("validate retained event payloads: {error}"))
        })?;
    if immutable_differences != 0 {
        return Err(CoreError::Message(
            "active event identity, payload, raw representation, or provenance changed; undo refused"
                .into(),
        ));
    }

    let changed_rows = conn
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM events active
                 JOIN {PREVIOUS_TABLE} previous
                   ON active.seq = previous.seq
                  AND active.source = previous.source
                 WHERE active.ts <> previous.ts
                    OR active.active_timestamp_basis <> previous.active_timestamp_basis"
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CoreError::Message(format!("count retained event changes: {error}")))?;
    let audit_rows = conn
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM {TIMESTAMP_CHANGES_TABLE}
                 WHERE audit_schema_version = {EVENT_REVISION_AUDIT_SCHEMA_VERSION}
                   AND revision = ?1"
            ),
            params![current_revision as i64],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(-1);
    if audit_rows < 0 || audit_rows != changed_rows {
        return Err(CoreError::Message(
            "retained timestamp audit count does not match active changes; undo refused".into(),
        ));
    }
    let exact_audit_rows = conn
        .query_row(
            &format!(
                r#"
                SELECT COUNT(*)
                FROM {TIMESTAMP_CHANGES_TABLE} changes
                JOIN events active
                  ON active.seq = changes.seq
                 AND active.source = changes.source
                 AND active.ts = changes.current_ts
                 AND active.active_timestamp_basis =
                     changes.current_active_timestamp_basis
                JOIN {PREVIOUS_TABLE} previous
                  ON previous.seq = changes.seq
                 AND previous.source = changes.source
                 AND previous.ts = changes.previous_ts
                 AND previous.active_timestamp_basis =
                     changes.previous_active_timestamp_basis
                WHERE changes.audit_schema_version =
                      {EVENT_REVISION_AUDIT_SCHEMA_VERSION}
                  AND changes.revision = ?1
                "#
            ),
            params![current_revision as i64],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(-1);
    if exact_audit_rows != audit_rows || previous_revision + 1 != current_revision {
        return Err(CoreError::Message(
            "retained timestamp audit mapping is inconsistent; undo refused".into(),
        ));
    }
    u64::try_from(changed_rows).map_err(|_| {
        CoreError::Message("retained timestamp change count is outside supported range".into())
    })
}

fn event_time_quality_code(quality: TimeQuality) -> Option<i64> {
    match quality {
        TimeQuality::Wall => Some(1),
        TimeQuality::OrderOnly => Some(0),
        TimeQuality::Mixed => None,
    }
}

/// Return only old timestamp hints proven by the retained active revision.
///
/// A matching seq/source pair alone is not enough. The active revision must
/// retain an exact published old/new mapping, the old row must still exist in
/// `events_previous`, and every non-timestamp event/payload/raw column must be
/// unchanged. Older corpora without this audit table fail closed.
pub(crate) fn retained_timestamp_revision_hints(
    corpus: &LogCorpus,
    hints: &[EventReferenceTimestampHint],
) -> CoreResult<HashSet<EventReferenceTimestampHint>> {
    if hints.is_empty() {
        return Ok(HashSet::new());
    }
    corpus.with_connection(|conn| {
        let required_tables = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM information_schema.tables
                 WHERE table_schema = 'main'
                   AND table_name IN (
                       'event_revision_state',
                       'event_revision_timestamp_changes',
                       'events_previous'
                   )",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| {
                CoreError::Message(format!("inspect retained event revision evidence: {error}"))
            })?;
        if required_tables != 3 {
            return Ok(HashSet::new());
        }
        let audit_columns = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM information_schema.columns
                 WHERE table_schema = 'main'
                   AND table_name = 'event_revision_timestamp_changes'
                   AND column_name IN (
                       'audit_schema_version', 'revision', 'seq', 'source',
                       'previous_ts', 'previous_active_timestamp_basis',
                       'current_ts', 'current_active_timestamp_basis'
                   )",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);
        if audit_columns != 8 {
            return Ok(HashSet::new());
        }

        let active_stats = active_stats(conn, "events")?;
        let state_stats = conn
            .query_row(
                "SELECT event_count, ts_min, ts_max
                 FROM event_revision_state
                 WHERE singleton = 1
                   AND previous_revision IS NOT NULL",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .ok()
            .and_then(|(count, min, max)| u64::try_from(count).ok().map(|count| (count, min, max)));
        if state_stats != Some(active_stats) {
            return Ok(HashSet::new());
        }

        let mut unique_hints = hints
            .iter()
            .filter(|hint| {
                hint.seq <= i64::MAX as u64
                    && event_time_quality_code(hint.time_quality_hint).is_some()
            })
            .cloned()
            .collect::<Vec<_>>();
        unique_hints.sort_by(|left, right| {
            left.seq
                .cmp(&right.seq)
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.timestamp_hint.cmp(&right.timestamp_hint))
                .then_with(|| {
                    event_time_quality_code(left.time_quality_hint)
                        .cmp(&event_time_quality_code(right.time_quality_hint))
                })
        });
        unique_hints.dedup();

        let mut verified = HashSet::new();
        for chunk in unique_hints.chunks(256) {
            let placeholders = std::iter::repeat_n("(?, ?, ?, ?)", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                r#"
                WITH requested(seq, source, previous_ts, previous_quality) AS (
                    VALUES {placeholders}
                )
                SELECT requested.seq, requested.source, requested.previous_ts,
                       requested.previous_quality
                FROM requested
                JOIN event_revision_timestamp_changes changes
                  ON changes.seq = requested.seq
                 AND changes.source = requested.source
                 AND changes.previous_ts = requested.previous_ts
                JOIN event_revision_state state
                  ON changes.revision = state.current_revision
                JOIN events active
                  ON active.seq = changes.seq
                 AND active.source = changes.source
                 AND active.ts = changes.current_ts
                 AND active.active_timestamp_basis =
                     changes.current_active_timestamp_basis
                JOIN events_previous previous
                  ON previous.seq = changes.seq
                 AND previous.source = changes.source
                 AND previous.ts = changes.previous_ts
                 AND previous.active_timestamp_basis =
                     changes.previous_active_timestamp_basis
                WHERE state.singleton = 1
                  AND state.previous_revision IS NOT NULL
                  AND changes.audit_schema_version = {EVENT_REVISION_AUDIT_SCHEMA_VERSION}
                  AND state.previous_revision = changes.revision - 1
                  AND changes.previous_ts <> changes.current_ts
                  AND (
                    (requested.previous_quality = 1
                     AND previous.active_timestamp_basis IN ('explicit_wall', 'resolved_local'))
                    OR
                    (requested.previous_quality = 0
                     AND previous.active_timestamp_basis IN ('order_only', 'legacy_unknown'))
                  )
                  AND active.level IS NOT DISTINCT FROM previous.level
                  AND active.service IS NOT DISTINCT FROM previous.service
                  AND active.host IS NOT DISTINCT FROM previous.host
                  AND active.template_id IS NOT DISTINCT FROM previous.template_id
                  AND active.params IS NOT DISTINCT FROM previous.params
                  AND active.trace_id IS NOT DISTINCT FROM previous.trace_id
                  AND active.message IS NOT DISTINCT FROM previous.message
                  AND active.original_redacted IS NOT DISTINCT FROM previous.original_redacted
                  AND active.original_source_bytes
                      IS NOT DISTINCT FROM previous.original_source_bytes
                  AND active.original_redacted_chars
                      IS NOT DISTINCT FROM previous.original_redacted_chars
                  AND active.original_truncated
                      IS NOT DISTINCT FROM previous.original_truncated
                  AND active.original_encoding_normalized
                      IS NOT DISTINCT FROM previous.original_encoding_normalized
                  AND active.original_redaction_applied
                      IS NOT DISTINCT FROM previous.original_redaction_applied
                  AND active.timestamp_provenance
                      IS NOT DISTINCT FROM previous.timestamp_provenance
                  AND active.unresolved_local_timestamp
                      IS NOT DISTINCT FROM previous.unresolved_local_timestamp
                "#
            );
            let mut values = Vec::with_capacity(chunk.len() * 4);
            for hint in chunk {
                values.push(DuckValue::BigInt(hint.seq as i64));
                values.push(DuckValue::Text(hint.source.clone()));
                values.push(DuckValue::BigInt(hint.timestamp_hint));
                values.push(DuckValue::BigInt(
                    event_time_quality_code(hint.time_quality_hint)
                        .expect("filtered event time quality"),
                ));
            }
            let bound = values
                .iter()
                .map(|value| value as &dyn duckdb::ToSql)
                .collect::<Vec<_>>();
            let mut statement = conn.prepare(&sql).map_err(|error| {
                CoreError::Message(format!("prepare retained timestamp evidence: {error}"))
            })?;
            let rows = statement
                .query_map(bound.as_slice(), |row| {
                    Ok(EventReferenceTimestampHint {
                        seq: row.get::<_, i64>(0)? as u64,
                        source: row.get(1)?,
                        timestamp_hint: row.get(2)?,
                        time_quality_hint: match row.get::<_, i64>(3)? {
                            1 => TimeQuality::Wall,
                            _ => TimeQuality::OrderOnly,
                        },
                    })
                })
                .map_err(|error| {
                    CoreError::Message(format!("validate retained timestamp evidence: {error}"))
                })?;
            for row in rows {
                verified.insert(row.map_err(|error| {
                    CoreError::Message(format!("read retained timestamp evidence: {error}"))
                })?);
            }
        }
        Ok(verified)
    })
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
            let wall_event_count = active_wall_count(conn, CANDIDATE_TABLE)?;
            check_fault(fault, EventRevisionCheckpoint::CandidateReady)?;
            if cancelled(cancel) {
                return Err(CoreError::Message(
                    "event re-analysis cancelled before publication".into(),
                ));
            }

            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {PREVIOUS_TABLE};
                 DROP TABLE IF EXISTS {TIMESTAMP_CHANGES_TABLE};"
            ))
            .map_err(|error| {
                CoreError::Message(format!("remove obsolete event revision: {error}"))
            })?;
            conn.execute_batch(&format!(
                "CREATE TABLE {PREVIOUS_TABLE} AS
                     SELECT * FROM events;
                 CREATE TABLE {TIMESTAMP_CHANGES_TABLE} AS
                     SELECT {EVENT_REVISION_AUDIT_SCHEMA_VERSION}::INTEGER
                                AS audit_schema_version,
                            {revision}::BIGINT AS revision,
                            seq,
                            source,
                            expected_ts AS previous_ts,
                            expected_active_timestamp_basis AS previous_active_timestamp_basis,
                            revised_ts AS current_ts,
                            revised_active_timestamp_basis AS current_active_timestamp_basis
                       FROM {UPDATES_TABLE};
                 UPDATE events active
                    SET ts = candidate.ts,
                        active_timestamp_basis = candidate.active_timestamp_basis
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
                     previous_wall_event_count = wall_event_count,
                     previous_ts_min = ts_min,
                     previous_ts_max = ts_max,
                     current_revision = ?1,
                     current_metadata_json = ?2,
                     event_count = ?3,
                     wall_event_count = ?4,
                     ts_min = ?5,
                     ts_max = ?6
                 WHERE singleton = 1",
                params![
                    revision as i64,
                    metadata_json,
                    event_count as i64,
                    wall_event_count as i64,
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
            let (event_count, wall_event_count, ts_min, ts_max) = conn
                .query_row(
                    "SELECT previous_event_count, previous_wall_event_count,
                            previous_ts_min, previous_ts_max
                     FROM event_revision_state
                     WHERE singleton = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
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
            let wall_event_count = wall_event_count
                .and_then(|count| u64::try_from(count).ok())
                .filter(|count| *count <= event_count)
                .ok_or_else(|| {
                    CoreError::Message(
                        "retained wall-clock event count is unavailable or invalid".into(),
                    )
                })?;
            let retained_stats = active_stats(conn, PREVIOUS_TABLE)?;
            let retained_wall_count = active_wall_count(conn, PREVIOUS_TABLE)?;
            if retained_stats != (event_count, ts_min, ts_max)
                || retained_wall_count != wall_event_count
            {
                return Err(CoreError::Message(
                    "retained event revision does not match its published statistics".into(),
                ));
            }

            let active_stats = active_stats(conn, "events")?;
            let active_wall_count = active_wall_count(conn, "events")?;
            let expected_current_stats = conn
                .query_row(
                    "SELECT event_count, wall_event_count, ts_min, ts_max
                     FROM event_revision_state
                     WHERE singleton = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
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
                    expected_current_stats.2,
                    expected_current_stats.3,
                )
                || active_wall_count != u64::try_from(expected_current_stats.1).unwrap_or(u64::MAX)
            {
                return Err(CoreError::Message(
                    "active events changed after revision publication; undo refused".into(),
                ));
            }
            let changed_events = validate_retained_revision_integrity(conn, current, previous)?;
            conn.execute_batch(&format!(
                "DELETE FROM events;
                 INSERT INTO events
                 SELECT * FROM {PREVIOUS_TABLE};
                 DROP TABLE {PREVIOUS_TABLE};
                 DROP TABLE IF EXISTS {TIMESTAMP_CHANGES_TABLE};"
            ))
            .map_err(|error| {
                CoreError::Message(format!("restore retained event revision: {error}"))
            })?;
            conn.execute(
                "UPDATE event_revision_state
                 SET current_revision = ?1,
                     current_metadata_json = previous_metadata_json,
                     event_count = previous_event_count,
                     wall_event_count = previous_wall_event_count,
                     ts_min = previous_ts_min,
                     ts_max = previous_ts_max,
                     previous_revision = NULL,
                     previous_metadata_json = NULL,
                     previous_event_count = NULL,
                     previous_wall_event_count = NULL,
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
    use crate::investigations::{
        AddFindingInput, EvidenceReferenceStatus, FindingKind, FindingViewFilters, FindingViewLane,
        FindingViewRecipe, FindingViewTimeLinkMode, FindingViewViewportAnchor, InvestigationStore,
    };
    use crate::log_analysis::{
        add_evidence_bookmark, ingest_path, list_resolved_bookmarks,
        load_operational_metrics_attachment, query_event_count,
        save_operational_metrics_attachment, BookmarkEventRef, BookmarkEvidenceStatus, EventQuery,
        LogEvent, NewEvidenceBookmark, OperationalMetricsAttachment,
        OperationalMetricsAttachmentSource, TimeQuality,
    };
    use crate::sessions::{Session, SessionStore};
    use std::collections::BTreeMap;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::PathBuf;
    use std::process::Command;
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
        (cache, report.corpus_id)
    }

    fn multi_source_fixture() -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "multi-source event revision").unwrap();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 0,
                    ts: 1_700_000_000,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: Some("api".into()),
                    host: Some("host-a".into()),
                    template_id: 10,
                    params: vec!["request-a".into()],
                    trace_id: Some("trace-a".into()),
                    message: "API failure boundary".into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 1,
                    ts: 1_700_000_010,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "info".into(),
                    service: Some("api".into()),
                    host: Some("host-a".into()),
                    template_id: 11,
                    params: vec!["request-b".into()],
                    trace_id: Some("trace-b".into()),
                    message: "API local timestamp to revise".into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 2,
                    ts: 1_700_000_020,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "warn".into(),
                    service: Some("worker".into()),
                    host: Some("host-b".into()),
                    template_id: 12,
                    params: vec!["job-a".into()],
                    trace_id: Some("trace-a".into()),
                    message: "Worker warning boundary".into(),
                    source: "worker/worker.log".into(),
                },
                LogEvent {
                    seq: 3,
                    ts: 1_700_000_030,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: Some("worker".into()),
                    host: Some("host-b".into()),
                    template_id: 13,
                    params: vec!["job-b".into()],
                    trace_id: Some("trace-b".into()),
                    message: "Worker local timestamp to revise".into(),
                    source: "worker/worker.log".into(),
                },
            ])
            .unwrap();
        corpus.flush().unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (cache, corpus_id)
    }

    fn root(cache: &Path, corpus_id: &str) -> PathBuf {
        cache.join("log_corpora").join(corpus_id)
    }

    fn snapshot_where(root: &Path, include: impl Fn(&str) -> bool) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        for entry in std::fs::read_dir(root).expect("read corpus root") {
            let entry = entry.expect("entry");
            if entry.file_type().expect("type").is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !include(&name) {
                    continue;
                }
                files.insert(name, std::fs::read(entry.path()).expect("read corpus file"));
            }
        }
        files
    }

    fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        snapshot_where(root, |_| true)
    }

    fn is_corpus_sidecar(name: &str) -> bool {
        !matches!(name, "events.duckdb" | "events.duckdb.wal")
    }

    fn sidecar_snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        snapshot_where(root, is_corpus_sidecar)
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
        update_for_source(seq, "app.log", expected_ts, revised_ts)
    }

    fn update_for_source(
        seq: u64,
        source: &str,
        expected_ts: i64,
        revised_ts: i64,
    ) -> EventTimestampUpdate {
        EventTimestampUpdate {
            seq,
            source: source.into(),
            expected_ts,
            expected_active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            expected_timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            expected_unresolved_local_timestamp: None,
            revised_ts,
            revised_active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        }
    }

    fn event_ref(corpus_id: &str, seq: u64, source: &str, timestamp_hint: i64) -> BookmarkEventRef {
        BookmarkEventRef {
            corpus_id: corpus_id.to_string(),
            seq,
            source: source.to_string(),
            timestamp_hint,
            time_quality_hint: TimeQuality::Wall,
        }
    }

    fn saved_view_recipe(corpus_id: &str) -> FindingViewRecipe {
        let api_ref = event_ref(corpus_id, 1, "api/app.log", 1_700_000_010);
        let worker_ref = event_ref(corpus_id, 3, "worker/worker.log", 1_700_000_030);
        FindingViewRecipe {
            filters: FindingViewFilters {
                levels: vec![],
                sources: vec!["api/app.log".into(), "worker/worker.log".into()],
                services: vec![],
                hosts: vec![],
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_000_100),
                seq_from: None,
                seq_to: None,
                template_id: None,
                trace_id: None,
                keyword: None,
            },
            lanes: vec![
                FindingViewLane {
                    id: "lane-api".into(),
                    label: "API".into(),
                    sources: vec!["api/app.log".into()],
                },
                FindingViewLane {
                    id: "lane-worker".into(),
                    label: "Worker".into(),
                    sources: vec!["worker/worker.log".into()],
                },
            ],
            visible_lane_count: 2,
            time_link_mode: FindingViewTimeLinkMode::AlignTime,
            focused_lane_id: Some("lane-api".into()),
            focused_event: Some(api_ref.clone()),
            selection: vec![api_ref.clone(), worker_ref.clone()],
            highlights: vec![worker_ref.clone()],
            find: None,
            viewport_anchors: vec![
                FindingViewViewportAnchor {
                    lane_id: "lane-api".into(),
                    event_ref: api_ref,
                },
                FindingViewViewportAnchor {
                    lane_id: "lane-worker".into(),
                    event_ref: worker_ref,
                },
            ],
        }
    }

    fn metric_document() -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "event-revision-metrics",
            "name": "Event revision metrics",
            "series": [{
                "id": "cpu",
                "name": "CPU",
                "unit": "%",
                "provenance": {"source": "revision-test-monitor"},
                "timeQuality": "wall",
                "points": [
                    {"timestamp": 1_700_000_000.0, "value": 42.0},
                    {"timestamp": 1_700_000_100.0, "value": 73.0}
                ]
            }]
        })
        .to_string()
    }

    struct ProductIdentityFixture {
        bookmark_id: String,
        investigation_id: String,
        finding_id: String,
        evidence_id: String,
        linked_chat_id: String,
        recipe: FindingViewRecipe,
        metric_attachment: OperationalMetricsAttachment,
    }

    fn create_product_identities(
        cache: &Path,
        corpus: &LogCorpus,
        durable_root: &Path,
    ) -> ProductIdentityFixture {
        let selected = vec![
            event_ref(corpus.id(), 1, "api/app.log", 1_700_000_010),
            event_ref(corpus.id(), 3, "worker/worker.log", 1_700_000_030),
        ];
        let bookmark = add_evidence_bookmark(
            corpus,
            NewEvidenceBookmark {
                event_refs: selected.clone(),
                label: "Failure boundaries".into(),
                note: Some("Stable exact identities around revised events".into()),
                color: Some("red".into()),
            },
        )
        .unwrap();

        let store = InvestigationStore::new(durable_root.join("investigations"));
        let investigation = store.create("Timestamp investigation", corpus).unwrap();
        let recipe = saved_view_recipe(corpus.id());
        let resolved = store
            .add_human_finding(
                &investigation.id,
                investigation.revision,
                corpus,
                AddFindingInput {
                    kind: FindingKind::Observation,
                    title: "Cross-source failure boundaries".into(),
                    why_it_matters:
                        "The saved view spans both source timestamps selected for revision.".into(),
                    event_refs: selected,
                    view_recipe: Some(recipe.clone()),
                },
            )
            .unwrap();
        let finding_id = resolved.document.findings[0].id.clone();
        let evidence_id = resolved.document.evidence[0].id.clone();

        let sessions = SessionStore::new(durable_root.join("sessions"));
        let mut linked_chat = Session::new("Linked timestamp investigation");
        linked_chat.set_linked_corpus_id(Some(corpus.id().to_string()));
        sessions.save(&linked_chat).unwrap();

        let metric_attachment = save_operational_metrics_attachment(
            cache,
            corpus.id(),
            &metric_document(),
            "/private/monitor/event-revision-metrics.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();

        ProductIdentityFixture {
            bookmark_id: bookmark.id,
            investigation_id: investigation.id,
            finding_id,
            evidence_id,
            linked_chat_id: linked_chat.id,
            recipe,
            metric_attachment,
        }
    }

    fn assert_product_identities(
        cache: &Path,
        corpus: &LogCorpus,
        durable_root: &Path,
        expected: &ProductIdentityFixture,
        expected_window_count: u64,
    ) {
        let bookmarks = list_resolved_bookmarks(corpus).unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].bookmark.id, expected.bookmark_id);
        assert_eq!(
            bookmarks[0].evidence_status,
            BookmarkEvidenceStatus::Verified
        );

        let store = InvestigationStore::new(durable_root.join("investigations"));
        let investigation = store.load(&expected.investigation_id, corpus).unwrap();
        assert_eq!(investigation.document.findings[0].id, expected.finding_id);
        assert_eq!(investigation.document.evidence[0].id, expected.evidence_id);
        assert!(investigation.evidence[0]
            .references
            .iter()
            .all(|reference| reference.status == EvidenceReferenceStatus::Verified));

        let preview = store
            .preview_evidence(&expected.investigation_id, &expected.evidence_id, corpus)
            .unwrap();
        assert!(preview
            .references
            .iter()
            .all(|reference| reference.status == EvidenceReferenceStatus::Verified));
        let recipe = store
            .resolve_finding_view_recipe(&expected.investigation_id, &expected.finding_id, corpus)
            .unwrap();
        assert_eq!(recipe.missing_count, 0);
        assert_eq!(recipe.stale_count, 0);
        assert_eq!(recipe.view_recipe, expected.recipe);

        let count = query_event_count(
            corpus,
            &EventQuery {
                time_from: recipe.view_recipe.filters.time_from,
                time_to: recipe.view_recipe.filters.time_to,
                sources: recipe.view_recipe.filters.sources,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(count.total_matched, expected_window_count);

        let sessions = SessionStore::new(durable_root.join("sessions"));
        let linked_chat = sessions.load(&expected.linked_chat_id).unwrap();
        assert_eq!(linked_chat.id, expected.linked_chat_id);
        assert_eq!(linked_chat.linked_corpus_id.as_deref(), Some(corpus.id()));
        let linked_meta = sessions.list_meta_for_corpus(corpus.id()).unwrap();
        assert_eq!(linked_meta.len(), 1);
        assert_eq!(linked_meta[0].id, expected.linked_chat_id);

        assert_eq!(
            load_operational_metrics_attachment(cache, corpus.id()).unwrap(),
            expected.metric_attachment
        );
    }

    fn assert_product_event_references_stale(
        corpus: &LogCorpus,
        durable_root: &Path,
        expected: &ProductIdentityFixture,
    ) {
        let bookmarks = list_resolved_bookmarks(corpus).unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].evidence_status, BookmarkEvidenceStatus::Stale);

        let store = InvestigationStore::new(durable_root.join("investigations"));
        let investigation = store.load(&expected.investigation_id, corpus).unwrap();
        assert!(investigation.evidence[0]
            .references
            .iter()
            .any(|reference| reference.status == EvidenceReferenceStatus::Stale));
        let preview = store
            .preview_evidence(&expected.investigation_id, &expected.evidence_id, corpus)
            .unwrap();
        assert!(preview
            .references
            .iter()
            .any(|reference| reference.status == EvidenceReferenceStatus::Stale));
        let recipe = store
            .resolve_finding_view_recipe(&expected.investigation_id, &expected.finding_id, corpus)
            .unwrap();
        assert!(recipe.stale_count > 0);
    }

    fn mutate_event(corpus: &LogCorpus, sql: &str) {
        corpus
            .with_connection(|conn| {
                conn.execute_batch(sql).map_err(|error| {
                    CoreError::Message(format!("mutate event for adversarial proof: {error}"))
                })
            })
            .unwrap();
    }

    fn event_snapshot(cache: &Path, corpus_id: &str) -> Vec<super::super::LogEvent> {
        let corpus = LogCorpus::open(cache, corpus_id).expect("open corpus");
        corpus
            .with_events(|events| CoreResult::Ok(events.to_vec()))
            .expect("events")
    }

    fn active_revision(cache: &Path, corpus_id: &str) -> u64 {
        LogCorpus::open(cache, corpus_id)
            .expect("open corpus revision")
            .event_revision()
    }

    fn unresolved_local_fixture() -> (tempfile::TempDir, String) {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "unresolved local revision").unwrap();
        corpus
            .push_events(&[LogEvent {
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
                message: "local timestamp".into(),
                source: "api/app.log".into(),
            }])
            .unwrap();
        corpus.flush().unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (cache, corpus_id)
    }

    #[test]
    fn ordinary_order_only_event_cannot_be_upgraded_to_wall_time() {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = LogCorpus::create(cache.path(), "order-only revision").unwrap();
        corpus
            .push_events(&[LogEvent {
                seq: 0,
                ts: 0,
                timestamp_provenance: TimestampProvenance::OrderOnly,
                active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                unresolved_local_timestamp: None,
                level: "info".into(),
                service: None,
                host: None,
                template_id: 1,
                params: vec![],
                trace_id: None,
                message: "no timestamp evidence".into(),
                source: "app.log".into(),
            }])
            .unwrap();
        corpus.flush().unwrap();
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        let before = event_snapshot(cache.path(), &corpus_id);

        let rejected = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [EventTimestampUpdate {
                seq: 0,
                source: "app.log".into(),
                expected_ts: 0,
                expected_active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                expected_timestamp_provenance: TimestampProvenance::OrderOnly,
                expected_unresolved_local_timestamp: None,
                revised_ts: 1_614_912_833,
                revised_active_timestamp_basis: ActiveTimestampBasis::ResolvedLocal,
            }],
            None,
        )
        .unwrap_err();

        assert!(rejected
            .to_string()
            .contains("active timestamp basis transition is unsupported"));
        assert_eq!(active_revision(cache.path(), &corpus_id), 1);
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[test]
    fn mismatched_expected_provenance_or_local_evidence_fails_closed() {
        let (cache, corpus_id) = unresolved_local_fixture();
        let before = event_snapshot(cache.path(), &corpus_id);
        let expected_revision = active_revision(cache.path(), &corpus_id);
        let mismatches = [
            EventTimestampUpdate {
                seq: 0,
                source: "api/app.log".into(),
                expected_ts: 0,
                expected_active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                expected_timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                expected_unresolved_local_timestamp: None,
                revised_ts: 1_614_912_833,
                revised_active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            },
            EventTimestampUpdate {
                seq: 0,
                source: "api/app.log".into(),
                expected_ts: 0,
                expected_active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                expected_timestamp_provenance: TimestampProvenance::UnresolvedLocal,
                expected_unresolved_local_timestamp: Some("2021-03-05 02:53:54,654".into()),
                revised_ts: 1_614_912_833,
                revised_active_timestamp_basis: ActiveTimestampBasis::ResolvedLocal,
            },
        ];

        for mismatch in mismatches {
            let rejected = apply_event_timestamp_revision(
                cache.path(),
                &corpus_id,
                expected_revision,
                metadata(),
                [mismatch],
                None,
            )
            .unwrap_err();
            assert!(rejected.to_string().contains("identity conflict"));
            assert_eq!(active_revision(cache.path(), &corpus_id), expected_revision);
            assert_eq!(
                serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
                serde_json::to_value(&before).unwrap()
            );
        }
    }

    #[test]
    fn local_resolution_revision_changes_active_basis_but_preserves_parser_evidence() {
        let (cache, corpus_id) = unresolved_local_fixture();

        let published = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [EventTimestampUpdate {
                seq: 0,
                source: "api/app.log".into(),
                expected_ts: 0,
                expected_active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                expected_timestamp_provenance: TimestampProvenance::UnresolvedLocal,
                expected_unresolved_local_timestamp: Some("2021-03-05 02:53:53,654".into()),
                revised_ts: 1_614_912_833,
                revised_active_timestamp_basis: ActiveTimestampBasis::ResolvedLocal,
            }],
            None,
        )
        .expect("publish local resolution");

        let resolved = event_snapshot(cache.path(), &corpus_id);
        assert_eq!(resolved[0].ts, 1_614_912_833);
        assert_eq!(
            resolved[0].timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            resolved[0].active_timestamp_basis,
            ActiveTimestampBasis::ResolvedLocal
        );
        assert_eq!(
            resolved[0].unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );

        undo_event_revision(cache.path(), &corpus_id, published.revision, None)
            .expect("undo local resolution");
        let restored = event_snapshot(cache.path(), &corpus_id);
        assert_eq!(restored[0].ts, 0);
        assert_eq!(
            restored[0].active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly
        );
        assert_eq!(
            restored[0].timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            restored[0].unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
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
            let bytes_before = snapshot(&corpus_root);
            let events_before = event_snapshot(cache.path(), &corpus_id);
            let already_open = LogCorpus::open(cache.path(), &corpus_id).unwrap();
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
                active_revision(cache.path(), &corpus_id),
                metadata(),
                [update(1, 1_700_000_010, 1_700_003_610)],
                None,
                Some(&fault),
            );
            assert!(result.is_err(), "{checkpoint:?}");
            drop(already_open);
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
            active_revision(cache.path(), &corpus_id),
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
                active_revision(cache.path(), &corpus_id),
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
    fn process_exit_child_aborts_after_active_events_change() {
        if std::env::var_os("CONTEXTDESK_EVENT_REVISION_CRASH_CHILD").is_none() {
            return;
        }
        let cache_root = PathBuf::from(
            std::env::var_os("CONTEXTDESK_EVENT_REVISION_CRASH_CACHE")
                .expect("crash child cache root"),
        );
        let corpus_id =
            std::env::var("CONTEXTDESK_EVENT_REVISION_CRASH_CORPUS").expect("crash child corpus");
        let terminate = |checkpoint| {
            if checkpoint == EventRevisionCheckpoint::ActiveEventsChanged {
                std::process::exit(86);
            }
            Ok(())
        };
        let result = apply_event_timestamp_revision_inner(
            &cache_root,
            &corpus_id,
            active_revision(&cache_root, &corpus_id),
            metadata(),
            [
                update_for_source(1, "api/app.log", 1_700_000_010, 1_700_003_610),
                update_for_source(3, "worker/worker.log", 1_700_000_030, 1_700_003_630),
            ],
            None,
            Some(&terminate),
        );
        panic!("crash child unexpectedly returned: {result:?}");
    }

    #[test]
    fn abrupt_process_exit_before_commit_restores_prior_multi_source_revision() {
        let (cache, corpus_id) = multi_source_fixture();
        let durable = tempfile::tempdir().expect("durable investigation root");
        let corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let product_identities = create_product_identities(cache.path(), &corpus, durable.path());
        let before = event_snapshot(cache.path(), &corpus_id);
        drop(corpus);

        let status = Command::new(std::env::current_exe().expect("current test executable"))
            .arg("--exact")
            .arg(
                "log_analysis::event_revision::tests::process_exit_child_aborts_after_active_events_change",
            )
            .env("CONTEXTDESK_EVENT_REVISION_CRASH_CHILD", "1")
            .env(
                "CONTEXTDESK_EVENT_REVISION_CRASH_CACHE",
                cache.path().as_os_str(),
            )
            .env("CONTEXTDESK_EVENT_REVISION_CRASH_CORPUS", &corpus_id)
            .status()
            .expect("run abrupt-exit child");
        assert_eq!(status.code(), Some(86));

        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&before).unwrap(),
            "DuckDB recovery must roll back both sources after a no-destructor process exit"
        );
        let reopened = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        assert_product_identities(
            cache.path(),
            &reopened,
            durable.path(),
            &product_identities,
            4,
        );
    }

    #[test]
    fn directly_revised_references_survive_apply_and_undo_but_unrelated_mutations_stale() {
        let (cache, corpus_id) = multi_source_fixture();
        let durable = tempfile::tempdir().expect("durable investigation root");
        let corpus_root = root(cache.path(), &corpus_id);
        let events_before = event_snapshot(cache.path(), &corpus_id);
        let already_open = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let product_identities =
            create_product_identities(cache.path(), &already_open, durable.path());
        let initial_window = query_event_count(
            &already_open,
            &EventQuery {
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_000_100),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(initial_window.total_matched, 4);
        assert_product_identities(
            cache.path(),
            &already_open,
            durable.path(),
            &product_identities,
            4,
        );
        let sidecars_before = sidecar_snapshot(&corpus_root);

        let report = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [
                update_for_source(1, "api/app.log", 1_700_000_010, 1_700_003_610),
                update_for_source(3, "worker/worker.log", 1_700_000_030, 1_700_003_630),
            ],
            None,
        )
        .expect("publish revision");
        assert_eq!(report.revision, 2);
        assert_eq!(report.previous_revision, 1);
        assert_eq!(report.changed_events, 2);
        assert_eq!(report.event_count, 4);
        assert_eq!(report.ts_min, Some(1_700_000_000));
        assert_eq!(report.ts_max, Some(1_700_003_630));
        let revised_window = query_event_count(
            &already_open,
            &EventQuery {
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_000_100),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            revised_window.total_matched, 2,
            "an already-open corpus handle must reject its cached old time-window count"
        );

        let events_after = event_snapshot(cache.path(), &corpus_id);
        assert_eq!(events_after[0].ts, 1_700_000_000);
        assert_eq!(events_after[1].ts, 1_700_003_610);
        assert_eq!(events_after[2].ts, 1_700_000_020);
        assert_eq!(events_after[3].ts, 1_700_003_630);
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
        let sidecars_after = sidecar_snapshot(&corpus_root);
        assert_eq!(sidecars_after, sidecars_before);
        assert_product_identities(
            cache.path(),
            &already_open,
            durable.path(),
            &product_identities,
            2,
        );

        mutate_event(
            &already_open,
            "UPDATE events
             SET ts = 1700009999
             WHERE seq = 1 AND source = 'api/app.log'",
        );
        assert_product_event_references_stale(&already_open, durable.path(), &product_identities);
        mutate_event(
            &already_open,
            "UPDATE events
             SET ts = 1700003610
             WHERE seq = 1 AND source = 'api/app.log'",
        );

        mutate_event(
            &already_open,
            "UPDATE events
             SET message = 'ordinary payload mutation'
             WHERE seq = 1 AND source = 'api/app.log'",
        );
        assert_product_event_references_stale(&already_open, durable.path(), &product_identities);
        mutate_event(
            &already_open,
            "UPDATE events
             SET message = 'API local timestamp to revise'
             WHERE seq = 1 AND source = 'api/app.log'",
        );

        mutate_event(
            &already_open,
            "UPDATE events
             SET original_redacted = 'ordinary raw mutation'
             WHERE seq = 1 AND source = 'api/app.log'",
        );
        assert_product_event_references_stale(&already_open, durable.path(), &product_identities);
        mutate_event(
            &already_open,
            "UPDATE events
             SET original_redacted = NULL
             WHERE seq = 1 AND source = 'api/app.log'",
        );
        assert_product_identities(
            cache.path(),
            &already_open,
            durable.path(),
            &product_identities,
            2,
        );

        let undone = undo_event_revision(cache.path(), &corpus_id, 2, None).expect("undo revision");
        assert_eq!(undone.revision, 3);
        assert_eq!(undone.previous_revision, 2);
        assert_eq!(undone.changed_events, 2);
        assert_eq!(undone.event_count, 4);
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&events_before).unwrap(),
            "undo must restore the complete prior event set"
        );
        assert_product_identities(
            cache.path(),
            &already_open,
            durable.path(),
            &product_identities,
            4,
        );
        let second_undo = undo_event_revision(cache.path(), &corpus_id, 3, None);
        assert!(second_undo
            .unwrap_err()
            .to_string()
            .contains("no prior event revision"));
    }

    #[test]
    fn multi_source_validation_and_publish_faults_are_all_or_nothing() {
        let (cache, corpus_id) = multi_source_fixture();
        let durable = tempfile::tempdir().expect("durable investigation root");
        let corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let product_identities = create_product_identities(cache.path(), &corpus, durable.path());
        let before = event_snapshot(cache.path(), &corpus_id);

        let identity_conflict = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [
                update_for_source(1, "api/app.log", 1_700_000_010, 1_700_003_610),
                update_for_source(3, "worker/worker.log", 123, 1_700_003_630),
            ],
            None,
        )
        .unwrap_err();
        assert!(identity_conflict.to_string().contains("identity conflict"));
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert_product_identities(
            cache.path(),
            &corpus,
            durable.path(),
            &product_identities,
            4,
        );

        let fault = |checkpoint| {
            if checkpoint == EventRevisionCheckpoint::ActiveEventsChanged {
                Err(CoreError::Message(
                    "injected multi-source publication fault".into(),
                ))
            } else {
                Ok(())
            }
        };
        let publication_fault = apply_event_timestamp_revision_inner(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [
                update_for_source(1, "api/app.log", 1_700_000_010, 1_700_003_610),
                update_for_source(3, "worker/worker.log", 1_700_000_030, 1_700_003_630),
            ],
            None,
            Some(&fault),
        )
        .unwrap_err();
        assert!(publication_fault
            .to_string()
            .contains("multi-source publication fault"));
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(&before).unwrap(),
            "neither source may publish when one transaction fails"
        );
        assert_product_identities(
            cache.path(),
            &corpus,
            durable.path(),
            &product_identities,
            4,
        );
    }

    #[test]
    fn undo_faults_restore_exact_revised_bytes_and_events() {
        for checkpoint in [
            EventRevisionCheckpoint::UndoEventsChanged,
            EventRevisionCheckpoint::BeforeCommit,
        ] {
            let (cache, corpus_id) = fixture();
            let published = apply_event_timestamp_revision(
                cache.path(),
                &corpus_id,
                active_revision(cache.path(), &corpus_id),
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
            let result = undo_event_revision_inner(
                cache.path(),
                &corpus_id,
                published.revision,
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
    fn undo_refuses_tampered_retained_payload_or_audit_mapping() {
        for tamper in ["retained payload", "audit mapping"] {
            let (cache, corpus_id) = fixture();
            let published = apply_event_timestamp_revision(
                cache.path(),
                &corpus_id,
                active_revision(cache.path(), &corpus_id),
                metadata(),
                [update(1, 1_700_000_010, 1_700_003_610)],
                None,
            )
            .expect("publish revision");
            let revised = event_snapshot(cache.path(), &corpus_id);
            let corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
            let sql = match tamper {
                "retained payload" => format!(
                    "UPDATE {PREVIOUS_TABLE}
                     SET message = 'tampered retained payload'
                     WHERE seq = 1 AND source = 'app.log'"
                ),
                "audit mapping" => format!(
                    "UPDATE {TIMESTAMP_CHANGES_TABLE}
                     SET current_ts = current_ts + 1
                     WHERE seq = 1 AND source = 'app.log'"
                ),
                _ => unreachable!(),
            };
            mutate_event(&corpus, &sql);
            drop(corpus);

            let rejected = undo_event_revision(cache.path(), &corpus_id, published.revision, None)
                .unwrap_err();
            let message = rejected.to_string();
            if tamper == "retained payload" {
                assert!(message.contains("payload"));
            } else {
                assert!(message.contains("audit mapping"));
            }
            assert_eq!(
                active_revision(cache.path(), &corpus_id),
                published.revision
            );
            assert_eq!(
                serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
                serde_json::to_value(&revised).unwrap(),
                "{tamper}"
            );
        }
    }

    #[test]
    fn undo_refuses_stale_audit_schema_version() {
        let (cache, corpus_id) = fixture();
        let published = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [update(1, 1_700_000_010, 1_700_003_610)],
            None,
        )
        .expect("publish revision");
        let revised = event_snapshot(cache.path(), &corpus_id);
        let corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        mutate_event(
            &corpus,
            &format!(
                "UPDATE {TIMESTAMP_CHANGES_TABLE}
                 SET audit_schema_version = {EVENT_REVISION_AUDIT_SCHEMA_VERSION} - 1"
            ),
        );
        drop(corpus);

        let rejected =
            undo_event_revision(cache.path(), &corpus_id, published.revision, None).unwrap_err();
        assert!(rejected.to_string().contains("audit count"));
        assert_eq!(
            active_revision(cache.path(), &corpus_id),
            published.revision
        );
        assert_eq!(
            serde_json::to_value(event_snapshot(cache.path(), &corpus_id)).unwrap(),
            serde_json::to_value(revised).unwrap()
        );
    }

    #[test]
    fn concurrent_attempt_fails_visibly_without_racing_publication() {
        let (cache, corpus_id) = fixture();
        let cache_path = cache.path().to_path_buf();
        let worker_id = corpus_id.clone();
        let expected_revision = active_revision(cache.path(), &corpus_id);
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
                expected_revision,
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
            expected_revision,
            metadata(),
            [update(1, 1_700_000_010, 1_700_003_610)],
            None,
        )
        .unwrap_err();
        assert!(conflict
            .to_string()
            .contains("event re-analysis is already in progress"));
        release.wait();
        assert_eq!(worker.join().expect("worker").expect("publish").revision, 2);
    }

    #[test]
    fn identity_conflict_fails_before_publication() {
        let (cache, corpus_id) = fixture();
        let corpus_root = root(cache.path(), &corpus_id);
        let bytes_before = snapshot(&corpus_root);
        let conflict = apply_event_timestamp_revision(
            cache.path(),
            &corpus_id,
            active_revision(cache.path(), &corpus_id),
            metadata(),
            [update(1, 123, 1_700_003_610)],
            None,
        )
        .unwrap_err();
        assert!(conflict.to_string().contains("identity conflict"));
        assert_eq!(snapshot(&corpus_root), bytes_before);
    }
}
