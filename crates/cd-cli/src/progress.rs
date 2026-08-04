//! `ProcessProgressObserver` for a headless CLI process: bounded human
//! progress on stderr (one overwriting line on a real terminal, one line
//! per phase transition when stderr is redirected) plus, in `--jsonl` mode,
//! one versioned JSON line per update on stdout — the same
//! `cd_core::process_progress::ProcessProgress` struct desktop broadcasts
//! over Tauri IPC, just written as JSON instead of emitted as an event.

use crate::config::OutputFormat;
use cd_core::process_progress::{
    LogIngestEvidence, ProcessProgress, ProcessProgressObserver, ProcessProgressPhase,
};
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Bumped only on a breaking change to the progress-line shape itself.
pub const PROGRESS_SCHEMA_VERSION: u32 = 1;

/// Minimum interval between overwriting-line redraws on a real terminal —
/// keeps the human view bounded to a handful of redraws per second
/// regardless of how often the underlying pipeline calls `progress()`.
const MIN_REDRAW_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Serialize)]
struct ProgressLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    schema_version: u32,
    #[serde(flatten)]
    progress: &'a ProcessProgress,
}

#[derive(Serialize)]
struct EvidenceLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    schema_version: u32,
    #[serde(flatten)]
    evidence: &'a LogIngestEvidence,
}

pub struct CliProgressObserver {
    format: OutputFormat,
    stderr_is_tty: bool,
    last_phase: Mutex<Option<ProcessProgressPhase>>,
    last_redraw: Mutex<Instant>,
    printed_anything: AtomicBool,
}

impl CliProgressObserver {
    pub fn new(format: OutputFormat) -> Self {
        Self {
            format,
            stderr_is_tty: io::stderr().is_terminal(),
            last_phase: Mutex::new(None),
            last_redraw: Mutex::new(Instant::now() - MIN_REDRAW_INTERVAL),
            printed_anything: AtomicBool::new(false),
        }
    }

    /// End the bounded stderr line cleanly. Call once after the operation
    /// finishes (success, failure, or cancellation) — never from inside
    /// `progress()`, which does not know when the LAST update has arrived.
    pub fn finish(&self) {
        if self.printed_anything.load(Ordering::Relaxed) {
            eprintln!();
        }
    }

    fn render_human(&self, update: &ProcessProgress) {
        let phase_changed = {
            let mut last = self.last_phase.lock().expect("progress observer lock");
            let changed = *last != Some(update.phase);
            *last = Some(update.phase);
            changed
        };
        if !phase_changed && self.stderr_is_tty {
            let mut last_redraw = self.last_redraw.lock().expect("progress observer lock");
            if last_redraw.elapsed() < MIN_REDRAW_INTERVAL {
                return;
            }
            *last_redraw = Instant::now();
        } else if !phase_changed {
            // Not a terminal: only phase transitions are worth a line at
            // all — an in-place redraw is meaningless once the output is
            // redirected to a file or pipe.
            return;
        }

        let mut line = String::new();
        if self.stderr_is_tty {
            line.push('\r');
            line.push_str("\x1b[2K"); // clear the line before redrawing shorter text over a longer one
        }
        line.push_str(update.phase.label());
        if let Some(fraction) = update.fraction {
            line.push_str(&format!(" {:.0}%", fraction * 100.0));
        }
        if let Some(files) = update.files_processed {
            line.push_str(&format!(" files={files}"));
        }
        if let Some(lines) = update.lines_processed {
            line.push_str(&format!(" lines={lines}"));
        }
        if let Some(templates) = update.templates {
            line.push_str(&format!(" templates={templates}"));
        }
        if !update.message.is_empty() {
            line.push_str(&format!(" — {}", update.message));
        }
        if !self.stderr_is_tty {
            line.push('\n');
        }
        eprint!("{line}");
        let _ = io::stderr().flush();
        self.printed_anything.store(true, Ordering::Relaxed);
    }
}

impl ProcessProgressObserver for CliProgressObserver {
    fn progress(&self, update: ProcessProgress) {
        match self.format {
            OutputFormat::Jsonl => {
                let line = ProgressLine {
                    kind: "progress",
                    schema_version: PROGRESS_SCHEMA_VERSION,
                    progress: &update,
                };
                println!(
                    "{}",
                    serde_json::to_string(&line).expect("ProgressLine is always serializable")
                );
            }
            OutputFormat::Text | OutputFormat::Json => self.render_human(&update),
        }
    }

    fn log_ingest_evidence(&self, evidence: LogIngestEvidence) {
        if matches!(self.format, OutputFormat::Jsonl) {
            let line = EvidenceLine {
                kind: "ingest_evidence",
                schema_version: PROGRESS_SCHEMA_VERSION,
                evidence: &evidence,
            };
            println!(
                "{}",
                serde_json::to_string(&line).expect("EvidenceLine is always serializable")
            );
        }
        // Text/Json modes rely on the final summary's `exclusion_counts`
        // (the same bounded aggregate `report.stats` already carries) —
        // printing every evidence item live here would be exactly the
        // unbounded per-file spam this module exists to avoid.
    }
}
