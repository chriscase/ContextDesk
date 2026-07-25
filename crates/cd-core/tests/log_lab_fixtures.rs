#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use log_lab_generator::{
    generate_compact, generate_scale, tree_hashes, verify_safety, LARGE_PROFILE,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/log-lab")
}

fn truth(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            fixture_root()
                .join("scenarios")
                .join(name)
                .join("truth/manifest.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

fn generated_subset_hashes(root: &Path) -> BTreeMap<String, String> {
    let mut hashes = tree_hashes(root).unwrap();
    hashes.remove(".gitignore");
    hashes.remove("README.md");
    hashes
}

#[test]
fn log_lab_compact_generation_is_frozen_deterministic_and_safe() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_root = first.path().join("lab");
    let second_root = second.path().join("lab");
    let first_summary = generate_compact(&first_root).unwrap();
    let second_summary = generate_compact(&second_root).unwrap();

    assert_eq!(first_summary, second_summary);
    assert_eq!(first_summary.profile, "small");
    assert_eq!(first_summary.events, 63);
    assert_eq!(
        generated_subset_hashes(&first_root),
        generated_subset_hashes(&second_root)
    );
    assert_eq!(
        generated_subset_hashes(&first_root),
        generated_subset_hashes(&fixture_root()),
        "checked-in compact fixtures drifted from the deterministic generator"
    );
    verify_safety(&fixture_root()).unwrap();

    for scenario in [
        "checkout-cascade",
        "mixed-time-quality",
        "source-provenance",
        "importer-edge-cases",
        "redaction",
    ] {
        let manifest = truth(scenario);
        assert_eq!(manifest["schema_version"], 1);
        assert_eq!(manifest["scenario_version"], 1);
        assert_eq!(manifest["scenario_id"], scenario);
        assert_eq!(
            manifest["generator_version"],
            "contextdesk.log_lab.generator.v1"
        );
        assert!(manifest["expected"]["files"].as_u64().unwrap() > 0);
        assert!(manifest["expected"]["bytes"].as_u64().unwrap() > 0);
        assert_eq!(
            manifest["expected"]["source_count"],
            manifest["expected"]["files"]
        );
        assert!(manifest["expected"]["sources"].is_object());
        assert!(manifest["expected"]["severities"].is_object());
        assert_eq!(
            manifest["expected"]["severities"]
                .as_object()
                .unwrap()
                .values()
                .map(|count| count.as_u64().unwrap())
                .sum::<u64>(),
            manifest["expected"]["events"].as_u64().unwrap()
        );
        assert!(manifest["expected"]["files_by_path"].is_object());
        assert!(manifest["provenance"]
            .as_str()
            .unwrap()
            .contains("Entirely synthetic"));
    }
    let checkout = truth("checkout-cascade");
    assert!(checkout["investigation"]["causal_timeline"]
        .as_array()
        .is_some_and(|timeline| timeline.len() >= 7));
    assert!(checkout["investigation"]["decoys"]
        .as_array()
        .unwrap()
        .iter()
        .all(|decoy| decoy["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())));
    assert_eq!(
        checkout["investigation"]["rubric"]["exact_prose_required"],
        false
    );

    eprintln!(
        "PASS compact files={} events={} bytes={} tree_sha256={}",
        first_summary.files, first_summary.events, first_summary.bytes, first_summary.tree_sha256
    );
}

#[test]
fn log_lab_safety_scan_rejects_public_hosts_environment_and_current_clock() {
    let unsafe_root = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let environment_marker = ["USER", "LOGNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| value.len() >= 8)
        .unwrap_or_else(|| "environment-marker-unavailable".into());
    fs::write(
        unsafe_root.path().join("unsafe.log"),
        format!(
            "host=production.example.com generated_at={now} environment={environment_marker}\n"
        ),
    )
    .unwrap();

    let diagnostic = verify_safety(unsafe_root.path())
        .expect_err("unsafe fixture content must fail")
        .to_string();
    assert!(diagnostic.contains("bare hostname"), "{diagnostic}");
    assert!(diagnostic.contains("current-clock"), "{diagnostic}");
    if environment_marker != "environment-marker-unavailable" {
        assert!(diagnostic.contains("current environment"), "{diagnostic}");
        assert!(!diagnostic.contains(&environment_marker), "{diagnostic}");
    }
}

#[test]
fn log_lab_configurable_large_profile_is_deterministic_at_test_scale() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_root = first.path().join("large");
    let second_root = second.path().join("large");
    let first_summary = generate_scale(&first_root, LARGE_PROFILE, 1_000).unwrap();
    let second_summary = generate_scale(&second_root, LARGE_PROFILE, 1_000).unwrap();

    assert_eq!(first_summary, second_summary);
    assert_eq!(first_summary.profile, LARGE_PROFILE);
    assert_eq!(first_summary.events, 1_000);
    assert_eq!(
        tree_hashes(&first_root).unwrap(),
        tree_hashes(&second_root).unwrap()
    );
    verify_safety(&first_root).unwrap();
}
