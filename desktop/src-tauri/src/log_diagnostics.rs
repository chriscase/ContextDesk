use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::Path;

pub const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAX_PATH_CHARS: usize = 4_096;

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

pub fn save_log_diagnostic_report(path: &Path, format: &str, content: &str) -> Result<(), String> {
    let format = DiagnosticFormat::parse(format)?;
    if content.is_empty() {
        return Err("diagnostic content is empty".into());
    }
    if content.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(format!(
            "diagnostic content exceeds {} bytes",
            MAX_DIAGNOSTIC_BYTES
        ));
    }
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
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("diagnostic destination cannot be a symbolic link".into());
    }

    let redacted = redact_at_export_boundary(content, format)?;
    if redacted.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(format!(
            "redacted diagnostic exceeds {} bytes",
            MAX_DIAGNOSTIC_BYTES
        ));
    }

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open diagnostic destination: {error}"))?;
    file.write_all(redacted.as_bytes())
        .map_err(|error| format!("write diagnostic destination: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("flush diagnostic destination: {error}"))?;
    Ok(())
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

fn redact_export_text(value: &str) -> String {
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
    let lower = value.to_ascii_lowercase();
    [
        "/users/",
        "/home/",
        "/private/",
        "/var/folders/",
        "/volumes/",
        "\\users\\",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || lower.starts_with("\\\\")
        || lower.as_bytes().windows(3).any(|window| {
            window[0].is_ascii_alphabetic() && window[1] == b':' && window[2] == b'\\'
        })
}

fn contains_private_network(value: &str) -> bool {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .filter(|candidate| !candidate.is_empty())
        .filter_map(|candidate| candidate.parse::<Ipv4Addr>().ok())
        .any(|address| {
            address.is_private() || address.is_loopback() || address.is_link_local() || {
                let octets = address.octets();
                octets[0] == 100 && (64..=127).contains(&octets[1])
            }
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
        .any(|candidate| SUFFIXES.iter().any(|suffix| candidate.ends_with(suffix)))
}

fn contains_url_query(value: &str) -> bool {
    (value.contains("http://") || value.contains("https://")) && value.contains('?')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_write_reapplies_redaction_without_hiding_safe_identity() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        let content = "\
# ContextDesk corpus diagnostic
- ID: 019fab76-18ff-7361-8dd8-e4ddc0f1bb6c
- Git: de43caeba66df05068a50db9356efad3b64a4a45
- Note: Bearer secret-token-value
- Status: /Users/chris/Company/private.log
";

        save_log_diagnostic_report(&destination, "markdown", content).expect("save report");
        let saved = std::fs::read_to_string(destination).expect("read report");
        assert!(saved.contains("019fab76-18ff-7361-8dd8-e4ddc0f1bb6c"));
        assert!(saved.contains("de43caeba66df05068a50db9356efad3b64a4a45"));
        assert!(!saved.contains("secret-token-value"));
        assert!(!saved.contains("/Users/chris"));
        assert!(saved.contains("[REDACTED_PATH]"));
    }

    #[test]
    fn json_write_stays_valid_and_redacts_private_values() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.json");
        let content = r#"{
  "schemaVersion": 1,
  "corpus": {
    "id": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
    "name": "private.internal",
    "note": "source /home/engineer/private.log",
    "status": "10.4.3.2"
  }
}"#;

        save_log_diagnostic_report(&destination, "json", content).expect("save report");
        let saved = std::fs::read_to_string(destination).expect("read report");
        let parsed: Value = serde_json::from_str(&saved).expect("valid json");
        assert_eq!(
            parsed["corpus"]["id"],
            "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c"
        );
        assert_eq!(parsed["corpus"]["name"], "[REDACTED_PRIVATE_HOST]");
        assert_eq!(parsed["corpus"]["note"], "[REDACTED_PATH]");
        assert_eq!(parsed["corpus"]["status"], "[REDACTED_PRIVATE_NETWORK]");
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

        save_log_diagnostic_report(&destination, "json", content).expect("save report");
        assert_eq!(
            std::fs::read_to_string(destination).expect("read report"),
            content
        );
    }

    #[test]
    fn rejects_oversized_wrong_extension_and_missing_parent() {
        let root = tempfile::tempdir().expect("temp root");
        let oversized = "x".repeat(MAX_DIAGNOSTIC_BYTES + 1);
        let error =
            save_log_diagnostic_report(&root.path().join("large.md"), "markdown", &oversized)
                .expect_err("oversized report");
        assert!(error.contains("exceeds"));

        let error = save_log_diagnostic_report(&root.path().join("wrong.txt"), "markdown", "safe")
            .expect_err("wrong extension");
        assert!(error.contains(".md"));

        let error = save_log_diagnostic_report(
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

        let error = save_log_diagnostic_report(&link, "markdown", "replacement")
            .expect_err("symlink refused");
        assert!(error.contains("symbolic link"));
        assert_eq!(
            std::fs::read_to_string(actual).expect("read actual"),
            "keep"
        );
    }
}
