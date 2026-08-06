//! Host-neutral inspection of `contextdesk.normalized_log_events.v1` streams.
//!
//! Discovery is deliberately format-oriented, not producer-oriented: a file
//! input is inspected directly; a directory input recursively discovers
//! regular `.jsonl` files in stable relative-path order. Parsing and contract
//! validation remain authoritative in `cd_core::normalized_log_events`.

use cd_core::error::{CoreError, CoreResult};
use cd_core::normalized_log_events::{
    validate_stream_with_cancel, NormalizedLogDiagnosticCode, NormalizedLogValidation,
};
use cd_core::process_progress::CancelFlag;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub const NORMALIZED_VALIDATION_SCHEMA_ID: &str = "contextdesk.normalized_validation.v1";
pub const NORMALIZED_SUMMARY_SCHEMA_ID: &str = "contextdesk.normalized_summary.v1";
pub const NORMALIZED_INSPECTION_SCHEMA_VERSION: u32 = 1;
pub const MAX_NORMALIZED_FILES: usize = 4096;
const MAX_DIRECTORY_DEPTH: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedInputKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedFileValidation {
    /// Slash-normalized path relative to a directory input. For a direct file
    /// input this is only the file name, never an absolute host path.
    pub path: String,
    #[serde(flatten)]
    pub validation: NormalizedLogValidation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedValidationReport {
    pub schema_id: &'static str,
    pub schema_version: u32,
    pub ok: bool,
    pub input_kind: NormalizedInputKind,
    pub files_examined: u64,
    pub files_conforming: u64,
    pub files_nonconforming: u64,
    pub events_validated: u64,
    pub diagnostics_total: u64,
    pub diagnostics_truncated: bool,
    pub files: Vec<NormalizedFileValidation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedSummaryReport {
    pub schema_id: &'static str,
    pub schema_version: u32,
    pub ok: bool,
    pub input_kind: NormalizedInputKind,
    pub files_examined: u64,
    pub files_conforming: u64,
    pub files_nonconforming: u64,
    pub events_validated: u64,
    pub diagnostics_total: u64,
    pub diagnostics_truncated: bool,
    /// Counts from the bounded diagnostic sample. When
    /// `diagnostics_truncated` is true these are explicitly sample counts,
    /// not invented totals.
    pub diagnostic_sample_counts: BTreeMap<String, u64>,
}

pub fn validate_normalized_path(
    input: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<NormalizedValidationReport> {
    let (input_kind, root, paths) = discover(input, cancel)?;
    let mut files = Vec::with_capacity(paths.len());
    let mut files_conforming = 0u64;
    let mut events_validated = 0u64;
    let mut diagnostics_total = 0u64;
    let mut diagnostics_truncated = false;

    for path in paths {
        check_cancel(cancel)?;
        let file = fs::File::open(&path).map_err(|error| {
            CoreError::Message(format!("cannot open normalized input: {}", error.kind()))
        })?;
        let validation = validate_stream_with_cancel(BufReader::new(file), cancel)?;
        if validation.ok {
            files_conforming = files_conforming.saturating_add(1);
        }
        events_validated = events_validated.saturating_add(validation.events_validated);
        diagnostics_total = diagnostics_total.saturating_add(validation.diagnostics_total);
        diagnostics_truncated |= validation.diagnostics_truncated;
        files.push(NormalizedFileValidation {
            path: portable_display(&root, &path, input_kind),
            validation,
        });
    }

    let files_examined = files.len() as u64;
    let files_nonconforming = files_examined.saturating_sub(files_conforming);
    Ok(NormalizedValidationReport {
        schema_id: NORMALIZED_VALIDATION_SCHEMA_ID,
        schema_version: NORMALIZED_INSPECTION_SCHEMA_VERSION,
        ok: files_nonconforming == 0,
        input_kind,
        files_examined,
        files_conforming,
        files_nonconforming,
        events_validated,
        diagnostics_total,
        diagnostics_truncated,
        files,
    })
}

pub fn summarize_normalized_path(
    input: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<NormalizedSummaryReport> {
    summarize_validation(&validate_normalized_path(input, cancel)?)
}

pub fn summarize_validation(
    report: &NormalizedValidationReport,
) -> CoreResult<NormalizedSummaryReport> {
    let mut diagnostic_sample_counts = BTreeMap::new();
    for file in &report.files {
        for diagnostic in &file.validation.diagnostics {
            let key = diagnostic_code_name(diagnostic.code)?;
            *diagnostic_sample_counts.entry(key).or_default() += 1;
        }
    }
    Ok(NormalizedSummaryReport {
        schema_id: NORMALIZED_SUMMARY_SCHEMA_ID,
        schema_version: NORMALIZED_INSPECTION_SCHEMA_VERSION,
        ok: report.ok,
        input_kind: report.input_kind,
        files_examined: report.files_examined,
        files_conforming: report.files_conforming,
        files_nonconforming: report.files_nonconforming,
        events_validated: report.events_validated,
        diagnostics_total: report.diagnostics_total,
        diagnostics_truncated: report.diagnostics_truncated,
        diagnostic_sample_counts,
    })
}

fn discover(
    input: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<(NormalizedInputKind, PathBuf, Vec<PathBuf>)> {
    if input.is_file() {
        let root = input
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        return Ok((NormalizedInputKind::File, root, vec![input.to_path_buf()]));
    }
    if !input.exists() {
        return Err(CoreError::Message("normalized input was not found".into()));
    }
    if !input.is_dir() {
        return Err(CoreError::Message(
            "normalized input must be a regular file or directory".into(),
        ));
    }

    let mut pending = vec![(input.to_path_buf(), 0usize)];
    let mut paths = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        check_cancel(cancel)?;
        if depth > MAX_DIRECTORY_DEPTH {
            return Err(CoreError::Policy(format!(
                "normalized input exceeds maximum directory depth {MAX_DIRECTORY_DEPTH}"
            )));
        }
        for entry in fs::read_dir(&directory)? {
            check_cancel(cancel)?;
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_dir() {
                pending.push((path, depth + 1));
            } else if file_type.is_file() && has_jsonl_extension(&path) {
                paths.push(path);
                if paths.len() > MAX_NORMALIZED_FILES {
                    return Err(CoreError::Policy(format!(
                        "normalized input exceeds maximum file count {MAX_NORMALIZED_FILES}"
                    )));
                }
            }
        }
    }
    paths.sort_by(|left, right| {
        portable_relative(input, left).cmp(&portable_relative(input, right))
    });
    if paths.is_empty() {
        return Err(CoreError::Policy(
            "directory contains no regular .jsonl files".into(),
        ));
    }
    Ok((NormalizedInputKind::Directory, input.to_path_buf(), paths))
}

fn check_cancel(cancel: Option<&CancelFlag>) -> CoreResult<()> {
    if cancel.is_some_and(CancelFlag::is_cancelled) {
        Err(CoreError::Cancelled)
    } else {
        Ok(())
    }
}

fn has_jsonl_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
}

fn portable_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn portable_display(root: &Path, path: &Path, kind: NormalizedInputKind) -> String {
    match kind {
        NormalizedInputKind::Directory => portable_relative(root, path),
        NormalizedInputKind::File => path.file_name().map_or_else(
            || "input.jsonl".into(),
            |name| name.to_string_lossy().into(),
        ),
    }
}

fn diagnostic_code_name(code: NormalizedLogDiagnosticCode) -> CoreResult<String> {
    let value = serde_json::to_value(code)?;
    value.as_str().map(str::to_string).ok_or_else(|| {
        CoreError::Message("normalized diagnostic code did not serialize as a string".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::normalized_log_events::{
        NormalizedLogHeader, ProducerIdentity, NORMALIZED_LOG_EVENTS_SCHEMA_ID,
    };
    use std::io::Write;

    fn valid_header(source_id: &str) -> String {
        serde_json::to_string(&NormalizedLogHeader {
            schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.into(),
            min_reader_version: 1,
            source_id: source_id.into(),
            source_label: None,
            producer: ProducerIdentity {
                name: "test-producer".into(),
                version: "1".into(),
            },
            redaction: None,
        })
        .unwrap()
    }

    #[test]
    fn directory_validation_is_stable_aggregated_and_mutation_sensitive() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("nested")).unwrap();
        fs::write(
            tmp.path().join("z.jsonl"),
            format!("{}\n", valid_header("z")),
        )
        .unwrap();
        fs::write(
            tmp.path().join("nested/a.jsonl"),
            format!("{}\n{{\"sourceSeq\":0}}\n", valid_header("a")),
        )
        .unwrap();
        fs::write(tmp.path().join("ignored.json"), b"not jsonl").unwrap();

        let report = validate_normalized_path(tmp.path(), None).unwrap();
        assert!(!report.ok, "malformed event mutation must fail validation");
        assert_eq!(report.files_examined, 2);
        assert_eq!(report.files[0].path, "nested/a.jsonl");
        assert_eq!(report.files[1].path, "z.jsonl");
        assert_eq!(report.files_nonconforming, 1);
        assert!(report.diagnostics_total > 0);

        let summary = summarize_validation(&report).unwrap();
        assert_eq!(summary.schema_id, NORMALIZED_SUMMARY_SCHEMA_ID);
        assert_eq!(summary.diagnostics_total, report.diagnostics_total);
        assert!(!summary.diagnostic_sample_counts.is_empty());
    }

    #[test]
    fn cancellation_stops_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut file = fs::File::create(tmp.path().join("input.jsonl")).unwrap();
        writeln!(file, "{}", valid_header("cancelled")).unwrap();
        let cancel = CancelFlag::new();
        cancel.cancel();
        assert!(matches!(
            validate_normalized_path(tmp.path(), Some(&cancel)),
            Err(CoreError::Cancelled)
        ));
    }
}
