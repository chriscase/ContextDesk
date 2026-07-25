#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use log_lab_generator::{generate_compact, tree_hashes, verify_safety};
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
        assert!(manifest["expected"]["files_by_path"].is_object());
        assert!(manifest["provenance"]
            .as_str()
            .unwrap()
            .contains("Entirely synthetic"));
    }

    eprintln!(
        "PASS compact files={} events={} bytes={} tree_sha256={}",
        first_summary.files, first_summary.events, first_summary.bytes, first_summary.tree_sha256
    );
}
