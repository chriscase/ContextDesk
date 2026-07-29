import {
  Fragment,
  type ReactNode,
  type RefObject,
  useState,
} from "react";
import type {
  HelpAssetRefDto,
  HelpTocEntryDto,
} from "../../lib/host";
import { parseHelpLocator } from "../../lib/help";

type Props = {
  body: string;
  toc: HelpTocEntryDto[];
  assets: HelpAssetRefDto[];
  assetUrls: Record<string, string>;
  onOpenHelp: (pageId: string, anchor?: string) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
};

const INLINE_TOKEN =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\(help:\/\/[^)\s]+\)|help:\/\/[a-z0-9-]+(?:#[a-z0-9-]+)?)/g;

function HelpCodeBlock({
  language,
  source,
}: {
  language: string;
  source: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_400);
    } catch {
      setCopyState("error");
    }
  };

  const languageLabel = language || "text";
  const result =
    copyState === "copied"
      ? `${languageLabel} block copied to clipboard`
      : copyState === "error"
        ? `Could not copy ${languageLabel} block`
        : "";

  return (
    <div className="help-code">
      <div className="help-code__toolbar">
        <span>{languageLabel}</span>
        <button
          type="button"
          aria-label={
            copyState === "copied"
              ? `Copied ${languageLabel} block`
              : copyState === "error"
                ? `Copy ${languageLabel} block failed; retry`
                : `Copy ${languageLabel} block`
          }
          onClick={() => void copy()}
        >
          {copyState === "copied"
            ? "Copied"
            : copyState === "error"
              ? "Copy failed"
              : "Copy"}
        </button>
      </div>
      <span className="help-code__status" role="status" aria-live="polite">
        {result}
      </span>
      <pre tabIndex={0}>
        <code>{source}</code>
      </pre>
    </div>
  );
}

function inlineNodes(
  text: string,
  onOpenHelp: Props["onOpenHelp"],
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(text.slice(cursor, index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;
    const markdownLink = token.match(/^\[([^\]]+)\]\((help:\/\/[^)]+)\)$/);
    const locator = parseHelpLocator(markdownLink?.[2] ?? token);
    if (locator) {
      nodes.push(
        <button
          className="help-inline-link"
          key={key}
          type="button"
          onClick={() => onOpenHelp(locator.pageId, locator.anchor)}
        >
          {markdownLink?.[1] ?? token}
        </button>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(token);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
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
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function imageAssetPath(
  target: string,
  assets: HelpAssetRefDto[],
): string | null {
  const basename = target.replace(/\\/g, "/").split("/").pop();
  if (!basename) return null;
  return (
    assets.find(
      (asset) =>
        asset.path === target ||
        asset.path.endsWith(`/${basename}`) ||
        asset.path === `assets/${basename}`,
    )?.path ?? null
  );
}

/** Static, React-only renderer for the validated Help Markdown subset. */
export function HelpMarkdown({
  body,
  toc,
  assets,
  assetUrls,
  onOpenHelp,
  titleRef,
}: Props) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let lineIndex = 0;
  let tocIndex = 0;
  let blockIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    if (!line.trim()) {
      lineIndex += 1;
      continue;
    }

    const codeFence = line.trim().match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (codeFence) {
      const language = codeFence[1] ?? "";
      const code: string[] = [];
      lineIndex += 1;
      while (
        lineIndex < lines.length &&
        lines[lineIndex].trim() !== "```"
      ) {
        code.push(lines[lineIndex]);
        lineIndex += 1;
      }
      if (lineIndex < lines.length) lineIndex += 1;
      blocks.push(
        <HelpCodeBlock
          key={`code-${blockIndex}`}
          language={language}
          source={code.join("\n")}
        />,
      );
      blockIndex += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const entry = level > 1 ? toc[tocIndex++] : undefined;
      const content = inlineNodes(title, onOpenHelp, `h-${blockIndex}`);
      if (level === 1) {
        blocks.push(
          <h1 className="help-article__title" key={`h-${blockIndex}`} ref={titleRef} tabIndex={-1}>
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2 id={entry?.anchor} key={`h-${blockIndex}`}>
            {content}
          </h2>,
        );
      } else {
        blocks.push(
          <h3 id={entry?.anchor} key={`h-${blockIndex}`}>
            {content}
          </h3>,
        );
      }
      blockIndex += 1;
      lineIndex += 1;
      continue;
    }

    const image = line.trim().match(/^!\[([^\]]+)\]\(([^)]+)\)$/);
    if (image) {
      const alt = image[1].trim();
      const assetPath = imageAssetPath(image[2].trim(), assets);
      const url = assetPath ? assetUrls[assetPath] : undefined;
      blocks.push(
        <figure className="help-figure" key={`figure-${blockIndex}`}>
          {url ? (
            <img src={url} alt={alt} />
          ) : (
            <div className="help-figure__fallback" role="img" aria-label={alt}>
              <span>Illustration unavailable</span>
              <small>{alt}</small>
            </div>
          )}
          <figcaption>{alt}</figcaption>
        </figure>,
      );
      blockIndex += 1;
      lineIndex += 1;
      continue;
    }

    if (
      line.includes("|") &&
      isTableSeparator(lines[lineIndex + 1] ?? "")
    ) {
      const headers = tableCells(line);
      lineIndex += 2;
      const rows: string[][] = [];
      while (
        lineIndex < lines.length &&
        lines[lineIndex].trim() &&
        lines[lineIndex].includes("|")
      ) {
        rows.push(tableCells(lines[lineIndex]));
        lineIndex += 1;
      }
      blocks.push(
        <div className="help-table-wrap" key={`table-${blockIndex}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={`th-${cellIndex}`} scope="col">
                    {inlineNodes(cell, onOpenHelp, `th-${blockIndex}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`tr-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`td-${cellIndex}`}>
                      {inlineNodes(
                        row[cellIndex] ?? "",
                        onOpenHelp,
                        `td-${blockIndex}-${rowIndex}-${cellIndex}`,
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

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex])) {
        quote.push(lines[lineIndex].replace(/^>\s?/, ""));
        lineIndex += 1;
      }
      const label = quote[0]?.replace(/:$/, "").toLowerCase();
      const tone =
        label === "warning" || label === "caution" || label === "important"
          ? "warning"
          : "note";
      blocks.push(
        <aside
          className={`help-callout help-callout--${tone}`}
          key={`quote-${blockIndex}`}
          aria-label={quote[0]?.replace(/:$/, "") || "Note"}
        >
          {quote.map((part, partIndex) => (
            <Fragment key={`quote-line-${partIndex}`}>
              {partIndex > 0 ? <br /> : null}
              {inlineNodes(part, onOpenHelp, `quote-${blockIndex}-${partIndex}`)}
            </Fragment>
          ))}
        </aside>,
      );
      blockIndex += 1;
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const items: string[] = [];
      const orderedList = Boolean(ordered);
      const marker = orderedList ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      while (lineIndex < lines.length) {
        const match = lines[lineIndex].match(marker);
        if (!match) break;
        let item = match[1].trim();
        lineIndex += 1;
        while (
          lineIndex < lines.length &&
          /^\s{2,}\S/.test(lines[lineIndex]) &&
          !lines[lineIndex].trim().startsWith("- ")
        ) {
          item += ` ${lines[lineIndex].trim()}`;
          lineIndex += 1;
        }
        items.push(item);
      }
      const rendered = items.map((item, itemIndex) => (
        <li key={`li-${itemIndex}`}>
          {inlineNodes(item, onOpenHelp, `li-${blockIndex}-${itemIndex}`)}
        </li>
      ));
      blocks.push(
        orderedList ? (
          <ol key={`list-${blockIndex}`}>{rendered}</ol>
        ) : (
          <ul key={`list-${blockIndex}`}>{rendered}</ul>
        ),
      );
      blockIndex += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    lineIndex += 1;
    while (
      lineIndex < lines.length &&
      lines[lineIndex].trim() &&
      !/^(#{1,3})\s+/.test(lines[lineIndex]) &&
      !/^!\[[^\]]+\]\([^)]+\)$/.test(lines[lineIndex].trim()) &&
      !/^>\s?/.test(lines[lineIndex]) &&
      !/^```/.test(lines[lineIndex].trim()) &&
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
    const text = paragraph.join(" ");
    blocks.push(
      <p key={`p-${blockIndex}`}>
        {inlineNodes(text, onOpenHelp, `p-${blockIndex}`)}
      </p>,
    );
    blockIndex += 1;
  }

  return <>{blocks}</>;
}

export const __helpMarkdownTest = {
  parseHelpLocator,
  imageAssetPath,
  isTableSeparator,
};
