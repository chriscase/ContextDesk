//! Offline Incident Evidence Bundle v1 validator (#764 / #763).
//!
//! Schema id: [`SCHEMA_ID`]. Directory-form validation only in this slice;
//! deterministic archive production/import is residual (documented, not faked).
//!
//! No network I/O. No product corpus publication. Streams SHA-256 over payloads.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read};
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
/// Max sum of payload sizes.
pub const MAX_AGGREGATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max relative path length in bytes (UTF-8).
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;
/// Streaming hash buffer.
pub const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// Forbidden substrings in manifest strings (conformance / shareable safety).
pub const FORBIDDEN_MANIFEST_SENTINELS: &[&str] = &[
    "evaluator_truth",
    "EVALUATOR_TRUTH",
    "EVALUATOR",
    "company-data",
];

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
    fn new(code: impl Into<String>, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: path.into(),
            message: message.into(),
        }
    }
}

/// Result of validating a bundle directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationReport {
    /// Whether validation succeeded.
    pub ok: bool,
    /// Bundle root that was validated.
    pub root: String,
    /// Schema id observed (if parsed).
    pub schema_id: Option<String>,
    /// Bundle id when parsed.
    pub bundle_id: Option<String>,
    /// Sorted diagnostics.
    pub diagnostics: Vec<Diagnostic>,
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
    let root_display = root.display().to_string();

    if !root.is_dir() {
        diagnostics.push(Diagnostic::new(
            "root_not_directory",
            root_display.clone(),
            "bundle root is not a directory",
        ));
        return finish(false, root_display, None, None, diagnostics);
    }

    let manifest_path = root.join("manifest.json");
    if !manifest_path.is_file() {
        diagnostics.push(Diagnostic::new(
            "manifest_missing",
            "manifest.json",
            "manifest.json is required at the bundle root",
        ));
        return finish(false, root_display, None, None, diagnostics);
    }

    let manifest_meta = match std::fs::metadata(&manifest_path) {
        Ok(m) => m,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "manifest_unreadable",
                "manifest.json",
                format!("cannot stat manifest.json: {e}"),
            ));
            return finish(false, root_display, None, None, diagnostics);
        }
    };
    if manifest_meta.len() > MAX_MANIFEST_BYTES {
        diagnostics.push(Diagnostic::new(
            "manifest_too_large",
            "manifest.json",
            format!("manifest.json exceeds MAX_MANIFEST_BYTES ({MAX_MANIFEST_BYTES})"),
        ));
        return finish(false, root_display, None, None, diagnostics);
    }

    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "manifest_unreadable",
                "manifest.json",
                format!("cannot read manifest.json: {e}"),
            ));
            return finish(false, root_display, None, None, diagnostics);
        }
    };

    // Forbidden sentinels in raw manifest text (ids, notes, labels).
    for s in FORBIDDEN_MANIFEST_SENTINELS {
        if raw.contains(s) {
            diagnostics.push(Diagnostic::new(
                "forbidden_sentinel",
                "manifest.json",
                format!("manifest contains forbidden sentinel `{s}`"),
            ));
        }
    }

    let manifest: Manifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            diagnostics.push(Diagnostic::new(
                "manifest_json_invalid",
                "manifest.json",
                format!("manifest.json is not valid JSON for the v1 shape: {e}"),
            ));
            return finish(false, root_display, None, None, diagnostics);
        }
    };

    let schema_id = Some(manifest.schema_id.clone());
    let bundle_id = Some(manifest.bundle_id.clone());

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
    if manifest.bundle_id.trim().is_empty() || manifest.bundle_id.len() > 256 {
        diagnostics.push(Diagnostic::new(
            "bundle_id_invalid",
            "$.bundleId",
            "bundleId must be non-empty and <= 256 characters",
        ));
    }
    if !created_at_has_explicit_offset(&manifest.created_at) {
        diagnostics.push(Diagnostic::new(
            "created_at_offset_required",
            "$.createdAt",
            "createdAt MUST include an explicit offset or Z",
        ));
    }
    if manifest.producer.name.trim().is_empty() || manifest.producer.version.trim().is_empty() {
        diagnostics.push(Diagnostic::new(
            "producer_invalid",
            "$.producer",
            "producer.name and producer.version MUST be non-empty",
        ));
    }
    if manifest.privacy.contains_credentials {
        diagnostics.push(Diagnostic::new(
            "privacy_credentials_not_shareable",
            "$.privacy.containsCredentials",
            "shareable bundles MUST set containsCredentials=false",
        ));
    }
    validate_time_basis(&manifest.time_basis, "$.timeBasis", &mut diagnostics);

    if manifest.components.len() > MAX_COMPONENTS {
        diagnostics.push(Diagnostic::new(
            "too_many_components",
            "$.components",
            format!("components exceed MAX_COMPONENTS ({MAX_COMPONENTS})"),
        ));
    }

    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut aggregate: u64 = 0;

    for (i, c) in manifest.components.iter().enumerate() {
        let base = format!("$.components[{i}]");
        if c.id.trim().is_empty() || c.id.len() > 128 {
            diagnostics.push(Diagnostic::new(
                "component_id_invalid",
                format!("{base}.id"),
                "component id MUST be non-empty and <= 128 characters",
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
        }
        if c.media_type.trim().is_empty() {
            diagnostics.push(Diagnostic::new(
                "media_type_empty",
                format!("{base}.mediaType"),
                "mediaType MUST be non-empty",
            ));
        }
        if let Err(msg) = validate_relative_path(&c.path) {
            diagnostics.push(Diagnostic::new("unsafe_path", format!("{base}.path"), msg));
            // Do not read payload for unsafe paths.
            continue;
        }
        if !seen_paths.insert(c.path.clone()) {
            diagnostics.push(Diagnostic::new(
                "duplicate_component_path",
                format!("{base}.path"),
                format!("duplicate component path `{}`", c.path),
            ));
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
        }
        aggregate = aggregate.saturating_add(c.bytes);
        if let Some(tb) = &c.time_basis {
            validate_time_basis(tb, &format!("{base}.timeBasis"), &mut diagnostics);
        }

        // Resolve path under root without following escapes.
        let payload = match resolve_under_root(root, &c.path) {
            Ok(p) => p,
            Err(msg) => {
                diagnostics.push(Diagnostic::new("path_escape", c.path.clone(), msg));
                continue;
            }
        };
        if !payload.is_file() {
            diagnostics.push(Diagnostic::new(
                "payload_missing",
                c.path.clone(),
                format!("payload file missing: {}", c.path),
            ));
            continue;
        }
        // Symlink escape: if symlink, ensure canonical parent stays under root.
        if payload
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            match (payload.canonicalize(), root.canonicalize()) {
                (Ok(real), Ok(root_real)) => {
                    if !real.starts_with(&root_real) {
                        diagnostics.push(Diagnostic::new(
                            "symlink_escape",
                            c.path.clone(),
                            "symlink target escapes bundle root",
                        ));
                        continue;
                    }
                }
                _ => {
                    diagnostics.push(Diagnostic::new(
                        "symlink_unresolvable",
                        c.path.clone(),
                        "symlink could not be resolved safely",
                    ));
                    continue;
                }
            }
        }

        let meta = match std::fs::metadata(&payload) {
            Ok(m) => m,
            Err(e) => {
                diagnostics.push(Diagnostic::new(
                    "payload_unreadable",
                    c.path.clone(),
                    format!("cannot stat payload: {e}"),
                ));
                continue;
            }
        };
        if meta.len() != c.bytes {
            diagnostics.push(Diagnostic::new(
                "byte_count_mismatch",
                c.path.clone(),
                format!("declared bytes {} != actual {}", c.bytes, meta.len()),
            ));
        }
        if meta.len() > MAX_PER_FILE_BYTES {
            diagnostics.push(Diagnostic::new(
                "file_too_large",
                c.path.clone(),
                format!("actual size exceeds MAX_PER_FILE_BYTES ({MAX_PER_FILE_BYTES})"),
            ));
            continue;
        }
        match stream_sha256_hex(&payload) {
            Ok(hex) => {
                if is_lowercase_sha256(&c.sha256) && hex != c.sha256 {
                    diagnostics.push(Diagnostic::new(
                        "hash_mismatch",
                        c.path.clone(),
                        "declared sha256 does not match file contents",
                    ));
                }
            }
            Err(e) => diagnostics.push(Diagnostic::new(
                "hash_failed",
                c.path.clone(),
                format!("failed to hash payload: {e}"),
            )),
        }

        // Lightweight metrics document check: JSON with schemaVersion 1 when role matches.
        if c.role == "operational_metrics" {
            if let Ok(text) = std::fs::read_to_string(&payload) {
                if text.len() <= 8 * 1024 * 1024 {
                    match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(v) => {
                            let ver = v.get("schemaVersion").and_then(|x| x.as_u64());
                            if ver != Some(1) {
                                diagnostics.push(Diagnostic::new(
                                    "metrics_schema_version",
                                    c.path.clone(),
                                    "operational_metrics document MUST use schemaVersion 1",
                                ));
                            }
                            if v.get("series").and_then(|s| s.as_array()).is_none() {
                                diagnostics.push(Diagnostic::new(
                                    "metrics_series_missing",
                                    c.path.clone(),
                                    "operational_metrics document MUST include a series array",
                                ));
                            }
                        }
                        Err(e) => diagnostics.push(Diagnostic::new(
                            "metrics_json_invalid",
                            c.path.clone(),
                            format!("operational_metrics payload is not JSON: {e}"),
                        )),
                    }
                }
            }
        }
    }

    if aggregate > MAX_AGGREGATE_BYTES {
        diagnostics.push(Diagnostic::new(
            "aggregate_too_large",
            "$.components",
            format!("aggregate declared bytes exceed MAX_AGGREGATE_BYTES ({MAX_AGGREGATE_BYTES})"),
        ));
    }

    let ok = diagnostics.is_empty();
    finish(ok, root_display, schema_id, bundle_id, diagnostics)
}

/// Archive form is residual — return a clear residual diagnostic (do not fake support).
pub fn validate_archive_residual(path: &Path) -> ValidationReport {
    let diagnostics = vec![Diagnostic::new(
        "archive_validation_residual",
        path.display().to_string(),
        "deterministic archive validation/production is residual for a later #763 slice; \
         validate the directory form with validate_directory",
    )];
    finish(false, path.display().to_string(), None, None, diagnostics)
}

fn finish(
    ok: bool,
    root: String,
    schema_id: Option<String>,
    bundle_id: Option<String>,
    mut diagnostics: Vec<Diagnostic>,
) -> ValidationReport {
    diagnostics.sort_by(|a, b| (&a.code, &a.path, &a.message).cmp(&(&b.code, &b.path, &b.message)));
    ValidationReport {
        ok,
        root,
        schema_id,
        bundle_id,
        diagnostics,
    }
}

fn is_known_role(role: &str) -> bool {
    matches!(
        role,
        "log" | "operational_metrics" | "attachment" | "readme"
    )
}

fn is_lowercase_sha256(s: &str) -> bool {
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

fn validate_time_basis(tb: &TimeBasis, json_path: &str, out: &mut Vec<Diagnostic>) {
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

/// Reject absolute, traversal, drive-prefix, empty, and overlong paths.
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

fn resolve_under_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    validate_relative_path(rel)?;
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        out.push(seg);
    }
    Ok(out)
}

fn stream_sha256_hex(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUFFER_BYTES];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Format a report as deterministic CI-friendly text.
pub fn format_report_text(report: &ValidationReport) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "incident-evidence-validate ok={} root={}",
        report.ok, report.root
    ));
    if let Some(s) = &report.schema_id {
        lines.push(format!("schemaId={s}"));
    }
    if let Some(b) = &report.bundle_id {
        lines.push(format!("bundleId={b}"));
    }
    lines.push(format!("diagnostics={}", report.diagnostics.len()));
    for d in &report.diagnostics {
        lines.push(format!("{} | {} | {}", d.code, d.path, d.message));
    }
    lines.join("\n")
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
    fn archive_residual_is_explicit() {
        let r = validate_archive_residual(Path::new("bundle.zip"));
        assert!(!r.ok);
        assert_eq!(r.diagnostics[0].code, "archive_validation_residual");
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
}
