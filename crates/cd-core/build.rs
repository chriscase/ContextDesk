//! Embed optional git identity at compile time (#338).
//!
//! Env overrides (CI / release): `CD_GIT_SHA`, `CD_GIT_DESCRIBE`, `CD_CHANNEL`.

use std::process::Command;

fn main() {
    // Rebuild when HEAD moves (best-effort; ignored if not a git tree).
    //
    // `.git/HEAD` only changes content when the checked-out ref itself
    // changes (branch switch / detach). A same-branch commit updates
    // `.git/refs/heads/<branch>` and appends to `.git/logs/HEAD`, leaving
    // `.git/HEAD`'s bytes untouched — so watching it alone lets Cargo skip
    // this build script after an ordinary `git commit` on the current
    // branch, silently baking a stale `CD_GIT_SHA`/`CD_GIT_DESCRIBE` into an
    // otherwise-fresh incremental build (#stale-git-identity). `.git/logs/HEAD`
    // (the reflog) is appended on every ref-changing operation — commit,
    // checkout, merge, rebase, reset, pull — so watch it too. Ask Git for
    // both paths instead of assuming `.git` is a directory: in a linked
    // worktree it is a pointer file and the actual HEAD/reflog live under
    // the primary repository's `.git/worktrees/<name>/` directory.
    watch_git_path("HEAD", "../../.git/HEAD");
    watch_git_path("logs/HEAD", "../../.git/logs/HEAD");
    println!("cargo:rerun-if-env-changed=CD_GIT_SHA");
    println!("cargo:rerun-if-env-changed=CD_GIT_DESCRIBE");
    println!("cargo:rerun-if-env-changed=CD_CHANNEL");

    let sha = std::env::var("CD_GIT_SHA").ok().filter(|s| !s.is_empty());
    let describe = std::env::var("CD_GIT_DESCRIBE")
        .ok()
        .filter(|s| !s.is_empty());

    let sha = sha.or_else(|| git_output(&["rev-parse", "--short=12", "HEAD"]));
    let describe = describe.or_else(|| {
        git_output(&["describe", "--always", "--dirty", "--tags"]).or_else(|| sha.clone())
    });

    if let Some(s) = sha {
        println!("cargo:rustc-env=CD_GIT_SHA={s}");
    }
    if let Some(d) = describe {
        println!("cargo:rustc-env=CD_GIT_DESCRIBE={d}");
    }
    // Embed release channel when CI/packaging sets CD_CHANNEL so binaries
    // report the channel without requiring a runtime env override.
    if let Ok(ch) = std::env::var("CD_CHANNEL") {
        if !ch.is_empty() {
            println!("cargo:rustc-env=CD_CHANNEL={ch}");
        }
    }
}

fn watch_git_path(name: &str, fallback: &str) {
    let path = git_output(&["rev-parse", "--git-path", name]).unwrap_or_else(|| fallback.into());
    println!("cargo:rerun-if-changed={path}");
}

fn git_output(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
