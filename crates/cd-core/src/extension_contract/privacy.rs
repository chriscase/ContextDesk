//! Share-safe text scanning for extension fixtures and envelopes.
//!
//! The scanner lives in the public contract crate so share-safe validation
//! does not depend on `cd-core` internals.

pub use cd_triage_sdk::{scan_share_safe_text, PrivacyFinding, PRIVACY_FORBIDDEN_SUBSTRINGS};
