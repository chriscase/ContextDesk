#[path = "../tests/support/log_lab_generator.rs"]
mod log_lab_generator;

use log_lab_generator::{
    generate_compact, generate_scale, DEFAULT_LARGE_EVENT_COUNT, LARGE_PROFILE, MEDIUM_EVENT_COUNT,
    MEDIUM_PROFILE, SMALL_PROFILE,
};
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("generate_log_lab: {error}");
        std::process::exit(2);
    }
}

fn run() -> log_lab_generator::LabResult<()> {
    let mut args = std::env::args().skip(1);
    let mut output: Option<PathBuf> = None;
    let mut profile = SMALL_PROFILE.to_string();
    let mut events: Option<usize> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--output" => {
                let value = args.next().ok_or("--output requires a path")?;
                output = Some(PathBuf::from(value));
            }
            "--profile" => {
                profile = args.next().ok_or("--profile requires a value")?;
            }
            "--events" => {
                let value = args.next().ok_or("--events requires a value")?;
                events = Some(value.parse()?);
            }
            "--help" | "-h" => {
                println!(
                    "Usage: cargo run -p cd-core --example generate_log_lab -- \\
                     --output PATH [--profile small|medium|large] [--events N]\n\
                     The output directory must be absent or empty."
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }
    let output = output.ok_or("--output is required")?;
    let summary = match profile.as_str() {
        SMALL_PROFILE => generate_compact(&output)?,
        MEDIUM_PROFILE => generate_scale(
            &output,
            MEDIUM_PROFILE,
            events.unwrap_or(MEDIUM_EVENT_COUNT),
        )?,
        LARGE_PROFILE => generate_scale(
            &output,
            LARGE_PROFILE,
            events.unwrap_or(DEFAULT_LARGE_EVENT_COUNT),
        )?,
        _ => return Err(format!("unsupported profile: {profile}").into()),
    };
    println!(
        "PASS profile={} files={} events={} bytes={} tree_sha256={}",
        summary.profile, summary.files, summary.events, summary.bytes, summary.tree_sha256
    );
    Ok(())
}
