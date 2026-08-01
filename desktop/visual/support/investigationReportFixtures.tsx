/**
 * Private fixtures for visual/investigation-report.test.tsx — owned by that
 * suite only; do not import from other visual suites.
 *
 * DTO shapes are copied from the shipped unit contracts so the visual suite
 * renders exactly the states the behavioral tests prove:
 * - reportPreviewFixture: extends the projection staged at
 *   src/components/logExplorer/InvestigationReport.test.tsx:28-158 (seven
 *   sections, authored + not-authored mix, [verified]/[stale]/[missing]
 *   timeline, bounded render) with a third finding so all of
 *   current / made_under_different_policy / unbound_legacy policy bindings
 *   render at once.
 * - corpus/resolvedInvestigation: verbatim shape from
 *   src/components/panes/InvestigationsPane.test.tsx:29-101, plus authored
 *   report sections so the pane summary line shows a non-zero count.
 * - proposedSectionView: the ProposedReportSectionView staged at
 *   InvestigationReport.test.tsx:160-169.
 */
import type { CSSProperties, ReactNode } from "react";
import type {
  LogCorpusSummaryDto,
  LogInvestigationReportPreviewDto,
  ResolvedInvestigationDocumentDto,
} from "../../src/lib/engine/investigationReports";
import type { ProposedReportSectionView } from "../../src/components/logExplorer/InvestigationReport";

export const EXACT_MARKDOWN =
  "# Investigation report\n\n[verified] exact host-rendered bytes\n";

export function reportPreviewFixture(): LogInvestigationReportPreviewDto {
  return {
    report: {
      schemaVersion: 1,
      investigationId: "inv-1",
      title: "Checkout latency regression",
      status: "active",
      sourceRevision: 9,
      generatedAt: 1_700_000_400,
      currentPolicy: {
        suppressionPolicyRevision: 7,
        resolvedTemplateRevision: 11,
        effectivePolicySha256: "abc123",
        noiseLens: "active",
      },
      scope: {
        corpusIds: ["corpus-1234abcd"],
        evidenceCount: 3,
        findingCount: 3,
        noteCount: 1,
        timeWindow: {
          minTimestampHint: 1_700_000_004,
          maxTimestampHint: 1_700_000_009,
          mixedQuality: true,
        },
      },
      sections: {
        // Authored from an accepted agent proposal (extra provenance line)…
        executiveSummary: {
          sectionId: "sec-1",
          body: "Retries amplified a database timeout into checkout failure.",
          evidenceIds: ["ev-1"],
          findingIds: [],
          noteIds: [],
          acceptedFromProposalId: "prop-9",
          acceptedProposalProvenance: {
            source: "model",
            provider: "openai_compatible",
            modelId: "incident-model",
            runId: "run-9",
            toolName: "propose_report_section",
          },
          acceptedProposalAcceptance: {
            acceptedAt: 1_700_000_250,
            edited: true,
          },
          updatedAt: 1_700_000_300,
        },
        // …one explicit Not authored slot…
        unresolvedQuestions: null,
        // …and one directly human-authored section without a proposal trail.
        nextActions: {
          sectionId: "sec-2",
          body: "Roll back the retry policy and re-run the load test.",
          evidenceIds: [],
          findingIds: ["finding-1"],
          noteIds: [],
          acceptedFromProposalId: null,
          updatedAt: 1_700_000_320,
        },
      },
      findings: [
        {
          findingId: "finding-1",
          kind: "inference",
          lifecycle: "accepted",
          title: "Retries amplify the database timeout",
          whyItMatters: "The retry storm increases queue pressure.",
          policyBindingStatus: "current",
          hasSavedView: true,
          citations: [
            {
              evidenceId: "ev-1",
              evidenceTitle: "Checkout timeout cluster",
              references: [
                {
                  corpusId: "corpus-1234abcd",
                  seq: 4,
                  source: "api/app.jsonl",
                  timestampHint: 1_700_000_004,
                  timeQualityHint: "wall",
                  status: "verified",
                },
              ],
            },
          ],
          createdAt: 1_700_000_100,
        },
        {
          findingId: "finding-2",
          kind: "observation",
          lifecycle: "accepted",
          title: "Timeouts cluster on one worker",
          whyItMatters: "Points at a single saturated dependency.",
          policyBindingStatus: "made_under_different_policy",
          hasSavedView: false,
          citations: [
            {
              evidenceId: "ev-3",
              evidenceTitle: "Worker saturation window",
              references: [
                {
                  corpusId: "corpus-1234abcd",
                  seq: 7,
                  source: "api/app.jsonl",
                  timestampHint: 1_700_000_007,
                  timeQualityHint: "wall",
                  status: "stale",
                },
              ],
            },
          ],
          createdAt: 1_700_000_110,
        },
        {
          findingId: "finding-3",
          kind: "hypothesis",
          lifecycle: "accepted",
          title: "Connection pool exhaustion is the trigger",
          whyItMatters: "Pool metrics spike before the first timeout.",
          policyBindingStatus: "unbound_legacy",
          hasSavedView: false,
          citations: [
            {
              evidenceId: "ev-2",
              evidenceTitle: "Pool saturation window",
              references: [
                {
                  corpusId: "corpus-1234abcd",
                  seq: 9,
                  source: "worker/worker.log",
                  timestampHint: 1_700_000_009,
                  timeQualityHint: "wall",
                  status: "missing",
                },
              ],
            },
          ],
          createdAt: 1_700_000_120,
        },
      ],
      timeline: {
        entries: [
          {
            corpusId: "corpus-1234abcd",
            seq: 4,
            source: "api/app.jsonl",
            timestampHint: 1_700_000_004,
            timeQualityHint: "wall",
            evidenceId: "ev-1",
            evidenceTitle: "Checkout timeout cluster",
            status: "verified",
          },
          {
            corpusId: "corpus-1234abcd",
            seq: 7,
            source: "api/app.jsonl",
            timestampHint: 1_700_000_007,
            timeQualityHint: "wall",
            evidenceId: "ev-3",
            evidenceTitle: "Worker saturation window",
            status: "stale",
          },
          {
            corpusId: "corpus-1234abcd",
            seq: 9,
            source: "worker/worker.log",
            timestampHint: 1_700_000_009,
            timeQualityHint: "order_only",
            evidenceId: "ev-2",
            evidenceTitle: "Pool saturation window",
            status: "missing",
          },
        ],
        omittedCount: 3,
      },
    },
    markdown: EXACT_MARKDOWN,
    exportId: "rep-visual-1",
    exportBytes: EXACT_MARKDOWN.length,
    exportUnavailableReason: null,
  };
}

export const proposedSectionView: ProposedReportSectionView = {
  id: "prop-report-1",
  kind: "executive_summary",
  body: "Retries amplified a database timeout into checkout failure.",
  status: "proposed",
  evidenceIdCount: 1,
  findingIdCount: 1,
  noteIdCount: 0,
  provenanceLabel: "Agent proposed",
};

/**
 * Deterministic multi-line export markdown whose longest line exceeds any
 * dialog width, so the export preview must scroll BOTH axes inside the pre
 * (investigation-report.css:189-202 `overflow: auto; white-space: pre;
 * max-height: 20rem`).
 */
/** A preview whose retained artifact is long and wide — export dialog fixture. */
export function exportMarkdownFixture(): LogInvestigationReportPreviewDto {
  const wide =
    "| seq 4 · api/app.jsonl · [verified] · Checkout timeout cluster |".repeat(
      4,
    );
  const lines = [
    "# Investigation report — Checkout latency regression",
    "",
    wide,
    "",
    ...Array.from(
      { length: 40 },
      (_, i) => `- [verified] seq ${i + 1} · api/app.jsonl · exact reference`,
    ),
  ];
  const markdown = `${lines.join("\n")}\n`;
  return {
    ...reportPreviewFixture(),
    markdown,
    exportId: "rep-1",
    exportBytes: new TextEncoder().encode(markdown).length,
    exportUnavailableReason: null,
  };
}

export function corpora(): LogCorpusSummaryDto[] {
  return [
    {
      id: "c1",
      name: "checkout-incident",
      eventCount: 1200,
      templateCount: 40,
      engine: "drain",
      createdAt: 1_700_000_000,
      sourceLabel: null,
      stats: null,
      topTemplates: [],
    },
    {
      id: "c2",
      name: "worker-fleet",
      eventCount: 34_800,
      templateCount: 96,
      engine: "drain",
      createdAt: 1_700_000_050,
      sourceLabel: null,
      stats: null,
      topTemplates: [],
    },
  ];
}

export function resolvedInvestigation(): ResolvedInvestigationDocumentDto {
  return {
    document: {
      schemaVersion: 6,
      id: "inv-1",
      revision: 4,
      title: "Checkout latency regression",
      status: "active",
      corpusLinks: [{ corpusId: "c1" }],
      evidence: [
        {
          id: "ev-1",
          title: "Checkout timeout cluster",
          provenance: "human",
          corpusId: "c1",
          eventRefs: [
            {
              corpusId: "c1",
              seq: 4,
              source: "api/app.jsonl",
              timestampHint: 1_700_000_004,
              timeQualityHint: "wall",
            },
          ],
          createdAt: 1_700_000_100,
          updatedAt: 1_700_000_100,
        },
      ],
      findings: [],
      notes: [],
      proposedFindings: [],
      reportSections: [
        {
          id: "sec-1",
          kind: "executive_summary",
          body: "Retries amplified a database timeout into checkout failure.",
          evidenceIds: ["ev-1"],
          findingIds: [],
          noteIds: [],
          provenance: "human",
          acceptedFromProposalId: "prop-9",
          createdAt: 1_700_000_300,
          updatedAt: 1_700_000_300,
        },
        {
          id: "sec-2",
          kind: "next_actions",
          body: "Roll back the retry policy and re-run the load test.",
          evidenceIds: [],
          findingIds: ["finding-1"],
          noteIds: [],
          provenance: "human",
          acceptedFromProposalId: null,
          createdAt: 1_700_000_320,
          updatedAt: 1_700_000_320,
        },
      ],
      proposedReportSections: [
        {
          id: "prop-report-1",
          status: "proposed",
          kind: "executive_summary",
          body: "Retries amplified a database timeout into checkout failure.",
          evidenceIds: ["ev-1"],
          findingIds: [],
          noteIds: [],
          corpusId: "c1",
          investigationId: "inv-1",
          provenance: {
            source: "model",
            toolName: "propose_report_section",
          },
          idempotencyKey: "idem-1",
          createdAt: 1_700_000_200,
          updatedAt: 1_700_000_200,
        },
      ],
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_200,
    },
    evidence: [],
    findings: [],
  };
}

/**
 * The Explorer desktop grid gives the Investigation rail a fixed 300px column
 * (log-explorer.css:405 `grid-template-columns: 220px 6px 1fr 6px 300px`).
 * This frame reproduces that track so the report surface renders at its
 * natural rail width.
 */
export const RAIL_WIDTH = 300;

/** The pane report column caps at the shared reading measure (tokens.css:42). */
export const CHAT_MEASURE_PX = 52 * 16;

export function ReportFrame({
  children,
  width,
}: {
  children: ReactNode;
  width: number | string;
}) {
  const style: CSSProperties = { width };
  return (
    <div data-testid="report-frame" style={style}>
      {children}
    </div>
  );
}
