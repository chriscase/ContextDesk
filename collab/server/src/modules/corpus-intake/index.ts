/** Investigation-scoped ZIP/directory/file corpus intake. */
export const MODULE_ID = "corpus-intake" as const;

export { extractZip, buildTestZip, buildUnicodePathExtra, isNestedArchive, normalizeIntakePath, ZipError } from "./zip.js";
export type { ZipExtractResult, ZipMember, ZipRejection, TestZipFile, TestZipOptions } from "./zip.js";
export { walkZip, CorpusIntakeCancelled } from "./zip-walk.js";
export type { ZipBudget, ZipWalkMember, ZipWalkOptions } from "./zip-walk.js";
export { fileByteSource, memoryByteSource } from "./byte-source.js";
export type { ByteSource } from "./byte-source.js";
export { classifyStream } from "./classify-stream.js";
export type { StreamClassification } from "./classify-stream.js";
export type { StagedCorpusEntry, StagedCorpusIntake } from "./staged.js";
export {
  archiveExceedsLimit,
  compressionRatioExceedsLimit,
  expandedBytesExceedLimit,
  fileCountExceedsLimit,
  fileExceedsLimit,
  processingExceedsLimit,
  requestExceedsLimit,
} from "./limits.js";
export { classifyBytes, digestOf } from "./classify.js";
export type { ClassifiedFile, ClassifiedRejection } from "./classify.js";
export {
  previewCorpusBytes,
  corpusIntakeRequestDigest,
  duplicateDigestFlags,
  decodeBase64,
} from "./preview.js";
export { registerCorpusIntakeRoutes } from "./routes.js";
export type { CorpusIntakeRouteDeps } from "./routes.js";
export { registerCorpusIntakeSessionRoutes } from "./session-routes.js";
export type { CorpusIntakeSessionRouteDeps } from "./session-routes.js";
export { CorpusIntakeSessionService, DEFAULT_SESSION_TTL_MS } from "./session.js";
export type { CorpusIntakeSessionDeps } from "./session.js";
export { CorpusIntakeSpool } from "./spool.js";
export { CorpusIntakeRequestError, codeForRejection, intakeError } from "./errors.js";
export {
  CORPUS_INTAKE_LIMIT_ENV_KEYS,
  corpusIntakeSpoolRoot,
  loadCorpusIntakeLimits,
} from "./owner-limits.js";
