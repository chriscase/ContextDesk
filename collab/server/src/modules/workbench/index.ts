/** Investigation-scoped Log workbench. */
export const MODULE_ID = "workbench" as const;

export { MemoryWorkbenchStore, PgWorkbenchStore } from "./store.js";
export type {
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

export { createWorkbenchCasePort } from "./case-port.js";
export type { WorkbenchCasePortDeps } from "./case-port.js";
