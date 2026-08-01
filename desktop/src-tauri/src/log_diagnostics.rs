use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAX_PATH_CHARS: usize = 4_096;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiagnosticFormat {
    Markdown,
    Json,
}

impl DiagnosticFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "markdown" => Ok(Self::Markdown),
            "json" => Ok(Self::Json),
            _ => Err("diagnostic format must be markdown or json".into()),
        }
    }

    fn accepts_path(self, path: &Path) -> bool {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        match self {
            Self::Markdown => extension.eq_ignore_ascii_case("md"),
            Self::Json => extension.eq_ignore_ascii_case("json"),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiagnosticPublishOutcome {
    pub warning: Option<String>,
}

pub fn save_log_diagnostic_report_at_host_path(
    path: &Path,
    format: &str,
    content: &str,
) -> Result<DiagnosticPublishOutcome, String> {
    let format = DiagnosticFormat::parse(format)?;
    validate_content(format, content)?;
    publish_reviewed_content_at_host_path(path, format, content)
}

/// Shared destination validation + atomic no-clobber publication for one
/// host-reviewed Markdown artefact.
///
/// This is the exact diagnostics machinery (#819) — host-selected destination,
/// symlink/reparse refusal, private sibling temp, no-replace rename, directory
/// sync warning — reused by the investigation report export (#532) so the two
/// paths cannot drift. Content validation stays with the caller because each
/// artefact family owns its own bound and privacy re-check.
pub(crate) fn publish_reviewed_markdown_at_host_path(
    path: &Path,
    content: &str,
) -> Result<DiagnosticPublishOutcome, String> {
    publish_reviewed_content_at_host_path(path, DiagnosticFormat::Markdown, content)
}

fn publish_reviewed_content_at_host_path(
    path: &Path,
    format: DiagnosticFormat,
    content: &str,
) -> Result<DiagnosticPublishOutcome, String> {
    validate_destination_path(path, format)?;
    let destination_exists = inspect_destination(path)?;
    atomic_publish(path, content, destination_exists)
}

fn validate_content(format: DiagnosticFormat, content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("diagnostic content is empty".into());
    }
    if content.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(format!(
            "diagnostic content exceeds {} bytes",
            MAX_DIAGNOSTIC_BYTES
        ));
    }
    let host_reviewed = redact_at_export_boundary(content, format)?;
    if host_reviewed != content {
        return Err(
            "diagnostic preview failed host privacy validation; nothing was written".into(),
        );
    }
    Ok(())
}

fn validate_destination_path(path: &Path, format: DiagnosticFormat) -> Result<(), String> {
    if path.as_os_str().to_string_lossy().chars().count() > MAX_PATH_CHARS {
        return Err("diagnostic destination path is too long".into());
    }
    if !format.accepts_path(path) {
        return Err(match format {
            DiagnosticFormat::Markdown => {
                "Markdown diagnostics require a user-selected .md file".into()
            }
            DiagnosticFormat::Json => "JSON diagnostics require a user-selected .json file".into(),
        });
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "diagnostic destination must have an existing parent".to_string())?;
    if !parent.is_dir() {
        return Err("diagnostic destination parent does not exist".into());
    }
    Ok(())
}

fn inspect_destination(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if unsafe_destination_metadata(&metadata) => {
            Err("diagnostic destination cannot be a symbolic link or reparse point".into())
        }
        Ok(metadata) if !metadata.is_file() => {
            Err("diagnostic destination must be a regular file".into())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect diagnostic destination: {error}")),
    }
}

fn unsafe_destination_metadata(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

struct PendingDiagnosticTemp {
    path: std::path::PathBuf,
    published: bool,
}

impl Drop for PendingDiagnosticTemp {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn atomic_publish(
    path: &Path,
    content: &str,
    destination_exists: bool,
) -> Result<DiagnosticPublishOutcome, String> {
    atomic_publish_with_post_commit_warning(path, content, destination_exists, None)
}

fn atomic_publish_with_post_commit_warning(
    path: &Path,
    content: &str,
    destination_exists: bool,
    forced_warning: Option<&str>,
) -> Result<DiagnosticPublishOutcome, String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "diagnostic destination must have an existing parent".to_string())?;
    let (mut pending, mut file) = create_private_sibling_temp(parent)?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("write diagnostic temporary file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("flush diagnostic temporary file: {error}"))?;
    drop(file);

    if destination_exists {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if unsafe_destination_metadata(&metadata) => {
                return Err("diagnostic destination became a symbolic link or reparse point".into())
            }
            Ok(metadata) if !metadata.is_file() => {
                return Err("diagnostic destination is no longer a regular file".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("recheck diagnostic destination: {error}")),
        }
        #[cfg(unix)]
        {
            std::fs::rename(&pending.path, path)
                .map_err(|error| format!("atomically replace diagnostic destination: {error}"))?;
            pending.published = true;
        }
        #[cfg(windows)]
        {
            windows_move_file(&pending.path, path, true)?;
            pending.published = true;
        }
        #[cfg(not(any(unix, windows)))]
        {
            return Err("atomic diagnostic replacement is unavailable on this platform".into());
        }
    } else {
        #[cfg(windows)]
        {
            windows_move_file(&pending.path, path, false)?;
            pending.published = true;
        }
        #[cfg(unix)]
        {
            unix_rename_no_replace(&pending.path, path)?;
            pending.published = true;
        }
        #[cfg(not(any(unix, windows)))]
        {
            return Err(
                "atomic no-replace diagnostic publication is unavailable on this platform".into(),
            );
        }
    }

    let mut warnings = Vec::new();
    if let Some(warning) = forced_warning {
        warnings.push(warning.to_string());
    }
    #[cfg(unix)]
    {
        if let Err(error) = std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
            warnings.push(format!(
                "the report was saved, but its parent directory could not be synchronized: {error}"
            ));
        }
    }
    Ok(DiagnosticPublishOutcome {
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    })
}

#[cfg(target_os = "macos")]
fn unix_rename_no_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renamex_np(old: *const c_char, new: *const c_char, flags: c_uint) -> c_int;
    }

    const RENAME_EXCL: c_uint = 0x0000_0004;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| "diagnostic temporary path contains an invalid NUL".to_string())?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| "diagnostic destination contains an invalid NUL".to_string())?;
    // SAFETY: both pointers are valid NUL-terminated paths for the duration of
    // the call, and RENAME_EXCL is the Darwin no-replace flag.
    let renamed = unsafe { renamex_np(source.as_ptr(), destination.as_ptr(), RENAME_EXCL) };
    if renamed != 0 {
        return Err(format!(
            "atomically publish new diagnostic without replacement: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )
))]
fn unix_rename_no_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::raw::{c_int, c_long, c_uint};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
    }

    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    #[cfg(target_arch = "x86_64")]
    const SYS_RENAMEAT2: c_long = 316;
    #[cfg(any(target_arch = "aarch64", target_arch = "riscv64"))]
    const SYS_RENAMEAT2: c_long = 276;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| "diagnostic temporary path contains an invalid NUL".to_string())?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| "diagnostic destination contains an invalid NUL".to_string())?;
    // SAFETY: both pointers are valid NUL-terminated paths for the duration of
    // the call. The syscall number is gated to architectures where it is
    // stable, and RENAME_NOREPLACE is the Linux no-replace flag.
    let renamed = unsafe {
        syscall(
            SYS_RENAMEAT2,
            AT_FDCWD,
            source.as_ptr(),
            AT_FDCWD,
            destination.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if renamed != 0 {
        return Err(format!(
            "atomically publish new diagnostic without replacement: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(all(
        target_os = "linux",
        any(
            target_arch = "x86_64",
            target_arch = "aarch64",
            target_arch = "riscv64"
        )
    ))
))]
fn unix_rename_no_replace(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("atomic no-replace diagnostic publication is unavailable on this Unix platform".into())
}

#[cfg(windows)]
fn windows_move_file(
    source: &Path,
    destination: &Path,
    replace_existing: bool,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    fn nul_terminated(path: &Path) -> Result<Vec<u16>, String> {
        let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if encoded.contains(&0) {
            return Err("diagnostic destination contains an invalid NUL".into());
        }
        encoded.push(0);
        Ok(encoded)
    }

    let source = nul_terminated(source)?;
    let destination = nul_terminated(destination)?;
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace_existing {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    // SAFETY: both pointers reference NUL-terminated UTF-16 buffers for the
    // duration of the call; the remaining parameter is a documented flag mask.
    let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) };
    if moved == 0 {
        return Err(format!(
            "atomically publish diagnostic with MoveFileExW: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn create_private_sibling_temp(
    parent: &Path,
) -> Result<(PendingDiagnosticTemp, std::fs::File), String> {
    for _ in 0..32 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".contextdesk-diagnostic-{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                return Ok((
                    PendingDiagnosticTemp {
                        path,
                        published: false,
                    },
                    file,
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create diagnostic temporary file: {error}")),
        }
    }
    Err("could not allocate a unique diagnostic temporary file".into())
}

fn redact_at_export_boundary(content: &str, format: DiagnosticFormat) -> Result<String, String> {
    match format {
        DiagnosticFormat::Markdown => Ok(content
            .lines()
            .map(|line| {
                if line.starts_with("- ID: ") || line.starts_with("- Git: ") {
                    redact_sensitive_locations(line)
                } else {
                    redact_export_text(line)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")),
        DiagnosticFormat::Json => {
            let mut value: Value = serde_json::from_str(content)
                .map_err(|error| format!("diagnostic JSON is invalid: {error}"))?;
            let original = value.clone();
            redact_json_value(&mut value, None, 0)?;
            if value == original {
                Ok(content.to_string())
            } else {
                serde_json::to_string_pretty(&value)
                    .map_err(|error| format!("serialize diagnostic JSON: {error}"))
            }
        }
    }
}

fn redact_json_value(value: &mut Value, key: Option<&str>, depth: usize) -> Result<(), String> {
    if depth > 12 {
        return Err("diagnostic JSON nesting is too deep".into());
    }
    match value {
        Value::String(text) => {
            *text = if matches!(key, Some("id" | "gitSha" | "generatedAt")) {
                redact_sensitive_locations(text)
            } else {
                redact_export_text(text)
            };
        }
        Value::Array(values) => {
            if values.len() > 128 {
                return Err("diagnostic JSON array is too large".into());
            }
            for child in values {
                redact_json_value(child, None, depth + 1)?;
            }
        }
        Value::Object(values) => {
            if values.len() > 128 {
                return Err("diagnostic JSON object is too large".into());
            }
            for (child_key, child) in values {
                redact_json_value(child, Some(child_key), depth + 1)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

pub(crate) fn redact_export_text(value: &str) -> String {
    let secret_scrubbed = cd_core::redact::scrub_secrets(value);
    redact_sensitive_locations(&secret_scrubbed)
}

fn redact_sensitive_locations(value: &str) -> String {
    if contains_absolute_path(value) {
        return "[REDACTED_PATH]".into();
    }
    if contains_private_network(value) {
        return "[REDACTED_PRIVATE_NETWORK]".into();
    }
    if contains_private_hostname(value) {
        return "[REDACTED_PRIVATE_HOST]".into();
    }
    if contains_url_query(value) {
        return "[REDACTED_URL_QUERY]".into();
    }
    value.to_string()
}

fn contains_absolute_path(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let trimmed = token.trim_matches(|character: char| {
            matches!(
                character,
                '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`' | ',' | ';'
            )
        });
        trimmed.len() > 1 && trimmed.starts_with('/') && !trimmed.starts_with("//")
    }) || (value.len() > 1 && value.starts_with('/') && !value.starts_with("//"))
        || value.as_bytes().windows(3).any(|window| {
            matches!(window[0], b':' | b'=' | b'(' | b'"' | b'\'' | b'`')
                && window[1] == b'/'
                && window[2] != b'/'
        })
        || value.starts_with("\\\\")
        || value.as_bytes().windows(3).any(|window| {
            window[0].is_ascii_alphabetic() && window[1] == b':' && window[2] == b'\\'
        })
}

fn contains_private_network(value: &str) -> bool {
    let private_v4 = value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .filter(|candidate| !candidate.is_empty())
        .filter_map(|candidate| candidate.parse::<Ipv4Addr>().ok())
        .any(|address| {
            address.is_private() || address.is_loopback() || address.is_link_local() || {
                let octets = address.octets();
                octets[0] == 100 && (64..=127).contains(&octets[1])
            }
        });
    private_v4
        || value
            .split(|character: char| !(character.is_ascii_hexdigit() || character == ':'))
            .filter(|candidate| candidate.contains(':'))
            .filter_map(|candidate| candidate.parse::<Ipv6Addr>().ok())
            .any(|address| {
                let first = address.segments()[0];
                address.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
            })
}

fn contains_private_hostname(value: &str) -> bool {
    const SUFFIXES: [&str; 7] = [
        ".internal",
        ".corp",
        ".intranet",
        ".local",
        ".lan",
        ".private",
        ".ies",
    ];
    value
        .to_ascii_lowercase()
        .split(|character: char| {
            !(character.is_ascii_alphanumeric() || character == '.' || character == '-')
        })
        .any(|candidate| {
            SUFFIXES.iter().any(|suffix| {
                candidate.ends_with(suffix) || candidate.contains(&format!("{suffix}."))
            })
        })
}

fn contains_url_query(value: &str) -> bool {
    (value.contains("http://") || value.contains("https://")) && value.contains('?')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_markdown_preview_is_rejected_without_mutating_destination() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        std::fs::write(&destination, "keep existing").expect("seed destination");
        let content = "\
# ContextDesk corpus diagnostic
- ID: 019fab76-18ff-7361-8dd8-e4ddc0f1bb6c
- Git: de43caeba66df05068a50db9356efad3b64a4a45
- Note: Bearer secret-token-value
- Status: /opt/company/logs/private.log on server.internal at ::1
";

        let reviewed =
            redact_at_export_boundary(content, DiagnosticFormat::Markdown).expect("review");
        for forbidden in [
            "secret-token-value",
            "/opt/company",
            "server.internal",
            "::1",
        ] {
            assert!(!reviewed.contains(forbidden), "{reviewed}");
        }
        assert!(reviewed.contains("019fab76-18ff-7361-8dd8-e4ddc0f1bb6c"));
        assert!(reviewed.contains("de43caeba66df05068a50db9356efad3b64a4a45"));

        let error = save_log_diagnostic_report_at_host_path(&destination, "markdown", content)
            .expect_err("mutating preview must be refused");
        assert!(error.contains("privacy validation"), "{error}");
        assert_eq!(
            std::fs::read_to_string(destination).expect("read destination"),
            "keep existing"
        );
    }

    #[test]
    fn host_review_redacts_generic_paths_private_hosts_and_private_ip_families() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.json");
        let content = r#"{
  "schemaVersion": 1,
  "corpus": {
    "id": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
    "name": "server.internal",
    "note": "source /opt/company/logs/private.log",
    "status": "127.0.0.1 ::1 fd12:3456::7 fe80::1"
  }
}"#;

        let reviewed = redact_at_export_boundary(content, DiagnosticFormat::Json).expect("review");
        let parsed: Value = serde_json::from_str(&reviewed).expect("valid json");
        assert_eq!(
            parsed["corpus"]["id"],
            "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c"
        );
        assert_eq!(parsed["corpus"]["name"], "[REDACTED_PRIVATE_HOST]");
        assert_eq!(parsed["corpus"]["note"], "[REDACTED_PATH]");
        assert_eq!(parsed["corpus"]["status"], "[REDACTED_PRIVATE_NETWORK]");
        let error = save_log_diagnostic_report_at_host_path(&destination, "json", content)
            .expect_err("unreviewed preview must be refused");
        assert!(error.contains("privacy validation"), "{error}");
        assert!(!destination.exists());
    }

    #[test]
    fn already_safe_json_is_written_exactly_as_previewed() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.json");
        let content = r#"{
  "schemaVersion": 1,
  "corpus": {
    "id": "corpus-1",
    "name": "Incident"
  }
}"#;

        save_log_diagnostic_report_at_host_path(&destination, "json", content)
            .expect("save report");
        assert_eq!(
            std::fs::read_to_string(destination).expect("read report"),
            content
        );
    }

    #[test]
    fn private_ipv6_detection_covers_loopback_unique_local_and_link_local_only() {
        for private in ["::1", "fd12:3456::7", "fc00::99", "fe80::1", "febf::1"] {
            assert!(contains_private_network(private), "{private}");
        }
        for public in ["2001:4860:4860::8888", "2606:4700:4700::1111"] {
            assert!(!contains_private_network(public), "{public}");
        }
    }

    #[test]
    fn host_selected_path_publishes_atomically_and_leaves_no_sibling_temp() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        let first = "# Safe diagnostic\n\n- Status: none";
        let second = "# Safe diagnostic\n\n- Status: updated";

        save_log_diagnostic_report_at_host_path(&destination, "markdown", first)
            .expect("publish new report");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read first"),
            first
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&destination)
                    .expect("destination metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        save_log_diagnostic_report_at_host_path(&destination, "markdown", second)
            .expect("atomically replace host-confirmed report");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read replacement"),
            second
        );

        let leftovers = std::fs::read_dir(root.path())
            .expect("read temp root")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".contextdesk-diagnostic-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn failed_ingest_and_active_view_json_are_detected_at_the_host_boundary() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("failed-ingest.json");
        let content = r#"{
  "schemaVersion": 1,
  "corpus": null,
  "failedIngest": {
    "reasonCode": "invalid_archive",
    "summary": "failed near /Users/employee/private.internal/incident.zip",
    "evidence": {
      "scanCounts": {
        "binary": 1,
        "empty": 0,
        "hidden": 0,
        "oversized": 0,
        "readFailed": 1,
        "parseFailed": 1
      },
      "transcript": [
        {
          "reason": "read_failed",
          "basename": "/Users/employee/private.internal/Bearer secret-token-value.log"
        },
        {
          "reason": "parse_failed",
          "basename": "customer.private.log"
        }
      ],
      "omittedEntries": 0
    }
  },
  "activeView": {
    "status": "10.4.3.2 Bearer secret-token-value",
    "selectedSeqs": [1, 2]
  }
}"#;

        let reviewed = redact_at_export_boundary(content, DiagnosticFormat::Json).expect("review");
        let parsed: Value = serde_json::from_str(&reviewed).expect("valid json");
        assert_eq!(parsed["failedIngest"]["reasonCode"], "invalid_archive");
        assert_eq!(
            parsed["activeView"]["selectedSeqs"],
            serde_json::json!([1, 2])
        );
        assert_eq!(parsed["failedIngest"]["summary"], "[REDACTED_PATH]");
        assert_eq!(
            parsed["failedIngest"]["evidence"]["transcript"][0]["basename"],
            "[REDACTED_PATH]"
        );
        assert_eq!(
            parsed["failedIngest"]["evidence"]["transcript"][1]["basename"],
            "[REDACTED_PRIVATE_HOST]"
        );
        assert_eq!(parsed["activeView"]["status"], "[REDACTED_PRIVATE_NETWORK]");
        for forbidden in [
            "/Users/employee",
            "private.internal",
            "incident.zip",
            "10.4.3.2",
            "secret-token-value",
        ] {
            assert!(!reviewed.contains(forbidden), "{reviewed}");
        }
        let error = save_log_diagnostic_report_at_host_path(&destination, "json", content)
            .expect_err("unreviewed preview must be refused");
        assert!(error.contains("privacy validation"), "{error}");
        assert!(!destination.exists());
    }

    #[test]
    fn rejects_oversized_wrong_extension_and_missing_parent() {
        let root = tempfile::tempdir().expect("temp root");
        let oversized = "x".repeat(MAX_DIAGNOSTIC_BYTES + 1);
        let error = save_log_diagnostic_report_at_host_path(
            &root.path().join("large.md"),
            "markdown",
            &oversized,
        )
        .expect_err("oversized report");
        assert!(error.contains("exceeds"));

        let error = save_log_diagnostic_report_at_host_path(
            &root.path().join("wrong.txt"),
            "markdown",
            "safe",
        )
        .expect_err("wrong extension");
        assert!(error.contains(".md"));

        let error = save_log_diagnostic_report_at_host_path(
            &root.path().join("missing").join("report.json"),
            "json",
            "{}",
        )
        .expect_err("missing parent");
        assert!(error.contains("parent"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_existing_symlink_destination() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temp root");
        let actual = root.path().join("actual.md");
        std::fs::write(&actual, "keep").expect("write actual");
        let link = root.path().join("diagnostic.md");
        symlink(&actual, &link).expect("create symlink");

        let error = save_log_diagnostic_report_at_host_path(&link, "markdown", "replacement")
            .expect_err("symlink refused");
        assert!(error.contains("symbolic link"));
        assert_eq!(
            std::fs::read_to_string(actual).expect("read actual"),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_unix_no_replace_publication_never_clobbers_a_racing_destination() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        std::fs::write(&destination, "# Existing diagnostic").expect("seed destination");

        let error = atomic_publish(&destination, "# Must not clobber", false)
            .expect_err("native no-replace publication must fail closed");
        assert!(error.contains("without replacement"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read unchanged destination"),
            "# Existing diagnostic"
        );
    }

    #[cfg(unix)]
    #[test]
    fn publication_is_the_commit_point_for_cleanup_and_directory_sync_warnings() {
        for warning in [
            "the report was saved, but temporary cleanup failed",
            "the report was saved, but directory synchronization failed",
        ] {
            let root = tempfile::tempdir().expect("temp root");
            let destination = root.path().join("diagnostic.md");
            let outcome = atomic_publish_with_post_commit_warning(
                &destination,
                "# Saved",
                false,
                Some(warning),
            )
            .expect("post-commit problem is a warning");
            assert_eq!(outcome.warning.as_deref(), Some(warning));
            assert_eq!(
                std::fs::read_to_string(&destination).expect("read committed destination"),
                "# Saved"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_move_file_is_write_through_no_clobber_then_atomic_replace() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        std::fs::write(&destination, "# Existing diagnostic").expect("seed destination");

        let error = atomic_publish(&destination, "# Must not clobber", false)
            .expect_err("new-file publication must stay no-clobber");
        assert!(error.contains("MoveFileExW"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read unchanged destination"),
            "# Existing diagnostic"
        );

        save_log_diagnostic_report_at_host_path(
            &destination,
            "markdown",
            "# Host-confirmed replacement",
        )
        .expect("replace with MoveFileExW");
        assert_eq!(
            std::fs::read_to_string(&destination).expect("read replacement"),
            "# Host-confirmed replacement"
        );
        let leftovers = std::fs::read_dir(root.path())
            .expect("read temp root")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".contextdesk-diagnostic-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
