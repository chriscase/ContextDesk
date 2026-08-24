//! Public-safe adversarial CLI acceptance lab.
//!
//! Drives the **compiled** `contextdesk` binary (not a reimplementation) through
//! import → timezone → explore → context → dry-run trace → mock native-tool
//! chat → two-turn session under an isolated `--data-dir`.
//!
//! All archives are **synthetic and deterministic**. No private data. No
//! external model APIs (provider traffic is wiremock-local only).
//!
//! Oracles are aggregate-only and mutation-checked so a vacuous “success”
//! (zero events, collapsed identities, silent failures) cannot pass.

use assert_cmd::Command;
use cd_core::config::AppConfig;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};
use zip::write::SimpleFileOptions;

#[path = "helpers/app_config.rs"]
mod app_config;

/// Unique first-turn phrase so continuity can be proven in provider history
/// without relying on second-turn prompt text alone.
const FIRST_TURN_MARKER: &str = "LAB_TURN1_QUEUE_STALL_A";
const SECOND_TURN_MARKER: &str = "LAB_TURN2_QUEUE_STALL_B";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn cli(data_dir: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.args(["--data-dir", data_dir.to_str().unwrap()]);
    cmd
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|e| {
        panic!(
            "stdout is one JSON envelope: {e}; raw={}",
            String::from_utf8_lossy(bytes)
        )
    })
}

fn jsonl(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
        .collect()
}

fn write_app_config(data_dir: &Path, cfg: &AppConfig) {
    std::fs::create_dir_all(data_dir).unwrap();
    app_config::plant_app_config(&data_dir.join("config.json"), cfg);
}

fn init_timezone_only(data_dir: &Path, zone: &str) {
    // Plant AppConfig instead of `config init --default-timezone`: production
    // `save_config` is Unix-only. This lab proves import/explore/context/chat
    // under an isolated data-dir, not durable config persistence.
    let mut cfg = AppConfig::default();
    cfg.default_timezone = Some(zone.to_string());
    write_app_config(data_dir, &cfg);
}

// ---------------------------------------------------------------------------
// Synthetic corpus matrix (public-safe, deterministic)
// ---------------------------------------------------------------------------

/// Build the multi-case adversarial archive under `root` and return its path.
///
/// Case map (path → purpose):
/// - `svc-a/app.log` / `svc-b/app.log` — same basename, different parents (identity non-collapse)
/// - `nested/inner.zip!/deep/app.log` — nested ZIP + path under archive
/// - `mixed/jsonl.jsonl` — JSON lines with explicit offsets
/// - `mixed/local.log` — local wall-clock timestamps (unresolved_local without TZ)
/// - `mixed/multiline.log` — continuation lines until next timestamp
/// - `mixed/crlf.log` — CRLF endings
/// - `mixed/missing_ts.log` — records without timestamps
/// - `noise/readme.txt` — non-log noise (should not dominate selection)
/// - `noise/icon.png` — binary attachment (PNG magic; must NOT start with `PK`)
/// - `noise/.hidden.log` — hidden path noise
/// - `bad/truncated.log` — short partial line (still readable)
/// - `bad/garbage.bin` — binary noise without zip magic (honest exclusion)
/// - `dup/dup.log` — duplicate identical lines
/// - `long/long.log` — one very long record + normal neighbors
/// - `bulk/stream.log` — bounded large stream
///
/// **Not** in the green archive: a truncated/corrupt nested `*.zip` member.
/// On this tip, nested members with zip extension/signature that fail open
/// abort the entire import (fail-closed, no partial corpus). That behaviour
/// is covered by [`corrupt_nested_zip_fails_closed_with_visible_error`].
fn build_adversarial_archive(root: &Path) -> PathBuf {
    let archive = root.join("public-acceptance-lab.zip");
    let file = std::fs::File::create(&archive).expect("create archive");
    let mut zip = zip::ZipWriter::new(file);
    fn put_bytes(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, body: &[u8]) {
        let opts = SimpleFileOptions::default();
        zip.start_file(name, opts).unwrap();
        zip.write_all(body).unwrap();
    }
    fn put_text(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, body: &str) {
        put_bytes(zip, name, body.as_bytes());
    }

    // --- duplicate basenames under different parents ---
    put_text(
        &mut zip,
        "svc-a/app.log",
        "2024-05-03T12:00:00Z ERROR [worker-a] QUEUE_STALL_A correlation=lab-1\n\
         2024-05-03T12:00:01Z INFO  [worker-a] recovered correlation=lab-1\n",
    );
    put_text(
        &mut zip,
        "svc-b/app.log",
        "2024-05-03T12:00:00Z ERROR [worker-b] QUEUE_STALL_B correlation=lab-2\n\
         2024-05-03T12:00:02Z WARN  [worker-b] backpressure correlation=lab-2\n",
    );

    // --- nested ZIP (complete valid inner archive as a member) ---
    let inner_bytes = {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut inner = zip::ZipWriter::new(cursor);
        inner
            .start_file("deep/app.log", SimpleFileOptions::default())
            .unwrap();
        inner
            .write_all(
                b"2024-05-03T13:00:00Z ERROR [nested] NESTED_SIGNAL deep=true\n\
                  2024-05-03T13:00:01Z INFO  [nested] nested ok\n",
            )
            .unwrap();
        inner.finish().unwrap().into_inner()
    };
    put_bytes(&mut zip, "nested/inner.zip", &inner_bytes);

    // --- mixed formats ---
    put_text(
        &mut zip,
        "mixed/jsonl.jsonl",
        concat!(
            r#"{"ts":"2024-05-03T14:00:00.000+00:00","level":"error","msg":"JSON_OFFSET_HIT"}"#,
            "\n",
            r#"{"ts":"2024-05-03T14:00:01.000+00:00","level":"info","msg":"json ok"}"#,
            "\n",
        ),
    );
    put_text(
        &mut zip,
        "mixed/local.log",
        "2024-05-03 15:24:22,729 INFO - LOCAL_WALL tick=1\n\
         2024-05-03 15:24:23,001 WARN - LOCAL_WALL tick=2\n",
    );
    put_text(
        &mut zip,
        "mixed/multiline.log",
        "2024-05-03T16:00:00Z ERROR MULTI_START boom\n\
         java.lang.IllegalStateException: demo\n\
         \tat com.example.Service.run(Service.java:42)\n\
         2024-05-03T16:00:01Z INFO MULTI_END recovered\n",
    );
    put_text(
        &mut zip,
        "mixed/crlf.log",
        "2024-05-03T17:00:00Z INFO CRLF_LINE_ONE\r\n\
         2024-05-03T17:00:01Z ERROR CRLF_LINE_TWO\r\n",
    );
    put_text(
        &mut zip,
        "mixed/missing_ts.log",
        "INFO no-ts-prefix still a line\nERROR MISSING_TS_SIGNAL bare\n",
    );

    // --- noise (no zip magic — PK* in member heads is treated as nested archive) ---
    put_text(
        &mut zip,
        "noise/readme.txt",
        "This is documentation, not a log stream.\n",
    );
    put_bytes(
        &mut zip,
        "noise/icon.png",
        b"\x89PNG\r\n\x1a\n\0synthetic-binary-not-a-log",
    );
    put_text(
        &mut zip,
        "noise/.hidden.log",
        "2024-05-03T18:00:00Z INFO hidden should be noise\n",
    );

    // --- truncated / partial readable ---
    put_text(
        &mut zip,
        "bad/truncated.log",
        "2024-05-03T19:00:00Z ERROR TRUNCATED_LINE incomplete",
    );

    // Binary garbage without zip signature (honest exclusion / non-log).
    put_bytes(
        &mut zip,
        "bad/garbage.bin",
        b"\x00\x01\x02\xff binary-noise-not-a-nested-zip",
    );

    // --- duplicates ---
    let mut dup = String::new();
    for _ in 0..5 {
        dup.push_str("2024-05-03T20:00:00Z INFO DUPLICATE_LINE same payload\n");
    }
    put_text(&mut zip, "dup/dup.log", &dup);

    // --- long record ---
    let long_msg = "X".repeat(8_000);
    put_text(
        &mut zip,
        "long/long.log",
        &format!(
            "2024-05-03T21:00:00Z INFO LONG_PREFIX\n\
             2024-05-03T21:00:01Z ERROR LONG_RECORD {long_msg}\n\
             2024-05-03T21:00:02Z INFO LONG_SUFFIX\n"
        ),
    );

    // --- bounded large stream ---
    let mut bulk = String::new();
    for i in 0..2_000 {
        bulk.push_str(&format!(
            "2024-05-03T22:00:00Z INFO BULK_LINE i={i} marker=BULK_LAB\n"
        ));
    }
    put_text(&mut zip, "bulk/stream.log", &bulk);

    let finished = zip.finish().unwrap();
    finished.sync_all().ok();
    drop(finished);
    let _ = std::fs::metadata(&archive).unwrap();
    archive
}

/// Outer archive that is valid but embeds a truncated nested zip member.
/// Product fail-closed: whole import errors; no corpus published.
fn build_corrupt_nested_archive(root: &Path) -> PathBuf {
    let archive = root.join("corrupt-nested-lab.zip");
    let file = std::fs::File::create(&archive).expect("create archive");
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default();
    zip.start_file("good/app.log", opts).unwrap();
    zip.write_all(b"2024-05-03T12:00:00Z ERROR GOOD_SIGNAL keep-me\n")
        .unwrap();
    zip.start_file("bad/broken-inner.zip", opts).unwrap();
    // Zip local-header magic → nested-archive path; truncated body → open fails.
    zip.write_all(b"PK\x03\x04truncated-not-a-valid-zip-body")
        .unwrap();
    let finished = zip.finish().unwrap();
    finished.sync_all().ok();
    drop(finished);
    archive
}

/// Oracle: minimum expectations for the green adversarial import.
/// Numbers are lower/upper bounds so generator tweaks don't require constant retuning,
/// but still fail closed on collapse/empty/silent-failure modes.
#[derive(Debug, Clone)]
struct ImportOracle {
    min_events: u64,
    min_selected: u64,
    max_failed: u64,
    /// At least one of these tokens must appear in explain-selection identities.
    required_identity_substrings: &'static [&'static str],
    /// Same basename must appear under ≥2 distinct identity strings.
    non_collapse_basename: &'static str,
    min_non_collapse_identities: usize,
    /// Provenance keys that must be present with count ≥ 1 when timezone default is applied later.
    expect_unresolved_local_at_import: bool,
    expect_explicit_or_offset_present: bool,
}

impl ImportOracle {
    fn green_adversarial() -> Self {
        Self {
            min_events: 30,
            min_selected: 8,
            max_failed: 5, // corrupt zip / partial may count as fail or unsupported
            required_identity_substrings: &[
                "svc-a/app.log",
                "svc-b/app.log",
                "mixed/jsonl.jsonl",
                "mixed/local.log",
                "bulk/stream.log",
            ],
            non_collapse_basename: "app.log",
            min_non_collapse_identities: 2,
            expect_unresolved_local_at_import: true,
            expect_explicit_or_offset_present: true,
        }
    }

    fn check(&self, import: &Value, selection: Option<&Value>) -> Result<(), String> {
        let data = import
            .get("data")
            .ok_or_else(|| "missing data".to_string())?;
        if import.get("ok") != Some(&json!(true)) {
            return Err(format!("import not ok: {import}"));
        }
        let events = data["events_imported"].as_u64().unwrap_or(0);
        if events < self.min_events {
            return Err(format!(
                "events_imported {events} < min {}",
                self.min_events
            ));
        }
        let selected = data["sources_selected"].as_u64().unwrap_or(0);
        if selected < self.min_selected {
            return Err(format!(
                "sources_selected {selected} < min {}",
                self.min_selected
            ));
        }
        let failed = data["sources_failed"].as_u64().unwrap_or(0);
        if failed > self.max_failed {
            return Err(format!("sources_failed {failed} > max {}", self.max_failed));
        }
        // Dual accounting fields must both exist (even if equal).
        if data.get("entries_examined").is_none() || data.get("discovered_files").is_none() {
            return Err("missing entries_examined or discovered_files".into());
        }
        let prov = data
            .get("timestamp_provenance")
            .and_then(|v| v.as_object())
            .ok_or_else(|| "missing timestamp_provenance".to_string())?;
        if self.expect_unresolved_local_at_import {
            let u = prov
                .get("unresolved_local")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if u == 0 {
                return Err("expected unresolved_local > 0 before/without TZ apply".into());
            }
        }
        if self.expect_explicit_or_offset_present {
            let explicit = prov
                .get("explicit_wall")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            // Offset-bearing JSON may land as explicit_wall; either is fine.
            if explicit == 0 && events > 0 {
                // still ok if most are order_only + unresolved — but we seeded offset JSON
                // require at least one non-unresolved provenance bucket with events
                let order = prov.get("order_only").and_then(|v| v.as_u64()).unwrap_or(0);
                if explicit == 0 && order == 0 {
                    return Err(format!("expected some wall/order provenance: {prov:?}"));
                }
            }
        }

        if let Some(sel) = selection {
            let items = sel
                .as_array()
                .ok_or_else(|| "selection not an array".to_string())?;
            let identities: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get("identity").and_then(|v| v.as_str()))
                .collect();
            for needle in self.required_identity_substrings {
                if !identities.iter().any(|id| id.contains(needle)) {
                    return Err(format!(
                        "selection missing identity containing {needle:?}; have {identities:?}"
                    ));
                }
            }
            let app_log_ids: Vec<&str> = identities
                .iter()
                .copied()
                .filter(|id| {
                    id.ends_with(self.non_collapse_basename)
                        || id.contains(&format!("/{}", self.non_collapse_basename))
                })
                .collect();
            // Distinct full identities (not basenames).
            let mut unique = app_log_ids.clone();
            unique.sort_unstable();
            unique.dedup();
            if unique.len() < self.min_non_collapse_identities {
                return Err(format!(
                    "identity collapse: only {} distinct identities for {}: {unique:?}",
                    unique.len(),
                    self.non_collapse_basename
                ));
            }
        }

        // Failures/exclusions must not be silently zero when we injected bad/noise
        // (at least ignored or unsupported should be non-zero for our matrix).
        let ignored = data["sources_ignored"].as_u64().unwrap_or(0);
        let unsupported = data["sources_unsupported"].as_u64().unwrap_or(0);
        let excluded = data["sources_excluded"].as_u64().unwrap_or(0);
        if ignored + unsupported + excluded + failed == 0 {
            return Err(
                "noise/binary/corrupt injects produced zero ignored+unsupported+excluded+failed"
                    .into(),
            );
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Green lab path
// ---------------------------------------------------------------------------

#[test]
fn public_adversarial_import_oracle_passes() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    init_timezone_only(&data_dir, "America/Chicago");
    let archive = build_adversarial_archive(root.path());

    let import = cli(&data_dir)
        .args([
            "--json",
            "import",
            archive.to_str().unwrap(),
            "--explain-selection",
        ])
        .output()
        .expect("import");
    assert!(
        import.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&import.stdout),
        String::from_utf8_lossy(&import.stderr)
    );
    let env = parse_envelope(&import.stdout);
    let selection = env["data"].get("selection");
    ImportOracle::green_adversarial()
        .check(&env, selection)
        .expect("green oracle");

    // Progress must have been on stderr, not mixed into JSON stdout.
    let stdout = String::from_utf8_lossy(&import.stdout);
    assert!(
        !stdout.contains("Streaming read"),
        "progress leaked onto stdout"
    );
}

#[tokio::test]
async fn full_path_import_timezone_explore_context_dry_run_mock_chat_two_turns() {
    let server = MockServer::start().await;
    let counter = Arc::new(AtomicUsize::new(0));
    let captured = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(LabTwoTurnProvider {
            call: counter.clone(),
            captured: captured.clone(),
        })
        .mount(&server)
        .await;

    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server.uri();
    profile.local_only = true;
    profile.chat_model = "lab-mock".into();
    profile.capabilities.embeddings = false;
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        default_timezone: Some("America/Chicago".into()),
        ..AppConfig::default()
    };
    write_app_config(&data_dir, &cfg);

    let archive = build_adversarial_archive(root.path());
    let import = cli(&data_dir)
        .args([
            "--json",
            "import",
            archive.to_str().unwrap(),
            "--explain-selection",
        ])
        .output()
        .expect("import");
    assert!(
        import.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&import.stderr)
    );
    let import_env = parse_envelope(&import.stdout);
    ImportOracle::green_adversarial()
        .check(&import_env, import_env["data"].get("selection"))
        .expect("import oracle");
    let corpus_id = import_env["data"]["corpus_id"]
        .as_str()
        .expect("corpus_id")
        .to_string();
    let events = import_env["data"]["events_imported"].as_u64().unwrap();

    // Timezone: seeded local wall clocks must resolve under America/Chicago.
    let tz = cli(&data_dir)
        .args(["--json", "timezone", "status", "--corpus", &corpus_id])
        .output()
        .expect("timezone status");
    assert!(
        tz.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&tz.stderr)
    );
    let tz_env = parse_envelope(&tz.stdout);
    assert_timezone_local_resolved(&tz_env, &corpus_id)
        .expect("timezone oracle after default zone");

    // Explore bound to current corpus (import set CLI current).
    let explore = cli(&data_dir)
        .args(["--json", "explore", "QUEUE_STALL_A"])
        .output()
        .expect("explore");
    assert!(
        explore.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&explore.stderr)
    );
    let explore_env = parse_envelope(&explore.stdout);
    assert_eq!(explore_env["data"]["corpus_id"], corpus_id);
    let hits = explore_env["data"]["hits"].as_array().expect("hits");
    assert!(
        !hits.is_empty(),
        "explore must find seeded token QUEUE_STALL_A: {explore_env}"
    );

    // Context: non-empty evidence bound to exact corpus.
    let context = cli(&data_dir)
        .args(["--json", "context", "NESTED_SIGNAL", "--corpus", &corpus_id])
        .output()
        .expect("context");
    assert!(
        context.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&context.stderr)
    );
    let context_env = parse_envelope(&context.stdout);
    assert_context_evidence(&context_env, &corpus_id).expect("context oracle");

    // Dry-run trace: zero provider HTTP (counter must stay 0).
    let dry = cli(&data_dir)
        .args([
            "--jsonl",
            "chat",
            "summarize QUEUE_STALL without contacting a model",
            "--dry-run",
            "--trace",
            "summary",
            "--corpus",
            &corpus_id,
            "--new",
        ])
        .output()
        .expect("dry-run chat");
    // Dry-run may exit 0 with linked_no_tool (honest) or complete with dry_run backend.
    let dry_lines = jsonl(&dry.stdout);
    assert!(
        !dry_lines.is_empty(),
        "dry-run must emit JSONL lines, not empty stdout"
    );
    assert_eq!(
        dry_lines.last().and_then(|l| l["type"].as_str()),
        Some("done"),
        "dry-run last line must be done: {dry_lines:#?}"
    );
    if let Some(summary) = dry_lines.iter().find(|l| l["type"] == "trace_summary") {
        assert_eq!(summary["dry_run"], true);
        assert_eq!(summary["corpus_id"], corpus_id);
    }
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "dry-run must not call the mock provider"
    );

    // Session list after dry-run must not invent a durable session.
    let sessions_after_dry = cli(&data_dir)
        .args(["--json", "session", "list"])
        .output()
        .expect("session list");
    let sess_env = parse_envelope(&sessions_after_dry.stdout);
    let n = sess_env["data"]["sessions"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(n, 0, "dry-run must not persist sessions: {sess_env}");

    // Live mock native-tool chat: two strictly grounded turns, same session.
    let first_prompt = format!("{FIRST_TURN_MARKER}: Find QUEUE_STALL_A and cite its source path.");
    let first = cli(&data_dir)
        .args([
            "--jsonl",
            "chat",
            &first_prompt,
            "--new",
            "--trace",
            "full",
            "--trace-ack",
            "--corpus",
            &corpus_id,
        ])
        .output()
        .expect("first chat");
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let first_lines = jsonl(&first.stdout);
    let (session_id, corpus_revision) =
        assert_strict_grounded_tool_turn(&first_lines, &corpus_id, None)
            .expect("first grounded turn");

    let second_prompt =
        format!("{SECOND_TURN_MARKER}: Now find QUEUE_STALL_B under the other parent.");
    let second = cli(&data_dir)
        .args([
            "--jsonl",
            "chat",
            &second_prompt,
            "--trace",
            "full",
            "--trace-ack",
            "--session",
            &session_id,
        ])
        .output()
        .expect("second chat");
    assert!(
        second.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&second.stdout),
        String::from_utf8_lossy(&second.stderr)
    );
    let second_lines = jsonl(&second.stdout);
    let (session_id2, revision2) =
        assert_strict_grounded_tool_turn(&second_lines, &corpus_id, Some(corpus_revision))
            .expect("second grounded turn");
    assert_eq!(session_id2, session_id);
    assert_eq!(revision2, corpus_revision);
    assert!(
        counter.load(Ordering::SeqCst) >= 4,
        "two tool+synthesis rounds require ≥4 provider calls; got {}",
        counter.load(Ordering::SeqCst)
    );

    // Conversation continuity: a second-turn provider request must include the
    // first user turn and prior assistant/tool context — not only the new prompt.
    let received = server.received_requests().await.expect("received requests");
    assert_provider_history_continuity(&received, FIRST_TURN_MARKER, SECOND_TURN_MARKER)
        .expect("provider history continuity");

    // Durable two-turn session.
    let show = cli(&data_dir)
        .args(["--json", "session", "show", &session_id])
        .output()
        .expect("session show");
    assert!(show.status.success());
    let show_env = parse_envelope(&show.stdout);
    let messages = show_env["data"]["messages"].as_array().expect("messages");
    let user_turns = messages.iter().filter(|m| m["role"] == "user").count();
    assert!(
        user_turns >= 2,
        "two-turn session must retain both user messages: {show_env}"
    );
    assert!(
        messages.iter().any(|m| {
            m["role"] == "user"
                && m["content"]
                    .as_str()
                    .is_some_and(|t| t.contains(FIRST_TURN_MARKER))
        }),
        "session must retain first-turn marker: {show_env}"
    );

    // Reopen consistency: corpus still has same event count.
    let list = cli(&data_dir)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("corpus list");
    let list_env = parse_envelope(&list.stdout);
    let corpora = list_env["data"]["corpora"].as_array().unwrap();
    let entry = corpora
        .iter()
        .find(|c| c["id"] == corpus_id)
        .expect("corpus present after reopen");
    assert_eq!(entry["event_count"].as_u64().unwrap(), events);

    // Isolation: a second data-dir must not see this corpus.
    let other = root.path().join("other-data");
    std::fs::create_dir_all(&other).unwrap();
    init_timezone_only(&other, "UTC");
    let other_list = cli(&other)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("other list");
    let other_env = parse_envelope(&other_list.stdout);
    let other_corpora = other_env["data"]["corpora"].as_array().unwrap();
    assert!(
        other_corpora.iter().all(|c| c["id"] != corpus_id),
        "isolated data-dir must not observe another profile's corpus"
    );
}

/// Strict live mock-chat oracle. Vacuous paths (tool_names only, attempted
/// tools, ungrounded-with-evidence, empty final_text) fail closed.
fn check_strict_grounded_tool_turn(
    lines: &[Value],
    corpus_id: &str,
    expected_revision: Option<u64>,
) -> Result<(String /*session_id*/, u64 /*corpus_revision*/), String> {
    if lines.iter().any(|l| l["type"] == "error") {
        return Err(format!("turn emitted an error line: {lines:#?}"));
    }
    let done = lines
        .last()
        .ok_or_else(|| "missing terminal line".to_string())?;
    if done["type"] != "done" {
        return Err(format!("last line must be done: {done}"));
    }
    if done["ok"] != true {
        return Err(format!("done.ok must be true: {done}"));
    }
    let final_text = done["final_text"].as_str().unwrap_or("");
    if final_text.trim().is_empty() {
        return Err(format!("done.final_text must be non-empty: {done}"));
    }
    // Finished tool line only — Started events are not emitted as tool lines.
    let finished_search_ok = lines
        .iter()
        .any(|line| line["type"] == "tool" && line["name"] == "search_logs" && line["ok"] == true);
    if !finished_search_ok {
        return Err(format!(
            "need finished search_logs tool line with ok=true (tool_names alone is not enough): {lines:#?}"
        ));
    }
    if lines
        .iter()
        .filter(|line| line["type"] == "tool")
        .any(|line| line["ok"] != true)
    {
        return Err(format!("all tool lines must be ok: {lines:#?}"));
    }
    let summary = lines
        .iter()
        .find(|l| l["type"] == "trace_summary")
        .ok_or_else(|| format!("missing trace_summary: {lines:#?}"))?;
    if summary["grounding"] != "grounded" {
        return Err(format!(
            "grounding must be exactly grounded, not {:?}: {summary}",
            summary["grounding"]
        ));
    }
    if summary["corpus_id"] != corpus_id {
        return Err(format!(
            "corpus_id mismatch: want {corpus_id}, summary={summary}"
        ));
    }
    if summary["dry_run"] != false {
        return Err(format!("live turn dry_run must be false: {summary}"));
    }
    let revision = summary["corpus_revision"]
        .as_u64()
        .ok_or_else(|| format!("corpus_revision missing: {summary}"))?;
    if let Some(expected) = expected_revision {
        if revision != expected {
            return Err(format!(
                "corpus_revision drift: want {expected}, got {revision}"
            ));
        }
    }
    let session_id = done["session_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("session_id missing on done: {done}"))?
        .to_string();
    Ok((session_id, revision))
}

fn assert_strict_grounded_tool_turn(
    lines: &[Value],
    corpus_id: &str,
    expected_revision: Option<u64>,
) -> Result<(String, u64), String> {
    check_strict_grounded_tool_turn(lines, corpus_id, expected_revision)
}

fn assert_context_evidence(env: &Value, corpus_id: &str) -> Result<(), String> {
    if env.get("ok") != Some(&json!(true)) {
        return Err(format!("context not ok: {env}"));
    }
    let data = env
        .get("data")
        .ok_or_else(|| format!("context missing data: {env}"))?;
    if data.get("corpus_id") != Some(&json!(corpus_id)) {
        return Err(format!("context corpus_id must be {corpus_id}: {data}"));
    }
    let evidence = data
        .get("evidence")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("context.evidence must be an array: {data}"))?;
    if evidence.is_empty() {
        return Err(format!("context.evidence must be non-empty: {data}"));
    }
    Ok(())
}

fn assert_timezone_local_resolved(env: &Value, corpus_id: &str) -> Result<(), String> {
    if env.get("ok") != Some(&json!(true)) {
        return Err(format!("timezone status not ok: {env}"));
    }
    let data = env
        .get("data")
        .ok_or_else(|| format!("timezone missing data: {env}"))?;
    if data.get("corpus_id") != Some(&json!(corpus_id)) {
        return Err(format!("timezone corpus_id mismatch: {data}"));
    }
    let sources = data
        .get("sources")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("timezone.sources missing: {data}"))?;
    let local = sources.iter().find(|s| {
        s.get("source")
            .and_then(|v| v.as_str())
            .is_some_and(|id| id.contains("mixed/local.log"))
    });
    let local = local.ok_or_else(|| {
        format!("seeded mixed/local.log missing from timezone sources: {sources:?}")
    })?;
    let resolved = local["resolved_local_records"].as_u64().unwrap_or(0);
    if resolved == 0 {
        return Err(format!(
            "mixed/local.log must have resolved_local_records > 0 (not vacuous zero/zero): {local}"
        ));
    }
    Ok(())
}

/// Prove second-turn provider traffic carries first-turn user + assistant/tool
/// history. Selecting the second query from the new prompt alone is insufficient.
fn assert_provider_history_continuity_bodies(
    bodies: &[Value],
    first_marker: &str,
    second_marker: &str,
) -> Result<(), String> {
    if bodies.is_empty() {
        return Err("no provider request bodies captured".into());
    }
    // A continuity-bearing request must include BOTH user markers and some
    // prior assistant or tool role from the first turn.
    let continuous = bodies.iter().find(|body| {
        let msgs = match body.get("messages").and_then(|m| m.as_array()) {
            Some(m) => m,
            None => return false,
        };
        let mut has_first = false;
        let mut has_second = false;
        let mut has_prior_assistant_or_tool = false;
        for m in msgs {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
            let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
            if role == "user" && content.contains(first_marker) {
                has_first = true;
            }
            if role == "user" && content.contains(second_marker) {
                has_second = true;
            }
            if role == "assistant" || role == "tool" {
                // Prior tool/assistant from first turn (not just empty shells).
                if !content.is_empty()
                    || m.get("tool_calls").is_some()
                    || m.get("tool_call_id").is_some()
                {
                    has_prior_assistant_or_tool = true;
                }
            }
        }
        has_first && has_second && has_prior_assistant_or_tool
    });
    if continuous.is_none() {
        return Err(format!(
            "no provider request contained first-turn user ({first_marker}), \
             second-turn user ({second_marker}), and prior assistant/tool context; \
             bodies={bodies:#?}"
        ));
    }
    Ok(())
}

fn assert_provider_history_continuity(
    requests: &[wiremock::Request],
    first_marker: &str,
    second_marker: &str,
) -> Result<(), String> {
    let mut bodies = Vec::new();
    for req in requests {
        let body: Value = serde_json::from_slice(&req.body)
            .map_err(|e| format!("provider body not JSON: {e}"))?;
        bodies.push(body);
    }
    assert_provider_history_continuity_bodies(&bodies, first_marker, second_marker)
}

#[derive(Clone)]
struct LabTwoTurnProvider {
    call: Arc<AtomicUsize>,
    /// Captured request bodies for continuity assertions (also available via MockServer).
    captured: Arc<Mutex<Vec<Value>>>,
}

impl Respond for LabTwoTurnProvider {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let n = self.call.fetch_add(1, Ordering::SeqCst);
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(json!({}));
        if let Ok(mut guard) = self.captured.lock() {
            guard.push(body.clone());
        }
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        // Host injects tool results as a *user* message containing HOST-RETURNED /
        // UNTRUSTED_DATA (not always role=tool). Detect that for synthesis.
        let last_content = messages
            .last()
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let last_role = messages
            .last()
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .unwrap_or("");
        let host_returned_evidence = last_role == "tool"
            || last_content.contains("HOST-RETURNED BOUNDED EVIDENCE")
            || last_content.contains("UNTRUSTED_DATA");
        // Continuity-independent query pick: first live tool call → A; later → B.
        // (Count completed tool rounds from host-returned evidence blocks.)
        let evidence_blocks = messages
            .iter()
            .filter(|m| {
                m.get("content")
                    .and_then(|c| c.as_str())
                    .is_some_and(|t| t.contains("HOST-RETURNED BOUNDED EVIDENCE"))
            })
            .count();
        let (query, source, seq) = if evidence_blocks == 0 && !host_returned_evidence {
            ("QUEUE_STALL_A", "svc-a/app.log", 0u64)
        } else if host_returned_evidence && evidence_blocks <= 1 {
            // Synthesizing first tool result → cite A at seq=0 from matrix.
            ("QUEUE_STALL_A", "svc-a/app.log", 0u64)
        } else {
            // Second tool path / second synthesis → B.
            ("QUEUE_STALL_B", "svc-b/app.log", 2u64)
        };
        let response = if host_returned_evidence {
            // Grounded answer must include exact seq=… source="…" pairs from evidence.
            json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": format!(
                            "{query} observed at seq={seq} source=\"{source}\"."
                        )
                    }
                }]
            })
        } else {
            json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": format!("lab-call-{n}"),
                            "type": "function",
                            "function": {
                                "name": "search_logs",
                                "arguments": {
                                    "query": query,
                                    "semantic": false,
                                    "k": 5
                                }
                            }
                        }]
                    }
                }]
            })
        };
        if body["stream"] == true {
            let (delta, finish_reason) = if host_returned_evidence {
                (
                    json!({"content": format!(
                        "{query} observed at seq={seq} source=\"{source}\"."
                    )}),
                    "stop",
                )
            } else {
                (
                    json!({"tool_calls": [{
                        "index": 0,
                        "id": format!("lab-call-{n}"),
                        "type": "function",
                        "function": {
                            "name": "search_logs",
                            "arguments": serde_json::to_string(&json!({
                                "query": query,
                                "semantic": false,
                                "k": 5
                            })).unwrap()
                        }
                    }]}),
                    "tool_calls",
                )
            };
            let chunk = json!({"choices": [{"index": 0, "delta": delta}]});
            let stop = json!({
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]
            });
            return ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(
                    format!("data: {chunk}\n\ndata: {stop}\n\ndata: [DONE]\n\n"),
                    "text/event-stream",
                );
        }
        ResponseTemplate::new(200)
            .insert_header("content-type", "application/json")
            .set_body_json(response)
    }
}

// ---------------------------------------------------------------------------
// Mutation oracles — must fail closed (prove lab is non-vacuous)
// ---------------------------------------------------------------------------

#[test]
fn mutation_strict_chat_rejects_tool_names_only_without_finished_tool() {
    let lines = vec![
        json!({
            "type": "trace_summary",
            "grounding": "grounded",
            "corpus_id": "c1",
            "corpus_revision": 1,
            "dry_run": false,
            "tool_names": ["search_logs"],
            "retrieved_evidence": 0
        }),
        json!({
            "type": "done",
            "ok": true,
            "session_id": "s1",
            "final_text": "something"
        }),
    ];
    let err = check_strict_grounded_tool_turn(&lines, "c1", None)
        .expect_err("tool_names alone must not pass");
    assert!(
        err.contains("search_logs") || err.contains("finished"),
        "unexpected: {err}"
    );
}

#[test]
fn mutation_strict_chat_rejects_ungrounded_even_with_tool_ok() {
    let lines = vec![
        json!({"type": "tool", "name": "search_logs", "ok": true, "summary": "hit"}),
        json!({
            "type": "trace_summary",
            "grounding": "ungrounded",
            "corpus_id": "c1",
            "corpus_revision": 1,
            "dry_run": false,
            "tool_names": ["search_logs"],
            "retrieved_evidence": 1
        }),
        json!({
            "type": "done",
            "ok": true,
            "session_id": "s1",
            "final_text": "answer"
        }),
    ];
    let err =
        check_strict_grounded_tool_turn(&lines, "c1", None).expect_err("ungrounded must fail");
    assert!(err.contains("grounded"), "unexpected: {err}");
}

#[test]
fn mutation_strict_chat_rejects_empty_final_text() {
    let lines = vec![
        json!({"type": "tool", "name": "search_logs", "ok": true}),
        json!({
            "type": "trace_summary",
            "grounding": "grounded",
            "corpus_id": "c1",
            "corpus_revision": 2,
            "dry_run": false
        }),
        json!({
            "type": "done",
            "ok": true,
            "session_id": "s1",
            "final_text": "   "
        }),
    ];
    let err = check_strict_grounded_tool_turn(&lines, "c1", None)
        .expect_err("empty final_text must fail");
    assert!(err.contains("final_text"), "unexpected: {err}");
}

#[test]
fn mutation_strict_chat_rejects_error_line_and_wrong_corpus() {
    let with_error = vec![
        json!({"type": "error", "code": "linked_x", "message": "nope"}),
        json!({"type": "tool", "name": "search_logs", "ok": true}),
        json!({
            "type": "trace_summary",
            "grounding": "grounded",
            "corpus_id": "c1",
            "corpus_revision": 1,
            "dry_run": false
        }),
        json!({
            "type": "done",
            "ok": true,
            "session_id": "s1",
            "final_text": "answer"
        }),
    ];
    let err =
        check_strict_grounded_tool_turn(&with_error, "c1", None).expect_err("error line must fail");
    assert!(err.contains("error"), "unexpected: {err}");

    let wrong_corpus = vec![
        json!({"type": "tool", "name": "search_logs", "ok": true}),
        json!({
            "type": "trace_summary",
            "grounding": "grounded",
            "corpus_id": "other",
            "corpus_revision": 1,
            "dry_run": false
        }),
        json!({
            "type": "done",
            "ok": true,
            "session_id": "s1",
            "final_text": "answer"
        }),
    ];
    let err = check_strict_grounded_tool_turn(&wrong_corpus, "c1", None)
        .expect_err("wrong corpus must fail");
    assert!(err.contains("corpus_id"), "unexpected: {err}");
}

#[test]
fn mutation_strict_chat_rejects_done_not_ok() {
    let lines = vec![
        json!({"type": "tool", "name": "search_logs", "ok": true}),
        json!({
            "type": "trace_summary",
            "grounding": "grounded",
            "corpus_id": "c1",
            "corpus_revision": 1,
            "dry_run": false
        }),
        json!({
            "type": "done",
            "ok": false,
            "session_id": "s1",
            "final_text": "answer"
        }),
    ];
    let err =
        check_strict_grounded_tool_turn(&lines, "c1", None).expect_err("done.ok=false must fail");
    assert!(err.contains("done.ok"), "unexpected: {err}");
}

#[test]
fn mutation_context_rejects_empty_evidence_or_wrong_corpus() {
    let empty = json!({
        "ok": true,
        "data": {"corpus_id": "c1", "evidence": [], "query": "x"}
    });
    let err = assert_context_evidence(&empty, "c1").expect_err("empty evidence");
    assert!(err.contains("non-empty"), "unexpected: {err}");

    let wrong = json!({
        "ok": true,
        "data": {
            "corpus_id": "other",
            "evidence": [{"citation_id": "log_event:0"}],
            "query": "x"
        }
    });
    let err = assert_context_evidence(&wrong, "c1").expect_err("wrong corpus");
    assert!(err.contains("corpus_id"), "unexpected: {err}");
}

#[test]
fn mutation_timezone_rejects_zero_resolved_local() {
    let vacuous = json!({
        "ok": true,
        "data": {
            "corpus_id": "c1",
            "sources": [{
                "source": "mixed/local.log",
                "resolved_local_records": 0,
                "unresolved_local_records": 0
            }]
        }
    });
    let err = assert_timezone_local_resolved(&vacuous, "c1").expect_err("zero resolved");
    assert!(err.contains("resolved_local"), "unexpected: {err}");
}

#[test]
fn mutation_provider_continuity_rejects_second_prompt_only() {
    // Body that only has the second-turn user marker — not continuity.
    let only_second = json!({
        "messages": [
            {"role": "user", "content": format!("{SECOND_TURN_MARKER} only")}
        ]
    });
    let err = assert_provider_history_continuity_bodies(
        &[only_second],
        FIRST_TURN_MARKER,
        SECOND_TURN_MARKER,
    )
    .expect_err("second prompt alone is not continuity");
    assert!(
        err.contains("first-turn") || err.contains(FIRST_TURN_MARKER),
        "unexpected: {err}"
    );

    // First + second user but no assistant/tool prior context — still not continuity.
    let users_only = json!({
        "messages": [
            {"role": "user", "content": format!("{FIRST_TURN_MARKER} first")},
            {"role": "user", "content": format!("{SECOND_TURN_MARKER} second")}
        ]
    });
    let err = assert_provider_history_continuity_bodies(
        &[users_only],
        FIRST_TURN_MARKER,
        SECOND_TURN_MARKER,
    )
    .expect_err("users without assistant/tool is not continuity");
    assert!(
        err.contains("assistant") || err.contains("tool") || err.contains("first-turn"),
        "unexpected: {err}"
    );
}

#[test]
fn mutation_oracle_rejects_zero_selected_as_green_success() {
    let fake = json!({
        "ok": true,
        "data": {
            "events_imported": 100,
            "sources_selected": 0,
            "sources_failed": 0,
            "sources_ignored": 0,
            "sources_unsupported": 0,
            "sources_excluded": 0,
            "entries_examined": 10,
            "discovered_files": 10,
            "timestamp_provenance": {"unresolved_local": 1}
        }
    });
    let err = ImportOracle::green_adversarial()
        .check(&fake, None)
        .expect_err("zero selected must fail oracle");
    assert!(err.contains("sources_selected"), "unexpected err: {err}");
}

#[test]
fn mutation_oracle_rejects_identity_collapse() {
    let import = json!({
        "ok": true,
        "data": {
            "events_imported": 50,
            "sources_selected": 10,
            "sources_failed": 0,
            "sources_ignored": 1,
            "sources_unsupported": 0,
            "sources_excluded": 0,
            "entries_examined": 20,
            "discovered_files": 20,
            "timestamp_provenance": {"unresolved_local": 2, "explicit_wall": 1}
        }
    });
    // Missing svc-b/app.log entirely → required identity substring fails.
    let selection = json!([
        {"identity": "svc-a/app.log", "selected": true},
        {"identity": "mixed/jsonl.jsonl", "selected": true},
        {"identity": "mixed/local.log", "selected": true},
        {"identity": "bulk/stream.log", "selected": true}
    ]);
    let err = ImportOracle::green_adversarial()
        .check(&import, Some(&selection))
        .expect_err("must fail missing required identity or collapse");
    assert!(
        err.contains("identity") || err.contains("svc-b") || err.contains("missing"),
        "unexpected: {err}"
    );
}

#[test]
fn mutation_oracle_rejects_silent_all_success_with_no_noise_accounting() {
    let fake = json!({
        "ok": true,
        "data": {
            "events_imported": 50,
            "sources_selected": 12,
            "sources_failed": 0,
            "sources_ignored": 0,
            "sources_unsupported": 0,
            "sources_excluded": 0,
            "entries_examined": 12,
            "discovered_files": 12,
            "timestamp_provenance": {"unresolved_local": 2, "explicit_wall": 1}
        }
    });
    let err = ImportOracle::green_adversarial()
        .check(&fake, None)
        .expect_err("all-zero noise accounting must fail for our matrix");
    assert!(
        err.contains("ignored") || err.contains("unsupported") || err.contains("noise"),
        "unexpected: {err}"
    );
}

#[test]
fn empty_source_cannot_vacuously_pass_as_green_import() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    init_timezone_only(&data_dir, "UTC");
    let empty = root.path().join("empty-dir");
    std::fs::create_dir_all(&empty).unwrap();

    let import = cli(&data_dir)
        .args(["--json", "import", empty.to_str().unwrap()])
        .output()
        .expect("import empty");
    // Must not succeed with green oracle metrics.
    if import.status.success() {
        let env = parse_envelope(&import.stdout);
        let check = ImportOracle::green_adversarial().check(&env, None);
        assert!(
            check.is_err(),
            "empty import must not satisfy green oracle: {env}"
        );
    }
    // Prefer fail-closed at CLI: either non-zero exit or oracle failure.
}

#[test]
fn noise_only_archive_does_not_satisfy_min_selected_oracle() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    init_timezone_only(&data_dir, "UTC");

    let archive = root.path().join("noise-only.zip");
    {
        let file = std::fs::File::create(&archive).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        zip.start_file("docs/readme.txt", opts).unwrap();
        writeln!(zip, "not a log").unwrap();
        zip.start_file("img/photo.png", opts).unwrap();
        zip.write_all(b"\x89PNG\r\n\x1a\n\0").unwrap();
        zip.finish().unwrap();
    }

    let import = cli(&data_dir)
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("import noise");
    if import.status.success() {
        let env = parse_envelope(&import.stdout);
        let check = ImportOracle::green_adversarial().check(&env, None);
        assert!(
            check.is_err(),
            "noise-only archive must not pass green oracle: {env}"
        );
        // Honest accounting: not a silent "all selected".
        let selected = env["data"]["sources_selected"].as_u64().unwrap_or(0);
        let events = env["data"]["events_imported"].as_u64().unwrap_or(0);
        assert!(
            selected < 8 || events < 30,
            "noise-only should not look like a full useful import: {env}"
        );
    }
}

/// Confirmed product behaviour on this tip: a truncated nested zip member
/// (zip magic / `*.zip`) fails the **entire** import — no partial corpus of
/// the sibling good logs. Visible error; not a silent success.
#[test]
fn corrupt_nested_zip_fails_closed_with_visible_error() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    init_timezone_only(&data_dir, "UTC");
    let archive = build_corrupt_nested_archive(root.path());

    let import = cli(&data_dir)
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("import corrupt-nested");
    assert!(
        !import.status.success(),
        "corrupt nested zip must not succeed: stdout={}",
        String::from_utf8_lossy(&import.stdout)
    );
    let env = parse_envelope(&import.stdout);
    assert_eq!(env["ok"], false, "envelope={env}");
    let msg = env["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("zip") || msg.contains("end record") || msg.contains("open"),
        "error must mention zip open failure: {env}"
    );

    // No corpus published (atomic fail-closed).
    let list = cli(&data_dir)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("corpus list");
    let list_env = parse_envelope(&list.stdout);
    let corpora = list_env["data"]["corpora"].as_array().unwrap();
    assert!(
        corpora.is_empty(),
        "fail-closed must publish zero corpora: {list_env}"
    );
}

/// Large public archive sized so SIGINT can land during streaming ingest.
#[cfg(unix)] // sole user is the cfg(unix) cancel test below
fn build_cancellable_bulk_archive(root: &Path) -> PathBuf {
    let archive = root.join("cancellable-bulk.zip");
    let file = std::fs::File::create(&archive).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("bulk/cancel-me.log", SimpleFileOptions::default())
        .unwrap();
    // ~80k lines: same order of magnitude as import_production_cli cancel test.
    let mut body = String::with_capacity(80_000 * 40);
    for i in 0..80_000 {
        body.push_str(&format!("2024-01-01T00:00:00Z INFO cancel-bulk line {i}\n"));
    }
    zip.write_all(body.as_bytes()).unwrap();
    let finished = zip.finish().unwrap();
    finished.sync_all().ok();
    drop(finished);
    archive
}

/// Deterministic cancel: must reach a cancellable stream phase, deliver SIGINT,
/// observe non-success/cancel on the first command, publish no partial corpus,
/// then retry to exactly one valid corpus.
#[cfg(unix)] // sends POSIX SIGINT via kill(1); no Windows equivalent here
#[test]
fn cancel_then_retry_publishes_exactly_one_corpus() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    init_timezone_only(&data_dir, "UTC");
    let archive = build_cancellable_bulk_archive(root.path());

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut child = std::process::Command::new(&bin)
        .args([
            "--data-dir",
            data_dir.to_str().unwrap(),
            "import",
            archive.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn import");

    let mut stderr_reader = BufReader::new(child.stderr.take().expect("piped stderr"));
    let mut saw_stream = false;
    let mut early = String::new();
    for _ in 0..4_000 {
        let mut line = String::new();
        match stderr_reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                early.push_str(&line);
                if line.contains("Streaming") || line.contains("files=") {
                    saw_stream = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        saw_stream,
        "import must reach a cancellable stream phase before SIGINT; stderr so far: {early:?}"
    );

    let pid = child.id();
    let kill_status = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(
        kill_status.success(),
        "kill -INT must be delivered to pid {pid}"
    );

    let mut rest = String::new();
    std::io::Read::read_to_string(&mut stderr_reader, &mut rest).ok();
    let status = child.wait().expect("wait for cancelled import");
    let stderr = format!("{early}{rest}");
    // Fail closed if the child finished successfully before cancel landed —
    // that would make this test claim cancellation coverage vacuously.
    assert_ne!(
        status.code(),
        Some(0),
        "first import must not succeed after SIGINT (non-deterministic finish-first is not cancel coverage); stderr={stderr}"
    );
    assert!(
        status.code() == Some(130) || stderr.to_lowercase().contains("cancel") || !status.success(),
        "cancelled import must report cancel/non-success: code={:?} stderr={stderr}",
        status.code()
    );
    if status.code() == Some(130) {
        assert!(
            stderr.to_lowercase().contains("cancel"),
            "exit 130 must mention cancel on stderr: {stderr}"
        );
    }

    // No partial corpus published after cancel.
    let list_after_cancel = cli(&data_dir)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("corpus list after cancel");
    let list_env = parse_envelope(&list_after_cancel.stdout);
    let corpora = list_env["data"]["corpora"].as_array().unwrap();
    assert!(
        corpora.is_empty(),
        "cancel must publish zero corpora: {list_env}"
    );

    // Retry publishes exactly one valid corpus.
    let retry = cli(&data_dir)
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("retry import");
    assert!(
        retry.status.success(),
        "retry after cancel must succeed: stderr={}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let env = parse_envelope(&retry.stdout);
    assert_eq!(env["ok"], true);
    assert!(
        env["data"]["events_imported"].as_u64().unwrap_or(0) > 0,
        "retry must import events: {env}"
    );

    let list = cli(&data_dir)
        .args(["--json", "corpus", "list"])
        .output()
        .expect("corpus list after retry");
    let list_env = parse_envelope(&list.stdout);
    let corpora = list_env["data"]["corpora"].as_array().unwrap();
    assert_eq!(
        corpora.len(),
        1,
        "exactly one corpus after cancel-then-retry: {list_env}"
    );
}
