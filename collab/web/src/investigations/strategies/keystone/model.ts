import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  EvidenceWithAnnotation,
} from "../../runtime/public.js";

export type KeystoneStatusFilter = "all" | CaseV1["status"];
export type KeystoneInspectorTab = "details" | "reasoning" | "record";
export type KeystoneEvidenceRow = EvidenceWithAnnotation<ArtifactV1, ContributionV1>;

export function recordedText(value: string | null | undefined): string {
  return value?.trim() || "Not recorded";
}

export function investigationTitle(investigation: CaseV1): string {
  return investigation.title.trim() || "Untitled investigation";
}

export function evidenceName(evidence: ArtifactV1): string {
  return evidence.filename?.trim()
    || evidence.relativePath?.trim()
    || evidence.uri?.trim()
    || "Unnamed evidence";
}

export function byteLengthLabel(value: number | null): string {
  return value === null ? "Not recorded" : `${value.toLocaleString()} bytes`;
}

/**
 * Filters the authoritative collection without sorting it. The server-provided
 * order remains visible; Keystone does not manufacture priority or recency.
 */
export function filterInvestigations(
  investigations: readonly CaseV1[],
  query: string,
  status: KeystoneStatusFilter,
): readonly CaseV1[] {
  const normalized = query.trim().toLocaleLowerCase();
  return investigations.filter((investigation) => {
    if (status !== "all" && investigation.status !== status) return false;
    if (!normalized) return true;
    const context = investigation.investigationContext;
    const searchable = [
      investigation.id,
      investigation.title,
      investigation.problemStatement,
      investigation.affectedParties,
      investigation.impact,
      investigation.scope,
      context?.productName,
      context?.version,
      context?.build,
      context?.component,
      context?.environment,
      context?.organization,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}

/** Evidence filtering also preserves the server-provided inventory order. */
export function filterEvidence(
  rows: readonly KeystoneEvidenceRow[],
  query: string,
): readonly KeystoneEvidenceRow[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return rows;
  return rows.filter(({ evidence, annotation }) => [
    evidence.id,
    evidenceName(evidence),
    evidence.kind,
    evidence.mediaType,
    evidence.verificationStatus,
    evidence.privacyClass,
    evidence.sourceId,
    evidence.relativePath,
    annotation?.body,
    annotation?.authorUsername,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase()
    .includes(normalized));
}

export function contributionsLinkedToEvidence(
  evidence: ArtifactV1 | null,
  annotation: ContributionV1 | null,
  contributions: readonly ContributionV1[],
): readonly ContributionV1[] {
  if (evidence === null) return contributions;
  const linkedIds = new Set([evidence.id]);
  if (annotation !== null) linkedIds.add(annotation.id);
  return contributions.filter((contribution) => {
    if (contribution.id === annotation?.id) return true;
    return contribution.hypothesisLinks?.some((link) => linkedIds.has(link.id)) ?? false;
  });
}

export function reconcileWorkingSet(
  selected: readonly string[],
  available: readonly KeystoneEvidenceRow[],
): readonly string[] {
  const availableIds = new Set(available.map(({ evidence }) => evidence.id));
  return selected.filter((id) => availableIds.has(id));
}
