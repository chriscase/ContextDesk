/** Immutable provenance: revision chains and tombstones. */
export const MODULE_ID = "provenance" as const;

export { LegalHoldError, assertCanTombstone, visibleBody } from "./chain.js";
