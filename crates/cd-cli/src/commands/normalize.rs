//! `contextdesk normalize` — thin offline adapter over `cd_workflow::normalize`.
//!
//! Entirely local: no provider transport and no OS secret-store reads.

use crate::cli::NormalizeArgs;
use crate::config::OutputFormat;
use crate::envelope::{CliError, CliResult, Render};
use crate::progress::CliProgressObserver;
use cd_core::log_analysis::normalize_export::NormalizeTimezonePolicy;
use cd_core::process_progress::CancelFlag;
use cd_workflow::normalize::{normalize_offline, NormalizeOptions};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Serialize)]
pub struct NormalizeOutput {
    pub output: String,
    pub events: u64,
    pub sources: u64,
    pub sources_examined: u64,
    pub sources_selected: u64,
    pub sources_ignored: u64,
    pub sources_unsupported: u64,
    pub sources_excluded: u64,
    pub sources_failed: u64,
    pub time_source_explicit: u64,
    pub time_producer_resolved: u64,
    pub time_unresolved: u64,
    pub time_order_only: u64,
    pub redactions: u64,
    pub truncations: u64,
    pub formats: BTreeMap<String, u64>,
    pub partial: bool,
    pub files: Vec<String>,
}

impl Render for NormalizeOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "Normalization complete\n\n  Output     {}\n  Events     {}\n  Sources    {}",
            self.output, self.events, self.sources
        );
        out.push_str(&format!(
            "\n\nSelection\n\n  Examined     {}\n  Selected     {}\n  Ignored      {}\n  Unsupported  {}\n  Excluded     {}\n  Failed       {}",
            self.sources_examined,
            self.sources_selected,
            self.sources_ignored,
            self.sources_unsupported,
            self.sources_excluded,
            self.sources_failed
        ));
        out.push_str(&format!(
            "\n\nTime quality\n\n  Explicit           {}\n  Producer-resolved  {}\n  Unresolved         {}\n  Order-only         {}",
            self.time_source_explicit,
            self.time_producer_resolved,
            self.time_unresolved,
            self.time_order_only
        ));
        if self.redactions > 0 || self.truncations > 0 {
            out.push_str(&format!(
                "\n\nPrivacy\n\n  Redacted originals  {}\n  Truncated           {}",
                self.redactions, self.truncations
            ));
        }
        if self.partial {
            out.push_str(
                "\n\nWarning\n\n  Partial output: some selected content failed or was excluded.",
            );
        }
        out.push_str(
            "\n\nFiles written\n\n  manifest.json\n  normalization-report.json\n  sources/*.jsonl",
        );
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("NormalizeOutput serializable")
    }
}

fn parse_timezone_map(raw: Option<&str>) -> CliResult<BTreeMap<String, String>> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(BTreeMap::new());
    };
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| CliError::user(format!("invalid --timezone-map JSON: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| CliError::user("--timezone-map must be a JSON object"))?;
    let mut map = BTreeMap::new();
    for (k, val) in obj {
        let zone = val
            .as_str()
            .ok_or_else(|| {
                CliError::user(format!(
                    "--timezone-map value for {k:?} must be a string IANA zone"
                ))
            })?
            .to_string();
        map.insert(k.clone(), zone);
    }
    Ok(map)
}

/// Resolve source path: relative paths honor `CONTEXTDESK_WORKING_DIR` when set.
fn resolve_source(source: &std::path::Path) -> PathBuf {
    if source.is_absolute() {
        return source.to_path_buf();
    }
    if let Ok(wd) = std::env::var("CONTEXTDESK_WORKING_DIR") {
        let base = PathBuf::from(wd);
        if base.is_dir() {
            return base.join(source);
        }
    }
    source.to_path_buf()
}

pub async fn run(args: &NormalizeArgs, format: OutputFormat) -> CliResult<NormalizeOutput> {
    let map = parse_timezone_map(args.timezone_map.as_deref())?;
    let _output_tz = std::env::var("CONTEXTDESK_OUTPUT_TIMEZONE").unwrap_or_else(|_| "UTC".into());

    let mut timezone = NormalizeTimezonePolicy {
        default_source_timezone: args.source_timezone.clone(),
        timezone_map: map,
        strict_time: args.strict_time,
    };
    if timezone.default_source_timezone.is_none() {
        if let Ok(z) = std::env::var("CONTEXTDESK_SOURCE_TIMEZONE") {
            if !z.trim().is_empty() {
                timezone.default_source_timezone = Some(z);
            }
        }
    }
    if !timezone.strict_time {
        if let Ok(v) = std::env::var("CONTEXTDESK_STRICT_TIME") {
            timezone.strict_time = matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes");
        }
    }

    let source = resolve_source(&args.source);
    if !source.exists() {
        return Err(CliError::not_found(format!(
            "no such file or directory: {}",
            source.display()
        )));
    }

    let options = NormalizeOptions {
        input: source,
        output: args.output.clone(),
        output_format: args.output_format.clone(),
        timezone,
    };

    let cancel = CancelFlag::new();
    let observer = Arc::new(CliProgressObserver::new(format));
    let cancel_for_task = cancel.clone();
    let observer_for_task = observer.clone();
    let options_for_task = options.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        normalize_offline(
            &options_for_task,
            Some(&cancel_for_task),
            observer_for_task.as_ref(),
        )
    });

    let joined = tokio::select! {
        joined = &mut task => joined,
        ctrl_c_result = tokio::signal::ctrl_c() => {
            if ctrl_c_result.is_err() {
                observer.finish();
                return Err(CliError::internal("failed to install Ctrl-C handler"));
            }
            cancel.cancel();
            eprintln!("\ncancelling normalize — no partial output will be published...");
            (&mut task).await
        }
    };
    observer.finish();

    let outcome = match joined {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(core_error)) => {
            if matches!(&core_error, cd_core::error::CoreError::Cancelled) {
                return Err(CliError::cancelled(
                    "normalize cancelled — destination unchanged",
                ));
            }
            let message = core_error.to_string();
            return Err(
                if message.contains("overwrite")
                    || message.contains("non-empty")
                    || message.contains("nothing normalizable")
                    || message.contains("no selected")
                    || message.contains("strict-time")
                    || message.contains("unsupported --output-format")
                {
                    CliError::user(message)
                } else {
                    CliError::internal(message)
                },
            );
        }
        Err(join_error) => {
            return Err(CliError::internal(format!(
                "normalize task panicked: {join_error}"
            )))
        }
    };

    let files: Vec<String> = outcome
        .report
        .sources
        .iter()
        .map(|s| s.relative_path.clone())
        .chain(
            ["manifest.json", "normalization-report.json"]
                .into_iter()
                .map(String::from),
        )
        .collect();

    Ok(NormalizeOutput {
        output: outcome.output.display().to_string(),
        events: outcome.report.events,
        sources: outcome.report.sources.len() as u64,
        sources_examined: outcome.report.sources_examined,
        sources_selected: outcome.report.sources_selected,
        sources_ignored: outcome.report.sources_ignored,
        sources_unsupported: outcome.report.sources_unsupported,
        sources_excluded: outcome.report.sources_excluded,
        sources_failed: outcome.report.sources_failed,
        time_source_explicit: outcome.report.time_source_explicit,
        time_producer_resolved: outcome.report.time_producer_resolved,
        time_unresolved: outcome.report.time_unresolved,
        time_order_only: outcome.report.time_order_only,
        redactions: outcome.report.redactions,
        truncations: outcome.report.truncations,
        formats: outcome.report.formats,
        partial: outcome.report.partial,
        files,
    })
}
