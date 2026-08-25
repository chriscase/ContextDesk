/** Canonical investigation activity projection and resource locator resolution. */
export const MODULE_ID = "activity" as const;

export {
  InvestigationActivityService,
  InvestigationActivityError,
  investigationActivityErrorBody,
} from "./service.js";
export type {
  InvestigationActivityListInput,
  InvestigationActivityServiceDeps,
} from "./service.js";
export { registerInvestigationActivityRoutes } from "./routes.js";
export type { InvestigationActivityRouteDeps } from "./routes.js";
export {
  INVESTIGATION_ACTIVITY_SOURCE_WINDOW,
  projectTimelineSource,
} from "./project.js";
export type { ProjectedInvestigationActivity, TimelineActivitySource } from "./project.js";
