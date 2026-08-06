//! `contextdesk normalized` — thin offline adapter over the shared normalized
//! inspection workflow. No parsing or directory policy lives in this host.

use crate::cli::NormalizedAction;
use crate::envelope::{CliError, CliResult, Render};
use cd_core::process_progress::CancelFlag;
use cd_workflow::normalized::{
    summarize_normalized_path, validate_normalized_path, NormalizedSummaryReport,
    NormalizedValidationReport,
};

#[derive(Debug)]
pub enum NormalizedOutput {
    Validation(NormalizedValidationReport),
    Summary(NormalizedSummaryReport),
}

impl NormalizedOutput {
    pub fn is_conforming(&self) -> bool {
        match self {
            Self::Validation(report) => report.ok,
            Self::Summary(report) => report.ok,
        }
    }
}

impl Render for NormalizedOutput {
    fn render_text(&self) -> String {
        match self {
            Self::Validation(report) => render_validation(report),
            Self::Summary(report) => render_summary(report),
        }
    }

    fn render_json(&self) -> serde_json::Value {
        match self {
            Self::Validation(report) => serde_json::to_value(report),
            Self::Summary(report) => serde_json::to_value(report),
        }
        .expect("normalized inspection report is serializable")
    }
}

pub async fn run(action: &NormalizedAction) -> CliResult<NormalizedOutput> {
    let (input, summarize) = match action {
        NormalizedAction::Validate(args) => (&args.input, false),
        NormalizedAction::Summarize(args) => (&args.input, true),
    };
    let input = resolve_input(input);
    if !input.exists() {
        return Err(CliError::not_found("normalized input was not found"));
    }

    let cancel = CancelFlag::new();
    let cancel_for_task = cancel.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        if summarize {
            summarize_normalized_path(&input, Some(&cancel_for_task)).map(NormalizedOutput::Summary)
        } else {
            validate_normalized_path(&input, Some(&cancel_for_task))
                .map(NormalizedOutput::Validation)
        }
    });
    let joined = tokio::select! {
        joined = &mut task => joined,
        signal = tokio::signal::ctrl_c() => {
            if signal.is_err() {
                return Err(CliError::internal("failed to install Ctrl-C handler"));
            }
            cancel.cancel();
            (&mut task).await
        }
    };
    match joined {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(cd_core::error::CoreError::Cancelled)) => Err(CliError::cancelled(
            "normalized inspection cancelled; input was not modified",
        )),
        Ok(Err(error)) => Err(CliError::user(error.to_string())),
        Err(error) => Err(CliError::internal(format!(
            "normalized inspection task panicked: {error}"
        ))),
    }
}

fn resolve_input(input: &std::path::Path) -> std::path::PathBuf {
    if input.is_absolute() {
        return input.to_path_buf();
    }
    if let Ok(directory) = std::env::var("CONTEXTDESK_WORKING_DIR") {
        let directory = std::path::PathBuf::from(directory);
        if directory.is_dir() {
            return directory.join(input);
        }
    }
    input.to_path_buf()
}

fn render_validation(report: &NormalizedValidationReport) -> String {
    let verdict = if report.ok {
        "CONFORMING"
    } else {
        "NOT CONFORMING"
    };
    let mut out = format!(
        "{verdict}\n\n  Files examined       {}\n  Files conforming     {}\n  Files nonconforming  {}\n  Events validated     {}\n  Diagnostics          {}",
        report.files_examined,
        report.files_conforming,
        report.files_nonconforming,
        report.events_validated,
        report.diagnostics_total
    );
    for file in &report.files {
        let status = if file.validation.ok { "ok" } else { "invalid" };
        out.push_str(&format!("\n\n  {}  {}", status, file.path));
        for diagnostic in &file.validation.diagnostics {
            let code = serde_json::to_value(diagnostic.code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown".into());
            out.push_str(&format!(
                "\n    record {}: {} at {}",
                diagnostic.line,
                code,
                diagnostic.location.as_deref().unwrap_or("-")
            ));
        }
        if file.validation.diagnostics_truncated {
            out.push_str(&format!(
                "\n    showing first {} of {} diagnostics",
                file.validation.diagnostics.len(),
                file.validation.diagnostics_total
            ));
        }
    }
    out
}

fn render_summary(report: &NormalizedSummaryReport) -> String {
    let verdict = if report.ok {
        "CONFORMING"
    } else {
        "NOT CONFORMING"
    };
    let mut out = format!(
        "{verdict}\n\n  Files examined       {}\n  Files conforming     {}\n  Files nonconforming  {}\n  Events validated     {}\n  Diagnostics          {}",
        report.files_examined,
        report.files_conforming,
        report.files_nonconforming,
        report.events_validated,
        report.diagnostics_total
    );
    if report.diagnostics_truncated {
        out.push_str("\n  Diagnostic counts below are from the bounded sample.");
    }
    for (code, count) in &report.diagnostic_sample_counts {
        out.push_str(&format!("\n    {code}: {count}"));
    }
    out
}
