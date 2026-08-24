/** Bounded operational Overview for the War Room command center. */
export const MODULE_ID = "overview" as const;

export { OverviewService, projectOverviewForStaticSnapshot } from "./service.js";
export type { OverviewActor, OverviewDeps } from "./service.js";
export { registerOverviewRoutes } from "./routes.js";
export type { OverviewRouteDeps } from "./routes.js";
