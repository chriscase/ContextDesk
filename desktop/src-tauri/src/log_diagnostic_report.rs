use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_REPORTS: usize = 8;
const MAX_TEXT_CHARS: usize = 1_200;
const MAX_LABEL_CHARS: usize = 160;
const MAX_STATUS_CHARS: usize = 800;
const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_COUNT_ENTRIES: usize = 32;
const MAX_EXAMPLES: usize = 12;
const MAX_TRANSCRIPT: usize = 20;
const MAX_SEQS: usize = 32;
const MAX_LANES: usize = 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static REPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const EXCLUDED_CONTENT: [&str; 6] = [
    "raw logs and event payloads",
    "absolute source and home paths",
    "chat transcripts",
    "provider and model inventories",
    "credentials and secrets",
    "evaluator truth",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogDiagnosticManifest {
    schema_version: u8,
    generated_at: String,
    privacy: DiagnosticPrivacy,
    application: DiagnosticApplication,
    corpus: Option<DiagnosticCorpus>,
    failed_ingest: Option<DiagnosticFailedIngest>,
    active_view: Option<DiagnosticActiveView>,
    current_status: Option<DiagnosticStatus>,
    user_note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticPrivacy {
    redacted: bool,
    review_required: bool,
    excluded: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticApplication {
    version: String,
    channel: String,
    git_sha: Option<String>,
    os: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticCorpus {
    id: String,
    name: String,
    created_at: u64,
    engine: String,
    event_count: u64,
    template_count: u64,
    stats: Option<DiagnosticStats>,
    embedding: DiagnosticEmbedding,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticStats {
    imported_files: u64,
    discovered_files: u64,
    excluded_files: u64,
    failed_files: u64,
    ignored_files: u64,
    partial: bool,
    source_bytes: u64,
    corpus_bytes: u64,
    level_counts: BTreeMap<String, u64>,
    format_counts: BTreeMap<String, u64>,
    reason_counts: BTreeMap<String, u64>,
    basename_examples: Vec<String>,
    stored_time_min: Option<i64>,
    stored_time_max: Option<i64>,
    time_quality: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticEmbedding {
    state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticFailedIngest {
    schema_version: u64,
    generated_at: u64,
    source_kind: String,
    reason_code: String,
    summary: String,
    cancelled: bool,
    progress: DiagnosticProgress,
    evidence: DiagnosticEvidence,
    retention: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticProgress {
    last_phase: String,
    lines_processed: Option<i64>,
    files_processed: Option<i64>,
    bytes_processed: Option<i64>,
    templates: Option<i64>,
    updates_seen: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticEvidence {
    scan_counts: DiagnosticScanCounts,
    transcript: Vec<DiagnosticTranscriptEntry>,
    omitted_entries: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticScanCounts {
    binary: u64,
    empty: u64,
    hidden: u64,
    oversized: u64,
    read_failed: u64,
    parse_failed: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticTranscriptEntry {
    reason: String,
    basename: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticActiveView {
    breakpoint: String,
    density: String,
    row_mode: String,
    metadata_presentation: String,
    field_emphasis: String,
    time_quality: String,
    link_mode: String,
    visible_lane_count: u64,
    lane_source_counts: Vec<u64>,
    filters: DiagnosticFilters,
    find: DiagnosticFind,
    selected_seqs: Vec<u64>,
    highlighted_seqs: Vec<u64>,
    focused_seq: Option<i64>,
    viewport_anchors: Vec<DiagnosticViewportAnchor>,
    filters_collapsed: bool,
    investigation_collapsed: bool,
    ui_state: DiagnosticUiState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticFilters {
    level_count: u64,
    source_count: u64,
    service_count: u64,
    host_count: u64,
    keyword_present: bool,
    trace_present: bool,
    time_from: Option<i64>,
    time_to: Option<i64>,
    seq_from: Option<i64>,
    seq_to: Option<i64>,
    template_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticFind {
    active: bool,
    match_mode: String,
    case_sensitive: bool,
    semantic: bool,
    resident_matches: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticViewportAnchor {
    lane_id: String,
    seq: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticUiState {
    category: String,
    busy: bool,
    has_error: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticStatus {
    kind: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLogDiagnostic {
    pub report_id: String,
    pub markdown: String,
    pub json: String,
}

#[derive(Clone, Debug)]
struct StoredReport {
    id: String,
    markdown: String,
    json: String,
}

#[derive(Default)]
pub struct LogDiagnosticReportStore {
    reports: VecDeque<StoredReport>,
}

impl LogDiagnosticReportStore {
    pub fn prepare(
        &mut self,
        mut manifest: LogDiagnosticManifest,
    ) -> Result<PreparedLogDiagnostic, String> {
        let input_bytes = serde_json::to_vec(&manifest)
            .map_err(|error| format!("measure diagnostic manifest: {error}"))?
            .len();
        if input_bytes > super::log_diagnostics::MAX_DIAGNOSTIC_BYTES {
            return Err("diagnostic manifest exceeds its input bound".into());
        }
        validate_and_sanitize_manifest(&mut manifest)?;
        let markdown = render_markdown(&manifest);
        let json = serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("serialize diagnostic JSON: {error}"))?;
        for content in [&markdown, &json] {
            if content.is_empty() || content.len() > super::log_diagnostics::MAX_DIAGNOSTIC_BYTES {
                return Err("diagnostic report exceeded its bounded export size".into());
            }
        }
        let id = next_report_id();
        self.reports.push_back(StoredReport {
            id: id.clone(),
            markdown: markdown.clone(),
            json: json.clone(),
        });
        while self.reports.len() > MAX_REPORTS {
            self.reports.pop_front();
        }
        Ok(PreparedLogDiagnostic {
            report_id: id,
            markdown,
            json,
        })
    }

    pub fn content(&self, report_id: &str, format: &str) -> Result<&str, String> {
        validate_report_id(report_id)?;
        let report = self
            .reports
            .iter()
            .find(|report| report.id == report_id)
            .ok_or_else(|| {
                "diagnostic report expired; refresh the preview and try again".to_string()
            })?;
        match format {
            "markdown" => Ok(&report.markdown),
            "json" => Ok(&report.json),
            _ => Err("diagnostic format must be markdown or json".into()),
        }
    }
}

fn next_report_id() -> String {
    let sequence = REPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    format!("cdlogdiag-{now:016x}-{sequence:016x}")
}

fn validate_report_id(value: &str) -> Result<(), String> {
    let mut parts = value.split('-');
    let valid = parts.next() == Some("cdlogdiag")
        && parts.next().is_some_and(is_hex16)
        && parts.next().is_some_and(is_hex16)
        && parts.next().is_none();
    if !valid {
        return Err("invalid diagnostic report id".into());
    }
    Ok(())
}

fn is_hex16(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_and_sanitize_manifest(manifest: &mut LogDiagnosticManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("unsupported diagnostic schema version".into());
    }
    validate_generated_at(&manifest.generated_at)?;
    manifest.generated_at = sanitize_text(&manifest.generated_at, 40);
    if !manifest.privacy.redacted || !manifest.privacy.review_required {
        return Err("diagnostic privacy flags must remain enabled".into());
    }
    if manifest.privacy.excluded.len() > EXCLUDED_CONTENT.len() * 2 {
        return Err("diagnostic privacy exclusions exceed the bound".into());
    }
    for item in &manifest.privacy.excluded {
        let _ = sanitize_text(item, MAX_LABEL_CHARS);
    }
    manifest.privacy.excluded = EXCLUDED_CONTENT
        .iter()
        .map(|value| (*value).into())
        .collect();

    manifest.application.version =
        validate_identifier(&manifest.application.version, "application version", 64)?;
    manifest.application.channel =
        validate_identifier(&manifest.application.channel, "application channel", 32)?;
    manifest.application.git_sha = manifest
        .application
        .git_sha
        .as_deref()
        .map(validate_git_sha)
        .transpose()?;
    manifest.application.os = sanitize_text(&manifest.application.os, 64);
    if manifest.application.os.is_empty() {
        manifest.application.os = "unknown".into();
    }

    if manifest.corpus.is_some() == manifest.failed_ingest.is_some() {
        return Err("diagnostic requires exactly one corpus or failed-ingest subject".into());
    }
    if let Some(corpus) = &mut manifest.corpus {
        corpus.id = validate_corpus_id(&corpus.id)?;
        corpus.name = sanitize_text(&corpus.name, MAX_LABEL_CHARS);
        if corpus.name.is_empty() {
            corpus.name = "Unnamed corpus".into();
        }
        corpus.engine = validate_identifier(&corpus.engine, "corpus engine", 64)?;
        validate_count(corpus.created_at, "corpus createdAt")?;
        validate_count(corpus.event_count, "corpus eventCount")?;
        validate_count(corpus.template_count, "corpus templateCount")?;
        validate_one_of(
            &corpus.embedding.state,
            "embedding state",
            &["keyword_only", "deferred", "partial", "complete"],
        )?;
        corpus.embedding.state = sanitize_text(&corpus.embedding.state, 32);
        if let Some(stats) = &mut corpus.stats {
            validate_stats(stats)?;
        }
    }
    if let Some(failure) = &mut manifest.failed_ingest {
        validate_failed_ingest(failure)?;
    }
    if let Some(active) = &mut manifest.active_view {
        validate_active_view(active)?;
    }
    if let Some(status) = &mut manifest.current_status {
        validate_one_of(&status.kind, "status kind", &["error", "status"])?;
        status.kind = sanitize_text(&status.kind, 16);
        status.message = sanitize_text(&status.message, MAX_STATUS_CHARS);
        if status.message.is_empty() {
            status.message = "No detail".into();
        }
    }
    manifest.user_note = manifest
        .user_note
        .take()
        .map(|note| sanitize_text(&note, MAX_TEXT_CHARS))
        .filter(|note| !note.is_empty());
    Ok(())
}

fn validate_stats(stats: &mut DiagnosticStats) -> Result<(), String> {
    for (label, count) in [
        ("importedFiles", stats.imported_files),
        ("discoveredFiles", stats.discovered_files),
        ("excludedFiles", stats.excluded_files),
        ("failedFiles", stats.failed_files),
        ("ignoredFiles", stats.ignored_files),
        ("sourceBytes", stats.source_bytes),
        ("corpusBytes", stats.corpus_bytes),
    ] {
        validate_count(count, label)?;
    }
    sanitize_count_map(&mut stats.level_counts, "levelCounts")?;
    sanitize_count_map(&mut stats.format_counts, "formatCounts")?;
    sanitize_count_map(&mut stats.reason_counts, "reasonCounts")?;
    if stats.basename_examples.len() > MAX_EXAMPLES {
        return Err("diagnostic basename examples exceed the bound".into());
    }
    for example in &mut stats.basename_examples {
        *example = sanitize_basename_example(example)?;
    }
    validate_optional_i64(stats.stored_time_min, "storedTimeMin", true)?;
    validate_optional_i64(stats.stored_time_max, "storedTimeMax", true)?;
    validate_one_of(
        &stats.time_quality,
        "stats time quality",
        &["not_persisted_in_corpus_summary"],
    )?;
    stats.time_quality = sanitize_text(&stats.time_quality, 64);
    Ok(())
}

fn validate_failed_ingest(failure: &mut DiagnosticFailedIngest) -> Result<(), String> {
    if failure.schema_version != 2 {
        return Err("unsupported failed-ingest schema version".into());
    }
    validate_count(failure.generated_at, "failed ingest generatedAt")?;
    failure.source_kind =
        validate_identifier(&failure.source_kind, "failed ingest source kind", 64)?;
    failure.reason_code =
        validate_identifier(&failure.reason_code, "failed ingest reason code", 64)?;
    failure.summary = sanitize_text(&failure.summary, MAX_STATUS_CHARS);
    if failure.summary.is_empty() {
        failure.summary = "Import failed before publication.".into();
    }
    failure.progress.last_phase =
        validate_identifier(&failure.progress.last_phase, "failed ingest phase", 64)?;
    validate_count(failure.progress.updates_seen, "failed ingest updatesSeen")?;
    for (label, value) in [
        (
            "failed ingest linesProcessed",
            failure.progress.lines_processed,
        ),
        (
            "failed ingest filesProcessed",
            failure.progress.files_processed,
        ),
        (
            "failed ingest bytesProcessed",
            failure.progress.bytes_processed,
        ),
        ("failed ingest templates", failure.progress.templates),
    ] {
        validate_optional_i64(value, label, false)?;
    }
    for (label, count) in [
        ("binary", failure.evidence.scan_counts.binary),
        ("empty", failure.evidence.scan_counts.empty),
        ("hidden", failure.evidence.scan_counts.hidden),
        ("oversized", failure.evidence.scan_counts.oversized),
        ("readFailed", failure.evidence.scan_counts.read_failed),
        ("parseFailed", failure.evidence.scan_counts.parse_failed),
        ("omittedEntries", failure.evidence.omitted_entries),
    ] {
        validate_count(count, label)?;
    }
    if failure.evidence.transcript.len() > MAX_TRANSCRIPT {
        return Err("failed-ingest transcript exceeds the core bound".into());
    }
    for entry in &mut failure.evidence.transcript {
        entry.reason = validate_identifier(&entry.reason, "failed-ingest transcript reason", 64)?;
        entry.basename = sanitize_basename(&entry.basename, 96);
    }
    validate_one_of(
        &failure.retention,
        "failed ingest retention",
        &["memory_only_until_clear_next_ingest_or_restart"],
    )?;
    failure.retention = sanitize_text(&failure.retention, 64);
    Ok(())
}

fn validate_active_view(active: &mut DiagnosticActiveView) -> Result<(), String> {
    for (value, field, allowed) in [
        (
            active.breakpoint.as_str(),
            "breakpoint",
            &["narrow", "normal", "ultrawide"][..],
        ),
        (
            active.density.as_str(),
            "density",
            &["comfortable", "compact"][..],
        ),
        (
            active.row_mode.as_str(),
            "row mode",
            &["compact", "wrap", "full"][..],
        ),
        (
            active.metadata_presentation.as_str(),
            "metadata presentation",
            &["standard", "compact"][..],
        ),
        (
            active.field_emphasis.as_str(),
            "field emphasis",
            &["balanced", "payload", "metadata"][..],
        ),
        (
            active.time_quality.as_str(),
            "time quality",
            &["wall", "mixed", "order_only"][..],
        ),
        (
            active.link_mode.as_str(),
            "link mode",
            &["independent", "follow_cursor", "align_time"][..],
        ),
    ] {
        validate_one_of(value, field, allowed)?;
    }
    active.breakpoint = sanitize_text(&active.breakpoint, 32);
    active.density = sanitize_text(&active.density, 32);
    active.row_mode = sanitize_text(&active.row_mode, 32);
    active.metadata_presentation = sanitize_text(&active.metadata_presentation, 32);
    active.field_emphasis = sanitize_text(&active.field_emphasis, 32);
    active.time_quality = sanitize_text(&active.time_quality, 32);
    active.link_mode = sanitize_text(&active.link_mode, 32);
    if active.visible_lane_count > MAX_LANES as u64
        || active.lane_source_counts.len() > MAX_LANES
        || active.viewport_anchors.len() > MAX_LANES
    {
        return Err("active-view lane data exceeds the bound".into());
    }
    for count in &active.lane_source_counts {
        validate_count(*count, "lane source count")?;
    }
    if active.selected_seqs.len() > MAX_SEQS || active.highlighted_seqs.len() > MAX_SEQS {
        return Err("active-view sequence identities exceed the bound".into());
    }
    for seq in active
        .selected_seqs
        .iter()
        .chain(active.highlighted_seqs.iter())
    {
        validate_count(*seq, "event sequence")?;
    }
    for anchor in &mut active.viewport_anchors {
        anchor.lane_id = validate_identifier(&anchor.lane_id, "viewport lane id", 32)?;
        validate_count(anchor.seq, "viewport sequence")?;
    }
    validate_optional_i64(active.focused_seq, "focused sequence", false)?;
    for (label, value, allow_negative) in [
        ("filter timeFrom", active.filters.time_from, true),
        ("filter timeTo", active.filters.time_to, true),
        ("filter seqFrom", active.filters.seq_from, false),
        ("filter seqTo", active.filters.seq_to, false),
        ("filter templateId", active.filters.template_id, false),
    ] {
        validate_optional_i64(value, label, allow_negative)?;
    }
    validate_one_of(
        &active.find.match_mode,
        "find match mode",
        &["literal", "regex"],
    )?;
    active.find.match_mode = sanitize_text(&active.find.match_mode, 16);
    validate_count(active.find.resident_matches, "resident matches")?;
    validate_one_of(
        &active.ui_state.category,
        "UI state category",
        &["ready", "active", "busy", "error"],
    )?;
    active.ui_state.category = sanitize_text(&active.ui_state.category, 16);
    for (label, count) in [
        ("filter levelCount", active.filters.level_count),
        ("filter sourceCount", active.filters.source_count),
        ("filter serviceCount", active.filters.service_count),
        ("filter hostCount", active.filters.host_count),
    ] {
        validate_count(count, label)?;
    }
    Ok(())
}

fn sanitize_count_map(values: &mut BTreeMap<String, u64>, field: &str) -> Result<(), String> {
    if values.len() > MAX_COUNT_ENTRIES {
        return Err(format!("{field} exceeds the entry bound"));
    }
    let mut sanitized = BTreeMap::new();
    for (key, value) in std::mem::take(values) {
        validate_count(value, field)?;
        let key = validate_identifier(&key, field, 64)?.to_ascii_lowercase();
        sanitized.insert(key, value);
    }
    *values = sanitized;
    Ok(())
}

fn sanitize_basename_example(value: &str) -> Result<String, String> {
    let (reason, basename) = value.split_once(':').unwrap_or(("item", value));
    let reason = validate_identifier(reason.trim(), "basename reason", 64)?;
    Ok(format!(
        "{reason}: {}",
        sanitize_basename(basename.trim(), 120)
    ))
}

fn sanitize_basename(value: &str, max_chars: usize) -> String {
    let basename = value.replace('\\', "/");
    let basename = basename.rsplit('/').next().unwrap_or_default();
    let sanitized = sanitize_text(basename, max_chars);
    if sanitized.is_empty() {
        "[REDACTED_BASENAME]".into()
    } else {
        sanitized
    }
}

fn validate_corpus_id(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let uuid_shape = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if !uuid_shape {
        return Err("diagnostic corpus id must be a UUID".into());
    }
    validate_identifier(value, "corpus id", 36)
}

fn validate_git_sha(value: &str) -> Result<String, String> {
    if !(7..=40).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("diagnostic gitSha must be 7 to 40 hexadecimal characters".into());
    }
    let scrubbed = super::log_diagnostics::redact_export_text(value);
    if scrubbed != value {
        return Err("diagnostic gitSha contains unsafe content".into());
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_identifier(value: &str, field: &str, max_chars: usize) -> Result<String, String> {
    if value.is_empty()
        || value.chars().count() > max_chars.min(MAX_IDENTIFIER_CHARS)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
    {
        return Err(format!("{field} has an invalid shape"));
    }
    let scrubbed = super::log_diagnostics::redact_export_text(value);
    if scrubbed != value {
        return Err(format!("{field} contains unsafe content"));
    }
    Ok(value.to_string())
}

fn validate_generated_at(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let shape = (20..=35).contains(&bytes.len())
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && value.ends_with('Z')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'-' | b':' | b'.' | b'T' | b'Z'));
    if !shape || super::log_diagnostics::redact_export_text(value) != value {
        return Err("diagnostic generatedAt must be a bounded UTC timestamp".into());
    }
    Ok(())
}

fn validate_count(value: u64, field: &str) -> Result<(), String> {
    if value > MAX_SAFE_INTEGER {
        return Err(format!("{field} exceeds the safe integer bound"));
    }
    Ok(())
}

fn validate_optional_i64(
    value: Option<i64>,
    field: &str,
    allow_negative: bool,
) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if (!allow_negative && value < 0) || value.unsigned_abs() > MAX_SAFE_INTEGER {
        return Err(format!("{field} exceeds the safe integer bound"));
    }
    Ok(())
}

fn validate_one_of(value: &str, field: &str, allowed: &[&str]) -> Result<(), String> {
    let scrubbed = super::log_diagnostics::redact_export_text(value);
    if scrubbed != value || !allowed.contains(&value) {
        return Err(format!("{field} has an unsupported value"));
    }
    Ok(())
}

fn sanitize_text(value: &str, max_chars: usize) -> String {
    super::log_diagnostics::redact_export_text(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn nullable(value: Option<String>) -> String {
    value.unwrap_or_else(|| "unknown".into())
}

fn count_lines(values: &BTreeMap<String, u64>) -> Vec<String> {
    if values.is_empty() {
        vec!["- none recorded".into()]
    } else {
        values
            .iter()
            .map(|(key, value)| format!("- {key}: {value}"))
            .collect()
    }
}

fn render_markdown(manifest: &LogDiagnosticManifest) -> String {
    let mut lines = vec![
        if manifest.corpus.is_some() {
            "# ContextDesk corpus diagnostic".into()
        } else {
            "# ContextDesk failed-ingest diagnostic".into()
        },
        String::new(),
        "> Redacted support report. Review before sharing.".into(),
        "> Excludes raw logs/event payloads, absolute paths, chats, provider/model inventories, secrets, and evaluator truth.".into(),
        String::new(),
        "## Application".into(),
        format!("- Version: {}", manifest.application.version),
        format!("- Channel: {}", manifest.application.channel),
        format!("- Git: {}", nullable(manifest.application.git_sha.clone())),
        format!("- OS: {}", manifest.application.os),
        format!("- Generated: {}", manifest.generated_at),
        String::new(),
    ];
    if let Some(corpus) = &manifest.corpus {
        lines.extend([
            "## Corpus".into(),
            format!("- ID: {}", corpus.id),
            format!("- Name: {}", corpus.name),
            format!("- Created (Unix seconds): {}", corpus.created_at),
            format!("- Engine: {}", corpus.engine),
            format!("- Events: {}", corpus.event_count),
            format!("- Templates: {}", corpus.template_count),
            format!("- Embedding state: {}", corpus.embedding.state),
        ]);
        if let Some(stats) = &corpus.stats {
            lines.extend([
                format!(
                    "- Files: {} imported / {} discovered",
                    stats.imported_files, stats.discovered_files
                ),
                format!(
                    "- Omissions: {} excluded / {} failed / {} ignored",
                    stats.excluded_files, stats.failed_files, stats.ignored_files
                ),
                format!(
                    "- Partial corpus: {}",
                    if stats.partial { "yes" } else { "no" }
                ),
                format!("- Source bytes: {}", stats.source_bytes),
                format!("- Corpus bytes: {}", stats.corpus_bytes),
                format!(
                    "- Stored time bounds: {} to {}",
                    nullable(stats.stored_time_min.map(|value| value.to_string())),
                    nullable(stats.stored_time_max.map(|value| value.to_string()))
                ),
                format!("- Time quality: {}", stats.time_quality),
                String::new(),
                "### Level counts".into(),
            ]);
            lines.extend(count_lines(&stats.level_counts));
            lines.extend([String::new(), "### Parse-format counts".into()]);
            lines.extend(count_lines(&stats.format_counts));
            lines.extend([String::new(), "### Import reason counts".into()]);
            lines.extend(count_lines(&stats.reason_counts));
            lines.extend([String::new(), "### Bounded basename-only examples".into()]);
            if stats.basename_examples.is_empty() {
                lines.push("- none recorded".into());
            } else {
                lines.extend(
                    stats
                        .basename_examples
                        .iter()
                        .map(|example| format!("- {example}")),
                );
            }
        } else {
            lines.push("- Persisted detailed statistics: unavailable".into());
        }
        lines.push(String::new());
    }
    if let Some(failure) = &manifest.failed_ingest {
        lines.extend([
            "## Failed ingest".into(),
            format!("- Reason: {}", failure.reason_code),
            format!("- Summary: {}", failure.summary),
            format!("- Source kind: {}", failure.source_kind),
            format!(
                "- Cancelled: {}",
                if failure.cancelled { "yes" } else { "no" }
            ),
            format!("- Last phase: {}", failure.progress.last_phase),
            format!(
                "- Lines observed: {}",
                nullable(
                    failure
                        .progress
                        .lines_processed
                        .map(|value| value.to_string())
                )
            ),
            format!(
                "- Files observed: {}",
                nullable(
                    failure
                        .progress
                        .files_processed
                        .map(|value| value.to_string())
                )
            ),
            format!(
                "- Bytes observed: {}",
                nullable(
                    failure
                        .progress
                        .bytes_processed
                        .map(|value| value.to_string())
                )
            ),
            format!(
                "- Templates observed: {}",
                nullable(failure.progress.templates.map(|value| value.to_string()))
            ),
            String::new(),
            "### Scan evidence counters".into(),
            format!("- binary: {}", failure.evidence.scan_counts.binary),
            format!("- empty: {}", failure.evidence.scan_counts.empty),
            format!("- hidden: {}", failure.evidence.scan_counts.hidden),
            format!("- oversized: {}", failure.evidence.scan_counts.oversized),
            format!(
                "- read_failed: {}",
                failure.evidence.scan_counts.read_failed
            ),
            format!(
                "- parse_failed: {}",
                failure.evidence.scan_counts.parse_failed
            ),
            String::new(),
            "### Bounded basename/reason transcript".into(),
        ]);
        if failure.evidence.transcript.is_empty() {
            lines.push("- none recorded".into());
        } else {
            lines.extend(
                failure
                    .evidence
                    .transcript
                    .iter()
                    .map(|entry| format!("- {}: {}", entry.reason, entry.basename)),
            );
        }
        if failure.evidence.omitted_entries > 0 {
            lines.push(format!(
                "- {} additional observation(s) omitted by the core transcript bound",
                failure.evidence.omitted_entries
            ));
        }
        lines.extend([
            "- Corpus published: no".into(),
            "- Retention: memory only; cleared explicitly, by the next ingest attempt, or on app restart".into(),
            String::new(),
        ]);
    }
    if let Some(active) = &manifest.active_view {
        lines.extend([
            "## Active Explorer view (payload-free)".into(),
            format!("- Layout: {} / {}", active.breakpoint, active.density),
            format!(
                "- Rows: {} / {} metadata / {} focus",
                active.row_mode, active.metadata_presentation, active.field_emphasis
            ),
            format!("- Time: {} / {}", active.time_quality, active.link_mode),
            format!(
                "- Lanes: {} visible; source counts {}",
                active.visible_lane_count,
                if active.lane_source_counts.is_empty() {
                    "none".into()
                } else {
                    active
                        .lane_source_counts
                        .iter()
                        .map(u64::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ),
            format!(
                "- Filter counts: {} levels / {} sources / {} services / {} hosts",
                active.filters.level_count,
                active.filters.source_count,
                active.filters.service_count,
                active.filters.host_count
            ),
            format!(
                "- Filter values withheld: keyword {} / trace {}",
                if active.filters.keyword_present {
                    "present"
                } else {
                    "absent"
                },
                if active.filters.trace_present {
                    "present"
                } else {
                    "absent"
                }
            ),
            format!(
                "- Time bounds: {} to {}",
                nullable(active.filters.time_from.map(|value| value.to_string())),
                nullable(active.filters.time_to.map(|value| value.to_string()))
            ),
            format!(
                "- Sequence bounds: {} to {}",
                nullable(active.filters.seq_from.map(|value| value.to_string())),
                nullable(active.filters.seq_to.map(|value| value.to_string()))
            ),
            format!(
                "- Template filter: {}",
                nullable(active.filters.template_id.map(|value| value.to_string()))
            ),
            format!(
                "- Find: {}; {} resident identities",
                if active.find.active {
                    active.find.match_mode.as_str()
                } else {
                    "off"
                },
                active.find.resident_matches
            ),
            format!(
                "- Selected seqs (bounded): {}",
                join_counts(&active.selected_seqs)
            ),
            format!(
                "- Highlighted seqs (bounded): {}",
                join_counts(&active.highlighted_seqs)
            ),
            format!(
                "- Focused seq: {}",
                nullable(active.focused_seq.map(|value| value.to_string()))
            ),
            format!(
                "- Viewport anchors: {}",
                if active.viewport_anchors.is_empty() {
                    "none".into()
                } else {
                    active
                        .viewport_anchors
                        .iter()
                        .map(|anchor| format!("{}:{}", anchor.lane_id, anchor.seq))
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ),
            format!(
                "- UI state: {}; busy {}; error present {}",
                active.ui_state.category,
                if active.ui_state.busy { "yes" } else { "no" },
                if active.ui_state.has_error {
                    "yes"
                } else {
                    "no"
                }
            ),
            String::new(),
        ]);
    }
    lines.push("## Current app status (redacted)".into());
    lines.push(
        manifest
            .current_status
            .as_ref()
            .map(|status| format!("- {}: {}", status.kind, status.message))
            .unwrap_or_else(|| "- none captured".into()),
    );
    lines.extend([
        String::new(),
        "## User reproduction note (redacted)".into(),
        manifest
            .user_note
            .clone()
            .unwrap_or_else(|| "(none)".into()),
        String::new(),
        "## Privacy boundary".into(),
    ]);
    lines.extend(
        manifest
            .privacy
            .excluded
            .iter()
            .map(|item| format!("- Excluded: {item}")),
    );
    lines.extend([
        String::new(),
        "_Generated by ContextDesk. This bounded report is redacted, but the user must review it before sharing._".into(),
    ]);
    lines.join("\n")
}

fn join_counts(values: &[u64]) -> String {
    if values.is_empty() {
        "none".into()
    } else {
        values
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn safe_manifest_value() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "generatedAt": "2026-07-29T12:34:56.000Z",
            "privacy": {
                "redacted": true,
                "reviewRequired": true,
                "excluded": ["renderer supplied value"]
            },
            "application": {
                "version": "0.1.0",
                "channel": "dev",
                "gitSha": "de43caeba66df05068a50db9356efad3b64a4a45",
                "os": "macOS"
            },
            "corpus": {
                "id": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
                "name": "Incident",
                "createdAt": 1700000000,
                "engine": "duckdb",
                "eventCount": 12,
                "templateCount": 3,
                "stats": null,
                "embedding": { "state": "keyword_only" }
            },
            "failedIngest": null,
            "activeView": null,
            "currentStatus": { "kind": "status", "message": "ready" },
            "userNote": "Reproduced safely"
        })
    }

    #[test]
    fn strict_manifest_rejects_unknown_payload_and_model_fields() {
        for path in ["payload", "model"] {
            let mut value = safe_manifest_value();
            value
                .as_object_mut()
                .expect("manifest")
                .insert(path.into(), serde_json::json!("arbitrary private data"));
            let error = serde_json::from_value::<LogDiagnosticManifest>(value)
                .expect_err("unknown top-level data must fail closed");
            assert!(error.to_string().contains("unknown field"), "{error}");
        }

        let mut nested = safe_manifest_value();
        nested["application"]["model"] = serde_json::json!("private-model");
        let error = serde_json::from_value::<LogDiagnosticManifest>(nested)
            .expect_err("unknown nested data must fail closed");
        assert!(error.to_string().contains("unknown field"), "{error}");
    }

    #[test]
    fn token_like_git_sha_and_ids_fail_before_storage() {
        for (pointer, unsafe_value) in [
            (
                "/application/gitSha",
                "ghp_abcdefghijklmnopqrstuvwxyz123456",
            ),
            ("/corpus/id", "sk-abcdefghijklmnopqrstuvwxyz123456"),
        ] {
            let mut value = safe_manifest_value();
            *value.pointer_mut(pointer).expect("field") = serde_json::json!(unsafe_value);
            let manifest =
                serde_json::from_value::<LogDiagnosticManifest>(value).expect("typed shape");
            let error = LogDiagnosticReportStore::default()
                .prepare(manifest)
                .expect_err("unsafe identifier must fail");
            assert!(
                error.contains("gitSha") || error.contains("corpus id"),
                "{error}"
            );
        }
    }

    #[test]
    fn host_scrubs_every_free_text_field_and_renders_exact_stored_preview() {
        let mut value = safe_manifest_value();
        value["corpus"]["name"] = serde_json::json!("server.internal");
        value["currentStatus"]["message"] =
            serde_json::json!("Bearer secret-token-value at /opt/company/logs");
        value["userNote"] = serde_json::json!("127.0.0.1");
        let manifest = serde_json::from_value(value).expect("manifest");
        let mut store = LogDiagnosticReportStore::default();
        let prepared = store.prepare(manifest).expect("prepare");
        for forbidden in [
            "server.internal",
            "secret-token-value",
            "/opt/company",
            "127.0.0.1",
            "renderer supplied value",
        ] {
            assert!(!prepared.markdown.contains(forbidden), "{forbidden}");
            assert!(!prepared.json.contains(forbidden), "{forbidden}");
        }
        assert_eq!(
            store
                .content(&prepared.report_id, "markdown")
                .expect("stored markdown"),
            prepared.markdown
        );
        assert_eq!(
            store
                .content(&prepared.report_id, "json")
                .expect("stored json"),
            prepared.json
        );
    }

    #[test]
    fn report_ids_are_strict_and_store_is_bounded() {
        let manifest: LogDiagnosticManifest =
            serde_json::from_value(safe_manifest_value()).expect("manifest");
        let mut store = LogDiagnosticReportStore::default();
        let first = store.prepare(manifest.clone()).expect("first");
        for _ in 0..MAX_REPORTS {
            store.prepare(manifest.clone()).expect("next");
        }
        assert!(store.content(&first.report_id, "markdown").is_err());
        for invalid in [
            "cdlogdiag-sk-abcdefghijklmnopqrstuvwxyz",
            "cdlogdiag-0000000000000000-0000000000000000-extra",
            "arbitrary",
        ] {
            assert!(store.content(invalid, "markdown").is_err(), "{invalid}");
        }
    }
}
