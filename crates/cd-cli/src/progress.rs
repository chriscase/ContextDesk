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
    interactive: bool,
    last_phase: Mutex<Option<ProcessProgressPhase>>,
    last_redraw: Mutex<Instant>,
    printed_anything: AtomicBool,
}

impl CliProgressObserver {
    pub fn new(format: OutputFormat) -> Self {
        let stderr_is_tty = io::stderr().is_terminal();
        let terminal_is_dumb = std::env::var("TERM").ok().as_deref() == Some("dumb");
        Self {
            format,
            interactive: stderr_is_tty && !terminal_is_dumb,
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
        if !phase_changed && self.interactive {
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
        if self.interactive {
            line.push('\r');
            line.push_str("\x1b[2K"); // clear the line before redrawing shorter text over a longer one
        }
        line.push_str(update.phase.label());
        if let Some(fraction) = update.fraction {
            line.push(' ');
            line.push_str(&progress_bar(fraction, 20));
            line.push_str(&format!(" {:>3.0}%", fraction.clamp(0.0, 1.0) * 100.0));
        }
        if let Some(files) = update.files_processed {
            line.push_str(&format!(" · {} files", grouped(files)));
        }
        if let Some(lines) = update.lines_processed {
            line.push_str(&format!(" · {} lines", grouped(lines)));
        }
        if let Some(templates) = update.templates {
            line.push_str(&format!(" · {} templates", grouped(templates)));
        }
        if let Some(elapsed_ms) = update.elapsed_ms {
            line.push_str(&format!(" · {:.1}s", elapsed_ms as f64 / 1_000.0));
        }
        if !update.message.is_empty() {
            if self.interactive {
                line.push_str(&format!(" · {}", update.message));
            } else {
                line.push_str(&format!("\n  {}", update.message));
            }
        }
        if !self.interactive {
            line.push('\n');
        }
        eprint!("{line}");
        let _ = io::stderr().flush();
        self.printed_anything.store(true, Ordering::Relaxed);
    }
}

fn progress_bar(fraction: f32, width: usize) -> String {
    let filled = (fraction.clamp(0.0, 1.0) * width as f32).round() as usize;
    format!("[{}{}]", "=".repeat(filled), "-".repeat(width - filled))
}

fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(character);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::{grouped, progress_bar};

    #[test]
    fn progress_bar_is_bounded_and_readable() {
        assert_eq!(progress_bar(-1.0, 10), "[----------]");
        assert_eq!(progress_bar(0.5, 10), "[=====-----]");
        assert_eq!(progress_bar(2.0, 10), "[==========]");
    }

    #[test]
    fn groups_large_counts() {
        assert_eq!(grouped(12), "12");
        assert_eq!(grouped(1_234), "1,234");
        assert_eq!(grouped(12_345_678), "12,345,678");
    }
}
