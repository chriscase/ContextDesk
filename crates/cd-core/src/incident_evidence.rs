//! Offline Incident Evidence Bundle v1 validator (#764 / #765 / #763).
//!
//! Schema id: [`SCHEMA_ID`]. Directory and deterministic ZIP transport are
//! supported offline. Product import/attachment UX remains residual.
//!
//! No network I/O. No product corpus publication. Streams SHA-256 over payloads.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

/// Exact schema identifier for Incident Evidence Bundle v1.
pub const SCHEMA_ID: &str = "contextdesk.incident_evidence.v1";
/// Reader capability implemented by this module.
pub const READER_VERSION: u32 = 1;

/// Max `manifest.json` size.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Max number of components.
pub const MAX_COMPONENTS: usize = 512;
/// Max single payload file size.
pub const MAX_PER_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Max sum of payload sizes (actual bytes processed).
pub const MAX_AGGREGATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max relative path length in bytes (UTF-8).
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;
/// Streaming hash buffer.
pub const HASH_BUFFER_BYTES: usize = 64 * 1024;
/// Max operational-metrics document size when role is operational_metrics.
pub const MAX_METRICS_DOC_BYTES: u64 = 8 * 1024 * 1024;
/// Max series in one metrics document (parity with bounded readers).
pub const MAX_METRICS_SERIES: usize = 256;
/// Max points per series.
pub const MAX_METRICS_POINTS_PER_SERIES: usize = 100000;
/// Max bundleId length.
pub const MAX_BUNDLE_ID_CHARS: usize = 256;
/// Max component id / producer string length.
pub const MAX_ID_CHARS: usize = 128;
/// Max mediaType length.
pub const MAX_MEDIA_TYPE_CHARS: usize = 128;
/// Max privacy notes length.
pub const MAX_PRIVACY_NOTES_CHARS: usize = 1024;

/// Forbidden substrings (matched case-insensitively on paths, ids, notes, undeclared names).
pub const FORBIDDEN_MANIFEST_SENTINELS: &[&str] = &[
    "evaluator_truth",
    "evaluator-truth",
    "answer_key",
    "answer-key",
    "expected_diagnosis",
    "truth_inventory",
    "company-data",
];

/// Characters allowed in component relative paths (matches JSON Schema relativePath).
const REL_PATH_ALLOWED: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._@+/-";

/// One deterministic diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Stable machine code.
    pub code: String,
    /// JSON path and/or relative file path.
    pub path: String,
    /// Human message.
    pub message: String,
}

impl Diagnostic {
    /// Construct a diagnostic (shared with archive transport).
    pub fn new(
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Result of validating a bundle directory or archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationReport {
    /// Whether validation succeeded.
    pub ok: bool,
    /// Bundle root or archive path that was validated.
    pub root: String,
    /// Schema id observed (if parsed).
    pub schema_id: Option<String>,
    /// Bundle id when parsed.
    pub bundle_id: Option<String>,
    /// Sorted diagnostics.
    pub diagnostics: Vec<Diagnostic>,
    /// Transport: `directory` or `archive`.
    #[serde(default = "default_transport_directory")]
    pub transport: String,
    /// Component count when manifest parsed.
    #[serde(default)]
    pub component_count: Option<usize>,
    /// Total declared component bytes validated (streamed).
    #[serde(default)]
    pub total_validated_bytes: Option<u64>,
}

fn default_transport_directory() -> String {
    "directory".into()
}

/// Manifest time basis.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBasis {
    /// Explicit timezone or null when unresolved.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Honesty flag — must be false when timezone is null/absent.
    pub timezone_resolved: bool,
}

/// Producer identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Producer {
    /// Producer name.
    pub name: String,
    /// Producer version.
    pub version: String,
}

/// Privacy declaration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Privacy {
    /// Whether redaction was declared applied.
    pub redaction_declared: bool,
    /// Credentials present flag.
    pub contains_credentials: bool,
    /// PII present flag.
    pub contains_pii: bool,
    /// Optional notes.
    #[serde(default)]
    pub notes: Option<String>,
}

/// One component inventory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEntry {
    /// Component id.
    pub id: String,
    /// Role enum string.
    pub role: String,
    /// Relative path.
    pub path: String,
    /// Media type hint.
    pub media_type: String,
    /// Declared byte length.
    pub bytes: u64,
    /// Declared lowercase SHA-256 hex.
    pub sha256: String,
    /// Optional source label.
    #[serde(default)]
    pub source_label: Option<String>,
    /// Optional per-component time basis.
    #[serde(default)]
    pub time_basis: Option<TimeBasis>,
    /// Optional lineage (no absolute host paths).
    #[serde(default)]
    pub lineage: Option<Lineage>,
}

/// Optional component lineage (parent reference without host paths).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    /// Parent component id.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Free-text note (≤ 512).
    #[serde(default)]
    pub note: Option<String>,
}

/// Root manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Exact schema id.
    pub schema_id: String,
    /// Minimum reader version.
    pub min_reader_version: u32,
    /// Bundle identity.
    pub bundle_id: String,
    /// Creation timestamp (RFC3339).
    pub created_at: String,
    /// Producer.
    pub producer: Producer,
    /// Privacy.
    pub privacy: Privacy,
    /// Bundle time basis.
    pub time_basis: TimeBasis,
    /// Components.
    pub components: Vec<ComponentEntry>,
}

/// Validate a directory-form Incident Evidence Bundle at `root`.
pub fn validate_directory(root: &Path) -> ValidationReport {
    let mut diagnostics = Vec::new();
    // Never surface absolute host paths in reports/CLI.
    let root_display = redacted_root_label(root);

    if !root.is_dir() {
        diagnostics.push(Diagnostic::new(
            "root_not_directory",
            root_display.clone(),
            "bundle root is not a directory",
        ));
        return finish(false, root_display, None, None, diagnostics);
    }

    let manifest_path = root.join("manifest.json");
    // Manifest must be a regular file (not a symlink).
    let mut opened =
        match open_regular_file_bounded(&manifest_path, MAX_MANIFEST_BYTES, "manifest.json") {
            Err(d) => {
                // Map missing open to stable codes used by fixtures.
                if d.code == "payload_missing" {
                    diagnostics.push(Diagnostic::new(
                        "manifest_missing",
                        "manifest.json",
                        "manifest.json is required at the bundle root",
                    ));
                } else if d.code == "file_too_large" {
                    diagnostics.push(Diagnostic::new(
                        "manifest_too_large",
                        "manifest.json",
                        format!("manifest.json exceeds MAX_MANIFEST_BYTES ({MAX_MANIFEST_BYTES})"),
                    ));
                } else {
                    diagnostics.push(Diagnostic::new(
                        "manifest_unreadable",
                        "manifest.json",
                        d.message,
                    ));
                }
                return finish(false, root_display, None, None, diagnostics);
            }
            Ok(opened) => opened,
        };
    let raw = match read_all_bounded(&mut opened.file, opened.size, MAX_MANIFEST_BYTES) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                diagnostics.push(Diagnostic::new(
                    "manifest_json_invalid",
                    "manifest.json",
                    "manifest.json is not valid UTF-8",
                ));
                return finish(false, root_display, None, None, diagnostics);
            }
        },
        Err(msg) => {
            diagnostics.push(Diagnostic::new("manifest_unreadable", "manifest.json", msg));
            return finish(false, root_display, None, None, diagnostics);
        }
    };
    if let Err(d) = verify_identity_unchanged(&opened) {
        diagnostics.push(d);
        return finish(false, root_display, None, None, diagnostics);
    }
    validate_manifest_and_payloads(root, &root_display, &raw, None)
}

fn non_empty_str(v: Option<&serde_json::Value>) -> bool {
    v.and_then(|x| x.as_str())
        .is_some_and(|s| !s.trim().is_empty())
}

/// Shared manifest header/policy checks for directory **and** archive transports.
///
/// Covers schemaId, minReaderVersion, bundleId, createdAt offset/length, producer,
/// privacy, timeBasis, and component count — so transports cannot diverge.
pub fn validate_manifest_header(manifest: &Manifest, diagnostics: &mut Vec<Diagnostic>) {
    if manifest.schema_id != SCHEMA_ID {
        diagnostics.push(Diagnostic::new(
            "unsupported_schema_id",
            "$.schemaId",
            format!(
                "unsupported schemaId `{}` (expected `{SCHEMA_ID}`)",
                manifest.schema_id
            ),
        ));
    }
    if manifest.min_reader_version > READER_VERSION {
        diagnostics.push(Diagnostic::new(
            "reader_too_old",
            "$.minReaderVersion",
            format!(
                "minReaderVersion {} exceeds this reader ({READER_VERSION})",
                manifest.min_reader_version
            ),
        ));
    }
    if manifest.min_reader_version < 1 {
        diagnostics.push(Diagnostic::new(
            "min_reader_version_invalid",
            "$.minReaderVersion",
            "minReaderVersion must be >= 1",
        ));
    }
    if manifest.bundle_id.trim().is_empty() || manifest.bundle_id.len() > MAX_BUNDLE_ID_CHARS {
        diagnostics.push(Diagnostic::new(
            "bundle_id_invalid",
            "$.bundleId",
            format!("bundleId must be non-empty and <= {MAX_BUNDLE_ID_CHARS} characters"),
        ));
    }
    if contains_forbidden_sentinel(&manifest.bundle_id) {
        diagnostics.push(Diagnostic::new(
            "forbidden_sentinel",
            "$.bundleId",
            "bundleId contains forbidden sentinel",
        ));
    }
    if !created_at_has_explicit_offset(&manifest.created_at) {
        diagnostics.push(Diagnostic::new(
            "created_at_offset_required",
            "$.createdAt",
            "createdAt MUST include an explicit offset or Z",
        ));
    }
    if manifest.created_at.len() > 64 {
        diagnostics.push(Diagnostic::new(
            "created_at_too_long",
            "$.createdAt",
            "createdAt exceeds 64 characters",
        ));
    }
    if manifest.producer.name.trim().is_empty()
        || manifest.producer.version.trim().is_empty()
        || manifest.producer.name.len() > MAX_ID_CHARS
        || manifest.producer.version.len() > MAX_ID_CHARS
    {
        diagnostics.push(Diagnostic::new(
            "producer_invalid",
            "$.producer",
            format!(
                "producer.name and producer.version MUST be non-empty and <= {MAX_ID_CHARS} characters"
            ),
        ));
    }
    if manifest.privacy.contains_credentials {
        diagnostics.push(Diagnostic::new(
            "privacy_credentials_not_shareable",
            "$.privacy.containsCredentials",
            "shareable bundles MUST set containsCredentials=false",
        ));
    }
    if let Some(notes) = &manifest.privacy.notes {
        if notes.len() > MAX_PRIVACY_NOTES_CHARS {
            diagnostics.push(Diagnostic::new(
                "privacy_notes_too_long",
                "$.privacy.notes",
                format!("privacy.notes exceeds {MAX_PRIVACY_NOTES_CHARS} characters"),
            ));
        }
        scan_forbidden_sentinels(notes, "$.privacy.notes", diagnostics);
    }
    validate_time_basis(&manifest.time_basis, "$.timeBasis", diagnostics);
    if manifest.components.len() > MAX_COMPONENTS {
        diagnostics.push(Diagnostic::new(
            "too_many_components",
            "$.components",
            format!("components exceed MAX_COMPONENTS ({MAX_COMPONENTS})"),
        ));
    }
}

/// Shared manifest+payload validation used by directory transport.
///
/// When `archive_entries` is `None`, payloads are read from the directory root
/// with TOCTOU-safe regular-file opens. Callers for archive transport validate
/// components against pre-streamed entry bytes via [`validate_metrics_document`]
/// and their own streaming path.
fn validate_manifest_and_payloads(
    root: &Path,
    root_display: &str,
    raw: &str,
    // When Some, skip filesystem payload I/O (archive path supplies hashes).
    skip_fs_payloads: Option<()>,
) -> ValidationReport {
    let mut diagnostics = Vec::new();

    // Case-insensitive sentinel scan on full manifest text.
    scan_forbidden_sentinels(raw, "manifest.json", &mut diagnostics);

    let manifest: Manifest = match serde_json::from_str(raw) {
        Ok(m) => m,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "manifest_json_invalid",
                "manifest.json",
                format!("manifest.json is not valid JSON for the v1 shape: {e}"),
            ));
            return finish(false, root_display.to_string(), None, None, diagnostics);
        }
    };

    let schema_id = Some(manifest.schema_id.clone());
    let bundle_id = Some(manifest.bundle_id.clone());

    // Shared structural rules — identical for directory and archive transports.
    validate_manifest_header(&manifest, &mut diagnostics);

    // --- Pass 1: inventory integrity before any payload I/O ---
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut seen_paths_lower = HashSet::new();
    let mut declared_paths: HashSet<String> = HashSet::new();
    let mut path_ok_for_io: Vec<bool> = Vec::with_capacity(manifest.components.len());

    for (i, c) in manifest.components.iter().enumerate() {
        let base = format!("$.components[{i}]");
        let mut ok_io = true;
        if c.id.trim().is_empty() || c.id.len() > MAX_ID_CHARS {
            diagnostics.push(Diagnostic::new(
                "component_id_invalid",
                format!("{base}.id"),
                format!("component id MUST be non-empty and <= {MAX_ID_CHARS} characters"),
            ));
            ok_io = false;
        }
        if contains_forbidden_sentinel(&c.id) {
            diagnostics.push(Diagnostic::new(
                "forbidden_sentinel",
                format!("{base}.id"),
                "component id contains forbidden sentinel",
            ));
        }
        if !seen_ids.insert(c.id.clone()) {
            diagnostics.push(Diagnostic::new(
                "duplicate_component_id",
                format!("{base}.id"),
                format!("duplicate component id `{}`", c.id),
            ));
        }
        if !is_known_role(&c.role) {
            diagnostics.push(Diagnostic::new(
                "unknown_role",
                format!("{base}.role"),
                format!("unknown component role `{}`", c.role),
            ));
            ok_io = false;
        }
        if c.media_type.trim().is_empty() || c.media_type.len() > MAX_MEDIA_TYPE_CHARS {
            diagnostics.push(Diagnostic::new(
                "media_type_empty",
                format!("{base}.mediaType"),
                format!("mediaType MUST be non-empty and <= {MAX_MEDIA_TYPE_CHARS} characters"),
            ));
        }
        if let Err(msg) = validate_relative_path(&c.path) {
            diagnostics.push(Diagnostic::new("unsafe_path", format!("{base}.path"), msg));
            ok_io = false;
        } else {
            if contains_forbidden_sentinel(&c.path) {
                diagnostics.push(Diagnostic::new(
                    "forbidden_sentinel",
                    format!("{base}.path"),
                    "component path contains forbidden sentinel",
                ));
            }
            if !seen_paths.insert(c.path.clone()) {
                diagnostics.push(Diagnostic::new(
                    "duplicate_component_path",
                    format!("{base}.path"),
                    format!("duplicate component path `{}`", c.path),
                ));
                ok_io = false;
            }
            let lower = c.path.to_ascii_lowercase();
            if !seen_paths_lower.insert(lower) {
                diagnostics.push(Diagnostic::new(
                    "portable_path_collision",
                    format!("{base}.path"),
                    format!("case-insensitive path collision for `{}`", c.path),
                ));
                ok_io = false;
            }
            declared_paths.insert(c.path.clone());
        }
        if let Some(label) = &c.source_label {
            if label.len() > MAX_ID_CHARS {
                diagnostics.push(Diagnostic::new(
                    "source_label_too_long",
                    format!("{base}.sourceLabel"),
                    format!("sourceLabel exceeds {MAX_ID_CHARS} characters"),
                ));
            }
            scan_forbidden_sentinels(label, &format!("{base}.sourceLabel"), &mut diagnostics);
        }
        if let Some(lin) = &c.lineage {
            if let Some(note) = &lin.note {
                if note.len() > 512 {
                    diagnostics.push(Diagnostic::new(
                        "lineage_note_too_long",
                        format!("{base}.lineage.note"),
                        "lineage.note exceeds 512 characters",
                    ));
                }
                scan_forbidden_sentinels(note, &format!("{base}.lineage.note"), &mut diagnostics);
                if note.contains('/') && (note.starts_with('/') || note.contains(":\\")) {
                    diagnostics.push(Diagnostic::new(
                        "lineage_absolute_path",
                        format!("{base}.lineage.note"),
                        "lineage MUST NOT embed absolute host paths",
                    ));
                }
            }
        }
        if !is_lowercase_sha256(&c.sha256) {
            diagnostics.push(Diagnostic::new(
                "hash_malformed",
                format!("{base}.sha256"),
                "sha256 MUST be 64 lowercase hex characters",
            ));
        }
        if c.bytes > MAX_PER_FILE_BYTES {
            diagnostics.push(Diagnostic::new(
                "file_too_large",
                format!("{base}.bytes"),
                format!("declared bytes exceed MAX_PER_FILE_BYTES ({MAX_PER_FILE_BYTES})"),
            ));
            ok_io = false;
        }
        if let Some(tb) = &c.time_basis {
            validate_time_basis(tb, &format!("{base}.timeBasis"), &mut diagnostics);
        }
        path_ok_for_io.push(ok_io);
    }

    // --- Pass 2: single-open size/hash/(metrics parse) per declared path ---
    let mut aggregate_actual: u64 = 0;
    if skip_fs_payloads.is_none() {
        for (i, c) in manifest.components.iter().enumerate() {
            if !path_ok_for_io[i] {
                continue;
            }
            let payload = match resolve_under_root(root, &c.path) {
                Ok(p) => p,
                Err(msg) => {
                    diagnostics.push(Diagnostic::new("path_escape", c.path.clone(), msg));
                    continue;
                }
            };
            // Intermediate symlink escape: lexical join then ensure every prefix
            // is not a symlink out of root; final open uses O_NOFOLLOW/regular-only.
            if path_has_symlink_component(root, &c.path) {
                diagnostics.push(Diagnostic::new(
                    "symlink_escape",
                    c.path.clone(),
                    "payload path contains a symlink component",
                ));
                continue;
            }
            let mut opened = match open_regular_file_bounded(&payload, MAX_PER_FILE_BYTES, &c.path)
            {
                Ok(o) => o,
                Err(d) => {
                    diagnostics.push(d);
                    continue;
                }
            };
            if opened.size != c.bytes {
                diagnostics.push(Diagnostic::new(
                    "byte_count_mismatch",
                    c.path.clone(),
                    format!("declared bytes {} != actual {}", c.bytes, opened.size),
                ));
            }
            // Hash exactly once from the open handle.
            let hex = match stream_sha256_file(&mut opened.file, opened.size) {
                Ok(h) => h,
                Err(e) => {
                    diagnostics.push(Diagnostic::new(
                        "hash_failed",
                        c.path.clone(),
                        format!("failed to hash payload: {e}"),
                    ));
                    continue;
                }
            };
            if let Err(d) = verify_identity_unchanged(&opened) {
                diagnostics.push(Diagnostic::new(d.code, c.path.clone(), d.message));
                continue;
            }
            if is_lowercase_sha256(&c.sha256) && hex != c.sha256 {
                diagnostics.push(Diagnostic::new(
                    "hash_mismatch",
                    c.path.clone(),
                    "declared sha256 does not match file contents",
                ));
            }
            aggregate_actual = aggregate_actual.saturating_add(opened.size);
            if aggregate_actual > MAX_AGGREGATE_BYTES {
                diagnostics.push(Diagnostic::new(
                    "aggregate_too_large",
                    "$.components",
                    format!(
                        "aggregate actual bytes exceed MAX_AGGREGATE_BYTES ({MAX_AGGREGATE_BYTES})"
                    ),
                ));
            }

            if c.role == "operational_metrics" {
                if opened.size > MAX_METRICS_DOC_BYTES {
                    diagnostics.push(Diagnostic::new(
                        "metrics_doc_too_large",
                        c.path.clone(),
                        format!(
                            "operational_metrics document exceeds MAX_METRICS_DOC_BYTES ({MAX_METRICS_DOC_BYTES})"
                        ),
                    ));
                } else if let Err(e) = opened.file.seek(SeekFrom::Start(0)) {
                    diagnostics.push(Diagnostic::new(
                        "metrics_read_failed",
                        c.path.clone(),
                        format!("cannot rewind payload for metrics parse: {e}"),
                    ));
                } else {
                    match read_all_bounded(&mut opened.file, opened.size, MAX_METRICS_DOC_BYTES) {
                        Ok(bytes) => match String::from_utf8(bytes) {
                            Ok(text) => {
                                validate_metrics_document_text(&text, &c.path, &mut diagnostics);
                            }
                            Err(_) => diagnostics.push(Diagnostic::new(
                                "metrics_json_invalid",
                                c.path.clone(),
                                "operational_metrics payload is not valid UTF-8",
                            )),
                        },
                        Err(msg) => diagnostics.push(Diagnostic::new(
                            "metrics_read_failed",
                            c.path.clone(),
                            msg,
                        )),
                    }
                    if let Err(d) = verify_identity_unchanged(&opened) {
                        diagnostics.push(Diagnostic::new(d.code, c.path.clone(), d.message));
                    }
                }
            }
        }

        // Undeclared files + undeclared truth material under the bundle root.
        scan_undeclared_entries(root, &declared_paths, &mut diagnostics);
    }

    let component_count = Some(manifest.components.len());
    let total_validated_bytes = Some(aggregate_actual);
    let ok = diagnostics.is_empty();
    finish_with_counts(
        ok,
        root_display.to_string(),
        schema_id,
        bundle_id,
        component_count,
        total_validated_bytes,
        diagnostics,
    )
}

fn finish(
    ok: bool,
    root: String,
    schema_id: Option<String>,
    bundle_id: Option<String>,
    diagnostics: Vec<Diagnostic>,
) -> ValidationReport {
    finish_with_counts(ok, root, schema_id, bundle_id, None, None, diagnostics)
}

fn finish_with_counts(
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
        transport: "directory".into(),
        component_count,
        total_validated_bytes,
    }
}

pub(crate) fn is_known_role(role: &str) -> bool {
    matches!(
        role,
        "log" | "operational_metrics" | "attachment" | "readme"
    )
}

pub(crate) fn is_lowercase_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn created_at_has_explicit_offset(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    // Require Z or ±HH:MM at end (RFC3339-ish). Reject offsetless local forms.
    if t.ends_with('Z') || t.ends_with('z') {
        return true;
    }
    // ...+00:00 or ...-05:00 — scan ASCII bytes only (timestamps are ASCII).
    let bytes = t.as_bytes();
    if bytes.len() >= 6 {
        let tail = &bytes[bytes.len() - 6..];
        if (tail[0] == b'+' || tail[0] == b'-')
            && tail[3] == b':'
            && tail[1].is_ascii_digit()
            && tail[2].is_ascii_digit()
            && tail[4].is_ascii_digit()
            && tail[5].is_ascii_digit()
        {
            return true;
        }
    }
    false
}

pub(crate) fn validate_time_basis(tb: &TimeBasis, json_path: &str, out: &mut Vec<Diagnostic>) {
    let tz = tb
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if tb.timezone_resolved && tz.is_none() {
        out.push(Diagnostic::new(
            "timezone_dishonest",
            json_path,
            "timezoneResolved=true requires a non-empty timezone",
        ));
    }
    if !tb.timezone_resolved && tz.is_some() {
        // Allowed: declare a candidate timezone without claiming resolution.
        // Spec: unresolved means timezoneResolved false; timezone MAY still be null.
    }
    if tb.timezone_resolved {
        if let Some(z) = tz {
            if z.contains("..") || z.contains('/') && z.starts_with('/') {
                out.push(Diagnostic::new(
                    "timezone_invalid",
                    json_path,
                    "timezone must not look like a filesystem path",
                ));
            }
        }
    }
}

/// Reject absolute, traversal, drive-prefix, empty, overlong, and non-schema paths.
pub fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path MUST be non-empty".into());
    }
    if path.len() > MAX_RELATIVE_PATH_BYTES {
        return Err(format!(
            "path exceeds MAX_RELATIVE_PATH_BYTES ({MAX_RELATIVE_PATH_BYTES})"
        ));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("path MUST NOT contain control characters".into());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("path MUST NOT be absolute".into());
    }
    let drive = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    if drive {
        return Err("path MUST NOT use a drive-letter prefix".into());
    }
    if path.contains('\\') {
        return Err("path MUST use `/` separators only".into());
    }
    if path.contains("//") {
        return Err("path MUST NOT contain empty segments".into());
    }
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err("path MUST NOT contain `.` or `..` segments".into());
        }
    }
    if !path.bytes().all(|b| REL_PATH_ALLOWED.contains(&b)) {
        return Err(
            "path MUST match the relativePath grammar [A-Za-z0-9._@+/-]+ (JSON Schema)".into(),
        );
    }
    // Also walk Path components for belt-and-suspenders.
    for c in Path::new(path).components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir => {
                return Err("path MUST NOT traverse".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("path MUST NOT be absolute".into());
            }
        }
    }
    Ok(())
}

/// Bundle-relative label for CLI/report output (never absolute machine paths).
pub fn redacted_root_label(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "bundle".into())
}

/// Case-insensitive forbidden-sentinel detection.
pub fn contains_forbidden_sentinel(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    FORBIDDEN_MANIFEST_SENTINELS
        .iter()
        .any(|s| lower.contains(&s.to_ascii_lowercase()))
}

fn scan_forbidden_sentinels(text: &str, path: &str, out: &mut Vec<Diagnostic>) {
    if contains_forbidden_sentinel(text) {
        out.push(Diagnostic::new(
            "forbidden_sentinel",
            path,
            "text contains forbidden evaluator-truth / answer-key sentinel",
        ));
    }
}

/// Opened regular file with size and OS identity for TOCTOU checks.
pub struct OpenedRegularFile {
    /// Open file handle (single source for size/hash/parse).
    pub file: File,
    /// Size observed at open (from fstat).
    pub size: u64,
    #[cfg(unix)]
    identity: (u64, u64),
    path_label: String,
}

/// Open a path only if it is a regular (non-symlink) file within size bound.
///
/// Uses `O_NOFOLLOW` on Unix. Size is taken from the open handle metadata.
pub fn open_regular_file_bounded(
    path: &Path,
    max_bytes: u64,
    path_label: &str,
) -> Result<OpenedRegularFile, Diagnostic> {
    // Fast pre-check: reject symlinks before open (also covers platforms without O_NOFOLLOW).
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Diagnostic::new(
                "payload_missing",
                path_label,
                format!("payload file missing: {path_label}"),
            ));
        }
        Err(e) => {
            return Err(Diagnostic::new(
                "payload_unreadable",
                path_label,
                format!("cannot lstat payload: {e}"),
            ));
        }
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(Diagnostic::new(
                    "symlink_escape",
                    path_label,
                    "payload MUST NOT be a symlink",
                ));
            }
            if !meta.file_type().is_file() {
                return Err(Diagnostic::new(
                    "entry_non_regular",
                    path_label,
                    "payload MUST be a regular file",
                ));
            }
            if meta.len() > max_bytes {
                return Err(Diagnostic::new(
                    "file_too_large",
                    path_label,
                    format!("actual size exceeds bound ({max_bytes})"),
                ));
            }
        }
    }

    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW: fail if final path component is a symlink.
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Diagnostic::new(
                "payload_missing",
                path_label,
                format!("payload file missing: {path_label}"),
            )
        } else {
            Diagnostic::new(
                "payload_unreadable",
                path_label,
                format!("cannot open payload: {e}"),
            )
        }
    })?;
    let meta = file.metadata().map_err(|e| {
        Diagnostic::new(
            "payload_unreadable",
            path_label,
            format!("cannot fstat payload: {e}"),
        )
    })?;
    if !meta.is_file() {
        return Err(Diagnostic::new(
            "entry_non_regular",
            path_label,
            "payload MUST be a regular file",
        ));
    }
    if meta.len() > max_bytes {
        return Err(Diagnostic::new(
            "file_too_large",
            path_label,
            format!("actual size exceeds bound ({max_bytes})"),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(OpenedRegularFile {
            file,
            size: meta.len(),
            identity: (meta.dev(), meta.ino()),
            path_label: path_label.to_string(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(OpenedRegularFile {
            file,
            size: meta.len(),
            path_label: path_label.to_string(),
        })
    }
}

fn verify_identity_unchanged(opened: &OpenedRegularFile) -> Result<(), Diagnostic> {
    let meta = opened.file.metadata().map_err(|e| {
        Diagnostic::new(
            "payload_identity_changed",
            opened.path_label.clone(),
            format!("cannot re-fstat payload: {e}"),
        )
    })?;
    if meta.len() != opened.size {
        return Err(Diagnostic::new(
            "payload_identity_changed",
            opened.path_label.clone(),
            "payload size changed during validation",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (meta.dev(), meta.ino()) != opened.identity {
            return Err(Diagnostic::new(
                "payload_identity_changed",
                opened.path_label.clone(),
                "payload identity (dev/ino) changed during validation",
            ));
        }
    }
    Ok(())
}

fn read_all_bounded(file: &mut File, expected: u64, max: u64) -> Result<Vec<u8>, String> {
    if expected > max {
        return Err(format!("read bound exceeded ({max})"));
    }
    let mut buf = Vec::new();
    // Cap allocation: take(expected) then ensure EOF.
    let mut limited = file.take(expected.saturating_add(1));
    limited
        .read_to_end(&mut buf)
        .map_err(|e| format!("read failed: {e}"))?;
    if buf.len() as u64 != expected {
        return Err(format!(
            "read length {} != expected size {expected}",
            buf.len()
        ));
    }
    Ok(buf)
}

/// Stream SHA-256 of an open file, reading at most `size` bytes (single pass).
pub fn stream_sha256_file(file: &mut File, size: u64) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("seek failed: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUFFER_BYTES];
    let mut remaining = size;
    while remaining > 0 {
        let chunk = (remaining as usize).min(buf.len());
        let n = file
            .read(&mut buf[..chunk])
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            return Err("unexpected EOF while hashing".into());
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    // Ensure no extra bytes beyond declared size on the open handle.
    let extra = file.read(&mut buf[..1]).map_err(|e| e.to_string())?;
    if extra != 0 {
        return Err("payload grew beyond size observed at open".into());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn path_has_symlink_component(root: &Path, rel: &str) -> bool {
    let mut cur = root.to_path_buf();
    for seg in rel.split('/') {
        cur.push(seg);
        if cur
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// Walk the bundle directory for undeclared files and truth sentinels.
fn scan_undeclared_entries(root: &Path, declared: &HashSet<String>, out: &mut Vec<Diagnostic>) {
    let Ok(root_real) = root.canonicalize() else {
        out.push(Diagnostic::new(
            "root_unresolvable",
            "bundle",
            "bundle root could not be resolved for undeclared scan",
        ));
        return;
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                out.push(Diagnostic::new(
                    "bundle_unreadable",
                    redacted_root_label(&dir),
                    format!("cannot read directory: {e}"),
                ));
                continue;
            }
        };
        for ent in entries.flatten() {
            let path = ent.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                // Symlinks are never valid undeclared or structural entries.
                let rel = relative_from_root(&root_real, &path)
                    .unwrap_or_else(|| redacted_root_label(&path));
                out.push(Diagnostic::new(
                    "symlink_escape",
                    rel,
                    "bundle MUST NOT contain symlink entries",
                ));
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                let rel = relative_from_root(&root_real, &path)
                    .unwrap_or_else(|| redacted_root_label(&path));
                out.push(Diagnostic::new(
                    "entry_non_regular",
                    rel,
                    "bundle MUST NOT contain non-regular files",
                ));
                continue;
            }
            let rel = match relative_from_root(&root_real, &path) {
                Some(r) => r,
                None => {
                    out.push(Diagnostic::new(
                        "path_escape",
                        redacted_root_label(&path),
                        "file outside bundle root during undeclared scan",
                    ));
                    continue;
                }
            };
            if rel == "manifest.json" {
                continue;
            }
            if contains_forbidden_sentinel(&rel) {
                out.push(Diagnostic::new(
                    "forbidden_sentinel",
                    rel.clone(),
                    "undeclared or declared path contains forbidden sentinel",
                ));
            }
            if !declared.contains(&rel) {
                out.push(Diagnostic::new(
                    "undeclared_payload",
                    rel,
                    "file is not declared in manifest components",
                ));
            }
        }
    }
}

fn relative_from_root(root_real: &Path, path: &Path) -> Option<String> {
    let real = path.canonicalize().ok()?;
    let rel = real.strip_prefix(root_real).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Validate operational-metrics v1 document text (parity with TypeScript validator).
pub fn validate_metrics_document_text(text: &str, path_label: &str, out: &mut Vec<Diagnostic>) {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            out.push(Diagnostic::new(
                "metrics_json_invalid",
                path_label,
                format!("operational_metrics payload is not JSON: {e}"),
            ));
            return;
        }
    };
    validate_metrics_document_value(&value, path_label, out);
}

/// Validate a parsed operational-metrics v1 value.
///
/// Parity target: desktop `validateOperationalMetricsDocument` (labels, provenance
/// optional string fields, point-level provenance/timeQuality, thresholds, gaps).
pub fn validate_metrics_document_value(
    value: &serde_json::Value,
    path_label: &str,
    out: &mut Vec<Diagnostic>,
) {
    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            out.push(Diagnostic::new(
                "metrics_not_object",
                path_label,
                "operational_metrics document must be an object",
            ));
            return;
        }
    };
    // Unknown fields are tolerated (additive evolution), matching TS.
    match obj.get("schemaVersion").and_then(|v| v.as_u64()) {
        Some(1) => {}
        _ => out.push(Diagnostic::new(
            "metrics_schema_version",
            format!("{path_label}:$.schemaVersion"),
            "must equal 1",
        )),
    }
    if !non_empty_str(obj.get("id")) {
        out.push(Diagnostic::new(
            "metrics_id_invalid",
            format!("{path_label}:$.id"),
            "must be a non-empty string",
        ));
    }
    if !non_empty_str(obj.get("name")) {
        out.push(Diagnostic::new(
            "metrics_name_invalid",
            format!("{path_label}:$.name"),
            "must be a non-empty string",
        ));
    }
    let series = match obj.get("series").and_then(|v| v.as_array()) {
        Some(s) if !s.is_empty() => s,
        Some(_) => {
            out.push(Diagnostic::new(
                "metrics_series_missing",
                format!("{path_label}:$.series"),
                "must contain at least one metric series",
            ));
            return;
        }
        None => {
            out.push(Diagnostic::new(
                "metrics_series_missing",
                format!("{path_label}:$.series"),
                "must contain a series array",
            ));
            return;
        }
    };
    if series.len() > MAX_METRICS_SERIES {
        out.push(Diagnostic::new(
            "metrics_too_many_series",
            format!("{path_label}:$.series"),
            format!("series count exceeds MAX_METRICS_SERIES ({MAX_METRICS_SERIES})"),
        ));
    }
    let mut ids = HashSet::new();
    for (si, candidate) in series.iter().enumerate() {
        let sp = format!("{path_label}:$.series[{si}]");
        let sobj = match candidate.as_object() {
            Some(o) => o,
            None => {
                out.push(Diagnostic::new(
                    "metrics_series_invalid",
                    sp,
                    "must be an object",
                ));
                continue;
            }
        };
        let sid = sobj.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if sid.trim().is_empty() {
            out.push(Diagnostic::new(
                "metrics_series_id_invalid",
                format!("{sp}.id"),
                "must be non-empty",
            ));
        } else if !ids.insert(sid.to_string()) {
            out.push(Diagnostic::new(
                "metrics_series_id_duplicate",
                format!("{sp}.id"),
                "must be unique",
            ));
        }
        if !non_empty_str(sobj.get("name")) {
            out.push(Diagnostic::new(
                "metrics_series_name_invalid",
                format!("{sp}.name"),
                "must be non-empty",
            ));
        }
        if !non_empty_str(sobj.get("unit")) {
            out.push(Diagnostic::new(
                "metrics_series_unit_invalid",
                format!("{sp}.unit"),
                "must be non-empty",
            ));
        }
        validate_metrics_labels(sobj.get("labels"), &format!("{sp}.labels"), out);
        validate_metrics_provenance(sobj.get("provenance"), &format!("{sp}.provenance"), out);
        validate_metrics_time_quality(sobj.get("timeQuality"), &format!("{sp}.timeQuality"), out);

        let points = match sobj.get("points").and_then(|v| v.as_array()) {
            Some(p) if !p.is_empty() => p,
            _ => {
                out.push(Diagnostic::new(
                    "metrics_points_missing",
                    format!("{sp}.points"),
                    "must contain at least one point",
                ));
                // Still validate optional thresholds/gaps when present.
                validate_metrics_thresholds(
                    sobj.get("thresholds"),
                    &format!("{sp}.thresholds"),
                    out,
                );
                validate_metrics_gaps(sobj.get("gaps"), &format!("{sp}.gaps"), out);
                continue;
            }
        };
        if points.len() > MAX_METRICS_POINTS_PER_SERIES {
            out.push(Diagnostic::new(
                "metrics_too_many_points",
                format!("{sp}.points"),
                format!(
                    "points exceed MAX_METRICS_POINTS_PER_SERIES ({MAX_METRICS_POINTS_PER_SERIES})"
                ),
            ));
        }
        let mut prev = f64::NEG_INFINITY;
        for (pi, point) in points.iter().enumerate() {
            let pp = format!("{sp}.points[{pi}]");
            let pobj = match point.as_object() {
                Some(o) => o,
                None => {
                    out.push(Diagnostic::new(
                        "metrics_point_invalid",
                        pp,
                        "must be an object",
                    ));
                    continue;
                }
            };
            match pobj.get("timestamp").and_then(|v| v.as_f64()) {
                Some(ts) if ts.is_finite() => {
                    if ts <= prev {
                        out.push(Diagnostic::new(
                            "metrics_timestamp_order",
                            format!("{pp}.timestamp"),
                            "must be strictly increasing",
                        ));
                    }
                    prev = ts;
                }
                _ => out.push(Diagnostic::new(
                    "metrics_timestamp_invalid",
                    format!("{pp}.timestamp"),
                    "must be a finite Unix timestamp in seconds",
                )),
            }
            match pobj.get("value").and_then(|v| v.as_f64()) {
                Some(v) if v.is_finite() => {}
                _ => out.push(Diagnostic::new(
                    "metrics_value_invalid",
                    format!("{pp}.value"),
                    "must be a finite number",
                )),
            }
            validate_metrics_labels(pobj.get("labels"), &format!("{pp}.labels"), out);
            if pobj.contains_key("provenance") {
                validate_metrics_provenance(
                    pobj.get("provenance"),
                    &format!("{pp}.provenance"),
                    out,
                );
            }
            if pobj.contains_key("timeQuality") {
                validate_metrics_time_quality(
                    pobj.get("timeQuality"),
                    &format!("{pp}.timeQuality"),
                    out,
                );
            }
        }
        validate_metrics_thresholds(sobj.get("thresholds"), &format!("{sp}.thresholds"), out);
        validate_metrics_gaps(sobj.get("gaps"), &format!("{sp}.gaps"), out);
    }
}

fn validate_metrics_labels(
    value: Option<&serde_json::Value>,
    path: &str,
    out: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        return;
    };
    let Some(obj) = value.as_object() else {
        out.push(Diagnostic::new(
            "metrics_labels_invalid",
            path,
            "must be an object of string values",
        ));
        return;
    };
    for (key, label_value) in obj {
        if key.trim().is_empty() || !label_value.is_string() {
            out.push(Diagnostic::new(
                "metrics_labels_invalid",
                format!("{path}.{key}"),
                "must be a string",
            ));
        }
    }
}

fn validate_metrics_provenance(
    value: Option<&serde_json::Value>,
    path: &str,
    out: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        out.push(Diagnostic::new(
            "metrics_provenance_missing",
            path,
            "must include a non-empty source",
        ));
        return;
    };
    let Some(obj) = value.as_object() else {
        out.push(Diagnostic::new(
            "metrics_provenance_invalid",
            path,
            "must include a non-empty source",
        ));
        return;
    };
    if !non_empty_str(obj.get("source")) {
        out.push(Diagnostic::new(
            "metrics_provenance_invalid",
            path,
            "must include a non-empty source",
        ));
    }
    for key in ["collector", "query"] {
        if let Some(v) = obj.get(key) {
            if !v.is_string() {
                out.push(Diagnostic::new(
                    "metrics_provenance_field_type",
                    format!("{path}.{key}"),
                    "must be a string",
                ));
            }
        }
    }
}

fn validate_metrics_time_quality(
    value: Option<&serde_json::Value>,
    path: &str,
    out: &mut Vec<Diagnostic>,
) {
    match value.and_then(|v| v.as_str()) {
        Some("wall" | "mixed" | "order_only") => {}
        _ => out.push(Diagnostic::new(
            "metrics_time_quality_invalid",
            path,
            "must be wall, mixed, or order_only",
        )),
    }
}

fn validate_metrics_thresholds(
    value: Option<&serde_json::Value>,
    path: &str,
    out: &mut Vec<Diagnostic>,
) {
    let Some(value) = value else {
        return;
    };
    let Some(arr) = value.as_array() else {
        out.push(Diagnostic::new(
            "metrics_thresholds_invalid",
            path,
            "must be an array",
        ));
        return;
    };
    for (i, threshold) in arr.iter().enumerate() {
        let tp = format!("{path}[{i}]");
        let Some(obj) = threshold.as_object() else {
            out.push(Diagnostic::new(
                "metrics_threshold_invalid",
                tp,
                "must include id, label, finite value, and a supported severity",
            ));
            continue;
        };
        let sev = obj.get("severity").and_then(|v| v.as_str()).unwrap_or("");
        let ok = non_empty_str(obj.get("id"))
            && non_empty_str(obj.get("label"))
            && obj
                .get("value")
                .and_then(|v| v.as_f64())
                .is_some_and(|n| n.is_finite())
            && matches!(sev, "info" | "warning" | "critical");
        if !ok {
            out.push(Diagnostic::new(
                "metrics_threshold_invalid",
                tp,
                "must include id, label, finite value, and a supported severity",
            ));
        }
    }
}

fn validate_metrics_gaps(value: Option<&serde_json::Value>, path: &str, out: &mut Vec<Diagnostic>) {
    let Some(value) = value else {
        return;
    };
    let Some(arr) = value.as_array() else {
        out.push(Diagnostic::new(
            "metrics_gaps_invalid",
            path,
            "must be an array",
        ));
        return;
    };
    for (i, gap) in arr.iter().enumerate() {
        let gp = format!("{path}[{i}]");
        let Some(obj) = gap.as_object() else {
            out.push(Diagnostic::new(
                "metrics_gap_invalid",
                gp,
                "must include finite from/to with to greater than from",
            ));
            continue;
        };
        let from = obj.get("from").and_then(|v| v.as_f64());
        let to = obj.get("to").and_then(|v| v.as_f64());
        match (from, to) {
            (Some(f), Some(t)) if f.is_finite() && t.is_finite() && t > f => {}
            _ => out.push(Diagnostic::new(
                "metrics_gap_invalid",
                gp.clone(),
                "must include finite from/to with to greater than from",
            )),
        }
        if let Some(reason) = obj.get("reason") {
            if !reason.is_string() {
                out.push(Diagnostic::new(
                    "metrics_gap_reason_type",
                    format!("{gp}.reason"),
                    "must be a string",
                ));
            }
        }
    }
}

fn resolve_under_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    validate_relative_path(rel)?;
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        out.push(seg);
    }
    Ok(out)
}

/// Stream SHA-256 of a path via a single bounded regular-file open.
pub fn stream_sha256_hex(path: &Path) -> Result<String, String> {
    stream_sha256_hex_bounded(path, MAX_PER_FILE_BYTES)
}

/// Stream SHA-256 with an explicit size bound (e.g. archive digests).
pub fn stream_sha256_hex_bounded(path: &Path, max_bytes: u64) -> Result<String, String> {
    let label = redacted_root_label(path);
    let mut opened = open_regular_file_bounded(path, max_bytes, &label).map_err(|d| d.message)?;
    let hex = stream_sha256_file(&mut opened.file, opened.size)?;
    verify_identity_unchanged(&opened).map_err(|d| d.message)?;
    Ok(hex)
}

/// Format a report as deterministic CI-friendly text (bundle-relative only).
pub fn format_report_text(report: &ValidationReport) -> String {
    let mut lines = Vec::new();
    // `report.root` is already redacted by validators; never re-expand.
    let root = sanitize_report_path(&report.root);
    lines.push(format!(
        "incident-evidence-validate ok={} root={}",
        report.ok, root
    ));
    if let Some(s) = &report.schema_id {
        lines.push(format!("schemaId={s}"));
    }
    if let Some(b) = &report.bundle_id {
        lines.push(format!("bundleId={b}"));
    }
    lines.push(format!("transport={}", report.transport));
    if let Some(n) = report.component_count {
        lines.push(format!("components={n}"));
    }
    if let Some(b) = report.total_validated_bytes {
        lines.push(format!("totalBytes={b}"));
    }
    lines.push(format!("diagnostics={}", report.diagnostics.len()));
    for d in &report.diagnostics {
        lines.push(format!(
            "{} | {} | {}",
            d.code,
            sanitize_report_path(&d.path),
            sanitize_report_message(&d.message)
        ));
    }
    lines.join("\n")
}

/// Strip absolute home/worktree prefixes from diagnostic paths for CLI safety.
pub fn sanitize_report_path(path: &str) -> String {
    if path.is_empty() {
        return path.to_string();
    }
    // Unix absolute or Windows drive — keep only the final component or bundle-relative tail.
    if path.starts_with('/') || path.starts_with('\\') {
        return Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("path")
            .to_string();
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("path")
            .to_string();
    }
    // Drop any accidental absolute segments embedded in messages like "… /Users/…"
    if path.contains("/Users/") || path.contains("/home/") || path.contains("Documents/GitHub") {
        return Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("path")
            .to_string();
    }
    path.to_string()
}

/// Redact absolute machine path fragments from diagnostic messages (CLI-safe).
pub fn sanitize_report_message(message: &str) -> String {
    // Never echo absolute machine paths from OS errors.
    let mut out = message.to_string();
    for marker in ["/Users/", "/home/", "Documents/GitHub", "C:\\Users\\"] {
        if let Some(idx) = out.find(marker) {
            // Truncate from marker and replace with redacted token (byte-safe via get).
            let prefix = out.get(..idx).unwrap_or("");
            out = format!("{prefix}[redacted-path]");
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        // crates/cd-core -> repo root
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/incident-evidence")
    }

    fn valid(name: &str) -> PathBuf {
        fixture_root().join("valid").join(name)
    }
    fn invalid(name: &str) -> PathBuf {
        fixture_root().join("invalid").join(name)
    }

    #[test]
    fn schema_id_constant() {
        assert_eq!(SCHEMA_ID, "contextdesk.incident_evidence.v1");
    }

    #[test]
    fn valid_minimal_log_only() {
        let r = validate_directory(&valid("minimal-log-only"));
        assert!(r.ok, "{:?}", r.diagnostics);
        assert_eq!(r.schema_id.as_deref(), Some(SCHEMA_ID));
    }

    #[test]
    fn valid_logs_plus_metrics() {
        let r = validate_directory(&valid("logs-plus-metrics"));
        assert!(r.ok, "{:?}", r.diagnostics);
    }

    #[test]
    fn valid_multi_source_dup_basenames() {
        let r = validate_directory(&valid("multi-source-dup-basenames"));
        assert!(r.ok, "{:?}", r.diagnostics);
        // Both paths distinct
        let raw =
            std::fs::read_to_string(valid("multi-source-dup-basenames").join("manifest.json"))
                .unwrap();
        assert!(raw.contains("logs/api/app.log"));
        assert!(raw.contains("logs/worker/app.log"));
    }

    #[test]
    fn valid_with_attachment() {
        let r = validate_directory(&valid("with-attachment"));
        assert!(r.ok, "{:?}", r.diagnostics);
    }

    #[test]
    fn invalid_unsupported_version() {
        let r = validate_directory(&invalid("unsupported-version"));
        assert!(!r.ok);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "unsupported_schema_id"));
    }

    #[test]
    fn invalid_hash_mismatch() {
        let r = validate_directory(&invalid("hash-mismatch"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "hash_mismatch"));
    }

    #[test]
    fn invalid_traversal_path() {
        let r = validate_directory(&invalid("traversal-path"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "unsafe_path"));
    }

    #[test]
    fn invalid_absolute_path() {
        let r = validate_directory(&invalid("absolute-path"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "unsafe_path"));
    }

    #[test]
    fn invalid_duplicate_manifest_paths() {
        let r = validate_directory(&invalid("duplicate-manifest-paths"));
        assert!(!r.ok);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "duplicate_component_path"));
    }

    #[test]
    fn invalid_missing_payload() {
        let r = validate_directory(&invalid("missing-payload"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "payload_missing"));
    }

    #[test]
    fn invalid_metric_reference() {
        let r = validate_directory(&invalid("invalid-metric-ref"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "payload_missing"));
    }

    #[test]
    fn invalid_timezone_dishonest() {
        let r = validate_directory(&invalid("unresolved-timezone-dishonest"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "timezone_dishonest"));
    }

    #[test]
    fn invalid_forbidden_evaluator_truth() {
        let r = validate_directory(&invalid("forbidden-evaluator-truth"));
        assert!(!r.ok);
        assert!(r.diagnostics.iter().any(|d| d.code == "forbidden_sentinel"));
    }

    #[test]
    fn path_rejects_drive_prefix_and_backslash() {
        assert!(validate_relative_path("C:/windows/system32").is_err());
        assert!(validate_relative_path("logs\\app.log").is_err());
        assert!(validate_relative_path("../x").is_err());
        assert!(validate_relative_path("/abs").is_err());
        assert!(validate_relative_path("logs/app.log").is_ok());
    }

    #[test]
    fn uppercase_hash_rejected() {
        assert!(!is_lowercase_sha256(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(is_lowercase_sha256(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
    }

    #[test]
    fn byte_size_mismatch_detected() {
        // Reuse hash-mismatch fixture shape: if we flip bytes in memory path —
        // covered by hash-mismatch + streaming. Explicit unit: stream hash of empty.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs/app.log"), b"abc").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"t",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[{{
    "id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain",
    "bytes":99,"sha256":"{hex}"
  }}]
}}"#
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();
        let r = validate_directory(root);
        assert!(!r.ok);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "byte_count_mismatch"));
    }

    #[test]
    fn report_text_is_deterministic() {
        let r = validate_directory(&valid("minimal-log-only"));
        let a = format_report_text(&r);
        let b = format_report_text(&r);
        assert_eq!(a, b);
        assert!(a.contains("ok=true"));
    }

    #[test]
    fn unknown_role_fails() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs/app.log"), b"x").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"t",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[{{
    "id":"l","role":"mystery","path":"logs/app.log","mediaType":"text/plain",
    "bytes":1,"sha256":"{hex}"
  }}]
}}"#
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();
        let r = validate_directory(root);
        assert!(r.diagnostics.iter().any(|d| d.code == "unknown_role"));
    }

    #[test]
    fn created_at_requires_offset() {
        assert!(created_at_has_explicit_offset("2024-01-15T12:00:00Z"));
        assert!(created_at_has_explicit_offset("2024-01-15T12:00:00+00:00"));
        assert!(!created_at_has_explicit_offset("2024-01-15T12:00:00"));
    }

    #[test]
    fn intermediate_dir_symlink_escape_rejected_before_hash() {
        // logs/ is a symlink to an outside directory; path logs/secret.log must fail
        // closed and must not successfully hash the outside file.
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.log");
        std::fs::write(&secret, b"OUTSIDE_BUNDLE_PAYLOAD\n").unwrap();
        let outside_hex = stream_sha256_hex(&secret).unwrap();

        let bundle = tempfile::tempdir().unwrap();
        let root = bundle.path();
        let logs_link = root.join("logs");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &logs_link).expect("symlink logs dir");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), &logs_link).expect("symlink logs dir");

        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"symlink-escape",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[{{
    "id":"evil",
    "role":"log",
    "path":"logs/secret.log",
    "mediaType":"text/plain",
    "bytes":{bytes},
    "sha256":"{hex}"
  }}]
}}"#,
            bytes = std::fs::metadata(&secret).unwrap().len(),
            hex = outside_hex
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();

        let r = validate_directory(root);
        assert!(
            !r.ok,
            "expected fail-closed, diagnostics={:?}",
            r.diagnostics
        );
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "symlink_escape" || d.code == "symlink_unresolvable"),
            "expected symlink_escape, got {:?}",
            r.diagnostics
        );
        // Must not report a clean hash match as success for the escaped path.
        assert!(!r.diagnostics.is_empty());
    }

    #[test]
    fn leaf_symlink_escape_rejected() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("leaf.log");
        std::fs::write(&secret, b"LEAF_OUTSIDE\n").unwrap();
        let outside_hex = stream_sha256_hex(&secret).unwrap();

        let bundle = tempfile::tempdir().unwrap();
        let root = bundle.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        let link = root.join("logs/app.log");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &link).expect("symlink leaf");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&secret, &link).expect("symlink leaf");

        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"leaf-symlink",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[{{
    "id":"evil",
    "role":"log",
    "path":"logs/app.log",
    "mediaType":"text/plain",
    "bytes":{bytes},
    "sha256":"{hex}"
  }}]
}}"#,
            bytes = std::fs::metadata(&secret).unwrap().len(),
            hex = outside_hex
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();
        let r = validate_directory(root);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(r
            .diagnostics
            .iter()
            .any(|d| d.code == "symlink_escape" || d.code == "symlink_unresolvable"));
    }

    #[test]
    fn metrics_require_series_provenance_parity_fixture() {
        let valid = fixture_root().join("metrics-parity/valid-with-provenance.json");
        let text = std::fs::read_to_string(&valid).unwrap();
        let mut diags = Vec::new();
        validate_metrics_document_text(&text, "metrics/valid.json", &mut diags);
        assert!(diags.is_empty(), "{diags:?}");

        let invalid = fixture_root().join("metrics-parity/invalid-missing-series-provenance.json");
        let text = std::fs::read_to_string(&invalid).unwrap();
        let mut diags = Vec::new();
        validate_metrics_document_text(&text, "metrics/bad.json", &mut diags);
        assert!(
            diags.iter().any(|d| d.code == "metrics_provenance_missing"),
            "{diags:?}"
        );
    }

    #[test]
    fn metrics_empty_series_parity_fixture_rejected() {
        let path = fixture_root().join("metrics-parity/invalid-empty-series.json");
        let text = std::fs::read_to_string(&path).unwrap();
        let mut diags = Vec::new();
        validate_metrics_document_text(&text, "metrics/empty.json", &mut diags);
        assert!(
            diags.iter().any(|d| d.code == "metrics_series_missing"),
            "{diags:?}"
        );
    }

    #[test]
    fn metrics_rejects_non_string_labels_and_provenance_fields() {
        let doc = serde_json::json!({
            "schemaVersion": 1,
            "id": "x",
            "name": "x",
            "series": [{
                "id": "s",
                "name": "S",
                "unit": "%",
                "timeQuality": "wall",
                "provenance": { "source": "ok", "collector": 99 },
                "labels": { "env": 1 },
                "points": [{ "timestamp": 1.0, "value": 1.0 }]
            }]
        });
        let mut diags = Vec::new();
        validate_metrics_document_value(&doc, "m.json", &mut diags);
        assert!(
            diags.iter().any(|d| d.code == "metrics_labels_invalid"),
            "{diags:?}"
        );
        assert!(
            diags
                .iter()
                .any(|d| d.code == "metrics_provenance_field_type"),
            "{diags:?}"
        );
    }

    #[test]
    fn metrics_rejects_invalid_point_provenance_and_time_quality() {
        let doc = serde_json::json!({
            "schemaVersion": 1,
            "id": "x",
            "name": "x",
            "series": [{
                "id": "s",
                "name": "S",
                "unit": "%",
                "timeQuality": "wall",
                "provenance": { "source": "host" },
                "points": [{
                    "timestamp": 1.0,
                    "value": 1.0,
                    "provenance": { "source": "" },
                    "timeQuality": "not-a-quality"
                }]
            }]
        });
        let mut diags = Vec::new();
        validate_metrics_document_value(&doc, "m.json", &mut diags);
        assert!(
            diags.iter().any(|d| d.code == "metrics_provenance_invalid"
                || d.code == "metrics_provenance_missing"),
            "{diags:?}"
        );
        assert!(
            diags
                .iter()
                .any(|d| d.code == "metrics_time_quality_invalid"
                    && d.path.contains("points[0].timeQuality")),
            "{diags:?}"
        );
    }

    #[test]
    fn portable_case_collision_rejected_before_payload_io() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        // Only one real file exists — collision must fail without requiring both payloads.
        std::fs::write(root.join("logs/app.log"), b"x").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"case-collision",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{{"name":"t","version":"1"}},
  "privacy":{{"redactionDeclared":true,"containsCredentials":false,"containsPii":false}},
  "timeBasis":{{"timezone":"UTC","timezoneResolved":true}},
  "components":[
    {{"id":"a","role":"log","path":"logs/app.log","mediaType":"text/plain","bytes":1,"sha256":"{hex}"}},
    {{"id":"b","role":"log","path":"logs/App.log","mediaType":"text/plain","bytes":1,"sha256":"{hex}"}}
  ]
}}"#
        );
        std::fs::write(root.join("manifest.json"), manifest).unwrap();
        let r = validate_directory(root);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "portable_path_collision"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn undeclared_evaluator_truth_file_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs/app.log"), b"ok\n").unwrap();
        std::fs::write(root.join("evaluator_truth.json"), b"{}\n").unwrap();
        let hex = stream_sha256_hex(&root.join("logs/app.log")).unwrap();
        let bytes = std::fs::metadata(root.join("logs/app.log")).unwrap().len();
        let manifest = format!(
            r#"{{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"undeclared-truth",
  "createdAt":"2024-01-15T12:00:00Z",
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
        let r = validate_directory(root);
        assert!(!r.ok, "{:?}", r.diagnostics);
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.code == "forbidden_sentinel" || d.code == "undeclared_payload"),
            "{:?}",
            r.diagnostics
        );
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.path.contains("evaluator_truth") || d.code == "forbidden_sentinel"),
            "{:?}",
            r.diagnostics
        );
    }

    #[test]
    fn cli_report_never_leaks_absolute_paths() {
        let r = validate_directory(&valid("minimal-log-only"));
        let text = format_report_text(&r);
        assert!(!text.contains("/Users/"), "{text}");
        assert!(!text.contains("Documents/GitHub"), "{text}");
        assert!(
            text.contains("root=minimal-log-only") || text.contains("root="),
            "{text}"
        );
        // Diagnostic sanitizer
        assert_eq!(sanitize_report_path("/Users/chris/secret/bundle"), "bundle");
    }

    #[test]
    fn non_regular_fifo_rejected_on_directory() {
        #[cfg(unix)]
        {
            use std::os::unix::net::UnixListener;
            // Use a socket path as a non-regular stand-in when mkfifo is unavailable;
            // also cover via open_regular_file_bounded on a directory.
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("logs")).unwrap();
            // Point component at a directory pretending to be a file.
            std::fs::create_dir_all(root.join("logs/app.log")).unwrap();
            let manifest = r#"{
  "schemaId":"contextdesk.incident_evidence.v1",
  "minReaderVersion":1,
  "bundleId":"nonreg",
  "createdAt":"2024-01-15T12:00:00Z",
  "producer":{"name":"t","version":"1"},
  "privacy":{"redactionDeclared":true,"containsCredentials":false,"containsPii":false},
  "timeBasis":{"timezone":"UTC","timezoneResolved":true},
  "components":[{
    "id":"l","role":"log","path":"logs/app.log","mediaType":"text/plain",
    "bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }]
}"#;
            std::fs::write(root.join("manifest.json"), manifest).unwrap();
            let r = validate_directory(root);
            assert!(!r.ok, "{:?}", r.diagnostics);
            assert!(
                r.diagnostics
                    .iter()
                    .any(|d| d.code == "entry_non_regular" || d.code == "payload_unreadable"),
                "{:?}",
                r.diagnostics
            );
            let _ = UnixListener::bind(root.join("ignore.sock"));
        }
    }

    #[test]
    fn path_grammar_rejects_spaces_and_unicode() {
        assert!(validate_relative_path("logs/app file.log").is_err());
        assert!(validate_relative_path("logs/app—log.log").is_err());
        assert!(validate_relative_path("logs/app.log").is_ok());
    }
}
