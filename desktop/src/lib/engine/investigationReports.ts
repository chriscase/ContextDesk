/**
 * Investigation-report engine adapter (#532). Components consume this module;
 * only the designated engine boundary delegates to the legacy Tauri host
 * bridge. Wave-3 report UI imports ONLY this module — never `lib/host`.
 *
 * Everything here is pure delegation: assembly/preview is host-side and
 * strictly non-mutating; section mutations are revision-pinned and go through
 * the host's investigation mutation lock; export follows the diagnostics gold
 * pattern (host-rendered bytes under an opaque id, host-owned Save panel).
 */
import {
  hostListLogCorpora,
  hostLogAcceptProposedReportSection,
  hostLogAssembleInvestigationReport,
  hostLogDismissProposedReportSection,
  hostLogLoadActiveInvestigation,
  hostLogPreviewInvestigationEvidence,
  hostLogReleaseInvestigationReportExport,
  hostLogSaveInvestigationReportExport,
  hostLogSetInvestigationReportSection,
} from "../host";

export type {
  ExplorerEventDto,
  InvestigationDocumentDto,
  InvestigationEvidenceItemDto,
  InvestigationEvidencePreviewDto,
  InvestigationEvidenceReferenceDto,
  InvestigationFindingKind,
  InvestigationFindingLifecycle,
  InvestigationNoiseLens,
  InvestigationPolicyBindingStatus,
  InvestigationReportAuthoredSectionDto,
  InvestigationReportCurrentPolicyDto,
  InvestigationReportDto,
  InvestigationReportEventReferenceDto,
  InvestigationReportFindingCitationDto,
  InvestigationReportFindingEntryDto,
  InvestigationReportScopeDto,
  InvestigationReportSectionItemDto,
  InvestigationReportSectionsDto,
  InvestigationReportTimeWindowDto,
  InvestigationReportTimelineDto,
  InvestigationReportTimelineEntryDto,
  LogCorpusSummaryDto,
  LogDiagnosticSaveStatus,
  LogInvestigationReportPreviewDto,
  ProposalProvenanceDto,
  ProposedFindingStatusDto,
  ProposedReportSectionItemDto,
  ReportSectionKindDto,
  ResolvedInvestigationDocumentDto,
  TimeQuality,
} from "../host";

/**
 * Whether the trusted desktop host is reachable (mirrors the host bridge's
 * private probe). Report surfaces use this for truthful browser-mode
 * degradation copy instead of misreading the stubs' empty results.
 */
export function investigationHostAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Existing investigation/corpus reads recomposed by report surfaces. Pure
// delegation only — the host stays the single authority (browser builds keep
// its truthful "requires Tauri host" stubs).
export const listLogCorpora = hostListLogCorpora;
export const logLoadActiveInvestigation = hostLogLoadActiveInvestigation;
export const logPreviewInvestigationEvidence =
  hostLogPreviewInvestigationEvidence;

export const logAssembleInvestigationReport = hostLogAssembleInvestigationReport;
export const logSetInvestigationReportSection =
  hostLogSetInvestigationReportSection;
// NOTE (#532 hardening): there is deliberately no renderer propose surface
// for report sections — proposals enter only through the tool host's
// SoftWrite path, where provenance is host-authored and the permission gate
// applies.
export const logAcceptProposedReportSection = hostLogAcceptProposedReportSection;
export const logDismissProposedReportSection =
  hostLogDismissProposedReportSection;
export const logSaveInvestigationReportExport =
  hostLogSaveInvestigationReportExport;
export const logReleaseInvestigationReportExport =
  hostLogReleaseInvestigationReportExport;
