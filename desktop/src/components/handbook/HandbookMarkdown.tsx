import { useState, type KeyboardEvent, type ReactNode } from "react";

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

type MermaidNode = {
  id: string;
  label: string;
};

type MermaidEdge = {
  from: string;
  to: string;
  label?: string;
};

type MermaidModel = {
  kind: "flow" | "sequence" | "state";
  direction: "LR" | "TB";
  title?: string;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
};

function HandbookCodeBlock({
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

  return (
    <div className="handbook-code">
      <div>
        <span>{language || "text"}</span>
        <button
          type="button"
          className="handbook-code__copy"
          aria-label={
            copyState === "copied"
              ? `${language || "text"} block copied`
              : copyState === "error"
                ? `Copy ${language || "text"} block failed; retry`
                : `Copy ${language || "text"} block`
          }
          onClick={() => void copy()}
        >
          {copyState === "copied"
            ? "Copied"
            : copyState === "error"
              ? "Copy failed"
              : "Copy"}
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied"
            ? `${language || "text"} block copied to clipboard`
            : copyState === "error"
              ? `Could not copy ${language || "text"} block`
              : ""}
        </span>
      </div>
      <pre>
        <code className={language ? `language-${language}` : undefined}>
          {source}
        </code>
      </pre>
    </div>
  );
}

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
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function mermaidTitle(source: string): string | undefined {
  const line = source
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => /^%%\s*title\s*:/i.test(candidate));
  return line?.replace(/^%%\s*title\s*:\s*/i, "").trim() || undefined;
}

function parseMermaidNode(
  value: string,
  aliases: Map<string, string>,
): MermaidNode | null {
  const token = value.trim().replace(/;$/, "");
  const parsed = token.match(
    /^(\[\*\]|[A-Za-z][\w-]*)\s*(?:\[([^\]]+)\]|\(([^)]*)\)|\{([^}]*)\})?$/,
  );
  if (!parsed) return null;
  const id = parsed[1];
  const declaredLabel = parsed[2] ?? parsed[3] ?? parsed[4];
  if (declaredLabel) aliases.set(id, mermaidLabel(declaredLabel));
  return {
    id,
    label: aliases.get(id) ?? (id === "[*]" ? "Start / end" : id),
  };
}

function parseMermaid(source: string): MermaidModel | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const declaration = lines[0] ?? "";
  const kind = /^sequenceDiagram\b/i.test(declaration)
    ? "sequence"
    : /^stateDiagram/i.test(declaration)
      ? "state"
      : /^(?:flowchart|graph)\b/i.test(declaration)
        ? "flow"
        : null;
  if (!kind) return null;
  const direction =
    kind === "state" || (kind === "flow" && /\b(?:TB|TD)\b/i.test(declaration))
      ? "TB"
      : "LR";
  const aliases = new Map<string, string>();
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const title = mermaidTitle(source);
  const remember = (node: MermaidNode | null) => {
    if (!node) return;
    nodes.set(node.id, node);
  };

  if (kind === "sequence") {
    for (const line of lines.slice(1)) {
      if (/^%%/.test(line)) continue;
      if (
        /^(?:alt|else|opt|loop|par|and|critical|option|break|rect|end)\b/i.test(
          line,
        )
      ) {
        return null;
      }
      const participant = line.match(
        /^(?:participant|actor)\s+([A-Za-z][\w-]*)(?:\s+as\s+(.+))?$/,
      );
      if (participant) {
        const id = participant[1];
        aliases.set(id, mermaidLabel(participant[2] ?? id));
        remember({ id, label: aliases.get(id) ?? id });
        continue;
      }
      const message = line.match(
        /^([A-Za-z][\w-]*)\s*(-{1,2}>>?)\s*([A-Za-z][\w-]*)\s*:\s*(.+)$/,
      );
      if (!message) return null;
      const from = message[1];
      const to = message[3];
      remember({ id: from, label: aliases.get(from) ?? from });
      remember({ id: to, label: aliases.get(to) ?? to });
      edges.push({ from, to, label: mermaidLabel(message[4]) });
    }
  } else {
    const relationSeparator = /\s*(?:-->|---|==>|-\.->)\s*/;
    for (const line of lines.slice(1)) {
      if (/^%%/.test(line)) continue;
      if (/^(?:subgraph\b|end$)/i.test(line)) return null;
      if (
        /^(?:direction\b|classDef\b|class\b|style\b|linkStyle\b)/i.test(line)
      ) {
        continue;
      }
      const stateParts =
        kind === "state" ? line.match(/^(.*?)(?:\s*:\s*(.+))?$/) : null;
      const relationSource = stateParts?.[1] ?? line;
      const edgeLabel = stateParts?.[2]
        ? mermaidLabel(stateParts[2])
        : undefined;
      const parts = relationSource.split(relationSeparator);
      if (parts.length > 1) {
        const chain = parts
          .map((part) => parseMermaidNode(part, aliases))
          .filter((node): node is MermaidNode => Boolean(node));
        chain.forEach(remember);
        for (let index = 0; index < chain.length - 1; index += 1) {
          edges.push({
            from: chain[index].id,
            to: chain[index + 1].id,
            label: edgeLabel,
          });
        }
        continue;
      }
      const node = parseMermaidNode(line, aliases);
      if (!node) return null;
      remember(node);
    }
  }

  for (const [id, node] of nodes) {
    nodes.set(id, { ...node, label: aliases.get(id) ?? node.label });
  }
  return { kind, direction, title, nodes: [...nodes.values()], edges };
}

function summarizeMermaid(source: string): MermaidSummary {
  const model = parseMermaid(source);
  if (!model) return { nodes: [], relations: [] };
  const labels = new Map(model.nodes.map((node) => [node.id, node.label]));
  return {
    nodes: model.nodes.map((node) => node.label).slice(0, 16),
    relations: model.edges
      .map((edge) => {
        const from = labels.get(edge.from) ?? edge.from;
        const to = labels.get(edge.to) ?? edge.to;
        return edge.label
          ? `${from} sends “${edge.label}” to ${to}`
          : `${from} leads to ${to}`;
      })
      .slice(0, 16),
  };
}

function wrappedLabel(value: string, limit = 24): string[] {
  const wrapped: string[] = [];
  for (const explicitLine of value.split("\n")) {
    const words = explicitLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (`${line} ${word}`.length <= limit) {
        line = `${line} ${word}`;
      } else {
        wrapped.push(line);
        line = word;
      }
    }
    if (line) wrapped.push(line);
  }
  if (wrapped.length <= 4) return wrapped;
  return [...wrapped.slice(0, 3), `${wrapped[3].slice(0, limit - 1)}…`];
}

type PositionedNode = MermaidNode & {
  x: number;
  y: number;
};

function layoutFlow(model: MermaidModel): {
  nodes: PositionedNode[];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
} {
  const nodeWidth = 184;
  const nodeHeight = model.direction === "TB" ? 64 : 76;
  const rankGap = model.direction === "TB" ? 28 : 72;
  const laneGap = model.direction === "TB" ? 24 : 28;
  const indegree = new Map(model.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, MermaidEdge[]>();
  for (const edge of model.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  const ranks = new Map(model.nodes.map((node) => [node.id, 0]));
  const queue = model.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      ranks.set(
        edge.to,
        Math.max(ranks.get(edge.to) ?? 0, (ranks.get(id) ?? 0) + 1),
      );
      const nextDegree = (indegree.get(edge.to) ?? 1) - 1;
      indegree.set(edge.to, nextDegree);
      if (nextDegree === 0) queue.push(edge.to);
    }
  }
  let fallbackRank = Math.max(0, ...ranks.values());
  for (const node of model.nodes) {
    if (visited.has(node.id) || (indegree.get(node.id) ?? 0) === 0) continue;
    fallbackRank += 1;
    ranks.set(node.id, fallbackRank);
  }
  const groups = new Map<number, MermaidNode[]>();
  for (const node of model.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    groups.set(rank, [...(groups.get(rank) ?? []), node]);
  }
  const orderedRanks = [...groups.keys()].sort((a, b) => a - b);
  const widestLane = Math.max(
    1,
    ...orderedRanks.map((rank) => groups.get(rank)?.length ?? 0),
  );
  const rankCount = Math.max(1, orderedRanks.length);
  const hasVerticalSkipEdge =
    model.direction === "TB" &&
    model.edges.some(
      (edge) => (ranks.get(edge.to) ?? 0) - (ranks.get(edge.from) ?? 0) > 1,
    );
  const width =
    model.direction === "LR"
      ? 32 + rankCount * nodeWidth + (rankCount - 1) * rankGap
      : 32 +
        widestLane * nodeWidth +
        (widestLane - 1) * laneGap +
        (hasVerticalSkipEdge ? 60 : 0);
  const height =
    model.direction === "LR"
      ? 32 + widestLane * nodeHeight + (widestLane - 1) * laneGap
      : 32 + rankCount * nodeHeight + (rankCount - 1) * rankGap;
  const nodes: PositionedNode[] = [];
  orderedRanks.forEach((rank, rankIndex) => {
    const group = groups.get(rank) ?? [];
    group.forEach((node, laneIndex) => {
      const x =
        model.direction === "LR"
          ? 16 + rankIndex * (nodeWidth + rankGap)
          : (width -
              (group.length * nodeWidth +
                Math.max(0, group.length - 1) * laneGap)) /
              2 +
            laneIndex * (nodeWidth + laneGap);
      const y =
        model.direction === "LR"
          ? (height -
              (group.length * nodeHeight +
                Math.max(0, group.length - 1) * laneGap)) /
              2 +
            laneIndex * (nodeHeight + laneGap)
          : 16 + rankIndex * (nodeHeight + rankGap);
      nodes.push({ ...node, x, y });
    });
  });
  return { nodes, width, height, nodeWidth, nodeHeight };
}

function DiagramText({ label, x, y }: { label: string; x: number; y: number }) {
  const lines = wrappedLabel(label);
  const firstY = y - ((lines.length - 1) * 15) / 2;
  return (
    <text className="handbook-diagram__svg-label" x={x} y={firstY}>
      {lines.map((line, index) => (
        <tspan x={x} dy={index === 0 ? 0 : 15} key={`${line}-${index}`}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function FlowSvg({
  model,
  markerId,
}: {
  model: MermaidModel;
  markerId: string;
}) {
  const naturalLayout = layoutFlow(model);
  const displayModel =
    model.direction === "LR" && naturalLayout.width > 1200
      ? { ...model, direction: "TB" as const }
      : model;
  const layout =
    displayModel === model ? naturalLayout : layoutFlow(displayModel);
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const { nodeWidth, nodeHeight } = layout;
  return (
    <svg
      aria-hidden="true"
      data-layout={
        displayModel.direction === model.direction
          ? model.direction.toLowerCase()
          : "responsive-top-to-bottom"
      }
      focusable="false"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={
        displayModel.direction === "LR"
          ? { minWidth: `${layout.width}px` }
          : undefined
      }
    >
      <defs>
        <marker
          id={markerId}
          markerHeight="8"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path className="handbook-diagram__svg-arrow" d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      {model.edges.map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const horizontal = displayModel.direction === "LR";
        const startX = horizontal ? from.x + nodeWidth : from.x + nodeWidth / 2;
        const startY = horizontal
          ? from.y + nodeHeight / 2
          : from.y + nodeHeight;
        const endX = horizontal ? to.x : to.x + nodeWidth / 2;
        const endY = horizontal ? to.y + nodeHeight / 2 : to.y;
        const skipsVerticalRank =
          !horizontal && endY - startY > nodeHeight + 40;
        const verticalDetourX = startX + nodeWidth / 2 + 44;
        const bend = horizontal
          ? `C${(startX + endX) / 2} ${startY},${(startX + endX) / 2} ${endY},${endX} ${endY}`
          : skipsVerticalRank
            ? `C${verticalDetourX} ${startY + 20},${verticalDetourX} ${endY - 20},${endX} ${endY}`
            : `C${startX} ${(startY + endY) / 2},${endX} ${(startY + endY) / 2},${endX} ${endY}`;
        return (
          <path
            className="handbook-diagram__svg-edge"
            data-edge={`${edge.from}-${edge.to}`}
            d={`M${startX} ${startY}${bend}`}
            key={`${edge.from}-${edge.to}-${index}`}
            markerEnd={`url(#${markerId})`}
          />
        );
      })}
      {layout.nodes.map((node) => (
        <g key={node.id}>
          <rect
            className="handbook-diagram__svg-node"
            height={nodeHeight}
            rx="12"
            width={nodeWidth}
            x={node.x}
            y={node.y}
          />
          <DiagramText
            label={node.label}
            x={node.x + nodeWidth / 2}
            y={node.y + nodeHeight / 2 + 1}
          />
        </g>
      ))}
    </svg>
  );
}

function SequenceSvg({
  model,
  markerId,
}: {
  model: MermaidModel;
  markerId: string;
}) {
  const participantWidth = 164;
  const width = Math.max(560, model.nodes.length * participantWidth + 32);
  const height = Math.max(220, model.edges.length * 54 + 132);
  const nodeX = new Map(
    model.nodes.map((node, index) => [
      node.id,
      16 + index * participantWidth + participantWidth / 2,
    ]),
  );
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      style={{ minWidth: `${width}px` }}
    >
      <defs>
        <marker
          id={markerId}
          markerHeight="8"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path className="handbook-diagram__svg-arrow" d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      {model.nodes.map((node) => {
        const x = nodeX.get(node.id) ?? 0;
        return (
          <g key={node.id}>
            <rect
              className="handbook-diagram__svg-node"
              height="48"
              rx="10"
              width="144"
              x={x - 72}
              y="16"
            />
            <DiagramText label={node.label} x={x} y={41} />
            <line
              className="handbook-diagram__svg-lifeline"
              x1={x}
              x2={x}
              y1="64"
              y2={height - 18}
            />
          </g>
        );
      })}
      {model.edges.map((edge, index) => {
        const from = nodeX.get(edge.from);
        const to = nodeX.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const y = 94 + index * 54;
        const self = from === to;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <path
              className="handbook-diagram__svg-edge"
              d={self ? `M${from} ${y}h46v26h-46` : `M${from} ${y}L${to} ${y}`}
              markerEnd={`url(#${markerId})`}
            />
            {edge.label ? (
              <text
                className="handbook-diagram__svg-message"
                x={self ? from + 24 : (from + to) / 2}
                y={y - 8}
              >
                {edge.label.length > 44
                  ? `${edge.label.slice(0, 43)}…`
                  : edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function MermaidDiagram({ source, index }: { source: string; index: number }) {
  const model = parseMermaid(source);
  const summary = summarizeMermaid(source);
  const markerId = `handbook-diagram-arrow-${index}`;
  const diagramTitle =
    model?.title ??
    mermaidTitle(source) ??
    (model?.kind === "sequence"
      ? "Context sequence"
      : model?.kind === "state"
        ? "State lifecycle"
        : "System flow");
  const description =
    summary.relations.length > 0
      ? summary.relations.join(". ")
      : summary.nodes.length > 0
        ? `Diagram elements: ${summary.nodes.join(", ")}.`
        : "This diagram uses unsupported Mermaid syntax. Expand the source for its complete text.";

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
          <strong id={`handbook-diagram-${index}-title`}>{diagramTitle}</strong>
          <small>
            Theme-aware responsive view of the canonical Mermaid source
          </small>
        </span>
      </figcaption>

      {model && model.nodes.length > 0 ? (
        <div className="handbook-diagram__canvas">
          {model.kind === "sequence" ? (
            <SequenceSvg model={model} markerId={markerId} />
          ) : (
            <FlowSvg model={model} markerId={markerId} />
          )}
        </div>
      ) : null}

      <p className="sr-only" id={`handbook-diagram-${index}-summary`}>
        {description}
      </p>
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
          <HandbookCodeBlock
            key={`code-${blockIndex}`}
            language={language}
            source={source}
          />
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
