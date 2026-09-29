/** Suggestions are a bounded view of already loaded, authorized records, never a catalog. */
export const RECORDED_CONTEXT_LIMIT = 100;
export const RECORDED_CONTEXT_FIELDS = ["productName", "version", "build", "component", "environment", "organization"] as const;
export type RecordedContextField = (typeof RECORDED_CONTEXT_FIELDS)[number];
export type RecordedContextDraft = Record<RecordedContextField, string>;
export interface RecordedContextRecord {
  readonly investigationContext?: Partial<Record<RecordedContextField, string | null>> | null;
}
export type RecordedContextStatus = "not-requested" | "idle" | "loading" | "refreshing" | "available" | "empty" | "stale" | "unavailable";
export interface RecordedContextCatalog {
  readonly status: RecordedContextStatus;
  readonly records: readonly RecordedContextRecord[];
  /** This may be a query-filtered page; no claim of global completeness is made. */
  readonly partial: boolean;
}

interface ResourceViewLike {
  readonly availability: "idle" | "loading" | "available" | "unavailable";
  readonly value?: readonly RecordedContextRecord[];
  readonly refresh?: "settled" | "loading" | "failed";
}

export function recordedContextCatalogFromView(
  view: ResourceViewLike,
  canRead: boolean,
  partial = true,
): RecordedContextCatalog {
  if (!canRead) return { status: "not-requested", records: [], partial };
  if (view.availability === "unavailable") return { status: "unavailable", records: [], partial };
  if (view.availability === "idle") return { status: "idle", records: [], partial };
  if (view.availability === "loading") return { status: "loading", records: [], partial };
  const records = view.value ?? [];
  if (view.refresh === "loading") return { status: "refreshing", records, partial };
  if (view.refresh === "failed") return { status: "stale", records, partial };
  return { status: records.length === 0 ? "empty" : "available", records, partial };
}

function literal(record: RecordedContextRecord, field: RecordedContextField): string | null {
  const value = record.investigationContext?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export interface BoundedValues<T> {
  readonly values: readonly T[];
  readonly truncated: boolean;
}

/** Exact parent equality; a failed constraint never falls back to unrelated records. */
export function recordedContextOptions(
  records: readonly RecordedContextRecord[],
  field: RecordedContextField,
  draft: Partial<RecordedContextDraft> = {},
): BoundedValues<string> {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const record of records) {
    if ((field === "version" || field === "build")
      && draft.productName?.trim()
      && literal(record, "productName") !== draft.productName) continue;
    if (field === "build" && draft.version?.trim()
      && literal(record, "version") !== draft.version) continue;
    const value = literal(record, field);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    if (values.length < RECORDED_CONTEXT_LIMIT) values.push(value);
    else return { values, truncated: true };
  }
  return { values, truncated: false };
}

export interface RecordedContextTuple {
  readonly productName: string;
  readonly version: string;
  readonly build: string;
  readonly key: string;
}

/** JSON array encoding preserves exact strings and cannot collide on delimiters. */
export function recordedContextTupleKey(productName: string, version: string, build: string): string {
  return JSON.stringify([productName, version, build]);
}

export function recordedContextTuples(records: readonly RecordedContextRecord[]): BoundedValues<RecordedContextTuple> {
  const seen = new Set<string>();
  const values: RecordedContextTuple[] = [];
  for (const record of records) {
    const productName = literal(record, "productName") ?? "";
    const version = literal(record, "version") ?? "";
    const build = literal(record, "build") ?? "";
    if (!productName && !version && !build) continue;
    const key = recordedContextTupleKey(productName, version, build);
    if (seen.has(key)) continue;
    seen.add(key);
    if (values.length < RECORDED_CONTEXT_LIMIT) values.push({ productName, version, build, key });
    else return { values, truncated: true };
  }
  return { values, truncated: false };
}
