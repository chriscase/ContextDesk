//! Readable terminal projections for ordinary and corpus-linked answers.
//!
//! This is presentation only: it receives the exact terminal answer emitted by
//! the production chat workflow. JSON/JSONL never pass through it; ordinary
//! unlinked `chat` keeps its existing streaming projection.

use crate::config::ColorMode;
use crate::render::{TerminalCapabilities, TerminalTextSanitizer};
use std::io::{self, IsTerminal};

const CYAN: &str = "\x1b[1;36m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const YELLOW: &str = "\x1b[1;33m";
const RESET: &str = "\x1b[0m";

struct InvestigationRenderOptions<'a> {
    model: &'a str,
    elapsed_ms: u64,
    typed_envelope: bool,
    grounding: &'a str,
    width: usize,
    ansi: bool,
}

pub fn render(markdown: &str, color: ColorMode) -> String {
    let mut sanitizer = TerminalTextSanitizer::for_current_console();
    let clean = sanitizer.push(markdown);
    let caps = TerminalCapabilities::detect(color);
    let ansi = io::stdout().is_terminal() && caps.color;
    render_with(&clean, terminal_width(), ansi)
}

/// Render a corpus-linked answer as a small investigation report.
///
/// The model's text remains the answer body; this wrapper adds only host-owned
/// provenance and validation facts. In particular, a missing typed envelope is
/// shown as `PROVISIONAL` rather than silently presented as a host-validated
/// answer. JSON/JSONL callers keep their existing machine-readable contract.
pub fn render_investigation(
    question: &str,
    answer: &str,
    model: &str,
    elapsed_ms: u64,
    typed_envelope: bool,
    grounding: &str,
    color: ColorMode,
) -> String {
    let caps = TerminalCapabilities::detect(color);
    let ansi = io::stdout().is_terminal() && caps.color;
    render_investigation_with(
        question,
        answer,
        InvestigationRenderOptions {
            model,
            elapsed_ms,
            typed_envelope,
            grounding,
            width: terminal_width(),
            ansi,
        },
    )
}

fn render_investigation_with(
    question: &str,
    answer: &str,
    options: InvestigationRenderOptions<'_>,
) -> String {
    let InvestigationRenderOptions {
        model,
        elapsed_ms,
        typed_envelope,
        grounding,
        width,
        ansi,
    } = options;
    let width = width.clamp(48, 120);
    let inner = width.saturating_sub(4).max(24);
    let validation = if typed_envelope {
        "HOST-VALIDATED"
    } else {
        "PROVISIONAL — human review recommended"
    };
    let elapsed = format_duration(elapsed_ms);
    let question = sanitize_inline(question);
    let model = sanitize_inline(model);
    let grounding = sanitize_inline(grounding);
    let mut out = String::new();

    out.push('+');
    out.push_str(&"-".repeat(width.saturating_sub(2)));
    out.push_str("+\n");
    boxed_field(&mut out, "Question", &question, inner, ansi, CYAN);
    boxed_field(&mut out, "Analyst", &model, inner, ansi, CYAN);
    boxed_field(
        &mut out,
        "Validation",
        validation,
        inner,
        ansi,
        if typed_envelope { CYAN } else { YELLOW },
    );
    boxed_field(&mut out, "Grounding", &grounding, inner, ansi, CYAN);
    boxed_field(&mut out, "Elapsed", &elapsed, inner, ansi, CYAN);
    out.push('+');
    out.push_str(&"-".repeat(width.saturating_sub(2)));
    out.push_str("+\n\n");

    if ansi {
        out.push_str(BOLD);
    }
    out.push_str("INVESTIGATION ANSWER");
    if ansi {
        out.push_str(RESET);
    }
    out.push('\n');
    out.push_str(&"─".repeat("INVESTIGATION ANSWER".len().min(width)));
    out.push('\n');
    out.push_str(&render_with(answer, width, ansi));
    out
}

fn boxed_field(out: &mut String, label: &str, value: &str, width: usize, ansi: bool, color: &str) {
    let prefix_plain = format!("| {label}: ");
    let continuation = format!("| {}  ", " ".repeat(label.chars().count()));
    let available = width.saturating_sub(prefix_plain.chars().count()).max(8);
    let lines = wrap_words(value, available);
    for (index, line) in lines.iter().enumerate() {
        let prefix = if index == 0 {
            prefix_plain.as_str()
        } else {
            continuation.as_str()
        };
        out.push_str(prefix);
        if ansi && index == 0 {
            out.push_str(color);
        }
        out.push_str(line);
        if ansi && index == 0 {
            out.push_str(RESET);
        }
        out.push_str("|\n");
    }
}

fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut lines = vec![String::new()];
    for word in text.split_whitespace() {
        let chunks: Vec<String> = word
            .chars()
            .collect::<Vec<_>>()
            .chunks(width.max(1))
            .map(|chunk| chunk.iter().collect())
            .collect();
        for (chunk_index, chunk) in chunks.iter().enumerate() {
            let current = lines.last_mut().expect("at least one line");
            if chunk_index > 0 {
                lines.push(chunk.clone());
            } else if current.is_empty() {
                current.push_str(chunk);
            } else if current.chars().count() + 1 + chunk.chars().count() > width {
                lines.push(chunk.clone());
            } else {
                current.push(' ');
                current.push_str(chunk);
            }
        }
    }
    lines
}

fn sanitize_inline(value: &str) -> String {
    let mut sanitizer = TerminalTextSanitizer::with_ascii(true);
    sanitizer.push(value).replace(['\n', '\r', '\t'], " ")
}

fn format_duration(elapsed_ms: u64) -> String {
    if elapsed_ms < 1_000 {
        format!("{elapsed_ms} ms")
    } else {
        format!("{:.1} s", elapsed_ms as f64 / 1_000.0)
    }
}

fn terminal_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(88)
        .clamp(32, 120)
}

fn render_with(markdown: &str, width: usize, ansi: bool) -> String {
    let mut out = String::new();
    let mut in_code = false;
    let mut paragraph = Vec::new();

    let flush_paragraph = |out: &mut String, paragraph: &mut Vec<String>| {
        if paragraph.is_empty() {
            return;
        }
        let text = expand_markdown_links(&paragraph.join(" "));
        push_wrapped(out, &text, "", "", width);
        paragraph.clear();
    };

    for raw in markdown.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with("```") {
            flush_paragraph(&mut out, &mut paragraph);
            in_code = !in_code;
            continue;
        }
        if in_code {
            push_wrapped(&mut out, line, "    ", "    ", width);
            continue;
        }
        if line.trim().is_empty() {
            flush_paragraph(&mut out, &mut paragraph);
            push_blank(&mut out);
            continue;
        }
        if let Some(title) = line.trim_start().strip_prefix('#') {
            flush_paragraph(&mut out, &mut paragraph);
            let title = title.trim_start_matches('#').trim();
            push_blank(&mut out);
            if ansi {
                out.push_str(CYAN);
            }
            out.push_str(title);
            if ansi {
                out.push_str(RESET);
            }
            out.push('\n');
            out.push_str(&"─".repeat(title.chars().count().min(width)));
            out.push('\n');
            continue;
        }
        let trimmed = line.trim_start();
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            flush_paragraph(&mut out, &mut paragraph);
            let prefix = if ansi {
                format!("{CYAN}•{RESET} ")
            } else {
                "- ".to_string()
            };
            push_wrapped(&mut out, &expand_markdown_links(item), &prefix, "  ", width);
            continue;
        }
        if let Some((number, item)) = numbered_item(trimmed) {
            flush_paragraph(&mut out, &mut paragraph);
            let prefix = format!("{number}. ");
            let continuation = " ".repeat(prefix.chars().count());
            push_wrapped(
                &mut out,
                &expand_markdown_links(item),
                &prefix,
                &continuation,
                width,
            );
            continue;
        }
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            flush_paragraph(&mut out, &mut paragraph);
            render_table_row(&mut out, trimmed, width, ansi);
            continue;
        }
        if let Some(quote) = trimmed.strip_prefix('>') {
            flush_paragraph(&mut out, &mut paragraph);
            let prefix = if ansi {
                format!("{DIM}│{RESET} ")
            } else {
                "| ".to_string()
            };
            push_wrapped(
                &mut out,
                &expand_markdown_links(quote.trim()),
                &prefix,
                "  ",
                width,
            );
            continue;
        }
        paragraph.push(trimmed.to_string());
    }
    flush_paragraph(&mut out, &mut paragraph);
    while out.ends_with("\n\n") {
        out.pop();
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn numbered_item(line: &str) -> Option<(&str, &str)> {
    let (number, item) = line.split_once(". ")?;
    number
        .chars()
        .all(|ch| ch.is_ascii_digit())
        .then_some((number, item))
}

fn render_table_row(out: &mut String, line: &str, width: usize, ansi: bool) {
    let cells = line
        .trim_matches('|')
        .split('|')
        .map(str::trim)
        .collect::<Vec<_>>();
    if cells
        .iter()
        .all(|cell| cell.chars().all(|ch| matches!(ch, '-' | ':')))
    {
        return;
    }
    let compact = cells.join("  |  ");
    if compact.chars().count() <= width {
        if ansi {
            out.push_str(BOLD);
        }
        out.push_str(&compact);
        if ansi {
            out.push_str(RESET);
        }
        out.push('\n');
    } else {
        for (index, cell) in cells.iter().enumerate() {
            push_wrapped(out, cell, &format!("{}: ", index + 1), "   ", width);
        }
    }
}

fn push_wrapped(out: &mut String, text: &str, first: &str, continuation: &str, width: usize) {
    let mut prefix = first;
    let mut line_len = prefix.chars().count();
    out.push_str(prefix);
    for word in text.split_whitespace() {
        let word_len = word.chars().count();
        let separator = usize::from(line_len > prefix.chars().count());
        if line_len + separator + word_len > width && line_len > prefix.chars().count() {
            out.push('\n');
            prefix = continuation;
            out.push_str(prefix);
            line_len = prefix.chars().count();
        } else if separator == 1 {
            out.push(' ');
            line_len += 1;
        }
        out.push_str(word);
        line_len += word_len;
    }
    out.push('\n');
}

fn push_blank(out: &mut String) {
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
}

fn expand_markdown_links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(label_start) = rest.find('[') {
        out.push_str(&rest[..label_start]);
        let candidate = &rest[label_start + 1..];
        let Some(label_end) = candidate.find("](") else {
            out.push_str(&rest[label_start..]);
            return out;
        };
        let url_start = label_end + 2;
        let Some(url_end) = candidate[url_start..].find(')') else {
            out.push_str(&rest[label_start..]);
            return out;
        };
        let label = &candidate[..label_end];
        let url = &candidate[url_start..url_start + url_end];
        out.push_str(label);
        out.push_str(" (");
        out.push_str(url);
        out.push(')');
        rest = &candidate[url_start + url_end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_plain_render_preserves_markdown_structure_citations_and_utf8() {
        let rendered = render_with(
            "# Cause\n\n- The worker exhausted its pool after retries.\n- Evidence: [worker log](cite://logs/7).\n\n| Fact | Value |\n|---|---|\n| Episodes | 56 |\n\n原因は接続枯渇です。",
            36,
            false,
        );
        assert!(rendered.contains("Cause\n─────"));
        assert!(rendered.contains("- Evidence: worker log"));
        assert!(rendered.contains("(cite://logs/7)"));
        assert!(rendered.contains("Fact  |  Value"));
        assert!(rendered.contains("原因は接続枯渇です。"));
        assert!(!rendered.contains('\u{1b}'));
        assert!(rendered.lines().all(|line| line.chars().count() <= 36));
    }

    #[test]
    fn ansi_is_presentation_only() {
        let plain = render_with("## Answer\n\nA result.", 80, false);
        let colored = render_with("## Answer\n\nA result.", 80, true)
            .replace(CYAN, "")
            .replace(BOLD, "")
            .replace(DIM, "")
            .replace(RESET, "");
        assert_eq!(plain, colored);
    }

    #[test]
    fn investigation_report_labels_provisional_answers_and_provenance() {
        let report = render_investigation_with(
            "What caused the service failures?",
            "# Observations\n\n- The service became unavailable.\n- Requests failed afterward.\n\n## Missing evidence\n\n- Service-side logs.",
            InvestigationRenderOptions {
                model: "example-chat-model",
                elapsed_ms: 85_800,
                typed_envelope: false,
                grounding: "grounded",
                width: 72,
                ansi: false,
            },
        );
        assert!(report.contains("Question: What caused the service failures?"));
        assert!(report.contains("Analyst: example-chat-model"));
        assert!(report.contains("PROVISIONAL"));
        assert!(report.contains("Grounding: grounded"));
        assert!(report.contains("Observations"));
        assert!(report.contains("Missing evidence"));
        assert!(!report.contains('\u{1b}'));
        assert!(report.lines().all(|line| line.chars().count() <= 72));
    }

    #[test]
    fn investigation_report_marks_typed_answer_validated() {
        let report = render_investigation_with(
            "Question",
            "Answer",
            InvestigationRenderOptions {
                model: "model",
                elapsed_ms: 42,
                typed_envelope: true,
                grounding: "grounded",
                width: 60,
                ansi: false,
            },
        );
        assert!(report.contains("HOST-VALIDATED"));
        assert!(!report.contains("PROVISIONAL"));
        assert!(report.contains("42 ms"));
    }

    #[test]
    fn investigation_report_wraps_opaque_identifiers_without_overflow() {
        let report = render_investigation_with(
            "Question",
            "Answer",
            InvestigationRenderOptions {
                model: "model-with-an-opaque-identifier-that-is-longer-than-the-box",
                elapsed_ms: 42,
                typed_envelope: false,
                grounding: "provisional",
                width: 48,
                ansi: false,
            },
        );
        assert!(report.lines().all(|line| line.chars().count() <= 48));
    }
}
