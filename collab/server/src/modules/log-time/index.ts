/** Case-bound log corpus and per-source timezone review for the War Room. */
export const MODULE_ID = "log-time" as const;

export {
  LOG_TIME_REQUEST_SCHEMA_ID,
  LOG_TIME_RESULT_SCHEMA_ID,
  LogTimeConflictError,
  LogTimeNotFoundError,
  LogTimeRequestError,
  ProcessLogTimeBridge,
} from "./bridge.js";
export type {
  HostBuild,
  HostDeclaration,
  HostPreview,
  HostResult,
  HostRevision,
  HostSample,
  HostSourceStatus,
  LogTimeAction,
  LogTimeBridge,
  LogTimeBridgeOptions,
  LogTimeFileInput,
} from "./bridge.js";

export { MemoryLogTimeStore, PgLogTimeStore } from "./store.js";
export type {
  LogCorpusRow,
  LogTimeDeclarationRow,
  LogTimeDependentRow,
  LogTimeOperationRow,
  LogTimeStore,
} from "./store.js";

export { LogTimeService } from "./service.js";
export type { LogTimeCasePort, LogTimeServiceDeps } from "./service.js";

export { createLogTimeCasePort } from "./case-port.js";
export type { LogTimeCasePortDeps } from "./case-port.js";

export { logTimeBridgeOptions } from "./runtime-config.js";

export { registerLogTimeRoutes } from "./routes.js";
export type { LogTimeRouteDeps } from "./routes.js";
