//! `contextdesk import` — the first half of the configured happy path.
//! Every decision (format detection, source selection, noise exclusion,
//! normalization) is made by `cd_workflow::import::default_import`, the
//! same default-path engine the desktop app's guided import wizard is
//! meant to preselect from; this module only shapes CLI args/output and
//! persists the resulting corpus as the CLI's new "current corpus."

use crate::cli::ImportArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::config::AppConfig;
use cd_core::log_analysis::import_preview::ImportPreviewItem;
use cd_workflow::import::default_import;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct ImportOutput {
    pub corpus_id: String,
    pub corpus_name: String,
    pub events_imported: u64,
    pub excluded_count: u64,
    pub timezone_ambiguous_sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<Vec<SelectionItem>>,
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
        if self.excluded_count > 0 {
            out.push_str(&format!(
                "\n{} item(s) excluded (noise/unsupported/review-only) — see `contextdesk import --explain-selection`",
                self.excluded_count
            ));
        }
        if !self.timezone_ambiguous_sources.is_empty() {
            out.push_str(&format!(
                "\n{} source(s) still have ambiguous local timestamps — no default timezone is configured.\nReview with `contextdesk timezone status --corpus {}`",
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

pub fn run(args: &ImportArgs, cache_root: &Path, cfg: &AppConfig) -> CliResult<ImportOutput> {
    if args.embed {
        // `cd_workflow::import::default_import` always ingests with
        // `LogEmbedMode::None` (its default-path doc comment names
        // `--embed` as a future escape hatch, not current behavior) — fail
        // honestly rather than silently accepting the flag and doing an
        // unembedded import anyway.
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
    let outcome = default_import(cache_root, &args.source, cfg, None).map_err(|e| {
        let message = e.to_string();
        if message.contains("nothing importable") {
            CliError::user(message)
        } else {
            CliError::internal(message)
        }
    })?;

    if let Some(name) = &args.name {
        cd_core::log_analysis::LogCorpus::rename(cache_root, &outcome.report.corpus_id, name)
            .map_err(|e| CliError::internal(format!("rename to requested name: {e}")))?;
    }

    Ok(ImportOutput {
        corpus_id: outcome.report.corpus_id.clone(),
        corpus_name: args.name.clone().unwrap_or(outcome.corpus_name),
        events_imported: outcome.report.stats.lines,
        excluded_count: outcome.excluded_count,
        timezone_ambiguous_sources: outcome.timezone_ambiguous_sources,
        selection: args.explain_selection.then(|| {
            outcome
                .plan
                .report
                .items
                .iter()
                .map(SelectionItem::from)
                .collect()
        }),
    })
}
