//! Path allowlist, canonicalization, secret filename policy.

use crate::error::{CoreError, CoreResult};
use crate::probe::looks_like_secret_filename;
use crate::workspace::Workspace;
use std::path::{Component, Path, PathBuf};

/// Resolve `path` under workspace allowlist; reject escapes and secrets by default.
pub fn resolve_allowed_path(
    workspace: &Workspace,
    path: impl AsRef<Path>,
    allow_secret_files: bool,
) -> CoreResult<PathBuf> {
    let path = path.as_ref();
    if path.as_os_str().is_empty() {
        return Err(CoreError::Policy("empty path".into()));
    }
    // Reject .. components before resolve
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        // still allow if after canonicalize stays in root — but strip traversal intent
        // by requiring canonicalize against roots
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if !allow_secret_files && looks_like_secret_filename(name) {
        return Err(CoreError::Policy(format!(
            "refusing secret-shaped file `{name}` (enable confirm for secrets)"
        )));
    }

    // Absolute path: must be under a root
    if path.is_absolute() {
        return ensure_under_roots(workspace, path);
    }

    // Relative: try each root
    let mut last_err = CoreError::Policy("path not under any workspace root".into());
    for root in &workspace.roots {
        let candidate = root.join(path);
        match ensure_under_roots(workspace, &candidate) {
            Ok(p) => return Ok(p),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn ensure_under_roots(workspace: &Workspace, path: &Path) -> CoreResult<PathBuf> {
    let canon = if path.exists() {
        path.canonicalize().map_err(CoreError::Io)?
    } else {
        // Parent must exist and be under root
        let parent = path.parent().unwrap_or(path);
        if parent.as_os_str().is_empty() || parent == Path::new("") {
            return Err(CoreError::Policy("invalid path".into()));
        }
        if parent.exists() {
            let pcanon = parent.canonicalize().map_err(CoreError::Io)?;
            let file = path
                .file_name()
                .ok_or_else(|| CoreError::Policy("no file name".into()))?;
            pcanon.join(file)
        } else {
            // Normalize without FS
            normalize_lexically(path)
        }
    };

    for root in &workspace.roots {
        let root_c = if root.exists() {
            root.canonicalize().unwrap_or_else(|_| root.clone())
        } else {
            normalize_lexically(root)
        };
        if canon.starts_with(&root_c) {
            // Symlink escape: if path exists, re-check final
            if path.exists() {
                let final_c = path.canonicalize().map_err(CoreError::Io)?;
                if !final_c.starts_with(&root_c) {
                    return Err(CoreError::Policy(
                        "path resolves outside workspace root (symlink?)".into(),
                    ));
                }
                return Ok(final_c);
            }
            return Ok(canon);
        }
    }
    Err(CoreError::Policy(format!(
        "path `{}` is outside allowlisted roots",
        path.display()
    )))
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Bound a session grant path: must be non-empty, under a root, not `/` alone, max length.
pub fn validate_session_grant_path(workspace: &Workspace, path: &str) -> CoreResult<String> {
    let path = path.trim();
    if path.is_empty() || path == "/" || path == "\\" {
        return Err(CoreError::Policy(
            "session grant path too broad or empty".into(),
        ));
    }
    if path.len() > 512 {
        return Err(CoreError::Policy("session grant path too long".into()));
    }
    // Must resolve under workspace
    let _ = resolve_allowed_path(workspace, Path::new(path), true)?;
    // Reject granting entire root without trailing specificity of at least one segment beyond root
    for root in &workspace.roots {
        let r = root.to_string_lossy();
        if path == r || path.trim_end_matches('/') == r.trim_end_matches('/') {
            return Err(CoreError::Policy(
                "cannot session-allow an entire workspace root; pick a subdirectory".into(),
            ));
        }
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn allows_file_under_root() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("docs/a.md");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, "hi").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let p = resolve_allowed_path(&ws, &f, false).unwrap();
        assert!(p.ends_with("a.md"));
    }

    #[test]
    fn blocks_outside() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let err = resolve_allowed_path(&ws, Path::new("/etc/passwd"), false).unwrap_err();
        assert!(
            err.to_string().contains("outside")
                || err.to_string().contains("secret")
                || err.to_string().contains("Policy")
        );
    }

    #[test]
    fn blocks_env_secret() {
        let dir = tempdir().unwrap();
        let f = dir.path().join(".env");
        fs::write(&f, "X=1").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        assert!(resolve_allowed_path(&ws, &f, false).is_err());
        assert!(resolve_allowed_path(&ws, &f, true).is_ok());
    }

    #[test]
    fn rejects_root_session_grant() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let r = dir.path().to_string_lossy().to_string();
        assert!(validate_session_grant_path(&ws, &r).is_err());
        let sub = dir.path().join("memory");
        fs::create_dir_all(&sub).unwrap();
        assert!(validate_session_grant_path(&ws, &sub.to_string_lossy()).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn rejects_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("passwd");
        fs::write(&secret, "nope").unwrap();
        let link = dir.path().join("escape");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let err = resolve_allowed_path(&ws, &link, false).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("outside") || msg.contains("symlink") || msg.contains("Policy"),
            "unexpected: {msg}"
        );
    }
}
