import { join } from "node:path";
import {
  CORPUS_INTAKE_LIMITS,
  CorpusIntakeLimitError,
  resolveCorpusIntakeLimits,
  type CorpusIntakeLimitsV1,
  type CorpusTextEncoding,
} from "@cd-collab/contracts";

/**
 * Owner-local intake limits, read from the deployment's own environment.
 *
 * Every key here is optional: an operator who sets nothing gets the
 * conservative defaults. What an operator cannot do is set a limit the runtime
 * would not honour — `resolveCorpusIntakeLimits` refuses those at boot, where a
 * misconfiguration is visible, rather than at the first large upload.
 */
const NUMERIC_ENV: Record<string, keyof CorpusIntakeLimitsV1> = {
  COLLAB_CORPUS_MAX_REQUEST_BYTES: "maxRequestBytes",
  COLLAB_CORPUS_MAX_ARCHIVE_BYTES: "maxArchiveBytes",
  COLLAB_CORPUS_MAX_EXPANDED_BYTES: "maxExpandedBytes",
  COLLAB_CORPUS_MAX_COMPRESSION_RATIO: "maxCompressionRatio",
  COLLAB_CORPUS_MAX_FILE_COUNT: "maxFileCount",
  COLLAB_CORPUS_MAX_PATH_DEPTH: "maxPathDepth",
  COLLAB_CORPUS_MAX_ARCHIVE_DEPTH: "maxArchiveDepth",
  COLLAB_CORPUS_MAX_PATH_LENGTH: "maxPathLength",
  COLLAB_CORPUS_MAX_FILE_BYTES: "maxFileBytes",
  COLLAB_CORPUS_MAX_PROCESSING_MS: "maxProcessingMs",
  COLLAB_CORPUS_MAX_EXPANSION_MS: "maxExpansionMs",
  COLLAB_CORPUS_MAX_LINE_BYTES: "maxLineBytes",
  COLLAB_CORPUS_MAX_STRUCTURED_PARSE_BYTES: "maxStructuredParseBytes",
};

export const CORPUS_INTAKE_LIMIT_ENV_KEYS = [
  ...Object.keys(NUMERIC_ENV),
  "COLLAB_CORPUS_SUPPORTED_ENCODINGS",
] as const;

export function loadCorpusIntakeLimits(
  env: NodeJS.ProcessEnv = process.env,
): CorpusIntakeLimitsV1 {
  const overrides: Partial<CorpusIntakeLimitsV1> = {};
  for (const [name, key] of Object.entries(NUMERIC_ENV)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || String(value) !== raw) {
      throw new CorpusIntakeLimitError(key, `must be an integer, got ${raw} from ${name}`);
    }
    (overrides as Record<string, number>)[key] = value;
  }
  const encodings = env.COLLAB_CORPUS_SUPPORTED_ENCODINGS?.trim();
  if (encodings) {
    overrides.supportedEncodings = encodings
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0) as CorpusTextEncoding[];
  }
  return resolveCorpusIntakeLimits(overrides);
}

/**
 * Where in-flight intake spools. It sits beside evidence rather than in the
 * evidence tree itself: spool bytes are not addressable evidence, and a
 * recovery sweep must be free to delete them.
 */
export function corpusIntakeSpoolRoot(
  env: NodeJS.ProcessEnv,
  evidenceRoot: string,
): string {
  return env.COLLAB_CORPUS_SPOOL_ROOT?.trim() || join(evidenceRoot, "..", "intake-spool");
}

export { CORPUS_INTAKE_LIMITS };
