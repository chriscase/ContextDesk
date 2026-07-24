//! Two-scope memory facade: personal (OS app-data) ∪ workspace (in-repo, gitignored).
//!
//! Personal rows are structurally excluded from [`MemoryStore::changes_since`]
//! so they can never enter a sync pipeline (MEMORY.md §7).

use super::sqlite_store::SqliteMemoryStore;
use super::types::*;
use super::MemoryStore;
use crate::branding::Branding;
use crate::embed::{EmbedBackend, HybridWeights};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Where the workspace-scope SQLite file lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMemoryLocation {
    /// `<workspace_root>/<slug>/memory/memory.sqlite` (default; gitignored).
    #[default]
    InRepo,
    /// Under OS app-data next to personal (never git-leaks; does not travel).
    AppData,
}

/// Memory configuration (owner defaults from MEMORY.md §10).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    /// Master switch for durable memory tools / ambient recall wiring.
    #[serde(default = "default_true")]
    pub durable_memory_enabled: bool,
    /// Workspace DB location policy.
    #[serde(default)]
    pub workspace_location: WorkspaceMemoryLocation,
    /// Ambient recall injection (default ON, tight budget).
    #[serde(default = "default_true")]
    pub ambient_recall_enabled: bool,
    /// Max chars for ambient injection (~1500).
    #[serde(default = "default_ambient_chars")]
    pub ambient_max_chars: usize,
    /// Max memories for ambient injection (≤5).
    #[serde(default = "default_ambient_k")]
    pub ambient_max_memories: usize,
    /// Min hybrid score floor for ambient (~0.35).
    #[serde(default = "default_ambient_min_score")]
    pub ambient_min_score: f32,
}

fn default_true() -> bool {
    true
}
fn default_ambient_chars() -> usize {
    1500
}
fn default_ambient_k() -> usize {
    5
}
fn default_ambient_min_score() -> f32 {
    0.35
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            durable_memory_enabled: true,
            workspace_location: WorkspaceMemoryLocation::InRepo,
            ambient_recall_enabled: true,
            ambient_max_chars: 1500,
            ambient_max_memories: 5,
            ambient_min_score: 0.35,
        }
    }
}

/// Resolve personal memory DB path under OS app-data / config dir.
pub fn personal_memory_db_path(branding: &Branding) -> CoreResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
    Ok(home
        .join(&branding.config_dir_name)
        .join("memory")
        .join("personal.sqlite"))
}

/// Resolve workspace memory DB path.
pub fn workspace_memory_db_path(
    workspace_root: &Path,
    branding: &Branding,
    location: WorkspaceMemoryLocation,
    workspace_id: &str,
) -> CoreResult<PathBuf> {
    match location {
        WorkspaceMemoryLocation::InRepo => Ok(workspace_root
            .join(&branding.workspace_dir_name)
            .join("memory")
            .join("memory.sqlite")),
        WorkspaceMemoryLocation::AppData => {
            let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
            Ok(home
                .join(&branding.config_dir_name)
                .join("memory")
                .join("workspaces")
                .join(workspace_id)
                .join("memory.sqlite"))
        }
    }
}

/// Default gitignore lines for in-repo workspace memory (owner default §10.2).
pub fn workspace_memory_gitignore_lines(branding: &Branding) -> Vec<String> {
    let slug = &branding.workspace_dir_name;
    vec![
        format!("{slug}/memory/"),
        format!("{slug}/memory/**"),
        // belt-and-suspenders for sqlite siblings
        format!("{slug}/memory/*.sqlite"),
        format!("{slug}/memory/*.sqlite-*"),
    ]
}

/// Ensure a `.gitignore` under the workspace data dir ignores memory DBs.
///
/// Idempotent: appends missing lines only.
pub fn ensure_workspace_memory_gitignored(
    workspace_root: &Path,
    branding: &Branding,
) -> CoreResult<()> {
    let dir = workspace_root.join(&branding.workspace_dir_name);
    std::fs::create_dir_all(&dir)?;
    let gi = dir.join(".gitignore");
    let existing = if gi.exists() {
        std::fs::read_to_string(&gi)?
    } else {
        String::new()
    };
    let mut out = existing.clone();
    for line in [
        "memory/",
        "memory/**",
        "memory/*.sqlite",
        "memory/*.sqlite-*",
    ] {
        if !existing.lines().any(|l| l.trim() == line) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(line);
            out.push('\n');
        }
    }
    if out != existing {
        std::fs::write(&gi, out)?;
    }
    Ok(())
}

/// Open personal + workspace stores from config and attach to a [`crate::tool_host::ToolHost`].
///
/// This is the product seam (#264 skeptic fix): without it, `durable_memory` stays
/// Filesystem operations for removing legacy on-disk candidate inboxes.
///
/// Injected so cleanup failure can be proven hermetically without relying on
/// platform-specific file permissions (#381/#385).
pub trait LegacyCandidateCleanup: Send + Sync {
    /// Remove one path. `NotFound` must be treated as success by implementors.
    fn remove_path(&self, path: &Path) -> std::io::Result<()>;
}

/// Production cleanup: `std::fs::remove_file`, ignoring missing files only.
#[derive(Debug, Default, Clone, Copy)]
pub struct FsLegacyCandidateCleanup;

impl LegacyCandidateCleanup for FsLegacyCandidateCleanup {
    fn remove_path(&self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Remove legacy `candidates.sqlite` (+ `-wal` / `-shm`) under `mem_dir`.
///
/// Failures are **never** silent: any non-NotFound error becomes a privacy
/// policy error so attach cannot claim a non-durable inbox while raw files
/// remain. Does not read or migrate candidate contents.
pub fn cleanup_legacy_candidate_files(
    mem_dir: &Path,
    cleanup: &dyn LegacyCandidateCleanup,
) -> CoreResult<()> {
    let base = mem_dir.join("candidates.sqlite");
    let paths = [
        base.clone(),
        PathBuf::from(format!("{}-wal", base.display())),
        PathBuf::from(format!("{}-shm", base.display())),
    ];
    for p in &paths {
        if let Err(e) = cleanup.remove_path(p) {
            // Log redacted path only — never legacy contents.
            // Redact to a short, path-safe suffix (ASCII path chars only in practice).
            let path_disp = p.display().to_string();
            let redacted = {
                let chars: String = path_disp.chars().rev().take(80).collect::<String>();
                if path_disp.chars().count() > 96 {
                    format!("…{}", chars.chars().rev().collect::<String>())
                } else {
                    path_disp
                }
            };
            tracing::error!(
                path = %redacted,
                error = %e,
                "legacy candidate store cleanup failed"
            );
            return Err(CoreError::Policy(format!(
                "privacy: failed to remove legacy candidate store at `{redacted}`: {e}. \
                 Durable memory will not attach until cleanup succeeds (retry after fixing permissions)."
            )));
        }
    }
    Ok(())
}

/// `None` and Phase-1 tools/ambient never run. Idempotent import of memory_fs notes
/// runs once when the workspace store is first opened (stable ids).
pub fn attach_durable_memory_to_host(
    host: &mut crate::tool_host::ToolHost,
    branding: &Branding,
    memory_cfg: &MemoryConfig,
) -> CoreResult<()> {
    attach_durable_memory_to_host_with_cleanup(
        host,
        branding,
        memory_cfg,
        &FsLegacyCandidateCleanup,
    )
}

/// Same as [`attach_durable_memory_to_host`] with an injectable cleanup seam.
pub fn attach_durable_memory_to_host_with_cleanup(
    host: &mut crate::tool_host::ToolHost,
    branding: &Branding,
    memory_cfg: &MemoryConfig,
    cleanup: &dyn LegacyCandidateCleanup,
) -> CoreResult<()> {
    if !memory_cfg.durable_memory_enabled {
        host.set_durable_memory_enabled(false);
        host.set_ambient_recall_enabled(false);
        return Ok(());
    }
    let personal = personal_memory_db_path(branding)?;
    let root = host
        .workspace
        .roots
        .first()
        .ok_or_else(|| CoreError::Policy("no workspace roots for durable memory".into()))?;
    if memory_cfg.workspace_location == WorkspaceMemoryLocation::InRepo {
        ensure_workspace_memory_gitignored(root, branding)?;
    }
    let ws_path = workspace_memory_db_path(
        root,
        branding,
        memory_cfg.workspace_location,
        &host.workspace.id,
    )?;
    let store = TwoScopeMemory::open(&personal, &ws_path, host.workspace.id.clone())?;
    // Wire embed BEFORE import so put_imported can embed-on-write (#346 skeptic).
    // set_durable_memory also propagates embed, but that runs after import.
    if let Some(emb) = host.embed_backend() {
        store.set_embed_backend(Some(emb), host.embed_model());
    }
    // One-shot import of legacy memory_fs notes (idempotent).
    let now = crate::embed::now_unix_secs();
    match super::import::import_memory_fs_sqlite(store.workspace(), &host.workspace, now) {
        Ok(r) if r.inserted > 0 => {
            tracing::info!(
                inserted = r.inserted,
                skipped = r.skipped_existing,
                "memory_fs import into durable store"
            );
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "memory_fs import skipped"),
    }
    // Lazy backfill for rows imported earlier without vectors (legacy / attach race).
    if host.embed_backend().is_some() {
        for (label, n) in [
            (
                "workspace",
                store.workspace().backfill_missing_embeddings(500),
            ),
            (
                "personal",
                store.personal().backfill_missing_embeddings(500),
            ),
        ] {
            match n {
                Ok(c) if c > 0 => tracing::info!(count = c, pool = label, "memory embed backfill"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, pool = label, "memory embed backfill failed"),
            }
        }
    }
    // Phase-2 inbox: **in-memory only** (#381) — unapproved candidates must not
    // survive restart or land on disk as raw title/content/excerpts.
    // Edges co-located with workspace memory dir (durable graph metadata).
    let mem_dir = ws_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| ws_path.clone());
    if let Ok(inbox) = super::CandidateInbox::open_in_memory() {
        host.set_candidate_inbox(Some(std::sync::Arc::new(inbox)));
    }
    // Remove any legacy on-disk inbox left by older builds. Failure is loud:
    // never claim non-durable ambient success while raw candidates remain.
    cleanup_legacy_candidate_files(&mem_dir, cleanup)?;
    if let Ok(edges) = super::EdgeStore::open(mem_dir.join("edges.sqlite")) {
        host.set_edge_store(Some(std::sync::Arc::new(edges)));
    }
    host.set_durable_memory(std::sync::Arc::new(store), true);
    host.set_harvest_db_path(Some(ws_path));
    host.set_ambient_recall_enabled(memory_cfg.ambient_recall_enabled);
    Ok(())
}

/// Facade over personal + workspace stores.
pub struct TwoScopeMemory {
    personal: SqliteMemoryStore,
    workspace: SqliteMemoryStore,
    /// Active workspace id stamped on workspace-scope inserts when missing.
    workspace_id: String,
}

impl TwoScopeMemory {
    /// Open both stores (creating parents as needed).
    pub fn open(
        personal_path: impl AsRef<Path>,
        workspace_path: impl AsRef<Path>,
        workspace_id: impl Into<String>,
    ) -> CoreResult<Self> {
        Ok(Self {
            personal: SqliteMemoryStore::open(personal_path)?,
            workspace: SqliteMemoryStore::open(workspace_path)?,
            workspace_id: workspace_id.into(),
        })
    }

    /// Hermetic pair for tests.
    pub fn open_in_memory(workspace_id: impl Into<String>) -> CoreResult<Self> {
        Ok(Self {
            personal: SqliteMemoryStore::open_in_memory()?,
            workspace: SqliteMemoryStore::open_in_memory()?,
            workspace_id: workspace_id.into(),
        })
    }

    /// Personal store handle.
    pub fn personal(&self) -> &SqliteMemoryStore {
        &self.personal
    }

    /// Workspace store handle.
    pub fn workspace(&self) -> &SqliteMemoryStore {
        &self.workspace
    }

    fn route_write(&self, draft: &mut MemoryDraft) {
        if draft.scope == Scope::Workspace && draft.workspace_id.is_none() {
            draft.workspace_id = Some(self.workspace_id.clone());
        }
    }

    fn store_for_scope(&self, scope: Scope) -> &SqliteMemoryStore {
        match scope {
            Scope::Personal => &self.personal,
            Scope::Workspace => &self.workspace,
        }
    }
}

impl MemoryStore for TwoScopeMemory {
    fn set_embed_backend(&self, backend: Option<std::sync::Arc<dyn EmbedBackend>>, model: &str) {
        self.personal
            .set_embed_backend_model(backend.clone(), model);
        self.workspace.set_embed_backend_model(backend, model);
    }

    fn put(&self, op: MemoryWriteOp, now_secs: i64) -> CoreResult<MemoryRecord> {
        match op {
            MemoryWriteOp::Insert(mut draft) => {
                self.route_write(&mut draft);
                self.store_for_scope(draft.scope)
                    .put(MemoryWriteOp::Insert(draft), now_secs)
            }
            MemoryWriteOp::Supersede { old, mut new } => {
                // Prefer store that already holds `old`
                if self.personal.get(&old)?.is_some() {
                    new.scope = Scope::Personal;
                    self.personal
                        .put(MemoryWriteOp::Supersede { old, new }, now_secs)
                } else if self.workspace.get(&old)?.is_some() {
                    new.scope = Scope::Workspace;
                    self.route_write(&mut new);
                    self.workspace
                        .put(MemoryWriteOp::Supersede { old, new }, now_secs)
                } else {
                    Err(CoreError::Message(format!(
                        "supersede target missing in both scopes: {old}"
                    )))
                }
            }
            MemoryWriteOp::UpdateMeta { id, .. } | MemoryWriteOp::Retract { id } => {
                if self.personal.get(&id)?.is_some() {
                    self.personal.put(op, now_secs)
                } else if self.workspace.get(&id)?.is_some() {
                    self.workspace.put(op, now_secs)
                } else {
                    Err(CoreError::Message(format!(
                        "memory not found in either scope: {id}"
                    )))
                }
            }
        }
    }

    fn get(&self, id: &Uuid) -> CoreResult<Option<MemoryRecord>> {
        if let Some(r) = self.personal.get(id)? {
            return Ok(Some(r));
        }
        self.workspace.get(id)
    }

    fn recall(
        &self,
        q: &RecallQuery,
        embed: Option<&dyn EmbedBackend>,
        w: HybridWeights,
        now_secs: i64,
    ) -> CoreResult<Vec<RecallHit>> {
        // Two-pool: normalize keyword scores per pool, then merge (MEMORY.md §4).
        super::recall::recall_two_pool(&self.personal, &self.workspace, q, embed, w, now_secs)
    }

    fn changes_since(&self, cursor: i64) -> CoreResult<Vec<MemoryRecord>> {
        // Personal is structurally barred from sync cursors.
        self.workspace.changes_since(cursor)
    }

    fn list(
        &self,
        kinds: Option<&[Kind]>,
        include_superseded: bool,
        include_retracted: bool,
        now_secs: i64,
        limit: usize,
    ) -> CoreResult<Vec<MemoryRecord>> {
        let half = (limit.max(1) / 2).max(1);
        let mut ws = self.workspace.list_records(
            kinds,
            include_superseded,
            include_retracted,
            now_secs,
            limit.max(half),
        )?;
        let mut pers = self.personal.list_records(
            kinds,
            include_superseded,
            include_retracted,
            now_secs,
            limit.max(half),
        )?;
        ws.append(&mut pers);
        ws.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
        ws.truncate(limit.max(1));
        Ok(ws)
    }

    fn purge_gdpr(
        &self,
        id: &Uuid,
        now_secs: i64,
        reason: &str,
    ) -> CoreResult<super::PurgeTombstone> {
        if self.personal.get(id)?.is_some() {
            return self.personal.purge_gdpr(id, now_secs, reason);
        }
        if self.workspace.get(id)?.is_some() {
            return self.workspace.purge_gdpr(id, now_secs, reason);
        }
        Err(CoreError::Message(format!(
            "purge target missing in both scopes: {id}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{Kind, MemoryDraft, MemoryWriteOp, Scope};

    #[test]
    fn personal_write_never_in_changes_since() {
        let facade = TwoScopeMemory::open_in_memory("ws-1").unwrap();
        let mut d = MemoryDraft::new(Kind::Fact, "my private note");
        d.scope = Scope::Personal;
        facade.put(MemoryWriteOp::Insert(d), 100).unwrap();
        let mut w = MemoryDraft::new(Kind::Fact, "team note");
        w.scope = Scope::Workspace;
        facade.put(MemoryWriteOp::Insert(w), 200).unwrap();
        let changes = facade.changes_since(0).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].content, "team note");
        assert_eq!(changes[0].scope, Scope::Workspace);
        assert!(!changes.iter().any(|r| r.scope == Scope::Personal));
    }

    #[test]
    fn scope_routing_insert() {
        let facade = TwoScopeMemory::open_in_memory("ws-9").unwrap();
        let mut d = MemoryDraft::new(Kind::Fact, "workspace fact");
        d.scope = Scope::Workspace;
        let rec = facade.put(MemoryWriteOp::Insert(d), 1).unwrap();
        assert_eq!(rec.scope, Scope::Workspace);
        assert_eq!(rec.workspace_id.as_deref(), Some("ws-9"));
        assert!(facade.workspace().get(&rec.id).unwrap().is_some());
        assert!(facade.personal().get(&rec.id).unwrap().is_none());
    }

    #[test]
    fn ensure_gitignore_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let branding = Branding::embedded();
        ensure_workspace_memory_gitignored(dir.path(), &branding).unwrap();
        ensure_workspace_memory_gitignored(dir.path(), &branding).unwrap();
        let gi = std::fs::read_to_string(
            dir.path()
                .join(&branding.workspace_dir_name)
                .join(".gitignore"),
        )
        .unwrap();
        assert!(gi.lines().any(|l| l.trim() == "memory/"));
        // Idempotent: second call does not duplicate lines
        let line_count = gi.lines().filter(|l| !l.trim().is_empty()).count();
        ensure_workspace_memory_gitignored(dir.path(), &branding).unwrap();
        let gi2 = std::fs::read_to_string(
            dir.path()
                .join(&branding.workspace_dir_name)
                .join(".gitignore"),
        )
        .unwrap();
        assert_eq!(
            gi2.lines().filter(|l| !l.trim().is_empty()).count(),
            line_count
        );
    }

    #[test]
    fn attach_to_host_enables_durable_tools() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        // Point personal store into temp via branding config dir is home-based;
        // use in-memory open path by calling set after attach fails on missing home?
        // Attach uses home for personal — in CI home exists. Use real attach.
        let ws = crate::workspace::Workspace {
            id: "attach-ws".into(),
            name: "a".into(),
            roots: vec![root.to_path_buf()],
        };
        let idx = crate::index::KeywordIndex::build(&ws).unwrap();
        let mut host = crate::tool_host::ToolHost::new(ws, idx, None);
        assert!(!host.durable_memory_active());
        attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
        assert!(host.durable_memory_active());
        assert!(host.ambient_recall_enabled());
        let names: Vec<_> = host.specs().into_iter().map(|s| s.name).collect();
        assert!(names.iter().any(|n| n == "recall_memory"));
        assert!(names.iter().any(|n| n == "retract_memory"));
        // Disabled config turns tools off
        let off = MemoryConfig {
            durable_memory_enabled: false,
            ..MemoryConfig::default()
        };
        attach_durable_memory_to_host(&mut host, &branding, &off).unwrap();
        assert!(!host.durable_memory_enabled());

        // Ambient flag from config (#271)
        let mut host2 = crate::tool_host::ToolHost::new(
            crate::workspace::Workspace {
                id: "attach-ws2".into(),
                name: "a".into(),
                roots: vec![root.to_path_buf()],
            },
            crate::index::KeywordIndex::build(&crate::workspace::Workspace {
                id: "attach-ws2".into(),
                name: "a".into(),
                roots: vec![root.to_path_buf()],
            })
            .unwrap(),
            None,
        );
        let ambient_off = MemoryConfig {
            ambient_recall_enabled: false,
            ..MemoryConfig::default()
        };
        attach_durable_memory_to_host(&mut host2, &branding, &ambient_off).unwrap();
        assert!(host2.durable_memory_active());
        assert!(!host2.ambient_recall_enabled());
    }

    /// Injected cleanup that can fail deterministically for hermetic tests.
    struct ScriptedCleanup {
        fail_paths: std::sync::Mutex<std::collections::HashSet<String>>,
        removed: std::sync::Mutex<Vec<String>>,
    }

    impl ScriptedCleanup {
        fn new() -> Self {
            Self {
                fail_paths: std::sync::Mutex::new(std::collections::HashSet::new()),
                removed: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn fail_on(&self, path: &std::path::Path) {
            self.fail_paths
                .lock()
                .unwrap()
                .insert(path.display().to_string());
        }
        fn clear_failures(&self) {
            self.fail_paths.lock().unwrap().clear();
        }
    }

    impl LegacyCandidateCleanup for ScriptedCleanup {
        fn remove_path(&self, path: &std::path::Path) -> std::io::Result<()> {
            let key = path.display().to_string();
            if self.fail_paths.lock().unwrap().contains(&key) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "scripted cleanup failure",
                ));
            }
            // Mirror production: NotFound is ok; otherwise delete if present.
            match std::fs::remove_file(path) {
                Ok(()) => {
                    self.removed.lock().unwrap().push(key);
                    Ok(())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        }
    }

    /// #385: normal legacy db + wal + shm are removed on attach.
    #[test]
    fn legacy_candidate_cleanup_removes_db_wal_shm() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        let mem_dir = root.join(&branding.workspace_dir_name).join("memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        let base = mem_dir.join("candidates.sqlite");
        std::fs::write(&base, b"legacy-db").unwrap();
        std::fs::write(format!("{}-wal", base.display()), b"wal").unwrap();
        std::fs::write(format!("{}-shm", base.display()), b"shm").unwrap();
        let cleanup = ScriptedCleanup::new();
        cleanup_legacy_candidate_files(&mem_dir, &cleanup).unwrap();
        assert!(!base.exists());
        assert!(!std::path::Path::new(&format!("{}-wal", base.display())).exists());
        assert!(!std::path::Path::new(&format!("{}-shm", base.display())).exists());
        let removed = cleanup.removed.lock().unwrap();
        assert!(removed.iter().any(|p| p.ends_with("candidates.sqlite")));
        assert!(removed.iter().any(|p| p.ends_with("candidates.sqlite-wal")));
        assert!(removed.iter().any(|p| p.ends_with("candidates.sqlite-shm")));
    }

    /// #385: deterministic deletion failure is surfaced; attach does not succeed.
    #[test]
    fn legacy_cleanup_failure_surfaces_and_blocks_attach() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        let mem_dir = root.join(&branding.workspace_dir_name).join("memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        let base = mem_dir.join("candidates.sqlite");
        std::fs::write(&base, b"legacy-raw-must-remain-if-cleanup-fails").unwrap();

        let cleanup = ScriptedCleanup::new();
        cleanup.fail_on(&base);
        let err = cleanup_legacy_candidate_files(&mem_dir, &cleanup).expect_err("must fail");
        let msg = format!("{err}");
        assert!(
            msg.contains("privacy") || msg.contains("legacy candidate"),
            "{msg}"
        );
        assert!(base.exists(), "file must remain after failed cleanup");

        let ws = crate::workspace::Workspace {
            id: format!("fail-{}", uuid::Uuid::now_v7()),
            name: "c".into(),
            roots: vec![root.to_path_buf()],
        };
        let idx = crate::index::KeywordIndex::build(&ws).unwrap();
        let mut host = crate::tool_host::ToolHost::new(ws, idx, None);
        let attach_err = attach_durable_memory_to_host_with_cleanup(
            &mut host,
            &branding,
            &MemoryConfig::default(),
            &cleanup,
        )
        .expect_err("attach must not succeed after cleanup failure");
        assert!(
            format!("{attach_err}").contains("privacy")
                || format!("{attach_err}").contains("legacy")
        );
        assert!(
            !host.durable_memory_active(),
            "must not enable durable memory after privacy cleanup failure"
        );
        assert!(base.exists());

        // Retry succeeds after simulated failure is cleared.
        cleanup.clear_failures();
        attach_durable_memory_to_host_with_cleanup(
            &mut host,
            &branding,
            &MemoryConfig::default(),
            &cleanup,
        )
        .unwrap();
        assert!(host.durable_memory_active());
        assert!(!base.exists(), "retry must remove legacy file");
    }

    /// #385: cleanup never migrates/recalls legacy candidate contents.
    #[test]
    fn legacy_cleanup_does_not_migrate_or_ambient_recall() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        let mem_dir = root.join(&branding.workspace_dir_name).join("memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        let secret = "sk-live-legacycandidateonlytoken99";
        let base = mem_dir.join("candidates.sqlite");
        // Plant opaque bytes containing a token-shaped string — must never be recalled.
        std::fs::write(&base, format!("raw-candidate-blob {secret}")).unwrap();
        let ws = crate::workspace::Workspace {
            id: format!("mig-{}", uuid::Uuid::now_v7()),
            name: "c".into(),
            roots: vec![root.to_path_buf()],
        };
        let idx = crate::index::KeywordIndex::build(&ws).unwrap();
        let mut host = crate::tool_host::ToolHost::new(ws, idx, None);
        attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
        assert!(!base.exists());
        let store = host.durable_memory_store().expect("store");
        let hits = store
            .recall(
                &crate::memory::RecallQuery::new(secret),
                None,
                crate::embed::HybridWeights::default(),
                crate::embed::now_unix_secs(),
            )
            .unwrap();
        assert!(
            hits.iter()
                .all(|h| !h.record.content.contains(secret) && !h.record.title.contains(secret)),
            "legacy candidate must not ambient-recall or copy into durable memory"
        );
    }

    /// #381 product path: attach must not leave candidates.sqlite; unapproved
    /// token-shaped candidates never hit durable store or ambient recall.
    #[test]
    fn attach_non_durable_candidates_no_disk_no_ambient() {
        use crate::memory::cue::{CandidateStatus, MemoryCandidate};
        use crate::memory::{Kind, Scope};
        use std::sync::Arc;
        use uuid::Uuid;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        // Plant legacy on-disk inbox that older builds would create under workspace memory dir.
        let mem_dir = root.join(&branding.workspace_dir_name).join("memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        let legacy = mem_dir.join("candidates.sqlite");
        std::fs::write(&legacy, b"legacy-raw-secret-should-be-wiped").unwrap();

        let ws = crate::workspace::Workspace {
            id: format!("cand-{}", Uuid::now_v7()),
            name: "c".into(),
            roots: vec![root.to_path_buf()],
        };
        let idx = crate::index::KeywordIndex::build(&ws).unwrap();
        let mut host = crate::tool_host::ToolHost::new(ws, idx, None);
        attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();

        // Product attach removes legacy disk inbox.
        assert!(
            !legacy.exists(),
            "attach_durable_memory_to_host must remove candidates.sqlite"
        );

        // Propose a token-shaped unapproved candidate into the host inbox.
        let token = "sk-live-productpathtesttoken12345";
        let inbox = host.candidate_inbox().expect("inbox attached").clone();
        let c = MemoryCandidate {
            id: Uuid::now_v7(),
            kind: Kind::Fact,
            title: format!("secret {token}"),
            content: format!("api key is {token}"),
            scope: Scope::Workspace,
            salience: 0.9,
            confidence: 0.9,
            content_hash: crate::memory::content_hash_for(&format!("api key is {token}")),
            origin_session_id: None,
            cue: "test".into(),
            source_excerpt: format!("excerpt {token}"),
            created_at: 1,
            status: CandidateStatus::Pending,
            propose_supersede_of: None,
        };
        inbox.put(&c).unwrap();

        // Durable store still empty of that secret.
        let store = host.durable_memory_store().expect("store");
        let hits = store
            .recall(
                &crate::memory::RecallQuery::new(token),
                None,
                crate::embed::HybridWeights::default(),
                crate::embed::now_unix_secs(),
            )
            .unwrap();
        assert!(
            hits.iter()
                .all(|h| !h.record.content.contains(token) && !h.record.title.contains(token)),
            "unapproved candidate must not ambient/durable-recall"
        );
        // No candidates.sqlite under workspace after attach + put.
        assert!(!mem_dir.join("candidates.sqlite").exists());
        // Pending exists only in process inbox.
        assert_eq!(inbox.list(false, 10).unwrap().len(), 1);
        let _ = Arc::strong_count(&inbox);
    }

    /// #346: attach must wire embed before memory_fs import so imported notes get vectors.
    #[test]
    fn attach_imports_with_embed_backend_before_migration() {
        use crate::embed::ConceptEmbedBackend;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let branding = Branding::embedded();
        let mem = root.join(&branding.workspace_dir_name).join("memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(
            mem.join("pg.md"),
            "# Decision\n\nChose Postgres as the durable brain backend\n",
        )
        .unwrap();
        let ws = crate::workspace::Workspace {
            id: format!("attach-embed-{}", uuid::Uuid::now_v7()),
            name: "a".into(),
            roots: vec![root.to_path_buf()],
        };
        let idx = crate::index::KeywordIndex::build(&ws).unwrap();
        let mut host = crate::tool_host::ToolHost::new(ws, idx, None);
        host.set_embed_backend_with_model(
            Some(Arc::new(ConceptEmbedBackend::new(64))),
            "concept-v1",
        );
        attach_durable_memory_to_host(&mut host, &branding, &MemoryConfig::default()).unwrap();
        let store = host.durable_memory_store().expect("store attached");
        let hits = store
            .recall(
                &crate::memory::RecallQuery::new("which relational database engine was selected"),
                host.embed_backend().as_deref(),
                crate::embed::HybridWeights {
                    keyword: 0.15,
                    semantic: 0.75,
                    recency: 0.10,
                },
                crate::embed::now_unix_secs(),
            )
            .unwrap();
        let hit = hits
            .iter()
            .find(|h| h.record.content.contains("Postgres") || h.record.content.contains("durable"))
            .expect("attach-time import must be paraphrase-recallable");
        assert!(
            hit.semantic_score > 0.0,
            "imported note must have stored vector: {:?}",
            hits.iter()
                .map(|h| (h.record.content.clone(), h.semantic_score))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn workspace_path_in_repo_default() {
        let branding = Branding::embedded();
        let root = PathBuf::from("/tmp/proj");
        let p = workspace_memory_db_path(&root, &branding, WorkspaceMemoryLocation::InRepo, "id")
            .unwrap();
        assert!(p.ends_with(
            Path::new(&branding.workspace_dir_name)
                .join("memory")
                .join("memory.sqlite")
        ));
    }
}
