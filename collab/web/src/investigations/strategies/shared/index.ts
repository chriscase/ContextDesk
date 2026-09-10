export {
  StrategyActionRow,
  StrategyBadge,
  StrategyHero,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "./presentation.js";

export {
  composeHandoffBody,
  createHandoffIdempotencyKey,
  recordedHandoffText,
  selectHandoffFacts,
  selectHandoffResourceView,
} from "./handoff.js";
export type {
  HandoffCaseRecord,
  HandoffContributionRecord,
  HandoffCreateCommand,
  HandoffCreateInput,
  HandoffCreateResult,
  HandoffCurrentState,
  HandoffFacts,
  HandoffMutationState,
  HandoffResourceState,
  HandoffResourceView,
} from "./handoff.js";

export { HandoffPanel } from "./HandoffPanel.js";
export type { HandoffPanelProps } from "./HandoffPanel.js";

export {
  createCoordinationIdempotencyKey,
  selectCoordinationResourceView,
} from "./coordination.js";
export type {
  CoordinationAction,
  CoordinationActionCommand,
  CoordinationActionInput,
  CoordinationActionResult,
  CoordinationFailureKind,
  CoordinationIdentityRecord,
  CoordinationMutationState,
  CoordinationParticipantHint,
  CoordinationReadError,
  CoordinationRecord,
  CoordinationResourceState,
  CoordinationResourceView,
} from "./coordination.js";
export { CoordinationControl } from "./CoordinationControl.js";
export type { CoordinationControlProps } from "./CoordinationControl.js";

export { EvidenceAnnotationWorkspace } from "./EvidenceAnnotationWorkspace.js";
export type { EvidenceAnnotationWorkspaceProps } from "./EvidenceAnnotationWorkspace.js";

export { CollectionPagination } from "./CollectionPagination.js";
export type { CollectionPageView, CollectionPaginationProps } from "./CollectionPagination.js";

export { RecordedContextCombo } from "./RecordedContextCombo.js";
export type { RecordedContextComboProps } from "./RecordedContextCombo.js";
export {
  RECORDED_CONTEXT_FIELDS,
  recordedContextCatalogFromView,
  recordedContextOptions,
} from "./recorded-context-options.js";
export type {
  RecordedContextCatalog,
  RecordedContextCatalogStatus,
  RecordedContextField,
  RecordedContextRecord,
} from "./recorded-context-options.js";
