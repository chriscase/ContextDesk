/**
 * Lightweight streaming-safe markdown renderer (no external deps).
 * While streaming, new text deltas materialize (beam-in); settled content
 * is full markdown. Prefer-reduced-motion disables motion.
 */

import { useRef } from "react";

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

/** Inline: `code`, **bold**, *italic*, [label](url) */
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

/**
 * Split growing text into stable + newly appended chunks so only fresh
 * deltas get a one-shot beam-in animation (Gemini-style materialize).
 */
function useBeamChunks(text: string, streaming: boolean): BeamChunk[] {
  const prev = useRef("");
  const chunks = useRef<BeamChunk[]>([]);
  const nextId = useRef(0);

  if (!streaming) {
    // Final frame: single settled chunk, no animation.
    if (chunks.current.length !== 1 || chunks.current[0]?.text !== text) {
      chunks.current = text ? [{ id: nextId.current++, text }] : [];
    }
    prev.current = text;
    return chunks.current;
  }

  if (!text.startsWith(prev.current)) {
    // Reset (new message / rewrite)
    chunks.current = text ? [{ id: nextId.current++, text }] : [];
  } else if (text.length > prev.current.length) {
    const added = text.slice(prev.current.length);
    // Merge tiny deltas into the last chunk if it's still "fresh" and small,
    // so we animate readable phrases rather than single characters only.
    const last = chunks.current[chunks.current.length - 1];
    const lastIsTiny = last && last.text.length < 12;
    if (lastIsTiny && chunks.current.length > 0) {
      chunks.current = [
        ...chunks.current.slice(0, -1),
        { id: last.id, text: last.text + added },
      ];
    } else {
      chunks.current = [...chunks.current, { id: nextId.current++, text: added }];
    }
  }
  prev.current = text;
  return chunks.current;
}

function BlocksView({ blocks, streaming }: { blocks: Block[]; streaming?: boolean }) {
  return (
    <>
      {blocks.map((b, idx) => {
        const isLast = idx === blocks.length - 1;
        const enter = !streaming || !isLast;
        if (b.kind === "pre") {
          return (
            <pre
              key={`pre-${idx}-${b.lang}`}
              className={`md-pre${enter ? " md-block-enter" : ""}`}
              data-open={b.open ? "true" : "false"}
              data-lang={b.lang || undefined}
            >
              <code
                dangerouslySetInnerHTML={{
                  __html:
                    escapeHtml(b.text) + (b.open && streaming ? "\n…" : ""),
                }}
              />
            </pre>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul
              key={`ul-${idx}`}
              className={`md-ul${enter ? " md-block-enter" : ""}`}
            >
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
              className={`md-h${enter ? " md-block-enter" : ""}`}
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        return (
          <p
            key={`p-${idx}`}
            className={`md-p${enter ? " md-block-enter" : ""}`}
            dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
          />
        );
      })}
    </>
  );
}

export function MarkdownBody({ text, streaming }: Props) {
  const chunks = useBeamChunks(text, Boolean(streaming));
  const blocks = parseBlocks(text);

  // While streaming: beam new deltas so the materialize is visible.
  // Settled markdown for completed structure still used when not streaming.
  if (streaming) {
    return (
      <div className="md-body md-body--streaming" data-streaming="true">
        <p className="md-p md-p--stream">
          {chunks.map((c, i) => {
            const isLatest = i === chunks.length - 1;
            return (
              <span
                key={c.id}
                className={isLatest ? "md-beam-chunk" : "md-beam-settled"}
              >
                {c.text}
              </span>
            );
          })}
          <span className="md-stream-caret" aria-hidden />
        </p>
      </div>
    );
  }

  return (
    <div className="md-body" data-streaming="false">
      <BlocksView blocks={blocks} streaming={false} />
    </div>
  );
}
