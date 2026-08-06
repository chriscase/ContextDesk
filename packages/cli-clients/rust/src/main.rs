//! Thin Rust reference client — `std::process::Command` argv only.
//! Does not link `cd-core`. C ABI / local service are future options.
//! See `docs/CLI_CLIENT_PROTOCOL.md`.

use std::env;
use std::process::{Command, Stdio};

const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;

fn resolve_bin() -> String {
    env::var("CONTEXTDESK_BIN").unwrap_or_else(|_| "contextdesk".into())
}

#[derive(Debug)]
struct CommandResult {
    envelope: serde_json::Value,
    exit_code: i32,
    verdict_kind: Option<&'static str>,
}

fn completed_verdict(code: i32) -> Option<&'static str> {
    match code {
        8 => Some("not_ready"),
        9 => Some("non_conforming"),
        10 => Some("partial"),
        _ => None,
    }
}

fn run_json(data_dir: Option<&str>, args: &[String]) -> Result<CommandResult, String> {
    let bin = resolve_bin();
    let mut cmd = Command::new(&bin);
    if let Some(d) = data_dir {
        cmd.arg("--data-dir").arg(d);
    }
    cmd.arg("--json");
    for a in args {
        cmd.arg(a);
    }
    // No shell — Command uses execve-style argv.
    let output = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    let code = output.status.code().unwrap_or(70);
    if output.stdout.len() > MAX_ENVELOPE_BYTES {
        return Err("oversized JSON envelope".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("empty stdout exit={code} stderr={stderr}"));
    }
    let envelope: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|error| format!("invalid JSON: {error}"))?;
    if envelope.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(format!("command error exit={code}: {envelope}"));
    }
    let verdict_kind = completed_verdict(code);
    if code != 0 && verdict_kind.is_none() {
        return Err(format!("ok envelope but exit={code}"));
    }
    Ok(CommandResult {
        envelope,
        exit_code: code,
        verdict_kind,
    })
}

fn main() {
    let mut data_dir: Option<String> = None;
    let mut args: Vec<String> = Vec::new();
    let mut argv = env::args().skip(1);
    while let Some(a) = argv.next() {
        if a == "--data-dir" {
            data_dir = argv.next();
        } else {
            args.push(a);
        }
    }
    if args.is_empty() {
        args.push("capabilities".into());
    }
    match run_json(data_dir.as_deref(), &args) {
        Ok(result) => {
            let _typed_verdict = result.verdict_kind;
            println!("{}", result.envelope);
            if result.exit_code != 0 {
                std::process::exit(result.exit_code);
            }
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(70);
        }
    }
}
