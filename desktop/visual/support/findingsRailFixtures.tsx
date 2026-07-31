/**
 * Private fixtures for visual/findings-rail.test.tsx — owned by that suite
 * only; do not import from other visual suites.
 *
 * DTO shapes are copied from the shipped unit contracts so the visual suite
 * renders exactly the states the behavioral tests prove:
 * - evidence/finding/recipeFinding/note/legacyBookmark: verbatim from
 *   src/components/logExplorer/EvidencePanel.test.tsx:12-96.
 * - proposedFinding: the proposed-finding DTO staged at
 *   src/components/logExplorer/LogExplorer.test.tsx:5196-5241, adapted to the
 *   ProposedFindingItemView prop shape EvidencePanel consumes (2 evidence
 *   refs → evidenceCount 2, supporting 1, contradicting 1).
 * - citations: from src/components/SourceCitations.test.tsx (#697/#828).
 */
import type { CSSProperties, ReactNode } from "react";
import {
  InvestigationModeControl,
  type BookmarkItemView,
  type EvidenceItemView,
  type FindingItemView,
  type NoteItemView,
  type ProposedFindingItemView,
} from "../../src/components/logExplorer/EvidencePanel";
import type { SourceCitation } from "../../src/components/SourceCitations";

export const evidence: EvidenceItemView = {
  id: "ev-1",
  title: "Checkout timeout cluster",
  eventRefs: [
    {
      corpusId: "c1",
      seq: 4,
      source: "api/app.jsonl",
      timestampHint: 1_700_000_004,
      timeQualityHint: "wall",
    },
    {
      corpusId: "c1",
      seq: 9,
      source: "worker/worker.log",
      timestampHint: 1_700_000_009,
      timeQualityHint: "wall",
    },
  ],
  evidenceStatus: "verified",
  createdAt: 1_700_000_100,
  provenanceLabel: "Saved manually",
};

export const finding: FindingItemView = {
  id: "finding-1",
  kind: "inference",
  lifecycle: "accepted",
  title: "Retries amplify the database timeout",
  whyItMatters: "The retry storm increases queue pressure.",
  evidenceIds: [evidence.id],
  viewRecipe: null,
  provenanceLabel: "Authored manually",
};

export const recipeFinding: FindingItemView = {
  ...finding,
  id: "finding-view-1",
  title: "Saved failure view",
  viewRecipe: {
    filters: {
      levels: ["error"],
      sources: [],
      services: [],
      hosts: [],
      timeFrom: null,
      timeTo: null,
      seqFrom: null,
      seqTo: null,
      templateId: null,
      traceId: null,
      keyword: null,
    },
    lanes: [{ id: "lane-0", label: "All sources", sources: [] }],
    visibleLaneCount: 1,
    linkMode: "independent",
    focusedLaneId: "lane-0",
    focusedEvent: null,
    selection: [],
    highlights: [],
    find: null,
    viewportAnchors: [],
  },
  policyStatus: "made_under_different_policy",
  policyStatusLabel: "Made under a different noise policy",
};

/**
 * recipeFinding plus one dangling evidence id, so the detail renders both a
 * live citation button and the 'Unavailable evidence' fallback span.
 */
export const danglingRefFinding: FindingItemView = {
  ...recipeFinding,
  evidenceIds: [evidence.id, "ev-missing"],
};

export const note: NoteItemView = {
  id: "note-1",
  title: "Compare with deployment",
  body: "Check whether this started after the release window.",
  evidenceIds: [evidence.id],
  findingIds: [finding.id],
  provenanceLabel: "Authored manually",
};

export const legacyBookmark: BookmarkItemView = {
  id: "bookmark-1",
  label: "Original triage marker",
  note: "Potential root cause",
  seqFrom: 4,
  seqTo: 9,
  eventRefs: [],
  evidenceStatus: "legacy_range",
};

export const proposedFinding: ProposedFindingItemView = {
  id: "prop-1",
  kind: "hypothesis",
  title: "Agent proposed checkout failure",
  whyItMatters: "First error anchors the retry sequence.",
  status: "proposed",
  dismissReason: null,
  caveats: "Single sample",
  evidenceCount: 2,
  supportingCount: 1,
  contradictingCount: 1,
  viewRecipe: null,
};

/** Bulk verified evidence items to make the rail list overflow vertically. */
export function bulkEvidence(count: number): EvidenceItemView[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ev-bulk-${i + 1}`,
    title: `Bulk timeout cluster ${i + 1}`,
    eventRefs: [
      {
        corpusId: "c1",
        seq: 100 + i,
        source: "api/app.jsonl",
        timestampHint: 1_700_000_200 + i,
        timeQualityHint: "wall",
      },
    ],
    evidenceStatus: "verified",
    createdAt: 1_700_000_300 + i,
    provenanceLabel: "Saved manually",
  }));
}

export function railModeControl(investigationCount: number): ReactNode {
  return (
    <InvestigationModeControl
      mode="investigation"
      investigationCount={investigationCount}
      chatCount={2}
      onChange={() => undefined}
    />
  );
}

/**
 * The Explorer desktop grid gives the Investigation rail a fixed 300px column
 * (log-explorer.css:405 `grid-template-columns: 220px 6px 1fr 6px 300px`)
 * whose single row stretches to the body height. This frame reproduces that
 * track so the panel renders at its natural production width.
 */
export const RAIL_WIDTH = 300;
export const RAIL_HEIGHT = 640;

export function RailFrame({
  children,
  width = RAIL_WIDTH,
  height = RAIL_HEIGHT,
}: {
  children: ReactNode;
  width?: number;
  height?: number;
}) {
  const style: CSSProperties = { width, height, display: "grid" };
  return (
    <div data-testid="rail-frame" style={style}>
      {children}
    </div>
  );
}

/** Fixed-width column standing in for the chat message column. */
export function ChipFrame({
  children,
  width,
}: {
  children: ReactNode;
  width: number;
}) {
  return (
    <div data-testid="chip-frame" style={{ width }}>
      {children}
    </div>
  );
}

/**
 * SourceCitations.test.tsx fixtures (#697 label collapse, #828 equal ids
 * across corpora both kept), plus one https citation so the collapsed row
 * shows a web monogram next to file icons.
 */
export const baseCitations: SourceCitation[] = [
  { id: "log_template:4", label: "log_template:4" },
  { id: "logs/app.log", label: "app.log", title: "Checkout failure" },
  { id: "log_event:7", label: "Corpus A", corpusId: "a" },
  { id: "log_event:7", label: "Corpus B", corpusId: "b" },
  {
    id: "https://example.com/postmortem",
    label: "example.com",
    title: "Postmortem report",
  },
];

export function manyCitations(count: number): SourceCitation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `logs/service-${i + 1}.log`,
    label: `service-${i + 1}.log`,
    title: `Service ${i + 1} failure`,
  }));
}
