//! Keep the runtime facade small and host-neutral.

use std::collections::BTreeSet;
use std::fs;
use std::process::Command;

const FORBIDDEN: &[&str] = &[
    "cd-core",
    "cd_core",
    "cd-workflow",
    "cd_workflow",
    "cd-triage-bench",
    "cd-triage-bench-adapter",
    "cd-cli",
    "cd-server",
    "tauri",
    "tokio",
    "reqwest",
    "keyring",
    "duckdb",
    "rusqlite",
    "sqlite",
    "dirs",
];

#[test]
fn manifest_has_exactly_the_bounded_runtime_dependencies() {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    for forbidden in FORBIDDEN {
        assert!(
            !manifest.contains(forbidden),
            "cd-triage-runtime Cargo.toml must not depend on {forbidden}"
        );
    }
    let mut in_dependencies = false;
    let mut actual = BTreeSet::new();
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_dependencies = line == "[dependencies]";
            continue;
        }
        if in_dependencies && !line.is_empty() && !line.starts_with('#') {
            let (name, _) = line
                .split_once('=')
                .unwrap_or_else(|| panic!("invalid dependency line: {line}"));
            actual.insert(name.trim());
        }
    }
    let expected = BTreeSet::from([
        "async-trait",
        "cd-triage-sdk",
        "serde_json",
        "sha2",
        "thiserror",
    ]);
    assert_eq!(actual, expected, "direct runtime dependencies drifted");
}

#[test]
fn complete_cargo_tree_excludes_host_and_heavy_dependencies() {
    let output = Command::new("cargo")
        .args([
            "tree",
            "-p",
            "cd-triage-runtime",
            "--edges",
            "normal,build,dev",
            "--target",
            "all",
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
    for forbidden in FORBIDDEN {
        assert!(
            !tree.lines().any(|line| line.contains(forbidden)),
            "cd-triage-runtime tree must not include {forbidden}:\n{tree}"
        );
    }
    for required in [
        "cd-triage-sdk",
        "serde",
        "serde_json",
        "sha2",
        "async-trait",
        "thiserror",
    ] {
        assert!(
            tree.contains(required),
            "tree must include {required}:\n{tree}"
        );
    }
}
