import { createHash } from "node:crypto";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import type { ArtifactKind, CorpusAllowedMedia, CorpusRejectionReason, PrivacyClass } from "@cd-collab/contracts";
import {
  CORPUS_ALLOWED_EXTENSIONS,
  CORPUS_ALLOWED_MEDIA,
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
  if (bytes.includes(0)) return true;
  let odd = 0;
  for (const octet of bytes) {
    if (octet < 9 || (octet > 13 && octet < 32)) odd += 1;
  }
  return odd > bytes.length / 5;
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
  if (looksBinary(bytes)) {
    return {
      relativePath: normalized.path,
      reason: "binary_or_unknown",
      detail: "bytes are not treated as text",
    };
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return {
      relativePath: normalized.path,
      reason: "binary_or_unknown",
      detail: "bytes are not valid UTF-8 text",
    };
  }
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
  };
}
