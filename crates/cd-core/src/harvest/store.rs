//! SQLite harvest store co-located with memory DB (#326 PR2).

use super::types::*;
use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// Harvest table CRUD on a memory-scope SQLite database.
pub struct HarvestStore {
    path: Option<PathBuf>,
    conn: Mutex<Connection>,
}

impl HarvestStore {
    /// Open file-backed store (runs memory+harvest migrations).
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)
            .map_err(|e| CoreError::Message(format!("harvest open {}: {e}", path.display())))?;
        crate::memory::migrate::migrate(&conn)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            conn: Mutex::new(conn),
        })
    }

    /// In-memory hermetic store.
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| CoreError::Message(format!("harvest open_in_memory: {e}")))?;
        crate::memory::migrate::migrate(&conn)?;
        Ok(Self {
            path: None,
            conn: Mutex::new(conn),
        })
    }

    /// Wrap an existing connection that already has migrations applied.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            path: None,
            conn: Mutex::new(conn),
        }
    }

    /// Filesystem path when file-backed.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Insert a new harvest row. Fails if partial unique index conflicts.
    pub fn insert(&self, record: &HarvestRecord) -> CoreResult<()> {
        validate_destination(&record.destination)?;
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let (memory_id, lineage, workspace_path) = dest_cols(&record.destination);
        conn.execute(
            r#"
INSERT INTO harvest (
  id, source_system, source_instance, source_remote_id, source_collection, source_url,
  remote_version, remote_etag, remote_content_hash,
  memory_id, memory_lineage_root, workspace_path,
  transform_profile, last_synced_at, local_content_hash, local_dirty, sync_status,
  created_at, updated_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6,
  ?7, ?8, ?9,
  ?10, ?11, ?12,
  ?13, ?14, ?15, ?16, ?17,
  ?18, ?19
)"#,
            params![
                record.id.to_string(),
                record.source.system,
                record.source.instance,
                record.source.remote_id,
                record.source.collection,
                record.source.url,
                record.source.remote_version,
                record.source.etag,
                record.source.remote_content_hash,
                memory_id,
                lineage,
                workspace_path,
                record.transform_profile,
                record.last_synced_at,
                record.local_content_hash,
                if record.local_dirty { 1 } else { 0 },
                record.sync_status.as_str(),
                record.created_at,
                record.updated_at,
            ],
        )
        .map_err(map_unique)?;
        Ok(())
    }

    /// Upsert by remote keys + transform + destination kind (memory vs file).
    ///
    /// On conflict: update hashes/versions, clear dirty, keep lineage root.
    pub fn upsert_by_remote(&self, record: &HarvestRecord) -> CoreResult<Uuid> {
        validate_destination(&record.destination)?;
        if let Some(existing) = self.find_by_remote_dest(
            &record.source.system,
            &record.source.instance,
            &record.source.remote_id,
            &record.transform_profile,
            matches!(record.destination, HarvestDestination::Memory { .. }),
        )? {
            let mut updated = record.clone();
            updated.id = existing.id;
            // Keep lineage root from the original harvest row.
            if let (
                HarvestDestination::Memory { memory_id, .. },
                HarvestDestination::Memory {
                    memory_lineage_root: old_root,
                    ..
                },
            ) = (&record.destination, &existing.destination)
            {
                updated.destination = HarvestDestination::Memory {
                    memory_id: *memory_id,
                    memory_lineage_root: *old_root,
                };
            }
            updated.created_at = existing.created_at;
            self.update(&updated)?;
            return Ok(updated.id);
        }
        self.insert(record)?;
        Ok(record.id)
    }

    /// Full row replace by primary key.
    pub fn update(&self, record: &HarvestRecord) -> CoreResult<()> {
        validate_destination(&record.destination)?;
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let (memory_id, lineage, workspace_path) = dest_cols(&record.destination);
        let n = conn
            .execute(
                r#"
UPDATE harvest SET
  source_system = ?2, source_instance = ?3, source_remote_id = ?4,
  source_collection = ?5, source_url = ?6,
  remote_version = ?7, remote_etag = ?8, remote_content_hash = ?9,
  memory_id = ?10, memory_lineage_root = ?11, workspace_path = ?12,
  transform_profile = ?13, last_synced_at = ?14, local_content_hash = ?15,
  local_dirty = ?16, sync_status = ?17, updated_at = ?18
WHERE id = ?1"#,
                params![
                    record.id.to_string(),
                    record.source.system,
                    record.source.instance,
                    record.source.remote_id,
                    record.source.collection,
                    record.source.url,
                    record.source.remote_version,
                    record.source.etag,
                    record.source.remote_content_hash,
                    memory_id,
                    lineage,
                    workspace_path,
                    record.transform_profile,
                    record.last_synced_at,
                    record.local_content_hash,
                    if record.local_dirty { 1 } else { 0 },
                    record.sync_status.as_str(),
                    record.updated_at,
                ],
            )
            .map_err(sqlite_err)?;
        if n == 0 {
            return Err(CoreError::Message(format!(
                "harvest row {} not found",
                record.id
            )));
        }
        Ok(())
    }

    /// Load by harvest id.
    pub fn get(&self, id: &Uuid) -> CoreResult<Option<HarvestRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let row = conn
            .query_row(
                "SELECT id, source_system, source_instance, source_remote_id, source_collection,
                        source_url, remote_version, remote_etag, remote_content_hash,
                        memory_id, memory_lineage_root, workspace_path,
                        transform_profile, last_synced_at, local_content_hash, local_dirty,
                        sync_status, created_at, updated_at
                 FROM harvest WHERE id = ?1",
                params![id.to_string()],
                map_row,
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row)
    }

    /// Find by remote keys + transform for a destination kind.
    pub fn find_by_remote_dest(
        &self,
        system: &str,
        instance: &str,
        remote_id: &str,
        transform_profile: &str,
        memory_dest: bool,
    ) -> CoreResult<Option<HarvestRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let sql = if memory_dest {
            "SELECT id, source_system, source_instance, source_remote_id, source_collection,
                    source_url, remote_version, remote_etag, remote_content_hash,
                    memory_id, memory_lineage_root, workspace_path,
                    transform_profile, last_synced_at, local_content_hash, local_dirty,
                    sync_status, created_at, updated_at
             FROM harvest
             WHERE source_system = ?1 AND source_instance = ?2 AND source_remote_id = ?3
               AND transform_profile = ?4 AND memory_id IS NOT NULL
             LIMIT 1"
        } else {
            "SELECT id, source_system, source_instance, source_remote_id, source_collection,
                    source_url, remote_version, remote_etag, remote_content_hash,
                    memory_id, memory_lineage_root, workspace_path,
                    transform_profile, last_synced_at, local_content_hash, local_dirty,
                    sync_status, created_at, updated_at
             FROM harvest
             WHERE source_system = ?1 AND source_instance = ?2 AND source_remote_id = ?3
               AND transform_profile = ?4 AND workspace_path IS NOT NULL
             LIMIT 1"
        };
        let row = conn
            .query_row(
                sql,
                params![system, instance, remote_id, transform_profile],
                map_row,
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row)
    }

    /// Find harvest row whose active memory_id matches.
    pub fn find_by_memory_id(&self, memory_id: &Uuid) -> CoreResult<Option<HarvestRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let row = conn
            .query_row(
                "SELECT id, source_system, source_instance, source_remote_id, source_collection,
                        source_url, remote_version, remote_etag, remote_content_hash,
                        memory_id, memory_lineage_root, workspace_path,
                        transform_profile, last_synced_at, local_content_hash, local_dirty,
                        sync_status, created_at, updated_at
                 FROM harvest WHERE memory_id = ?1 LIMIT 1",
                params![memory_id.to_string()],
                map_row,
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row)
    }

    /// Rewrite active memory_id after supersede; keep lineage; mark dirty unless from sync.
    pub fn on_memory_superseded(
        &self,
        old_id: &Uuid,
        new_id: &Uuid,
        now_secs: i64,
        mark_dirty: bool,
    ) -> CoreResult<bool> {
        let Some(mut rec) = self.find_by_memory_id(old_id)? else {
            return Ok(false);
        };
        let lineage = match &rec.destination {
            HarvestDestination::Memory {
                memory_lineage_root,
                ..
            } => *memory_lineage_root,
            HarvestDestination::File { .. } => return Ok(false),
        };
        rec.destination = HarvestDestination::Memory {
            memory_id: *new_id,
            memory_lineage_root: lineage,
        };
        if mark_dirty {
            rec.local_dirty = true;
            if rec.sync_status == SyncStatus::InSync {
                rec.sync_status = SyncStatus::LocalDirty;
            }
        }
        rec.updated_at = now_secs;
        self.update(&rec)?;
        Ok(true)
    }

    /// Mark missing_local after retract; keep last memory_id (CHECK).
    pub fn on_memory_retracted(&self, memory_id: &Uuid, now_secs: i64) -> CoreResult<bool> {
        let Some(mut rec) = self.find_by_memory_id(memory_id)? else {
            return Ok(false);
        };
        rec.sync_status = SyncStatus::MissingLocal;
        rec.updated_at = now_secs;
        self.update(&rec)?;
        Ok(true)
    }

    /// List all harvest rows (newest updated first).
    pub fn list(&self, limit: usize) -> CoreResult<Vec<HarvestRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, source_system, source_instance, source_remote_id, source_collection,
                        source_url, remote_version, remote_etag, remote_content_hash,
                        memory_id, memory_lineage_root, workspace_path,
                        transform_profile, last_synced_at, local_content_hash, local_dirty,
                        sync_status, created_at, updated_at
                 FROM harvest ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![limit as i64], map_row)
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sqlite_err)?);
        }
        Ok(out)
    }
}

fn dest_cols(dest: &HarvestDestination) -> (Option<String>, Option<String>, Option<String>) {
    match dest {
        HarvestDestination::Memory {
            memory_id,
            memory_lineage_root,
        } => (
            Some(memory_id.to_string()),
            Some(memory_lineage_root.to_string()),
            None,
        ),
        HarvestDestination::File { workspace_path } => (None, None, Some(workspace_path.clone())),
    }
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HarvestRecord> {
    let id: String = r.get(0)?;
    let memory_id: Option<String> = r.get(9)?;
    let lineage: Option<String> = r.get(10)?;
    let workspace_path: Option<String> = r.get(11)?;
    let destination = if let Some(mid) = memory_id {
        HarvestDestination::Memory {
            memory_id: Uuid::parse_str(&mid).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    9,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
            memory_lineage_root: Uuid::parse_str(lineage.as_deref().unwrap_or(&mid)).map_err(
                |e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        10,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                },
            )?,
        }
    } else {
        HarvestDestination::File {
            workspace_path: workspace_path.unwrap_or_default(),
        }
    };
    let dirty: i64 = r.get(15)?;
    let status: String = r.get(16)?;
    Ok(HarvestRecord {
        id: Uuid::parse_str(&id).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        source: SourceRef {
            system: r.get(1)?,
            instance: r.get(2)?,
            remote_id: r.get(3)?,
            collection: r.get(4)?,
            url: r.get(5)?,
            remote_version: r.get(6)?,
            etag: r.get(7)?,
            remote_content_hash: r.get(8)?,
        },
        destination,
        transform_profile: r.get(12)?,
        last_synced_at: r.get(13)?,
        local_content_hash: r.get(14)?,
        local_dirty: dirty != 0,
        sync_status: SyncStatus::parse(&status).unwrap_or(SyncStatus::InSync),
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

fn map_unique(e: rusqlite::Error) -> CoreError {
    let msg = e.to_string();
    if msg.contains("UNIQUE") || msg.contains("unique") {
        CoreError::Policy(format!(
            "harvest already exists for this remote+profile+destination: {msg}"
        ))
    } else {
        sqlite_err(e)
    }
}

fn sqlite_err(e: rusqlite::Error) -> CoreError {
    CoreError::Message(format!("harvest sqlite: {e}"))
}

fn lock_err() -> CoreError {
    CoreError::Message("harvest store lock poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harvest::profiles;

    fn mem_record(remote: &str, profile: &str, mem: Uuid) -> HarvestRecord {
        let now = 1_700_000_000;
        HarvestRecord {
            id: Uuid::now_v7(),
            source: SourceRef {
                system: "confluence".into(),
                instance: "https://wiki.example.com".into(),
                remote_id: remote.into(),
                collection: Some("ENG".into()),
                remote_version: Some(1),
                etag: None,
                url: Some("https://wiki.example.com/pages/viewpage.action?pageId=1".into()),
                remote_content_hash: Some("abc".into()),
            },
            destination: HarvestDestination::Memory {
                memory_id: mem,
                memory_lineage_root: mem,
            },
            transform_profile: profile.into(),
            last_synced_at: now,
            local_content_hash: "local1".into(),
            local_dirty: false,
            sync_status: SyncStatus::InSync,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn rejects_duplicate_memory_dest_same_remote_profile() {
        let store = HarvestStore::open_in_memory().unwrap();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let r1 = mem_record("42", profiles::PLAIN_STRIP, a);
        store.insert(&r1).unwrap();
        let r2 = mem_record("42", profiles::PLAIN_STRIP, b);
        let err = store.insert(&r2).unwrap_err();
        assert!(
            err.to_string().contains("already exists") || err.to_string().contains("UNIQUE"),
            "{err}"
        );
    }

    #[test]
    fn allows_different_transform_profiles() {
        let store = HarvestStore::open_in_memory().unwrap();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        store
            .insert(&mem_record("42", profiles::PLAIN_STRIP, a))
            .unwrap();
        store
            .insert(&mem_record("42", profiles::RAW_STORAGE, b))
            .unwrap();
        assert_eq!(store.list(10).unwrap().len(), 2);
    }

    #[test]
    fn supersede_rewrites_memory_id_keeps_lineage() {
        let store = HarvestStore::open_in_memory().unwrap();
        let old = Uuid::now_v7();
        let new = Uuid::now_v7();
        let r = mem_record("99", profiles::PLAIN_STRIP, old);
        let lineage = old;
        store.insert(&r).unwrap();
        assert!(store
            .on_memory_superseded(&old, &new, 1_700_000_100, true)
            .unwrap());
        let got = store.find_by_memory_id(&new).unwrap().unwrap();
        match got.destination {
            HarvestDestination::Memory {
                memory_id,
                memory_lineage_root,
            } => {
                assert_eq!(memory_id, new);
                assert_eq!(memory_lineage_root, lineage);
            }
            _ => panic!("expected memory dest"),
        }
        assert!(got.local_dirty);
        assert_eq!(got.sync_status, SyncStatus::LocalDirty);
        assert!(store.find_by_memory_id(&old).unwrap().is_none());
    }

    #[test]
    fn retract_marks_missing_local_keeps_memory_id() {
        let store = HarvestStore::open_in_memory().unwrap();
        let mem = Uuid::now_v7();
        store
            .insert(&mem_record("7", profiles::PLAIN_STRIP, mem))
            .unwrap();
        assert!(store.on_memory_retracted(&mem, 99).unwrap());
        let got = store.find_by_memory_id(&mem).unwrap().unwrap();
        assert_eq!(got.sync_status, SyncStatus::MissingLocal);
        match got.destination {
            HarvestDestination::Memory { memory_id, .. } => assert_eq!(memory_id, mem),
            _ => panic!("expected memory"),
        }
    }

    #[test]
    fn upsert_updates_same_remote_memory_dest() {
        let store = HarvestStore::open_in_memory().unwrap();
        let mem = Uuid::now_v7();
        let mut r = mem_record("5", profiles::PLAIN_STRIP, mem);
        let id1 = store.upsert_by_remote(&r).unwrap();
        r.source.remote_version = Some(2);
        r.source.remote_content_hash = Some("xyz".into());
        r.local_content_hash = "local2".into();
        r.updated_at = 1_700_000_200;
        let id2 = store.upsert_by_remote(&r).unwrap();
        assert_eq!(id1, id2);
        let got = store.get(&id1).unwrap().unwrap();
        assert_eq!(got.source.remote_version, Some(2));
        assert_eq!(got.source.remote_content_hash.as_deref(), Some("xyz"));
        assert_eq!(store.list(10).unwrap().len(), 1);
    }

    #[test]
    fn memory_and_file_dest_coexist() {
        let store = HarvestStore::open_in_memory().unwrap();
        let mem = Uuid::now_v7();
        store
            .insert(&mem_record("8", profiles::PLAIN_STRIP, mem))
            .unwrap();
        let now = 1_700_000_000;
        let file = HarvestRecord {
            id: Uuid::now_v7(),
            source: SourceRef::confluence("https://wiki.example.com", "8", Some("ENG".into())),
            destination: HarvestDestination::File {
                workspace_path: "harvest/confluence/ENG/8.md".into(),
            },
            transform_profile: profiles::PLAIN_STRIP.into(),
            last_synced_at: now,
            local_content_hash: "f".into(),
            local_dirty: false,
            sync_status: SyncStatus::InSync,
            created_at: now,
            updated_at: now,
        };
        store.insert(&file).unwrap();
        assert_eq!(store.list(10).unwrap().len(), 2);
    }
}
