/**
 * Lightweight streaming-safe markdown renderer (no external deps).
 * While streaming, text accumulates into larger phrases before a beam-in.
 * Prefer-reduced-motion disables motion.
 * GFM tables render as real HTML tables once header + separator are present.
 */

import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  text: string;
  streaming?: boolean;
};

type Align = "left" | "center" | "right";

type Block =
  | { kind: "p"; text: string }
  | { kind: "pre"; lang: string; text: string; open: boolean }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | {
      kind: "table";
      headers: string[];
      aligns: Align[];
      rows: string[][];
      /** True while still receiving more rows (streaming). */
      open?: boolean;
    };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortHostFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("news.google.")) return "Google News";
    if (host.includes("duckduckgo.com")) return "DuckDuckGo";
    if (host.endsWith("wikipedia.org")) return "Wikipedia";
    return host;
  } catch {
    return "link";
  }
}

function renderInline(src: string): string {
  let s = escapeHtml(src);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(
    /\[([^\]]+)\]\(#cite:([^)]+)\)/g,
    '<button type="button" class="citation-chip" data-cite="$2"><span class="citation-chip__name">$1</span></button>',
  );
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, text, href) => {
    const label = String(text).trim() || shortHostFromUrl(String(href));
    return `<a class="md-ext-link" href="${href}" target="_blank" rel="noreferrer noopener" title="${href}">${label}</a>`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_m, pre, href) => {
    const host = shortHostFromUrl(String(href));
    return `${pre}<a class="md-ext-link" href="${href}" target="_blank" rel="noreferrer noopener" title="${href}">${host}</a>`;
  });
  return s;
}

/** GFM table row: has pipes and is not a fence. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith("```")) return false;
  // Must have at least one pipe and non-separator content somewhere
  if (!t.includes("|")) return false;
  return true;
}

/** Separator like | --- | :---: | ---: | */
function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  // Strip outer pipes
  let inner = t;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function parseAlign(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function parseTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  if (i >= lines.length) return false;
  if (!isTableRow(lines[i]) || isTableSep(lines[i])) return false;
  // Need a separator on the next non-empty line (allow streaming gap)
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") j += 1;
  if (j >= lines.length) return false;
  return isTableSep(lines[j]);
}

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].startsWith("```")) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "pre", lang, text: body.join("\n"), open: !closed });
      continue;
    }

    // GFM table: header + separator + rows
    if (isTableStart(lines, i)) {
      const headers = parseTableRow(lines[i]);
      i += 1;
      while (i < lines.length && lines[i].trim() === "") i += 1;
      const aligns = isTableSep(lines[i] ?? "")
        ? parseTableRow(lines[i]).map(parseAlign)
        : headers.map(() => "left" as Align);
      if (isTableSep(lines[i] ?? "")) i += 1;

      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i];
        if (rowLine.trim() === "") {
          // Blank line ends table
          break;
        }
        if (!isTableRow(rowLine) || isTableSep(rowLine)) break;
        if (rowLine.startsWith("```") || /^#{1,3}\s+/.test(rowLine)) break;
        if (/^[-*]\s+/.test(rowLine) && !rowLine.includes("|")) break;
        if (/^\d+[.)]\s+/.test(rowLine) && !rowLine.includes("|")) break;
        if (/^>\s?/.test(rowLine)) break;
        const cells = parseTableRow(rowLine);
        // Pad / trim to header width
        const normalized = headers.map((_, ci) => cells[ci] ?? "");
        rows.push(normalized);
        i += 1;
      }
      // Pad aligns to header length
      while (aligns.length < headers.length) aligns.push("left");
      const open =
        i >= lines.length &&
        lines.length > 0 &&
        isTableRow(lines[lines.length - 1] ?? "");
      blocks.push({
        kind: "table",
        headers,
        aligns: aligns.slice(0, headers.length),
        rows,
        open: open || undefined,
      });
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      blocks.push({
        kind: "h",
        level: h[1].length as 1 | 2 | 3,
        text: h[2],
      });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list: 1. / 1)
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Blockquote: consecutive lines starting with >
    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", text: parts.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph — stop before tables, fences, lists, quotes, headings
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      // Lone table-looking line without a following separator: keep as prose
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }
  return blocks;
}

type BeamChunk = { id: number; text: string };

const MIN_BEAM_CHARS = 52;
const MIN_BOUNDARY_CHARS = 28;
const MAX_BUFFER_MS = 220;
const HARD_MAX_CHARS = 120;

function shouldFlushBuffer(buf: string, force: boolean): boolean {
  if (!buf) return false;
  if (force) return true;
  if (buf.length >= HARD_MAX_CHARS) return true;
  if (buf.length >= MIN_BEAM_CHARS) return true;
  if (buf.length >= MIN_BOUNDARY_CHARS) {
    if (/[.!?]["')\]]?\s*$/.test(buf)) return true;
    if (/\n\n/.test(buf)) return true;
    if (/[:;]\s+$/.test(buf) && buf.length >= 40) return true;
  }
  return false;
}

/**
 * Accumulate streaming text into larger phrases, then beam them in once.
 * Unflushed buffer is shown muted (no animation) until the phrase is ready.
 */
function useBeamChunks(
  text: string,
  streaming: boolean,
): { settled: BeamChunk[]; buffer: string } {
  const [settled, setSettled] = useState<BeamChunk[]>([]);
  const [buffer, setBuffer] = useState("");
  const settledRef = useRef<BeamChunk[]>([]);
  const committedLen = useRef(0);
  const bufferRef = useRef("");
  const nextId = useRef(0);
  const timerRef = useRef<number | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = (force: boolean) => {
    const buf = bufferRef.current;
    if (!shouldFlushBuffer(buf, force)) return;
    bufferRef.current = "";
    clearTimer();
    const chunk = { id: nextId.current++, text: buf };
    settledRef.current = [...settledRef.current, chunk];
    committedLen.current += buf.length;
    setSettled(settledRef.current);
    setBuffer("");
  };

  const scheduleFlush = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      flush(true);
    }, MAX_BUFFER_MS);
  };

  useEffect(() => {
    return () => clearTimer();
  }, []);

  useEffect(() => {
    if (text.length < committedLen.current) {
      clearTimer();
      settledRef.current = [];
      committedLen.current = 0;
      bufferRef.current = "";
      setSettled([]);
      setBuffer("");
    }

    if (!streaming) {
      clearTimer();
      const rest = text.slice(committedLen.current);
      if (rest) {
        bufferRef.current = rest;
        flush(true);
      }
      bufferRef.current = "";
      setBuffer("");
      return;
    }

    const fullPending = text.slice(committedLen.current);
    bufferRef.current = fullPending;
    setBuffer(fullPending);

    if (shouldFlushBuffer(fullPending, false)) {
      flush(false);
      const again = textRef.current.slice(committedLen.current);
      bufferRef.current = again;
      setBuffer(again);
      if (again) scheduleFlush();
    } else if (fullPending) {
      scheduleFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, streaming]);

  return { settled, buffer: streaming ? buffer : "" };
}

function TableView({
  block,
}: {
  block: Extract<Block, { kind: "table" }>;
}) {
  const colCount = Math.max(
    block.headers.length,
    ...block.rows.map((r) => r.length),
    1,
  );
  const headers = Array.from(
    { length: colCount },
    (_, i) => block.headers[i] ?? "",
  );
  const aligns = Array.from(
    { length: colCount },
    (_, i) => block.aligns[i] ?? "left",
  );

  return (
    <div
      className="md-table-wrap md-block-enter"
      data-open={block.open ? "true" : "false"}
    >
      <table className="md-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                style={{ textAlign: aligns[i] }}
                dangerouslySetInnerHTML={{ __html: renderInline(h) }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>
              {headers.map((_, ci) => (
                <td
                  key={ci}
                  style={{ textAlign: aligns[ci] }}
                  dangerouslySetInnerHTML={{
                    __html: renderInline(row[ci] ?? ""),
                  }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({
  lang,
  text,
  open,
}: {
  lang: string;
  text: string;
  open: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable offline / denied */
    }
  };
  return (
    <div
      className="md-pre-wrap md-block-enter"
      data-open={open ? "true" : "false"}
    >
      <div className="md-pre-toolbar">
        <span className="md-pre-lang">{lang || "code"}</span>
        <button
          type="button"
          className="md-pre-copy"
          onClick={() => void onCopy()}
          title="Copy code"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className="md-pre"
        data-open={open ? "true" : "false"}
        data-lang={lang || undefined}
      >
        <code dangerouslySetInnerHTML={{ __html: escapeHtml(text) }} />
      </pre>
    </div>
  );
}

function BlocksView({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, idx) => {
        if (b.kind === "pre") {
          return (
            <CodeBlock
              key={`pre-${idx}-${b.lang}`}
              lang={b.lang}
              text={b.text}
              open={b.open}
            />
          );
        }
        if (b.kind === "table") {
          return <TableView key={`table-${idx}`} block={b} />;
        }
        if (b.kind === "ul") {
          return (
            <ul key={`ul-${idx}`} className="md-ul md-block-enter">
              {b.items.map((it, j) => (
                <li
                  key={j}
                  dangerouslySetInnerHTML={{ __html: renderInline(it) }}
                />
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={`ol-${idx}`} className="md-ol md-block-enter">
              {b.items.map((it, j) => (
                <li
                  key={j}
                  dangerouslySetInnerHTML={{ __html: renderInline(it) }}
                />
              ))}
            </ol>
          );
        }
        if (b.kind === "blockquote") {
          return (
            <blockquote
              key={`bq-${idx}`}
              className="md-blockquote md-block-enter"
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        if (b.kind === "h") {
          const Tag = `h${b.level}` as "h1" | "h2" | "h3";
          return (
            <Tag
              key={`h-${idx}`}
              className="md-h md-block-enter"
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        return (
          <p
            key={`p-${idx}`}
            className="md-p md-block-enter"
            dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
          />
        );
      })}
    </>
  );
}

/** Prefer structured blocks when tables/code fences need real layout. */
function needsStructuredRender(blocks: Block[]): boolean {
  return blocks.some(
    (b) =>
      b.kind === "table" ||
      b.kind === "pre" ||
      b.kind === "ul" ||
      b.kind === "ol" ||
      b.kind === "blockquote" ||
      b.kind === "h",
  );
}

export function MarkdownBody({ text, streaming }: Props) {
  const { settled, buffer } = useBeamChunks(text, Boolean(streaming));
  // Settled rows must not re-parse when a neighbor streams (#148).
  const blocks = useMemo(
    () => parseBlocks(text),
    // `streaming` included so open fences/tables re-evaluate on settle.
    [text, streaming],
  );
  const structured = needsStructuredRender(blocks);

  // Streaming prose: phrase beam-in. Tables / lists / headings / code: structured.
  if (streaming && !structured) {
    return (
      <div className="md-body md-body--streaming" data-streaming="true">
        <p className="md-p md-p--stream">
          {settled.map((c) => (
            <span key={c.id} className="md-beam-chunk">
              {c.text}
            </span>
          ))}
          {buffer ? (
            <span className="md-beam-buffer" aria-hidden={false}>
              {buffer}
            </span>
          ) : null}
          <span className="md-stream-caret" aria-hidden />
        </p>
      </div>
    );
  }

  return (
    <div
      className={
        streaming ? "md-body md-body--streaming md-body--blocks" : "md-body"
      }
      data-streaming={streaming ? "true" : "false"}
    >
      <BlocksView blocks={blocks} />
      {streaming ? <span className="md-stream-caret" aria-hidden /> : null}
    </div>
  );
}

/** Exported for unit-style checks in the browser console / tests. */
export const __mdTest = { parseBlocks, isTableSep, isTableRow, parseTableRow };
