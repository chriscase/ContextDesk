/** Source catalog: human, external-tool, internal-system, contextdesk, unknown. */
export const MODULE_ID = "catalog" as const;

export {
  CatalogService,
  CatalogMutationRefusedError,
  CatalogVersionedSourceError,
  CatalogPermanentUnknownError,
  CatalogCommitOutcomeUnknownError,
  withCatalogCaseMutation,
} from "./service.js";
export type { CatalogActor } from "./service.js";
export {
  MemoryCatalogStore,
  PgCatalogStore,
  CatalogIdentityBoundError,
  CatalogMutationBoundaryError,
} from "./store.js";
export type { CatalogStore, SourceRow, SourceCatalogSuccessIntent } from "./store.js";
export { registerCatalogRoutes } from "./routes.js";
export type { CatalogRouteDeps } from "./routes.js";
export { isSourceKind } from "./model.js";
export { directoryAttribution, projectSourceForCaller } from "./project.js";
