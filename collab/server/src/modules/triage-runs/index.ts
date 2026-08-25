/** Snapshot-bound triage job orchestration and comparison-ready run history. */
export const MODULE_ID = "triage-runs" as const;

export {
  DeterministicMockTriageExecutor,
  TriageRunConflictError,
  TriageRunNotFoundError,
  TriageRunService,
} from "./service.js";
export type {
  TriageBatchExecutionContext,
  TriageBatchRunExecutor,
  TriageExecutionContext,
  TriageExecutionEvidence,
  TriageRunExecutor,
} from "./service.js";
export { MemoryTriageJobStore, PgTriageJobStore, triageRunningLeaseExpired, triageWorkerHoldsLiveLease } from "./store.js";
export type { OverviewJobQuery, OverviewListedJob, TriageJobStore } from "./store.js";
export { loadConfiguredTriageProfileCatalog, parseTriageProfileCatalog } from "./profiles.js";
export type { TriageProfileOption } from "./profiles.js";
export { RustBridgeTriageExecutor } from "./runner.js";
export type { RustBridgeTriageExecutorOptions } from "./runner.js";
export { triageBridgeOptions } from "./runtime-config.js";
export { listCaseWorkstreams } from "./workstreams.js";
export { registerTriageRunRoutes } from "./routes.js";
export type { TriageRunRouteDeps } from "./routes.js";
