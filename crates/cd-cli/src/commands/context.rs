//! `contextdesk context` — assemble a grounded evidence bundle (with
//! stable, parseable citation ids) for a question, WITHOUT running a model
//! turn. This is the lightweight half of "bounded context": the same
//! `search_logs` evidence a grounded `chat` turn's tool calls would return,
//! shaped for a script to consume directly. Running an actual model over
//! this evidence is `contextdesk chat --corpus <id> "<question>"`, which
//! goes through `cd_workflow::chat` and cd_core's citation-enforced agent
//! loop instead — this command never fabricates an answer, only surfaces
//! the evidence a caller (human or script) can read for itself.

use crate::cli::ContextArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::governed_citation::{
    format_governed_log_citation_id, GovernedLogCitationKind,
};
use cd_core::log_analysis::search::{search_logs, SearchLogsQuery};
use cd_core::log_analysis::store::LogCorpus;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct EvidenceItem {
    pub citation_id: String,
    pub pattern: String,
    pub score: f32,
    pub count: u64,
    pub event_citation_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ContextOutput {
    pub corpus_id: String,
    pub query: String,
    pub evidence: Vec<EvidenceItem>,
}

impl Render for ContextOutput {
    fn render_text(&self) -> String {
        if self.evidence.is_empty() {
            return format!(
                "no evidence found for {:?} in {}",
                self.query, self.corpus_id
            );
        }
        let mut out = format!("evidence for {:?} in {}:\n\n", self.query, self.corpus_id);
        for item in &self.evidence {
            out.push_str(&format!(
                "[{}] {}\n  {} matching event(s): {}\n\n",
                item.citation_id,
                item.pattern,
                item.count,
                item.event_citation_ids.join(", ")
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ContextOutput is always serializable")
    }
}

pub fn run(
    args: &ContextArgs,
    cache_root: &Path,
    current_corpus: &Option<String>,
) -> CliResult<ContextOutput> {
    let corpus_id = args
        .corpus
        .as_deref()
        .or(current_corpus.as_deref())
        .ok_or_else(|| {
            CliError::user(
                "no corpus given and none set — pass --corpus or run `contextdesk corpus use <id>`",
            )
        })?;
    let corpus = LogCorpus::open(cache_root, corpus_id)
        .map_err(|_| CliError::not_found(format!("no corpus {corpus_id}")))?;

    let query = SearchLogsQuery {
        query: Some(args.query.clone()),
        k: args.k,
        ..SearchLogsQuery::default()
    };
    let hits = search_logs(&corpus, &query, None)
        .map_err(|e| CliError::internal(format!("search: {e}")))?;

    Ok(ContextOutput {
        corpus_id: corpus_id.to_string(),
        query: args.query.clone(),
        evidence: hits
            .into_iter()
            .map(|hit| EvidenceItem {
                citation_id: format_governed_log_citation_id(
                    GovernedLogCitationKind::Template,
                    hit.template_id,
                ),
                pattern: hit.pattern,
                count: hit.count,
                score: hit.score,
                event_citation_ids: hit
                    .evidence
                    .iter()
                    .map(|e| format_governed_log_citation_id(GovernedLogCitationKind::Event, e.seq))
                    .collect(),
            })
            .collect(),
    })
}
