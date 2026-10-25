/** Browser-safe vocabulary for how an investigation resolution was reached. */
export const RESOLUTION_BASES = [
  "human_only",
  "experiment_decision",
  "reasoned_exception",
] as const;
export type ResolutionBasis = (typeof RESOLUTION_BASES)[number];
