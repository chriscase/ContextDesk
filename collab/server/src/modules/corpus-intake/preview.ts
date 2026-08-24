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
    if (input.archive.byteLength > CORPUS_INTAKE_LIMITS.maxArchiveBytes) {
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

  if (incoming.length > CORPUS_INTAKE_LIMITS.maxFileCount) {
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

  for (const file of incoming) {
    if (Date.now() - startedAt > CORPUS_INTAKE_LIMITS.maxProcessingMs) {
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
      duplicateDigest: known.has(result.digest) || classified.filter((row) => row.digest === result.digest).length > 1,
    });
  }

  // Recompute duplicateDigest against the batch itself after all classified.
  const counts = new Map<string, number>();
  for (const row of classified) counts.set(row.digest, (counts.get(row.digest) ?? 0) + 1);
  for (const row of accepted) {
    row.duplicateDigest = known.has(row.digest) || (counts.get(row.digest) ?? 0) > 1;
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

export function decodeBase64(path: string, raw: string): Uint8Array {
  const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (raw.length % 4 !== 0 || !canonical.test(raw)) {
    throw new Error(`${path} is not valid base64`);
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.toString("base64") !== raw) {
    throw new Error(`${path} is not valid base64`);
  }
  return Uint8Array.from(decoded);
}

export { digestOf };
