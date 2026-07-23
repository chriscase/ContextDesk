//! Converter-gated Publish helpers (#326 PR8 / K16).
//!
//! Publish v1 prefers `raw_storage` harvest bodies. Markdown / plain transforms
//! require an explicit `body_storage` paste until full md→storage converters ship.

use super::types::{profiles, HarvestRecord};
use crate::error::{CoreError, CoreResult};
use serde_json::{json, Value};

/// Whether this harvest may re-upload local body without a storage paste.
pub fn publish_from_local_body_allowed(transform_profile: &str) -> bool {
    transform_profile.trim() == profiles::RAW_STORAGE
}

/// Gate publish: raw_storage local body, or explicit storage override (K16).
pub fn gate_publish(
    transform_profile: &str,
    body_storage_override: Option<&str>,
) -> CoreResult<()> {
    if body_storage_override
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(());
    }
    if publish_from_local_body_allowed(transform_profile) {
        return Ok(());
    }
    Err(CoreError::Policy(
        "Publish requires transform_profile=raw_storage or paste body_storage (converter gate K16)"
            .into(),
    ))
}

/// Build frozen HardWrite args for `confluence_update_page` from a harvest row.
pub fn build_update_args(
    record: &HarvestRecord,
    body_storage: &str,
    title: Option<&str>,
) -> CoreResult<Value> {
    gate_publish(
        &record.transform_profile,
        // Caller already resolved body; re-check profile only.
        if publish_from_local_body_allowed(&record.transform_profile) {
            None
        } else {
            Some(body_storage)
        },
    )?;
    let version = record.source.remote_version.ok_or_else(|| {
        CoreError::Message(
            "harvest missing remote_version — run check_source_sync before Publish".into(),
        )
    })?;
    let mut v = json!({
        "page_id": record.source.remote_id,
        "body_storage": body_storage,
        "version": version,
        "harvest_id": record.id.to_string(),
    });
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        v["title"] = json!(t);
    }
    Ok(v)
}

/// Build frozen HardWrite args for `confluence_create_page`.
pub fn build_create_args(
    space: &str,
    title: &str,
    body_storage: &str,
    parent_id: Option<&str>,
) -> CoreResult<Value> {
    let space = space.trim();
    let title = title.trim();
    if space.is_empty() || title.is_empty() || body_storage.is_empty() {
        return Err(CoreError::Message(
            "create requires non-empty space, title, and body_storage".into(),
        ));
    }
    let mut v = json!({
        "space": space,
        "title": title,
        "body_storage": body_storage,
    });
    if let Some(p) = parent_id.map(str::trim).filter(|s| !s.is_empty()) {
        v["parent_id"] = json!(p);
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harvest::types::{HarvestDestination, SourceRef, SyncStatus};
    use uuid::Uuid;

    fn sample_record(profile: &str, version: Option<i64>) -> HarvestRecord {
        let mid = Uuid::nil();
        let mut src = SourceRef::confluence("https://wiki.example.com", "42", Some("ENG".into()));
        src.remote_version = version;
        HarvestRecord {
            id: Uuid::nil(),
            source: src,
            destination: HarvestDestination::Memory {
                memory_id: mid,
                memory_lineage_root: mid,
            },
            transform_profile: profile.into(),
            last_synced_at: 0,
            local_content_hash: "abc".into(),
            local_dirty: false,
            sync_status: SyncStatus::LocalDirty,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn raw_storage_allowed_without_paste() {
        assert!(publish_from_local_body_allowed(profiles::RAW_STORAGE));
        assert!(!publish_from_local_body_allowed(profiles::PLAIN_STRIP));
        assert!(gate_publish(profiles::RAW_STORAGE, None).is_ok());
        assert!(gate_publish(profiles::PLAIN_STRIP, None).is_err());
        assert!(gate_publish(profiles::PLAIN_STRIP, Some("<p>x</p>")).is_ok());
    }

    #[test]
    fn build_update_requires_version() {
        let r = sample_record(profiles::RAW_STORAGE, None);
        assert!(build_update_args(&r, "<p>hi</p>", None).is_err());
        let r2 = sample_record(profiles::RAW_STORAGE, Some(3));
        let args = build_update_args(&r2, "<p>hi</p>", Some("T")).unwrap();
        assert_eq!(args["page_id"], "42");
        assert_eq!(args["version"], 3);
        assert_eq!(args["body_storage"], "<p>hi</p>");
        assert_eq!(args["title"], "T");
        assert_eq!(args["harvest_id"], r2.id.to_string());
    }

    #[test]
    fn plain_strip_needs_paste_for_update_args() {
        let r = sample_record(profiles::PLAIN_STRIP, Some(1));
        // body from local is not enough without gate treating override
        assert!(gate_publish(profiles::PLAIN_STRIP, None).is_err());
        let args = build_update_args(&r, "<p>pasted</p>", None).unwrap();
        assert_eq!(args["body_storage"], "<p>pasted</p>");
    }

    #[test]
    fn build_create_args_ok() {
        let v = build_create_args("ENG", "Title", "<p>x</p>", None).unwrap();
        assert_eq!(v["space"], "ENG");
        assert!(build_create_args("", "T", "b", None).is_err());
    }
}
