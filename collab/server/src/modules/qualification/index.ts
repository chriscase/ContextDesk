/** Release qualification over current Experiment Lab and case-memory seams. */
export const MODULE_ID = "qualification" as const;

export { runQualification } from "./harness.js";
export type { QualificationDeps } from "./harness.js";
export { runFakeHostLanes, exerciseHostLaneContracts, DEFAULT_HOST_LANE_CONCURRENCY } from "./host-lanes.js";
export { inspectLiveProfiles } from "./live.js";
