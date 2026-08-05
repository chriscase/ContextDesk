//! Thin Rust reference client — `std::process::Command` argv only.
//! Does not link `cd-core`. C ABI / local service are future options.
//! See `docs/CLI_CLIENT_PROTOCOL.md`.

use std::env;
use std::process::{Command, Stdio};

fn resolve_bin() -> String {
    env::var("CONTEXTDESK_BIN").unwrap_or_else(|_| "contextdesk".into())
}

fn run_json(data_dir: Option<&str>, args: &[String]) -> Result<(i32, String), String> {
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
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("empty stdout exit={code} stderr={stderr}"));
    }
    Ok((code, stdout))
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
        Ok((code, body)) => {
            println!("{body}");
            if code != 0 {
                std::process::exit(code);
            }
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(70);
        }
    }
}
