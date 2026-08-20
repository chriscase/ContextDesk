/** Cases, timelines, and the collaboration core. */
export const MODULE_ID = "cases" as const;

export { CaseService, LegalHoldError, MemoryCaseStore, PgCaseStore } from "./service.js";
export type { Actor, CaseStore, TimelineRow } from "./service.js";
export { deriveCaseBoard } from "./board.js";
export type { AcceptedDecisionBoardInput, CaseBoardInput } from "./board.js";
export { registerCaseRoutes } from "./routes.js";
export type { CaseRouteDeps } from "./routes.js";
