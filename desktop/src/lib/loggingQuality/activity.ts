/**
 * Truthful Activity Inspector inputs for logging quality assessment runs.
 * Metadata only — no paths, payloads, or secrets.
 */

import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityEventInput,
} from "../activity/types";

export type LoggingQualityActivityPhase =
  | "started"
  | "facts_gathered"
  | "exported"
  | "export_cancelled"
  | "failed"
  | "cancelled"
  | "completed";

export function loggingQualityActivityEvent(args: {
  corpusId: string;
  correlationId: string;
  phase: LoggingQualityActivityPhase;
  /** Safe counts only. */
  findingCount?: number;
  overallScore?: number;
  exportFormat?: string;
  /** Safe failure label — never a raw error with paths. */
  safeDetail?: string;
  seq?: number;
}): ActivityEventInput {
  const origin =
    args.phase === "cancelled" || args.phase === "export_cancelled"
      ? ("user_decision" as const)
      : ("deterministic_host" as const);

  const label =
    args.phase === "started"
      ? "Logging quality assessment started"
      : args.phase === "facts_gathered"
        ? "Logging quality facts gathered"
        : args.phase === "exported"
          ? "Logging quality report exported"
          : args.phase === "export_cancelled"
            ? "Logging quality export cancelled"
            : args.phase === "failed"
              ? "Logging quality assessment failed"
              : args.phase === "cancelled"
                ? "Logging quality assessment cancelled"
                : "Logging quality assessment completed";

  const detailParts: string[] = ["deterministic"];
  if (args.findingCount != null) {
    detailParts.push(`${args.findingCount} finding(s)`);
  }
  if (args.overallScore != null) {
    detailParts.push(`score ${args.overallScore}`);
  }
  if (args.exportFormat) {
    detailParts.push(`format=${args.exportFormat}`);
  }
  if (args.safeDetail) {
    detailParts.push(args.safeDetail);
  }

  const status =
    args.phase === "failed"
      ? ("failed" as const)
      : args.phase === "cancelled" || args.phase === "export_cancelled"
        ? ("cancelled" as const)
        : args.phase === "started"
          ? ("pending" as const)
          : ("ok" as const);

  const phase =
    args.phase === "started"
      ? ("started" as const)
      : args.phase === "facts_gathered"
        ? ("progress" as const)
        : ("completed" as const);

  return {
    correlationId: args.correlationId,
    operationId: `${args.correlationId}:lqa:${args.phase}`,
    origin,
    determinism: determinismForOrigin(origin),
    phase,
    status,
    clock: { kind: "sequence", seq: args.seq ?? 0 },
    label,
    detail: detailParts.join(" · "),
    scope: {
      kind: "log_corpus",
      id: args.corpusId,
      label: "Log corpus",
    },
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
    corpusId: args.corpusId,
  };
}

/** Strip path/secret-shaped text from host error messages before Activity. */
export function sanitizeAssessmentErrorMessage(raw: string): string {
  let s = raw.replace(/\/Users\/[^\s]+/gi, "[path]");
  s = s.replace(/\/home\/[^\s]+/gi, "[path]");
  s = s.replace(/[A-Za-z]:\\[^\s]+/g, "[path]");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=[redacted]");
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  return s;
}
