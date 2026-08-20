/** Bounded host-triage job leases and comparison runner. */
export const MODULE_ID = "jobs" as const;

export {
  DEFAULT_COMPARISON_CONCURRENCY,
  DEFAULT_LEASE_MS,
  MAX_COMPARISON_CONCURRENCY,
  ComparisonJobRunner,
  memoryRunner,
} from "./runner.js";
export type { ComparisonLaneSpec, ComparisonRunInput, ComparisonRunResult } from "./runner.js";
export { FakeHostConnector, LiveHostConnector, inspectLiveProfiles } from "./connector.js";
export type { HostConnector, HostLaneRequest, HostLaneResult, LiveProfileState } from "./connector.js";
export {
  MemoryJobStore,
  PgJobStore,
  newJobId,
  payloadHash,
} from "./store.js";
export type { JobKind, JobRow, JobStatus, JobStore } from "./store.js";
export { SqliteJobStore, sqliteAvailable } from "./sqlite.js";
