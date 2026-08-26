/**
 * The host boundary between the War Room server and the shipped desktop
 * log-analysis pipeline.
 *
 * Every timestamp decision — parsing, IANA rules, DST gaps and folds, revision
 * publication — is made by `contextdesk collab-log-time`, which delegates to
 * `cd-core`. Nothing in this file interprets a timestamp. It marshals a bounded
 * request, runs one short-lived process, and validates the envelope that comes
 * back.
 */
import { spawn } from "node:child_process";

/** Stable request/result identities shared with the Rust boundary. */
export const LOG_TIME_REQUEST_SCHEMA_ID = "cd-collab.log_time_request.v1" as const;
export const LOG_TIME_RESULT_SCHEMA_ID = "cd-collab.log_time_result.v1" as const;

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 5_000;

/** The host refused the request because observed state has moved. */
export class LogTimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogTimeConflictError";
  }
}

/** The named case corpus, source, or declaration does not exist. */
export class LogTimeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogTimeNotFoundError";
  }
}

/** The request was invalid on its face — including an unrecognized zone. */
export class LogTimeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogTimeRequestError";
  }
}

export interface LogTimeBridgeOptions {
  /** Absolute path to the `contextdesk` binary. */
  command: string;
  /** Cache root holding durable case-bound corpora. */
  cacheRoot: string;
  /** Arguments injected before the subcommand (for test shims). */
  prefixArgs?: string[];
  timeoutMs?: number;
}

export interface LogTimeFileInput {
  relativePath: string;
  contentBase64: string;
}

export type LogTimeAction =
  | { kind: "build"; corpusName: string; files: LogTimeFileInput[] }
  | { kind: "status"; corpusId: string }
  | {
      kind: "preview";
      corpusId: string;
      expectedRevision: number;
      source: string;
      ianaTimezone: string;
    }
  | {
      kind: "apply";
      corpusId: string;
      expectedRevision: number;
      source: string;
      ianaTimezone: string;
      declarationFingerprint: string;
      declaredAt: number;
    }
  | { kind: "clear"; corpusId: string; expectedRevision: number; source: string }
  | { kind: "undo"; corpusId: string; expectedRevision: number }
  | {
      kind: "chronology";
      corpusId: string;
      search: string | null;
      sources: string[];
      limit: number;
      cursor: string | null;
    };

export interface HostSourceStatus {
  source: string;
  unresolvedLocalRecords: number;
  resolvedLocalRecords: number;
  explicitWallClockRecords: number;
  otherOrderOnlyRecords: number;
}

export interface HostDeclaration {
  source: string;
  ianaTimezone: string;
  basis: "user_declared" | "configured_default";
  declaredAt: number;
  appliedRevision: number;
}

export interface HostSample {
  ordinal: number;
  outcome: "resolved" | "unresolved" | "existing_wall_clock";
  rawTimestamp: string | null;
  normalizedInstant: string | null;
  utcOffsetSeconds: number | null;
  unresolvedReason: string | null;
  excerpt: string;
}

export interface HostPreview {
  declarationFingerprint: string;
  source: string;
  ianaTimezone: string;
  affectedRecords: number;
  existingWallClockRecords: number;
  unchangedOrderOnlyRecords: number;
  firstResolvedInstant: string | null;
  lastResolvedInstant: string | null;
  dstGapCount: number;
  dstFoldCount: number;
  unsupportedTimestampCount: number;
  zoneAbbreviationMismatchCount: number;
  outOfRangeCount: number;
  samples: HostSample[];
}

export interface HostRevision {
  previousRevision: number;
  appliedRevision: number;
  restoredRevision: number | null;
  changedRecords: number;
  eventCount: number;
}

export interface HostChronologyRow {
  seq: number;
  source: string;
  rawTimestamp: string | null;
  normalizedInstant: string | null;
  timeState: "resolved" | "order_only";
  timestampProvenance:
    | "explicit_wall"
    | "resolved_local"
    | "unresolved_local"
    | "order_only"
    | "legacy_unknown";
  orderOnlyReason:
    | "timezone_unresolved"
    | "no_recognized_local_timestamp"
    | "unsupported_local_timestamp_shape"
    | "ambiguous_dst_fold"
    | "nonexistent_dst_gap"
    | "zone_abbreviation_mismatch"
    | "resolved_instant_out_of_range"
    | null;
  level: string;
  message: string;
}

export interface HostChronology {
  corpusRevision: number;
  rows: HostChronologyRow[];
  nextCursor: string | null;
  totalMatched: number;
  orderOnlyCount: number;
  timeQuality: "wall" | "mixed" | "order_only";
}

export interface HostBuild {
  corpusName: string;
  eventsImported: number;
  sourcesSelected: number;
  sourcesFailed: number;
  partial: boolean;
  timezoneAmbiguousSources: string[];
}

export interface HostResult {
  caseId: string;
  corpusId: string;
  corpusRevision: number;
  build?: HostBuild;
  sources?: HostSourceStatus[];
  preview?: HostPreview;
  revision?: HostRevision;
  chronology?: HostChronology;
  declarations: Record<string, HostDeclaration>;
}

/** Runs one bounded log-time operation on the host pipeline. */
export interface LogTimeBridge {
  run(caseId: string, action: LogTimeAction): Promise<HostResult>;
}

interface CliEnvelope {
  ok?: unknown;
  data?: unknown;
  error?: { kind?: unknown; message?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map the host's stable exit categories onto server-side errors.
 *
 * The message is host-authored and already free of paths and credentials, so it
 * is surfaced verbatim; anything unrecognized collapses to a generic failure
 * rather than leaking an unclassified string.
 */
function raiseFor(kind: string, message: string): never {
  const detail = message.length > 240 ? "invalid" : message;
  if (kind === "conflict") throw new LogTimeConflictError(detail);
  if (kind === "not_found") throw new LogTimeNotFoundError(detail);
  if (kind === "user_error") throw new LogTimeRequestError(detail);
  throw new Error("log-time host operation failed");
}

export class ProcessLogTimeBridge implements LogTimeBridge {
  constructor(private readonly options: LogTimeBridgeOptions) {}

  async run(caseId: string, action: LogTimeAction): Promise<HostResult> {
    const envelope = await this.runProcess({
      schemaId: LOG_TIME_REQUEST_SCHEMA_ID,
      caseId,
      action,
    });

    if (envelope.ok !== true) {
      const error = asRecord(envelope.error) ?? {};
      raiseFor(
        typeof error.kind === "string" ? error.kind : "internal",
        typeof error.message === "string" ? error.message : "unknown host failure",
      );
    }
    const data = asRecord(envelope.data);
    if (!data || data.schemaId !== LOG_TIME_RESULT_SCHEMA_ID) {
      throw new Error("log-time host returned an unrecognized result schema");
    }
    if (data.caseId !== caseId) {
      throw new Error("log-time host returned a different case identity");
    }
    return data as unknown as HostResult;
  }

  private runProcess(request: unknown): Promise<CliEnvelope> {
    const payload = JSON.stringify(request);
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.options.command,
        [
          ...(this.options.prefixArgs ?? []),
          "collab-log-time",
          "--request",
          "-",
          "--cache-root",
          this.options.cacheRoot,
          "--format",
          "json",
        ],
        { shell: false, detached: true, stdio: ["pipe", "pipe", "ignore"] },
      );

      let stdout = "";
      let overflow = false;
      let timedOut = false;
      let forceKill: ReturnType<typeof setTimeout> | null = null;

      const terminate = (signal: NodeJS.Signals) => {
        if (typeof child.pid === "number") {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process group is already gone; fall back to the child.
          }
        }
        child.kill(signal);
      };
      const clearTimers = () => {
        clearTimeout(timeout);
        if (forceKill !== null) {
          clearTimeout(forceKill);
          forceKill = null;
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate("SIGINT");
        forceKill = setTimeout(() => terminate("SIGKILL"), FORCE_KILL_GRACE_MS);
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (overflow) return;
        stdout += chunk;
        if (stdout.length > MAX_STDOUT_BYTES) {
          overflow = true;
          stdout = "";
          terminate("SIGKILL");
        }
      });

      child.on("error", (error) => {
        clearTimers();
        reject(error);
      });
      child.on("close", () => {
        clearTimers();
        if (timedOut) {
          reject(new Error("log-time host operation exceeded its deadline"));
          return;
        }
        if (overflow) {
          reject(new Error("log-time host produced an oversized result"));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as CliEnvelope);
        } catch {
          reject(new Error("log-time host produced a malformed envelope"));
        }
      });

      child.stdin.on("error", () => {
        // A host that exits before reading stdin surfaces through `close`.
      });
      child.stdin.end(payload);
    });
  }
}
