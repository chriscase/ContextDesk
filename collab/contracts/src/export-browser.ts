/**
 * Browser-safe export envelope contract.
 *
 * The parser is re-exported rather than wrapped so browser and server callers
 * execute one authoritative implementation. Node-only hashing and cursor
 * helpers stay outside this entry's transitive import graph.
 */
export {
  EXPORT_ENVELOPE_SCHEMA_ID,
  EXPORT_INVENTORY_SCHEMA_ID,
  EXPORT_KINDS,
  parseExportEnvelope,
  parseExportInventory,
} from "./export.js";
export type {
  ExportEnvelopeV1,
  ExportInventoryItemV1,
  ExportInventoryV1,
  ExportKind,
} from "./export.js";
