//! `contextdesk capabilities` — a stable, machine-readable description of
//! this build: envelope schema version, exit-code categories, and the
//! command grammar. A script should probe this once rather than parsing
//! `--help` text, which is for humans and may reflow at any time.

use crate::envelope::{ExitCategory, Render, ENVELOPE_SCHEMA_VERSION};
use cd_core::branding::Branding;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ExitCategoryDoc {
    pub code: i32,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CapabilitiesOutput {
    pub product_name: String,
    pub cli_version: &'static str,
    pub envelope_schema_version: u32,
    /// Embedded compile-time git identity from `cd_core::build_identity`
    /// (`CD_GIT_SHA` / build.rs). Present when the binary was built with git
    /// metadata; `null` when unavailable (fail-closed for exact-head acceptance).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_sha: Option<String>,
    /// Optional `git describe` string when embedded at build time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_describe: Option<String>,
    /// Build channel (`dev` / `installed`) from the same identity snapshot.
    pub build_channel: String,
    pub exit_categories: Vec<ExitCategoryDoc>,
    pub commands: Vec<&'static str>,
    /// Nonzero exits that still carry a completed `ok:true` report envelope.
    pub completed_verdict_categories: Vec<ExitCategoryDoc>,
    pub normalized: NormalizedCapabilities,
    /// Semantic ingest-pipeline identity this binary stamps on new corpora.
    /// Not a Git SHA — covers parse/frame/normalize/template/storage semantics.
    pub ingest_pipeline_identity: &'static str,
    /// Privacy-safe summary of what [`Self::ingest_pipeline_identity`] covers.
    pub ingest_pipeline_semantics: &'static str,
}

#[derive(Debug, Serialize)]
pub struct NormalizedCapabilities {
    pub event_schema_id: &'static str,
    pub event_reader_version: u32,
    pub validation_schema_id: &'static str,
    pub summary_schema_id: &'static str,
    pub inspection_schema_version: u32,
    pub max_line_bytes: usize,
    pub max_files: usize,
    pub max_directories: usize,
    pub max_directory_entries: usize,
    pub max_directory_depth: usize,
    pub max_retained_diagnostics: usize,
    pub max_retained_error_samples: usize,
}

impl Render for CapabilitiesOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "{} CLI — contextdesk {} (envelope schema {})\n",
            self.product_name, self.cli_version, self.envelope_schema_version
        );
        if let Some(sha) = &self.git_sha {
            out.push_str(&format!("git={sha} channel={}\n", self.build_channel));
        } else {
            out.push_str(&format!("git=(none) channel={}\n", self.build_channel));
        }
        out.push_str(&format!(
            "ingest_pipeline={} ({})\n",
            self.ingest_pipeline_identity, self.ingest_pipeline_semantics
        ));
        out.push_str("\nexit codes:\n");
        for c in &self.exit_categories {
            out.push_str(&format!("  {:>3}  {}\n", c.code, c.kind));
        }
        out.push_str("\ncommands:\n");
        for c in &self.commands {
            out.push_str(&format!("  {c}\n"));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("CapabilitiesOutput is always serializable")
    }
}

const CATEGORIES: &[ExitCategory] = &[
    ExitCategory::Success,
    ExitCategory::UserError,
    ExitCategory::NotFound,
    ExitCategory::Conflict,
    ExitCategory::PermissionDenied,
    ExitCategory::ProviderError,
    ExitCategory::NotImplemented,
    ExitCategory::Cancelled,
    ExitCategory::NotReady,
    ExitCategory::NonConforming,
    ExitCategory::Partial,
    ExitCategory::Internal,
];

const COMMANDS: &[&str] = &[
    "import",
    "normalize",
    "normalized validate",
    "normalized summarize",
    "corpus list",
    "corpus show",
    "corpus rename",
    "corpus delete",
    "corpus use",
    "timezone status",
    "timezone apply",
    "timezone clear",
    "timezone apply-all",
    "explore",
    "context",
    "session list",
    "session show",
    "chat",
    "config init",
    "config validate",
    "config show",
    "config path",
    "capabilities",
    "doctor",
    "models",
    "retrieval-status",
    "logging-assessment",
    "exception-episodes",
    "eval suites",
    "eval validate",
    "eval run",
    "triage-policy validate",
    "triage-policy compile",
    "triage-policy example",
    "triage-policy store",
    "triage-policy qualify",
];

pub fn run(branding: &Branding) -> CapabilitiesOutput {
    let id = cd_core::build_identity::current();
    CapabilitiesOutput {
        product_name: branding.name.clone(),
        cli_version: env!("CARGO_PKG_VERSION"),
        envelope_schema_version: ENVELOPE_SCHEMA_VERSION,
        git_sha: id.git_sha,
        git_describe: id.git_describe,
        build_channel: id.channel.as_str().to_string(),
        exit_categories: CATEGORIES
            .iter()
            .map(|c| ExitCategoryDoc {
                code: c.code(),
                kind: c.kind(),
            })
            .collect(),
        commands: COMMANDS.to_vec(),
        completed_verdict_categories: [
            ExitCategory::NotReady,
            ExitCategory::NonConforming,
            ExitCategory::Partial,
        ]
        .into_iter()
        .map(|category| ExitCategoryDoc {
            code: category.code(),
            kind: category.kind(),
        })
        .collect(),
        normalized: NormalizedCapabilities {
            event_schema_id: cd_core::normalized_log_events::NORMALIZED_LOG_EVENTS_SCHEMA_ID,
            event_reader_version:
                cd_core::normalized_log_events::NORMALIZED_LOG_EVENTS_READER_VERSION,
            validation_schema_id: cd_workflow::normalized::NORMALIZED_VALIDATION_SCHEMA_ID,
            summary_schema_id: cd_workflow::normalized::NORMALIZED_SUMMARY_SCHEMA_ID,
            inspection_schema_version:
                cd_workflow::normalized::NORMALIZED_INSPECTION_SCHEMA_VERSION,
            max_line_bytes: cd_core::normalized_log_events::MAX_NORMALIZED_LINE_BYTES,
            max_files: cd_workflow::normalized::MAX_NORMALIZED_FILES,
            max_directories: cd_workflow::normalized::MAX_NORMALIZED_DIRECTORIES,
            max_directory_entries: cd_workflow::normalized::MAX_NORMALIZED_DIRECTORY_ENTRIES,
            max_directory_depth: cd_workflow::normalized::MAX_DIRECTORY_DEPTH,
            max_retained_diagnostics: cd_workflow::normalized::MAX_RETAINED_DIAGNOSTICS,
            max_retained_error_samples: cd_workflow::normalized::MAX_RETAINED_ERROR_SAMPLES,
        },
        ingest_pipeline_identity: cd_core::log_analysis::INGEST_PIPELINE_IDENTITY,
        ingest_pipeline_semantics: cd_core::log_analysis::INGEST_PIPELINE_SEMANTICS,
    }
}
