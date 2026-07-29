#[path = "../tests/support/log_lab_generator.rs"]
mod log_lab_generator;

use log_lab_generator::{
    generate_behavior, generate_compact, generate_scale, generate_triage_stress,
    is_behavior_profile, triage_stress_estimated_bytes, write_performance_template,
    write_triage_stress_performance_template, BehaviorControls, DEFAULT_LARGE_EVENT_COUNT,
    DEFAULT_TRIAGE_STRESS_EVENT_COUNT, LARGE_PROFILE, MEDIUM_EVENT_COUNT, MEDIUM_PROFILE,
    PAGING_STRESS_PROFILE, SEVEN_DAY_PROFILE, SMALL_PROFILE, TRIAGE_STRESS_PROFILE,
    TRIAGE_STRESS_SOURCE_COUNT, UI_MEDIUM_PROFILE,
};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    if let Err(error) = run() {
        eprintln!("generate_log_lab: {error}");
        std::process::exit(2);
    }
}

fn run() -> log_lab_generator::LabResult<()> {
    let mut args = std::env::args().skip(1);
    let mut output: Option<PathBuf> = None;
    let mut profile = SMALL_PROFILE.to_string();
    let mut events: Option<usize> = None;
    let mut span_secs: Option<i64> = None;
    let mut source_count: Option<usize> = None;
    let mut estimate_only = false;
    let mut record_perf = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--output" => {
                let value = args.next().ok_or("--output requires a path")?;
                output = Some(PathBuf::from(value));
            }
            "--profile" => {
                profile = args.next().ok_or("--profile requires a value")?;
            }
            "--events" => {
                let value = args.next().ok_or("--events requires a value")?;
                events = Some(value.parse()?);
            }
            "--span-secs" => {
                let value = args.next().ok_or("--span-secs requires a value")?;
                span_secs = Some(value.parse()?);
            }
            "--sources" => {
                let value = args.next().ok_or("--sources requires a value")?;
                source_count = Some(value.parse()?);
            }
            "--estimate-only" => estimate_only = true,
            "--record-perf" => record_perf = true,
            "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    if profile == TRIAGE_STRESS_PROFILE {
        if span_secs.is_some() || source_count.is_some() {
            return Err(
                "triage-stress has a fixed 12-source wall-clock design; only --events may be overridden"
                    .into(),
            );
        }
        let count = events.unwrap_or(DEFAULT_TRIAGE_STRESS_EVENT_COUNT);
        let approx = triage_stress_estimated_bytes(count);
        if estimate_only {
            println!(
                "ESTIMATE profile={TRIAGE_STRESS_PROFILE} events={count} sources={TRIAGE_STRESS_SOURCE_COUNT} approx_bytes={approx} approx_mib={:.1}",
                approx as f64 / (1024.0 * 1024.0)
            );
            println!(
                "policy: generated triage-stress corpora are local-only; never commit generated trees. One machine's timing is not a universal claim."
            );
            return Ok(());
        }
        let output = output.ok_or("--output is required (unless --estimate-only)")?;
        eprintln!(
            "WARNING: generating triage-stress with {count} events (~{:.1} MiB estimated). Output must stay outside Git.",
            approx as f64 / (1024.0 * 1024.0)
        );
        let started = Instant::now();
        let summary = generate_triage_stress(&output, count)?;
        let generation_ms = started.elapsed().as_millis();
        if record_perf {
            let template = write_triage_stress_performance_template(&output, &summary)?;
            eprintln!(
                "Wrote performance template {} (fill measurements after import; generation_ms={generation_ms})",
                template.display()
            );
        }
        println!(
            "PASS profile={} files={} events={} bytes={} tree_sha256={} generation_ms={}",
            summary.profile,
            summary.files,
            summary.events,
            summary.bytes,
            summary.tree_sha256,
            generation_ms
        );
        return Ok(());
    }

    if is_behavior_profile(&profile) {
        let mut controls = BehaviorControls::for_profile(&profile, events)?;
        if let Some(span) = span_secs {
            controls.span_secs = span;
        }
        if let Some(count) = source_count {
            controls.source_count = count;
        }
        if estimate_only {
            println!(
                "ESTIMATE profile={} events={} sources={} span_secs={} approx_bytes={} approx_mib={:.1}",
                controls.profile,
                controls.event_count,
                controls.source_count,
                controls.span_secs,
                controls.estimated_bytes(),
                controls.estimated_bytes() as f64 / (1024.0 * 1024.0)
            );
            println!(
                "policy: large corpora are local-only; never commit generated trees. One machine's timing is not a universal claim."
            );
            return Ok(());
        }
        let output = output.ok_or("--output is required (unless --estimate-only)")?;
        if controls.event_count >= 1_000_000 {
            eprintln!(
                "WARNING: generating ~{} events (~{:.1} MiB estimated). Output must stay outside Git.",
                controls.event_count,
                controls.estimated_bytes() as f64 / (1024.0 * 1024.0)
            );
        }
        let started = Instant::now();
        let summary = generate_behavior(&output, &controls)?;
        let generation_ms = started.elapsed().as_millis();
        if record_perf {
            let template = write_performance_template(&output, &controls, &summary)?;
            eprintln!(
                "Wrote performance template {} (fill measurements after import; generation_ms={generation_ms})",
                template.display()
            );
        }
        println!(
            "PASS profile={} files={} events={} bytes={} tree_sha256={} generation_ms={}",
            summary.profile,
            summary.files,
            summary.events,
            summary.bytes,
            summary.tree_sha256,
            generation_ms
        );
        return Ok(());
    }

    if matches!(profile.as_str(), LARGE_PROFILE) && estimate_only {
        let count = events.unwrap_or(DEFAULT_LARGE_EVENT_COUNT);
        let approx = (count as u64).saturating_mul(180);
        println!(
            "ESTIMATE profile=large events={count} approx_bytes={approx} approx_mib={:.1}",
            approx as f64 / (1024.0 * 1024.0)
        );
        println!("policy: large corpora are local-only; never commit generated trees.");
        return Ok(());
    }

    let output = output.ok_or("--output is required")?;
    if matches!(profile.as_str(), LARGE_PROFILE) {
        let count = events.unwrap_or(DEFAULT_LARGE_EVENT_COUNT);
        let approx = (count as u64).saturating_mul(180);
        eprintln!(
            "WARNING: large profile ~{count} events (~{:.1} MiB estimated). Local-only; never commit.",
            approx as f64 / (1024.0 * 1024.0)
        );
    }

    let summary = match profile.as_str() {
        SMALL_PROFILE => generate_compact(&output)?,
        MEDIUM_PROFILE => generate_scale(
            &output,
            MEDIUM_PROFILE,
            events.unwrap_or(MEDIUM_EVENT_COUNT),
        )?,
        LARGE_PROFILE => generate_scale(
            &output,
            LARGE_PROFILE,
            events.unwrap_or(DEFAULT_LARGE_EVENT_COUNT),
        )?,
        UI_MEDIUM_PROFILE
        | SEVEN_DAY_PROFILE
        | PAGING_STRESS_PROFILE
        | TRIAGE_STRESS_PROFILE => {
            unreachable!("behavior profiles handled above")
        }
        _ => {
            return Err(format!(
            "unsupported profile: {profile} (small|medium|large|ui-medium|seven-day|paging-stress|triage-stress)"
        )
            .into())
        }
    };
    println!(
        "PASS profile={} files={} events={} bytes={} tree_sha256={}",
        summary.profile, summary.files, summary.events, summary.bytes, summary.tree_sha256
    );
    Ok(())
}

fn print_help() {
    println!(
        "\
Usage: cargo run -p cd-core --example generate_log_lab -- \\
  --output PATH [--profile PROFILE] [options]

Profiles:
  small            Compact checked-in mystery scenarios (default)
  medium           Legacy regular 100k scale (4 sources, fixed rate)
  large            Opt-in million-event stress (never commit)
  ui-medium        Behavior-rich 100k, 8 sources, multi-day (#542)
  seven-day        Seven-day sparse/burst (event count independent of span)
  paging-stress    Boundary sentinels for bidirectional paging/eviction
  triage-stress    Error-heavy 250k broad-triage corpus (local-only)

Options:
  --events N       Override event count
  --span-secs N    Override wall-clock span (behavior profiles only)
  --sources N      Override source count 1–10 (behavior profiles only)
  --estimate-only  Print disk estimate and exit (no files written)
  --record-perf    Write performance-record.template.json beside output
  -h, --help       Show this help

The output directory must be absent or empty. Large/opt-in profiles are
local-only. Two identical runs are byte-for-byte deterministic.

Examples:
  cargo run -p cd-core --example generate_log_lab -- --profile ui-medium --estimate-only
  cargo run -p cd-core --example generate_log_lab -- --output /tmp/cd-lab-ui --profile ui-medium --record-perf
  cargo run -p cd-core --example generate_log_lab -- --output /tmp/cd-lab-7d --profile seven-day --events 25000
  cargo run -p cd-core --example generate_log_lab -- --profile triage-stress --estimate-only
  cargo run -p cd-core --example generate_log_lab -- --output target/contextdesk-demo-lab/triage-stress-250k --profile triage-stress --record-perf
"
    );
}
