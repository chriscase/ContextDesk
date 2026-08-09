//! Interactive-terminal rendering for `chat` — a bounded, redrawing stderr
//! status line.
//!
//! Presentation only: every fact rendered here already exists on the
//! shared `cd_core`/`cd_workflow` wire (`StreamEvent`) or was already
//! computed by `commands::chat` (`grounding_status`, `elapsed_ms`).
//! Nothing here changes what a turn does, what a tool call means, or what
//! `--json`/`--jsonl` stdout contains — see `docs/CLI.md`'s Output section,
//! which this module never touches: this renderer only ever writes to
//! **stderr**, and only when `OutputFormat::Text` is in effect.
//!
//! Degrades to bounded, ANSI-free, one-line-per-transition output whenever
//! the destination cannot support an overwriting status line — stderr
//! redirected to a file or pipe, `TERM=dumb`, or no controlling terminal at
//! all — the exact same rule `progress.rs` already applies to `import`,
//! reused here rather than reinvented. Cancellation and mid-render errors
//! both terminate through the same single `finish()` call, so the status
//! line is always left in a clean, newline-terminated state exactly once,
//! regardless of how the command ended.

use crate::config::ColorMode;
use cd_core::events::{progress_for_stream_event, StreamEvent, ToolPhase};
use std::io::{self, IsTerminal, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Minimum interval between overwriting-line redraws on a real terminal —
/// mirrors `progress.rs`'s `MIN_REDRAW_INTERVAL` so both renderers feel
/// like one product rather than two independently tuned ones.
const MIN_REDRAW_INTERVAL: Duration = Duration::from_millis(120);

/// What the destination terminal can actually do, resolved once at
/// construction from the real process environment — never re-checked
/// mid-render, so one command invocation's rendering behavior is
/// internally consistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCapabilities {
    /// stderr is a real controlling terminal AND that terminal claims to
    /// support redraw (see `TERM=dumb` handling below) — an overwriting
    /// `\r` + clear-line redraw is meaningful.
    pub interactive: bool,
    /// ANSI color escapes are safe to emit.
    pub color: bool,
}

impl TerminalCapabilities {
    /// Resolve from the real process environment.
    pub fn detect(color_mode: ColorMode) -> Self {
        Self::from_parts(
            io::stderr().is_terminal() && platform_supports_ansi(),
            std::env::var("TERM").ok(),
            std::env::var_os("NO_COLOR").is_some(),
            color_mode,
        )
    }

    /// Pure constructor used by [`Self::detect`] and directly by tests — no
    /// env or fd access, so terminal-capability decisions are
    /// unit-testable without a real pty or a subprocess.
    ///
    /// `TERM=dumb` (e.g. Emacs' `shell-mode`) disables the overwriting
    /// redraw even when `is_terminal()` reports true — the same treatment
    /// `less`/`git` give it. `NO_COLOR` (<https://no-color.org>) disables
    /// color under `Auto` regardless of tty-ness; an explicit
    /// `--color always` still wins (a deliberate user override beats an
    /// ambient environment convention), and `--color never` always wins.
    fn from_parts(
        is_tty: bool,
        term: Option<String>,
        no_color_env: bool,
        color_mode: ColorMode,
    ) -> Self {
        let dumb = term.as_deref() == Some("dumb");
        let plain = matches!(color_mode, ColorMode::Never)
            || (matches!(color_mode, ColorMode::Auto) && no_color_env);
        let interactive = is_tty && !dumb && !plain;
        let color = match color_mode {
            ColorMode::Never => false,
            ColorMode::Always => true,
            ColorMode::Auto => interactive && !no_color_env,
        };
        Self { interactive, color }
    }
}

/// Conservative platform capability check. Unix terminals conventionally
/// interpret ANSI when attached to a tty. On Windows, a tty alone is not
/// enough: legacy Console Host sessions can display escape bytes literally,
/// so enable redraw only for terminals that advertise VT/ANSI support.
pub fn platform_supports_ansi() -> bool {
    #[cfg(not(windows))]
    {
        true
    }
    #[cfg(windows)]
    {
        std::env::var_os("WT_SESSION").is_some()
            || std::env::var_os("ANSICON").is_some()
            || std::env::var("ConEmuANSI").is_ok_and(|value| value.eq_ignore_ascii_case("ON"))
            || std::env::var_os("TERM_PROGRAM").is_some()
            || std::env::var("TERM").is_ok_and(|value| {
                let value = value.to_ascii_lowercase();
                value.starts_with("xterm")
                    || value.starts_with("screen")
                    || value.starts_with("tmux")
                    || value.contains("cygwin")
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscapeState {
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

/// Stateful filter for untrusted model text written to a human terminal.
/// JSON/JSONL retain the original bytes; only terminal presentation strips
/// control sequences that could redraw the screen, change the title, or
/// otherwise appear as mojibake on an unsupported console.
pub struct TerminalTextSanitizer {
    state: EscapeState,
    ascii: bool,
}

impl Default for TerminalTextSanitizer {
    fn default() -> Self {
        Self {
            state: EscapeState::Text,
            ascii: false,
        }
    }
}

impl TerminalTextSanitizer {
    pub fn for_current_console() -> Self {
        let ascii = match std::env::var("CONTEXTDESK_ASCII") {
            Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "no") => {
                false
            }
            Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes") => {
                true
            }
            _ => cfg!(windows),
        };
        Self::with_ascii(ascii)
    }

    /// Construct with an explicit ASCII-typography flag (no env lookup).
    /// Used by hierarchy renderers so leaf values follow the same scrubbing
    /// rules as streamed model text without re-reading process environment.
    pub fn with_ascii(ascii: bool) -> Self {
        Self {
            state: EscapeState::Text,
            ascii,
        }
    }

    #[cfg(test)]
    fn ascii() -> Self {
        Self::with_ascii(true)
    }

    pub fn push(&mut self, chunk: &str) -> String {
        let mut out = String::with_capacity(chunk.len());
        for character in chunk.chars() {
            self.state = match self.state {
                EscapeState::Text => match character {
                    '\u{1b}' => EscapeState::Escape,
                    '\n' | '\t' => {
                        out.push(character);
                        EscapeState::Text
                    }
                    '\r' => EscapeState::Text,
                    c if c.is_control() => EscapeState::Text,
                    // Bidi overrides, embeddings, isolates, and directional
                    // marks are invisible but reorder what a terminal shows,
                    // so displayed order can disagree with the bytes. Dropping
                    // them costs nothing legible — the bidi algorithm still
                    // lays out RTL text on its own — and removes a whole class
                    // of line spoofing from every provider's output, not just
                    // from host-rendered answers.
                    c if cd_core::investigation_answer::is_bidi_formatting_control(c) => {
                        EscapeState::Text
                    }
                    c => {
                        if self.ascii {
                            push_ascii_typography(&mut out, c);
                        } else {
                            out.push(c);
                        }
                        EscapeState::Text
                    }
                },
                EscapeState::Escape => match character {
                    '[' => EscapeState::Csi,
                    ']' => EscapeState::Osc,
                    '\u{1b}' => EscapeState::Escape,
                    _ => EscapeState::Text,
                },
                EscapeState::Csi => {
                    if ('@'..='~').contains(&character) {
                        EscapeState::Text
                    } else {
                        EscapeState::Csi
                    }
                }
                EscapeState::Osc => match character {
                    '\u{7}' => EscapeState::Text,
                    '\u{1b}' => EscapeState::OscEscape,
                    _ => EscapeState::Osc,
                },
                EscapeState::OscEscape => {
                    if character == '\\' {
                        EscapeState::Text
                    } else {
                        EscapeState::Osc
                    }
                }
            };
        }
        out
    }
}

fn push_ascii_typography(out: &mut String, character: char) {
    match character {
        '\u{00a0}' | '\u{2007}' | '\u{202f}' => out.push(' '),
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => {
            out.push('-')
        }
        '\u{2018}' | '\u{2019}' | '\u{2032}' => out.push('\''),
        '\u{201c}' | '\u{201d}' | '\u{2033}' => out.push('"'),
        '\u{2026}' => out.push_str("..."),
        '\u{00b7}' | '\u{2022}' => out.push('*'),
        '\u{2190}' => out.push_str("<-"),
        '\u{2192}' => out.push_str("->"),
        '\u{21d2}' => out.push_str("=>"),
        '\u{27e6}' => out.push('['),
        '\u{27e7}' => out.push(']'),
        c if c.is_ascii() => out.push(c),
        // Preserve non-Latin content rather than corrupting or deleting it.
        // The Windows default only normalizes typography known to cause the
        // observed mojibake; meaningful international text remains intact.
        c => out.push(c),
    }
}

struct ChatStatusState {
    /// Shared core-authored human label for the latest engine activity.
    stage: String,
    tools_started: usize,
    tools_finished: usize,
    retries: usize,
    started: Instant,
    last_redraw: Instant,
    printed_anything: bool,
    /// Set once the first `TextDelta` arrives. From that point the reply
    /// itself is streaming to stdout with no guaranteed trailing newline
    /// (`print!`, not `println!`) and now owns the terminal cursor — even a
    /// plain appended stderr line could land mid-word on the same shared
    /// cursor. So once downgraded, `redraw()` prints nothing at all for
    /// ANY further event (a phase change only updates its counters
    /// internally); the streaming reply is the visible activity indicator
    /// until the turn ends, at which point `finish()` — and only
    /// `finish()` — is allowed to print again, with its own leading-newline
    /// rule for `Cancelled`/`Failed` (see its doc comment).
    downgraded: bool,
}

/// The concise, already-finished facts a chat turn ended with — reuses
/// exactly what `commands::chat::run` already computed (session id,
/// `grounding_status()`) rather than deriving anything new.
pub enum ChatOutcomeSummary<'a> {
    Ok {
        session_id: &'a str,
        grounding: &'a str,
    },
    Cancelled,
    /// `message` is the same `CliError::message` the non-interactive error
    /// path already prints verbatim (`main.rs`'s `emit_error`) — no new
    /// data source, so no new leak surface.
    Failed {
        message: &'a str,
    },
}

/// Bounded stderr status line for an interactive `chat` turn, fed by the
/// SAME `StreamEvent`s `--jsonl` mode already serializes and `--trace`
/// already inspects. Only ever advances this renderer's own display
/// state; never reinterprets an event for any other purpose, and never
/// writes to stdout (the reply text itself stays exactly where
/// `commands::chat::run`'s existing `live_sink` already puts it).
pub struct ChatStatusRenderer {
    caps: TerminalCapabilities,
    state: Mutex<ChatStatusState>,
}

impl ChatStatusRenderer {
    pub fn new(caps: TerminalCapabilities) -> Self {
        Self {
            caps,
            state: Mutex::new(ChatStatusState {
                stage: "Connecting to provider".into(),
                tools_started: 0,
                tools_finished: 0,
                retries: 0,
                started: Instant::now(),
                last_redraw: Instant::now() - MIN_REDRAW_INTERVAL,
                printed_anything: false,
                downgraded: false,
            }),
        }
    }

    /// Print the initial status line before any `StreamEvent` has arrived.
    /// `TurnStarted`/`TurnPhase` fire essentially immediately (before the
    /// provider connect/health-probe step even begins — see
    /// `cd_core::research`), so nothing on the shared event stream ever
    /// marks "still connecting" on its own; call this once, right after
    /// construction and before the turn starts, so a slow connect is never
    /// silently invisible. Call exactly once.
    pub fn start(&self) {
        let mut state = self.state.lock().expect("chat status renderer lock");
        self.redraw(&mut state, true);
    }

    /// Feed one shared `StreamEvent`.
    pub fn on_event(&self, event: &StreamEvent) {
        let mut state = self.state.lock().expect("chat status renderer lock");
        // Once the reply itself has started streaming to stdout, it owns
        // the terminal cursor: any further stderr line — even a plain
        // appended one, not just an in-place redraw — could land mid-word
        // and corrupt the visible reply. Downgrade suppresses ALL further
        // printing from `redraw()` (see its own doc comment) for the rest
        // of the turn; only `finish()` may print again, once, when the
        // turn ends. Never printed for `TextDelta` itself either way — the
        // streaming text is now the visible activity — and never reverts.
        if let StreamEvent::TextDelta { .. } = event {
            if !state.downgraded {
                self.clear_in_place(&state);
                state.downgraded = true;
            }
            return;
        }
        match event {
            StreamEvent::Tool {
                phase: ToolPhase::Started,
                ..
            } => {
                state.tools_started += 1;
            }
            StreamEvent::Tool {
                phase: ToolPhase::Finished,
                ..
            } => {
                state.tools_finished += 1;
            }
            StreamEvent::LinkedSynthesisRetry { .. } => {
                state.retries += 1;
            }
            StreamEvent::PermissionRequired { .. } => {
                // `commands::chat::decide_permission` is about to print a
                // synchronous, multi-line prompt on this same stderr
                // stream — clear this renderer's in-place line first so
                // the prompt never collides with a stale fragment, then
                // let the prompt own the terminal until it returns.
                self.clear_in_place(&state);
                return;
            }
            _ => {}
        }
        let phase_changed = if matches!(event, StreamEvent::Error { .. }) {
            // Terminal for this render; `finish()` writes the actual failure
            // line — just force one last redraw of the current context.
            true
        } else if let Some(progress) = progress_for_stream_event(
            event,
            u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        ) {
            let changed = state.stage != progress.label;
            state.stage = progress.label;
            changed
        } else {
            return;
        };
        self.redraw(&mut state, phase_changed);
    }

    /// Clear the in-place status line before an out-of-band message (a
    /// Ctrl-C interrupt notice) is about to print — the same courtesy
    /// `on_event`'s `PermissionRequired` handling already gives the
    /// synchronous permission prompt, so the interrupt message never
    /// collides with a stale in-place fragment.
    pub fn clear_for_interrupt(&self) {
        let state = self.state.lock().expect("chat status renderer lock");
        self.clear_in_place(&state);
    }

    fn redraw(&self, state: &mut ChatStatusState, phase_changed: bool) {
        if state.downgraded {
            // The reply is streaming to stdout with no guaranteed trailing
            // newline (`print!`, not `println!` — see `commands::chat`'s
            // `live_sink`), and may still be mid-line right now. ANY line
            // this function would print here — even a plain appended one —
            // would concatenate directly onto the end of that visible
            // reply text on the shared terminal. So once downgraded, this
            // function never prints anything at all; `on_event`'s callers
            // still update `tools_started`/`tools_finished`/`retries`/
            // `stage` unconditionally before reaching here, so those counts
            // remain correct for `finish()`'s own single terminal line,
            // which is the only thing allowed to print again after
            // downgrade (see its own leading-newline handling).
            return;
        }
        let interactive_now = self.caps.interactive;
        if !phase_changed {
            if interactive_now {
                if state.last_redraw.elapsed() < MIN_REDRAW_INTERVAL {
                    return;
                }
            } else {
                // Redirected or dumb: an in-place redraw is meaningless
                // once output is going to a file or pipe — only a genuine
                // phase change is worth a line at all (matches
                // `progress.rs`).
                return;
            }
        }
        state.last_redraw = Instant::now();
        let mut line = String::new();
        if interactive_now {
            line.push('\r');
            line.push_str("\x1b[2K");
        }
        // Else (redirected or dumb): no leading separator needed — the
        // previous line (this function's own, or `start()`'s) always ended
        // with `\n` in that mode.
        if self.caps.color {
            line.push_str("\x1b[36m");
        }
        line.push_str(&state.stage);
        if self.caps.color {
            line.push_str("\x1b[0m");
        }
        if state.tools_started > 0 {
            line.push_str(&format!(
                " (tools {}/{})",
                state.tools_finished, state.tools_started
            ));
        }
        if state.retries > 0 {
            line.push_str(&format!(" | retry {}", state.retries));
        }
        line.push_str(&format!(" | {:.1}s", state.started.elapsed().as_secs_f32()));
        if !interactive_now {
            line.push('\n');
        }
        eprint!("{line}");
        let _ = io::stderr().flush();
        state.printed_anything = true;
    }

    fn clear_in_place(&self, state: &ChatStatusState) {
        if self.caps.interactive && !state.downgraded && state.printed_anything {
            eprint!("\r\x1b[2K");
            let _ = io::stderr().flush();
        }
    }

    /// End the status render exactly once, with a concise completion
    /// result — success (session id, grounding, tool count), cancellation,
    /// or failure. Call exactly once, after the turn has fully finished
    /// (including on Ctrl-C and on error) — never from inside `on_event`,
    /// which does not know when the LAST event has arrived.
    ///
    /// Once downgraded (the reply has streamed to stdout with no
    /// guaranteed trailing newline), a `Cancelled`/`Failed` outcome must
    /// start this line on its own fresh line rather than concatenating
    /// onto the end of the visible reply — `commands::chat::run`'s own
    /// success path already prints that separating newline itself (on
    /// stdout, terminating the reply's own line) before calling this with
    /// `Ok`, so `Ok` must NOT also get one here, or a real terminal (where
    /// stdout and stderr share one cursor) would show a spurious blank
    /// line between the reply and `done`.
    pub fn finish(&self, outcome: ChatOutcomeSummary<'_>) {
        let state = self.state.lock().expect("chat status renderer lock");
        let is_ok = matches!(outcome, ChatOutcomeSummary::Ok { .. });
        if state.downgraded {
            if !is_ok {
                eprintln!();
            }
        } else if self.caps.interactive && state.printed_anything {
            eprint!("\r\x1b[2K");
        }
        let elapsed = state.started.elapsed().as_secs_f32();
        let mut line = String::new();
        match outcome {
            ChatOutcomeSummary::Ok {
                session_id,
                grounding,
            } => {
                self.push_colored(&mut line, "\x1b[32m", "done");
                line.push_str(&format!(
                    " | session {session_id} | {} | tools {}/{}",
                    human_grounding_label(grounding),
                    state.tools_finished,
                    state.tools_started
                ));
            }
            ChatOutcomeSummary::Cancelled => {
                self.push_colored(&mut line, "\x1b[33m", "cancelled");
            }
            ChatOutcomeSummary::Failed { message } => {
                self.push_colored(&mut line, "\x1b[31m", "failed");
                line.push_str(&format!(" | {message}"));
            }
        }
        line.push_str(&format!(" | {elapsed:.1}s"));
        eprintln!("{line}");
        let _ = io::stderr().flush();
    }

    fn push_colored(&self, line: &mut String, code: &str, text: &str) {
        if self.caps.color {
            line.push_str(code);
        }
        line.push_str(text);
        if self.caps.color {
            line.push_str("\x1b[0m");
        }
    }
}

fn human_grounding_label(grounding: &str) -> &'static str {
    match grounding {
        "grounded" => "citations checked; interpretation unverified",
        "ungrounded" => "citation check failed",
        _ => "no corpus evidence check",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(interactive: bool, color: bool) -> TerminalCapabilities {
        TerminalCapabilities { interactive, color }
    }

    #[test]
    fn real_terminal_with_default_term_is_interactive_and_colored() {
        let caps = TerminalCapabilities::from_parts(true, None, false, ColorMode::Auto);
        assert!(caps.interactive);
        assert!(caps.color);
    }

    #[test]
    fn term_dumb_disables_redraw_even_on_a_real_tty() {
        let caps = TerminalCapabilities::from_parts(
            true,
            Some("dumb".to_string()),
            false,
            ColorMode::Auto,
        );
        assert!(!caps.interactive);
        assert!(!caps.color);
    }

    #[test]
    fn redirected_stderr_disables_redraw_and_color() {
        let caps = TerminalCapabilities::from_parts(false, None, false, ColorMode::Auto);
        assert!(!caps.interactive);
        assert!(!caps.color);
    }

    #[test]
    fn no_color_env_selects_plain_output() {
        let caps = TerminalCapabilities::from_parts(true, None, true, ColorMode::Auto);
        assert!(!caps.interactive);
        assert!(!caps.color);
    }

    #[test]
    fn explicit_color_always_beats_no_color_env() {
        // Adversarial: NO_COLOR is an ambient convention; an explicit user
        // flag is a deliberate override and must win.
        let caps = TerminalCapabilities::from_parts(true, None, true, ColorMode::Always);
        assert!(caps.color);
    }

    #[test]
    fn explicit_color_never_beats_a_real_colorful_terminal() {
        let caps = TerminalCapabilities::from_parts(true, None, false, ColorMode::Never);
        assert!(!caps.color);
        assert!(!caps.interactive);
    }

    #[test]
    fn terminal_text_filter_strips_split_ansi_and_control_sequences() {
        let mut filter = TerminalTextSanitizer::default();
        assert_eq!(filter.push("safe\u{1b}[31"), "safe");
        assert_eq!(
            filter.push("mred\u{1b}[0m\nnext\rline\u{7}"),
            "red\nnextline"
        );
    }

    #[test]
    fn terminal_text_filter_strips_osc_title_sequences_across_chunks() {
        let mut filter = TerminalTextSanitizer::default();
        assert_eq!(filter.push("before\u{1b}]0;secret"), "before");
        assert_eq!(filter.push(" title\u{1b}\\after"), "after");
    }

    /// Bidi controls are invisible and reorder a rendered line, so a value
    /// carrying them can make a terminal show something the bytes do not say.
    #[test]
    fn terminal_text_filter_strips_bidi_formatting_controls() {
        let mut filter = TerminalTextSanitizer::default();
        assert_eq!(
            filter.push("\u{202e}reversed\u{202c} \u{2066}iso\u{2069} \u{061c}\u{200e}\u{200f}m"),
            "reversed iso m"
        );
        // Legible RTL content itself is untouched; only the controls go.
        let mut filter = TerminalTextSanitizer::default();
        assert_eq!(filter.push("خطأ في الاتصال"), "خطأ في الاتصال");
    }

    /// The whole host projection, carrying an adversarial value, reaches a
    /// terminal with no control sequence and no forged line boundary.
    #[test]
    fn a_host_projection_carrying_hostile_values_stays_flat_in_a_terminal() {
        use cd_core::investigation_answer::literal_display_text;

        let hostile = [
            "x\nsecond line",
            "x\u{2028}second line",
            "\u{1b}[31mred\u{1b}[0m",
            "\u{1b}]8;;https://evil.example\u{7}osc\u{1b}]8;;\u{7}",
            "\u{202e}reversed\u{202c}",
            "bell\u{7}del\u{7f}nul\u{0}",
            "x\u{0085}\u{000b}\u{000c}y",
        ];
        for raw in hostile {
            let value = literal_display_text(raw);
            let line = format!("- `{value}` — cites `e-a`");
            let mut filter = TerminalTextSanitizer::default();
            let rendered = filter.push(&line);
            assert_eq!(
                rendered, line,
                "the host boundary already removed everything the terminal filter would"
            );
            assert_eq!(
                rendered.lines().count(),
                1,
                "a dynamic value must not create a terminal line: {rendered:?}"
            );
            assert!(
                !rendered.chars().any(|c| c.is_control() && c != '\n'),
                "control character reached the terminal: {rendered:?}"
            );
            assert!(
                !rendered
                    .chars()
                    .any(cd_core::investigation_answer::is_bidi_formatting_control),
                "bidi control reached the terminal: {rendered:?}"
            );
        }
    }

    #[test]
    fn ascii_terminal_mode_normalizes_problematic_typography() {
        let mut filter = TerminalTextSanitizer::ascii();
        assert_eq!(
            filter.push(
                "wall\u{2011}clock\u{202f}10 \u{201c}ok\u{201d} \u{27e6}seq=1\u{27e7} \u{2026}"
            ),
            "wall-clock 10 \"ok\" [seq=1] ..."
        );
    }

    #[test]
    fn human_grounding_label_does_not_overclaim_diagnostic_correctness() {
        assert_eq!(
            human_grounding_label("grounded"),
            "citations checked; interpretation unverified"
        );
        assert_eq!(human_grounding_label("ungrounded"), "citation check failed");
        assert_eq!(
            human_grounding_label("not_applicable"),
            "no corpus evidence check"
        );
    }

    #[test]
    fn redirected_output_only_lines_on_phase_change_never_redraws() {
        let renderer = ChatStatusRenderer::new(caps(false, false));
        renderer.on_event(&StreamEvent::TurnStarted {
            session_id: "s1".into(),
            model: None,
        });
        // A same-stage event must not itself force a new line under
        // redirected output — only genuine phase transitions do.
        let state = renderer.state.lock().unwrap();
        assert_eq!(state.stage, "Assembling context");
    }

    #[test]
    fn tool_events_are_counted_and_advance_stage() {
        let renderer = ChatStatusRenderer::new(caps(false, false));
        renderer.on_event(&StreamEvent::Tool {
            id: "t1".into(),
            name: "search".into(),
            phase: ToolPhase::Started,
            summary: String::new(),
            detail: None,
            ok: None,
        });
        renderer.on_event(&StreamEvent::Tool {
            id: "t1".into(),
            name: "search".into(),
            phase: ToolPhase::Finished,
            summary: String::new(),
            detail: None,
            ok: Some(true),
        });
        let state = renderer.state.lock().unwrap();
        assert_eq!(state.stage, "Finished: search");
        assert_eq!(state.tools_started, 1);
        assert_eq!(state.tools_finished, 1);
    }

    #[test]
    fn phase_changes_after_downgrade_update_counters_but_never_print_again() {
        // Adversarial: `Tool`/`TurnCompleted`/etc. all report `phase_changed
        // = true`, which used to force a redraw unconditionally — even
        // once the reply had started streaming to stdout with no
        // guaranteed trailing newline, concatenating the status word onto
        // the visible reply. `redraw()` must now short-circuit entirely
        // once downgraded, updating only the counters `on_event`'s own
        // match arms already touch before calling it.
        let renderer = ChatStatusRenderer::new(caps(true, false));
        renderer.on_event(&StreamEvent::TextDelta {
            text: "partial reply".into(),
        });
        let printed_before_downgrade = renderer.state.lock().unwrap().printed_anything;

        renderer.on_event(&StreamEvent::Tool {
            id: "t1".into(),
            name: "search".into(),
            phase: ToolPhase::Started,
            summary: String::new(),
            detail: None,
            ok: None,
        });
        renderer.on_event(&StreamEvent::TurnCompleted {
            reason: "stop".into(),
        });

        let state = renderer.state.lock().unwrap();
        assert!(state.downgraded);
        // Counters still update — only the printing is suppressed.
        assert_eq!(state.tools_started, 1);
        assert_eq!(state.stage, "Saving session");
        // `redraw()` never ran its print branch after downgrade: the flag
        // it alone sets to `true` is unchanged from before the downgrade.
        assert_eq!(state.printed_anything, printed_before_downgrade);
    }

    #[test]
    fn retry_events_are_counted_and_advance_stage() {
        let renderer = ChatStatusRenderer::new(caps(false, false));
        renderer.on_event(&StreamEvent::LinkedSynthesisRetry {
            available: true,
            session_id: "s1".into(),
            corpus_id: "c1".into(),
            provider_profile_id: None,
            model_id: None,
        });
        let state = renderer.state.lock().unwrap();
        assert_eq!(state.stage, "Bounded evidence is ready for synthesis retry");
        assert_eq!(state.retries, 1);
    }

    #[test]
    fn multi_model_reviewer_stage_uses_shared_human_label() {
        let renderer = ChatStatusRenderer::new(caps(false, false));
        renderer.on_event(&StreamEvent::MultiModelStage {
            stage: "reviewer".into(),
            phase: "started".into(),
            status: None,
            detail: "reviewing 2 candidate findings".into(),
            candidate_id: None,
        });
        assert_eq!(
            renderer.state.lock().unwrap().stage,
            "Reviewing candidate findings"
        );
    }

    #[test]
    fn permission_required_clears_the_in_place_line_without_starting_a_new_stage() {
        let renderer = ChatStatusRenderer::new(caps(true, false));
        let stage_before = renderer.state.lock().unwrap().stage.clone();
        renderer.on_event(&StreamEvent::PermissionRequired {
            request_id: "r1".into(),
            tool_name: "write_file".into(),
            target: "note.md".into(),
            reason: "save".into(),
            preview: String::new(),
            risk: "local".into(),
            arguments: serde_json::Value::Null,
        });
        assert_eq!(renderer.state.lock().unwrap().stage, stage_before);
    }
}
