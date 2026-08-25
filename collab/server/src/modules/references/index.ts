/**
 * Authorized cross-investigation references.
 *
 * A reference points at another investigation, or at one resource inside it,
 * and records why. It copies nothing, writes nothing into the cited
 * investigation, and never becomes evidence or a contribution on its own.
 * Read access is re-checked for every reader on every read: a citation is a
 * pointer, not a grant.
 */
export const MODULE_ID = "references" as const;

export {
  CitedInvestigationNotAuthorizedError,
  CitingInvestigationNotVisibleError,
  DuplicateReferenceError,
  MemoryReferenceStore,
  PgReferenceStore,
  ReferenceNotFoundError,
  ReferenceService,
  SelfReferenceError,
} from "./service.js";
export type {
  Actor,
  InvestigationGateway,
  ReferenceInput,
  ReferenceRow,
  ReferenceStore,
} from "./service.js";
export { registerReferenceRoutes } from "./routes.js";
export type { ReferenceRouteDeps } from "./routes.js";
