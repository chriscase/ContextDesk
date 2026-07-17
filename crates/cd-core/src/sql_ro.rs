//! Read-only SQL execution (SQLite via rusqlite, query_only).

use crate::connectors::validate_readonly_sql;
use crate::error::{CoreError, CoreResult};
use crate::injection::wrap_untrusted;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Result of a RO query (for tools / UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlRoResult {
    /// Column names.
    pub columns: Vec<String>,
    /// Rows as string cells (capped).
    pub rows: Vec<Vec<String>>,
    /// Truncated?
    pub truncated: bool,
}

/// Max rows returned to the model.
pub const MAX_ROWS: usize = 50;
/// Max cell chars.
pub const MAX_CELL: usize = 200;

/// Execute read-only SQL against a SQLite file path.
///
/// Opens with `SQLITE_OPEN_READ_ONLY` and `PRAGMA query_only=ON`.
/// SQL must pass [`validate_readonly_sql`] first.
pub fn execute_sqlite_ro(db_path: &Path, sql: &str) -> CoreResult<SqlRoResult> {
    validate_readonly_sql(sql)?;
    if !db_path.is_file() {
        return Err(CoreError::Message(format!(
            "sqlite file not found: {}",
            db_path.display()
        )));
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| CoreError::Message(format!("sqlite open: {e}")))?;

    conn.pragma_update(None, "query_only", true)
        .map_err(|e| CoreError::Message(format!("pragma query_only: {e}")))?;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::Message(format!("prepare: {e}")))?;
    let col_count = stmt.column_count();
    let columns: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    let mut rows_out = Vec::new();
    let mut truncated = false;
    let mut rows = stmt
        .query([])
        .map_err(|e| CoreError::Message(format!("query: {e}")))?;

    while let Some(row) = rows
        .next()
        .map_err(|e| CoreError::Message(format!("row: {e}")))?
    {
        if rows_out.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let s: String = row
                .get_ref(i)
                .map(|v| match v {
                    rusqlite::types::ValueRef::Null => "NULL".into(),
                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                    rusqlite::types::ValueRef::Real(f) => f.to_string(),
                    rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    rusqlite::types::ValueRef::Blob(b) => format!("<blob {} bytes>", b.len()),
                })
                .unwrap_or_else(|_| "?".into());
            let s = if s.chars().count() > MAX_CELL {
                format!("{}…", s.chars().take(MAX_CELL).collect::<String>())
            } else {
                s
            };
            cells.push(s);
        }
        rows_out.push(cells);
    }

    Ok(SqlRoResult {
        columns,
        rows: rows_out,
        truncated,
    })
}

/// Format SQL result for the model (untrusted wrap).
pub fn format_sql_for_model(source: &str, result: &SqlRoResult) -> String {
    let mut body = format!("columns: {:?}\n", result.columns);
    for (i, row) in result.rows.iter().enumerate() {
        body.push_str(&format!("row{i}: {row:?}\n"));
    }
    if result.truncated {
        body.push_str("(truncated)\n");
    }
    wrap_untrusted(source, &body)
}

/// Validate only (no open).
pub fn sql_select_validate_only(sql: &str) -> CoreResult<()> {
    validate_readonly_sql(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_writes() {
        assert!(validate_readonly_sql("DELETE FROM t").is_err());
        assert!(sql_select_validate_only("SELECT 1").is_ok());
    }

    #[test]
    fn executes_real_select() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
                 INSERT INTO users (name) VALUES ('alice'), ('bob');",
            )
            .unwrap();
        }
        let r = execute_sqlite_ro(&db, "SELECT id, name FROM users ORDER BY id").unwrap();
        assert_eq!(r.columns, vec!["id", "name"]);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][1], "alice");
        assert_eq!(r.rows[1][1], "bob");
        assert!(!r.truncated);
    }

    #[test]
    fn write_sql_blocked_even_if_db_writable() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.db");
        Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE t (x INT);")
            .unwrap();
        assert!(execute_sqlite_ro(&db, "DELETE FROM t").is_err());
        assert!(execute_sqlite_ro(&db, "INSERT INTO t VALUES (1)").is_err());
    }

    #[test]
    fn missing_file_errors() {
        let err = execute_sqlite_ro(Path::new("/no/such/file.db"), "SELECT 1");
        assert!(err.is_err());
    }
}
