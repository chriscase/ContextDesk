//! Passive, bounded HTML report reader. This deliberately accepts less than a browser:
//! explicit balanced containers and positive evidence of diagnostic record boundaries.
//! Byte ranges always refer to the unmodified original, not the decoded text.
use super::format_profile::{fingerprint_format, FormatFingerprintOutcome};
use html5gum::{DefaultEmitter, Token, Tokenizer};
use std::str;

pub(crate) const MAX_HTML_BYTES: usize = 256 * 1024;
const MAX_DEPTH: usize = 48;
const MAX_TOKENS: usize = 8192;
const MAX_RECORDS: usize = 1024;
const MAX_LINE: usize = 8192;
const MAX_VISIBLE: usize = 8192;

#[derive(Debug, PartialEq)]
pub(crate) struct HtmlRecord {
    pub(crate) text: String,
    pub(crate) source_start: usize,
    pub(crate) source_end: usize,
}
#[derive(Debug, PartialEq)]
pub(crate) enum HtmlDiagnostic {
    NotHtml,
    Document {
        visible_text: String,
        visible_truncated: bool,
        reason: &'static str,
    },
    Records {
        records: Vec<HtmlRecord>,
        container_kind: &'static str,
    },
}
/// Content signature only. Do not rely on a filename to select this reader.
pub(crate) fn has_html_signature(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let head = &bytes[..bytes.len().min(2048)];
    let mut head = head;
    loop {
        head = &head[head
            .iter()
            .position(|b| !b.is_ascii_whitespace())
            .unwrap_or(head.len())..];
        if let Some(comment) = head.strip_prefix(b"<!--") {
            let Some(end) = comment.windows(3).position(|w| w == b"-->") else {
                return false;
            };
            head = &comment[end + 3..];
        } else {
            break;
        }
    }
    [
        b"<!doctype html".as_slice(),
        b"<html",
        b"<head",
        b"<body",
        b"<pre",
        b"<table",
        b"<div",
        b"<article",
        b"<main",
        b"<section",
        b"<script",
        b"<style",
        b"<p",
    ]
    .iter()
    .any(|p| {
        head.get(..p.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(p))
            && head
                .get(p.len())
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>')
    })
}
fn hidden(s: &str) -> bool {
    matches!(
        s,
        "head"
            | "script"
            | "style"
            | "nav"
            | "header"
            | "footer"
            | "aside"
            | "form"
            | "template"
            | "noscript"
            | "svg"
            | "math"
            | "iframe"
            | "object"
            | "canvas"
            | "textarea"
            | "xmp"
            | "plaintext"
            | "noembed"
            | "noframes"
            | "select"
            | "button"
            | "details"
            | "dialog"
    )
}
fn void(s: &str) -> bool {
    matches!(
        s,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}
fn level(s: &str) -> bool {
    [
        "TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "WARNING", "ERROR", "FATAL", "CRITICAL",
    ]
    .iter()
    .any(|v| s.eq_ignore_ascii_case(v))
}
fn plausible(s: &str) -> bool {
    matches!(
        fingerprint_format(s, None).outcome,
        FormatFingerprintOutcome::Matched
    ) || s
        .split_once(char::is_whitespace)
        .is_some_and(|(first, rest)| {
            level(first.trim_matches(['[', ']', ':'])) && !rest.trim().is_empty()
        })
}
fn append_visible(dst: &mut String, truncated: &mut bool, text: &str) {
    if *truncated {
        return;
    }
    let mut n = (MAX_VISIBLE - dst.len()).min(text.len());
    while !text.is_char_boundary(n) {
        n -= 1;
    }
    dst.push_str(text.get(..n).unwrap_or_default());
    *truncated |= n < text.len();
}
// Tokenize each raw source line separately. Encoded newlines or markup cannot
// create extra records; reject such containers rather than invent byte offsets.
fn pre_records(raw: &str, base: usize, out: &mut Vec<HtmlRecord>) -> bool {
    let mut offset = 0usize;
    for line in raw.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        if !body.trim().is_empty() {
            if body.len() > MAX_LINE
                || body.contains('<')
                || body.contains('\r')
                || out.len() >= MAX_RECORDS
            {
                return false;
            }
            let mut decoded = String::new();
            for token in Tokenizer::new(body).flatten() {
                match token {
                    Token::String(x) => {
                        let Ok(s) = str::from_utf8(&x.value) else {
                            return false;
                        };
                        decoded.push_str(s);
                    }
                    _ => return false,
                }
            }
            let text = decoded.trim();
            if text.is_empty() || decoded.contains(['\n', '\r']) || !plausible(text) {
                return false;
            }
            out.push(HtmlRecord {
                text: text.to_owned(),
                source_start: base + offset,
                source_end: base + offset + body.len(),
            });
        }
        offset += line.len();
    }
    !out.is_empty()
}
#[derive(Default)]
struct Row {
    start: usize,
    cells: Vec<(bool, String)>,
}
#[derive(Default)]
struct Table {
    header: Vec<String>,
    row: Option<Row>,
    cell: Option<(bool, String)>,
}
fn finish_row(t: &mut Table, end: usize, out: &mut Vec<HtmlRecord>) -> bool {
    let Some(row) = t.row.take() else {
        return false;
    };
    let cols: Vec<_> = row
        .cells
        .iter()
        .map(|(_, s)| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    let names: Vec<_> = cols.iter().map(|x| x.to_ascii_lowercase()).collect();
    if t.header.is_empty() {
        if !(2..=3).contains(&cols.len()) || !row.cells.iter().all(|(header, _)| *header) {
            return false;
        }
        let mut mapped = Vec::new();
        for name in names {
            let key = match name.as_str() {
                "time" | "timestamp" | "datetime" => "time",
                "level" | "severity" => "level",
                "message" | "msg" => "message",
                _ => return false,
            };
            if mapped.contains(&key.to_owned()) {
                return false;
            }
            mapped.push(key.to_owned());
        }
        if !mapped.iter().any(|k| k == "message") {
            return false;
        }
        t.header = mapped;
        return true;
    }
    if row.cells.iter().all(|(h, _)| *h) {
        let mut repeated = Table {
            row: Some(row),
            ..Default::default()
        };
        return finish_row(&mut repeated, end, out) && repeated.header == t.header;
    }
    if row.cells.iter().any(|(h, _)| *h) || cols.len() != t.header.len() || out.len() >= MAX_RECORDS
    {
        return false;
    }
    let field = |name: &str| {
        t.header
            .iter()
            .position(|k| k == name)
            .map(|i| cols[i].as_str())
            .unwrap_or("")
    };
    let (ts, sev, msg) = (field("time"), field("level"), field("message"));
    if msg.is_empty() || (!sev.is_empty() && !level(sev)) {
        return false;
    }
    let text = [ts, sev, msg]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if sev.is_empty()
        && (ts.is_empty()
            || !matches!(
                super::parse::parse_line(&text, None, 0).timestamp_provenance,
                super::parse::TimestampProvenance::ExplicitWallClock
                    | super::parse::TimestampProvenance::UnresolvedLocal
            ))
    {
        return false;
    }
    if text.len() > MAX_LINE {
        return false;
    }
    out.push(HtmlRecord {
        text,
        source_start: row.start,
        source_end: end,
    });
    true
}
pub(crate) fn detect_and_extract(bytes: &[u8]) -> HtmlDiagnostic {
    use HtmlDiagnostic::*;
    if !has_html_signature(bytes) {
        return NotHtml;
    }
    let doc = |visible_text: String, visible_truncated, reason| Document {
        visible_text,
        visible_truncated,
        reason,
    };
    if bytes.len() > MAX_HTML_BYTES {
        return doc(String::new(), true, "input_limit");
    }
    let Ok(raw) = str::from_utf8(bytes) else {
        return doc(String::new(), true, "invalid_utf8");
    };
    let mut emitter = DefaultEmitter::<usize>::new_with_span();
    emitter.naively_switch_states(true);
    let mut stack: Vec<(String, bool)> = Vec::new();
    let (mut visible, mut records) = (String::new(), Vec::new());
    let mut visible_truncated = false;
    let mut pre = None;
    let mut table: Option<Table> = None;
    let mut kind = None;
    let mut ambiguous = false;
    let mut stylesheet = false;
    for (idx, token) in Tokenizer::new_with_emitter(raw, emitter)
        .flatten()
        .enumerate()
    {
        if idx >= MAX_TOKENS {
            return doc(String::new(), true, "token_limit");
        }
        let suppressed = stack.last().is_some_and(|(_, s)| *s);
        match token {
            Token::StartTag(t) => {
                let Ok(tag) = str::from_utf8(&t.name) else {
                    return doc(String::new(), true, "invalid_markup");
                };
                if tag == "link"
                    && t.attributes.get(b"rel".as_slice()).is_some_and(|a| {
                        a.value
                            .split(u8::is_ascii_whitespace)
                            .any(|part| part.eq_ignore_ascii_case(b"stylesheet"))
                    })
                {
                    stylesheet = true;
                }
                let conceal = suppressed
                    || hidden(tag)
                    || t.attributes.contains_key(b"hidden".as_slice())
                    || t.attributes.contains_key(b"style".as_slice())
                    || t.attributes.contains_key(b"inert".as_slice())
                    || t.attributes
                        .get(b"aria-hidden".as_slice())
                        .is_some_and(|a| a.value.eq_ignore_ascii_case(b"true"));
                if pre.is_some() {
                    ambiguous = true;
                }
                if !suppressed && table.is_some() && conceal {
                    ambiguous = true;
                }
                if !conceal {
                    match tag {
                        "pre" | "table" => {
                            if kind.is_some() {
                                ambiguous = true;
                            }
                            kind = Some(if tag == "pre" {
                                "preformatted_lines"
                            } else {
                                "diagnostic_table_rows"
                            });
                            if tag == "pre" {
                                pre = Some(t.span.end)
                            } else {
                                table = Some(Table::default())
                            }
                        }
                        "tr" if table.is_some() => {
                            let tab = table.as_mut().unwrap();
                            if !stack.last().is_some_and(|(parent, _)| {
                                matches!(parent.as_str(), "table" | "thead" | "tbody" | "tfoot")
                            }) || tab.row.is_some()
                            {
                                ambiguous = true
                            }
                            tab.row = Some(Row {
                                start: t.span.start,
                                cells: Vec::new(),
                            });
                        }
                        "td" | "th" if table.is_some() => {
                            let tab = table.as_mut().unwrap();
                            if !stack.last().is_some_and(|(parent, _)| parent == "tr")
                                || tab.row.is_none()
                                || tab.cell.is_some()
                                || t.attributes.contains_key(b"rowspan".as_slice())
                                || t.attributes.contains_key(b"colspan".as_slice())
                            {
                                ambiguous = true
                            }
                            tab.cell = Some((tag == "th", String::new()));
                        }
                        "thead" | "tbody" | "tfoot" if table.is_some() => {}
                        _ if table.is_some() => ambiguous = true,
                        _ => {}
                    }
                    if matches!(
                        tag,
                        "p" | "div" | "pre" | "table" | "tr" | "br" | "h1" | "h2"
                    ) {
                        append_visible(&mut visible, &mut visible_truncated, "\n");
                    }
                }
                if !void(tag) {
                    if stack.len() >= MAX_DEPTH {
                        return doc(String::new(), true, "depth_limit");
                    }
                    if t.self_closing {
                        return doc(String::new(), true, "invalid_markup");
                    }
                    stack.push((tag.to_owned(), conceal));
                }
            }
            Token::EndTag(t) => {
                let Some((tag, conceal)) = stack.pop() else {
                    return doc(String::new(), true, "invalid_markup");
                };
                if tag.as_bytes() != *t.name {
                    return doc(String::new(), true, "invalid_markup");
                }
                if !conceal {
                    match tag.as_str() {
                        "pre" => {
                            if let Some(start) = pre.take() {
                                if !raw
                                    .get(start..t.span.start)
                                    .is_some_and(|s| pre_records(s, start, &mut records))
                                {
                                    ambiguous = true;
                                }
                            }
                        }
                        "td" | "th" if table.is_some() => {
                            let tab = table.as_mut().unwrap();
                            match (tab.row.as_mut(), tab.cell.take()) {
                                (Some(row), Some(cell)) if row.cells.len() < 3 => {
                                    row.cells.push(cell)
                                }
                                _ => ambiguous = true,
                            };
                            append_visible(&mut visible, &mut visible_truncated, " ");
                        }
                        "tr" if table.is_some() => {
                            if !finish_row(table.as_mut().unwrap(), t.span.end, &mut records) {
                                ambiguous = true;
                            }
                        }
                        "table" => {
                            table = None;
                        }
                        _ => {}
                    }
                }
            }
            Token::String(s) if stack.last().is_some_and(|(name, _)| name == "style") => {
                // No CSS engine, browser or asset loading. Unknown visibility cannot
                // establish a record or authorize a "visible text" projection.
                if !s.value.iter().all(u8::is_ascii_whitespace) {
                    stylesheet = true;
                }
            }
            Token::String(s) if !suppressed => {
                let Ok(text) = str::from_utf8(&s.value) else {
                    return doc(String::new(), true, "invalid_utf8");
                };
                append_visible(&mut visible, &mut visible_truncated, text);
                if let Some(tab) = table.as_mut() {
                    if let Some((_, cell)) = tab.cell.as_mut() {
                        if cell.len() + text.len() > MAX_LINE {
                            ambiguous = true;
                        } else {
                            cell.push_str(text)
                        }
                    } else if !text.trim().is_empty() {
                        ambiguous = true
                    }
                }
            }
            Token::Error(_) => return doc(String::new(), true, "invalid_markup"),
            _ => {}
        }
    }
    if stylesheet {
        return doc(String::new(), true, "visibility_unverified_stylesheet");
    }
    if !stack.is_empty() {
        return doc(String::new(), true, "invalid_markup");
    }
    if let Some(container_kind) = kind {
        if !ambiguous && !records.is_empty() {
            return Records {
                records,
                container_kind,
            };
        }
    }
    doc(
        visible.trim().to_owned(),
        visible_truncated,
        "no_confident_records",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn records(raw: &str) -> (Vec<HtmlRecord>, &'static str) {
        match detect_and_extract(raw.as_bytes()) {
            HtmlDiagnostic::Records {
                records,
                container_kind,
            } => (records, container_kind),
            result => panic!("unexpected classification: {result:?}"),
        }
    }
    #[test]
    fn pre_decodes_entities_and_retains_exact_utf8_source_ranges() {
        let raw="<!DOCTYPE html><html><head><title>ignored</title></head><body><nav>chrome</nav><pre>\r\nINFO α &amp; β\r\nERROR second\r\n</pre></body></html>";
        let (rows, k) = records(raw);
        assert_eq!(k, "preformatted_lines");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "INFO α & β");
        assert_eq!(
            raw.get(rows[0].source_start..rows[0].source_end)
                .expect("valid source span"),
            "INFO α &amp; β"
        );
        assert_eq!(
            raw.get(rows[1].source_start..rows[1].source_end)
                .expect("valid source span"),
            "ERROR second"
        );
    }
    #[test]
    fn table_binds_headers_by_role_and_ignores_repeated_headers() {
        let h = "<tr><th>Message</th><th>Severity</th><th>Time</th></tr>";
        let first = "<tr><td>part &amp; status</td><td>WARN</td><td>2025-01-12 12:30:00</td></tr>";
        let raw =
            format!("<table>{h}{first}{h}<tr><td>offline</td><td>INFO</td><td></td></tr></table>");
        let (rows, k) = records(&raw);
        assert_eq!(k, "diagnostic_table_rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            raw.get(rows[0].source_start..rows[0].source_end)
                .expect("valid source span"),
            first
        );
        assert_eq!(rows[0].text, "2025-01-12 12:30:00 WARN part & status");
        assert_eq!(rows[1].text, "INFO offline");
    }
    #[test]
    fn supporting_text_excludes_inactive_subtrees_and_never_returns_html() {
        let raw="<html><head><title>secret1</title></head><body><script>const x='<pre>INFO secret2</pre>';</script><nav>secret3</nav><div hidden>secret4</div><p>Readable &amp; plain</p><pre>not a log</pre></body></html>";
        let HtmlDiagnostic::Document { visible_text, .. } = detect_and_extract(raw.as_bytes())
        else {
            panic!("expected document")
        };
        assert!(visible_text.contains("Readable & plain"));
        assert!(!visible_text.contains("secret"));
        assert!(!visible_text.contains("<pre>"));
    }
    #[test]
    fn ordinary_schedule_table_is_not_a_diagnostic_stream() {
        for time in ["", "Tomorrow"] {
            let raw=format!("<table><tr><th>Time</th><th>Message</th></tr><tr><td>{time}</td><td>Bring the report</td></tr></table>");
            assert!(matches!(
                detect_and_extract(raw.as_bytes()),
                HtmlDiagnostic::Document { .. }
            ));
        }
    }
    #[test]
    fn stylesheet_can_hide_any_container_and_is_never_evaluated() {
        for css in [
            "<style>pre{display:none}</style>",
            "<link rel='alternate StyleSheet' href='never-fetched.css'>",
        ] {
            let raw=format!("<html><head>{css}</head><body><pre>ERROR hidden historical sample</pre></body></html>");
            assert!(
                matches!(detect_and_extract(raw.as_bytes()), HtmlDiagnostic::Document{visible_text,reason:"visibility_unverified_stylesheet",..} if visible_text.is_empty())
            );
        }
    }
    #[test]
    fn visible_document_truncation_is_explicit_and_unicode_safe() {
        let raw = format!(
            "<!-- short prologue --><html><body><p>{}</p></body></html>",
            "λ".repeat(MAX_VISIBLE)
        );
        let HtmlDiagnostic::Document {
            visible_text,
            visible_truncated,
            ..
        } = detect_and_extract(raw.as_bytes())
        else {
            panic!("expected supporting document")
        };
        assert!(visible_truncated);
        assert!(visible_text.len() <= MAX_VISIBLE);
        assert!(visible_text.chars().all(|c| c == 'λ'));
    }
    #[test]
    fn ambiguous_malformed_limit_and_misleading_file_inputs_fail_closed() {
        for s in [
            "<pre>INFO ok\ncontinuation without a boundary</pre>",
            "<table><tr><td>INFO accidental</td></tr></table>",
            "<pre>INFO first</pre><pre>DEBUG second</pre>",
            "<pre>INFO first&#10;ERROR injected</pre>",
            "<pre>INFO unterminated",
        ] {
            assert!(
                matches!(
                    detect_and_extract(s.as_bytes()),
                    HtmlDiagnostic::Document { .. }
                ),
                "{s}"
            );
        }
        assert!(matches!(
            detect_and_extract(b"INFO ordinary log contents"),
            HtmlDiagnostic::NotHtml
        ));
        let oversized = format!("<pre>{}</pre>", "x".repeat(MAX_HTML_BYTES));
        assert!(matches!(
            detect_and_extract(oversized.as_bytes()),
            HtmlDiagnostic::Document {
                reason: "input_limit",
                ..
            }
        ));
        let deep = format!(
            "<html>{}INFO x{}</html>",
            "<div>".repeat(60),
            "</div>".repeat(60)
        );
        assert!(matches!(
            detect_and_extract(deep.as_bytes()),
            HtmlDiagnostic::Document {
                reason: "depth_limit",
                ..
            }
        ));
    }
}
