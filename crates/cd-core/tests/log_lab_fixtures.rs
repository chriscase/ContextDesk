#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use log_lab_generator::{
    generate_behavior, generate_compact, generate_scale, load_behavior_manifest, tree_hashes,
    verify_safety, write_performance_template, BehaviorControls, LARGE_PROFILE,
    PAGING_STRESS_PROFILE, SEVEN_DAY_PROFILE, UI_MEDIUM_PROFILE,
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

#[test]
fn log_lab_behavior_profiles_are_deterministic_with_rich_manifests() {
    // Reduced event counts keep the default suite offline-fast while exercising
    // the same control surface and sentinel placement as full profiles.
    for (profile, events, min_sources, min_span_secs) in [
        (UI_MEDIUM_PROFILE, 2_000usize, 6usize, 2 * 86_400i64),
        (SEVEN_DAY_PROFILE, 1_500usize, 6usize, 7 * 86_400i64),
        (PAGING_STRESS_PROFILE, 1_200usize, 4usize, 1i64),
    ] {
        let controls = BehaviorControls::for_profile(profile, Some(events)).unwrap();
        // Keep default spans/sources from the profile; only shrink event count.
        assert!(
            controls.source_count >= min_sources,
            "{profile} source_count"
        );
        assert!(
            controls.span_secs >= min_span_secs,
            "{profile} span_secs={} < {min_span_secs}",
            controls.span_secs
        );
        assert!(controls.estimated_bytes() > 0);

        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().join(profile);
        let second_root = second.path().join(profile);
        let first_summary = generate_behavior(&first_root, &controls).unwrap();
        let second_summary = generate_behavior(&second_root, &controls).unwrap();

        assert_eq!(first_summary, second_summary, "{profile}");
        assert_eq!(first_summary.profile, profile);
        assert_eq!(first_summary.events, events);
        assert_eq!(
            tree_hashes(&first_root).unwrap(),
            tree_hashes(&second_root).unwrap(),
            "{profile} trees must be byte-identical across runs"
        );
        verify_safety(&first_root).unwrap();

        let manifest = load_behavior_manifest(&first_root).unwrap();
        assert_eq!(manifest["scenario_id"], "behavior-scale");
        assert_eq!(manifest["scenario_version"], 1);
        assert_eq!(
            manifest["generator_version"],
            "contextdesk.log_lab.generator.v1"
        );
        assert_eq!(manifest["seed"], 52_620_260_725_u64);
        assert_eq!(manifest["expected"]["events"], events as u64);
        assert_eq!(manifest["expected"]["profile"], profile);
        assert_eq!(manifest["expected"]["time_span_secs"], controls.span_secs);
        assert!(manifest["expected"]["traffic_shape"].as_str().is_some());
        assert!(
            manifest["investigation"]["sentinels"]["find_beyond_first_page"]["token"]
                .as_str()
                .unwrap()
                .contains("FIND_RARE")
        );
        assert!(
            manifest["investigation"]["sentinels"]["find_beyond_4k"]["token"]
                .as_str()
                .is_some()
        );
        assert!(
            manifest["investigation"]["sentinels"]["bookmark_evict_window"]["token"]
                .as_str()
                .unwrap()
                .contains("BOOKMARK")
        );
        assert!(manifest["investigation"]["expected_queries"]
            .as_array()
            .is_some_and(|q| q.len() >= 4));
        assert!(manifest["investigation"]["lane_gaps"]
            .as_array()
            .is_some_and(|g| !g.is_empty()));
        assert!(manifest["investigation"]["expected_bookmark_targets"]
            .as_array()
            .is_some_and(|t| t.len() >= 3));

        // Sentinel tokens must appear in the import tree (not only the truth file).
        let import_root = first_root.join("scenarios/behavior-scale/import");
        let mut blob = String::new();
        for entry in walkdir_files(&import_root) {
            blob.push_str(&fs::read_to_string(&entry).unwrap_or_default());
        }
        for token in [
            "FIND_RARE_BEYOND_PAGE",
            "FIND_RARE_BEYOND_4K",
            "FIND_RARE_DEEP",
            "BOOKMARK_PAGE_BOUNDARY",
            "BOOKMARK_EVICT_WINDOW",
            "BOOKMARK_NEAR_END",
        ] {
            assert!(
                blob.contains(token),
                "{profile} import tree missing sentinel {token}"
            );
        }

        let perf = write_performance_template(&first_root, &controls, &first_summary).unwrap();
        assert!(perf.is_file());
        let perf_json: Value = serde_json::from_slice(&fs::read(&perf).unwrap()).unwrap();
        assert_eq!(perf_json["profile"], profile);
        assert!(perf_json["measurements"].is_object());
        assert!(perf_json["policy"].as_str().unwrap().contains("universal"));

        eprintln!(
            "PASS behavior profile={profile} events={} files={} bytes={} tree_sha256={}",
            first_summary.events,
            first_summary.files,
            first_summary.bytes,
            first_summary.tree_sha256
        );
    }
}

#[test]
fn log_lab_behavior_controls_are_independent() {
    // Event count and span are independent: a short dense corpus vs long sparse.
    let dense = BehaviorControls {
        profile: "custom".into(),
        event_count: 500,
        span_secs: 60,
        source_count: 4,
        time_quality: "wall".into(),
        traffic_shape: "paging".into(),
        long_line_percent: 1,
        rotation_every: 0,
    };
    let sparse = BehaviorControls {
        event_count: 500,
        span_secs: 7 * 86_400,
        traffic_shape: "sparse_burst".into(),
        ..dense.clone()
    };
    assert_eq!(dense.event_count, sparse.event_count);
    assert!(sparse.span_secs > dense.span_secs * 100);

    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    // for_profile validates known names; call generate with constructed controls
    // by temporarily using seven-day defaults then overriding via struct.
    let mut c1 = BehaviorControls::for_profile(SEVEN_DAY_PROFILE, Some(400)).unwrap();
    c1.span_secs = 120;
    c1.source_count = 3;
    c1.traffic_shape = "paging".into();
    let mut c2 = c1.clone();
    c2.span_secs = 7 * 86_400;
    c2.traffic_shape = "sparse_burst".into();

    let s1 = generate_behavior(&a.path().join("dense"), &c1).unwrap();
    let s2 = generate_behavior(&b.path().join("sparse"), &c2).unwrap();
    assert_eq!(s1.events, 400);
    assert_eq!(s2.events, 400);
    let m1 = load_behavior_manifest(&a.path().join("dense")).unwrap();
    let m2 = load_behavior_manifest(&b.path().join("sparse")).unwrap();
    assert_eq!(m1["expected"]["time_span_secs"], 120);
    assert_eq!(m2["expected"]["time_span_secs"], 7 * 86_400);
    assert_ne!(
        m1["expected"]["traffic_shape"], m2["expected"]["traffic_shape"],
        "traffic shape must be independently controlled"
    );
    // Different spans produce different timestamp layouts → different hashes.
    assert_ne!(s1.tree_sha256, s2.tree_sha256);

    eprintln!(
        "PASS independent controls dense_span={} sparse_span={} events={}",
        c1.span_secs, c2.span_secs, s1.events
    );
}

fn walkdir_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(root, &mut files);
    files.sort();
    files
}
