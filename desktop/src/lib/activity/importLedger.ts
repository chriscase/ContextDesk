/**
 * Import ledger — pure projection of one import attempt into (a) the
 * compact one-line summary, (b) detailed ledger sections, and (c) host
 * activity entries. Every statement is derived from data the host
 * actually reported; where a fact is a product contract rather than a
 * per-run measurement (redaction, local-only ingest) the wording says so
 * plainly instead of implying a per-run proof.
 */
import type {
  ImportRunInput,
  ImportReportInput,
  TimeQuality,
} from "./types";

export type LedgerRow = { term: string; detail: string };
export type LedgerSection = {
  id:
    | "inclusion"
    | "parsing"
    | "redaction"
    | "timestamps"
    | "indexing"
    | "hooks";
  title: string;
  rows: LedgerRow[];
};

export type CompactImportSummary = {
  outcome: ImportRunInput["outcome"];
  /** "12/14 files imported · 2 ignored · 0 failed" */
  filesLine: string;
  /** "25,000 events · 10 templates" (absent when nothing was published) */
  eventsLine: string | null;
  /** "in 4.2 s" */
  elapsedLine: string;
  /** "wall clock" | "mixed time quality" | "order only (not calendar time)" | null */
  timestampQuality: string | null;
  /** "Keyword analysis" | "Semantic (model …)" | … | null */
  analysisMode: string | null;
};

const nf = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return nf.format(n);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.floor(ms)} ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
  return `${Math.floor(secs / 60)}m ${Math.floor(secs % 60)}s`;
}

/** Same honesty wording the Explorer uses for `timeQuality`. */
export function timeQualityLabel(quality: TimeQuality): string {
  switch (quality) {
    case "wall":
      return "wall clock";
    case "mixed":
      return "mixed time quality";
    case "order_only":
      return "order only (not calendar time)";
  }
}

function analysisModeLabel(report: ImportReportInput): string | null {
  const embedding = report.embedding;
  if (!embedding) {
    return report.embedded > 0 ? "Semantic analysis" : "Keyword analysis";
  }
  switch (embedding.state) {
    case "keyword_only":
      return "Keyword analysis (no model)";
    case "deferred":
      return "Keyword analysis (embedding deferred)";
    case "partial":
      return `Semantic (partial${embedding.modelId ? ` · ${embedding.modelId}` : ""})`;
    case "complete":
      return `Semantic${embedding.modelId ? ` (${embedding.modelId})` : ""}`;
  }
}

export function compactImportSummary(run: ImportRunInput): CompactImportSummary {
  const report = run.report ?? null;
  const elapsedLine = `in ${formatElapsed(run.endedAtMs - run.startedAtMs)}`;
  if (!report) {
    return {
      outcome: run.outcome,
      filesLine:
        run.outcome === "cancelled"
          ? "Import cancelled — nothing published"
          : "Import failed — nothing published",
      eventsLine: null,
      elapsedLine,
      timestampQuality: null,
      analysisMode: null,
    };
  }
  const filesParts = [
    `${formatCount(report.files)}/${formatCount(report.discoveredFiles)} files imported`,
  ];
  if (report.excludedFiles > 0) {
    filesParts.push(`${formatCount(report.excludedFiles)} excluded`);
  }
  if (report.ignoredFiles > 0) {
    filesParts.push(`${formatCount(report.ignoredFiles)} ignored`);
  }
  if (report.failedFiles > 0) {
    filesParts.push(`${formatCount(report.failedFiles)} failed`);
  }
  return {
    outcome: run.outcome,
    filesLine: filesParts.join(" · "),
    eventsLine: `${formatCount(report.lines)} events · ${formatCount(report.templates)} templates`,
    elapsedLine,
    timestampQuality: report.confidence
      ? timeQualityLabel(report.confidence.corpusTimeQuality)
      : null,
    analysisMode: analysisModeLabel(report),
  };
}

export function importLedgerSections(run: ImportRunInput): LedgerSection[] {
  const sections: LedgerSection[] = [];
  const report = run.report ?? null;
  const diagnostic = run.diagnostic ?? null;

  // Inclusion / exclusion ---------------------------------------------------
  {
    const rows: LedgerRow[] = [];
    if (report) {
      rows.push({
        term: "Examined",
        detail: `${formatCount(report.discoveredFiles)} files discovered (${formatBytes(report.sourceBytes)})`,
      });
      rows.push({
        term: "Imported",
        detail: `${formatCount(report.files)} files → ${formatCount(report.lines)} events`,
      });
      const exclusions = Object.entries(report.exclusionCounts);
      if (exclusions.length > 0) {
        rows.push({
          term: "Excluded",
          detail: exclusions
            .map(([reason, count]) => `${reason}: ${formatCount(count)}`)
            .join(" · "),
        });
      }
      if (report.exclusionExamples.length > 0) {
        rows.push({
          term: "Excluded identities",
          detail: `${formatCount(report.exclusionExamples.length)} bounded examples are available in Import confidence; Activity does not retain source names`,
        });
      }
      if (report.ignoredFiles > 0 || report.failedFiles > 0) {
        rows.push({
          term: "Not imported",
          detail: `${formatCount(report.ignoredFiles)} ignored · ${formatCount(report.failedFiles)} failed`,
        });
      }
      if (report.partial) {
        rows.push({
          term: "Coverage",
          detail: "Partial — some discovered files were not imported (see above)",
        });
      }
    }
    if (diagnostic) {
      const sc = diagnostic.evidence.scanCounts;
      rows.push({
        term: run.outcome === "cancelled" ? "Cancelled" : "Failed",
        detail: diagnostic.cancelled
          ? "Host confirmed cancellation; source-specific detail stays in the dedicated diagnostic view"
          : "Host returned a failure diagnostic; source-specific detail stays in the dedicated diagnostic view",
      });
      rows.push({
        term: "Scan skips",
        detail: `binary ${sc.binary} · empty ${sc.empty} · hidden ${sc.hidden} · oversized ${sc.oversized} · read-failed ${sc.readFailed} · parse-failed ${sc.parseFailed}`,
      });
      rows.push({
        term: "Published",
        detail: "Nothing — no corpus was created by this attempt",
      });
    }
    if (rows.length > 0) {
      sections.push({ id: "inclusion", title: "Inclusion & exclusion", rows });
    }
  }

  // Parser / format ---------------------------------------------------------
  if (report) {
    const rows: LedgerRow[] = [];
    const formats = Object.entries(report.formatCounts);
    if (formats.length > 0) {
      rows.push({
        term: "Formats",
        detail: formats
          .map(([format, count]) => `${format}: ${formatCount(count)}`)
          .join(" · "),
      });
    }
    if (report.confidence) {
      const c = report.confidence.counts;
      rows.push({
        term: "Format confidence",
        detail: `${formatCount(c.matched)} matched · ${formatCount(c.ambiguous)} ambiguous · ${formatCount(c.unknown)} unknown`,
      });
      if (report.confidence.sources.length > 0) {
        rows.push({
          term: "Per-source detail",
          detail: `${formatCount(report.confidence.sources.length)} sources are available in Import confidence; Activity does not retain their names`,
        });
      }
    }
    if (rows.length > 0) {
      sections.push({ id: "parsing", title: "Parser & format", rows });
    }
  }

  // Redaction / normalization ----------------------------------------------
  sections.push({
    id: "redaction",
    title: "Redaction & normalization",
    rows: [
      {
        term: "Redaction",
        detail:
          "Secrets are redacted during streaming ingest, before anything is persisted (standing import contract — not a per-run measurement).",
      },
      {
        term: "Normalization",
        detail: report
          ? `Events grouped into ${formatCount(report.templates)} learned templates (${report.reductionRatio.toFixed(1)}× grouping)`
          : "Not reached — no events were published.",
      },
    ],
  });

  // Timestamp / timezone provenance ----------------------------------------
  if (report) {
    const rows: LedgerRow[] = [];
    if (report.confidence) {
      const c = report.confidence.counts;
      rows.push({
        term: "Corpus time quality",
        detail: timeQualityLabel(report.confidence.corpusTimeQuality),
      });
      rows.push({
        term: "Per-source",
        detail: `${formatCount(c.wall)} wall-clock · ${formatCount(c.mixed)} mixed · ${formatCount(c.orderOnly)} order-only · ${formatCount(c.unresolved)} unresolved timezone`,
      });
      const unresolved = report.confidence.sources.filter(
        (s) => (s.unresolvedReasons?.length ?? 0) > 0,
      );
      if (unresolved.length > 0) {
        rows.push({
          term: "Awaiting timezone",
          detail: `${unresolved.length} source(s) hold exact local times that need a timezone declaration before they become calendar time`,
        });
      }
    } else {
      rows.push({
        term: "Corpus time quality",
        detail: "Not reported for this import",
      });
    }
    if (report.tsMin != null && report.tsMax != null) {
      rows.push({
        term: "Evidence range",
        detail: "Client incident time — shown on the evidence timeline, never merged with ContextDesk runtime",
      });
    }
    sections.push({
      id: "timestamps",
      title: "Timestamp & timezone provenance",
      rows,
    });
  }

  // Indexing / templates ----------------------------------------------------
  if (report) {
    sections.push({
      id: "indexing",
      title: "Indexing & templates",
      rows: [
        {
          term: "Templates",
          detail: `${formatCount(report.templates)} learned · ${formatCount(report.embedded)} embedded`,
        },
        {
          term: "Corpus size",
          detail: `${formatBytes(report.corpusBytes)} on disk (from ${formatBytes(report.sourceBytes)} source)`,
        },
      ],
    });
  }

  // Optional model / network hooks ------------------------------------------
  {
    const rows: LedgerRow[] = [];
    const embedding = report?.embedding ?? null;
    const modelRan =
      embedding != null &&
      (embedding.state === "partial" || embedding.state === "complete");
    rows.push({
      term: "Model hook",
      detail: modelRan
        ? `Local embedding model ran${embedding.modelId ? ` (${embedding.modelId})` : ""} — trigger: optional embedding phase of this import · data scope: learned templates of this corpus only`
        : embedding?.state === "deferred"
          ? "Deferred — no model ran during this import"
          : "None ran during this import",
    });
    rows.push({
      term: "Network",
      detail:
        "Log ingest runs locally; no network access is part of the import pipeline (standing contract).",
    });
    sections.push({ id: "hooks", title: "Model & network hooks", rows });
  }

  return sections;
}
