/** Investigation-scoped Log workbench. */
export const MODULE_ID = "workbench" as const;

export { MemoryWorkbenchStore, PgWorkbenchStore } from "./store.js";
export type {
  WorkbenchAnchorRow,
  WorkbenchBookmarkRow,
  WorkbenchStore,
  WorkbenchViewRow,
} from "./store.js";

export {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchService,
} from "./service.js";
export type {
  WorkbenchCasePort,
  WorkbenchEvidenceFile,
  WorkbenchServiceDeps,
} from "./service.js";

export { registerWorkbenchRoutes } from "./routes.js";
export type { WorkbenchRouteDeps } from "./routes.js";

export { createWorkbenchCasePort, workbenchHostEventStamps } from "./case-port.js";
export type { WorkbenchCasePortDeps, WorkbenchHostEventSource } from "./case-port.js";
