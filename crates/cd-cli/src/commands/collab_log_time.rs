//! `contextdesk collab-log-time` — the narrow host boundary for War Room
//! log-time review.
//!
//! The Collab server owns the case, the durable declaration record, and every
//! user-facing decision. This command owns exactly one thing: running the
//! shipped desktop log-analysis pipeline over a case-bound corpus. All
//! timestamp math is delegated to `cd_core::log_analysis::timezone_resolution`
//! and `::timezone_application`; all corpus construction is delegated to
//! `cd_workflow::import`. Nothing here reimplements parsing, zone rules, or
//! revision publication.
//!
//! Two properties are structural rather than incidental:
//!
//! * **No zone is ever guessed.** The import runs with `default_timezone`
//!   forced to `None`, so a saved desktop default can never silently resolve a
//!   Collab corpus. A zone becomes authoritative only when a request carries
//!   one explicitly.
//! * **Every mutation is revision-bound.** State is re-read immediately before
//!   each preview/apply/clear/undo, so a concurrent change is reported as a
//!   conflict instead of being overwritten.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use cd_core::config::AppConfig;
use cd_core::log_analysis::event_revision::undo_event_revision;
use cd_core::log_analysis::parse::{LogFormat, ParsedLine, TimestampProvenance};
use cd_core::log_analysis::query::{
    query_chronology, query_events, search_events_advanced, ChronologyCursor, ChronologyQuery,
    EventQuery, EventSearchQuery, SearchMatchMode, TimeQuality, MAX_CHRONOLOGY_PAGE,
    MAX_EVENT_PAGE,
};
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::timezone_application::{
    apply_source_timezone, clear_source_timezone, load_timezone_resolution_state,
    preview_source_timezone, preview_source_timezone_samples,
};
use cd_core::log_analysis::timezone_resolution::{
    SourceTimezoneDeclaration, SourceTimezoneResolver, TimestampResolution,
    TimezoneDeclarationBasis, UnresolvedTimestampReason,
};
use cd_core::process_progress::NoopProcessProgress;
use cd_workflow::import::default_import_with_outcome;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::cli::CollabLogTimeArgs;
use crate::envelope::{CliError, CliResult, Render};

const REQUEST_SCHEMA_ID: &str = "cd-collab.log_time_request.v1";
const RESULT_SCHEMA_ID: &str = "cd-collab.log_time_result.v1";

// Keep the trusted host boundary aligned with the War Room intake envelope.
// The JSON request carries base64, so its transport cap includes worst-case
// base64 expansion plus bounded path and per-entry metadata overhead. The
// decoded checks below remain authoritative and reject any larger corpus.
const MAX_FILES: usize = 4_096;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_AGGREGATE_BYTES: usize = 512 * 1024 * 1024;
const MAX_PATH_DEPTH: usize = 8;
const MAX_PATH_CHARS: usize = 240;
const MAX_REQUEST_BYTES: u64 = 4 * (MAX_AGGREGATE_BYTES as u64).div_ceil(3)
    + MAX_FILES as u64 * (MAX_PATH_CHARS as u64 * 6 + 512)
    + 4_096;
/// Mirrors `LOG_TIME_LIMITS.maxPreviewSamples` in the Collab contract.
const MAX_SAMPLES: usize = 24;
/// Mirrors `LOG_TIME_LIMITS.maxExcerptChars` in the Collab contract.
const MAX_EXCERPT_CHARS: usize = 240;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// The Collab-to-host request. It carries no credential, endpoint, or provider
/// field, and no timezone default.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabLogTimeRequest {
    pub schema_id: String,
    pub case_id: String,
    pub action: CollabLogTimeAction,
}

/// One bounded synthetic or case-bound log file supplied for corpus build.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabLogFile {
    pub relative_path: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CollabLogTimeAction {
    /// Build a durable case-bound corpus from committed intake bytes.
    Build {
        corpus_name: String,
        files: Vec<CollabLogFile>,
    },
    /// Read durable declarations and per-source retention counts.
    Status { corpus_id: String },
    /// Recompute a source-bound preview against one exact revision.
    Preview {
        corpus_id: String,
        expected_revision: u64,
        source: String,
        iana_timezone: String,
    },
    /// Publish a previewed declaration after exact recomputation.
    Apply {
        corpus_id: String,
        expected_revision: u64,
        source: String,
        iana_timezone: String,
        declaration_fingerprint: String,
        declared_at: i64,
    },
    /// Withdraw a declaration, returning its events to ingest order.
    Clear {
        corpus_id: String,
        expected_revision: u64,
        source: String,
    },
    /// Step back exactly one durable revision.
    Undo {
        corpus_id: String,
        expected_revision: u64,
    },
    /// Read one stable normalized chronology page without mutating the corpus.
    Chronology {
        corpus_id: String,
        search: Option<String>,
        sources: Vec<String>,
        limit: usize,
        cursor: Option<String>,
    },
    /// Bounded event search through the shipped cd-core query pipeline.
    Search {
        corpus_id: String,
        expected_revision: u64,
        query: String,
        mode: String,
        case_sensitive: bool,
        k: u64,
        #[serde(default)]
        sources: Vec<String>,
        time_from: Option<i64>,
        time_to: Option<i64>,
    },
    /// List corpus events (no query) so the workbench can overlay host UTC.
    Events {
        corpus_id: String,
        expected_revision: u64,
        #[serde(default)]
        sources: Vec<String>,
        k: u64,
    },
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabLogTimeResult {
    pub schema_id: &'static str,
    pub case_id: String,
    pub corpus_id: String,
    pub corpus_revision: u64,
    /// Present for `build`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildOut>,
    /// Present for `status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SourceStatusOut>>,
    /// Present for `preview`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<PreviewOut>,
    /// Present for `apply`, `clear`, and `undo`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<RevisionOut>,
    /// Present for the read-only chronology projection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chronology: Option<ChronologyOut>,
    /// Present for `search`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<SearchOut>,
    /// Declarations in force after the operation, keyed by source.
    pub declarations: BTreeMap<String, DeclarationOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOut {
    pub bounded: bool,
    pub at_least: u64,
    pub returned: u64,
    pub partial: bool,
    pub cancelled: bool,
    pub diagnostic: Option<String>,
    pub hits: Vec<SearchHitOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitOut {
    pub seq: u64,
    pub source: String,
    pub message: String,
    pub level: String,
    pub ts: i64,
    pub time_quality: String,
    pub unresolved_local_timestamp: Option<String>,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOut {
    pub corpus_name: String,
    pub events_imported: u64,
    pub sources_selected: u64,
    pub sources_failed: u64,
    pub partial: bool,
    /// Sources the pipeline flagged as carrying zone-less local timestamps.
    /// These are reported, never resolved on the caller's behalf.
    pub timezone_ambiguous_sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusOut {
    pub source: String,
    pub unresolved_local_records: u64,
    pub resolved_local_records: u64,
    pub explicit_wall_clock_records: u64,
    pub other_order_only_records: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationOut {
    pub source: String,
    pub iana_timezone: String,
    pub basis: TimezoneDeclarationBasis,
    pub declared_at: i64,
    pub applied_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOut {
    pub declaration_fingerprint: String,
    pub source: String,
    pub iana_timezone: String,
    pub affected_records: u64,
    pub existing_wall_clock_records: u64,
    pub unchanged_order_only_records: u64,
    pub first_resolved_instant: Option<String>,
    pub last_resolved_instant: Option<String>,
    pub dst_gap_count: u64,
    pub dst_fold_count: u64,
    pub unsupported_timestamp_count: u64,
    pub zone_abbreviation_mismatch_count: u64,
    pub out_of_range_count: u64,
    pub samples: Vec<SampleOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleOut {
    pub ordinal: u64,
    pub outcome: &'static str,
    pub raw_timestamp: Option<String>,
    pub normalized_instant: Option<String>,
    pub utc_offset_seconds: Option<i32>,
    pub unresolved_reason: Option<&'static str>,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionOut {
    pub previous_revision: u64,
    pub applied_revision: u64,
    /// For `undo`, the earlier revision whose content is back in force. Undo
    /// publishes a new revision rather than deleting history, so this is the
    /// only field that says what the corpus now reads like.
    pub restored_revision: Option<u64>,
    pub changed_records: u64,
    pub event_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronologyOut {
    pub corpus_revision: u64,
    pub rows: Vec<ChronologyRowOut>,
    pub next_cursor: Option<String>,
    pub total_matched: u64,
    pub order_only_count: u64,
    pub time_quality: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronologyRowOut {
    pub seq: u64,
    pub source: String,
    pub raw_timestamp: Option<String>,
    pub normalized_instant: Option<String>,
    pub time_state: &'static str,
    pub timestamp_provenance: &'static str,
    pub order_only_reason: Option<&'static str>,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChronologyCursorToken {
    revision: u64,
    group: u8,
    value: i64,
    seq: u64,
    filter_fingerprint: String,
}

impl Render for CollabLogTimeResult {
    fn render_text(&self) -> String {
        let mut out = format!(
            "Log time review\n\n  Case      {}\n  Corpus    {}\n  Revision  {}\n",
            self.case_id, self.corpus_id, self.corpus_revision
        );
        if let Some(build) = &self.build {
            out.push_str(&format!(
                "\n  Built {} ({} events from {} source(s))\n",
                build.corpus_name, build.events_imported, build.sources_selected
            ));
            if !build.timezone_ambiguous_sources.is_empty() {
                out.push_str(&format!(
                    "  Awaiting a declared zone: {}\n",
                    build.timezone_ambiguous_sources.join(", ")
                ));
            }
        }
        if let Some(sources) = &self.sources {
            for status in sources {
                out.push_str(&format!(
                    "\n  {}\n    Resolved    {}\n    Unresolved  {}\n    Wall-clock  {}\n",
                    status.source,
                    status.resolved_local_records,
                    status.unresolved_local_records,
                    status.explicit_wall_clock_records
                ));
            }
        }
        if let Some(preview) = &self.preview {
            out.push_str(&format!(
                "\n  Preview {} for {}\n    Would resolve  {}\n    Stay ordered   {}\n    DST gap/fold   {}/{}\n",
                preview.iana_timezone,
                preview.source,
                preview.affected_records,
                preview.unchanged_order_only_records,
                preview.dst_gap_count,
                preview.dst_fold_count
            ));
        }
        if let Some(revision) = &self.revision {
            out.push_str(&format!(
                "\n  Revision {} -> {} ({} timestamps changed)\n",
                revision.previous_revision, revision.applied_revision, revision.changed_records
            ));
        }
        if let Some(chronology) = &self.chronology {
            out.push_str(&format!(
                "\n  Chronology {} row(s), {} match(es), {} order-only\n",
                chronology.rows.len(),
                chronology.total_matched,
                chronology.order_only_count
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CollabLogTimeResult is always serializable")
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run(args: &CollabLogTimeArgs) -> CliResult<Box<dyn Render>> {
    let request = read_request(&args.request)?;
    if request.schema_id != REQUEST_SCHEMA_ID {
        return Err(CliError::user("unsupported Collab log-time request schema"));
    }
    if request.case_id.trim().is_empty() || request.case_id.len() > 128 {
        return Err(CliError::user("case id is not a bounded token"));
    }
    let cache_root = args.cache_root.as_path();

    match &request.action {
        CollabLogTimeAction::Build { corpus_name, files } => {
            build(cache_root, &request.case_id, corpus_name, files)
        }
        CollabLogTimeAction::Status { corpus_id } => {
            status(cache_root, &request.case_id, corpus_id)
        }
        CollabLogTimeAction::Preview {
            corpus_id,
            expected_revision,
            source,
            iana_timezone,
        } => preview(
            cache_root,
            &request.case_id,
            corpus_id,
            *expected_revision,
            source,
            iana_timezone,
        ),
        CollabLogTimeAction::Apply {
            corpus_id,
            expected_revision,
            source,
            iana_timezone,
            declaration_fingerprint,
            declared_at,
        } => apply(
            cache_root,
            &request.case_id,
            corpus_id,
            *expected_revision,
            source,
            iana_timezone,
            declaration_fingerprint,
            *declared_at,
        ),
        CollabLogTimeAction::Clear {
            corpus_id,
            expected_revision,
            source,
        } => clear(
            cache_root,
            &request.case_id,
            corpus_id,
            *expected_revision,
            source,
        ),
        CollabLogTimeAction::Undo {
            corpus_id,
            expected_revision,
        } => undo(cache_root, &request.case_id, corpus_id, *expected_revision),
        CollabLogTimeAction::Chronology {
            corpus_id,
            search,
            sources,
            limit,
            cursor,
        } => chronology(
            cache_root,
            &request.case_id,
            corpus_id,
            search.as_deref(),
            sources,
            *limit,
            cursor.as_deref(),
        ),
        CollabLogTimeAction::Search {
            corpus_id,
            expected_revision,
            query,
            mode,
            case_sensitive,
            k,
            sources,
            time_from,
            time_to,
        } => search(
            cache_root,
            &request.case_id,
            corpus_id,
            *expected_revision,
            query,
            mode,
            *case_sensitive,
            *k,
            sources,
            *time_from,
            *time_to,
        ),
        CollabLogTimeAction::Events {
            corpus_id,
            expected_revision,
            sources,
            k,
        } => list_events(
            cache_root,
            &request.case_id,
            corpus_id,
            *expected_revision,
            sources,
            *k,
        ),
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

fn build(
    cache_root: &Path,
    case_id: &str,
    corpus_name: &str,
    files: &[CollabLogFile],
) -> CliResult<Box<dyn Render>> {
    if corpus_name.trim().is_empty() || corpus_name.len() > 128 {
        return Err(CliError::user("corpus name is not a bounded label"));
    }
    if files.is_empty() {
        return Err(CliError::user("at least one log file is required"));
    }
    validate_file_count(files.len())?;

    let staging = tempfile::tempdir()
        .map_err(|_| CliError::internal("could not stage the Collab log corpus"))?;
    let mut aggregate = 0usize;
    for file in files {
        let relative = safe_relative_path(&file.relative_path)?;
        let bytes = BASE64
            .decode(file.content_base64.as_bytes())
            .map_err(|_| CliError::user("log file content is not valid base64"))?;
        aggregate = checked_aggregate_size(aggregate, bytes.len())?;
        let target = staging.path().join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| CliError::internal("could not stage the Collab log corpus"))?;
        }
        fs::write(&target, &bytes)
            .map_err(|_| CliError::internal("could not stage the Collab log corpus"))?;
    }

    // The one configuration decision this boundary makes: never let a saved
    // desktop default resolve a Collab corpus. Ambiguity must survive import so
    // a person can review it.
    let cfg = AppConfig {
        default_timezone: None,
        ..AppConfig::default()
    };
    let (outcome, _report) =
        default_import_with_outcome(cache_root, staging.path(), &cfg, None, &NoopProcessProgress);
    let outcome = outcome.map_err(|error| CliError::internal(error.to_string()))?;
    let corpus_id = outcome.report.corpus_id.clone();
    // The import derives a name from the staging directory. Replace it with the
    // caller's label so no temporary path ever surfaces as corpus identity.
    LogCorpus::rename(cache_root, &corpus_id, corpus_name)
        .map_err(|error| CliError::internal(error.to_string()))?;
    let state = load_state(cache_root, &corpus_id)?;

    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id,
        corpus_revision: state.scope.event_revision,
        build: Some(BuildOut {
            corpus_name: corpus_name.to_string(),
            events_imported: outcome.events_imported,
            sources_selected: outcome.sources_selected,
            sources_failed: outcome.sources_failed,
            partial: outcome.partial,
            timezone_ambiguous_sources: outcome.timezone_ambiguous_sources.clone(),
        }),
        sources: Some(state.sources.iter().map(source_status_out).collect()),
        preview: None,
        revision: None,
        chronology: None,
        search: None,
        declarations: declarations_out(&state.declarations),
    }))
}

fn validate_file_count(file_count: usize) -> CliResult<()> {
    if file_count > MAX_FILES {
        return Err(CliError::user("file count exceeds the bounded input size"));
    }
    Ok(())
}

fn checked_aggregate_size(aggregate: usize, file_size: usize) -> CliResult<usize> {
    if file_size > MAX_FILE_BYTES {
        return Err(CliError::user("a log file exceeds the bounded input size"));
    }
    let aggregate = aggregate.saturating_add(file_size);
    if aggregate > MAX_AGGREGATE_BYTES {
        return Err(CliError::user(
            "log files exceed the bounded aggregate input size",
        ));
    }
    Ok(aggregate)
}

fn status(cache_root: &Path, case_id: &str, corpus_id: &str) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    let state = load_state(cache_root, corpus_id)?;
    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: state.scope.event_revision,
        build: None,
        sources: Some(state.sources.iter().map(source_status_out).collect()),
        preview: None,
        revision: None,
        chronology: None,
        search: None,
        declarations: declarations_out(&state.declarations),
    }))
}

fn preview(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
    iana_timezone: &str,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    let computed = preview_source_timezone(
        cache_root,
        corpus_id,
        expected_revision,
        source,
        iana_timezone,
    )
    .map_err(map_core_error)?;
    let samples = collect_samples(
        cache_root,
        corpus_id,
        source,
        iana_timezone,
        expected_revision,
    )?;
    let state = load_state(cache_root, corpus_id)?;

    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: computed.event_revision,
        build: None,
        sources: None,
        preview: Some(PreviewOut {
            declaration_fingerprint: computed.declaration_fingerprint.clone(),
            source: computed.source.clone(),
            iana_timezone: computed.iana_timezone.clone(),
            affected_records: computed.affected_records,
            existing_wall_clock_records: computed.existing_wall_clock_records,
            unchanged_order_only_records: computed.unchanged_order_only_records,
            first_resolved_instant: computed.first_resolved_instant.and_then(iso_instant),
            last_resolved_instant: computed.last_resolved_instant.and_then(iso_instant),
            dst_gap_count: computed.dst_gap_count,
            dst_fold_count: computed.dst_fold_count,
            unsupported_timestamp_count: computed.unsupported_timestamp_count,
            zone_abbreviation_mismatch_count: computed.zone_abbreviation_mismatch_count,
            out_of_range_count: computed.out_of_range_count,
            samples,
        }),
        revision: None,
        chronology: None,
        search: None,
        declarations: declarations_out(&state.declarations),
    }))
}

#[allow(clippy::too_many_arguments)]
fn apply(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
    iana_timezone: &str,
    declaration_fingerprint: &str,
    declared_at: i64,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    let report = apply_source_timezone(
        cache_root,
        corpus_id,
        expected_revision,
        source,
        iana_timezone,
        declaration_fingerprint,
        declared_at,
    )
    .map_err(map_core_error)?;
    revision_result(cache_root, case_id, corpus_id, report, None)
}

fn clear(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
    source: &str,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    let state = load_state(cache_root, corpus_id)?;
    let applied_revision = state
        .declarations
        .get(source)
        .map(|declaration| declaration.applied_revision)
        .ok_or_else(|| CliError::not_found("no timezone declaration exists for this source"))?;
    let report = clear_source_timezone(
        cache_root,
        corpus_id,
        expected_revision,
        source,
        applied_revision,
    )
    .map_err(map_core_error)?;
    revision_result(cache_root, case_id, corpus_id, report, None)
}

fn undo(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    // `undo_event_revision` publishes a NEW revision carrying the content of the
    // step before `expected_revision`. Name that restored revision explicitly so
    // the War Room never implies history was deleted.
    let restored = expected_revision
        .checked_sub(1)
        .ok_or_else(|| CliError::user("revision 0 has nothing to undo"))?;
    let report = undo_event_revision(cache_root, corpus_id, expected_revision, None)
        .map_err(map_core_error)?;
    revision_result(cache_root, case_id, corpus_id, report, Some(restored))
}

#[allow(clippy::too_many_arguments)]
fn search(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
    query: &str,
    mode: &str,
    case_sensitive: bool,
    k: u64,
    sources: &[String],
    time_from: Option<i64>,
    time_to: Option<i64>,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    if query.chars().count() > 512 {
        return Err(CliError::user("search query exceeds the bounded length"));
    }
    let match_mode = match mode {
        "literal" | "case_insensitive" => SearchMatchMode::Literal,
        "regex" => SearchMatchMode::Regex,
        _ => {
            return Err(CliError::user(
                "search mode must be literal, case_insensitive, or regex",
            ))
        }
    };
    let state = load_state(cache_root, corpus_id)?;
    if state.scope.event_revision != expected_revision {
        return Err(CliError::conflict(format!(
            "stale timezone search: expected revision {expected_revision}, current {}",
            state.scope.event_revision
        )));
    }
    let corpus = LogCorpus::open(cache_root, corpus_id).map_err(map_core_error)?;
    let cap = if query.is_empty() { 2_000 } else { 200 };
    let result = search_events_advanced(
        &corpus,
        &EventSearchQuery {
            query: if query.is_empty() {
                None
            } else {
                Some(query.to_string())
            },
            filter: EventQuery {
                time_from,
                time_to,
                sources: sources.to_vec(),
                ..EventQuery::default()
            },
            semantic: false,
            k: k.min(cap) as usize,
            match_mode,
            case_sensitive: if mode == "case_insensitive" {
                false
            } else {
                case_sensitive
            },
        },
        None,
    )
    .map_err(map_core_error)?;
    let hits: Vec<SearchHitOut> = result
        .hits
        .into_iter()
        .map(|hit| SearchHitOut {
            seq: hit.event.seq,
            source: hit.event.source,
            message: hit.event.message,
            level: hit.event.level,
            ts: hit.event.ts,
            time_quality: hit.event.time_quality.label().to_string(),
            unresolved_local_timestamp: hit.event.unresolved_local_timestamp,
            excerpt: hit.excerpt,
        })
        .collect();
    let returned = hits.len() as u64;
    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: state.scope.event_revision,
        build: None,
        sources: None,
        preview: None,
        revision: None,
        search: Some(SearchOut {
            bounded: result.partial || result.total_matched.is_none(),
            at_least: result.total_matched.unwrap_or(returned),
            returned,
            partial: result.partial,
            cancelled: result.cancelled,
            diagnostic: result.diagnostic,
            hits,
        }),
        declarations: declarations_out(&state.declarations),
    }))
}

fn list_events(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    expected_revision: u64,
    sources: &[String],
    k: u64,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    let state = load_state(cache_root, corpus_id)?;
    if state.scope.event_revision != expected_revision {
        return Err(CliError::conflict(format!(
            "stale timezone events: expected revision {expected_revision}, current {}",
            state.scope.event_revision
        )));
    }
    let corpus = LogCorpus::open(cache_root, corpus_id).map_err(map_core_error)?;
    let cap = k.clamp(1, 2_000) as usize;
    let mut hits: Vec<SearchHitOut> = Vec::new();
    let mut after_seq = None;
    let mut after_ts = None;
    let more;
    loop {
        let remaining = cap.saturating_sub(hits.len());
        if remaining == 0 {
            more = true;
            break;
        }
        let page = query_events(
            &corpus,
            &EventQuery {
                sources: sources.to_vec(),
                limit: remaining.min(MAX_EVENT_PAGE),
                after_seq,
                after_ts,
                ..EventQuery::default()
            },
        )
        .map_err(map_core_error)?;
        let exhausted = page.events.is_empty() || page.next_cursor.is_none();
        for event in page.events {
            hits.push(SearchHitOut {
                seq: event.seq,
                source: event.source,
                message: event.message,
                level: event.level,
                ts: event.ts,
                time_quality: event.time_quality.label().to_string(),
                unresolved_local_timestamp: event.unresolved_local_timestamp,
                excerpt: None,
            });
            if hits.len() >= cap {
                break;
            }
        }
        if hits.len() >= cap {
            more = page.next_cursor.is_some();
            break;
        }
        if exhausted {
            more = false;
            break;
        }
        after_seq = page.next_cursor;
        after_ts = page.next_ts;
    }
    let returned = hits.len() as u64;
    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: state.scope.event_revision,
        build: None,
        sources: None,
        preview: None,
        revision: None,
        search: Some(SearchOut {
            bounded: more,
            at_least: returned,
            returned,
            partial: more,
            cancelled: false,
            diagnostic: None,
            hits,
        }),
        declarations: declarations_out(&state.declarations),
    }))
}

fn revision_result(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    report: cd_core::log_analysis::event_revision::EventRevisionReport,
    restored_revision: Option<u64>,
) -> CliResult<Box<dyn Render>> {
    let state = load_state(cache_root, corpus_id)?;
    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: state.scope.event_revision,
        build: None,
        sources: Some(state.sources.iter().map(source_status_out).collect()),
        preview: None,
        revision: Some(RevisionOut {
            previous_revision: report.previous_revision,
            applied_revision: report.revision,
            restored_revision,
            changed_records: report.changed_events,
            event_count: report.event_count,
        }),
        search: None,
        declarations: declarations_out(&state.declarations),
        chronology: None,
    }))
}

// ---------------------------------------------------------------------------
// Normalized chronology
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn chronology(
    cache_root: &Path,
    case_id: &str,
    corpus_id: &str,
    search: Option<&str>,
    sources: &[String],
    limit: usize,
    cursor: Option<&str>,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = validated_corpus_id(corpus_id)?;
    if limit > MAX_CHRONOLOGY_PAGE {
        return Err(CliError::user("chronology page size exceeds cap"));
    }
    let after = cursor.map(decode_chronology_cursor).transpose()?;
    let query = ChronologyQuery {
        search: search.map(str::to_string),
        sources: sources.to_vec(),
        limit,
        after,
    };
    let state = load_state(cache_root, corpus_id)?;
    let corpus = LogCorpus::open(cache_root, corpus_id).map_err(map_core_error)?;
    let page = query_chronology(&corpus, &query).map_err(map_core_error)?;
    let rows = page
        .events
        .iter()
        .map(|event| chronology_row(event, &state.declarations))
        .collect::<CliResult<Vec<_>>>()?;
    let next_cursor = page
        .next_cursor
        .as_ref()
        .map(encode_chronology_cursor)
        .transpose()?;

    Ok(Box::new(CollabLogTimeResult {
        schema_id: RESULT_SCHEMA_ID,
        case_id: case_id.to_string(),
        corpus_id: corpus_id.to_string(),
        corpus_revision: state.scope.event_revision,
        build: None,
        sources: None,
        preview: None,
        revision: None,
        chronology: Some(ChronologyOut {
            corpus_revision: state.scope.event_revision,
            rows,
            next_cursor,
            total_matched: page.total_matched,
            order_only_count: page.order_only_count,
            time_quality: chronology_time_quality(page.time_quality),
        }),
        declarations: declarations_out(&state.declarations),
    }))
}

fn chronology_row(
    event: &cd_core::log_analysis::query::ChronologyEvent,
    declarations: &BTreeMap<String, SourceTimezoneDeclaration>,
) -> CliResult<ChronologyRowOut> {
    let resolved = event.active_timestamp_basis.is_wall_clock();
    let (normalized_instant, order_only_reason) = if resolved {
        let instant = iso_instant(event.ts).ok_or_else(|| {
            CliError::internal("chronology wall-clock timestamp is outside the supported range")
        })?;
        (Some(instant), None)
    } else {
        (None, chronology_order_only_reason(event, declarations)?)
    };
    Ok(ChronologyRowOut {
        seq: event.seq,
        source: event.source.clone(),
        raw_timestamp: event.unresolved_local_timestamp.clone(),
        normalized_instant,
        time_state: if resolved { "resolved" } else { "order_only" },
        timestamp_provenance: chronology_provenance(event.timestamp_provenance),
        order_only_reason,
        level: event.level.clone(),
        message: truncate_chars(&event.message, MAX_EXCERPT_CHARS),
    })
}

fn chronology_order_only_reason(
    event: &cd_core::log_analysis::query::ChronologyEvent,
    declarations: &BTreeMap<String, SourceTimezoneDeclaration>,
) -> CliResult<Option<&'static str>> {
    if event.timestamp_provenance != TimestampProvenance::UnresolvedLocal {
        return Ok(Some("no_recognized_local_timestamp"));
    }
    let Some(declaration) = declarations.get(&event.source) else {
        return Ok(Some("timezone_unresolved"));
    };
    let resolver = SourceTimezoneResolver::new(declaration.clone())
        .map_err(|error| CliError::internal(error.to_string()))?;
    let parsed = ParsedLine {
        ts: Some(event.ts),
        timestamp_provenance: event.timestamp_provenance,
        active_timestamp_basis: event.active_timestamp_basis,
        unresolved_local_timestamp: event.unresolved_local_timestamp.clone(),
        level: event.level.clone(),
        service: None,
        host: None,
        trace_id: None,
        message: event.message.clone(),
        raw: String::new(),
        format: LogFormat::Plain,
    };
    match resolver
        .resolve(&event.source, &parsed)
        .map_err(|error| CliError::internal(error.to_string()))?
    {
        TimestampResolution::Unresolved { reason } => Ok(Some(unresolved_reason(reason))),
        TimestampResolution::ExistingWallClock { .. } | TimestampResolution::Resolved { .. } => {
            Err(CliError::internal(
                "chronology event basis disagrees with its timezone declaration",
            ))
        }
    }
}

fn chronology_provenance(provenance: TimestampProvenance) -> &'static str {
    match provenance {
        TimestampProvenance::ExplicitWallClock => "explicit_wall",
        TimestampProvenance::UnresolvedLocal => "unresolved_local",
        TimestampProvenance::OrderOnly => "order_only",
        TimestampProvenance::LegacyUnknown => "legacy_unknown",
    }
}

fn chronology_time_quality(quality: TimeQuality) -> &'static str {
    match quality {
        TimeQuality::Wall => "wall",
        TimeQuality::Mixed => "mixed",
        TimeQuality::OrderOnly => "order_only",
    }
}

fn decode_chronology_cursor(raw: &str) -> CliResult<ChronologyCursor> {
    if raw.is_empty() || raw.len() > 2_048 {
        return Err(CliError::user("chronology cursor is not bounded"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.as_bytes())
        .map_err(|_| CliError::user("chronology cursor is invalid"))?;
    let token: ChronologyCursorToken = serde_json::from_slice(&bytes)
        .map_err(|_| CliError::user("chronology cursor is invalid"))?;
    if token.group > 1
        || token.filter_fingerprint.len() != 64
        || !token
            .filter_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || (token.group == 1 && i64::try_from(token.seq).ok() != Some(token.value))
    {
        return Err(CliError::user("chronology cursor is invalid"));
    }
    Ok(ChronologyCursor {
        revision: token.revision,
        group: token.group,
        value: token.value,
        seq: token.seq,
        filter_fingerprint: token.filter_fingerprint,
    })
}

fn encode_chronology_cursor(cursor: &ChronologyCursor) -> CliResult<String> {
    let token = ChronologyCursorToken {
        revision: cursor.revision,
        group: cursor.group,
        value: cursor.value,
        seq: cursor.seq,
        filter_fingerprint: cursor.filter_fingerprint.clone(),
    };
    let bytes = serde_json::to_vec(&token)
        .map_err(|_| CliError::internal("chronology cursor could not be encoded"))?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    if encoded.len() > 2_048 {
        return Err(CliError::internal("chronology cursor exceeded its bound"));
    }
    Ok(encoded)
}

// ---------------------------------------------------------------------------
// Sample collection
// ---------------------------------------------------------------------------

/// Bounded evidence rows behind a preview's counters.
///
/// `cd_core` decides every row with the same resolver the preview used, so a
/// sample can never disagree with the aggregate it illustrates. This function
/// only reshapes the result for the wire.
fn collect_samples(
    cache_root: &Path,
    corpus_id: &str,
    source: &str,
    iana_timezone: &str,
    expected_revision: u64,
) -> CliResult<Vec<SampleOut>> {
    let rows = preview_source_timezone_samples(
        cache_root,
        corpus_id,
        expected_revision,
        source,
        iana_timezone,
        MAX_SAMPLES,
    )
    .map_err(map_core_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let (outcome, normalized, offset, reason) = match &row.resolution {
                TimestampResolution::ExistingWallClock { unix_seconds } => (
                    "existing_wall_clock",
                    iso_instant(*unix_seconds),
                    None,
                    None,
                ),
                TimestampResolution::Resolved {
                    unix_seconds,
                    provenance,
                } => (
                    "resolved",
                    iso_instant(*unix_seconds),
                    Some(provenance.resolved_utc_offset_seconds),
                    None,
                ),
                TimestampResolution::Unresolved { reason } => {
                    ("unresolved", None, None, Some(unresolved_reason(*reason)))
                }
            };
            SampleOut {
                ordinal: row.seq,
                outcome,
                raw_timestamp: row.raw_timestamp,
                normalized_instant: normalized,
                utc_offset_seconds: offset,
                unresolved_reason: reason,
                excerpt: truncate_chars(&row.message, MAX_EXCERPT_CHARS),
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_request(path: &Path) -> CliResult<CollabLogTimeRequest> {
    let mut bytes = Vec::new();
    if path == Path::new("-") {
        io::stdin()
            .lock()
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| CliError::user("Collab log-time request could not be read"))?;
    } else {
        let metadata = fs::metadata(path)
            .map_err(|_| CliError::user("Collab log-time request file could not be read"))?;
        if !metadata.is_file() || metadata.len() > MAX_REQUEST_BYTES {
            return Err(CliError::user(
                "Collab log-time request exceeds the bounded input size",
            ));
        }
        fs::File::open(path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| CliError::user("Collab log-time request could not be read"))?;
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(CliError::user(
            "Collab log-time request exceeds the bounded input size",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| CliError::user("Collab log-time request JSON is malformed"))
}

/// Accept only a corpus-relative, non-traversing, bounded path. This boundary
/// re-checks what the Collab intake already enforced rather than trusting it.
fn safe_relative_path(raw: &str) -> CliResult<PathBuf> {
    if raw.is_empty() || raw.len() > MAX_PATH_CHARS {
        return Err(CliError::user(
            "log file path is not a bounded relative path",
        ));
    }
    if raw.contains('\0') {
        return Err(CliError::user("log file path must not contain NUL"));
    }
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        return Err(CliError::user("log file path must stay corpus-relative"));
    }
    let mut depth = 0usize;
    let mut safe = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                depth += 1;
                if depth > MAX_PATH_DEPTH {
                    return Err(CliError::user("log file path is too deep"));
                }
                safe.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(CliError::user("log file path must stay corpus-relative"));
            }
        }
    }
    if safe.as_os_str().is_empty() {
        return Err(CliError::user(
            "log file path is not a bounded relative path",
        ));
    }
    Ok(safe)
}

fn validated_corpus_id(corpus_id: &str) -> CliResult<&str> {
    let bounded = !corpus_id.is_empty()
        && corpus_id.len() <= 128
        && corpus_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !bounded {
        return Err(CliError::user("corpus id is not a bounded token"));
    }
    Ok(corpus_id)
}

fn load_state(
    cache_root: &Path,
    corpus_id: &str,
) -> CliResult<cd_core::log_analysis::timezone_application::TimezoneResolutionState> {
    load_timezone_resolution_state(cache_root, corpus_id).map_err(|error| {
        let message = error.to_string();
        if message.contains("no such corpus") || message.contains("not found") {
            CliError::not_found(format!("no corpus {corpus_id}"))
        } else {
            CliError::internal(message)
        }
    })
}

fn source_status_out(
    status: &cd_core::log_analysis::timezone_application::TimezoneSourceStatus,
) -> SourceStatusOut {
    SourceStatusOut {
        source: status.source.clone(),
        unresolved_local_records: status.unresolved_local_records,
        resolved_local_records: status.resolved_local_records,
        explicit_wall_clock_records: status.explicit_wall_clock_records,
        other_order_only_records: status.other_order_only_records,
    }
}

fn declarations_out(
    declarations: &BTreeMap<String, SourceTimezoneDeclaration>,
) -> BTreeMap<String, DeclarationOut> {
    declarations
        .iter()
        .map(|(source, declaration)| {
            (
                source.clone(),
                DeclarationOut {
                    source: declaration.source.clone(),
                    iana_timezone: declaration.iana_timezone.clone(),
                    basis: declaration.basis,
                    declared_at: declaration.declared_at,
                    applied_revision: declaration.applied_revision,
                },
            )
        })
        .collect()
}

fn iso_instant(unix_seconds: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(unix_seconds, 0)
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn unresolved_reason(reason: UnresolvedTimestampReason) -> &'static str {
    match reason {
        UnresolvedTimestampReason::NoRecognizedLocalTimestamp => "no_recognized_local_timestamp",
        UnresolvedTimestampReason::UnsupportedLocalTimestampShape => {
            "unsupported_local_timestamp_shape"
        }
        UnresolvedTimestampReason::AmbiguousDstFold => "ambiguous_dst_fold",
        UnresolvedTimestampReason::NonexistentDstGap => "nonexistent_dst_gap",
        UnresolvedTimestampReason::ZoneAbbreviationMismatch => "zone_abbreviation_mismatch",
        UnresolvedTimestampReason::ResolvedInstantOutOfRange => "resolved_instant_out_of_range",
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

fn map_core_error(error: cd_core::error::CoreError) -> CliError {
    let message = error.to_string();
    if message.contains("stale") || message.contains("no longer matches") {
        CliError::conflict(message)
    } else if message.contains("no such corpus") || message.contains("no timezone declaration") {
        CliError::not_found(message)
    } else if message.contains("invalid") {
        CliError::user(message)
    } else {
        CliError::internal(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_host_capacity_matches_the_war_room_intake_envelope() {
        assert_eq!(MAX_FILES, 4_096);
        assert_eq!(MAX_FILE_BYTES, 64 * 1024 * 1024);
        assert_eq!(MAX_AGGREGATE_BYTES, 512 * 1024 * 1024);
        assert!(validate_file_count(MAX_FILES).is_ok());
        assert!(validate_file_count(MAX_FILES + 1).is_err());
    }

    #[test]
    fn decoded_file_and_aggregate_limits_are_fail_closed() {
        assert_eq!(
            checked_aggregate_size(0, MAX_FILE_BYTES).expect("exact file boundary"),
            MAX_FILE_BYTES
        );
        assert!(checked_aggregate_size(0, MAX_FILE_BYTES + 1).is_err());
        assert_eq!(
            checked_aggregate_size(MAX_AGGREGATE_BYTES - 1, 1).expect("exact aggregate boundary"),
            MAX_AGGREGATE_BYTES
        );
        assert!(checked_aggregate_size(MAX_AGGREGATE_BYTES, 1).is_err());
        assert!(checked_aggregate_size(usize::MAX, 1).is_err());
    }

    #[test]
    fn request_limit_covers_worst_case_base64_and_metadata() {
        let base64_ceiling = 4 * (MAX_AGGREGATE_BYTES as u64).div_ceil(3);
        assert!(MAX_REQUEST_BYTES > base64_ceiling);
        assert_eq!(
            MAX_REQUEST_BYTES,
            base64_ceiling + MAX_FILES as u64 * (MAX_PATH_CHARS as u64 * 6 + 512) + 4_096
        );
    }
}
