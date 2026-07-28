//! Read-only access to the bundled engineering handbook.
//!
//! This index is intentionally separate from `cd_core::help::HelpIndex`: making
//! engineering design material viewable must not make it searchable by the user
//! Help tool or eligible for ordinary/linked chat context.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_PAGE_BYTES: u64 = 1_048_576;
const HANDBOOK_CHAPTERS: &[&str] = &[
    "docs/design/PROVEN_METHODS.md",
    "docs/design/proven-methods/DETERMINISTIC_CONTEXT_ASSEMBLY.md",
    "docs/design/proven-methods/LOG_EVIDENCE_PIPELINE.md",
    "docs/design/proven-methods/INVESTIGATION_LOOP.md",
    "docs/design/proven-methods/METHOD_TEMPLATE.md",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandbookChapter {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandbookManifest {
    pub title: String,
    pub audience: String,
    pub chapters: Vec<HandbookChapter>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandbookPage {
    pub id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum HandbookLink {
    Internal {
        page_id: String,
        anchor: Option<String>,
    },
    External {
        url: String,
    },
}

/// Validated, read-only view over installed Markdown resources.
pub(crate) struct HandbookIndex {
    root: PathBuf,
    manifest: HandbookManifest,
}

impl HandbookIndex {
    pub(crate) fn load(root: impl AsRef<Path>) -> Result<Self, String> {
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|error| format!("handbook root unavailable: {error}"))?;
        if !root.is_dir() {
            return Err("handbook root is not a directory".into());
        }

        let mut chapters = Vec::with_capacity(HANDBOOK_CHAPTERS.len());
        for id in HANDBOOK_CHAPTERS {
            let body = read_page_body(&root, id)?;
            chapters.push(HandbookChapter {
                id: (*id).into(),
                title: markdown_title(&body)
                    .ok_or_else(|| format!("bundled handbook page has no title: {id}"))?,
            });
        }

        Ok(Self {
            root,
            manifest: HandbookManifest {
                title: "Proven methods handbook".into(),
                audience: "Engineering reference for teams adapting or reimplementing ContextDesk’s evidence-heavy AI methods.".into(),
                chapters,
            },
        })
    }

    pub(crate) fn manifest(&self) -> HandbookManifest {
        self.manifest.clone()
    }

    pub(crate) fn page(&self, id: &str) -> Result<HandbookPage, String> {
        let body = read_page_body(&self.root, id)?;
        let title = markdown_title(&body)
            .ok_or_else(|| format!("bundled handbook page has no title: {id}"))?;
        Ok(HandbookPage {
            id: id.into(),
            title,
            body,
        })
    }

    pub(crate) fn resolve_link(
        &self,
        from_page_id: &str,
        target: &str,
    ) -> Result<HandbookLink, String> {
        // Validate the source page before using it as a relative-link base.
        let from_path = safe_page_path(&self.root, from_page_id)?;
        let target = target.trim();
        if target.is_empty() {
            return Err("empty handbook link".into());
        }
        if target.starts_with("https://") || target.starts_with("http://") {
            return Ok(HandbookLink::External { url: target.into() });
        }
        if target.contains("://") || target.starts_with("mailto:") {
            return Err("unsupported handbook link scheme".into());
        }
        if target.contains('?') {
            return Err("handbook links cannot contain a query".into());
        }

        let (relative, anchor) = target
            .split_once('#')
            .map_or((target, None), |(path, fragment)| {
                (path, nonempty(fragment.trim()))
            });
        let page_path = if relative.is_empty() {
            from_path
        } else {
            let parent = from_path
                .parent()
                .ok_or_else(|| "handbook page has no parent".to_string())?;
            parent.join(relative)
        };
        let canonical = page_path
            .canonicalize()
            .map_err(|_| "linked handbook page is unavailable".to_string())?;
        let page_id = safe_page_id(&self.root, &canonical)?;
        // Read once while resolving so directories, oversized files, and invalid
        // Markdown targets fail before the UI mutates navigation state.
        let _ = read_page_body(&self.root, &page_id)?;
        Ok(HandbookLink::Internal {
            page_id,
            anchor: anchor.map(str::to_string),
        })
    }
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn markdown_title(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string)
    })
}

fn read_page_body(root: &Path, id: &str) -> Result<String, String> {
    let path = safe_page_path(root, id)?;
    let metadata = fs::metadata(&path).map_err(|_| "handbook page is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_PAGE_BYTES {
        return Err("handbook page is unavailable".into());
    }
    fs::read_to_string(path).map_err(|_| "handbook page is unavailable".to_string())
}

fn safe_page_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || Path::new(id).is_absolute() || !id.ends_with(".md") {
        return Err("invalid handbook page id".into());
    }
    let id_path = Path::new(id);
    if id_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("invalid handbook page id".into());
    }
    if id != "AGENTS.md" && !id.starts_with("docs/") {
        return Err("handbook page is outside the bundled documentation allowlist".into());
    }
    let path = root.join(id_path);
    let canonical = path
        .canonicalize()
        .map_err(|_| "handbook page is unavailable".to_string())?;
    safe_page_id(root, &canonical)?;
    Ok(canonical)
}

fn safe_page_id(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "handbook path escaped the bundled documentation root".to_string())?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || relative.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("linked handbook target is not Markdown".into());
    }
    let id = relative
        .to_str()
        .ok_or_else(|| "handbook path is not UTF-8".to_string())?
        .replace('\\', "/");
    if id != "AGENTS.md" && !id.starts_with("docs/") {
        return Err("handbook page is outside the bundled documentation allowlist".into());
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checked_in_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn loads_exact_handbook_markdown_and_declared_chapters() {
        let index = HandbookIndex::load(checked_in_root()).expect("handbook");
        let manifest = index.manifest();
        assert_eq!(manifest.chapters.len(), HANDBOOK_CHAPTERS.len());
        assert_eq!(manifest.chapters[0].id, "docs/design/PROVEN_METHODS.md");
        let page = index.page("docs/design/PROVEN_METHODS.md").expect("page");
        assert_eq!(
            page.body,
            include_str!("../../../docs/design/PROVEN_METHODS.md")
        );
    }

    #[test]
    fn resolves_only_bundled_markdown_or_explicit_web_links() {
        let index = HandbookIndex::load(checked_in_root()).expect("handbook");
        assert_eq!(
            index
                .resolve_link(
                    "docs/design/PROVEN_METHODS.md",
                    "proven-methods/LOG_EVIDENCE_PIPELINE.md#status"
                )
                .expect("internal"),
            HandbookLink::Internal {
                page_id: "docs/design/proven-methods/LOG_EVIDENCE_PIPELINE.md".into(),
                anchor: Some("status".into())
            }
        );
        assert_eq!(
            index
                .resolve_link(
                    "docs/design/PROVEN_METHODS.md",
                    "https://github.com/chriscase/ContextDesk/issues/683"
                )
                .expect("external"),
            HandbookLink::External {
                url: "https://github.com/chriscase/ContextDesk/issues/683".into()
            }
        );
        for target in [
            "../../../../../../etc/passwd",
            "../../../Cargo.toml",
            "file:///etc/passwd",
            "mailto:someone@example.com",
        ] {
            assert!(
                index
                    .resolve_link("docs/design/PROVEN_METHODS.md", target)
                    .is_err(),
                "{target}"
            );
        }
    }
}
