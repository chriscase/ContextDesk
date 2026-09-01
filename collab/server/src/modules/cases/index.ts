/** Cases, timelines, and the collaboration core. */
export const MODULE_ID = "cases" as const;

export {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  ContributionConflictError,
  CorpusIntakeConflictError,
  LifecycleActionRequiredError,
  LifecycleChangedError,
  LifecycleRefusedError,
  LegalHoldError,
  MemoryCaseStore,
  PgCaseStore,
  StatusChangedError,
  SituationConflictError,
} from "./service.js";
export type {
  Actor,
  ArtifactRow,
  CaseStore,
  CaseTimelineRow,
  OverviewActivityRow,
  OverviewCounts,
  OverviewOpenCaseRow,
  OverviewScope,
  OverviewVisibilityBoundary,
  RevisionRow,
  TimelineRow,
} from "./service.js";
export type {
  ActivityPageCursor,
  ActivityPageQuery,
  CaseProbeKind,
  CaseRow,
  ParticipantIdentityRow,
} from "./store.js";
export { CASE_PROBE_KINDS } from "./store.js";
export { activityComesAfter, compareActivityDesc, overviewVisiblePredicate, isOverviewVisibleCase, activeCaseQueryable, runWithCaseQueryable } from "./store.js";
export { deriveCaseBoard } from "./board.js";
export type { AcceptedDecisionBoardInput, CaseBoardInput } from "./board.js";
export { registerCaseRoutes } from "./routes.js";
export type { CaseRouteDeps } from "./routes.js";
