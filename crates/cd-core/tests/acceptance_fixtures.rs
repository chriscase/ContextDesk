//! #819 — one manifest-driven generator for every packaged-acceptance fixture.
//!
//! These artifacts exist because the four states below **cannot be produced
//! through ordinary use**: local re-analysis does not reparse events, so
//! template identity never moves, and activation rejects a duplicate predicate
//! outright. A stale, conflicting, or unbound record is therefore something a
//! corpus or profile *arrives* carrying. No production UI, command, capability,
//! or release backdoor creates them.
//!
//! Regenerate with a single command:
//!
//! ```text
//! cargo test -p cd-core --test acceptance_fixtures -- --ignored --nocapture
//! ```
//!
//! Output goes to `$CD_ACCEPTANCE_FIXTURE_DIR` when set, otherwise
//! `target/acceptance-fixtures/` — both ignored by git. Nothing is committed as
//! a binary archive.

// Shared test-support modules: each including test binary uses a different
// subset, so unused items here are expected rather than dead code.
// `legacy_investigation_fixture` carries its own inner `allow(dead_code)`.
#[path = "support/legacy_investigation_fixture.rs"]
mod legacy_investigation_fixture;
#[allow(dead_code)]
#[path = "support/suppression_fixtures.rs"]
mod suppression_fixtures;

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Manifest schema for the acceptance fixture set.
const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// Refuse to emit an artifact larger than this; fixtures must stay bounded.
const MAX_FIXTURE_BYTES: u64 = 4 * 1024 * 1024;

fn output_dir() -> PathBuf {
    match std::env::var_os("CD_ACCEPTANCE_FIXTURE_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/acceptance-fixtures")
            .to_path_buf(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// One manifest row. Deliberately payload-free: names, expectations, and
/// integrity only — never event text, template text, paths, or tokens.
fn entry(
    name: &str,
    file: &str,
    bytes: &[u8],
    expected_status: &str,
    expected_label: &str,
    expected_rule_count: usize,
    expected_exclusions: usize,
) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "file": file,
        "sha256": sha256_hex(bytes),
        "bytes": bytes.len(),
        "expectedStatus": expected_status,
        "expectedLabel": expected_label,
        "expectedRuleCount": expected_rule_count,
        "expectedExclusions": expected_exclusions,
    })
}

/// Generate every acceptance fixture plus a manifest describing it.
///
/// Ignored by default so ordinary `cargo test` never writes artifacts.
#[test]
#[ignore = "artifact generator; run explicitly with --ignored"]
fn generate_acceptance_fixtures() {
    let out = output_dir();
    std::fs::create_dir_all(&out).expect("create fixture output dir");
    let cache = tempfile::tempdir().expect("scratch cache");

    let mut entries = Vec::new();

    for (name, package, status, label, rules) in [
        (
            "fingerprint-changed",
            suppression_fixtures::fingerprint_changed_package(cache.path(), &out)
                .expect("fingerprint fixture"),
            "stale_fingerprint_changed",
            "Stale — template changed",
            1usize,
        ),
        (
            "target-missing",
            suppression_fixtures::target_missing_package(cache.path(), &out)
                .expect("target-missing fixture"),
            "stale_target_missing",
            "Stale — matches nothing",
            1,
        ),
        (
            "conflicting-predicates",
            suppression_fixtures::conflicting_predicates_package(cache.path(), &out)
                .expect("conflicting fixture"),
            "conflicting_predicate",
            "Conflicts with another rule",
            2,
        ),
    ] {
        let bytes = std::fs::read(&package.path).expect("read package");
        assert!(
            bytes.len() as u64 <= MAX_FIXTURE_BYTES,
            "{name} fixture exceeds the bound"
        );
        assert_eq!(package.rule_names.len(), rules, "{name} rule count");
        entries.push(entry(
            name,
            package
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .expect("file name"),
            &bytes,
            status,
            label,
            rules,
            0,
        ));
    }

    // The legacy fixture is a profile directory, not a corpus package: it is
    // installed into a caller-supplied root and read by the ordinary loader.
    let legacy_profile = out.join("legacy-unbound-profile");
    std::fs::create_dir_all(&legacy_profile).expect("legacy profile dir");
    let legacy_corpus =
        legacy_investigation_fixture::legacy_fixture_corpus(cache.path()).expect("legacy corpus");
    let legacy = legacy_investigation_fixture::install_legacy_unbound_investigation(
        legacy_profile
            .canonicalize()
            .expect("absolute legacy root")
            .as_path(),
        &legacy_corpus,
    )
    .expect("install legacy fixture");
    let legacy_bytes = std::fs::read(&legacy.revision_path).expect("read legacy revision");
    assert!(
        legacy_bytes.len() as u64 <= MAX_FIXTURE_BYTES,
        "legacy fixture exceeds the bound"
    );
    entries.push(serde_json::json!({
        "name": "legacy-unbound-finding",
        "kind": "investigation-profile",
        "file": format!(
            "legacy-unbound-profile/{}/{}",
            legacy.investigation_id,
            legacy_investigation_fixture::revision_filename(legacy.revision),
        ),
        "sha256": sha256_hex(&legacy_bytes),
        "bytes": legacy_bytes.len(),
        "investigationSchemaVersion": 3,
        "expectedStatus": "unbound_legacy",
        "expectedLabel": "Legacy finding · no noise-policy binding",
        "expectedFindingCount": 1,
        "expectedPolicyBinding": "none",
    }));

    let manifest = serde_json::json!({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "purpose": "ContextDesk #819 packaged-acceptance fixtures",
        "note": "Ordinary UI cannot create these historical states; they arrive with imported evidence.",
        "identity": "TEST-FIXTURE",
        "fixtures": entries,
        "cleanup": "Delete the output directory; fixtures are disposable and hold no user data.",
        "regenerate": "cargo test -p cd-core --test acceptance_fixtures -- --ignored --nocapture",
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).expect("serialize manifest");
    let manifest_path = out.join("acceptance-manifest.json");
    std::fs::write(&manifest_path, &manifest_bytes).expect("write manifest");

    println!("acceptance fixtures written to {}", out.display());
    println!("manifest sha256 {}", sha256_hex(&manifest_bytes));
}

/// The manifest is evidence, not a data leak: it may carry names, expected
/// statuses, counts, and digests, and must never carry payloads, template text,
/// representatives, absolute paths, tokens, or secrets.
#[test]
fn acceptance_manifest_is_payload_free() {
    let out = tempfile::tempdir().expect("out");
    let cache = tempfile::tempdir().expect("cache");

    // Build every fixture the generator emits, then scan the real manifest.
    let mut entries = Vec::new();
    for (name, package, status, label, rules) in [
        (
            "fingerprint-changed",
            suppression_fixtures::fingerprint_changed_package(cache.path(), out.path())
                .expect("fingerprint fixture"),
            "stale_fingerprint_changed",
            "Stale — template changed",
            1usize,
        ),
        (
            "target-missing",
            suppression_fixtures::target_missing_package(cache.path(), out.path())
                .expect("target-missing fixture"),
            "stale_target_missing",
            "Stale — matches nothing",
            1,
        ),
        (
            "conflicting-predicates",
            suppression_fixtures::conflicting_predicates_package(cache.path(), out.path())
                .expect("conflicting fixture"),
            "conflicting_predicate",
            "Conflicts with another rule",
            2,
        ),
    ] {
        let bytes = std::fs::read(&package.path).expect("read package");
        entries.push(entry(
            name,
            package
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .expect("file name"),
            &bytes,
            status,
            label,
            rules,
            0,
        ));
    }

    let legacy_corpus =
        legacy_investigation_fixture::legacy_fixture_corpus(cache.path()).expect("legacy corpus");
    let legacy = legacy_investigation_fixture::install_legacy_unbound_investigation(
        out.path().canonicalize().expect("absolute").as_path(),
        &legacy_corpus,
    )
    .expect("legacy fixture");
    let legacy_bytes = std::fs::read(&legacy.revision_path).expect("read legacy");
    entries.push(entry(
        "legacy-unbound-finding",
        &legacy_investigation_fixture::revision_filename(legacy.revision),
        &legacy_bytes,
        "unbound_legacy",
        "Legacy finding · no noise-policy binding",
        1,
        0,
    ));

    let manifest = serde_json::json!({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "identity": "TEST-FIXTURE",
        "fixtures": entries,
    });
    let text = serde_json::to_string(&manifest).expect("serialize");

    for forbidden in [
        "routine health",            // template text
        "different evidence",        // template text
        "routine health ok",         // event payload
        "fixture/app.log",           // source path
        "sha256:fixture-routine",    // template fingerprint
        "sha256:fixture-different",  // template fingerprint
        "sha256:fixture-conflicted", // template fingerprint
        "previewToken",
        "preview_token",
        "representative",
        "/Users/",
        "\\Users\\",
        "/var/folders/", // absolute temp path
    ] {
        assert!(
            !text.contains(forbidden),
            "acceptance manifest leaked {forbidden}"
        );
    }
    // Digests are hex sha256 of the artifact, not of any payload field.
    assert_eq!(entries_len(&manifest), 4, "all four fixtures described");
    assert!(text.contains("\"sha256\""));
    assert!(text.contains("TEST-FIXTURE"));
}

fn entries_len(manifest: &serde_json::Value) -> usize {
    manifest["fixtures"].as_array().map_or(0, Vec::len)
}
