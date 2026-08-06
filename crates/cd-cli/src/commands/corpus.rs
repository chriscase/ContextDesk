//! Corpus management — thin wrappers over `cd_core::log_analysis::LogCorpus`.
//! No business logic lives here beyond mapping CLI args to those calls and
//! shaping a stable output; selection, ingest, and timezone logic stay in
//! `cd_core` / `cd_workflow`.

use crate::cli::CorpusAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::{IngestPipelineCompatibility, LogCorpus};
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
    /// Persisted semantic identity when known (`null` for legacy corpora).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingest_pipeline_identity: Option<String>,
    /// Host-neutral compatibility: `current` | `legacy_unknown` | `different_version`.
    pub ingest_pipeline_compatibility: IngestPipelineCompatibility,
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
            ingest_pipeline_identity: s.ingest_pipeline_identity,
            ingest_pipeline_compatibility: s.ingest_pipeline_compatibility,
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
        let id_width = self
            .corpora
            .iter()
            .map(|item| item.id.chars().count())
            .max()
            .unwrap_or(2)
            .max(2);
        let name_width = self
            .corpora
            .iter()
            .map(|item| item.name.chars().count())
            .max()
            .unwrap_or(4)
            .max(4);
        let mut out = format!(
            "Corpora ({})\n\n  {:<id_width$}  {:<name_width$}  {:>10}  {:>10}  {}\n",
            self.corpora.len(),
            "ID",
            "NAME",
            "EVENTS",
            "TEMPLATES",
            "PIPELINE"
        );
        for item in &self.corpora {
            out.push_str(&format!(
                "  {:<id_width$}  {:<name_width$}  {:>10}  {:>10}  {}\n",
                item.id,
                item.name,
                item.event_count,
                item.template_count,
                item.ingest_pipeline_compatibility.as_str()
            ));
        }
        let advisories: Vec<_> = self
            .corpora
            .iter()
            .filter(|c| c.ingest_pipeline_compatibility.needs_reimport_advisory())
            .collect();
        if !advisories.is_empty() {
            // Human-only note on stderr would mix with envelopes; keep text-mode
            // advisory as a trailing paragraph on the same human render path.
            out.push_str(
                "\nNote: corpora marked legacy_unknown or different_version were imported under \
                 older or other ingest-pipeline semantics. Reimporting may apply newer parsing \
                 improvements; ContextDesk never auto-reimports or deletes them.\n",
            );
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
        let identity = self
            .ingest_pipeline_identity
            .as_deref()
            .unwrap_or("(unknown/legacy)");
        let mut out = format!(
            "Corpus\n\n  ID           {}\n  Name         {}\n  Events       {}\n  Templates    {}\n  Created      {}\n  Source       {}\n  Pipeline     {}\n  Compatibility {}",
            self.id,
            self.name,
            self.event_count,
            self.template_count,
            self.created_at,
            self.source_label.as_deref().unwrap_or("(unknown)"),
            identity,
            self.ingest_pipeline_compatibility.as_str()
        );
        if self.ingest_pipeline_compatibility.needs_reimport_advisory() {
            out.push_str(
                "\n\nNote: this corpus may predate current parsing/framing improvements. \
                 Reimporting is optional and never automatic.",
            );
        }
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CorpusItem is always serializable")
    }
}

fn open_or_not_found(cache_root: &Path, id: &str) -> CliResult<LogCorpus> {
    LogCorpus::open(cache_root, id).map_err(|_| CliError::not_found(format!("no corpus {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::INGEST_PIPELINE_IDENTITY;

    #[test]
    fn json_list_includes_stable_pipeline_fields() {
        let out = CorpusListOutput {
            corpora: vec![CorpusItem {
                id: "c1".into(),
                name: "n".into(),
                event_count: 1,
                template_count: 1,
                created_at: 1,
                source_label: None,
                ingest_pipeline_identity: Some(INGEST_PIPELINE_IDENTITY.into()),
                ingest_pipeline_compatibility: IngestPipelineCompatibility::Current,
            }],
        };
        let v = out.render_json();
        let row = &v["corpora"][0];
        assert_eq!(row["ingest_pipeline_compatibility"], "current");
        assert_eq!(row["ingest_pipeline_identity"], INGEST_PIPELINE_IDENTITY);
        // Machine JSON must not embed the human advisory paragraph.
        let s = v.to_string();
        assert!(!s.contains("Reimporting"));
    }

    #[test]
    fn text_list_mentions_pipeline_without_breaking_layout() {
        let out = CorpusListOutput {
            corpora: vec![CorpusItem {
                id: "c1".into(),
                name: "legacy".into(),
                event_count: 2,
                template_count: 1,
                created_at: 1,
                source_label: None,
                ingest_pipeline_identity: None,
                ingest_pipeline_compatibility: IngestPipelineCompatibility::LegacyUnknown,
            }],
        };
        let text = out.render_text();
        assert!(text.contains("PIPELINE"));
        assert!(text.contains("legacy_unknown"));
        assert!(text.contains("never auto-reimports"));
    }
}
