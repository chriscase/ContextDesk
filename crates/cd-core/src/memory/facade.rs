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
