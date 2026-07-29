//! Offline CLI for Incident Evidence Bundle v1 directory validation (#764).
//!
//! Usage:
//!   cd-validate-incident-evidence <bundle-directory>
//!
//! Exit code 0 when ok; 1 when validation fails; 2 on usage error.
//! No network. Does not publish product state.

use cd_core::incident_evidence::{
    format_report_text, validate_archive_residual, validate_directory,
};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!(
            "Usage: cd-validate-incident-evidence <bundle-directory>\n\
             Offline validator for contextdesk.incident_evidence.v1 (directory form).\n\
             Archive production/validation is residual (#763 later slice)."
        );
        return ExitCode::from(2);
    }
    let path = PathBuf::from(args.remove(0));
    let report = if path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        validate_archive_residual(&path)
    } else {
        validate_directory(&path)
    };
    println!("{}", format_report_text(&report));
    if report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
