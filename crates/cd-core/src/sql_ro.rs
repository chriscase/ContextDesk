//! Read-only SQL execution (SQLite + Postgres) with timeouts and row caps (#130).

use crate::connectors::validate_readonly_sql;
use crate::error::{CoreError, CoreResult};
use crate::injection::wrap_untrusted;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
/// Default wall-clock query timeout.
pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;

/// Backend kind for a registered SQL source.
#[derive(Debug, Clone)]
pub enum SqlBackend {
    /// Local SQLite file (read-only open).
    Sqlite {
        /// Absolute path to `.db` / `.sqlite` file.
        path: PathBuf,
        /// Wall-clock timeout in milliseconds.
        timeout_ms: u64,
    },
    /// Postgres (session set read-only + statement_timeout).
    Postgres(PostgresConnectConfig),
}

/// Non-secret Postgres connection parameters + optional password (host-only, never IPC).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresConnectConfig {
    /// Host name or IP.
    pub host: String,
    /// Port (default 5432).
    #[serde(default = "default_pg_port")]
    pub port: u16,
    /// Database name.
    pub database: String,
    /// Role (prefer a dedicated RO role — see docs/DEV.md).
    pub user: String,
    /// `disable` | `prefer` | `require` (prefer/require need TLS residual if unavailable).
    #[serde(default = "default_sslmode")]
    pub sslmode: String,
    /// Password — set by host from keychain only; never persist in config.json.
    #[serde(skip)]
    pub password: Option<String>,
    /// Wall-clock / statement_timeout milliseconds.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_pg_port() -> u16 {
    5432
}
fn default_sslmode() -> String {
    "prefer".into()
}
fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

impl PostgresConnectConfig {
    /// Build a libpq-style connection string (password included when present).
    /// Offline-testable; does not open a socket.
    pub fn connection_string(&self) -> String {
        let mut s = format!(
            "host={} port={} dbname={} user={} connect_timeout={}",
            escape_conn_val(&self.host),
            self.port,
            escape_conn_val(&self.database),
            escape_conn_val(&self.user),
            (self.timeout_ms / 1000).max(1),
        );
        if let Some(pw) = &self.password {
            s.push_str(&format!(" password={}", escape_conn_val(pw)));
        }
        // tokio-postgres NoTls path only for disable; others documented residual.
        if self.sslmode.eq_ignore_ascii_case("disable") {
            s.push_str(" sslmode=disable");
        } else {
            s.push_str(&format!(" sslmode={}", escape_conn_val(&self.sslmode)));
        }
        s
    }
}

fn escape_conn_val(v: &str) -> String {
    if v.is_empty()
        || v.chars()
            .any(|c| c.is_whitespace() || c == '\'' || c == '\\')
    {
        format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
    } else {
        v.to_string()
    }
}

/// Session setup statements for Postgres RO defense-in-depth (#130 / #46).
pub fn postgres_ro_session_sqls(timeout_ms: u64) -> Vec<String> {
    let ms = timeout_ms.clamp(100, 120_000);
    vec![
        "SET default_transaction_read_only = on".into(),
        format!("SET statement_timeout = {ms}"),
    ]
}

/// Append `LIMIT MAX_ROWS+1` when the query has no LIMIT (cursor-level row cap).
pub fn with_row_limit(sql: &str) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let lower = trimmed.to_lowercase();
    // crude but effective: skip if limit already present as a clause keyword
    if lower.split_whitespace().any(|w| w == "limit") {
        trimmed.to_string()
    } else {
        format!("{trimmed} LIMIT {}", MAX_ROWS + 1)
    }
}

/// Execute read-only SQL against a SQLite file path (default timeout).
pub fn execute_sqlite_ro(db_path: &Path, sql: &str) -> CoreResult<SqlRoResult> {
    execute_sqlite_ro_with_timeout(db_path, sql, Duration::from_millis(DEFAULT_TIMEOUT_MS))
}

/// SQLite RO with wall-clock timeout via interrupt handle (#130).
pub fn execute_sqlite_ro_with_timeout(
    db_path: &Path,
    sql: &str,
    timeout: Duration,
) -> CoreResult<SqlRoResult> {
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

    let interrupt = conn.get_interrupt_handle();
    let done = Arc::new(AtomicBool::new(false));
    let done_w = Arc::clone(&done);
    let watcher = std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if !done_w.load(Ordering::SeqCst) {
            interrupt.interrupt();
        }
    });

    let capped = with_row_limit(sql);
    let result = run_sqlite_query(&conn, &capped);
    done.store(true, Ordering::SeqCst);
    let _ = watcher.join();

    match result {
        Err(e) if format!("{e}").to_lowercase().contains("interrupt") => Err(CoreError::Message(
            format!("sqlite query interrupted after {timeout:?} (timeout)"),
        )),
        other => other,
    }
}

fn run_sqlite_query(conn: &Connection, sql: &str) -> CoreResult<SqlRoResult> {
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
            cells.push(truncate_cell(&s));
        }
        rows_out.push(cells);
    }

    Ok(SqlRoResult {
        columns,
        rows: rows_out,
        truncated,
    })
}

fn truncate_cell(s: &str) -> String {
    if s.chars().count() > MAX_CELL {
        format!("{}…", s.chars().take(MAX_CELL).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Execute against a [`SqlBackend`].
pub fn execute_sql_backend(backend: &SqlBackend, sql: &str) -> CoreResult<SqlRoResult> {
    match backend {
        SqlBackend::Sqlite { path, timeout_ms } => {
            execute_sqlite_ro_with_timeout(path, sql, Duration::from_millis((*timeout_ms).max(100)))
        }
        SqlBackend::Postgres(cfg) => execute_postgres_ro_blocking(cfg, sql),
    }
}

/// Blocking Postgres RO query (tokio runtime for tokio-postgres).
pub fn execute_postgres_ro_blocking(
    cfg: &PostgresConnectConfig,
    sql: &str,
) -> CoreResult<SqlRoResult> {
    // Prefer existing runtime; otherwise create a short-lived one.
    match tokio::runtime::Handle::try_current() {
        Ok(h) => tokio::task::block_in_place(|| h.block_on(execute_postgres_ro(cfg, sql))),
        Err(_) => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| CoreError::Message(format!("tokio runtime: {e}")))?;
            rt.block_on(execute_postgres_ro(cfg, sql))
        }
    }
}

/// Async Postgres RO: SET read_only + statement_timeout, then SELECT.
///
/// Requires `sslmode=disable` in this build (NoTls). Prefer/require is refused with a
/// clear error so we never silently drop TLS requirements.
pub async fn execute_postgres_ro(
    cfg: &PostgresConnectConfig,
    sql: &str,
) -> CoreResult<SqlRoResult> {
    validate_readonly_sql(sql)?;
    if !cfg.sslmode.eq_ignore_ascii_case("disable") {
        return Err(CoreError::Config(format!(
            "Postgres sslmode=`{}` requires TLS; this build supports sslmode=disable only (set sslmode=disable for local RO, or track TLS residual)",
            cfg.sslmode
        )));
    }
    let dsn = cfg.connection_string();
    let (client, connection) = tokio_postgres::connect(&dsn, tokio_postgres::NoTls)
        .await
        .map_err(|e| CoreError::Message(format!("postgres connect: {e}")))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            tracing::warn!(error = %e, "postgres connection closed");
        }
    });

    for stmt in postgres_ro_session_sqls(cfg.timeout_ms) {
        client
            .batch_execute(&stmt)
            .await
            .map_err(|e| CoreError::Message(format!("postgres session setup: {e}")))?;
    }

    let capped = with_row_limit(sql);
    let rows = client
        .query(&capped, &[])
        .await
        .map_err(|e| CoreError::Message(format!("postgres query: {e}")))?;

    let columns: Vec<String> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect()
    } else {
        // No rows: still try to get columns from a prepare-style empty result.
        Vec::new()
    };

    let mut rows_out = Vec::new();
    let mut truncated = false;
    for row in rows {
        if rows_out.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        if columns.is_empty() {
            // Unreachable if we got rows, but keep safe.
        }
        let cols = row.columns();
        let mut cells = Vec::with_capacity(cols.len());
        for (i, _) in cols.iter().enumerate() {
            let s: String = match row.try_get::<_, Option<String>>(i) {
                Ok(Some(v)) => v,
                Ok(None) => "NULL".into(),
                Err(_) => match row.try_get::<_, Option<i64>>(i) {
                    Ok(Some(n)) => n.to_string(),
                    Ok(None) => "NULL".into(),
                    Err(_) => match row.try_get::<_, Option<f64>>(i) {
                        Ok(Some(f)) => f.to_string(),
                        Ok(None) => "NULL".into(),
                        Err(_) => "?".into(),
                    },
                },
            };
            cells.push(truncate_cell(&s));
        }
        rows_out.push(cells);
    }

    // If first row established columns when empty name list
    let columns = if columns.is_empty() && !rows_out.is_empty() {
        (0..rows_out[0].len()).map(|i| format!("c{i}")).collect()
    } else {
        columns
    };

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

/// Parse SQLite connector settings into a backend (no secrets).
pub fn sqlite_backend_from_settings(settings: &serde_json::Value) -> CoreResult<SqlBackend> {
    let path = settings
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Config("sqlite connector missing settings.path".into()))?
        .trim();
    if path.is_empty() {
        return Err(CoreError::Config("sqlite path is empty".into()));
    }
    let pb = PathBuf::from(path);
    if !pb.is_absolute() {
        return Err(CoreError::Config(
            "sqlite path must be absolute (no relative paths)".into(),
        ));
    }
    let timeout_ms = settings
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(100, 120_000);
    Ok(SqlBackend::Sqlite {
        path: pb,
        timeout_ms,
    })
}

/// Parse Postgres connector settings (password filled by host from keychain).
pub fn postgres_config_from_settings(
    settings: &serde_json::Value,
    password: Option<String>,
) -> CoreResult<PostgresConnectConfig> {
    let host = settings
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1")
        .trim()
        .to_string();
    let database = settings
        .get("database")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Config("postgres connector missing settings.database".into()))?
        .trim()
        .to_string();
    if database.is_empty() {
        return Err(CoreError::Config("postgres database is empty".into()));
    }
    let user = settings
        .get("user")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Config("postgres connector missing settings.user".into()))?
        .trim()
        .to_string();
    let port = settings
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(5432) as u16;
    let sslmode = settings
        .get("sslmode")
        .and_then(|v| v.as_str())
        .unwrap_or("prefer")
        .to_string();
    let timeout_ms = settings
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(100, 120_000);
    Ok(PostgresConnectConfig {
        host,
        port,
        database,
        user,
        sslmode,
        password,
        timeout_ms,
    })
}

/// Keychain ref id for a postgres connector password (never the secret itself).
pub fn postgres_password_ref(connector_id: &str) -> String {
    format!("connector/{connector_id}/password")
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

    #[test]
    fn with_row_limit_appends_when_missing() {
        let s = with_row_limit("SELECT * FROM t");
        assert!(s.to_lowercase().contains("limit"), "{s}");
        assert!(with_row_limit("SELECT * FROM t LIMIT 3")
            .to_lowercase()
            .contains("limit 3"));
    }

    #[test]
    fn row_cap_reports_truncated() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE t (id INTEGER);").unwrap();
            for i in 0..60 {
                conn.execute("INSERT INTO t VALUES (?1)", [i]).unwrap();
            }
        }
        let r = execute_sqlite_ro(&db, "SELECT id FROM t ORDER BY id").unwrap();
        assert_eq!(r.rows.len(), MAX_ROWS);
        assert!(r.truncated);
    }

    /// Wall-clock interrupt: recursive CTE under a very short timeout must fail.
    #[test]
    fn sqlite_timeout_interrupts_runaway() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.db");
        Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE t (x INT);")
            .unwrap();
        // Busy pure-SQL loop: recursive CTE without early exit bound by LIMIT in outer —
        // interrupt should fire before completion under 50ms.
        let sql = "WITH RECURSIVE cnt(x) AS (
            SELECT 1
            UNION ALL
            SELECT x+1 FROM cnt WHERE x < 100000000
        ) SELECT x FROM cnt WHERE x = 100000000";
        let err = execute_sqlite_ro_with_timeout(&db, sql, Duration::from_millis(50));
        assert!(err.is_err(), "expected timeout, got {err:?}");
        let msg = format!("{}", err.unwrap_err()).to_lowercase();
        assert!(
            msg.contains("interrupt") || msg.contains("timeout") || msg.contains("query"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn postgres_session_sqls_set_ro_and_timeout() {
        let sqls = postgres_ro_session_sqls(1500);
        assert!(sqls
            .iter()
            .any(|s| s.contains("default_transaction_read_only")));
        assert!(sqls.iter().any(|s| s.contains("statement_timeout = 1500")));
    }

    #[test]
    fn postgres_dsn_builds_without_network() {
        let cfg = PostgresConnectConfig {
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            user: "cd_ro".into(),
            sslmode: "disable".into(),
            password: Some("s3cret".into()),
            timeout_ms: 3000,
        };
        let dsn = cfg.connection_string();
        assert!(dsn.contains("host=127.0.0.1"));
        assert!(dsn.contains("dbname=app"));
        assert!(dsn.contains("user=cd_ro"));
        assert!(dsn.contains("password=s3cret"));
        assert!(dsn.contains("sslmode=disable"));
        // Password must not appear in Serialize of config used for persistence.
        let v = serde_json::to_value(&cfg).unwrap();
        assert!(v.get("password").is_none());
    }

    #[test]
    fn postgres_ssl_require_refused_without_tls_stack() {
        let cfg = PostgresConnectConfig {
            host: "127.0.0.1".into(),
            port: 5432,
            database: "app".into(),
            user: "cd_ro".into(),
            sslmode: "require".into(),
            password: None,
            timeout_ms: 1000,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(execute_postgres_ro(&cfg, "SELECT 1"));
        assert!(err.is_err());
        assert!(format!("{}", err.unwrap_err()).contains("sslmode"));
    }

    #[test]
    fn sqlite_settings_require_absolute_path() {
        assert!(sqlite_backend_from_settings(&serde_json::json!({"path": "rel.db"})).is_err());
        let b = sqlite_backend_from_settings(&serde_json::json!({
            "path": "/tmp/x.db",
            "timeout_ms": 2000
        }))
        .unwrap();
        match b {
            SqlBackend::Sqlite { path, timeout_ms } => {
                assert_eq!(path, PathBuf::from("/tmp/x.db"));
                assert_eq!(timeout_ms, 2000);
            }
            _ => panic!("expected sqlite"),
        }
    }

    #[test]
    fn password_ref_shape() {
        assert_eq!(
            postgres_password_ref("pg-main"),
            "connector/pg-main/password"
        );
    }

    /// Live Postgres — opt-in only (AGENTS.md offline default).
    #[test]
    #[ignore = "requires live Postgres; set CD_PG_TEST_DSN env and run with --ignored"]
    fn live_postgres_select_ro() {
        let dsn = std::env::var("CD_PG_TEST_DSN").expect("CD_PG_TEST_DSN");
        // Parse minimally: expect host=... form or skip
        let cfg = PostgresConnectConfig {
            host: "127.0.0.1".into(),
            port: 5432,
            database: "postgres".into(),
            user: "postgres".into(),
            sslmode: "disable".into(),
            password: None,
            timeout_ms: 3000,
        };
        let _ = dsn;
        let r = execute_postgres_ro_blocking(&cfg, "SELECT 1 AS n").expect("live select");
        assert!(!r.rows.is_empty());
    }
}
