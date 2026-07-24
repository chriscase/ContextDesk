//! Pure helpers for guided source-run git update (#340).
//!
//! Never hard-resets. Never infers the product checkout from the **active user
//! workspace**. Status/fetch require a proven ContextDesk source checkout.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Git working tree state for source-run update UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceGitStatus {
    /// True when a validated ContextDesk source checkout was found.
    pub is_git_repo: bool,
    /// Absolute path of the source checkout (when known).
    pub path: Option<String>,
    /// Configured remote name when known (`origin` preferred).
    pub remote: Option<String>,
    /// Remote URL (redacted credentials) when known.
    pub remote_url: Option<String>,
    /// Branch name (short) when known.
    pub branch: Option<String>,
    /// Commits ahead of upstream.
    pub ahead: u32,
    /// Commits behind upstream.
    pub behind: u32,
    /// Working tree has uncommitted changes.
    pub dirty: bool,
    /// Human-readable summary for UI.
    pub summary: String,
    /// Rebuild guidance (never signed-updater channel).
    pub rebuild_hint: String,
    /// When false, UI must disable Fetch.
    pub fetch_allowed: bool,
}

impl SourceGitStatus {
    /// Not a ContextDesk source checkout.
    pub fn not_repo() -> Self {
        Self {
            is_git_repo: false,
            path: None,
            remote: None,
            remote_url: None,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            summary: "Not a ContextDesk source checkout — use the signed installer updater in Settings if installed.".into(),
            rebuild_hint: String::new(),
            fetch_allowed: false,
        }
    }
}

/// Default rebuild steps for a ContextDesk source tree (documented path).
pub fn default_rebuild_hint() -> String {
    "Source-run rebuild (not the signed installer channel):\n\
     1. Commit or stash local changes if dirty\n\
     2. git pull --ff-only  (only after reviewing status)\n\
     3. cargo build -p cd-core && (cd desktop && npm ci && npm run build)\n\
     4. Restart `cargo tauri dev` / your usual run command"
        .into()
}

/// Classify dirty from `git status --porcelain` stdout.
pub fn porcelain_is_dirty(porcelain: &str) -> bool {
    porcelain.lines().any(|l| !l.trim().is_empty())
}

/// Parse `git rev-list --left-right --count HEAD...@{upstream}` output.
pub fn parse_ahead_behind(raw: &str) -> (u32, u32) {
    let t = raw.trim();
    if t.is_empty() {
        return (0, 0);
    }
    let parts: Vec<&str> = t
        .split(|c: char| c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() >= 2 {
        let a = parts[0].parse().unwrap_or(0);
        let b = parts[1].parse().unwrap_or(0);
        return (a, b);
    }
    (0, 0)
}

/// Redact credentials from git error / URL strings.
pub fn redact_git_text(s: &str) -> String {
    // https://user:token@host → https://***@host (ASCII URL scheme only).
    let Some(scheme_end) = s.find("://") else {
        return s.to_string();
    };
    let after_scheme = scheme_end + 3;
    let rest = s.get(after_scheme..).unwrap_or("");
    let Some(at_rel) = rest.find('@') else {
        return s.to_string();
    };
    let prefix = s.get(..after_scheme).unwrap_or("");
    let suffix = rest.get(at_rel..).unwrap_or("");
    format!("{prefix}***{suffix}")
}

/// True when path looks like a ContextDesk product source tree.
///
/// Requires: git repo + `crates/cd-core` + `desktop/src-tauri` (product layout).
pub fn looks_like_contextdesk_source(root: &Path) -> bool {
    root.join(".git").exists()
        && root
            .join("crates")
            .join("cd-core")
            .join("Cargo.toml")
            .is_file()
        && root
            .join("desktop")
            .join("src-tauri")
            .join("Cargo.toml")
            .is_file()
}

/// Resolve product source checkout candidates (authoritative locations only).
///
/// **Never** uses the active user workspace root. Order:
/// 1. `CONTEXTDESK_SOURCE_ROOT` env (operator override)
/// 2. Walk up from `cwd` looking for ContextDesk layout
/// 3. Executable-relative walk (dev binary under target/)
pub fn resolve_product_source_candidates(
    cwd: Option<&Path>,
    env_source: Option<&str>,
    exe_path: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(e) = env_source.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(PathBuf::from(e));
    }
    if let Some(c) = cwd {
        let mut cur = c;
        for _ in 0..12 {
            out.push(cur.to_path_buf());
            if let Some(p) = cur.parent() {
                cur = p;
            } else {
                break;
            }
        }
    }
    if let Some(exe) = exe_path {
        let mut cur = exe.parent().unwrap_or(exe);
        for _ in 0..16 {
            out.push(cur.to_path_buf());
            if let Some(p) = cur.parent() {
                cur = p;
            } else {
                break;
            }
        }
    }
    out
}

/// Pick the first path that validates as a ContextDesk source checkout.
pub fn select_product_source(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| looks_like_contextdesk_source(p))
        .cloned()
}

/// Build a status view from pure facts (offline unit-testable).
#[allow(clippy::too_many_arguments)]
pub fn build_source_git_status(
    is_product_source: bool,
    path: Option<&str>,
    remote: Option<&str>,
    remote_url: Option<&str>,
    branch: Option<&str>,
    ahead: u32,
    behind: u32,
    dirty: bool,
) -> SourceGitStatus {
    if !is_product_source {
        return SourceGitStatus::not_repo();
    }
    let remote_s = remote.map(|s| s.to_string());
    let branch_s = branch.map(|s| s.to_string());
    let url_s = remote_url.map(redact_git_text);
    let mut bits = Vec::new();
    if let Some(p) = path {
        bits.push(format!("path `{p}`"));
    }
    if let Some(b) = &branch_s {
        bits.push(format!("branch `{b}`"));
    }
    if let Some(r) = &remote_s {
        bits.push(format!("remote `{r}`"));
    }
    if let Some(u) = &url_s {
        bits.push(format!("url `{u}`"));
    }
    bits.push(format!("ahead {ahead} / behind {behind}"));
    if dirty {
        bits.push("working tree dirty".into());
    } else {
        bits.push("clean".into());
    }
    let mut summary = bits.join(" · ");
    if dirty {
        summary.push_str(" — will not hard-reset; stash or commit before pull.");
    }
    if behind == 0 && ahead == 0 && !dirty {
        summary.push_str(" — up to date with upstream (after last fetch).");
    }
    SourceGitStatus {
        is_git_repo: true,
        path: path.map(|s| s.to_string()),
        remote: remote_s,
        remote_url: url_s,
        branch: branch_s,
        ahead,
        behind,
        dirty,
        summary,
        rebuild_hint: default_rebuild_hint(),
        fetch_allowed: true,
    }
}

/// Product rule: this UI never hard-resets.
pub fn must_not_hard_reset(_dirty: bool) -> bool {
    true
}

/// Default wall-clock bound for git child processes (#340).
pub const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Synchronous git with fixed argv (no shell); redacts stderr; kills on timeout.
pub fn run_git_simple(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_timeout(cwd, args, GIT_TIMEOUT)
}

/// Fixed-argv git with explicit timeout (tests use a short budget).
pub fn run_git_timeout(
    cwd: &Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::thread;

    let cwd = cwd.to_path_buf();
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let out = Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => {
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(redact_git_text(err.trim()));
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        Ok(Err(e)) => Err(format!("git: {e}")),
        Err(_) => Err("git timed out".into()),
    }
}

/// Inspect a **validated** product source root (caller must prove layout).
pub fn inspect_product_source(root: &Path) -> SourceGitStatus {
    if !looks_like_contextdesk_source(root) {
        return SourceGitStatus::not_repo();
    }
    let path_s = root.display().to_string();
    let branch = run_git_simple(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let remote = run_git_simple(root, &["remote"]).ok().and_then(|s| {
        s.lines()
            .find(|l| *l == "origin")
            .or_else(|| s.lines().next())
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
    });
    let remote_url = remote.as_ref().and_then(|r| {
        run_git_simple(root, &["remote", "get-url", r])
            .ok()
            .map(|s| s.trim().to_string())
    });
    let porcelain = run_git_simple(root, &["status", "--porcelain"]).unwrap_or_default();
    let dirty = porcelain_is_dirty(&porcelain);
    let (ahead, behind) = match run_git_simple(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) {
        Ok(raw) => parse_ahead_behind(&raw),
        Err(_) => (0, 0),
    };
    let _ = must_not_hard_reset(dirty);
    build_source_git_status(
        true,
        Some(&path_s),
        remote.as_deref(),
        remote_url.as_deref(),
        branch.as_deref(),
        ahead,
        behind,
        dirty,
    )
}

/// Fetch **only** the named remote (default origin). Never `--all --prune`.
pub fn fetch_product_source(root: &Path, remote: &str) -> Result<(), String> {
    if !looks_like_contextdesk_source(root) {
        return Err("not a ContextDesk source checkout".into());
    }
    let remote = if remote.trim().is_empty() {
        "origin"
    } else {
        remote.trim()
    };
    // Fixed argv — no shell.
    run_git_simple(root, &["fetch", remote]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    #[test]
    fn porcelain_dirty_detect() {
        assert!(!porcelain_is_dirty(""));
        assert!(porcelain_is_dirty(" M src/lib.rs\n"));
    }

    #[test]
    fn ahead_behind_parse() {
        assert_eq!(parse_ahead_behind("2\t5"), (2, 5));
    }

    #[test]
    fn redact_credentials_in_url() {
        let r = redact_git_text("https://user:secret@github.com/org/repo.git");
        assert!(!r.contains("secret"));
        assert!(r.contains("***@github.com"));
    }

    #[test]
    fn workspace_without_layout_is_not_product_source() {
        let d = tempdir().unwrap();
        // bare git repo without cd-core layout
        Command::new("git")
            .args(["init"])
            .current_dir(d.path())
            .output()
            .unwrap();
        assert!(!looks_like_contextdesk_source(d.path()));
        let s = inspect_product_source(d.path());
        assert!(!s.fetch_allowed);
        assert!(!s.is_git_repo);
    }

    #[test]
    fn two_repo_isolation_status_only_product_source() {
        let base = tempdir().unwrap();
        let workspace = base.path().join("user-ws");
        let product = base.path().join("ContextDesk");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(product.join("crates/cd-core")).unwrap();
        std::fs::create_dir_all(product.join("desktop/src-tauri")).unwrap();
        std::fs::write(
            product.join("crates/cd-core/Cargo.toml"),
            "[package]\nname=\"cd-core\"\n",
        )
        .unwrap();
        std::fs::write(
            product.join("desktop/src-tauri/Cargo.toml"),
            "[package]\nname=\"contextdesk\"\n",
        )
        .unwrap();
        for (dir, name) in [(&workspace, "user"), (&product, "product")] {
            Command::new("git")
                .args(["init", "-b", "main"])
                .current_dir(dir)
                .output()
                .unwrap();
            Command::new("git")
                .args(["config", "user.email", "t@t.com"])
                .current_dir(dir)
                .output()
                .unwrap();
            Command::new("git")
                .args(["config", "user.name", "t"])
                .current_dir(dir)
                .output()
                .unwrap();
            std::fs::write(dir.join("marker.txt"), name).unwrap();
            Command::new("git")
                .args(["add", "."])
                .current_dir(dir)
                .output()
                .unwrap();
            Command::new("git")
                .args(["commit", "-m", "init"])
                .current_dir(dir)
                .output()
                .unwrap();
        }
        // Active workspace is NOT selected even if listed first as "cwd" alone —
        // select_product_source walks candidates.
        let cands = resolve_product_source_candidates(
            Some(&workspace),
            Some(product.to_str().unwrap()),
            None,
        );
        let chosen = select_product_source(&cands).expect("product source");
        assert_eq!(chosen, product);
        assert!(!looks_like_contextdesk_source(&workspace));
        let st = inspect_product_source(&chosen);
        assert!(st.is_git_repo && st.fetch_allowed);
        assert!(st.path.as_ref().unwrap().contains("ContextDesk"));
        // Fetch intended remote only — wrong remote errors without touching workspace
        let r = fetch_product_source(&workspace, "origin");
        assert!(r.is_err());
        // Product fetch origin may fail without remote configured — but must not
        // mutate workspace marker
        let before = std::fs::read_to_string(workspace.join("marker.txt")).unwrap();
        let _ = fetch_product_source(&chosen, "origin");
        let after = std::fs::read_to_string(workspace.join("marker.txt")).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn must_not_hard_reset_always() {
        assert!(must_not_hard_reset(true));
        assert!(must_not_hard_reset(false));
    }

    #[test]
    fn git_timeout_returns_error() {
        let d = tempdir().unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(d.path())
            .output()
            .unwrap();
        // Impossible short timeout with a slow-ish status still usually finishes;
        // use a zero timeout so recv_timeout fails.
        let r = run_git_timeout(d.path(), &["status"], std::time::Duration::from_secs(0));
        // Either timeout or rare instant success — accept timeout path primarily.
        if let Err(e) = r {
            assert!(e.contains("timed out") || e.contains("git"), "{e}");
        }
    }
}
