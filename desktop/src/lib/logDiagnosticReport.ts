import type {
  BrandingDto,
  LogCorpusStatsDto,
  LogCorpusSummaryDto,
} from "./host";
import { redactDiagnosticText } from "./errorReport";

export const LOG_DIAGNOSTIC_NOTE_MAX_CHARS = 1_200;
export const LOG_DIAGNOSTIC_REPORT_MAX_BYTES = 64 * 1024;
const MAX_EXAMPLES = 12;
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
  };
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
  /(^|[\s("'`=])\/(?:Users|home|private|var\/folders|Volumes|tmp)\/[^\s)"'`,;]*/gi;
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
): LogDiagnosticManifest["corpus"]["stats"] {
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
  const stats = manifest.corpus.stats;
  return [
    "# ContextDesk corpus diagnostic",
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
  corpus: LogCorpusSummaryDto;
  environment: LogDiagnosticEnvironment;
  currentStatus?: LogDiagnosticStatus | null;
  userNote?: string;
  generatedAt?: Date;
}): LogDiagnosticReport {
  const embeddingState = args.corpus.embedding?.state ?? "keyword_only";
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
    corpus: {
      id: sanitizeIdentifier(args.corpus.id),
      name: sanitizeText(args.corpus.name, MAX_LABEL_CHARS) || "Unnamed corpus",
      createdAt: safeCount(args.corpus.createdAt),
      engine: sanitizeIdentifier(args.corpus.engine, 64),
      eventCount: safeCount(args.corpus.eventCount),
      templateCount: safeCount(args.corpus.templateCount),
      stats: buildStats(args.corpus.stats),
      embedding: {
        state: embeddingState,
      },
    },
    currentStatus: args.currentStatus
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
