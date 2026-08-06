//! Human-terminal presentation shared by non-streaming CLI commands.
//!
//! Machine formats never pass through this module. Text is sanitized even
//! when redirected, while borders and color are added only for an actual
//! capable terminal so scripts retain stable plain output.

use crate::config::ColorMode;
use crate::render::{platform_supports_ansi, TerminalTextSanitizer};
use std::io::{self, IsTerminal};

const CYAN: &str = "\x1b[1;36m";
const GREEN: &str = "\x1b[1;32m";
const YELLOW: &str = "\x1b[1;33m";
const RED: &str = "\x1b[1;31m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

pub fn present(raw: &str, color_mode: ColorMode) -> String {
    let mut sanitizer = TerminalTextSanitizer::for_current_console();
    let clean = sanitizer.push(raw);
    let tty = io::stdout().is_terminal();
    if !tty || clean.trim().is_empty() || clean.starts_with('#') {
        return clean;
    }

    let no_color = std::env::var_os("NO_COLOR").is_some();
    let ansi = platform_supports_ansi()
        && match color_mode {
            ColorMode::Always => true,
            ColorMode::Never => false,
            ColorMode::Auto => !no_color,
        };
    decorate(&clean, ansi)
}

fn decorate(clean: &str, ansi: bool) -> String {
    let mut lines = clean.lines();
    let Some(title) = lines.next() else {
        return String::new();
    };
    let title_width = title.chars().count().clamp(8, 68);
    let border = format!("+{}+", "-".repeat(title_width + 2));
    let title_line = format!("| {:<title_width$} |", title);
    let title_color = if title.to_ascii_lowercase().contains("complete")
        || title.to_ascii_lowercase().contains("ready")
    {
        GREEN
    } else {
        CYAN
    };

    let mut out = String::new();
    push_styled(&mut out, &border, title_color, ansi);
    out.push('\n');
    push_styled(&mut out, &title_line, title_color, ansi);
    out.push('\n');
    push_styled(&mut out, &border, title_color, ansi);

    let rest: Vec<&str> = lines.collect();
    for (index, line) in rest.iter().enumerate() {
        out.push('\n');
        let trimmed = line.trim();
        let previous_blank = index == 0 || rest[index - 1].trim().is_empty();
        let next_blank = index + 1 >= rest.len() || rest[index + 1].trim().is_empty();
        let section = !trimmed.is_empty()
            && !line.starts_with(char::is_whitespace)
            && previous_blank
            && next_blank;
        if section {
            let section_line = format!("-- {trimmed} --");
            push_styled(&mut out, &section_line, CYAN, ansi);
        } else if contains_warning(trimmed) {
            push_styled(&mut out, line, YELLOW, ansi);
        } else if contains_error(trimmed) {
            push_styled(&mut out, line, RED, ansi);
        } else if line.starts_with("  ") && trimmed.contains("  ") {
            push_styled(&mut out, line, DIM, ansi);
        } else {
            out.push_str(line);
        }
    }
    out
}

fn push_styled(out: &mut String, text: &str, style: &str, ansi: bool) {
    if ansi {
        out.push_str(style);
    }
    out.push_str(text);
    if ansi {
        out.push_str(RESET);
    }
}

fn contains_warning(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("warning")
        || lower.contains("partial")
        || lower.contains("unresolved")
        || lower.contains("cancelled")
}

fn contains_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("error") || lower.contains("failed")
}

#[cfg(test)]
mod tests {
    use super::decorate;

    #[test]
    fn decorates_title_sections_and_warnings_with_ascii_only_when_plain() {
        let rendered = decorate(
            "Import complete\n\nSources\n\n  Selected     2\nWarning: partial",
            false,
        );
        assert!(rendered.starts_with("+-----------------+\n| Import complete |"));
        assert!(rendered.contains("-- Sources --"));
        assert!(!rendered.contains('\u{1b}'));
        assert!(rendered.is_ascii());
    }

    #[test]
    fn color_mode_wraps_but_never_changes_content() {
        let rendered = decorate("Search results\n\nMatches\n\n  Events  3", true);
        assert!(rendered.contains("\x1b[1;36m"));
        let stripped = rendered
            .replace("\x1b[1;36m", "")
            .replace("\x1b[2m", "")
            .replace("\x1b[0m", "");
        assert!(stripped.contains("| Search results |"));
        assert!(stripped.contains("-- Matches --"));
    }
}
