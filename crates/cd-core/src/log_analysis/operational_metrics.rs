//! Durable, corpus-scoped operational-metrics attachments (#772 / #763).
//!
//! This module owns one caller-neutral persistence contract. A manual file load
//! and a future validated Incident Evidence Bundle component both submit the
//! same bounded document plus safe source provenance. The original external
//! path is never accepted or stored, and attachment content is never exposed to
//! chat/model context by this API.

use crate::incident_evidence::{validate_metrics_document_text, Diagnostic, MAX_METRICS_DOC_BYTES};
use crate::log_analysis::TimeQuality;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use thiserror::Error;
use uuid::{Uuid, Version};

/// Schema version for the persisted attachment envelope.
pub const OPERATIONAL_METRICS_ATTACHMENT_SCHEMA_VERSION: u32 = 1;
/// Operational-metrics document schema currently supported by the product.
pub const OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION: u32 = 1;
/// Authoritative maximum document size, shared with Incident Evidence validation.
pub const MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES: u64 = MAX_METRICS_DOC_BYTES;
/// Maximum caller-supplied display label before basename sanitization.
pub const MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES: usize = 4 * 1024;

const ATTACHMENT_FILE_NAME: &str = "operational-metrics-attachment.v1.json";
const MAX_ATTACHMENT_ENVELOPE_BYTES: u64 =
    MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES * 2 + 128 * 1024;
const MAX_DISPLAY_BASENAME_BYTES: usize = 255;
const MAX_SOURCE_ID_BYTES: usize = 256;
const MAX_VALIDATION_DIAGNOSTICS: usize = 64;

static ATTACHMENT_MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Safe provenance for the action that attached the document.
///
/// Metric-series provenance remains authoritative inside the exact validated
/// document. These variants identify only the product workflow that persisted
/// that document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationalMetricsAttachmentSource {
    /// A person explicitly loaded a metric document.
    ManualLoad,
    /// A validated Incident Evidence Bundle component supplied the document.
    IncidentEvidence {
        /// Safe bundle identity from the validated manifest, never a path.
        bundle_id: String,
        /// Safe component identity from the validated manifest, never a path.
        component_id: String,
    },
}

/// Persisted, path-private metadata for one operational-metrics attachment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalMetricsAttachmentMetadata {
    /// Attachment envelope schema version.
    pub schema_version: u32,
    /// Stable attachment identity across close/reopen and process restart.
    pub attachment_id: String,
    /// Exact owning corpus identity.
    pub corpus_id: String,
    /// SHA-256 of the exact UTF-8 document content.
    pub content_sha256: String,
    /// Exact validated document byte count.
    pub content_bytes: u64,
    /// Operational-metrics schema version declared by the document.
    pub metric_schema_version: u32,
    /// Safe basename for display; never an original absolute path.
    pub display_name: String,
    /// Unix seconds when this exact content passed validation.
    pub validated_at_unix_secs: i64,
    /// Product workflow that supplied this attachment.
    pub source: OperationalMetricsAttachmentSource,
    /// Distinct time-quality declarations present in the exact document.
    pub time_quality_declarations: Vec<TimeQuality>,
}

/// A revalidated stored attachment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalMetricsAttachment {
    /// Verified path-private metadata.
    pub metadata: OperationalMetricsAttachmentMetadata,
    /// Exact UTF-8 document content originally validated and persisted.
    pub document_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationalMetricsAttachmentEnvelope {
    metadata: OperationalMetricsAttachmentMetadata,
    document_text: String,
}

/// Typed failures for save, restore, and removal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum OperationalMetricsAttachmentError {
    /// The requested corpus does not exist or its identity/storage is unsafe.
    #[error("The log corpus is unavailable.")]
    CorpusUnavailable,
    /// No attachment exists for the exact corpus.
    #[error("No operational-metrics attachment exists for this corpus.")]
    Missing,
    /// The submitted document exceeds the shared product bound.
    #[error("The operational-metrics document exceeds the supported size.")]
    TooLarge {
        /// Actual submitted byte count.
        actual_bytes: u64,
        /// Maximum accepted byte count.
        max_bytes: u64,
    },
    /// The submitted document failed the authoritative metrics validator.
    #[error("The operational-metrics document is invalid.")]
    InvalidDocument {
        /// Stable validation diagnostics with no external path.
        diagnostics: Vec<Diagnostic>,
    },
    /// Caller-supplied attachment provenance is unsafe or unsupported.
    #[error("The attachment source metadata is invalid.")]
    InvalidSource {
        /// Safe reason suitable for UI recovery guidance.
        reason: String,
    },
    /// The stored attachment envelope is newer than this reader.
    #[error("The stored metric attachment uses an unsupported schema version.")]
    UnsupportedAttachmentVersion {
        /// Version found in storage.
        found: u32,
        /// Highest version this reader supports.
        supported: u32,
    },
    /// The stored metric document schema is unsupported.
    #[error("The stored operational-metrics document uses an unsupported schema version.")]
    UnsupportedMetricSchema {
        /// Version found in the stored document or metadata.
        found: u32,
        /// Version this reader supports.
        supported: u32,
    },
    /// Stored bytes or metadata failed integrity/revalidation checks.
    #[error("The stored operational-metrics attachment is corrupt.")]
    Corrupt {
        /// Safe reason suitable for a visible recovery message.
        reason: String,
    },
    /// Application-controlled storage could not complete an operation.
    #[error("Operational-metrics attachment storage failed.")]
    Storage {
        /// Safe operation label; filesystem paths and raw OS errors are omitted.
        operation: String,
    },
}

/// Validate and atomically save or replace one attachment for an exact corpus.
///
/// `display_label` may be a caller-visible filename or component label. Only a
/// bounded basename is retained. `source` is workflow provenance, not a path.
pub fn save_operational_metrics_attachment(
    cache_root: &Path,
    corpus_id: &str,
    document_text: &str,
    display_label: &str,
    source: OperationalMetricsAttachmentSource,
) -> Result<OperationalMetricsAttachment, OperationalMetricsAttachmentError> {
    let _guard = mutation_guard()?;
    let corpus_root = open_exact_corpus_root(cache_root, corpus_id)?;
    let content_bytes = u64::try_from(document_text.len()).unwrap_or(u64::MAX);
    if content_bytes > MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES {
        return Err(OperationalMetricsAttachmentError::TooLarge {
            actual_bytes: content_bytes,
            max_bytes: MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES,
        });
    }
    if display_label.len() > MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES {
        return Err(OperationalMetricsAttachmentError::InvalidSource {
            reason: "display label exceeds its bounded input size".into(),
        });
    }
    validate_source(&source)?;
    let (metric_schema_version, time_quality_declarations) = validate_document(document_text)?;
    let metadata = OperationalMetricsAttachmentMetadata {
        schema_version: OPERATIONAL_METRICS_ATTACHMENT_SCHEMA_VERSION,
        attachment_id: Uuid::now_v7().to_string(),
        corpus_id: corpus_id.to_string(),
        content_sha256: sha256_hex(document_text.as_bytes()),
        content_bytes,
        metric_schema_version,
        display_name: safe_display_basename(display_label),
        validated_at_unix_secs: crate::embed::now_unix_secs(),
        source,
        time_quality_declarations,
    };
    let envelope = OperationalMetricsAttachmentEnvelope {
        metadata,
        document_text: document_text.to_string(),
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| storage_error("serialize"))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_ENVELOPE_BYTES {
        return Err(storage_error("bound serialized envelope"));
    }

    // Validate exactly what will be published before replacing prior state.
    let candidate: OperationalMetricsAttachmentEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| storage_error("verify serialization"))?;
    let attachment = validate_envelope(corpus_id, candidate)?;
    publish_envelope(&corpus_root, &bytes)?;
    Ok(attachment)
}

/// Load and fully revalidate one attachment for an exact corpus.
///
/// Missing storage is a typed error rather than an empty success so callers can
/// distinguish "never attached" from damaged or unsupported persisted state.
pub fn load_operational_metrics_attachment(
    cache_root: &Path,
    corpus_id: &str,
) -> Result<OperationalMetricsAttachment, OperationalMetricsAttachmentError> {
    let corpus_root = open_exact_corpus_root(cache_root, corpus_id)?;
    let envelope = read_envelope(&corpus_root)?;
    validate_envelope(corpus_id, envelope)
}

/// Remove only the exact corpus attachment.
///
/// Logs, findings, bookmarks, and external source files are never addressed by
/// this operation. Missing storage remains a typed error. Corrupt or
/// unsupported content does not prevent this explicit recovery operation.
pub fn remove_operational_metrics_attachment(
    cache_root: &Path,
    corpus_id: &str,
) -> Result<(), OperationalMetricsAttachmentError> {
    let _guard = mutation_guard()?;
    let corpus_root = open_exact_corpus_root(cache_root, corpus_id)?;
    let target = attachment_path(&corpus_root);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            return Err(corrupt("attachment is not a safe regular file"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(OperationalMetricsAttachmentError::Missing);
        }
        Err(_) => return Err(storage_error("inspect attachment")),
    }
    std::fs::remove_file(&target).map_err(|_| storage_error("remove attachment"))?;
    sync_directory(&corpus_root)?;
    Ok(())
}

fn open_exact_corpus_root(
    cache_root: &Path,
    corpus_id: &str,
) -> Result<PathBuf, OperationalMetricsAttachmentError> {
    super::store::contained_exact_corpus_root(cache_root, corpus_id)
        .map_err(|_| OperationalMetricsAttachmentError::CorpusUnavailable)
}

fn validate_document(
    document_text: &str,
) -> Result<(u32, Vec<TimeQuality>), OperationalMetricsAttachmentError> {
    let value: serde_json::Value = serde_json::from_str(document_text).map_err(|_| {
        OperationalMetricsAttachmentError::InvalidDocument {
            diagnostics: vec![Diagnostic::new(
                "metrics_json_invalid",
                "operational-metrics",
                "operational_metrics payload is not valid JSON",
            )],
        }
    })?;
    if let Some(found) = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
    {
        if found != OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION {
            return Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema {
                found,
                supported: OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION,
            });
        }
    }
    let mut diagnostics = Vec::new();
    validate_metrics_document_text(document_text, "operational-metrics", &mut diagnostics);
    if !diagnostics.is_empty() {
        diagnostics.truncate(MAX_VALIDATION_DIAGNOSTICS);
        return Err(OperationalMetricsAttachmentError::InvalidDocument { diagnostics });
    }
    let schema = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| OperationalMetricsAttachmentError::Corrupt {
            reason: "validated document has no bounded schema version".into(),
        })?;
    if schema != OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION {
        return Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema {
            found: schema,
            supported: OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION,
        });
    }
    Ok((schema, collect_time_quality_declarations(&value)))
}

fn collect_time_quality_declarations(value: &serde_json::Value) -> Vec<TimeQuality> {
    let mut wall = false;
    let mut mixed = false;
    let mut order_only = false;
    let mut observe = |candidate: Option<&str>| match candidate {
        Some("wall") => wall = true,
        Some("mixed") => mixed = true,
        Some("order_only") => order_only = true,
        _ => {}
    };
    if let Some(series) = value.get("series").and_then(serde_json::Value::as_array) {
        for item in series {
            observe(item.get("timeQuality").and_then(serde_json::Value::as_str));
            if let Some(points) = item.get("points").and_then(serde_json::Value::as_array) {
                for point in points {
                    observe(point.get("timeQuality").and_then(serde_json::Value::as_str));
                }
            }
        }
    }
    let mut declarations = Vec::with_capacity(3);
    if wall {
        declarations.push(TimeQuality::Wall);
    }
    if mixed {
        declarations.push(TimeQuality::Mixed);
    }
    if order_only {
        declarations.push(TimeQuality::OrderOnly);
    }
    declarations
}

fn validate_envelope(
    expected_corpus_id: &str,
    envelope: OperationalMetricsAttachmentEnvelope,
) -> Result<OperationalMetricsAttachment, OperationalMetricsAttachmentError> {
    let metadata = &envelope.metadata;
    if metadata.schema_version != OPERATIONAL_METRICS_ATTACHMENT_SCHEMA_VERSION {
        return Err(
            OperationalMetricsAttachmentError::UnsupportedAttachmentVersion {
                found: metadata.schema_version,
                supported: OPERATIONAL_METRICS_ATTACHMENT_SCHEMA_VERSION,
            },
        );
    }
    if metadata.corpus_id != expected_corpus_id {
        return Err(corrupt("attachment belongs to a different corpus"));
    }
    let attachment_id =
        Uuid::parse_str(&metadata.attachment_id).map_err(|_| corrupt("invalid attachment id"))?;
    if attachment_id.get_version() != Some(Version::SortRand) {
        return Err(corrupt("invalid attachment id"));
    }
    if metadata.validated_at_unix_secs < 0 {
        return Err(corrupt("invalid validation timestamp"));
    }
    validate_source(&metadata.source).map_err(|_| corrupt("invalid source provenance"))?;
    if safe_display_basename(&metadata.display_name) != metadata.display_name {
        return Err(corrupt("unsafe display name"));
    }
    let actual_bytes = u64::try_from(envelope.document_text.len()).unwrap_or(u64::MAX);
    if actual_bytes > MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES {
        return Err(OperationalMetricsAttachmentError::TooLarge {
            actual_bytes,
            max_bytes: MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES,
        });
    }
    if metadata.content_bytes != actual_bytes {
        return Err(corrupt("content byte count mismatch"));
    }
    if !is_sha256_hex(&metadata.content_sha256)
        || sha256_hex(envelope.document_text.as_bytes()) != metadata.content_sha256
    {
        return Err(corrupt("content digest mismatch"));
    }
    let (schema, declarations) = match validate_document(&envelope.document_text) {
        Ok(validated) => validated,
        Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema { found, supported })
            if metadata.metric_schema_version == found =>
        {
            return Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema {
                found,
                supported,
            });
        }
        Err(_) => return Err(corrupt("stored document failed revalidation")),
    };
    if schema != metadata.metric_schema_version {
        return Err(corrupt("document schema metadata mismatch"));
    }
    if declarations != metadata.time_quality_declarations {
        return Err(corrupt("time-quality metadata mismatch"));
    }
    Ok(OperationalMetricsAttachment {
        metadata: envelope.metadata,
        document_text: envelope.document_text,
    })
}

fn read_envelope(
    corpus_root: &Path,
) -> Result<OperationalMetricsAttachmentEnvelope, OperationalMetricsAttachmentError> {
    let path = attachment_path(corpus_root);
    let mut file = match open_regular_nofollow(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(OperationalMetricsAttachmentError::Missing);
        }
        Err(_) => return Err(corrupt("attachment is not a safe regular file")),
    };
    let bytes = read_stable_envelope_bytes(&mut file)?;
    serde_json::from_slice(&bytes).map_err(|_| corrupt("attachment envelope is not valid JSON"))
}

fn read_stable_envelope_bytes(
    file: &mut File,
) -> Result<Vec<u8>, OperationalMetricsAttachmentError> {
    read_stable_envelope_bytes_with_hook(file, || {})
}

fn read_stable_envelope_bytes_with_hook<F>(
    file: &mut File,
    after_first_read: F,
) -> Result<Vec<u8>, OperationalMetricsAttachmentError>
where
    F: FnOnce(),
{
    let before = file
        .metadata()
        .map_err(|_| storage_error("inspect attachment"))?;
    if before.len() > MAX_ATTACHMENT_ENVELOPE_BYTES {
        return Err(corrupt("attachment envelope exceeds its storage bound"));
    }
    let first = read_bounded_envelope_pass(file, before.len())?;
    after_first_read();
    file.seek(SeekFrom::Start(0))
        .map_err(|_| storage_error("rewind attachment"))?;
    let second = read_bounded_envelope_pass(file, before.len())?;
    let after = file
        .metadata()
        .map_err(|_| storage_error("reinspect attachment"))?;
    if before.len() != after.len() || first != second {
        return Err(corrupt("attachment changed while being read"));
    }
    Ok(second)
}

fn read_bounded_envelope_pass(
    file: &mut File,
    expected_len: u64,
) -> Result<Vec<u8>, OperationalMetricsAttachmentError> {
    let mut bytes = Vec::with_capacity(expected_len as usize);
    Read::by_ref(file)
        .take(MAX_ATTACHMENT_ENVELOPE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error("read attachment"))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_ENVELOPE_BYTES {
        return Err(corrupt("attachment envelope exceeds its storage bound"));
    }
    Ok(bytes)
}

fn publish_envelope(
    corpus_root: &Path,
    bytes: &[u8],
) -> Result<(), OperationalMetricsAttachmentError> {
    let target = attachment_path(corpus_root);
    reject_unsafe_existing_file(&target)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".operational-metrics-")
        .tempfile_in(corpus_root)
        .map_err(|_| storage_error("create temporary attachment"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|_| storage_error("write temporary attachment"))?;
    temporary
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|_| storage_error("rewind temporary attachment"))?;
    if read_stable_envelope_bytes(temporary.as_file_mut())? != bytes {
        return Err(corrupt("temporary attachment changed before publication"));
    }
    reject_unsafe_existing_file(&target)?;
    // `NamedTempFile::persist` atomically replaces an existing target. The
    // tempfile Windows implementation uses MoveFileExW with
    // MOVEFILE_REPLACE_EXISTING; there is no delete-first window.
    let published = temporary
        .persist(&target)
        .map_err(|_| storage_error("publish attachment atomically"))?;
    published
        .sync_all()
        .map_err(|_| storage_error("sync attachment"))?;
    sync_directory(corpus_root)
}

fn open_regular_nofollow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "attachment is not a regular non-symlink file",
        ));
    }
    Ok(file)
}

fn reject_unsafe_existing_file(path: &Path) -> Result<(), OperationalMetricsAttachmentError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            Err(corrupt("attachment is not a safe regular file"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(storage_error("inspect attachment")),
    }
}

fn validate_source(
    source: &OperationalMetricsAttachmentSource,
) -> Result<(), OperationalMetricsAttachmentError> {
    match source {
        OperationalMetricsAttachmentSource::ManualLoad => Ok(()),
        OperationalMetricsAttachmentSource::IncidentEvidence {
            bundle_id,
            component_id,
        } => {
            validate_safe_source_id("bundle id", bundle_id)?;
            validate_safe_source_id("component id", component_id)
        }
    }
}

fn validate_safe_source_id(
    label: &str,
    value: &str,
) -> Result<(), OperationalMetricsAttachmentError> {
    let safe = !value.is_empty()
        && value.len() <= MAX_SOURCE_ID_BYTES
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'@' | b'+' | b'/' | b'-')
        })
        && !value.split('/').any(|segment| segment == "..");
    if safe {
        Ok(())
    } else {
        Err(OperationalMetricsAttachmentError::InvalidSource {
            reason: format!("{label} must be a bounded safe identity, not a path"),
        })
    }
}

fn safe_display_basename(label: &str) -> String {
    let basename = label
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("");
    let mut safe = String::new();
    for character in basename.trim().chars() {
        if character.is_control() {
            continue;
        }
        if safe.len() + character.len_utf8() > MAX_DISPLAY_BASENAME_BYTES {
            break;
        }
        safe.push(character);
    }
    if safe.is_empty() || matches!(safe.as_str(), "." | "..") {
        "operational-metrics.json".into()
    } else {
        safe
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn attachment_path(corpus_root: &Path) -> PathBuf {
    corpus_root.join(ATTACHMENT_FILE_NAME)
}

fn mutation_guard() -> Result<MutexGuard<'static, ()>, OperationalMetricsAttachmentError> {
    ATTACHMENT_MUTATION_LOCK
        .lock()
        .map_err(|_| storage_error("acquire attachment lock"))
}

fn corrupt(reason: &str) -> OperationalMetricsAttachmentError {
    OperationalMetricsAttachmentError::Corrupt {
        reason: reason.into(),
    }
}

fn storage_error(operation: &str) -> OperationalMetricsAttachmentError {
    OperationalMetricsAttachmentError::Storage {
        operation: operation.into(),
    }
}

fn sync_directory(_directory: &Path) -> Result<(), OperationalMetricsAttachmentError> {
    #[cfg(unix)]
    {
        File::open(_directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| storage_error("sync corpus directory"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::LogCorpus;
    use serde_json::json;

    fn metric_document(id: &str, quality: &str, value: f64) -> String {
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "id": id,
            "name": format!("Metrics {id}"),
            "series": [{
                "id": "cpu",
                "name": "CPU",
                "unit": "%",
                "provenance": {"source": "synthetic-monitor"},
                "timeQuality": quality,
                "points": [
                    {"timestamp": 1_735_737_600.0, "value": value},
                    {
                        "timestamp": 1_735_737_601.0,
                        "value": value + 1.0,
                        "timeQuality": quality
                    }
                ]
            }]
        }))
        .unwrap()
    }

    fn corpus(cache: &Path, name: &str) -> LogCorpus {
        LogCorpus::create(cache, name).unwrap()
    }

    #[test]
    fn round_trip_survives_corpus_reopen_and_preserves_exact_content() {
        let cache = tempfile::tempdir().unwrap();
        let created = corpus(cache.path(), "restart");
        let corpus_id = created.id().to_string();
        let document = metric_document("restart", "wall", 42.5);
        let saved = save_operational_metrics_attachment(
            cache.path(),
            &corpus_id,
            &document,
            "/private/company/metrics.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        drop(created);

        let reopened = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        drop(reopened);
        let loaded = load_operational_metrics_attachment(cache.path(), &corpus_id).unwrap();
        assert_eq!(loaded, saved);
        assert_eq!(loaded.document_text.as_bytes(), document.as_bytes());
        assert_eq!(loaded.metadata.display_name, "metrics.json");
        assert_eq!(
            loaded.metadata.time_quality_declarations,
            vec![TimeQuality::Wall]
        );
    }

    #[test]
    fn different_corpora_never_share_an_attachment() {
        let cache = tempfile::tempdir().unwrap();
        let first = corpus(cache.path(), "first");
        let second = corpus(cache.path(), "second");
        save_operational_metrics_attachment(
            cache.path(),
            first.id(),
            &metric_document("same-name", "wall", 10.0),
            "same.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), second.id()),
            Err(OperationalMetricsAttachmentError::Missing)
        ));
    }

    #[test]
    fn replacement_is_atomic_and_failed_candidate_preserves_prior_attachment() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "replace");
        let first = save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &metric_document("first", "wall", 1.0),
            "first.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        let invalid = r#"{"schemaVersion":1,"id":"","series":[]}"#;
        assert!(matches!(
            save_operational_metrics_attachment(
                cache.path(),
                corpus.id(),
                invalid,
                "invalid.json",
                OperationalMetricsAttachmentSource::ManualLoad,
            ),
            Err(OperationalMetricsAttachmentError::InvalidDocument { .. })
        ));
        assert_eq!(
            load_operational_metrics_attachment(cache.path(), corpus.id()).unwrap(),
            first
        );

        let second = save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &metric_document("second", "mixed", 90.0),
            "second.json",
            OperationalMetricsAttachmentSource::IncidentEvidence {
                bundle_id: "incident:demo-1".into(),
                component_id: "metrics-main".into(),
            },
        )
        .unwrap();
        assert_ne!(second.metadata.attachment_id, first.metadata.attachment_id);
        assert_eq!(
            load_operational_metrics_attachment(cache.path(), corpus.id()).unwrap(),
            second
        );
        let temporary_count = std::fs::read_dir(corpus.root())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".operational-metrics-")
            })
            .count();
        assert_eq!(temporary_count, 0);
    }

    #[test]
    fn same_size_mutation_during_restore_is_detected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("attachment");
        std::fs::write(&path, b"aaaaaaaa").unwrap();
        let mut file = open_regular_nofollow(&path).unwrap();
        let error = read_stable_envelope_bytes_with_hook(&mut file, || {
            std::fs::write(&path, b"bbbbbbbb").unwrap();
        })
        .unwrap_err();
        assert!(matches!(
            error,
            OperationalMetricsAttachmentError::Corrupt { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn path_swap_during_restore_cannot_redirect_the_open_handle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("attachment");
        let retained = directory.path().join("retained");
        std::fs::write(&path, b"original").unwrap();
        let mut file = open_regular_nofollow(&path).unwrap();
        let bytes = read_stable_envelope_bytes_with_hook(&mut file, || {
            std::fs::rename(&path, &retained).unwrap();
            std::fs::write(&path, b"replaced").unwrap();
        })
        .unwrap();
        assert_eq!(bytes, b"original");
        assert_eq!(std::fs::read(&path).unwrap(), b"replaced");
    }

    #[test]
    fn remove_is_exact_and_missing_is_not_silent_success() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "remove");
        save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &metric_document("remove", "wall", 2.0),
            "remove.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        remove_operational_metrics_attachment(cache.path(), corpus.id()).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Missing)
        ));
        assert!(matches!(
            remove_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Missing)
        ));
        assert!(corpus.root().join("events.duckdb").is_file());
    }

    #[test]
    fn corruption_and_unsupported_versions_are_typed() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "corrupt");
        save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &metric_document("corrupt", "wall", 3.0),
            "corrupt.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        let path = attachment_path(corpus.root());
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["documentText"] = serde_json::Value::String(metric_document("changed", "wall", 4.0));
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Corrupt { .. })
        ));

        let newer_document = metric_document("newer", "wall", 4.0)
            .replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        value["documentText"] = json!(newer_document);
        value["metadata"]["contentBytes"] = json!(newer_document.len());
        value["metadata"]["contentSha256"] = json!(sha256_hex(newer_document.as_bytes()));
        value["metadata"]["metricSchemaVersion"] = json!(2);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema {
                found: 2,
                supported: 1
            })
        ));

        value["metadata"]["schemaVersion"] = json!(99);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(
                OperationalMetricsAttachmentError::UnsupportedAttachmentVersion {
                    found: 99,
                    supported: 1
                }
            )
        ));
        remove_operational_metrics_attachment(cache.path(), corpus.id())
            .expect("a corrupt attachment remains explicitly removable");
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Missing)
        ));
    }

    #[test]
    fn traversal_source_abuse_and_document_size_are_bounded() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "bounds");
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), "../outside"),
            Err(OperationalMetricsAttachmentError::CorpusUnavailable)
        ));
        assert!(matches!(
            save_operational_metrics_attachment(
                cache.path(),
                corpus.id(),
                &metric_document("source", "wall", 1.0),
                "metrics.json",
                OperationalMetricsAttachmentSource::IncidentEvidence {
                    bundle_id: "/private/bundle".into(),
                    component_id: "../metrics".into(),
                },
            ),
            Err(OperationalMetricsAttachmentError::InvalidSource { .. })
        ));
        let oversized = " ".repeat((MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES + 1) as usize);
        assert!(matches!(
            save_operational_metrics_attachment(
                cache.path(),
                corpus.id(),
                &oversized,
                "too-large.json",
                OperationalMetricsAttachmentSource::ManualLoad,
            ),
            Err(OperationalMetricsAttachmentError::TooLarge { .. })
        ));
        let newer = metric_document("newer", "wall", 1.0)
            .replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(matches!(
            save_operational_metrics_attachment(
                cache.path(),
                corpus.id(),
                &newer,
                "newer.json",
                OperationalMetricsAttachmentSource::ManualLoad,
            ),
            Err(OperationalMetricsAttachmentError::UnsupportedMetricSchema {
                found: 2,
                supported: 1
            })
        ));
        let oversized_label = "x".repeat(MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES + 1);
        assert!(matches!(
            save_operational_metrics_attachment(
                cache.path(),
                corpus.id(),
                &metric_document("label", "wall", 1.0),
                &oversized_label,
                OperationalMetricsAttachmentSource::ManualLoad,
            ),
            Err(OperationalMetricsAttachmentError::InvalidSource { .. })
        ));
        let invalid_points = (0..100)
            .map(|_| json!({"timestamp": "invalid", "value": "invalid"}))
            .collect::<Vec<_>>();
        let many_issues = json!({
            "schemaVersion": 1,
            "id": "bounded-diagnostics",
            "name": "Bounded diagnostics",
            "series": [{
                "id": "cpu",
                "name": "CPU",
                "unit": "%",
                "provenance": {"source": "test"},
                "timeQuality": "wall",
                "points": invalid_points
            }]
        })
        .to_string();
        let error = save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &many_issues,
            "many-issues.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap_err();
        match error {
            OperationalMetricsAttachmentError::InvalidDocument { diagnostics } => {
                assert_eq!(diagnostics.len(), MAX_VALIDATION_DIAGNOSTICS);
            }
            other => panic!("expected bounded diagnostics, got {other:?}"),
        }
    }

    #[test]
    fn persisted_envelope_never_contains_the_original_absolute_path() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "privacy");
        let private_path = "/Users/private-person/Secret Customer/metrics.json";
        let external = cache.path().join("external-original.json");
        std::fs::write(&external, "external content").unwrap();
        save_operational_metrics_attachment(
            cache.path(),
            corpus.id(),
            &metric_document("privacy", "wall", 5.0),
            private_path,
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        let stored = std::fs::read_to_string(attachment_path(corpus.root())).unwrap();
        assert!(!stored.contains(private_path));
        assert!(!stored.contains("/Users/private-person"));
        assert!(stored.contains("\"displayName\":\"metrics.json\""));
        remove_operational_metrics_attachment(cache.path(), corpus.id()).unwrap();
        assert_eq!(
            std::fs::read_to_string(external).unwrap(),
            "external content"
        );
    }

    #[cfg(unix)]
    #[test]
    fn attachment_symlink_is_never_followed_or_removed_as_content() {
        use std::os::unix::fs::symlink;

        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "symlink");
        let outside = cache.path().join("outside.json");
        std::fs::write(&outside, "outside").unwrap();
        symlink(&outside, attachment_path(corpus.root())).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Corrupt { .. })
        ));
        assert!(matches!(
            remove_operational_metrics_attachment(cache.path(), corpus.id()),
            Err(OperationalMetricsAttachmentError::Corrupt { .. })
        ));
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "outside");
    }

    #[cfg(unix)]
    #[test]
    fn corpus_root_symlink_escape_is_rejected_before_attachment_access() {
        use std::os::unix::fs::symlink;

        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "root escape");
        let corpus_id = corpus.id().to_string();
        let original_root = corpus.root().to_path_buf();
        drop(corpus);
        let retained = cache.path().join("retained-corpus");
        std::fs::rename(&original_root, &retained).unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), &original_root).unwrap();
        assert!(matches!(
            load_operational_metrics_attachment(cache.path(), &corpus_id),
            Err(OperationalMetricsAttachmentError::CorpusUnavailable)
        ));
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn corpus_discard_cleans_owned_attachment_only_with_the_corpus() {
        let cache = tempfile::tempdir().unwrap();
        let corpus = corpus(cache.path(), "cleanup");
        let corpus_id = corpus.id().to_string();
        let corpus_root = corpus.root().to_path_buf();
        save_operational_metrics_attachment(
            cache.path(),
            &corpus_id,
            &metric_document("cleanup", "wall", 6.0),
            "cleanup.json",
            OperationalMetricsAttachmentSource::ManualLoad,
        )
        .unwrap();
        drop(corpus);
        LogCorpus::discard(cache.path(), &corpus_id).unwrap();
        assert!(!corpus_root.exists());
    }
}
