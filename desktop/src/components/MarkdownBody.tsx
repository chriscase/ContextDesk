/**
 * Lightweight streaming-safe markdown renderer (no external deps).
 * Handles incomplete fences while tokens stream; escapes HTML.
 */

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
  // code spans first
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // citation-style chips written as [^path] or bare [label](#cite:id)
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
    // fenced code
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
    // heading
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
    // list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // blank
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // paragraph (merge consecutive)
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

export function MarkdownBody({ text, streaming }: Props) {
  const blocks = parseBlocks(text);
  return (
    <div
      className="md-body"
      data-streaming={streaming ? "true" : "false"}
      data-materialize={streaming ? "true" : "false"}
    >
      {blocks.map((b, idx) => {
        if (b.kind === "pre") {
          return (
            <pre
              key={idx}
              className="md-pre"
              data-open={b.open ? "true" : "false"}
              data-lang={b.lang || undefined}
            >
              <code
                dangerouslySetInnerHTML={{
                  __html: escapeHtml(b.text) + (b.open && streaming ? "\n…" : ""),
                }}
              />
            </pre>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul key={idx} className="md-ul">
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
          const Tag = (`h${b.level}` as "h1" | "h2" | "h3");
          return (
            <Tag
              key={idx}
              className="md-h"
              dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
            />
          );
        }
        return (
          <p
            key={idx}
            className="md-p"
            dangerouslySetInnerHTML={{ __html: renderInline(b.text) }}
          />
        );
      })}
    </div>
  );
}
