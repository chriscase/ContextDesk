//! SoftWrite harvest apply: memory + harvest row (#326 PR3).

use super::store::HarvestStore;
use super::transform::{apply_transform, content_hash};
use super::types::*;
use crate::confluence_ro::{space_permitted, ConfluencePageBody, ConfluenceRoConfig};
use crate::error::{CoreError, CoreResult};
use crate::memory::{Kind, MemoryDraft, MemorySource, MemoryStore, MemoryWriteOp, Scope};
use uuid::Uuid;

/// Result of one page harvest.
#[derive(Debug, Clone)]
pub struct HarvestPageResult {
    /// Page id requested.
    pub page_id: String,
    /// Whether this page succeeded.
    pub ok: bool,
    /// Harvest row id when ok.
    pub harvest_id: Option<Uuid>,
    /// Memory id when destination includes memory.
    pub memory_id: Option<Uuid>,
    /// Error message when !ok.
    pub error: Option<String>,
}

/// Apply one expanded page into durable memory + harvest SoT (offline-testable).
///
/// Policy: `space_permitted(..., require_allowlist=true)` — empty allowlist denied.
pub fn harvest_page_to_memory(
    cfg: &ConfluenceRoConfig,
    memory: &dyn MemoryStore,
    harvest: &HarvestStore,
    body: &ConfluencePageBody,
    transform_profile: &str,
    scope: Scope,
    now_secs: i64,
) -> CoreResult<(crate::memory::MemoryRecord, HarvestRecord)> {
    let space = body.meta.space.as_str();
    if !space_permitted(cfg, space, true) {
        if cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                "spaces allowlist required for harvest (add space keys in Settings)".into(),
            ));
        }
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted for harvest"
        )));
    }

    let profile = if transform_profile.trim().is_empty() {
        profiles::PLAIN_STRIP
    } else {
        transform_profile.trim()
    };
    let content = apply_transform(profile, &body.storage, &body.meta);
    let local_hash = content_hash(&content);
    let remote_hash = content_hash(&body.storage);

    let mut source =
        SourceRef::confluence(&cfg.base_url, &body.meta.id, Some(body.meta.space.clone()));
    source.remote_version = body.meta.version;
    source.url = body.meta.url.clone();
    source.remote_content_hash = Some(remote_hash);

    let mut draft = MemoryDraft::new(Kind::ProjectNote, content);
    draft.title = body.meta.title.clone();
    draft.scope = scope;
    draft.source = MemorySource::Connector;
    draft.origin_tool = Some("harvest_from_source".into());
    draft.url = source.url.clone();
    draft.tags = {
        let mut t = vec![
            "source:confluence".into(),
            format!("space:{}", body.meta.space),
        ];
        t.extend(body.meta.labels.iter().cloned());
        t
    };
    // provenance filled after harvest id known — dual-write harvest first then memory
    // (design: harvest SoT first). We insert harvest with provisional memory_id after put.
    // Order: put memory then harvest row with ids (design dual-write harvest-first prefers
    // harvest row before memory; for SQLite CHECK we need memory_id). Put memory first is OK
    // if we then write harvest; on failure leave orphan memory (acceptable v1).
    let rec = memory.put(MemoryWriteOp::Insert(draft), now_secs)?;

    let harvest_id = Uuid::now_v7();
    let structured_note = serde_json::json!({
        "provenance": source,
        "harvest_id": harvest_id.to_string(),
        "transform_profile": profile,
        "confluence": {
            "space": body.meta.space,
            "page_id": body.meta.id,
            "version": body.meta.version,
        }
    });
    // Best-effort supersede to attach structured provenance (same content).
    let mut draft2 = MemoryDraft::new(Kind::ProjectNote, rec.content.clone());
    draft2.title = rec.title.clone();
    draft2.scope = rec.scope;
    draft2.source = MemorySource::Connector;
    draft2.origin_tool = Some("harvest_from_source".into());
    draft2.url = rec.url.clone();
    draft2.tags = rec.tags.clone();
    draft2.structured = structured_note;
    let rec = memory
        .put(
            MemoryWriteOp::Supersede {
                old: rec.id,
                new: draft2,
            },
            now_secs,
        )
        .unwrap_or(rec);

    let record = HarvestRecord {
        id: harvest_id,
        source: source.clone(),
        destination: HarvestDestination::Memory {
            memory_id: rec.id,
            memory_lineage_root: rec.id,
        },
        transform_profile: profile.to_string(),
        last_synced_at: now_secs,
        local_content_hash: local_hash,
        local_dirty: false,
        sync_status: SyncStatus::InSync,
        created_at: now_secs,
        updated_at: now_secs,
    };
    harvest.upsert_by_remote(&record)?;
    Ok((rec, record))
}

/// Harvest page into a workspace-relative markdown file + harvest row (#326 PR4).
///
/// `write_file` must write the body to an allowlisted workspace path (host enforces ACL).
pub fn harvest_page_to_file(
    cfg: &ConfluenceRoConfig,
    harvest: &HarvestStore,
    body: &ConfluencePageBody,
    transform_profile: &str,
    workspace_rel_path: &str,
    write_file: &dyn Fn(&str, &str) -> CoreResult<()>,
    now_secs: i64,
) -> CoreResult<HarvestRecord> {
    let space = body.meta.space.as_str();
    if !space_permitted(cfg, space, true) {
        if cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                "spaces allowlist required for harvest (add space keys in Settings)".into(),
            ));
        }
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted for harvest"
        )));
    }
    let path = workspace_rel_path.trim();
    if path.is_empty() {
        return Err(CoreError::Message(
            "file harvest requires workspace-relative path".into(),
        ));
    }
    let profile = if transform_profile.trim().is_empty() {
        profiles::PLAIN_STRIP
    } else {
        transform_profile.trim()
    };
    let content = apply_transform(profile, &body.storage, &body.meta);
    let local_hash = content_hash(&content);
    let remote_hash = content_hash(&body.storage);
    write_file(path, &content)?;

    let mut source =
        SourceRef::confluence(&cfg.base_url, &body.meta.id, Some(body.meta.space.clone()));
    source.remote_version = body.meta.version;
    source.url = body.meta.url.clone();
    source.remote_content_hash = Some(remote_hash);

    let record = HarvestRecord {
        id: Uuid::now_v7(),
        source,
        destination: HarvestDestination::File {
            workspace_path: path.to_string(),
        },
        transform_profile: profile.to_string(),
        last_synced_at: now_secs,
        local_content_hash: local_hash,
        local_dirty: false,
        sync_status: SyncStatus::InSync,
        created_at: now_secs,
        updated_at: now_secs,
    };
    harvest.upsert_by_remote(&record)?;
    Ok(record)
}

/// Validate harvest SoftWrite args before permission / execute.
pub fn parse_harvest_args(args: &serde_json::Value) -> CoreResult<HarvestArgs> {
    let system = args
        .get("system")
        .and_then(|v| v.as_str())
        .unwrap_or("confluence")
        .trim()
        .to_string();
    if system != "confluence" {
        return Err(CoreError::Message(
            "harvest_from_source v1 only supports system=confluence".into(),
        ));
    }
    let page_ids: Vec<String> = args
        .get("page_ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if page_ids.is_empty() {
        if let Some(one) = args.get("page_id").and_then(|v| v.as_str()) {
            let one = one.trim();
            if !one.is_empty() {
                return Ok(HarvestArgs {
                    system,
                    page_ids: vec![one.to_string()],
                    transform: args
                        .get("transform")
                        .and_then(|v| v.as_str())
                        .unwrap_or(profiles::PLAIN_STRIP)
                        .to_string(),
                    destination: parse_destination_kind(args),
                    file_path: parse_file_path(args),
                    scope: parse_scope(args),
                    batch_max: 25,
                });
            }
        }
        return Err(CoreError::Message(
            "harvest_from_source requires page_ids (or page_id)".into(),
        ));
    }
    let batch_max = args
        .get("batch_max")
        .and_then(|v| v.as_u64())
        .unwrap_or(25)
        .clamp(1, 50) as usize;
    let page_ids: Vec<String> = page_ids.into_iter().take(batch_max).collect();
    let dest = parse_destination_kind(args);
    if dest == "file" && parse_file_path(args).is_none() {
        return Err(CoreError::Message(
            "destination=file requires file_path (workspace-relative)".into(),
        ));
    }
    if dest != "memory" && dest != "file" {
        return Err(CoreError::Message(
            "destination must be memory or file".into(),
        ));
    }
    Ok(HarvestArgs {
        system,
        page_ids,
        transform: args
            .get("transform")
            .and_then(|v| v.as_str())
            .unwrap_or(profiles::PLAIN_STRIP)
            .to_string(),
        destination: dest,
        file_path: parse_file_path(args),
        scope: parse_scope(args),
        batch_max,
    })
}

fn parse_destination_kind(args: &serde_json::Value) -> String {
    args.get("destination")
        .and_then(|v| v.as_str())
        .unwrap_or("memory")
        .trim()
        .to_string()
}

fn parse_file_path(args: &serde_json::Value) -> Option<String> {
    args.get("file_path")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_scope(args: &serde_json::Value) -> Scope {
    args.get("scope")
        .and_then(|v| v.as_str())
        .and_then(Scope::parse)
        .unwrap_or(Scope::Workspace)
}

/// Parsed harvest tool args.
#[derive(Debug, Clone)]
pub struct HarvestArgs {
    /// Source system.
    pub system: String,
    /// Page ids to harvest.
    pub page_ids: Vec<String>,
    /// Transform profile id.
    pub transform: String,
    /// Destination kind: `memory` | `file`.
    pub destination: String,
    /// Workspace-relative path when destination is file.
    pub file_path: Option<String>,
    /// Memory scope.
    pub scope: Scope,
    /// Cap used.
    pub batch_max: usize,
}

/// Permission / audit target for harvest SoftWrite.
pub fn harvest_permission_target(args: &HarvestArgs) -> String {
    if args.page_ids.len() == 1 {
        format!("harvest://confluence/_/{}", args.page_ids[0])
    } else {
        format!("harvest://confluence/batch/{}", args.page_ids.len())
    }
}

/// Whether a permission target is a harvest SoftWrite target (never session-auto).
pub fn is_harvest_target(target: &str) -> bool {
    target.trim().starts_with("harvest://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confluence_ro::{ConfluencePageBody, ConfluencePageMeta, ConfluenceRoConfig};
    use crate::memory::SqliteMemoryStore;

    fn page(space: &str) -> ConfluencePageBody {
        ConfluencePageBody {
            meta: ConfluencePageMeta {
                id: "42".into(),
                title: "Page".into(),
                space: space.into(),
                version: Some(1),
                parent_id: None,
                url: Some("https://wiki.example.com/p/42".into()),
                labels: vec![],
                excerpt: None,
            },
            storage: "<p>Hello harvest</p>".into(),
            plain: "Hello harvest".into(),
        }
    }

    #[test]
    fn empty_allowlist_denies_harvest() {
        let cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec![]);
        let mem = SqliteMemoryStore::open_in_memory().unwrap();
        let hv = HarvestStore::open_in_memory().unwrap();
        let err = harvest_page_to_memory(
            &cfg,
            &mem,
            &hv,
            &page("ENG"),
            profiles::PLAIN_STRIP,
            Scope::Workspace,
            100,
        )
        .unwrap_err();
        assert!(err.to_string().contains("allowlist required"));
    }

    #[test]
    fn harvest_writes_memory_and_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.sqlite");
        let mem = SqliteMemoryStore::open(&path).unwrap();
        let hv = HarvestStore::open(&path).unwrap();
        let cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec!["ENG".into()]);
        let (rec, hr) = harvest_page_to_memory(
            &cfg,
            &mem,
            &hv,
            &page("ENG"),
            profiles::PLAIN_STRIP,
            Scope::Workspace,
            200,
        )
        .unwrap();
        assert!(rec.content.contains("Hello harvest"));
        assert_eq!(hr.source.remote_id, "42");
        match hr.destination {
            HarvestDestination::Memory { memory_id, .. } => {
                assert_eq!(memory_id, rec.id);
            }
            _ => panic!("expected memory dest"),
        }
        let found = hv.find_by_memory_id(&rec.id).unwrap().unwrap();
        assert_eq!(found.source.collection.as_deref(), Some("ENG"));
    }

    #[test]
    fn wrong_space_denied() {
        let cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec!["ENG".into()]);
        let mem = SqliteMemoryStore::open_in_memory().unwrap();
        let hv = HarvestStore::open_in_memory().unwrap();
        let err = harvest_page_to_memory(
            &cfg,
            &mem,
            &hv,
            &page("HR"),
            profiles::PLAIN_STRIP,
            Scope::Workspace,
            1,
        )
        .unwrap_err();
        assert!(err.to_string().contains("not allowlisted"));
    }

    #[test]
    fn parse_args_and_target() {
        let args = serde_json::json!({
            "page_ids": ["1", "2"],
            "transform": "plain_strip"
        });
        let a = parse_harvest_args(&args).unwrap();
        assert_eq!(a.page_ids.len(), 2);
        assert!(harvest_permission_target(&a).contains("batch/2"));
        assert!(is_harvest_target("harvest://confluence/_/1"));
    }

    #[test]
    fn harvest_to_file_writes_content_and_row() {
        use std::sync::Mutex;
        let hv = HarvestStore::open_in_memory().unwrap();
        let cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec!["ENG".into()]);
        let wrote = Mutex::new(String::new());
        let hr = harvest_page_to_file(
            &cfg,
            &hv,
            &page("ENG"),
            profiles::PLAIN_STRIP,
            "harvest/eng/42.md",
            &|path, body| {
                assert_eq!(path, "harvest/eng/42.md");
                *wrote.lock().unwrap() = body.to_string();
                Ok(())
            },
            50,
        )
        .unwrap();
        assert!(wrote.lock().unwrap().contains("Hello harvest"));
        match hr.destination {
            HarvestDestination::File { workspace_path } => {
                assert_eq!(workspace_path, "harvest/eng/42.md");
            }
            _ => panic!("expected file dest"),
        }
    }

    #[test]
    fn parse_file_destination() {
        let a = parse_harvest_args(&serde_json::json!({
            "page_id": "9",
            "destination": "file",
            "file_path": "harvest/x.md"
        }))
        .unwrap();
        assert_eq!(a.destination, "file");
        assert_eq!(a.file_path.as_deref(), Some("harvest/x.md"));
    }
}
