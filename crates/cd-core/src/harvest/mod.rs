//! Provenance-linked harvest store (#326 PR2).
//!
//! Co-locates `harvest` tables with the destination memory SQLite DB.
//! SoftWrite harvest application and transforms land in later PRs.

pub mod store;
pub mod types;

pub use store::HarvestStore;
pub use types::*;
