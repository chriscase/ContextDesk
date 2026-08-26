import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  archiveExceedsLimit,
  compressionRatioExceedsLimit,
  expandedBytesExceedLimit,
  fileCountExceedsLimit,
  fileExceedsLimit,
  processingExceedsLimit,
} from "./limits.js";

describe("corpus intake capacity boundaries", () => {
  it("accepts every exact byte/count/time limit and rejects one unit over", () => {
    expect(archiveExceedsLimit(CORPUS_INTAKE_LIMITS.maxArchiveBytes)).toBe(false);
    expect(archiveExceedsLimit(CORPUS_INTAKE_LIMITS.maxArchiveBytes + 1)).toBe(true);
    expect(fileExceedsLimit(CORPUS_INTAKE_LIMITS.maxFileBytes)).toBe(false);
    expect(fileExceedsLimit(CORPUS_INTAKE_LIMITS.maxFileBytes + 1)).toBe(true);
    expect(fileCountExceedsLimit(CORPUS_INTAKE_LIMITS.maxFileCount)).toBe(false);
    expect(fileCountExceedsLimit(CORPUS_INTAKE_LIMITS.maxFileCount + 1)).toBe(true);
    expect(expandedBytesExceedLimit(0, CORPUS_INTAKE_LIMITS.maxExpandedBytes)).toBe(false);
    expect(expandedBytesExceedLimit(1, CORPUS_INTAKE_LIMITS.maxExpandedBytes)).toBe(true);
    expect(processingExceedsLimit(0, CORPUS_INTAKE_LIMITS.maxProcessingMs)).toBe(false);
    expect(processingExceedsLimit(0, CORPUS_INTAKE_LIMITS.maxProcessingMs + 1)).toBe(true);
  });

  it("accepts compression ratio 256 and rejects any ratio above it", () => {
    expect(compressionRatioExceedsLimit(1, CORPUS_INTAKE_LIMITS.maxCompressionRatio)).toBe(false);
    expect(compressionRatioExceedsLimit(1, CORPUS_INTAKE_LIMITS.maxCompressionRatio + 1)).toBe(true);
    expect(compressionRatioExceedsLimit(0, CORPUS_INTAKE_LIMITS.maxExpandedBytes)).toBe(false);
  });
});
