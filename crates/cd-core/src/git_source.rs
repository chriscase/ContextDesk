//! Pure helpers for guided source-run git update (#340).
//!
//! Never hard-resets. Parse porcelain / rev-list style output offline.

use serde::{Deserialize, Serialize};

/// Git working tree state for source-run update UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceGitStatus {
    /// True when `.git` was found under the given root.
    pub is_git_repo: bool,
    /// Configured remote name when known (`origin` default).
    pub remote: Option<String>,
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
}

impl SourceGitStatus {
    /// Not a git checkout.
    pub fn not_repo() -> Self {
        Self {
            is_git_repo: false,
            remote: None,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            summary:
                "Not a git checkout — use the signed installer updater in Settings if installed."
                    .into(),
            rebuild_hint: String::new(),
        }
    }
}

/// Default rebuild steps for a ContextDesk source tree (documented path).
pub fn default_rebuild_hint() -> String {
    "Source-run rebuild (not the signed installer channel):\n\
     1. Commit or stash local changes if dirty\n\
     2. git pull --ff-only\n\
     3. cargo build -p cd-core && (cd desktop && npm ci && npm run build)\n\
     4. Restart `cargo tauri dev` / your usual run command"
        .into()
}

/// Classify dirty from `git status --porcelain` stdout.
pub fn porcelain_is_dirty(porcelain: &str) -> bool {
    porcelain.lines().any(|l| !l.trim().is_empty())
}

/// Parse `git rev-list --left-right --count HEAD...@{upstream}` output (`ahead\tbehind` or `ahead behind`).
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

/// Build a status view from pure facts (offline unit-testable).
pub fn build_source_git_status(
    is_git_repo: bool,
    remote: Option<&str>,
    branch: Option<&str>,
    ahead: u32,
    behind: u32,
    dirty: bool,
) -> SourceGitStatus {
    if !is_git_repo {
        return SourceGitStatus::not_repo();
    }
    let remote_s = remote.map(|s| s.to_string());
    let branch_s = branch.map(|s| s.to_string());
    let mut bits = Vec::new();
    if let Some(b) = &branch_s {
        bits.push(format!("branch `{b}`"));
    }
    if let Some(r) = &remote_s {
        bits.push(format!("remote `{r}`"));
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
        remote: remote_s,
        branch: branch_s,
        ahead,
        behind,
        dirty,
        summary,
        rebuild_hint: default_rebuild_hint(),
    }
}

/// True when an update action must refuse hard-reset (always true for dirty).
pub fn must_not_hard_reset(dirty: bool) -> bool {
    // Product rule: never hard-reset dirty trees; also never hard-reset clean ones
    // from this UI — only ff-only pull after user action.
    let _ = dirty;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_dirty_detect() {
        assert!(!porcelain_is_dirty(""));
        assert!(!porcelain_is_dirty("\n\n"));
        assert!(porcelain_is_dirty(" M src/lib.rs\n"));
        assert!(porcelain_is_dirty("?? foo\n"));
    }

    #[test]
    fn ahead_behind_parse() {
        assert_eq!(parse_ahead_behind("2\t5"), (2, 5));
        assert_eq!(parse_ahead_behind("0 3"), (0, 3));
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn dirty_never_hard_reset() {
        assert!(must_not_hard_reset(true));
        assert!(must_not_hard_reset(false));
        let s = build_source_git_status(true, Some("origin"), Some("main"), 0, 2, true);
        assert!(s.dirty);
        assert!(s.summary.contains("not hard-reset") || s.summary.contains("dirty"));
        assert!(
            s.rebuild_hint.contains("signed installer") || s.rebuild_hint.contains("Source-run")
        );
        assert!(s.rebuild_hint.contains("git pull"));
    }

    #[test]
    fn not_repo_summary() {
        let s = build_source_git_status(false, None, None, 0, 0, false);
        assert!(!s.is_git_repo);
        assert!(s.summary.contains("Not a git"));
    }
}
