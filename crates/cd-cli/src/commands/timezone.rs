//! Timezone review — thin wrapper over
//! `cd_core::log_analysis::timezone_application`. Every call here is
//! revision-bound: state is re-read fresh immediately before each
//! preview/apply so a concurrent mutation (another process, another host)
//! is caught as a conflict rather than silently overwritten.

use crate::cli::TimezoneAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::log_analysis::timezone_application::{
    apply_source_timezone, clear_source_timezone, load_timezone_resolution_state,
    preview_source_timezone,
};
use cd_core::log_analysis::timezone_resolution::TimezoneDeclarationBasis;
use cd_workflow::timezone::apply_timezone_to_all_unresolved;
use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct SourceStatus {
    pub source: String,
    pub resolved_local_records: u64,
    pub unresolved_local_records: u64,
    pub explicit_wall_clock_records: u64,
}

#[derive(Debug, Serialize)]
pub struct StatusOutput {
    pub corpus_id: String,
    pub event_revision: u64,
    pub sources: Vec<SourceStatus>,
}

impl Render for StatusOutput {
    fn render_text(&self) -> String {
        if self.sources.is_empty() {
            return format!(
                "{}: no sources carry local-timestamp evidence needing a timezone declaration.",
                self.corpus_id
            );
        }
        let mut out = format!("{} (revision {})\n", self.corpus_id, self.event_revision);
        for s in &self.sources {
            let flag = if s.unresolved_local_records > 0 {
                " [UNRESOLVED]"
            } else {
                ""
            };
            out.push_str(&format!(
                "  {}  resolved={} unresolved={} wall_clock={}{}\n",
                s.source,
                s.resolved_local_records,
                s.unresolved_local_records,
                s.explicit_wall_clock_records,
                flag
            ));
        }
        out.trim_end().to_string()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("StatusOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct ApplyOutput {
    pub corpus_id: String,
    pub source: String,
    pub iana_timezone: String,
    pub affected_records: u64,
    pub applied_revision: u64,
}

impl Render for ApplyOutput {
    fn render_text(&self) -> String {
        format!(
            "{}: applied {} to {} ({} records affected, now revision {})",
            self.corpus_id,
            self.iana_timezone,
            self.source,
            self.affected_records,
            self.applied_revision
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ApplyOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct ApplyAllOutput {
    pub corpus_id: String,
    pub iana_timezone: String,
    pub applied_sources: Vec<String>,
    pub already_resolved: bool,
}

impl Render for ApplyAllOutput {
    fn render_text(&self) -> String {
        if self.already_resolved {
            return format!(
                "{}: no sources had ambiguous local timestamps — nothing to apply",
                self.corpus_id
            );
        }
        format!(
            "{}: applied {} to {} source(s) in one revision — {}",
            self.corpus_id,
            self.iana_timezone,
            self.applied_sources.len(),
            self.applied_sources.join(", ")
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ApplyAllOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct ClearOutput {
    pub corpus_id: String,
    pub source: String,
    pub applied_revision: u64,
}

impl Render for ClearOutput {
    fn render_text(&self) -> String {
        format!(
            "{}: cleared declaration for {} (now revision {})",
            self.corpus_id, self.source, self.applied_revision
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ClearOutput is always serializable")
    }
}

fn require_corpus<'a>(
    explicit: &'a Option<String>,
    current: &'a Option<String>,
) -> CliResult<&'a str> {
    explicit.as_deref().or(current.as_deref()).ok_or_else(|| {
        CliError::user(
            "no corpus given and none set — pass --corpus or run `contextdesk corpus use <id>`",
        )
    })
}

pub fn run(
    action: &TimezoneAction,
    cache_root: &Path,
    current_corpus: &Option<String>,
) -> CliResult<Box<dyn Render>> {
    match action {
        TimezoneAction::Status { corpus } => {
            let corpus_id = require_corpus(corpus, current_corpus)?;
            let state = load_state(cache_root, corpus_id)?;
            Ok(Box::new(StatusOutput {
                corpus_id: corpus_id.to_string(),
                event_revision: state.scope.event_revision,
                sources: state
                    .sources
                    .into_iter()
                    .map(|s| SourceStatus {
                        source: s.source,
                        resolved_local_records: s.resolved_local_records,
                        unresolved_local_records: s.unresolved_local_records,
                        explicit_wall_clock_records: s.explicit_wall_clock_records,
                    })
                    .collect(),
            }))
        }
        TimezoneAction::Apply {
            source,
            iana_timezone,
            corpus,
            yes,
        } => {
            let corpus_id = require_corpus(corpus, current_corpus)?;
            let state = load_state(cache_root, corpus_id)?;
            let expected_revision = state.scope.event_revision;
            let preview = preview_source_timezone(
                cache_root,
                corpus_id,
                expected_revision,
                source,
                iana_timezone,
            )
            .map_err(map_apply_error)?;
            if !*yes {
                return Err(CliError::user(format!(
                    "refusing to apply without --yes — preview: {} of {} affected records; re-run with --yes to confirm",
                    preview.affected_records,
                    preview.affected_records + preview.unchanged_order_only_records
                )));
            }
            let declared_at = now_secs();
            let report = apply_source_timezone(
                cache_root,
                corpus_id,
                expected_revision,
                source,
                iana_timezone,
                &preview.declaration_fingerprint,
                declared_at,
            )
            .map_err(map_apply_error)?;
            Ok(Box::new(ApplyOutput {
                corpus_id: corpus_id.to_string(),
                source: source.clone(),
                iana_timezone: iana_timezone.clone(),
                affected_records: preview.affected_records,
                applied_revision: report.revision,
            }))
        }
        TimezoneAction::Clear { source, corpus } => {
            let corpus_id = require_corpus(corpus, current_corpus)?;
            let state = load_state(cache_root, corpus_id)?;
            let expected_revision = state.scope.event_revision;
            let declared_applied_revision = state
                .declarations
                .get(source)
                .map(|d| d.applied_revision)
                .ok_or_else(|| {
                    CliError::not_found(format!("no declaration for source {source}"))
                })?;
            let report = clear_source_timezone(
                cache_root,
                corpus_id,
                expected_revision,
                source,
                declared_applied_revision,
            )
            .map_err(map_apply_error)?;
            Ok(Box::new(ClearOutput {
                corpus_id: corpus_id.to_string(),
                source: source.clone(),
                applied_revision: report.revision,
            }))
        }
        TimezoneAction::ApplyAll {
            iana_timezone,
            corpus,
            yes,
        } => {
            let corpus_id = require_corpus(corpus, current_corpus)?;
            if !*yes {
                let unresolved = load_state(cache_root, corpus_id)?
                    .sources
                    .iter()
                    .filter(|s| s.unresolved_local_records > 0)
                    .count();
                if unresolved == 0 {
                    return Ok(Box::new(ApplyAllOutput {
                        corpus_id: corpus_id.to_string(),
                        iana_timezone: iana_timezone.clone(),
                        applied_sources: Vec::new(),
                        already_resolved: true,
                    }));
                }
                return Err(CliError::user(format!(
                    "refusing to apply {iana_timezone} to {unresolved} unresolved source(s) without --yes"
                )));
            }
            let outcome = apply_timezone_to_all_unresolved(
                cache_root,
                corpus_id,
                iana_timezone,
                TimezoneDeclarationBasis::UserDeclared,
            )
            .map_err(map_apply_error)?;
            Ok(Box::new(ApplyAllOutput {
                corpus_id: corpus_id.to_string(),
                iana_timezone: iana_timezone.clone(),
                applied_sources: outcome.applied_sources,
                already_resolved: outcome.already_resolved,
            }))
        }
    }
}

fn load_state(
    cache_root: &Path,
    corpus_id: &str,
) -> CliResult<cd_core::log_analysis::timezone_application::TimezoneResolutionState> {
    load_timezone_resolution_state(cache_root, corpus_id).map_err(|e| {
        if e.to_string().contains("no such corpus") || e.to_string().contains("not found") {
            CliError::not_found(format!("no corpus {corpus_id}"))
        } else {
            CliError::internal(e.to_string())
        }
    })
}

fn map_apply_error(error: cd_core::error::CoreError) -> CliError {
    let message = error.to_string();
    if message.contains("stale") || message.contains("revision") {
        CliError::conflict(message)
    } else if message.contains("invalid") {
        CliError::user(message)
    } else {
        CliError::internal(message)
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
