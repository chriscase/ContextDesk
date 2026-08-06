//! Host-neutral logging quality assessment workflow.
//!
//! Opens a durable corpus by id, runs the pure `cd_core` assessor, and
//! optionally publishes an atomic report (JSON source of truth, Markdown
//! projection). CLI/Tauri/API hosts must call this rather than re-deriving
//! scores or inventing a second report writer.

use cd_core::error::{CoreError, CoreResult};
use cd_core::log_analysis::{
    assess_logging_quality, render_logging_quality_markdown, validate_logging_quality_json,
    LogCorpus, LoggingQualityAssessment, LOGGING_QUALITY_SCHEMA_ID,
};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Options for one assessment run.
#[derive(Debug, Clone)]
pub struct LoggingQualityAssessmentOptions {
    /// Corpus id to assess.
    pub corpus_id: String,
    /// Optional atomic report export path.
    pub output: Option<PathBuf>,
    /// Export format when [`Self::output`] is set.
    pub report_format: LoggingQualityReportFormat,
}

/// On-disk report format for atomic export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoggingQualityReportFormat {
    /// Pretty JSON ([`LoggingQualityAssessment`]) — source of truth.
    Json,
    /// Markdown projection of the JSON assessment.
    Markdown,
}

impl LoggingQualityReportFormat {
    /// Parse a CLI/API format string.
    pub fn parse(raw: &str) -> CoreResult<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Self::Json),
            "markdown" | "md" => Ok(Self::Markdown),
            other => Err(CoreError::Message(format!(
                "unsupported logging-assessment report format {other:?}; use json or markdown"
            ))),
        }
    }

    /// Stable wire id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Markdown => "markdown",
        }
    }
}

/// Outcome of one host-neutral assessment.
#[derive(Debug, Clone)]
pub struct LoggingQualityAssessmentOutcome {
    /// Shared assessment DTO.
    pub assessment: LoggingQualityAssessment,
    /// Absolute path written when export was requested.
    pub output: Option<PathBuf>,
    /// Format written when export was requested.
    pub report_format: Option<LoggingQualityReportFormat>,
}

/// Assess an imported corpus by id under `cache_root`.
pub fn assess_corpus_logging_quality(
    cache_root: &Path,
    options: &LoggingQualityAssessmentOptions,
) -> CoreResult<LoggingQualityAssessmentOutcome> {
    let corpus = LogCorpus::open(cache_root, &options.corpus_id).map_err(|err| {
        CoreError::Message(format!(
            "corpus {} not found or unreadable: {err}",
            options.corpus_id
        ))
    })?;
    let assessment = assess_logging_quality(&corpus)?;

    let mut output_written = None;
    let mut format_written = None;
    if let Some(path) = &options.output {
        publish_assessment_report(&assessment, path, options.report_format)?;
        output_written = Some(path.clone());
        format_written = Some(options.report_format);
    }

    Ok(LoggingQualityAssessmentOutcome {
        assessment,
        output: output_written,
        report_format: format_written,
    })
}

/// Render Markdown for hosts that stream text without writing a file.
pub fn assessment_markdown(assessment: &LoggingQualityAssessment) -> String {
    render_logging_quality_markdown(assessment)
}

/// Atomic publication: stage → validate → persist_noclobber.
///
/// On validation failure or noclobber conflict, no destination report remains.
pub fn publish_assessment_report(
    assessment: &LoggingQualityAssessment,
    output: &Path,
    format: LoggingQualityReportFormat,
) -> CoreResult<()> {
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CoreError::Message(format!("create logging quality output parent: {e}"))
            })?;
        }
    }
    let parent = output.parent().filter(|p| !p.as_os_str().is_empty());
    let temp_parent = parent.unwrap_or_else(|| Path::new("."));

    // Always stage JSON first (source of truth), validate, then either publish
    // JSON bytes or derive Markdown from the validated assessment.
    let json = serde_json::to_vec_pretty(assessment)
        .map_err(|e| CoreError::Message(format!("serialize logging quality report: {e}")))?;
    let validated = validate_logging_quality_json(&json)?;
    if validated.schema_id != LOGGING_QUALITY_SCHEMA_ID {
        return Err(CoreError::Message(
            "validated assessment schema_id mismatch".into(),
        ));
    }

    let bytes = match format {
        LoggingQualityReportFormat::Json => json,
        LoggingQualityReportFormat::Markdown => {
            render_logging_quality_markdown(&validated).into_bytes()
        }
    };

    let mut staged = tempfile::NamedTempFile::new_in(temp_parent)
        .map_err(|e| CoreError::Message(format!("stage logging quality report: {e}")))?;
    staged
        .write_all(&bytes)
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|e| {
            // Drop staging file on write failure — NamedTempFile cleans up.
            CoreError::Message(format!("write logging quality report staging: {e}"))
        })?;
    staged.persist_noclobber(output).map_err(|_| {
        CoreError::Message(
            "publish logging quality report: output already exists or cannot be created".into(),
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
    use cd_core::log_analysis::ingest::ingest_path_with_policy;
    use std::fs;
    use tempfile::TempDir;

    fn ingest_one(cache: &Path, src: &Path) -> String {
        let policy = LogEmbedPolicy {
            mode: LogEmbedMode::None,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: "test-none".into(),
            defer_above_source_bytes: None,
        };
        ingest_path_with_policy(cache, src, "wf-lq", &policy, None)
            .unwrap()
            .corpus_id
    }

    #[test]
    fn workflow_dto_matches_core_and_atomic_markdown() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(
            src.join("app.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"hello"}"#,
                "\n",
            ),
        )
        .unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_one(&cache, &src);

        let out_path = tmp.path().join("plan.md");
        let outcome = assess_corpus_logging_quality(
            &cache,
            &LoggingQualityAssessmentOptions {
                corpus_id: corpus_id.clone(),
                output: Some(out_path.clone()),
                report_format: LoggingQualityReportFormat::Markdown,
            },
        )
        .unwrap();

        let corpus = LogCorpus::open(&cache, &corpus_id).unwrap();
        let direct = assess_logging_quality(&corpus).unwrap();
        assert_eq!(outcome.assessment, direct);
        assert!(out_path.is_file());
        let md = fs::read_to_string(&out_path).unwrap();
        assert!(md.contains("Logging Quality Assessment"));
        assert!(md.contains("JSON is the source of truth"));
        assert!(!md.contains("Engineering Improvement Plan"));
        assert!(!md.to_lowercase().contains("api_key"));

        // noclobber leaves existing report untouched and errors
        let err = publish_assessment_report(
            &outcome.assessment,
            &out_path,
            LoggingQualityReportFormat::Markdown,
        )
        .unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn atomic_json_export_validates_schema() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(
            src.join("app.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"WARN","msg":"x"}"#,
                "\n",
            ),
        )
        .unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_one(&cache, &src);
        let out = tmp.path().join("report.json");
        let outcome = assess_corpus_logging_quality(
            &cache,
            &LoggingQualityAssessmentOptions {
                corpus_id,
                output: Some(out.clone()),
                report_format: LoggingQualityReportFormat::Json,
            },
        )
        .unwrap();
        let bytes = fs::read(&out).unwrap();
        let round = validate_logging_quality_json(&bytes).unwrap();
        assert_eq!(round, outcome.assessment);
    }

    #[test]
    fn missing_corpus_is_not_found_style_error() {
        let tmp = TempDir::new().unwrap();
        let err = assess_corpus_logging_quality(
            tmp.path(),
            &LoggingQualityAssessmentOptions {
                corpus_id: "does-not-exist".into(),
                output: None,
                report_format: LoggingQualityReportFormat::Json,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not found"));
        // No report left behind when assessment never started
        assert!(!tmp.path().join("report.json").exists());
    }
}
