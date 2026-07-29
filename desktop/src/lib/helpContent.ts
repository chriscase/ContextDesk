/**
 * Typed contextual Help registry (#541).
 * Keys map UI controls to structured content + canonical Help locators.
 */
import type { HelpTipContent } from "../components/HelpTip";

export const HELP_TEMPLATE_GROUPING: HelpTipContent = {
  title: "Events per template",
  definition:
    "Average events per template is the imported event count divided by the learned Drain template count. A template replaces changing tokens with placeholders, so structurally similar—not necessarily identical—events can share one pattern.",
  currentState:
    "Every original redacted event remains in the corpus for search, filters, provenance, and inspection.",
  useWhen:
    "estimating how many recurring patterns a triage engineer must review and how much optional template-level embedding work is avoided.",
  example:
    "100,000 events ÷ 10 learned templates = 10,000 avg. events/template",
  consequence:
    "A higher value means more repetition at the pattern level. It is not a byte-compression or event-deletion claim.",
  safety:
    "Use Source and Corpus sizes for storage. Inspect top-template counts because this ratio is only an average and may hide a long tail.",
  helpLocator: "help://log-analysis-pipeline#events-per-template",
};

export const HELP_FIND_VS_FILTER: HelpTipContent = {
  title: "Find vs Filter",
  definition:
    "Find highlights matches and steps next/previous while keeping surrounding rows. Filter reduces the table. Both intersect explicit level, source, service, host, trace, template, UTC-time, and sequence scopes.",
  useWhen:
    "you need either to jump through hits in context (Find) or to isolate a subset of the corpus (Filter).",
  options: [
    {
      name: "Find",
      when: "You want next/prev over backend-paged hits without losing neighboring evidence.",
    },
    {
      name: "Filter",
      when: "You want only matching events (e.g. job-7f3a ∩ ERROR).",
    },
  ],
  example: "Find job-7f3a → step hits; Filter ERROR + worker source → 2 rows",
  shortcut: "⌘/Ctrl+F focuses Find when the Explorer is active",
  safety:
    "Only one bounded result page is retained. Next/Prev request chronological cursor pages; a regex scan-budget warning is partial and should be refined or continued. Cancel signals the active backend request and preserves the prior visible result identities. Exact UTC scope requires wall-clock evidence; use sequence range for mixed or order-only logs.",
  helpLocator: "help://log-explorer#find-vs-filter",
};

export const HELP_COUNTS: HelpTipContent = {
  title: "Corpus, matched, and resident counts",
  definition:
    "Corpus is the full event store size. Matched is how many events satisfy the active global query/facets. Resident is how many events are currently loaded in the evidence window.",
  useWhen:
    "you need to know whether you are looking at a page or the whole match set.",
  safety:
    "Never treat a per-lane maximum as the global total — multi-lane headers report each lane separately.",
  helpLocator: "help://log-explorer#counts",
};

export const HELP_TIME_LINK: HelpTipContent = {
  title: "Time-link modes",
  definition:
    "Independent lets each lane scroll alone. Follow seeks peers near a selected timestamp. Align gives every wall-clock lane the same virtualized exact-time rows, with blank cells where a lane has no event.",
  currentState:
    "Align is an exact event-time axis, not a duration-proportional chart. Coarse gap-region counts summarize silence; blank aligned cells are the row-level evidence.",
  useWhen: "comparing multi-source timelines during an incident.",
  options: [
    {
      name: "Independent",
      when: "Sources have unrelated rates or order-only data.",
    },
    {
      name: "Follow",
      when: "You want approximate peer seek without claiming row alignment.",
    },
    {
      name: "Align",
      when: "Every visible lane has reliable wall-clock time and exact timestamp rows are useful.",
    },
  ],
  safety:
    "Order-only or mixed time quality cannot enter Align. Empty, failed, or unloaded lanes do not strengthen the aggregate. Align never fabricates placeholder log events.",
  helpLocator: "help://log-explorer#time-link",
};

export const HELP_TIMELINE_NAVIGATOR: HelpTipContent = {
  title: "Investigation timeline",
  definition:
    "A fixed-size overview of the current filters. It summarizes event volume and canonical severity into at most 96 backend buckets, then seeks a bounded event neighborhood when you choose a position.",
  currentState:
    "The timeline is visible by default on desktop and has a broad chart scrubber. Moving previews synchronized compact values on the log and metric tracks; releasing performs one seek. Right-click a log bucket, or focus it and press Shift+F10, for the richer exact breakdown. A validated wall-clock metric JSON document can be loaded for this Explorer session only; it is not persisted. Metric tracks show bounded spike-preserving summaries; brush a range and choose Zoom to selection for finer samples and a matching bounded log histogram. That control becomes Reset full range while zoomed. Collapse stops subsequent timeline and metric work until it is reopened.",
  useWhen:
    "you need to jump across a long corpus without loading or scrolling through every intervening event.",
  comparison: {
    columns: ["Control", "Purpose"],
    rows: [
      {
        option: "Align",
        meaning: "Compare resident lane rows at exact wall-clock times.",
      },
      {
        option: "Timeline",
        meaning: "Move the resident window across the full filtered corpus.",
      },
    ],
  },
  consequence:
    "Empty buckets are honest gaps. Preview, committed seek, and resident range are distinct. Order-only data is labeled as order, not formatted as calendar time.",
  safety:
    "The overview returns bounded counts only, never full event bodies. Severity has text and pattern equivalents in addition to color. Hover and focus never seek. Exact UTC bucket bounds remain available through the explicit context detail.",
  helpLocator: "help://log-explorer#investigation-timeline",
};

export const HELP_LANE_COMPOSE: HelpTipContent = {
  title: "Lane composition",
  definition:
    "A lane is a named ordered evidence stream of zero or more sources. Empty membership means all sources. The same source may appear in multiple lanes.",
  useWhen:
    "you need custom multi-source groups instead of automatic first-N assignment.",
  helpLocator: "help://log-explorer#lanes",
};

export const HELP_LONG_LINES: HelpTipContent = {
  title: "Reading long events",
  definition:
    "1 line keeps dense scanning. Preview and Deep use the selected depth as a maximum while short events stay compact. Deep doubles that bounded maximum. Selecting any row opens the resizable inspector with the complete redacted event.",
  useWhen:
    "messages, stack traces, JSON, or logfmt values do not fit in a dense row.",
  options: [
    {
      name: "1 line",
      when: "Scanning many events; use Expand on an individual long row.",
    },
    {
      name: "Preview / Deep",
      when: "Comparing several wrapped lines in place; choose a 2, 4, 8, or 12-line maximum without padding every short event to that height.",
    },
    {
      name: "Inspector",
      when: "Reading or copying every character and structured event metadata.",
    },
  ],
  shortcut: "X expands/collapses the focused row; Enter opens the inspector",
  safety:
    "Row previews are deliberately bounded for virtualization. The inspector is the complete redacted persisted event and never relies on a hover tooltip.",
  helpLocator: "help://log-explorer#long-lines",
};

export const HELP_LINKED_CHAT_CONTEXT: HelpTipContent = {
  title: "Linked chat and agent context",
  definition:
    "A linked chat belongs to this corpus. Each turn receives a small immutable snapshot of the visible lanes, active filters, selection and bookmark counts, and time-link state.",
  useWhen:
    "you want the agent to investigate the current corpus or need to understand what changes when you switch chats.",
  options: [
    {
      name: "Context snapshot",
      when: "Captured when the turn starts; later UI changes do not rewrite that turn.",
    },
    {
      name: "Log tools",
      when: "Required for every linked investigation. A tools-enabled provider profile searches and correlates bounded result pages instead of receiving the entire corpus; otherwise the turn stops before contacting the provider and names the unavailable capability.",
    },
    {
      name: "Other read sources",
      when: "Configured workspace/Markdown, durable memory, Help, and read-only connector tools may supply relevant supporting evidence. Linking a corpus grants no new source or write permission; an MCP read that still needs first-use approval is omitted until separately authorized.",
    },
    {
      name: "Skills and synthesis",
      when: "A selected skill guides the investigation process but is not observed incident evidence. ContextDesk retrieves and caps evidence deterministically; the model synthesizes only what those results support.",
    },
    {
      name: "Suggested navigation",
      when: "The agent proposes a view change; nothing changes until you activate the validated action.",
    },
  ],
  safety:
    "Switching chats cannot move a pending turn, error, progress state, source citation, or navigation proposal into another chat. Failed, capped, unavailable, and permission-blocked sources remain visible.",
  privacy:
    "Raw corpus dumps, evaluator truth, credentials, and absolute source paths are not placed in the chat snapshot.",
  helpLocator: "help://log-explorer#agent-context",
};

/** Coverage checklist for audits (#541). */
export const HELP_COVERAGE_KEYS = [
  "find-vs-filter",
  "counts",
  "time-link",
  "timeline-navigator",
  "lanes",
  "long-lines",
  "bookmarks",
  "linked-chat",
  "first-chat",
] as const;

export type HelpCoverageKey = (typeof HELP_COVERAGE_KEYS)[number];
