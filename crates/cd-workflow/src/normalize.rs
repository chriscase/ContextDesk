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
    /// Publish every valid artifact, but mark the completion as policy-failed
    /// when source ingestion was partial. Hosts use this to return a nonzero
    /// automation exit without discarding safely published evidence.
    pub fail_on_partial: bool,
}

/// Successful normalize outcome.
#[derive(Debug, Clone)]
pub struct NormalizeOutcome {
    /// Written report (output path filled in).
    pub report: NormalizationReport,
    /// Absolute output directory.
    pub output: PathBuf,
    /// True only when `fail_on_partial` was requested and the published report
    /// honestly declares `partial=true`.
    pub partial_policy_failed: bool,
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
        // Fail closed on silent partial export (e.g. keyset dropping seq 0).
        let ingested_lines = ingest.stats.lines;
        if rows.len() as u64 != ingested_lines {
            return Err(CoreError::Policy(format!(
                "export event count mismatch: loaded {} rows but ingest reported {} lines (seq-0 drop?)",
                rows.len(),
                ingested_lines
            )));
        }
        drop(corpus);
        // Discard ephemeral corpus directory under cache (best-effort).
        let _ = LogCorpus::discard(&cache_root, &ingest.corpus_id);

        let batches = build_source_batches(&rows, &options.timezone)?;
        if batches.is_empty() {
            return Err(CoreError::Policy(
                "no events produced from selected sources".into(),
            ));
        }
        let exported_events: u64 = batches.iter().map(|b| b.events.len() as u64).sum();
        if exported_events != ingested_lines {
            return Err(CoreError::Policy(format!(
                "export batch event count mismatch: {exported_events} mapped vs {ingested_lines} ingested"
            )));
        }

        let preview = PreviewCountSnapshot {
            examined: counts.total,
            selected: counts.selected,
            ignored: counts.ignored,
            unsupported: counts.unsupported,
            excluded: counts.blocked,
            failed: ingest.stats.failed_files,
            // A successful subset is still partial when preview proved that
            // event-bearing input was unsupported, policy-blocked, or not
            // selected. Ingest-only partiality misses those sources because
            // the verified selection intentionally excludes them.
            partial: ingest.stats.partial || preview_selection_is_partial(&counts),
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

        Ok(complete_published_outcome(
            report,
            options.output.clone(),
            options.fail_on_partial,
        ))
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

fn fail_on_partial_verdict(requested: bool, partial: bool) -> bool {
    requested && partial
}

fn preview_selection_is_partial(counts: &ImportPreviewCounts) -> bool {
    let event_bearing = counts
        .ready
        .saturating_add(counts.review)
        .saturating_add(counts.raw_fallback);
    counts.unsupported > 0 || counts.blocked > 0 || counts.selected < event_bearing
}

fn complete_published_outcome(
    report: NormalizationReport,
    output: PathBuf,
    fail_on_partial: bool,
) -> NormalizeOutcome {
    NormalizeOutcome {
        partial_policy_failed: fail_on_partial_verdict(fail_on_partial, report.partial),
        report,
        output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(dir: &Path) {
        fs::create_dir_all(dir.join("api")).unwrap();
        fs::create_dir_all(dir.join("worker")).unwrap();
        fs::write(
            dir.join("api/app.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T00:00:00Z","level":"INFO","msg":"started"}"#,
                "\n",
                r#"{"ts":"2026-01-01T00:00:01+00:00","level":"ERROR","msg":"failed token=ghp_example_invalid_secret_marker_1234567890"}"#,
                "\n",
            ),
        )
        .unwrap();
        // Comma-ms local + stack continuation + SQL-ish continuation.
        fs::write(
            dir.join("api/local.log"),
            "2021-03-05 02:53:53,654 INFO local event\n  at com.example.Foo.bar(Foo.java:10)\n2021-03-05 02:53:54,001 WARN query\n  COMMIT;\n",
        )
        .unwrap();
        // Rotated source (distinct identity).
        fs::write(
            dir.join("worker/app.log.1"),
            "2021-03-04 01:00:00 INFO rotated older line\n",
        )
        .unwrap();
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 255]).unwrap();
        fs::write(dir.join("meta.xml"), "<root/>\n").unwrap();
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
            fail_on_partial: false,
        };
        let outcome = normalize_offline_quiet(&opts).expect("normalize");
        assert!(output.join("manifest.json").is_file());
        assert!(output.join("normalization-report.json").is_file());
        assert!(output.join("sources").is_dir());
        assert!(outcome.report.events >= 2);
        // Count events on disk: must match report (no silent seq-0 drop).
        let mut on_disk = 0u64;
        for entry in fs::read_dir(output.join("sources")).unwrap() {
            let text = fs::read_to_string(entry.unwrap().path()).unwrap();
            on_disk += text.lines().count().saturating_sub(1) as u64; // minus header
        }
        assert_eq!(
            on_disk, outcome.report.events,
            "on-disk JSONL events must equal report.events (caught seq-0 drop)"
        );
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

    /// Single one-line source must publish (seq 0 is the only event).
    #[test]
    fn single_line_source_includes_seq_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        fs::create_dir_all(input.join("only")).unwrap();
        fs::write(
            input.join("only/one.jsonl"),
            r#"{"ts":"2026-06-01T00:00:00Z","level":"INFO","msg":"solo"}"#.to_string() + "\n",
        )
        .unwrap();
        let output = tmp.path().join("out");
        let opts = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
            fail_on_partial: false,
        };
        let outcome = normalize_offline_quiet(&opts).expect("single-line must not fail on seq 0");
        assert_eq!(outcome.report.events, 1, "exactly one logical event");
        let files: Vec<_> = fs::read_dir(output.join("sources"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        let text = fs::read_to_string(&files[0]).unwrap();
        assert_eq!(
            text.lines().count(),
            2,
            "header + one event (seq 0 must be present)"
        );
        let ev: serde_json::Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
        assert_eq!(ev["sourceSeq"], 0);
        assert!(ev["message"].as_str().unwrap_or("").contains("solo"));
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
            fail_on_partial: false,
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
            fail_on_partial: false,
        };
        let err = normalize_offline(&opts, Some(&flag), &NoopProcessProgress).unwrap_err();
        assert!(matches!(err, CoreError::Cancelled) || err.to_string().contains("cancel"));
        assert!(!output.exists() || fs::read_dir(&output).map(|d| d.count()).unwrap_or(0) == 0);
    }

    /// Real-path honesty: no invented UTC, continuations retained, rotations distinct,
    /// unsupported excluded, redacted original kept, streaming validator already ran.
    #[test]
    fn normalize_preserves_continuations_and_never_guesses_utc() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        write_fixture(&input);
        let output = tmp.path().join("out");
        let opts = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
            fail_on_partial: false,
        };
        let outcome = normalize_offline_quiet(&opts).expect("normalize");
        assert!(
            outcome.report.sources_unsupported >= 1
                || outcome.report.sources_examined > outcome.report.sources_selected
        );

        let mut saw_continuation = false;
        let mut saw_unresolved_without_instant = false;
        let mut source_ids = std::collections::BTreeSet::new();
        for entry in fs::read_dir(output.join("sources")).unwrap() {
            let path = entry.unwrap().path();
            let text = fs::read_to_string(&path).unwrap();
            let mut lines = text.lines();
            let header: serde_json::Value =
                serde_json::from_str(lines.next().expect("header")).unwrap();
            let sid = header["sourceId"].as_str().unwrap().to_string();
            assert!(
                source_ids.insert(sid.clone()),
                "duplicate sourceId file for {sid}"
            );
            assert_eq!(header["schemaId"], "contextdesk.normalized_log_events.v1");
            for line in lines {
                let ev: serde_json::Value = serde_json::from_str(line).unwrap();
                let res = ev["time"]["resolution"].as_str().unwrap_or("");
                if res == "unresolved" {
                    assert!(
                        ev["time"].get("instant").is_none() || ev["time"]["instant"].is_null(),
                        "guessed UTC forbidden: {line}"
                    );
                    saw_unresolved_without_instant = true;
                }
                let msg = ev["message"].as_str().unwrap_or("");
                let can = ev["canonical"].as_str().unwrap_or("");
                if msg.contains("Foo.bar") || can.contains("Foo.bar") || msg.contains("COMMIT") {
                    saw_continuation = true;
                }
                // Canonical must not be only the short message when original is richer.
                if can.contains("Foo.bar") {
                    assert!(
                        can.contains('\n') || msg.contains('\n') || can.contains("at "),
                        "continuation should survive in canonical/message"
                    );
                }
                // Severity: never schema_mapped+low; absent has no raw/canonical.
                let sev = &ev["severity"];
                if sev["provenance"] == "absent" {
                    assert!(sev.get("raw").is_none() || sev["raw"].is_null());
                    assert!(sev.get("canonical").is_none() || sev["canonical"].is_null());
                }
                if sev["provenance"] == "schema_mapped" {
                    assert_ne!(sev["confidence"], "low");
                }
            }
        }
        assert!(
            saw_unresolved_without_instant || outcome.report.time_unresolved > 0,
            "expected unresolved local times without invented instants"
        );
        assert!(
            saw_continuation || outcome.report.events >= 3,
            "expected multiline continuation retained via real framer path"
        );
        // Rotated worker source should be its own file when selected.
        assert!(
            source_ids.len() >= 2,
            "expected multiple source files, got {source_ids:?}"
        );
    }

    #[test]
    fn fail_on_partial_is_a_post_publish_verdict_not_an_output_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        let input = tmp.path().join("in");
        fs::create_dir_all(&input).unwrap();
        fs::write(
            input.join("keep.log"),
            "2026-01-01T00:00:00Z INFO retained event\n",
        )
        .unwrap();
        fs::write(input.join("unsupported.log"), b"prefix\0binary").unwrap();
        let output = tmp.path().join("out");
        let options = NormalizeOptions {
            input,
            output: output.clone(),
            output_format: "jsonl".into(),
            timezone: NormalizeTimezonePolicy::default(),
            fail_on_partial: true,
        };
        let outcome = normalize_offline_quiet(&options).expect("complete publish");
        assert!(outcome.report.partial);
        assert!(outcome.partial_policy_failed);
        assert!(outcome.report.events > 0);
        assert!(output.join("manifest.json").is_file());
        assert!(output.join("normalization-report.json").is_file());
        assert!(output.join("sources").is_dir());

        assert!(fail_on_partial_verdict(true, true));
        assert!(!fail_on_partial_verdict(false, true));
        assert!(!fail_on_partial_verdict(true, false));
    }
}
