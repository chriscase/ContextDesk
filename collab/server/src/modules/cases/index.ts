/** Cases, timelines, and the collaboration core. */
export const MODULE_ID = "cases" as const;

export { CaseService, LegalHoldError, MemoryCaseStore, PgCaseStore } from "./service.js";
export type {
  Actor,
  CaseStore,
  CaseTimelineRow,
  OverviewActivityRow,
  OverviewCounts,
  OverviewOpenCaseRow,
  OverviewScope,
  OverviewVisibilityBoundary,
  TimelineRow,
} from "./service.js";
export { overviewVisiblePredicate, isOverviewVisibleCase } from "./store.js";
export { deriveCaseBoard } from "./board.js";
export type { AcceptedDecisionBoardInput, CaseBoardInput } from "./board.js";
export { registerCaseRoutes } from "./routes.js";
export type { CaseRouteDeps } from "./routes.js";
