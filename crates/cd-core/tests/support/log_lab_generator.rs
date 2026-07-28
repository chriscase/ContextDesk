#![allow(dead_code)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

#[path = "log_lab_behavior.rs"]
mod log_lab_behavior;
pub use log_lab_behavior::*;

pub type LabResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub const TRUTH_SCHEMA_VERSION: u32 = 1;
pub const GENERATOR_VERSION: &str = "contextdesk.log_lab.generator.v1";
pub const FIXED_SEED: u64 = 52_620_260_725;
pub const SMALL_PROFILE: &str = "small";
pub const MEDIUM_PROFILE: &str = "medium";
pub const LARGE_PROFILE: &str = "large";
pub const MEDIUM_EVENT_COUNT: usize = 100_000;
pub const DEFAULT_LARGE_EVENT_COUNT: usize = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationSummary {
    pub profile: String,
    pub files: usize,
    pub events: usize,
    pub bytes: u64,
    pub tree_sha256: String,
}

#[derive(Debug, Clone)]
struct ImportFile {
    path: String,
    bytes: Vec<u8>,
    event_count: u64,
}

impl ImportFile {
    fn text(path: &str, lines: &[String]) -> Self {
        let mut body = lines.join("\n").into_bytes();
        body.push(b'\n');
        Self {
            path: path.to_string(),
            bytes: body,
            event_count: lines.len() as u64,
        }
    }

    fn bytes(path: &str, bytes: Vec<u8>, event_count: u64) -> Self {
        Self {
            path: path.to_string(),
            bytes,
            event_count,
        }
    }
}

pub fn generate_compact(root: &Path) -> LabResult<GenerationSummary> {
    ensure_empty_generation_target(root)?;
    fs::create_dir_all(root)?;
    write_json(&root.join("schema/truth.schema.json"), &truth_schema())?;

    let checkout = checkout_cascade_files();
    write_scenario(
        root,
        "checkout-cascade",
        &checkout,
        checkout_cascade_truth(&checkout),
    )?;

    let mixed = mixed_time_files();
    write_scenario(root, "mixed-time-quality", &mixed, mixed_time_truth(&mixed))?;

    let provenance = source_provenance_files();
    write_scenario(
        root,
        "source-provenance",
        &provenance,
        source_provenance_truth(&provenance),
    )?;

    let edges = importer_edge_files();
    write_scenario(
        root,
        "importer-edge-cases",
        &edges,
        importer_edge_truth(&edges),
    )?;
    write_json(
        &root.join("scenarios/importer-edge-cases/recipes/archives.json"),
        &archive_recipes(),
    )?;

    let redaction = redaction_files();
    write_scenario(root, "redaction", &redaction, redaction_truth(&redaction))?;

    let company_timestamps = company_timestamp_diversity_files();
    write_scenario(
        root,
        "company-timestamp-diversity",
        &company_timestamps,
        company_timestamp_diversity_truth(&company_timestamps),
    )?;

    let company_noise = company_known_noise_files();
    write_scenario(
        root,
        "company-known-noise",
        &company_noise,
        company_known_noise_truth(&company_noise),
    )?;

    let company_fidelity = company_original_fidelity_files();
    write_scenario(
        root,
        "company-original-fidelity",
        &company_fidelity,
        company_original_fidelity_truth(&company_fidelity),
    )?;

    let archive_path = root.join("archives/checkout-cascade.zip");
    write_deterministic_zip(&checkout, &archive_path)?;
    let archive_hash = sha256_file(&archive_path)?;
    write_json(
        &root.join("archives/manifest.json"),
        &json!({
            "schema_version": TRUTH_SCHEMA_VERSION,
            "generator_version": GENERATOR_VERSION,
            "archives": [{
                "path": "checkout-cascade.zip",
                "sha256": archive_hash,
                "entries": checkout.len(),
                "events": checkout.iter().map(|file| file.event_count).sum::<u64>()
            }]
        }),
    )?;

    verify_safety(root)?;
    summarize_generation(root, SMALL_PROFILE, count_import_events(root)?)
}

pub fn generate_scale(
    root: &Path,
    profile: &str,
    event_count: usize,
) -> LabResult<GenerationSummary> {
    if !matches!(profile, MEDIUM_PROFILE | LARGE_PROFILE) {
        return Err(format!("unsupported scale profile: {profile}").into());
    }
    if event_count == 0 {
        return Err("event_count must be greater than zero".into());
    }
    ensure_empty_generation_target(root)?;
    fs::create_dir_all(root)?;
    let import_root = root.join("scenarios/scale/import");
    let source_names = [
        "edge/access.jsonl",
        "api/app.jsonl",
        "worker/worker.log",
        "db/database.log",
    ];
    let mut writers = Vec::new();
    for name in &source_names {
        let path = import_root.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        writers.push(fs::File::create(path)?);
    }

    let base = 1_735_732_800_i64;
    for index in 0..event_count {
        let source_index = index % source_names.len();
        let timestamp = base + (index / 20) as i64;
        let trace = format!("trace-scale-{:08}", index % 10_000);
        let line = match source_index {
            0 => json!({
                "ts": timestamp,
                "level": if index % 97 == 0 { "error" } else { "info" },
                "service": "edge",
                "host": "edge-01.example",
                "trace_id": trace,
                "message": format!("request completed status={} request=req-scale-{:08}", if index % 97 == 0 { 503 } else { 200 }, index)
            })
            .to_string(),
            1 => json!({
                "ts": timestamp,
                "level": if index % 211 == 0 { "warn" } else { "info" },
                "service": "checkout-api",
                "host": "api-01.example",
                "trace_id": trace,
                "message": format!("checkout step={} duration_ms={}", index % 7, 10 + index % 300)
            })
            .to_string(),
            2 => format!(
                "ts={timestamp} level={} service=queue-worker host=worker-01.example trace_id={trace} msg=job-step-{}",
                if index % 313 == 0 { "error" } else { "info" },
                index % 9
            ),
            _ => format!(
                "ts={timestamp} level={} service=database host=db-01.example trace_id={trace} msg=query-latency-ms-{}",
                if index % 401 == 0 { "warn" } else { "info" },
                index % 500
            ),
        };
        writeln!(writers[source_index], "{line}")?;
    }
    drop(writers);

    let files = collect_regular_files(&import_root)?;
    let hashes = hashes_for_paths(root, &files)?;
    write_json(
        &root.join("scenarios/scale/truth/manifest.json"),
        &json!({
            "schema_version": TRUTH_SCHEMA_VERSION,
            "scenario_version": 1,
            "scenario_id": "scale",
            "generator_version": GENERATOR_VERSION,
            "seed": FIXED_SEED,
            "profile": profile,
            "expected": {
                "files": source_names.len(),
                "events": event_count,
                "sources": source_names,
                "time_quality": "wall",
                "hashes": hashes
            },
            "performance_claim_policy": "Record measured environment, elapsed time, CPU, and memory; do not treat one host as a universal threshold."
        }),
    )?;
    verify_safety(root)?;
    summarize_generation(root, profile, event_count)
}

pub(super) fn ensure_empty_generation_target(root: &Path) -> LabResult<()> {
    if root.exists() && fs::read_dir(root)?.next().is_some() {
        return Err(format!(
            "generation target must be absent or empty: {}",
            root.display()
        )
        .into());
    }
    Ok(())
}

fn checkout_cascade_files() -> Vec<ImportFile> {
    let base = 1_735_732_800_i64;
    let api = vec![
        json_line(
            base + 10,
            "info",
            "checkout-api",
            "api-01.example",
            "trace-baseline-01",
            "event_id=api-baseline checkout accepted request=req-baseline",
        ),
        json_line(
            base + 125,
            "info",
            "checkout-api",
            "api-01.example",
            "trace-checkout-42",
            "event_id=api-start checkout accepted request=req-7f3a job=job-7f3a",
        ),
        json_line(
            base + 150,
            "warn",
            "checkout-api",
            "api-01.example",
            "trace-checkout-42",
            "event_id=api-pool-wait database pool wait exceeded 800ms request=req-7f3a",
        ),
        json_line(
            base + 165,
            "error",
            "checkout-api",
            "api-01.example",
            "trace-checkout-42",
            "event_id=api-timeout checkout failed database acquisition timeout request=req-7f3a",
        ),
        json_line(
            base + 172,
            "warn",
            "checkout-api",
            "api-02.example",
            "trace-secondary-09",
            "event_id=api-rate-limit overload guard returned 429 request=req-secondary",
        ),
        json_line(
            base + 260,
            "info",
            "checkout-api",
            "api-01.example",
            "trace-recovery-01",
            "event_id=api-recovery checkout latency normal request=req-recovery",
        ),
    ];
    let audit = vec![
        json_line(
            base,
            "info",
            "deploy-audit",
            "control-01.example",
            "change-baseline",
            "event_id=audit-baseline release=2025.01.01-1 active db_pool_max=32",
        ),
        json_line(
            base + 60,
            "warn",
            "deploy-audit",
            "control-01.example",
            "change-204",
            "event_id=audit-config release=2025.01.01-2 applied db_pool_max old=32 new=4",
        ),
        json_line(
            base + 90,
            "info",
            "deploy-audit",
            "control-01.example",
            "change-decoy-cert",
            "event_id=audit-decoy certificate rotation completed successfully expires_in_days=89",
        ),
        json_line(
            base + 230,
            "warn",
            "deploy-audit",
            "control-01.example",
            "change-rollback-204",
            "event_id=audit-rollback rollback release=2025.01.01-1 restored db_pool_max=32",
        ),
    ];
    let database = vec![
        logfmt(
            base + 5,
            "info",
            "database",
            "db-01.example",
            "trace-baseline-01",
            "event_id=db-baseline pool-active-2 pool-max-32",
        ),
        logfmt(
            base + 130,
            "warn",
            "database",
            "db-01.example",
            "trace-checkout-42",
            "event_id=db-saturation pool-active-4 pool-max-4 waiters-11",
        ),
        logfmt(
            base + 145,
            "error",
            "database",
            "db-01.example",
            "trace-checkout-42",
            "event_id=db-lock job-job-7f3a held-transaction-lock-ms-45000",
        ),
        logfmt(
            base + 160,
            "error",
            "database",
            "db-01.example",
            "trace-checkout-42",
            "event_id=db-timeout acquire-timeout request-req-7f3a pool-max-4",
        ),
        logfmt(
            base + 170,
            "warn",
            "database",
            "db-01.example",
            "trace-secondary-09",
            "event_id=db-secondary waiters-23 pool-active-4",
        ),
        logfmt(
            base + 245,
            "info",
            "database",
            "db-01.example",
            "trace-recovery-01",
            "event_id=db-recovery pool-active-3 pool-max-32 waiters-0",
        ),
    ];
    let edge = vec![
        json_line(
            base + 8,
            "info",
            "edge",
            "edge-01.example",
            "trace-baseline-01",
            "event_id=edge-baseline status=200 request=req-baseline duration_ms=42",
        ),
        json_line(
            base + 120,
            "info",
            "edge",
            "edge-01.example",
            "trace-checkout-42",
            "event_id=edge-start status=pending request=req-7f3a path=/checkout",
        ),
        json_line(
            base + 168,
            "error",
            "edge",
            "edge-01.example",
            "trace-checkout-42",
            "event_id=edge-504 status=504 request=req-7f3a duration_ms=48002",
        ),
        json_line(
            base + 175,
            "warn",
            "edge",
            "edge-02.example",
            "trace-secondary-09",
            "event_id=edge-429 status=429 request=req-secondary retry_after_s=2",
        ),
        json_line(
            base + 180,
            "info",
            "edge",
            "edge-01.example",
            "trace-decoy-health",
            "event_id=edge-decoy-health status=200 path=/health certificate=valid",
        ),
        json_line(
            base + 255,
            "info",
            "edge",
            "edge-01.example",
            "trace-recovery-01",
            "event_id=edge-recovery status=200 request=req-recovery duration_ms=38",
        ),
    ];
    let queue = vec![
        json_line(
            base + 100,
            "info",
            "checkout-queue",
            "queue-01.example",
            "trace-checkout-42",
            "event_id=queue-receive job=job-7f3a delivery=1",
        ),
        json_line(
            base + 135,
            "warn",
            "checkout-queue",
            "queue-01.example",
            "trace-checkout-42",
            "event_id=queue-retry job=job-7f3a delivery=2 reason=worker-timeout",
        ),
        json_line(
            base + 155,
            "warn",
            "checkout-queue",
            "queue-01.example",
            "trace-checkout-42",
            "event_id=queue-retry-3 job=job-7f3a delivery=3 reason=worker-timeout",
        ),
        json_line(
            base + 190,
            "error",
            "checkout-queue",
            "queue-01.example",
            "trace-checkout-42",
            "event_id=queue-poison job=job-7f3a delivery=4 visibility_timeout_s=15",
        ),
        json_line(
            base + 235,
            "warn",
            "checkout-queue",
            "queue-01.example",
            "trace-checkout-42",
            "event_id=queue-dead-letter job=job-7f3a action=dead-letter",
        ),
        json_line(
            base + 250,
            "info",
            "checkout-queue",
            "queue-01.example",
            "trace-recovery-01",
            "event_id=queue-recovery depth=0 oldest_age_s=0",
        ),
    ];
    let worker = vec![
        logfmt(
            base + 105,
            "info",
            "checkout-worker",
            "worker-01.example",
            "trace-checkout-42",
            "event_id=worker-start job-job-7f3a attempt-1",
        ),
        logfmt(
            base + 132,
            "error",
            "checkout-worker",
            "worker-01.example",
            "trace-checkout-42",
            "event_id=worker-poison job-job-7f3a malformed-line-item retryable-true",
        ),
        logfmt(
            base + 140,
            "warn",
            "checkout-worker",
            "worker-01.example",
            "trace-checkout-42",
            "event_id=worker-retry job-job-7f3a attempt-2",
        ),
        logfmt(
            base + 158,
            "warn",
            "checkout-worker",
            "worker-02.example",
            "trace-checkout-42",
            "event_id=worker-retry-3 job-job-7f3a attempt-3",
        ),
        logfmt(
            base + 188,
            "error",
            "checkout-worker",
            "worker-01.example",
            "trace-checkout-42",
            "event_id=worker-loop job-job-7f3a attempt-4 transaction-open-true",
        ),
        logfmt(
            base + 238,
            "info",
            "checkout-worker",
            "worker-01.example",
            "trace-checkout-42",
            "event_id=worker-stopped job-job-7f3a dead-lettered",
        ),
        logfmt(
            base + 252,
            "info",
            "checkout-worker",
            "worker-01.example",
            "trace-recovery-01",
            "event_id=worker-recovery queue-depth-0",
        ),
    ];
    vec![
        ImportFile::text("api/app.jsonl", &api),
        ImportFile::text("audit/deploy.jsonl", &audit),
        ImportFile::text("db/database.log", &database),
        ImportFile::text("edge/access.jsonl", &edge),
        ImportFile::text("queue/events.jsonl", &queue),
        ImportFile::text("worker/worker.log", &worker),
    ]
}

fn checkout_cascade_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "checkout-cascade",
        "wall",
        files,
        json!({
            "summary": "Release 2025.01.01-2 reduced db_pool_max from 32 to 4. Poison job job-7f3a retried while retaining database work, exhausting the pool and causing checkout timeouts, 504s, and secondary 429s. Dead-lettering the job and rolling back the pool setting restored service.",
            "root_cause": "Configuration shrink plus repeated poison-job processing exhausted the database connection pool.",
            "affected_interval": {"from": 1735732860_i64, "to": 1735733060_i64},
            "causal_timeline": [
                {"event_id": "audit-config", "role": "primary_change", "after": null},
                {"event_id": "queue-receive", "role": "trigger", "after": "audit-config"},
                {"event_id": "worker-loop", "role": "amplifier", "after": "queue-receive"},
                {"event_id": "db-saturation", "role": "resource_exhaustion", "after": "worker-loop"},
                {"event_id": "edge-504", "role": "secondary_symptom", "after": "db-saturation"},
                {"event_id": "audit-rollback", "role": "repair", "after": "edge-504"},
                {"event_id": "edge-recovery", "role": "observed_recovery", "after": "audit-rollback"}
            ],
            "decisive_clues": [
                {"event_id": "audit-config", "source": "audit/deploy.jsonl", "query": "db_pool_max old=32 new=4"},
                {"event_id": "worker-loop", "source": "worker/worker.log", "query": "job-job-7f3a attempt-4 transaction-open-true"},
                {"event_id": "db-saturation", "source": "db/database.log", "query": "pool-active-4 pool-max-4 waiters-11"},
                {"event_id": "edge-504", "source": "edge/access.jsonl", "query": "status=504 request=req-7f3a"},
                {"event_id": "audit-rollback", "source": "audit/deploy.jsonl", "query": "restored db_pool_max=32"},
                {"event_id": "edge-recovery", "source": "edge/access.jsonl", "query": "request=req-recovery duration_ms=38"}
            ],
            "required_correlations": ["trace-checkout-42", "job-7f3a", "req-7f3a", "change-204"],
            "decoys": [
                {"event_id": "audit-decoy", "reason": "Certificate rotation completed successfully before the incident and health traffic remained 200."},
                {"event_id": "edge-decoy-health", "reason": "The health endpoint remained healthy while checkout requests failed; it does not explain pool saturation."}
            ],
            "canonical_questions": [
                "What caused the checkout failures, and which evidence establishes the causal chain?",
                "Which symptoms were secondary, and which apparent clue was a decoy?",
                "What changed immediately before recovery?"
            ],
            "canonical_queries": [
                {"kind": "literal", "text": "job-7f3a"},
                {"kind": "literal", "text": "pool-max-4"},
                {"kind": "trace", "text": "trace-checkout-42"},
                {"kind": "level_source", "level": "error", "source": "edge/access.jsonl"}
            ],
            "rubric": {
                "required": [
                    "identifies both the pool-size change and poison-job retry loop",
                    "cites at least three privacy-safe source paths",
                    "uses at least two correlation identifiers",
                    "separates primary cause from 429/504 symptoms",
                    "rejects the certificate-rotation decoy",
                    "cites rollback/dead-letter recovery evidence",
                    "states only evidence-supported conclusions"
                ],
                "exact_prose_required": false
            }
        }),
    )
}

fn mixed_time_files() -> Vec<ImportFile> {
    let base = 1_735_733_400_i64;
    let wall = (0..4)
        .map(|i| {
            json_line(
                base + i,
                "info",
                "wall-service",
                "wall-01.example",
                &format!("trace-wall-{i}"),
                &format!("event_id=wall-{i} wall-clock event"),
            )
        })
        .collect::<Vec<_>>();
    let order = vec![
        "INFO event_id=order-0 startup without timestamp".to_string(),
        "WARN event_id=order-1 queue depth rising".to_string(),
        "ERROR event_id=order-2 order-only failure".to_string(),
    ];
    let malformed = vec![
        json!({"ts":"not-a-time","level":"warn","service":"malformed","message":"event_id=malformed-0 invalid timestamp"}).to_string(),
        json!({"level":"error","service":"malformed","message":"event_id=malformed-1 missing timestamp"}).to_string(),
    ];
    let skew = vec![
        logfmt(
            base - 120,
            "warn",
            "skewed-service",
            "skew-01.example",
            "trace-skew-1",
            "event_id=skew-0 clock-behind-120s",
        ),
        logfmt(
            base + 10,
            "info",
            "skewed-service",
            "skew-01.example",
            "trace-skew-2",
            "event_id=skew-1 late-arrival",
        ),
    ];
    vec![
        ImportFile::text("01-wall.jsonl", &wall),
        ImportFile::text("02-order.log", &order),
        ImportFile::text("03-malformed.jsonl", &malformed),
        ImportFile::text("04-skew.log", &skew),
    ]
}

fn mixed_time_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "mixed-time-quality",
        "mixed",
        files,
        json!({
            "lane_expectations": [
                {"sources": ["01-wall.jsonl"], "quality": "wall", "linked_scroll": true, "calendar_gap_claims": true},
                {"sources": ["02-order.log"], "quality": "order_only", "linked_scroll": false, "calendar_gap_claims": false},
                {"sources": ["03-malformed.jsonl"], "quality": "order_only", "linked_scroll": false, "calendar_gap_claims": false},
                {"sources": ["01-wall.jsonl", "02-order.log"], "quality": "mixed", "linked_scroll": false, "calendar_gap_claims": false}
            ],
            "rule": "Any visible order-only, empty, failed, or unloaded lane prevents reliable wall-clock linking. Mixed data must never be presented as fully reliable wall time.",
            "late_arrival": {"event_id": "skew-1", "source": "04-skew.log"},
            "canonical_queries": [{"kind": "literal", "text": "order-only failure"}]
        }),
    )
}

fn source_provenance_files() -> Vec<ImportFile> {
    let base = 1_735_734_000_i64;
    let region_a = vec![json_line(
        base,
        "error",
        "catalog",
        "a-01.example",
        "trace-region-a",
        "event_id=region-a-failure duplicate-basename marker=alpha",
    )];
    let region_b = vec![json_line(
        base,
        "warn",
        "catalog",
        "b-01.example",
        "trace-region-b",
        "event_id=region-b-warning duplicate-basename marker=beta",
    )];
    let plain = vec![
        "INFO event_id=plain-0 plain fallback line".to_string(),
        "ERROR event_id=plain-1 stack trace begins".to_string(),
        "    at fictional.module.invalid(example.rs:42)".to_string(),
    ];
    let logfmt_lines = vec![logfmt(
        base + 2,
        "info",
        "format-service",
        "format-01.example",
        "trace-logfmt",
        "event_id=logfmt-0 format-detected",
    )];
    let syslog = vec![
        "<34>Oct 11 22:14:15 syslog-01.example app: event_id=syslog-0 error simulated".to_string(),
    ];
    let crlf =
        b"INFO event_id=crlf-0 windows line\r\nWARN event_id=crlf-1 second line\r\n".to_vec();
    let utf8 = "INFO event_id=utf8-0 caf\u{00e9} \u{03bb} synthetic unicode\n"
        .as_bytes()
        .to_vec();
    let rotated = vec![json_line(
        base + 3,
        "info",
        "rotated-api",
        "api-01.example",
        "trace-rotation",
        "event_id=rotation-old repeated-line-number=1",
    )];
    let current = vec![json_line(
        base + 3,
        "error",
        "rotated-api",
        "api-01.example",
        "trace-rotation",
        "event_id=rotation-new repeated-line-number=1",
    )];
    vec![
        ImportFile::text("formats/01-plain.log", &plain),
        ImportFile::text("formats/02-logfmt.log", &logfmt_lines),
        ImportFile::text("formats/03-syslog.log", &syslog),
        ImportFile::bytes("formats/04-crlf.log", crlf, 2),
        ImportFile::bytes("formats/05-utf8.log", utf8, 1),
        ImportFile::bytes("formats/06-empty.log", Vec::new(), 0),
        ImportFile::text("region-a/app.jsonl", &region_a),
        ImportFile::text("region-b/app.jsonl", &region_b),
        ImportFile::text("rotated/api.log", &current),
        ImportFile::text("rotated/api.log.1", &rotated),
    ]
}

fn source_provenance_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "source-provenance",
        "mixed",
        files,
        json!({
            "duplicate_basenames": [
                {"source": "region-a/app.jsonl", "event_id": "region-a-failure"},
                {"source": "region-b/app.jsonl", "event_id": "region-b-warning"}
            ],
            "formats": ["plain", "logfmt", "syslog", "json", "crlf", "utf8"],
            "rotations": [
                {"source": "rotated/api.log", "event_id": "rotation-new"},
                {"source": "rotated/api.log.1", "event_id": "rotation-old"}
            ],
            "privacy_rule": "Only normalized relative source paths may be exposed. Absolute paths and home directories are forbidden.",
            "canonical_queries": [
                {"kind": "source", "text": "region-a/app.jsonl"},
                {"kind": "literal", "text": "marker=beta"},
                {"kind": "literal", "text": "caf\u{00e9}"}
            ]
        }),
    )
}

fn importer_edge_files() -> Vec<ImportFile> {
    vec![
        ImportFile::text(
            "safe.log",
            &[
                "INFO event_id=edge-safe-0 safe text line".to_string(),
                "WARN event_id=edge-safe-1 partial fixture remains usable".to_string(),
            ],
        ),
        ImportFile::bytes("binary.log", b"synthetic\0binary\n".to_vec(), 0),
        ImportFile::bytes(".hidden.log", b"must be ignored\n".to_vec(), 0),
        ImportFile::bytes("empty.log", Vec::new(), 0),
    ]
}

fn importer_edge_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "importer-edge-cases",
        "order_only",
        files,
        json!({
            "expected_ingest": {
                "discovered": 4,
                "imported": 2,
                "excluded": 1,
                "failed": 0,
                "ignored": 1,
                "partial": true,
                "exclusion_counts": {"binary": 1, "hidden": 1}
            },
            "recipes": {
                "oversized_sparse_bytes": 536870913_u64,
                "unreadable": "Remove or chmod a discovered file after scan using the production observer hook; skip when the platform cannot enforce it.",
                "cancellation": "Cancel after a deterministic progress line threshold for both directory and ZIP paths.",
                "zero_safe_files": ["binary", "hidden", "empty"],
                "truncated": "Generate a final line without a newline and verify it remains bounded and importable."
            }
        }),
    )
}

fn archive_recipes() -> Value {
    json!({
        "schema_version": TRUTH_SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "archives": [
            {"id": "absolute", "entries": ["/absolute.log"], "expected": "reject"},
            {"id": "drive_prefix", "entries": ["C:/drive.log"], "expected": "reject"},
            {"id": "traversal", "entries": ["../escape.log"], "expected": "reject"},
            {"id": "backslash", "entries": ["nested\\escape.log"], "expected": "reject"},
            {"id": "ambiguous_separator", "entries": ["nested//double.log"], "expected": "reject"},
            {"id": "duplicate", "entries": ["same.log", "same.log"], "expected": "reject"},
            {"id": "directory_only", "entries": ["ignored/"], "expected": "zero-safe-file failure"},
            {"id": "binary_only", "entries": ["binary.log"], "expected": "zero-safe-file failure"},
            {"id": "compressed_limit", "entries": ["large.log"], "expected": "bounded rejection"},
            {"id": "truncated", "entries": ["truncated.log"], "expected": "bounded error without publication"}
        ]
    })
}

fn redaction_files() -> Vec<ImportFile> {
    let token = "sk-LOG-LAB-INVALID-abcdefghijklmnop";
    let bearer = "LOG-LAB-INVALID-BEARER-abcdefghijklmnop";
    let lines = vec![
        json_line(1_735_735_000, "error", "auth-service", "auth-01.example", "trace-redaction-1", &format!("event_id=redaction-api-key authentication rejected synthetic_key={token} account=fictional-user")),
        json_line(1_735_735_001, "warn", "auth-service", "auth-01.example", "trace-redaction-1", &format!("event_id=redaction-bearer authorization failed Bearer {bearer} request=req-redaction")),
        json_line(1_735_735_002, "info", "auth-service", "auth-01.example", "trace-redaction-1", "event_id=redaction-safe remediation=rotate-synthetic-test-credential owner=fictional-team"),
    ];
    vec![ImportFile::text("auth/auth.jsonl", &lines)]
}

fn redaction_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "redaction",
        "wall",
        files,
        json!({
            "raw_values_for_test_only": [
                "sk-LOG-LAB-INVALID-abcdefghijklmnop",
                "LOG-LAB-INVALID-BEARER-abcdefghijklmnop"
            ],
            "required_absence_surfaces": [
                "persisted events",
                "search results",
                "Explorer rows and detail",
                "linked-chat context",
                "errors",
                "audit output",
                "snapshots",
                "exported packages"
            ],
            "safe_evidence": ["event_id=redaction-api-key", "event_id=redaction-bearer", "trace-redaction-1", "fictional-user"],
            "supported_conclusion": "A fictional credential was rejected and must be rotated; the raw synthetic value is not required to investigate."
        }),
    )
}

/// Shared wall-clock instant used by company-timestamp-diversity encodings.
/// 2025-01-01T13:20:00Z (Unix seconds). String forms below must represent this
/// instant when they carry a complete offset; epoch and fractional forms match it.
const COMPANY_TS_SHARED_INSTANT_SECS: i64 = 1_735_740_000;
const COMPANY_TS_SHARED_INSTANT_MS: i64 = 1_735_740_000_000;
const COMPANY_TS_SHARED_RFC3339_UTC: &str = "2025-01-01T13:20:00Z";
const COMPANY_TS_SHARED_OFFSET_PLUS: &str = "2025-01-01T14:20:00+01:00";
const COMPANY_TS_SHARED_OFFSET_MINUS: &str = "2025-01-01T08:20:00-05:00";
const COMPANY_TS_SHARED_FRACTIONAL: &str = "2025-01-01T13:20:00.123Z";
const COMPANY_TS_SHARED_RFC5424: &str = "2025-01-01T13:20:00.000Z";

fn company_timestamp_diversity_files() -> Vec<ImportFile> {
    let shared = COMPANY_TS_SHARED_INSTANT_SECS;
    // Same local clock face as shared UTC hour/minute but a different day — similar
    // displayed local time only, not the same instant.
    let similar_local_only = "2025-01-02T13:20:00";

    let shared_encodings = vec![
        json!({
            "ts": COMPANY_TS_SHARED_RFC3339_UTC,
            "level": "info",
            "service": "billing-api",
            "host": "api-01.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-rfc3339-utc shared-instant encoding=rfc3339-utc"
        })
        .to_string(),
        json!({
            "ts": COMPANY_TS_SHARED_OFFSET_PLUS,
            "level": "info",
            "service": "billing-api",
            "host": "api-01.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-offset-plus shared-instant encoding=rfc3339-plus-one"
        })
        .to_string(),
        json!({
            "ts": COMPANY_TS_SHARED_OFFSET_MINUS,
            "level": "info",
            "service": "billing-api",
            "host": "api-02.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-offset-minus shared-instant encoding=rfc3339-minus-five"
        })
        .to_string(),
        json!({
            "ts": shared,
            "level": "info",
            "service": "billing-api",
            "host": "api-01.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-epoch-s shared-instant encoding=epoch-seconds"
        })
        .to_string(),
        json!({
            "ts": COMPANY_TS_SHARED_INSTANT_MS,
            "level": "info",
            "service": "billing-api",
            "host": "api-01.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-epoch-ms shared-instant encoding=epoch-milliseconds"
        })
        .to_string(),
        json!({
            "ts": COMPANY_TS_SHARED_FRACTIONAL,
            "level": "info",
            "service": "billing-api",
            "host": "api-01.example",
            "trace_id": "trace-company-ts-shared",
            "message": "event_id=ts-fractional shared-instant encoding=rfc3339-fractional"
        })
        .to_string(),
        json!({
            "ts": similar_local_only,
            "level": "warn",
            "service": "billing-api",
            "host": "api-03.example",
            "trace_id": "trace-company-ts-similar",
            "message": "event_id=ts-similar-local-only similar-local-display-only not-shared-instant"
        })
        .to_string(),
    ];

    let logfmt_offset = format!(
        "ts={COMPANY_TS_SHARED_OFFSET_PLUS} level=info service=billing-worker host=worker-01.example trace_id=trace-company-ts-shared msg=\"event_id=ts-logfmt-offset shared-instant encoding=logfmt-rfc3339-offset\""
    );
    let rfc5424 = format!(
        "<34>1 {COMPANY_TS_SHARED_RFC5424} syslog-01.example billing-api - - - event_id=ts-rfc5424 shared-instant encoding=rfc5424-offset"
    );
    let yearless = "<34>Jan  1 13:20:00 syslog-01.example billing-api: event_id=ts-yearless-syslog yearless classic syslog must not assume year or timezone".to_string();
    // US fall-back style local time without offset — ambiguous until zone rules are known.
    let dst_ambiguous = json!({
        "ts": "2025-11-02T01:30:00",
        "level": "warn",
        "service": "scheduler",
        "host": "sched-01.example",
        "trace_id": "trace-company-ts-dst",
        "message": "event_id=ts-dst-ambiguous local fall-back hour without offset"
    })
    .to_string();
    let malformed = json!({
        "ts": "not-a-timestamp",
        "level": "error",
        "service": "billing-api",
        "host": "api-01.example",
        "trace_id": "trace-company-ts-bad",
        "message": "event_id=ts-malformed unusable timestamp string"
    })
    .to_string();
    let missing = json!({
        "level": "error",
        "service": "billing-api",
        "host": "api-01.example",
        "trace_id": "trace-company-ts-missing",
        "message": "event_id=ts-missing no timestamp field"
    })
    .to_string();

    let skew = logfmt(
        shared - 180,
        "warn",
        "edge-proxy",
        "edge-01.example",
        "trace-company-ts-skew",
        "event_id=ts-skew-behind known source clock skew_seconds=-180 no automatic correction claimed",
    );
    let late = logfmt(
        shared + 30,
        "info",
        "edge-proxy",
        "edge-01.example",
        "trace-company-ts-late",
        "event_id=ts-late late-arriving event wall time may disagree with ingest order",
    );

    let ambiguous = vec![yearless, dst_ambiguous, malformed, missing];
    let skew_late = vec![skew, late];

    vec![
        ImportFile::text("01-shared-encodings.jsonl", &shared_encodings),
        ImportFile::text("02-logfmt-offset.log", &[logfmt_offset]),
        ImportFile::text("03-rfc5424.log", &[rfc5424]),
        ImportFile::text("04-ambiguous-or-unusable.log", &ambiguous),
        ImportFile::text("05-skew-and-late.log", &skew_late),
    ]
}

fn company_timestamp_diversity_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "company-timestamp-diversity",
        "mixed",
        files,
        json!({
            "shared_instant": {
                "epoch_seconds": COMPANY_TS_SHARED_INSTANT_SECS,
                "epoch_milliseconds": COMPANY_TS_SHARED_INSTANT_MS,
                "rfc3339_utc": COMPANY_TS_SHARED_RFC3339_UTC,
                "event_ids": [
                    "ts-rfc3339-utc",
                    "ts-offset-plus",
                    "ts-offset-minus",
                    "ts-epoch-s",
                    "ts-epoch-ms",
                    "ts-fractional",
                    "ts-logfmt-offset",
                    "ts-rfc5424"
                ],
                "note": "These encodings represent the same wall-clock instant when a complete offset or epoch is present. The fixture does not claim production already normalizes them."
            },
            "similar_local_display_only": [
                {
                    "event_id": "ts-similar-local-only",
                    "local_face": "2025-01-02T13:20:00",
                    "reason": "Same clock face as the shared UTC hour:minute on a different day and without an offset; not the shared instant."
                }
            ],
            "unusable_timestamps": [
                {"event_id": "ts-malformed", "reason": "non-parseable timestamp string"},
                {"event_id": "ts-missing", "reason": "no timestamp field"}
            ],
            "order_only_or_incomplete": [
                {
                    "event_id": "ts-yearless-syslog",
                    "reason": "Yearless classic syslog must not be assumed to have a year or timezone."
                }
            ],
            "dst_ambiguous": {
                "event_id": "ts-dst-ambiguous",
                "local": "2025-11-02T01:30:00",
                "note": "US-style fall-back hour without offset is ambiguous; do not claim a unique UTC conversion."
            },
            "known_skew": {
                "event_id": "ts-skew-behind",
                "skew_seconds": -180,
                "note": "Known source clock skew relative to the shared instant. Fixture does not claim automatic correction."
            },
            "late_arrival": {
                "event_id": "ts-late",
                "source": "05-skew-and-late.log",
                "note": "Late-arriving event: wall time may disagree with ingest or file order."
            },
            "product_gap_note": "Supports evaluation of future timestamp normalization (#670). Does not assert that normalization or auto-correction already ships.",
            "canonical_queries": [
                {"kind": "literal", "text": "shared-instant"},
                {"kind": "literal", "text": "event_id=ts-yearless-syslog"},
                {"kind": "literal", "text": "event_id=ts-dst-ambiguous"}
            ]
        }),
    )
}

fn company_known_noise_files() -> Vec<ImportFile> {
    let base = COMPANY_TS_SHARED_INSTANT_SECS + 3_600;
    let mut health = Vec::new();
    for i in 0..4 {
        health.push(json_line(
            base + i,
            "info",
            "health-monitor",
            "health-01.example",
            &format!("trace-noise-health-{i}"),
            &format!(
                "event_id=noise-health-{i} GET /health status=200 latency_ms={}",
                3 + i
            ),
        ));
    }

    let retries = (0..3)
        .map(|i| {
            logfmt(
                base + 10 + i,
                "warn",
                "queue-worker",
                "worker-02.example",
                &format!("trace-noise-retry-{i}"),
                &format!(
                    "event_id=noise-retry-{i} retrying delivery attempt={} reason=temporary-timeout job=job-noise-{}",
                    i + 1,
                    i
                ),
            )
        })
        .collect::<Vec<_>>();

    // Known-benign error template (safe candidate for a narrow template rule).
    let benign_errors = vec![
        json_line(
            base + 20,
            "error",
            "health-monitor",
            "health-01.example",
            "trace-noise-benign-0",
            "event_id=noise-benign-reset-0 connection reset by peer during health probe target=192.0.2.10",
        ),
        json_line(
            base + 21,
            "error",
            "health-monitor",
            "health-01.example",
            "trace-noise-benign-1",
            "event_id=noise-benign-reset-1 connection reset by peer during health probe target=192.0.2.10",
        ),
    ];

    // Superficially similar wording, genuinely important payment path — must not
    // be hidden by an overbroad "connection reset" rule.
    let important_similar = json_line(
        base + 22,
        "error",
        "payments-api",
        "pay-01.example",
        "trace-noise-important",
        "event_id=noise-important-reset connection reset by peer during payment settle request=req-noise-pay-7 amount_cents=4200",
    );

    // Same level (error) but different template, source, service, host, and trace.
    let other_errors = vec![
        json_line(
            base + 30,
            "error",
            "catalog-api",
            "cat-01.example",
            "trace-noise-catalog",
            "event_id=noise-catalog-error catalog lookup failed sku=SKU-NOISE-1",
        ),
        logfmt(
            base + 31,
            "error",
            "edge-proxy",
            "edge-02.example",
            "trace-noise-edge",
            "event_id=noise-edge-error upstream timeout path=/v1/checkout",
        ),
    ];

    // Real incident: suppress-all-ERROR would hide the primary signal.
    let incident = vec![
        json_line(
            base + 40,
            "error",
            "checkout-api",
            "api-01.example",
            "trace-noise-incident",
            "event_id=noise-incident-error payment authorization failed code=AUTH_DECLINED request=req-noise-incident-9",
        ),
        json_line(
            base + 41,
            "info",
            "checkout-api",
            "api-01.example",
            "trace-noise-incident",
            "event_id=noise-incident-context recovery path selected request=req-noise-incident-9",
        ),
    ];

    let mut errors_file = benign_errors;
    errors_file.push(important_similar);
    errors_file.extend(other_errors);
    errors_file.extend(incident);

    vec![
        ImportFile::text("health/health.jsonl", &health),
        ImportFile::text("worker/retries.log", &retries),
        ImportFile::text("services/errors-and-incident.jsonl", &errors_file),
    ]
}

fn company_known_noise_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "company-known-noise",
        "wall",
        files,
        json!({
            "safe_suppression_candidates": [
                {
                    "predicate_id": "health_get_200",
                    "description": "service=health-monitor AND message matches GET /health status=200",
                    "event_ids": [
                        "noise-health-0",
                        "noise-health-1",
                        "noise-health-2",
                        "noise-health-3"
                    ],
                    "expected_count": 4
                },
                {
                    "predicate_id": "health_probe_connection_reset",
                    "description": "service=health-monitor AND message contains 'connection reset by peer during health probe'",
                    "event_ids": [
                        "noise-benign-reset-0",
                        "noise-benign-reset-1"
                    ],
                    "expected_count": 2
                },
                {
                    "predicate_id": "temporary_retry_timeout",
                    "description": "service=queue-worker AND message contains 'retrying delivery' AND reason=temporary-timeout",
                    "event_ids": [
                        "noise-retry-0",
                        "noise-retry-1",
                        "noise-retry-2"
                    ],
                    "expected_count": 3
                }
            ],
            "safe_candidate_total": 9,
            "must_remain_visible": [
                {
                    "event_id": "noise-important-reset",
                    "reason": "Payment settle connection reset is incident-relevant; overbroad 'connection reset' suppression would hide it."
                },
                {
                    "event_id": "noise-incident-error",
                    "reason": "Primary incident ERROR; suppress-all-ERROR damages investigation visibility."
                },
                {
                    "event_id": "noise-catalog-error",
                    "reason": "Shares level=error with noise but differs by template, service, host, and trace."
                },
                {
                    "event_id": "noise-edge-error",
                    "reason": "Shares level=error with noise but differs by template, service, host, and trace."
                },
                {
                    "event_id": "noise-incident-context",
                    "reason": "Incident context on the same trace as the primary failure."
                }
            ],
            "unsafe_broad_predicates": [
                {
                    "predicate": "level=error",
                    "would_hide_event_ids": [
                        "noise-benign-reset-0",
                        "noise-benign-reset-1",
                        "noise-important-reset",
                        "noise-catalog-error",
                        "noise-edge-error",
                        "noise-incident-error"
                    ],
                    "would_hide_count": 6,
                    "reason": "Level-only suppression removes both safe noise and the real incident signal."
                },
                {
                    "predicate": "message contains 'connection reset'",
                    "would_hide_event_ids": [
                        "noise-benign-reset-0",
                        "noise-benign-reset-1",
                        "noise-important-reset"
                    ],
                    "would_hide_count": 3,
                    "reason": "Broad regex hides the payment settle failure that only looks similar to the health-probe template."
                }
            ],
            "product_gap_note": "Supports evaluation of future known-noise suppression (#671). Does not claim suppression already ships.",
            "canonical_queries": [
                {"kind": "literal", "text": "event_id=noise-important-reset"},
                {"kind": "literal", "text": "event_id=noise-incident-error"},
                {"kind": "literal", "text": "GET /health"}
            ]
        }),
    )
}

fn company_original_fidelity_files() -> Vec<ImportFile> {
    let base = COMPANY_TS_SHARED_INSTANT_SECS + 7_200;
    let token = "sk-LOG-LAB-INVALID-companyfidelity01";
    let bearer = "LOG-LAB-INVALID-BEARER-companyfidelity01";

    // Deliberate key order + unknown fields + nested object via raw string
    // (serde_json::json! may reorder keys). Credential-shaped value uses safety marker.
    let json_line_ordered = format!(
        r#"{{"z_unknown":"tail-field","message":"event_id=fid-json-nested nested payload","nested":{{"cart":{{"items":2,"note":"keep punctuation: a,b; c=\"quoted\""}},"region":"lab"}},"level":"info","service":"orders-api","host":"ord-01.example","trace_id":"trace-fid-json","synthetic_key":"{token}","ts":{base}}}"#
    );

    let json_escape = json!({
        "ts": base + 1,
        "level": "warn",
        "service": "orders-api",
        "host": "ord-01.example",
        "trace_id": "trace-fid-escape",
        "message": "event_id=fid-json-escape path=C:\\\\lab\\\\orders note=\"quoted\" backslash\\and\"quote",
        "extra_field": "unknown-top-level",
        "unicode_note": "café λ synthetic"
    })
    .to_string();

    let logfmt_line = format!(
        "ts={} level=info service=format-service host=fmt-01.example trace_id=trace-fid-logfmt msg=\"event_id=fid-logfmt escaped=\\\"inner\\\" path=C:\\\\lab\\\\file\" unknown_kv=keep-me",
        base + 2
    );

    let syslog_line = format!(
        "<14>1 2025-01-01T15:20:00.000Z syslog-02.example orders-api - - - event_id=fid-syslog unicode=café status=ok"
    );

    let plain = format!(
        "INFO event_id=fid-plain plain text with punctuation: a,b; c=\"quoted\" and unicode café λ"
    );

    let crlf = format!(
        "INFO event_id=fid-crlf-0 first windows line\r\nWARN event_id=fid-crlf-1 second windows line bearer={bearer}\r\n"
    )
    .into_bytes();

    // Long but bounded line (~400 chars of payload, well under importer limits).
    let long_payload = "X".repeat(400);
    let long_line = format!(
        "ts={} level=info service=orders-api host=ord-01.example trace_id=trace-fid-long msg=\"event_id=fid-long-line payload={long_payload}\"",
        base + 3
    );

    vec![
        ImportFile::text(
            "formats/01-json-ordered.jsonl",
            &[json_line_ordered, json_escape],
        ),
        ImportFile::text("formats/02-logfmt.log", &[logfmt_line]),
        ImportFile::text("formats/03-syslog.log", &[syslog_line]),
        // Basename 04-crlf.log matches root .gitattributes (-text -eol) so CRLF survives checkout.
        ImportFile::bytes("formats/04-crlf.log", crlf, 2),
        ImportFile::text("formats/05-plain.log", &[plain]),
        ImportFile::text("formats/06-long.log", &[long_line]),
    ]
}

fn company_original_fidelity_truth(files: &[ImportFile]) -> Value {
    base_truth(
        "company-original-fidelity",
        "mixed",
        files,
        json!({
            "formats": ["json", "logfmt", "syslog", "plain", "crlf", "long-line"],
            "raw_values_for_test_only": [
                "sk-LOG-LAB-INVALID-companyfidelity01",
                "LOG-LAB-INVALID-BEARER-companyfidelity01"
            ],
            "original_redacted_must_preserve": [
                {
                    "event_id": "fid-json-nested",
                    "properties": [
                        "unknown field z_unknown",
                        "deliberate JSON key order as stored in the import line",
                        "nested cart items count",
                        "nested cart note punctuation and escaped quotes",
                        "nested region value",
                        "trace_id",
                        "service",
                        "host"
                    ]
                },
                {
                    "event_id": "fid-json-escape",
                    "properties": [
                        "escaped backslashes and quotes in message",
                        "extra_field unknown top-level key",
                        "unicode_note cafe lambda synthetic"
                    ]
                },
                {
                    "event_id": "fid-logfmt",
                    "properties": [
                        "escaped quotes inside msg",
                        "unknown_kv key",
                        "backslash path shape without becoming a real host path claim"
                    ]
                },
                {
                    "event_id": "fid-syslog",
                    "properties": ["RFC5424-style framing", "unicode cafe"]
                },
                {
                    "event_id": "fid-plain",
                    "properties": ["punctuation", "unicode cafe lambda"]
                },
                {
                    "event_id": "fid-crlf-0",
                    "properties": [
                        "first record content imported from a CRLF source",
                        "per-event Original does not claim record-separator bytes"
                    ]
                },
                {
                    "event_id": "fid-crlf-1",
                    "properties": [
                        "second record content imported from a CRLF source",
                        "per-event Original does not claim record-separator bytes"
                    ]
                },
                {
                    "event_id": "fid-long-line",
                    "properties": ["full bounded long payload without truncation in Original redacted view"]
                }
            ],
            "original_redacted_must_redact": [
                {
                    "event_id": "fid-json-nested",
                    "values": ["sk-LOG-LAB-INVALID-companyfidelity01"],
                    "field_hints": ["synthetic_key"]
                },
                {
                    "event_id": "fid-crlf-1",
                    "values": ["LOG-LAB-INVALID-BEARER-companyfidelity01"],
                    "field_hints": ["bearer"]
                }
            ],
            "required_absence_surfaces": [
                "persisted events",
                "search results",
                "Explorer rows and detail",
                "Original (redacted) view",
                "linked-chat context",
                "errors",
                "audit output",
                "snapshots",
                "exported packages"
            ],
            "safe_evidence": [
                "event_id=fid-json-nested",
                "event_id=fid-json-escape",
                "event_id=fid-logfmt",
                "event_id=fid-syslog",
                "event_id=fid-plain",
                "event_id=fid-crlf-0",
                "event_id=fid-crlf-1",
                "event_id=fid-long-line",
                "trace-fid-json"
            ],
            "product_gap_note": "Supports evaluation of future Original (redacted) fidelity (#673). Does not claim the Original view already ships.",
            "canonical_queries": [
                {"kind": "literal", "text": "event_id=fid-json-nested"},
                {"kind": "literal", "text": "event_id=fid-long-line"},
                {"kind": "literal", "text": "café"}
            ]
        }),
    )
}

fn base_truth(
    scenario_id: &str,
    time_quality: &str,
    files: &[ImportFile],
    investigation: Value,
) -> Value {
    let file_hashes = files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                json!({
                    "sha256": sha256_bytes(&file.bytes),
                    "bytes": file.bytes.len(),
                    "events": file.event_count
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let events = files.iter().map(|file| file.event_count).sum::<u64>();
    let bytes = files
        .iter()
        .map(|file| file.bytes.len() as u64)
        .sum::<u64>();
    let sources = files
        .iter()
        .map(|file| (file.path.clone(), Value::from(file.event_count)))
        .collect::<serde_json::Map<_, _>>();
    let severities = expected_severity_counts(files);
    json!({
        "schema_version": TRUTH_SCHEMA_VERSION,
        "scenario_version": 1,
        "scenario_id": scenario_id,
        "generator_version": GENERATOR_VERSION,
        "seed": FIXED_SEED,
        "provenance": "Entirely synthetic and generated by the ContextDesk repository; no third-party or production log material.",
        "expected": {
            "files": files.len(),
            "events": events,
            "bytes": bytes,
            "source_count": files.len(),
            "sources": sources,
            "severities": severities,
            "time_quality": time_quality,
            "files_by_path": file_hashes
        },
        "investigation": investigation
    })
}

fn expected_severity_counts(files: &[ImportFile]) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for file in files {
        let text = String::from_utf8_lossy(&file.bytes);
        for line in text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(file.event_count as usize)
        {
            let level = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("level")
                        .and_then(Value::as_str)
                        .map(str::to_ascii_lowercase)
                })
                .or_else(|| {
                    line.split_whitespace().find_map(|token| {
                        token
                            .strip_prefix("level=")
                            .map(|value| value.trim_matches('"').to_ascii_lowercase())
                    })
                })
                .or_else(|| {
                    let lower = line.to_ascii_lowercase();
                    ["fatal", "error", "warn", "info", "debug"]
                        .into_iter()
                        .find(|level| {
                            lower
                                .split(|ch: char| !ch.is_ascii_alphanumeric())
                                .any(|token| token == *level)
                        })
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| "unknown".into());
            *counts.entry(level).or_insert(0) += 1;
        }
    }
    counts
}

fn truth_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://contextdesk.example/schemas/log-lab-truth-v1.json",
        "title": "ContextDesk Log Lab truth manifest",
        "type": "object",
        "required": ["schema_version", "scenario_version", "scenario_id", "generator_version", "seed", "provenance", "expected"],
        "properties": {
            "schema_version": {"const": TRUTH_SCHEMA_VERSION},
            "scenario_version": {"type": "integer", "minimum": 1},
            "scenario_id": {"type": "string", "minLength": 1},
            "generator_version": {"const": GENERATOR_VERSION},
            "seed": {"const": FIXED_SEED},
            "provenance": {"type": "string", "minLength": 1},
            "expected": {
                "type": "object",
                "required": [
                    "files",
                    "events",
                    "bytes",
                    "source_count",
                    "sources",
                    "severities",
                    "time_quality",
                    "files_by_path"
                ]
            },
            "investigation": {"type": "object"}
        },
        "additionalProperties": false
    })
}

pub(super) fn json_line(
    ts: i64,
    level: &str,
    service: &str,
    host: &str,
    trace_id: &str,
    message: &str,
) -> String {
    json!({
        "ts": ts,
        "level": level,
        "service": service,
        "host": host,
        "trace_id": trace_id,
        "message": message
    })
    .to_string()
}

pub(super) fn logfmt(
    ts: i64,
    level: &str,
    service: &str,
    host: &str,
    trace_id: &str,
    message: &str,
) -> String {
    let message = message.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "ts={ts} level={level} service={service} host={host} trace_id={trace_id} msg=\"{message}\""
    )
}

fn write_scenario(
    root: &Path,
    scenario_id: &str,
    files: &[ImportFile],
    truth: Value,
) -> LabResult<()> {
    let scenario_root = root.join("scenarios").join(scenario_id);
    for file in files {
        write_bytes(&scenario_root.join("import").join(&file.path), &file.bytes)?;
    }
    write_json(&scenario_root.join("truth/manifest.json"), &truth)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> LabResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

pub(super) fn write_json(path: &Path, value: &Value) -> LabResult<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_bytes(path, &bytes)
}

fn write_deterministic_zip(files: &[ImportFile], path: &Path) -> LabResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let time = zip::DateTime::from_date_and_time(2025, 1, 1, 0, 0, 0)?;
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(time)
        .unix_permissions(0o644);
    let mut ordered = files.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    for fixture in ordered {
        zip.start_file(&fixture.path, options)?;
        zip.write_all(&fixture.bytes)?;
    }
    zip.finish()?;
    Ok(())
}

pub fn verify_safety(root: &Path) -> LabResult<()> {
    let mut failures = Vec::new();
    let home = std::env::var("HOME").ok().filter(|value| value.len() > 1);
    let environment_markers = ["USER", "LOGNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|value| value.len() >= 8)
        .collect::<Vec<_>>();
    let current_epoch_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs());
    for path in collect_regular_files(root)? {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if matches!(rel.as_str(), "README.md" | ".gitignore") {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("zip") {
            let file = fs::File::open(&path)?;
            let mut archive = zip::ZipArchive::new(file)?;
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                scan_fixture_bytes(
                    &format!("{rel}:{}", entry.name()),
                    &bytes,
                    home.as_deref(),
                    &environment_markers,
                    current_epoch_seconds,
                    &mut failures,
                );
            }
        } else {
            let bytes = fs::read(&path)?;
            scan_fixture_bytes(
                &rel,
                &bytes,
                home.as_deref(),
                &environment_markers,
                current_epoch_seconds,
                &mut failures,
            );
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("Log Lab safety failures:\n{}", failures.join("\n")).into())
    }
}

fn scan_fixture_bytes(
    label: &str,
    bytes: &[u8],
    home: Option<&str>,
    environment_markers: &[String],
    current_epoch_seconds: Option<u64>,
    failures: &mut Vec<String>,
) {
    let text = String::from_utf8_lossy(bytes);
    for needle in ["/Users/", "/home/", "C:\\Users\\"] {
        if text.contains(needle) {
            failures.push(format!(
                "{label}: contains absolute home-shaped path `{needle}`"
            ));
        }
    }
    if let Some(home) = home {
        if text.contains(home) {
            failures.push(format!("{label}: contains the current HOME value"));
        }
    }
    if environment_markers
        .iter()
        .any(|marker| text.contains(marker))
    {
        failures.push(format!(
            "{label}: contains a value copied from the current environment"
        ));
    }
    if let Some(now) = current_epoch_seconds {
        let start = now.saturating_sub(300);
        let contains_current_clock = (start..=now.saturating_add(300)).any(|timestamp| {
            text.contains(&timestamp.to_string())
                || text.contains(&timestamp.saturating_mul(1_000).to_string())
        });
        if contains_current_clock {
            failures.push(format!("{label}: contains a current-clock epoch timestamp"));
        }
    }
    for token in text.split(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
            )
    }) {
        let candidate = token
            .trim_matches(|ch: char| matches!(ch, ':' | '=' | '/' | '<' | '>' | '.' | '?' | '&'));
        if let Ok(IpAddr::V4(ip)) = candidate.parse::<IpAddr>() {
            if !is_documentation_ip(ip) {
                failures.push(format!("{label}: non-documentation IPv4 address `{ip}`"));
            }
        }
        if token.starts_with("http://") || token.starts_with("https://") {
            match url::Url::parse(token.trim_end_matches([',', '.', '"'])) {
                Ok(url) => {
                    let allowed = url.host_str().is_some_and(|host| {
                        host.ends_with(".example")
                            || host.ends_with(".test")
                            || host.ends_with(".invalid")
                            || (label == "schema/truth.schema.json" && host == "json-schema.org")
                    });
                    if !allowed {
                        failures.push(format!("{label}: non-reserved URL `{token}`"));
                    }
                }
                Err(_) => failures.push(format!("{label}: malformed URL `{token}`")),
            }
        } else if let Some(host) = domain_like_host(token) {
            if !host.ends_with(".example")
                && !host.ends_with(".test")
                && !host.ends_with(".invalid")
            {
                failures.push(format!(
                    "{label}: public-looking bare hostname is not reserved"
                ));
            }
        }
    }
    if text.contains("sk-") && !text.contains("sk-LOG-LAB-INVALID-") {
        failures.push(format!("{label}: unapproved `sk-` credential shape"));
    }
    for line in text.lines().filter(|line| line.contains("Bearer ")) {
        if !line.contains("Bearer LOG-LAB-INVALID-BEARER-") {
            failures.push(format!("{label}: unapproved Bearer credential shape"));
        }
    }
}

fn domain_like_host(token: &str) -> Option<String> {
    let candidate = token
        .rsplit_once('=')
        .map_or(token, |(_, value)| value)
        .trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
            )
        })
        .trim_end_matches('.');
    if candidate.contains('/') || candidate.contains('\\') || candidate.parse::<Ipv4Addr>().is_ok()
    {
        return None;
    }
    let mut labels = candidate.split('.');
    let first = labels.next()?;
    let remaining = labels.collect::<Vec<_>>();
    let tld = remaining.last()?;
    if first.is_empty()
        || !first.chars().any(|ch| ch.is_ascii_alphabetic())
        || !(2..=63).contains(&tld.len())
        || !tld.chars().all(|ch| ch.is_ascii_alphabetic())
        || matches!(
            *tld,
            "log" | "json" | "jsonl" | "txt" | "zip" | "md" | "rs" | "toml"
        )
    {
        return None;
    }
    Some(candidate.to_ascii_lowercase())
}

fn is_documentation_ip(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    matches!(
        octets,
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}

pub fn tree_hashes(root: &Path) -> LabResult<BTreeMap<String, String>> {
    let files = collect_regular_files(root)?;
    hashes_for_paths(root, &files)
}

pub(super) fn hashes_for_paths(
    root: &Path,
    paths: &[PathBuf],
) -> LabResult<BTreeMap<String, String>> {
    let mut hashes = BTreeMap::new();
    for path in paths {
        let rel = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        hashes.insert(rel, sha256_file(path)?);
    }
    Ok(hashes)
}

fn collect_regular_files(root: &Path) -> LabResult<Vec<PathBuf>> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        if !dir.exists() {
            return Ok(());
        }
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
    walk(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn count_import_events(root: &Path) -> LabResult<usize> {
    let mut count = 0usize;
    for path in collect_regular_files(root)? {
        if !path
            .components()
            .any(|component| component.as_os_str() == "import")
        {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("log")
            || matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("jsonl" | "json")
            )
        {
            let bytes = fs::read(path)?;
            if bytes.contains(&0) {
                continue;
            }
            count += String::from_utf8_lossy(&bytes)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count();
        }
    }
    Ok(count)
}

pub(super) fn summarize_generation(
    root: &Path,
    profile: &str,
    events: usize,
) -> LabResult<GenerationSummary> {
    let hashes = tree_hashes(root)?;
    let mut tree_hasher = Sha256::new();
    let mut bytes = 0u64;
    for (path, hash) in &hashes {
        tree_hasher.update(path.as_bytes());
        tree_hasher.update([0]);
        tree_hasher.update(hash.as_bytes());
        tree_hasher.update(*b"\n");
        bytes = bytes.saturating_add(fs::metadata(root.join(path))?.len());
    }
    Ok(GenerationSummary {
        profile: profile.to_string(),
        files: hashes.len(),
        events,
        bytes,
        tree_sha256: format!("{:x}", tree_hasher.finalize()),
    })
}

fn sha256_file(path: &Path) -> LabResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
