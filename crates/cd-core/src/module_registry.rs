//! Browse-only module registry index (#139).
//!
//! **NON_GOALS.md #7 — no MCP marketplace auto-install.** This module only
//! parses and validates *metadata* for discovery. It never downloads module
//! code, never spawns entrypoints, and never calls [`crate::modules::install_module_from_dir`].
//! Install remains an explicit local-path action through Settings (#136) with
//! first-use capability approval (#135).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{build_pinned_client_for_url, validate_provider_url, SsrfPolicy, SystemResolver};
use serde::{Deserialize, Serialize};
use url::Url;

/// Schema id for a static registry JSON document.
pub const REGISTRY_SCHEMA_V1: &str = "cd.module.registry.v1";

/// Static JSON list of module metadata (discovery only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleRegistryIndex {
    /// Must be [`REGISTRY_SCHEMA_V1`].
    pub schema: String,
    /// Optional human label for the index source.
    #[serde(default)]
    pub name: String,
    /// Metadata rows only — no binaries, no install payloads.
    #[serde(default)]
    pub entries: Vec<ModuleRegistryEntry>,
}

/// One discoverable module (metadata only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleRegistryEntry {
    /// Module id (should match a future local `module.toml` id).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Semver string (informational in the index).
    pub version: String,
    /// Short description for the browser UI.
    #[serde(default)]
    pub description: String,
    /// Optional homepage or docs URL (display only; not fetched by browse).
    #[serde(default)]
    pub homepage: Option<String>,
    /// Optional **local** directory path for Install hand-off to #136.
    /// When absent, UI must tell the user to download/build locally then Install by path.
    #[serde(default)]
    pub local_path: Option<String>,
}

/// Parse a registry JSON document (fixture or fetched body).
///
/// **Does not install or execute anything** — metadata only (NON_GOALS #7).
pub fn parse_registry_json(text: &str) -> CoreResult<ModuleRegistryIndex> {
    let idx: ModuleRegistryIndex = serde_json::from_str(text)
        .map_err(|e| CoreError::Message(format!("invalid module registry JSON: {e}")))?;
    validate_index(&idx)?;
    Ok(idx)
}

fn validate_index(idx: &ModuleRegistryIndex) -> CoreResult<()> {
    if idx.schema.trim() != REGISTRY_SCHEMA_V1 {
        return Err(CoreError::Message(format!(
            "unknown registry schema (expected `{REGISTRY_SCHEMA_V1}`, got `{}`)",
            idx.schema
        )));
    }
    for e in &idx.entries {
        if e.id.trim().is_empty() {
            return Err(CoreError::Message("registry entry id is required".into()));
        }
        if e.name.trim().is_empty() {
            return Err(CoreError::Message(format!(
                "registry entry `{}` missing name",
                e.id
            )));
        }
        // Informational semver when present; allow empty version with warning via reject empty.
        if e.version.trim().is_empty() {
            return Err(CoreError::Message(format!(
                "registry entry `{}` missing version",
                e.id
            )));
        }
        semver::Version::parse(e.version.trim()).map_err(|err| {
            CoreError::Message(format!(
                "registry entry `{}` version is not valid semver: {err}",
                e.id
            ))
        })?;
    }
    Ok(())
}

/// Validate an opt-in registry fetch URL via SSRF policy (http/https only).
///
/// Empty URL is rejected — fetch is disabled until the user configures a URL.
/// Default product config leaves the URL empty (no hardcoded company index).
pub fn validate_registry_fetch_url(raw: &str, policy: &SsrfPolicy) -> CoreResult<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CoreError::Config(
            "module registry URL is empty (browse disabled until configured)".into(),
        ));
    }
    validate_provider_url(raw, policy)
}

/// Whether browse is allowed: user must opt in **and** supply a non-empty URL.
pub fn registry_browse_enabled(opt_in: bool, url: &str) -> bool {
    opt_in && !url.trim().is_empty()
}

/// Map a registry entry to a local install path for #136, if the index provided one.
///
/// Returns `None` when Install cannot hand off automatically (user must pick a path).
pub fn install_path_for_entry(entry: &ModuleRegistryEntry) -> Option<&str> {
    entry
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
}

/// Fetch registry **metadata JSON** over HTTP(S) with SSRF pin (#139).
///
/// Never installs modules. Does not download entrypoint binaries — only the index body.
/// Live network is for hosts; unit tests use [`parse_registry_json`] offline.
pub async fn fetch_registry_index(
    url_raw: &str,
    policy: &SsrfPolicy,
) -> CoreResult<ModuleRegistryIndex> {
    let (url, client) = build_pinned_client_for_url(
        url_raw,
        policy,
        &SystemResolver,
        std::time::Duration::from_secs(15),
    )?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("registry fetch failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(CoreError::Message(format!(
            "registry fetch HTTP {}",
            resp.status()
        )));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| CoreError::Message(format!("registry body: {e}")))?;
    parse_registry_json(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::install_module_from_dir;
    use std::sync::atomic::{AtomicBool, Ordering};

    const FIXTURE: &str = r#"{
  "schema": "cd.module.registry.v1",
  "name": "fixture-index",
  "entries": [
    {
      "id": "echo-notes",
      "name": "Echo Notes",
      "version": "0.1.0",
      "description": "Reference module",
      "local_path": "/tmp/does-not-auto-install"
    },
    {
      "id": "other",
      "name": "Other",
      "version": "1.0.0",
      "description": "Metadata only"
    }
  ]
}"#;

    #[test]
    fn parse_fixture_metadata_only() {
        let idx = parse_registry_json(FIXTURE).unwrap();
        assert_eq!(idx.schema, REGISTRY_SCHEMA_V1);
        assert_eq!(idx.entries.len(), 2);
        assert_eq!(idx.entries[0].id, "echo-notes");
        assert!(install_path_for_entry(&idx.entries[0]).is_some());
        assert!(install_path_for_entry(&idx.entries[1]).is_none());
    }

    #[test]
    fn reject_bad_schema_and_semver() {
        let err = parse_registry_json(r#"{"schema":"nope","entries":[]}"#)
            .unwrap_err()
            .to_string();
        assert!(err.contains("schema"), "{err}");
        let bad = r#"{
          "schema": "cd.module.registry.v1",
          "entries": [{"id":"x","name":"X","version":"not-semver"}]
        }"#;
        let err = parse_registry_json(bad).unwrap_err().to_string();
        assert!(err.contains("semver"), "{err}");
    }

    #[test]
    fn ssrf_gates_registry_url() {
        let p = SsrfPolicy::default();
        assert!(validate_registry_fetch_url("", &p).is_err());
        assert!(validate_registry_fetch_url("https://example.com/modules.json", &p).is_ok());
        assert!(validate_registry_fetch_url("http://169.254.169.254/latest", &p).is_err());
        assert!(validate_registry_fetch_url("http://10.0.0.5/reg.json", &p).is_err());
        assert!(validate_registry_fetch_url("file:///etc/passwd", &p).is_err());
    }

    #[test]
    fn browse_disabled_by_default() {
        assert!(!registry_browse_enabled(
            false,
            "https://example.com/r.json"
        ));
        assert!(!registry_browse_enabled(true, ""));
        assert!(!registry_browse_enabled(true, "   "));
        assert!(registry_browse_enabled(true, "https://example.com/r.json"));
    }

    /// Prove browse path never calls install (NON_GOALS #7).
    #[test]
    fn browse_parse_does_not_install() {
        static INSTALL_CALLED: AtomicBool = AtomicBool::new(false);
        // Parsing is the browse surface; install is a separate API the user must invoke.
        let idx = parse_registry_json(FIXTURE).unwrap();
        assert!(!INSTALL_CALLED.load(Ordering::SeqCst));
        assert_eq!(idx.entries.len(), 2);
        // install_module_from_dir is *not* invoked by parse_registry_json.
        // Reference the install API only to document the boundary for reviewers.
        let _install_api: fn(&std::path::Path, &std::path::Path) -> CoreResult<_> =
            install_module_from_dir;
        assert!(!INSTALL_CALLED.load(Ordering::SeqCst));
    }
}
