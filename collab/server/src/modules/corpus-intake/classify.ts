import { createHash } from "node:crypto";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import type {
  ArtifactKind,
  CorpusAllowedMedia,
  CorpusRejectionReason,
  CorpusTextEncodingStatus,
  PrivacyClass,
} from "@cd-collab/contracts";
import {
  CORPUS_ALLOWED_MEDIA,
  corpusAllowedExtension,
} from "@cd-collab/contracts";
import { isNestedArchive, normalizeIntakePath } from "./zip.js";
import { fileExceedsLimit } from "./limits.js";

const EXT_MEDIA: Record<string, CorpusAllowedMedia> = {
  ".log": "text/x-log",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".eml": "message/rfc822",
};

/**
 * Header block an RFC 5322 message starts with, e.g. `From:` / `Subject:`.
 *
 * A mail client that exports one message per file routinely writes it with a
 * `.txt` extension, so extension and declared media type alone cannot separate
 * a saved email from a log. Reading the header block is what tells them apart.
 */
const EMAIL_HEADER = /^(from|to|cc|bcc|subject|date|message-id|reply-to|sender|return-path)\s*:/i;

/** True when the text opens with an RFC 5322 header block. */
function looksLikeEmail(text: string): boolean {
  const lines = text.split(/\r?\n/, 24);
  let headers = 0;
  let sawSubjectOrFrom = false;
  for (const line of lines) {
    // A blank line closes the header block; everything after it is the body.
    if (!line.trim()) break;
    // Continuation lines (leading whitespace) belong to the previous header.
    if (/^\s/.test(line) && headers > 0) continue;
    if (!EMAIL_HEADER.test(line)) return false;
    if (/^(from|subject)\s*:/i.test(line)) sawSubjectOrFrom = true;
    headers += 1;
  }
  // Require more than a single header so a log line like `date: ...` on its own
  // is not promoted to an email.
  return sawSubjectOrFrom && headers >= 2;
}

/**
 * The evidence kind a reader should see for one intake member.
 *
 * Calling every text file a "log" mislabels saved email and structured
 * attachments on the evidence board, where the kind is the first thing a
 * triage engineer reads. Classify only what the bytes actually support and
 * fall back to `log` for line-oriented text.
 */
function artifactKindFor(media: CorpusAllowedMedia, text: string): ArtifactKind {
  if (media === "message/rfc822") return "email";
  if (looksLikeEmail(text)) return "email";
  if (media === "text/x-log" || media === "text/plain") return "log";
  // CSV, JSON, XML, and Markdown are documents, not logs.
  return "attachment";
}

export interface ClassifiedFile {
  relativePath: string;
  mediaType: CorpusAllowedMedia;
  artifactKind: ArtifactKind;
  bytes: Uint8Array;
  digest: string;
  encodingStatus: CorpusTextEncodingStatus;
}

export interface ClassifiedRejection {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

function disallowedControlCount(bytes: Uint8Array): number {
  let count = 0;
  for (const octet of bytes) {
    if ((octet < 0x20 || octet === 0x7f) && ![0x09, 0x0a, 0x0c, 0x0d].includes(octet)) {
      count += 1;
    }
  }
  return count;
}

function invalidUtf8ByteCount(bytes: Uint8Array): number {
  let invalid = 0;
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? 0;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const fourth = bytes[index + 3];
    const continuation = (value: number | undefined) =>
      value !== undefined && value >= 0x80 && value <= 0xbf;
    const valid =
      (first >= 0xc2 && first <= 0xdf && continuation(second))
      || (first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf && continuation(third))
      || (first >= 0xe1 && first <= 0xec && continuation(second) && continuation(third))
      || (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f && continuation(third))
      || (first >= 0xee && first <= 0xef && continuation(second) && continuation(third))
      || (first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf && continuation(third) && continuation(fourth))
      || (first >= 0xf1 && first <= 0xf3 && continuation(second) && continuation(third) && continuation(fourth))
      || (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f && continuation(third) && continuation(fourth));
    if (valid) {
      index += first <= 0xdf ? 2 : first <= 0xef ? 3 : 4;
    } else {
      invalid += 1;
      index += 1;
    }
  }
  return invalid;
}

function looksBinary(bytes: Uint8Array, invalidUtf8Bytes: number): boolean {
  if (bytes.includes(0)) return true;
  return disallowedControlCount(bytes) * 16 > bytes.length
    || invalidUtf8Bytes * 8 > bytes.length;
}

const SHARE_SAFE_MEDIA = new Set<CorpusAllowedMedia>([
  "text/plain",
  "text/x-log",
  "text/csv",
  "text/markdown",
  "application/json",
]);

const CLAIM_ALIASES: Partial<Record<CorpusAllowedMedia, readonly string[]>> = {
  "text/x-log": ["text/plain"],
  "text/markdown": ["text/plain"],
};

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
  if (fileExceedsLimit(bytes.byteLength)) {
    return { relativePath: normalized.path, reason: "file_too_large", detail: "file exceeds cap" };
  }
  if (isNestedArchive(normalized.path)) {
    return {
      relativePath: normalized.path,
      reason: "nested_archive",
      detail: "nested archives are unsupported",
    };
  }
  const ext = corpusAllowedExtension(normalized.path);
  if (ext === null) {
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
  if (
    claimedMedia
    && claimedMedia !== "application/octet-stream"
    && claimedMedia !== media
    && !(CLAIM_ALIASES[media] ?? []).includes(claimedMedia)
  ) {
    return {
      relativePath: normalized.path,
      reason: "unsupported_media",
      detail: "declared media type does not match allowlist",
    };
  }
  const invalidUtf8Bytes = invalidUtf8ByteCount(bytes);
  if (looksBinary(bytes, invalidUtf8Bytes)) {
    return {
      relativePath: normalized.path,
      reason: "binary_or_unknown",
      detail: "bytes are not treated as text",
    };
  }
  const utf8 = decodeUtf8(bytes);
  const encodingStatus: CorpusTextEncodingStatus = utf8 === null ? "normalized_non_utf8" : "utf8";
  if (
    utf8 === null
    && (privacyClass === "share_safe"
      || !["text/plain", "text/x-log", "text/csv", "text/markdown"].includes(media))
  ) {
    return {
      relativePath: normalized.path,
      reason: "binary_or_unknown",
      detail: privacyClass === "share_safe"
        ? "non-UTF-8 text requires private intake before normalization review"
        : "structured content must be valid UTF-8 text",
    };
  }
  const text = utf8 ?? new TextDecoder("utf-8").decode(bytes);
  let structuredContent: unknown = text;
  if (media === "application/json") {
    try {
      structuredContent = JSON.parse(text);
    } catch {
      return {
        relativePath: normalized.path,
        reason: "unsupported_media",
        detail: "JSON content must be valid JSON",
      };
    }
  }
  if (privacyClass === "share_safe") {
    if (!SHARE_SAFE_MEDIA.has(media)) {
      return {
        relativePath: normalized.path,
        reason: "redaction_failed",
        detail: "media type is not supported by the share-safe privacy gate",
      };
    }
    const findings = scanShareSafePrivacy({
      relativePath: normalized.path,
      content: structuredContent,
    });
    if (findings.length > 0) {
      return {
        relativePath: normalized.path,
        reason: "redaction_failed",
        detail: "share-safe privacy gate rejected the file",
      };
    }
  }
  const artifactKind: ArtifactKind = artifactKindFor(media, text);
  return {
    relativePath: normalized.path,
    mediaType: media,
    artifactKind,
    bytes,
    digest: digestOf(bytes),
    encodingStatus,
  };
}
