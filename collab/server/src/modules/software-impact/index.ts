/**
 * Investigation-scoped software impact: observed / suspected / confirmed /
 * ruled-out judgments against named product, version, build, component, and
 * environment labels. No build ordering is inferred.
 */
export const MODULE_ID = "software-impact" as const;

export {
  DuplicateSoftwareImpactError,
  InvestigationNotVisibleError,
  MemorySoftwareImpactStore,
  SoftwareImpactNotFoundError,
  SoftwareImpactReleasedError,
  SoftwareImpactService,
} from "./service.js";
export type {
  Actor,
  InvestigationGateway,
  SoftwareImpactCreateInput,
  SoftwareImpactRow,
  SoftwareImpactStore,
} from "./service.js";
export { PgSoftwareImpactStore, toSoftwareImpactV1 } from "./store.js";
export { registerSoftwareImpactRoutes } from "./routes.js";
export type { SoftwareImpactRouteDeps } from "./routes.js";
