//! Persistent watcher definitions and at-most-once event claims (#290).
//!
//! Execution lives in `main.rs`, where the server can reuse workspace indexes,
//! `ToolHost` permission state, and the Telegram notification transport. This
//! module deliberately owns only the durable, hermetic watch model.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) const MIN_INTERVAL_SECONDS: u64 = 5 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct WatcherDefinition {
    pub id: String,
    pub workspace_id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub watch: WatchSource,
    #[serde(default)]
    pub condition: WatchCondition,
    pub action: WatchAction,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum WatchSource {
    Query {
        query: String,
        interval_seconds: u64,
        #[serde(default = "default_result_limit")]
        result_limit: usize,
    },
    ConnectorPoll {
        connector_id: String,
        tool_name: String,
        #[serde(default)]
        arguments: serde_json::Value,
        interval_seconds: u64,
    },
    Schedule {
        interval_seconds: u64,
    },
}

fn default_result_limit() -> usize {
    10
}

impl WatchSource {
    pub(crate) fn interval_seconds(&self) -> u64 {
        match self {
            Self::Query {
                interval_seconds, ..
            }
            | Self::ConnectorPoll {
                interval_seconds, ..
            }
            | Self::Schedule { interval_seconds } => *interval_seconds,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum WatchCondition {
    #[default]
    Always,
    Contains {
        needle: String,
    },
    ResultCountAtLeast {
        minimum: usize,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum WatchAction {
    Notify {
        chat_id: i64,
        #[serde(default)]
        message_thread_id: Option<i64>,
        text: String,
    },
    ProposeTool {
        tool_name: String,
        #[serde(default)]
        arguments: serde_json::Value,
        chat_id: i64,
        #[serde(default)]
        message_thread_id: Option<i64>,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct WatcherState {
    pub last_run_at: Option<i64>,
    pub last_event_key: Option<String>,
    pub last_fired_at: Option<i64>,
    pub last_outcome: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct WatcherRecord {
    pub definition: WatcherDefinition,
    pub state: WatcherState,
}

#[derive(Clone, Debug)]
pub(crate) struct WatcherStore {
    path: PathBuf,
}

impl WatcherDefinition {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("watcher id must not be empty".into());
        }
        if self.workspace_id.trim().is_empty() {
            return Err("watcher workspace_id must not be empty".into());
        }
        let interval = self.watch.interval_seconds();
        if interval < MIN_INTERVAL_SECONDS {
            return Err(format!(
                "watcher interval must be at least {MIN_INTERVAL_SECONDS} seconds"
            ));
        }
        match &self.watch {
            WatchSource::Query {
                query,
                result_limit,
                ..
            } => {
                if query.trim().is_empty() {
                    return Err("query watcher requires a non-empty query".into());
                }
                if *result_limit == 0 || *result_limit > 100 {
                    return Err("query watcher result_limit must be between 1 and 100".into());
                }
            }
            WatchSource::ConnectorPoll {
                connector_id,
                tool_name,
                ..
            } => {
                if connector_id.trim().is_empty() || tool_name.trim().is_empty() {
                    return Err(
                        "connector poll requires non-empty connector_id and tool_name".into(),
                    );
                }
            }
            WatchSource::Schedule { .. } => {}
        }
        if let WatchCondition::Contains { needle } = &self.condition {
            if needle.trim().is_empty() {
                return Err("contains condition requires a non-empty needle".into());
            }
        }
        match &self.action {
            WatchAction::Notify { text, .. } if text.trim().is_empty() => {
                Err("notify action requires non-empty text".into())
            }
            WatchAction::ProposeTool { tool_name, .. } if tool_name.trim().is_empty() => {
                Err("propose_tool action requires non-empty tool_name".into())
            }
            _ => Ok(()),
        }
    }
}

impl WatcherStore {
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("watcher database directory: {error}"))?;
        }
        let store = Self { path };
        store.with_connection(|connection| {
            connection.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS watchers (
                    id TEXT PRIMARY KEY NOT NULL,
                    workspace_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    definition_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS watchers_workspace
                    ON watchers(workspace_id, enabled);
                 CREATE TABLE IF NOT EXISTS watcher_state (
                    watcher_id TEXT PRIMARY KEY NOT NULL
                        REFERENCES watchers(id) ON DELETE CASCADE,
                    last_run_at INTEGER,
                    last_event_key TEXT,
                    last_fired_at INTEGER,
                    last_outcome TEXT
                 );
                 CREATE TABLE IF NOT EXISTS watcher_events (
                    watcher_id TEXT NOT NULL
                        REFERENCES watchers(id) ON DELETE CASCADE,
                    event_key TEXT NOT NULL,
                    claimed_at INTEGER NOT NULL,
                    PRIMARY KEY (watcher_id, event_key)
                 );",
            )
        })?;
        Ok(store)
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut connection = Connection::open(&self.path)
            .map_err(|error| format!("open watcher database: {error}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("configure watcher database: {error}"))?;
        operation(&mut connection).map_err(|error| format!("watcher database: {error}"))
    }

    pub(crate) fn put(&self, definition: &WatcherDefinition, now: i64) -> Result<(), String> {
        definition.validate()?;
        let definition_json = serde_json::to_string(definition)
            .map_err(|error| format!("serialize watcher definition: {error}"))?;
        self.with_connection(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "INSERT INTO watchers
                    (id, workspace_id, enabled, definition_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    enabled = excluded.enabled,
                    definition_json = excluded.definition_json,
                    updated_at = excluded.updated_at",
                params![
                    definition.id,
                    definition.workspace_id,
                    definition.enabled,
                    definition_json,
                    now
                ],
            )?;
            transaction.execute(
                "INSERT OR IGNORE INTO watcher_state (watcher_id) VALUES (?1)",
                params![definition.id],
            )?;
            transaction.commit()
        })
    }

    pub(crate) fn get(&self, id: &str) -> Result<Option<WatcherRecord>, String> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT w.definition_json,
                            s.last_run_at, s.last_event_key,
                            s.last_fired_at, s.last_outcome
                     FROM watchers w
                     LEFT JOIN watcher_state s ON s.watcher_id = w.id
                     WHERE w.id = ?1",
                    params![id],
                    row_to_record,
                )
                .optional()
        })
    }

    pub(crate) fn list_workspace(&self, workspace_id: &str) -> Result<Vec<WatcherRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT w.definition_json,
                        s.last_run_at, s.last_event_key,
                        s.last_fired_at, s.last_outcome
                 FROM watchers w
                 LEFT JOIN watcher_state s ON s.watcher_id = w.id
                 WHERE w.workspace_id = ?1
                 ORDER BY w.id",
            )?;
            let records = statement
                .query_map(params![workspace_id], row_to_record)?
                .collect();
            records
        })
    }

    pub(crate) fn list_enabled(&self) -> Result<Vec<WatcherRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT w.definition_json,
                        s.last_run_at, s.last_event_key,
                        s.last_fired_at, s.last_outcome
                 FROM watchers w
                 LEFT JOIN watcher_state s ON s.watcher_id = w.id
                 WHERE w.enabled = 1
                 ORDER BY w.id",
            )?;
            let records = statement.query_map([], row_to_record)?.collect();
            records
        })
    }

    pub(crate) fn delete(&self, id: &str) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection
                .execute("DELETE FROM watchers WHERE id = ?1", params![id])
                .map(|count| count == 1)
        })
    }

    pub(crate) fn record_run(
        &self,
        id: &str,
        now: i64,
        event_key: Option<&str>,
        outcome: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE watcher_state SET
                    last_run_at = ?2,
                    last_event_key = COALESCE(?3, last_event_key),
                    last_outcome = ?4
                 WHERE watcher_id = ?1",
                params![id, now, event_key, outcome],
            )?;
            Ok(())
        })
    }

    /// Atomically reserve a source event. `false` means another tick or process
    /// already claimed it; execution must not happen again.
    pub(crate) fn claim_event(&self, id: &str, event_key: &str, now: i64) -> Result<bool, String> {
        self.with_connection(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO watcher_events
                    (watcher_id, event_key, claimed_at)
                 VALUES (?1, ?2, ?3)",
                params![id, event_key, now],
            )?;
            transaction.execute(
                "UPDATE watcher_state SET
                    last_run_at = ?2,
                    last_event_key = ?3,
                    last_outcome = ?4
                 WHERE watcher_id = ?1",
                params![
                    id,
                    now,
                    event_key,
                    if inserted == 1 {
                        "claimed"
                    } else {
                        "duplicate"
                    }
                ],
            )?;
            transaction.commit()?;
            Ok(inserted == 1)
        })
    }

    pub(crate) fn record_fired(&self, id: &str, now: i64, outcome: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE watcher_state SET
                    last_fired_at = ?2,
                    last_outcome = ?3
                 WHERE watcher_id = ?1",
                params![id, now, outcome],
            )?;
            Ok(())
        })
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<WatcherRecord> {
    let json: String = row.get(0)?;
    let definition = serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(WatcherRecord {
        definition,
        state: WatcherState {
            last_run_at: row.get(1)?,
            last_event_key: row.get(2)?,
            last_fired_at: row.get(3)?,
            last_outcome: row.get(4)?,
        },
    })
}

pub(crate) fn jitter_seconds(watcher_id: &str, interval_seconds: u64) -> u64 {
    let digest = Sha256::digest(watcher_id.as_bytes());
    let sample = u64::from_le_bytes(digest[..8].try_into().expect("sha256 prefix"));
    let window = (interval_seconds / 10).clamp(1, 60);
    sample % (window + 1)
}

pub(crate) fn is_due(record: &WatcherRecord, now: i64) -> bool {
    if !record.definition.enabled {
        return false;
    }
    let Some(last_run) = record.state.last_run_at else {
        return true;
    };
    let interval = record.definition.watch.interval_seconds();
    let jitter = jitter_seconds(&record.definition.id, interval);
    now >= last_run.saturating_add_unsigned(interval.saturating_add(jitter))
}

pub(crate) fn event_key(namespace: &str, bytes: &[u8]) -> String {
    format!("{namespace}:{}", hex::encode(Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn definition(id: &str) -> WatcherDefinition {
        WatcherDefinition {
            id: id.into(),
            workspace_id: "ws-a".into(),
            enabled: true,
            watch: WatchSource::Schedule {
                interval_seconds: MIN_INTERVAL_SECONDS,
            },
            condition: WatchCondition::Always,
            action: WatchAction::Notify {
                chat_id: 7,
                message_thread_id: None,
                text: "wake up".into(),
            },
        }
    }

    #[test]
    fn definitions_and_run_state_survive_reopen() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("watchers.sqlite");
        let store = WatcherStore::open(&path).unwrap();
        store.put(&definition("daily"), 10).unwrap();
        assert!(store.claim_event("daily", "schedule:1", 20).unwrap());
        store.record_fired("daily", 20, "notified").unwrap();
        drop(store);

        let reopened = WatcherStore::open(&path).unwrap();
        let record = reopened.get("daily").unwrap().unwrap();
        assert_eq!(record.definition, definition("daily"));
        assert_eq!(record.state.last_run_at, Some(20));
        assert_eq!(record.state.last_event_key.as_deref(), Some("schedule:1"));
        assert_eq!(record.state.last_fired_at, Some(20));
        assert_eq!(record.state.last_outcome.as_deref(), Some("notified"));
        assert!(!reopened.claim_event("daily", "schedule:1", 30).unwrap());
    }

    #[test]
    fn interval_floor_jitter_and_due_check_are_deterministic() {
        let mut invalid = definition("too-fast");
        invalid.watch = WatchSource::Schedule {
            interval_seconds: MIN_INTERVAL_SECONDS - 1,
        };
        assert!(invalid.validate().unwrap_err().contains("at least 300"));

        let mut record = WatcherRecord {
            definition: definition("jittered"),
            state: WatcherState {
                last_run_at: Some(1_000),
                ..WatcherState::default()
            },
        };
        let jitter = jitter_seconds("jittered", MIN_INTERVAL_SECONDS);
        assert_eq!(jitter, jitter_seconds("jittered", MIN_INTERVAL_SECONDS));
        assert!(!is_due(
            &record,
            1_000 + MIN_INTERVAL_SECONDS as i64 + jitter as i64 - 1
        ));
        assert!(is_due(
            &record,
            1_000 + MIN_INTERVAL_SECONDS as i64 + jitter as i64
        ));
        record.definition.enabled = false;
        assert!(!is_due(&record, i64::MAX));
    }
}
