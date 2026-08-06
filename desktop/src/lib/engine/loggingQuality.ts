/**
 * Logging quality engine adapter.
 * Components import this module — never `lib/host` or `@tauri-apps` directly.
 *
 * Host calls are dynamic so suite-wide `vi.mock("../host")` stubs that omit
 * assess/export still load LogExplorer without evaluation errors.
 */

export type {
  LoggingQualityAssessment,
  LoggingQualityAssessmentHostDto,
  LoggingQualityExportStatus,
  LoggingQualityFinding,
  LoggingQualityRunPhase,
} from "../loggingQuality/types";

export {
  planShowInExplorer,
  findingIsAggregateOnly,
  MAX_EVIDENCE_LANES,
} from "../loggingQuality/evidenceBridge";

export {
  assessmentUiStringsArePrivate,
  collectAssessmentDisplayStrings,
  findAssessmentPrivacyLeak,
} from "../loggingQuality/privacy";

export {
  loggingQualityActivityEvent,
  sanitizeAssessmentErrorMessage,
} from "../loggingQuality/activity";

export function loggingQualityHostAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function assessLoggingQuality(
  corpusId: string,
): Promise<import("../loggingQuality/types").LoggingQualityAssessmentHostDto> {
  const { hostAssessLoggingQuality } = await import("../host");
  return hostAssessLoggingQuality(corpusId);
}

export async function exportLoggingQualityAssessment(
  corpusId: string,
  format: "json" | "markdown",
): Promise<import("../loggingQuality/types").LoggingQualityExportStatus> {
  const { hostExportLoggingQualityAssessment } = await import("../host");
  return hostExportLoggingQualityAssessment(corpusId, format);
}
