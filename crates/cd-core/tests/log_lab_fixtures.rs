#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use chrono::{DateTime, NaiveDateTime};
use log_lab_generator::{
    generate_behavior, generate_compact, generate_scale, generate_triage_stress,
    load_behavior_manifest, load_triage_stress_manifest, tree_hashes,
    triage_stress_estimated_bytes, verify_safety, write_performance_template, BehaviorControls,
    DEFAULT_TRIAGE_STRESS_EVENT_COUNT, LARGE_PROFILE, MIN_TRIAGE_STRESS_EVENT_COUNT,
    PAGING_STRESS_PROFILE, SEVEN_DAY_PROFILE, TRIAGE_STRESS_INCIDENT_REPETITIONS,
    TRIAGE_STRESS_INCIDENT_TEMPLATE_FAMILIES, TRIAGE_STRESS_PARSER_TEMPLATE_COUNT,
    TRIAGE_STRESS_PROFILE, TRIAGE_STRESS_ROUTINE_TEMPLATE_FAMILIES, TRIAGE_STRESS_SOURCE_COUNT,
    TRIAGE_STRESS_TEMPLATE_FAMILIES, UI_MEDIUM_PROFILE,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Expected shared wall-clock instant for company-timestamp-diversity encodings
/// (2025-01-01T13:20:00Z). Must match generator COMPANY_TS_SHARED_INSTANT_SECS.
const COMPANY_TS_SHARED_INSTANT_SECS: i64 = 1_735_737_600;

fn parse_rfc3339_to_unix_secs(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text)
        .unwrap_or_else(|err| panic!("invalid RFC3339 `{text}`: {err}"))
        .timestamp()
}

fn parse_timestamp_token_to_unix_secs(token: &str) -> Option<i64> {
    if let Ok(number) = token.parse::<i64>() {
        // Heuristic used by the fixtures: values past year ~2001 in ms are epoch ms.
        if number.abs() >= 1_000_000_000_000 {
            return Some(number / 1_000);
        }
        return Some(number);
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(token) {
        return Some(dt.timestamp());
    }
    // Offset-less local face: interpret as UTC for fixture comparison only.
    if let Ok(naive) = NaiveDateTime::parse_from_str(token, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.and_utc().timestamp());
    }
    None
}

fn event_id_from_line(line: &str) -> Option<String> {
    // Prefer JSON message field when present; otherwise scan the whole line so
    // logfmt `msg="event_id=..."` still resolves.
    let haystack = if let Ok(value) = serde_json::from_str::<Value>(line) {
        value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(line)
            .to_owned()
    } else {
        line.to_owned()
    };
    let marker = "event_id=";
    let start = haystack.find(marker)? + marker.len();
    let end = haystack[start..]
        .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | ',' | ';' | '}'))
        .map(|offset| start + offset)
        .unwrap_or(haystack.len());
    let id = haystack[start..end].trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_owned())
    }
}

fn company_timestamp_import_instants() -> BTreeMap<String, i64> {
    let import_root = fixture_root().join("scenarios/company-timestamp-diversity/import");
    let mut instants = BTreeMap::new();
    for path in walkdir_files(&import_root) {
        let text = fs::read_to_string(&path).unwrap();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let Some(event_id) = event_id_from_line(line) else {
                continue;
            };

            let instant = if let Ok(value) = serde_json::from_str::<Value>(line) {
                match &value["ts"] {
                    Value::Number(number) => {
                        let n = number
                            .as_i64()
                            .or_else(|| number.as_u64().map(|v| v as i64))
                            .expect("numeric ts");
                        if n.abs() >= 1_000_000_000_000 {
                            n / 1_000
                        } else {
                            n
                        }
                    }
                    Value::String(text) => match parse_timestamp_token_to_unix_secs(text) {
                        Some(value) => value,
                        None => continue, // malformed / unusable
                    },
                    Value::Null => continue, // missing timestamp field
                    other => panic!("unsupported JSON ts for {event_id}: {other}"),
                }
            } else if let Some(ts) = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("ts="))
            {
                match parse_timestamp_token_to_unix_secs(ts.trim_matches('"')) {
                    Some(value) => value,
                    None => continue,
                }
            } else if line.starts_with('<') && line.contains(" - - - ") {
                // RFC5424 with explicit offset: <pri>VERSION TIMESTAMP HOST APP ...
                let fields: Vec<&str> = line.split_whitespace().collect();
                assert!(
                    fields.len() >= 3,
                    "RFC5424 line too short for {event_id}: {line}"
                );
                parse_rfc3339_to_unix_secs(fields[1])
            } else {
                // Yearless classic syslog and other incomplete forms have no unique UTC.
                continue;
            };
            instants.insert(event_id, instant);
        }
    }
    instants
}

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
    hashes.retain(|path, _| !path.starts_with("acceptance/"));
    hashes
}

fn pinned_seven_day_root() -> PathBuf {
    fixture_root().join("acceptance/seven-day-25k")
}

const SEVEN_DAY_METRIC_JSON: [&str; 5] = [
    "scenarios/behavior-scale/metrics/manifest.v1.json",
    "scenarios/behavior-scale/metrics/operational-metrics-patterns.v1.json",
    "scenarios/behavior-scale/metrics/operational-metrics.v1.json",
    "scenarios/behavior-scale/truth/metric-correlations.v1.json",
    "scenarios/behavior-scale/truth/metric-patterns.v1.json",
];

fn generated_seven_day_byte_hashes(root: &Path) -> BTreeMap<String, String> {
    let mut hashes = tree_hashes(root).unwrap();
    for path in SEVEN_DAY_METRIC_JSON {
        hashes.remove(path);
    }
    hashes
}

#[derive(Debug)]
struct BehaviorRow {
    source: String,
    generation_index: usize,
    ts: i64,
    level: String,
}

fn parse_behavior_rows(root: &Path) -> Vec<BehaviorRow> {
    let import_root = root.join("scenarios/behavior-scale/import");
    let mut rows = Vec::new();
    for path in walkdir_files(&import_root) {
        let source = path
            .strip_prefix(&import_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for line in fs::read_to_string(path).unwrap().lines() {
            let json = serde_json::from_str::<Value>(line).ok();
            let ts = json
                .as_ref()
                .and_then(|value| value["ts"].as_i64())
                .or_else(|| {
                    line.split_whitespace()
                        .find_map(|token| token.strip_prefix("ts=")?.parse().ok())
                })
                .unwrap_or_else(|| panic!("wall-time behavior row lacked ts: {line}"));
            let level = json
                .as_ref()
                .and_then(|value| value["level"].as_str())
                .map(str::to_owned)
                .or_else(|| {
                    line.split_whitespace()
                        .find_map(|token| token.strip_prefix("level=").map(str::to_owned))
                })
                .unwrap_or_else(|| panic!("behavior row lacked level: {line}"));
            let event_marker = "event_id=behavior-";
            let marker_start = line
                .find(event_marker)
                .unwrap_or_else(|| panic!("behavior row lacked event id: {line}"))
                + event_marker.len();
            let marker_end = line[marker_start..]
                .find(|ch: char| !ch.is_ascii_digit())
                .map(|offset| marker_start + offset)
                .unwrap_or(line.len());
            let generation_index = line[marker_start..marker_end].parse().unwrap();
            rows.push(BehaviorRow {
                source: source.clone(),
                generation_index,
                ts,
                level,
            });
        }
    }
    rows.sort_by_key(|row| row.generation_index);
    rows
}

fn linear_behavior_ts(index: usize, event_count: usize, span_secs: i64) -> i64 {
    let denominator = event_count.saturating_sub(1).max(1) as i128;
    1_735_732_800 + ((span_secs as i128 * index as i128) / denominator) as i64
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
    assert_eq!(first_summary.events, 100);
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
        "company-timestamp-diversity",
        "company-known-noise",
        "company-original-fidelity",
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

    let company_ts = truth("company-timestamp-diversity");
    assert_eq!(company_ts["expected"]["events"], 15);
    assert_eq!(company_ts["expected"]["files"], 5);
    assert_eq!(company_ts["expected"]["time_quality"], "mixed");
    let shared = company_ts["investigation"]["shared_instant"]["event_ids"]
        .as_array()
        .unwrap();
    assert_eq!(shared.len(), 8);
    assert!(shared.iter().any(|id| id == "ts-rfc3339-utc"));
    assert!(shared.iter().any(|id| id == "ts-epoch-ms"));
    assert!(shared.iter().any(|id| id == "ts-rfc5424"));
    assert_eq!(
        company_ts["investigation"]["shared_instant"]["epoch_seconds"],
        COMPANY_TS_SHARED_INSTANT_SECS
    );
    assert_eq!(
        company_ts["investigation"]["shared_instant"]["epoch_milliseconds"],
        COMPANY_TS_SHARED_INSTANT_SECS * 1_000
    );
    assert_eq!(
        company_ts["investigation"]["shared_instant"]["rfc3339_utc"],
        "2025-01-01T13:20:00Z"
    );
    // Honest proof: parse each shared_instant import encoding to one UTC instant.
    let import_instants = company_timestamp_import_instants();
    for event_id in shared {
        let id = event_id.as_str().unwrap();
        let instant = import_instants
            .get(id)
            .unwrap_or_else(|| panic!("shared_instant event_id missing from import: {id}"));
        assert_eq!(
            *instant, COMPANY_TS_SHARED_INSTANT_SECS,
            "shared_instant {id} resolved to {instant}, expected {COMPANY_TS_SHARED_INSTANT_SECS}"
        );
    }
    // Control: similar-local-only and skew must NOT collapse to the shared instant.
    assert_ne!(
        *import_instants.get("ts-similar-local-only").unwrap(),
        COMPANY_TS_SHARED_INSTANT_SECS
    );
    assert_eq!(
        *import_instants.get("ts-skew-behind").unwrap(),
        COMPANY_TS_SHARED_INSTANT_SECS - 180
    );
    assert_eq!(
        *import_instants.get("ts-late").unwrap(),
        COMPANY_TS_SHARED_INSTANT_SECS + 30
    );
    assert_eq!(
        company_ts["investigation"]["known_skew"]["skew_seconds"],
        -180
    );
    assert_eq!(
        company_ts["investigation"]["late_arrival"]["event_id"],
        "ts-late"
    );
    assert!(company_ts["investigation"]["unusable_timestamps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["event_id"] == "ts-malformed"));
    assert!(company_ts["investigation"]["product_gap_note"]
        .as_str()
        .unwrap()
        .contains("#670"));

    let company_noise = truth("company-known-noise");
    assert_eq!(company_noise["expected"]["events"], 14);
    assert_eq!(company_noise["expected"]["files"], 3);
    assert_eq!(company_noise["investigation"]["safe_candidate_total"], 9);
    let safe = company_noise["investigation"]["safe_suppression_candidates"]
        .as_array()
        .unwrap();
    let safe_sum: u64 = safe
        .iter()
        .map(|row| row["expected_count"].as_u64().unwrap())
        .sum();
    assert_eq!(safe_sum, 9);
    for row in safe {
        assert_eq!(
            row["event_ids"].as_array().unwrap().len() as u64,
            row["expected_count"].as_u64().unwrap()
        );
    }
    let must_remain = company_noise["investigation"]["must_remain_visible"]
        .as_array()
        .unwrap();
    assert!(must_remain
        .iter()
        .any(|row| row["event_id"] == "noise-important-reset"));
    assert!(must_remain
        .iter()
        .any(|row| row["event_id"] == "noise-incident-error"));
    let unsafe_preds = company_noise["investigation"]["unsafe_broad_predicates"]
        .as_array()
        .unwrap();
    assert!(unsafe_preds
        .iter()
        .any(|row| { row["predicate"] == "level=error" && row["would_hide_count"] == 6 }));
    assert!(company_noise["investigation"]["product_gap_note"]
        .as_str()
        .unwrap()
        .contains("#671"));

    let company_fid = truth("company-original-fidelity");
    assert_eq!(company_fid["expected"]["events"], 8);
    assert_eq!(company_fid["expected"]["files"], 6);
    let raw = company_fid["investigation"]["raw_values_for_test_only"]
        .as_array()
        .unwrap();
    assert!(raw.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|text| text.contains("LOG-LAB-INVALID"))
    }));
    assert!(
        company_fid["investigation"]["original_redacted_must_preserve"]
            .as_array()
            .unwrap()
            .len()
            >= 6
    );
    assert!(
        company_fid["investigation"]["original_redacted_must_redact"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );
    assert!(company_fid["investigation"]["product_gap_note"]
        .as_str()
        .unwrap()
        .contains("#673"));

    // Import roots must never ship truth manifests (chat-context isolation).
    for scenario in [
        "company-timestamp-diversity",
        "company-known-noise",
        "company-original-fidelity",
    ] {
        let import_root = fixture_root()
            .join("scenarios")
            .join(scenario)
            .join("import");
        assert!(import_root.is_dir());
        for path in walkdir_files(&import_root) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            assert_ne!(name, "manifest.json");
            let text = fs::read_to_string(&path).unwrap_or_default();
            assert!(
                !text.contains("product_gap_note"),
                "truth-only fields leaked into import for {scenario}"
            );
        }
    }

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
fn log_lab_triage_stress_is_deterministic_safe_and_truthful() {
    let events = MIN_TRIAGE_STRESS_EVENT_COUNT;
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_root = first.path().join("triage-stress");
    let second_root = second.path().join("triage-stress");
    let first_summary = generate_triage_stress(&first_root, events).unwrap();
    let second_summary = generate_triage_stress(&second_root, events).unwrap();

    assert_eq!(first_summary, second_summary);
    assert_eq!(first_summary.profile, TRIAGE_STRESS_PROFILE);
    assert_eq!(first_summary.events, events);
    assert_eq!(first_summary.files, TRIAGE_STRESS_SOURCE_COUNT + 1);
    assert_eq!(
        tree_hashes(&first_root).unwrap(),
        tree_hashes(&second_root).unwrap()
    );
    verify_safety(&first_root).unwrap();

    let manifest = load_triage_stress_manifest(&first_root).unwrap();
    assert_eq!(manifest["profile"], TRIAGE_STRESS_PROFILE);
    assert_eq!(manifest["local_only"], true);
    assert_eq!(manifest["expected"]["events"], events as u64);
    assert_eq!(
        manifest["expected"]["source_count"],
        TRIAGE_STRESS_SOURCE_COUNT as u64
    );
    assert_eq!(
        manifest["expected"]["generator_template_families"],
        TRIAGE_STRESS_TEMPLATE_FAMILIES as u64
    );
    assert_eq!(
        manifest["expected"]["routine_template_families"],
        TRIAGE_STRESS_ROUTINE_TEMPLATE_FAMILIES as u64
    );
    assert_eq!(
        manifest["expected"]["incident_template_families"],
        TRIAGE_STRESS_INCIDENT_TEMPLATE_FAMILIES as u64
    );
    assert_eq!(
        manifest["expected"]["incident_family_repetitions"],
        TRIAGE_STRESS_INCIDENT_REPETITIONS as u64
    );
    assert_eq!(
        manifest["expected"]["parser_templates_after_import"],
        TRIAGE_STRESS_PARSER_TEMPLATE_COUNT as u64
    );
    assert_eq!(manifest["expected"]["time_quality"], "wall");
    assert_eq!(manifest["expected"]["severities"]["error"], 1_800);
    assert_eq!(manifest["expected"]["severities"]["warn"], 1_500);
    assert_eq!(manifest["expected"]["severities"]["debug"], 300);
    assert_eq!(manifest["expected"]["severities"]["info"], 6_400);
    assert_eq!(
        manifest["expected"]["severities"]
            .as_object()
            .unwrap()
            .values()
            .map(|value| value.as_u64().unwrap())
            .sum::<u64>(),
        events as u64
    );
    assert_eq!(
        manifest["expected"]["sources"]
            .as_object()
            .unwrap()
            .values()
            .map(|value| value.as_u64().unwrap())
            .sum::<u64>(),
        events as u64
    );
    assert_eq!(
        manifest["expected"]["template_family_counts"]
            .as_object()
            .unwrap()
            .len(),
        TRIAGE_STRESS_TEMPLATE_FAMILIES
    );
    assert!(manifest["expected"]["template_family_counts_sha256"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64));
    let incidents = manifest["investigation"]["incidents"].as_array().unwrap();
    assert_eq!(incidents.len(), 3);
    for incident in incidents {
        assert!(incident["to_ts"].as_i64().unwrap() >= incident["from_ts"].as_i64().unwrap());
        assert_eq!(incident["roles"].as_array().unwrap().len(), 7);
        assert!(incident["roles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|role| role["expected_count"] == TRIAGE_STRESS_INCIDENT_REPETITIONS as u64));
    }
    let noise = manifest["investigation"]["safe_exact_noise_candidates"]
        .as_array()
        .unwrap();
    assert_eq!(noise.len(), 6);
    assert!(noise.iter().all(|candidate| {
        candidate["expected_count"].as_u64().unwrap() > 0
            && candidate["scope"]
                .as_str()
                .is_some_and(|scope| scope.contains("exact generated template"))
    }));
    assert!(manifest["investigation"]["denoising_contract"]
        .as_str()
        .unwrap()
        .contains("reversible"));
    assert!(manifest["investigation"]["evaluator_isolation"]
        .as_str()
        .unwrap()
        .contains("Import only"));

    let import_root = first_root.join("scenarios/triage-stress/import");
    let paths = walkdir_files(&import_root);
    assert_eq!(paths.len(), TRIAGE_STRESS_SOURCE_COUNT);
    assert!(paths.iter().all(|path| {
        !path
            .components()
            .any(|component| component.as_os_str() == "truth")
            && path.file_name().and_then(|name| name.to_str()) != Some("manifest.json")
    }));
    let runtime_text = paths
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for evaluator_label in [
        "incident_id=",
        "role=",
        "TRIAGE_SIGNAL",
        "trace-pool-exhaustion",
        "trace-key-rollout",
        "trace-cache-stampede",
    ] {
        assert!(
            !runtime_text.contains(evaluator_label),
            "runtime import leaked evaluator label `{evaluator_label}`"
        );
    }
    assert!(runtime_text.contains("CDLAB2004 database pool exhausted"));
    assert!(runtime_text.contains("trace-fixture-a17"));
    assert!(triage_stress_estimated_bytes(DEFAULT_TRIAGE_STRESS_EVENT_COUNT) > 80 * 1024 * 1024);

    eprintln!(
        "PASS triage-stress-test events={} sources={} template_families={} bytes={} tree_sha256={}",
        events,
        TRIAGE_STRESS_SOURCE_COUNT,
        TRIAGE_STRESS_TEMPLATE_FAMILIES,
        first_summary.bytes,
        first_summary.tree_sha256
    );
}

#[test]
fn log_lab_triage_stress_rejects_undersized_and_nonempty_targets() {
    let undersized = tempfile::tempdir().unwrap();
    let diagnostic = generate_triage_stress(
        &undersized.path().join("triage"),
        MIN_TRIAGE_STRESS_EVENT_COUNT - 1,
    )
    .unwrap_err()
    .to_string();
    assert!(diagnostic.contains("requires at least"), "{diagnostic}");

    let nonempty = tempfile::tempdir().unwrap();
    fs::write(nonempty.path().join("keep.txt"), "user-owned").unwrap();
    let diagnostic = generate_triage_stress(nonempty.path(), MIN_TRIAGE_STRESS_EVENT_COUNT)
        .unwrap_err()
        .to_string();
    assert!(diagnostic.contains("absent or empty"), "{diagnostic}");
    assert_eq!(
        fs::read_to_string(nonempty.path().join("keep.txt")).unwrap(),
        "user-owned"
    );
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
        assert_eq!(manifest["scenario_version"], 2);
        assert_eq!(
            manifest["generator_version"],
            "contextdesk.log_lab.generator.v1"
        );
        assert_eq!(manifest["seed"], 52_620_260_725_u64);
        assert_eq!(manifest["expected"]["events"], events as u64);
        assert_eq!(manifest["expected"]["profile"], profile);
        assert_eq!(
            manifest["expected"]["requested_time_span_secs"],
            controls.span_secs
        );
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

        // Parse actual generated rows: truth metadata must describe emitted
        // timestamps and file identities, not merely contain plausible fields.
        let import_root = first_root.join("scenarios/behavior-scale/import");
        let rows = parse_behavior_rows(&first_root);
        assert_eq!(rows.len(), events);
        assert_eq!(
            rows.iter()
                .map(|row| row.generation_index)
                .collect::<BTreeSet<_>>()
                .len(),
            events,
            "{profile} generation indices must be unique"
        );
        let actual_from = rows.iter().map(|row| row.ts).min().unwrap();
        let actual_to = rows.iter().map(|row| row.ts).max().unwrap();
        assert_eq!(actual_to - actual_from, controls.span_secs, "{profile}");
        assert_eq!(
            manifest["expected"]["time_span_secs"],
            actual_to - actual_from
        );
        assert_eq!(
            manifest["investigation"]["time_span"]["from_ts"],
            actual_from
        );
        assert_eq!(manifest["investigation"]["time_span"]["to_ts"], actual_to);

        let actual_source_counts =
            rows.iter()
                .fold(BTreeMap::<String, u64>::new(), |mut counts, row| {
                    *counts.entry(row.source.clone()).or_default() += 1;
                    counts
                });
        let manifest_source_counts = manifest["expected"]["sources"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(source, count)| (source.clone(), count.as_u64().unwrap()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            manifest_source_counts, actual_source_counts,
            "{profile} per-file source counts"
        );

        let burst = &manifest["investigation"]["burst_windows"][0];
        let burst_start = burst["from_generation_index"].as_u64().unwrap() as usize;
        let burst_end = burst["to_generation_index"].as_u64().unwrap() as usize;
        let burst_ts = burst["ts"].as_i64().unwrap();
        let burst_rows = rows
            .iter()
            .filter(|row| row.generation_index >= burst_start && row.generation_index <= burst_end)
            .collect::<Vec<_>>();
        assert_eq!(
            burst_rows.len() as u64,
            burst["event_count"].as_u64().unwrap()
        );
        assert!(
            burst_rows.len() >= 32,
            "{profile} burst must be meaningfully dense"
        );
        assert!(
            burst_rows.iter().all(|row| row.ts == burst_ts),
            "{profile} declared burst rows did not share one second"
        );

        let gap = &manifest["investigation"]["lane_gaps"][0];
        let gap_from = gap["from_ts"].as_i64().unwrap();
        let gap_to = gap["to_ts"].as_i64().unwrap();
        let gap_duration = gap["duration_secs"].as_i64().unwrap();
        let gap_sources = gap["affected_sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| source.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert!(
            gap_duration >= controls.span_secs / 10,
            "{profile} source gap was only {gap_duration}s"
        );
        assert!(
            rows.iter().all(|row| {
                !gap_sources.contains(row.source.as_str()) || row.ts <= gap_from || row.ts >= gap_to
            }),
            "{profile} emitted an affected-source event inside its declared gap"
        );

        let skew = &manifest["investigation"]["misaligned_intervals"][0];
        assert_eq!(skew["offset_secs"], -90);
        let skew_sources = skew["affected_sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| source.as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert!(
            !skew_sources.is_empty(),
            "{profile} skew affected no sources"
        );
        let skew_start = skew["from_generation_index"].as_u64().unwrap() as usize;
        let skew_end = skew["to_generation_index"].as_u64().unwrap() as usize;
        let verified_skew_rows = rows
            .iter()
            .filter(|row| {
                row.generation_index >= skew_start
                    && row.generation_index <= skew_end
                    && skew_sources.contains(row.source.as_str())
                    && row.ts
                        == linear_behavior_ts(row.generation_index, events, controls.span_secs) - 90
            })
            .count();
        assert!(
            verified_skew_rows > 0,
            "{profile} did not emit the declared 90-second source skew"
        );

        let late = &manifest["investigation"]["late_arrivals"];
        let lead_index = late["lead_generation_index"].as_u64().unwrap() as usize;
        let event_index = late["event_generation_index"].as_u64().unwrap() as usize;
        assert_eq!(rows[lead_index].generation_index, lead_index);
        assert_eq!(rows[event_index].generation_index, event_index);
        assert_eq!(
            rows[lead_index].ts - rows[event_index].ts,
            90,
            "{profile} late-arrival pair"
        );
        assert!(late["count"].as_u64().unwrap() > 0);

        // Sentinel tokens must appear in the import tree (not only the truth file).
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
fn pinned_seven_day_acceptance_corpus_matches_generator_and_truth() {
    let pinned_root = pinned_seven_day_root();
    verify_safety(&pinned_root).unwrap();

    let controls = BehaviorControls::for_profile(SEVEN_DAY_PROFILE, None).unwrap();
    let generated = tempfile::tempdir().unwrap();
    let generated_root = generated.path().join("seven-day-25k");
    let summary = generate_behavior(&generated_root, &controls).unwrap();

    assert_eq!(summary.events, 25_000);
    assert_eq!(summary.files, 16);
    assert_eq!(summary.bytes, 4_384_032);
    assert_eq!(
        summary.tree_sha256,
        "948551a0ffcc32ce27cb0916027e36babb9b2282519c509c7c23592dbd3665c3"
    );
    assert_eq!(
        generated_seven_day_byte_hashes(&generated_root),
        generated_seven_day_byte_hashes(&pinned_root),
        "checked-in seven-day logs or primary truth drifted from the deterministic generator"
    );
    for path in SEVEN_DAY_METRIC_JSON {
        let generated_json: Value =
            serde_json::from_slice(&fs::read(generated_root.join(path)).unwrap()).unwrap();
        let pinned_json: Value =
            serde_json::from_slice(&fs::read(pinned_root.join(path)).unwrap()).unwrap();
        assert_eq!(
            generated_json, pinned_json,
            "checked-in seven-day metric fixture drifted semantically: {path}"
        );
    }

    let manifest = load_behavior_manifest(&pinned_root).unwrap();
    assert_eq!(manifest["scenario_version"], 2);
    assert_eq!(manifest["expected"]["profile"], SEVEN_DAY_PROFILE);
    assert_eq!(manifest["expected"]["events"], 25_000);
    assert_eq!(manifest["expected"]["files"], 10);
    assert_eq!(manifest["expected"]["bytes"], 4_201_281);
    assert_eq!(manifest["expected"]["time_span_secs"], 604_800);
    assert_eq!(manifest["expected"]["severities"]["error"], 164);
    let canonical_readme =
        fs::read_to_string(fixture_root().join("README.md")).expect("canonical Log Lab README");
    let readme_without_commas = canonical_readme.replace(',', "");
    assert!(
        readme_without_commas.contains(&format!(
            "| Import source bytes | {} |",
            manifest["expected"]["bytes"].as_u64().unwrap()
        )),
        "canonical README byte count drifted from the pinned manifest"
    );
    assert!(
        readme_without_commas.contains(&format!(
            "| Levels | {} INFO · {} DEBUG · {} WARN · {} ERROR |",
            manifest["expected"]["severities"]["info"].as_u64().unwrap(),
            manifest["expected"]["severities"]["debug"]
                .as_u64()
                .unwrap(),
            manifest["expected"]["severities"]["warn"].as_u64().unwrap(),
            manifest["expected"]["severities"]["error"]
                .as_u64()
                .unwrap(),
        )),
        "canonical README severity counts drifted from the pinned manifest"
    );
    assert!(
        canonical_readme.contains(&format!(
            "| Generated tree SHA-256 | `{}` |",
            summary.tree_sha256
        )),
        "canonical README tree identity drifted from deterministic generation"
    );
    assert!(
        canonical_readme.contains(&format!(
            "| Filter level ERROR | Reports {} matching events |",
            manifest["expected"]["severities"]["error"]
                .as_u64()
                .unwrap()
        )),
        "canonical README ERROR-filter proof drifted from the pinned manifest"
    );

    let rows = parse_behavior_rows(&pinned_root);
    assert_eq!(rows.len(), 25_000);
    assert_eq!(rows.first().unwrap().generation_index, 0);
    assert_eq!(rows.last().unwrap().generation_index, 24_999);
    assert_eq!(
        rows.iter().map(|row| row.ts).max().unwrap() - rows.iter().map(|row| row.ts).min().unwrap(),
        604_800
    );

    let metrics: Value = serde_json::from_slice(
        &fs::read(pinned_root.join("scenarios/behavior-scale/metrics/operational-metrics.v1.json"))
            .unwrap(),
    )
    .unwrap();
    let metric_series = metrics["series"].as_array().unwrap();
    assert_eq!(
        metric_series
            .iter()
            .map(|series| series["unit"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["%", "bytes", "clients"]
    );
    let corpus_from = rows.iter().map(|row| row.ts).min().unwrap();
    let corpus_to = rows.iter().map(|row| row.ts).max().unwrap();
    for series in metric_series {
        let points = series["points"].as_array().unwrap();
        assert_eq!(points.first().unwrap()["timestamp"], corpus_from);
        assert_eq!(points.last().unwrap()["timestamp"], corpus_to);
    }
    let series = |id: &str| {
        metric_series
            .iter()
            .find(|series| series["id"] == id)
            .unwrap()
    };
    assert_eq!(
        series("cpu-percent")["points"].as_array().unwrap().len(),
        673
    );
    assert_eq!(
        series("heap-used-bytes")["points"]
            .as_array()
            .unwrap()
            .len(),
        668
    );
    assert_eq!(
        series("concurrent-clients")["points"]
            .as_array()
            .unwrap()
            .len(),
        673
    );
    assert_eq!(
        metric_series
            .iter()
            .map(|series| series["gaps"].as_array().map_or(0, Vec::len))
            .sum::<usize>(),
        1,
        "the primary load-test fixture has one explicit collector gap"
    );
    let client_points = series("concurrent-clients")["points"].as_array().unwrap();
    assert_eq!(client_points[384]["value"], 120);
    assert_eq!(
        client_points[400]["value"], 180,
        "the staged workload must reach its deterministic overload plateau"
    );
    assert_eq!(client_points[408]["value"], 180);
    assert_eq!(client_points[420]["value"], 65);
    let cpu_points = series("cpu-percent")["points"].as_array().unwrap();
    assert!(
        cpu_points[400]["value"].as_i64().unwrap() > cpu_points[392]["value"].as_i64().unwrap(),
        "CPU must follow the staged client ramp with its declared sample lag"
    );
    assert!(
        series("heap-used-bytes")["points"]
            .as_array()
            .unwrap()
            .windows(2)
            .any(|pair| {
                pair[0]["value"].as_i64().unwrap() - pair[1]["value"].as_i64().unwrap()
                    > 250_000_000
            }),
        "heap series must include a visible major-GC recovery"
    );

    let elevated_rate = |from: i64, to: i64| {
        let in_window = rows
            .iter()
            .filter(|row| (from..to).contains(&row.ts))
            .collect::<Vec<_>>();
        let elevated = in_window
            .iter()
            .filter(|row| matches!(row.level.as_str(), "warn" | "error"))
            .count();
        (elevated, in_window.len())
    };
    let (before_elevated, before_total) =
        elevated_rate(corpus_from + 90 * 3_600, corpus_from + 97 * 3_600);
    let (overload_elevated, overload_total) =
        elevated_rate(corpus_from + 97 * 3_600, corpus_from + 104 * 3_600);
    let (recovery_elevated, recovery_total) =
        elevated_rate(corpus_from + 104 * 3_600, corpus_from + 111 * 3_600);
    assert!(
        overload_elevated * before_total > before_elevated * overload_total * 4,
        "warning/error prevalence must rise materially near overload"
    );
    assert!(
        overload_elevated * recovery_total > recovery_elevated * overload_total * 4,
        "warning/error prevalence must recover after the load drop"
    );
    eprintln!(
        "PASS seven-day metrics samples=673/668/673 span_secs=604800 overload_elevated={overload_elevated}/{overload_total} before={before_elevated}/{before_total} recovery={recovery_elevated}/{recovery_total}"
    );
    let stack_incident = rows
        .iter()
        .find(|row| row.generation_index == 14_763)
        .unwrap();
    assert_eq!(stack_incident.source, "api/app.jsonl");
    assert_eq!(stack_incident.level, "error");

    let import_root = pinned_root.join("scenarios/behavior-scale/import");
    let mut import_blob = String::new();
    for path in walkdir_files(&import_root) {
        import_blob.push_str(&fs::read_to_string(path).unwrap());
    }
    for token in [
        "FIND_RARE_BEYOND_PAGE",
        "FIND_RARE_BEYOND_4K",
        "FIND_RARE_DEEP",
        "BOOKMARK_PAGE_BOUNDARY",
        "BOOKMARK_EVICT_WINDOW",
        "BOOKMARK_NEAR_END",
        "STACK_TRACE_SENTINEL",
        "UTF8_café_λ",
    ] {
        assert!(
            import_blob.contains(token),
            "pinned seven-day import tree missing {token}"
        );
    }

    eprintln!(
        "PASS pinned seven-day events={} files={} bytes={} tree_sha256={}",
        summary.events, summary.files, summary.bytes, summary.tree_sha256
    );
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
