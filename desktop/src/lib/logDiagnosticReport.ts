import type {
  BrandingDto,
  FailedLogIngestDiagnosticDto,
  LogCorpusStatsDto,
  LogCorpusSummaryDto,
} from "./host";
import { redactDiagnosticText } from "./errorReport";

export const LOG_DIAGNOSTIC_NOTE_MAX_CHARS = 1_200;
export const LOG_DIAGNOSTIC_REPORT_MAX_BYTES = 64 * 1024;
const MAX_EXAMPLES = 12;
const MAX_FAILED_INGEST_TRANSCRIPT = 20;
const MAX_COUNT_ENTRIES = 32;
const MAX_LABEL_CHARS = 160;
const MAX_STATUS_CHARS = 800;

export type LogDiagnosticStatus = {
  kind: "error" | "status";
  message: string;
};

export type LogDiagnosticEnvironment = {
  appVersion: string;
  channel: string;
  gitSha: string | null;
  os: string;
};

export type LogDiagnosticActiveViewInput = {
  breakpoint: "narrow" | "normal" | "ultrawide";
  density: "comfortable" | "compact";
  rowMode: "compact" | "wrap" | "full";
  metadataPresentation: "standard" | "compact";
  fieldEmphasis: "balanced" | "payload" | "metadata";
  timeQuality: "wall" | "mixed" | "order_only";
  linkMode: "independent" | "follow_cursor" | "align_time";
  visibleLaneCount: number;
  laneSourceCounts: number[];
  filters: {
    levelCount: number;
    sourceCount: number;
    serviceCount: number;
    hostCount: number;
    keywordPresent: boolean;
    tracePresent: boolean;
    timeFrom: number | null;
    timeTo: number | null;
    seqFrom: number | null;
    seqTo: number | null;
    templateId: number | null;
  };
  find: {
    active: boolean;
    matchMode: "literal" | "regex";
    caseSensitive: boolean;
    semantic: boolean;
    residentMatches: number;
  };
  selectedSeqs: number[];
  highlightedSeqs: number[];
  focusedSeq: number | null;
  viewportAnchors: { laneId: string; seq: number }[];
  filtersCollapsed: boolean;
  investigationCollapsed: boolean;
  uiState: {
    category: "ready" | "active" | "busy" | "error";
    busy: boolean;
    hasError: boolean;
  };
};

export type LogDiagnosticActiveView = LogDiagnosticActiveViewInput;

export type LogDiagnosticManifest = {
  schemaVersion: 1;
  generatedAt: string;
  privacy: {
    redacted: true;
    reviewRequired: true;
    excluded: string[];
  };
  application: {
    version: string;
    channel: string;
    gitSha: string | null;
    os: string;
  };
  corpus: {
    id: string;
    name: string;
    createdAt: number;
    engine: string;
    eventCount: number;
    templateCount: number;
    stats: {
      importedFiles: number;
      discoveredFiles: number;
      excludedFiles: number;
      failedFiles: number;
      ignoredFiles: number;
      partial: boolean;
      sourceBytes: number;
      corpusBytes: number;
      levelCounts: Record<string, number>;
      formatCounts: Record<string, number>;
      reasonCounts: Record<string, number>;
      basenameExamples: string[];
      storedTimeMin: number | null;
      storedTimeMax: number | null;
      timeQuality: "not_persisted_in_corpus_summary";
    } | null;
    embedding: {
      state: "keyword_only" | "deferred" | "partial" | "complete";
    };
  } | null;
  failedIngest: {
    schemaVersion: number;
    generatedAt: number;
    sourceKind: string;
    reasonCode: string;
    summary: string;
    cancelled: boolean;
    progress: {
      lastPhase: string;
      linesProcessed: number | null;
      filesProcessed: number | null;
      bytesProcessed: number | null;
      templates: number | null;
      updatesSeen: number;
    };
    evidence: {
      scanCounts: {
        binary: number;
        empty: number;
        hidden: number;
        oversized: number;
        readFailed: number;
        parseFailed: number;
      };
      transcript: { reason: string; basename: string }[];
      omittedEntries: number;
    };
    retention: "memory_only_until_clear_next_ingest_or_restart";
  } | null;
  activeView: LogDiagnosticActiveView | null;
  currentStatus: LogDiagnosticStatus | null;
  userNote: string | null;
};

export type LogDiagnosticReport = {
  manifest: LogDiagnosticManifest;
  markdown: string;
  json: string;
};

const EXCLUDED_CONTENT = [
  "raw logs and event payloads",
  "absolute source and home paths",
  "chat transcripts",
  "provider and model inventories",
  "credentials and secrets",
  "evaluator truth",
];

const ABSOLUTE_UNIX_PATH_RE =
  /(^|[\s("'`=:])\/(?!\/)[^\s)"'`,;]+/g;
const ABSOLUTE_WINDOWS_PATH_RE =
  /(?:[A-Za-z]:\\|\\\\)[^\s)"'`,;]+/g;

function capText(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function sanitizeText(value: unknown, maxChars: number): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const redacted = redactDiagnosticText(raw)
    .replace(ABSOLUTE_UNIX_PATH_RE, "$1[REDACTED_PATH]")
    .replace(ABSOLUTE_WINDOWS_PATH_RE, "[REDACTED_PATH]")
    .replace(/\s+/g, " ")
    .trim();
  return capText(redacted, maxChars);
}

function sanitizeIdentifier(value: unknown, maxChars = 128): string {
  const candidate = sanitizeText(value, maxChars);
  const safe = candidate.replace(/[^a-zA-Z0-9._:+-]/g, "_");
  return safe || "unknown";
}

function sanitizeReason(value: unknown): string {
  return sanitizeIdentifier(value, 64).toLowerCase();
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function safeOptionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(
    Number.MIN_SAFE_INTEGER,
    Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER),
  );
}

function boundedCounts(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values)
      .slice(0, MAX_COUNT_ENTRIES)
      .map(([key, value]) => [sanitizeReason(key), safeCount(value)]),
  );
}

function basenameExample(example: string): string {
  const separator = example.indexOf(":");
  const reason =
    separator >= 0 ? sanitizeReason(example.slice(0, separator)) : "item";
  const originalName =
    separator >= 0 ? example.slice(separator + 1).trim() : example.trim();
  const basename = originalName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return `${reason}: ${sanitizeText(basename, 120) || "[REDACTED_NAME]"}`;
}

function buildStats(
  stats: LogCorpusStatsDto | null,
): NonNullable<LogDiagnosticManifest["corpus"]>["stats"] {
  if (!stats) return null;
  return {
    importedFiles: safeCount(stats.files),
    discoveredFiles: safeCount(stats.discoveredFiles),
    excludedFiles: safeCount(stats.excludedFiles),
    failedFiles: safeCount(stats.failedFiles),
    ignoredFiles: safeCount(stats.ignoredFiles),
    partial: Boolean(stats.partial),
    sourceBytes: safeCount(stats.sourceBytes),
    corpusBytes: safeCount(stats.corpusBytes),
    levelCounts: boundedCounts(stats.levelCounts),
    formatCounts: boundedCounts(stats.formatCounts),
    reasonCounts: boundedCounts(stats.exclusionCounts),
    basenameExamples: stats.exclusionExamples
      .slice(0, MAX_EXAMPLES)
      .map(basenameExample),
    storedTimeMin: safeOptionalNumber(stats.tsMin),
    storedTimeMax: safeOptionalNumber(stats.tsMax),
    timeQuality: "not_persisted_in_corpus_summary",
  };
}

function boundedSeqs(values: number[]): number[] {
  return [
    ...new Set(
      values
        .filter((value) => Number.isSafeInteger(value) && value >= 0)
        .map((value) => Math.floor(value)),
    ),
  ]
    .sort((left, right) => left - right)
    .slice(0, 32);
}

function buildActiveView(
  view: LogDiagnosticActiveViewInput | null | undefined,
): LogDiagnosticActiveView | null {
  if (!view) return null;
  return {
    breakpoint: view.breakpoint,
    density: view.density,
    rowMode: view.rowMode,
    metadataPresentation: view.metadataPresentation,
    fieldEmphasis: view.fieldEmphasis,
    timeQuality: view.timeQuality,
    linkMode: view.linkMode,
    visibleLaneCount: Math.min(4, safeCount(view.visibleLaneCount)),
    laneSourceCounts: view.laneSourceCounts
      .slice(0, 4)
      .map((value) => safeCount(value)),
    filters: {
      levelCount: safeCount(view.filters.levelCount),
      sourceCount: safeCount(view.filters.sourceCount),
      serviceCount: safeCount(view.filters.serviceCount),
      hostCount: safeCount(view.filters.hostCount),
      keywordPresent: Boolean(view.filters.keywordPresent),
      tracePresent: Boolean(view.filters.tracePresent),
      timeFrom: safeOptionalNumber(view.filters.timeFrom),
      timeTo: safeOptionalNumber(view.filters.timeTo),
      seqFrom: safeOptionalNumber(view.filters.seqFrom),
      seqTo: safeOptionalNumber(view.filters.seqTo),
      templateId: safeOptionalNumber(view.filters.templateId),
    },
    find: {
      active: Boolean(view.find.active),
      matchMode: view.find.matchMode,
      caseSensitive: Boolean(view.find.caseSensitive),
      semantic: Boolean(view.find.semantic),
      residentMatches: safeCount(view.find.residentMatches),
    },
    selectedSeqs: boundedSeqs(view.selectedSeqs),
    highlightedSeqs: boundedSeqs(view.highlightedSeqs),
    focusedSeq: safeOptionalNumber(view.focusedSeq),
    viewportAnchors: view.viewportAnchors
      .filter((anchor) => Number.isSafeInteger(anchor.seq) && anchor.seq >= 0)
      .slice(0, 4)
      .map((anchor) => ({
        laneId: sanitizeIdentifier(anchor.laneId, 32),
        seq: Math.floor(anchor.seq),
      })),
    filtersCollapsed: Boolean(view.filtersCollapsed),
    investigationCollapsed: Boolean(view.investigationCollapsed),
    uiState: {
      category: view.uiState.category,
      busy: Boolean(view.uiState.busy),
      hasError: Boolean(view.uiState.hasError),
    },
  };
}

function buildFailedIngest(
  failure: FailedLogIngestDiagnosticDto | null | undefined,
): LogDiagnosticManifest["failedIngest"] {
  if (!failure) return null;
  return {
    schemaVersion: safeCount(failure.schemaVersion),
    generatedAt: safeCount(failure.generatedAt),
    sourceKind: sanitizeReason(failure.sourceKind),
    reasonCode: sanitizeReason(failure.reasonCode),
    summary:
      sanitizeText(failure.summary, MAX_STATUS_CHARS) ||
      "Import failed before publication.",
    cancelled: Boolean(failure.cancelled),
    progress: {
      lastPhase: sanitizeReason(failure.progress.lastPhase),
      linesProcessed: safeOptionalNumber(failure.progress.linesProcessed),
      filesProcessed: safeOptionalNumber(failure.progress.filesProcessed),
      bytesProcessed: safeOptionalNumber(failure.progress.bytesProcessed),
      templates: safeOptionalNumber(failure.progress.templates),
      updatesSeen: safeCount(failure.progress.updatesSeen),
    },
    evidence: {
      scanCounts: {
        binary: safeCount(failure.evidence.scanCounts.binary),
        empty: safeCount(failure.evidence.scanCounts.empty),
        hidden: safeCount(failure.evidence.scanCounts.hidden),
        oversized: safeCount(failure.evidence.scanCounts.oversized),
        readFailed: safeCount(failure.evidence.scanCounts.readFailed),
        parseFailed: safeCount(failure.evidence.scanCounts.parseFailed),
      },
      transcript: failure.evidence.transcript
        .slice(0, MAX_FAILED_INGEST_TRANSCRIPT)
        .map((entry) => {
          const basename =
            entry.basename.replace(/\\/g, "/").split("/").at(-1) ?? "";
          return {
            reason: sanitizeReason(entry.reason),
            basename:
              sanitizeText(basename, 96) || "[REDACTED_BASENAME]",
          };
        }),
      omittedEntries: Math.min(
        Number.MAX_SAFE_INTEGER,
        safeCount(failure.evidence.omittedEntries) +
          Math.max(
            0,
            failure.evidence.transcript.length -
              MAX_FAILED_INGEST_TRANSCRIPT,
          ),
      ),
    },
    retention: "memory_only_until_clear_next_ingest_or_restart",
  };
}

function lineCounts(values: Record<string, number>): string[] {
  const entries = Object.entries(values);
  return entries.length
    ? entries.map(([key, value]) => `- ${key}: ${value}`)
    : ["- none recorded"];
}

function nullable(value: string | null): string {
  return value ?? "unknown";
}

function renderMarkdown(manifest: LogDiagnosticManifest): string {
  const stats = manifest.corpus?.stats ?? null;
  const failure = manifest.failedIngest;
  const activeView = manifest.activeView;
  return [
    manifest.corpus
      ? "# ContextDesk corpus diagnostic"
      : "# ContextDesk failed-ingest diagnostic",
    "",
    "> Redacted support report. Review before sharing.",
    "> Excludes raw logs/event payloads, absolute paths, chats, provider/model inventories, secrets, and evaluator truth.",
    "",
    "## Application",
    `- Version: ${manifest.application.version}`,
    `- Channel: ${manifest.application.channel}`,
    `- Git: ${nullable(manifest.application.gitSha)}`,
    `- OS: ${manifest.application.os}`,
    `- Generated: ${manifest.generatedAt}`,
    "",
    ...(manifest.corpus
      ? [
          "## Corpus",
          `- ID: ${manifest.corpus.id}`,
          `- Name: ${manifest.corpus.name}`,
          `- Created (Unix seconds): ${manifest.corpus.createdAt}`,
          `- Engine: ${manifest.corpus.engine}`,
          `- Events: ${manifest.corpus.eventCount}`,
          `- Templates: ${manifest.corpus.templateCount}`,
          `- Embedding state: ${manifest.corpus.embedding.state}`,
          ...(stats
            ? [
                `- Files: ${stats.importedFiles} imported / ${stats.discoveredFiles} discovered`,
                `- Omissions: ${stats.excludedFiles} excluded / ${stats.failedFiles} failed / ${stats.ignoredFiles} ignored`,
                `- Partial corpus: ${stats.partial ? "yes" : "no"}`,
                `- Source bytes: ${stats.sourceBytes}`,
                `- Corpus bytes: ${stats.corpusBytes}`,
                `- Stored time bounds: ${nullable(stats.storedTimeMin?.toString() ?? null)} to ${nullable(stats.storedTimeMax?.toString() ?? null)}`,
                `- Time quality: ${stats.timeQuality}`,
                "",
                "### Level counts",
                ...lineCounts(stats.levelCounts),
                "",
                "### Parse-format counts",
                ...lineCounts(stats.formatCounts),
                "",
                "### Import reason counts",
                ...lineCounts(stats.reasonCounts),
                "",
                "### Bounded basename-only examples",
                ...(stats.basenameExamples.length
                  ? stats.basenameExamples.map((example) => `- ${example}`)
                  : ["- none recorded"]),
              ]
            : ["- Persisted detailed statistics: unavailable"]),
          "",
        ]
      : []),
    ...(failure
      ? [
          "## Failed ingest",
          `- Reason: ${failure.reasonCode}`,
          `- Summary: ${failure.summary}`,
          `- Source kind: ${failure.sourceKind}`,
          `- Cancelled: ${failure.cancelled ? "yes" : "no"}`,
          `- Last phase: ${failure.progress.lastPhase}`,
          `- Lines observed: ${nullable(failure.progress.linesProcessed?.toString() ?? null)}`,
          `- Files observed: ${nullable(failure.progress.filesProcessed?.toString() ?? null)}`,
          `- Bytes observed: ${nullable(failure.progress.bytesProcessed?.toString() ?? null)}`,
          `- Templates observed: ${nullable(failure.progress.templates?.toString() ?? null)}`,
          "",
          "### Scan evidence counters",
          `- binary: ${failure.evidence.scanCounts.binary}`,
          `- empty: ${failure.evidence.scanCounts.empty}`,
          `- hidden: ${failure.evidence.scanCounts.hidden}`,
          `- oversized: ${failure.evidence.scanCounts.oversized}`,
          `- read_failed: ${failure.evidence.scanCounts.readFailed}`,
          `- parse_failed: ${failure.evidence.scanCounts.parseFailed}`,
          "",
          "### Bounded basename/reason transcript",
          ...(failure.evidence.transcript.length
            ? failure.evidence.transcript.map(
                (entry) => `- ${entry.reason}: ${entry.basename}`,
              )
            : ["- none recorded"]),
          ...(failure.evidence.omittedEntries > 0
            ? [
                `- ${failure.evidence.omittedEntries} additional observation(s) omitted by the core transcript bound`,
              ]
            : []),
          "- Corpus published: no",
          "- Retention: memory only; cleared explicitly, by the next ingest attempt, or on app restart",
          "",
        ]
      : []),
    ...(activeView
      ? [
          "## Active Explorer view (payload-free)",
          `- Layout: ${activeView.breakpoint} / ${activeView.density}`,
          `- Rows: ${activeView.rowMode} / ${activeView.metadataPresentation} metadata / ${activeView.fieldEmphasis} focus`,
          `- Time: ${activeView.timeQuality} / ${activeView.linkMode}`,
          `- Lanes: ${activeView.visibleLaneCount} visible; source counts ${activeView.laneSourceCounts.join(", ") || "none"}`,
          `- Filter counts: ${activeView.filters.levelCount} levels / ${activeView.filters.sourceCount} sources / ${activeView.filters.serviceCount} services / ${activeView.filters.hostCount} hosts`,
          `- Filter values withheld: keyword ${activeView.filters.keywordPresent ? "present" : "absent"} / trace ${activeView.filters.tracePresent ? "present" : "absent"}`,
          `- Time bounds: ${nullable(activeView.filters.timeFrom?.toString() ?? null)} to ${nullable(activeView.filters.timeTo?.toString() ?? null)}`,
          `- Sequence bounds: ${nullable(activeView.filters.seqFrom?.toString() ?? null)} to ${nullable(activeView.filters.seqTo?.toString() ?? null)}`,
          `- Template filter: ${nullable(activeView.filters.templateId?.toString() ?? null)}`,
          `- Find: ${activeView.find.active ? activeView.find.matchMode : "off"}; ${activeView.find.residentMatches} resident identities`,
          `- Selected seqs (bounded): ${activeView.selectedSeqs.join(", ") || "none"}`,
          `- Highlighted seqs (bounded): ${activeView.highlightedSeqs.join(", ") || "none"}`,
          `- Focused seq: ${nullable(activeView.focusedSeq?.toString() ?? null)}`,
          `- Viewport anchors: ${
            activeView.viewportAnchors
              .map((anchor) => `${anchor.laneId}:${anchor.seq}`)
              .join(", ") || "none"
          }`,
          `- UI state: ${activeView.uiState.category}; busy ${activeView.uiState.busy ? "yes" : "no"}; error present ${activeView.uiState.hasError ? "yes" : "no"}`,
          "",
        ]
      : []),
    "## Current app status (redacted)",
    manifest.currentStatus
      ? `- ${manifest.currentStatus.kind}: ${manifest.currentStatus.message}`
      : "- none captured",
    "",
    "## User reproduction note (redacted)",
    manifest.userNote || "(none)",
    "",
    "## Privacy boundary",
    ...manifest.privacy.excluded.map((item) => `- Excluded: ${item}`),
    "",
    "_Generated by ContextDesk. This bounded report is redacted, but the user must review it before sharing._",
  ].join("\n");
}

export function diagnosticEnvironmentFromBranding(
  branding: BrandingDto,
): LogDiagnosticEnvironment {
  return {
    appVersion: sanitizeIdentifier(branding.version, 64),
    channel: sanitizeIdentifier(branding.channel, 32),
    gitSha: branding.git_sha
      ? sanitizeIdentifier(branding.git_sha, 64)
      : null,
    os: portableDiagnosticOsHint(),
  };
}

export function portableDiagnosticOsHint(): string {
  if (typeof navigator === "undefined") return "unknown";
  const userAgent = navigator.userAgent || "";
  if (/Mac/i.test(userAgent)) return "macOS";
  if (/Win/i.test(userAgent)) return "Windows";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "unknown";
}

export function buildLogDiagnosticReport(args: {
  corpus?: LogCorpusSummaryDto | null;
  failedIngest?: FailedLogIngestDiagnosticDto | null;
  activeView?: LogDiagnosticActiveViewInput | null;
  environment: LogDiagnosticEnvironment;
  currentStatus?: LogDiagnosticStatus | null;
  userNote?: string;
  generatedAt?: Date;
}): LogDiagnosticReport {
  if (Boolean(args.corpus) === Boolean(args.failedIngest)) {
    throw new Error(
      "Diagnostic report requires exactly one corpus or failed-ingest subject",
    );
  }
  const embeddingState = args.corpus?.embedding?.state ?? "keyword_only";
  const corpus = args.corpus
    ? {
        id: sanitizeIdentifier(args.corpus.id),
        name:
          sanitizeText(args.corpus.name, MAX_LABEL_CHARS) || "Unnamed corpus",
        createdAt: safeCount(args.corpus.createdAt),
        engine: sanitizeIdentifier(args.corpus.engine, 64),
        eventCount: safeCount(args.corpus.eventCount),
        templateCount: safeCount(args.corpus.templateCount),
        stats: buildStats(args.corpus.stats),
        embedding: {
          state: embeddingState,
        },
      }
    : null;
  const manifest: LogDiagnosticManifest = {
    schemaVersion: 1,
    generatedAt: (args.generatedAt ?? new Date()).toISOString(),
    privacy: {
      redacted: true,
      reviewRequired: true,
      excluded: [...EXCLUDED_CONTENT],
    },
    application: {
      version: sanitizeIdentifier(args.environment.appVersion, 64),
      channel: sanitizeIdentifier(args.environment.channel, 32),
      gitSha: args.environment.gitSha
        ? sanitizeIdentifier(args.environment.gitSha, 64)
        : null,
      os: sanitizeText(args.environment.os, 64) || "unknown",
    },
    corpus,
    failedIngest: buildFailedIngest(args.failedIngest),
    activeView: buildActiveView(args.activeView),
    currentStatus:
      !args.activeView && !args.failedIngest && args.currentStatus
      ? {
          kind: args.currentStatus.kind,
          message:
            sanitizeText(args.currentStatus.message, MAX_STATUS_CHARS) ||
            "No detail",
        }
      : null,
    userNote:
      sanitizeText(
        args.userNote ?? "",
        LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
      ) || null,
  };
  const markdown = renderMarkdown(manifest);
  const json = JSON.stringify(manifest, null, 2);

  if (
    new TextEncoder().encode(markdown).length >
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES ||
    new TextEncoder().encode(json).length > LOG_DIAGNOSTIC_REPORT_MAX_BYTES
  ) {
    throw new Error("Diagnostic report exceeded its bounded export size");
  }

  return { manifest, markdown, json };
}
