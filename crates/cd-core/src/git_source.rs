//! Pure helpers for guided source-run git update (#340).
//!
//! Never hard-resets. Never infers the product checkout from the **active user
//! workspace**. Status/fetch require a **proven** ContextDesk source checkout:
//! product layout **and** a remote whose normalized identity is the canonical
//! upstream (`github.com/chriscase/ContextDesk`). Layout alone is not identity.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Canonical GitHub owner for the product source repository.
pub const CANONICAL_GITHUB_OWNER: &str = "chriscase";
/// Canonical GitHub repository name for the product source.
pub const CANONICAL_GITHUB_REPO: &str = "ContextDesk";

/// Git working tree state for source-run update UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceGitStatus {
    /// True when a validated ContextDesk source checkout was found.
    pub is_git_repo: bool,
    /// Absolute path of the source checkout (when known).
    pub path: Option<String>,
    /// Configured remote name when known (canonical upstream only).
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

    /// Layout matches product tree but no proven canonical upstream remote.
    pub fn unproven_identity(path: Option<&str>, detail: &str) -> Self {
        let mut summary = "Not a proven ContextDesk source checkout".to_string();
        if let Some(p) = path {
            summary.push_str(&format!(" — path `{p}`"));
        }
        if !detail.is_empty() {
            summary.push_str(&format!(" — {detail}"));
        }
        summary.push_str(
            ". Fetch disabled until a remote normalizes to github.com/chriscase/ContextDesk.",
        );
        Self {
            is_git_repo: false,
            path: path.map(|s| s.to_string()),
            remote: None,
            remote_url: None,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            summary,
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

/// True when path looks like a ContextDesk product source tree (layout only).
///
/// Requires: git repo + `crates/cd-core` + `desktop/src-tauri` (product layout).
/// Layout alone is **not** identity — see [`is_proven_contextdesk_source`].
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

/// Normalize a remote URL to `(owner, repo)` when it points at GitHub.
///
/// Supports HTTPS (with optional credentials), SSH `git@github.com:owner/repo`,
/// and `ssh://git@github.com/owner/repo` forms. Trailing `.git` is stripped.
/// Comparison of owner/repo is case-insensitive at the call site.
pub fn normalize_github_repo_identity(url: &str) -> Option<(String, String)> {
    let raw = url.trim();
    if raw.is_empty() {
        return None;
    }
    // Redact only for path parsing safety of credentials — work on a scrubbed form.
    let scrubbed = redact_git_text(raw);
    let path_part = if let Some(rest) = scrubbed.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = scrubbed
        .strip_prefix("ssh://git@github.com/")
        .or_else(|| scrubbed.strip_prefix("ssh://git@github.com:"))
    {
        rest.trim_start_matches('/')
    } else {
        // https://…@github.com/owner/repo or https://github.com/owner/repo
        let lower = scrubbed.to_ascii_lowercase();
        let idx = lower
            .find("github.com/")
            .or_else(|| lower.find("github.com:"))?;
        let after = scrubbed.get(idx + "github.com".len()..)?;
        let after = after.trim_start_matches(['/', ':']);
        after
    };
    let path_part = path_part.split('?').next().unwrap_or(path_part);
    let path_part = path_part.split('#').next().unwrap_or(path_part);
    let path_part = path_part.trim_end_matches('/');
    let mut segs = path_part
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches(".git").to_string())
        .filter(|s| !s.is_empty());
    let owner = segs.next()?;
    let repo = segs.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// True when the URL normalizes to the canonical ContextDesk upstream.
pub fn is_canonical_contextdesk_remote(url: &str) -> bool {
    match normalize_github_repo_identity(url) {
        Some((owner, repo)) => {
            owner.eq_ignore_ascii_case(CANONICAL_GITHUB_OWNER)
                && repo.eq_ignore_ascii_case(CANONICAL_GITHUB_REPO)
        }
        None => false,
    }
}

/// Select the remote whose URL is the canonical upstream. Never first-remote fallback.
///
/// `remotes` is `(name, url)` as reported by git. Returns `(name, url)` of the
/// first match that validates; order is stable but only identity matters.
pub fn select_canonical_remote(remotes: &[(String, String)]) -> Option<(String, String)> {
    remotes
        .iter()
        .find(|(_, url)| is_canonical_contextdesk_remote(url))
        .cloned()
}

/// List remotes as `(name, url)` for a checkout (fixed argv).
pub fn list_remotes(root: &Path) -> Result<Vec<(String, String)>, String> {
    let names = run_git_simple(root, &["remote"])?;
    let mut out = Vec::new();
    for name in names.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match run_git_simple(root, &["remote", "get-url", name]) {
            Ok(url) => out.push((name.to_string(), url.trim().to_string())),
            Err(e) => {
                // Still list the name with empty URL so callers can reason about
                // missing identity without inventing a fallback.
                let _ = e;
                out.push((name.to_string(), String::new()));
            }
        }
    }
    Ok(out)
}

/// Layout + proven canonical remote. Used for fetch enablement.
pub fn is_proven_contextdesk_source(root: &Path) -> bool {
    if !looks_like_contextdesk_source(root) {
        return false;
    }
    match list_remotes(root) {
        Ok(remotes) => select_canonical_remote(&remotes).is_some(),
        Err(_) => false,
    }
}

/// Resolve product source checkout candidates (authoritative locations only).
///
/// **Never** uses the active user workspace root as identity. Order:
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

/// Pick the first path that validates as a **proven** ContextDesk source checkout.
pub fn select_product_source(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| is_proven_contextdesk_source(p))
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
    // Proven identity requires a canonical remote URL when one is supplied.
    if let Some(url) = remote_url {
        if !is_canonical_contextdesk_remote(url) {
            return SourceGitStatus::unproven_identity(
                path,
                "remote URL is not the canonical ContextDesk upstream",
            );
        }
    } else {
        return SourceGitStatus::unproven_identity(path, "no canonical upstream remote");
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
pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);

// Test-only override of the git binary (thread-local so parallel tests stay isolated).
#[cfg(test)]
thread_local! {
    static GIT_BIN_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Run `f` with a fixed git executable (hermetic timeout/fixture tests).
#[cfg(test)]
pub fn with_git_bin_override<R>(path: &Path, f: impl FnOnce() -> R) -> R {
    GIT_BIN_OVERRIDE.with(|c| {
        *c.borrow_mut() = Some(path.to_path_buf());
    });
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            GIT_BIN_OVERRIDE.with(|c| {
                *c.borrow_mut() = None;
            });
        }
    }
    let _guard = Reset;
    f()
}

/// Resolve the git executable (tests may inject via thread-local override).
fn git_program() -> String {
    #[cfg(test)]
    {
        if let Some(p) = GIT_BIN_OVERRIDE.with(|c| c.borrow().clone()) {
            return p.display().to_string();
        }
    }
    // Optional process-wide override for integration harnesses (not used by unit tests).
    std::env::var("CONTEXTDESK_GIT_BIN").unwrap_or_else(|_| "git".into())
}

/// Synchronous git with fixed argv (no shell); redacts stderr; kills on timeout.
pub fn run_git_simple(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_timeout(cwd, args, GIT_TIMEOUT)
}

/// Fixed-argv git with explicit timeout. On timeout/cancel the child (and its
/// process group on Unix) is terminated and reaped before return so repository
/// state cannot keep mutating after the caller observes failure.
pub fn run_git_timeout(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(git_program());
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // New process group so descendants (e.g. shell wrappers in tests) die with us.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("git: {e}"))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "git: missing stdout pipe".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "git: missing stderr pipe".to_string())?;

    let (tx_out, rx_out) = mpsc::channel::<Vec<u8>>();
    let (tx_err, rx_err) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        let _ = tx_out.send(buf);
    });
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        let _ = tx_err.send(buf);
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    terminate_git_child(&mut child);
                    // Reap so we never leave a zombie; drains worker threads via EOF.
                    let _ = child.wait();
                    let _ = rx_out.recv_timeout(Duration::from_millis(200));
                    let _ = rx_err.recv_timeout(Duration::from_millis(200));
                    return Err("git timed out".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("git wait: {e}")),
        }
    };

    let out_bytes = rx_out
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_default();
    let err_bytes = rx_err
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_default();

    if !status.success() {
        let err = String::from_utf8_lossy(&err_bytes);
        return Err(redact_git_text(err.trim()));
    }
    Ok(String::from_utf8_lossy(&out_bytes).to_string())
}

/// Terminate the git child and practical descendants, then leave reaping to caller.
fn terminate_git_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // Negative PID = process group (created via process_group(0)).
        let pgid = child.id() as i32;
        // SIGKILL the whole group so fixture shells + sleeps cannot linger.
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pgid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Inspect a product source root: layout + proven canonical remote required.
pub fn inspect_product_source(root: &Path) -> SourceGitStatus {
    let path_s = root.display().to_string();
    if !looks_like_contextdesk_source(root) {
        return SourceGitStatus::not_repo();
    }
    let remotes = match list_remotes(root) {
        Ok(r) => r,
        Err(e) => {
            return SourceGitStatus::unproven_identity(
                Some(&path_s),
                &format!("could not list remotes: {}", redact_git_text(&e)),
            );
        }
    };
    let Some((remote_name, remote_url)) = select_canonical_remote(&remotes) else {
        let detail = if remotes.is_empty() {
            "no remotes configured".to_string()
        } else {
            let names: Vec<&str> = remotes.iter().map(|(n, _)| n.as_str()).collect();
            format!("no canonical upstream among remotes [{}]", names.join(", "))
        };
        return SourceGitStatus::unproven_identity(Some(&path_s), &detail);
    };
    let branch = run_git_simple(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
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
        Some(&remote_name),
        Some(&remote_url),
        branch.as_deref(),
        ahead,
        behind,
        dirty,
    )
}

/// Fetch **only** the validated canonical upstream remote. Never first-remote
/// fallback. Never `--all --prune`. Never pull/reset/stash/checkout/merge/rebase.
pub fn fetch_product_source(root: &Path, remote: &str) -> Result<(), String> {
    if !looks_like_contextdesk_source(root) {
        return Err("not a proven ContextDesk source checkout".into());
    }
    let remotes = list_remotes(root)?;
    let Some((canonical_name, _)) = select_canonical_remote(&remotes) else {
        return Err(
            "not a proven ContextDesk source checkout — no canonical upstream remote".into(),
        );
    };
    // Caller may pass empty (default) or the canonical name; never accept a
    // different remote (e.g. a fork named origin while upstream is canonical).
    let requested = remote.trim();
    if !requested.is_empty() && requested != canonical_name {
        return Err(format!(
            "fetch refused: remote `{requested}` is not the validated canonical upstream (`{canonical_name}`)"
        ));
    }
    // Fixed argv — no shell. Target only the proven remote name.
    run_git_simple(root, &["fetch", &canonical_name]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::tempdir;

    fn git_init(dir: &Path) {
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
    }

    fn git_commit_all(dir: &Path, msg: &str) {
        Command::new("git")
            .args(["add", "."])
            .current_dir(dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", msg])
            .current_dir(dir)
            .output()
            .unwrap();
    }

    fn write_product_layout(root: &Path) {
        fs::create_dir_all(root.join("crates/cd-core")).unwrap();
        fs::create_dir_all(root.join("desktop/src-tauri")).unwrap();
        fs::write(
            root.join("crates/cd-core/Cargo.toml"),
            "[package]\nname=\"cd-core\"\n",
        )
        .unwrap();
        fs::write(
            root.join("desktop/src-tauri/Cargo.toml"),
            "[package]\nname=\"contextdesk\"\n",
        )
        .unwrap();
    }

    fn add_remote(dir: &Path, name: &str, url: &str) {
        Command::new("git")
            .args(["remote", "add", name, url])
            .current_dir(dir)
            .output()
            .unwrap();
    }

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
    fn normalize_https_and_ssh_canonical() {
        let cases = [
            "https://github.com/chriscase/ContextDesk.git",
            "https://github.com/chriscase/ContextDesk",
            "https://user:TOKEN@github.com/chriscase/ContextDesk.git",
            "git@github.com:chriscase/ContextDesk.git",
            "ssh://git@github.com/chriscase/ContextDesk.git",
            "HTTPS://GitHub.com/ChrisCase/contextdesk",
        ];
        for u in cases {
            assert!(
                is_canonical_contextdesk_remote(u),
                "expected canonical: {u}"
            );
            let (o, r) = normalize_github_repo_identity(u).expect(u);
            assert!(o.eq_ignore_ascii_case("chriscase"), "{u} owner={o}");
            assert!(r.eq_ignore_ascii_case("ContextDesk"), "{u} repo={r}");
        }
    }

    #[test]
    fn normalize_rejects_unrelated() {
        assert!(!is_canonical_contextdesk_remote(
            "https://github.com/other/ContextDesk.git"
        ));
        assert!(!is_canonical_contextdesk_remote(
            "https://github.com/chriscase/OtherRepo.git"
        ));
        assert!(!is_canonical_contextdesk_remote(
            "https://gitlab.com/chriscase/ContextDesk.git"
        ));
        assert!(normalize_github_repo_identity("not-a-url").is_none());
    }

    #[test]
    fn select_canonical_never_first_remote_fallback() {
        let remotes = vec![
            (
                "origin".into(),
                "https://github.com/attacker/ContextDesk.git".into(),
            ),
            (
                "upstream".into(),
                "git@github.com:chriscase/ContextDesk.git".into(),
            ),
        ];
        let (name, url) = select_canonical_remote(&remotes).expect("canonical");
        assert_eq!(name, "upstream");
        assert!(is_canonical_contextdesk_remote(&url));

        let only_fork = vec![(
            "origin".into(),
            "https://github.com/attacker/ContextDesk.git".into(),
        )];
        assert!(select_canonical_remote(&only_fork).is_none());
        assert!(select_canonical_remote(&[]).is_none());
    }

    #[test]
    fn workspace_without_layout_is_not_product_source() {
        let d = tempdir().unwrap();
        git_init(d.path());
        assert!(!looks_like_contextdesk_source(d.path()));
        assert!(!is_proven_contextdesk_source(d.path()));
        let s = inspect_product_source(d.path());
        assert!(!s.fetch_allowed);
        assert!(!s.is_git_repo);
    }

    /// Active customer workspace + genuine ContextDesk source (canonical remote).
    #[test]
    fn workspace_plus_genuine_source_selects_proven_only() {
        let base = tempdir().unwrap();
        let workspace = base.path().join("user-ws");
        let product = base.path().join("ContextDesk");
        fs::create_dir_all(&workspace).unwrap();
        write_product_layout(&product);
        git_init(&workspace);
        git_init(&product);
        fs::write(workspace.join("marker.txt"), "user").unwrap();
        git_commit_all(&workspace, "ws");
        fs::write(product.join("marker.txt"), "product").unwrap();
        git_commit_all(&product, "prod");
        add_remote(
            &product,
            "origin",
            "https://github.com/chriscase/ContextDesk.git",
        );

        let cands = resolve_product_source_candidates(
            Some(&workspace),
            Some(product.to_str().unwrap()),
            None,
        );
        let chosen = select_product_source(&cands).expect("proven product source");
        assert_eq!(chosen, product);
        assert!(!looks_like_contextdesk_source(&workspace));
        let st = inspect_product_source(&chosen);
        assert!(st.is_git_repo && st.fetch_allowed, "{:?}", st.summary);
        assert_eq!(st.remote.as_deref(), Some("origin"));
        assert!(st.path.as_ref().unwrap().contains("ContextDesk"));
        assert!(
            st.summary.contains("path")
                && st.summary.contains("remote")
                && st.summary.contains("url"),
            "status must show path/remote/url before confirm: {}",
            st.summary
        );
        // Fetch on workspace must fail (not proven source).
        assert!(fetch_product_source(&workspace, "origin").is_err());
        let before = fs::read_to_string(workspace.join("marker.txt")).unwrap();
        // Fetch may fail network, but must only target product + origin remote.
        let _ = fetch_product_source(&chosen, "origin");
        let after = fs::read_to_string(workspace.join("marker.txt")).unwrap();
        assert_eq!(before, after);
    }

    /// Layout-shaped counterfeit with unrelated remote: not proven; fetch disabled.
    #[test]
    fn layout_counterfeit_unrelated_remote_disables_fetch() {
        let d = tempdir().unwrap();
        let root = d.path().join("fake-cd");
        write_product_layout(&root);
        git_init(&root);
        fs::write(root.join("x"), "1").unwrap();
        git_commit_all(&root, "init");
        add_remote(
            &root,
            "origin",
            "https://github.com/evilcorp/NotContextDesk.git",
        );
        assert!(looks_like_contextdesk_source(&root));
        assert!(!is_proven_contextdesk_source(&root));
        let st = inspect_product_source(&root);
        assert!(!st.fetch_allowed);
        assert!(!st.is_git_repo);
        assert!(
            st.summary
                .contains("not a proven ContextDesk source checkout")
                || st.summary.to_ascii_lowercase().contains("proven"),
            "{}",
            st.summary
        );
        let err = fetch_product_source(&root, "origin").unwrap_err();
        assert!(
            err.contains("not a proven ContextDesk source checkout"),
            "{err}"
        );
    }

    /// Layout + remotes but none is canonical.
    #[test]
    fn no_canonical_upstream_remote_disables_fetch() {
        let d = tempdir().unwrap();
        write_product_layout(d.path());
        git_init(d.path());
        fs::write(d.path().join("x"), "1").unwrap();
        git_commit_all(d.path(), "init");
        // No remotes at all.
        let st = inspect_product_source(d.path());
        assert!(!st.fetch_allowed);
        assert!(
            st.summary.to_ascii_lowercase().contains("proven"),
            "{}",
            st.summary
        );
        // Unrelated remotes only.
        add_remote(
            d.path(),
            "origin",
            "https://github.com/someone/ContextDesk.git",
        );
        add_remote(d.path(), "fork", "git@github.com:other/fork.git");
        let st2 = inspect_product_source(d.path());
        assert!(!st2.fetch_allowed);
        assert!(select_product_source(&[d.path().to_path_buf()]).is_none());
    }

    /// Fork remote present; fetch must target only validated canonical remote.
    #[test]
    fn fork_plus_canonical_fetch_targets_canonical_only() {
        let d = tempdir().unwrap();
        write_product_layout(d.path());
        git_init(d.path());
        fs::write(d.path().join("x"), "1").unwrap();
        git_commit_all(d.path(), "init");
        add_remote(
            d.path(),
            "origin",
            "https://github.com/myfork/ContextDesk.git",
        );
        add_remote(
            d.path(),
            "upstream",
            "git@github.com:chriscase/ContextDesk.git",
        );
        let st = inspect_product_source(d.path());
        assert!(st.fetch_allowed, "{}", st.summary);
        assert_eq!(st.remote.as_deref(), Some("upstream"));
        // Requesting the fork name must be refused.
        let err = fetch_product_source(d.path(), "origin").unwrap_err();
        assert!(err.contains("not the validated canonical"), "{err}");
        // Empty / default uses canonical name only (network may fail — identity is what we prove).
        let r = fetch_product_source(d.path(), "");
        // Either network error from real fetch attempt against github, or success offline mock —
        // must not have used origin. We assert error does not claim unproven when remote is good.
        if let Err(e) = r {
            assert!(
                !e.contains("not a proven ContextDesk source checkout — no canonical"),
                "{e}"
            );
            assert!(!e.contains("not the validated canonical"));
        }
    }

    #[test]
    fn credential_bearing_url_redacted_in_status_and_errors() {
        let d = tempdir().unwrap();
        write_product_layout(d.path());
        git_init(d.path());
        fs::write(d.path().join("x"), "1").unwrap();
        git_commit_all(d.path(), "init");
        let secret = "super-secret-token-xyz";
        let url = format!("https://user:{secret}@github.com/chriscase/ContextDesk.git");
        add_remote(d.path(), "origin", &url);
        let st = inspect_product_source(d.path());
        assert!(st.fetch_allowed, "{}", st.summary);
        let display = format!("{:?}{}", st.remote_url, st.summary);
        assert!(!display.contains(secret), "leaked secret in {display}");
        assert!(
            st.remote_url
                .as_ref()
                .map(|u| u.contains("***@"))
                .unwrap_or(false),
            "{:?}",
            st.remote_url
        );
        // Error path redaction.
        let err = redact_git_text(&format!(
            "fatal: could not read Password for 'https://user:{secret}@github.com'"
        ));
        assert!(!err.contains(secret));
    }

    #[test]
    fn must_not_hard_reset_always() {
        assert!(must_not_hard_reset(true));
        assert!(must_not_hard_reset(false));
    }

    /// Deterministic timeout kill: fixture Git would mutate after delay; after
    /// `run_git_timeout` returns, mutation must never occur.
    #[test]
    fn git_timeout_kills_child_before_delayed_mutation() {
        let d = tempdir().unwrap();
        git_init(d.path());
        let marker = d.path().join("late_mutation.marker");
        let bin_dir = d.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let fake_git = bin_dir.join("git");
        // Fixture: sleep longer than timeout, then write marker (must never land).
        let script = format!(
            "#!/bin/sh\nsleep 30\necho mutated > '{}'\nexit 0\n",
            marker.display()
        );
        fs::write(&fake_git, script).unwrap();
        let mut perms = fs::metadata(&fake_git).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&fake_git, perms).unwrap();

        // Thread-local override — does not poison parallel tests.
        let started = Instant::now();
        let r = with_git_bin_override(&fake_git, || {
            run_git_timeout(d.path(), &["status"], Duration::from_millis(200))
        });
        let elapsed = started.elapsed();

        assert!(r.is_err(), "expected timeout error, got {r:?}");
        let e = r.unwrap_err();
        assert!(e.contains("timed out"), "expected timed out, got {e}");
        assert!(
            elapsed < Duration::from_secs(5),
            "timeout path took too long: {elapsed:?}"
        );
        // Give a hung child time to write if kill failed.
        thread::sleep(Duration::from_millis(500));
        assert!(
            !marker.exists(),
            "fixture Git mutated after timeout — child was not terminated"
        );
    }
}
