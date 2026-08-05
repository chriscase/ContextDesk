//! Offline normalize orchestration: preview → ephemeral ingest → export v1 JSONL.
//!
//! Zero provider / keychain access. Ephemeral corpus under a private cache is
//! always discarded. Progress and cancellation follow the same observer/flag
//! contracts as import.

use cd_core::error::{CoreError, CoreResult};
use cd_core::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use cd_core::log_analysis::import_preview::{
    preview_import_plan, verify_import_plan, ImportPreviewCounts,
};
use cd_core::log_analysis::ingest::ingest_path_with_policy_selection_and_observer;
use cd_core::log_analysis::normalize_export::{
    build_source_batches, load_events_with_originals, publish_staging, write_and_validate_staging,
    NormalizationReport, NormalizeTimezonePolicy, PreviewCountSnapshot,
};
use cd_core::log_analysis::store::LogCorpus;
use cd_core::process_progress::{
    CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind, ProcessProgressObserver,
    ProcessProgressPhase,
};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Options for one offline normalize run.
#[derive(Debug, Clone)]
pub struct NormalizeOptions {
    /// Input file, folder, or zip.
    pub input: PathBuf,
    /// Destination directory (must be empty / non-existent).
    pub output: PathBuf,
    /// Data format — only `jsonl` is supported in this slice.
    pub output_format: String,
    /// Timezone policy for zone-less local timestamps.
    pub timezone: NormalizeTimezonePolicy,
}

/// Successful normalize outcome.
#[derive(Debug, Clone)]
pub struct NormalizeOutcome {
    /// Written report (output path filled in).
    pub report: NormalizationReport,
    /// Absolute output directory.
    pub output: PathBuf,
}

/// Offline normalize: no durable corpus, no provider/keychain.
pub fn normalize_offline(
    options: &NormalizeOptions,
    cancel: Option<&CancelFlag>,
    observer: &dyn ProcessProgressObserver,
) -> CoreResult<NormalizeOutcome> {
    if options.output_format != "jsonl" {
        return Err(CoreError::Message(format!(
            "unsupported --output-format {:?}; only jsonl is supported",
            options.output_format
        )));
    }
    if !options.input.exists() {
        return Err(CoreError::Message(format!(
            "input not found: {}",
            options.input.display()
        )));
    }

    let kind = ProcessProgressKind::LogIngest;
    emit(
        observer,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Starting,
            "normalize starting",
            true,
        ),
    );
    check_cancel(cancel)?;

    // Preview / selection — real import path.
    emit(
        observer,
        ProcessProgress::phase(kind, ProcessProgressPhase::Scan, "previewing sources", true),
    );
    let plan = preview_import_plan(&options.input, cancel)?;
    if let Some(block) = plan.report.plan_block() {
        return Err(CoreError::Policy(format!(
            "nothing normalizable at {}: {block:?}",
            options.input.display()
        )));
    }
    let counts: ImportPreviewCounts = plan.report.counts.clone();
    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| item.selected)
        .map(|item| item.identity.clone())
        .collect();
    if selected.is_empty() {
        return Err(CoreError::Policy(format!(
            "no selected log sources at {}",
            options.input.display()
        )));
    }
    let selection = verify_import_plan(
        &options.input,
        plan.plan_version,
        &plan.plan_token,
        &selected,
        cancel,
    )?;
    check_cancel(cancel)?;

    // Ephemeral cache + private staging for JSONL publish.
    let work_root = options
        .output
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".contextdesk-normalize-{}", Uuid::now_v7()));
    fs::create_dir_all(&work_root)?;
    let cache_root = work_root.join("cache");
    let staging_dir = work_root.join("staging");
    fs::create_dir_all(&cache_root)?;
    fs::create_dir_all(&staging_dir)?;

    let cleanup = || {
        let _ = fs::remove_dir_all(&work_root);
    };

    let result = (|| {
        check_cancel(cancel)?;
        emit(
            observer,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Stream,
                "parsing and redacting selected sources",
                true,
            ),
        );
        let policy = LogEmbedPolicy {
            mode: LogEmbedMode::None,
            ..LogEmbedPolicy::default()
        };
        let ingest = ingest_path_with_policy_selection_and_observer(
            &cache_root,
            &options.input,
            "normalize-ephemeral",
            &policy,
            None,
            observer,
            cancel,
            &selection,
        )?;
        check_cancel(cancel)?;

        emit(
            observer,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Validate,
                "mapping to normalized_log_events.v1",
                true,
            ),
        );
        let corpus = LogCorpus::open(&cache_root, &ingest.corpus_id)?;
        let rows = load_events_with_originals(&corpus)?;
        drop(corpus);
        // Discard ephemeral corpus directory under cache (best-effort).
        let _ = LogCorpus::discard(&cache_root, &ingest.corpus_id);

        let batches = build_source_batches(&rows, &options.timezone)?;
        if batches.is_empty() {
            return Err(CoreError::Policy(
                "no events produced from selected sources".into(),
            ));
        }

        let preview = PreviewCountSnapshot {
            examined: counts.total,
            selected: counts.selected,
            ignored: counts.ignored,
            unsupported: counts.unsupported,
            excluded: counts.blocked,
            failed: ingest.stats.failed_files,
            partial: ingest.stats.partial,
        };

        let mut report = write_and_validate_staging(
            &staging_dir,
            &options.input.display().to_string(),
            &batches,
            ingest.stats.format_counts.clone(),
            preview,
        )?;
        check_cancel(cancel)?;

        emit(
            observer,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Publish,
                "publishing normalize outputs",
                false,
            ),
        );
        publish_staging(&staging_dir, &options.output)?;
        report.output = options.output.display().to_string();
        // Rewrite report with filled output path.
        fs::write(
            options.output.join("normalization-report.json"),
            serde_json::to_vec_pretty(&report)?,
        )?;

        emit(
            observer,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Completed,
                format!(
                    "normalized {} events from {} sources",
                    report.events,
                    report.sources.len()
                ),
                false,
            ),
        );

        Ok(NormalizeOutcome {
            report,
            output: options.output.clone(),
        })
    })();

    match &result {
        Ok(_) => {
            // Staging was renamed into output; remove residual work_root (cache).
            let _ = fs::remove_dir_all(&work_root);
        }
        Err(_) => {
            cleanup();
            // Ensure destination was not partially written.
            if options.output.exists() {
                // Only remove if it looks like our publish (has report) and we failed after rename —
                // publish_staging is atomic rename; on failure staging still under work_root.
                // Leave pre-existing output untouched (no-clobber would have failed earlier).
            }
        }
    }
    result
}

/// Convenience: normalize with silent progress.
pub fn normalize_offline_quiet(options: &NormalizeOptions) -> CoreResult<NormalizeOutcome> {
    normalize_offline(options, None, &NoopProcessProgress)
}

fn emit(observer: &dyn ProcessProgressObserver, update: ProcessProgress) {
    observer.progress(update);
}

fn check_cancel(cancel: Option<&CancelFlag>) -> CoreResult<()> {
    if cancel.is_some_and(|c| c.is_cancelled()) {
        Err(CoreError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(dir: &Path) {
        fs::create_dir_all(dir.join("api")).unwrap();
        fs::write(
            dir.join("api/app.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T00:00:00Z","level":"INFO","msg":"started"}"#,
                "\n",
                r#"{"ts":"2026-01-01T00:00:01Z","level":"ERROR","msg":"failed token=ghp_example_invalid_secret_marker_1234567890"}"#,
                "\n",
            ),
        )
        .unwrap();
        fs::write(
            dir.join("api/local.log"),
            "2021-03-05 02:53:53,654 INFO local event\n  at com.example.Foo.bar(Foo.java:10)\n",
        )
        .unwrap();
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 255]).unwrap();
    }

    #[test]
    fn normalize_folder_writes_jsonl_manifest_report() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        write_fixture(&input);
        let output = tmp.path().join("out");
        let opts = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
        };
        let outcome = normalize_offline_quiet(&opts).expect("normalize");
        assert!(output.join("manifest.json").is_file());
        assert!(output.join("normalization-report.json").is_file());
        assert!(output.join("sources").is_dir());
        assert!(outcome.report.events >= 2);
        // Ephemeral work root cleaned.
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".contextdesk-normalize-")
            })
            .collect();
        assert!(leftovers.is_empty(), "ephemeral staging must be cleaned");
    }

    #[test]
    fn no_clobber_refuses_existing_output() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        write_fixture(&input);
        let output = tmp.path().join("out");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("keep.txt"), b"stay").unwrap();
        let opts = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
        };
        let err = normalize_offline_quiet(&opts).unwrap_err();
        assert!(
            err.to_string().contains("overwrite") || err.to_string().contains("non-empty"),
            "{err}"
        );
        assert_eq!(fs::read(output.join("keep.txt")).unwrap(), b"stay");
    }

    #[test]
    fn cancel_before_publish_leaves_destination_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        write_fixture(&input);
        let output = tmp.path().join("out");
        let flag = CancelFlag::new();
        flag.cancel();
        let opts = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
        };
        let err = normalize_offline(&opts, Some(&flag), &NoopProcessProgress).unwrap_err();
        assert!(matches!(err, CoreError::Cancelled) || err.to_string().contains("cancel"));
        assert!(!output.exists() || fs::read_dir(&output).map(|d| d.count()).unwrap_or(0) == 0);
    }
}
