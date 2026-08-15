/** Portable triage-brief and selected-evidence package export. Read-only. */
export const MODULE_ID = "export" as const;

export { ExportService, PrivacyScanError, isPrivacyClass } from "./service.js";
export type { ExportSelection } from "./service.js";
export { registerExportRoutes } from "./routes.js";
export type { ExportRouteDeps } from "./routes.js";
export {
  loadExportPrivacyConfig,
  testExportPrivacyConfig,
  parseRedactionMap,
} from "./config.js";
export type { ExportPrivacyConfig } from "./config.js";
export { canonicalJson, sha256Text } from "./canonical.js";
