import { Fragment, type KeyboardEvent, type ReactNode } from "react";

export type HandbookHeading = {
  id: string;
  level: 1 | 2 | 3 | 4;
  title: string;
};

type Props = {
  body: string;
  headings: HandbookHeading[];
  onNavigate: (target: string) => void;
};

type MermaidSummary = {
  nodes: string[];
  relations: string[];
};

const INLINE_PATTERN =
  /(\[[^\]\n]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

function plainInlineText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .trim();
}

function inlineNodes(
  value: string,
  onNavigate: Props["onNavigate"],
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(value.slice(cursor, index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

    if (link) {
      const target = link[2];
      nodes.push(
        <button
          className="handbook-inline-link"
          key={key}
          type="button"
          onClick={() => onNavigate(target)}
          title={target}
        >
          {link[1]}
          <span aria-hidden>↗</span>
        </button>,
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = index + token.length;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function mermaidLabel(value: string): string {
  return value
    .replace(/^[A-Za-z0-9_-]+\s*(?:\[|\(|\{)+/, "")
    .replace(/(?:\]|\)|\})+$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function summarizeMermaid(source: string): MermaidSummary {
  const nodes = new Set<string>();
  const relations: string[] = [];
  const aliases = new Map<string, string>();
  const nodePattern =
    /([A-Za-z][\w-]*(?:\s*(?:\[[^\]]+\]|\([^)]*\)|\{[^}]*\}))?)/g;
  const nodeDisplay = (value: string): string => {
    const token = value.match(nodePattern)?.at(-1)?.trim() ?? value.trim();
    const parsed = token.match(
      /^([A-Za-z][\w-]*)\s*(?:\[([^\]]+)\]|\(([^)]*)\)|\{([^}]*)\})?$/,
    );
    if (!parsed) return mermaidLabel(token);
    const id = parsed[1];
    const declaredLabel = parsed[2] ?? parsed[3] ?? parsed[4];
    if (declaredLabel) aliases.set(id, mermaidLabel(declaredLabel));
    return aliases.get(id) ?? id;
  };

  for (const sourceLine of source.split("\n")) {
    const line = sourceLine.trim();
    if (
      !line ||
      /^(?:flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|%%)\b/i.test(
        line,
      )
    ) {
      continue;
    }

    const relation = line.match(
      /^(.+?)\s*(-->|---|==>|-.->|--\s*[^-]+?\s*-->)\s*(.+)$/,
    );
    if (relation) {
      const from = nodeDisplay(relation[1]);
      const to = nodeDisplay(relation[3]);
      if (from) nodes.add(from);
      if (to) nodes.add(to);
      if (from && to) relations.push(`${from} leads to ${to}`);
      continue;
    }

    const sequence = line.match(/^([^:]+?)(?:--?>>?|->>?)\s*([^:]+):\s*(.+)$/);
    if (sequence) {
      const from = sequence[1].trim();
      const to = sequence[2].trim();
      nodes.add(from);
      nodes.add(to);
      relations.push(`${from} sends “${sequence[3].trim()}” to ${to}`);
      continue;
    }

    const declaration = line.match(
      /^(?:participant|actor|state|class)\s+(.+?)(?:\s+as\s+(.+))?$/,
    );
    if (declaration) {
      const id = declaration[1].trim();
      const label = (declaration[2] ?? id).trim();
      aliases.set(id, label);
      nodes.add(label);
    }
  }

  return {
    nodes: [...nodes].slice(0, 8),
    relations: relations.slice(0, 8),
  };
}

function MermaidDiagram({ source, index }: { source: string; index: number }) {
  const summary = summarizeMermaid(source);
  const description =
    summary.relations.length > 0
      ? summary.relations.join(". ")
      : summary.nodes.length > 0
        ? `Diagram elements: ${summary.nodes.join(", ")}.`
        : "The source describes a Mermaid diagram; expand the source for its complete text.";

  return (
    <figure
      className="handbook-diagram"
      aria-labelledby={`handbook-diagram-${index}-title`}
      aria-describedby={`handbook-diagram-${index}-summary`}
    >
      <figcaption>
        <span className="handbook-diagram__mark" aria-hidden>
          ◇
        </span>
        <span>
          <strong id={`handbook-diagram-${index}-title`}>
            Architecture diagram
          </strong>
          <small>Readable representation of the bundled Mermaid source</small>
        </span>
      </figcaption>

      {summary.nodes.length > 0 ? (
        <div className="handbook-diagram__flow" aria-hidden>
          {summary.nodes.map((node, nodeIndex) => (
            <Fragment key={`${node}-${nodeIndex}`}>
              {nodeIndex > 0 ? (
                <span className="handbook-diagram__arrow">→</span>
              ) : null}
              <span className="handbook-diagram__node">{node}</span>
            </Fragment>
          ))}
        </div>
      ) : null}

      <p id={`handbook-diagram-${index}-summary`}>{description}</p>
      <details>
        <summary>Read diagram source</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}

function focusHeading(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const reader = target.closest<HTMLElement>(".handbook-reader");
  reader?.scrollTo?.({
    top: Math.max(0, target.offsetTop - 24),
    behavior: "smooth",
  });
  target.focus({ preventScroll: true });
}

export function HandbookMarkdown({ body, headings, onNavigate }: Props) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let lineIndex = 0;
  let blockIndex = 0;
  let headingIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    if (!line.trim()) {
      lineIndex += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      const language = fence[1].toLowerCase();
      const code: string[] = [];
      lineIndex += 1;
      while (lineIndex < lines.length && !/^```\s*$/.test(lines[lineIndex])) {
        code.push(lines[lineIndex]);
        lineIndex += 1;
      }
      if (lineIndex < lines.length) lineIndex += 1;
      const source = code.join("\n");
      blocks.push(
        language === "mermaid" ? (
          <MermaidDiagram
            key={`diagram-${blockIndex}`}
            source={source}
            index={blockIndex}
          />
        ) : (
          <div className="handbook-code" key={`code-${blockIndex}`}>
            <div>
              <span>{language || "text"}</span>
              <span>Read-only</span>
            </div>
            <pre>
              <code className={language ? `language-${language}` : undefined}>
                {source}
              </code>
            </pre>
          </div>
        ),
      );
      blockIndex += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4;
      const fallback = `section-${headingIndex + 1}`;
      const id = headings[headingIndex]?.id ?? fallback;
      const content = inlineNodes(
        heading[2].trim(),
        onNavigate,
        `heading-${blockIndex}`,
      );
      const common = {
        id,
        tabIndex: -1,
        "data-handbook-heading": true,
      };
      if (level === 1) {
        blocks.push(
          <h1 {...common} key={`heading-${blockIndex}`}>
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 {...common} key={`heading-${blockIndex}`}>
            {content}
          </h2>,
        );
      } else if (level === 3) {
        blocks.push(
          <h3 {...common} key={`heading-${blockIndex}`}>
            {content}
          </h3>,
        );
      } else {
        blocks.push(
          <h4 {...common} key={`heading-${blockIndex}`}>
            {content}
          </h4>,
        );
      }
      headingIndex += 1;
      blockIndex += 1;
      lineIndex += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[lineIndex + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      lineIndex += 2;
      while (
        lineIndex < lines.length &&
        lines[lineIndex].trim() &&
        lines[lineIndex].includes("|")
      ) {
        rows.push(tableCells(lines[lineIndex]));
        lineIndex += 1;
      }
      blocks.push(
        <div className="handbook-table" key={`table-${blockIndex}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th scope="col" key={`header-${cellIndex}`}>
                    {inlineNodes(
                      cell,
                      onNavigate,
                      `header-${blockIndex}-${cellIndex}`,
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${cellIndex}`}>
                      {inlineNodes(
                        row[cellIndex] ?? "",
                        onNavigate,
                        `cell-${blockIndex}-${rowIndex}-${cellIndex}`,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      blockIndex += 1;
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const pattern = isOrdered ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      const items: string[] = [];
      while (lineIndex < lines.length) {
        const item = lines[lineIndex].match(pattern);
        if (!item) break;
        items.push(item[1].trim());
        lineIndex += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`item-${itemIndex}`}>
          {inlineNodes(item, onNavigate, `item-${blockIndex}-${itemIndex}`)}
        </li>
      ));
      blocks.push(
        isOrdered ? (
          <ol key={`list-${blockIndex}`}>{children}</ol>
        ) : (
          <ul key={`list-${blockIndex}`}>{children}</ul>
        ),
      );
      blockIndex += 1;
      continue;
    }

    const paragraph = [line.trim()];
    lineIndex += 1;
    while (
      lineIndex < lines.length &&
      lines[lineIndex].trim() &&
      !/^```/.test(lines[lineIndex]) &&
      !/^#{1,4}\s+/.test(lines[lineIndex]) &&
      !/^[-*+]\s+/.test(lines[lineIndex]) &&
      !/^\d+[.)]\s+/.test(lines[lineIndex]) &&
      !(
        lines[lineIndex].includes("|") &&
        isTableSeparator(lines[lineIndex + 1] ?? "")
      )
    ) {
      paragraph.push(lines[lineIndex].trim());
      lineIndex += 1;
    }
    blocks.push(
      <p key={`paragraph-${blockIndex}`}>
        {inlineNodes(
          paragraph.join(" "),
          onNavigate,
          `paragraph-${blockIndex}`,
        )}
      </p>,
    );
    blockIndex += 1;
  }

  return <>{blocks}</>;
}

export function collectHandbookHeadings(body: string): HandbookHeading[] {
  const used = new Map<string, number>();
  let fenced = false;
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .reduce<HandbookHeading[]>((entries, line) => {
      if (/^```/.test(line)) {
        fenced = !fenced;
        return entries;
      }
      if (fenced) return entries;
      const match = line.match(/^(#{1,4})\s+(.+)$/);
      if (!match) return entries;
      const title = plainInlineText(match[2]);
      const base =
        title
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-") || "section";
      const occurrence = used.get(base) ?? 0;
      used.set(base, occurrence + 1);
      entries.push({
        id: occurrence === 0 ? base : `${base}-${occurrence + 1}`,
        level: match[1].length as 1 | 2 | 3 | 4,
        title,
      });
      return entries;
    }, []);
}

export function HandbookTableOfContents({
  headings,
  activeHeadingId,
  onActivate,
}: {
  headings: HandbookHeading[];
  activeHeadingId?: string | null;
  onActivate?: (headingId: string) => void;
}) {
  const visible = headings.filter((heading) => heading.level > 1);
  if (visible.length === 0) {
    return <p className="handbook-toc__empty">This chapter has no sections.</p>;
  }

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visible.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, visible.length - 1)
            : Math.max(index - 1, 0);
    const container = event.currentTarget.closest("ol");
    container?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <ol>
      {visible.map((heading, index) => (
        <li
          key={heading.id}
          data-level={heading.level}
          data-active={activeHeadingId === heading.id}
        >
          <button
            type="button"
            aria-current={
              activeHeadingId === heading.id ? "location" : undefined
            }
            onClick={() => {
              onActivate?.(heading.id);
              focusHeading(heading.id);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {heading.title}
          </button>
        </li>
      ))}
    </ol>
  );
}

export const __handbookMarkdownTest = {
  isTableSeparator,
  summarizeMermaid,
};
