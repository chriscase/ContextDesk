//! Human-readable nested rendering for `chat --trace` and `chat --activity`.
//!
//! Presentation only. Every fact comes from typed CLI/core contracts
//! ([`crate::envelope::StreamLine`] trace DTOs and
//! [`cd_core::activity::TurnActivityRecord`]). This module never re-runs the
//! agent loop, never invents tool arguments, and never changes JSON/JSONL
//! schema bytes — those formats bypass it entirely.
//!
//! Desired hierarchy:
//! ```text
//! Turn
//! +-- Context
//! +-- Model round 1
//! |   +-- Tools offered
//! |   +-- Tool call
//! |   |   +-- Arguments (honest absence when not in contract)
//! |   |   `-- Result
//! |   `-- Validation/retry / Outcome
//! `-- Model round 2
//!     `-- Final status
//! ```

use crate::cli::TraceLevel;
use crate::config::ColorMode;
use crate::envelope::{
    StreamLine, TraceContextLine, TraceSummaryLine, TraceToolLine, TracedMessageLine,
};
use crate::render::{platform_supports_ansi, TerminalTextSanitizer};
use cd_core::activity::{ActivityEvent, ActivityPhase, ActivityStatus, TurnActivityRecord};
use cd_core::context_budgeting::ContextBudgetTelemetry;
use std::io::{self, IsTerminal};

const MIN_WIDTH: usize = 40;
const MAX_WIDTH: usize = 120;
const DEFAULT_WIDTH: usize = 80;
const FULL_DETAIL_CHARS: usize = 800;
const SUMMARY_RESULT_CHARS: usize = 160;
const CONTEXT_BODY_CHARS: usize = 240;
const FULL_BODY_CHARS: usize = 1_200;

const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

/// Honest marker when tool-call JSON arguments are outside the trace contract.
pub const ARGS_NOT_CAPTURED: &str = "arguments not captured by this trace level/contract";

/// Pure style knobs for hierarchy rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HierarchyStyle {
    pub color: bool,
    pub ascii: bool,
    pub width: Option<usize>,
}

impl HierarchyStyle {
    /// Stable plain lines: no color, ASCII tree, default width.
    pub fn plain() -> Self {
        Self {
            color: false,
            ascii: true,
            width: Some(DEFAULT_WIDTH),
        }
    }

    pub fn detect_stdout(color_mode: ColorMode) -> Self {
        Self::from_parts(
            io::stdout().is_terminal() && platform_supports_ansi(),
            std::env::var("TERM").ok(),
            std::env::var_os("NO_COLOR").is_some(),
            color_mode,
            ascii_from_env(),
            detect_columns(),
        )
    }

    pub fn detect_stderr(color_mode: ColorMode) -> Self {
        Self::from_parts(
            io::stderr().is_terminal() && platform_supports_ansi(),
            std::env::var("TERM").ok(),
            std::env::var_os("NO_COLOR").is_some(),
            color_mode,
            ascii_from_env(),
            detect_columns(),
        )
    }

    /// Pure constructor — no env/fd access (unit-testable).
    pub fn from_parts(
        is_tty: bool,
        term: Option<String>,
        no_color_env: bool,
        color_mode: ColorMode,
        ascii: bool,
        columns: Option<usize>,
    ) -> Self {
        let dumb = term.as_deref() == Some("dumb");
        // Capable TTY: color (per mode) + optional Unicode tree.
        // Pipe/file/`TERM=dumb`: stable ASCII, never ANSI.
        let capable = is_tty && !dumb;
        let color = match color_mode {
            ColorMode::Never => false,
            ColorMode::Always => capable,
            ColorMode::Auto => capable && !no_color_env,
        };
        Self {
            color,
            ascii: ascii || !capable || no_color_env,
            width: Some(columns.unwrap_or(DEFAULT_WIDTH).clamp(MIN_WIDTH, MAX_WIDTH)),
        }
    }

    fn cols(self) -> usize {
        self.width
            .unwrap_or(DEFAULT_WIDTH)
            .clamp(MIN_WIDTH, MAX_WIDTH)
    }
}

fn ascii_from_env() -> bool {
    match std::env::var("CONTEXTDESK_ASCII") {
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "no") => false,
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes") => true,
        _ => cfg!(windows),
    }
}

fn detect_columns() -> Option<usize> {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= MIN_WIDTH)
}

struct Glyphs {
    branch: &'static str,
    last: &'static str,
    pipe: &'static str,
    blank: &'static str,
}

impl Glyphs {
    fn for_style(style: HierarchyStyle) -> Self {
        if style.ascii {
            Self {
                branch: "+-- ",
                last: "`-- ",
                pipe: "|   ",
                blank: "    ",
            }
        } else {
            Self {
                branch: "├── ",
                last: "└── ",
                pipe: "│   ",
                blank: "    ",
            }
        }
    }
}

struct TreeWriter {
    out: String,
    style: HierarchyStyle,
    glyphs: Glyphs,
    sanitizer: TerminalTextSanitizer,
}

impl TreeWriter {
    fn new(style: HierarchyStyle) -> Self {
        Self {
            out: String::new(),
            style,
            glyphs: Glyphs::for_style(style),
            sanitizer: TerminalTextSanitizer::with_ascii(style.ascii),
        }
    }

    fn finish(self) -> String {
        self.out
    }

    fn push_styled(&mut self, text: &str, ansi: &str) {
        if self.style.color {
            self.out.push_str(ansi);
        }
        self.out.push_str(text);
        if self.style.color {
            self.out.push_str(RESET);
        }
    }

    fn line_root(&mut self, title: &str, ansi: &str) {
        self.push_styled(title, ansi);
        self.out.push('\n');
    }

    fn line(&mut self, prefix: &str, connector: &str, text: &str) {
        self.out.push_str(prefix);
        self.out.push_str(connector);
        let indent = prefix.chars().count() + connector.chars().count();
        let width = self.style.cols().saturating_sub(indent).max(16);
        let clean = self.sanitizer.push(text);
        let parts = wrap_preserving_utf8(&clean, width);
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                self.out.push('\n');
                self.out.push_str(prefix);
                self.out.push_str(self.glyphs.blank);
            }
            self.out.push_str(part);
        }
        self.out.push('\n');
    }

    fn branch(&mut self, prefix: &str, last: bool, text: &str) {
        let connector = if last {
            self.glyphs.last
        } else {
            self.glyphs.branch
        };
        self.line(prefix, connector, text);
    }

    fn branch_styled(&mut self, prefix: &str, last: bool, text: &str, ansi: &str) {
        let connector = if last {
            self.glyphs.last
        } else {
            self.glyphs.branch
        };
        self.out.push_str(prefix);
        self.out.push_str(connector);
        let indent = prefix.chars().count() + connector.chars().count();
        let width = self.style.cols().saturating_sub(indent).max(16);
        let clean = self.sanitizer.push(text);
        let parts = wrap_preserving_utf8(&clean, width);
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                self.out.push('\n');
                self.out.push_str(prefix);
                self.out.push_str(self.glyphs.blank);
            }
            self.push_styled(part, ansi);
        }
        self.out.push('\n');
    }

    fn child_prefix(&self, prefix: &str, last: bool) -> String {
        let mut next = String::from(prefix);
        next.push_str(if last {
            self.glyphs.blank
        } else {
            self.glyphs.pipe
        });
        next
    }
}

fn wrap_preserving_utf8(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut cols = 0usize;
        // Prefer breaking at spaces so labels stay readable.
        for word in split_keep_spaces(paragraph) {
            let word_cols: usize = word.chars().map(char_display_width).sum();
            if cols > 0 && cols + word_cols > width {
                lines.push(std::mem::take(&mut current));
                cols = 0;
                // Skip leading spaces on the continuation line.
                let trimmed = word.trim_start_matches(' ');
                if trimmed.is_empty() {
                    continue;
                }
                for ch in trimmed.chars() {
                    let w = char_display_width(ch);
                    if cols + w > width && !current.is_empty() {
                        lines.push(std::mem::take(&mut current));
                        cols = 0;
                    }
                    current.push(ch);
                    cols = cols.saturating_add(w);
                }
                continue;
            }
            if word_cols > width && current.is_empty() {
                // Hard-break an oversized token on char boundaries only.
                for ch in word.chars() {
                    let w = char_display_width(ch);
                    if cols + w > width && !current.is_empty() {
                        lines.push(std::mem::take(&mut current));
                        cols = 0;
                    }
                    current.push(ch);
                    cols = cols.saturating_add(w);
                }
                continue;
            }
            current.push_str(word);
            cols = cols.saturating_add(word_cols);
        }
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn split_keep_spaces(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut in_space = false;
    for (idx, ch) in text.char_indices() {
        let space = ch == ' ';
        if idx == start {
            in_space = space;
            continue;
        }
        if space != in_space {
            parts.push(&text[start..idx]);
            start = idx;
            in_space = space;
        }
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

fn char_display_width(ch: char) -> usize {
    if ch.is_ascii() {
        1
    } else if ('\u{1100}'..='\u{115F}').contains(&ch)
        || ('\u{2E80}'..='\u{A4CF}').contains(&ch)
        || ('\u{AC00}'..='\u{D7A3}').contains(&ch)
        || ('\u{F900}'..='\u{FAFF}').contains(&ch)
        || ('\u{FE10}'..='\u{FE6F}').contains(&ch)
        || ('\u{FF00}'..='\u{FF60}').contains(&ch)
        || ('\u{FFE0}'..='\u{FFE6}').contains(&ch)
    {
        2
    } else if ch.is_control() {
        0
    } else {
        1
    }
}

fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let mut out: String = text.chars().take(max.saturating_sub(3)).collect();
    out.push_str("...");
    (out, true)
}

fn byte_note(text: &str) -> String {
    format!("{} chars, {} bytes", text.chars().count(), text.len())
}

#[cfg(test)]
fn contains_control_or_ansi(s: &str) -> bool {
    s.chars()
        .any(|c| c == '\u{1b}' || (c.is_control() && c != '\n' && c != '\t'))
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/// Render typed trace lines as nested human text for `level`.
pub fn render_trace_hierarchy(
    lines: &[StreamLine<'_>],
    level: TraceLevel,
    style: HierarchyStyle,
) -> String {
    let mut summary: Option<&TraceSummaryLine> = None;
    let mut contexts: Vec<&TraceContextLine> = Vec::new();
    let mut tools: Vec<&TraceToolLine> = Vec::new();
    for line in lines {
        match line {
            StreamLine::TraceSummary(s) => summary = Some(s),
            StreamLine::TraceContext(c) => contexts.push(c),
            StreamLine::TraceTool(t) => tools.push(t),
            _ => {}
        }
    }

    let Some(summary) = summary else {
        let mut w = TreeWriter::new(style);
        w.line_root("Trace", CYAN);
        w.branch(
            "",
            true,
            "(empty evidence: no trace_summary in contract projection)",
        );
        return w.finish();
    };

    // Assign finished tools to rounds by contractual tool_call_count order.
    let mut queue = tools;
    let mut by_round: Vec<Vec<&TraceToolLine>> = contexts.iter().map(|_| Vec::new()).collect();
    for (idx, ctx) in contexts.iter().enumerate() {
        let n = ctx.tool_call_count.unwrap_or(0);
        for _ in 0..n {
            if queue.is_empty() {
                break;
            }
            by_round[idx].push(queue.remove(0));
        }
    }
    let orphans = queue;

    let mut w = TreeWriter::new(style);
    let level_label = match level {
        TraceLevel::Summary => "summary",
        TraceLevel::Context => "context",
        TraceLevel::Full => "full",
    };
    w.line_root(&format!("Trace ({level_label})"), CYAN);

    let n_rounds = contexts.len();
    let has_orphans = !orphans.is_empty();

    // Turn
    w.branch("", false, "Turn");
    let turn_prefix = w.child_prefix("", false);
    write_turn_meta(&mut w, &turn_prefix, summary);

    // Context is never the last root child: either model rounds follow, or
    // a Final status line does (summary-only / empty rounds).
    w.branch("", false, "Context");
    let context_prefix = w.child_prefix("", false);
    write_context_meta(&mut w, &context_prefix, summary);

    if n_rounds == 0 {
        if has_orphans {
            write_orphan_tools(&mut w, "", &orphans, level, false);
        }
        w.branch(
            "",
            true,
            &format!(
                "Final status: grounding={}  interpretation_validated={}",
                summary.grounding, summary.interpretation_validated
            ),
        );
        return w.finish();
    }

    for (i, ctx) in contexts.iter().enumerate() {
        let is_last_round = i + 1 == n_rounds && !has_orphans;
        w.branch(
            "",
            is_last_round,
            &format!("Model round {}", ctx.round.saturating_add(1)),
        );
        let rp = w.child_prefix("", is_last_round);
        write_model_round(&mut w, &rp, ctx, &by_round[i], level, i + 1 == n_rounds);
    }

    if has_orphans {
        write_orphan_tools(&mut w, "", &orphans, level, true);
    }

    w.finish()
}

fn write_turn_meta(w: &mut TreeWriter, prefix: &str, summary: &TraceSummaryLine) {
    // Recompute child_prefix — prefix already includes pipe/blank from parent.
    let dry = if summary.dry_run { "yes" } else { "no" };
    w.branch(
        prefix,
        false,
        &format!(
            "provider={}  model={}  dry_run={dry}",
            summary.provider_profile_id, summary.chat_model
        ),
    );
    let corpus = match (&summary.corpus_id, summary.corpus_revision) {
        (Some(id), Some(rev)) => format!("corpus={id}@{rev}"),
        (Some(id), None) => format!("corpus={id}"),
        (None, _) => "corpus=(none)".into(),
    };
    w.branch(prefix, false, &corpus);
    w.branch(
        prefix,
        false,
        &format!(
            "grounding={}  scope={}",
            summary.grounding, summary.grounding_scope
        ),
    );
    w.branch(
        prefix,
        false,
        &format!(
            "interpretation_validated={}",
            summary.interpretation_validated
        ),
    );
    w.branch(
        prefix,
        true,
        &format!(
            "turn_elapsed_ms={}  provider_call_elapsed_ms_sum={}",
            summary.turn_elapsed_ms, summary.provider_call_elapsed_ms_sum
        ),
    );
}

fn write_context_meta(w: &mut TreeWriter, prefix: &str, summary: &TraceSummaryLine) {
    let capped = if summary.context_messages_capped {
        "  [messages capped in detailed payload]"
    } else {
        ""
    };
    w.branch(
        prefix,
        false,
        &format!(
            "budget_chars={}  used_chars={}{capped}",
            summary.context_budget_chars, summary.context_used_chars
        ),
    );
    w.branch(
        prefix,
        false,
        &format!("history_messages={}", summary.history_messages),
    );
    if let Some(telemetry) = &summary.context_budget_telemetry {
        write_budget_telemetry(w, prefix, telemetry, false);
    }
    if summary.retrieved_evidence == 0 && summary.evidence_ids.is_empty() {
        w.branch(prefix, false, "evidence: (empty)");
    } else {
        w.branch(
            prefix,
            false,
            &format!(
                "evidence ({}): {}",
                summary.retrieved_evidence,
                summary.evidence_ids.join(", ")
            ),
        );
    }
    let offered = if summary.tools_offered.is_empty() {
        "(none)".into()
    } else {
        summary.tools_offered.join(", ")
    };
    let executed = if summary.tools_executed.is_empty() {
        "(none)".into()
    } else {
        summary.tools_executed.join(", ")
    };
    w.branch(prefix, false, &format!("tools_offered: {offered}"));
    w.branch(prefix, false, &format!("tools_executed: {executed}"));
    match &summary.context_used {
        Some(cu) if !cu.is_empty() => {
            w.branch(prefix, true, &format!("context_used: {cu}"));
        }
        _ => w.branch(prefix, true, "context_used: (omitted / not present)"),
    }
}

fn write_budget_telemetry(
    w: &mut TreeWriter,
    prefix: &str,
    telemetry: &ContextBudgetTelemetry,
    last: bool,
) {
    w.branch(
        prefix,
        false,
        &format!(
            "packing={}  reserved={}  free={}",
            telemetry.packing_budget_chars,
            telemetry.reserved_headroom_chars,
            telemetry.free_chars_estimate
        ),
    );
    w.branch(
        prefix,
        false,
        &format!(
            "evidence: pre_pack={}  included={}  omitted_blocks={}  omitted_chars={}",
            telemetry.evidence_pre_pack_chars,
            telemetry.evidence_included_chars,
            telemetry.evidence_omitted_blocks,
            telemetry.evidence_omitted_chars
        ),
    );
    w.branch(
        prefix,
        false,
        &format!(
            "evidence_identities: included={}  omitted={}",
            telemetry.evidence_identity_lines_included, telemetry.evidence_identity_lines_omitted
        ),
    );
    w.branch(
        prefix,
        false,
        &format!(
            "history: retained={}  omitted={}  compacted={}",
            telemetry.history_retained_messages,
            telemetry.history_omitted_messages,
            telemetry.history_compacted
        ),
    );
    w.branch(
        prefix,
        last,
        &format!(
            "capacity_source={}  useful_headroom={}  model_round={}",
            telemetry.provider_capacity_source.as_str(),
            telemetry.useful_headroom,
            telemetry.model_round
        ),
    );
}

fn write_model_round(
    w: &mut TreeWriter,
    prefix: &str,
    ctx: &TraceContextLine,
    tools: &[&TraceToolLine],
    level: TraceLevel,
    is_final_round: bool,
) {
    let show_messages = matches!(level, TraceLevel::Context | TraceLevel::Full);
    let has_messages = show_messages && !ctx.messages.is_empty();
    let has_offered = !ctx.tool_names.is_empty();
    let mut left = usize::from(has_messages)
        + usize::from(has_offered)
        + tools.len()
        + 1 // outcome
        + usize::from(is_final_round);

    if has_messages {
        left -= 1;
        let last = left == 0;
        w.branch(prefix, last, &format!("Messages ({})", ctx.messages.len()));
        let mp = w.child_prefix(prefix, last);
        write_messages(w, &mp, &ctx.messages, level);
    }

    if has_offered {
        left -= 1;
        let last = left == 0;
        w.branch(prefix, last, "Tools offered");
        let op = w.child_prefix(prefix, last);
        for (i, name) in ctx.tool_names.iter().enumerate() {
            w.branch(&op, i + 1 == ctx.tool_names.len(), name);
        }
    }

    for tool in tools {
        left -= 1;
        let last = left == 0;
        write_tool_call(w, prefix, last, tool, level);
    }

    left -= 1;
    let outcome_last = left == 0;
    let outcome_text = if ctx.outcome == "failed" {
        let err = ctx
            .error
            .as_deref()
            .unwrap_or("(error text omitted / redacted)");
        format!("Validation/retry: FAILED — {err}")
    } else {
        let fr = ctx.finish_reason.as_deref().unwrap_or("(omitted)");
        let tcc = ctx
            .tool_call_count
            .map(|n| n.to_string())
            .unwrap_or_else(|| "(omitted)".into());
        format!(
            "Outcome: {}  finish_reason={fr}  tool_call_count={tcc}  elapsed_ms={}",
            ctx.outcome, ctx.elapsed_ms
        )
    };
    w.branch(prefix, outcome_last, &outcome_text);

    if is_final_round {
        w.branch(prefix, true, &format!("Final status: {}", ctx.outcome));
    }
}

fn write_messages(
    w: &mut TreeWriter,
    prefix: &str,
    messages: &[TracedMessageLine],
    level: TraceLevel,
) {
    let max = match level {
        TraceLevel::Summary => 0,
        TraceLevel::Context => CONTEXT_BODY_CHARS,
        TraceLevel::Full => FULL_BODY_CHARS,
    };
    for (i, msg) in messages.iter().enumerate() {
        let last = i + 1 == messages.len();
        let trunc_flag = if msg.truncated { " [truncated]" } else { "" };
        let (body, cut) = truncate_chars(&msg.content, max);
        let cut_flag = if cut { " [display truncated]" } else { "" };
        w.branch(
            prefix,
            last,
            &format!(
                "{} ({}): {body}{cut_flag}{trunc_flag}",
                msg.role,
                byte_note(&msg.content)
            ),
        );
    }
}

fn write_tool_call(
    w: &mut TreeWriter,
    prefix: &str,
    last: bool,
    tool: &TraceToolLine,
    level: TraceLevel,
) {
    let ok_label = if tool.ok { "ok" } else { "FAILED" };
    w.branch(
        prefix,
        last,
        &format!("Tool call: {} (id={})", tool.name, tool.id),
    );
    let tp = w.child_prefix(prefix, last);
    w.branch(&tp, false, &format!("Arguments: [{ARGS_NOT_CAPTURED}]"));
    let (summary, sum_cut) = truncate_chars(&tool.summary, SUMMARY_RESULT_CHARS);
    let sum_mark = if sum_cut { " [display truncated]" } else { "" };
    match level {
        TraceLevel::Full => {
            let detail_last = tool.detail.is_none();
            w.branch(
                &tp,
                detail_last,
                &format!("Result: {ok_label} — {summary}{sum_mark}"),
            );
            if let Some(detail) = &tool.detail {
                let (d, cut) = truncate_chars(detail, FULL_DETAIL_CHARS);
                let mark = if cut { " [display truncated]" } else { "" };
                w.branch(
                    &tp,
                    true,
                    &format!("Detail ({}): {d}{mark}", byte_note(detail)),
                );
            }
        }
        _ => {
            w.branch(
                &tp,
                true,
                &format!("Result: {ok_label} — {summary}{sum_mark}"),
            );
        }
    }
}

fn write_orphan_tools(
    w: &mut TreeWriter,
    prefix: &str,
    tools: &[&TraceToolLine],
    level: TraceLevel,
    last_section: bool,
) {
    w.branch(
        prefix,
        last_section,
        "Tool calls (round correlation omitted by contract)",
    );
    let tp = w.child_prefix(prefix, last_section);
    for (i, tool) in tools.iter().enumerate() {
        write_tool_call(w, &tp, i + 1 == tools.len(), tool, level);
    }
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/// Nested causal hierarchy for a finished activity record.
pub fn render_activity_hierarchy(record: &TurnActivityRecord, style: HierarchyStyle) -> String {
    render_activity_hierarchy_with_context(record, None, style)
}

/// Activity hierarchy with the latest typed context-budget snapshot nested in
/// the same tree. Used by `--activity` when `--trace` is not also rendering it.
pub fn render_activity_hierarchy_with_context(
    record: &TurnActivityRecord,
    context_budget: Option<&ContextBudgetTelemetry>,
    style: HierarchyStyle,
) -> String {
    let mut w = TreeWriter::new(style);
    w.line_root("Activity", CYAN);

    w.branch("", false, "Turn");
    let tp = w.child_prefix("", false);
    w.branch(&tp, false, &format!("turn_id={}", record.turn_id));
    w.branch(&tp, false, &format!("session_id={}", record.session_id));
    let status = wire_status(record.status);
    w.branch(
        &tp,
        false,
        &format!(
            "status={status}  events={}  omitted={}  elapsed_ms={}",
            record.events.len(),
            record.dropped_events,
            record.total_elapsed_ms
        ),
    );
    if record.is_truncated() {
        w.branch(
            &tp,
            false,
            &format!(
                "[truncated] {} event(s) omitted by hard bound",
                record.dropped_events
            ),
        );
    }
    let detail = match record.detail_level {
        cd_core::activity::ActivityDetailLevel::Summary => "summary",
        cd_core::activity::ActivityDetailLevel::Full => "full",
    };
    w.branch(&tp, true, &format!("detail_level={detail}"));

    if let Some(telemetry) = context_budget {
        w.branch("", false, "Context");
        let cp = w.child_prefix("", false);
        w.branch(
            &cp,
            false,
            &format!(
                "hard={}  used={}",
                telemetry.hard_budget_chars, telemetry.used_chars_estimate
            ),
        );
        write_budget_telemetry(&mut w, &cp, telemetry, true);
    }

    if record.events.is_empty() {
        w.branch("", true, "Events: (empty evidence)");
        return w.finish();
    }

    let groups = group_activity_events(&record.events);
    for (gi, group) in groups.iter().enumerate() {
        let last = gi + 1 == groups.len();
        match group {
            ActivityGroup::Section { title, indices } => {
                w.branch("", last, title);
                let gp = w.child_prefix("", last);
                write_grouped_events(&mut w, &gp, &record.events, indices);
            }
        }
    }

    w.finish()
}

/// Plain ANSI-free activity text (stable for redirected output / tests).
pub fn render_human_activity(record: &TurnActivityRecord) -> String {
    render_activity_hierarchy(record, HierarchyStyle::plain())
}

enum ActivityGroup {
    Section { title: String, indices: Vec<usize> },
}

fn group_activity_events(events: &[ActivityEvent]) -> Vec<ActivityGroup> {
    let mut groups = Vec::new();
    let mut i = 0;
    while i < events.len() {
        let e = &events[i];
        if let Some(round) = e.operation_id.strip_prefix("provider-round-") {
            let round: u32 = round.parse().unwrap_or(0);
            let mut indices = vec![i];
            i += 1;
            while i < events.len() {
                let id = events[i].operation_id.as_str();
                if id.starts_with("provider-round-")
                    || id == "turn-completed"
                    || id == "turn-started"
                    || id.starts_with("phase-")
                {
                    break;
                }
                indices.push(i);
                i += 1;
            }
            groups.push(ActivityGroup::Section {
                title: format!("Model round {}", round.saturating_add(1)),
                indices,
            });
            continue;
        }
        if e.operation_id.starts_with("phase-") || e.operation_id == "turn-started" {
            let title = if e.operation_id == "turn-started" {
                "Phase: start".into()
            } else {
                e.label.clone()
            };
            let mut indices = vec![i];
            i += 1;
            while i < events.len() {
                let id = events[i].operation_id.as_str();
                if id.starts_with("provider-round-")
                    || id.starts_with("phase-")
                    || id == "turn-started"
                    || id == "turn-completed"
                    || id.starts_with("tool-")
                {
                    break;
                }
                indices.push(i);
                i += 1;
            }
            groups.push(ActivityGroup::Section { title, indices });
            continue;
        }
        let title = if e.operation_id == "turn-completed" {
            "Final status".into()
        } else if e.operation_id.starts_with("tool-") {
            "Tools".into()
        } else {
            "Host / other".into()
        };
        let mut indices = vec![i];
        i += 1;
        while i < events.len() {
            let id = events[i].operation_id.as_str();
            if id.starts_with("provider-round-") || id.starts_with("phase-") || id == "turn-started"
            {
                break;
            }
            // Keep consuming tools / errors / completed into this section
            // when we started as Tools or Host.
            indices.push(i);
            i += 1;
        }
        groups.push(ActivityGroup::Section { title, indices });
    }
    groups
}

fn write_grouped_events(
    w: &mut TreeWriter,
    prefix: &str,
    events: &[ActivityEvent],
    indices: &[usize],
) {
    // Fold consecutive tool rows that share operation_id into one Tool call.
    let mut i = 0;
    while i < indices.len() {
        let ev = &events[indices[i]];
        if ev.operation_id.starts_with("tool-") {
            let op = ev.operation_id.clone();
            let mut rows = vec![ev];
            let mut j = i + 1;
            while j < indices.len() && events[indices[j]].operation_id == op {
                rows.push(&events[indices[j]]);
                j += 1;
            }
            let last = j >= indices.len();
            write_tool_lifecycle(w, prefix, last, &rows);
            i = j;
            continue;
        }
        let last = i + 1 == indices.len();
        write_single_event(w, prefix, last, ev);
        i += 1;
    }
}

fn write_tool_lifecycle(w: &mut TreeWriter, prefix: &str, last: bool, rows: &[&ActivityEvent]) {
    let name = rows.first().map(|e| e.label.as_str()).unwrap_or("Tool");
    w.branch(prefix, last, &format!("Tool call: {name}"));
    let tp = w.child_prefix(prefix, last);
    w.branch(&tp, false, &format!("Arguments: [{ARGS_NOT_CAPTURED}]"));
    // Prefer Completed row for result; else last row.
    let result = rows
        .iter()
        .rev()
        .find(|e| e.phase == ActivityPhase::Completed)
        .or_else(|| rows.last())
        .copied();
    if let Some(ev) = result {
        let st = wire_status(ev.status);
        let mut text = format!("Result: {st}");
        if let Some(detail) = &ev.detail {
            let (d, cut) = truncate_chars(detail, SUMMARY_RESULT_CHARS);
            let mark = if cut { " [display truncated]" } else { "" };
            text.push_str(&format!(" — {d}{mark}"));
        }
        if matches!(ev.status, ActivityStatus::Failed | ActivityStatus::Withheld) {
            text.push_str("  [failed/rejected]");
        }
        if matches!(ev.status, ActivityStatus::Cancelled) {
            text.push_str("  [cancelled]");
        }
        w.branch(&tp, true, &text);
    } else {
        w.branch(&tp, true, "Result: (omitted)");
    }
}

fn write_single_event(w: &mut TreeWriter, prefix: &str, last: bool, ev: &ActivityEvent) {
    let st = wire_status(ev.status);
    let phase = match ev.phase {
        ActivityPhase::Started => "started",
        ActivityPhase::Progress => "progress",
        ActivityPhase::Completed => "completed",
    };
    let mut line = format!("[{}] {phase}/{st} — {}", ev.seq, ev.label);
    if let Some(detail) = &ev.detail {
        let (d, cut) = truncate_chars(detail, SUMMARY_RESULT_CHARS);
        let mark = if cut { " [display truncated]" } else { "" };
        line.push_str(&format!(" ({d}{mark})"));
    }
    if let Some(ctx) = &ev.context {
        line.push_str(&format!(
            "  [round={} msgs={} chars={}]",
            ctx.round, ctx.message_count, ctx.context_used_chars
        ));
        if ctx.messages_capped {
            line.push_str(" [messages capped]");
        }
        if ctx.bodies.is_some() {
            line.push_str(" [bodies retained]");
        } else {
            line.push_str(" [bodies omitted]");
        }
    }
    if style_color_hint(w) {
        // Semantic color on the status token only; label stays plain.
        let ansi = match ev.status {
            ActivityStatus::Failed => RED,
            ActivityStatus::Cancelled | ActivityStatus::Withheld => YELLOW,
            ActivityStatus::Ok => GREEN,
            ActivityStatus::Pending => DIM,
        };
        w.branch_styled(prefix, last, &line, ansi);
    } else {
        w.branch(prefix, last, &line);
    }
}

fn style_color_hint(w: &TreeWriter) -> bool {
    w.style.color
}

fn wire_status(status: ActivityStatus) -> &'static str {
    match status {
        ActivityStatus::Pending => "pending",
        ActivityStatus::Ok => "ok",
        ActivityStatus::Failed => "failed",
        ActivityStatus::Cancelled => "cancelled",
        ActivityStatus::Withheld => "withheld",
    }
}

/// True when `s` is safe for plain/redirected mode (no ANSI / cursor controls).
#[cfg(test)]
pub fn is_plain_output(s: &str) -> bool {
    !contains_control_or_ansi(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{TraceContextLine, TraceSummaryLine, TraceToolLine, TracedMessageLine};
    use cd_core::activity::{
        ActivityDetailLevel, ActivityOrigin, ActivityTrigger, DataScope, Determinism, PrivacyClass,
    };
    use cd_core::context_budgeting::CapacitySourceLabel;

    fn summary_fixture() -> TraceSummaryLine {
        TraceSummaryLine {
            provider_profile_id: "ollama-local".into(),
            chat_model: "mistral".into(),
            corpus_id: None,
            corpus_revision: None,
            dry_run: true,
            history_messages: 3,
            retrieved_evidence: 0,
            evidence_ids: vec![],
            context_budget_chars: 120_000,
            context_used_chars: 828,
            context_budget_telemetry: None,
            context_messages_capped: false,
            tool_names: vec!["search_kb".into()],
            tools_executed: vec![],
            tools_offered: vec!["search_kb".into()],
            elapsed_ms: 2,
            turn_elapsed_ms: 7,
            provider_call_elapsed_ms_sum: 2,
            grounding: "not_applicable".into(),
            grounding_scope: "not_applicable".into(),
            interpretation_validated: false,
            context_used: None,
            provider_telemetry: None,
        }
    }

    fn budget_fixture() -> ContextBudgetTelemetry {
        ContextBudgetTelemetry {
            model_round: 1,
            hard_budget_chars: 120_000,
            packing_budget_chars: 108_000,
            reserved_headroom_chars: 12_000,
            used_chars_estimate: 50_000,
            free_chars_estimate: 70_000,
            evidence_pre_pack_chars: 150_000,
            evidence_included_chars: 90_000,
            evidence_omitted_blocks: 2,
            evidence_omitted_chars: 60_000,
            evidence_identity_lines_included: 10,
            evidence_identity_lines_omitted: 5,
            history_retained_messages: 2,
            history_omitted_messages: 1,
            history_compacted: false,
            provider_capacity_source: CapacitySourceLabel::UnknownConfigured,
            useful_headroom: true,
        }
    }

    fn style_plain_narrow() -> HierarchyStyle {
        HierarchyStyle {
            color: false,
            ascii: true,
            width: Some(48),
        }
    }

    #[test]
    fn summary_trace_is_nested_ascii_without_json_dump() {
        let lines = vec![StreamLine::TraceSummary(summary_fixture())];
        let out = render_trace_hierarchy(&lines, TraceLevel::Summary, style_plain_narrow());
        assert!(out.contains("Trace (summary)"));
        assert!(out.contains("+-- Turn") || out.contains("`-- Turn") || out.contains("Turn"));
        assert!(out.contains("Context"));
        assert!(out.contains("evidence: (empty)"));
        assert!(out.contains("Final status:"));
        assert!(!out.contains("\"type\":\"trace_summary\""));
        assert!(!out.contains('{'));
        assert!(
            is_plain_output(&out),
            "plain mode must not emit ANSI: {out:?}"
        );
        assert!(!out.contains('├'));
        assert!(!out.contains(ARGS_NOT_CAPTURED)); // no tools at summary-only
    }

    #[test]
    fn typed_context_budget_is_nested_in_trace() {
        let mut summary = summary_fixture();
        summary.context_budget_telemetry = Some(budget_fixture());
        let out = render_trace_hierarchy(
            &[StreamLine::TraceSummary(summary)],
            TraceLevel::Summary,
            HierarchyStyle::plain(),
        );
        assert!(out.contains("packing=108000"));
        assert!(out.contains("omitted_chars=60000"));
        assert!(out.contains("model_round=1"));
    }

    #[test]
    fn summary_trace_golden_snapshot_stable_plain() {
        let lines = vec![StreamLine::TraceSummary(summary_fixture())];
        let out = render_trace_hierarchy(&lines, TraceLevel::Summary, HierarchyStyle::plain());
        let expected = "\
Trace (summary)
+-- Turn
|   +-- provider=ollama-local  model=mistral  dry_run=yes
|   +-- corpus=(none)
|   +-- grounding=not_applicable  scope=not_applicable
|   +-- interpretation_validated=false
|   `-- turn_elapsed_ms=7  provider_call_elapsed_ms_sum=2
+-- Context
|   +-- budget_chars=120000  used_chars=828
|   +-- history_messages=3
|   +-- evidence: (empty)
|   +-- tools_offered: search_kb
|   +-- tools_executed: (none)
|   `-- context_used: (omitted / not present)
`-- Final status: grounding=not_applicable  interpretation_validated=false
";
        assert_eq!(out, expected, "human summary golden drifted:\n{out}");
    }

    #[test]
    fn context_and_full_show_rounds_and_never_invent_arguments() {
        let mut summary = summary_fixture();
        summary.dry_run = false;
        summary.tools_executed = vec!["search_kb".into()];
        let ctx0 = TraceContextLine {
            round: 0,
            elapsed_ms: 10,
            tool_names: vec!["search_kb".into()],
            messages: vec![TracedMessageLine {
                role: "user".into(),
                content: "hello".into(),
                char_count: 5,
                truncated: false,
            }],
            outcome: "completed",
            finish_reason: Some("tool_calls".into()),
            tool_call_count: Some(1),
            error: None,

            provider_round_telemetry: None,
        };
        let ctx1 = TraceContextLine {
            round: 1,
            elapsed_ms: 8,
            tool_names: vec!["search_kb".into()],
            messages: vec![
                TracedMessageLine {
                    role: "user".into(),
                    content: "hello".into(),
                    char_count: 5,
                    truncated: false,
                },
                TracedMessageLine {
                    role: "tool".into(),
                    content: "result body".into(),
                    char_count: 11,
                    truncated: false,
                },
            ],
            outcome: "completed",
            finish_reason: Some("stop".into()),
            tool_call_count: Some(0),
            error: None,

            provider_round_telemetry: None,
        };
        let tool = TraceToolLine {
            id: "call_1".into(),
            name: "search_kb".into(),
            ok: true,
            summary: "found 2 hits".into(),
            detail: Some("a".repeat(900)),
        };
        let lines = vec![
            StreamLine::TraceSummary(summary),
            StreamLine::TraceContext(ctx0),
            StreamLine::TraceContext(ctx1),
            StreamLine::TraceTool(tool),
        ];

        let context_out =
            render_trace_hierarchy(&lines, TraceLevel::Context, HierarchyStyle::plain());
        assert!(context_out.contains("Model round 1"));
        assert!(context_out.contains("Model round 2"));
        assert!(context_out.contains("Tools offered"));
        assert!(context_out.contains("Tool call: search_kb"));
        assert!(context_out.contains(ARGS_NOT_CAPTURED));
        assert!(!context_out.contains("Detail ("));
        assert!(context_out.contains("Final status: completed"));
        assert!(!context_out.to_ascii_lowercase().contains("\"query\""));

        let full_out = render_trace_hierarchy(&lines, TraceLevel::Full, HierarchyStyle::plain());
        assert!(full_out.contains("Detail ("));
        assert!(full_out.contains("[display truncated]") || full_out.contains("900 chars"));
        assert!(full_out.contains(ARGS_NOT_CAPTURED));
        assert!(is_plain_output(&full_out));
    }

    #[test]
    fn failed_call_and_retry_markers_are_explicit() {
        let mut summary = summary_fixture();
        summary.grounding = "ungrounded".into();
        let ctx = TraceContextLine {
            round: 0,
            elapsed_ms: 3,
            tool_names: vec![],
            messages: vec![],
            outcome: "failed",
            finish_reason: None,
            tool_call_count: None,
            error: Some("provider timeout".into()),

            provider_round_telemetry: None,
        };
        let tool = TraceToolLine {
            id: "t1".into(),
            name: "search_logs".into(),
            ok: false,
            summary: "denied".into(),
            detail: None,
        };
        let lines = vec![
            StreamLine::TraceSummary(summary),
            StreamLine::TraceContext(ctx),
            StreamLine::TraceTool(tool),
        ];
        let out = render_trace_hierarchy(&lines, TraceLevel::Full, HierarchyStyle::plain());
        assert!(out.contains("FAILED"));
        assert!(out.contains("provider timeout"));
        // Orphan tool (no tool_call_count) still rendered honestly.
        assert!(
            out.contains("round correlation omitted") || out.contains("Tool call: search_logs")
        );
    }

    #[test]
    fn unicode_tree_only_when_configured_ascii_false_and_capable() {
        let lines = vec![StreamLine::TraceSummary(summary_fixture())];
        let unicode = HierarchyStyle {
            color: false,
            ascii: false,
            width: Some(80),
        };
        let out = render_trace_hierarchy(&lines, TraceLevel::Summary, unicode);
        assert!(out.contains('├') || out.contains('└'));

        let redirected = HierarchyStyle::from_parts(
            false,
            Some("xterm".into()),
            false,
            ColorMode::Auto,
            false,
            Some(80),
        );
        assert!(redirected.ascii, "redirected output must force ASCII");
        assert!(!redirected.color);

        let dumb = HierarchyStyle::from_parts(
            true,
            Some("dumb".into()),
            false,
            ColorMode::Auto,
            false,
            Some(80),
        );
        assert!(dumb.ascii);
        assert!(!dumb.color);

        let no_color = HierarchyStyle::from_parts(
            true,
            Some("xterm".into()),
            true,
            ColorMode::Auto,
            false,
            Some(80),
        );
        assert!(!no_color.color);
        assert!(no_color.ascii, "NO_COLOR must select ASCII-safe glyphs");
        assert!(is_plain_output(&render_trace_hierarchy(
            &lines,
            TraceLevel::Summary,
            no_color
        )));
    }

    #[test]
    fn narrow_width_wraps_without_splitting_codepoints() {
        let mut summary = summary_fixture();
        summary.context_used = Some("café-".to_string() + &"路径".repeat(40));
        let lines = vec![StreamLine::TraceSummary(summary)];
        let out = render_trace_hierarchy(
            &lines,
            TraceLevel::Summary,
            HierarchyStyle {
                color: false,
                ascii: true,
                width: Some(40),
            },
        );
        assert!(out.contains("café") || out.contains("context_used"));
        // Every line must be valid UTF-8 (String guarantee) and not contain
        // replacement artifacts from mid-codepoint splits.
        assert!(!out.contains('\u{FFFD}'));
        assert!(is_plain_output(&out));
    }

    #[test]
    fn long_path_label_wraps() {
        let mut summary = summary_fixture();
        summary.evidence_ids = vec![format!("file:{}", "a".repeat(200))];
        summary.retrieved_evidence = 1;
        let out = render_trace_hierarchy(
            &[StreamLine::TraceSummary(summary)],
            TraceLevel::Summary,
            HierarchyStyle {
                color: false,
                ascii: true,
                width: Some(40),
            },
        );
        assert!(out.contains("evidence"));
        let max_line = out.lines().map(|l| l.chars().count()).max().unwrap_or(0);
        assert!(
            max_line <= 56,
            "expected wrap near width, got max_line={max_line}: {out}"
        );
    }

    fn activity_event(
        seq: u64,
        operation_id: &str,
        label: &str,
        phase: ActivityPhase,
        status: ActivityStatus,
    ) -> ActivityEvent {
        ActivityEvent {
            turn_id: "t1".into(),
            operation_id: operation_id.into(),
            seq,
            elapsed_ms: Some(seq * 2),
            phase,
            status,
            origin: ActivityOrigin::DeterministicHost,
            determinism: Determinism::Deterministic,
            label: label.into(),
            detail: None,
            trigger: ActivityTrigger::HostPolicy,
            scope: DataScope::conversation(),
            evidence: vec![],
            privacy: PrivacyClass::Metadata,
            context: None,
        }
    }

    #[test]
    fn activity_hierarchy_groups_rounds_tools_retry_cancel_empty() {
        let empty = TurnActivityRecord {
            version: 2,
            turn_id: "t-empty".into(),
            session_id: "s".into(),
            message_id: None,
            scope: DataScope::conversation(),
            status: ActivityStatus::Ok,
            total_elapsed_ms: 0,
            detail_level: ActivityDetailLevel::Summary,
            events: vec![],
            dropped_events: 0,
        };
        let empty_out = render_human_activity(&empty);
        assert!(empty_out.contains("empty evidence"));
        assert!(is_plain_output(&empty_out));
        let with_context = render_activity_hierarchy_with_context(
            &empty,
            Some(&budget_fixture()),
            HierarchyStyle::plain(),
        );
        assert!(with_context.contains("Context"));
        assert!(with_context.contains("packing=108000"));
        assert!(with_context.contains("model_round=1"));

        let mut provider = activity_event(
            2,
            "provider-round-0",
            "Model request round 0",
            ActivityPhase::Completed,
            ActivityStatus::Ok,
        );
        provider.origin = ActivityOrigin::ProbabilisticModel;
        provider.determinism = Determinism::Probabilistic;

        let record = TurnActivityRecord {
            version: 2,
            turn_id: "t1".into(),
            session_id: "s1".into(),
            message_id: None,
            scope: DataScope::conversation(),
            status: ActivityStatus::Cancelled,
            total_elapsed_ms: 40,
            detail_level: ActivityDetailLevel::Summary,
            events: vec![
                activity_event(
                    0,
                    "turn-started",
                    "Turn started",
                    ActivityPhase::Started,
                    ActivityStatus::Pending,
                ),
                activity_event(
                    1,
                    "phase-SynthesizingAnswer",
                    "Phase: SynthesizingAnswer",
                    ActivityPhase::Progress,
                    ActivityStatus::Pending,
                ),
                provider,
                activity_event(
                    3,
                    "tool-call_1",
                    "Tool search_kb",
                    ActivityPhase::Started,
                    ActivityStatus::Pending,
                ),
                activity_event(
                    4,
                    "tool-call_1",
                    "Tool search_kb",
                    ActivityPhase::Completed,
                    ActivityStatus::Failed,
                ),
                activity_event(
                    5,
                    "error-retry",
                    "Linked synthesis retry",
                    ActivityPhase::Completed,
                    ActivityStatus::Ok,
                ),
                activity_event(
                    6,
                    "turn-completed",
                    "Turn completed (cancel)",
                    ActivityPhase::Completed,
                    ActivityStatus::Cancelled,
                ),
            ],
            dropped_events: 0,
        };
        let out = render_human_activity(&record);
        assert!(out.contains("Activity"));
        assert!(out.contains("Model round 1"));
        assert!(out.contains("Tool call:"));
        assert!(out.contains(ARGS_NOT_CAPTURED));
        assert!(out.contains("failed") || out.contains("FAILED") || out.contains("[failed"));
        assert!(out.contains("cancelled") || out.contains("Final status"));
        assert!(out.contains("status=cancelled"));
        assert!(!out.contains("sk-"));
        assert!(is_plain_output(&out));
    }

    #[test]
    fn json_shapes_untouched_by_renderer_module() {
        // Renderer consumes references only; serializing the same DTOs must
        // still produce the historical field set (spot-check key fields).
        let summary = summary_fixture();
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["provider_profile_id"], "ollama-local");
        assert_eq!(json["interpretation_validated"], false);
        assert!(json.get("arguments").is_none());
        let tool = TraceToolLine {
            id: "1".into(),
            name: "t".into(),
            ok: true,
            summary: "s".into(),
            detail: None,
        };
        let v = serde_json::to_value(&tool).unwrap();
        assert!(v.get("arguments").is_none());
        assert_eq!(v["id"], "1");
    }

    #[test]
    fn color_capable_tty_may_emit_ansi_but_plain_does_not() {
        let lines = vec![StreamLine::TraceSummary(summary_fixture())];
        let colored = HierarchyStyle {
            color: true,
            ascii: true,
            width: Some(80),
        };
        let out = render_trace_hierarchy(&lines, TraceLevel::Summary, colored);
        assert!(out.contains('\u{1b}'));
        let plain = render_trace_hierarchy(&lines, TraceLevel::Summary, HierarchyStyle::plain());
        assert!(is_plain_output(&plain));
    }

    #[test]
    fn colored_activity_sanitizes_untrusted_labels_and_details() {
        let mut event = activity_event(
            0,
            "tool",
            "\u{1b}[31mINJECT\u{7}",
            ActivityPhase::Completed,
            ActivityStatus::Ok,
        );
        event.detail = Some("detail\u{1b}[2J\u{7}".into());
        let record = TurnActivityRecord {
            version: 2,
            turn_id: "t".into(),
            session_id: "s".into(),
            message_id: None,
            scope: DataScope::conversation(),
            status: ActivityStatus::Ok,
            total_elapsed_ms: 1,
            detail_level: ActivityDetailLevel::Summary,
            events: vec![event],
            dropped_events: 0,
        };
        let out = render_activity_hierarchy(
            &record,
            HierarchyStyle {
                color: true,
                ascii: true,
                width: Some(80),
            },
        );
        assert!(!out.contains("\u{1b}[31mINJECT"));
        assert!(!out.contains("\u{1b}[2J"));
        assert!(!out.contains('\u{7}'));
    }
}
