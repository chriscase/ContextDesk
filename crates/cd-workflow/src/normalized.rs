//! Host-neutral, bounded inspection of normalized JSONL streams.

use cd_core::error::{CoreError, CoreResult};
use cd_core::normalized_log_events::{
    validate_stream_with_cancel, NormalizedLogDiagnosticCode, NormalizedLogValidation,
};
use cd_core::process_progress::{
    CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind, ProcessProgressObserver,
    ProcessProgressPhase,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub const NORMALIZED_VALIDATION_SCHEMA_ID: &str = "contextdesk.normalized_validation.v1";
pub const NORMALIZED_SUMMARY_SCHEMA_ID: &str = "contextdesk.normalized_summary.v1";
pub const NORMALIZED_INSPECTION_SCHEMA_VERSION: u32 = 1;
pub const MAX_NORMALIZED_FILES: usize = 4096;
pub const MAX_NORMALIZED_DIRECTORIES: usize = 4096;
pub const MAX_NORMALIZED_DIRECTORY_ENTRIES: usize = 65_536;
pub const MAX_DIRECTORY_DEPTH: usize = 32;
pub const MAX_RETAINED_DIAGNOSTICS: usize = 512;
pub const MAX_RETAINED_ERROR_SAMPLES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedInputKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedFileValidation {
    pub path: String,
    pub diagnostics_omitted: u64,
    pub error_samples_omitted: u64,
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
    pub diagnostics_retained: u64,
    pub diagnostics_omitted: u64,
    pub error_samples_retained: u64,
    pub error_samples_omitted: u64,
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
    pub diagnostics_sampled: u64,
    pub diagnostics_omitted_from_sample: u64,
    pub diagnostics_truncated: bool,
    pub diagnostic_sample_counts: BTreeMap<String, u64>,
}

pub fn validate_normalized_path(
    input: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<NormalizedValidationReport> {
    validate_normalized_path_with_observer(input, cancel, &NoopProcessProgress)
}

pub fn validate_normalized_path_with_observer(
    input: &Path,
    cancel: Option<&CancelFlag>,
    observer: &dyn ProcessProgressObserver,
) -> CoreResult<NormalizedValidationReport> {
    let discovered = discover(input, cancel, observer)?;
    let mut files = Vec::with_capacity(discovered.paths.len());
    let mut aggregate = Aggregate::default();
    let mut diagnostic_budget = MAX_RETAINED_DIAGNOSTICS;
    let mut sample_budget = MAX_RETAINED_ERROR_SAMPLES;

    for (index, path) in discovered.paths.iter().enumerate() {
        check_cancel(cancel)?;
        emit_file_progress(observer, index, discovered.paths.len());
        let mut validation = validate_one(&discovered.root, path, cancel)?;
        aggregate.observe(&validation)?;

        validation.diagnostics.truncate(diagnostic_budget);
        diagnostic_budget = diagnostic_budget.saturating_sub(validation.diagnostics.len());
        // `diagnostics_total` already includes findings omitted by core's
        // per-file cap. Subtract only the final retained count so later global
        // truncation is included exactly once as well.
        let diagnostics_omitted = validation
            .diagnostics_total
            .saturating_sub(validation.diagnostics.len() as u64);

        validation.error_samples.truncate(sample_budget);
        sample_budget = sample_budget.saturating_sub(validation.error_samples.len());
        let error_samples_omitted = validation
            .error_samples_total
            .saturating_sub(validation.error_samples.len() as u64);
        validation.diagnostics_truncated |= diagnostics_omitted > 0;
        files.push(NormalizedFileValidation {
            path: portable_display(&discovered.root, path, discovered.kind),
            diagnostics_omitted,
            error_samples_omitted,
            validation,
        });
    }
    observer.progress(ProcessProgress::phase(
        ProcessProgressKind::NormalizedInspection,
        ProcessProgressPhase::Completed,
        "normalized validation complete",
        false,
    ));
    let diagnostics_retained = files
        .iter()
        .map(|file| file.validation.diagnostics.len() as u64)
        .sum();
    let error_samples_retained = files
        .iter()
        .map(|file| file.validation.error_samples.len() as u64)
        .sum();
    let diagnostics_omitted = aggregate
        .diagnostics_total
        .saturating_sub(diagnostics_retained);
    let error_samples_omitted = files.iter().map(|file| file.error_samples_omitted).sum();
    Ok(NormalizedValidationReport {
        schema_id: NORMALIZED_VALIDATION_SCHEMA_ID,
        schema_version: NORMALIZED_INSPECTION_SCHEMA_VERSION,
        ok: aggregate.files_nonconforming == 0,
        input_kind: discovered.kind,
        files_examined: aggregate.files_examined,
        files_conforming: aggregate.files_conforming,
        files_nonconforming: aggregate.files_nonconforming,
        events_validated: aggregate.events_validated,
        diagnostics_total: aggregate.diagnostics_total,
        diagnostics_retained,
        diagnostics_omitted,
        error_samples_retained,
        error_samples_omitted,
        diagnostics_truncated: diagnostics_omitted > 0,
        files,
    })
}

pub fn summarize_normalized_path(
    input: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<NormalizedSummaryReport> {
    summarize_normalized_path_with_observer(input, cancel, &NoopProcessProgress)
}

/// Constant-retained-memory summary: each per-file validation is reduced and
/// dropped before the next file is opened.
pub fn summarize_normalized_path_with_observer(
    input: &Path,
    cancel: Option<&CancelFlag>,
    observer: &dyn ProcessProgressObserver,
) -> CoreResult<NormalizedSummaryReport> {
    let discovered = discover(input, cancel, observer)?;
    let mut aggregate = Aggregate::default();
    let mut diagnostic_sample_counts = BTreeMap::new();
    let mut diagnostics_sampled = 0u64;
    for (index, path) in discovered.paths.iter().enumerate() {
        check_cancel(cancel)?;
        emit_file_progress(observer, index, discovered.paths.len());
        let validation = validate_one(&discovered.root, path, cancel)?;
        aggregate.observe(&validation)?;
        for diagnostic in validation
            .diagnostics
            .iter()
            .take(MAX_RETAINED_DIAGNOSTICS.saturating_sub(diagnostics_sampled as usize))
        {
            *diagnostic_sample_counts
                .entry(diagnostic_code_name(diagnostic.code)?)
                .or_default() += 1;
            diagnostics_sampled = diagnostics_sampled.saturating_add(1);
        }
    }
    observer.progress(ProcessProgress::phase(
        ProcessProgressKind::NormalizedInspection,
        ProcessProgressPhase::Completed,
        "normalized summary complete",
        false,
    ));
    let diagnostics_omitted_from_sample = aggregate
        .diagnostics_total
        .saturating_sub(diagnostics_sampled);
    Ok(NormalizedSummaryReport {
        schema_id: NORMALIZED_SUMMARY_SCHEMA_ID,
        schema_version: NORMALIZED_INSPECTION_SCHEMA_VERSION,
        ok: aggregate.files_nonconforming == 0,
        input_kind: discovered.kind,
        files_examined: aggregate.files_examined,
        files_conforming: aggregate.files_conforming,
        files_nonconforming: aggregate.files_nonconforming,
        events_validated: aggregate.events_validated,
        diagnostics_total: aggregate.diagnostics_total,
        diagnostics_sampled,
        diagnostics_omitted_from_sample,
        diagnostics_truncated: diagnostics_omitted_from_sample > 0,
        diagnostic_sample_counts,
    })
}

#[derive(Default)]
struct Aggregate {
    files_examined: u64,
    files_conforming: u64,
    files_nonconforming: u64,
    events_validated: u64,
    diagnostics_total: u64,
}

impl Aggregate {
    fn observe(&mut self, validation: &NormalizedLogValidation) -> CoreResult<()> {
        self.files_examined = self.files_examined.saturating_add(1);
        if validation.ok {
            self.files_conforming = self.files_conforming.saturating_add(1);
        } else {
            self.files_nonconforming = self.files_nonconforming.saturating_add(1);
        }
        self.events_validated = self
            .events_validated
            .saturating_add(validation.events_validated);
        self.diagnostics_total = self
            .diagnostics_total
            .saturating_add(validation.diagnostics_total);
        Ok(())
    }
}

struct Discovered {
    kind: NormalizedInputKind,
    root: PathBuf,
    paths: Vec<PathBuf>,
}

fn discover(
    input: &Path,
    cancel: Option<&CancelFlag>,
    observer: &dyn ProcessProgressObserver,
) -> CoreResult<Discovered> {
    observer.progress(ProcessProgress::phase(
        ProcessProgressKind::NormalizedInspection,
        ProcessProgressPhase::Scan,
        "discovering normalized JSONL files",
        true,
    ));
    let metadata = fs::symlink_metadata(input)
        .map_err(|_| CoreError::Message("normalized input was not found".into()))?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::Policy(
            "normalized input root must not be a symlink".into(),
        ));
    }
    if metadata.is_file() {
        let parent = input.parent().unwrap_or_else(|| Path::new("."));
        return Ok(Discovered {
            kind: NormalizedInputKind::File,
            root: fs::canonicalize(parent)?,
            paths: vec![input.to_path_buf()],
        });
    }
    if !metadata.is_dir() {
        return Err(CoreError::Message(
            "normalized input must be a regular file or directory".into(),
        ));
    }
    let root = fs::canonicalize(input)?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut paths = Vec::new();
    let mut directories = 0usize;
    let mut entries = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        check_cancel(cancel)?;
        increment_discovery_counter(&mut directories, MAX_NORMALIZED_DIRECTORIES, "directories")?;
        if depth > MAX_DIRECTORY_DEPTH {
            return Err(CoreError::Policy(format!(
                "normalized discovery limit exceeded: maximum depth {MAX_DIRECTORY_DEPTH}"
            )));
        }
        for entry in fs::read_dir(&directory)? {
            check_cancel(cancel)?;
            increment_discovery_counter(&mut entries, MAX_NORMALIZED_DIRECTORY_ENTRIES, "entries")?;
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_dir() {
                pending.push((path, depth + 1));
            } else if file_type.is_file() && has_jsonl_extension(&path) {
                paths.push(path);
                if paths.len() > MAX_NORMALIZED_FILES {
                    return Err(CoreError::Policy(format!(
                        "normalized discovery limit exceeded: maximum files {MAX_NORMALIZED_FILES}"
                    )));
                }
            }
        }
    }
    paths.sort_by(|left, right| {
        portable_relative(&root, left).cmp(&portable_relative(&root, right))
    });
    if paths.is_empty() {
        return Err(CoreError::Policy(
            "directory contains no regular .jsonl files".into(),
        ));
    }
    Ok(Discovered {
        kind: NormalizedInputKind::Directory,
        root,
        paths,
    })
}

fn validate_one(
    root: &Path,
    path: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<NormalizedLogValidation> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        CoreError::Message(format!("cannot resolve normalized input: {}", error.kind()))
    })?;
    if !canonical.starts_with(root) {
        return Err(CoreError::Policy(
            "normalized input escaped the selected root".into(),
        ));
    }
    let file = open_regular_no_follow(path)?;
    validate_stream_with_cancel(BufReader::new(file), cancel)
}

fn open_regular_no_follow(path: &Path) -> CoreResult<fs::File> {
    let before = fs::symlink_metadata(path).map_err(|error| {
        CoreError::Message(format!("cannot inspect normalized input: {}", error.kind()))
    })?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CoreError::Policy(
            "normalized input changed or is not a regular file".into(),
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path).map_err(|error| {
        CoreError::Message(format!("cannot open normalized input: {}", error.kind()))
    })?;
    if !file.metadata()?.is_file() {
        return Err(CoreError::Policy(
            "normalized input changed or is not a regular file".into(),
        ));
    }
    Ok(file)
}

fn emit_file_progress(observer: &dyn ProcessProgressObserver, index: usize, total: usize) {
    observer.progress(
        ProcessProgress::phase(
            ProcessProgressKind::NormalizedInspection,
            ProcessProgressPhase::Validate,
            "validating normalized JSONL files",
            true,
        )
        .with_files(index as u64)
        .with_fraction(index as f32 / total.max(1) as f32),
    );
}

fn check_cancel(cancel: Option<&CancelFlag>) -> CoreResult<()> {
    if cancel.is_some_and(CancelFlag::is_cancelled) {
        Err(CoreError::Cancelled)
    } else {
        Ok(())
    }
}

fn increment_discovery_counter(counter: &mut usize, maximum: usize, name: &str) -> CoreResult<()> {
    *counter = counter.saturating_add(1);
    if *counter > maximum {
        Err(CoreError::Policy(format!(
            "normalized discovery limit exceeded: maximum {name} {maximum}"
        )))
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
    serde_json::to_value(code)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| CoreError::Message("diagnostic code was not a string".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::normalized_log_events::{
        NormalizedLogHeader, ProducerIdentity, NORMALIZED_LOG_EVENTS_SCHEMA_ID,
    };
    #[cfg(unix)]
    use std::sync::Mutex;

    fn header(id: &str) -> String {
        serde_json::to_string(&NormalizedLogHeader {
            schema_id: NORMALIZED_LOG_EVENTS_SCHEMA_ID.into(),
            min_reader_version: 1,
            source_id: id.into(),
            source_label: None,
            producer: ProducerIdentity {
                name: "test".into(),
                version: "1".into(),
            },
            redaction: None,
        })
        .unwrap()
    }

    #[test]
    fn validation_is_stable_bounded_and_summary_reduces_per_file() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..4 {
            let mut body = format!("{}\n", header(&format!("s{index}")));
            for _ in 0..300 {
                body.push_str("{}\n");
            }
            fs::write(tmp.path().join(format!("{index}.jsonl")), body).unwrap();
        }
        let report = validate_normalized_path(tmp.path(), None).unwrap();
        assert!(!report.ok);
        assert_eq!(report.files_examined, 4);
        assert_eq!(
            report.diagnostics_retained as usize,
            MAX_RETAINED_DIAGNOSTICS
        );
        assert!(report.diagnostics_omitted > 0);
        assert_eq!(
            report
                .files
                .iter()
                .map(|f| f.validation.diagnostics.len())
                .sum::<usize>(),
            MAX_RETAINED_DIAGNOSTICS
        );
        let summary = summarize_normalized_path(tmp.path(), None).unwrap();
        assert_eq!(
            summary.diagnostics_sampled as usize,
            MAX_RETAINED_DIAGNOSTICS
        );
        assert!(summary.diagnostics_omitted_from_sample > 0);
    }

    #[test]
    fn per_file_omissions_include_core_and_global_caps_exactly_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("many.jsonl");
        let mut body = format!("{}\n", header("many"));
        for _ in 0..1_000 {
            body.push_str("{}\n");
        }
        fs::write(&path, body).unwrap();

        let report = validate_normalized_path(&path, None).unwrap();
        let file = &report.files[0];
        assert_eq!(file.validation.diagnostics_total, 1_000);
        assert_eq!(file.validation.diagnostics.len(), 256);
        assert_eq!(file.diagnostics_omitted, 744);
        assert_eq!(report.diagnostics_retained, 256);
        assert_eq!(report.diagnostics_omitted, 744);
        assert_eq!(file.validation.error_samples_total, 1_000);
        assert_eq!(file.validation.error_samples.len(), 5);
        assert_eq!(file.error_samples_omitted, 995);
        assert_eq!(report.error_samples_retained, 5);
        assert_eq!(report.error_samples_omitted, 995);
    }

    #[test]
    fn root_and_internal_symlinks_fail_closed_or_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("real.jsonl"),
            format!("{}\n", header("real")),
        )
        .unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                tmp.path().join("real.jsonl"),
                tmp.path().join("link.jsonl"),
            )
            .unwrap();
            let report = validate_normalized_path(tmp.path(), None).unwrap();
            assert_eq!(report.files_examined, 1);
            let root_link = tmp.path().with_extension("link");
            std::os::unix::fs::symlink(tmp.path(), &root_link).unwrap();
            let error = validate_normalized_path(&root_link, None).unwrap_err();
            assert!(error.to_string().contains("root must not be a symlink"));
            fs::remove_file(root_link).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn discovered_file_replaced_by_symlink_fails_closed() {
        struct SwapOnValidate {
            victim: PathBuf,
            replacement: PathBuf,
            swapped: Mutex<bool>,
        }

        impl ProcessProgressObserver for SwapOnValidate {
            fn progress(&self, update: ProcessProgress) {
                if update.phase == ProcessProgressPhase::Validate {
                    let mut swapped = self.swapped.lock().unwrap();
                    if !*swapped {
                        fs::remove_file(&self.victim).unwrap();
                        std::os::unix::fs::symlink(&self.replacement, &self.victim).unwrap();
                        *swapped = true;
                    }
                }
            }
        }

        let selected = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = selected.path().join("victim.jsonl");
        let replacement = outside.path().join("outside.jsonl");
        fs::write(&victim, format!("{}\n", header("victim"))).unwrap();
        fs::write(&replacement, format!("{}\n", header("outside"))).unwrap();
        let observer = SwapOnValidate {
            victim,
            replacement,
            swapped: Mutex::new(false),
        };

        let error =
            validate_normalized_path_with_observer(selected.path(), None, &observer).unwrap_err();
        assert!(error.to_string().contains("escaped the selected root"));
    }

    #[test]
    fn discovery_directory_limit_is_stable() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=MAX_NORMALIZED_DIRECTORIES {
            fs::create_dir(tmp.path().join(format!("d{index:05}"))).unwrap();
        }
        let error = validate_normalized_path(tmp.path(), None).unwrap_err();
        assert!(error.to_string().contains("maximum directories"));
    }

    #[test]
    fn discovery_entry_limit_is_independent_and_stable() {
        let mut entries = MAX_NORMALIZED_DIRECTORY_ENTRIES;
        let error =
            increment_discovery_counter(&mut entries, MAX_NORMALIZED_DIRECTORY_ENTRIES, "entries")
                .unwrap_err();
        assert!(error.to_string().ends_with(&format!(
            "normalized discovery limit exceeded: maximum entries {}",
            MAX_NORMALIZED_DIRECTORY_ENTRIES
        )));
    }
}
