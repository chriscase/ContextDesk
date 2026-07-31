use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::fmt::Write;
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
const MAX_SUPPRESSION_RULES: usize = 32;
const MAX_SUPPRESSION_AUDIT_ENTRIES: usize = 64;
const MAX_SEQS: usize = 32;
const MAX_LANES: usize = 4;
const MAX_RATIONALE_CHARS: usize = 400;
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
    suppression_policy: Option<DiagnosticSuppressionPolicy>,
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
struct DiagnosticSuppressionPolicy {
    policy_revision: u64,
    resolved_template_revision: u64,
    enabled_rule_count: u64,
    applied_rule_count: u64,
    stale_rule_count: u64,
    rules: Vec<DiagnosticSuppressionRule>,
    audit: Vec<DiagnosticSuppressionAuditEntry>,
    omitted_rule_entries: u64,
    omitted_audit_entries: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticSuppressionRule {
    rule_id: String,
    name: String,
    rationale: String,
    state: String,
    resolution_kind: String,
    /// Trusted-core explanation of the resolution; payload-free.
    #[serde(default)]
    explanation: String,
    matching_event_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiagnosticSuppressionAuditEntry {
    action: String,
    revision: u64,
    rule_id: Option<String>,
    created_at: u64,
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

    pub fn release(&mut self, report_id: &str) -> Result<bool, String> {
        validate_report_id(report_id)?;
        let Some(index) = self
            .reports
            .iter()
            .position(|report| report.id == report_id)
        else {
            return Ok(false);
        };
        self.reports.remove(index);
        Ok(true)
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
    if manifest.failed_ingest.is_some() && manifest.suppression_policy.is_some() {
        return Err("failed-ingest diagnostics cannot include a suppression policy".into());
    }
    if let Some(policy) = &mut manifest.suppression_policy {
        validate_suppression_policy(policy)?;
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

fn validate_suppression_policy(policy: &mut DiagnosticSuppressionPolicy) -> Result<(), String> {
    for (label, count) in [
        ("suppression policy revision", policy.policy_revision),
        (
            "suppression resolved template revision",
            policy.resolved_template_revision,
        ),
        ("suppression enabled rule count", policy.enabled_rule_count),
        ("suppression applied rule count", policy.applied_rule_count),
        ("suppression stale rule count", policy.stale_rule_count),
        (
            "suppression omitted rule entries",
            policy.omitted_rule_entries,
        ),
        (
            "suppression omitted audit entries",
            policy.omitted_audit_entries,
        ),
    ] {
        validate_count(count, label)?;
    }
    if policy.applied_rule_count > policy.enabled_rule_count
        || policy.stale_rule_count > policy.enabled_rule_count
    {
        return Err("suppression policy counts are internally inconsistent".into());
    }
    if policy.rules.len() > MAX_SUPPRESSION_RULES {
        return Err("suppression diagnostic rules exceed the entry bound".into());
    }
    if policy.audit.len() > MAX_SUPPRESSION_AUDIT_ENTRIES {
        return Err("suppression diagnostic audit exceeds the entry bound".into());
    }

    for rule in &mut policy.rules {
        rule.rule_id = validate_uuid_identifier(&rule.rule_id, "suppression rule id")?;
        rule.name = sanitize_text(&rule.name, MAX_LABEL_CHARS);
        if rule.name.is_empty() {
            rule.name = "Unnamed rule".into();
        }
        rule.rationale = sanitize_text(&rule.rationale, MAX_RATIONALE_CHARS);
        if rule.rationale.is_empty() {
            rule.rationale = "No rationale recorded".into();
        }
        validate_one_of(
            &rule.state,
            "suppression rule state",
            &["enabled", "disabled", "removed"],
        )?;
        validate_one_of(
            &rule.resolution_kind,
            "suppression rule resolution",
            &[
                "matches_current",
                "stale_target_missing",
                "stale_fingerprint_changed",
                "invalid_predicate",
                "conflicting_predicate",
                "inactive",
            ],
        )?;
        validate_count(
            rule.matching_event_count,
            "suppression rule matching event count",
        )?;
        match (rule.state.as_str(), rule.resolution_kind.as_str()) {
            ("enabled", "matches_current")
            | (
                "enabled",
                "stale_target_missing"
                | "stale_fingerprint_changed"
                | "invalid_predicate"
                | "conflicting_predicate",
            )
            | ("disabled" | "removed", "inactive") => {}
            _ => {
                return Err("suppression lifecycle and trusted resolution are inconsistent".into())
            }
        }
        if rule.resolution_kind != "matches_current" && rule.matching_event_count != 0 {
            return Err("non-applying suppression rules must report zero matches".into());
        }
        // An enabled+matches_current rule is the only applying case; a disabled
        // or removed rule may never report matches even with a matching kind.
        if rule.state != "enabled" && rule.matching_event_count != 0 {
            return Err("non-enabled suppression rules must report zero matches".into());
        }
        rule.explanation = sanitize_text(&rule.explanation, MAX_RATIONALE_CHARS);
    }

    let mut previous_revision = None;
    for entry in &mut policy.audit {
        validate_one_of(
            &entry.action,
            "suppression audit action",
            &["previewed", "activated", "disabled", "reenabled", "removed"],
        )?;
        validate_count(entry.revision, "suppression audit revision")?;
        validate_count(entry.created_at, "suppression audit createdAt")?;
        entry.rule_id = entry
            .rule_id
            .as_deref()
            .map(|value| validate_uuid_identifier(value, "suppression audit rule id"))
            .transpose()?;
        if entry.action == "previewed" {
            if entry.rule_id.is_some() {
                return Err("preview audit metadata cannot identify a rule".into());
            }
        } else if entry.rule_id.is_none() {
            return Err("suppression lifecycle audit metadata requires a rule id".into());
        }
        if entry.revision > policy.policy_revision
            || previous_revision.is_some_and(|revision| entry.revision <= revision)
        {
            return Err("suppression audit revisions are inconsistent".into());
        }
        previous_revision = Some(entry.revision);
    }
    if previous_revision.is_some_and(|revision| revision != policy.policy_revision) {
        return Err("suppression audit does not reach the reported policy revision".into());
    }
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
    validate_uuid_identifier(value, "diagnostic corpus id")
}

fn validate_uuid_identifier(value: &str, field: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let uuid_shape = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if !uuid_shape {
        return Err(format!("{field} must be a UUID"));
    }
    validate_identifier(value, field, 36)
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

fn markdown_literal(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_punctuation() {
            write!(&mut escaped, "&#{};", character as u32)
                .expect("writing a character reference to a String cannot fail");
        } else {
            escaped.push(character);
        }
    }
    escaped
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
            .map(|(key, value)| format!("- {}: {value}", markdown_literal(key)))
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
        format!(
            "- Version: {}",
            markdown_literal(&manifest.application.version)
        ),
        format!(
            "- Channel: {}",
            markdown_literal(&manifest.application.channel)
        ),
        format!(
            "- Git: {}",
            markdown_literal(&nullable(manifest.application.git_sha.clone()))
        ),
        format!("- OS: {}", markdown_literal(&manifest.application.os)),
        format!("- Generated: {}", markdown_literal(&manifest.generated_at)),
        String::new(),
    ];
    if let Some(corpus) = &manifest.corpus {
        lines.extend([
            "## Corpus".into(),
            format!("- ID: {}", markdown_literal(&corpus.id)),
            format!("- Name: {}", markdown_literal(&corpus.name)),
            format!("- Created (Unix seconds): {}", corpus.created_at),
            format!("- Engine: {}", markdown_literal(&corpus.engine)),
            format!("- Events: {}", corpus.event_count),
            format!("- Templates: {}", corpus.template_count),
            format!(
                "- Embedding state: {}",
                markdown_literal(&corpus.embedding.state)
            ),
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
                format!("- Time quality: {}", markdown_literal(&stats.time_quality)),
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
                        .map(|example| format!("- {}", markdown_literal(example))),
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
            format!("- Reason: {}", markdown_literal(&failure.reason_code)),
            format!("- Summary: {}", markdown_literal(&failure.summary)),
            format!("- Source kind: {}", markdown_literal(&failure.source_kind)),
            format!(
                "- Cancelled: {}",
                if failure.cancelled { "yes" } else { "no" }
            ),
            format!(
                "- Last phase: {}",
                markdown_literal(&failure.progress.last_phase)
            ),
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
            lines.extend(failure.evidence.transcript.iter().map(|entry| {
                format!(
                    "- {}: {}",
                    markdown_literal(&entry.reason),
                    markdown_literal(&entry.basename)
                )
            }));
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
    if let Some(policy) = &manifest.suppression_policy {
        lines.extend([
            "## Suppression policy (payload-free)".into(),
            format!("- Policy revision: {}", policy.policy_revision),
            format!(
                "- Resolved template revision: {}",
                policy.resolved_template_revision
            ),
            format!(
                "- Rules: {} enabled / {} applied / {} stale",
                policy.enabled_rule_count, policy.applied_rule_count, policy.stale_rule_count
            ),
            String::new(),
            "### Bounded rule metadata".into(),
        ]);
        if policy.rules.is_empty() {
            lines.push("- none recorded".into());
        } else {
            lines.extend(policy.rules.iter().map(|rule| {
                format!(
                    "- {} ({}): {} / {} / {} matching event(s) — {}",
                    markdown_literal(&rule.name),
                    markdown_literal(&rule.rule_id),
                    markdown_literal(&rule.state),
                    markdown_literal(&rule.resolution_kind),
                    rule.matching_event_count,
                    markdown_literal(&rule.rationale)
                )
            }));
        }
        if policy.omitted_rule_entries > 0 {
            lines.push(format!(
                "- {} additional rule entry/entries omitted by the diagnostic bound",
                policy.omitted_rule_entries
            ));
        }
        lines.extend([String::new(), "### Bounded payload-free audit".into()]);
        if policy.audit.is_empty() {
            lines.push("- none recorded".into());
        } else {
            lines.extend(policy.audit.iter().map(|entry| {
                format!(
                    "- Revision {}: {}; rule {}; Unix seconds {}",
                    entry.revision,
                    markdown_literal(&entry.action),
                    markdown_literal(&nullable(entry.rule_id.clone())),
                    entry.created_at
                )
            }));
        }
        if policy.omitted_audit_entries > 0 {
            lines.push(format!(
                "- {} older audit entry/entries omitted by the diagnostic bound",
                policy.omitted_audit_entries
            ));
        }
        lines.push(String::new());
    }
    if let Some(active) = &manifest.active_view {
        lines.extend([
            "## Active Explorer view (payload-free)".into(),
            format!(
                "- Layout: {} / {}",
                markdown_literal(&active.breakpoint),
                markdown_literal(&active.density)
            ),
            format!(
                "- Rows: {} / {} metadata / {} focus",
                markdown_literal(&active.row_mode),
                markdown_literal(&active.metadata_presentation),
                markdown_literal(&active.field_emphasis)
            ),
            format!(
                "- Time: {} / {}",
                markdown_literal(&active.time_quality),
                markdown_literal(&active.link_mode)
            ),
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
                    markdown_literal(&active.find.match_mode)
                } else {
                    "off".into()
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
                        .map(|anchor| {
                            format!("{}:{}", markdown_literal(&anchor.lane_id), anchor.seq)
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ),
            format!(
                "- UI state: {}; busy {}; error present {}",
                markdown_literal(&active.ui_state.category),
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
            .map(|status| {
                format!(
                    "- {}: {}",
                    markdown_literal(&status.kind),
                    markdown_literal(&status.message)
                )
            })
            .unwrap_or_else(|| "- none captured".into()),
    );
    lines.extend([
        String::new(),
        "## User reproduction note (redacted)".into(),
        manifest
            .user_note
            .as_deref()
            .map(markdown_literal)
            .unwrap_or_else(|| "(none)".into()),
        String::new(),
        "## Privacy boundary".into(),
    ]);
    lines.extend(
        manifest
            .privacy
            .excluded
            .iter()
            .map(|item| format!("- Excluded: {}", markdown_literal(item))),
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
            "suppressionPolicy": null,
            "activeView": null,
            "currentStatus": { "kind": "status", "message": "ready" },
            "userNote": "Reproduced safely"
        })
    }

    fn safe_suppression_policy_value() -> serde_json::Value {
        serde_json::json!({
            "policyRevision": 2,
            "resolvedTemplateRevision": 9,
            "enabledRuleCount": 2,
            "appliedRuleCount": 1,
            "staleRuleCount": 1,
            "rules": [
                {
                    "ruleId": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6d",
                    "name": "Applied repetitive family",
                    "rationale": "Reviewed exact template",
                    "state": "enabled",
                    "resolutionKind": "matches_current",
                    "matchingEventCount": 12452
                },
                {
                    "ruleId": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6e",
                    "name": "Missing template",
                    "rationale": "Retained for review",
                    "state": "enabled",
                    "resolutionKind": "stale_target_missing",
                    "matchingEventCount": 0
                }
            ],
            "audit": [
                {
                    "action": "previewed",
                    "revision": 1,
                    "ruleId": null,
                    "createdAt": 1753680000
                },
                {
                    "action": "activated",
                    "revision": 2,
                    "ruleId": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6d",
                    "createdAt": 1753680001
                }
            ],
            "omittedRuleEntries": 0,
            "omittedAuditEntries": 0
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
    fn host_accepts_and_renders_bounded_payload_free_suppression_diagnostics() {
        let mut value = safe_manifest_value();
        value["suppressionPolicy"] = safe_suppression_policy_value();
        value["suppressionPolicy"]["rules"][0]["name"] =
            serde_json::json!("Rule on server.internal");
        value["suppressionPolicy"]["rules"][0]["rationale"] =
            serde_json::json!("Hide /opt/company/logs with Bearer secret-token-value");

        let manifest = serde_json::from_value(value).expect("manifest");
        let prepared = LogDiagnosticReportStore::default()
            .prepare(manifest)
            .expect("prepare");

        for expected in [
            "## Suppression policy (payload-free)",
            "Policy revision: 2",
            "Resolved template revision: 9",
            "2 enabled / 1 applied / 1 stale",
            "stale&#95;target&#95;missing",
            "12452 matching event(s)",
            "Revision 2: activated",
        ] {
            assert!(prepared.markdown.contains(expected), "{expected}");
        }
        for forbidden in [
            "server.internal",
            "/opt/company",
            "secret-token-value",
            "representative",
            "previewToken",
            "rawPayload",
            "sourcePath",
        ] {
            assert!(!prepared.markdown.contains(forbidden), "{forbidden}");
            assert!(!prepared.json.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn suppression_diagnostics_reject_unknown_private_or_preview_fields() {
        for (pointer, field) in [
            ("/suppressionPolicy/rules/0", "representatives"),
            ("/suppressionPolicy/rules/0", "rawPayload"),
            ("/suppressionPolicy/rules/0", "sourcePath"),
            ("/suppressionPolicy/audit/0", "previewToken"),
        ] {
            let mut value = safe_manifest_value();
            value["suppressionPolicy"] = safe_suppression_policy_value();
            value
                .pointer_mut(pointer)
                .expect("target object")
                .as_object_mut()
                .expect("object")
                .insert(field.into(), serde_json::json!("private content"));
            let error = serde_json::from_value::<LogDiagnosticManifest>(value)
                .expect_err("private field must fail closed");
            assert!(error.to_string().contains("unknown field"), "{error}");
        }
    }

    #[test]
    fn suppression_diagnostics_reject_unbounded_or_inconsistent_shapes() {
        let mut unbounded = safe_manifest_value();
        unbounded["suppressionPolicy"] = safe_suppression_policy_value();
        let rule = unbounded["suppressionPolicy"]["rules"][0].clone();
        unbounded["suppressionPolicy"]["rules"] =
            serde_json::Value::Array(vec![rule; MAX_SUPPRESSION_RULES + 1]);
        let manifest = serde_json::from_value(unbounded).expect("typed manifest");
        let error = LogDiagnosticReportStore::default()
            .prepare(manifest)
            .expect_err("unbounded rules must fail");
        assert!(error.contains("rules exceed the entry bound"), "{error}");

        for (pointer, replacement, expected) in [
            (
                "/suppressionPolicy/appliedRuleCount",
                serde_json::json!(3),
                "counts are internally inconsistent",
            ),
            (
                "/suppressionPolicy/rules/1/matchingEventCount",
                serde_json::json!(1),
                "must report zero matches",
            ),
            (
                "/suppressionPolicy/rules/1/state",
                serde_json::json!("disabled"),
                "lifecycle and trusted resolution are inconsistent",
            ),
            (
                "/suppressionPolicy/audit/1/revision",
                serde_json::json!(1),
                "audit revisions are inconsistent",
            ),
        ] {
            let mut value = safe_manifest_value();
            value["suppressionPolicy"] = safe_suppression_policy_value();
            *value.pointer_mut(pointer).expect("field") = replacement;
            let manifest = serde_json::from_value(value).expect("typed manifest");
            let error = LogDiagnosticReportStore::default()
                .prepare(manifest)
                .expect_err("inconsistent policy must fail");
            assert!(error.contains(expected), "{pointer}: {error}");
        }
    }

    #[test]
    fn markdown_literal_neutralizes_ascii_syntax_and_encoded_delimiters() {
        let active = r#"![image](https://example.com/pixel) <script> `code` [ref]: <user@example.com> &#91;link&#93;"#;
        let escaped = markdown_literal(active);

        assert_eq!(
            escaped,
            "&#33;&#91;image&#93;&#40;https&#58;&#47;&#47;example&#46;com&#47;pixel&#41; \
&#60;script&#62; &#96;code&#96; &#91;ref&#93;&#58; \
&#60;user&#64;example&#46;com&#62; &#38;&#35;91&#59;link&#38;&#35;93&#59;"
        );
        for active_sequence in [
            "![",
            "](",
            "https://",
            "<script>",
            "`code`",
            "[ref]:",
            "<user@example.com>",
        ] {
            assert!(!escaped.contains(active_sequence), "{escaped}");
        }
    }

    #[test]
    fn host_markdown_neutralizes_active_content_without_changing_json_values() {
        let corpus_name = "Incident ![status](https://example.com/pixel)";
        let user_note = "Line one\n\
![remote](https://example.com/pixel)\n\
[link](https://example.com/report)\n\
<https://example.com/autolink> <script>alert(1)</script>\n\
[ref]: https://example.com/reference\n\
`inline` ``` fence break [brackets] <angles>\n\
&#91;encoded reference&#93;";
        let normalized_note = user_note.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut value = safe_manifest_value();
        value["corpus"]["name"] = serde_json::json!(corpus_name);
        value["currentStatus"]["message"] =
            serde_json::json!("<b>Retry</b> at https://example.com/status");
        value["userNote"] = serde_json::json!(user_note);

        let manifest = serde_json::from_value(value).expect("manifest");
        let prepared = LogDiagnosticReportStore::default()
            .prepare(manifest)
            .expect("prepare");

        for active_sequence in [
            "![status](",
            "![remote](",
            "[link](",
            "<https://",
            "<script>",
            "[ref]:",
            "`inline`",
            "```",
            "[brackets]",
            "<angles>",
            "&#91;encoded",
        ] {
            assert!(
                !prepared.markdown.contains(active_sequence),
                "{active_sequence}\n{}",
                prepared.markdown
            );
        }
        assert!(
            prepared
                .markdown
                .contains("Incident &#33;&#91;status&#93;&#40;https&#58;&#47;&#47;example&#46;com"),
            "{}",
            prepared.markdown
        );
        assert!(
            prepared
                .markdown
                .contains("&#96;&#96;&#96; fence break &#91;brackets&#93;"),
            "{}",
            prepared.markdown
        );
        assert!(prepared
            .markdown
            .starts_with("# ContextDesk corpus diagnostic\n"));
        assert!(prepared
            .markdown
            .contains("\n## User reproduction note (redacted)\n"));
        assert!(prepared.markdown.ends_with(
            "_Generated by ContextDesk. This bounded report is redacted, but the user must review it before sharing._"
        ));

        let json: serde_json::Value =
            serde_json::from_str(&prepared.json).expect("valid diagnostic JSON");
        assert_eq!(json["corpus"]["name"], corpus_name);
        assert_eq!(
            json["currentStatus"]["message"],
            "<b>Retry</b> at https://example.com/status"
        );
        assert_eq!(json["userNote"], normalized_note);
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

    #[test]
    fn releasing_a_report_removes_only_that_host_rendered_preview() {
        let manifest: LogDiagnosticManifest =
            serde_json::from_value(safe_manifest_value()).expect("manifest");
        let mut store = LogDiagnosticReportStore::default();
        let first = store.prepare(manifest.clone()).expect("first");
        let second = store.prepare(manifest).expect("second");

        assert!(store.release(&first.report_id).expect("release first"));
        assert!(!store
            .release(&first.report_id)
            .expect("release is idempotent"));
        assert!(store.content(&first.report_id, "markdown").is_err());
        assert_eq!(
            store
                .content(&second.report_id, "markdown")
                .expect("second remains"),
            second.markdown
        );
    }
}
