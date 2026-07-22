//! Provenance-linked harvest store + SoftWrite apply (#326 PR2–PR3).
//!
//! Co-locates `harvest` tables with the destination memory SQLite DB.

pub mod apply;
pub mod store;
pub mod transform;
pub mod types;

pub use apply::{
    harvest_page_to_memory, harvest_permission_target, is_harvest_target, parse_harvest_args,
    HarvestArgs, HarvestPageResult,
};
pub use store::HarvestStore;
pub use transform::{apply_transform, content_hash, plain_strip};
pub use types::*;
