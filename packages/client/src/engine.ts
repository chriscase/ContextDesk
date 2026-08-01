/**
 * Transport-neutral engine client surface for the unified import flow.
 *
 * The UI consumes exactly this interface; adapters satisfy it. The Tauri
 * adapter lives in `desktop/src/lib/engine/` (the sanctioned host-boundary
 * home), the deterministic mock in this package. Wire shapes reuse
 * `@contextdesk/contracts` wherever a frozen contract exists so a drifting
 * host surfaces as a `ContractViolation`, not a silent mismatch.
 */
import type { WireImportPreviewPlan, WireProcessProgress } from "@contextdesk/contracts";

/** Stable classification of an engine failure for UI branching. */
export type EngineErrorCode =
  /** The user (or a supervisor) cancelled the operation. */
  | "cancelled"
  /** The request raced a newer state: stale revision or preview token. */
  | "conflict"
  /** The request itself is not runnable (for example zero importable sources). */
  | "invalid"
  /** Anything else the engine reported. The raw message is preserved. */
  | "failed";

/** Typed engine failure preserving the engine's own message verbatim. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/** Classify a raw engine message into an [`EngineErrorCode`]. */
export function classifyEngineMessage(message: string): EngineErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("cancel")) return "cancelled";
  if (lower.includes("stale") || lower.includes("token no longer matches")) {
    return "conflict";
  }
  if (lower.includes("already running")) return "conflict";
  if (
    lower.includes("no safe/importable log events") ||
    lower.includes("no importable log file entries") ||
    lower.includes("selection lists") ||
    lower.includes("import plan")
  ) {
    return "invalid";
  }
  return "failed";
}

/** Per-source import confidence as the host reports it (camelCase wire). */
export type ImportSourceConfidence = {
  source: string;
  lines: number;
  formatId?: string;
  formatVersion?: number;
  outcome: "matched" | "ambiguous" | "unknown";
  runnerUpMargin?: number;
  producerHint?: string;
  timeQuality: "wall" | "mixed" | "order_only";
  /** Omitted by the Rust wire when the source has no unresolved-time reason. */
  unresolvedReasons?: ("no_timezone" | "zone_abbreviation_not_resolved")[];
  /** Omitted by the Rust wire when there are no bounded timestamp samples. */
  timestampPrefixSamples?: string[];
};

/** Import confidence report subset the flow consumes. */
export type ImportConfidence = {
  corpusTimeQuality: "wall" | "mixed" | "order_only";
  counts: {
    wall: number;
    orderOnly: number;
    mixed: number;
    matched: number;
    ambiguous: number;
    unknown: number;
    unresolved: number;
  };
  sources: ImportSourceConfidence[];
};

/** Result of a completed (published) import run. */
export type ImportRunReport = {
  corpusId: string;
  lines: number;
  files: number;
  discoveredFiles: number;
  excludedFiles: number;
  failedFiles: number;
  ignoredFiles: number;
  exclusionCounts: Record<string, number>;
  exclusionExamples: string[];
  partial: boolean;
  confidence: ImportConfidence;
};

/** Request for a reviewed, plan-bound import run. */
export type ImportRunRequest = {
  /** Root path exactly as previewed. */
  path: string;
  /** Corpus display name. */
  name?: string;
  /** Token from the reviewed [`WireImportPreviewPlan`]. */
  planToken: string;
  /** Plan contract version from the same plan. */
  planVersion: number;
  /** Exact reviewed identities that may produce log events. */
  selected: string[];
};

/** One saved timezone declaration (host wire shape). */
export type TimezoneDeclaration = {
  source: string;
  ianaZone: string;
  basis: "user_declared";
  declaredAt: number;
  appliedRevision: number;
};

/** Per-source timestamp state for the review workflow (host wire shape). */
export type TimezoneSourceStatus = {
  source: string;
  unresolvedLocalRecords: number;
  resolvedLocalRecords: number;
  explicitWallClockRecords: number;
  otherOrderOnlyRecords: number;
};

/** Durable timezone review state for one corpus revision (host wire shape). */
export type TimezoneState = {
  corpusId: string;
  eventRevision: number;
  declarations: Record<string, TimezoneDeclaration>;
  sources: TimezoneSourceStatus[];
};

/** Read-only preview of one source under one zone (host wire shape). */
export type TimezonePreview = {
  corpusId: string;
  eventRevision: number;
  source: string;
  ianaZone: string;
  previewToken: string;
  affectedRecords: number;
  existingWallClockRecords: number;
  firstResolvedTs: number | null;
  lastResolvedTs: number | null;
  dstGapRecords: number;
  dstFoldAmbiguities: number;
  unchangedOrderOnlyRecords: number;
  unsupportedTimestampRecords: number;
  outOfRangeRecords: number;
  precision: "whole_second";
};

/** One source's share of an atomic multi-source apply. */
export type TimezoneApplyRequest = {
  source: string;
  ianaTimezone: string;
  previewToken: string;
};

/** Published event-revision outcome. */
export type EventRevisionReport = {
  revision: number;
  previousRevision: number;
  changedEvents: number;
  eventCount: number;
  tsMin: number | null;
  tsMax: number | null;
};

/** Unsubscribe handle. */
export type Unsubscribe = () => void;

/** Import planning and execution. */
export interface ImportService {
  /** Bounded read-only preview bound into a runnable plan. */
  preview(path: string): Promise<WireImportPreviewPlan>;
  /**
   * Run a reviewed import. The engine re-enumerates and fails closed
   * (`invalid`) on a stale plan, drifted content, non-event selections, or
   * an empty selection — before any staging.
   */
  run(request: ImportRunRequest): Promise<ImportRunReport>;
  /** Request cancellation of the running import. Resolves whether a run was live. */
  cancel(): Promise<boolean>;
}

/** Timezone review over a published corpus. */
export interface TimeService {
  state(corpusId: string): Promise<TimezoneState>;
  preview(
    corpusId: string,
    eventRevision: number,
    source: string,
    ianaZone: string,
  ): Promise<TimezonePreview>;
  /** Atomic multi-source apply; any stale token rejects the whole request. */
  applyMany(
    corpusId: string,
    expectedRevision: number,
    requests: TimezoneApplyRequest[],
  ): Promise<EventRevisionReport>;
  /** One-step undo of the current revision (publishes forward). */
  undo(corpusId: string, expectedRevision: number): Promise<EventRevisionReport>;
}

/** Host progress event stream. */
export interface EngineEvents {
  onProcessProgress(listener: (progress: WireProcessProgress) => void): Unsubscribe;
}

/** The transport-neutral engine client the import flow consumes. */
export interface EngineClient {
  import: ImportService;
  time: TimeService;
  events: EngineEvents;
}
