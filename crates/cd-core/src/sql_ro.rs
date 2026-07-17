//! Read-only SQL execution helpers (SQLite via rusqlite optional; pure validation always).

use crate::connectors::validate_readonly_sql;
use crate::error::CoreResult;
use crate::injection::wrap_untrusted;
use serde::{Deserialize, Serialize};

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

/// Execute read-only SQL against a SQLite file using the `sqlite` crate API when linked.
/// Default build: validate SQL and return empty result set (execution available via host).
pub fn execute_sqlite_ro(_db_path: &std::path::Path, sql: &str) -> CoreResult<SqlRoResult> {
    validate_readonly_sql(sql)?;
    // Hosts may replace this with a real engine; core guarantees validation.
    Ok(SqlRoResult {
        columns: vec![],
        rows: vec![],
        truncated: false,
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

/// Tool-facing SQL select without a live DB: validates and returns structured error or empty.
/// Used when sqlite feature off / dry-run.
pub fn sql_select_validate_only(sql: &str) -> CoreResult<()> {
    validate_readonly_sql(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::validate_readonly_sql;

    #[test]
    fn rejects_writes() {
        assert!(validate_readonly_sql("DELETE FROM t").is_err());
        assert!(sql_select_validate_only("SELECT 1").is_ok());
    }
}
