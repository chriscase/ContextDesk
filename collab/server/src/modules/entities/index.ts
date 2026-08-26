/**
 * Reusable investigation entities and the links that involve them in a case.
 *
 * The registry is global and holds only labels: a kind, a human label, and an
 * optional single-line profile. It never holds evidence, logs, email, chat, or
 * note content, and it is a different vocabulary from the Attribution source
 * catalog next door — Attribution answers "where did this information come
 * from", this module answers "who or what is this investigation about".
 *
 * Involvement links are investigation-scoped and carry immutable historical
 * attribution: the label and kind the entity had when it was linked survive
 * every later rename or retirement.
 */
export const MODULE_ID = "entities" as const;

export {
  DuplicateEntityError,
  DuplicateInvolvementError,
  EntityNotFoundError,
  EntityService,
  InvestigationNotVisibleError,
  MemoryEntityStore,
  PgEntityStore,
  RetiredEntityError,
} from "./service.js";
export type {
  Actor,
  EntityCreateInput,
  EntityFilter,
  EntityRow,
  EntityStore,
  InvestigationGateway,
  InvolvementInput,
  InvolvementRow,
} from "./service.js";
export { toEntityV1, toInvolvementV1 } from "./store.js";
export { registerEntityRoutes } from "./routes.js";
export type { EntityRouteDeps } from "./routes.js";
