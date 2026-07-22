//! Embed optional git identity at compile time (#338).
//!
//! Env overrides (CI / release): `CD_GIT_SHA`, `CD_GIT_DESCRIBE`, `CD_CHANNEL`.

use std::process::Command;

fn main() {
    // Rebuild when HEAD moves (best-effort; ignored if not a git tree).
    println!("cargo:rerun-if-changed=../../.git/HEAD");
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
