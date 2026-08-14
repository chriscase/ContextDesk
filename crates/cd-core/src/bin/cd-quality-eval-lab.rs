//! Hermetic quality-evaluation lab (issue #867).
//!
//! Offline only: reads committed OPEN fixtures, scores retrieval rankings and
//! scripted answers, emits normalized JSON/JSONL. Never contacts providers,
//! Keychain, or Grok session files. Does not write unless `--output` is set.

use cd_core::quality_eval::{
    load_suite, normalize_for_stability, resolve_suite_path, run_hermetic_suite, serialize_json,
    serialize_jsonl, write_export, ExportFormat, HermeticRunOptions, LaneStatus,
};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
Usage:
  cd-quality-eval-lab run [--suite <dir>] [--format json|jsonl] [--output <path>] [--force]
  cd-quality-eval-lab validate [--suite <dir>]

Runs the OPEN hermetic quality-evaluation suite without network or credentials.
Writes nothing unless --output is supplied. Refuses to overwrite existing files
unless --force is set.
";

#[derive(Debug)]
enum Command {
    Run {
        suite: Option<PathBuf>,
        format: ExportFormat,
        output: Option<PathBuf>,
        force: bool,
    },
    Validate {
        suite: Option<PathBuf>,
    },
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    if args.len() < 2 {
        return Err(USAGE.into());
    }
    match args[1].as_str() {
        "run" => {
            let mut suite = None;
            let mut format = ExportFormat::Json;
            let mut output = None;
            let mut force = false;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--suite" => {
                        i += 1;
                        suite = Some(PathBuf::from(args.get(i).ok_or("--suite needs path")?));
                    }
                    "--format" => {
                        i += 1;
                        let raw = args.get(i).ok_or("--format needs value")?;
                        format = ExportFormat::parse(raw)
                            .ok_or_else(|| format!("unknown format {raw}"))?;
                    }
                    "--output" => {
                        i += 1;
                        output = Some(PathBuf::from(args.get(i).ok_or("--output needs path")?));
                    }
                    "--force" => force = true,
                    "-h" | "--help" => return Err(USAGE.into()),
                    other => return Err(format!("unknown flag {other}\n{USAGE}")),
                }
                i += 1;
            }
            Ok(Command::Run {
                suite,
                format,
                output,
                force,
            })
        }
        "validate" => {
            let mut suite = None;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--suite" => {
                        i += 1;
                        suite = Some(PathBuf::from(args.get(i).ok_or("--suite needs path")?));
                    }
                    "-h" | "--help" => return Err(USAGE.into()),
                    other => return Err(format!("unknown flag {other}\n{USAGE}")),
                }
                i += 1;
            }
            Ok(Command::Validate { suite })
        }
        "-h" | "--help" => Err(USAGE.into()),
        other => Err(format!("unknown command {other}\n{USAGE}")),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let command = match parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };

    match command {
        Command::Validate { suite } => match run_validate(suite.as_deref()) {
            Ok(digest) => {
                println!("QUALITY_EVAL_SUITE_OK digest={digest}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("QUALITY_EVAL_SUITE_FAIL: {e}");
                ExitCode::from(1)
            }
        },
        Command::Run {
            suite,
            format,
            output,
            force,
        } => match run_suite(suite.as_deref(), format, output.as_deref(), force) {
            Ok(status) => {
                if status == LaneStatus::Executed {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                }
            }
            Err(e) => {
                eprintln!("QUALITY_EVAL_RUN_FAIL: {e}");
                ExitCode::from(1)
            }
        },
    }
}

fn run_validate(suite: Option<&std::path::Path>) -> Result<String, String> {
    let path = resolve_suite_path(suite).map_err(|e| e.to_string())?;
    let loaded = load_suite(&path).map_err(|e| e.to_string())?;
    println!(
        "suite_id={} cases={} digest={}",
        loaded.manifest.suite_id,
        loaded.cases.len(),
        loaded.digest
    );
    Ok(loaded.digest)
}

fn run_suite(
    suite: Option<&std::path::Path>,
    format: ExportFormat,
    output: Option<&std::path::Path>,
    force: bool,
) -> Result<LaneStatus, String> {
    let path = resolve_suite_path(suite).map_err(|e| e.to_string())?;
    let loaded = load_suite(&path).map_err(|e| e.to_string())?;
    let mut opts = HermeticRunOptions::default();
    if let Ok(sha) = env::var("CD_GIT_SHA") {
        if !sha.trim().is_empty() {
            opts.build_identity = sha.trim().to_string();
        }
    }
    let record = run_hermetic_suite(&loaded, &opts);
    let body = match format {
        ExportFormat::Json => serialize_json(&record).map_err(|e| e.to_string())?,
        ExportFormat::Jsonl => serialize_jsonl(&record).map_err(|e| e.to_string())?,
    };
    // Stability check: the bytes actually selected for emission must reparse
    // to the same normalized value as the run record.
    if matches!(format, ExportFormat::Json) {
        let emitted: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("reparse emitted JSON: {e}"))?;
        let expected_text = normalize_for_stability(&record).map_err(|e| e.to_string())?;
        let expected: serde_json::Value = serde_json::from_str(&expected_text)
            .map_err(|e| format!("reparse normalized JSON: {e}"))?;
        if emitted != expected {
            return Err("non-deterministic serialization".into());
        }
    }

    if let Some(out) = output {
        write_export(out, &body, force).map_err(|e| e.to_string())?;
        // Print only the basename, never the absolute path.
        let name = out.file_name().and_then(|s| s.to_str()).unwrap_or("output");
        println!(
            "QUALITY_EVAL_RUN status={} suite_digest={} wrote={name}",
            record.status.as_str(),
            record.suite_digest
        );
    } else {
        // stdout only — no path disclosure.
        print!("{body}");
        eprintln!(
            "QUALITY_EVAL_RUN status={} suite_digest={} cases={}",
            record.status.as_str(),
            record.suite_digest,
            record.cases.len()
        );
    }

    Ok(record.status)
}
