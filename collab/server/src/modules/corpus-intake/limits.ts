import { CORPUS_INTAKE_LIMITS, type CorpusIntakeLimitsV1 } from "@cd-collab/contracts";

/**
 * Numeric intake gates.
 *
 * Every gate takes the resolved limits it should enforce. Defaulting to the
 * built-in set keeps the inline lane's call sites unchanged, while the streamed
 * lane threads an owner-local configuration through the same functions — one
 * enforcement path, so an advertised limit and an enforced limit cannot drift.
 */
export function archiveExceedsLimit(
  byteLength: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return byteLength > limits.maxArchiveBytes;
}

export function expandedBytesExceedLimit(
  current: number,
  next: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return next > limits.maxExpandedBytes - current;
}

export function fileCountExceedsLimit(
  count: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return count > limits.maxFileCount;
}

export function fileExceedsLimit(
  byteLength: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return byteLength > limits.maxFileBytes;
}

export function processingExceedsLimit(
  startedAt: number,
  now = Date.now(),
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return now - startedAt > limits.maxProcessingMs;
}

export function expansionExceedsLimit(
  startedAt: number,
  now = Date.now(),
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return now - startedAt > limits.maxExpansionMs;
}

export function compressionRatioExceedsLimit(
  compressedBytes: number,
  expandedBytes: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return compressedBytes > 0
    && expandedBytes > compressedBytes * limits.maxCompressionRatio;
}

export function requestExceedsLimit(
  byteLength: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return byteLength > limits.maxRequestBytes;
}

export function archiveDepthExceedsLimit(
  depth: number,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): boolean {
  return depth > limits.maxArchiveDepth;
}
