import { createHash } from "node:crypto";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import type { ArtifactKind, CorpusAllowedMedia, CorpusRejectionReason, PrivacyClass } from "@cd-collab/contracts";
import {
  CORPUS_ALLOWED_EXTENSIONS,
  CORPUS_ALLOWED_MEDIA,
  CORPUS_INTAKE_LIMITS,
} from "@cd-collab/contracts";
import { isNestedArchive, normalizeIntakePath } from "./zip.js";

const EXT_MEDIA: Record<string, CorpusAllowedMedia> = {
  ".log": "text/x-log",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".eml": "message/rfc822",
};

export interface ClassifiedFile {
  relativePath: string;
  mediaType: CorpusAllowedMedia;
  artifactKind: ArtifactKind;
  bytes: Uint8Array;
  digest: string;
}

export interface ClassifiedRejection {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  if (sample.includes(0)) return true;
  let odd = 0;
  for (const octet of sample) {
    if (octet < 9 || (octet > 13 && octet < 32)) odd += 1;
  }
  return odd > sample.length / 5;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function classifyBytes(
  relativePath: string,
  bytes: Uint8Array,
  claimedMedia: string | undefined,
  privacyClass: PrivacyClass,
): ClassifiedFile | ClassifiedRejection {
  const normalized = normalizeIntakePath(relativePath);
  if (!normalized.ok) {
    return { relativePath, reason: normalized.reason, detail: normalized.detail };
  }
  if (bytes.byteLength > CORPUS_INTAKE_LIMITS.maxFileBytes) {
    return { relativePath: normalized.path, reason: "file_too_large", detail: "file exceeds cap" };
  }
  if (isNestedArchive(normalized.path)) {
    return {
      relativePath: normalized.path,
      reason: "nested_archive",
      detail: "nested archives are unsupported",
    };
  }
  const ext = extensionOf(normalized.path);
  if (!(CORPUS_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      relativePath: normalized.path,
      reason: "unsupported_media",
      detail: "extension is not in the intake allowlist",
    };
  }
  const media = EXT_MEDIA[ext];
  if (!media || !(CORPUS_ALLOWED_MEDIA as readonly string[]).includes(media)) {
    return {
      relativePath: normalized.path,
      reason: "unsupported_media",
      detail: "media type is not allowlisted",
    };
  }
  if (claimedMedia && claimedMedia !== "application/octet-stream" && claimedMedia !== media && claimedMedia !== "text/plain") {
    return {
      relativePath: normalized.path,
      reason: "unsupported_media",
      detail: "declared media type does not match allowlist",
    };
  }
  if (looksBinary(bytes) && media !== "message/rfc822") {
    return {
      relativePath: normalized.path,
      reason: "binary_or_unknown",
      detail: "bytes are not treated as text",
    };
  }
  if (privacyClass === "share_safe") {
    const text = Buffer.from(bytes).toString("utf8");
    const findings = scanShareSafePrivacy(text);
    if (findings.length > 0) {
      return {
        relativePath: normalized.path,
        reason: "redaction_failed",
        detail: "share-safe privacy gate rejected the file",
      };
    }
  }
  const artifactKind: ArtifactKind = media === "message/rfc822" ? "email" : "log";
  return {
    relativePath: normalized.path,
    mediaType: media,
    artifactKind,
    bytes,
    digest: digestOf(bytes),
  };
}
