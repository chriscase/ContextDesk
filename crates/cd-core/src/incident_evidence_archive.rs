//! Deterministic ZIP pack and streaming offline validation for Incident Evidence Bundle v1 (#765).
//!
//! - No silent extraction of untrusted archives to temp directories.
//! - Stream component hashes from zip entry readers.
//! - Pack produces byte-identical archives for identical directory inputs.

use crate::incident_evidence::{
    contains_forbidden_sentinel, is_lowercase_sha256, redacted_root_label,
    stream_sha256_hex_bounded, validate_component_inventory, validate_directory,
    validate_manifest_header, validate_metrics_document_text, validate_relative_path, BundleRoot,
    Diagnostic, ForbiddenSentinelStream, Manifest, ValidationReport, HASH_BUFFER_BYTES,
    MAX_AGGREGATE_BYTES, MAX_COMPONENTS, MAX_MANIFEST_BYTES, MAX_METRICS_DOC_BYTES,
    MAX_PER_FILE_BYTES, MAX_RELATIVE_PATH_BYTES, SCHEMA_ID,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

/// Canonical archive path for the manifest (root of the zip only).
pub const ARCHIVE_MANIFEST_PATH: &str = "manifest.json";

/// Max compressed archive size on disk (2 GiB).
pub const MAX_ARCHIVE_COMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max zip entries (manifest + components + no extras).
pub const MAX_ARCHIVE_ENTRIES: usize = MAX_COMPONENTS + 1;
/// Max expanded/compressed ratio for any single compressed entry (ZIP bomb guard).
pub const MAX_COMPRESSION_RATIO: u64 = 100;
/// Minimum compressed size when applying ratio (avoid div-by-zero).
const RATIO_FLOOR_COMPRESSED: u64 = 64;
static UNIQUE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Fixed DOS timestamp for deterministic packs (1980-01-01 00:00:00).
fn deterministic_mtime() -> DateTime {
    DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).expect("valid zip DateTime")
}

fn pack_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(deterministic_mtime())
        .unix_permissions(0o644)
}

/// Pack a validated directory into a deterministic ZIP archive.
///
/// Steps: directory validate → refuse links → unique temp → validate temp → atomic publication.
/// Does not overwrite `output` unless `overwrite` is true.
pub fn pack_directory(
    root: &Path,
    output: &Path,
    overwrite: bool,
) -> Result<PackReport, Vec<Diagnostic>> {
    pack_directory_with_before_write(root, output, overwrite, || {})
}

fn pack_directory_with_before_write(
    root: &Path,
    output: &Path,
    overwrite: bool,
    before_write: impl FnOnce(),
) -> Result<PackReport, Vec<Diagnostic>> {
    // Pin the user-selected root before validation. All later pack reads are
    // relative to this handle so path swaps cannot redirect payload I/O.
    let bundle_root = BundleRoot::open(root).map_err(|diagnostic| vec![diagnostic])?;
    let dir_report = validate_directory(root);
    if !dir_report.ok {
        return Err(dir_report.diagnostics);
    }

    if output.exists() && !overwrite {
        return Err(vec![Diagnostic::new(
            "output_exists",
            redacted_root_label(output),
            "output archive already exists; pass --force to replace",
        )]);
    }

    let raw = read_pack_manifest(&bundle_root)?;
    let manifest: Manifest = serde_json::from_str(&raw).map_err(|e| {
        vec![Diagnostic::new(
            "manifest_json_invalid",
            "manifest.json",
            format!("manifest parse for pack: {e}"),
        )]
    })?;

    // Collect archive paths with stable order. Filesystem reads happen later
    // through the pinned root handle, never through reconstructed paths.
    let mut entries: Vec<String> = vec![ARCHIVE_MANIFEST_PATH.to_string()];
    for c in &manifest.components {
        validate_relative_path(&c.path)
            .map_err(|msg| vec![Diagnostic::new("unsafe_path", c.path.clone(), msg)])?;
        entries.push(c.path.clone());
    }
    // Stable order: lexicographic by archive path (manifest.json first among equals).
    entries.sort();
    let expected_components: HashMap<&str, (u64, &str)> = manifest
        .components
        .iter()
        .map(|component| {
            (
                component.path.as_str(),
                (component.bytes, component.sha256.as_str()),
            )
        })
        .collect();

    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| {
        vec![Diagnostic::new(
            "output_parent",
            redacted_root_label(parent),
            format!("cannot create output parent: {e}"),
        )]
    })?;
    before_write();
    let (tmp, file) = create_unique_partial(parent, output).map_err(|d| vec![d])?;

    let write_result = (|| -> Result<(u64, String), Vec<Diagnostic>> {
        let mut zip = ZipWriter::new(file);
        let opts = pack_options();
        let mut total = 0u64;
        for name in &entries {
            zip.start_file(name.as_str(), opts).map_err(|e| {
                vec![Diagnostic::new(
                    "pack_zip_failed",
                    name.clone(),
                    format!("zip start_file: {e}"),
                )]
            })?;

            if name == ARCHIVE_MANIFEST_PATH {
                zip.write_all(raw.as_bytes()).map_err(|e| {
                    vec![Diagnostic::new(
                        "pack_zip_failed",
                        name.clone(),
                        format!("zip write: {e}"),
                    )]
                })?;
                total = total.saturating_add(raw.len() as u64);
                continue;
            }

            let Some(&(expected_bytes, expected_sha256)) = expected_components.get(name.as_str())
            else {
                return Err(vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    "component no longer has a manifest declaration during pack",
                )]);
            };

            // Bound + TOCTOU-safe open; stream into zip without full-file allocation
            // and verify the bytes still match the already-validated manifest.
            let mut opened = bundle_root
                .open_regular_file_bounded(name, MAX_PER_FILE_BYTES, name)
                .map_err(|d| vec![d])?;
            let size_at_open = opened.size;
            if size_at_open != expected_bytes {
                return Err(vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    "source file size no longer matches the manifest during pack",
                )]);
            }

            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; HASH_BUFFER_BYTES];
            let mut remaining = size_at_open;
            while remaining > 0 {
                let chunk = (remaining as usize).min(buf.len());
                let n = opened.file.read(&mut buf[..chunk]).map_err(|e| {
                    vec![Diagnostic::new(
                        "pack_read_failed",
                        name.clone(),
                        format!("cannot read payload for pack: {e}"),
                    )]
                })?;
                if n == 0 {
                    return Err(vec![Diagnostic::new(
                        "pack_read_failed",
                        name.clone(),
                        "unexpected EOF while packing payload",
                    )]);
                }
                hasher.update(&buf[..n]);
                zip.write_all(&buf[..n]).map_err(|e| {
                    vec![Diagnostic::new(
                        "pack_zip_failed",
                        name.clone(),
                        format!("zip write: {e}"),
                    )]
                })?;
                remaining -= n as u64;
            }
            // Read at most one byte beyond the declared size so growth cannot hide
            // behind a stale size observed at open.
            let mut extra = [0u8; 1];
            if opened.file.read(&mut extra).map_err(|e| {
                vec![Diagnostic::new(
                    "pack_read_failed",
                    name.clone(),
                    format!("cannot finish payload read for pack: {e}"),
                )]
            })? != 0
            {
                return Err(vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    "source file grew while being packed",
                )]);
            }

            let meta_after = opened.file.metadata().map_err(|e| {
                vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    format!("cannot re-stat during pack: {e}"),
                )]
            })?;
            if meta_after.len() != size_at_open {
                return Err(vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    "source file size changed during pack",
                )]);
            }

            let actual_sha256: String = hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if actual_sha256 != expected_sha256 {
                return Err(vec![Diagnostic::new(
                    "payload_identity_changed",
                    name.clone(),
                    "source file contents no longer match the manifest during pack",
                )]);
            }
            total = total.saturating_add(size_at_open);
        }
        zip.finish().map_err(|e| {
            vec![Diagnostic::new(
                "pack_zip_failed",
                redacted_root_label(&tmp),
                format!("zip finish: {e}"),
            )]
        })?;

        let validation = validate_archive(&tmp);
        if !validation.ok {
            return Err(validation.diagnostics);
        }
        let digest = stream_sha256_hex_bounded(&tmp, MAX_ARCHIVE_COMPRESSED_BYTES)
            .map_err(|e| vec![Diagnostic::new("hash_failed", redacted_root_label(&tmp), e)])?;
        Ok((total, digest))
    })();

    match write_result {
        Ok((total_bytes, digest)) => {
            publish_archive(&tmp, output, overwrite).map_err(|d| {
                let _ = fs::remove_file(&tmp);
                vec![d]
            })?;
            Ok(PackReport {
                output: redacted_root_label(output),
                schema_id: SCHEMA_ID.to_string(),
                bundle_id: manifest.bundle_id,
                component_count: manifest.components.len(),
                total_bytes,
                archive_sha256: digest,
            })
        }
        Err(diagnostics) => {
            let _ = fs::remove_file(&tmp);
            Err(diagnostics)
        }
    }
}

fn read_pack_manifest(root: &BundleRoot) -> Result<String, Vec<Diagnostic>> {
    let opened = root
        .open_regular_file_bounded(
            ARCHIVE_MANIFEST_PATH,
            MAX_MANIFEST_BYTES,
            ARCHIVE_MANIFEST_PATH,
        )
        .map_err(|d| vec![d])?;
    let mut bytes = Vec::with_capacity(usize::try_from(opened.size).unwrap_or(0));
    opened
        .file
        .take(MAX_MANIFEST_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| {
            vec![Diagnostic::new(
                "manifest_unreadable",
                ARCHIVE_MANIFEST_PATH,
                format!("cannot read manifest for pack: {e}"),
            )]
        })?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(vec![Diagnostic::new(
            "manifest_too_large",
            ARCHIVE_MANIFEST_PATH,
            format!("manifest exceeds MAX_MANIFEST_BYTES ({MAX_MANIFEST_BYTES})"),
        )]);
    }
    String::from_utf8(bytes).map_err(|_| {
        vec![Diagnostic::new(
            "manifest_utf8",
            ARCHIVE_MANIFEST_PATH,
            "manifest.json is not UTF-8",
        )]
    })
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = UNIQUE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}.{}.{}", std::process::id(), nanos, counter)
}

fn create_unique_partial(parent: &Path, output: &Path) -> Result<(PathBuf, File), Diagnostic> {
    let output_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("bundle.zip");
    for attempt in 0..128u16 {
        let path = parent.join(format!(
            ".{output_name}.partial.{}.{}",
            unique_suffix(),
            attempt
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Diagnostic::new(
                    "pack_create_failed",
                    redacted_root_label(&path),
                    format!("cannot create partial archive: {error}"),
                ));
            }
        }
    }
    Err(Diagnostic::new(
        "pack_create_failed",
        redacted_root_label(output),
        "cannot allocate a unique partial archive name",
    ))
}

fn publish_archive(temp: &Path, output: &Path, overwrite: bool) -> Result<(), Diagnostic> {
    if !overwrite {
        fs::hard_link(temp, output).map_err(|error| {
            let (code, message) = if error.kind() == std::io::ErrorKind::AlreadyExists {
                (
                    "output_exists",
                    "output archive already exists; pass --force to replace".to_string(),
                )
            } else {
                (
                    "output_rename_failed",
                    format!("atomic no-clobber publication failed: {error}"),
                )
            };
            Diagnostic::new(code, redacted_root_label(output), message)
        })?;
        let _ = fs::remove_file(temp);
        return Ok(());
    }

    publish_archive_overwrite(temp, output)
}

#[cfg(not(windows))]
fn publish_archive_overwrite(temp: &Path, output: &Path) -> Result<(), Diagnostic> {
    // POSIX rename atomically replaces a same-filesystem destination and leaves
    // the previous destination untouched when the rename itself fails.
    fs::rename(temp, output).map_err(|error| {
        Diagnostic::new(
            "output_replace_failed",
            redacted_root_label(output),
            format!("atomic replacement failed: {error}"),
        )
    })
}

#[cfg(windows)]
fn publish_archive_overwrite(temp: &Path, output: &Path) -> Result<(), Diagnostic> {
    if !output.exists() {
        return fs::rename(temp, output).map_err(|error| {
            Diagnostic::new(
                "output_rename_failed",
                redacted_root_label(output),
                format!("atomic rename failed: {error}"),
            )
        });
    }

    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let output_wide: Vec<u16> = output
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let temp_wide: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // ReplaceFileW atomically replaces the destination on the same volume and
    // leaves the existing file intact when replacement fails.
    let replaced = unsafe {
        ReplaceFileW(
            output_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(Diagnostic::new(
            "output_replace_failed",
            redacted_root_label(output),
            format!(
                "atomic replacement failed: {}",
                std::io::Error::last_os_error()
            ),
        ))
    } else {
        Ok(())
    }
}

/// Result of a successful pack.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackReport {
    /// Output path.
    pub output: String,
    /// Schema id packed.
    pub schema_id: String,
    /// Bundle id.
    pub bundle_id: String,
    /// Component count.
    pub component_count: usize,
    /// Total uncompressed payload bytes written (manifest + components).
    pub total_bytes: u64,
    /// SHA-256 of the produced archive file.
    pub archive_sha256: String,
}

/// Validate a ZIP archive form without extracting to a temp directory tree.
pub fn validate_archive(path: &Path) -> ValidationReport {
    let mut diagnostics = Vec::new();
    let root_display = redacted_root_label(path);

    if !path.is_file() {
        diagnostics.push(Diagnostic::new(
            "archive_not_file",
            root_display.clone(),
            "archive path is not a regular file",
        ));
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }

    let compressed_len = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "archive_unreadable",
                root_display.clone(),
                format!("cannot stat archive: {e}"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
    };
    if compressed_len > MAX_ARCHIVE_COMPRESSED_BYTES {
        diagnostics.push(Diagnostic::new(
            "archive_too_large",
            root_display.clone(),
            format!(
                "compressed archive exceeds MAX_ARCHIVE_COMPRESSED_BYTES ({MAX_ARCHIVE_COMPRESSED_BYTES})"
            ),
        ));
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }
    if compressed_len < 22 {
        diagnostics.push(Diagnostic::new(
            "archive_truncated",
            root_display.clone(),
            "archive is too small to contain a zip end record",
        ));
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }

    // Explicit multi-disk / Zip64 / EOCD consistency preflight (fail closed
    // with dedicated codes, not only as a generic open failure).
    if let Err(d) = preflight_zip_structure(path, compressed_len) {
        diagnostics.push(d);
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }

    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "archive_unreadable",
                root_display.clone(),
                format!("cannot open archive: {e}"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
    };

    let mut archive = match ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "archive_open_failed",
                root_display.clone(),
                format!("zip open failed (corrupt or unsupported): {e}"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
    };

    if archive.len() > MAX_ARCHIVE_ENTRIES {
        diagnostics.push(Diagnostic::new(
            "too_many_entries",
            root_display.clone(),
            format!("archive entry count exceeds MAX_ARCHIVE_ENTRIES ({MAX_ARCHIVE_ENTRIES})"),
        ));
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }

    let mut by_name: HashMap<String, usize> = HashMap::new();
    let mut lower_names: HashSet<String> = HashSet::new();
    let mut unsafe_payload_indices: HashSet<usize> = HashSet::new();
    let mut expanded_total: u64 = 0;

    for index in 0..archive.len() {
        let entry = match archive.by_index(index) {
            Ok(e) => e,
            Err(e) => {
                let msg = e.to_string();
                let lower = msg.to_ascii_lowercase();
                let code = if lower.contains("password")
                    || lower.contains("encrypt")
                    || lower.contains("decrypt")
                {
                    "entry_encrypted"
                } else {
                    "entry_unreadable"
                };
                diagnostics.push(Diagnostic::new(
                    code,
                    format!("entry[{index}]"),
                    format!("cannot read zip entry metadata: {msg}"),
                ));
                continue;
            }
        };
        let name = match std::str::from_utf8(entry.name_raw()) {
            Ok(s) => s.to_string(),
            Err(_) => {
                diagnostics.push(Diagnostic::new(
                    "entry_name_utf8",
                    format!("entry[{index}]"),
                    "zip entry name is not valid UTF-8",
                ));
                continue;
            }
        };

        if name.is_empty() {
            diagnostics.push(Diagnostic::new(
                "entry_name_empty",
                format!("entry[{index}]"),
                "zip entry name is empty",
            ));
            continue;
        }
        if name.contains('\0') || name.chars().any(|c| c.is_control()) {
            diagnostics.push(Diagnostic::new(
                "entry_name_control",
                name.clone(),
                "zip entry name contains control characters",
            ));
        }
        if name.contains('\\') {
            diagnostics.push(Diagnostic::new(
                "unsafe_path",
                name.clone(),
                "zip entry MUST use `/` separators only",
            ));
        }
        if name.starts_with('/') || name.starts_with('\\') {
            diagnostics.push(Diagnostic::new(
                "unsafe_path",
                name.clone(),
                "zip entry MUST NOT be absolute",
            ));
        }
        let drive = name.as_bytes().get(1) == Some(&b':')
            && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
        if drive {
            diagnostics.push(Diagnostic::new(
                "unsafe_path",
                name.clone(),
                "zip entry MUST NOT use a drive-letter prefix",
            ));
        }
        if name.split('/').any(|s| s == ".." || s == ".") {
            diagnostics.push(Diagnostic::new(
                "unsafe_path",
                name.clone(),
                "zip entry MUST NOT contain `.` or `..` segments",
            ));
        }
        if name.len() > MAX_RELATIVE_PATH_BYTES {
            diagnostics.push(Diagnostic::new(
                "path_too_long",
                name.clone(),
                format!("entry name exceeds MAX_RELATIVE_PATH_BYTES ({MAX_RELATIVE_PATH_BYTES})"),
            ));
        }

        let mut unsafe_for_payload_io = false;
        if entry.encrypted() {
            diagnostics.push(Diagnostic::new(
                "entry_encrypted",
                name.clone(),
                "encrypted zip entries are not supported",
            ));
            unsafe_for_payload_io = true;
        }
        if entry.is_symlink() {
            diagnostics.push(Diagnostic::new(
                "entry_symlink",
                name.clone(),
                "symlink zip entries are not supported",
            ));
            unsafe_for_payload_io = true;
        }
        // Reject FIFO/chardev/block/socket and other non-regular modes via
        // unix external attributes (same kind mask as log zip ingest).
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            // 0 = unset/common portable; 0o100000 = S_IFREG; 0o040000 = dir; 0o120000 = symlink.
            if kind != 0 && kind != 0o100000 && kind != 0o040000 && kind != 0o120000 {
                diagnostics.push(Diagnostic::new(
                    "entry_non_regular",
                    name.clone(),
                    format!(
                        "non-regular zip entry mode {:o} (device/FIFO/socket/etc. not allowed)",
                        kind
                    ),
                ));
                unsafe_for_payload_io = true;
            }
        }
        if entry.is_dir() {
            // Directory entries are rejected later as directory_entry; keep kind check above.
            unsafe_for_payload_io = true;
        }
        match entry.compression() {
            CompressionMethod::Stored | CompressionMethod::Deflated => {}
            other => {
                diagnostics.push(Diagnostic::new(
                    "unsupported_compression",
                    name.clone(),
                    format!("unsupported compression method: {other:?}"),
                ));
                unsafe_for_payload_io = true;
            }
        }

        let expanded = entry.size();
        let compressed = entry.compressed_size();
        if expanded > MAX_PER_FILE_BYTES {
            diagnostics.push(Diagnostic::new(
                "file_too_large",
                name.clone(),
                format!("expanded entry exceeds MAX_PER_FILE_BYTES ({MAX_PER_FILE_BYTES})"),
            ));
            unsafe_for_payload_io = true;
        }
        expanded_total = expanded_total.saturating_add(expanded);
        if expanded_total > MAX_AGGREGATE_BYTES {
            diagnostics.push(Diagnostic::new(
                "aggregate_too_large",
                name.clone(),
                format!(
                    "aggregate expanded bytes exceed MAX_AGGREGATE_BYTES ({MAX_AGGREGATE_BYTES})"
                ),
            ));
            unsafe_for_payload_io = true;
        }
        // Compression ratio bomb guard (expanded / max(compressed, floor)).
        if !entry.is_dir() && matches!(entry.compression(), CompressionMethod::Deflated) {
            let denom = compressed.max(RATIO_FLOOR_COMPRESSED);
            if expanded > denom.saturating_mul(MAX_COMPRESSION_RATIO) {
                diagnostics.push(Diagnostic::new(
                    "compression_ratio",
                    name.clone(),
                    format!(
                        "entry expanded/compressed ratio exceeds MAX_COMPRESSION_RATIO ({MAX_COMPRESSION_RATIO})"
                    ),
                ));
                unsafe_for_payload_io = true;
            }
        }
        if unsafe_for_payload_io {
            unsafe_payload_indices.insert(index);
        }

        let lower = name.to_ascii_lowercase();
        if !lower_names.insert(lower) {
            diagnostics.push(Diagnostic::new(
                "portable_name_collision",
                name.clone(),
                "case-insensitive portable path collision with another entry",
            ));
        }
        if by_name.insert(name.clone(), index).is_some() {
            diagnostics.push(Diagnostic::new(
                "duplicate_entry_name",
                name.clone(),
                "duplicate zip entry name",
            ));
        }

        // File/directory collision: if we later see both `foo` file and `foo/bar`.
        drop(entry);
    }

    // File vs directory prefix collisions among entry names.
    let names: Vec<String> = by_name.keys().cloned().collect();
    for a in &names {
        for b in &names {
            if a != b && b.starts_with(&format!("{a}/")) {
                diagnostics.push(Diagnostic::new(
                    "file_dir_collision",
                    a.clone(),
                    format!("entry `{a}` collides with nested path `{b}`"),
                ));
            }
        }
    }

    if !by_name.contains_key(ARCHIVE_MANIFEST_PATH) {
        diagnostics.push(Diagnostic::new(
            "manifest_missing",
            ARCHIVE_MANIFEST_PATH,
            "archive MUST contain root manifest.json",
        ));
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }
    if by_name
        .get(ARCHIVE_MANIFEST_PATH)
        .is_some_and(|index| unsafe_payload_indices.contains(index))
    {
        return finish_archive(false, root_display, None, None, None, None, diagnostics);
    }

    // Stream-read manifest without extracting other files.
    let manifest_raw = {
        let f = match archive.by_name(ARCHIVE_MANIFEST_PATH) {
            Ok(f) => f,
            Err(e) => {
                diagnostics.push(Diagnostic::new(
                    "manifest_unreadable",
                    ARCHIVE_MANIFEST_PATH,
                    format!("cannot open manifest entry: {e}"),
                ));
                return finish_archive(false, root_display, None, None, None, None, diagnostics);
            }
        };
        if f.size() > MAX_MANIFEST_BYTES {
            diagnostics.push(Diagnostic::new(
                "manifest_too_large",
                ARCHIVE_MANIFEST_PATH,
                format!("manifest exceeds MAX_MANIFEST_BYTES ({MAX_MANIFEST_BYTES})"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
        let mut buf = Vec::new();
        if let Err(e) = f.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut buf) {
            diagnostics.push(Diagnostic::new(
                "manifest_unreadable",
                ARCHIVE_MANIFEST_PATH,
                format!("cannot read manifest entry: {e}"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
        if buf.len() as u64 > MAX_MANIFEST_BYTES {
            diagnostics.push(Diagnostic::new(
                "manifest_too_large",
                ARCHIVE_MANIFEST_PATH,
                format!("manifest exceeds MAX_MANIFEST_BYTES ({MAX_MANIFEST_BYTES})"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
        match String::from_utf8(buf) {
            Ok(s) => s,
            Err(_) => {
                diagnostics.push(Diagnostic::new(
                    "manifest_utf8",
                    ARCHIVE_MANIFEST_PATH,
                    "manifest.json is not UTF-8",
                ));
                return finish_archive(false, root_display, None, None, None, None, diagnostics);
            }
        }
    };

    if contains_forbidden_sentinel(&manifest_raw) {
        diagnostics.push(Diagnostic::new(
            "forbidden_sentinel",
            ARCHIVE_MANIFEST_PATH,
            "manifest contains forbidden evaluator-truth / answer-key sentinel",
        ));
    }

    let manifest: Manifest = match serde_json::from_str(&manifest_raw) {
        Ok(m) => m,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "manifest_json_invalid",
                ARCHIVE_MANIFEST_PATH,
                format!("manifest.json is not valid JSON for the v1 shape: {e}"),
            ));
            return finish_archive(false, root_display, None, None, None, None, diagnostics);
        }
    };

    let schema_id = Some(manifest.schema_id.clone());
    let bundle_id = Some(manifest.bundle_id.clone());

    // Structural + component inventory — same rules as directory form.
    validate_manifest_header(&manifest, &mut diagnostics);
    let inventory = validate_component_inventory(&manifest.components, &mut diagnostics);
    let mut declared_paths = inventory.declared_paths;
    declared_paths.insert(ARCHIVE_MANIFEST_PATH.to_string());
    let mut validated_bytes: u64 = 0;

    for (i, c) in manifest.components.iter().enumerate() {
        // Skip payload I/O when Pass-1 already failed closed for this component
        // (unsafe path, unknown role, case collision, etc.) — parity with directory.
        if !inventory.path_ok_for_io.get(i).copied().unwrap_or(false) {
            continue;
        }

        let Some(&idx) = by_name.get(&c.path) else {
            diagnostics.push(Diagnostic::new(
                "payload_missing",
                c.path.clone(),
                format!("declared component missing from archive: {}", c.path),
            ));
            continue;
        };
        // Metadata rejection is terminal for payload I/O. In particular, never
        // instantiate a decoder for an oversized, over-ratio, or over-aggregate
        // entry merely to discover another error while hashing.
        if unsafe_payload_indices.contains(&idx) {
            continue;
        }

        // Nested .zip as declared attachment is opaque — we only stream-hash.
        let mut entry = match archive.by_index(idx) {
            Ok(e) => e,
            Err(e) => {
                diagnostics.push(Diagnostic::new(
                    "entry_unreadable",
                    c.path.clone(),
                    format!("cannot open component entry: {e}"),
                ));
                continue;
            }
        };
        if entry.is_dir() {
            diagnostics.push(Diagnostic::new(
                "entry_is_directory",
                c.path.clone(),
                "component path refers to a directory entry",
            ));
            continue;
        }
        let expanded = entry.size();
        if expanded != c.bytes {
            diagnostics.push(Diagnostic::new(
                "byte_count_mismatch",
                c.path.clone(),
                format!(
                    "declared bytes {} != archive expanded size {expanded}",
                    c.bytes
                ),
            ));
        }
        let aggregate_remaining = MAX_AGGREGATE_BYTES.saturating_sub(validated_bytes);
        if expanded > aggregate_remaining {
            diagnostics.push(Diagnostic::new(
                "aggregate_too_large",
                c.path.clone(),
                format!(
                    "aggregate actual bytes exceed MAX_AGGREGATE_BYTES ({MAX_AGGREGATE_BYTES})"
                ),
            ));
            continue;
        }
        // Single pass: hash while optionally capturing metrics JSON (bounded).
        let capture_metrics = c.role == "operational_metrics" && expanded <= MAX_METRICS_DOC_BYTES;
        let mut metrics_buf = if capture_metrics {
            Some(Vec::with_capacity(expanded as usize))
        } else {
            None
        };
        let scan_forbidden = matches!(c.role.as_str(), "log" | "readme");
        match stream_sha256_reader_capturing(
            &mut entry,
            expanded,
            metrics_buf.as_mut(),
            scan_forbidden,
        ) {
            Ok((hex, forbidden_content)) => {
                if is_lowercase_sha256(&c.sha256) && hex != c.sha256 {
                    diagnostics.push(Diagnostic::new(
                        "hash_mismatch",
                        c.path.clone(),
                        "declared sha256 does not match archive entry contents",
                    ));
                }
                if forbidden_content {
                    diagnostics.push(Diagnostic::new(
                        "forbidden_sentinel",
                        c.path.clone(),
                        "payload contains forbidden evaluator-truth / answer-key sentinel",
                    ));
                }
            }
            Err(e) => diagnostics.push(Diagnostic::new(
                "hash_failed",
                c.path.clone(),
                format!("failed to stream-hash entry: {e}"),
            )),
        }
        // Aggregate real expanded bytes processed.
        validated_bytes = validated_bytes.saturating_add(expanded);
        if validated_bytes > MAX_AGGREGATE_BYTES {
            diagnostics.push(Diagnostic::new(
                "aggregate_too_large",
                "$.components",
                format!(
                    "aggregate actual bytes exceed MAX_AGGREGATE_BYTES ({MAX_AGGREGATE_BYTES})"
                ),
            ));
        }

        if c.role == "operational_metrics" {
            if c.bytes > MAX_METRICS_DOC_BYTES {
                diagnostics.push(Diagnostic::new(
                    "metrics_doc_too_large",
                    c.path.clone(),
                    format!(
                        "operational_metrics document exceeds MAX_METRICS_DOC_BYTES ({MAX_METRICS_DOC_BYTES})"
                    ),
                ));
            } else if let Some(buf) = metrics_buf {
                match String::from_utf8(buf) {
                    Ok(text) => validate_metrics_document_text(&text, &c.path, &mut diagnostics),
                    Err(_) => diagnostics.push(Diagnostic::new(
                        "metrics_json_invalid",
                        c.path.clone(),
                        "operational_metrics payload is not valid UTF-8",
                    )),
                }
            }
        }
        if contains_forbidden_sentinel(&c.path) || contains_forbidden_sentinel(&c.id) {
            diagnostics.push(Diagnostic::new(
                "forbidden_sentinel",
                c.path.clone(),
                "component path or id contains forbidden sentinel",
            ));
        }
    }

    // Undeclared payload files (allow only manifest.json + declared components).
    for name in by_name.keys() {
        if contains_forbidden_sentinel(name) {
            diagnostics.push(Diagnostic::new(
                "forbidden_sentinel",
                name.clone(),
                "archive entry name contains forbidden sentinel",
            ));
        }
        if name.ends_with('/') {
            // Directory entries: reject (we do not emit them on pack).
            diagnostics.push(Diagnostic::new(
                "directory_entry",
                name.clone(),
                "directory zip entries are not allowed",
            ));
            continue;
        }
        if !declared_paths.contains(name) {
            diagnostics.push(Diagnostic::new(
                "undeclared_payload",
                name.clone(),
                "archive contains a file not declared in the manifest",
            ));
        }
    }

    let component_count = Some(manifest.components.len());
    let total_bytes = Some(validated_bytes);
    let ok = diagnostics.is_empty();
    finish_archive(
        ok,
        root_display,
        schema_id,
        bundle_id,
        component_count,
        total_bytes,
        diagnostics,
    )
}

/// EOCD + central-directory disk_start preflight. Fail closed on multi-disk
/// and Zip64 markers without relying solely on ZipArchive::new errors.
fn preflight_zip_structure(path: &Path, compressed_len: u64) -> Result<(), Diagnostic> {
    const EOCD_MIN: usize = 22;
    const MAX_COMMENT: usize = u16::MAX as usize;
    const EOCD_SIG: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIG: &[u8; 4] = b"PK\x01\x02";
    const CENTRAL_HDR: usize = 46;

    let mut reader = File::open(path).map_err(|e| {
        Diagnostic::new(
            "archive_unreadable",
            path.display().to_string(),
            format!("cannot open for preflight: {e}"),
        )
    })?;
    if compressed_len < EOCD_MIN as u64 {
        return Err(Diagnostic::new(
            "archive_truncated",
            path.display().to_string(),
            "archive too small for EOCD",
        ));
    }
    let tail_len = usize::try_from(compressed_len)
        .unwrap_or(usize::MAX)
        .min(EOCD_MIN + MAX_COMMENT);
    reader
        .seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                format!("seek EOCD tail failed: {e}"),
            )
        })?;
    let mut tail = vec![0u8; tail_len];
    reader.read_exact(&mut tail).map_err(|e| {
        Diagnostic::new(
            "archive_truncated",
            path.display().to_string(),
            format!("read EOCD tail failed: {e}"),
        )
    })?;

    let eocd_in_tail = (0..=tail.len().saturating_sub(4))
        .rev()
        .find(|position| {
            let p = *position;
            if tail.get(p..p + 4) != Some(EOCD_SIG) {
                return false;
            }
            let Some(comment) = tail.get(p + 20..p + 22) else {
                return false;
            };
            let comment_len = u16::from_le_bytes([comment[0], comment[1]]) as usize;
            p + EOCD_MIN + comment_len == tail.len()
        })
        .ok_or_else(|| {
            Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                "missing or ambiguous zip end-of-central-directory record",
            )
        })?;

    let eocd = &tail[eocd_in_tail..];
    let disk = u16::from_le_bytes([eocd[4], eocd[5]]);
    let central_disk = u16::from_le_bytes([eocd[6], eocd[7]]);
    let entries_on_disk = u16::from_le_bytes([eocd[8], eocd[9]]);
    let entries_total = u16::from_le_bytes([eocd[10], eocd[11]]);
    let central_size = u32::from_le_bytes([eocd[12], eocd[13], eocd[14], eocd[15]]);
    let central_offset = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]);

    if disk != 0 || central_disk != 0 || entries_on_disk != entries_total {
        return Err(Diagnostic::new(
            "multi_disk_archive",
            path.display().to_string(),
            "multi-disk zip archives are not supported",
        ));
    }
    if entries_total == u16::MAX || central_size == u32::MAX || central_offset == u32::MAX {
        return Err(Diagnostic::new(
            "zip64_unsupported",
            path.display().to_string(),
            "Zip64 metadata is not supported under evidence-bundle limits",
        ));
    }

    let central_end = (central_offset as u64)
        .checked_add(central_size as u64)
        .ok_or_else(|| {
            Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                "central directory offset overflow",
            )
        })?;
    let absolute_eocd = compressed_len - tail_len as u64 + eocd_in_tail as u64;
    if central_end != absolute_eocd {
        return Err(Diagnostic::new(
            "archive_truncated",
            path.display().to_string(),
            "central directory boundaries are inconsistent",
        ));
    }

    // Walk central directory headers for per-entry disk_start != 0.
    reader
        .seek(SeekFrom::Start(central_offset as u64))
        .map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                format!("seek central directory failed: {e}"),
            )
        })?;
    for i in 0..entries_total {
        let mut header = [0u8; CENTRAL_HDR];
        reader.read_exact(&mut header).map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                format!("truncated central directory at entry {i}: {e}"),
            )
        })?;
        if &header[..4] != CENTRAL_SIG {
            return Err(Diagnostic::new(
                "archive_truncated",
                path.display().to_string(),
                "central directory entry signature is invalid",
            ));
        }
        // General-purpose bit 0 = traditional encryption; bit 6 = strong encryption.
        // Detect here so encrypted archives fail with entry_encrypted before
        // ZipArchive::by_index surfaces a generic "Password required" error.
        let flags = u16::from_le_bytes([header[8], header[9]]);
        if flags & 1 != 0 || flags & (1 << 6) != 0 {
            return Err(Diagnostic::new(
                "entry_encrypted",
                redacted_root_label(path),
                "encrypted zip entries are not supported",
            ));
        }
        let name_len = u16::from_le_bytes([header[28], header[29]]) as u64;
        let extra_len = u16::from_le_bytes([header[30], header[31]]) as u64;
        let comment_len = u16::from_le_bytes([header[32], header[33]]) as u64;
        let disk_start = u16::from_le_bytes([header[34], header[35]]);
        let local_offset = u32::from_le_bytes([header[42], header[43], header[44], header[45]]);
        if disk_start != 0 {
            return Err(Diagnostic::new(
                "multi_disk_archive",
                redacted_root_label(path),
                "multi-disk zip entry disk_start is not supported",
            ));
        }
        // Read name for local header cross-check.
        let mut name_bytes = vec![0u8; name_len as usize];
        reader.read_exact(&mut name_bytes).map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                format!("truncated central name: {e}"),
            )
        })?;
        // Skip extra + comment for this central entry.
        let skip_rest = extra_len.checked_add(comment_len).ok_or_else(|| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                "central directory field overflow",
            )
        })?;
        reader
            .seek(SeekFrom::Current(i64::try_from(skip_rest).map_err(
                |_| {
                    Diagnostic::new(
                        "archive_truncated",
                        redacted_root_label(path),
                        "central directory skip exceeds seek range",
                    )
                },
            )?))
            .map_err(|e| {
                Diagnostic::new(
                    "archive_truncated",
                    redacted_root_label(path),
                    format!("seek past central entry failed: {e}"),
                )
            })?;

        // Central vs local header agreement (flags + name).
        let return_pos = reader.stream_position().map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                format!("tell failed: {e}"),
            )
        })?;
        reader
            .seek(SeekFrom::Start(local_offset as u64))
            .map_err(|e| {
                Diagnostic::new(
                    "archive_truncated",
                    redacted_root_label(path),
                    format!("seek local header failed: {e}"),
                )
            })?;
        let mut local = [0u8; 30];
        reader.read_exact(&mut local).map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                format!("truncated local header failed: {e}"),
            )
        })?;
        if &local[..4] != b"PK\x03\x04" {
            return Err(Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                "local file header signature is invalid",
            ));
        }
        let local_flags = u16::from_le_bytes([local[6], local[7]]);
        if (local_flags & 1) != (flags & 1) || (local_flags & (1 << 6)) != (flags & (1 << 6)) {
            return Err(Diagnostic::new(
                "header_disagreement",
                redacted_root_label(path),
                "central and local encryption flags disagree",
            ));
        }
        let local_name_len = u16::from_le_bytes([local[26], local[27]]) as usize;
        let mut local_name = vec![0u8; local_name_len];
        reader.read_exact(&mut local_name).map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                format!("read local name failed: {e}"),
            )
        })?;
        if local_name != name_bytes {
            return Err(Diagnostic::new(
                "header_disagreement",
                redacted_root_label(path),
                "central and local entry names disagree",
            ));
        }
        reader.seek(SeekFrom::Start(return_pos)).map_err(|e| {
            Diagnostic::new(
                "archive_truncated",
                redacted_root_label(path),
                format!("restore central walk failed: {e}"),
            )
        })?;
    }
    Ok(())
}

fn stream_sha256_reader_capturing(
    reader: &mut dyn Read,
    byte_ceiling: u64,
    mut capture: Option<&mut Vec<u8>>,
    scan_forbidden: bool,
) -> Result<(String, bool), String> {
    let mut hasher = Sha256::new();
    let mut sentinel_scan = ForbiddenSentinelStream::default();
    let mut buf = vec![0u8; HASH_BUFFER_BYTES];
    let mut limited = reader.take(byte_ceiling.saturating_add(1));
    let mut observed = 0u64;
    loop {
        let n = limited.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        observed = observed.saturating_add(n as u64);
        if observed > byte_ceiling {
            return Err(format!("read bound exceeded ({byte_ceiling})"));
        }
        hasher.update(&buf[..n]);
        if scan_forbidden {
            sentinel_scan.observe(&buf[..n]);
        }
        if let Some(cap) = capture.as_deref_mut() {
            cap.extend_from_slice(&buf[..n]);
        }
    }
    if observed != byte_ceiling {
        return Err(format!(
            "read length {observed} != expected size {byte_ceiling}"
        ));
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        sentinel_scan.found(),
    ))
}

fn finish_archive(
    ok: bool,
    root: String,
    schema_id: Option<String>,
    bundle_id: Option<String>,
    component_count: Option<usize>,
    total_validated_bytes: Option<u64>,
    mut diagnostics: Vec<Diagnostic>,
) -> ValidationReport {
    diagnostics.sort_by(|a, b| (&a.code, &a.path, &a.message).cmp(&(&b.code, &b.path, &b.message)));
    ValidationReport {
        ok,
        root,
        schema_id,
        bundle_id,
        diagnostics,
        transport: "archive".into(),
        component_count,
        total_validated_bytes,
    }
}

/// Format pack report for CLI.
pub fn format_pack_report(r: &PackReport) -> String {
    format!(
        "incident-evidence-pack ok=true output={}\n\
         schemaId={}\n\
         bundleId={}\n\
         components={}\n\
         totalBytes={}\n\
         archiveSha256={}",
        r.output, r.schema_id, r.bundle_id, r.component_count, r.total_bytes, r.archive_sha256
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::incident_evidence::{stream_sha256_hex, validate_directory};
    use std::io::Write;

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/incident-evidence")
    }

    fn valid_dir(name: &str) -> PathBuf {
        fixture_root().join("valid").join(name)
    }

    fn write_single_component_archive(
        path: &Path,
        role: &str,
        payload: &[u8],
        payload_compression: CompressionMethod,
        declared_sha256: Option<&str>,
    ) {
        let actual_sha256: String = Sha256::digest(payload)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let sha256 = declared_sha256.map(str::to_owned).unwrap_or(actual_sha256);
        let manifest = format!(
            r#"{{"schemaId":"contextdesk.incident_evidence.v1","minReaderVersion":1,"bundleId":"archive-test","createdAt":"2024-01-15T12:00:00Z","producer":{{"name":"test","version":"1"}},"privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},"timeBasis":{{"timezone":"UTC","timezoneResolved":true}},"components":[{{"id":"component","role":"{role}","path":"logs/app.log","mediaType":"text/plain","bytes":{},"sha256":"{sha256}"}}]}}"#,
            payload.len()
        );
        let file = File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file(
                ARCHIVE_MANIFEST_PATH,
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        archive.write_all(manifest.as_bytes()).unwrap();
        archive
            .start_file(
                "logs/app.log",
                SimpleFileOptions::default().compression_method(payload_compression),
            )
            .unwrap();
        archive.write_all(payload).unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn pack_and_validate_minimal_archive() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("minimal.zip");
        let pack = pack_directory(&dir, &zip_path, false).expect("pack");
        assert_eq!(pack.schema_id, SCHEMA_ID);
        assert!(zip_path.is_file());
        let r = validate_archive(&zip_path);
        assert!(r.ok, "{:?}", r.diagnostics);
        assert_eq!(r.transport, "archive");
        assert_eq!(r.schema_id.as_deref(), Some(SCHEMA_ID));
        assert_eq!(r.component_count, Some(1));
    }

    #[test]
    fn pack_and_validate_logs_plus_metrics() {
        let dir = valid_dir("logs-plus-metrics");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("metrics.zip");
        pack_directory(&dir, &zip_path, false).expect("pack");
        let r = validate_archive(&zip_path);
        assert!(r.ok, "{:?}", r.diagnostics);
        assert_eq!(r.component_count, Some(2));
    }

    #[test]
    fn two_pack_runs_are_byte_identical() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.zip");
        let b = tmp.path().join("b.zip");
        let ra = pack_directory(&dir, &a, false).unwrap();
        let rb = pack_directory(&dir, &b, false).unwrap();
        assert_eq!(ra.archive_sha256, rb.archive_sha256);
        let ba = fs::read(&a).unwrap();
        let bb = fs::read(&b).unwrap();
        assert_eq!(ba, bb, "archives must be byte-identical");
    }

    #[test]
    fn directory_and_archive_parity() {
        let dir = valid_dir("with-attachment");
        let d = validate_directory(&dir);
        assert!(d.ok, "{:?}", d.diagnostics);
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("p.zip");
        pack_directory(&dir, &zip_path, false).unwrap();
        let a = validate_archive(&zip_path);
        assert!(a.ok, "{:?}", a.diagnostics);
        assert_eq!(d.bundle_id, a.bundle_id);
        assert_eq!(d.schema_id, a.schema_id);
        assert_eq!(a.component_count, Some(2));
    }

    #[test]
    fn refuse_overwrite_without_force() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("once.zip");
        pack_directory(&dir, &zip_path, false).unwrap();
        let err = pack_directory(&dir, &zip_path, false).unwrap_err();
        assert!(err.iter().any(|d| d.code == "output_exists"));
        pack_directory(&dir, &zip_path, true).expect("force overwrite");
    }

    #[test]
    fn failed_pack_leaves_no_partial() {
        let tmp = tempfile::tempdir().unwrap();
        // Invalid directory (no manifest)
        let bad = tmp.path().join("bad-root");
        fs::create_dir_all(&bad).unwrap();
        let out = tmp.path().join("out.zip");
        let _ = pack_directory(&bad, &out, false);
        assert!(!out.exists());
        assert!(
            fs::read_dir(tmp.path())
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".out.zip.partial.")),
            "failed pack must clean up only its uniquely-created partial"
        );
    }

    #[test]
    fn pack_preserves_unrelated_predictable_partial() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let output = tmp.path().join("out.zip");
        let unrelated = tmp.path().join(".out.zip.partial");
        fs::write(&unrelated, b"unrelated data").unwrap();

        pack_directory(&dir, &output, false).expect("pack");

        assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated data");
        assert!(output.is_file());
    }

    #[test]
    fn failed_publication_preserves_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let missing_temp = tmp.path().join("missing-partial");
        let destination = tmp.path().join("existing.zip");
        fs::write(&destination, b"prior archive").unwrap();

        let error = publish_archive(&missing_temp, &destination, true).unwrap_err();

        assert!(
            matches!(
                error.code.as_str(),
                "output_replace_failed" | "output_rename_failed"
            ),
            "{error:?}"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"prior archive");
    }

    #[test]
    fn pack_refuses_leaf_symlink() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("x.log");
        fs::write(&secret, b"OUT\n").unwrap();
        let bundle = tempfile::tempdir().unwrap();
        let root = bundle.path();
        fs::create_dir_all(root.join("logs")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, root.join("logs/app.log")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret, root.join("logs/app.log")).unwrap();
        // Even if we craft a fake manifest, pack path checks symlink.
        // Use a real validated-looking tree only for path walk: skip if validate fails early.
        // Stronger: construct after writing a valid-looking file then replace with symlink.
        let root2 = tempfile::tempdir().unwrap();
        let r2 = root2.path();
        fs::create_dir_all(r2.join("logs")).unwrap();
        fs::write(r2.join("logs/app.log"), b"2024-01-15T12:00:00Z INFO x\n").unwrap();
        let (bytes, hex) = {
            let p = r2.join("logs/app.log");
            let h = stream_sha256_hex(&p).unwrap();
            (fs::metadata(&p).unwrap().len(), h)
        };
        let man = format!(
            r#"{{"schemaId":"contextdesk.incident_evidence.v1","minReaderVersion":1,"bundleId":"s","createdAt":"2024-01-15T12:00:00Z","producer":{{"name":"t","version":"1"}},"privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},"timeBasis":{{"timezone":"UTC","timezoneResolved":true}},"components":[{{"id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain","bytes":{bytes},"sha256":"{hex}"}}]}}"#
        );
        fs::write(r2.join("manifest.json"), man).unwrap();
        assert!(validate_directory(r2).ok);
        fs::remove_file(r2.join("logs/app.log")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, r2.join("logs/app.log")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret, r2.join("logs/app.log")).unwrap();
        let out2 = root2.path().join("out.zip");
        let err = pack_directory(r2, &out2, true).unwrap_err();
        assert!(
            err.iter().any(|d| d.code == "symlink_refused"
                || d.code == "symlink_escape"
                || !err.is_empty()),
            "{err:?}"
        );
        assert!(!out2.exists());
    }

    #[test]
    fn archive_rejects_traversal_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("evil.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("../escape.log", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            zip.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "unsafe_path"));
    }

    #[test]
    fn archive_rejects_undeclared_payload() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("extra.zip");
        pack_directory(&dir, &zip_path, false).unwrap();
        // Rebuild with extra file by re-packing manually.
        let zip2 = tmp.path().join("extra2.zip");
        {
            let file = File::create(&zip2).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = pack_options();
            // Copy original entries then add undeclared.
            let orig = File::open(&zip_path).unwrap();
            let mut archive = ZipArchive::new(orig).unwrap();
            for i in 0..archive.len() {
                let mut e = archive.by_index(i).unwrap();
                let name = e.name().to_string();
                let mut data = Vec::new();
                e.read_to_end(&mut data).unwrap();
                zip.start_file(&name, opts).unwrap();
                zip.write_all(&data).unwrap();
            }
            zip.start_file("logs/extra.log", opts).unwrap();
            zip.write_all(b"sneak\n").unwrap();
            zip.finish().unwrap();
        }
        let r = validate_archive(&zip2);
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "undeclared_payload"));
    }

    #[test]
    fn archive_rejects_hash_mismatch() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("badhash.zip");
        // Manually craft: correct files but wrong hash in manifest.
        let log = fs::read(dir.join("logs/app.log")).unwrap();
        let mut man: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        man["components"][0]["sha256"] =
            serde_json::json!("0000000000000000000000000000000000000000000000000000000000000000");
        let man_bytes = serde_json::to_vec_pretty(&man).unwrap();
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = pack_options();
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(&man_bytes).unwrap();
            zip.start_file("logs/app.log", opts).unwrap();
            zip.write_all(&log).unwrap();
            zip.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "hash_mismatch"));
    }

    #[test]
    fn nested_zip_attachment_is_opaque_not_recursively_opened() {
        // A declared attachment that is itself a zip is hashed as opaque bytes.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("bundle");
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("logs/app.log"), b"2024-01-15T12:00:00Z INFO n\n").unwrap();
        // nested zip bytes
        let nested_path = root.join("attachments/nested.zip");
        {
            let f = File::create(&nested_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            z.start_file("inner.txt", opts).unwrap();
            z.write_all(b"inner").unwrap();
            z.finish().unwrap();
        }
        let (lb, lh) = {
            let p = root.join("logs/app.log");
            (
                fs::metadata(&p).unwrap().len(),
                stream_sha256_hex(&p).unwrap(),
            )
        };
        let (ab, ah) = {
            let p = &nested_path;
            (
                fs::metadata(p).unwrap().len(),
                stream_sha256_hex(p).unwrap(),
            )
        };
        let man = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"nested-opaque",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[
    {{"id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain","bytes":{lb},"sha256":"{lh}"}},
    {{"id":"a","role":"attachment","path":"attachments/nested.zip","mediaType":"application/zip","bytes":{ab},"sha256":"{ah}"}}
  ]
}}"#
        );
        fs::write(root.join("manifest.json"), man).unwrap();
        assert!(
            validate_directory(&root).ok,
            "{:?}",
            validate_directory(&root).diagnostics
        );
        let zip_out = tmp.path().join("outer.zip");
        pack_directory(&root, &zip_out, false).unwrap();
        let r = validate_archive(&zip_out);
        assert!(
            r.ok,
            "opaque nested zip attachment must validate: {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn evaluator_truth_in_archive_manifest_fails() {
        let dir = fixture_root().join("invalid/forbidden-evaluator-truth");
        // Directory form already fails; packing should refuse via validate.
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("x.zip");
        let err = pack_directory(&dir, &out, true);
        assert!(err.is_err());
        assert!(!out.exists());
    }

    /// Patch central-directory external attributes (unix mode << 16) for named entry.
    fn patch_entry_unix_mode(zip_bytes: &mut [u8], entry_name: &[u8], mode: u32) {
        let attrs = mode << 16;
        let central = zip_bytes
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .find(|position| {
                let name_len =
                    u16::from_le_bytes([zip_bytes[position + 28], zip_bytes[position + 29]])
                        as usize;
                zip_bytes.get(position + 46..position + 46 + name_len) == Some(entry_name)
            })
            .expect("central header for entry");
        zip_bytes[central + 38..central + 42].copy_from_slice(&attrs.to_le_bytes());
    }

    fn write_minimal_valid_zip(path: &Path) {
        let dir = valid_dir("minimal-log-only");
        pack_directory(&dir, path, true).unwrap();
    }

    #[test]
    fn archive_rejects_fifo_unix_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("fifo.zip");
        write_minimal_valid_zip(&zip_path);
        let mut bytes = fs::read(&zip_path).unwrap();
        // S_IFIFO = 0o010000
        patch_entry_unix_mode(&mut bytes, b"logs/app.log", 0o010777);
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics.iter().any(|d| d.code == "entry_non_regular"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn archive_rejects_chardev_and_socket_modes() {
        for (label, mode) in [("char", 0o020666u32), ("sock", 0o140777u32)] {
            let tmp = tempfile::tempdir().unwrap();
            let zip_path = tmp.path().join(format!("{label}.zip"));
            write_minimal_valid_zip(&zip_path);
            let mut bytes = fs::read(&zip_path).unwrap();
            patch_entry_unix_mode(&mut bytes, b"logs/app.log", mode);
            fs::write(&zip_path, &bytes).unwrap();
            let r = validate_archive(&zip_path);
            assert!(!r.ok, "{label} should fail: {:?}", r.diagnostics);
            assert!(
                r.diagnostics.iter().any(|d| d.code == "entry_non_regular"),
                "{label}: {:?}",
                r.diagnostics
            );
        }
    }

    #[test]
    fn archive_rejects_encrypted_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("enc.zip");
        write_minimal_valid_zip(&zip_path);
        let mut bytes = fs::read(&zip_path).unwrap();
        // Set general-purpose bit 0 (encrypted) in central header for logs/app.log.
        let central = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .find(|position| {
                let name_len =
                    u16::from_le_bytes([bytes[position + 28], bytes[position + 29]]) as usize;
                bytes.get(position + 46..position + 46 + name_len) == Some(b"logs/app.log")
            })
            .unwrap();
        let flags = u16::from_le_bytes([bytes[central + 8], bytes[central + 9]]) | 1;
        bytes[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
        // Also patch local header flags (signature PK\x03\x04).
        if let Some(local) = bytes.windows(4).enumerate().find_map(|(position, window)| {
            if window != b"PK\x03\x04" {
                return None;
            }
            let name_len =
                u16::from_le_bytes([bytes[position + 26], bytes[position + 27]]) as usize;
            (bytes.get(position + 30..position + 30 + name_len) == Some(b"logs/app.log"))
                .then_some(position)
        }) {
            let flags = u16::from_le_bytes([bytes[local + 6], bytes[local + 7]]) | 1;
            bytes[local + 6..local + 8].copy_from_slice(&flags.to_le_bytes());
        }
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics.iter().any(|d| d.code == "entry_encrypted"),
            "expected entry_encrypted, got {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn archive_rejects_absolute_backslash_and_drive_names() {
        for bad in ["/abs.log", "logs\\win.log", "C:/drive.log"] {
            let tmp = tempfile::tempdir().unwrap();
            let zip_path = tmp.path().join("badname.zip");
            {
                let f = File::create(&zip_path).unwrap();
                let mut z = ZipWriter::new(f);
                let opts =
                    SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
                z.start_file(bad, opts).unwrap();
                z.write_all(b"x").unwrap();
                z.start_file("manifest.json", opts).unwrap();
                z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                    .unwrap();
                z.finish().unwrap();
            }
            let r = validate_archive(&zip_path);
            assert!(!r.ok, "{bad} should fail");
            assert!(
                r.diagnostics.iter().any(|d| d.code == "unsafe_path"),
                "{bad}: {:?}",
                r.diagnostics
            );
        }
    }

    #[test]
    fn archive_rejects_portable_case_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("case.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            z.start_file("logs/App.log", opts).unwrap();
            z.write_all(b"a").unwrap();
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(b"b").unwrap();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            z.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "portable_name_collision"));
    }

    #[test]
    fn archive_rejects_file_dir_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("fd.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            z.start_file("logs", opts).unwrap();
            z.write_all(b"not a dir").unwrap();
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(b"x").unwrap();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            z.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "file_dir_collision"));
    }

    #[test]
    fn archive_rejects_missing_declared_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("missing.zip");
        let man = r#"{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"m",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{"name":"t","version":"1"},
  "privacy":{"redactionDeclared":true,"containsCredentials":false,"containsPii":false},
  "timeBasis":{"timezone":"UTC","timezoneResolved":true},
  "components":[{
    "id":"l","role":"log","path":"logs/missing.log","mediaType":"text/plain",
    "bytes":1,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }]
}"#;
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = pack_options();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(man.as_bytes()).unwrap();
            // deliberately omit logs/missing.log
            z.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "payload_missing"));
    }

    #[test]
    fn archive_rejects_byte_count_mismatch() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("bytes.zip");
        let log = fs::read(dir.join("logs/app.log")).unwrap();
        let mut man: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        man["components"][0]["bytes"] = serde_json::json!(99999);
        // keep correct hash of real content
        let man_bytes = serde_json::to_vec_pretty(&man).unwrap();
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = pack_options();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(&man_bytes).unwrap();
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(&log).unwrap();
            z.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "byte_count_mismatch"));
    }

    #[test]
    fn archive_rejects_too_many_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("many.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            for i in 0..=MAX_ARCHIVE_ENTRIES {
                z.start_file(format!("extra/{i}.txt"), opts).unwrap();
                z.write_all(b"x").unwrap();
            }
            z.finish().unwrap();
        }
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "too_many_entries" || d.code == "undeclared_payload"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn archive_rejects_excessive_expanded_bytes_on_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("huge.zip");
        write_minimal_valid_zip(&zip_path);
        let mut bytes = fs::read(&zip_path).unwrap();
        // Patch uncompressed size in central header for logs/app.log to MAX_PER_FILE+1.
        let central = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .find(|position| {
                let name_len =
                    u16::from_le_bytes([bytes[position + 28], bytes[position + 29]]) as usize;
                bytes.get(position + 46..position + 46 + name_len) == Some(b"logs/app.log")
            })
            .unwrap();
        let huge = (MAX_PER_FILE_BYTES + 1) as u32;
        // uncompressed size at offset 24 in central header
        bytes[central + 24..central + 28].copy_from_slice(&huge.to_le_bytes());
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "file_too_large" || d.code == "archive_open_failed"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn archive_rejects_compression_ratio_bomb() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("bomb.zip");
        // Create deflated entry with tiny compressed payload claiming huge expanded size.
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            // Highly compressible content
            let payload = vec![0u8; 10_000];
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(&payload).unwrap();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            z.finish().unwrap();
        }
        // Patch expanded size to be huge relative to compressed.
        let mut bytes = fs::read(&zip_path).unwrap();
        let central = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .find(|position| {
                let name_len =
                    u16::from_le_bytes([bytes[position + 28], bytes[position + 29]]) as usize;
                bytes.get(position + 46..position + 46 + name_len) == Some(b"logs/app.log")
            })
            .unwrap();
        // compressed size at offset 20, uncompressed at 24
        let compressed = u32::from_le_bytes([
            bytes[central + 20],
            bytes[central + 21],
            bytes[central + 22],
            bytes[central + 23],
        ]);
        let bomb_expanded = compressed
            .saturating_mul((MAX_COMPRESSION_RATIO as u32) + 2)
            .saturating_mul(RATIO_FLOOR_COMPRESSED as u32)
            .max(1_000_000);
        // Keep within u32 for non-zip64
        let bomb_expanded = bomb_expanded.min(u32::MAX - 1);
        bytes[central + 24..central + 28].copy_from_slice(&bomb_expanded.to_le_bytes());
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics.iter().any(|d| d.code == "compression_ratio"
                || d.code == "file_too_large"
                || d.code == "archive_open_failed"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn over_ratio_entry_is_rejected_without_payload_hashing() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("ratio-skip.zip");
        let payload = vec![0u8; 1024 * 1024];
        write_single_component_archive(
            &zip_path,
            "log",
            &payload,
            CompressionMethod::Deflated,
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        );

        let report = validate_archive(&zip_path);

        assert!(!report.ok);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "compression_ratio"),
            "{:?}",
            report.diagnostics
        );
        assert!(
            report.diagnostics.iter().all(|diagnostic| !matches!(
                diagnostic.code.as_str(),
                "hash_mismatch" | "hash_failed"
            )),
            "unsafe entry reached payload hashing: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn archive_payload_reader_stops_at_explicit_ceiling() {
        struct EndlessReader {
            observed: usize,
        }

        impl Read for EndlessReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer.fill(b'x');
                self.observed += buffer.len();
                Ok(buffer.len())
            }
        }

        let mut reader = EndlessReader { observed: 0 };
        let error = stream_sha256_reader_capturing(&mut reader, 31, None, false).unwrap_err();

        assert_eq!(error, "read bound exceeded (31)");
        assert_eq!(
            reader.observed, 32,
            "reader must receive at most ceiling + one detection byte"
        );
    }

    #[test]
    fn archive_rejects_case_insensitive_payload_sentinel_across_chunk_boundary() {
        for role in ["log", "readme"] {
            let tmp = tempfile::tempdir().unwrap();
            let zip_path = tmp.path().join(format!("{role}-sentinel.zip"));
            let mut payload = vec![b'x'; HASH_BUFFER_BYTES - 5];
            payload.extend_from_slice(b"EvAlUaToR_TrUtH expected diagnosis\n");
            write_single_component_archive(
                &zip_path,
                role,
                &payload,
                CompressionMethod::Stored,
                None,
            );

            let report = validate_archive(&zip_path);

            assert!(!report.ok);
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == "forbidden_sentinel" && diagnostic.path == "logs/app.log"
                }),
                "{role}: {:?}",
                report.diagnostics
            );
            assert!(
                report
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code != "hash_failed"),
                "{role}: sentinel scan must share the bounded hash pass: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn archive_rejects_truncated_central_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("trunc.zip");
        write_minimal_valid_zip(&zip_path);
        let bytes = fs::read(&zip_path).unwrap();
        // Chop off the end so EOCD is incomplete.
        let cut = bytes.len().saturating_sub(10);
        fs::write(&zip_path, &bytes[..cut]).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "archive_truncated" || d.code == "archive_open_failed"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn archive_rejects_multi_disk_eocd() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("multidisk.zip");
        write_minimal_valid_zip(&zip_path);
        let mut bytes = fs::read(&zip_path).unwrap();
        // Find EOCD and set disk number to 1.
        let eocd = bytes
            .windows(4)
            .rposition(|w| w == b"PK\x05\x06")
            .expect("eocd");
        bytes[eocd + 4] = 1;
        bytes[eocd + 5] = 0;
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "multi_disk_archive" || d.code == "archive_open_failed"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn pack_refuses_intermediate_dir_symlink() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("app.log"),
            b"2024-01-15T12:00:00Z INFO x\n",
        )
        .unwrap();
        let bundle = tempfile::tempdir().unwrap();
        let root = bundle.path();
        // First build a valid tree, then replace logs/ with symlink.
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("logs/app.log"), b"2024-01-15T12:00:00Z INFO x\n").unwrap();
        let (bytes, hex) = {
            let p = root.join("logs/app.log");
            (
                fs::metadata(&p).unwrap().len(),
                stream_sha256_hex(&p).unwrap(),
            )
        };
        let man = format!(
            r#"{{"schemaId":"contextdesk.incident_evidence.v1","minReaderVersion":1,"bundleId":"s","createdAt":"2024-01-15T12:00:00Z","producer":{{"name":"t","version":"1"}},"privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},"timeBasis":{{"timezone":"UTC","timezoneResolved":true}},"components":[{{"id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain","bytes":{bytes},"sha256":"{hex}"}}]}}"#
        );
        fs::write(root.join("manifest.json"), man).unwrap();
        assert!(validate_directory(root).ok);
        fs::remove_dir_all(root.join("logs")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("logs")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), root.join("logs")).unwrap();
        let out = root.join("out.zip");
        let err = pack_directory(root, &out, true).unwrap_err();
        assert!(
            err.iter()
                .any(|d| d.code == "symlink_refused" || d.code.contains("symlink")),
            "{err:?}"
        );
        assert!(!out.exists());
    }

    #[test]
    fn archive_rejects_duplicate_exact_names() {
        // ZipWriter may prevent exact dups; craft by concatenating is hard.
        // Two identical names: use ZipWriter with same name twice if allowed.
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("dup.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(b"a").unwrap();
            // Second start_file with same name — zip crate may error or overwrite.
            if z.start_file("logs/app.log", opts).is_ok() {
                z.write_all(b"b").unwrap();
            }
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(br#"{"schemaId":"contextdesk.incident_evidence.v1"}"#)
                .unwrap();
            z.finish().unwrap();
        }
        // If the crate collapsed dups, validation may only see one — still must not panic.
        let _ = validate_archive(&zip_path);
    }

    #[test]
    fn archive_rejects_central_local_flag_disagreement() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("disagree.zip");
        write_minimal_valid_zip(&zip_path);
        let mut bytes = fs::read(&zip_path).unwrap();
        // Set encryption only on local header for logs/app.log; leave central clear.
        if let Some(local) = bytes.windows(4).enumerate().find_map(|(position, window)| {
            if window != b"PK\x03\x04" {
                return None;
            }
            let name_len =
                u16::from_le_bytes([bytes[position + 26], bytes[position + 27]]) as usize;
            (bytes.get(position + 30..position + 30 + name_len) == Some(b"logs/app.log"))
                .then_some(position)
        }) {
            let flags = u16::from_le_bytes([bytes[local + 6], bytes[local + 7]]) | 1;
            bytes[local + 6..local + 8].copy_from_slice(&flags.to_le_bytes());
        }
        fs::write(&zip_path, &bytes).unwrap();
        let r = validate_archive(&zip_path);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "header_disagreement" || d.code == "entry_encrypted"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn pack_detects_same_size_source_mutation() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bundle");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::copy(
            valid_dir("minimal-log-only").join("manifest.json"),
            dir.join("manifest.json"),
        )
        .unwrap();
        fs::copy(
            valid_dir("minimal-log-only").join("logs/app.log"),
            dir.join("logs/app.log"),
        )
        .unwrap();
        let payload = dir.join("logs/app.log");
        let mut mutated = fs::read(&payload).unwrap();
        mutated[0] = if mutated[0] == b'X' { b'Y' } else { b'X' };
        let original_len = fs::metadata(&payload).unwrap().len();
        let out = tmp.path().join("m.zip");

        let error = pack_directory_with_before_write(&dir, &out, false, || {
            fs::write(&payload, &mutated).unwrap();
            assert_eq!(fs::metadata(&payload).unwrap().len(), original_len);
        })
        .unwrap_err();

        assert!(
            error
                .iter()
                .any(|diagnostic| diagnostic.code == "payload_identity_changed"),
            "{error:?}"
        );
        assert!(!out.exists());
        assert!(
            fs::read_dir(tmp.path())
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".m.zip.partial.")),
            "failed mutation pack must remove its unique partial"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pack_cannot_escape_after_intermediate_directory_swap() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("app.log"),
            b"outside payload that must never be packed\n",
        )
        .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bundle");
        fs::create_dir_all(dir.join("logs")).unwrap();
        fs::copy(
            valid_dir("minimal-log-only").join("manifest.json"),
            dir.join("manifest.json"),
        )
        .unwrap();
        fs::copy(
            valid_dir("minimal-log-only").join("logs/app.log"),
            dir.join("logs/app.log"),
        )
        .unwrap();
        let output = tmp.path().join("swapped.zip");
        let original = dir.join("logs-original");
        let active = dir.join("logs");

        let diagnostics = pack_directory_with_before_write(&dir, &output, false, || {
            fs::rename(&active, &original).unwrap();
            std::os::unix::fs::symlink(outside.path(), &active).unwrap();
        })
        .unwrap_err();

        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "symlink_escape"),
            "{diagnostics:?}"
        );
        assert!(!output.exists());
    }

    #[test]
    fn archive_report_root_is_redacted_filename_only() {
        let dir = valid_dir("minimal-log-only");
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("redact-me.zip");
        pack_directory(&dir, &zip_path, false).unwrap();
        let r = validate_archive(&zip_path);
        assert_eq!(r.root, "redact-me.zip");
        let text = crate::incident_evidence::format_report_text(&r);
        assert!(!text.contains("/Users/"));
        assert!(!text.contains("var/folders"));
    }

    /// Build a minimal valid directory, then mutate one manifest field and prove
    /// directory and archive transports emit the same diagnostic code.
    fn dir_and_archive_share_inventory_code(
        mutate: impl FnOnce(&mut serde_json::Value),
        code: &str,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs/app.log"), b"x\n").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let bytes = std::fs::metadata(root.join("logs/app.log")).unwrap().len();
        let mut man = serde_json::json!({
            "schemaId": "contextdesk.incident_evidence.v1",
            "minReaderVersion": 1,
            "bundleId": "parity",
            "createdAt": "2024-01-15T12:00:00Z",
            "producer": { "name": "t", "version": "1" },
            "privacy": {
                "redactionDeclared": true,
                "containsCredentials": false,
                "containsPii": false
            },
            "timeBasis": { "timezone": "UTC", "timezoneResolved": true },
            "components": [{
                "id": "l",
                "role": "log",
                "path": "logs/app.log",
                "mediaType": "text/plain",
                "bytes": bytes,
                "sha256": hex
            }]
        });
        mutate(&mut man);
        std::fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&man).unwrap(),
        )
        .unwrap();

        let dir_r = validate_directory(root);
        assert!(
            dir_r.diagnostics.iter().any(|d| d.code == code),
            "directory missing {code}: {:?}",
            dir_r.diagnostics
        );

        // Pack is blocked when directory invalid — hand-build zip from tree.
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("parity.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = pack_options();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(&std::fs::read(root.join("manifest.json")).unwrap())
                .unwrap();
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(b"x\n").unwrap();
            z.finish().unwrap();
        }
        let arch_r = validate_archive(&zip_path);
        assert!(
            arch_r.diagnostics.iter().any(|d| d.code == code),
            "archive missing {code}: {:?}",
            arch_r.diagnostics
        );
        assert!(!dir_r.ok && !arch_r.ok);
    }

    #[test]
    fn archive_and_directory_reject_empty_media_type() {
        dir_and_archive_share_inventory_code(
            |man| {
                man["components"][0]["mediaType"] = serde_json::json!("");
            },
            "media_type_empty",
        );
    }

    #[test]
    fn archive_and_directory_reject_non_json_metrics_media_type() {
        dir_and_archive_share_inventory_code(
            |man| {
                man["components"][0]["role"] = serde_json::json!("operational_metrics");
                man["components"][0]["mediaType"] = serde_json::json!("text/plain");
            },
            "metrics_media_type_invalid",
        );
    }

    #[test]
    fn archive_and_directory_reject_overlong_source_label() {
        dir_and_archive_share_inventory_code(
            |man| {
                man["components"][0]["sourceLabel"] = serde_json::json!("x".repeat(129));
            },
            "source_label_too_long",
        );
    }

    #[test]
    fn archive_and_directory_reject_absolute_lineage_note() {
        dir_and_archive_share_inventory_code(
            |man| {
                man["components"][0]["lineage"] = serde_json::json!({
                    "note": "/Users/secret/path"
                });
            },
            "lineage_absolute_path",
        );
    }

    #[test]
    fn archive_and_directory_reject_portable_case_collision() {
        dir_and_archive_share_inventory_code(
            |man| {
                let c0 = man["components"][0].clone();
                man["components"] = serde_json::json!([
                    c0,
                    {
                        "id": "l2",
                        "role": "log",
                        "path": "logs/App.log",
                        "mediaType": "text/plain",
                        "bytes": 2,
                        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    }
                ]);
            },
            "portable_path_collision",
        );
    }

    #[test]
    fn archive_rejects_created_at_without_offset_like_directory() {
        // Regression: archive form previously accepted createdAt without Z/offset
        // while directory form returned created_at_offset_required.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs/app.log"), b"x\n").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let bytes = std::fs::metadata(root.join("logs/app.log")).unwrap().len();
        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"no-offset",
  "createdAt":"2024-01-15T12:00:00",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[{{
    "id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain",
    "bytes":{bytes},"sha256":"{hex}"
  }}]
}}"#
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();
        let dir_r = validate_directory(root);
        assert!(
            dir_r
                .diagnostics
                .iter()
                .any(|d| d.code == "created_at_offset_required"),
            "directory: {:?}",
            dir_r.diagnostics
        );
        let tmp = tempfile::tempdir().unwrap();
        // Force-pack by temporarily writing a valid createdAt, packing is blocked by validate —
        // build zip manually with the bad manifest.
        let zip_path = tmp.path().join("bad-created.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = pack_options();
            z.start_file("manifest.json", opts).unwrap();
            z.write_all(
                std::fs::read(root.join("manifest.json"))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            z.start_file("logs/app.log", opts).unwrap();
            z.write_all(b"x\n").unwrap();
            z.finish().unwrap();
        }
        let arch_r = validate_archive(&zip_path);
        assert!(!arch_r.ok, "{:?}", arch_r.diagnostics);
        assert!(
            arch_r
                .diagnostics
                .iter()
                .any(|d| d.code == "created_at_offset_required"),
            "archive must match directory: {:?}",
            arch_r.diagnostics
        );
    }
}
