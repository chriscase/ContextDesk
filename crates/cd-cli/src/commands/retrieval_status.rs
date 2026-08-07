//! `contextdesk retrieval-status` — optional retrieval-role diagnostics
//! (embedding / reranking): configured state, optional live health probe,
//! the retrieval mode configuration would select, and corpus embedding
//! facts. No provider LLM involved; probes touch only the configured role
//! endpoints and only with `--probe`.

use crate::cli::RetrievalStatusArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_workflow::retrieval::{retrieval_status, RetrievalStatusOptions, RetrievalStatusReport};
use serde::Serialize;
use std::path::Path;

/// Envelope payload for `retrieval-status`.
#[derive(Debug, Serialize)]
pub struct RetrievalStatusOutput {
    /// The host-neutral report DTO (schema `contextdesk.retrieval_status.v1`).
    pub report: RetrievalStatusReport,
}

impl Render for RetrievalStatusOutput {
    fn render_text(&self) -> String {
        let report = &self.report;
        let mut out = String::new();
        out.push_str("Retrieval roles\n\n");
        out.push_str(&format!(
            "  Schema            {} v{}\n  Mode (configured) {}\n  Probed            {}\n\n",
            report.schema_id, report.schema_version, report.mode_configured, report.probed
        ));
        for role in &report.roles {
            out.push_str(&format!(
                "  {:9} {:22} model={} endpoint={} — {}\n",
                role.role,
                role.state.as_str(),
                role.model.as_deref().unwrap_or("-"),
                role.endpoint_fingerprint
                    .as_deref()
                    .map(|f| &f[..f.len().min(12)])
                    .unwrap_or("-"),
                role.detail
            ));
        }
        if let Some(corpus) = &report.corpus {
            out.push_str(&format!(
                "\nCorpus {}\n  Embedded templates {}\n  Event revision     {}\n",
                corpus.corpus_id, corpus.embedded_templates, corpus.event_revision
            ));
            if corpus.embedded_templates == 0 {
                out.push_str(
                    "  Semantic ranking stays off for this corpus until templates are embedded.\n",
                );
            }
        }
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Execute the command.
pub fn run(
    args: &RetrievalStatusArgs,
    cache_root: &Path,
    app_cfg: &AppConfig,
    current_corpus: &Option<String>,
    secrets: &dyn SecretStore,
) -> CliResult<RetrievalStatusOutput> {
    let corpus_id = args.corpus_id.clone().or_else(|| {
        if args.corpus {
            current_corpus.clone()
        } else {
            None
        }
    });
    let options = RetrievalStatusOptions {
        probe: args.probe,
        corpus_id,
    };
    let report = retrieval_status(cache_root, app_cfg, &options, Some(secrets)).map_err(|e| {
        if e.to_string().contains("not found") {
            CliError::not_found(e.to_string())
        } else {
            CliError::internal(e.to_string())
        }
    })?;
    Ok(RetrievalStatusOutput { report })
}
