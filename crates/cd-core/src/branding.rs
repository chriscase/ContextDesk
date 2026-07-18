//! Product identity — keep display names out of scattered string literals.

use crate::error::{CoreError, CoreResult};
use serde::Deserialize;
use std::path::Path;

/// Fallback if `branding.toml` is missing at runtime.
pub const DEFAULT_PRODUCT_NAME: &str = "ContextDesk";
/// Default filesystem/config slug.
pub const DEFAULT_SLUG: &str = "contextdesk";
/// Default tagline.
pub const DEFAULT_TAGLINE: &str = "Developer knowledge workbench — find, synthesize, remember.";

#[derive(Debug, Clone, Deserialize)]
struct BrandingFile {
    product: ProductSection,
    #[serde(default)]
    paths: PathsSection,
    #[serde(default)]
    themes: ThemesSection,
}

#[derive(Debug, Clone, Deserialize)]
struct ProductSection {
    name: String,
    slug: String,
    #[serde(default)]
    tagline: Option<String>,
    #[serde(default)]
    repository: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PathsSection {
    #[serde(default = "default_config_dir")]
    config_dir_name: String,
    #[serde(default = "default_workspace_dir")]
    workspace_dir_name: String,
}

fn default_config_dir() -> String {
    format!(".{DEFAULT_SLUG}")
}
fn default_workspace_dir() -> String {
    format!(".{DEFAULT_SLUG}")
}

#[derive(Debug, Clone, Deserialize)]
struct ThemesSection {
    #[serde(default = "default_theme")]
    default: String,
    #[serde(default)]
    available: Vec<String>,
}

fn default_theme() -> String {
    "dark".into()
}

impl Default for ThemesSection {
    fn default() -> Self {
        Self {
            default: default_theme(),
            available: vec!["dark".into(), "light".into()],
        }
    }
}

/// Resolved branding used by hosts and UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branding {
    /// Display name.
    pub name: String,
    /// Config/data directory slug.
    pub slug: String,
    /// Short product description.
    pub tagline: String,
    /// Public repository URL if known.
    pub repository: Option<String>,
    /// User config directory name (e.g. `.contextdesk`).
    pub config_dir_name: String,
    /// Per-workspace directory name.
    pub workspace_dir_name: String,
    /// Default theme id.
    pub default_theme: String,
    /// Theme ids available in the build.
    pub available_themes: Vec<String>,
}

impl Default for Branding {
    fn default() -> Self {
        Self {
            name: DEFAULT_PRODUCT_NAME.into(),
            slug: DEFAULT_SLUG.into(),
            tagline: DEFAULT_TAGLINE.into(),
            repository: Some("https://github.com/chriscase/ContextDesk".into()),
            config_dir_name: format!(".{DEFAULT_SLUG}"),
            workspace_dir_name: format!(".{DEFAULT_SLUG}"),
            default_theme: "dark".into(),
            available_themes: vec!["dark".into(), "light".into()],
        }
    }
}

impl Branding {
    /// Product identity baked from the committed repo-root `branding.toml` (#179).
    ///
    /// Edit `branding.toml` + rebuild to rename. On parse error, logs a warning
    /// and returns [`Branding::default`] (never panics).
    pub fn embedded() -> Self {
        const RAW: &str = include_str!("../../../branding.toml");
        match Self::parse_toml(RAW) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "branding.toml embed parse failed; using defaults");
                Self::default()
            }
        }
    }

    /// Load branding from a TOML file path.
    pub fn load_from_path(path: impl AsRef<Path>) -> CoreResult<Self> {
        let raw = std::fs::read_to_string(path.as_ref())?;
        Self::parse_toml(&raw)
    }

    /// Parse branding TOML from a string.
    pub fn parse_toml(raw: &str) -> CoreResult<Self> {
        let file: BrandingFile =
            toml::from_str(raw).map_err(|e| CoreError::Config(format!("branding.toml: {e}")))?;
        if file.product.name.trim().is_empty() || file.product.slug.trim().is_empty() {
            return Err(CoreError::Config(
                "product.name and product.slug must be non-empty".into(),
            ));
        }
        let themes = file.themes;
        Ok(Self {
            name: file.product.name,
            slug: file.product.slug,
            tagline: file
                .product
                .tagline
                .unwrap_or_else(|| DEFAULT_TAGLINE.into()),
            repository: file.product.repository,
            config_dir_name: file.paths.config_dir_name,
            workspace_dir_name: file.paths.workspace_dir_name,
            default_theme: themes.default,
            available_themes: if themes.available.is_empty() {
                vec!["dark".into(), "light".into()]
            } else {
                themes.available
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_branding_is_contextdesk() {
        let b = Branding::default();
        assert_eq!(b.name, "ContextDesk");
        assert_eq!(b.slug, "contextdesk");
        assert_eq!(b.default_theme, "dark");
    }

    #[test]
    fn parse_repo_branding_toml() {
        let raw = include_str!("../../../branding.toml");
        let b = Branding::parse_toml(raw).expect("branding.toml");
        assert_eq!(b.name, "ContextDesk");
        assert!(b.available_themes.contains(&"light".to_string()));
    }

    #[test]
    fn embedded_matches_repo_toml() {
        let b = Branding::embedded();
        assert_eq!(b.name, "ContextDesk");
        assert_eq!(b.workspace_dir_name, ".contextdesk");
        assert_eq!(b.config_dir_name, ".contextdesk");
    }

    /// #179: non-default workspace_dir_name drives memory/skills path helpers.
    #[test]
    fn custom_workspace_dir_name_in_paths() {
        let b = Branding {
            workspace_dir_name: ".acme".into(),
            ..Branding::default()
        };
        let root = std::path::Path::new("/tmp/ws");
        let mem = crate::memory_fs::memory_dir_named(
            &crate::workspace::Workspace::new("t", vec![root.to_path_buf()]),
            &b.workspace_dir_name,
        )
        .unwrap();
        let skills = crate::skills::workspace_skills_dir_named(root, &b.workspace_dir_name);
        assert_eq!(mem, std::path::PathBuf::from("/tmp/ws/.acme/memory"));
        assert_eq!(skills, std::path::PathBuf::from("/tmp/ws/.acme/skills"));
        assert!(!mem.to_string_lossy().contains(".contextdesk"));
    }
}
