/**
 * Lightweight streaming-safe markdown renderer (no external deps).
 * While streaming, text accumulates into larger phrases before a beam-in.
 * Prefer-reduced-motion disables motion.
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  text: string;
  streaming?: boolean;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(src: string): string {
  let s = escapeHtml(src);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(
    /\[([^\]]+)\]\(#cite:([^)]+)\)/g,
    '<button type="button" class="citation-chip" data-cite="$2">$1</button>',
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return s;
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "pre"; lang: string; text: string; open: boolean }
  | { kind: "ul"; items: string[] }
  | { kind: "h"; level: 1 | 2 | 3; text: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
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
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i])
    ) {
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
  // Sentence / paragraph boundary once we have a readable phrase.
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

function BlocksView({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, idx) => {
        if (b.kind === "pre") {
          return (
            <pre
              key={`pre-${idx}-${b.lang}`}
              className="md-pre md-block-enter"
              data-open={b.open ? "true" : "false"}
              data-lang={b.lang || undefined}
            >
              <code
                dangerouslySetInnerHTML={{ __html: escapeHtml(b.text) }}
              />
            </pre>
          );
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

export function MarkdownBody({ text, streaming }: Props) {
  const { settled, buffer } = useBeamChunks(text, Boolean(streaming));
  const blocks = parseBlocks(text);

  if (streaming) {
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
    <div className="md-body" data-streaming="false">
      <BlocksView blocks={blocks} />
    </div>
  );
}
