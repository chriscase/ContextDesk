//! `cd-normalized-log-lab` — offline conformance lab for
//! `contextdesk.normalized_log_events.v1`.
//!
//! Three subcommands:
//!
//! ```text
//! cd-normalized-log-lab validate     <file.jsonl>
//! cd-normalized-log-lab summarize    <file.jsonl>
//! cd-normalized-log-lab canonicalize <in.jsonl> <out.jsonl>
//! ```
//!
//! # What this tool will not do
//!
//! * **No network.** It contacts no provider and resolves no host. A producer
//!   validating a bundle before transfer must not be the moment their log
//!   content leaves the building.
//! * **No mutation of input.** `canonicalize` refuses to write over an
//!   existing file and never writes to its input, so a mistyped argument
//!   cannot destroy the evidence being checked.
//! * **No payload or path in output.** Diagnostics carry a record number and a
//!   field location. `summarize` is aggregate-only — counts, never lines. The
//!   input path is never echoed, because a report is exactly the artifact that
//!   gets pasted into a ticket.
//!
//! Exit codes: `0` conforming, `1` non-conforming, `2` usage or I/O error.

use std::collections::BTreeMap;
use std::io::Write;

use cd_core::normalized_log_events::{
    canonicalize_stream, validate_stream, NormalizedLogValidation,
};

fn usage() -> ! {
    eprintln!(
        "usage:\n  \
         cd-normalized-log-lab validate     <file.jsonl>\n  \
         cd-normalized-log-lab summarize    <file.jsonl>\n  \
         cd-normalized-log-lab canonicalize <in.jsonl> <out.jsonl>"
    );
    std::process::exit(2);
}

fn open(path: &str) -> std::io::BufReader<std::fs::File> {
    match std::fs::File::open(path) {
        Ok(file) => std::io::BufReader::new(file),
        Err(error) => {
            // Report the error kind, never the path: the path is the one piece
            // of host detail a shareable report must not carry.
            eprintln!("cannot open input: {}", error.kind());
            std::process::exit(2);
        }
    }
}

fn report(validation: &NormalizedLogValidation) -> i32 {
    if validation.ok {
        println!(
            "conforming: {} event(s) validated",
            validation.events_validated
        );
        return 0;
    }
    println!(
        "NOT conforming: {} diagnostic(s), {} event(s) validated before failure",
        validation.diagnostics.len(),
        validation.events_validated
    );
    for diagnostic in &validation.diagnostics {
        let location = diagnostic.location.as_deref().unwrap_or("-");
        println!(
            "  record {}: {} at {}",
            diagnostic.line,
            serde_json::to_string(&diagnostic.code)
                .unwrap_or_default()
                .trim_matches('"'),
            location
        );
    }
    1
}

/// Aggregate-only: counts per diagnostic code, never a line of content.
fn summarize(validation: &NormalizedLogValidation) -> i32 {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for diagnostic in &validation.diagnostics {
        let code = serde_json::to_string(&diagnostic.code)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        *counts.entry(code).or_default() += 1;
    }
    println!("events validated: {}", validation.events_validated);
    println!("diagnostics: {}", validation.diagnostics.len());
    for (code, count) in counts {
        println!("  {code}: {count}");
    }
    i32::from(!validation.ok)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.as_slice() {
        [command, input] if command == "validate" => {
            let validation = match validate_stream(open(input)) {
                Ok(validation) => validation,
                Err(error) => {
                    eprintln!("read failed: {error}");
                    std::process::exit(2);
                }
            };
            report(&validation)
        }
        [command, input] if command == "summarize" => {
            let validation = match validate_stream(open(input)) {
                Ok(validation) => validation,
                Err(error) => {
                    eprintln!("read failed: {error}");
                    std::process::exit(2);
                }
            };
            summarize(&validation)
        }
        [command, input, output] if command == "canonicalize" => {
            // No-clobber: refuse rather than overwrite. `create_new` makes the
            // check atomic, so a concurrent writer cannot slip in between a
            // separate `exists()` test and the open.
            let mut sink = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    eprintln!("refusing to overwrite an existing output file");
                    std::process::exit(2);
                }
                Err(error) => {
                    eprintln!("cannot create output: {}", error.kind());
                    std::process::exit(2);
                }
            };
            match canonicalize_stream(open(input), &mut sink) {
                Ok(count) => {
                    if let Err(error) = sink.flush() {
                        eprintln!("write failed: {}", error.kind());
                        std::process::exit(2);
                    }
                    println!("canonicalized {count} record(s)");
                    0
                }
                Err(error) => {
                    eprintln!("canonicalize failed: {error}");
                    // Leave the partial output rather than deleting a file the
                    // user named; say so instead of silently cleaning up.
                    eprintln!("note: output may be incomplete");
                    1
                }
            }
        }
        _ => usage(),
    };
    std::process::exit(code);
}
