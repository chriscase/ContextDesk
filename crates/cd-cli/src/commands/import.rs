//! `contextdesk import` — the first half of the configured happy path.
//! Every decision (format detection, source selection, noise exclusion,
//! reviewed-grammar matching, normalization) is made by
//! `cd_workflow::import::default_import_with_observer`, the same
//! production, bindings-aware engine the desktop app's guided import wizard
//! is meant to preselect from; this module only shapes CLI args/output,
//! wires Ctrl-C cancellation, and persists the resulting corpus as the
//! CLI's new "current corpus."

use crate::cli::ImportArgs;
use crate::config::OutputFormat;
use crate::envelope::{CliError, CliResult, Render};
use crate::progress::CliProgressObserver;
use cd_core::config::AppConfig;
use cd_core::log_analysis::import_preview::ImportPreviewItem;
use cd_core::process_progress::CancelFlag;
use cd_workflow::import::{default_import_with_observer, DefaultImportOutcome};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Serialize)]
pub struct ImportOutput {
    pub corpus_id: String,
    pub corpus_name: String,
    /// Preview inventory count (`ImportPreviewCounts.total`).
    pub entries_examined: u64,
    /// Ingest walk count (`IngestStats.discovered_files`); may exceed
    /// `entries_examined` when directories/archive containers are walked.
    pub discovered_files: u64,
    pub sources_selected: u64,
    pub sources_ignored: u64,
    pub sources_unsupported: u64,
    pub sources_excluded: u64,
    pub sources_failed: u64,
    pub events_imported: u64,
    pub templates: u64,
    pub formats: std::collections::BTreeMap<String, u64>,
    pub timestamp_provenance: std::collections::BTreeMap<String, u64>,
    pub partial: bool,
    pub timezone_ambiguous_sources: Vec<String>,
    pub reviewed_formats_applied: Vec<ReviewedFormatApplicationOut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviewed_format_warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<Vec<SelectionItem>>,
}

#[derive(Debug, Serialize)]
pub struct ReviewedFormatApplicationOut {
    pub source_identity: String,
    pub format_name: String,
}

#[derive(Debug, Serialize)]
pub struct SelectionItem {
    pub identity: String,
    pub selected: bool,
    pub reason: String,
}

impl From<&ImportPreviewItem> for SelectionItem {
    fn from(item: &ImportPreviewItem) -> Self {
        let reason = if item.reasons.is_empty() {
            format!("{:?}", item.status)
        } else {
            item.reasons
                .iter()
                .map(|r| format!("{r:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        Self {
            identity: item.identity.clone(),
            selected: item.selected,
            reason,
        }
    }
}

impl Render for ImportOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "imported {} events into corpus \"{}\" ({})",
            self.events_imported, self.corpus_name, self.corpus_id
        );
        // Preview inventory vs ingest walk are different metrics — always label both.
        out.push_str(&format!(
            "\n  preview inventory: {} file entries; ingest walk: {} filesystem/archive entries",
            self.entries_examined, self.discovered_files
        ));
        out.push_str(&format!(
            "\n  selection: {} selected, {} ignored (noise/hidden/dirs), {} unsupported, {} excluded (policy), {} failed (I/O)",
            self.sources_selected,
            self.sources_ignored,
            self.sources_unsupported,
            self.sources_excluded,
            self.sources_failed
        ));
        if self.sources_ignored > 0 && self.sources_failed == 0 {
            out.push_str(
                "\n  note: ignored entries are intentional noise filtering, not import failures",
            );
        }
        out.push_str(&format!("\n  {} template(s)", self.templates));
        if !self.formats.is_empty() {
            let formats: Vec<String> = self
                .formats
                .iter()
                .map(|(id, count)| format!("{id}={count}"))
                .collect();
            out.push_str(&format!("\n  formats: {}", formats.join(", ")));
        }
        if !self.timestamp_provenance.is_empty() {
            let provenance: Vec<String> = self
                .timestamp_provenance
                .iter()
                .map(|(kind, count)| format!("{kind}={count}"))
                .collect();
            out.push_str(&format!(
                "\n  timestamp provenance: {}",
                provenance.join(", ")
            ));
        }
        if self.partial {
            out.push_str(
                "\n  PARTIAL: not everything discovered was imported — see the counts above",
            );
        }
        if !self.reviewed_formats_applied.is_empty() {
            out.push_str("\n  reviewed formats applied:");
            for application in &self.reviewed_formats_applied {
                out.push_str(&format!(
                    "\n    {} -> {}",
                    application.source_identity, application.format_name
                ));
            }
        }
        if !self.reviewed_format_warnings.is_empty() {
            out.push_str("\n  reviewed-format warnings:");
            for warning in &self.reviewed_format_warnings {
                out.push_str(&format!("\n    {warning}"));
            }
        }
        if !self.timezone_ambiguous_sources.is_empty() {
            out.push_str(&format!(
                "\n  {} source(s) still have ambiguous local timestamps — no default timezone is configured.\n  Resolve all of them at once: `contextdesk timezone apply-all <iana-timezone> --corpus {} --yes`",
                self.timezone_ambiguous_sources.len(),
                self.corpus_id
            ));
        }
        if let Some(selection) = &self.selection {
            out.push_str("\n\nselection:\n");
            for item in selection {
                let mark = if item.selected { "+" } else { "-" };
                out.push_str(&format!("  {mark} {} ({})\n", item.identity, item.reason));
            }
            out = out.trim_end().to_string();
        }
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ImportOutput is always serializable")
    }
}

impl From<DefaultImportOutcome> for ImportOutput {
    fn from(outcome: DefaultImportOutcome) -> Self {
        Self {
            corpus_id: outcome.report.corpus_id.clone(),
            corpus_name: outcome.corpus_name,
            entries_examined: outcome.entries_examined,
            discovered_files: outcome.discovered_files,
            sources_selected: outcome.sources_selected,
            sources_ignored: outcome.sources_ignored,
            sources_unsupported: outcome.sources_unsupported,
            sources_excluded: outcome.sources_excluded,
            sources_failed: outcome.sources_failed,
            events_imported: outcome.events_imported,
            templates: outcome.templates,
            formats: outcome.formats,
            timestamp_provenance: outcome.timestamp_provenance,
            partial: outcome.partial,
            timezone_ambiguous_sources: outcome.timezone_ambiguous_sources,
            reviewed_formats_applied: outcome
                .reviewed_formats_applied
                .into_iter()
                .map(|a| ReviewedFormatApplicationOut {
                    source_identity: a.source_identity,
                    format_name: a.format_name,
                })
                .collect(),
            reviewed_format_warnings: outcome.reviewed_format_warnings,
            selection: None,
        }
    }
}

pub async fn run(
    args: &ImportArgs,
    cache_root: &Path,
    cfg: &AppConfig,
    format: OutputFormat,
) -> CliResult<ImportOutput> {
    if args.embed {
        // `cd_workflow::import::default_import_with_observer` always
        // ingests with `LogEmbedMode::None` — fail honestly rather than
        // silently accepting the flag and doing an unembedded import
        // anyway.
        return Err(CliError::not_implemented(
            "embedding during import is not implemented yet — import without --embed, then embed via the desktop app",
        ));
    }
    if !args.source.exists() {
        return Err(CliError::not_found(format!(
            "no such file or directory: {}",
            args.source.display()
        )));
    }

    let cancel = CancelFlag::new();
    let observer = Arc::new(CliProgressObserver::new(format));

    let cache_root_owned = cache_root.to_path_buf();
    let source_owned = args.source.clone();
    let cfg_owned = cfg.clone();
    let cancel_for_task = cancel.clone();
    let observer_for_task = observer.clone();
    let mut import_task = tokio::task::spawn_blocking(move || {
        default_import_with_observer(
            &cache_root_owned,
            &source_owned,
            &cfg_owned,
            Some(&cancel_for_task),
            observer_for_task.as_ref(),
        )
    });

    // `default_import_with_observer` runs on a blocking thread so this task
    // stays free to race it against Ctrl-C; on cancel we set the flag and
    // wait for the SAME task to actually return (ingest's staging cleanup
    // runs via `Drop` on that thread, not here) rather than abandoning it.
    let joined = tokio::select! {
        joined = &mut import_task => joined,
        ctrl_c_result = tokio::signal::ctrl_c() => {
            if ctrl_c_result.is_err() {
                observer.finish();
                return Err(CliError::internal("failed to install Ctrl-C handler"));
            }
            cancel.cancel();
            eprintln!(
                "\ncancelling — cleaning up (safe to retry the same import once this finishes)..."
            );
            (&mut import_task).await
        }
    };
    observer.finish();

    let outcome = match joined {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(core_error)) => {
            if matches!(&core_error, cd_core::error::CoreError::Cancelled) {
                return Err(CliError::cancelled(
                    "import cancelled — no partial corpus was published, safe to retry",
                ));
            }
            let message = core_error.to_string();
            return Err(if message.contains("nothing importable") {
                CliError::user(message)
            } else {
                CliError::internal(message)
            });
        }
        Err(join_error) => {
            return Err(CliError::internal(format!(
                "import task panicked: {join_error}"
            )))
        }
    };

    if let Some(name) = &args.name {
        cd_core::log_analysis::LogCorpus::rename(cache_root, &outcome.report.corpus_id, name)
            .map_err(|e| CliError::internal(format!("rename to requested name: {e}")))?;
    }

    let explain_selection = args.explain_selection;
    let name_override = args.name.clone();
    let plan_items: Option<Vec<SelectionItem>> = explain_selection.then(|| {
        outcome
            .plan
            .report
            .items
            .iter()
            .map(SelectionItem::from)
            .collect()
    });

    let mut output = ImportOutput::from(outcome);
    if let Some(name) = name_override {
        output.corpus_name = name;
    }
    output.selection = plan_items;
    Ok(output)
}
