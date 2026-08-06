//! `contextdesk logging-assessment` — thin adapter over
//! `cd_workflow::logging_quality`.
//!
//! Zero provider / keychain. Exit 0 when assessment completes (including
//! insufficient/empty corpora). Exit `not_found` (3) when the corpus id is
//! missing. Improvement hints are fixed templates per finding code.

use crate::cli::LoggingAssessmentArgs;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::LoggingQualityAssessment;
use cd_workflow::logging_quality::{
    assess_corpus_logging_quality, assessment_markdown, LoggingQualityAssessmentOptions,
    LoggingQualityReportFormat,
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct LoggingAssessmentOutput {
    pub assessment: LoggingQualityAssessment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_format: Option<String>,
}

impl Render for LoggingAssessmentOutput {
    fn render_text(&self) -> String {
        let a = &self.assessment;
        let mut out = String::new();
        out.push_str(&format!(
            "Logging quality assessment\n\n  Grade      {}\n  Score      {}/100\n  Summary    {}\n",
            a.summary.grade.as_str(),
            a.summary.overall_score,
            a.summary.headline
        ));
        out.push_str(&format!(
            "\nCorpus\n\n  ID         {}\n  Events     {}\n  Templates  {}\n  Partial    {}\n",
            a.corpus.id, a.corpus.event_count, a.corpus.template_count, a.corpus.partial
        ));
        out.push_str(&format!(
            "\nTime quality\n\n  Overall     {:?}\n  Wall-clock  {}\n  Order-only  {}\n  Unresolved  {}\n",
            a.metrics.time_quality,
            a.metrics.wall_event_count,
            a.metrics.order_only_event_count,
            a.metrics.unresolved_local_event_count
        ));
        out.push_str(&format!(
            "\nSelection\n\n  Selected     {}\n  Ignored      {}\n  Unsupported  {}\n  Excluded     {}\n  Failed       {}\n",
            a.metrics.selection.selected_imported,
            a.metrics.selection.ignored,
            a.metrics.selection.unsupported,
            a.metrics.selection.excluded_policy,
            a.metrics.selection.failed
        ));
        if !a.findings.is_empty() {
            out.push_str("\nFindings\n");
            for f in a.findings.iter().take(8) {
                out.push_str(&format!(
                    "\n  {} [{:?}]\n    {}\n    Improvement: {}\n",
                    f.id, f.severity, f.title, f.improvement_hint.template_id
                ));
            }
            if a.findings.len() > 8 {
                out.push_str(&format!("    … {} more\n", a.findings.len() - 8));
            }
        }
        if let Some(path) = &self.output {
            out.push_str(&format!(
                "\nExport\n\n  Wrote   {}\n  Format  {}\n",
                path,
                self.report_format.as_deref().unwrap_or("json")
            ));
        } else {
            out.push_str(
                "\nTip\n\n  Add `--report-format markdown --output plan.md` to export a readable plan.\n",
            );
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("LoggingAssessmentOutput serializable")
    }
}

/// Markdown projection on stdout when `--report-format markdown` without `--output`.
pub struct LoggingAssessmentMarkdownOutput {
    pub markdown: String,
}

impl Render for LoggingAssessmentMarkdownOutput {
    fn render_text(&self) -> String {
        self.markdown.clone()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::json!({ "markdown": self.markdown })
    }
}

pub fn run(
    args: &LoggingAssessmentArgs,
    cache_root: &Path,
    current_corpus: &Option<String>,
) -> CliResult<Box<dyn Render>> {
    let corpus_id = args
        .corpus_id
        .as_deref()
        .or(current_corpus.as_deref())
        .ok_or_else(|| {
            CliError::user("no corpus given and none set - import logs first or pass a corpus id")
        })?;
    let report_format = LoggingQualityReportFormat::parse(&args.report_format)
        .map_err(|e| CliError::user(e.to_string()))?;

    if args.output.is_none() && matches!(report_format, LoggingQualityReportFormat::Markdown) {
        let outcome = assess_corpus_logging_quality(
            cache_root,
            &LoggingQualityAssessmentOptions {
                corpus_id: corpus_id.to_string(),
                output: None,
                report_format: LoggingQualityReportFormat::Json,
            },
        )
        .map_err(map_workflow_err)?;
        return Ok(Box::new(LoggingAssessmentMarkdownOutput {
            markdown: assessment_markdown(&outcome.assessment),
        }));
    }

    let outcome = assess_corpus_logging_quality(
        cache_root,
        &LoggingQualityAssessmentOptions {
            corpus_id: corpus_id.to_string(),
            output: args.output.clone(),
            report_format,
        },
    )
    .map_err(map_workflow_err)?;

    Ok(Box::new(LoggingAssessmentOutput {
        assessment: outcome.assessment,
        output: outcome.output.as_ref().map(|p| p.display().to_string()),
        report_format: outcome.report_format.map(|f| f.as_str().to_string()),
    }))
}

fn map_workflow_err(err: cd_core::error::CoreError) -> CliError {
    let msg = err.to_string();
    if msg.contains("not found") {
        CliError::not_found(msg)
    } else if msg.contains("already exists") || msg.contains("unsupported") {
        CliError::user(msg)
    } else {
        CliError::internal(msg)
    }
}
