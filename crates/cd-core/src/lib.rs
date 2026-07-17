//! ContextDesk core library.
//!
//! Hosts (desktop, server, embeds) depend on this crate for business logic.
//! Keep secrets and OS integration at the host boundary where needed;
//! pure policy and tools live here.

#![deny(missing_docs)]

pub mod agent;
pub mod audit;
pub mod branding;
pub mod chat;
pub mod config;
pub mod confluence_ro;
pub mod connectors;
pub mod discovery;
pub mod error;
pub mod events;
pub mod grok_auth;
pub mod home_source;
pub mod http_preset;
pub mod index;
pub mod injection;
/// Keychain / in-memory credential store (module name avoids gitignore `*secret*`).
pub mod keychain_store;
pub mod mcp_client;
pub mod memory_fs;
pub mod paths;
pub mod permissions;
pub mod preflight;
pub mod probe;
pub mod providers;
pub mod research;
pub mod router;
/// Back-compat alias path used in docs.
pub use keychain_store as secrets;
pub mod sessions;
pub mod skills;
pub mod sql_ro;
pub mod ssrf;
pub mod tool_host;
pub mod tools;
pub mod workspace;

pub use branding::{Branding, DEFAULT_PRODUCT_NAME, DEFAULT_SLUG};
pub use error::{CoreError, CoreResult};
pub use events::{StreamEvent, ToolPhase};
pub use permissions::{PermissionDecision, PermissionRequest, PermissionState};
pub use providers::{ProviderConfig, ProviderKind, ProviderProfile};
pub use tools::{ToolSideEffect, ToolSpec};

/// Library version (cargo package version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Protocol version string.
pub const PROTOCOL_VERSION: &str = "cd.v1";
