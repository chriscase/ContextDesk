//! Exact-head acceptance lab: timezone apply-all rewrites local wall clocks
//! into normalized UTC event timestamps (drives the real CLI binary + LogCorpus).
//!
//! Synthetic fixtures only. No private data. No network.

use assert_cmd::Command;
use cd_core::config::AppConfig;
use cd_core::log_analysis::store::LogCorpus;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

#[path = "helpers/app_config.rs"]
mod app_config;

fn cli(data_dir: &Path) -> Command {
    let mut cmd = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    cmd.args(["--data-dir", data_dir.to_str().unwrap()]);
    cmd
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|e| {
        panic!(
            "stdout must be one JSON envelope: {e}; raw={}",
            String::from_utf8_lossy(bytes)
        )
    })
}

fn write_default_config(data_dir: &Path) {
    std::fs::create_dir_all(data_dir).unwrap();
    // No default_timezone — force explicit apply-all.
    let cfg = AppConfig {
        default_timezone: None,
        ..AppConfig::default()
    };
    app_config::plant_app_config(&data_dir.join("config.json"), &cfg);
}

/// Local wall clocks without zone (ambiguous until apply-all).
fn write_local_wall_fixture(dir: &Path) -> PathBuf {
    let logs = dir.join("logs");
    std::fs::create_dir_all(logs.join("svc-a")).unwrap();
    // America/Chicago CDT (UTC-5) on 2024-06-15:
    // 10:00:01 local → 15:00:01 UTC; 10:00:02 local → 15:00:02 UTC.
    let mut f = std::fs::File::create(logs.join("svc-a/app.log")).unwrap();
    writeln!(
        f,
        "2024-06-15 10:00:01 ERROR SYNTH_TZ_A correlation=tz-demo"
    )
    .unwrap();
    writeln!(f, "2024-06-15 10:00:02 INFO SYNTH_TZ_B correlation=tz-demo").unwrap();
    let zip_path = dir.join("local-wall.zip");
    let file = std::fs::File::create(&zip_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("svc-a/app.log", opts).unwrap();
    zip.write_all(
        b"2024-06-15 10:00:01 ERROR SYNTH_TZ_A correlation=tz-demo\n\
2024-06-15 10:00:02 INFO SYNTH_TZ_B correlation=tz-demo\n",
    )
    .unwrap();
    zip.finish().unwrap();
    zip_path
}

#[test]
fn apply_all_normalizes_local_wall_clocks_to_expected_utc_event_ts() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    write_default_config(&data_dir);
    let archive = write_local_wall_fixture(root.path());

    let import = cli(&data_dir)
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("import");
    assert!(
        import.status.success(),
        "import failed: {}",
        String::from_utf8_lossy(&import.stderr)
    );
    let imp = parse_envelope(&import.stdout);
    assert_eq!(imp["ok"], true, "{imp}");
    let corpus_id = imp["data"]["corpus_id"]
        .as_str()
        .expect("corpus_id")
        .to_string();
    assert!(imp["data"]["events_imported"].as_u64().unwrap_or(0) >= 2);

    // Before apply-all, local records should still be unresolved.
    let before = cli(&data_dir)
        .args(["--json", "timezone", "status", "--corpus", &corpus_id])
        .output()
        .expect("tz status before");
    assert!(before.status.success());
    let before_env = parse_envelope(&before.stdout);
    let unresolved_before: u64 = before_env["data"]["sources"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|s| s["unresolved_local_records"].as_u64().unwrap_or(0))
        .sum();
    assert!(
        unresolved_before > 0,
        "fixture must present unresolved local timestamps: {before_env}"
    );

    let apply = cli(&data_dir)
        .args([
            "--json",
            "timezone",
            "apply-all",
            "America/Chicago",
            "--corpus",
            &corpus_id,
            "--yes",
        ])
        .output()
        .expect("apply-all");
    assert!(
        apply.status.success(),
        "apply-all failed: {}",
        String::from_utf8_lossy(&apply.stderr)
    );
    let apply_env = parse_envelope(&apply.stdout);
    assert_eq!(apply_env["ok"], true, "{apply_env}");

    let after = cli(&data_dir)
        .args(["--json", "timezone", "status", "--corpus", &corpus_id])
        .output()
        .expect("tz status after");
    assert!(after.status.success());
    let after_env = parse_envelope(&after.stdout);
    let unresolved_after: u64 = after_env["data"]["sources"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|s| s["unresolved_local_records"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(
        unresolved_after, 0,
        "all local timestamps must resolve after apply-all: {after_env}"
    );

    // Normalized event UTC: open the same cache the CLI uses and read `ts`.
    // America/Chicago on 2024-06-15 is CDT (UTC-5): 10:00:01 → 15:00:01Z.
    let cache_root = data_dir.join("cache");
    let corpus = LogCorpus::open(&cache_root, &corpus_id).expect("open corpus");
    let events = corpus.with_events(|evs| {
        evs.iter()
            .map(|e| (e.ts, e.source.clone(), e.message.clone()))
            .collect::<Vec<_>>()
    });
    assert!(
        events.len() >= 2,
        "expected ≥2 normalized events, got {events:?}"
    );

    // Host stores event `ts` as Unix **seconds** (not ms). Pinned offline:
    // datetime(2024,6,15,15,0,1,tz=UTC).timestamp() after America/Chicago apply.
    const EXPECTED_FIRST_S: i64 = 1_718_463_601;
    const EXPECTED_SECOND_S: i64 = 1_718_463_602;
    let first = events
        .iter()
        .find(|(_, _, m)| m.contains("SYNTH_TZ_A"))
        .expect("SYNTH_TZ_A event");
    let second = events
        .iter()
        .find(|(_, _, m)| m.contains("SYNTH_TZ_B"))
        .expect("SYNTH_TZ_B event");
    assert_eq!(
        first.0, EXPECTED_FIRST_S,
        "SYNTH_TZ_A must normalize to 2024-06-15T15:00:01Z; got {}",
        first.0
    );
    assert_eq!(
        second.0, EXPECTED_SECOND_S,
        "SYNTH_TZ_B must normalize to 2024-06-15T15:00:02Z; got {}",
        second.0
    );

    assert_eq!(
        unresolved_after, 0,
        "apply-all must leave zero unresolved locals"
    );
    assert!(
        unresolved_before > 0,
        "precondition: fixture had unresolved locals"
    );
}
