//! Offline CLI for Incident Evidence Bundle v1 (#764 / #765).
//!
//! ```text
//! cd-validate-incident-evidence validate <directory-or-zip>
//! cd-validate-incident-evidence pack <directory> --output <bundle.zip> [--force]
//! ```
//!
//! Exit codes: 0 success; 1 validation/pack failure; 2 usage error.
//! No network. Does not publish product state.

use cd_core::incident_evidence::{
    format_report_text, sanitize_report_message, sanitize_report_path, validate_directory,
};
use cd_core::incident_evidence_archive::{format_pack_report, pack_directory, validate_archive};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!(
        "Usage:\n\
         \tcd-validate-incident-evidence validate <directory-or-zip>\n\
         \tcd-validate-incident-evidence pack <directory> --output <bundle.zip> [--force]\n\
         \n\
         Offline tool for contextdesk.incident_evidence.v1.\n\
         Pack uses Stored compression, fixed 1980-01-01 timestamps, sorted paths.\n\
         Product import/attachment UX remains residual (#763)."
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        return usage();
    }

    // Back-compat: bare path implies validate.
    let cmd = if args[0] == "validate" || args[0] == "pack" {
        args.remove(0)
    } else {
        "validate".into()
    };

    match cmd.as_str() {
        "validate" => {
            if args.is_empty() {
                return usage();
            }
            let path = PathBuf::from(&args[0]);
            let report = if path.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
            {
                validate_archive(&path)
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
        "pack" => {
            if args.is_empty() {
                return usage();
            }
            let dir = PathBuf::from(&args[0]);
            let mut output: Option<PathBuf> = None;
            let mut force = false;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--output" | "-o" => {
                        i += 1;
                        if i >= args.len() {
                            return usage();
                        }
                        output = Some(PathBuf::from(&args[i]));
                    }
                    "--force" | "-f" => force = true,
                    _ => return usage(),
                }
                i += 1;
            }
            let Some(out) = output else {
                eprintln!("pack requires --output <bundle.zip>");
                return usage();
            };
            match pack_directory(&dir, &out, force) {
                Ok(r) => {
                    println!("{}", format_pack_report(&r));
                    ExitCode::SUCCESS
                }
                Err(diags) => {
                    eprintln!("incident-evidence-pack ok=false");
                    for d in diags {
                        eprintln!(
                            "{} | {} | {}",
                            d.code,
                            sanitize_report_path(&d.path),
                            sanitize_report_message(&d.message)
                        );
                    }
                    ExitCode::from(1)
                }
            }
        }
        _ => usage(),
    }
}
