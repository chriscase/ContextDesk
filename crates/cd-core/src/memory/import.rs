//! One-shot migration of memory_fs notes + server memory.jsonl (MEMORY.md §5).
//!
//! Stable id = deterministic UUID from path/key hash so re-runs are idempotent.

use super::types::*;
use super::MemoryStore;
use super::SqliteMemoryStore;
use crate::error::CoreResult;
use crate::memory_fs;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// Import report.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportReport {
    /// Newly inserted rows.
    pub inserted: u32,
    /// Skipped because id already present.
    pub skipped_existing: u32,
    /// Errors (path, message).
    pub errors: Vec<String>,
}

/// Deterministic id from a stable key (relative path or jsonl line key).
pub fn stable_import_id(key: &str) -> Uuid {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    "contextdesk.memory.import.v1".hash(&mut h);
    key.hash(&mut h);
    let a = h.finish();
    let mut h2 = DefaultHasher::new();
    key.hash(&mut h2);
    "salt2".hash(&mut h2);
    let b = h2.finish();
    let mut bytes = [0u8; 16];
    bytes[0..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..16].copy_from_slice(&b.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// cd-server style memory.jsonl note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerMemoryNote {
    /// Optional pre-existing id.
    #[serde(default)]
    pub id: Option<String>,
    /// Body text.
    #[serde(default)]
    pub body: String,
    /// Alternate content field.
    #[serde(default)]
    pub content: String,
    /// Title.
    #[serde(default)]
    pub title: String,
    /// Kind string.
    #[serde(default)]
    pub kind: Option<String>,
}

/// Bulk-import arbitrary markdown notes with stable `import_fp` ids (Phase 2).
///
/// Each note is keyed by `(source, path_key)`; re-running is idempotent.
pub fn bulk_import_markdown_notes(
    store: &SqliteMemoryStore,
    notes: &[(String, String, String)],
    source_label: &str,
    now_secs: i64,
) -> CoreResult<ImportReport> {
    // notes: (path_key, title, body)
    let mut report = ImportReport::default();
    for (path_key, title, body) in notes {
        if body.trim().is_empty() {
            continue;
        }
        let fp = import_fp(source_label, path_key);
        let id = stable_import_id(&fp);
        if store.get(&id)?.is_some() {
            report.skipped_existing += 1;
            continue;
        }
        let mut draft = MemoryDraft::new(Kind::ProjectNote, body.clone());
        draft.title = title.clone();
        draft.source = MemorySource::Import;
        draft.created_by = "bulk_import".into();
        draft.origin_tool = Some("bulk_import".into());
        draft.structured = serde_json::json!({
            "import_fp": fp,
            "path_key": path_key,
        });
        match store.put_imported(id, draft, now_secs) {
            Ok(_) => report.inserted += 1,
            Err(e) => report.errors.push(format!("{path_key}: {e}")),
        }
    }
    Ok(report)
}

/// Import memory_fs into a [`SqliteMemoryStore`] with stable ids.
pub fn import_memory_fs_sqlite(
    store: &SqliteMemoryStore,
    workspace: &Workspace,
    now_secs: i64,
) -> CoreResult<ImportReport> {
    let files = memory_fs::list_memory_files(workspace)?;
    let mut report = ImportReport::default();
    for f in files {
        let key = format!("memory_fs:{}", f.relative);
        let id = stable_import_id(&key);
        if store.get(&id)?.is_some() {
            report.skipped_existing += 1;
            continue;
        }
        let mut draft = MemoryDraft::new(Kind::ProjectNote, f.body);
        draft.title = f.title;
        draft.source = MemorySource::Import;
        draft.created_by = "import".into();
        draft.origin_tool = Some("import_memory_fs".into());
        match store.put_imported(id, draft, now_secs) {
            Ok(_) => report.inserted += 1,
            Err(e) => report.errors.push(format!("{}: {e}", f.relative)),
        }
    }
    Ok(report)
}

/// Import jsonl into SqliteMemoryStore with stable ids.
pub fn import_memory_jsonl_sqlite(
    store: &SqliteMemoryStore,
    path: &Path,
    now_secs: i64,
) -> CoreResult<ImportReport> {
    if !path.exists() {
        return Ok(ImportReport::default());
    }
    let text = fs::read_to_string(path)?;
    let mut report = ImportReport::default();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let note: ServerMemoryNote = match serde_json::from_str(line) {
            Ok(n) => n,
            Err(e) => {
                report.errors.push(format!("line {}: {e}", i + 1));
                continue;
            }
        };
        let body = if !note.content.is_empty() {
            note.content
        } else {
            note.body
        };
        if body.trim().is_empty() {
            continue;
        }
        let key = note
            .id
            .clone()
            .unwrap_or_else(|| format!("jsonl:{}:{}", path.display(), i));
        let id = note
            .id
            .as_ref()
            .and_then(|s| Uuid::parse_str(s).ok())
            .unwrap_or_else(|| stable_import_id(&key));
        if store.get(&id)?.is_some() {
            report.skipped_existing += 1;
            continue;
        }
        let kind = note
            .kind
            .as_deref()
            .map(Kind::parse)
            .unwrap_or(Kind::ProjectNote);
        let mut draft = MemoryDraft::new(kind, body);
        draft.title = note.title;
        draft.source = MemorySource::Import;
        draft.created_by = "import".into();
        draft.origin_tool = Some("import_memory_jsonl".into());
        match store.put_imported(id, draft, now_secs) {
            Ok(_) => report.inserted += 1,
            Err(e) => report.errors.push(format!("line {}: {e}", i + 1)),
        }
    }
    Ok(report)
}

/// Whether a workspace-relative path is a memory_fs note (should not double-surface
/// as KB after migration — recall_memory is the memory path).
pub fn is_migrated_memory_fs_path(rel: &str) -> bool {
    let r = rel.replace('\\', "/");
    (r.contains("/memory/") && r.ends_with(".md"))
        || (r.starts_with("memory/") && r.ends_with(".md"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::HybridWeights;
    use crate::workspace::Workspace;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn stable_id_is_deterministic() {
        let a = stable_import_id("memory_fs:notes/a.md");
        let b = stable_import_id("memory_fs:notes/a.md");
        let c = stable_import_id("memory_fs:notes/b.md");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn import_memory_fs_idempotent() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let branding = crate::branding::Branding::embedded();
        let mem = root.join(&branding.workspace_dir_name).join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(mem.join("hello.md"), "# Hello\n\nworld fact alpha\n").unwrap();
        let ws = Workspace {
            id: "t".into(),
            name: "t".into(),
            roots: vec![root.to_path_buf()],
        };
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let r1 = import_memory_fs_sqlite(&store, &ws, 100).unwrap();
        assert_eq!(r1.inserted, 1);
        assert!(r1.errors.is_empty());
        let r2 = import_memory_fs_sqlite(&store, &ws, 200).unwrap();
        assert_eq!(r2.inserted, 0);
        assert_eq!(r2.skipped_existing, 1);
        let hits = store
            .recall(
                &crate::memory::RecallQuery::new("alpha"),
                None,
                HybridWeights::default(),
                200,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.source, MemorySource::Import);
    }

    #[test]
    fn import_jsonl_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("memory.jsonl");
        fs::write(
            &path,
            r#"{"id":"11111111-1111-5111-8111-111111111111","title":"T","content":"jsonl unique body zebra"}
"#,
        )
        .unwrap();
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let r1 = import_memory_jsonl_sqlite(&store, &path, 1).unwrap();
        assert_eq!(r1.inserted, 1);
        let r2 = import_memory_jsonl_sqlite(&store, &path, 2).unwrap();
        assert_eq!(r2.inserted, 0);
        assert_eq!(r2.skipped_existing, 1);
        let hits = store
            .recall(
                &crate::memory::RecallQuery::new("zebra"),
                None,
                HybridWeights::default(),
                2,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn bulk_import_is_idempotent() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let notes = vec![
            (
                "notes/a.md".into(),
                "A".into(),
                "Rememberable note body alpha".into(),
            ),
            (
                "notes/b.md".into(),
                "B".into(),
                "Second note body beta".into(),
            ),
        ];
        let r1 = bulk_import_markdown_notes(&store, &notes, "md_bulk", 10).unwrap();
        assert_eq!(r1.inserted, 2);
        let r2 = bulk_import_markdown_notes(&store, &notes, "md_bulk", 20).unwrap();
        assert_eq!(r2.inserted, 0);
        assert_eq!(r2.skipped_existing, 2);
    }

    #[test]
    fn memory_fs_path_detection() {
        assert!(is_migrated_memory_fs_path(".contextdesk/memory/note.md"));
        assert!(is_migrated_memory_fs_path("memory/note.md"));
        assert!(!is_migrated_memory_fs_path("src/main.rs"));
    }

    /// #346: import via put_imported must embed-on-write so paraphrases work.
    #[test]
    fn import_memory_fs_embed_on_write_paraphrase_recallable() {
        use crate::embed::ConceptEmbedBackend;
        use crate::memory::{RecallQuery, TwoScopeMemory};
        use std::sync::Arc;

        let dir = tempdir().unwrap();
        let root = dir.path();
        let branding = crate::branding::Branding::embedded();
        let mem = root.join(&branding.workspace_dir_name).join("memory");
        fs::create_dir_all(&mem).unwrap();
        // Zero keyword overlap with the paraphrase query below.
        fs::write(
            mem.join("db.md"),
            "# Decision\n\nChose Postgres as the durable brain backend\n",
        )
        .unwrap();
        let ws = Workspace {
            id: "import-embed".into(),
            name: "t".into(),
            roots: vec![root.to_path_buf()],
        };
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let backend = Arc::new(ConceptEmbedBackend::new(64));
        store.set_embed_backend(Some(backend.clone()), "concept-v1");
        let r = import_memory_fs_sqlite(&store, &ws, 1_000).unwrap();
        assert_eq!(r.inserted, 1, "expected one imported note");
        let recs = store.changes_since(0).unwrap();
        assert_eq!(recs.len(), 1);
        assert!(
            store.get_embedding(&recs[0].id).unwrap().is_some(),
            "put_imported must store memory_embeddings when backend attached"
        );

        // Facade path (product two-pool recall) + paraphrase with no shared keywords.
        let facade = TwoScopeMemory::open_in_memory("import-embed").unwrap();
        facade.set_embed_backend(Some(backend.clone()), "concept-v1");
        let r2 = import_memory_fs_sqlite(facade.workspace(), &ws, 1_001).unwrap();
        assert_eq!(r2.inserted, 1);
        let query = "which relational database engine was selected";
        let hits = facade
            .recall(
                &RecallQuery::new(query),
                Some(backend.as_ref()),
                HybridWeights {
                    keyword: 0.15,
                    semantic: 0.75,
                    recency: 0.10,
                },
                2_000,
            )
            .unwrap();
        let hit = hits
            .iter()
            .find(|h| h.record.content.contains("Postgres") || h.record.content.contains("durable"))
            .expect("imported note must surface on paraphrase");
        assert!(
            hit.semantic_score > 0.0,
            "semantic_score>0 for imported content: {:?}",
            hits.iter()
                .map(|h| (&h.record.content, h.semantic_score))
                .collect::<Vec<_>>()
        );
    }

    /// #346: rows imported without a backend get vectors via backfill.
    #[test]
    fn backfill_embeds_legacy_import_rows() {
        use crate::embed::ConceptEmbedBackend;
        use std::sync::Arc;

        let store = SqliteMemoryStore::open_in_memory().unwrap();
        // Import without embed backend (legacy attach order).
        let dir = tempdir().unwrap();
        let root = dir.path();
        let branding = crate::branding::Branding::embedded();
        let mem = root.join(&branding.workspace_dir_name).join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(
            mem.join("x.md"),
            "# X\n\nChose Postgres as the durable brain backend\n",
        )
        .unwrap();
        let ws = Workspace {
            id: "bf".into(),
            name: "t".into(),
            roots: vec![root.to_path_buf()],
        };
        let r = import_memory_fs_sqlite(&store, &ws, 1).unwrap();
        assert_eq!(r.inserted, 1);
        let id = store.changes_since(0).unwrap()[0].id;
        assert!(store.get_embedding(&id).unwrap().is_none());

        store.set_embed_backend(Some(Arc::new(ConceptEmbedBackend::new(64))), "concept-v1");
        let n = store.backfill_missing_embeddings(50).unwrap();
        assert_eq!(n, 1);
        assert!(store.get_embedding(&id).unwrap().is_some());
    }
}
