//! SourceRef, harvest row, and pure sync classification (#326 PR2).

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Built-in transform profile ids (free functions land in later PRs).
pub mod profiles {
    /// Faithful storage body (preferred for re-publish).
    pub const RAW_STORAGE: &str = "raw_storage";
    /// `strip_tags` plain text (default).
    pub const PLAIN_STRIP: &str = "plain_strip";
    /// storage→markdown cleaned subset.
    pub const CLEANED_MARKDOWN: &str = "cleaned_markdown";
    /// Heuristic summary extract.
    pub const SUMMARY: &str = "summary";
    /// Title/space/labels/version/url table only.
    pub const STRUCTURED_FIELDS: &str = "structured_fields";
}

/// Stable remote provenance pointer (mirrorable into memory.structured).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRef {
    /// `"confluence"` | `"workspace_file"` | `"memory"` | …
    pub system: String,
    /// Normalized instance base (no trailing slash; host lowercased).
    pub instance: String,
    /// Stable remote id (Confluence page id).
    pub remote_id: String,
    /// Space key / collection.
    pub collection: Option<String>,
    /// Remote version number when known.
    pub remote_version: Option<i64>,
    /// Remote etag when known.
    pub etag: Option<String>,
    /// Absolute web UI URL when known.
    pub url: Option<String>,
    /// Hash of canonical remote storage body at last observation.
    pub remote_content_hash: Option<String>,
}

impl SourceRef {
    /// Build a Confluence SourceRef from instance base + page id.
    pub fn confluence(
        instance: impl Into<String>,
        remote_id: impl Into<String>,
        collection: Option<String>,
    ) -> Self {
        let instance = normalize_instance(instance.into());
        Self {
            system: "confluence".into(),
            instance,
            remote_id: remote_id.into(),
            collection,
            remote_version: None,
            etag: None,
            url: None,
            remote_content_hash: None,
        }
    }

    /// Permission / audit target: `confluence://{host}/page/{id}@v{n}`.
    pub fn permission_target(&self) -> String {
        let host = self
            .instance
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        let ver = self
            .remote_version
            .map(|v| format!("@v{v}"))
            .unwrap_or_default();
        format!("confluence://{host}/page/{}{ver}", self.remote_id)
    }

    /// Harvest SoftWrite / session-grant target (exact-match only for batch safety).
    pub fn harvest_target(&self) -> String {
        let space = self.collection.as_deref().unwrap_or("_");
        format!("harvest://{}/{space}/{}", self.system, self.remote_id)
    }
}

/// Normalize instance base: trim, strip trailing slash, lowercase host.
pub fn normalize_instance(raw: String) -> String {
    let s = raw.trim().trim_end_matches('/').to_string();
    if let Ok(mut u) = url::Url::parse(&s) {
        if let Some(host) = u.host_str().map(|h| h.to_ascii_lowercase()) {
            let _ = u.set_host(Some(&host));
        }
        let mut out = u.to_string();
        if out.ends_with('/') {
            out.pop();
        }
        return out;
    }
    s
}

/// Sync classification stored on harvest rows (SoT for sync UI).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    /// Local matches last observed remote.
    #[default]
    InSync,
    /// Remote version/hash newer than last sync.
    RemoteNewer,
    /// Local edited since last sync (not yet conflicted).
    LocalDirty,
    /// Both sides changed since last sync baseline.
    Conflict,
    /// Remote page missing / 404 on check.
    MissingRemote,
    /// Local memory/file destination gone (retracted); keep memory_id pointer.
    MissingLocal,
}

impl SyncStatus {
    /// Wire / SQL string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InSync => "in_sync",
            Self::RemoteNewer => "remote_newer",
            Self::LocalDirty => "local_dirty",
            Self::Conflict => "conflict",
            Self::MissingRemote => "missing_remote",
            Self::MissingLocal => "missing_local",
        }
    }

    /// Parse wire / SQL string.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "in_sync" => Some(Self::InSync),
            "remote_newer" => Some(Self::RemoteNewer),
            "local_dirty" => Some(Self::LocalDirty),
            "conflict" => Some(Self::Conflict),
            "missing_remote" => Some(Self::MissingRemote),
            "missing_local" => Some(Self::MissingLocal),
            _ => None,
        }
    }
}

impl std::fmt::Display for SyncStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Destination of a harvest row (exactly one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HarvestDestination {
    /// Durable memory UUID (active id).
    Memory {
        /// Active memory row id.
        memory_id: Uuid,
        /// First memory id from original harvest; never rewritten.
        memory_lineage_root: Uuid,
    },
    /// Workspace-relative path under harvest prefix.
    File {
        /// Relative workspace path.
        workspace_path: String,
    },
}

/// One harvest linkage row (SyncState SoT).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarvestRecord {
    /// UUIDv7 row id.
    pub id: Uuid,
    /// Remote provenance.
    pub source: SourceRef,
    /// Local destination (memory XOR file).
    pub destination: HarvestDestination,
    /// Transform profile id.
    pub transform_profile: String,
    /// Last successful sync/observation unix seconds.
    pub last_synced_at: i64,
    /// Hash of local body at last sync.
    pub local_content_hash: String,
    /// Local edited since last remote apply.
    pub local_dirty: bool,
    /// Classified sync status.
    pub sync_status: SyncStatus,
    /// Created at unix seconds.
    pub created_at: i64,
    /// Updated at unix seconds.
    pub updated_at: i64,
}

impl HarvestRecord {
    /// Build SourceRef snapshot from this row (for memory.structured mirror).
    pub fn source_ref(&self) -> SourceRef {
        self.source.clone()
    }
}

/// Observation of remote page used by pure classify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteObservation {
    /// Remote version if any.
    pub version: Option<i64>,
    /// Remote content hash if any.
    pub content_hash: Option<String>,
    /// True when remote is confirmed missing (404).
    pub missing: bool,
}

/// Pure sync status classifier (offline-testable).
///
/// Rules (v1):
/// - missing remote → MissingRemote
/// - local_dirty && remote newer (version or hash) → Conflict
/// - local_dirty only → LocalDirty
/// - remote newer only → RemoteNewer
/// - else → InSync
pub fn classify_sync(
    record: &HarvestRecord,
    remote: &RemoteObservation,
    local_missing: bool,
) -> SyncStatus {
    if local_missing {
        return SyncStatus::MissingLocal;
    }
    if remote.missing {
        return SyncStatus::MissingRemote;
    }
    let remote_newer = is_remote_newer(record, remote);
    if record.local_dirty && remote_newer {
        SyncStatus::Conflict
    } else if record.local_dirty {
        SyncStatus::LocalDirty
    } else if remote_newer {
        SyncStatus::RemoteNewer
    } else {
        SyncStatus::InSync
    }
}

fn is_remote_newer(record: &HarvestRecord, remote: &RemoteObservation) -> bool {
    if let (Some(rv), Some(lv)) = (remote.version, record.source.remote_version) {
        if rv > lv {
            return true;
        }
    }
    if let (Some(rh), Some(lh)) = (
        remote.content_hash.as_deref(),
        record.source.remote_content_hash.as_deref(),
    ) {
        if rh != lh {
            // Hash mismatch with no version increase still means remote changed
            // when local is clean; if we also have versions and remote.version
            // is None or equal, treat hash change as newer.
            if let (Some(rv), Some(lv)) = (remote.version, record.source.remote_version) {
                return rv >= lv && rh != lh;
            }
            return true;
        }
    }
    false
}

/// Validate destination XOR for inserts.
pub fn validate_destination(dest: &HarvestDestination) -> CoreResult<()> {
    match dest {
        HarvestDestination::Memory {
            memory_id,
            memory_lineage_root,
        } => {
            if memory_id.is_nil() || memory_lineage_root.is_nil() {
                return Err(CoreError::Message(
                    "harvest memory destination requires non-nil ids".into(),
                ));
            }
            Ok(())
        }
        HarvestDestination::File { workspace_path } => {
            if workspace_path.trim().is_empty() {
                return Err(CoreError::Message(
                    "harvest file destination requires workspace_path".into(),
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(dirty: bool, ver: i64, hash: &str) -> HarvestRecord {
        // use non-nil for validate; classify doesn't care
        let id = Uuid::new_v4();
        HarvestRecord {
            id,
            source: SourceRef {
                system: "confluence".into(),
                instance: "https://wiki.example.com".into(),
                remote_id: "42".into(),
                collection: Some("ENG".into()),
                remote_version: Some(ver),
                etag: None,
                url: None,
                remote_content_hash: Some(hash.into()),
            },
            destination: HarvestDestination::Memory {
                memory_id: id,
                memory_lineage_root: id,
            },
            transform_profile: profiles::PLAIN_STRIP.into(),
            last_synced_at: 1,
            local_content_hash: "local".into(),
            local_dirty: dirty,
            sync_status: SyncStatus::InSync,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn classify_remote_newer_and_conflict() {
        let clean = sample_record(false, 3, "h1");
        let dirty = sample_record(true, 3, "h1");
        let obs = RemoteObservation {
            version: Some(4),
            content_hash: Some("h2".into()),
            missing: false,
        };
        assert_eq!(classify_sync(&clean, &obs, false), SyncStatus::RemoteNewer);
        assert_eq!(classify_sync(&dirty, &obs, false), SyncStatus::Conflict);
    }

    #[test]
    fn classify_local_dirty_and_in_sync() {
        let dirty = sample_record(true, 3, "h1");
        let clean = sample_record(false, 3, "h1");
        let same = RemoteObservation {
            version: Some(3),
            content_hash: Some("h1".into()),
            missing: false,
        };
        assert_eq!(classify_sync(&dirty, &same, false), SyncStatus::LocalDirty);
        assert_eq!(classify_sync(&clean, &same, false), SyncStatus::InSync);
    }

    #[test]
    fn classify_missing() {
        let r = sample_record(false, 1, "h");
        assert_eq!(
            classify_sync(
                &r,
                &RemoteObservation {
                    version: None,
                    content_hash: None,
                    missing: true,
                },
                false
            ),
            SyncStatus::MissingRemote
        );
        assert_eq!(
            classify_sync(
                &r,
                &RemoteObservation {
                    version: Some(1),
                    content_hash: Some("h".into()),
                    missing: false,
                },
                true
            ),
            SyncStatus::MissingLocal
        );
    }

    #[test]
    fn source_ref_targets() {
        let mut s = SourceRef::confluence("https://Wiki.Example.com/", "99", Some("ENG".into()));
        s.remote_version = Some(2);
        assert!(s.instance.contains("wiki.example.com") || s.instance.contains("Wiki.Example.com"));
        assert!(s.permission_target().contains("page/99@v2"));
        assert_eq!(s.harvest_target(), "harvest://confluence/ENG/99");
    }

    #[test]
    fn sync_status_roundtrip() {
        for s in [
            SyncStatus::InSync,
            SyncStatus::RemoteNewer,
            SyncStatus::LocalDirty,
            SyncStatus::Conflict,
            SyncStatus::MissingRemote,
            SyncStatus::MissingLocal,
        ] {
            assert_eq!(SyncStatus::parse(s.as_str()), Some(s));
        }
    }
}
