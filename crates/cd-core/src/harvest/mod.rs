//! Provenance-linked harvest store + SoftWrite apply (#326 PR2–PR5).
//!
//! Co-locates `harvest` tables with the destination memory SQLite DB.

pub mod apply;
pub mod store;
pub mod sync;
pub mod transform;
pub mod types;

pub use apply::{
    harvest_page_to_file, harvest_page_to_memory, harvest_permission_target, is_harvest_target,
    parse_harvest_args, HarvestArgs, HarvestPageResult,
};
pub use store::HarvestStore;
pub use sync::{
    apply_sync_page_to_file_content, apply_sync_page_to_memory, apply_sync_permission_target,
    check_sync_with_observation, observation_from_page, parse_apply_sync_args,
    parse_check_sync_args, CheckSyncResult,
};
pub use transform::{apply_transform, content_hash, plain_strip};
pub use types::{
    classify_sync, normalize_instance, profiles, validate_destination, HarvestDestination,
    HarvestRecord, RemoteObservation, SourceRef, SyncStatus,
};
