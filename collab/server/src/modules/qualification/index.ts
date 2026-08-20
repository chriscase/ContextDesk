/** Release-qualification harness for the collaborative triage workflow. */
export const MODULE_ID = "qualification" as const;

export { runQualification } from "./harness.js";
export type { QualificationDeps } from "./harness.js";
