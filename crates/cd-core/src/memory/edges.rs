//! Memory edges + neighbor expansion (MEMORY.md §9 Phase 2).

use super::types::*;
use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

/// Edge relationship type (open string, common values documented).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeType(pub String);

impl EdgeType {
    /// decision → project / fact.
    pub fn relates() -> Self {
        Self("relates".into())
    }
    /// bookmark → fact.
    pub fn supports() -> Self {
        Self("supports".into())
    }
    /// parent/child style.
    pub fn child_of() -> Self {
        Self("child_of".into())
    }
}

/// One directed edge between memories.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEdge {
    /// Edge id.
    pub id: Uuid,
    /// Source memory.
    pub from_id: Uuid,
    /// Target memory.
    pub to_id: Uuid,
    /// Relationship type.
    pub edge_type: String,
    /// Created at.
    pub created_at: i64,
}

/// Edge store co-located with a memory SQLite connection path or shared conn.
pub struct EdgeStore {
    conn: Mutex<Connection>,
}

impl EdgeStore {
    /// Open at path (creates schema).
    pub fn open(path: impl AsRef<std::path::Path>) -> CoreResult<Self> {
        if let Some(p) = path.as_ref().parent() {
            std::fs::create_dir_all(p)?;
        }
        let conn = Connection::open(path.as_ref())
            .map_err(|e| CoreError::Message(format!("edge store: {e}")))?;
        init_edges(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory.
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| CoreError::Message(format!("edge store mem: {e}")))?;
        init_edges(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Attach edges schema onto an existing memory connection (workspace DB).
    pub fn ensure_on_connection(conn: &Connection) -> CoreResult<()> {
        init_edges(conn)
    }

    /// Link two memories (SoftWrite-class; caller gates permission).
    pub fn link(
        &self,
        from: Uuid,
        to: Uuid,
        edge_type: &str,
        now_secs: i64,
    ) -> CoreResult<MemoryEdge> {
        if from == to {
            return Err(CoreError::Message("cannot link memory to itself".into()));
        }
        let id = Uuid::now_v7();
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO memory_edges (id, from_id, to_id, edge_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(from_id, to_id, edge_type) DO NOTHING",
            params![
                id.to_string(),
                from.to_string(),
                to.to_string(),
                edge_type,
                now_secs
            ],
        )
        .map_err(sqlite_err)?;
        Ok(MemoryEdge {
            id,
            from_id: from,
            to_id: to,
            edge_type: edge_type.to_string(),
            created_at: now_secs,
        })
    }

    /// Neighbors of a memory (outgoing + incoming).
    pub fn neighbors(&self, id: &Uuid, limit: usize) -> CoreResult<Vec<(MemoryEdge, bool)>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, from_id, to_id, edge_type, created_at FROM memory_edges
                 WHERE from_id = ?1 OR to_id = ?1
                 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![id.to_string(), limit.clamp(1, 100) as i64], |r| {
                let from_s: String = r.get(1)?;
                let to_s: String = r.get(2)?;
                let from = Uuid::parse_str(&from_s).unwrap_or_else(|_| Uuid::nil());
                let to = Uuid::parse_str(&to_s).unwrap_or_else(|_| Uuid::nil());
                let edge = MemoryEdge {
                    id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap_or_else(|_| Uuid::nil()),
                    from_id: from,
                    to_id: to,
                    edge_type: r.get(3)?,
                    created_at: r.get(4)?,
                };
                let outgoing = from == *id;
                Ok((edge, outgoing))
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    /// Neighbor memory ids only.
    pub fn neighbor_ids(&self, id: &Uuid, limit: usize) -> CoreResult<Vec<Uuid>> {
        let mut ids = Vec::new();
        for (e, outgoing) in self.neighbors(id, limit)? {
            ids.push(if outgoing { e.to_id } else { e.from_id });
        }
        Ok(ids)
    }
}

/// Expand recall hits with neighbor records from the same store (one hop).
pub fn expand_recall_neighbors(
    store: &dyn super::MemoryStore,
    edges: &EdgeStore,
    hits: &[RecallHit],
    now_secs: i64,
    max_extra: usize,
) -> CoreResult<Vec<RecallHit>> {
    let mut out = hits.to_vec();
    let mut seen: std::collections::HashSet<Uuid> = hits.iter().map(|h| h.record.id).collect();
    let mut extra = 0usize;
    for h in hits {
        if extra >= max_extra {
            break;
        }
        for nid in edges.neighbor_ids(&h.record.id, 4)? {
            if !seen.insert(nid) {
                continue;
            }
            if let Some(rec) = store.get(&nid)? {
                if rec.status != Status::Active {
                    continue;
                }
                if !is_valid_now(rec.valid_from, rec.valid_to, now_secs) {
                    continue;
                }
                out.push(RecallHit {
                    source_id: RecallHit::memory_source_id(&rec.id),
                    snippet: rec.content.chars().take(160).collect(),
                    score: h.score * 0.85,
                    keyword_score: 0.0,
                    semantic_score: 0.0,
                    recency_score: h.recency_score,
                    record: rec,
                });
                extra += 1;
                if extra >= max_extra {
                    break;
                }
            }
        }
    }
    Ok(out)
}

fn init_edges(conn: &Connection) -> CoreResult<()> {
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
"#,
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn lock_err() -> CoreError {
    CoreError::Message("edge store lock poisoned".into())
}
fn sqlite_err(e: rusqlite::Error) -> CoreError {
    CoreError::Message(format!("sqlite: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite_store::SqliteMemoryStore;
    use crate::memory::{MemoryDraft, MemoryStore, MemoryWriteOp};

    #[test]
    fn link_and_expand_neighbors() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let a = store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(Kind::Decision, "use Postgres")),
                1,
            )
            .unwrap();
        let b = store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(Kind::ProjectNote, "NexaDB project")),
                2,
            )
            .unwrap();
        let edges = EdgeStore::open_in_memory().unwrap();
        edges.link(a.id, b.id, "relates", 3).unwrap();
        let n = edges.neighbor_ids(&a.id, 10).unwrap();
        assert!(n.contains(&b.id));

        let hits = vec![RecallHit {
            record: store.get(&a.id).unwrap().unwrap(),
            score: 1.0,
            keyword_score: 1.0,
            semantic_score: 0.0,
            recency_score: 1.0,
            source_id: RecallHit::memory_source_id(&a.id),
            snippet: "use Postgres".into(),
        }];
        let expanded = expand_recall_neighbors(&store, &edges, &hits, 10, 5).unwrap();
        assert!(
            expanded.iter().any(|h| h.record.id == b.id),
            "neighbor must expand: {:?}",
            expanded.iter().map(|h| h.record.id).collect::<Vec<_>>()
        );
    }
}
