export const RECORDED_CONTEXT_FIELDS = [
  "productName",
  "version",
  "build",
  "component",
  "environment",
  "organization",
] as const;

export type RecordedContextField = (typeof RECORDED_CONTEXT_FIELDS)[number];

export interface RecordedContextRecord {
  readonly investigationContext?: Partial<Record<RecordedContextField, string>> | null;
}
export type RecordedContextCatalogStatus =
  | "not-requested"
  | "loading"
  | "empty"
  | "unavailable"
  | "available"
  | "stale";

export interface RecordedContextCatalog {
  readonly status: RecordedContextCatalogStatus;
  readonly records: readonly RecordedContextRecord[];
}

interface ResourceViewLike {
  readonly availability: "idle" | "loading" | "available" | "unavailable";
  readonly value?: readonly RecordedContextRecord[];
  readonly refresh?: "settled" | "loading" | "failed";
}

/** Maps an already-authorized Runtime list into presentation-only suggestion state. */
export function recordedContextCatalogFromView(
  view: ResourceViewLike,
  canRead: boolean,
): RecordedContextCatalog {
  if (!canRead) return { status: "not-requested", records: [] };
  if (view.availability === "unavailable") return { status: "unavailable", records: [] };
  if (view.availability !== "available") return { status: "loading", records: [] };
  const records = view.value ?? [];
  if (view.refresh === "failed") return { status: "stale", records };
  return { status: records.length === 0 ? "empty" : "available", records };
}

function recordedLiteral(record: RecordedContextRecord, field: RecordedContextField): string | null {
  const value = record.investigationContext?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function matchingRecords(
  records: readonly RecordedContextRecord[],
  field: RecordedContextField,
  draft: Partial<Record<RecordedContextField, string>>,
): readonly RecordedContextRecord[] {
  if (field === "version" && draft.productName) {
    const matches = records.filter((record) => recordedLiteral(record, "productName") === draft.productName);
    if (matches.length > 0) return matches;
  }
  if (field === "build" && draft.productName && draft.version) {
    const matches = records.filter((record) => recordedLiteral(record, "productName") === draft.productName
      && recordedLiteral(record, "version") === draft.version);
    if (matches.length > 0) return matches;
  }
  return records;
}

/**
 * Returns first-seen literals exactly as recorded. This deliberately performs
 * no trimming, case folding, sorting, aliasing, semver interpretation, or
 * deduplication beyond exact byte equality.
 */
export function recordedContextOptions(
  records: readonly RecordedContextRecord[],
  field: RecordedContextField,
  draft: Partial<Record<RecordedContextField, string>> = {},
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const record of matchingRecords(records, field, draft)) {
    const value = recordedLiteral(record, field);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
