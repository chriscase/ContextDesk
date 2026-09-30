/** The same strict owner-only gold parser is used by browser and server. */
export {
  GOLD_REFERENCE_EXPORT_SCHEMA_ID,
  goldPromotionFingerprint,
  parseGoldReference,
  parseGoldReferenceExport,
} from "./gold.js";
export type { GoldReferenceExportV1, GoldReferenceV1 } from "./gold.js";
