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
}
