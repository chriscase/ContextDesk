/** Share-safe experiment package review loop. */
export const MODULE_ID = "experiments" as const;

export { ExperimentService, ExperimentConflictError, ExperimentNotFoundError } from "./service.js";
export type { ExperimentView, PromoteGoldInput } from "./service.js";
export { alignExperimentCandidates } from "./align.js";
export { MemoryExperimentStore, PgExperimentStore } from "./store.js";
export type { ExperimentStore } from "./store.js";
export { registerExperimentRoutes } from "./routes.js";
export type { ExperimentRouteDeps } from "./routes.js";
export { projectCandidateMatrix, projectReviewExport } from "./project.js";
