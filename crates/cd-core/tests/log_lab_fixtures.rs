#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use chrono::{DateTime, NaiveDateTime};
use log_lab_generator::{
    generate_behavior, generate_compact, generate_scale, load_behavior_manifest, tree_hashes,
    verify_safety, write_performance_template, BehaviorControls, LARGE_PROFILE,
    PAGING_STRESS_PROFILE, SEVEN_DAY_PROFILE, UI_MEDIUM_PROFILE,
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

#[derive(Debug)]
struct BehaviorRow {
    source: String,
    generation_index: usize,
    ts: i64,
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
    assert_eq!(summary.files, 11);
    assert_eq!(summary.bytes, 4_209_626);
    assert_eq!(
        summary.tree_sha256,
        "d5908dbe2b41d925d49066e397d3bfdecaa0168c1340ea6de8d5c79603ddaea1"
    );
    assert_eq!(
        tree_hashes(&generated_root).unwrap(),
        tree_hashes(&pinned_root).unwrap(),
        "checked-in seven-day acceptance corpus drifted from the deterministic generator"
    );

    let manifest = load_behavior_manifest(&pinned_root).unwrap();
    assert_eq!(manifest["scenario_version"], 2);
    assert_eq!(manifest["expected"]["profile"], SEVEN_DAY_PROFILE);
    assert_eq!(manifest["expected"]["events"], 25_000);
    assert_eq!(manifest["expected"]["files"], 10);
    assert_eq!(manifest["expected"]["bytes"], 4_201_238);
    assert_eq!(manifest["expected"]["time_span_secs"], 604_800);
    assert_eq!(manifest["expected"]["severities"]["error"], 119);

    let rows = parse_behavior_rows(&pinned_root);
    assert_eq!(rows.len(), 25_000);
    assert_eq!(rows.first().unwrap().generation_index, 0);
    assert_eq!(rows.last().unwrap().generation_index, 24_999);
    assert_eq!(
        rows.iter().map(|row| row.ts).max().unwrap() - rows.iter().map(|row| row.ts).min().unwrap(),
        604_800
    );

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
