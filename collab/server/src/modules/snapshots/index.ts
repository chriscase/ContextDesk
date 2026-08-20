/** Frozen war-room evidence snapshots and derived case boards. */
export const MODULE_ID = "snapshots" as const;

export {
  SnapshotConflictError,
  SnapshotNotFoundError,
  SnapshotService,
} from "./service.js";
export type { FreezeSnapshotInput } from "./service.js";
export { MemorySnapshotStore } from "./store.js";
export type { SnapshotStore } from "./store.js";
