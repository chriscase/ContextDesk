//! Embed a multi-line long version for `contextdesk --version`.
//!
//! Env overrides (CI / release): `CD_GIT_SHA`, `CD_GIT_DESCRIBE`, `CD_CHANNEL`.
//! Mirrors `cd-core` identity so the CLI binary surface stays consistent.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=CD_GIT_SHA");
    println!("cargo:rerun-if-env-changed=CD_GIT_DESCRIBE");
    println!("cargo:rerun-if-env-changed=CD_CHANNEL");
    // See crates/cd-core/build.rs for why both paths are required: `.git/HEAD`
    // alone misses same-branch commits (only `.git/logs/HEAD` and the branch's
    // ref file change), which silently bakes a stale CD_GIT_SHA into an
    // otherwise-fresh incremental build. Resolve through Git because `.git`
    // is a pointer file in the linked worktrees used by acceptance lanes.
    watch_git_path("HEAD", "../../.git/HEAD");
    watch_git_path("logs/HEAD", "../../.git/logs/HEAD");
    watch_current_ref();

    let pkg = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    let sha = std::env::var("CD_GIT_SHA")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| git_output(&["rev-parse", "--short=12", "HEAD"]));
    let describe = std::env::var("CD_GIT_DESCRIBE")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            git_output(&["describe", "--always", "--dirty", "--tags"]).or_else(|| sha.clone())
        });
    let channel = std::env::var("CD_CHANNEL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "dev".into());

    if let Some(s) = &sha {
        println!("cargo:rustc-env=CD_GIT_SHA={s}");
    }
    if let Some(d) = &describe {
        println!("cargo:rustc-env=CD_GIT_DESCRIBE={d}");
    }
    println!("cargo:rustc-env=CD_CHANNEL_EMBED={channel}");

    let sha_s = sha.as_deref().unwrap_or("none");
    let desc_s = describe.as_deref().unwrap_or("none");
    // Single-line long version so clap --version stays parseable by scripts.
    let long = format!("{pkg} git={sha_s} describe={desc_s} channel={channel}");
    println!("cargo:rustc-env=CD_CLI_LONG_VERSION={long}");
}

fn watch_git_path(name: &str, fallback: &str) {
    let path = git_output(&["rev-parse", "--git-path", name]).unwrap_or_else(|| fallback.into());
    println!("cargo:rerun-if-changed={path}");
}

fn watch_current_ref() {
    if let Some(reference) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_output(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
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
