//! `contextdesk explore` — template-level hybrid search over one corpus.
//! A thin shaping layer over `cd_core::log_analysis::search::search_logs`;
//! no ranking, filtering, or embedding logic lives here.

use crate::cli::ExploreArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::search::{search_logs, SearchLogsQuery};
use cd_core::log_analysis::store::LogCorpus;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct ExploreHit {
    pub template_id: u64,
    pub pattern: String,
    pub score: f32,
    pub count: u64,
    pub severity: u8,
}

#[derive(Debug, Serialize)]
pub struct ExploreOutput {
    pub corpus_id: String,
    pub query: String,
    pub hits: Vec<ExploreHit>,
}

impl Render for ExploreOutput {
    fn render_text(&self) -> String {
        if self.hits.is_empty() {
            return format!("no matches for {:?} in {}", self.query, self.corpus_id);
        }
        let mut out = String::new();
        for hit in &self.hits {
            out.push_str(&format!(
                "[log_template:{}] score={:.2} count={} sev={}  {}\n",
                hit.template_id, hit.score, hit.count, hit.severity, hit.pattern
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ExploreOutput is always serializable")
    }
}

pub fn run(
    args: &ExploreArgs,
    cache_root: &Path,
    current_corpus: &Option<String>,
) -> CliResult<ExploreOutput> {
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

    Ok(ExploreOutput {
        corpus_id: corpus_id.to_string(),
        query: args.query.clone(),
        hits: hits
            .into_iter()
            .map(|h| ExploreHit {
                template_id: h.template_id,
                pattern: h.pattern,
                score: h.score,
                count: h.count,
                severity: h.severity,
            })
            .collect(),
    })
}
