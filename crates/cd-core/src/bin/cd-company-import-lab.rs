//! One-command public-safe company import acceptance laboratory.
//!
//! ```text
//! # Generate + verify default ~75k package under ./company-import-lab-out
//! cargo run --locked -p cd-core --bin cd-company-import-lab -- release --size 75k --out ./company-import-lab-out
//!
//! # Sizes: 25k | 75k | 250k
//! cargo run --locked -p cd-core --bin cd-company-import-lab -- generate --size 25k --out /tmp/lab25
//! cargo run --locked -p cd-core --bin cd-company-import-lab -- verify --package /tmp/lab25
//! ```
//!
//! Exit codes: 0 pass; 1 oracle drift / production mismatch; 2 usage.

use cd_core::log_analysis::{
    generate_company_import_lab, verify_company_import_lab, CompanyImportLabSize,
};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
Usage:
  cd-company-import-lab release --size <25k|75k|250k> --out <dir>
  cd-company-import-lab generate --size <25k|75k|250k> --out <dir>
  cd-company-import-lab verify --package <dir>

Public-safe deterministic company-import acceptance laboratory.
Generates a synthetic ZIP corpus + aggregate oracle, then runs the
production import / timezone / diagnose path. Emits only aggregate JSON.
Never inspects private company logs.
";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        eprint!("{USAGE}");
        return if args.is_empty() {
            ExitCode::from(2)
        } else {
            ExitCode::SUCCESS
        };
    }

    let cmd = args[0].as_str();
    match cmd {
        "generate" => {
            let (size, out) = match parse_size_out(&args[1..]) {
                Ok(v) => v,
                Err(msg) => {
                    eprintln!("error: {msg}");
                    eprint!("{USAGE}");
                    return ExitCode::from(2);
                }
            };
            match generate_company_import_lab(&out, size) {
                Ok(pkg) => {
                    println!(
                        "{{\"ok\":true,\"action\":\"generate\",\"size\":\"{}\",\"plannedEvents\":{},\"package\":\"{}\",\"oracle\":\"{}\",\"packageSha256\":\"{}\"}}",
                        size.as_str(),
                        pkg.oracle.planned_events_total,
                        pkg.zip_path.display(),
                        pkg.oracle_path.display(),
                        pkg.oracle.package_sha256
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("error: generate failed: {e}");
                    ExitCode::from(1)
                }
            }
        }
        "verify" => {
            let package = match parse_package(&args[1..]) {
                Ok(v) => v,
                Err(msg) => {
                    eprintln!("error: {msg}");
                    eprint!("{USAGE}");
                    return ExitCode::from(2);
                }
            };
            match verify_company_import_lab(&package) {
                Ok(report) => {
                    match serde_json::to_string_pretty(&report) {
                        Ok(json) => println!("{json}"),
                        Err(e) => {
                            eprintln!("error: serialize report: {e}");
                            return ExitCode::from(1);
                        }
                    }
                    if report.passed {
                        ExitCode::SUCCESS
                    } else {
                        eprintln!("oracle drift: {} failure(s)", report.failures.len());
                        ExitCode::from(1)
                    }
                }
                Err(e) => {
                    eprintln!("error: verify failed: {e}");
                    ExitCode::from(1)
                }
            }
        }
        "release" => {
            let (size, out) = match parse_size_out(&args[1..]) {
                Ok(v) => v,
                Err(msg) => {
                    eprintln!("error: {msg}");
                    eprint!("{USAGE}");
                    return ExitCode::from(2);
                }
            };
            if let Err(e) = generate_company_import_lab(&out, size) {
                eprintln!("error: generate failed: {e}");
                return ExitCode::from(1);
            }
            match verify_company_import_lab(&out) {
                Ok(report) => {
                    match serde_json::to_string_pretty(&report) {
                        Ok(json) => println!("{json}"),
                        Err(e) => {
                            eprintln!("error: serialize report: {e}");
                            return ExitCode::from(1);
                        }
                    }
                    if report.passed {
                        ExitCode::SUCCESS
                    } else {
                        eprintln!("oracle drift: {} failure(s)", report.failures.len());
                        for f in &report.failures {
                            eprintln!("  - {f}");
                        }
                        ExitCode::from(1)
                    }
                }
                Err(e) => {
                    eprintln!("error: verify failed: {e}");
                    ExitCode::from(1)
                }
            }
        }
        other => {
            eprintln!("error: unknown command {other}");
            eprint!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn parse_size_out(args: &[String]) -> Result<(CompanyImportLabSize, PathBuf), String> {
    let mut size = CompanyImportLabSize::Medium;
    let mut out: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--size" => {
                i += 1;
                if i >= args.len() {
                    return Err("--size requires a value".into());
                }
                size = CompanyImportLabSize::parse(&args[i])
                    .ok_or_else(|| format!("invalid size {}", args[i]))?;
            }
            "--out" => {
                i += 1;
                if i >= args.len() {
                    return Err("--out requires a path".into());
                }
                out = Some(PathBuf::from(&args[i]));
            }
            other if other.starts_with("--size=") => {
                let v = other.trim_start_matches("--size=");
                size = CompanyImportLabSize::parse(v).ok_or_else(|| format!("invalid size {v}"))?;
            }
            other if other.starts_with("--out=") => {
                out = Some(PathBuf::from(other.trim_start_matches("--out=")));
            }
            other => return Err(format!("unexpected argument {other}")),
        }
        i += 1;
    }
    let out = out.ok_or_else(|| "--out is required".to_string())?;
    Ok((size, out))
}

fn parse_package(args: &[String]) -> Result<PathBuf, String> {
    let mut package: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--package" => {
                i += 1;
                if i >= args.len() {
                    return Err("--package requires a path".into());
                }
                package = Some(PathBuf::from(&args[i]));
            }
            other if other.starts_with("--package=") => {
                package = Some(PathBuf::from(other.trim_start_matches("--package=")));
            }
            other => return Err(format!("unexpected argument {other}")),
        }
        i += 1;
    }
    package.ok_or_else(|| "--package is required".to_string())
}
