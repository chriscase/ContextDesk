/** Browser-safe lifecycle vocabulary for an investigation reference. */
export const REFERENCE_STATES = ["active", "withdrawn"] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];
