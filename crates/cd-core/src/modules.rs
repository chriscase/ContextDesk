//! External module manifests (`cd.module.v1`), discovery, and capability grants (#134/#135).
//!
//! Substrate: MCP stdio subprocess — see `docs/adr/0001-external-module-substrate.md`.
//! Spawn/lifecycle is #136; this module enforces **UI-originated** capability grants.

use crate::connectors::validate_mcp_command;
use crate::error::{CoreError, CoreResult};
use crate::permissions::{PermissionDecision, PermissionRequest};
use crate::tools::ToolSideEffect;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Exact schema id for module manifests.
pub const MODULE_SCHEMA_V1: &str = "cd.module.v1";

/// Parsed `module.toml` for one third-party module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleManifest {
    /// Must be exactly [`MODULE_SCHEMA_V1`].
    pub schema: String,
    /// Stable module id (directory name should match).
    pub id: String,
    /// Human display name.
    pub name: String,
    /// Semver version string (validated on parse).
    pub version: String,
    /// MCP entrypoint (absolute command + args).
    pub entrypoint: ModuleEntrypoint,
    /// Tools the module claims to provide (host still classifies side effects).
    #[serde(default)]
    pub provided_tools: Vec<ModuleToolDecl>,
    /// Tools that must be treated as HardWrite (host-assigned; mirror MCP config).
    #[serde(default)]
    pub hard_write_tools: Vec<String>,
    /// Generic connector kinds only (e.g. `http`, `sqlite`) — no employer brands.
    #[serde(default)]
    pub provided_connectors: Vec<String>,
    /// Capabilities the module **requests** (host may deny).
    #[serde(default)]
    pub requested_capabilities: ModuleCapabilities,
    /// Directory the manifest was loaded from (set by discovery; not in TOML).
    #[serde(skip)]
    pub path: PathBuf,
}

/// Absolute MCP command + args.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleEntrypoint {
    /// Absolute path to the executable.
    pub command: PathBuf,
    /// Args passed after the command.
    #[serde(default)]
    pub args: Vec<String>,
}

/// Declared tool name (and optional description for UI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleToolDecl {
    /// Tool name as registered by the MCP server (bare name, not `mcp__…`).
    pub name: String,
    /// Optional short description.
    #[serde(default)]
    pub description: String,
}

/// Requested host capabilities (not automatically granted).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleCapabilities {
    /// Filesystem roots the module wants to read/write (host policy still applies).
    #[serde(default)]
    pub filesystem_roots: Vec<PathBuf>,
    /// Network hosts the module wants to contact (SSRF policy still applies).
    #[serde(default)]
    pub network_hosts: Vec<String>,
    /// Secret keychain refs the module wants the host to inject (never raw secrets).
    #[serde(default)]
    pub secret_refs: Vec<String>,
}

/// Host-assigned side effect for a tool name from a manifest.
///
/// Defaults to [`ToolSideEffect::Read`] unless the name is listed in
/// `hard_write_tools` (same principle as `mcp_client` classification).
pub fn side_effect_for_module_tool(tool_name: &str, hard_write_tools: &[String]) -> ToolSideEffect {
    let n = tool_name.trim();
    if hard_write_tools.iter().any(|h| h.trim() == n) {
        ToolSideEffect::HardWrite
    } else {
        ToolSideEffect::Read
    }
}

/// Parse and validate a module.toml from TOML text.
pub fn parse_module_toml(text: &str) -> CoreResult<ModuleManifest> {
    let mut m: ModuleManifest = toml::from_str(text)
        .map_err(|e| CoreError::Message(format!("invalid module.toml: {e}")))?;
    validate_manifest(&mut m)?;
    Ok(m)
}

/// Parse `module.toml` at `path` and record the parent directory on the result.
pub fn parse_module_file(path: &Path) -> CoreResult<ModuleManifest> {
    let text = fs::read_to_string(path)
        .map_err(|e| CoreError::Message(format!("read {}: {e}", path.display())))?;
    let mut m = parse_module_toml(&text)?;
    if let Some(parent) = path.parent() {
        m.path = parent.to_path_buf();
    }
    Ok(m)
}

fn validate_manifest(m: &mut ModuleManifest) -> CoreResult<()> {
    if m.schema.trim() != MODULE_SCHEMA_V1 {
        return Err(CoreError::Message(format!(
            "unknown or missing module schema (expected `{MODULE_SCHEMA_V1}`, got `{}`)",
            m.schema
        )));
    }
    if m.id.trim().is_empty() {
        return Err(CoreError::Message("module id is required".into()));
    }
    if m.name.trim().is_empty() {
        return Err(CoreError::Message("module name is required".into()));
    }
    // Semver validation.
    semver::Version::parse(m.version.trim())
        .map_err(|e| CoreError::Message(format!("module version is not valid semver: {e}")))?;
    validate_mcp_command(&m.entrypoint.command)?;
    Ok(())
}

/// Discover modules under `dirs` (each may contain `<id>/module.toml`).
///
/// Skips non-directories and trees without `module.toml`. Malformed manifests
/// are skipped with `tracing::warn!` so one bad module does not block others.
pub fn discover_modules(dirs: &[PathBuf]) -> CoreResult<Vec<ModuleManifest>> {
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        // dir/module.toml (single) or dir/*/module.toml
        let direct = dir.join("module.toml");
        if direct.is_file() {
            match parse_module_file(&direct) {
                Ok(m) => out.push(m),
                Err(e) => tracing::warn!(path = %direct.display(), error = %e, "skip module"),
            }
        }
        if let Ok(rd) = fs::read_dir(dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                if !p.is_dir() {
                    continue;
                }
                let mt = p.join("module.toml");
                if !mt.is_file() {
                    continue;
                }
                match parse_module_file(&mt) {
                    Ok(m) => out.push(m),
                    Err(e) => {
                        tracing::warn!(path = %mt.display(), error = %e, "skip module")
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Default modules directory under the product config dir (`~/.{config_dir_name}/modules`).
pub fn default_modules_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("modules")
}

/// Install a module from a local directory containing `module.toml` into `modules_dir/<id>/`.
///
/// **Local path only** — no network fetch (NON_GOALS #7). Validates via [`parse_module_file`].
pub fn install_module_from_dir(src: &Path, modules_dir: &Path) -> CoreResult<ModuleManifest> {
    let manifest_path =
        if src.is_file() && src.file_name().and_then(|s| s.to_str()) == Some("module.toml") {
            src.to_path_buf()
        } else {
            src.join("module.toml")
        };
    if !manifest_path.is_file() {
        return Err(CoreError::Message(format!(
            "no module.toml at {}",
            manifest_path.display()
        )));
    }
    let m = parse_module_file(&manifest_path)?;
    let dest = modules_dir.join(&m.id);
    if dest.exists() {
        return Err(CoreError::Message(format!(
            "module `{}` already installed at {}",
            m.id,
            dest.display()
        )));
    }
    fs::create_dir_all(&dest).map_err(|e| CoreError::Message(format!("create module dir: {e}")))?;
    // Copy module.toml + sibling files from source directory (shallow).
    let src_dir = manifest_path.parent().unwrap_or(src);
    if let Ok(rd) = fs::read_dir(src_dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_file() {
                let name = p.file_name().unwrap();
                fs::copy(&p, dest.join(name))
                    .map_err(|e| CoreError::Message(format!("copy {}: {e}", p.display())))?;
            }
        }
    }
    parse_module_file(&dest.join("module.toml"))
}

/// Remove an installed module directory.
pub fn remove_module_dir(modules_dir: &Path, module_id: &str) -> CoreResult<()> {
    let dest = modules_dir.join(module_id);
    if !dest.exists() {
        return Err(CoreError::Message(format!(
            "module `{module_id}` not installed"
        )));
    }
    fs::remove_dir_all(&dest).map_err(|e| CoreError::Message(format!("remove module: {e}")))?;
    Ok(())
}

/// Update an installed module by re-copying from a local source dir (same id required).
pub fn update_module_from_dir(src: &Path, modules_dir: &Path) -> CoreResult<ModuleManifest> {
    let m = {
        let manifest_path = if src.is_file() {
            src.to_path_buf()
        } else {
            src.join("module.toml")
        };
        parse_module_file(&manifest_path)?
    };
    let dest = modules_dir.join(&m.id);
    if dest.exists() {
        fs::remove_dir_all(&dest)
            .map_err(|e| CoreError::Message(format!("remove old module: {e}")))?;
    }
    install_module_from_dir(src, modules_dir)
}

// ─── Capability grants (#135) ───────────────────────────────────────────────

/// Persisted per-module capability grants (UI-originated only).
///
/// A manifest's `requested_capabilities` never auto-grant — the host must call
/// [`ModuleGrantStore::grant_from_ui`] after a successful `PermissionDecision`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModuleGrantStore {
    /// module_id → granted capabilities (may be a subset of requested).
    grants: HashMap<String, ModuleCapabilities>,
}

impl ModuleGrantStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Load grants JSON from disk (missing file → empty).
    pub fn load(path: &Path) -> CoreResult<Self> {
        if !path.is_file() {
            return Ok(Self::new());
        }
        let text = fs::read_to_string(path).map_err(|e| {
            CoreError::Message(format!("read module grants {}: {e}", path.display()))
        })?;
        serde_json::from_str(&text)
            .map_err(|e| CoreError::Message(format!("parse module grants: {e}")))
    }

    /// Persist grants JSON.
    pub fn save(&self, path: &Path) -> CoreResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| CoreError::Message(format!("create grants dir: {e}")))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| CoreError::Message(format!("serialize grants: {e}")))?;
        fs::write(path, text).map_err(|e| CoreError::Message(format!("write grants: {e}")))?;
        Ok(())
    }

    /// Whether `module_id` has an explicit UI grant recorded.
    pub fn is_granted(&self, module_id: &str) -> bool {
        self.grants.contains_key(module_id)
    }

    /// Granted capabilities for a module (empty if never granted).
    pub fn granted(&self, module_id: &str) -> ModuleCapabilities {
        self.grants.get(module_id).cloned().unwrap_or_default()
    }

    /// Record a UI-originated grant after `validate_decision` succeeds.
    ///
    /// Rejects `Deny`. Does **not** accept a bare manifest as proof of grant.
    pub fn grant_from_ui(
        &mut self,
        module_id: &str,
        caps: ModuleCapabilities,
        decision: PermissionDecision,
    ) -> CoreResult<()> {
        if matches!(decision, PermissionDecision::Deny) {
            return Err(CoreError::Policy("module capability denied by user".into()));
        }
        // AllowOnce and AllowSessionPath both persist for module scope (per-module, not session).
        self.grants.insert(module_id.to_string(), caps);
        Ok(())
    }

    /// Explicit revoke for a module.
    pub fn revoke(&mut self, module_id: &str) {
        self.grants.remove(module_id);
    }

    /// **Rejected path:** never treat the manifest's requested caps as granted.
    ///
    /// Callers must not use this as a grant API — it always returns an error so
    /// unit tests can prove self-grant is impossible.
    pub fn try_self_grant_from_manifest(_manifest: &ModuleManifest) -> CoreResult<()> {
        Err(CoreError::Policy(
            "module cannot self-grant capabilities from its own manifest (UI grant required)"
                .into(),
        ))
    }
}

/// True if the module may run tools (requested caps empty **or** UI grant present).
pub fn module_tools_allowed(manifest: &ModuleManifest, store: &ModuleGrantStore) -> bool {
    let req = &manifest.requested_capabilities;
    let needs_grant = !req.filesystem_roots.is_empty()
        || !req.network_hosts.is_empty()
        || !req.secret_refs.is_empty();
    if !needs_grant {
        return true;
    }
    store.is_granted(&manifest.id)
}

/// Build a first-use `PermissionRequest` for enabling a module's capabilities.
pub fn permission_request_for_module_enable(manifest: &ModuleManifest) -> PermissionRequest {
    let caps = &manifest.requested_capabilities;
    let risk = if !caps.network_hosts.is_empty() {
        "remote"
    } else if !caps.filesystem_roots.is_empty() || !caps.secret_refs.is_empty() {
        "destructive"
    } else {
        "local"
    };
    let preview = format!(
        "Enable module `{}` ({})\n\nfilesystem_roots: {:?}\nnetwork_hosts: {:?}\nsecret_refs: {:?}",
        manifest.id, manifest.version, caps.filesystem_roots, caps.network_hosts, caps.secret_refs
    );
    PermissionRequest::new(
        format!("module_enable:{}", manifest.id),
        ToolSideEffect::HardWrite,
        format!("module:{}", manifest.id),
        format!(
            "Module `{}` requests capabilities before its tools may run",
            manifest.name
        ),
        preview,
        risk,
    )
}

/// Env vars the host may inject for a granted module (values from keychain, not config).
///
/// Keys are sanitized `CD_SECRET_<REF>` style; values are never returned to webview.
pub fn secret_env_for_module(
    granted: &ModuleCapabilities,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for r in &granted.secret_refs {
        if let Some(val) = resolve(r) {
            let key = format!(
                "CD_SECRET_{}",
                r.chars()
                    .map(|c| if c.is_ascii_alphanumeric() {
                        c.to_ascii_uppercase()
                    } else {
                        '_'
                    })
                    .collect::<String>()
            );
            env.insert(key, val);
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Absolute sample path in TOML-escaped form (Windows backslashes doubled).
    fn abs_cmd_toml() -> &'static str {
        if cfg!(windows) {
            r"C:\\Windows\\System32\\cmd.exe"
        } else {
            "/usr/bin/true"
        }
    }

    fn valid_toml(cmd: &str) -> String {
        format!(
            r#"
schema = "cd.module.v1"
id = "demo-mod"
name = "Demo Module"
version = "1.2.3"
hard_write_tools = ["write_record"]
provided_connectors = ["http"]

[entrypoint]
command = "{cmd}"
args = ["--stdio"]

[[provided_tools]]
name = "lookup"
description = "Look up a record"

[[provided_tools]]
name = "write_record"

[requested_capabilities]
filesystem_roots = ["/tmp/demo"]
network_hosts = ["api.example.com"]
secret_refs = ["provider/demo/api_key"]
"#
        )
    }

    #[test]
    fn parse_valid_manifest() {
        let m = parse_module_toml(&valid_toml(abs_cmd_toml())).unwrap();
        assert_eq!(m.schema, MODULE_SCHEMA_V1);
        assert_eq!(m.id, "demo-mod");
        assert_eq!(m.version, "1.2.3");
        assert_eq!(m.entrypoint.args, vec!["--stdio"]);
        assert_eq!(m.provided_tools.len(), 2);
        assert_eq!(
            side_effect_for_module_tool("lookup", &m.hard_write_tools),
            ToolSideEffect::Read
        );
        assert_eq!(
            side_effect_for_module_tool("write_record", &m.hard_write_tools),
            ToolSideEffect::HardWrite
        );
    }

    #[test]
    fn reject_bad_semver() {
        let mut t = valid_toml(abs_cmd_toml());
        t = t.replace("1.2.3", "not-a-version");
        let err = parse_module_toml(&t).unwrap_err().to_string();
        assert!(err.contains("semver"), "{err}");
    }

    #[test]
    fn reject_relative_entrypoint() {
        let err = parse_module_toml(&valid_toml("npx"))
            .unwrap_err()
            .to_string();
        assert!(err.to_lowercase().contains("absolute"), "{err}");
    }

    #[test]
    fn reject_unknown_schema() {
        let mut t = valid_toml(abs_cmd_toml());
        t = t.replace("cd.module.v1", "cd.module.v0");
        let err = parse_module_toml(&t).unwrap_err().to_string();
        assert!(err.contains("schema"), "{err}");
    }

    #[test]
    fn discovery_finds_fixture_and_skips_junk() {
        let dir = tempfile::tempdir().unwrap();
        let mods = dir.path().join("modules");
        let good = mods.join("demo-mod");
        fs::create_dir_all(&good).unwrap();
        let mut f = fs::File::create(good.join("module.toml")).unwrap();
        f.write_all(valid_toml(abs_cmd_toml()).as_bytes()).unwrap();

        // Non-module dir
        fs::create_dir_all(mods.join("notes")).unwrap();
        fs::write(mods.join("notes/readme.txt"), "hi").unwrap();

        // Bad manifest dir (skipped, not fatal)
        let bad = mods.join("broken");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("module.toml"), "schema = \"nope\"\n").unwrap();

        let found = discover_modules(&[mods]).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].id, "demo-mod");
        assert!(found[0].path.ends_with("demo-mod"));
    }

    #[test]
    fn default_modules_dir_under_config() {
        let p = default_modules_dir(Path::new("/home/u/.contextdesk"));
        assert_eq!(p, PathBuf::from("/home/u/.contextdesk/modules"));
    }

    fn sample_manifest_with_caps() -> ModuleManifest {
        let mut m = parse_module_toml(&valid_toml(abs_cmd_toml())).unwrap();
        m.requested_capabilities = ModuleCapabilities {
            filesystem_roots: vec![PathBuf::from("/tmp/demo")],
            network_hosts: vec!["api.example.com".into()],
            secret_refs: vec!["provider/demo/api_key".into()],
        };
        m
    }

    #[test]
    fn manifest_cannot_self_grant() {
        let m = sample_manifest_with_caps();
        let err = ModuleGrantStore::try_self_grant_from_manifest(&m)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("self-grant") || err.contains("UI grant"),
            "{err}"
        );
        let store = ModuleGrantStore::new();
        assert!(!module_tools_allowed(&m, &store));
    }

    #[test]
    fn tools_blocked_until_ui_grant_then_allowed() {
        let m = sample_manifest_with_caps();
        let mut store = ModuleGrantStore::new();
        assert!(!module_tools_allowed(&m, &store));

        // UI path
        let req = permission_request_for_module_enable(&m);
        assert_eq!(req.risk, "remote");
        assert_eq!(req.type_confirm_phrase.as_deref(), Some("WRITE"));
        crate::permissions::validate_decision(&req, PermissionDecision::AllowOnce, Some("WRITE"))
            .unwrap();
        store
            .grant_from_ui(
                &m.id,
                m.requested_capabilities.clone(),
                PermissionDecision::AllowOnce,
            )
            .unwrap();
        assert!(module_tools_allowed(&m, &store));

        store.revoke(&m.id);
        assert!(!module_tools_allowed(&m, &store));
    }

    #[test]
    fn grants_persist_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("module_grants.json");
        let mut store = ModuleGrantStore::new();
        store
            .grant_from_ui(
                "demo-mod",
                ModuleCapabilities {
                    network_hosts: vec!["api.example.com".into()],
                    ..Default::default()
                },
                PermissionDecision::AllowSessionPath,
            )
            .unwrap();
        store.save(&path).unwrap();
        let loaded = ModuleGrantStore::load(&path).unwrap();
        assert!(loaded.is_granted("demo-mod"));
        assert_eq!(
            loaded.granted("demo-mod").network_hosts,
            vec!["api.example.com".to_string()]
        );
    }

    #[test]
    fn secret_env_only_for_granted_refs() {
        let granted = ModuleCapabilities {
            secret_refs: vec!["provider/demo/api_key".into()],
            ..Default::default()
        };
        let env = secret_env_for_module(&granted, &|r| {
            if r == "provider/demo/api_key" {
                Some("sekrit".into())
            } else {
                None
            }
        });
        assert_eq!(
            env.get("CD_SECRET_PROVIDER_DEMO_API_KEY")
                .map(String::as_str),
            Some("sekrit")
        );
    }

    #[test]
    fn no_caps_requested_allows_tools_without_grant() {
        let m = parse_module_toml(&valid_toml(abs_cmd_toml())).unwrap();
        // valid_toml has some requested_capabilities — clear them
        let mut m = m;
        m.requested_capabilities = ModuleCapabilities::default();
        let store = ModuleGrantStore::new();
        assert!(module_tools_allowed(&m, &store));
    }

    #[test]
    fn install_from_local_dir_and_remove() {
        let src = tempfile::tempdir().unwrap();
        let mut f = fs::File::create(src.path().join("module.toml")).unwrap();
        f.write_all(valid_toml(abs_cmd_toml()).as_bytes()).unwrap();
        fs::write(src.path().join("README.md"), "demo").unwrap();

        let mods = tempfile::tempdir().unwrap();
        let m = install_module_from_dir(src.path(), mods.path()).unwrap();
        assert_eq!(m.id, "demo-mod");
        assert!(mods.path().join("demo-mod/module.toml").is_file());
        assert!(mods.path().join("demo-mod/README.md").is_file());

        // Relative entrypoint rejected at parse (already in install)
        remove_module_dir(mods.path(), "demo-mod").unwrap();
        assert!(!mods.path().join("demo-mod").exists());
    }

    /// #138: reference module under `examples/modules/echo-notes` parses as `cd.module.v1`.
    ///
    /// Entrypoint is rewritten to a platform-absolute path so Windows CI accepts the
    /// absolute-path policy; the shipped `module.toml` remains the author-facing sample.
    #[test]
    fn example_echo_notes_module_toml_parses() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/modules/echo-notes/module.toml");
        assert!(
            path.is_file(),
            "missing reference module at {}",
            path.display()
        );
        let raw = fs::read_to_string(&path).expect("read example module.toml");
        assert!(raw.contains("cd.module.v1"), "schema must be cd.module.v1");
        // Normalize entrypoint for platform absolute-path policy.
        let abs = abs_cmd_toml();
        let mut normalized = String::new();
        for line in raw.lines() {
            if line.trim_start().starts_with("command") {
                normalized.push_str(&format!("command = \"{abs}\"\n"));
            } else {
                normalized.push_str(line);
                normalized.push('\n');
            }
        }
        let m = parse_module_toml(&normalized).expect("example module.toml must parse");
        assert_eq!(m.schema, MODULE_SCHEMA_V1);
        assert_eq!(m.id, "echo-notes");
        assert_eq!(m.version, "0.1.0");
        let names: Vec<_> = m.provided_tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"note_read"), "{names:?}");
        assert!(names.contains(&"note_append"), "{names:?}");
        // Authors must not self-grant.
        assert!(ModuleGrantStore::try_self_grant_from_manifest(&m).is_err());
    }
}
