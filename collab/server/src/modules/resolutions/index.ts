/**
 * Resolution records and the guard on conclusive status transitions.
 *
 * An investigation reaches `resolved` only with an active resolution behind
 * it. Human-only reasoning is a first-class basis — most historical and manual
 * investigations end that way and must not be forced through a model
 * comparison that never happened — alongside an accepted experiment decision
 * and an explicit reasoned exception. What is refused is the silent flip: a
 * status that claims the question was answered with nothing recorded about who
 * decided, why, or what stayed unknown.
 */
export const MODULE_ID = "resolutions" as const;

export {
  InvestigationNotVisibleError,
  MemoryResolutionStore,
  PgResolutionStore,
  ResolutionRequiredError,
  ResolutionRevisionConflictError,
  ResolutionService,
  toResolutionV1,
} from "./service.js";
export type {
  Actor,
  InvestigationGateway,
  ResolutionInput,
  ResolutionRow,
  ResolutionStore,
} from "./service.js";
export {
  registerResolutionRoutes,
  resolutionDomainError,
  resolutionInputFrom,
} from "./routes.js";
export type { ResolutionRouteDeps } from "./routes.js";
