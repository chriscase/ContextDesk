//! The adapter's default build must stay dependency-light and engine-free,
//! and it must add no incident-management storage to ContextDesk.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Crates the default adapter and bench trees must never reach: the engine,
/// desktop, embedded databases, credential stores, async runtimes, and every
/// network-capable transport those engines use.
const FORBIDDEN_TREE_ENTRIES: &[&str] = &[
    "cd-core",
    "cd-workflow",
    "cd-cli",
    "cd-server",
    "tauri",
    "duckdb",
    "libduckdb",
    "rusqlite",
    "libsqlite",
    "keyring",
    "secret-service",
    "reqwest",
    "tokio",
    "hyper",
    "h2 ",
    "rustls",
    "native-tls",
    "openssl",
    "ureq",
    "curl",
    "notify",
    "wiremock",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn workspace_root() -> PathBuf {
    manifest_dir().join("../..")
}

fn cargo_tree(package: &str) -> String {
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "-p",
            package,
            "--edges",
            "normal",
            "--prefix",
            "none",
            "--locked",
            "--offline",
        ])
        .current_dir(workspace_root())
        .output()
        .expect("cargo tree");
    assert!(
        output.status.success(),
        "cargo tree -p {package} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_ascii_lowercase()
}

fn assert_tree_is_clean(package: &str) {
    let tree = cargo_tree(package);
    for forbidden in FORBIDDEN_TREE_ENTRIES {
        assert!(
            !tree.lines().any(|line| line.contains(forbidden)),
            "default `{package}` tree must not include `{forbidden}`:\n{tree}"
        );
    }
}

#[test]
fn default_adapter_tree_avoids_engine_database_credential_and_network_crates() {
    assert_tree_is_clean("cd-triage-bench-adapter");
}

#[test]
fn default_bench_tree_avoids_engine_database_credential_and_network_crates() {
    // The adapter is only as clean as the bench it sits on, so guard both.
    assert_tree_is_clean("cd-triage-bench");
}

#[test]
fn default_adapter_tree_contains_exactly_the_three_contextdesk_crates_it_claims() {
    let tree = cargo_tree("cd-triage-bench-adapter");
    let contextdesk: Vec<&str> = tree
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("cd-"))
        .collect();
    assert!(contextdesk
        .iter()
        .any(|line| line.starts_with("cd-triage-sdk ")));
    assert!(contextdesk
        .iter()
        .any(|line| line.starts_with("cd-triage-runtime ")));
    assert!(contextdesk
        .iter()
        .any(|line| line.starts_with("cd-triage-bench ")));
    for line in &contextdesk {
        assert!(
            line.starts_with("cd-triage-sdk ")
                || line.starts_with("cd-triage-runtime ")
                || line.starts_with("cd-triage-bench ")
                || line.starts_with("cd-triage-bench-adapter "),
            "unexpected ContextDesk crate in the default tree: {line}"
        );
    }
    assert!(tree.contains("serde"), "serde is expected in the leaf tree");
}

#[test]
fn engine_crates_are_optional_and_never_in_the_default_feature_set() {
    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).unwrap();
    assert!(
        manifest.contains("default = []"),
        "the default feature set must stay empty"
    );
    for (dependency, feature) in [
        (
            "cd-core = { path = \"../cd-core\", optional = true }",
            "dep:cd-core",
        ),
        (
            "cd-workflow = { path = \"../cd-workflow\", optional = true }",
            "dep:cd-workflow",
        ),
    ] {
        assert!(
            manifest.contains(dependency),
            "`{dependency}` must be declared exactly as an optional dependency"
        );
        assert!(
            manifest.contains("workflow-mock = [\"dep:cd-core\", \"dep:cd-workflow\"]")
                && manifest.contains(feature),
            "`{feature}` must only be reachable through the non-default workflow-mock feature"
        );
    }
    // A live engine feature must not smuggle in an engine dependency.
    assert!(
        manifest.contains("live = []"),
        "the live feature must stay a dependency-free placeholder"
    );
}

/// Source with comment-only lines removed.
///
/// These guards are about what the crate *does*, not what it says about
/// itself: the module docs deliberately name the things the code must never
/// reach ("no `cd-core`", "writes no qualification state", "no
/// `triage_with_policy()` exists"), and those sentences must not trip the
/// scanner they describe.
fn code_only(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn source_files() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let text = fs::read_to_string(&path).expect("read source");
                out.push((path, text));
            }
        }
    }
    let mut out = Vec::new();
    walk(&manifest_dir().join("src"), &mut out);
    assert!(!out.is_empty(), "expected adapter sources");
    out
}

#[test]
fn crate_source_imports_public_contracts_only() {
    for (path, text) in source_files() {
        let code = code_only(&text);
        for forbidden in ["cd_core", "cd_workflow", "cd_cli", "cd_server", "tauri"] {
            assert!(
                !code.contains(forbidden),
                "{} imports `{forbidden}`; the adapter is public-contract only",
                path.display()
            );
        }
    }
}

#[test]
fn crate_source_performs_no_filesystem_network_or_clock_access() {
    for (path, text) in source_files() {
        let code = code_only(&text);
        for forbidden in [
            "std::fs",
            "std::net",
            "std::process",
            "std::env",
            "SystemTime",
            "Instant::now",
        ] {
            assert!(
                !code.contains(forbidden),
                "{} uses `{forbidden}`; the adapter is pure and offline",
                path.display()
            );
        }
    }
}

#[test]
fn adapter_adds_no_case_adjudication_scoring_or_routing_writes() {
    // The bench owns cases, adjudication, and scores. ContextDesk stays a
    // triage engine. This crate must not grow a write path into either.
    for (path, text) in source_files() {
        let code = code_only(&text);
        for forbidden in [
            "put_case(",
            "put_adjudication(",
            "put_score(",
            "put_run(",
            "put_blob(",
            "BenchStore",
            "qualification_store",
            "readiness_store",
            "routing",
            "private_store",
            "compatibility_store",
        ] {
            assert!(
                !code.contains(forbidden),
                "{} references `{forbidden}`; the adapter writes no case, \
                 adjudication, score, qualification, readiness, routing, or \
                 private-store state",
                path.display()
            );
        }
    }
}

#[test]
fn adapter_declares_no_schema_id_and_no_second_validator() {
    // Schema ids and validators live in cd-triage-sdk and cd-triage-bench.
    for (path, text) in source_files() {
        assert!(
            !code_only(&text).contains("contextdesk."),
            "{} declares a literal schema id; reuse the published constants",
            path.display()
        );
    }
    let engine = fs::read_to_string(manifest_dir().join("src/engine.rs")).unwrap();
    assert!(
        engine.contains("replay.validate()"),
        "the engine must hand its stream to the real TriageReplayV1::validate"
    );
}

#[test]
fn runtime_facade_exists_but_default_adapter_calls_no_live_entry_point() {
    // The lightweight facade supplies request identity and replay binding, but
    // this source-neutral adapter still has no live host implementation.
    for (path, text) in source_files() {
        let code = code_only(&text);
        for forbidden in ["triage_with_policy(", "triage("] {
            assert!(
                !code.contains(forbidden),
                "{} calls live runtime entry point `{forbidden}`",
                path.display()
            );
        }
    }
    let runtime = fs::read_to_string(workspace_root().join("crates/cd-triage-runtime/src/lib.rs"))
        .expect("runtime facade source");
    assert!(
        runtime.contains("pub async fn triage_with_policy")
            && runtime.contains("pub async fn triage<"),
        "expected the host-neutral runtime facade to exist"
    );
}
