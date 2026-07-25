//! Portable log-corpus package export/import (`contextdesk.log_corpus.v1`).
//!
//! ## Versioning (compat contract)
//!
//! - `format_version`: exact schema id (`contextdesk.log_corpus.vN`).
//! - `min_reader_version`: integer this binary must support (`PACKAGE_READER_VERSION`).
//! - Additive changes within a major: optional JSON fields / optional files only.
//! - Breaking changes require a new major and dual-path importers for N and N−1.
//! - Readers **ignore unknown JSON fields**; missing optionals use defaults.
//! - Too-new packages refuse **before** writing under `log_corpora/`.
//!
//! Zip layout:
//! ```text
//! manifest.json
//! meta.json
//! events.duckdb
//! templates.json
//! README.txt
//! ```

use super::store::{
    dir_size, write_meta_file, CorpusMeta, CorpusStats, LogCorpus, EVENT_ENGINE, META_VERSION,
};
use crate::error::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use uuid::Uuid;

/// Package format id for packages written by this build.
pub const PACKAGE_FORMAT_VERSION: &str = "contextdesk.log_corpus.v1";
/// Exact package readers compiled into this build.
///
/// Add the new reader here before changing the writer to a new major. Once v2
/// exists, keep both v2 and v1 in this registry for the documented N/N−1
/// compatibility window.
pub const PACKAGE_READERS: &[PackageReader] = &[PackageReader::V1];
/// Package kind.
pub const PACKAGE_KIND: &str = "log_corpus";
/// Reader capability version for this binary (bump when import rules change incompatibly).
pub const PACKAGE_READER_VERSION: u32 = 1;
/// Max compressed package size on import (2 GiB).
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max entries in package zip.
pub const MAX_PACKAGE_ENTRIES: usize = 32;
/// Max aggregate expanded bytes across every zip entry.
pub const MAX_EXPANDED_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max expanded bytes for any single entry.
pub const MAX_EXPANDED_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Explicit cap for manifest.json.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Explicit cap for the imported metadata document.
pub const MAX_META_BYTES: u64 = 4 * 1024 * 1024;
/// Expanded payload transfer buffer. No package file body is retained in memory.
pub const IMPORT_BUFFER_BYTES: usize = 64 * 1024;
/// Flat package entry names are intentionally short and non-hierarchical.
pub const MAX_ENTRY_NAME_BYTES: usize = 255;

/// Version-specific package reader selected only after shared ZIP/path/cap
/// validation has completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageReader {
    /// Historical and current `contextdesk.log_corpus.v1` packages.
    V1,
}

impl PackageReader {
    /// Exact manifest format identifier accepted by this reader.
    pub const fn format_version(self) -> &'static str {
        match self {
            Self::V1 => PACKAGE_FORMAT_VERSION,
        }
    }
}

/// One file entry in the package manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileEntry {
    /// Relative path inside the package.
    pub path: String,
    /// Hex SHA-256 of file bytes.
    pub sha256: String,
    /// Uncompressed size in bytes.
    pub bytes: u64,
}

/// Package manifest (shipped inside the zip).
///
/// Unknown JSON fields are ignored (`deny_unknown_fields` is **not** set).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    /// Package format version string.
    pub format_version: String,
    /// Oldest reader version that can import this package.
    #[serde(default = "default_min_reader_version")]
    pub min_reader_version: u32,
    /// Package kind (`log_corpus`).
    pub package_kind: String,
    /// Export time (unix secs).
    pub created_at: i64,
    /// Origin corpus id at export.
    pub corpus_id: String,
    /// Display name.
    pub name: String,
    /// Event engine id.
    pub engine: String,
    /// Optional feature tags (additive; unknown tags ignored by readers).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
    /// Optional writer diagnostics (never required for import).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_app_version: Option<String>,
    /// Payload file entries with hashes.
    pub files: Vec<PackageFileEntry>,
    /// Stats snapshot when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
}

fn default_min_reader_version() -> u32 {
    1
}

/// Result of importing a package.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageImportReport {
    /// New local corpus id after import.
    pub corpus_id: String,
    /// Display name.
    pub name: String,
    /// Corpus id from the package origin.
    pub origin_corpus_id: String,
    /// Stats snapshot when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
}

fn resolve_package_reader(format_version: &str) -> CoreResult<PackageReader> {
    if let Some(reader) = PACKAGE_READERS
        .iter()
        .copied()
        .find(|reader| reader.format_version() == format_version)
    {
        return Ok(reader);
    }

    let future_major = format_version
        .strip_prefix("contextdesk.log_corpus.v")
        .filter(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|suffix| suffix.parse::<u32>().ok())
        .filter(|major| *major > 1);
    if future_major.is_some() {
        return Err(CoreError::Message(format!(
            "This package requires ContextDesk package reader for format {format_version} \
             (this build supports {PACKAGE_FORMAT_VERSION} / reader {PACKAGE_READER_VERSION}). \
             Re-export from a matching app or upgrade ContextDesk."
        )));
    }

    Err(CoreError::Message(format!(
        "unsupported package format_version: {format_version} \
         (this build accepts exactly {PACKAGE_FORMAT_VERSION})"
    )))
}

fn resolve_package_reader_version(
    format_version: &str,
    min_reader_version: u32,
) -> CoreResult<PackageReader> {
    let reader = resolve_package_reader(format_version)?;
    if min_reader_version > PACKAGE_READER_VERSION {
        return Err(CoreError::Message(format!(
            "This package requires ContextDesk package reader ≥ {min_reader_version} \
             (this build supports {PACKAGE_READER_VERSION}). \
             Upgrade ContextDesk or ask the sender for an older package."
        )));
    }
    Ok(reader)
}

/// Validate format_version + min_reader_version before any cache writes.
pub fn validate_package_versions(format_version: &str, min_reader_version: u32) -> CoreResult<()> {
    resolve_package_reader_version(format_version, min_reader_version).map(|_| ())
}

/// Export an existing corpus directory into a portable zip at `out_path`.
pub fn export_corpus_zip(
    cache_root: &Path,
    corpus_id: &str,
    out_path: &Path,
) -> CoreResult<PackageManifest> {
    // Open, flush, snapshot meta, then **drop** the handle before reading
    // `events.duckdb` — Windows exclusive-locks the DuckDB file while open.
    let (root, meta) = {
        let corpus = LogCorpus::open(cache_root, corpus_id)?;
        corpus.flush()?;
        let root = corpus.root().to_path_buf();
        let meta = corpus.meta()?;
        (root, meta)
    };

    let payloads = ["meta.json", "events.duckdb", "templates.json"];
    let mut files = Vec::new();
    let mut file_bytes: Vec<(String, Vec<u8>)> = Vec::new();
    let mut features = vec!["events_duckdb".into(), "templates_json".into()];
    for name in payloads {
        let p = root.join(name);
        if !p.exists() {
            if name == "templates.json" {
                let empty = b"[]".to_vec();
                files.push(PackageFileEntry {
                    path: name.into(),
                    sha256: hex_sha256(&empty),
                    bytes: empty.len() as u64,
                });
                file_bytes.push((name.into(), empty));
                continue;
            }
            return Err(CoreError::Message(format!(
                "corpus package missing required file: {name}"
            )));
        }
        let data =
            std::fs::read(&p).map_err(|e| CoreError::Message(format!("read {name}: {e}")))?;
        if name == "templates.json" {
            if let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&data) {
                if rows.iter().any(|r| r.get("vector").is_some()) {
                    features.push("template_vectors".into());
                }
            }
        }
        files.push(PackageFileEntry {
            path: name.into(),
            sha256: hex_sha256(&data),
            bytes: data.len() as u64,
        });
        file_bytes.push((name.into(), data));
    }
    if meta.stats.is_some() {
        features.push("corpus_stats".into());
    }

    let manifest = PackageManifest {
        format_version: PACKAGE_FORMAT_VERSION.into(),
        min_reader_version: PACKAGE_READER_VERSION,
        package_kind: PACKAGE_KIND.into(),
        created_at: crate::embed::now_unix_secs(),
        corpus_id: meta.id.clone(),
        name: meta.name.clone(),
        engine: meta.engine.clone(),
        features,
        writer_app_version: None,
        files,
        stats: meta.stats.clone(),
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    let readme = format!(
        "ContextDesk log corpus package ({PACKAGE_FORMAT_VERSION})\n\
         min_reader_version: {}\n\
         \n\
         Name: {}\n\
         Corpus id: {}\n\
         Engine: {}\n\
         \n\
         Import via Logs → Import package… (SoftWrite).\n\
         Contains redacted analysis artifacts — share only with trusted peers.\n",
        manifest.min_reader_version, manifest.name, manifest.corpus_id, manifest.engine
    );

    let file = std::fs::File::create(out_path)
        .map_err(|e| CoreError::Message(format!("create package: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts)
        .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
    zip.write_all(&manifest_bytes)
        .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;

    zip.start_file("README.txt", opts)
        .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
    zip.write_all(readme.as_bytes())
        .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;

    for (name, data) in file_bytes {
        zip.start_file(&name, opts)
            .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
        zip.write_all(&data)
            .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;
    }

    zip.finish()
        .map_err(|e| CoreError::Message(format!("zip finish: {e}")))?;
    let _ = root;
    Ok(manifest)
}

/// Import a portable package zip into a new corpus under `cache_root`.
/// Always assigns a **new** corpus id; stores `origin_corpus_id` in meta.
///
/// On validation failure, no new directory is left under `log_corpora/`.
pub fn import_corpus_zip(cache_root: &Path, zip_bytes: &[u8]) -> CoreResult<PackageImportReport> {
    import_corpus_zip_reader(
        cache_root,
        std::io::Cursor::new(zip_bytes),
        zip_bytes.len() as u64,
    )
}

/// Import from a bounded `Read + Seek` source.
///
/// `compressed_len` must be obtained before constructing or buffering the
/// reader. The filesystem wrapper uses file metadata and the byte-slice wrapper
/// uses the slice length.
pub fn import_corpus_zip_reader<R: Read + Seek>(
    cache_root: &Path,
    reader: R,
    compressed_len: u64,
) -> CoreResult<PackageImportReport> {
    import_corpus_zip_reader_with_limits(
        cache_root,
        reader,
        compressed_len,
        ImportLimits::production(),
    )
    .map(|outcome| outcome.report)
}

#[derive(Debug, Clone, Copy)]
struct ImportLimits {
    compressed_bytes: u64,
    entries: usize,
    total_expanded_bytes: u64,
    entry_expanded_bytes: u64,
    manifest_bytes: u64,
    meta_bytes: u64,
    buffer_bytes: usize,
}

impl ImportLimits {
    const fn production() -> Self {
        Self {
            compressed_bytes: MAX_PACKAGE_BYTES,
            entries: MAX_PACKAGE_ENTRIES,
            total_expanded_bytes: MAX_EXPANDED_PACKAGE_BYTES,
            entry_expanded_bytes: MAX_EXPANDED_ENTRY_BYTES,
            manifest_bytes: MAX_MANIFEST_BYTES,
            meta_bytes: MAX_META_BYTES,
            buffer_bytes: IMPORT_BUFFER_BYTES,
        }
    }
}

#[derive(Debug, Default)]
struct ImportMetrics {
    max_transfer_chunk: usize,
    actual_expanded_bytes: u64,
}

#[derive(Debug)]
struct ImportOutcome {
    report: PackageImportReport,
    #[cfg_attr(not(test), allow(dead_code))]
    metrics: ImportMetrics,
}

#[derive(Debug, Clone)]
struct ScannedEntry {
    index: usize,
    name: String,
    expanded_bytes: u64,
}

#[derive(Debug)]
struct ScannedArchive {
    ordered: Vec<ScannedEntry>,
    by_name: HashMap<String, ScannedEntry>,
}

#[derive(Debug, Clone, Copy)]
struct PackageReadPlan {
    import_templates: bool,
}

fn build_package_read_plan(
    reader: PackageReader,
    manifest: &PackageManifest,
    scanned: &ScannedArchive,
    manifest_files: &HashMap<String, PackageFileEntry>,
) -> CoreResult<PackageReadPlan> {
    match reader {
        PackageReader::V1 => {
            for required in ["meta.json", "events.duckdb"] {
                if !scanned.by_name.contains_key(required) {
                    return Err(CoreError::Message(format!(
                        "package missing required file: {required}"
                    )));
                }
                if !manifest_files.contains_key(required) {
                    return Err(CoreError::Message(format!(
                        "package hash missing for required payload `{required}`"
                    )));
                }
            }

            let import_templates = scanned.by_name.contains_key("templates.json");
            if import_templates && !manifest_files.contains_key("templates.json") {
                return Err(CoreError::Message(
                    "package hash missing for required payload `templates.json`".into(),
                ));
            }

            // All v1 feature tags, including known tags, are advisory. The
            // hashed payload list and optional `stats` field are authoritative;
            // unknown tags therefore remain additive and cannot switch readers
            // or bypass shared validation.
            let _v1_advisory_features = &manifest.features;

            Ok(PackageReadPlan { import_templates })
        }
    }
}

fn import_corpus_zip_reader_with_limits<R: Read + Seek>(
    cache_root: &Path,
    mut reader: R,
    compressed_len: u64,
    limits: ImportLimits,
) -> CoreResult<ImportOutcome> {
    let reader_len = reader
        .seek(SeekFrom::End(0))
        .map_err(|e| CoreError::Message(format!("measure package stream: {e}")))?;
    if reader_len != compressed_len {
        return Err(CoreError::Policy(
            "declared package stream length does not match the reader".into(),
        ));
    }
    if reader_len > limits.compressed_bytes {
        return Err(CoreError::Policy(format!(
            "package exceeds compressed-byte limit ({})",
            limits.compressed_bytes
        )));
    }
    if limits.buffer_bytes == 0 {
        return Err(CoreError::Policy(
            "package import buffer must be non-zero".into(),
        ));
    }

    preflight_central_directory(&mut reader, reader_len, limits)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|e| CoreError::Message(format!("rewind package: {e}")))?;
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    let scanned = scan_archive(&mut archive, limits)?;
    let manifest_entry = scanned
        .by_name
        .get("manifest.json")
        .ok_or_else(|| CoreError::Message("package missing manifest.json".into()))?
        .clone();
    if manifest_entry.expanded_bytes > limits.manifest_bytes {
        return Err(CoreError::Policy("package manifest exceeds limit".into()));
    }

    let mut metrics = ImportMetrics::default();
    let manifest_bytes = {
        let mut file = archive
            .by_index(manifest_entry.index)
            .map_err(|e| CoreError::Message(format!("zip manifest entry: {e}")))?;
        read_capped_entry(
            &mut file,
            manifest_entry.expanded_bytes,
            limits.manifest_bytes,
            limits,
            &mut metrics,
        )?
    };
    // Unknown JSON fields remain additive-compatible.
    let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| CoreError::Message(format!("manifest parse: {e}")))?;

    // Format, kind, and engine gates happen before cache staging exists.
    let reader =
        resolve_package_reader_version(&manifest.format_version, manifest.min_reader_version)?;
    if manifest.package_kind != PACKAGE_KIND {
        return Err(CoreError::Message("unsupported package_kind".into()));
    }
    if manifest.engine != EVENT_ENGINE {
        return Err(CoreError::Message(format!(
            "unsupported package engine (want {EVENT_ENGINE})"
        )));
    }
    if manifest.files.len() > limits.entries {
        return Err(CoreError::Policy(
            "manifest lists too many payload entries".into(),
        ));
    }
    let manifest_files = validate_manifest_files(&manifest.files, &scanned)?;
    let read_plan = build_package_read_plan(reader, &manifest, &scanned, &manifest_files)?;

    let origin_id = manifest.corpus_id.clone();
    let new_id = Uuid::now_v7().to_string();
    let staging_id = format!(".import-{new_id}");
    let corpora_root = cache_root.join("log_corpora");
    let staging = corpora_root.join(&staging_id);
    let dest = corpora_root.join(&new_id);

    std::fs::create_dir_all(&corpora_root)
        .map_err(|e| CoreError::Message(format!("mkdir log_corpora: {e}")))?;
    std::fs::create_dir(&staging)
        .map_err(|e| CoreError::Message(format!("create import staging: {e}")))?;

    let result = (|| {
        stream_archive_entries(
            &mut archive,
            &scanned,
            &manifest_files,
            read_plan,
            &staging,
            limits,
            &mut metrics,
        )?;
        materialize_package_metadata(&staging, &manifest, &new_id, &origin_id, limits.meta_bytes)?;

        // Validate metadata, templates, and DuckDB while the corpus is still
        // hidden under the staging name. Drop the DB handle before rename for
        // Windows compatibility.
        let report = {
            let opened = LogCorpus::open(cache_root, &staging_id)?;
            let opened_meta = opened.meta()?;
            PackageImportReport {
                corpus_id: new_id.clone(),
                name: opened.name().to_string(),
                origin_corpus_id: origin_id.clone(),
                stats: opened_meta.stats,
            }
        };

        // Publication is the last fallible step. Never remove a pre-existing
        // destination if rename fails.
        std::fs::rename(&staging, &dest)
            .map_err(|e| CoreError::Message(format!("finalize import: {e}")))?;
        Ok(report)
    })();

    match result {
        Ok(report) => Ok(ImportOutcome { report, metrics }),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

fn preflight_central_directory<R: Read + Seek>(
    reader: &mut R,
    compressed_len: u64,
    limits: ImportLimits,
) -> CoreResult<()> {
    const EOCD_MIN_BYTES: usize = 22;
    const MAX_ZIP_COMMENT_BYTES: usize = u16::MAX as usize;
    const CENTRAL_HEADER_BYTES: usize = 46;
    const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";

    if compressed_len < EOCD_MIN_BYTES as u64 {
        return Err(CoreError::Message("zip open: missing end record".into()));
    }
    let tail_len = usize::try_from(compressed_len)
        .unwrap_or(usize::MAX)
        .min(EOCD_MIN_BYTES + MAX_ZIP_COMMENT_BYTES);
    reader
        .seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| CoreError::Message(format!("seek zip tail: {e}")))?;
    let mut tail = vec![0u8; tail_len];
    reader
        .read_exact(&mut tail)
        .map_err(|e| CoreError::Message(format!("read zip tail: {e}")))?;

    let eocd_in_tail = (0..=tail.len().saturating_sub(EOCD_SIGNATURE.len()))
        .rev()
        .find(|position| {
            let position = *position;
            if tail.get(position..position + 4) != Some(EOCD_SIGNATURE) {
                return false;
            }
            let Some(comment) = tail.get(position + 20..position + 22) else {
                return false;
            };
            let comment_len = u16::from_le_bytes([comment[0], comment[1]]) as usize;
            position + EOCD_MIN_BYTES + comment_len == tail.len()
        })
        .ok_or_else(|| CoreError::Message("zip open: missing end record".into()))?;
    if eocd_in_tail + EOCD_MIN_BYTES > tail.len() {
        return Err(CoreError::Message("zip open: truncated end record".into()));
    }
    let eocd = &tail[eocd_in_tail..];
    let disk = read_le_u16(eocd, 4)?;
    let central_disk = read_le_u16(eocd, 6)?;
    let entries_on_disk = read_le_u16(eocd, 8)?;
    let entries_total = read_le_u16(eocd, 10)?;
    let central_size = read_le_u32(eocd, 12)?;
    let central_offset = read_le_u32(eocd, 16)?;
    let comment_len = read_le_u16(eocd, 20)? as usize;
    if disk != 0 || central_disk != 0 || entries_on_disk != entries_total {
        return Err(CoreError::Policy(
            "multi-disk package archives are not supported".into(),
        ));
    }
    if entries_total == u16::MAX || central_size == u32::MAX || central_offset == u32::MAX {
        return Err(CoreError::Policy(
            "Zip64 package metadata is not supported under Phase A limits".into(),
        ));
    }
    if entries_total as usize > limits.entries {
        return Err(CoreError::Policy("package has too many entries".into()));
    }
    if eocd_in_tail + EOCD_MIN_BYTES + comment_len != tail.len() {
        return Err(CoreError::Policy(
            "package has an ambiguous end record or trailing bytes".into(),
        ));
    }
    let central_end = (central_offset as u64)
        .checked_add(central_size as u64)
        .ok_or_else(|| CoreError::Policy("central directory offset overflow".into()))?;
    let absolute_eocd = compressed_len - tail_len as u64 + eocd_in_tail as u64;
    if central_end != absolute_eocd {
        return Err(CoreError::Policy(
            "central directory boundaries are inconsistent".into(),
        ));
    }

    reader
        .seek(SeekFrom::Start(central_offset as u64))
        .map_err(|e| CoreError::Message(format!("seek central directory: {e}")))?;
    let mut names = HashSet::with_capacity(entries_total as usize);
    for _ in 0..entries_total {
        let mut header = [0u8; CENTRAL_HEADER_BYTES];
        reader
            .read_exact(&mut header)
            .map_err(|e| CoreError::Message(format!("read central directory: {e}")))?;
        if &header[..4] != CENTRAL_SIGNATURE {
            return Err(CoreError::Policy(
                "central directory entry signature is invalid".into(),
            ));
        }
        let name_len = read_le_u16(&header, 28)? as usize;
        let extra_len = read_le_u16(&header, 30)? as u64;
        let entry_comment_len = read_le_u16(&header, 32)? as u64;
        if name_len == 0 || name_len > MAX_ENTRY_NAME_BYTES {
            return Err(CoreError::Policy(
                "package entry name exceeds policy limit".into(),
            ));
        }
        let mut name_bytes = vec![0u8; name_len];
        reader
            .read_exact(&mut name_bytes)
            .map_err(|e| CoreError::Message(format!("read package entry name: {e}")))?;
        let name = std::str::from_utf8(&name_bytes)
            .map_err(|_| CoreError::Policy("package entry name is not valid UTF-8".into()))?;
        validate_flat_entry_name(name)?;
        if !names.insert(name_bytes) {
            return Err(CoreError::Policy(
                "package contains duplicate entry names".into(),
            ));
        }
        let skip = extra_len
            .checked_add(entry_comment_len)
            .ok_or_else(|| CoreError::Policy("central directory field overflow".into()))?;
        reader
            .seek(SeekFrom::Current(i64::try_from(skip).map_err(|_| {
                CoreError::Policy("central directory field exceeds seek range".into())
            })?))
            .map_err(|e| CoreError::Message(format!("seek central directory entry: {e}")))?;
    }
    let final_position = reader
        .stream_position()
        .map_err(|e| CoreError::Message(format!("read central directory position: {e}")))?;
    if final_position != central_end {
        return Err(CoreError::Policy(
            "central directory entry lengths are inconsistent".into(),
        ));
    }
    Ok(())
}

fn read_le_u16(bytes: &[u8], offset: usize) -> CoreResult<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| CoreError::Message("zip metadata is truncated".into()))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_le_u32(bytes: &[u8], offset: usize) -> CoreResult<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| CoreError::Message("zip metadata is truncated".into()))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn scan_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    limits: ImportLimits,
) -> CoreResult<ScannedArchive> {
    if archive.len() > limits.entries {
        return Err(CoreError::Policy("package has too many entries".into()));
    }
    let mut ordered = Vec::with_capacity(archive.len());
    let mut by_name = HashMap::with_capacity(archive.len());
    let mut declared_total = 0u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| CoreError::Message(format!("zip entry metadata: {e}")))?;
        let name = std::str::from_utf8(file.name_raw())
            .map_err(|_| CoreError::Policy("package entry name is not valid UTF-8".into()))?
            .to_string();
        validate_flat_entry_name(&name)?;
        if file.is_dir() {
            return Err(CoreError::Policy(
                "package directory entries are not allowed".into(),
            ));
        }
        let expanded_bytes = file.size();
        if expanded_bytes > limits.entry_expanded_bytes {
            return Err(CoreError::Policy(
                "package entry exceeds expanded-byte limit".into(),
            ));
        }
        declared_total = declared_total
            .checked_add(expanded_bytes)
            .ok_or_else(|| CoreError::Policy("package expanded-byte total overflow".into()))?;
        if declared_total > limits.total_expanded_bytes {
            return Err(CoreError::Policy(
                "package exceeds aggregate expanded-byte limit".into(),
            ));
        }
        let entry = ScannedEntry {
            index,
            name: name.clone(),
            expanded_bytes,
        };
        if by_name.insert(name, entry.clone()).is_some() {
            return Err(CoreError::Policy(
                "package contains duplicate entry names".into(),
            ));
        }
        ordered.push(entry);
    }
    Ok(ScannedArchive { ordered, by_name })
}

fn validate_flat_entry_name(name: &str) -> CoreResult<()> {
    let drive_prefix = name.as_bytes().get(1) == Some(&b':')
        && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    let one_normal_component = {
        let mut components = Path::new(name).components();
        matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none()
    };
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with(['/', '\\'])
        || name.contains(['/', '\\'])
        || drive_prefix
        || name.chars().any(char::is_control)
        || !one_normal_component
    {
        return Err(CoreError::Policy(
            "package entry path is absolute, traversing, or ambiguous".into(),
        ));
    }
    Ok(())
}

fn validate_manifest_files(
    files: &[PackageFileEntry],
    scanned: &ScannedArchive,
) -> CoreResult<HashMap<String, PackageFileEntry>> {
    let mut out = HashMap::with_capacity(files.len());
    for entry in files {
        validate_flat_entry_name(&entry.path)?;
        if entry.path == "manifest.json" {
            return Err(CoreError::Policy(
                "manifest.json must not list itself as a payload".into(),
            ));
        }
        if out.insert(entry.path.clone(), entry.clone()).is_some() {
            return Err(CoreError::Policy(
                "manifest contains duplicate payload entries".into(),
            ));
        }
        let scanned_entry = scanned
            .by_name
            .get(&entry.path)
            .ok_or_else(|| CoreError::Message("manifest lists a missing payload".into()))?;
        if entry.bytes != scanned_entry.expanded_bytes {
            return Err(CoreError::Policy(
                "manifest payload byte count does not match zip metadata".into(),
            ));
        }
        if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CoreError::Policy(
                "manifest payload has invalid SHA-256 metadata".into(),
            ));
        }
    }
    Ok(out)
}

fn read_capped_entry(
    reader: &mut impl Read,
    expected_bytes: u64,
    cap: u64,
    limits: ImportLimits,
    metrics: &mut ImportMetrics,
) -> CoreResult<Vec<u8>> {
    if expected_bytes > cap {
        return Err(CoreError::Policy(
            "package entry exceeds explicit cap".into(),
        ));
    }
    let capacity = usize::try_from(expected_bytes)
        .unwrap_or(usize::MAX)
        .min(usize::try_from(cap).unwrap_or(usize::MAX));
    let mut out = Vec::with_capacity(capacity);
    let mut buffer = vec![0u8; limits.buffer_bytes];
    let mut actual = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| CoreError::Message(format!("zip read: {e}")))?;
        if read == 0 {
            break;
        }
        metrics.max_transfer_chunk = metrics.max_transfer_chunk.max(read);
        actual = account_expanded_bytes(actual, read, cap)?;
        metrics.actual_expanded_bytes = account_expanded_bytes(
            metrics.actual_expanded_bytes,
            read,
            limits.total_expanded_bytes,
        )?;
        out.extend_from_slice(&buffer[..read]);
    }
    if actual != expected_bytes {
        return Err(CoreError::Policy(
            "package entry expanded size differs from zip metadata".into(),
        ));
    }
    Ok(out)
}

fn stream_archive_entries<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    scanned: &ScannedArchive,
    manifest_files: &HashMap<String, PackageFileEntry>,
    read_plan: PackageReadPlan,
    staging: &Path,
    limits: ImportLimits,
    metrics: &mut ImportMetrics,
) -> CoreResult<()> {
    let mut processed_manifest_payloads = HashSet::new();
    for entry in &scanned.ordered {
        if entry.name == "manifest.json" {
            continue;
        }
        let mut source = archive
            .by_index(entry.index)
            .map_err(|e| CoreError::Message(format!("zip payload entry: {e}")))?;
        let manifest_entry = manifest_files.get(&entry.name);
        let mut hasher = Sha256::new();
        let mut target: Box<dyn Write> = match entry.name.as_str() {
            "meta.json" => Box::new(
                std::fs::File::create(staging.join("meta.package.json"))
                    .map_err(|e| CoreError::Message(format!("create metadata staging: {e}")))?,
            ),
            "events.duckdb" => Box::new(
                std::fs::File::create(staging.join("events.duckdb"))
                    .map_err(|e| CoreError::Message(format!("create event staging: {e}")))?,
            ),
            "templates.json" if read_plan.import_templates => Box::new(
                std::fs::File::create(staging.join("templates.json"))
                    .map_err(|e| CoreError::Message(format!("create template staging: {e}")))?,
            ),
            _ => Box::new(std::io::sink()),
        };
        let mut buffer = vec![0u8; limits.buffer_bytes];
        let mut actual = 0u64;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|e| CoreError::Message(format!("zip payload read: {e}")))?;
            if read == 0 {
                break;
            }
            metrics.max_transfer_chunk = metrics.max_transfer_chunk.max(read);
            actual = account_expanded_bytes(actual, read, limits.entry_expanded_bytes)?;
            metrics.actual_expanded_bytes = account_expanded_bytes(
                metrics.actual_expanded_bytes,
                read,
                limits.total_expanded_bytes,
            )?;
            hasher.update(&buffer[..read]);
            target
                .write_all(&buffer[..read])
                .map_err(|e| CoreError::Message(format!("write import staging: {e}")))?;
        }
        if actual != entry.expanded_bytes {
            return Err(CoreError::Policy(
                "package entry expanded size differs from zip metadata".into(),
            ));
        }
        if let Some(expected) = manifest_entry {
            if actual != expected.bytes {
                return Err(CoreError::Policy(
                    "manifest payload byte count differs from expanded data".into(),
                ));
            }
            let digest = format!("{:x}", hasher.finalize());
            if !digest.eq_ignore_ascii_case(&expected.sha256) {
                return Err(CoreError::Message("package payload hash mismatch".into()));
            }
            processed_manifest_payloads.insert(entry.name.clone());
        }
    }
    if processed_manifest_payloads.len() != manifest_files.len() {
        return Err(CoreError::Message(
            "not every manifest payload was validated".into(),
        ));
    }
    if !read_plan.import_templates {
        std::fs::write(staging.join("templates.json"), b"[]")
            .map_err(|e| CoreError::Message(format!("write templates: {e}")))?;
    }
    Ok(())
}

fn account_expanded_bytes(current: u64, added: usize, limit: u64) -> CoreResult<u64> {
    let next = current
        .checked_add(added as u64)
        .ok_or_else(|| CoreError::Policy("package expanded-byte counter overflow".into()))?;
    if next > limit {
        return Err(CoreError::Policy(
            "package exceeds expanded-byte limit during transfer".into(),
        ));
    }
    Ok(next)
}

fn materialize_package_metadata(
    dest: &Path,
    manifest: &PackageManifest,
    new_id: &str,
    origin_id: &str,
    meta_cap: u64,
) -> CoreResult<()> {
    let meta_path = dest.join("meta.package.json");
    let meta_len = std::fs::metadata(&meta_path)
        .map_err(|e| CoreError::Message(format!("metadata stat: {e}")))?
        .len();
    if meta_len > meta_cap {
        return Err(CoreError::Policy(
            "package metadata exceeds explicit cap".into(),
        ));
    }
    let meta_raw = std::fs::read(&meta_path)
        .map_err(|e| CoreError::Message(format!("read metadata staging: {e}")))?;
    let value: serde_json::Value = serde_json::from_slice(&meta_raw)
        .map_err(|e| CoreError::Message(format!("metadata parse: {e}")))?;
    if !value.is_object() {
        return Err(CoreError::Message(
            "package metadata must be a JSON object".into(),
        ));
    }
    let mut meta: CorpusMeta = match serde_json::from_value(value.clone()) {
        Ok(m) => m,
        Err(_) => legacy_corpus_meta(&value, manifest, new_id, origin_id),
    };
    meta.meta_version = META_VERSION;
    meta.id = new_id.to_string();
    meta.origin_corpus_id = Some(origin_id.to_string());
    meta.source_label = Some(format!("import:{origin_id}"));
    if meta.name.trim().is_empty() {
        meta.name = manifest.name.clone();
    }
    meta.engine = EVENT_ENGINE.into();
    if meta.stats.is_none() {
        meta.stats = manifest.stats.clone();
    }
    std::fs::remove_file(&meta_path)
        .map_err(|e| CoreError::Message(format!("remove metadata staging: {e}")))?;
    let stats_bytes = dir_size(dest);
    if let Some(ref mut stats) = meta.stats {
        stats.corpus_bytes = stats_bytes;
    }
    write_meta_file(dest, &meta)?;
    Ok(())
}

fn legacy_corpus_meta(
    value: &serde_json::Value,
    manifest: &PackageManifest,
    new_id: &str,
    origin_id: &str,
) -> CorpusMeta {
    let get_string = |camel: &str, snake: &str| {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    CorpusMeta {
        meta_version: value
            .get("metaVersion")
            .or_else(|| value.get("meta_version"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1) as u32,
        id: {
            let id = get_string("id", "id");
            if id.is_empty() {
                new_id.to_string()
            } else {
                id
            }
        },
        name: {
            let name = get_string("name", "name");
            if name.is_empty() {
                manifest.name.clone()
            } else {
                name
            }
        },
        created_at: value
            .get("createdAt")
            .or_else(|| value.get("created_at"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_else(crate::embed::now_unix_secs),
        engine: EVENT_ENGINE.into(),
        license: get_string("license", "license"),
        vector_index: get_string("vectorIndex", "vector_index"),
        source_label: Some(format!("import:{origin_id}")),
        origin_corpus_id: Some(origin_id.to_string()),
        stats: manifest.stats.clone(),
        top_templates: Vec::new(),
    }
}

#[cfg(test)]
fn test_limits(
    compressed_bytes: u64,
    total_expanded_bytes: u64,
    entry_expanded_bytes: u64,
    manifest_bytes: u64,
    meta_bytes: u64,
    buffer_bytes: usize,
) -> ImportLimits {
    ImportLimits {
        compressed_bytes,
        entries: MAX_PACKAGE_ENTRIES,
        total_expanded_bytes,
        entry_expanded_bytes,
        manifest_bytes,
        meta_bytes,
        buffer_bytes,
    }
}

/// Import package from a filesystem path.
pub fn import_corpus_zip_path(
    cache_root: &Path,
    zip_path: &Path,
) -> CoreResult<PackageImportReport> {
    // Stat first so an over-limit file is rejected before it can be read or
    // copied into memory.
    let compressed_len = std::fs::metadata(zip_path)
        .map_err(|e| CoreError::Message(format!("stat package: {e}")))?
        .len();
    if compressed_len > MAX_PACKAGE_BYTES {
        return Err(CoreError::Policy(format!(
            "package exceeds compressed-byte limit ({MAX_PACKAGE_BYTES})"
        )));
    }
    let file = std::fs::File::open(zip_path)
        .map_err(|e| CoreError::Message(format!("open package: {e}")))?;
    import_corpus_zip_reader(cache_root, file, compressed_len)
}

fn hex_sha256(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// Build a zip from raw entries (tests / fixtures).
#[cfg(test)]
fn zip_from_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Cursor;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::io::Write;

    fn seed_corpus(dir: &Path) -> (std::path::PathBuf, String) {
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..50 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused {}"}}"#,
                1_700_000_000 + i,
                i % 5
            )
            .unwrap();
        }
        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report =
            crate::log_analysis::ingest_path(&cache, &logs, "round", None, "none").unwrap();
        (cache, report.corpus_id)
    }

    fn zip_from_owned(
        entries: &[(String, Vec<u8>)],
        compression: zip::CompressionMethod,
    ) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default().compression_method(compression);
            for (name, data) in entries {
                writer.start_file(name, opts).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        buf.into_inner()
    }

    #[derive(Debug, Clone, Copy)]
    enum FrozenV1Fixture {
        Minimal,
        Full,
        UnknownFields,
    }

    /// Build the historical v1 fixture from fixed v1-era SQL and JSON literals.
    ///
    /// This intentionally does not call `export_corpus_zip`, `LogCorpus::create`,
    /// ingest, current metadata serialization, or current schema initialization.
    /// A future writer/schema change therefore cannot silently regenerate these
    /// compatibility expectations; changing them requires an explicit edit here.
    fn frozen_v1_package(dir: &Path, fixture: FrozenV1Fixture) -> Vec<u8> {
        let db_path = dir.join(format!("frozen-v1-{fixture:?}.duckdb"));
        let connection = duckdb::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE events (
                    seq BIGINT NOT NULL,
                    ts BIGINT NOT NULL,
                    level VARCHAR NOT NULL,
                    service VARCHAR,
                    host VARCHAR,
                    template_id BIGINT NOT NULL,
                    params VARCHAR NOT NULL,
                    trace_id VARCHAR,
                    message VARCHAR NOT NULL,
                    source VARCHAR NOT NULL
                );
                "#,
            )
            .unwrap();
        if !matches!(fixture, FrozenV1Fixture::Minimal) {
            connection
                .execute_batch(
                    r#"
                    INSERT INTO events VALUES (
                        1, 1700000000, 'error', 'api', 'node-1', 1, '[]',
                        'trace-frozen-v1', 'connection refused by frozen upstream',
                        'historical.log'
                    );
                    CHECKPOINT;
                    "#,
                )
                .unwrap();
        }
        drop(connection);
        let events = std::fs::read(&db_path).unwrap();

        let meta = match fixture {
            FrozenV1Fixture::Minimal => br#"{
                "id":"frozen-v1-minimal",
                "name":"Frozen v1 minimal",
                "created_at":1700000000,
                "engine":"duckdb"
            }"#
            .to_vec(),
            FrozenV1Fixture::Full => br#"{
                "id":"frozen-v1-full",
                "name":"Frozen v1 full",
                "created_at":1700000000,
                "engine":"duckdb",
                "license":"MIT",
                "vector_index":"exact"
            }"#
            .to_vec(),
            FrozenV1Fixture::UnknownFields => br#"{
                "id":"frozen-v1-unknown",
                "name":"Frozen v1 unknown fields",
                "created_at":1700000000,
                "engine":"duckdb",
                "future_meta_object":{"enabled":true}
            }"#
            .to_vec(),
        };
        let templates = (!matches!(fixture, FrozenV1Fixture::Minimal)).then(|| {
            br#"[{
                "info":{
                    "template_id":1,
                    "pattern":"connection refused by frozen upstream",
                    "token_count":5,
                    "count":1,
                    "first_seen":1700000000,
                    "last_seen":1700000000,
                    "severity":5,
                    "example":"connection refused by frozen upstream"
                },
                "content_hash":"frozen-v1-template-hash",
                "vector":[0.25,0.5,0.75]
            }]"#
            .to_vec()
        });

        let mut files = vec![
            serde_json::json!({
                "path": "meta.json",
                "sha256": hex_sha256(&meta),
                "bytes": meta.len(),
            }),
            serde_json::json!({
                "path": "events.duckdb",
                "sha256": hex_sha256(&events),
                "bytes": events.len(),
            }),
        ];
        if let Some(templates) = &templates {
            files.push(serde_json::json!({
                "path": "templates.json",
                "sha256": hex_sha256(templates),
                "bytes": templates.len(),
            }));
        }

        let mut manifest = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v1",
            "minReaderVersion": 1,
            "packageKind": "log_corpus",
            "createdAt": 1700000000,
            "corpusId": match fixture {
                FrozenV1Fixture::Minimal => "frozen-v1-minimal",
                FrozenV1Fixture::Full => "frozen-v1-full",
                FrozenV1Fixture::UnknownFields => "frozen-v1-unknown",
            },
            "name": match fixture {
                FrozenV1Fixture::Minimal => "Frozen v1 minimal",
                FrozenV1Fixture::Full => "Frozen v1 full",
                FrozenV1Fixture::UnknownFields => "Frozen v1 unknown fields",
            },
            "engine": "duckdb",
            "files": files,
        });
        if !matches!(fixture, FrozenV1Fixture::Minimal) {
            manifest["features"] = serde_json::json!([
                "events_duckdb",
                "templates_json",
                "template_vectors",
                "corpus_stats"
            ]);
            manifest["stats"] = serde_json::json!({
                "files": 1,
                "lines": 1,
                "templates": 1,
                "reductionRatio": 1.0,
                "embedded": 1,
                "sourceBytes": 48,
                "corpusBytes": 0,
                "levelCounts": {"error": 1},
                "tsMin": 1700000000,
                "tsMax": 1700000000,
                "formatCounts": {"plain": 1}
            });
        }
        if matches!(fixture, FrozenV1Fixture::UnknownFields) {
            manifest["futureOptionalField"] = serde_json::json!({"nested": ["still", "accepted"]});
            manifest["features"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("future_optional_payload_semantics"));
        }

        let mut entries = vec![
            (
                "manifest.json".to_string(),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            ),
            ("meta.json".to_string(), meta),
            ("events.duckdb".to_string(), events),
        ];
        if let Some(templates) = templates {
            entries.push(("templates.json".to_string(), templates));
        }
        zip_from_owned(&entries, zip::CompressionMethod::Deflated)
    }

    fn replace_all_same_len(mut bytes: Vec<u8>, from: &[u8], to: &[u8]) -> Vec<u8> {
        assert_eq!(from.len(), to.len());
        let mut replaced = 0;
        let mut offset = 0;
        while let Some(relative) = bytes[offset..]
            .windows(from.len())
            .position(|window| window == from)
        {
            let start = offset + relative;
            bytes[start..start + from.len()].copy_from_slice(to);
            offset = start + to.len();
            replaced += 1;
        }
        assert!(replaced >= 2, "expected local and central filename records");
        bytes
    }

    fn valid_package(
        meta: &[u8],
        events: &[u8],
        templates: Option<&[u8]>,
        extra_entries: &[(&str, &[u8])],
    ) -> Vec<u8> {
        let mut files = vec![
            serde_json::json!({
                "path": "meta.json",
                "sha256": hex_sha256(meta),
                "bytes": meta.len(),
            }),
            serde_json::json!({
                "path": "events.duckdb",
                "sha256": hex_sha256(events),
                "bytes": events.len(),
            }),
        ];
        if let Some(data) = templates {
            files.push(serde_json::json!({
                "path": "templates.json",
                "sha256": hex_sha256(data),
                "bytes": data.len(),
            }));
        }
        let manifest = serde_json::to_vec(&serde_json::json!({
            "formatVersion": PACKAGE_FORMAT_VERSION,
            "minReaderVersion": PACKAGE_READER_VERSION,
            "packageKind": PACKAGE_KIND,
            "createdAt": 1,
            "corpusId": "origin-id",
            "name": "fixture",
            "engine": EVENT_ENGINE,
            "files": files,
        }))
        .unwrap();
        let mut entries = vec![
            ("manifest.json".to_string(), manifest),
            ("meta.json".to_string(), meta.to_vec()),
            ("events.duckdb".to_string(), events.to_vec()),
        ];
        if let Some(data) = templates {
            entries.push(("templates.json".to_string(), data.to_vec()));
        }
        entries.extend(
            extra_entries
                .iter()
                .map(|(name, data)| ((*name).to_string(), (*data).to_vec())),
        );
        zip_from_owned(&entries, zip::CompressionMethod::Deflated)
    }

    fn cache_entries(cache: &Path) -> BTreeSet<String> {
        let root = cache.join("log_corpora");
        let Ok(read_dir) = std::fs::read_dir(root) else {
            return BTreeSet::new();
        };
        read_dir
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn scan_with_limits(
        bytes: &[u8],
        total_expanded_bytes: u64,
        entry_expanded_bytes: u64,
    ) -> CoreResult<ScannedArchive> {
        let limits = test_limits(
            bytes.len() as u64,
            total_expanded_bytes,
            entry_expanded_bytes,
            MAX_MANIFEST_BYTES,
            MAX_META_BYTES,
            8,
        );
        let mut cursor = std::io::Cursor::new(bytes);
        preflight_central_directory(&mut cursor, bytes.len() as u64, limits)?;
        cursor.set_position(0);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        scan_archive(&mut archive, limits)
    }

    #[test]
    fn exact_reader_registry_rejects_malformed_v1_lookalikes() {
        assert_eq!(PACKAGE_READERS, &[PackageReader::V1]);
        assert_eq!(
            resolve_package_reader("contextdesk.log_corpus.v1").unwrap(),
            PackageReader::V1
        );
        for malformed in [
            "contextdesk.log_corpus.v01",
            "contextdesk.log_corpus.v1.extra",
            "contextdesk.log_corpus.v1 ",
            "contextdesk.log_corpus.v1/../v2",
            "CONTEXTDESK.log_corpus.v1",
            "contextdesk.log-corpus.v1",
        ] {
            let error = resolve_package_reader(malformed).unwrap_err();
            assert!(
                error.to_string().contains("accepts exactly"),
                "{malformed}: {error}"
            );
        }
        let too_new = resolve_package_reader("contextdesk.log_corpus.v2").unwrap_err();
        assert!(too_new.to_string().contains("upgrade ContextDesk"));
    }

    #[test]
    fn frozen_v1_minimal_imports_without_current_exporter() {
        let dir = tempfile::tempdir().unwrap();
        let package = frozen_v1_package(dir.path(), FrozenV1Fixture::Minimal);
        let cache = dir.path().join("cache");

        let report = import_corpus_zip(&cache, &package).unwrap();
        assert_eq!(report.origin_corpus_id, "frozen-v1-minimal");
        assert!(report.stats.is_none());

        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(corpus.name(), "Frozen v1 minimal");
        assert_eq!(corpus.event_count(), 0);
        assert_eq!(corpus.template_count(), 0);
        let meta = corpus.meta().unwrap();
        assert_eq!(meta.meta_version, META_VERSION);
        assert_eq!(meta.origin_corpus_id.as_deref(), Some("frozen-v1-minimal"));
    }

    #[test]
    fn frozen_v1_full_imports_and_searches_without_current_exporter() {
        let dir = tempfile::tempdir().unwrap();
        let package = frozen_v1_package(dir.path(), FrozenV1Fixture::Full);
        let cache = dir.path().join("cache");

        let report = import_corpus_zip(&cache, &package).unwrap();
        let stats = report.stats.as_ref().expect("frozen stats must survive");
        assert_eq!(stats.lines, 1);
        assert_eq!(stats.embedded, 1);

        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(corpus.event_count(), 1);
        assert_eq!(corpus.template_count(), 1);
        assert_eq!(
            corpus.list_templates()[0].vector.as_deref(),
            Some([0.25, 0.5, 0.75].as_slice())
        );
        let hits = crate::log_analysis::search_logs(
            &corpus,
            &crate::log_analysis::SearchLogsQuery {
                query: Some("connection refused".into()),
                k: 10,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].template_id, 1);
        assert!(hits[0].pattern.contains("frozen upstream"));
    }

    #[test]
    fn frozen_v1_unknown_optional_fields_and_features_import() {
        let dir = tempfile::tempdir().unwrap();
        let package = frozen_v1_package(dir.path(), FrozenV1Fixture::UnknownFields);
        let cache = dir.path().join("cache");

        let report = import_corpus_zip(&cache, &package).unwrap();
        assert_eq!(report.origin_corpus_id, "frozen-v1-unknown");
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(corpus.event_count(), 1);
        assert_eq!(corpus.template_count(), 1);
    }

    #[test]
    fn shared_archive_validation_precedes_reader_dispatch() {
        let manifest = serde_json::to_vec(&serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v99",
            "minReaderVersion": 99,
            "packageKind": PACKAGE_KIND,
            "createdAt": 1,
            "corpusId": "too-new",
            "name": "too-new",
            "engine": EVENT_ENGINE,
            "files": [],
        }))
        .unwrap();
        let package = zip_from_owned(
            &[
                ("manifest.json".into(), manifest),
                ("../must-fail-before-dispatch".into(), vec![b'x']),
            ],
            zip::CompressionMethod::Stored,
        );
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");

        let error = import_corpus_zip(&cache, &package).unwrap_err();
        assert!(
            error.to_string().contains("traversing") || error.to_string().contains("ambiguous"),
            "{error}"
        );
        assert!(!error.to_string().contains("v99"), "{error}");
        assert!(cache_entries(&cache).is_empty());
    }

    #[test]
    fn export_import_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.cdlog.zip");
        let man = export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        assert_eq!(man.format_version, PACKAGE_FORMAT_VERSION);
        assert_eq!(man.min_reader_version, PACKAGE_READER_VERSION);
        assert!(out.is_file());

        let cache2 = dir.path().join("cache2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip_path(&cache2, &out).unwrap();
        assert_ne!(imp.corpus_id, corpus_id);
        assert_eq!(imp.origin_corpus_id, corpus_id);
        let c = LogCorpus::open(&cache2, &imp.corpus_id).unwrap();
        assert!(c.event_count() >= 50);
        assert!(c.template_count() > 0);
        let meta = c.meta().unwrap();
        assert_eq!(meta.origin_corpus_id.as_deref(), Some(corpus_id.as_str()));
        assert!(meta.stats.is_some());
        assert!(meta.stats.as_ref().unwrap().reduction_ratio > 1.0);
    }

    #[test]
    fn unknown_manifest_fields_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        // Re-pack with extra JSON field in manifest.
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        man.as_object_mut()
            .unwrap()
            .insert("futureOptionalField".into(), serde_json::json!(42));
        man.as_object_mut()
            .unwrap()
            .insert("features".into(), serde_json::json!(["x", "y"]));
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip(&cache2, &zipped).unwrap();
        assert!(LogCorpus::open(&cache2, &imp.corpus_id).is_ok());
    }

    #[test]
    fn empty_files_array_refuses_required_payloads_without_hash() {
        // Real payloads in zip but manifest.files omits them → fail closed (no silent skip).
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(cache.join("log_corpora")).unwrap();
        let man = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v1",
            "minReaderVersion": 1,
            "packageKind": "log_corpus",
            "createdAt": 1,
            "corpusId": "x",
            "name": "n",
            "engine": "duckdb",
            "files": []
        });
        let zipped = zip_from_entries(&[
            (
                "manifest.json",
                serde_json::to_vec(&man).unwrap().as_slice(),
            ),
            (
                "meta.json",
                br#"{"id":"x","name":"n","created_at":1,"engine":"duckdb"}"#,
            ),
            ("events.duckdb", b"fake-db-bytes"),
        ]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        let s = format!("{err}");
        assert!(
            s.contains("hash missing") || s.contains("SHA-256") || s.contains("meta.json"),
            "{s}"
        );
        let orphans: Vec<_> = std::fs::read_dir(cache.join("log_corpora"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(orphans.is_empty(), "orphans: {orphans:?}");
    }

    #[test]
    fn too_new_format_refused_without_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(cache.join("log_corpora")).unwrap();
        let man = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v99",
            "minReaderVersion": 1,
            "packageKind": "log_corpus",
            "createdAt": 1,
            "corpusId": "x",
            "name": "n",
            "engine": "duckdb",
            "files": []
        });
        let zipped = zip_from_entries(&[
            (
                "manifest.json",
                serde_json::to_vec(&man).unwrap().as_slice(),
            ),
            ("meta.json", b"{}"),
            ("events.duckdb", b"not-a-real-db"),
        ]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        let s = format!("{err}");
        assert!(
            s.contains("v99") || s.contains("requires") || s.contains("unsupported"),
            "{s}"
        );
        // No orphan corpus dirs (only empty log_corpora ok).
        let entries: Vec<_> = std::fs::read_dir(cache.join("log_corpora"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(entries.is_empty(), "orphans: {entries:?}");
    }

    #[test]
    fn too_new_min_reader_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let man = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v1",
            "minReaderVersion": 9999,
            "packageKind": "log_corpus",
            "createdAt": 1,
            "corpusId": "x",
            "name": "n",
            "engine": "duckdb",
            "files": []
        });
        let zipped = zip_from_entries(&[
            (
                "manifest.json",
                serde_json::to_vec(&man).unwrap().as_slice(),
            ),
            ("meta.json", b"{}"),
            ("events.duckdb", b"x"),
        ]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        assert!(
            format!("{err}").contains("9999") || format!("{err}").contains("reader"),
            "{err}"
        );
    }

    #[test]
    fn corrupt_hash_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        if let Some(files) = man.get_mut("files").and_then(|f| f.as_array_mut()) {
            if let Some(first) = files.first_mut() {
                first
                    .as_object_mut()
                    .unwrap()
                    .insert("sha256".into(), serde_json::json!("d".repeat(64)));
            }
        }
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(cache2.join("log_corpora")).unwrap();
        let err = import_corpus_zip(&cache2, &zipped).unwrap_err();
        assert!(format!("{err}").contains("hash"), "{err}");
        let orphans: Vec<_> = std::fs::read_dir(cache2.join("log_corpora"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(orphans.is_empty());
    }

    #[test]
    fn zip_slip_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("c");
        std::fs::create_dir_all(&cache).unwrap();
        let zipped = zip_from_entries(&[("../evil.txt", b"nope")]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        let s = format!("{err}").to_lowercase();
        assert!(
            s.contains("absolute")
                || s.contains("travers")
                || s.contains("ambiguous")
                || s.contains("policy"),
            "{err}"
        );
    }

    #[test]
    fn stripped_optional_min_reader_defaults_and_imports() {
        // Manifest without minReaderVersion must default and import.
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        man.as_object_mut().unwrap().remove("minReaderVersion");
        man.as_object_mut().unwrap().remove("features");
        man.as_object_mut().unwrap().remove("stats");
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip(&cache2, &zipped).unwrap();
        assert!(LogCorpus::open(&cache2, &imp.corpus_id).is_ok());
    }

    #[test]
    fn filesystem_compressed_limit_is_checked_before_zip_open() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let package = dir.path().join("sparse.cdlog.zip");
        let file = std::fs::File::create(&package).unwrap();
        file.set_len(MAX_PACKAGE_BYTES + 1).unwrap();
        drop(file);

        let before = cache_entries(&cache);
        let err = import_corpus_zip_path(&cache, &package).unwrap_err();
        assert!(err.to_string().contains("compressed-byte"), "{err}");
        assert_eq!(cache_entries(&cache), before);

        let small = zip_from_entries(&[("manifest.json", b"{}")]);
        let err =
            import_corpus_zip_reader(&cache, std::io::Cursor::new(&small), small.len() as u64 - 1)
                .unwrap_err();
        assert!(err.to_string().contains("stream length"), "{err}");
        assert_eq!(cache_entries(&cache), before);
    }

    #[test]
    fn compression_expansion_and_unknown_entries_obey_aggregate_limit() {
        let repeated = vec![b'x'; 16 * 1024];
        let manifest = serde_json::to_vec(&serde_json::json!({
            "formatVersion": PACKAGE_FORMAT_VERSION,
            "minReaderVersion": 1,
            "packageKind": PACKAGE_KIND,
            "createdAt": 1,
            "corpusId": "origin",
            "name": "bomb",
            "engine": EVENT_ENGINE,
            "files": [],
        }))
        .unwrap();
        let zipped = zip_from_owned(
            &[
                ("manifest.json".into(), manifest),
                ("future.bin".into(), repeated),
            ],
            zip::CompressionMethod::Deflated,
        );
        assert!(zipped.len() < 2_000, "fixture should remain compressed");
        let err = scan_with_limits(&zipped, 8 * 1024, 32 * 1024).unwrap_err();
        assert!(err.to_string().contains("aggregate"), "{err}");
    }

    #[test]
    fn per_entry_and_aggregate_boundaries_are_exact() {
        for (size, should_pass) in [(31usize, true), (32, true), (33, false)] {
            let zipped = zip_from_entries(&[("future.bin", &vec![0u8; size])]);
            let result = scan_with_limits(&zipped, 1_024, 32);
            assert_eq!(result.is_ok(), should_pass, "entry size {size}");
        }

        for (second_size, should_pass) in [(31usize, true), (32, true), (33, false)] {
            let first = vec![0u8; 32];
            let second = vec![0u8; second_size];
            let zipped = zip_from_entries(&[
                ("one.bin", first.as_slice()),
                ("two.bin", second.as_slice()),
            ]);
            let result = scan_with_limits(&zipped, 64, 64);
            assert_eq!(
                result.is_ok(),
                should_pass,
                "aggregate size {}",
                32 + second_size
            );
        }
    }

    #[test]
    fn duplicate_zip_and_manifest_payload_entries_are_rejected() {
        let duplicate_manifest =
            zip_from_entries(&[("manifest0json", b"{}"), ("manifest1json", b"{}")]);
        let duplicate_manifest =
            replace_all_same_len(duplicate_manifest, b"manifest0json", b"manifest.json");
        let duplicate_manifest =
            replace_all_same_len(duplicate_manifest, b"manifest1json", b"manifest.json");
        let err = scan_with_limits(&duplicate_manifest, 1_024, 1_024).unwrap_err();
        assert!(err.to_string().contains("duplicate"), "{err}");

        let duplicate_required =
            zip_from_entries(&[("events0duckdb", b"a"), ("events1duckdb", b"b")]);
        let duplicate_required =
            replace_all_same_len(duplicate_required, b"events0duckdb", b"events.duckdb");
        let duplicate_required =
            replace_all_same_len(duplicate_required, b"events1duckdb", b"events.duckdb");
        let err = scan_with_limits(&duplicate_required, 1_024, 1_024).unwrap_err();
        assert!(err.to_string().contains("duplicate"), "{err}");

        let meta = br#"{"id":"old","name":"fixture","createdAt":1,"engine":"duckdb"}"#;
        let events = b"not-opened-because-manifest-fails";
        let duplicate_file = serde_json::json!({
            "path": "meta.json",
            "sha256": hex_sha256(meta),
            "bytes": meta.len(),
        });
        let manifest = serde_json::to_vec(&serde_json::json!({
            "formatVersion": PACKAGE_FORMAT_VERSION,
            "minReaderVersion": 1,
            "packageKind": PACKAGE_KIND,
            "createdAt": 1,
            "corpusId": "origin",
            "name": "duplicate",
            "engine": EVENT_ENGINE,
            "files": [
                duplicate_file.clone(),
                duplicate_file,
                {
                    "path": "events.duckdb",
                    "sha256": hex_sha256(events),
                    "bytes": events.len(),
                }
            ],
        }))
        .unwrap();
        let zipped = zip_from_owned(
            &[
                ("manifest.json".into(), manifest),
                ("meta.json".into(), meta.to_vec()),
                ("events.duckdb".into(), events.to_vec()),
            ],
            zip::CompressionMethod::Stored,
        );
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        assert!(err.to_string().contains("duplicate payload"), "{err}");
        assert!(cache_entries(&cache).is_empty());
    }

    #[test]
    fn absolute_traversal_backslash_drive_and_directory_paths_are_rejected() {
        for bad_name in [
            "/absolute.bin",
            "../secret-token-name",
            "nested/file.bin",
            r"..\secret-token-name",
            r"C:\secret-token-name",
            r"\\server\secret-token-name",
        ] {
            let zipped = zip_from_entries(&[(bad_name, b"x")]);
            let err = scan_with_limits(&zipped, 1_024, 1_024).unwrap_err();
            let message = err.to_string();
            assert!(
                message.contains("absolute")
                    || message.contains("traversing")
                    || message.contains("ambiguous"),
                "{message}"
            );
            assert!(!message.contains("secret-token-name"), "{message}");
        }

        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .add_directory("meta.json/", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.finish().unwrap();
        }
        let zipped = buffer.into_inner();
        let err = scan_with_limits(&zipped, 1_024, 1_024).unwrap_err();
        assert!(
            err.to_string().contains("directory")
                || err.to_string().contains("absolute")
                || err.to_string().contains("ambiguous"),
            "{err}"
        );
    }

    #[test]
    fn explicit_manifest_and_metadata_caps_fail_without_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let manifest_only = zip_from_entries(&[(
            "manifest.json",
            br#"{"formatVersion":"contextdesk.log_corpus.v1"}"#,
        )]);
        let err = import_corpus_zip_reader_with_limits(
            &cache,
            std::io::Cursor::new(&manifest_only),
            manifest_only.len() as u64,
            test_limits(
                MAX_PACKAGE_BYTES,
                MAX_EXPANDED_PACKAGE_BYTES,
                MAX_EXPANDED_ENTRY_BYTES,
                8,
                MAX_META_BYTES,
                8,
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("manifest"), "{err}");
        assert!(cache_entries(&cache).is_empty());

        let meta = br#"{"id":"old","name":"fixture","createdAt":1,"engine":"duckdb"}"#;
        let package = valid_package(meta, b"not-opened", Some(b"[]"), &[]);
        let err = import_corpus_zip_reader_with_limits(
            &cache,
            std::io::Cursor::new(&package),
            package.len() as u64,
            test_limits(
                MAX_PACKAGE_BYTES,
                MAX_EXPANDED_PACKAGE_BYTES,
                MAX_EXPANDED_ENTRY_BYTES,
                MAX_MANIFEST_BYTES,
                meta.len() as u64 - 1,
                8,
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("metadata"), "{err}");
        assert!(cache_entries(&cache).is_empty());
    }

    #[test]
    fn malformed_duckdb_and_hash_failure_leave_previous_corpora_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, existing_id) = seed_corpus(dir.path());
        let before = cache_entries(&cache);
        assert!(before.contains(&existing_id));

        let meta = br#"{"id":"old","name":"fixture","createdAt":1,"engine":"duckdb"}"#;
        let malformed = valid_package(meta, b"not-a-duckdb-database", Some(b"[]"), &[]);
        let err = import_corpus_zip(&cache, &malformed).unwrap_err();
        assert!(
            err.to_string().contains("duckdb") || err.to_string().contains("database"),
            "{err}"
        );
        assert_eq!(cache_entries(&cache), before);

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&malformed)).unwrap();
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            if entry.name() == "events.duckdb" {
                data.push(b'x');
            }
            entries.push((entry.name().to_string(), data));
        }
        let corrupt = zip_from_owned(&entries, zip::CompressionMethod::Stored);
        let err = import_corpus_zip(&cache, &corrupt).unwrap_err();
        assert!(
            err.to_string().contains("byte count") || err.to_string().contains("hash"),
            "{err}"
        );
        assert_eq!(cache_entries(&cache), before);
        assert!(cache_entries(&cache)
            .iter()
            .all(|name| !name.starts_with(".import-")));
    }

    #[test]
    fn unknown_entry_is_drained_and_transfer_buffer_stays_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        let data = std::fs::read(&out).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).unwrap();
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            entries.push((entry.name().to_string(), bytes));
        }
        entries.push(("future.bin".into(), vec![b'z'; 257]));
        let zipped = zip_from_owned(&entries, zip::CompressionMethod::Deflated);

        let cache2 = dir.path().join("cache2");
        let outcome = import_corpus_zip_reader_with_limits(
            &cache2,
            std::io::Cursor::new(&zipped),
            zipped.len() as u64,
            test_limits(
                MAX_PACKAGE_BYTES,
                MAX_EXPANDED_PACKAGE_BYTES,
                MAX_EXPANDED_ENTRY_BYTES,
                MAX_MANIFEST_BYTES,
                MAX_META_BYTES,
                7,
            ),
        )
        .unwrap();
        assert!(outcome.metrics.actual_expanded_bytes > 257);
        assert!(
            outcome.metrics.max_transfer_chunk <= 7,
            "{:?}",
            outcome.metrics
        );
        let root = cache2.join("log_corpora").join(&outcome.report.corpus_id);
        assert!(!root.join("future.bin").exists());
        assert!(LogCorpus::open(&cache2, &outcome.report.corpus_id).is_ok());
    }
}
