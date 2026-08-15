/** Source catalog: human, external-tool, internal-system, contextdesk, unknown. */
export const MODULE_ID = "catalog" as const;

export { CatalogService } from "./service.js";
export type { CatalogActor } from "./service.js";
export { MemoryCatalogStore, PgCatalogStore } from "./store.js";
export type { CatalogStore } from "./store.js";
export { registerCatalogRoutes } from "./routes.js";
export type { CatalogRouteDeps } from "./routes.js";
export { isSourceKind } from "./model.js";
