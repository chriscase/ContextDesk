//! `contextdesk exception-episodes` — deterministic exception family/episode
//! correlation over an imported corpus (no provider / keychain).

use crate::cli::ExceptionEpisodesArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::{
    correlate_exception_episodes_from_corpus, ExceptionCorrelationOptions, ExceptionEpisodeReport,
    LogCorpus,
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct ExceptionEpisodesOutput {
    pub report: ExceptionEpisodeReport,
}

impl Render for ExceptionEpisodesOutput {
    fn render_text(&self) -> String {
        let r = &self.report;
        let mut out = String::new();
        out.push_str("Exception episode correlation\n\n");
        out.push_str(&format!(
            "  Schema           {} v{}\n\
             \nCounts\n\n\
               Events scanned              {}\n\
               Events classified           {}\n\
               Episodes                    {}\n\
               Families                    {}\n\
               Raw records (scanned)       {}\n\
               Correlated occurrences      {}\n\
               Correlated raw records      {}\n\
               Overall amplification       {}x\n\
               Partial                     {}\n\
               Truncated                   {}\n\
               Confidence                  {:?}\n",
            r.schema_id,
            r.schema_version,
            r.events_scanned,
            r.events_classified,
            r.episode_count,
            r.family_count,
            r.raw_record_total,
            r.correlated_occurrence_total,
            r.correlated_raw_record_total,
            r.overall_amplification_x,
            r.partial,
            r.truncated,
            r.confidence
        ));
        if !r.families.is_empty() {
            out.push_str("\nFamilies\n");
            for f in r.families.iter().take(12) {
                out.push_str(&format!(
                    "\n  {} occurrences={} raw={} amplification={}x class={}\n    confidence={:?}\n",
                    f.family_id,
                    f.occurrence_count,
                    f.raw_record_count,
                    f.amplification_x,
                    f.exception_class.as_deref().unwrap_or("<unknown>"),
                    f.confidence
                ));
                for lead in f.lead_citations.iter().take(3) {
                    out.push_str(&format!(
                        "    lead seq={} source={} role={:?}\n",
                        lead.seq, lead.source, lead.role
                    ));
                }
            }
        }
        out.push_str("\nRanking\n\n  ");
        out.push_str(
            &r.ranking_disclosure
                .lines()
                .collect::<Vec<_>>()
                .join("\n  "),
        );
        out.push_str(
            "\n\nNote\n\n  Wrappers and stack frames are supporting records of an episode, \
             not independent incidents. Raw events are unchanged.\n",
        );
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ExceptionEpisodesOutput serializable")
    }
}

pub fn run(
    args: &ExceptionEpisodesArgs,
    cache_root: &Path,
    current_corpus: &Option<String>,
) -> CliResult<ExceptionEpisodesOutput> {
    let corpus_id = args
        .corpus_id
        .as_deref()
        .or(current_corpus.as_deref())
        .ok_or_else(|| {
            CliError::user("no corpus given and none set - import logs first or pass a corpus id")
        })?;
    let corpus = LogCorpus::open(cache_root, corpus_id).map_err(|e| {
        if e.to_string().contains("not found") {
            CliError::not_found(format!("corpus {corpus_id} not found or unreadable: {e}"))
        } else {
            CliError::internal(e.to_string())
        }
    })?;
    let report = correlate_exception_episodes_from_corpus(
        &corpus,
        &ExceptionCorrelationOptions::default(),
        None,
    )
    .map_err(|e| {
        if e.to_string().contains("cancelled") {
            CliError::cancelled(e.to_string())
        } else {
            CliError::internal(e.to_string())
        }
    })?;
    Ok(ExceptionEpisodesOutput { report })
}
