/**
 * Typed contextual Help registry (#541).
 * Keys map UI controls to structured content + canonical Help locators.
 */
import type { HelpTipContent } from "../components/HelpTip";

export const HELP_FIND_VS_FILTER: HelpTipContent = {
  title: "Find vs Filter",
  definition:
    "Find highlights matches and steps next/previous while keeping surrounding rows. Filter reduces the table to matching events and intersects levels, sources, and time.",
  useWhen:
    "you need either to jump through hits in context (Find) or to isolate a subset of the corpus (Filter).",
  options: [
    {
      name: "Find",
      when: "You want next/prev over hits without losing neighboring evidence.",
    },
    {
      name: "Filter",
      when: "You want only matching events (e.g. job-7f3a ∩ ERROR).",
    },
  ],
  example: "Find job-7f3a → step hits; Filter ERROR + worker source → 2 rows",
  shortcut: "⌘/Ctrl+F focuses Find when the Explorer is active",
  safety:
    "Find may be capped (partial results). Refine the query if the status says capped.",
  helpLocator: "help://log-explorer#find-vs-filter",
};

export const HELP_COUNTS: HelpTipContent = {
  title: "Corpus, matched, and resident counts",
  definition:
    "Corpus is the full event store size. Matched is how many events satisfy the active global query/facets. Resident is how many events are currently loaded in the evidence window.",
  useWhen: "you need to know whether you are looking at a page or the whole match set.",
  safety:
    "Never treat a per-lane maximum as the global total — multi-lane headers report each lane separately.",
  helpLocator: "help://log-explorer#counts",
};

export const HELP_TIME_LINK: HelpTipContent = {
  title: "Time-link modes",
  definition:
    "Independent: each lane scrolls alone. Follow cursor: selecting an event seeks peers to the nearest time (not row alignment). Align time: lanes share a vertical time axis with explicit gap bands.",
  useWhen: "comparing multi-source timelines during an incident.",
  options: [
    { name: "Independent", when: "Sources have unrelated rates or order-only data." },
    { name: "Follow", when: "You want peer seek without claiming row alignment." },
    { name: "Align", when: "Wall-clock data supports shared vertical time." },
  ],
  safety:
    "Order-only or mixed time quality cannot claim calendar alignment. Empty/failed lanes do not strengthen quality.",
  helpLocator: "help://log-explorer#time-link",
};

export const HELP_LANE_COMPOSE: HelpTipContent = {
  title: "Lane composition",
  definition:
    "A lane is a named ordered evidence stream of zero or more sources. Empty membership means all sources. The same source may appear in multiple lanes.",
  useWhen: "you need custom multi-source groups instead of automatic first-N assignment.",
  helpLocator: "help://log-explorer#lanes",
};

/** Coverage checklist for audits (#541). */
export const HELP_COVERAGE_KEYS = [
  "find-vs-filter",
  "counts",
  "time-link",
  "lanes",
  "long-lines",
  "bookmarks",
  "linked-chat",
  "first-chat",
] as const;

export type HelpCoverageKey = (typeof HELP_COVERAGE_KEYS)[number];
