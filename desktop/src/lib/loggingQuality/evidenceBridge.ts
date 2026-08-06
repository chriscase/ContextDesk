/**
 * Pure planning for "Show in Explorer" from assessment evidence.
 * Never fabricates event citations. Caps lanes at 1–4. Fails closed when
 * more than 4 distinct portable sources would be required.
 */

import type {
  LoggingQualityEvidenceLocator,
  LoggingQualityFinding,
} from "./types";

export const MAX_EVIDENCE_LANES = 4;

export type LanePlan = {
  id: string;
  label: string;
  sources: string[];
};

export type ShowInExplorerPlan =
  | {
      kind: "lanes";
      lanes: LanePlan[];
      /** Template ids mentioned (no event fabrication). */
      templateIds: number[];
      note: string | null;
    }
  | {
      kind: "aggregate_only";
      reason: string;
      /** Open corpus Explorer without inventing event citations. */
      openCorpus: true;
    }
  | {
      kind: "fail_closed";
      reason: string;
    };

function isPortableSource(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith("/") || t.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return false;
  if (t.includes("\0")) return false;
  return true;
}

/**
 * Resolve SourceAggregate keys through the host map; collect template ids.
 * Aggregate-only findings (corpus_metric / selection_bucket only) never invent events.
 */
export function planShowInExplorer(
  finding: LoggingQualityFinding,
  sourceKeyMap: Record<string, string>,
): ShowInExplorerPlan {
  const portableSources: string[] = [];
  const templateIds: number[] = [];
  let sawAggregateOnlyKind = false;
  let sawResolvableSource = false;

  for (const loc of finding.evidence) {
    if (loc.kind === "source_aggregate") {
      const portable = sourceKeyMap[loc.key];
      if (portable && isPortableSource(portable)) {
        portableSources.push(portable);
        sawResolvableSource = true;
      } else if (isPortableSource(loc.key) && !loc.key.startsWith("src_")) {
        // Defensive: some locators may carry portable identity as key.
        portableSources.push(loc.key);
        sawResolvableSource = true;
      }
    } else if (loc.kind === "template") {
      // Core emits `template_id:<id>`; accept a bare numeric key as a
      // compatibility shape. `value` is the event count, never an id.
      const rawId = loc.key.startsWith("template_id:")
        ? loc.key.slice("template_id:".length)
        : loc.key;
      const id = Number(rawId);
      if (Number.isSafeInteger(id) && id >= 0) templateIds.push(id);
    } else if (loc.kind === "corpus_metric" || loc.kind === "selection_bucket") {
      sawAggregateOnlyKind = true;
    }
  }

  const uniqueSources = [...new Set(portableSources)];
  const uniqueTemplates = [...new Set(templateIds)];

  if (uniqueSources.length > MAX_EVIDENCE_LANES) {
    return {
      kind: "fail_closed",
      reason: `This finding references ${uniqueSources.length} sources; Explorer evidence lanes are limited to ${MAX_EVIDENCE_LANES}. Narrow the finding or inspect sources from the catalog instead of auto-applying lanes.`,
    };
  }

  if (uniqueSources.length > 0) {
    const lanes: LanePlan[] = uniqueSources.map((source, i) => ({
      id: `lane-${i}`,
      label: source,
      sources: [source],
    }));
    return {
      kind: "lanes",
      lanes,
      templateIds: uniqueTemplates,
      note:
        uniqueTemplates.length > 0
          ? `Template id(s) ${uniqueTemplates.join(", ")} are review signals only — no event citations were fabricated.`
          : null,
    };
  }

  // No portable sources: aggregate-only or template-only honesty.
  if (uniqueTemplates.length > 0 || sawAggregateOnlyKind || finding.evidence.length === 0) {
    return {
      kind: "aggregate_only",
      openCorpus: true,
      reason: sawResolvableSource
        ? "Evidence could not be resolved to portable sources."
        : "This finding is backed by aggregate corpus metrics only. No event citations were fabricated. Opening the corpus Explorer for source-level review.",
    };
  }

  return {
    kind: "aggregate_only",
    openCorpus: true,
    reason:
      "No host-resolved portable sources or event citations are available for this finding.",
  };
}

/** True when every evidence locator is aggregate-level (no event fabrication possible). */
export function findingIsAggregateOnly(
  evidence: readonly LoggingQualityEvidenceLocator[],
): boolean {
  if (evidence.length === 0) return true;
  return evidence.every(
    (e) => e.kind === "corpus_metric" || e.kind === "selection_bucket",
  );
}
