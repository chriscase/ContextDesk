//! Versioned migration runner for the memory SQLite database.
//!
//! Improves on ad-hoc `CREATE IF NOT EXISTS` by tracking applied versions in
//! `memory_schema_migrations` and applying each version exactly once.

use crate::error::{CoreError, CoreResult};
use rusqlite::Connection;

/// Current schema version shipped by this crate.
pub const MEMORY_SCHEMA_VERSION: i64 = 3;

/// Apply all pending migrations up to [`MEMORY_SCHEMA_VERSION`].
///
/// Idempotent: re-running after a successful apply is a no-op.
pub fn migrate(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;",
    )
    .map_err(sqlite_err)?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );",
    )
    .map_err(sqlite_err)?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM memory_schema_migrations",
            [],
            |r| r.get(0),
        )
        .map_err(sqlite_err)?;

    if current < 1 {
        apply_v1(conn)?;
        record(conn, 1)?;
    }
    if current < 2 {
        apply_v2_harvest(conn)?;
        record(conn, 2)?;
    }
    if current < 3 {
        apply_v3_phase2(conn)?;
        record(conn, 3)?;
    }

    Ok(())
}

/// Phase 2: edges + purge tombstones (candidates live in separate inbox file).
fn apply_v3_phase2(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);

CREATE TABLE IF NOT EXISTS memory_purge_tombstones (
  id TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title_redacted TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'gdpr_purge'
);
"#,
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn record(conn: &Connection, version: i64) -> CoreResult<()> {
    let now = crate::embed::now_unix_secs();
    conn.execute(
        "INSERT OR IGNORE INTO memory_schema_migrations (version, applied_at) VALUES (?1, ?2)",
        rusqlite::params![version, now],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn apply_v1(conn: &Connection) -> CoreResult<()> {
    // MEMORY.md §3 DDL — store-maintained FTS (no external-content triggers),
    // separate memory_embeddings (never the index DB embeddings cache).
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS memory (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL,
  structured     TEXT NOT NULL DEFAULT '{}',

  status         TEXT NOT NULL DEFAULT 'active',
  valid_from     INTEGER,
  valid_to       INTEGER,
  supersedes     TEXT REFERENCES memory(id) ON DELETE SET NULL,
  superseded_by  TEXT REFERENCES memory(id) ON DELETE SET NULL,

  scope          TEXT NOT NULL DEFAULT 'workspace',
  workspace_id   TEXT,

  confidence     REAL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'user',
  created_by     TEXT NOT NULL DEFAULT 'user',
  origin_session_id TEXT,
  origin_tool    TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  rev            INTEGER NOT NULL DEFAULT 1,
  origin_node    TEXT,
  content_hash   TEXT NOT NULL,

  url            TEXT,
  due_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_current  ON memory(status, scope, workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_kind     ON memory(kind, status);
CREATE INDEX IF NOT EXISTS idx_memory_updated  ON memory(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_valid_to ON memory(valid_to) WHERE valid_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_hash     ON memory(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  title,
  memory_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
"#,
    )
    .map_err(sqlite_err)?;
    Ok(())
}

/// Harvest / SourceRef linkage tables (#326 PR2). Co-located with memory DB.
fn apply_v2_harvest(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS harvest (
  id                  TEXT PRIMARY KEY,
  source_system       TEXT NOT NULL,
  source_instance     TEXT NOT NULL,
  source_remote_id    TEXT NOT NULL,
  source_collection   TEXT,
  source_url          TEXT,
  remote_version      INTEGER,
  remote_etag         TEXT,
  remote_content_hash TEXT,
  memory_id           TEXT,
  memory_lineage_root TEXT,
  workspace_path      TEXT,
  transform_profile   TEXT NOT NULL,
  last_synced_at      INTEGER NOT NULL,
  local_content_hash  TEXT NOT NULL,
  local_dirty         INTEGER NOT NULL DEFAULT 0,
  sync_status         TEXT NOT NULL DEFAULT 'in_sync',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (
    (memory_id IS NOT NULL AND workspace_path IS NULL)
    OR (memory_id IS NULL AND workspace_path IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harvest_mem_dest
  ON harvest(source_system, source_instance, source_remote_id, transform_profile)
  WHERE memory_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_harvest_file_dest
  ON harvest(source_system, source_instance, source_remote_id, transform_profile)
  WHERE workspace_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_harvest_remote
  ON harvest(source_system, source_instance, source_remote_id);
CREATE INDEX IF NOT EXISTS idx_harvest_memory ON harvest(memory_id);
CREATE INDEX IF NOT EXISTS idx_harvest_lineage ON harvest(memory_lineage_root);
"#,
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn sqlite_err(e: rusqlite::Error) -> CoreError {
    CoreError::Message(format!("memory sqlite: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT MAX(version) FROM memory_schema_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, MEMORY_SCHEMA_VERSION);
        // Tables exist
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        let fts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='memory_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts, 1);
        let emb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='memory_embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(emb, 1);
        // Index DB footgun table name must NOT be present
        let bad: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad, 0, "must not create index-style embeddings table");
        let harvest: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='harvest'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(harvest, 1, "v2 harvest table required");
    }

    #[test]
    fn journal_mode_is_wal_on_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode.to_lowercase(), "wal");
        }
    }
}
