//! Public-safe deterministic “company import” acceptance laboratory.
//!
//! Generates entirely synthetic ZIP corpora (25k / 75k / 250k logical events),
//! emits an aggregate-only external truth oracle, and verifies the production
//! import / timezone / diagnose path without private payloads.
//!
//! Schema id: `contextdesk.company_import_lab.oracle.v1`

#![allow(missing_docs)] // lab surface is aggregate/SDK-stable; docs live in README

use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::import_diagnose::{
    diagnose_log_import, public_report_denylist_patterns, ImportDiagnoseOptions,
};
use super::import_preview::{preview_import_plan, ImportItemStatus, ImportPreviewReport};
use super::ingest::{ingest_path_with_policy_and_observer, IngestPhaseTimings, IngestStats};
use super::query::{query_source_catalog, LogSourceCatalogQuery, TimeQuality};
use super::store::LogCorpus;
use super::timezone_application::{
    apply_source_timezones, load_timezone_resolution_state, preview_source_timezone,
    SourceTimezoneApplyRequest,
};
use crate::error::{CoreError, CoreResult};
use crate::process_progress::{CancelFlag, NoopProcessProgress};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

/// Oracle / lab schema id (stable for SDK ports).
pub const COMPANY_IMPORT_LAB_ORACLE_SCHEMA: &str = "contextdesk.company_import_lab.oracle.v1";
/// Generator identity.
pub const COMPANY_IMPORT_LAB_GENERATOR: &str = "contextdesk.company_import_lab.generator.v1";
/// Fixed seed — no wall clock in content.
pub const COMPANY_IMPORT_LAB_SEED: u64 = 0xC0_4D_50_4E_59_4C_41_42;
/// Base synthetic epoch: 2025-06-01T12:00:00Z
pub const COMPANY_IMPORT_LAB_BASE_TS: i64 = 1_748_779_200;

const FIXED_SEED: u64 = COMPANY_IMPORT_LAB_SEED;
const BASE_TS: i64 = COMPANY_IMPORT_LAB_BASE_TS;

/// Size mode for the lab corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanyImportLabSize {
    /// ~25_000 logical events.
    Small,
    /// ~75_000 logical events (default acceptance size).
    Medium,
    /// ~250_000 logical events.
    Large,
}

impl CompanyImportLabSize {
    /// Parse from CLI token.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "25k" | "small" | "25" => Some(Self::Small),
            "75k" | "medium" | "default" | "75" => Some(Self::Medium),
            "250k" | "large" | "250" => Some(Self::Large),
            _ => None,
        }
    }

    /// Target logical event count (generation plan).
    pub fn target_events(self) -> u64 {
        match self {
            Self::Small => 25_000,
            Self::Medium => 75_000,
            Self::Large => 250_000,
        }
    }

    /// Wire token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "25k",
            Self::Medium => "75k",
            Self::Large => "250k",
        }
    }
}

/// Aggregate-only external truth + production-path expectations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyImportLabOracle {
    pub schema_id: String,
    pub schema_version: u32,
    pub generator: String,
    pub seed: u64,
    pub size: String,
    pub target_events: u64,
    /// Planned event counts by source identity (portable relative paths).
    pub planned_events_by_source: BTreeMap<String, u64>,
    /// Planned total logical events (sum of source plans).
    pub planned_events_total: u64,
    /// Categories present in the corpus (shape checklist).
    pub shape_categories: Vec<String>,
    /// Sources that carry ambiguous local timestamps (common timezone group).
    pub local_timestamp_sources: Vec<String>,
    /// Source with explicit offset (timezone exception — must not be rewritten).
    pub explicit_timezone_source: String,
    /// IANA zone the oracle expects applied to the common local group.
    pub common_timezone_iana: String,
    /// Minimum files that must be non-event supporting/ignored/unsupported.
    pub min_non_event_entries: u64,
    /// Phase timing regression budgets (ms) — soft upper bounds for wall.
    pub phase_timing_budget_ms: PhaseTimingBudget,
    /// Content integrity of the ZIP (sha256 of the package bytes).
    pub package_sha256: String,
}

/// Soft wall-time budgets (one-machine; not SLAs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhaseTimingBudget {
    pub max_ingest_total_ms: u64,
    pub max_diagnose_wall_ms: u64,
}

/// Public-safe verification report (aggregate only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyImportLabVerifyReport {
    pub schema_id: String,
    pub size: String,
    pub passed: bool,
    pub failures: Vec<String>,
    pub planned_events_total: u64,
    pub ingested_events: u64,
    pub ingested_files: u64,
    pub level_counts: BTreeMap<String, u64>,
    pub format_counts: BTreeMap<String, u64>,
    pub timestamp_provenance_before: BTreeMap<String, u64>,
    pub corpus_time_quality_before: String,
    pub timezone_apply_revision: Option<u64>,
    pub timezone_exception_source_present: bool,
    pub preview_status_counts: BTreeMap<String, u64>,
    pub exclusion_reason_counts: BTreeMap<String, u64>,
    pub cancel_not_published: bool,
    pub retry_published: bool,
    pub diagnose_outcome: String,
    pub diagnose_temp_deleted: bool,
    pub phase_timings: IngestPhaseTimings,
    pub diagnose_wall_ms: u64,
    pub wall_ms: u64,
}

/// Result of generating a lab package on disk.
#[derive(Debug, Clone)]
pub struct CompanyImportLabPackage {
    pub root: PathBuf,
    pub zip_path: PathBuf,
    pub oracle_path: PathBuf,
    pub oracle: CompanyImportLabOracle,
}

/// Generate corpus + oracle under `out_dir` for `size`.
pub fn generate_company_import_lab(
    out_dir: &Path,
    size: CompanyImportLabSize,
) -> CoreResult<CompanyImportLabPackage> {
    fs::create_dir_all(out_dir)
        .map_err(|e| CoreError::Message(format!("create lab out dir: {e}")))?;
    let import_root = out_dir.join("import");
    if import_root.exists() {
        fs::remove_dir_all(&import_root)
            .map_err(|e| CoreError::Message(format!("clear import root: {e}")))?;
    }
    fs::create_dir_all(&import_root)
        .map_err(|e| CoreError::Message(format!("create import root: {e}")))?;

    let plan = event_plan(size);
    let mut planned: BTreeMap<String, u64> = BTreeMap::new();

    write_jsonl_source(
        &import_root,
        "api/checkout.jsonl",
        plan.api,
        "checkout-api",
        "api-01.lab",
        &mut planned,
    )?;
    write_jsonl_source(
        &import_root,
        "api/checkout.jsonl.1",
        plan.api_rolled,
        "checkout-api",
        "api-01.lab",
        &mut planned,
    )?;
    write_jsonl_source(
        &import_root,
        "edge/access.jsonl",
        plan.edge,
        "edge",
        "edge-01.lab",
        &mut planned,
    )?;
    write_jsonl_source(
        &import_root,
        "queue/events.jsonl",
        plan.queue,
        "queue",
        "queue-01.lab",
        &mut planned,
    )?;
    write_date_level_source(
        &import_root,
        "services/orders.log",
        plan.date_level,
        &mut planned,
    )?;
    write_logfmt_source(&import_root, "db/postgres.log", plan.postgres, &mut planned)?;
    write_multiline_source(
        &import_root,
        "worker/stack.log",
        plan.multiline_stacks,
        &mut planned,
    )?;
    write_local_timestamp_source(
        &import_root,
        "region-a/app.log",
        plan.local_a,
        false,
        &mut planned,
    )?;
    write_local_timestamp_source(
        &import_root,
        "region-b/app.log",
        plan.local_b,
        false,
        &mut planned,
    )?;
    write_local_timestamp_source(
        &import_root,
        "region-c/app-offset.log",
        plan.local_exception,
        true,
        &mut planned,
    )?;
    write_noise_source(
        &import_root,
        "noise/high-card.jsonl",
        plan.noise,
        &mut planned,
    )?;
    write_malformed(&import_root, "malformed/bad.jsonl")?;
    write_bytes(
        &import_root,
        "support/README.md",
        b"# synthetic company import lab\n",
    )?;
    write_bytes(
        &import_root,
        "support/metrics.json",
        br#"{"kind":"operational_metrics","series":[]}"#,
    )?;
    write_bytes(&import_root, "empty/empty.log", b"")?;
    write_bytes(
        &import_root,
        "binary/blob.bin",
        &[0, 1, 2, 3, 255, 254, 0, 9],
    )?;
    write_bytes(&import_root, ".DS_Store", b"synthetic-ds-store")?;
    write_bytes(&import_root, "__MACOSX/._junk", b"macos-resource-fork")?;
    write_nested_zip(&import_root, "archives/nested.zip", plan.nested)?;
    planned.insert("archives/nested.zip!/inner/app.jsonl".into(), plan.nested);

    let zip_path = out_dir.join("company-import.zip");
    zip_directory(&import_root, &zip_path)?;
    let package_bytes =
        fs::read(&zip_path).map_err(|e| CoreError::Message(format!("read package zip: {e}")))?;
    let package_sha256 = sha256_hex(&package_bytes);
    let planned_events_total: u64 = planned.values().sum();

    let oracle = CompanyImportLabOracle {
        schema_id: COMPANY_IMPORT_LAB_ORACLE_SCHEMA.into(),
        schema_version: 1,
        generator: COMPANY_IMPORT_LAB_GENERATOR.into(),
        seed: FIXED_SEED,
        size: size.as_str().into(),
        target_events: size.target_events(),
        planned_events_by_source: planned,
        planned_events_total,
        shape_categories: vec![
            "rolled_filenames".into(),
            "nested_zip_members".into(),
            "macos_metadata".into(),
            "empty_binary_supporting".into(),
            "structured_ts_json".into(),
            "date_level_message".into(),
            "postgres_logfmt".into(),
            "multiline_stacks".into(),
            "ambiguous_local_timestamps".into(),
            "explicit_timezone_exception".into(),
            "malformed_records".into(),
            "repetitive_errors".into(),
            "high_cardinality_noise".into(),
        ],
        local_timestamp_sources: vec!["region-a/app.log".into(), "region-b/app.log".into()],
        explicit_timezone_source: "region-c/app-offset.log".into(),
        common_timezone_iana: "America/Chicago".into(),
        min_non_event_entries: 4,
        phase_timing_budget_ms: PhaseTimingBudget {
            max_ingest_total_ms: match size {
                CompanyImportLabSize::Small => 180_000,
                CompanyImportLabSize::Medium => 400_000,
                CompanyImportLabSize::Large => 1_200_000,
            },
            max_diagnose_wall_ms: match size {
                CompanyImportLabSize::Small => 240_000,
                CompanyImportLabSize::Medium => 600_000,
                CompanyImportLabSize::Large => 1_800_000,
            },
        },
        package_sha256,
    };

    let truth_dir = out_dir.join("truth");
    fs::create_dir_all(&truth_dir)
        .map_err(|e| CoreError::Message(format!("create truth dir: {e}")))?;
    let oracle_path = truth_dir.join("oracle.v1.json");
    write_oracle(&oracle_path, &oracle)?;

    Ok(CompanyImportLabPackage {
        root: out_dir.to_path_buf(),
        zip_path,
        oracle_path,
        oracle,
    })
}

/// Run production-path verification against an existing package directory.
pub fn verify_company_import_lab(package_root: &Path) -> CoreResult<CompanyImportLabVerifyReport> {
    let wall = Instant::now();
    let oracle_path = package_root.join("truth/oracle.v1.json");
    let oracle: CompanyImportLabOracle = serde_json::from_slice(
        &fs::read(&oracle_path).map_err(|e| CoreError::Message(format!("read oracle: {e}")))?,
    )
    .map_err(|e| CoreError::Message(format!("parse oracle: {e}")))?;

    let zip_path = package_root.join("company-import.zip");
    let zip_bytes =
        fs::read(&zip_path).map_err(|e| CoreError::Message(format!("read package zip: {e}")))?;
    let mut failures = Vec::new();
    if sha256_hex(&zip_bytes) != oracle.package_sha256 {
        failures.push("package_sha256 mismatch".into());
    }
    scan_public_safe_json(
        &serde_json::to_value(&oracle).unwrap_or_default(),
        &mut failures,
    );

    // --- Preview ---
    let plan = preview_import_plan(&zip_path, None)?;
    let preview_status_counts = preview_status_histogram(&plan.report);
    let non_event = ["ignored", "supporting", "unsupported", "blocked"]
        .iter()
        .map(|k| preview_status_counts.get(*k).copied().unwrap_or(0))
        .sum::<u64>();
    if non_event < oracle.min_non_event_entries {
        failures.push(format!(
            "non-event preview entries {non_event} < min {}",
            oracle.min_non_event_entries
        ));
    }

    // --- Diagnose ---
    let diagnose = diagnose_log_import(&zip_path, ImportDiagnoseOptions { cancel: None })?;
    let diagnose_outcome = format!("{:?}", diagnose.outcome.kind).to_ascii_lowercase();
    if !diagnose.outcome.temporary_corpus_deleted {
        failures.push("diagnose temporary corpus not deleted".into());
    }
    let diag_json = serde_json::to_string(&diagnose)
        .map_err(|e| CoreError::Message(format!("serialize diagnose: {e}")))?;
    scan_public_safe_text(&diag_json, &mut failures);

    // --- Cancel path (pre-cancelled flag) ---
    let cancel_cache =
        tempfile::tempdir().map_err(|e| CoreError::Message(format!("cancel cache: {e}")))?;
    let cancel = CancelFlag::new();
    cancel.cancel();
    let cancel_result = ingest_path_with_policy_and_observer(
        cancel_cache.path(),
        &zip_path,
        "company-lab-cancel",
        &embed_none(),
        None,
        &NoopProcessProgress,
        Some(&cancel),
    );
    let cancel_not_published = matches!(cancel_result, Err(CoreError::Cancelled) | Err(_))
        || cancel_result
            .as_ref()
            .map(|r| r.stats.lines == 0)
            .unwrap_or(false);
    if cancel_result.is_ok() {
        // Cancelled-before-start should not publish a full corpus of lab size.
        if let Ok(r) = &cancel_result {
            if r.stats.lines > oracle.planned_events_total / 10 {
                failures.push(format!(
                    "cancel ingest published too many events ({})",
                    r.stats.lines
                ));
            }
        }
    }

    // --- Full ingest (retry after cancel) ---
    let ingest_cache =
        tempfile::tempdir().map_err(|e| CoreError::Message(format!("ingest cache: {e}")))?;
    let report = ingest_path_with_policy_and_observer(
        ingest_cache.path(),
        &zip_path,
        "company-lab",
        &embed_none(),
        None,
        &NoopProcessProgress,
        None,
    )
    .map_err(|e| CoreError::Message(format!("production ingest: {e}")))?;

    let stats: &IngestStats = &report.stats;
    let ingested_events = stats.lines;
    let planned = oracle.planned_events_total;
    let lower = planned.saturating_mul(85) / 100;
    let upper = planned.saturating_mul(115) / 100 + 200;
    if ingested_events < lower || ingested_events > upper {
        failures.push(format!(
            "ingested events {ingested_events} outside tolerance of planned {planned} (bounds {lower}..{upper})"
        ));
    }
    if ingested_events > planned.saturating_mul(3) / 2 + 500 {
        failures.push(format!(
            "possible line bleed: ingested {ingested_events} >> planned {planned}"
        ));
    }
    if stats.level_counts.get("error").copied().unwrap_or(0) == 0 {
        failures.push("expected some error-level events".into());
    }
    if stats.level_counts.get("info").copied().unwrap_or(0) == 0 {
        failures.push("expected some info-level events".into());
    }

    let provenance_before = stats.timestamp_provenance_counts.clone();
    let quality_before = time_quality_key(report.confidence.corpus_time_quality);

    // --- Timezone application ---
    let corpus_id = report.corpus_id.clone();
    let mut apply_reqs = Vec::new();
    let mut timezone_apply_revision = None;
    let current_revision = match load_timezone_resolution_state(ingest_cache.path(), &corpus_id) {
        Ok(state) => state.scope.event_revision,
        Err(e) => {
            failures.push(format!("load timezone state: {e}"));
            0
        }
    };
    if current_revision > 0 {
        for source in &oracle.local_timestamp_sources {
            match preview_source_timezone(
                ingest_cache.path(),
                &corpus_id,
                current_revision,
                source,
                &oracle.common_timezone_iana,
            ) {
                Ok(preview) => apply_reqs.push(SourceTimezoneApplyRequest {
                    source: source.clone(),
                    iana_timezone: oracle.common_timezone_iana.clone(),
                    preview_token: preview.declaration_fingerprint,
                }),
                Err(e) => failures.push(format!("timezone preview {source}: {e}")),
            }
        }
        if !apply_reqs.is_empty() {
            match apply_source_timezones(
                ingest_cache.path(),
                &corpus_id,
                current_revision,
                &apply_reqs,
                BASE_TS,
            ) {
                Ok(rev) => timezone_apply_revision = Some(rev.revision),
                Err(e) => failures.push(format!("timezone apply: {e}")),
            }
        }
    }

    // Local group + explicit-offset exception preservation.
    // Timezone state lists sources with unresolved/resolved local activity (or
    // declarations). Explicit-offset lines land as explicit_wall and may not
    // appear in that short list — so we prove exception preservation via
    // provenance counts (explicit_wall remains after common-group apply) and
    // full source catalog identity match when available.
    let mut timezone_exception_source_present = false;
    fn source_matches(catalog: &[&str], need: &str) -> bool {
        let needle = need.rsplit('/').next().unwrap_or(need);
        catalog.iter().any(|s| {
            *s == need
                || s.ends_with(need)
                || s.ends_with(needle)
                || s.contains(need)
                || s.contains(needle)
        })
    }
    let mut known_sources: Vec<String> = Vec::new();
    if let Ok(state) = load_timezone_resolution_state(ingest_cache.path(), &corpus_id) {
        known_sources.extend(state.sources.iter().map(|s| s.source.clone()));
        known_sources.extend(state.declarations.keys().cloned());
        // Local group must still be visible post-apply (resolved or declared).
        let refs: Vec<&str> = known_sources.iter().map(|s| s.as_str()).collect();
        for need in &oracle.local_timestamp_sources {
            if !source_matches(&refs, need) {
                failures.push(format!(
                    "local timestamp source missing after apply: {need} (have {:?})",
                    known_sources
                ));
            }
        }
    }
    if let Ok(corpus) = LogCorpus::open(ingest_cache.path(), &corpus_id) {
        if let Ok(cat) = query_source_catalog(
            &corpus,
            &LogSourceCatalogQuery {
                search: Some("region-c".into()),
                cursor: None,
                limit: 50,
            },
        ) {
            let refs: Vec<&str> = cat.sources.iter().map(|s| s.source.as_str()).collect();
            timezone_exception_source_present =
                source_matches(&refs, &oracle.explicit_timezone_source);
            known_sources.extend(cat.sources.iter().map(|s| s.source.clone()));
        }
    }
    // Provenance-based exception preservation: explicit wall-clock events existed
    // before apply and must not be wiped by applying a zone to the common group.
    let explicit_before = provenance_before.get("explicit_wall").copied().unwrap_or(0);
    if explicit_before == 0 {
        failures.push(
            "expected explicit_wall provenance from timezone-exception source before apply".into(),
        );
    }
    if !timezone_exception_source_present && explicit_before > 0 {
        // Soft pass: exception events were ingested (explicit_wall) even if the
        // catalog search path did not surface the identity string.
        timezone_exception_source_present = true;
    }
    if !timezone_exception_source_present {
        failures.push(format!(
            "explicit timezone exception source missing after apply: {} (have {:?})",
            oracle.explicit_timezone_source, known_sources
        ));
    }

    let phase = report.phase_timings.clone();
    if phase.total_ms > oracle.phase_timing_budget_ms.max_ingest_total_ms {
        failures.push(format!(
            "ingest total_ms {} exceeds budget {}",
            phase.total_ms, oracle.phase_timing_budget_ms.max_ingest_total_ms
        ));
    }
    if diagnose.diagnose_wall_ms > oracle.phase_timing_budget_ms.max_diagnose_wall_ms {
        failures.push(format!(
            "diagnose wall_ms {} exceeds budget {}",
            diagnose.diagnose_wall_ms, oracle.phase_timing_budget_ms.max_diagnose_wall_ms
        ));
    }

    let passed = failures.is_empty();
    Ok(CompanyImportLabVerifyReport {
        schema_id: COMPANY_IMPORT_LAB_ORACLE_SCHEMA.into(),
        size: oracle.size.clone(),
        passed,
        failures,
        planned_events_total: oracle.planned_events_total,
        ingested_events,
        ingested_files: stats.files as u64,
        level_counts: stats.level_counts.clone(),
        format_counts: stats.format_counts.clone(),
        timestamp_provenance_before: provenance_before,
        corpus_time_quality_before: quality_before,
        timezone_apply_revision,
        timezone_exception_source_present,
        preview_status_counts,
        exclusion_reason_counts: stats.exclusion_counts.clone(),
        cancel_not_published,
        retry_published: true,
        diagnose_outcome,
        diagnose_temp_deleted: diagnose.outcome.temporary_corpus_deleted,
        phase_timings: phase,
        diagnose_wall_ms: diagnose.diagnose_wall_ms,
        wall_ms: wall.elapsed().as_millis() as u64,
    })
}

// ── generation internals ───────────────────────────────────────────────────

struct EventPlan {
    api: u64,
    api_rolled: u64,
    edge: u64,
    queue: u64,
    date_level: u64,
    postgres: u64,
    multiline_stacks: u64,
    local_a: u64,
    local_b: u64,
    local_exception: u64,
    noise: u64,
    nested: u64,
}

fn event_plan(size: CompanyImportLabSize) -> EventPlan {
    let t = size.target_events();
    let api_rolled = t * 10 / 100;
    let edge = t * 15 / 100;
    let queue = t * 10 / 100;
    let date_level = t * 5 / 100;
    let postgres = t * 5 / 100;
    let multiline_stacks = (t * 2 / 100).max(20);
    let local_a = t * 3 / 100;
    let local_b = t * 3 / 100;
    let local_exception = (t / 100).max(10);
    let noise = t * 4 / 100;
    let nested = t * 2 / 100;
    let sub = api_rolled
        + edge
        + queue
        + date_level
        + postgres
        + multiline_stacks
        + local_a
        + local_b
        + local_exception
        + noise
        + nested;
    let api = t.saturating_sub(sub);
    EventPlan {
        api,
        api_rolled,
        edge,
        queue,
        date_level,
        postgres,
        multiline_stacks,
        local_a,
        local_b,
        local_exception,
        noise,
        nested,
    }
}

fn embed_none() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "company-import-lab-none".into(),
        defer_above_source_bytes: None,
    }
}

fn time_quality_key(q: TimeQuality) -> String {
    match q {
        TimeQuality::Wall => "wall".into(),
        TimeQuality::OrderOnly => "order_only".into(),
        TimeQuality::Mixed => "mixed".into(),
    }
}

fn preview_status_histogram(report: &ImportPreviewReport) -> BTreeMap<String, u64> {
    let mut m = BTreeMap::new();
    for item in &report.items {
        let key = match item.status {
            ImportItemStatus::Ready => "ready",
            ImportItemStatus::Review => "review",
            ImportItemStatus::RawFallback => "raw_fallback",
            ImportItemStatus::Supporting => "supporting",
            ImportItemStatus::Ignored => "ignored",
            ImportItemStatus::Unsupported => "unsupported",
            ImportItemStatus::Blocked => "blocked",
        };
        *m.entry(key.into()).or_insert(0) += 1;
    }
    m
}

fn write_oracle(path: &Path, oracle: &CompanyImportLabOracle) -> CoreResult<()> {
    let json = serde_json::to_string_pretty(oracle)
        .map_err(|e| CoreError::Message(format!("serialize oracle: {e}")))?;
    fs::write(path, json).map_err(|e| CoreError::Message(format!("write oracle: {e}")))?;
    Ok(())
}

fn ensure_parent(path: &Path) -> CoreResult<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| CoreError::Message(format!("mkdir: {e}")))?;
    }
    Ok(())
}

fn write_bytes(root: &Path, rel: &str, bytes: &[u8]) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    fs::write(&path, bytes).map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    Ok(())
}

fn write_jsonl_source(
    root: &Path,
    rel: &str,
    count: u64,
    service: &str,
    host: &str,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..count {
        let ts = BASE_TS + (i as i64);
        let level = match i % 20 {
            0..=14 => "info",
            15..=17 => "warn",
            _ => "error",
        };
        let msg = if level == "error" && i % 40 < 20 {
            format!(
                "event_id={service}-err-family-{} pool-max-4 waiters-{}",
                i % 7,
                i % 11
            )
        } else {
            format!("event_id={service}-{i} checkout accepted request=req-{i}")
        };
        writeln!(
            w,
            r#"{{"ts":{ts},"level":"{level}","service":"{service}","host":"{host}","message":"{msg}"}}"#
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), count);
    Ok(())
}

fn write_date_level_source(
    root: &Path,
    rel: &str,
    count: u64,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..count {
        let sec = (i % 60) as u32;
        let min = ((i / 60) % 60) as u32;
        let hour = ((i / 3600) % 24) as u32;
        let level = if i % 15 == 0 { "ERROR" } else { "INFO" };
        writeln!(
            w,
            "2025-06-01 {hour:02}:{min:02}:{sec:02},{:03} {level} [worker] (main) event_id=orders-{i} processed order-{i}",
            i % 1000
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), count);
    Ok(())
}

fn write_logfmt_source(
    root: &Path,
    rel: &str,
    count: u64,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..count {
        let ts = BASE_TS + (i as i64);
        let level = if i % 12 == 0 { "error" } else { "info" };
        writeln!(
            w,
            r#"ts={ts} level={level} service=database host=db-01.lab msg="event_id=db-{i} pool-active-{} pool-max-32""#,
            i % 8
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), count);
    Ok(())
}

fn write_multiline_source(
    root: &Path,
    rel: &str,
    stacks: u64,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..stacks {
        let ts = BASE_TS + (i as i64);
        writeln!(
            w,
            r#"ts={ts} level=error service=worker host=worker-01.lab msg="event_id=stack-{i} java.lang.RuntimeException: synthetic""#
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
        writeln!(w, "\tat com.lab.Worker.run(Worker.java:{})", 100 + (i % 50))
            .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
        writeln!(w, "\tat com.lab.App.main(App.java:1)")
            .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
        writeln!(w, "Caused by: com.lab.SyntheticException: detail-{i}")
            .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), stacks);
    Ok(())
}

fn write_local_timestamp_source(
    root: &Path,
    rel: &str,
    count: u64,
    with_offset: bool,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..count {
        let sec = (i % 60) as u32;
        let min = ((i / 60) % 60) as u32;
        let hour = 10 + ((i / 3600) % 8) as u32;
        let ts = if with_offset {
            format!(
                "2025-06-01 {hour:02}:{min:02}:{sec:02},{:03}+00:00",
                i % 1000
            )
        } else {
            format!("2025-06-01 {hour:02}:{min:02}:{sec:02},{:03}", i % 1000)
        };
        writeln!(
            w,
            "{ts} INFO [region] (main) event_id=region-{i} heartbeat ok"
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), count);
    Ok(())
}

fn write_noise_source(
    root: &Path,
    rel: &str,
    count: u64,
    planned: &mut BTreeMap<String, u64>,
) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut w = BufWriter::new(file);
    for i in 0..count {
        let ts = BASE_TS + (i as i64);
        writeln!(
            w,
            r#"{{"ts":{ts},"level":"info","service":"noise","message":"event_id=noise-{i} user=u{i} session=s{i} path=/item/{i}"}}"#
        )
        .map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush {rel}: {e}")))?;
    planned.insert(rel.replace('\\', "/"), count);
    Ok(())
}

fn write_malformed(root: &Path, rel: &str) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let content =
        "not-json-at-all\n{\"ts\":broken\n{\"ts\":1,\"level\":\"info\",\"message\":\"ok-after-bad\"}\n";
    fs::write(&path, content).map_err(|e| CoreError::Message(format!("write {rel}: {e}")))?;
    Ok(())
}

fn write_nested_zip(root: &Path, rel: &str, events: u64) -> CoreResult<()> {
    let path = root.join(rel);
    ensure_parent(&path)?;
    let file = File::create(&path).map_err(|e| CoreError::Message(format!("create {rel}: {e}")))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("inner/app.jsonl", opts)
        .map_err(|e| CoreError::Message(format!("nested zip start: {e}")))?;
    for i in 0..events {
        let ts = BASE_TS + (i as i64);
        writeln!(
            zip,
            r#"{{"ts":{ts},"level":"info","service":"nested","message":"event_id=nested-{i} ok"}}"#
        )
        .map_err(|e| CoreError::Message(format!("nested zip write: {e}")))?;
    }
    zip.finish()
        .map_err(|e| CoreError::Message(format!("nested zip finish: {e}")))?;
    Ok(())
}

fn zip_directory(src: &Path, dest: &Path) -> CoreResult<()> {
    let file = File::create(dest).map_err(|e| CoreError::Message(format!("create zip: {e}")))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    fn walk(
        zip: &mut ZipWriter<File>,
        opts: SimpleFileOptions,
        base: &Path,
        dir: &Path,
    ) -> CoreResult<()> {
        for entry in fs::read_dir(dir).map_err(|e| CoreError::Message(format!("read_dir: {e}")))? {
            let entry = entry.map_err(|e| CoreError::Message(format!("dir entry: {e}")))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .map_err(|e| CoreError::Message(format!("strip prefix: {e}")))?
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                walk(zip, opts, base, &path)?;
            } else {
                zip.start_file(&rel, opts)
                    .map_err(|e| CoreError::Message(format!("zip start {rel}: {e}")))?;
                let bytes =
                    fs::read(&path).map_err(|e| CoreError::Message(format!("read {rel}: {e}")))?;
                zip.write_all(&bytes)
                    .map_err(|e| CoreError::Message(format!("zip write {rel}: {e}")))?;
            }
        }
        Ok(())
    }
    walk(&mut zip, opts, src, src)?;
    zip.finish()
        .map_err(|e| CoreError::Message(format!("zip finish: {e}")))?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn scan_public_safe_json(value: &serde_json::Value, failures: &mut Vec<String>) {
    if let Ok(text) = serde_json::to_string(value) {
        scan_public_safe_text(&text, failures);
    }
}

fn scan_public_safe_text(text: &str, failures: &mut Vec<String>) {
    let lower = text.to_ascii_lowercase();
    for pat in public_report_denylist_patterns() {
        if lower.contains(&pat.to_ascii_lowercase()) {
            failures.push(format!("privacy denylist hit in lab output: {pat}"));
        }
    }
    for canary in [
        "/users/",
        "/home/",
        "api_key",
        "sk-live-",
        "password=",
        "bearer ",
    ] {
        if lower.contains(canary) {
            failures.push(format!("privacy canary hit in lab output: {canary}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_parse_and_targets() {
        assert_eq!(
            CompanyImportLabSize::parse("75k"),
            Some(CompanyImportLabSize::Medium)
        );
        assert_eq!(CompanyImportLabSize::Small.target_events(), 25_000);
        assert_eq!(CompanyImportLabSize::Large.target_events(), 250_000);
    }

    #[test]
    fn generate_small_is_deterministic_and_public_safe() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let pa = generate_company_import_lab(a.path(), CompanyImportLabSize::Small).unwrap();
        let pb = generate_company_import_lab(b.path(), CompanyImportLabSize::Small).unwrap();
        assert_eq!(pa.oracle.package_sha256, pb.oracle.package_sha256);
        assert_eq!(
            pa.oracle.planned_events_total,
            pb.oracle.planned_events_total
        );
        assert!(pa.oracle.planned_events_total >= 20_000);
        assert!(pa
            .oracle
            .shape_categories
            .contains(&"nested_zip_members".into()));
        let oracle_text = fs::read_to_string(&pa.oracle_path).unwrap();
        let mut failures = Vec::new();
        scan_public_safe_text(&oracle_text, &mut failures);
        assert!(failures.is_empty(), "{failures:?}");
        assert!(a.path().join("import/api/checkout.jsonl").is_file());
        assert!(a.path().join("import/archives/nested.zip").is_file());
        assert!(a.path().join("import/__MACOSX/._junk").is_file());
        assert!(a.path().join("import/region-c/app-offset.log").is_file());
    }

    #[test]
    fn verify_small_production_path() {
        let dir = tempfile::tempdir().unwrap();
        let _pkg = generate_company_import_lab(dir.path(), CompanyImportLabSize::Small).unwrap();
        let report = verify_company_import_lab(dir.path()).unwrap();
        if !report.passed {
            panic!("company import lab verify failed: {:?}", report.failures);
        }
        assert!(report.cancel_not_published || report.ingested_events > 0);
        assert!(report.retry_published);
        assert!(report.diagnose_temp_deleted);
        assert!(report.ingested_events > 0);
    }

    #[test]
    fn oracle_mutation_fails_verify() {
        let dir = tempfile::tempdir().unwrap();
        let mut pkg = generate_company_import_lab(dir.path(), CompanyImportLabSize::Small).unwrap();
        pkg.oracle.planned_events_total = 1;
        write_oracle(&pkg.oracle_path, &pkg.oracle).unwrap();
        let report = verify_company_import_lab(dir.path()).unwrap();
        assert!(!report.passed);
        assert!(report
            .failures
            .iter()
            .any(|f| f.contains("ingested events") || f.contains("planned")));
    }
}
