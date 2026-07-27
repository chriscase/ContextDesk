//! Behavior-rich Log Lab scale profiles (#542).
//!
//! Extends the compact/scale generator without mutating historical scenario
//! versions. Independent controls: event count, time span, source count,
//! traffic shape, bursts/quiet, rotation, long/multiline frequency, rare match
//! placement, paging/eviction sentinels, lane interval alignment, time quality.

use super::{
    ensure_empty_generation_target, hashes_for_paths, json_line, logfmt, summarize_generation,
    verify_safety, write_json, LabResult, FIXED_SEED, GENERATOR_VERSION, TRUTH_SCHEMA_VERSION,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

/// Practical UI investigation profile: 100k events, 8 sources, multi-day span.
pub const UI_MEDIUM_PROFILE: &str = "ui-medium";
/// Seven-day sparse/burst investigation profile (event count independent of span).
pub const SEVEN_DAY_PROFILE: &str = "seven-day";
/// Paging/eviction stress profile with dense boundary sentinels.
pub const PAGING_STRESS_PROFILE: &str = "paging-stress";

pub const UI_MEDIUM_EVENT_COUNT: usize = 100_000;
pub const SEVEN_DAY_DEFAULT_EVENTS: usize = 25_000;
pub const PAGING_STRESS_DEFAULT_EVENTS: usize = 12_000;

/// Scenario id written under `scenarios/<id>/` for behavior profiles.
pub const BEHAVIOR_SCENARIO_ID: &str = "behavior-scale";
pub const BEHAVIOR_SCENARIO_VERSION: u32 = 1;

const BASE_TS: i64 = 1_735_732_800; // 2025-01-01T00:00:00Z fixed lab epoch
const DAY_SECS: i64 = 86_400;

/// Independent generation controls for behavior-rich profiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BehaviorControls {
    pub profile: String,
    pub event_count: usize,
    /// Wall-clock span of the corpus in seconds (independent of event count).
    pub span_secs: i64,
    pub source_count: usize,
    /// `wall` | `mixed` | `order_only`
    pub time_quality: String,
    /// `steady` | `sparse_burst` | `paging`
    pub traffic_shape: String,
    /// Approximate fraction of events that are long/multiline (0–100).
    pub long_line_percent: u8,
    /// How often rotated sibling files appear (0 = none).
    pub rotation_every: usize,
}

impl BehaviorControls {
    pub fn for_profile(profile: &str, event_count: Option<usize>) -> LabResult<Self> {
        match profile {
            UI_MEDIUM_PROFILE => Ok(Self {
                profile: UI_MEDIUM_PROFILE.into(),
                event_count: event_count.unwrap_or(UI_MEDIUM_EVENT_COUNT),
                span_secs: 3 * DAY_SECS, // three days
                source_count: 8,
                time_quality: "wall".into(),
                traffic_shape: "sparse_burst".into(),
                long_line_percent: 3,
                rotation_every: 20_000,
            }),
            SEVEN_DAY_PROFILE => Ok(Self {
                profile: SEVEN_DAY_PROFILE.into(),
                event_count: event_count.unwrap_or(SEVEN_DAY_DEFAULT_EVENTS),
                span_secs: 7 * DAY_SECS,
                source_count: 8,
                time_quality: "wall".into(),
                traffic_shape: "sparse_burst".into(),
                long_line_percent: 4,
                rotation_every: 8_000,
            }),
            PAGING_STRESS_PROFILE => Ok(Self {
                profile: PAGING_STRESS_PROFILE.into(),
                event_count: event_count.unwrap_or(PAGING_STRESS_DEFAULT_EVENTS),
                span_secs: DAY_SECS, // one day is enough; density drives paging
                source_count: 6,
                time_quality: "wall".into(),
                traffic_shape: "paging".into(),
                long_line_percent: 2,
                rotation_every: 0,
            }),
            other => Err(format!("unsupported behavior profile: {other}").into()),
        }
    }

    /// Rough disk estimate (bytes) before generation; not a hard bound.
    pub fn estimated_bytes(&self) -> u64 {
        // ~180 bytes average JSON/logfmt line + long-line overhead.
        let avg = 180u64 + u64::from(self.long_line_percent) * 40;
        avg.saturating_mul(self.event_count as u64)
    }
}

/// Catalog of relative source paths (privacy-safe, no absolute paths).
fn source_catalog() -> [&'static str; 10] {
    [
        "edge/access.jsonl",
        "api/app.jsonl",
        "worker/worker.log",
        "db/database.log",
        "queue/events.jsonl",
        "auth/auth.jsonl",
        "region-a/app.jsonl",
        "region-b/app.jsonl",
        "inventory/service.log",
        "gateway/proxy.jsonl",
    ]
}

/// Deterministic LCG (not cryptographic). Seed is always FIXED_SEED-derived.
struct LabRng(u64);

impl LabRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        // Numerical Recipes LCG
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.0
    }

    fn next_usize(&mut self, max: usize) -> usize {
        if max == 0 {
            return 0;
        }
        (self.next_u64() as usize) % max
    }

    fn chance(&mut self, percent: u8) -> bool {
        self.next_usize(100) < percent as usize
    }
}

#[derive(Debug, Clone)]
struct SentinelPlan {
    /// Global ordinal indices (0-based generation order) for rare Find targets.
    find_beyond_first_page: usize,
    find_beyond_4k: usize,
    find_deep: usize,
    /// Bookmark targets at page / eviction boundaries.
    bookmark_page_boundary: usize,
    bookmark_evict_window: usize,
    bookmark_near_end: usize,
    /// Shared timestamp indices for align-by-time (multiple sources).
    shared_ts_a: usize,
    shared_ts_b: usize,
    /// Quiet gap markers (start/end ordinals documented in manifest).
    quiet_gap_start: usize,
    quiet_gap_end: usize,
}

impl SentinelPlan {
    fn for_count(event_count: usize) -> Self {
        let last = event_count.saturating_sub(1);
        let clamp = |v: usize| v.min(last);
        Self {
            // First page is 100–200 rows in Explorer; place well past that.
            find_beyond_first_page: clamp(250),
            // Beyond the old 40×100 = 4_000 scan horizon.
            find_beyond_4k: clamp(if event_count > 5_000 {
                4_500
            } else {
                event_count.saturating_mul(3) / 4
            }),
            find_deep: clamp(event_count.saturating_mul(4) / 5),
            bookmark_page_boundary: clamp(100),
            // Past a typical resident window (~2–4 pages of 100).
            bookmark_evict_window: clamp(if event_count > 2_000 {
                2_500
            } else {
                event_count.saturating_mul(2) / 3
            }),
            bookmark_near_end: clamp(last.saturating_sub(50)),
            shared_ts_a: clamp(500),
            shared_ts_b: clamp(501),
            quiet_gap_start: clamp(event_count / 3),
            quiet_gap_end: clamp(event_count / 3 + event_count / 20),
        }
    }
}

/// Generate a behavior-rich scale corpus under `scenarios/behavior-scale/`.
pub fn generate_behavior(
    root: &Path,
    controls: &BehaviorControls,
) -> LabResult<super::GenerationSummary> {
    if controls.event_count == 0 {
        return Err("event_count must be greater than zero".into());
    }
    if !(1..=10).contains(&controls.source_count) {
        return Err("source_count must be between 1 and 10".into());
    }
    if controls.span_secs <= 0 {
        return Err("span_secs must be positive".into());
    }
    ensure_empty_generation_target(root)?;
    fs::create_dir_all(root)?;

    let catalog = source_catalog();
    let sources: Vec<&str> = catalog[..controls.source_count].to_vec();
    let import_root = root
        .join("scenarios")
        .join(BEHAVIOR_SCENARIO_ID)
        .join("import");
    let mut writers: Vec<fs::File> = Vec::with_capacity(sources.len());
    // Optional rotation siblings (same basename family).
    let mut rotation_writers: BTreeMap<String, fs::File> = BTreeMap::new();

    for name in &sources {
        let path = import_root.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        writers.push(fs::File::create(path)?);
    }

    let sentinels = SentinelPlan::for_count(controls.event_count);
    let mut rng = LabRng::new(FIXED_SEED ^ (controls.event_count as u64).wrapping_mul(0x9E37));
    let mut per_source: BTreeMap<String, u64> = BTreeMap::new();
    let mut severity: BTreeMap<String, u64> = BTreeMap::new();
    let mut long_line_count = 0u64;
    let mut multiline_count = 0u64;
    let mut equal_ts_pairs = 0u64;

    // Pre-compute timestamps so quiet gaps and shared stamps are exact.
    let timestamps = plan_timestamps(controls, &sentinels, &mut rng);
    // Source assignment (with intentional misalignment windows).
    let assignments = plan_source_assignments(controls, &sources, &sentinels, &mut rng);

    for index in 0..controls.event_count {
        let source_index = assignments[index];
        let source_path = sources[source_index];
        let ts = timestamps[index];
        let level = pick_level(index, &mut rng);
        *severity.entry(level.to_string()).or_insert(0) += 1;
        *per_source.entry(source_path.to_string()).or_insert(0) += 1;

        let marker = sentinel_marker(index, &sentinels);
        let is_long = controls.long_line_percent > 0
            && (index % 100 < controls.long_line_percent as usize
                || marker.as_ref().is_some_and(|m| m.contains("STACK")));
        let is_multiline = is_long && index.is_multiple_of(3);
        if is_long {
            long_line_count += 1;
        }
        if is_multiline {
            multiline_count += 1;
        }

        // Equal-timestamp peers around shared_ts_a/b for lane alignment tests.
        if index == sentinels.shared_ts_a || index == sentinels.shared_ts_b {
            equal_ts_pairs += 1;
        }

        let line = format_event(
            source_index,
            source_path,
            index,
            ts,
            level,
            marker.as_deref(),
            is_long,
            is_multiline,
            controls,
        );

        // Rotation: write a slice of traffic to `*.log.1` / sibling files.
        let use_rotation = controls.rotation_every > 0
            && index > 0
            && index % controls.rotation_every < controls.rotation_every / 10
            && source_path.ends_with(".log");
        if use_rotation {
            let rotated = format!("{source_path}.1");
            if !rotation_writers.contains_key(&rotated) {
                let path = import_root.join(&rotated);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                rotation_writers.insert(rotated.clone(), fs::File::create(path)?);
            }
            writeln!(rotation_writers.get_mut(&rotated).unwrap(), "{line}")?;
            // Still count under primary source for expected totals; rotation
            // files add extra events — track them separately below.
        } else {
            writeln!(writers[source_index], "{line}")?;
        }
    }
    drop(writers);
    drop(rotation_writers);

    // Recount actual events from files (rotation adds files).
    let import_files = collect_import_files(&import_root)?;
    let actual_events: usize = import_files.iter().map(|(_, n)| *n).sum();
    let file_hashes = hashes_for_paths(root, &collect_paths(&import_root)?)?;

    let time_span = json!({
        "from_ts": BASE_TS,
        "to_ts": BASE_TS + controls.span_secs,
        "span_secs": controls.span_secs,
        "span_days": (controls.span_secs as f64 / DAY_SECS as f64)
    });

    let quiet_from = timestamps[sentinels.quiet_gap_start];
    let quiet_to = timestamps[sentinels.quiet_gap_end.min(timestamps.len() - 1)];

    let investigation = json!({
        "profile": controls.profile,
        "traffic_shape": controls.traffic_shape,
        "controls": {
            "event_count": controls.event_count,
            "span_secs": controls.span_secs,
            "source_count": controls.source_count,
            "time_quality": controls.time_quality,
            "long_line_percent": controls.long_line_percent,
            "rotation_every": controls.rotation_every
        },
        "time_span": time_span,
        "long_line_count": long_line_count,
        "multiline_count": multiline_count,
        "equal_timestamp_markers": equal_ts_pairs,
        "lane_gaps": [
            {
                "id": "primary-quiet-gap",
                "from_ts": quiet_from,
                "to_ts": quiet_to,
                "duration_secs": quiet_to.saturating_sub(quiet_from),
                "description": "Documented quiet interval for Align-by-time / navigator tests (#486/#522)."
            }
        ],
        "aligned_intervals": [
            {
                "id": "shared-ts-pair",
                "indices": [sentinels.shared_ts_a, sentinels.shared_ts_b],
                "ts": timestamps[sentinels.shared_ts_a],
                "description": "Two events share one wall timestamp across sources for alignment proof."
            }
        ],
        "misaligned_intervals": [
            {
                "id": "source-skew-window",
                "description": "Odd-indexed sources run ~90s behind even-indexed peers during the middle third of the span."
            }
        ],
        "sentinels": {
            "find_beyond_first_page": sentinel_record(sentinels.find_beyond_first_page, &timestamps, &assignments, &sources, "FIND_RARE_BEYOND_PAGE"),
            "find_beyond_4k": sentinel_record(sentinels.find_beyond_4k, &timestamps, &assignments, &sources, "FIND_RARE_BEYOND_4K"),
            "find_deep": sentinel_record(sentinels.find_deep, &timestamps, &assignments, &sources, "FIND_RARE_DEEP"),
            "bookmark_page_boundary": sentinel_record(sentinels.bookmark_page_boundary, &timestamps, &assignments, &sources, "BOOKMARK_PAGE_BOUNDARY"),
            "bookmark_evict_window": sentinel_record(sentinels.bookmark_evict_window, &timestamps, &assignments, &sources, "BOOKMARK_EVICT_WINDOW"),
            "bookmark_near_end": sentinel_record(sentinels.bookmark_near_end, &timestamps, &assignments, &sources, "BOOKMARK_NEAR_END")
        },
        "expected_queries": [
            {"kind": "find", "text": "FIND_RARE_BEYOND_PAGE", "min_hits": 1, "placement": "beyond_first_page"},
            {"kind": "find", "text": "FIND_RARE_BEYOND_4K", "min_hits": 1, "placement": "beyond_4000"},
            {"kind": "find", "text": "FIND_RARE_DEEP", "min_hits": 1, "placement": "deep"},
            {"kind": "filter", "text": "BOOKMARK_EVICT_WINDOW", "min_hits": 1},
            {"kind": "literal", "text": "STACK_TRACE_SENTINEL", "notes": "long multiline sample"},
            {"kind": "literal", "text": "UTF8_café_λ", "notes": "unicode sample"},
            {"kind": "level", "level": "error"}
        ],
        "expected_bookmark_targets": [
            "BOOKMARK_PAGE_BOUNDARY",
            "BOOKMARK_EVICT_WINDOW",
            "BOOKMARK_NEAR_END"
        ],
        "formats": ["json", "logfmt", "multiline_stack", "utf8", "long_json"],
        "rotations": if controls.rotation_every > 0 {
            json!([{"pattern": "*.log.1", "every": controls.rotation_every}])
        } else {
            json!([])
        },
        "performance_claim_policy": "Record machine/OS/build mode, elapsed times, resident counts, and peak memory/CPU when available. Do not treat one host as a universal threshold.",
        "disk_estimate_bytes": controls.estimated_bytes(),
        "safety": "Entirely synthetic; hosts use .example; no current-clock, home paths, or real credentials."
    });

    // Build expected.sources as object path -> count for schema parity with compact.
    let sources_obj: serde_json::Map<String, Value> = per_source
        .iter()
        .map(|(k, v)| (k.clone(), json!(*v)))
        .collect();

    write_json(
        &root
            .join("scenarios")
            .join(BEHAVIOR_SCENARIO_ID)
            .join("truth/manifest.json"),
        &json!({
            "schema_version": TRUTH_SCHEMA_VERSION,
            "scenario_version": BEHAVIOR_SCENARIO_VERSION,
            "scenario_id": BEHAVIOR_SCENARIO_ID,
            "generator_version": GENERATOR_VERSION,
            "seed": FIXED_SEED,
            "provenance": "Entirely synthetic and generated by the ContextDesk repository; no third-party or production log material.",
            "expected": {
                "files": import_files.len(),
                "events": actual_events,
                "bytes": import_files.iter().map(|(p, _)| fs::metadata(import_root.join(p)).map(|m| m.len()).unwrap_or(0)).sum::<u64>(),
                "source_count": import_files.len(),
                "sources": sources_obj,
                "severities": severity,
                "time_quality": controls.time_quality,
                "files_by_path": file_hashes.iter().map(|(k,v)| (k.clone(), json!({"sha256": v}))).collect::<serde_json::Map<_,_>>(),
                "time_span_secs": controls.span_secs,
                "traffic_shape": controls.traffic_shape,
                "profile": controls.profile,
                "requested_events": controls.event_count,
                "hashes": file_hashes
            },
            "investigation": investigation
        }),
    )?;

    verify_safety(root)?;
    summarize_generation(root, &controls.profile, actual_events)
}

fn plan_timestamps(
    controls: &BehaviorControls,
    sentinels: &SentinelPlan,
    rng: &mut LabRng,
) -> Vec<i64> {
    let n = controls.event_count;
    let span = controls.span_secs.max(1);
    let mut out = Vec::with_capacity(n);

    match controls.traffic_shape.as_str() {
        "paging" => {
            // Dense: ~50 events/sec so paging is about ordinal, not calendar.
            for i in 0..n {
                out.push(BASE_TS + (i as i64 / 50));
            }
        }
        _ => {
            // sparse_burst (default) and any future shapes share this path.
            // Map ordinal → fractional position, then apply burst/quiet warping.
            for i in 0..n {
                let mut frac = i as f64 / n.max(1) as f64;
                // Quiet gap: compress ordinals in the quiet band into a tiny
                // wall interval, then jump — creates a long wall quiet with few events.
                let q0 = sentinels.quiet_gap_start as f64 / n.max(1) as f64;
                let q1 = sentinels.quiet_gap_end as f64 / n.max(1) as f64;
                if frac >= q0 && frac <= q1 {
                    // Keep wall time almost flat across quiet ordinals.
                    frac = q0 + (frac - q0) * 0.02;
                } else if frac > q1 {
                    // Stretch remaining span after quiet.
                    let remain = 1.0 - q1;
                    let local = (frac - q1) / remain.max(1e-9);
                    frac = q0 + 0.02 * (q1 - q0) + local * (1.0 - q0 - 0.02 * (q1 - q0));
                }
                // Bursts: every ~7% of span, pack 40 events into the same second.
                let burst_bucket = (i / 40) % 17;
                let ts = if burst_bucket == 0 {
                    BASE_TS + ((frac * span as f64) as i64)
                } else {
                    BASE_TS + ((frac * span as f64) as i64) + rng.next_usize(3) as i64
                };
                out.push(ts.clamp(BASE_TS, BASE_TS + span));
            }
            // Force shared timestamps for alignment sentinels.
            if n > sentinels.shared_ts_b {
                let shared = out[sentinels.shared_ts_a];
                out[sentinels.shared_ts_b] = shared;
            }
        }
    }
    out
}

fn plan_source_assignments(
    controls: &BehaviorControls,
    sources: &[&str],
    sentinels: &SentinelPlan,
    rng: &mut LabRng,
) -> Vec<usize> {
    let n = controls.event_count;
    let sc = sources.len().max(1);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        // Baseline: weighted round-robin with light randomness.
        let mut idx = if controls.traffic_shape == "paging" {
            i % sc
        } else {
            // Sparse sources: higher indices are quieter.
            let roll = rng.next_usize(100);
            if roll < 35 {
                0
            } else if roll < 60 {
                1.min(sc - 1)
            } else if roll < 75 {
                2.min(sc - 1)
            } else if roll < 85 {
                3.min(sc - 1)
            } else {
                rng.next_usize(sc)
            }
        };
        // During quiet gap, silence sources 2+ to create lane gaps.
        if i >= sentinels.quiet_gap_start && i <= sentinels.quiet_gap_end && sc > 2 {
            idx = i % 2; // only first two sources tick
        }
        out.push(idx);
    }
    // Ensure sentinel events land on stable, documented sources.
    for &si in &[
        sentinels.find_beyond_first_page,
        sentinels.find_beyond_4k,
        sentinels.find_deep,
        sentinels.bookmark_page_boundary,
        sentinels.bookmark_evict_window,
        sentinels.bookmark_near_end,
    ] {
        if si < n {
            out[si] = 0; // edge/access.jsonl
        }
    }
    if sentinels.shared_ts_b < n && sc > 1 {
        out[sentinels.shared_ts_a] = 0;
        out[sentinels.shared_ts_b] = 1;
    }
    out
}

fn pick_level(index: usize, rng: &mut LabRng) -> &'static str {
    if index.is_multiple_of(211) {
        "error"
    } else if index.is_multiple_of(97) {
        "warn"
    } else if rng.chance(2) {
        "debug"
    } else {
        "info"
    }
}

fn sentinel_marker(index: usize, plan: &SentinelPlan) -> Option<String> {
    if index == plan.find_beyond_first_page {
        Some("FIND_RARE_BEYOND_PAGE".into())
    } else if index == plan.find_beyond_4k {
        Some("FIND_RARE_BEYOND_4K".into())
    } else if index == plan.find_deep {
        Some("FIND_RARE_DEEP".into())
    } else if index == plan.bookmark_page_boundary {
        Some("BOOKMARK_PAGE_BOUNDARY".into())
    } else if index == plan.bookmark_evict_window {
        Some("BOOKMARK_EVICT_WINDOW".into())
    } else if index == plan.bookmark_near_end {
        Some("BOOKMARK_NEAR_END".into())
    } else if index.is_multiple_of(777) {
        Some("STACK_TRACE_SENTINEL".into())
    } else {
        None
    }
}

fn sentinel_record(
    index: usize,
    timestamps: &[i64],
    assignments: &[usize],
    sources: &[&str],
    token: &str,
) -> Value {
    let source = sources
        .get(assignments.get(index).copied().unwrap_or(0))
        .copied()
        .unwrap_or("edge/access.jsonl");
    json!({
        "generation_index": index,
        "token": token,
        "ts": timestamps.get(index).copied().unwrap_or(BASE_TS),
        "source": source,
        "stable_message_token": token
    })
}

#[allow(clippy::too_many_arguments)]
fn format_event(
    source_index: usize,
    source_path: &str,
    index: usize,
    ts: i64,
    level: &str,
    marker: Option<&str>,
    is_long: bool,
    is_multiline: bool,
    controls: &BehaviorControls,
) -> String {
    // Optional order-only / mixed: strip wall ts for a subset of inventory.
    let order_only = controls.time_quality == "order_only"
        || (controls.time_quality == "mixed" && source_path.starts_with("inventory/"));

    let trace = format!("trace-behavior-{:08}", index % 50_000);
    let marker_suffix = marker.map(|m| format!(" marker={m}")).unwrap_or_default();
    let utf8_sample = if index.is_multiple_of(1_109) {
        " UTF8_café_λ"
    } else {
        ""
    };

    let body = if is_multiline {
        // Avoid multi-label dotted tokens (safety scanner treats them as hostnames).
        format!(
            "event_id=behavior-{index} STACK_TRACE_SENTINEL failure in handler{marker_suffix}{utf8_sample}\n    at lab_module_handler(file=example_rs line={})\n    at lab_module_dispatch(file=example_rs line={})\nCaused by: simulated timeout after {}ms",
            40 + (index % 20),
            10 + (index % 5),
            100 + (index % 900)
        )
    } else if is_long {
        let pad = "x".repeat(400 + (index % 200));
        format!(
            "event_id=behavior-{index} LONG_JSON_SENTINEL payload={pad}{marker_suffix}{utf8_sample}"
        )
    } else {
        format!(
            "event_id=behavior-{index} step={}{marker_suffix}{utf8_sample}",
            index % 11
        )
    };

    // Source 2,3 use logfmt; others JSON. Inventory order-only uses plain text.
    if order_only {
        return format!(
            "{} event_id=behavior-{index} order-only line{marker_suffix}{utf8_sample}",
            level.to_ascii_uppercase()
        );
    }

    let host = host_for(source_index);
    let use_logfmt = source_index == 2 || source_index == 3 || source_path.ends_with(".log");
    if !use_logfmt {
        // Keep every row in a JSON/JSONL source valid JSON. Production ingest
        // intentionally detects one format per file, so switching a multiline
        // row to logfmt would turn its wall timestamp into synthetic order.
        json_line(ts, level, service_for(source_path), &host, &trace, &body)
    } else if !is_multiline {
        logfmt(
            ts,
            level,
            service_for(source_path),
            &host,
            &trace,
            &body.replace('\n', " | "),
        )
    } else {
        // Escape newlines inside one logfmt row so importers still see a single
        // event with recoverable multiline content.
        format!(
            "ts={ts} level={level} service={} host={host} trace_id={trace} msg=\"{}\"",
            service_for(source_path),
            body.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
        )
    }
}

fn service_for(source_path: &str) -> &'static str {
    match source_path {
        "edge/access.jsonl" => "edge",
        "api/app.jsonl" => "checkout-api",
        "worker/worker.log" => "queue-worker",
        "db/database.log" => "database",
        "queue/events.jsonl" => "checkout-queue",
        "auth/auth.jsonl" => "auth-service",
        "region-a/app.jsonl" | "region-b/app.jsonl" => "catalog",
        "inventory/service.log" => "inventory",
        "gateway/proxy.jsonl" => "gateway",
        _ => "service",
    }
}

fn host_for(source_index: usize) -> String {
    format!("host-{:02}.example", (source_index % 6) + 1)
}

fn collect_paths(import_root: &Path) -> LabResult<Vec<std::path::PathBuf>> {
    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else if path.is_file() {
                out.push(path);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    if import_root.exists() {
        walk(import_root, &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn collect_import_files(import_root: &Path) -> LabResult<Vec<(String, usize)>> {
    let mut out = Vec::new();
    for path in collect_paths(import_root)? {
        let rel = path
            .strip_prefix(import_root)?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(&path)?;
        if bytes.contains(&0) {
            continue;
        }
        let count = String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count();
        out.push((rel, count));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Write a performance recording template next to a generated corpus.
/// Callers fill measured fields after import/seek; one machine ≠ universal claim.
pub fn write_performance_template(
    root: &Path,
    controls: &BehaviorControls,
    summary: &super::GenerationSummary,
) -> LabResult<std::path::PathBuf> {
    let path = root.join("performance-record.template.json");
    write_json(
        &path,
        &json!({
            "schema_version": 1,
            "generator_version": GENERATOR_VERSION,
            "seed": FIXED_SEED,
            "profile": controls.profile,
            "scenario_id": BEHAVIOR_SCENARIO_ID,
            "machine": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "notes": "Fill hostname/CPU model manually if needed. Do not claim universal thresholds."
            },
            "build": {
                "mode": "record at measurement time (debug vs release)",
                "git_sha": "fill after measurement"
            },
            "corpus": {
                "events": summary.events,
                "files": summary.files,
                "tree_sha256": summary.tree_sha256,
                "source_bytes_estimate": controls.estimated_bytes(),
                "span_secs": controls.span_secs,
                "source_count": controls.source_count,
                "traffic_shape": controls.traffic_shape
            },
            "measurements": {
                "generation_ms": null,
                "import_ms": null,
                "source_bytes": null,
                "corpus_bytes": null,
                "first_page_ms": null,
                "deep_seek_ms": null,
                "peak_rss_bytes": null,
                "peak_cpu_percent": null
            },
            "policy": "These are one-machine observations. Never promote them to universal performance claims."
        }),
    )?;
    Ok(path)
}

/// Read sentinel tokens from a generated behavior-scale tree (for tests).
pub fn load_behavior_manifest(root: &Path) -> LabResult<Value> {
    let path = root
        .join("scenarios")
        .join(BEHAVIOR_SCENARIO_ID)
        .join("truth/manifest.json");
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// True when `profile` is a behavior-rich profile name.
pub fn is_behavior_profile(profile: &str) -> bool {
    matches!(
        profile,
        UI_MEDIUM_PROFILE | SEVEN_DAY_PROFILE | PAGING_STRESS_PROFILE
    )
}
