//! `contextdesk exception-episodes` — four-layer exception rendering analysis
//! (raw records / physical renderings / semantic occurrences / families).

use crate::cli::ExceptionEpisodesArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::{analyze_exception_episodes, ExceptionEpisodeAnalysis, LogCorpus};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct ExceptionEpisodesOutput {
    pub report: ExceptionEpisodeAnalysis,
}

impl Render for ExceptionEpisodesOutput {
    fn render_text(&self) -> String {
        let r = &self.report;
        let mut out = String::new();
        out.push_str("Exception episode correlation\n\n");
        out.push_str(&format!(
            "  Schema           {} v{}\n\
             \nLayers\n\n\
               Events available            {}\n\
               Events scanned              {}\n\
               Raw exception records       {}\n\
               Physical renderings         {}\n\
               Semantic occurrences        {}\n\
               Duplicate-render occurrences {}\n\
               Families                    {}\n\
               Overall amplification       {}x\n\
               Partial                     {}\n\
               Uncertain                   {}\n",
            r.schema_id,
            r.schema_version,
            r.events_available,
            r.events_scanned,
            r.raw_exception_record_count,
            r.rendering_episode_count,
            r.occurrence_count,
            r.duplicate_rendering_occurrence_count,
            r.families.len(),
            r.overall_amplification_x,
            r.partial,
            r.uncertain
        ));
        if !r.families.is_empty() {
            out.push_str("\nFamilies\n");
            for f in r.families.iter().take(12) {
                out.push_str(&format!(
                    "\n  {} occurrences={} raw={} renderings={} amplification={}x duplicates={}\n",
                    f.signature,
                    f.occurrence_count,
                    f.raw_record_count,
                    f.rendering_episode_count,
                    f.amplification_x,
                    f.duplicate_rendering_occurrence_count
                ));
                for occ in f.occurrences.iter().take(2) {
                    out.push_str(&format!(
                        "    occurrence raw={} renderings={} duplicate={} confidence={:?}\n",
                        occ.raw_record_count,
                        occ.rendering_count,
                        occ.duplicate_rendering,
                        occ.correlation_confidence
                    ));
                    for c in occ.citations.iter().take(3) {
                        out.push_str(&format!("      cite seq={} source={}\n", c.seq, c.source));
                    }
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
            "\n\nNote\n\n  Four layers: raw records, physical renderings, semantic occurrences, \
             families. Duplicate renderings require multi-signal evidence. Order-only \
             cross-source merge requires a strong execution key. Raw events are unchanged.\n",
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
    let report = analyze_exception_episodes(&corpus, &[]).map_err(|e| {
        if matches!(e, cd_core::error::CoreError::Cancelled) || e.to_string().contains("cancel") {
            CliError::cancelled(e.to_string())
        } else {
            CliError::internal(e.to_string())
        }
    })?;
    Ok(ExceptionEpisodesOutput { report })
}
