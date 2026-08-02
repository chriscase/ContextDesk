//! Public-safe deterministic “company import” acceptance laboratory.
//!
//! Generates entirely synthetic ZIP corpora (25k / 75k / 250k logical events),
//! emits an aggregate-only external truth oracle, and verifies the production
//! import / timezone / diagnose path without private payloads.
//!
//! Schema id: `contextdesk.company_import_lab.oracle.v1`
//!
//! Production path mirrors the shipped **EngineClient** host commands
//! (`log_preview_import` → `verify_import_plan` + selection-bound ingest
//! ≈ `log_run_import`, timezone commands, `diagnose_log_import`).

#![allow(missing_docs)] // lab surface is aggregate/SDK-stable; docs live in README

use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::import_diagnose::{
    diagnose_log_import, public_report_denylist_patterns, ImportDiagnoseOptions,
};
use super::import_preview::{
    event_importable, preview_import_plan, verify_import_plan, ImportItemStatus,
    ImportPreviewReason, ImportPreviewReport,
};
use super::ingest::{
    ingest_path_with_policy_selection_and_observer, IngestPhaseTimings, IngestStats,
};
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
use zip::DateTime;
use zip::ZipWriter;

/// Fixed ZIP member mtime so package_sha256 is deterministic across runs.
fn zip_file_options() -> SimpleFileOptions {
    let mtime =
        DateTime::from_date_and_time(2025, 6, 1, 12, 0, 0).unwrap_or_else(|_| DateTime::default());
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(mtime)
}

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
///
/// Expected counts are computed at generation time so verify can fail closed
/// on level/format/selection/template drift — not merely echo observed values.
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
    /// Planned top-level ingest events (must land in production corpus).
    pub planned_events_total: u64,
    /// Nested ZIP member events that production must expand and ingest.
    pub planned_nested_member_events: u64,
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
    /// Minimum expected level counts (fail closed if below).
    pub expected_level_counts_min: BTreeMap<String, u64>,
    /// Minimum expected format counts (fail closed if below).
    pub expected_format_counts_min: BTreeMap<String, u64>,
    /// Minimum preview status counts (fail closed if below).
    pub expected_preview_status_mins: BTreeMap<String, u64>,
    /// Minimum exclusion reason counts (fail closed if below).
    pub expected_exclusion_reason_mins: BTreeMap<String, u64>,
    /// Minimum distinct templates after ingest.
    pub min_template_count: u64,
    /// Minimum templates whose event count is high enough to count as repetitive families.
    pub min_repetitive_template_count: u64,
    /// Minimum unresolved_local provenance before timezone apply.
    pub min_unresolved_local_before: u64,
    /// Minimum explicit_wall provenance before timezone apply (exception + structured).
    pub min_explicit_wall_before: u64,
    /// Absolute tolerance on planned_events_total (not a percentage greenwash).
    pub ingest_event_tolerance_abs: u64,
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
    pub planned_nested_member_events: u64,
    pub ingested_events: u64,
    pub nested_events_ingested: u64,
    pub ingested_files: u64,
    pub level_counts: BTreeMap<String, u64>,
    pub format_counts: BTreeMap<String, u64>,
    pub timestamp_provenance_before: BTreeMap<String, u64>,
    pub timestamp_provenance_after: BTreeMap<String, u64>,
    pub corpus_time_quality_before: String,
    pub corpus_time_quality_after: String,
    pub timezone_apply_revision: Option<u64>,
    pub timezone_exception_source_present: bool,
    pub timezone_exception_explicit_wall_after: u64,
    pub local_group_unresolved_before: u64,
    pub local_group_unresolved_after: u64,
    pub local_group_resolved_after: u64,
    pub template_count: u64,
    pub repetitive_template_count: u64,
    pub preview_status_counts: BTreeMap<String, u64>,
    pub exclusion_reason_counts: BTreeMap<String, u64>,
    pub cancel_not_published: bool,
    pub cancel_error_kind: String,
    pub retry_published: bool,
    pub engine_client_path: bool,
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
    // Nested ZIP members: production must expand these (EngineClient ingest path).
    write_nested_zip(&import_root, "archives/nested.zip", plan.nested)?;
    // Nested members are tracked separately: production selection-bound ingest
    // must expand them. They are not folded into planned_events_total so a
    // nested miss cannot hide behind a wide percentage band.
    let planned_nested_member_events = plan.nested;
    planned.insert(
        "archives/nested.zip!/inner/app.jsonl".into(),
        planned_nested_member_events,
    );

    let zip_path = out_dir.join("company-import.zip");
    zip_directory(&import_root, &zip_path)?;
    let package_bytes =
        fs::read(&zip_path).map_err(|e| CoreError::Message(format!("read package zip: {e}")))?;
    let package_sha256 = sha256_hex(&package_bytes);
    // Top-level planned ingest only (nested asserted separately).
    let planned_events_total: u64 = planned
        .iter()
        .filter(|(k, _)| !k.contains("nested.zip"))
        .map(|(_, v)| *v)
        .sum();

    // Expected aggregates derived from the generator plan (not observed).
    let json_events =
        plan.api + plan.api_rolled + plan.edge + plan.queue + plan.noise + plan.nested;
    // jsonl levels: info ~75%, warn ~15%, error ~10% of json family
    let mut expected_level_counts_min = BTreeMap::new();
    expected_level_counts_min.insert("info".into(), (json_events * 60 / 100).max(100));
    expected_level_counts_min.insert("error".into(), (json_events * 5 / 100).max(10));
    expected_level_counts_min.insert("warn".into(), (json_events * 5 / 100).max(5));
    let mut expected_format_counts_min = BTreeMap::new();
    expected_format_counts_min.insert("json".into(), (json_events * 85 / 100).max(100));
    expected_format_counts_min.insert("logfmt".into(), plan.postgres * 80 / 100);
    let mut expected_preview_status_mins = BTreeMap::new();
    expected_preview_status_mins.insert("ready".into(), 8);
    expected_preview_status_mins.insert("ignored".into(), 1);
    let expected_exclusion_reason_mins = BTreeMap::new();
    // Binary/empty/hidden are required as non-event inventory; under
    // selection-bound ingest they may land as ignored:not_selected rather than
    // exclusion_counts — enforce via expected_preview_status_mins instead.

    let local_total = plan.local_a + plan.local_b;
    let oracle = CompanyImportLabOracle {
        schema_id: COMPANY_IMPORT_LAB_ORACLE_SCHEMA.into(),
        schema_version: 2,
        generator: COMPANY_IMPORT_LAB_GENERATOR.into(),
        seed: FIXED_SEED,
        size: size.as_str().into(),
        target_events: size.target_events(),
        planned_events_by_source: planned,
        planned_events_total,
        planned_nested_member_events,
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
        expected_level_counts_min,
        expected_format_counts_min,
        expected_preview_status_mins,
        expected_exclusion_reason_mins,
        min_template_count: 8,
        min_repetitive_template_count: 2,
        min_unresolved_local_before: local_total * 80 / 100,
        min_explicit_wall_before: plan.local_exception.max(10),
        // Tight absolute tolerance — not ±15% greenwash of nested loss.
        ingest_event_tolerance_abs: match size {
            CompanyImportLabSize::Small => 80,
            CompanyImportLabSize::Medium => 150,
            CompanyImportLabSize::Large => 400,
        },
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
///
/// Mirrors EngineClient / Tauri host: preview → verify plan → selection-bound
/// ingest (cancel + retry) → timezone state/preview/apply → diagnose.
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

    // --- Preview (EngineClient.import.preview ≈ log_preview_import) ---
    let plan = preview_import_plan(&zip_path, None)?;
    let preview_status_counts = preview_status_histogram(&plan.report);
    assert_mins(
        &preview_status_counts,
        &oracle.expected_preview_status_mins,
        "preview status",
        &mut failures,
    );
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

    // Event-importable selection exactly as the host builds for log_run_import.
    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item))
        .map(|item| item.identity.clone())
        .collect();
    if selected.is_empty() {
        failures.push("preview produced zero event-importable identities".into());
    }
    // Nested archive leaves must appear in the reviewed plan (or expansion fails closed later).
    let nested_in_preview = plan.report.items.iter().any(|item| {
        item.identity.contains("nested")
            || item
                .reasons
                .iter()
                .any(|r| matches!(r, ImportPreviewReason::NestedArchiveNotInventoried))
    });
    if !nested_in_preview && oracle.planned_nested_member_events > 0 {
        // Not fatal alone — expansion is proven at ingest — but note for diagnostics.
        let _ = nested_in_preview;
    }

    // --- Diagnose (shipped diagnose_log_import boundary) ---
    let diagnose = diagnose_log_import(&zip_path, ImportDiagnoseOptions { cancel: None })?;
    let diagnose_outcome = format!("{:?}", diagnose.outcome.kind).to_ascii_lowercase();
    if !diagnose.outcome.temporary_corpus_deleted {
        failures.push("diagnose temporary corpus not deleted".into());
    }
    let diag_json = serde_json::to_string(&diagnose)
        .map_err(|e| CoreError::Message(format!("serialize diagnose: {e}")))?;
    scan_public_safe_text(&diag_json, &mut failures);

    // --- Cancel path: pre-cancelled flag must yield Cancelled and publish nothing ---
    let cancel_cache =
        tempfile::tempdir().map_err(|e| CoreError::Message(format!("cancel cache: {e}")))?;
    // Fresh plan verification without cancel for a valid selection (EngineClient.import.run).
    let selection = verify_import_plan(
        &zip_path,
        plan.plan_version,
        &plan.plan_token,
        &selected,
        None,
    );
    let (cancel_not_published, cancel_error_kind) = match &selection {
        Err(e) => {
            failures.push(format!("verify_import_plan failed: {e}"));
            (false, format!("plan_verify:{e}"))
        }
        Ok(sel) => {
            let cancel_flag = CancelFlag::new();
            cancel_flag.cancel();
            let cancel_result = ingest_path_with_policy_selection_and_observer(
                cancel_cache.path(),
                &zip_path,
                "company-lab-cancel",
                &embed_none(),
                None,
                &NoopProcessProgress,
                Some(&cancel_flag),
                sel,
            );
            let kind = match &cancel_result {
                Err(CoreError::Cancelled) => "cancelled".to_string(),
                Err(e) => format!("other_err:{e}"),
                Ok(r) => format!("ok_lines:{}", r.stats.lines),
            };
            // Only CoreError::Cancelled counts as a successful cancel observation.
            let cancelled_ok = matches!(cancel_result, Err(CoreError::Cancelled));
            // No published corpus directory with events under cancel cache.
            let published = published_corpus_event_count(cancel_cache.path()).unwrap_or(0);
            let not_published = cancelled_ok && published == 0;
            if !cancelled_ok {
                failures.push(format!(
                    "cancel path must return CoreError::Cancelled (got {kind})"
                ));
            }
            if published > 0 {
                failures.push(format!(
                    "cancel path published {published} events (must be zero)"
                ));
            }
            (not_published, kind)
        }
    };

    // --- Retry: selection-bound production ingest (EngineClient.import.run) ---
    let ingest_cache =
        tempfile::tempdir().map_err(|e| CoreError::Message(format!("ingest cache: {e}")))?;
    let report = match &selection {
        Ok(sel) => ingest_path_with_policy_selection_and_observer(
            ingest_cache.path(),
            &zip_path,
            "company-lab",
            &embed_none(),
            None,
            &NoopProcessProgress,
            None,
            sel,
        )
        .map_err(|e| CoreError::Message(format!("production ingest (selection-bound): {e}")))?,
        Err(_) => {
            // Fall through already failed plan verify.
            return Ok(empty_failed_report(
                &oracle,
                failures,
                cancel_not_published,
                cancel_error_kind,
                wall,
            ));
        }
    };

    let stats: &IngestStats = &report.stats;
    let ingested_events = stats.lines;
    let planned = oracle.planned_events_total;
    let tol = oracle.ingest_event_tolerance_abs;
    let lower = planned.saturating_sub(tol);
    let upper = planned.saturating_add(tol);
    if ingested_events < lower || ingested_events > upper {
        failures.push(format!(
            "ingested events {ingested_events} outside absolute tolerance of planned {planned} (±{tol} → {lower}..{upper})"
        ));
    }
    if ingested_events > planned.saturating_add(tol.max(200)) {
        failures.push(format!(
            "possible line bleed: ingested {ingested_events} >> planned {planned}"
        ));
    }
    assert_mins(
        &stats.level_counts,
        &oracle.expected_level_counts_min,
        "level",
        &mut failures,
    );
    assert_mins(
        &stats.format_counts,
        &oracle.expected_format_counts_min,
        "format",
        &mut failures,
    );
    assert_mins(
        &stats.exclusion_counts,
        &oracle.expected_exclusion_reason_mins,
        "exclusion reason",
        &mut failures,
    );

    let provenance_before = stats.timestamp_provenance_counts.clone();
    let quality_before = time_quality_key(report.confidence.corpus_time_quality);
    let unresolved_before = provenance_before
        .get("unresolved_local")
        .copied()
        .unwrap_or(0);
    let explicit_before = provenance_before.get("explicit_wall").copied().unwrap_or(0);
    if unresolved_before < oracle.min_unresolved_local_before {
        failures.push(format!(
            "unresolved_local before apply {unresolved_before} < min {}",
            oracle.min_unresolved_local_before
        ));
    }
    if explicit_before < oracle.min_explicit_wall_before {
        failures.push(format!(
            "explicit_wall before apply {explicit_before} < min {}",
            oracle.min_explicit_wall_before
        ));
    }

    // Nested expansion: count events whose source identity mentions nested.zip
    let corpus_id = report.corpus_id.clone();
    let corpus = LogCorpus::open(ingest_cache.path(), &corpus_id)
        .map_err(|e| CoreError::Message(format!("open published corpus: {e}")))?;
    let nested_events_ingested = count_events_matching_source(&corpus, "nested.zip")?;
    if nested_events_ingested + 5 < oracle.planned_nested_member_events {
        failures.push(format!(
            "PRODUCT BLOCKER: nested ZIP members not expanded — planned {} nested events, ingested {nested_events_ingested} (source identity must include nested.zip). Manager/format-profile lane: archive expansion under selection-bound EngineClient path.",
            oracle.planned_nested_member_events
        ));
    }

    // Templates / repetitive error families (observed vs oracle mins).
    let templates = corpus.list_template_infos();
    let template_count = templates.len() as u64;
    let repetitive_template_count = templates.iter().filter(|t| t.count >= 20).count() as u64;
    if template_count < oracle.min_template_count {
        failures.push(format!(
            "template count {template_count} < min {}",
            oracle.min_template_count
        ));
    }
    if repetitive_template_count < oracle.min_repetitive_template_count {
        failures.push(format!(
            "repetitive template families {repetitive_template_count} < min {}",
            oracle.min_repetitive_template_count
        ));
    }

    // retry_published: observed published corpus with events, not a constant.
    let published_count = LogCorpus::open(ingest_cache.path(), &corpus_id)
        .map(|c| c.event_count() as u64)
        .unwrap_or(0);
    let retry_published =
        ingested_events > 0 && published_count > 0 && published_count == ingested_events;

    if !retry_published {
        failures.push(format!(
            "retry ingest did not publish durable corpus matching stats (stats={ingested_events} published={published_count})"
        ));
    }

    // --- Timezone application (EngineClient.time.*) ---
    let mut apply_reqs = Vec::new();
    let mut timezone_apply_revision = None;
    let current_revision = match load_timezone_resolution_state(ingest_cache.path(), &corpus_id) {
        Ok(state) => state.scope.event_revision,
        Err(e) => {
            failures.push(format!("load timezone state: {e}"));
            0
        }
    };
    let tz_before = load_timezone_resolution_state(ingest_cache.path(), &corpus_id).ok();
    let mut local_group_unresolved_before = 0u64;
    let mut exception_explicit_before = 0u64;
    if let Some(state) = &tz_before {
        for s in &state.sources {
            if source_key_matches(&s.source, &oracle.local_timestamp_sources) {
                local_group_unresolved_before += s.unresolved_local_records;
            }
            if source_key_matches(
                &s.source,
                std::slice::from_ref(&oracle.explicit_timezone_source),
            ) {
                exception_explicit_before += s.explicit_wall_clock_records;
            }
        }
    }

    if current_revision > 0 {
        let resolved_keys = resolve_source_keys(
            ingest_cache.path(),
            &corpus_id,
            &oracle.local_timestamp_sources,
        );
        if resolved_keys.len() != oracle.local_timestamp_sources.len() {
            failures.push(format!(
                "common-group source resolution collapsed {} local sources into {} durable identities ({resolved_keys:?}; need {:?})",
                oracle.local_timestamp_sources.len(),
                resolved_keys.len(),
                oracle.local_timestamp_sources
            ));
        }
        for source in &resolved_keys {
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
        if apply_reqs.is_empty() {
            failures.push("no timezone apply requests built for local group".into());
        } else if apply_reqs.len() < oracle.local_timestamp_sources.len() {
            failures.push(format!(
                "timezone apply built {} requests for {} local sources (partial common-group apply)",
                apply_reqs.len(),
                oracle.local_timestamp_sources.len()
            ));
        } else {
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
    } else {
        failures.push("timezone event_revision was zero before apply".into());
    }

    // --- Provenance AFTER apply (re-query corpus + timezone state) ---
    let corpus_after = LogCorpus::open(ingest_cache.path(), &corpus_id)
        .map_err(|e| CoreError::Message(format!("re-open corpus after TZ apply: {e}")))?;
    let provenance_after = query_provenance_histogram(&corpus_after)?;
    let quality_after = time_quality_key(super::query::corpus_time_quality(&corpus_after));

    let tz_after = load_timezone_resolution_state(ingest_cache.path(), &corpus_id).ok();
    let mut local_group_unresolved_after = 0u64;
    let mut local_group_resolved_after = 0u64;
    let mut timezone_exception_explicit_wall_after = 0u64;
    let mut timezone_exception_source_present = false;
    if let Some(state) = &tz_after {
        for s in &state.sources {
            if source_key_matches(&s.source, &oracle.local_timestamp_sources) {
                local_group_unresolved_after += s.unresolved_local_records;
                local_group_resolved_after += s.resolved_local_records;
            }
            if source_key_matches(
                &s.source,
                std::slice::from_ref(&oracle.explicit_timezone_source),
            ) {
                timezone_exception_source_present = true;
                timezone_exception_explicit_wall_after += s.explicit_wall_clock_records;
            }
        }
        // Every common-group source must be applied (declaration and/or resolved rows).
        for need in &oracle.local_timestamp_sources {
            let declared = state
                .declarations
                .keys()
                .any(|k| source_path_matches(k, need));
            let resolved_here = state
                .sources
                .iter()
                .filter(|s| source_path_matches(&s.source, need))
                .map(|s| s.resolved_local_records)
                .sum::<u64>();
            if !declared && resolved_here == 0 {
                failures.push(format!(
                    "common-group source not applied after TZ apply: {need} (no declaration and resolved=0)"
                ));
            }
        }
    }
    // Catalog fallback for exception identity when timezone state omits explicit-only sources.
    if !timezone_exception_source_present {
        if let Ok(cat) = query_source_catalog(
            &corpus_after,
            &LogSourceCatalogQuery {
                search: Some("region-c".into()),
                cursor: None,
                limit: 50,
            },
        ) {
            timezone_exception_source_present = cat.sources.iter().any(|s| {
                source_key_matches(
                    &s.source,
                    std::slice::from_ref(&oracle.explicit_timezone_source),
                )
            });
        }
    }
    // Exception must retain explicit wall after common-group apply (not soft-passed from before only).
    if timezone_exception_explicit_wall_after == 0 {
        // Count explicit_wall events on exception source via DB.
        timezone_exception_explicit_wall_after =
            count_provenance_for_source(&corpus_after, "region-c", "explicit_wall")?;
    }
    if timezone_exception_explicit_wall_after == 0 {
        failures.push(
            "timezone exception source lost explicit_wall after common-group apply (exception not preserved)"
                .into(),
        );
    }
    if !timezone_exception_source_present && timezone_exception_explicit_wall_after == 0 {
        failures.push(format!(
            "explicit timezone exception source missing after apply: {}",
            oracle.explicit_timezone_source
        ));
    }
    // Common group: require near-complete resolution of *all* local sources
    // (not merely resolved_after > 0, which greenwashes a single-source apply).
    if timezone_apply_revision.is_some() && local_group_unresolved_before > 0 {
        let min_resolved = local_group_unresolved_before.saturating_mul(90) / 100;
        if local_group_resolved_after < min_resolved {
            failures.push(format!(
                "common-group partial apply: resolved_after={local_group_resolved_after} < 90% of unresolved_before={local_group_unresolved_before} (min {min_resolved}); both region-a and region-b must be applied"
            ));
        }
    }
    // Exception must not be force-applied as local-only: keep explicit_wall >= before for exception.
    if exception_explicit_before > 0
        && timezone_exception_explicit_wall_after + 5 < exception_explicit_before
    {
        failures.push(format!(
            "exception explicit_wall dropped after apply: before={exception_explicit_before} after={timezone_exception_explicit_wall_after}"
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
        planned_nested_member_events: oracle.planned_nested_member_events,
        ingested_events,
        nested_events_ingested,
        ingested_files: stats.files as u64,
        level_counts: stats.level_counts.clone(),
        format_counts: stats.format_counts.clone(),
        timestamp_provenance_before: provenance_before,
        timestamp_provenance_after: provenance_after,
        corpus_time_quality_before: quality_before,
        corpus_time_quality_after: quality_after,
        timezone_apply_revision,
        timezone_exception_source_present,
        timezone_exception_explicit_wall_after,
        local_group_unresolved_before,
        local_group_unresolved_after,
        local_group_resolved_after,
        template_count,
        repetitive_template_count,
        preview_status_counts,
        exclusion_reason_counts: stats.exclusion_counts.clone(),
        cancel_not_published,
        cancel_error_kind,
        retry_published,
        engine_client_path: true,
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

fn assert_mins(
    observed: &BTreeMap<String, u64>,
    mins: &BTreeMap<String, u64>,
    label: &str,
    failures: &mut Vec<String>,
) {
    for (k, min_v) in mins {
        let got = observed.get(k).copied().unwrap_or(0);
        if got < *min_v {
            failures.push(format!("{label} `{k}` count {got} < expected min {min_v}"));
        }
    }
}

/// Match a durable corpus source identity to an oracle path **without**
/// collapsing distinct parents that share a basename.
///
/// `region-a/app.log` and `region-b/app.log` must never both match the same
/// observed identity via bare `app.log`. Prefer exact / full-relative-path
/// suffix matches with a path boundary (`/`, `!/`).
fn source_path_matches(observed: &str, need: &str) -> bool {
    if need.is_empty() {
        return false;
    }
    if observed == need {
        return true;
    }
    // Full need path as suffix with a path boundary (archive member or nested path).
    if let Some(prefix) = observed.strip_suffix(need) {
        return prefix.is_empty()
            || prefix.ends_with('/')
            || prefix.ends_with("!/")
            || prefix.ends_with('!');
    }
    // Embedded full path after archive separator.
    if observed.contains(&format!("!/{need}")) {
        return true;
    }
    false
}

fn source_key_matches(observed: &str, needs: &[String]) -> bool {
    needs.iter().any(|need| source_path_matches(observed, need))
}

/// Resolve each oracle local-source path to the durable corpus identity.
/// Returns one identity **per** need (order preserved); fails closed callers
/// should check `out.len() == needs.len()` for collapse.
fn resolve_source_keys(cache: &Path, corpus_id: &str, needs: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    if let Ok(state) = load_timezone_resolution_state(cache, corpus_id) {
        for need in needs {
            let resolved = state
                .sources
                .iter()
                .find(|s| source_path_matches(&s.source, need))
                .map(|s| s.source.clone())
                .or_else(|| {
                    state
                        .declarations
                        .keys()
                        .find(|k| source_path_matches(k, need))
                        .cloned()
                })
                .or_else(|| {
                    // Catalog may surface identities not listed in timezone state.
                    LogCorpus::open(cache, corpus_id)
                        .ok()
                        .and_then(|corpus| {
                            query_source_catalog(
                                &corpus,
                                &LogSourceCatalogQuery {
                                    search: Some(need.clone()),
                                    cursor: None,
                                    limit: 100,
                                },
                            )
                            .ok()
                        })
                        .and_then(|cat| {
                            cat.sources
                                .into_iter()
                                .find(|s| source_path_matches(&s.source, need))
                                .map(|s| s.source)
                        })
                })
                .unwrap_or_else(|| need.clone());
            if seen.insert(resolved.clone()) {
                out.push(resolved);
            } else {
                // Collapse: same durable identity claimed by two needs — keep
                // first only; verify will fail apply_reqs.len() check.
            }
        }
    } else {
        for need in needs {
            if seen.insert(need.clone()) {
                out.push(need.clone());
            }
        }
    }
    out
}

fn published_corpus_event_count(cache_root: &Path) -> CoreResult<u64> {
    let mut total = 0u64;
    if !cache_root.exists() {
        return Ok(0);
    }
    for entry in fs::read_dir(cache_root).map_err(|e| CoreError::Message(e.to_string()))? {
        let entry = entry.map_err(|e| CoreError::Message(e.to_string()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if let Ok(corpus) = LogCorpus::open(cache_root, &name) {
            total = total.saturating_add(corpus.event_count() as u64);
        }
    }
    Ok(total)
}

fn count_events_matching_source(corpus: &LogCorpus, needle: &str) -> CoreResult<u64> {
    // Use facets/source catalog + count query when available.
    let cat = query_source_catalog(
        corpus,
        &LogSourceCatalogQuery {
            search: Some(needle.to_string()),
            cursor: None,
            limit: 100,
        },
    )?;
    let mut total = 0u64;
    for s in cat.sources {
        if s.source.contains(needle) {
            total = total.saturating_add(s.event_count);
        }
    }
    Ok(total)
}

fn query_provenance_histogram(corpus: &LogCorpus) -> CoreResult<BTreeMap<String, u64>> {
    corpus.with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(timestamp_provenance, 'unknown'), COUNT(*) FROM events GROUP BY 1",
            )
            .map_err(|e| CoreError::Message(format!("provenance hist prepare: {e}")))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| CoreError::Message(format!("provenance hist query: {e}")))?;
        let mut m = BTreeMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| CoreError::Message(format!("provenance row: {e}")))?;
            m.insert(k, v);
        }
        Ok(m)
    })
}

fn count_provenance_for_source(
    corpus: &LogCorpus,
    source_needle: &str,
    provenance: &str,
) -> CoreResult<u64> {
    let like = format!("%{source_needle}%");
    corpus.with_connection(|conn| {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE source LIKE ?1 AND timestamp_provenance = ?2",
                duckdb::params![like, provenance],
                |r| r.get(0),
            )
            .map_err(|e| CoreError::Message(format!("provenance source count: {e}")))?;
        Ok(count as u64)
    })
}

fn empty_failed_report(
    oracle: &CompanyImportLabOracle,
    failures: Vec<String>,
    cancel_not_published: bool,
    cancel_error_kind: String,
    wall: Instant,
) -> CompanyImportLabVerifyReport {
    CompanyImportLabVerifyReport {
        schema_id: COMPANY_IMPORT_LAB_ORACLE_SCHEMA.into(),
        size: oracle.size.clone(),
        passed: false,
        failures,
        planned_events_total: oracle.planned_events_total,
        planned_nested_member_events: oracle.planned_nested_member_events,
        ingested_events: 0,
        nested_events_ingested: 0,
        ingested_files: 0,
        level_counts: BTreeMap::new(),
        format_counts: BTreeMap::new(),
        timestamp_provenance_before: BTreeMap::new(),
        timestamp_provenance_after: BTreeMap::new(),
        corpus_time_quality_before: "unknown".into(),
        corpus_time_quality_after: "unknown".into(),
        timezone_apply_revision: None,
        timezone_exception_source_present: false,
        timezone_exception_explicit_wall_after: 0,
        local_group_unresolved_before: 0,
        local_group_unresolved_after: 0,
        local_group_resolved_after: 0,
        template_count: 0,
        repetitive_template_count: 0,
        preview_status_counts: BTreeMap::new(),
        exclusion_reason_counts: BTreeMap::new(),
        cancel_not_published,
        cancel_error_kind,
        retry_published: false,
        engine_client_path: true,
        diagnose_outcome: "skipped".into(),
        diagnose_temp_deleted: false,
        phase_timings: IngestPhaseTimings::default(),
        diagnose_wall_ms: 0,
        wall_ms: wall.elapsed().as_millis() as u64,
    }
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
    let opts = zip_file_options();
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
    let opts = zip_file_options();
    // Deterministic member order (sorted paths) for stable package_sha256.
    let mut files: Vec<PathBuf> = Vec::new();
    fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> CoreResult<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| CoreError::Message(format!("read_dir: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| CoreError::Message(format!("dir entry: {e}")))?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, files)?;
            } else {
                files.push(path);
            }
        }
        Ok(())
    }
    collect(src, &mut files)?;
    files.sort();
    for path in files {
        let rel = path
            .strip_prefix(src)
            .map_err(|e| CoreError::Message(format!("strip prefix: {e}")))?
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(&rel, opts)
            .map_err(|e| CoreError::Message(format!("zip start {rel}: {e}")))?;
        let bytes = fs::read(&path).map_err(|e| CoreError::Message(format!("read {rel}: {e}")))?;
        zip.write_all(&bytes)
            .map_err(|e| CoreError::Message(format!("zip write {rel}: {e}")))?;
    }
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
    fn source_path_matches_does_not_collapse_same_basename() {
        let a = "company-import.zip!/region-a/app.log";
        let b = "company-import.zip!/region-b/app.log";
        assert!(source_path_matches(a, "region-a/app.log"));
        assert!(source_path_matches(b, "region-b/app.log"));
        // Critical: distinct parents that share basename must not cross-match.
        assert!(!source_path_matches(a, "region-b/app.log"));
        assert!(!source_path_matches(b, "region-a/app.log"));
        assert!(source_path_matches("region-a/app.log", "region-a/app.log"));
        // resolve_source_keys must yield two identities for the two needs.
        let needs = ["region-a/app.log", "region-b/app.log"];
        let mut resolved = Vec::new();
        for need in needs {
            for candidate in [a, b] {
                if source_path_matches(candidate, need) {
                    resolved.push(candidate);
                    break;
                }
            }
        }
        assert_eq!(resolved.len(), 2);
        assert_ne!(resolved[0], resolved[1]);
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
        assert!(pa.oracle.planned_nested_member_events > 0);
        assert!(!pa.oracle.expected_level_counts_min.is_empty());
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
        assert!(
            report.cancel_not_published,
            "cancel must be observed as Cancelled + zero publish: {}",
            report.cancel_error_kind
        );
        assert!(
            report.retry_published,
            "retry_published must be observed from published corpus"
        );
        assert!(report.engine_client_path);
        assert!(report.diagnose_temp_deleted);
        assert!(report.ingested_events > 0);
        assert!(
            report.nested_events_ingested + 5 >= report.planned_nested_member_events,
            "nested expansion required: got {} planned {}",
            report.nested_events_ingested,
            report.planned_nested_member_events
        );
        assert!(
            !report.timestamp_provenance_after.is_empty(),
            "must re-query provenance after TZ apply"
        );
        assert!(
            report.timezone_exception_explicit_wall_after > 0,
            "exception explicit_wall after apply"
        );
        // Full common group: both region-a and region-b must resolve (~100%, ≥90%).
        assert!(
            report.local_group_unresolved_before > 0,
            "expected unresolved local before apply"
        );
        let min_resolved = report.local_group_unresolved_before * 90 / 100;
        assert!(
            report.local_group_resolved_after >= min_resolved,
            "common-group partial apply: resolved {} < 90% of unresolved {} — both local sources must be applied",
            report.local_group_resolved_after,
            report.local_group_unresolved_before
        );
        assert!(report.template_count >= 8);
        assert!(report.repetitive_template_count >= 2);
    }

    #[test]
    fn oracle_mutation_fails_verify() {
        let dir = tempfile::tempdir().unwrap();
        let mut pkg = generate_company_import_lab(dir.path(), CompanyImportLabSize::Small).unwrap();
        pkg.oracle.planned_events_total = 1;
        pkg.oracle.ingest_event_tolerance_abs = 0;
        write_oracle(&pkg.oracle_path, &pkg.oracle).unwrap();
        let report = verify_company_import_lab(dir.path()).unwrap();
        assert!(!report.passed);
        assert!(report
            .failures
            .iter()
            .any(|f| f.contains("ingested events") || f.contains("planned")));
    }

    #[test]
    fn oracle_level_min_mutation_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let mut pkg = generate_company_import_lab(dir.path(), CompanyImportLabSize::Small).unwrap();
        pkg.oracle
            .expected_level_counts_min
            .insert("error".into(), 9_999_999);
        write_oracle(&pkg.oracle_path, &pkg.oracle).unwrap();
        let report = verify_company_import_lab(dir.path()).unwrap();
        assert!(!report.passed);
        assert!(report
            .failures
            .iter()
            .any(|f| f.contains("level") && f.contains("error")));
    }
}
