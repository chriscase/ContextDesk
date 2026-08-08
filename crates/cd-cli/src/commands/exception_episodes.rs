//! `contextdesk exception-episodes` — layered exception rendering analysis
//! (raw records / physical renderings / correlation groups / certified episodes / families).

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
        let amp = &r.amplification;
        let certified_semantic = if r.semantic_counts_certified && !r.partial {
            r.strong_derived_episode_count.to_string()
        } else {
            "withheld (uncertified)".into()
        };
        out.push_str(&format!(
            "  Schema           {} v{}\n\
             \nLayers\n\n\
               Candidate scope             {}\n\
               Events available            {}\n\
               Events scanned              {}\n\
               Rows walked                 {}\n\
               Raw exception records       {}\n\
               Application records         {}\n\
               Stderr records              {}\n\
               Physical renderings         {}\n\
               Unpaired renderings         {}\n\
               Retained correlation groups {}\n\
               Certified semantic episodes {}\n\
               Duplicate-render occurrences {}\n\
               Families                    {}\n\
               Raw records / retained group {}/{} = {} rem {}\n\
               Stderr records / retained group {}/{} = {} rem {}\n\
               Renderings / retained group {}/{} = {} rem {}\n\
               Counts complete             {}\n\
               Partial                     {}\n\
               Uncertain                   {}\n\
               Matching ambiguous          {}\n",
            r.schema_id,
            r.schema_version,
            r.candidate_scope,
            r.events_available,
            r.events_scanned,
            r.rows_walked,
            r.raw_exception_record_count,
            r.application_exception_record_count,
            r.stderr_exception_record_count,
            r.rendering_episode_count,
            r.unpaired_rendering_count,
            r.occurrence_count,
            certified_semantic,
            r.duplicate_rendering_occurrence_count,
            r.families.len(),
            amp.raw_records_per_occurrence.numerator,
            amp.raw_records_per_occurrence.denominator,
            amp.raw_records_per_occurrence.quotient,
            amp.raw_records_per_occurrence.remainder,
            amp.stderr_records_per_occurrence.numerator,
            amp.stderr_records_per_occurrence.denominator,
            amp.stderr_records_per_occurrence.quotient,
            amp.stderr_records_per_occurrence.remainder,
            amp.renderings_per_occurrence.numerator,
            amp.renderings_per_occurrence.denominator,
            amp.renderings_per_occurrence.quotient,
            amp.renderings_per_occurrence.remainder,
            r.counts_complete,
            r.partial,
            r.uncertain,
            r.matching_ambiguous
        ));
        if !r.families.is_empty() {
            out.push_str("\nFamilies\n");
            for f in r.families.iter().take(12) {
                let famp = &f.amplification;
                let strong_derived = f
                    .occurrences
                    .iter()
                    .filter(|occurrence| {
                        occurrence.duplicate_rendering
                            && occurrence.correlation_confidence
                                == cd_core::log_analysis::ExceptionCorrelationConfidence::Strong
                    })
                    .count() as u64;
                let non_strong_groups = f.occurrence_count.saturating_sub(strong_derived);
                out.push_str(&format!(
                    "\n  {} retained_groups={} strong_derived={} non_strong_groups={} raw={} app={} stderr={} renderings={} raw_per_group={}/{}={} rem{} app_per_group={}/{}={} rem{} duplicate_render_groups={}\n",
                    f.signature,
                    f.occurrence_count,
                    strong_derived,
                    non_strong_groups,
                    f.raw_record_count,
                    f.application_record_count,
                    f.stderr_record_count,
                    f.rendering_episode_count,
                    famp.raw_records_per_occurrence.numerator,
                    famp.raw_records_per_occurrence.denominator,
                    famp.raw_records_per_occurrence.quotient,
                    famp.raw_records_per_occurrence.remainder,
                    famp.application_records_per_occurrence.numerator,
                    famp.application_records_per_occurrence.denominator,
                    famp.application_records_per_occurrence.quotient,
                    famp.application_records_per_occurrence.remainder,
                    f.duplicate_rendering_occurrence_count
                ));
                for occ in f.occurrences.iter().take(2) {
                    out.push_str(&format!(
                        "    retained_group raw={} renderings={} duplicate={} confidence={:?}\n",
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
        out.push_str(&format!(
            "\nCompleteness\n\n               Scan complete                 {}\n               Renderings complete           {}\n               Correlation complete          {}\n               Citations complete            {}\n               Structural coverage           {}\n               Semantic counts certified     {}\n               Application propagation chains {}\n               Strongly supported derived episodes {}\n               Standalone renderings         {}\n               Unresolved renderings         {}\n               Ambiguous components          {}\n               counts_complete (deprecated v1 alias) {}\n",
            r.scan_complete,
            r.renderings_complete,
            r.correlation_complete,
            r.citations_complete,
            r.structural_coverage_complete,
            r.semantic_counts_certified,
            r.application_propagation_chain_count,
            r.strong_derived_episode_count,
            r.standalone_rendering_count,
            r.unresolved_rendering_count,
            r.ambiguous_component_count,
            r.counts_complete,
        ));
        if r.semantic_counts_certified {
            out.push_str(&format!(
                "\nSummary\n\n  {} strongly supported derived episodes · {} renderings · {} underlying records\n",
                r.strong_derived_episode_count,
                r.rendering_episode_count,
                r.raw_exception_record_count,
            ));
        } else {
            out.push_str(
                "\nSummary\n\n  Semantic episode totals are not certified; raw/rendering counts and unresolved/ambiguous components above are authoritative.\n",
            );
        }
        out.push_str(
            "\n\nNote\n\n  Layers: raw records, physical renderings, retained correlation groups, application propagation chains, strongly supported derived episodes, families. occurrenceCount and semanticOccurrences are legacy JSON names for retained groups, not incident totals. Never claim independent incident counts. Order-only app-app grouping requires an exact unique execution anchor. counts_complete is a deprecated v1 alias and does not alone certify semantic totals. Raw events are unchanged.\n",
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
