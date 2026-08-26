import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";

export function archiveExceedsLimit(byteLength: number): boolean {
  return byteLength > CORPUS_INTAKE_LIMITS.maxArchiveBytes;
}

export function expandedBytesExceedLimit(current: number, next: number): boolean {
  return next > CORPUS_INTAKE_LIMITS.maxExpandedBytes - current;
}

export function fileCountExceedsLimit(count: number): boolean {
  return count > CORPUS_INTAKE_LIMITS.maxFileCount;
}

export function fileExceedsLimit(byteLength: number): boolean {
  return byteLength > CORPUS_INTAKE_LIMITS.maxFileBytes;
}

export function processingExceedsLimit(startedAt: number, now = Date.now()): boolean {
  return now - startedAt > CORPUS_INTAKE_LIMITS.maxProcessingMs;
}

export function compressionRatioExceedsLimit(
  compressedBytes: number,
  expandedBytes: number,
): boolean {
  return compressedBytes > 0
    && expandedBytes > compressedBytes * CORPUS_INTAKE_LIMITS.maxCompressionRatio;
}
