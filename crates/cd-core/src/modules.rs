//! External module manifests (`cd.module.v1`) and filesystem discovery (#134).
//!
//! Substrate: MCP stdio subprocess — see `docs/adr/0001-external-module-substrate.md`.
//! This module **parses and discovers only**; it does not spawn processes (#136).

use crate::connectors::validate_mcp_command;
use crate::error::{CoreError, CoreResult};
use crate::tools::ToolSideEffect;
use serde::{Deserialize, Serialize};
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
        let abs = if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe"
        } else {
            "/usr/bin/true"
        };
        let mut t = valid_toml(abs);
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
        let abs = if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe"
        } else {
            "/usr/bin/true"
        };
        let mut t = valid_toml(abs);
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
        let abs = if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe"
        } else {
            "/usr/bin/true"
        };
        let mut f = fs::File::create(good.join("module.toml")).unwrap();
        f.write_all(valid_toml(abs).as_bytes()).unwrap();

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
}
