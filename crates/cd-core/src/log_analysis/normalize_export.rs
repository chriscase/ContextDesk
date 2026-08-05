//! Export selected log sources as `contextdesk.normalized_log_events.v1` JSONL.
//!
//! Host-neutral: maps real ingest events (with redacted originals and timestamp
//! provenance) into the normalized contract. Does not call providers or the
//! keychain. Callers (workflow) own preview/selection, ephemeral ingest, and
//! staging lifecycle.

#![allow(missing_docs)]

use super::parse::{ActiveTimestampBasis, LogFormat, ParsedLine, TimestampProvenance};
use super::store::{LogCorpus, LogEvent};
use super::timezone_resolution::{
    SourceTimezoneDeclaration, SourceTimezoneResolver, TimestampResolution,
    TimezoneDeclarationBasis, TIMEZONE_DECLARATION_SCHEMA_VERSION,
};
use crate::error::{CoreError, CoreResult};
use crate::normalized_log_events::{
    validate_stream, EventTime, NormalizedLogEvent, NormalizedLogHeader, ProducerIdentity,
    ProducerRedactionClaim, Severity, SeverityConfidence, SeverityProvenance, TimeBasis,
    TimeResolution, NORMALIZED_LOG_EVENTS_READER_VERSION, NORMALIZED_LOG_EVENTS_SCHEMA_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Producer identity stamped on every normalize export header.
pub const NORMALIZE_PRODUCER_NAME: &str = "contextdesk-normalize";
/// Producer version for this export path.
pub const NORMALIZE_PRODUCER_VERSION: &str = "1.0.0";

/// How to resolve zone-less local timestamps for normalize export.
#[derive(Debug, Clone, Default)]
pub struct NormalizeTimezonePolicy {
    /// Default IANA zone applied to every source that has no map entry.
    pub default_source_timezone: Option<String>,
    /// Per-source identity (portable path) → IANA zone.
    pub timezone_map: BTreeMap<String, String>,
    /// When true, unresolved local timestamps without a zone cause export failure.
    pub strict_time: bool,
}

impl NormalizeTimezonePolicy {
    /// Resolve the IANA zone for one source identity, if any.
    pub fn zone_for_source(&self, source: &str) -> Option<&str> {
        self.timezone_map
            .get(source)
            .map(String::as_str)
            .or(self.default_source_timezone.as_deref())
    }
}

/// One stored event plus optional redacted original and flags.
pub type EventWithOriginal = (LogEvent, Option<String>, bool, bool);

/// One source's events ready for JSONL export.
#[derive(Debug, Clone)]
pub struct SourceExportBatch {
    /// Portable source identity (same as ingest `source` column).
    pub source_id: String,
    /// Optional human label.
    pub source_label: Option<String>,
    /// Ordered events for this source.
    pub events: Vec<NormalizedLogEvent>,
    /// Whether any event claimed redaction applied on its original.
    pub any_redaction: bool,
    /// Truncated canonical originals count.
    pub truncations: u64,
}

/// Aggregate report for one normalize run (machine + human summary).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationReport {
    /// Schema for this report document.
    pub schema_id: String,
    /// Wall-clock of the export (unix seconds).
    pub generated_at: u64,
    /// Input path as provided by the caller.
    pub input: String,
    /// Output directory published to.
    pub output: String,
    /// Output data format (`jsonl`).
    pub output_format: String,
    /// Preview inventory counts.
    pub sources_examined: u64,
    /// Selected for normalize.
    pub sources_selected: u64,
    /// Noise / ignored.
    pub sources_ignored: u64,
    /// Unsupported content.
    pub sources_unsupported: u64,
    /// Policy-blocked.
    pub sources_excluded: u64,
    /// I/O or hard failures.
    pub sources_failed: u64,
    /// Logical events written.
    pub events: u64,
    /// Time resolution tallies among written events.
    pub time_source_explicit: u64,
    pub time_producer_resolved: u64,
    pub time_unresolved: u64,
    pub time_order_only: u64,
    /// Events whose original was redacted.
    pub redactions: u64,
    /// Events whose canonical was truncated.
    pub truncations: u64,
    /// Detected parse formats from ingest stats (if available).
    pub formats: BTreeMap<String, u64>,
    /// True when selection was incomplete or strict-time would have failed (should not publish).
    pub partial: bool,
    /// Per-source JSONL relative paths.
    pub sources: Vec<NormalizationSourceReport>,
    /// Bounded warnings (never log payloads).
    pub warnings: Vec<String>,
}

/// Per-source row in the normalization report / manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationSourceReport {
    pub source_id: String,
    pub relative_path: String,
    pub events: u64,
    pub time_source_explicit: u64,
    pub time_producer_resolved: u64,
    pub time_unresolved: u64,
    pub time_order_only: u64,
    pub redactions: u64,
    pub truncations: u64,
}

/// Manifest of published normalize outputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationManifest {
    pub schema_id: String,
    pub generated_at: u64,
    pub input: String,
    pub output_format: String,
    pub producer: ProducerIdentity,
    pub sources: Vec<NormalizationSourceReport>,
}

const REPORT_SCHEMA: &str = "contextdesk.normalization_report.v1";
const MANIFEST_SCHEMA: &str = "contextdesk.normalization_manifest.v1";

/// Map level string from parse to OTel-ish severity without inventing raw source fields.
///
/// Provenance is always [`SeverityProvenance::SchemaMapped`] (or Absent): we do
/// not retain raw severity tokens through current ingest, so we never claim
/// `source_declared`.
pub fn map_level_severity(level: &str) -> Severity {
    let canonical = match level.to_ascii_lowercase().as_str() {
        "trace" | "debug" => Some(5),
        "info" | "information" | "notice" => Some(9),
        "warn" | "warning" => Some(13),
        "error" | "err" => Some(17),
        "fatal" | "critical" | "crit" | "alert" | "emergency" => Some(21),
        "unknown" | "" => None,
        _ => None,
    };
    match canonical {
        Some(n) => Severity {
            raw: None,
            canonical: Some(n),
            confidence: SeverityConfidence::Medium,
            provenance: SeverityProvenance::SchemaMapped,
        },
        None => Severity {
            raw: None,
            canonical: None,
            confidence: SeverityConfidence::Low,
            provenance: SeverityProvenance::Absent,
        },
    }
}

/// Format unix seconds as RFC3339 UTC with `Z`.
pub fn unix_secs_to_rfc3339_z(secs: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| format!("{secs}"))
}

/// Map one stored ingest event + optional redacted original into a normalized event.
pub fn map_event_to_normalized(
    event: &LogEvent,
    original_text: Option<&str>,
    original_truncated: bool,
    policy: &NormalizeTimezonePolicy,
) -> CoreResult<NormalizedLogEvent> {
    let time = map_event_time(event, policy)?;
    let canonical = original_text
        .map(str::to_string)
        .unwrap_or_else(|| event.message.clone());
    // Never claim the redacted/normalized message is the original when we lost it.
    Ok(NormalizedLogEvent {
        source_seq: event.seq,
        time,
        severity: map_level_severity(&event.level),
        message: event.message.clone(),
        trace_id: event.trace_id.clone(),
        span_id: None,
        correlations: Vec::new(),
        attributes: serde_json::Map::new(),
        logger: None,
        service: event.service.clone(),
        host: event.host.clone(),
        canonical,
        canonical_truncated: original_truncated,
    })
}

fn map_event_time(event: &LogEvent, policy: &NormalizeTimezonePolicy) -> CoreResult<EventTime> {
    match event.timestamp_provenance {
        TimestampProvenance::ExplicitWallClock
            if event.active_timestamp_basis == ActiveTimestampBasis::ExplicitWall =>
        {
            Ok(EventTime {
                basis: TimeBasis::Wall,
                resolution: TimeResolution::SourceExplicit,
                instant: Some(unix_secs_to_rfc3339_z(event.ts)),
                local_text: None,
                resolved_timezone: None,
                observed: None,
            })
        }
        TimestampProvenance::UnresolvedLocal => {
            let local = event
                .unresolved_local_timestamp
                .clone()
                .filter(|s| !s.is_empty());
            let Some(local_text) = local else {
                // Malformed storage: treat as order-only rather than invent.
                return Ok(order_only_time());
            };
            if let Some(zone) = policy.zone_for_source(&event.source) {
                match try_producer_resolve(event, &local_text, zone) {
                    Ok(Some(resolved)) => return Ok(resolved),
                    Ok(None) => {
                        if policy.strict_time {
                            return Err(CoreError::Policy(format!(
                                "strict-time: could not resolve local timestamp for source {} with zone {zone}",
                                event.source
                            )));
                        }
                    }
                    Err(e) => return Err(e),
                }
            } else if policy.strict_time {
                return Err(CoreError::Policy(format!(
                    "strict-time: unresolved local timestamp on source {} without timezone",
                    event.source
                )));
            }
            // Honest: keep local text, no invented instant.
            Ok(EventTime {
                basis: TimeBasis::Order,
                resolution: TimeResolution::Unresolved,
                instant: None,
                local_text: Some(local_text),
                resolved_timezone: None,
                observed: None,
            })
        }
        TimestampProvenance::OrderOnly | TimestampProvenance::LegacyUnknown => {
            Ok(order_only_time())
        }
        TimestampProvenance::ExplicitWallClock => {
            // Explicit wall provenance with non-explicit active basis — still
            // emit source_explicit from stored ts when it is a wall basis.
            if event.active_timestamp_basis.is_wall_clock() {
                Ok(EventTime {
                    basis: TimeBasis::Wall,
                    resolution: TimeResolution::SourceExplicit,
                    instant: Some(unix_secs_to_rfc3339_z(event.ts)),
                    local_text: None,
                    resolved_timezone: None,
                    observed: None,
                })
            } else {
                Ok(order_only_time())
            }
        }
    }
}

fn order_only_time() -> EventTime {
    EventTime {
        basis: TimeBasis::Order,
        resolution: TimeResolution::OrderOnly,
        instant: None,
        local_text: None,
        resolved_timezone: None,
        observed: None,
    }
}

fn try_producer_resolve(
    event: &LogEvent,
    local_text: &str,
    iana: &str,
) -> CoreResult<Option<EventTime>> {
    let decl = SourceTimezoneDeclaration {
        schema_version: TIMEZONE_DECLARATION_SCHEMA_VERSION,
        source: event.source.clone(),
        iana_timezone: iana.to_string(),
        basis: TimezoneDeclarationBasis::UserDeclared,
        declared_at: now_unix() as i64,
        // validate_declaration rejects revision 0.
        applied_revision: 1,
    };
    let resolver = match SourceTimezoneResolver::new(decl) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let parsed = ParsedLine {
        ts: Some(event.ts),
        timestamp_provenance: event.timestamp_provenance,
        active_timestamp_basis: event.active_timestamp_basis,
        unresolved_local_timestamp: Some(local_text.to_string()),
        level: event.level.clone(),
        service: event.service.clone(),
        host: event.host.clone(),
        trace_id: event.trace_id.clone(),
        message: event.message.clone(),
        raw: local_text.to_string(),
        format: LogFormat::Plain,
    };
    match resolver.resolve(&event.source, &parsed) {
        Ok(TimestampResolution::Resolved {
            unix_seconds,
            provenance,
        }) => Ok(Some(EventTime {
            basis: TimeBasis::Wall,
            resolution: TimeResolution::ProducerResolved,
            // Contract: producer_resolved instant must be RFC3339 with offset;
            // we emit UTC Z which is an explicit offset of zero.
            instant: Some(unix_secs_to_rfc3339_z(unix_seconds)),
            local_text: Some(provenance.original_local_timestamp),
            resolved_timezone: Some(provenance.iana_timezone),
            observed: None,
        })),
        Ok(_) => Ok(None),
        Err(e) => Err(CoreError::Message(format!("timezone resolve: {e}"))),
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load events with redacted originals from an open corpus (ingest store).
pub fn load_events_with_originals(corpus: &LogCorpus) -> CoreResult<Vec<EventWithOriginal>> {
    corpus.with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source, \
                        timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp, \
                        original_redacted, original_truncated, original_redaction_applied \
                 FROM events ORDER BY seq",
            )
            .map_err(|e| CoreError::Message(format!("prepare events: {e}")))?;
        let rows = stmt
            .query_map([], |r| {
                let params_s: String = r.get(6)?;
                let params: Vec<String> = serde_json::from_str(&params_s).unwrap_or_default();
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    params,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, Option<String>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, Option<String>>(13)?,
                    r.get::<_, Option<bool>>(14)?,
                    r.get::<_, Option<bool>>(15)?,
                ))
            })
            .map_err(|e| CoreError::Message(format!("query events: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            let (
                seq,
                ts,
                level,
                service,
                host,
                template_id,
                params,
                trace_id,
                message,
                source,
                stored_provenance,
                stored_active_basis,
                unresolved_local_timestamp,
                original_redacted,
                original_truncated,
                original_redaction_applied,
            ) = row.map_err(|e| CoreError::Message(format!("row: {e}")))?;
            let timestamp_provenance = TimestampProvenance::from_storage_str(
                stored_provenance.as_deref(),
            )
            .ok_or_else(|| CoreError::Message("invalid timestamp provenance".into()))?;
            let active_timestamp_basis = ActiveTimestampBasis::from_storage_str(
                stored_active_basis.as_deref(),
            )
            .ok_or_else(|| CoreError::Message("invalid active timestamp basis".into()))?;
            let event = LogEvent {
                seq: u64::try_from(seq)
                    .map_err(|_| CoreError::Message("negative seq".into()))?,
                ts,
                timestamp_provenance,
                active_timestamp_basis,
                unresolved_local_timestamp,
                level,
                service,
                host,
                template_id: u64::try_from(template_id)
                    .map_err(|_| CoreError::Message("negative template".into()))?,
                params,
                trace_id,
                message,
                source,
            };
            event.validate_timestamp_provenance()?;
            out.push((
                event,
                original_redacted,
                original_truncated.unwrap_or(false),
                original_redaction_applied.unwrap_or(false),
            ));
        }
        Ok(out)
    })
}

/// Group mapped events by source identity.
pub fn build_source_batches(
    rows: &[EventWithOriginal],
    policy: &NormalizeTimezonePolicy,
) -> CoreResult<Vec<SourceExportBatch>> {
    let mut by_source: BTreeMap<String, SourceExportBatch> = BTreeMap::new();
    for (event, original, truncated, redacted) in rows {
        let mapped = map_event_to_normalized(event, original.as_deref(), *truncated, policy)?;
        // Re-number source_seq per source (0-based contiguous).
        let entry = by_source
            .entry(event.source.clone())
            .or_insert_with(|| SourceExportBatch {
                source_id: event.source.clone(),
                source_label: Some(event.source.clone()),
                events: Vec::new(),
                any_redaction: false,
                truncations: 0,
            });
        let mut ev = mapped;
        ev.source_seq = entry.events.len() as u64;
        if *redacted {
            entry.any_redaction = true;
        }
        if *truncated {
            entry.truncations += 1;
        }
        entry.events.push(ev);
    }
    Ok(by_source.into_values().collect())
}

/// Safe relative filename for one source JSONL under the output directory.
pub fn source_jsonl_relative_path(source_id: &str) -> String {
    let mut safe = String::with_capacity(source_id.len() + 8);
    for ch in source_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            safe.push(ch);
        } else {
            // Path separators and other punctuation collapse to '_'
            safe.push('_');
        }
    }
    if safe.is_empty() {
        safe.push_str("source");
    }
    // Avoid `file.jsonl.jsonl` when the source path already ends in .jsonl.
    let stem = safe
        .strip_suffix(".jsonl")
        .or_else(|| safe.strip_suffix(".json"))
        .unwrap_or(safe.as_str());
    format!("sources/{stem}.jsonl")
}

/// Write one conforming JSONL (header + events) to `path`.
pub fn write_source_jsonl(path: &Path, batch: &SourceExportBatch) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::create(path).map_err(|e| CoreError::Message(format!("create jsonl: {e}")))?;
    let mut w = BufWriter::new(file);
    let header = NormalizedLogHeader {
        schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.into(),
        min_reader_version: NORMALIZED_LOG_EVENTS_READER_VERSION,
        source_id: batch.source_id.clone(),
        producer: ProducerIdentity {
            name: NORMALIZE_PRODUCER_NAME.into(),
            version: NORMALIZE_PRODUCER_VERSION.into(),
        },
        redaction: Some(ProducerRedactionClaim {
            credentials_removed: batch.any_redaction,
            personal_data_removed: false,
            note: Some("ContextDesk normalize re-redacts; claim is advisory".into()),
        }),
        source_label: batch.source_label.clone(),
    };
    writeln!(
        w,
        "{}",
        serde_json::to_string(&header).map_err(|e| CoreError::Message(e.to_string()))?
    )
    .map_err(|e| CoreError::Message(format!("write header: {e}")))?;
    for event in &batch.events {
        writeln!(
            w,
            "{}",
            serde_json::to_string(event).map_err(|e| CoreError::Message(e.to_string()))?
        )
        .map_err(|e| CoreError::Message(format!("write event: {e}")))?;
    }
    w.flush()
        .map_err(|e| CoreError::Message(format!("flush jsonl: {e}")))?;
    Ok(())
}

/// Validate a JSONL file with the streaming validator; fail closed on invalid.
pub fn validate_jsonl_file(path: &Path) -> CoreResult<()> {
    let file =
        File::open(path).map_err(|e| CoreError::Message(format!("open for validate: {e}")))?;
    let reader = std::io::BufReader::new(file);
    let report = validate_stream(reader)?;
    if !report.ok {
        return Err(CoreError::Policy(format!(
            "normalized JSONL failed validation: {} ({} diagnostics)",
            path.display(),
            report.diagnostics.len()
        )));
    }
    Ok(())
}

/// Write staging tree for all batches; validate each JSONL; return report + staging root content list.
pub fn write_and_validate_staging(
    staging_dir: &Path,
    input_label: &str,
    batches: &[SourceExportBatch],
    formats: BTreeMap<String, u64>,
    preview_counts: PreviewCountSnapshot,
) -> CoreResult<NormalizationReport> {
    fs::create_dir_all(staging_dir.join("sources"))?;
    let mut sources = Vec::new();
    let mut total_events = 0u64;
    let mut t_explicit = 0u64;
    let mut t_resolved = 0u64;
    let mut t_unresolved = 0u64;
    let mut t_order = 0u64;
    let mut redactions = 0u64;
    let mut truncations = 0u64;

    for batch in batches {
        let rel = source_jsonl_relative_path(&batch.source_id);
        let path = staging_dir.join(&rel);
        write_source_jsonl(&path, batch)?;
        validate_jsonl_file(&path)?;

        let mut se = 0u64;
        let mut sr = 0u64;
        let mut su = 0u64;
        let mut so = 0u64;
        for ev in &batch.events {
            match ev.time.resolution {
                TimeResolution::SourceExplicit => se += 1,
                TimeResolution::ProducerResolved => sr += 1,
                TimeResolution::Unresolved => su += 1,
                TimeResolution::OrderOnly => so += 1,
            }
            if ev.canonical_truncated {
                truncations += 1;
            }
        }
        if batch.any_redaction {
            redactions += batch.events.len() as u64;
        }
        total_events += batch.events.len() as u64;
        t_explicit += se;
        t_resolved += sr;
        t_unresolved += su;
        t_order += so;
        sources.push(NormalizationSourceReport {
            source_id: batch.source_id.clone(),
            relative_path: rel,
            events: batch.events.len() as u64,
            time_source_explicit: se,
            time_producer_resolved: sr,
            time_unresolved: su,
            time_order_only: so,
            redactions: if batch.any_redaction {
                batch.events.len() as u64
            } else {
                0
            },
            truncations: batch.truncations,
        });
    }

    let generated_at = now_unix();
    let report = NormalizationReport {
        schema_id: REPORT_SCHEMA.into(),
        generated_at,
        input: input_label.into(),
        output: String::new(), // filled by publisher
        output_format: "jsonl".into(),
        sources_examined: preview_counts.examined,
        sources_selected: preview_counts.selected,
        sources_ignored: preview_counts.ignored,
        sources_unsupported: preview_counts.unsupported,
        sources_excluded: preview_counts.excluded,
        sources_failed: preview_counts.failed,
        events: total_events,
        time_source_explicit: t_explicit,
        time_producer_resolved: t_resolved,
        time_unresolved: t_unresolved,
        time_order_only: t_order,
        redactions,
        truncations,
        formats,
        partial: preview_counts.partial,
        sources: sources.clone(),
        warnings: Vec::new(),
    };

    let manifest = NormalizationManifest {
        schema_id: MANIFEST_SCHEMA.into(),
        generated_at,
        input: input_label.into(),
        output_format: "jsonl".into(),
        producer: ProducerIdentity {
            name: NORMALIZE_PRODUCER_NAME.into(),
            version: NORMALIZE_PRODUCER_VERSION.into(),
        },
        sources,
    };

    fs::write(
        staging_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::write(
        staging_dir.join("normalization-report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

/// Preview count snapshot supplied by workflow.
#[derive(Debug, Clone, Copy, Default)]
pub struct PreviewCountSnapshot {
    pub examined: u64,
    pub selected: u64,
    pub ignored: u64,
    pub unsupported: u64,
    pub excluded: u64,
    pub failed: u64,
    pub partial: bool,
}

/// Atomically publish staging directory contents into `output_dir`.
///
/// Refuses if `output_dir` exists and is non-empty (no-clobber). Creates
/// `output_dir` via rename of staging when possible; otherwise moves children.
pub fn publish_staging(staging_dir: &Path, output_dir: &Path) -> CoreResult<()> {
    if output_dir.exists() {
        let mut rd = fs::read_dir(output_dir)
            .map_err(|e| CoreError::Message(format!("inspect output: {e}")))?;
        if rd.next().is_some() {
            return Err(CoreError::Policy(format!(
                "refusing to overwrite non-empty output directory: {}",
                output_dir.display()
            )));
        }
        // empty dir — remove so rename can replace
        fs::remove_dir(output_dir).ok();
    }
    if let Some(parent) = output_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(staging_dir, output_dir) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-device fallback: copy tree then remove staging.
            copy_dir_recursive(staging_dir, output_dir)?;
            let _ = fs::remove_dir_all(staging_dir);
            Ok(())
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> CoreResult<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src).map_err(|e| CoreError::Message(e.to_string()))? {
        let entry = entry.map_err(|e| CoreError::Message(e.to_string()))?;
        let ty = entry
            .file_type()
            .map_err(|e| CoreError::Message(e.to_string()))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to).map_err(|e| CoreError::Message(e.to_string()))?;
        }
    }
    Ok(())
}

/// Mutation-friendly: never invent UTC for unresolved without a zone.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::parse::{ActiveTimestampBasis, TimestampProvenance};

    fn base_event() -> LogEvent {
        LogEvent {
            seq: 0,
            ts: 0,
            timestamp_provenance: TimestampProvenance::OrderOnly,
            active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
            unresolved_local_timestamp: None,
            level: "info".into(),
            service: None,
            host: None,
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: "hello".into(),
            source: "api/app.log".into(),
        }
    }

    #[test]
    fn unresolved_local_without_zone_has_no_instant() {
        let mut e = base_event();
        e.timestamp_provenance = TimestampProvenance::UnresolvedLocal;
        e.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        e.unresolved_local_timestamp = Some("2021-03-05 02:53:53,654".into());
        e.ts = 0;
        let policy = NormalizeTimezonePolicy::default();
        let n = map_event_to_normalized(&e, Some("raw line"), false, &policy).unwrap();
        assert_eq!(n.time.resolution, TimeResolution::Unresolved);
        assert!(n.time.instant.is_none());
        assert_eq!(
            n.time.local_text.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
        assert_eq!(n.canonical, "raw line");
    }

    #[test]
    fn explicit_wall_becomes_source_explicit_utc_z() {
        let mut e = base_event();
        e.timestamp_provenance = TimestampProvenance::ExplicitWallClock;
        e.active_timestamp_basis = ActiveTimestampBasis::ExplicitWall;
        e.ts = 1_609_459_200; // 2021-01-01T00:00:00Z
        let n =
            map_event_to_normalized(&e, Some("orig"), false, &NormalizeTimezonePolicy::default())
                .unwrap();
        assert_eq!(n.time.resolution, TimeResolution::SourceExplicit);
        assert_eq!(n.time.instant.as_deref(), Some("2021-01-01T00:00:00Z"));
    }

    #[test]
    fn producer_resolved_with_source_timezone() {
        let mut e = base_event();
        e.timestamp_provenance = TimestampProvenance::UnresolvedLocal;
        e.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        // Shape accepted by SourceTimezoneResolver::parse_complete_local_timestamp.
        e.unresolved_local_timestamp = Some("2021-03-05 12:00:00.000".into());
        let policy = NormalizeTimezonePolicy {
            default_source_timezone: Some("Etc/UTC".into()),
            ..NormalizeTimezonePolicy::default()
        };
        let n = map_event_to_normalized(&e, Some("orig"), false, &policy).unwrap();
        assert_eq!(
            n.time.resolution,
            TimeResolution::ProducerResolved,
            "instant={:?} local={:?}",
            n.time.instant,
            n.time.local_text
        );
        assert!(n.time.instant.is_some());
        assert_eq!(n.time.resolved_timezone.as_deref(), Some("Etc/UTC"));
        assert_eq!(
            n.time.local_text.as_deref(),
            Some("2021-03-05 12:00:00.000")
        );
    }

    #[test]
    fn severity_never_claims_source_declared_without_raw() {
        let s = map_level_severity("error");
        assert!(s.raw.is_none());
        assert_ne!(s.provenance, SeverityProvenance::SourceDeclared);
        assert_eq!(s.canonical, Some(17));
    }

    #[test]
    fn canonical_is_original_not_message() {
        let e = base_event();
        let n = map_event_to_normalized(
            &e,
            Some("ORIGINAL with secret [REDACTED]"),
            false,
            &NormalizeTimezonePolicy::default(),
        )
        .unwrap();
        assert_eq!(n.canonical, "ORIGINAL with secret [REDACTED]");
        assert_eq!(n.message, "hello");
    }

    #[test]
    fn strict_time_fails_unresolved_without_zone() {
        let mut e = base_event();
        e.timestamp_provenance = TimestampProvenance::UnresolvedLocal;
        e.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        e.unresolved_local_timestamp = Some("2021-03-05 02:53:53,654".into());
        let policy = NormalizeTimezonePolicy {
            strict_time: true,
            ..Default::default()
        };
        let err = map_event_to_normalized(&e, Some("x"), false, &policy).unwrap_err();
        assert!(err.to_string().contains("strict-time"));
    }

    #[test]
    fn publish_refuses_nonempty_output() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging");
        let out = tmp.path().join("out");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("a.txt"), b"x").unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("exists.txt"), b"y").unwrap();
        let err = publish_staging(&staging, &out).unwrap_err();
        assert!(err.to_string().contains("overwrite") || err.to_string().contains("non-empty"));
        assert!(out.join("exists.txt").exists());
    }
}
