/**
 * Private fixtures for visual/help.test.tsx — owned by that suite only.
 *
 * Shapes mirror the host DTO contracts in src/lib/host.ts (HelpSectionDto /
 * HelpPageDto / HelpSearchHitDto / HelpAssetDto) and are adapted from the
 * reference unit fixtures in src/components/panes/HelpPane.test.tsx:20-90,
 * extended with a long article body so the reader column genuinely overflows
 * at 1280x800 and the "reader is the scrolling column" geometry is provable.
 *
 * Everything is deterministic: the figure asset is an inline shapes-only SVG
 * data: URI (no external fetch, no text glyphs), scores and modes are fixed.
 */
import type {
  HelpPageDto,
  HelpSearchHitDto,
  HelpSectionDto,
} from "../../src/lib/host";

const pipelineSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200" viewBox="0 0 640 200">',
  '<rect x="0" y="0" width="640" height="200" rx="12" fill="#1f2733"/>',
  '<rect x="36" y="72" width="120" height="56" rx="8" fill="#3b82f6"/>',
  '<rect x="260" y="72" width="120" height="56" rx="8" fill="#22c55e"/>',
  '<rect x="484" y="72" width="120" height="56" rx="8" fill="#eab308"/>',
  '<path d="M156 100h104m0 0-12-8m12 8-12 8" stroke="#94a3b8" stroke-width="3" fill="none"/>',
  '<path d="M380 100h104m0 0-12-8m12 8-12 8" stroke="#94a3b8" stroke-width="3" fill="none"/>',
  "</svg>",
].join("");

export const pipelineDiagramDataUrl = `data:image/svg+xml,${encodeURIComponent(pipelineSvg)}`;

export const helpSections: HelpSectionDto[] = [
  {
    id: "overview",
    title: "Overview",
    order: 10,
    pages: [
      {
        id: "product-overview",
        title: "What ContextDesk does",
        summary: "Understand the product.",
        order: 10,
        tags: ["overview"],
      },
      {
        id: "first-run",
        title: "First run and prelaunch",
        summary: "What the launch checks verify.",
        order: 20,
        tags: ["setup"],
      },
    ],
  },
  {
    id: "log-analysis",
    title: "Log analysis",
    order: 70,
    pages: [
      {
        id: "log-analysis-pipeline",
        title: "How log analysis works",
        summary: "Follow the bounded pipeline.",
        order: 10,
        tags: ["logs"],
      },
    ],
  },
  {
    id: "trust",
    title: "Trust and safety",
    order: 90,
    pages: [
      {
        id: "permissions",
        title: "Permissions and write boundaries",
        summary: "When ContextDesk asks before writing.",
        order: 10,
        tags: ["permissions"],
      },
    ],
  },
];

/**
 * Long-form article: five h2/h3 headings (TOC order must match document
 * order — HelpMarkdown assigns ids sequentially from the toc array), a
 * declared SVG figure, a list, a code fence, a table, a callout, and an
 * internal help:// link. Long enough that main.help-reader overflows an
 * 800px-tall pane.
 */
export const overviewPage: HelpPageDto = {
  meta: {
    id: "product-overview",
    title: "What ContextDesk does",
    summary: "Understand the product.",
    order: 10,
    tags: ["overview"],
    section: "overview",
    related: ["log-analysis-pipeline", "permissions"],
  },
  body: [
    "# What ContextDesk does",
    "",
    "ContextDesk is a local-first knowledge workbench. It ingests the material you point it at, keeps the corpus on this machine, and lets an agent reason over a bounded snapshot instead of a live filesystem.",
    "",
    "Nothing in this guide requires a network connection. Every page, diagram, and search result is bundled with the desktop app and served by the trusted host process.",
    "",
    "![Bounded pipeline overview](assets/pipeline-overview.svg)",
    "",
    "## Getting oriented",
    "",
    "The workspace is organised around panes. Chat is where you converse, Logs is where captured evidence lives, and Help — this pane — is a documentation browser rather than a file list.",
    "",
    "- **Sections** on the left group pages by task.",
    "- The `On this page` rail mirrors the article headings.",
    "- Search ranks bundled pages locally; nothing leaves the machine.",
    "",
    "Skim the section list once: knowing what exists is usually faster than searching for it later.",
    "",
    "## The bounded pipeline",
    "",
    "Everything the agent can see passes through the same four stages. The stages are ordered, and each one narrows what the next may touch.",
    "",
    "```text",
    "ingest -> redact -> store -> analyze",
    "```",
    "",
    "Ingest copies the selected material into the workspace. Redact strips secrets before anything is persisted. Store writes the bounded snapshot. Analyze is the only stage the agent participates in.",
    "",
    "### Redaction",
    "",
    "Redaction runs before storage, not after. If a token or key is caught at this stage it never reaches the corpus, which is why the redaction report is worth reading after every large ingest.",
    "",
    "## Boundaries",
    "",
    "| Layer | Responsibility | Writes |",
    "| --- | --- | --- |",
    "| Host | Trusted reads and bundled content | Never |",
    "| Renderer | Presentation and interaction | Session state only |",
    "| Agent | Analysis over the snapshot | Proposals only |",
    "",
    "> Note:",
    "> The host asks before any proposal becomes a write. There is no silent write path from the agent to your files.",
    "",
    "## Recovering from failures",
    "",
    "Most failures are recoverable in place. A failed ingest leaves the previous snapshot intact, and a failed analysis run can simply be retried against the same corpus.",
    "",
    "When a page or asset cannot be loaded, the reader shows a labelled error state with a search escape hatch rather than a blank column. If that happens repeatedly, the bundled corpus is damaged and reinstalling restores it.",
    "",
    "For the full ingest story, see [How log analysis works](help://log-analysis-pipeline).",
  ].join("\n"),
  toc: [
    { level: 2, title: "Getting oriented", anchor: "getting-oriented" },
    { level: 2, title: "The bounded pipeline", anchor: "the-bounded-pipeline" },
    { level: 3, title: "Redaction", anchor: "redaction" },
    { level: 2, title: "Boundaries", anchor: "boundaries" },
    {
      level: 2,
      title: "Recovering from failures",
      anchor: "recovering-from-failures",
    },
  ],
  assets: [
    {
      path: "assets/pipeline-overview.svg",
      alt: "Bounded pipeline overview",
      mime: "image/svg+xml",
    },
  ],
};

export const logPage: HelpPageDto = {
  meta: {
    id: "log-analysis-pipeline",
    title: "How log analysis works",
    summary: "Follow the bounded pipeline.",
    order: 10,
    tags: ["logs"],
    section: "log-analysis",
    related: [],
  },
  body: "# How log analysis works\n\n## Pipeline\n\nIngest, redact, store, analyze.",
  toc: [{ level: 2, title: "Pipeline", anchor: "pipeline" }],
  assets: [],
};

/** Three ranked hits: one hybrid, two keyword, distinct scores. */
export const searchHits: HelpSearchHitDto[] = [
  {
    page_id: "log-analysis-pipeline",
    title: "How log analysis works",
    summary: "Follow the bounded pipeline.",
    section: "log-analysis",
    heading: "Pipeline",
    anchor: "pipeline",
    snippet: "Ingest, redact, store, and analyze a bounded corpus.",
    score: 0.92,
    mode: "hybrid",
    citation: "help://log-analysis-pipeline#pipeline",
  },
  {
    page_id: "product-overview",
    title: "What ContextDesk does",
    summary: "Understand the product.",
    section: "overview",
    heading: "Boundaries",
    anchor: "boundaries",
    snippet: "Host, renderer, and agent each own one side of the boundary.",
    score: 0.61,
    mode: "keyword",
    citation: "help://product-overview#boundaries",
  },
  {
    page_id: "permissions",
    title: "Permissions and write boundaries",
    summary: "When ContextDesk asks before writing.",
    section: "trust",
    heading: null,
    anchor: null,
    snippet: "The host asks before any proposal becomes a write.",
    score: 0.4,
    mode: "keyword",
    citation: "help://permissions",
  },
];
