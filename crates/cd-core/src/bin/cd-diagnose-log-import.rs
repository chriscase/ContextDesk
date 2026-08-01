//! Offline privacy-safe log-import diagnostic CLI.
//!
//! ```text
//! cargo run --locked -p cd-core --bin cd-diagnose-log-import -- \
//!   --input PATH --output REPORT.json
//! ```
//!
//! Exit codes: 0 success (useful report written); 1 fail-closed report written;
//! 2 usage error; 3 cancel. Never publishes into the user library; never
//! contacts a network provider; never mutates the input.

use cd_core::log_analysis::{
    diagnose_log_import, write_import_diagnostic_report, ImportDiagnoseOptions,
    ImportDiagnosticOutcomeKind,
};
use cd_core::process_progress::CancelFlag;
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "Usage:\n\
\tcd-diagnose-log-import --input <path> --output <report.json>\n\
\n\
Offline privacy-safe diagnostic for ContextDesk log import.\n\
Runs real preview → plan verification → streaming ingest into a temporary\n\
corpus with embeddings disabled, then deletes that corpus.\n\
The default report is aggregate-only (no log text, paths, basenames, hashes,\n\
credentials, or raw timestamps).\n";

fn usage() -> ExitCode {
    eprint!("{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--input" => {
                i += 1;
                if i >= args.len() {
                    return usage();
                }
                input = Some(PathBuf::from(&args[i]));
            }
            "--output" => {
                i += 1;
                if i >= args.len() {
                    return usage();
                }
                output = Some(PathBuf::from(&args[i]));
            }
            other if other.starts_with("--input=") => {
                input = Some(PathBuf::from(other.trim_start_matches("--input=")));
            }
            other if other.starts_with("--output=") => {
                output = Some(PathBuf::from(other.trim_start_matches("--output=")));
            }
            _ => return usage(),
        }
        i += 1;
    }

    let (Some(input), Some(output)) = (input, output) else {
        return usage();
    };
    if !input.exists() {
        eprintln!("error: input path does not exist");
        return ExitCode::from(2);
    }

    let cancel = CancelFlag::new();
    let report = match diagnose_log_import(
        &input,
        ImportDiagnoseOptions {
            cancel: Some(cancel),
        },
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };

    if let Err(e) = write_import_diagnostic_report(&report, &output) {
        eprintln!("error: write report: {e}");
        return ExitCode::from(1);
    }

    match report.outcome.kind {
        ImportDiagnosticOutcomeKind::Success => ExitCode::SUCCESS,
        ImportDiagnosticOutcomeKind::Cancelled => ExitCode::from(3),
        ImportDiagnosticOutcomeKind::FailClosed => ExitCode::from(1),
    }
}
