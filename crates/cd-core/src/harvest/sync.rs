//! check_source_sync (Read) + apply_source_sync (SoftWrite) — #326 PR5.
//!
//! Pure classify is offline; HTTP fetch is host/tool layer.

use super::store::HarvestStore;
use super::transform::{apply_transform, content_hash};
use super::types::*;
use crate::confluence_ro::ConfluencePageBody;
use crate::error::{CoreError, CoreResult};
use crate::memory::{Kind, MemoryDraft, MemorySource, MemoryStore, MemoryWriteOp};
use uuid::Uuid;

/// Result of a check (Read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckSyncResult {
    /// Harvest row id.
    pub harvest_id: Uuid,
    /// Classified status.
    pub status: SyncStatus,
    /// Short detail for UI/model.
    pub detail: String,
}

/// Check sync using already-fetched remote observation + local state (offline-testable).
pub fn check_sync_with_observation(
    harvest: &HarvestStore,
    record: &HarvestRecord,
    remote: &RemoteObservation,
    local_missing: bool,
    now_secs: i64,
) -> CoreResult<CheckSyncResult> {
    let status = classify_sync(record, remote, local_missing);
    let mut updated = record.clone();
    updated.sync_status = status;
    updated.updated_at = now_secs;
    if let Some(v) = remote.version {
        updated.source.remote_version = Some(v);
    }
    if let Some(ref h) = remote.content_hash {
        updated.source.remote_content_hash = Some(h.clone());
    }
    harvest.update(&updated)?;
    Ok(CheckSyncResult {
        harvest_id: record.id,
        status,
        detail: format!("sync_status={}", status.as_str()),
    })
}

/// Build RemoteObservation from expanded page body.
pub fn observation_from_page(body: &ConfluencePageBody) -> RemoteObservation {
    RemoteObservation {
        version: body.meta.version,
        content_hash: Some(content_hash(&body.storage)),
        missing: false,
    }
}

/// Apply remote body onto local destination (SoftWrite — caller must gate permission).
///
/// Memory: Supersede with transformed content; update harvest row.
/// File: rewrite workspace path content.
pub fn apply_sync_page_to_memory(
    memory: &dyn MemoryStore,
    harvest: &HarvestStore,
    record: &HarvestRecord,
    body: &ConfluencePageBody,
    now_secs: i64,
) -> CoreResult<(Uuid, HarvestRecord)> {
    let (old_id, lineage) = match &record.destination {
        HarvestDestination::Memory {
            memory_id,
            memory_lineage_root,
        } => (*memory_id, *memory_lineage_root),
        HarvestDestination::File { .. } => {
            return Err(CoreError::Message(
                "apply_sync_page_to_memory requires memory destination".into(),
            ));
        }
    };
    if memory.get(&old_id)?.is_none() {
        return Err(CoreError::Message(format!(
            "local memory missing for apply: {old_id}"
        )));
    }

    let content = apply_transform(&record.transform_profile, &body.storage, &body.meta);
    let local_hash = content_hash(&content);
    let remote_hash = content_hash(&body.storage);

    let mut draft = MemoryDraft::new(Kind::ProjectNote, content);
    draft.title = body.meta.title.clone();
    draft.source = MemorySource::Connector;
    draft.origin_tool = Some("apply_source_sync".into());
    draft.url = body.meta.url.clone();
    draft.structured = serde_json::json!({
        "provenance": {
            "system": "confluence",
            "remote_id": body.meta.id,
            "space": body.meta.space,
            "version": body.meta.version,
            "harvest_id": record.id.to_string(),
        },
        "transform_profile": record.transform_profile,
    });

    let rec = memory.put(
        MemoryWriteOp::Supersede {
            old: old_id,
            new: draft,
        },
        now_secs,
    )?;
    let _ = harvest.on_memory_superseded(&old_id, &rec.id, now_secs, false);

    let mut source = record.source.clone();
    source.remote_version = body.meta.version;
    source.url = body.meta.url.clone();
    source.remote_content_hash = Some(remote_hash);

    let updated = HarvestRecord {
        id: record.id,
        source,
        destination: HarvestDestination::Memory {
            memory_id: rec.id,
            memory_lineage_root: lineage,
        },
        transform_profile: record.transform_profile.clone(),
        last_synced_at: now_secs,
        local_content_hash: local_hash,
        local_dirty: false,
        sync_status: SyncStatus::InSync,
        created_at: record.created_at,
        updated_at: now_secs,
    };
    harvest.update(&updated)?;
    Ok((rec.id, updated))
}

/// Apply remote body to a file destination harvest (writes bytes via callback path).
pub fn apply_sync_page_to_file_content(
    record: &HarvestRecord,
    body: &ConfluencePageBody,
) -> CoreResult<(String, String)> {
    let path = match &record.destination {
        HarvestDestination::File { workspace_path } => workspace_path.clone(),
        _ => {
            return Err(CoreError::Message(
                "apply_sync_page_to_file_content requires file destination".into(),
            ));
        }
    };
    let content = apply_transform(&record.transform_profile, &body.storage, &body.meta);
    Ok((path, content))
}

/// Parse check_source_sync args.
pub fn parse_check_sync_args(args: &serde_json::Value) -> CoreResult<Uuid> {
    let id_s = args
        .get("harvest_id")
        .or_else(|| args.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Message("check_source_sync requires harvest_id".into()))?;
    Uuid::parse_str(id_s.trim())
        .map_err(|_| CoreError::Message(format!("invalid harvest_id: {id_s}")))
}

/// Parse apply_source_sync args.
pub fn parse_apply_sync_args(args: &serde_json::Value) -> CoreResult<Uuid> {
    let id_s = args
        .get("harvest_id")
        .or_else(|| args.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::Message("apply_source_sync requires harvest_id".into()))?;
    Uuid::parse_str(id_s.trim())
        .map_err(|_| CoreError::Message(format!("invalid harvest_id: {id_s}")))
}

/// Permission target for apply (exact-match harvest://).
pub fn apply_sync_permission_target(record: &HarvestRecord) -> String {
    record.source.harvest_target()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confluence_ro::{ConfluencePageBody, ConfluencePageMeta, ConfluenceRoConfig};
    use crate::harvest::apply::harvest_page_to_memory;
    use crate::memory::SqliteMemoryStore;

    fn page(space: &str, ver: i64, storage: &str) -> ConfluencePageBody {
        ConfluencePageBody {
            meta: ConfluencePageMeta {
                id: "42".into(),
                title: "Page".into(),
                space: space.into(),
                version: Some(ver),
                parent_id: None,
                url: Some("https://wiki.example.com/p/42".into()),
                labels: vec![],
                excerpt: None,
            },
            storage: storage.into(),
            plain: "x".into(),
        }
    }

    #[test]
    fn check_and_apply_memory_path_offline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.sqlite");
        let mem = SqliteMemoryStore::open(&path).unwrap();
        let hv = HarvestStore::open(&path).unwrap();
        let cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec!["ENG".into()]);
        let (_rec, hr) = harvest_page_to_memory(
            &cfg,
            &mem,
            &hv,
            &page("ENG", 1, "<p>v1</p>"),
            profiles::PLAIN_STRIP,
            crate::memory::Scope::Workspace,
            100,
        )
        .unwrap();

        let obs = observation_from_page(&page("ENG", 2, "<p>v2 body</p>"));
        let check = check_sync_with_observation(&hv, &hr, &obs, false, 200).unwrap();
        assert_eq!(check.status, SyncStatus::RemoteNewer);

        let row = hv.get(&hr.id).unwrap().unwrap();
        let (new_id, updated) =
            apply_sync_page_to_memory(&mem, &hv, &row, &page("ENG", 2, "<p>v2 body</p>"), 300)
                .unwrap();
        assert_ne!(new_id, hr.id);
        assert_eq!(updated.sync_status, SyncStatus::InSync);
        let got = mem.get(&new_id).unwrap().unwrap();
        assert!(got.content.contains("v2 body") || got.content.contains("v2"));
    }

    #[test]
    fn parse_ids() {
        let id = Uuid::now_v7();
        let a = parse_check_sync_args(&serde_json::json!({"harvest_id": id.to_string()})).unwrap();
        assert_eq!(a, id);
        let b = parse_apply_sync_args(&serde_json::json!({"id": id.to_string()})).unwrap();
        assert_eq!(b, id);
    }
}
