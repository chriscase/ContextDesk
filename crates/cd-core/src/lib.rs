//! ContextDesk core library.
//!
//! Hosts (desktop, server, embeds) depend on this crate for business logic.
//! Keep secrets and OS integration at the host boundary; keep policy and
//! pure logic here so agents can evolve the product safely.
//!
//! # Module map
//! - [`branding`] — product identity from `branding.toml`
//! - [`error`] — shared error types
//! - [`tools`] — tool specs and side-effect classes
//! - [`events`] — `cd.v1` stream event types
//! - [`workspace`] — workspace identity (early stub)
//! - [`probe`] — gateway URL normalization / model heuristics
//! - [`permissions`] — UI-originated write grants
//! - [`providers`] — provider profile model (keychain refs, not secrets)
//! - [`preflight`] — environment health checks for Settings UI

#![deny(missing_docs)]

pub mod branding;
pub mod error;
pub mod events;
pub mod permissions;
pub mod preflight;
pub mod probe;
pub mod providers;
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
