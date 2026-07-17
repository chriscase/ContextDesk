//! Markdown skills discovery and parse.

use crate::error::CoreResult;
use crate::injection::wrap_skill;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// A skill playbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    /// Id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// When to use.
    pub description: String,
    /// Body markdown.
    pub body: String,
    /// Path on disk.
    pub path: PathBuf,
    /// Whether disabled by user.
    #[serde(default)]
    pub disabled: bool,
    /// Skill claims write intent (still gated by host).
    #[serde(default)]
    pub allows_write: bool,
}

/// Parse frontmatter from SKILL.md.
pub fn parse_skill_file(path: &Path) -> CoreResult<Option<Skill>> {
    let text = fs::read_to_string(path)?;
    let (meta, body) = split_frontmatter(&text);
    let id = meta.get("id").cloned().unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("skill")
            .to_string()
    });
    let name = meta.get("name").cloned().unwrap_or_else(|| id.clone());
    let description = meta.get("description").cloned().unwrap_or_default();
    let allows_write = meta
        .get("allows_write")
        .map(|v| v == "true" || v == "yes")
        .unwrap_or(false);
    Ok(Some(Skill {
        id,
        name,
        description,
        body: body.trim().to_string(),
        path: path.to_path_buf(),
        disabled: false,
        allows_write,
    }))
}

fn split_frontmatter(text: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut map = std::collections::HashMap::new();
    let t = text.trim_start();
    if !t.starts_with("---") {
        return (map, text.to_string());
    }
    let rest = &t[3..];
    if let Some(end) = rest.find("\n---") {
        let yaml = &rest[..end];
        for line in yaml.lines() {
            if let Some((k, v)) = line.split_once(':') {
                map.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
            }
        }
        let body = rest[end + 4..].to_string();
        return (map, body);
    }
    (map, text.to_string())
}

/// Discover skills under user and workspace dirs.
pub fn discover_skills(dirs: &[PathBuf]) -> CoreResult<Vec<Skill>> {
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        // dir/SKILL.md or dir/*/SKILL.md or dir/*.md
        let skill_md = dir.join("SKILL.md");
        if skill_md.is_file() {
            if let Some(s) = parse_skill_file(&skill_md)? {
                out.push(s);
            }
        }
        if let Ok(rd) = fs::read_dir(dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.is_dir() {
                    let sm = p.join("SKILL.md");
                    if sm.is_file() {
                        if let Some(s) = parse_skill_file(&sm)? {
                            out.push(s);
                        }
                    }
                } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                    if let Some(s) = parse_skill_file(&p)? {
                        out.push(s);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Catalog summaries for system prompt.
pub fn catalog_summaries(skills: &[Skill]) -> String {
    skills
        .iter()
        .filter(|s| !s.disabled)
        .map(|s| format!("- `{}`: {}", s.id, s.description))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Load skill body wrapped for injection.
pub fn skill_context(skill: &Skill) -> String {
    wrap_skill(&skill.id, &skill.body)
}

/// Write a new skill file (caller must have SoftWrite grant).
pub fn write_skill(dir: &Path, skill: &Skill) -> CoreResult<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.md", skill.id));
    let content = format!(
        "---\nid: {}\nname: {}\ndescription: {}\nallows_write: {}\n---\n\n{}\n",
        skill.id, skill.name, skill.description, skill.allows_write, skill.body
    );
    fs::write(&path, content)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parse_and_discover() {
        let dir = tempdir().unwrap();
        let skills = dir.path().join("skills");
        fs::create_dir_all(&skills).unwrap();
        fs::write(
            skills.join("auth.md"),
            "---\nid: auth-trace\nname: Auth\ndescription: Trace authentication\n---\n\n1. Search auth\n",
        )
        .unwrap();
        let found = discover_skills(&[skills]).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "auth-trace");
        assert!(catalog_summaries(&found).contains("auth-trace"));
    }
}
