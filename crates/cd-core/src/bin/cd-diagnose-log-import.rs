//! Offline privacy-safe log-import diagnostic CLI.
//!
//! ```text
//! cargo run --locked -p cd-core --bin cd-diagnose-log-import -- \
//!   --input PATH --output REPORT.json
//! ```
//!
//! Exit codes: 0 success (useful report written); 1 fail-closed or cancelled
//! report written; 2 usage error. Never publishes into the user library; never
//! contacts a network provider; never overwrites the input or an existing
//! report.

use cd_core::log_analysis::{
    diagnose_log_import, write_import_diagnostic_report, ImportDiagnoseOptions,
    ImportDiagnosticOutcomeKind,
};
use cd_core::process_progress::CancelFlag;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
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
    if let Err(message) = validate_output_boundary(&input, &output) {
        eprintln!("error: {message}");
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
        ImportDiagnosticOutcomeKind::Cancelled => ExitCode::from(1),
        ImportDiagnosticOutcomeKind::FailClosed => ExitCode::from(1),
    }
}

fn validate_output_boundary(input: &Path, output: &Path) -> Result<(), String> {
    if output.components().any(|part| part == Component::ParentDir) {
        return Err("output path must not contain '..'".into());
    }
    if fs::symlink_metadata(output).is_ok() {
        return Err("output path already exists".into());
    }

    let input = fs::canonicalize(input).map_err(|_| "input path cannot be resolved")?;
    let output = resolve_new_path(output).map_err(|_| "output path cannot be resolved")?;
    if output == input || (input.is_dir() && output.starts_with(&input)) {
        return Err("output path must be outside the input tree".into());
    }
    Ok(())
}

fn resolve_new_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for part in missing.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or(err)?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "path has no parent")
                })?;
            }
            Err(err) => return Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_boundary_rejects_input_overwrite_and_nested_output() {
        let dir = tempfile::tempdir().unwrap();
        let input_dir = dir.path().join("logs");
        fs::create_dir(&input_dir).unwrap();
        let input_file = input_dir.join("app.log");
        fs::write(&input_file, b"synthetic").unwrap();

        assert!(validate_output_boundary(&input_file, &input_file).is_err());
        assert!(validate_output_boundary(&input_dir, &input_dir.join("report.json")).is_err());
        assert!(validate_output_boundary(&input_dir, Path::new("../report.json")).is_err());
        assert!(validate_output_boundary(&input_dir, &dir.path().join("report.json")).is_ok());
    }

    #[test]
    fn output_boundary_rejects_any_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.log");
        let output = dir.path().join("report.json");
        fs::write(&input, b"synthetic").unwrap();
        fs::write(&output, b"keep").unwrap();

        assert!(validate_output_boundary(&input, &output).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"keep");
    }
}
