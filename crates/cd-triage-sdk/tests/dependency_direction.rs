//! The contract crate must stay a leaf: no engine, credentials, or network.

use std::fs;
use std::process::Command;

const FORBIDDEN: &[&str] = &[
    "cd-core",
    "cd_core",
    "cd-workflow",
    "cd-cli",
    "cd-server",
    "tauri",
    "keyring",
    "reqwest",
    "tokio",
    "duckdb",
    "rusqlite",
    "notify",
    "dirs",
];

#[test]
fn manifest_has_no_banned_or_heavy_dependencies() {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    for forbidden in FORBIDDEN {
        assert!(
            !manifest.contains(forbidden),
            "cd-triage-sdk Cargo.toml must not depend on {forbidden}"
        );
    }
}

#[test]
fn cargo_tree_closure_is_serde_only() {
    let output = Command::new("cargo")
        .args([
            "tree",
            "-p",
            "cd-triage-sdk",
            "--edges",
            "normal",
            "--prefix",
            "none",
        ])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .output()
        .expect("cargo tree");
    assert!(
        output.status.success(),
        "cargo tree failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    for forbidden in [
        "cd-core",
        "cd-workflow",
        "tauri",
        "keyring",
        "reqwest",
        "tokio",
        "duckdb",
        "libduckdb",
        "rusqlite",
        "libsqlite",
    ] {
        assert!(
            !tree.lines().any(|line| line.contains(forbidden)),
            "cd-triage-sdk tree must not include {forbidden}:\n{tree}"
        );
    }
    assert!(tree.contains("serde"), "expected serde in the leaf tree");
    assert!(
        tree.contains("thiserror"),
        "expected thiserror in the leaf tree"
    );
}
