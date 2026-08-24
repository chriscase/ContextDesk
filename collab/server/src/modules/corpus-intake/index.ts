/** Investigation-scoped ZIP/directory/file corpus intake. */
export const MODULE_ID = "corpus-intake" as const;

export { extractZip, buildTestZip, isNestedArchive, normalizeIntakePath, ZipError } from "./zip.js";
export type { ZipExtractResult, ZipMember, ZipRejection } from "./zip.js";
export { classifyBytes, digestOf } from "./classify.js";
export type { ClassifiedFile, ClassifiedRejection } from "./classify.js";
export { previewCorpusBytes, decodeBase64 } from "./preview.js";
export { registerCorpusIntakeRoutes } from "./routes.js";
export type { CorpusIntakeRouteDeps } from "./routes.js";
