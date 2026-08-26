import {
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_REPORT_SCHEMA_ID,
  type CorpusAcceptedFileV1,
  type CorpusIntakeOrigin,
  type CorpusIntakePreviewReportV1,
  type CorpusRejectedFileV1,
  type PrivacyClass,
} from "@cd-collab/contracts";
import { createHash } from "node:crypto";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import { classifyBytes, digestOf, type ClassifiedFile } from "./classify.js";
import { ZipError, extractZip } from "./zip.js";
import {
  archiveExceedsLimit,
  expandedBytesExceedLimit,
  fileCountExceedsLimit,
  processingExceedsLimit,
} from "./limits.js";

export interface PreviewInput {
  caseId: string;
  actorId: string;
  origin: CorpusIntakeOrigin;
  privacyClass: PrivacyClass;
  sourceLabel: string;
  idempotencyKey: string;
  files: Array<{ relativePath: string; mediaType?: string; bytes: Uint8Array }>;
  archive?: Uint8Array | null;
  knownDigests?: Set<string>;
  startedAt?: number;
}

export interface PreviewOutcome {
  report: CorpusIntakePreviewReportV1;
  classified: ClassifiedFile[];
}

function framed(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

/**
 * Honest duplicate classification against a live known-digest set.
 * A digest already present in the investigation, or present more than once in
 * this batch, is a duplicate. Callers must supply `known` observed after the
 * per-digest lock so concurrent distinct-key commits cannot both claim original.
 */
export function duplicateDigestFlags(
  digests: readonly string[],
  known: ReadonlySet<string>,
): boolean[] {
  const counts = new Map<string, number>();
  for (const digest of digests) counts.set(digest, (counts.get(digest) ?? 0) + 1);
  return digests.map((digest) => known.has(digest) || (counts.get(digest) ?? 0) > 1);
}

export function corpusIntakeRequestDigest(input: PreviewInput): string {
  const hash = createHash("sha256");
  for (const value of [
    input.caseId,
    input.actorId,
    input.origin,
    input.sourceLabel,
    input.privacyClass,
    input.idempotencyKey,
  ]) {
    framed(hash, value);
  }
  framed(hash, input.archive ?? new Uint8Array());
  for (const file of input.files) {
    framed(hash, file.relativePath);
    framed(hash, file.mediaType ?? "");
    framed(hash, file.bytes);
  }
  return hash.digest("hex");
}

function decodeArchive(archive: Uint8Array, startedAt: number): {
  files: Array<{ relativePath: string; bytes: Uint8Array }>;
  rejected: CorpusRejectedFileV1[];
} {
  try {
    const extracted = extractZip(archive, startedAt);
    return {
      files: extracted.members.map((row) => ({ relativePath: row.relativePath, bytes: row.bytes })),
      rejected: extracted.rejected,
    };
  } catch (error) {
    if (error instanceof ZipError) {
      return {
        files: [],
        rejected: [{ relativePath: "", reason: error.reason, detail: error.message }],
      };
    }
    throw error;
  }
}

export function previewCorpusBytes(input: PreviewInput): PreviewOutcome {
  const startedAt = input.startedAt ?? Date.now();
  const previewToken = corpusIntakeRequestDigest(input);
  const rejected: CorpusRejectedFileV1[] = [];
  const incoming: Array<{ relativePath: string; mediaType?: string; bytes: Uint8Array }> = [];
  if (input.archive && input.archive.byteLength > 0) {
    if (archiveExceedsLimit(input.archive.byteLength)) {
      rejected.push({
        relativePath: "",
        reason: "oversized_archive",
        detail: "archive exceeds byte cap",
      });
    } else {
      const unpacked = decodeArchive(input.archive, startedAt);
      rejected.push(...unpacked.rejected);
      incoming.push(...unpacked.files);
    }
  }
  incoming.push(...input.files);

  if (
    input.privacyClass === "share_safe"
    && scanShareSafePrivacy({ sourceLabel: input.sourceLabel }).length > 0
  ) {
    return {
      classified: [],
      report: {
        schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
        caseId: input.caseId,
        origin: input.origin,
        previewToken,
        accepted: [],
        rejected: [{
          relativePath: "",
          reason: "redaction_failed",
          detail: "share-safe privacy gate rejected intake metadata",
        }],
        limits: CORPUS_INTAKE_LIMITS,
      },
    };
  }

  const classified: ClassifiedFile[] = [];
  const seenPath = new Set<string>();
  const known = input.knownDigests ?? new Set<string>();
  const accepted: CorpusAcceptedFileV1[] = [];

  if (fileCountExceedsLimit(incoming.length)) {
    return {
      classified: [],
      report: {
        schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
        caseId: input.caseId,
        origin: input.origin,
        previewToken,
        accepted: [],
        rejected: [
          {
            relativePath: "",
            reason: "too_many_files",
            detail: "file count exceeds cap",
          },
        ],
        limits: CORPUS_INTAKE_LIMITS,
      },
    };
  }

  let expandedBytes = 0;
  for (const file of incoming) {
    if (expandedBytesExceedLimit(expandedBytes, file.bytes.byteLength)) {
      return {
        classified: [],
        report: {
          schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
          caseId: input.caseId,
          origin: input.origin,
          previewToken,
          accepted: [],
          rejected: [{
            relativePath: file.relativePath,
            reason: "oversized_expanded",
            detail: "expanded size exceeds cap",
          }],
          limits: CORPUS_INTAKE_LIMITS,
        },
      };
    }
    expandedBytes += file.bytes.byteLength;
  }

  for (const file of incoming) {
    if (processingExceedsLimit(startedAt)) {
      rejected.push({
        relativePath: file.relativePath,
        reason: "processing_timeout",
        detail: "intake exceeded time cap",
      });
      continue;
    }
    const result = classifyBytes(file.relativePath, file.bytes, file.mediaType, input.privacyClass);
    if ("reason" in result) {
      rejected.push(result);
      continue;
    }
    const fold = result.relativePath.toLocaleLowerCase("en-US");
    if (seenPath.has(fold)) {
      rejected.push({
        relativePath: result.relativePath,
        reason: "duplicate_normalized_path",
        detail: "duplicate path in this batch",
      });
      continue;
    }
    seenPath.add(fold);
    classified.push(result);
    accepted.push({
      relativePath: result.relativePath,
      mediaType: result.mediaType,
      artifactKind: result.artifactKind,
      byteLength: result.bytes.byteLength,
      digest: result.digest,
      duplicateDigest: false,
      encodingStatus: result.encodingStatus,
    });
  }

  const flags = duplicateDigestFlags(
    classified.map((row) => row.digest),
    known,
  );
  for (const [index, row] of accepted.entries()) {
    row.duplicateDigest = flags[index] ?? false;
  }

  return {
    classified,
    report: {
      schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
      caseId: input.caseId,
      origin: input.origin,
      previewToken,
      accepted,
      rejected,
      limits: CORPUS_INTAKE_LIMITS,
    },
  };
}

/**
 * Base64 alphabet check as a linear scan.
 *
 * The obvious spelling — `/^(?:[A-Za-z0-9+\/]{4})*.../` — overflows the regex
 * engine's stack once the payload is a few megabytes, because the outer `*`
 * builds a backtracking frame per group. A committed log file is routinely
 * that large, so the pattern turned a valid intake into "not valid base64".
 * Scanning the characters costs one pass and cannot overflow.
 */
function isBase64Alphabet(raw: string): boolean {
  let limit = raw.length;
  // Canonical padding is at most two `=`, and only at the very end.
  if (limit > 0 && raw.charCodeAt(limit - 1) === 0x3d) limit -= 1;
  if (limit > 0 && raw.charCodeAt(limit - 1) === 0x3d) limit -= 1;
  for (let index = 0; index < limit; index += 1) {
    const code = raw.charCodeAt(index);
    const allowed =
      (code >= 0x41 && code <= 0x5a) // A-Z
      || (code >= 0x61 && code <= 0x7a) // a-z
      || (code >= 0x30 && code <= 0x39) // 0-9
      || code === 0x2b // +
      || code === 0x2f; // /
    if (!allowed) return false;
  }
  return true;
}

export function decodeBase64(path: string, raw: string): Uint8Array {
  if (raw.length % 4 !== 0 || !isBase64Alphabet(raw)) {
    throw new Error(`${path} is not valid base64`);
  }
  const decoded = Buffer.from(raw, "base64");
  // Round-tripping is the real canonical test: it rejects stray padding and
  // any non-canonical spelling the alphabet scan let through.
  if (decoded.toString("base64") !== raw) {
    throw new Error(`${path} is not valid base64`);
  }
  return Uint8Array.from(decoded);
}

export { digestOf };
