//! Corpus management — thin wrappers over `cd_core::log_analysis::LogCorpus`.
//! No business logic lives here beyond mapping CLI args to those calls and
//! shaping a stable output; selection, ingest, and timezone logic stay in
//! `cd_core` / `cd_workflow`.

use crate::cli::CorpusAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::LogCorpus;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct CorpusItem {
    pub id: String,
    pub name: String,
    pub event_count: u64,
    pub template_count: u64,
    pub created_at: i64,
    pub source_label: Option<String>,
}

impl From<cd_core::log_analysis::CorpusSummary> for CorpusItem {
    fn from(s: cd_core::log_analysis::CorpusSummary) -> Self {
        Self {
            id: s.id,
            name: s.name,
            event_count: s.event_count,
            template_count: s.template_count,
            created_at: s.created_at,
            source_label: s.source_label,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CorpusListOutput {
    pub corpora: Vec<CorpusItem>,
}

impl Render for CorpusListOutput {
    fn render_text(&self) -> String {
        if self.corpora.is_empty() {
            return "No corpora imported yet. Run `contextdesk import <archive>`.".to_string();
        }
        let mut out = String::new();
        for item in &self.corpora {
            out.push_str(&format!(
                "{}  {}  ({} events, {} templates)\n",
                item.id, item.name, item.event_count, item.template_count
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CorpusListOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct CorpusOkOutput {
    pub id: String,
    pub message: String,
}

impl Render for CorpusOkOutput {
    fn render_text(&self) -> String {
        self.message.clone()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CorpusOkOutput is always serializable")
    }
}

pub fn run(action: &CorpusAction, cache_root: &Path) -> CliResult<Box<dyn Render>> {
    match action {
        CorpusAction::List => {
            let summaries = LogCorpus::list_summaries(cache_root)
                .map_err(|e| CliError::internal(format!("list corpora: {e}")))?;
            Ok(Box::new(CorpusListOutput {
                corpora: summaries.into_iter().map(CorpusItem::from).collect(),
            }))
        }
        CorpusAction::Show { id } => {
            let corpus = open_or_not_found(cache_root, id)?;
            let summary = corpus.summary();
            Ok(Box::new(CorpusItem::from(summary)))
        }
        CorpusAction::Rename { id, name } => {
            open_or_not_found(cache_root, id)?;
            LogCorpus::rename(cache_root, id, name).map_err(|e| {
                if e.to_string().contains("empty") {
                    CliError::user(e.to_string())
                } else {
                    CliError::internal(e.to_string())
                }
            })?;
            Ok(Box::new(CorpusOkOutput {
                id: id.clone(),
                message: format!("renamed {id} to \"{name}\""),
            }))
        }
        CorpusAction::Delete { id, yes } => {
            open_or_not_found(cache_root, id)?;
            if !*yes {
                return Err(CliError::user(format!(
                    "refusing to delete corpus {id} without --yes"
                )));
            }
            LogCorpus::discard(cache_root, id)
                .map_err(|e| CliError::internal(format!("delete corpus: {e}")))?;
            Ok(Box::new(CorpusOkOutput {
                id: id.clone(),
                message: format!("deleted {id}"),
            }))
        }
        CorpusAction::Use { id } => {
            open_or_not_found(cache_root, id)?;
            Ok(Box::new(CorpusOkOutput {
                id: id.clone(),
                message: format!("current corpus set to {id}"),
            }))
        }
    }
}

impl Render for CorpusItem {
    fn render_text(&self) -> String {
        format!(
            "{}\n  name: {}\n  events: {}\n  templates: {}\n  created_at: {}\n  source: {}",
            self.id,
            self.name,
            self.event_count,
            self.template_count,
            self.created_at,
            self.source_label.as_deref().unwrap_or("(unknown)")
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CorpusItem is always serializable")
    }
}

fn open_or_not_found(cache_root: &Path, id: &str) -> CliResult<LogCorpus> {
    LogCorpus::open(cache_root, id).map_err(|_| CliError::not_found(format!("no corpus {id}")))
}
