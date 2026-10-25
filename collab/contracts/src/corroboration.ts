/** Browser-safe vocabulary for the recorded corroboration state of an imported run. */
export const CORROBORATION_STATES = ["unverified", "corroborated", "contradicted"] as const;
export type CorroborationState = (typeof CORROBORATION_STATES)[number];
