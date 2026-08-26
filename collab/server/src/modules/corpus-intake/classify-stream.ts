import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import {
  CORPUS_ALLOWED_MEDIA,
  CORPUS_INTAKE_LIMITS,
  corpusAllowedExtension,
  type ArtifactKind,
  type CorpusAllowedExtension,
  type CorpusAllowedMedia,
  type CorpusIntakeLimitsV1,
  type CorpusRejectionReason,
  type CorpusTextEncoding,
  type CorpusTextEncodingStatus,
  type PrivacyClass,
} from "@cd-collab/contracts";
import { fileExceedsLimit } from "./limits.js";
import { isNestedArchive, normalizeIntakePath } from "./zip-names.js";

const EXT_MEDIA: Record<string, CorpusAllowedMedia> = {
  ".log": "text/x-log",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".jsonl": "text/x-log",
  ".ndjson": "text/x-log",
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

/** Text kept from the start of a member for header sniffing; never the whole file. */
const HEAD_TEXT_BYTES = 16 * 1024;

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
function artifactKindFor(media: CorpusAllowedMedia, head: string): ArtifactKind {
  if (media === "message/rfc822") return "email";
  if (looksLikeEmail(head)) return "email";
  if (media === "text/x-log" || media === "text/plain") return "log";
  // CSV, JSON, XML, and Markdown are documents, not logs.
  return "attachment";
}

const SHARE_SAFE_MEDIA = new Set<CorpusAllowedMedia>([
  "text/plain",
  "text/x-log",
  "text/csv",
  "text/markdown",
  "application/json",
]);

const LINE_ORIENTED_MEDIA = new Set<CorpusAllowedMedia>([
  "text/plain",
  "text/x-log",
  "text/csv",
  "text/markdown",
]);

const CLAIM_ALIASES: Partial<Record<CorpusAllowedMedia, readonly string[]>> = {
  "text/x-log": ["text/plain"],
  "text/markdown": ["text/plain"],
};

// Browsers and operating systems commonly describe JSON Lines as ordinary
// JSON or x-ndjson. Keep those aliases extension-scoped so a `.log` file that
// claims JSON still fails the declared-media consistency check.
const EXT_CLAIM_ALIASES: Partial<Record<CorpusAllowedExtension, readonly string[]>> = {
  ".jsonl": ["application/json", "application/x-ndjson"],
  ".ndjson": ["application/json", "application/x-ndjson"],
};

function isJsonLinesExtension(ext: CorpusAllowedExtension): boolean {
  return ext === ".jsonl" || ext === ".ndjson";
}

/**
 * One indexed pass over a chunk that answers everything the byte level decides:
 * UTF-8 validity, NUL and control density, and how long the current line has
 * grown.
 *
 * These were three separate passes and an iterator-based loop, which is fine
 * for a mail attachment and hopeless for half a gigabyte of logs. Folding them
 * together keeps a large corpus's expansion dominated by I/O and hashing rather
 * than by classification, and carries only the bytes of a sequence split across
 * a chunk boundary.
 */
class ByteScanner {
  private needed = 0;
  private seen = 0;
  private lower = 0x80;
  private upper = 0xbf;
  invalidBytes = 0;
  nonAscii = false;
  nulBytes = 0;
  controlBytes = 0;
  lineBytes = 0;
  longestLineBytes = 0;

  update(bytes: Uint8Array): void {
    let needed = this.needed;
    let seen = this.seen;
    let lower = this.lower;
    let upper = this.upper;
    let invalid = this.invalidBytes;
    let nonAscii = this.nonAscii;
    let nul = this.nulBytes;
    let control = this.controlBytes;
    let line = this.lineBytes;
    let longest = this.longestLineBytes;
    for (let index = 0; index < bytes.length; index += 1) {
      const octet = bytes[index]!;
      if (octet === 0x0a) {
        if (line > longest) longest = line;
        line = 0;
      } else {
        line += 1;
      }
      if (octet === 0) {
        nul += 1;
      } else if (octet < 0x20) {
        if (octet !== 0x09 && octet !== 0x0a && octet !== 0x0c && octet !== 0x0d) control += 1;
      } else if (octet === 0x7f) {
        control += 1;
      }
      if (needed === 0) {
        if (octet <= 0x7f) continue;
        nonAscii = true;
        if (octet >= 0xc2 && octet <= 0xdf) {
          needed = 1;
        } else if (octet === 0xe0) {
          needed = 2;
          lower = 0xa0;
        } else if (octet >= 0xe1 && octet <= 0xec) {
          needed = 2;
        } else if (octet === 0xed) {
          needed = 2;
          upper = 0x9f;
        } else if (octet >= 0xee && octet <= 0xef) {
          needed = 2;
        } else if (octet === 0xf0) {
          needed = 3;
          lower = 0x90;
        } else if (octet >= 0xf1 && octet <= 0xf3) {
          needed = 3;
        } else if (octet === 0xf4) {
          needed = 3;
          upper = 0x8f;
        } else {
          invalid += 1;
        }
        seen = 0;
        continue;
      }
      const floor = seen === 0 ? lower : 0x80;
      const ceiling = seen === 0 ? upper : 0xbf;
      if (octet < floor || octet > ceiling) {
        // The truncated sequence and the byte that broke it are both invalid.
        invalid += seen + 1;
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        continue;
      }
      seen += 1;
      if (seen === needed) {
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
      }
    }
    this.needed = needed;
    this.seen = seen;
    this.lower = lower;
    this.upper = upper;
    this.invalidBytes = invalid;
    this.nonAscii = nonAscii;
    this.nulBytes = nul;
    this.controlBytes = control;
    this.lineBytes = line;
    this.longestLineBytes = longest;
  }

  finish(): void {
    if (this.needed > 0) {
      this.invalidBytes += this.seen + 1;
      this.needed = 0;
      this.seen = 0;
    }
    if (this.lineBytes > this.longestLineBytes) this.longestLineBytes = this.lineBytes;
  }
}

export interface StreamClassifyInput {
  relativePath: string;
  claimedMedia?: string | undefined;
  privacyClass: PrivacyClass;
  limits?: CorpusIntakeLimitsV1;
  bytes: AsyncIterable<Uint8Array>;
  /** Receives each validated chunk so the caller can stage it durably. */
  sink?: ((chunk: Uint8Array) => Promise<void>) | undefined;
  poll?: (() => void) | undefined;
}

export interface StreamClassificationAccepted {
  ok: true;
  relativePath: string;
  mediaType: CorpusAllowedMedia;
  artifactKind: ArtifactKind;
  byteLength: number;
  digest: string;
  encoding: CorpusTextEncoding;
  encodingStatus: CorpusTextEncodingStatus;
}

export interface StreamClassificationRejected {
  ok: false;
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

export type StreamClassification =
  | StreamClassificationAccepted
  | StreamClassificationRejected;

function decoderFor(encoding: CorpusTextEncoding): TextDecoder {
  if (encoding === "utf-16le") return new TextDecoder("utf-16le");
  if (encoding === "utf-16be") return new TextDecoder("utf-16be");
  return new TextDecoder("utf-8");
}

/**
 * Classify one member while its bytes stream past exactly once.
 *
 * Nothing whole-file is retained unless the media genuinely needs it (a JSON
 * document), and that case is itself capped by `maxStructuredParseBytes`. Every
 * refusal names the specific thing an operator would have to change.
 */
export async function classifyStream(
  input: StreamClassifyInput,
): Promise<StreamClassification> {
  const limits = input.limits ?? CORPUS_INTAKE_LIMITS;
  const reject = (
    relativePath: string,
    reason: CorpusRejectionReason,
    detail: string,
  ): StreamClassificationRejected => ({ ok: false, relativePath, reason, detail });

  const normalized = normalizeIntakePath(input.relativePath, limits);
  if (!normalized.ok) {
    return reject(input.relativePath, normalized.reason, normalized.detail);
  }
  const path = normalized.path;
  if (isNestedArchive(path)) {
    return reject(path, "nested_archive", "nested archives are unsupported");
  }
  const ext = corpusAllowedExtension(path);
  if (ext === null) {
    return reject(path, "unsupported_media", "extension is not in the intake allowlist");
  }
  const media = EXT_MEDIA[ext];
  if (!media || !(CORPUS_ALLOWED_MEDIA as readonly string[]).includes(media)) {
    return reject(path, "unsupported_media", "media type is not allowlisted");
  }
  const claimed = input.claimedMedia;
  if (
    claimed
    && claimed !== "application/octet-stream"
    && claimed !== media
    && !(CLAIM_ALIASES[media] ?? []).includes(claimed)
    && !(EXT_CLAIM_ALIASES[ext] ?? []).includes(claimed)
  ) {
    return reject(path, "unsupported_media", "declared media type does not match allowlist");
  }

  const jsonLines = isJsonLinesExtension(ext);
  const shareSafe = input.privacyClass === "share_safe";
  const wholeText = media === "application/json"
    || (shareSafe && !jsonLines && !LINE_ORIENTED_MEDIA.has(media));
  const needLines = jsonLines || (shareSafe && LINE_ORIENTED_MEDIA.has(media));

  const hash = createHash("sha256");
  const scanner = new ByteScanner();
  let byteLength = 0;
  let encoding: CorpusTextEncoding | null = null;
  let decoder: TextDecoder | null = null;
  let head = "";
  let pendingLine = "";
  let wholeTextBuffer = "";
  let jsonLineRecords = 0;
  let failure: StreamClassificationRejected | null = null;
  let bomSkip = 0;
  let wideLineBytes = 0;

  const consumeLine = (line: string): StreamClassificationRejected | null => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (jsonLines) {
      if (trimmed.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return reject(
            path,
            "unsupported_media",
            "JSON Lines content must contain valid JSON on every non-empty line",
          );
        }
        jsonLineRecords += 1;
        if (shareSafe && scanShareSafePrivacy(parsed).length > 0) {
          return reject(path, "redaction_failed", "share-safe privacy gate rejected the file");
        }
      }
      return null;
    }
    if (
      shareSafe && trimmed
      && scanShareSafePrivacy({ relativePath: path, content: trimmed }).length > 0
    ) {
      return reject(path, "redaction_failed", "share-safe privacy gate rejected the file");
    }
    return null;
  };

  /**
   * Text-level work, run only for media that genuinely needs characters: JSON
   * Lines, share-safe scanning, whole-document JSON, and the head block used to
   * tell a saved email from a log. An ordinary private log stops decoding once
   * its head is captured, so half a gigabyte of it costs one byte pass.
   */
  const absorbText = (segment: string): StreamClassificationRejected | null => {
    if (head.length < HEAD_TEXT_BYTES) {
      head += segment.slice(0, HEAD_TEXT_BYTES - head.length);
    }
    if (wholeText) {
      if (wholeTextBuffer.length + segment.length > limits.maxStructuredParseBytes) {
        return reject(
          path,
          "structured_too_large",
          `structured content above ${limits.maxStructuredParseBytes} bytes cannot be validated in bounded memory`,
        );
      }
      wholeTextBuffer += segment;
    }
    if (wide) {
      // UTF-16 has no single-byte newline, so its line cap is measured here.
      // Every piece after the first starts a new line, which is what resets the
      // running count; without that a long file reads as one endless line.
      const pieces = segment.split("\n");
      for (const [position, piece] of pieces.entries()) {
        if (position > 0) wideLineBytes = 0;
        wideLineBytes += piece.length * 2;
        if (wideLineBytes > limits.maxLineBytes) {
          return reject(
            path,
            "line_too_long",
            `a single line exceeds the ${limits.maxLineBytes}-byte cap`,
          );
        }
      }
    }
    if (!needLines) return null;
    let cursor = 0;
    for (;;) {
      const newline = segment.indexOf("\n", cursor);
      if (newline === -1) {
        pendingLine += segment.slice(cursor);
        return null;
      }
      const problem = consumeLine(pendingLine + segment.slice(cursor, newline));
      if (problem) return problem;
      pendingLine = "";
      cursor = newline + 1;
    }
  };

  let wide = false;
  const needsText = (): boolean => needLines || wholeText || wide || head.length < HEAD_TEXT_BYTES;

  for await (const chunk of input.bytes) {
    input.poll?.();
    byteLength += chunk.byteLength;
    if (fileExceedsLimit(byteLength, limits)) {
      failure = reject(path, "file_too_large", "file exceeds cap");
      break;
    }
    hash.update(chunk);
    if (input.sink) await input.sink(chunk);
    if (failure) continue;

    if (encoding === null) {
      if (chunk[0] === 0xff && chunk[1] === 0xfe) {
        encoding = "utf-16le";
        bomSkip = 2;
      } else if (chunk[0] === 0xfe && chunk[1] === 0xff) {
        encoding = "utf-16be";
        bomSkip = 2;
      } else {
        encoding = "utf-8";
        if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) bomSkip = 3;
      }
      wide = encoding === "utf-16le" || encoding === "utf-16be";
      if (wide && !limits.supportedEncodings.includes(encoding)) {
        failure = reject(
          path,
          "unsupported_encoding",
          `content is ${encoding}; this investigation accepts ${limits.supportedEncodings.join(", ")}`,
        );
        continue;
      }
      decoder = decoderFor(encoding);
    }

    const body = bomSkip > 0 ? chunk.subarray(Math.min(bomSkip, chunk.byteLength)) : chunk;
    bomSkip = Math.max(0, bomSkip - chunk.byteLength);

    if (!wide) {
      scanner.update(body);
      if (scanner.nulBytes > 0) {
        failure = reject(path, "binary_or_unknown", "bytes are not treated as text");
        continue;
      }
      if (scanner.lineBytes > limits.maxLineBytes) {
        failure = reject(
          path,
          "line_too_long",
          `a single line exceeds the ${limits.maxLineBytes}-byte cap`,
        );
        continue;
      }
    }

    if (needsText()) {
      const segment = decoder!.decode(body, { stream: true });
      if (segment) {
        const problem = absorbText(segment);
        if (problem) {
          failure = problem;
          continue;
        }
      }
    }
  }

  if (failure) return failure;
  if (encoding === null) {
    encoding = "utf-8";
    decoder = decoderFor(encoding);
  }
  scanner.finish();
  const tail = decoder!.decode();
  if (tail) {
    const problem = absorbText(tail);
    if (problem) return problem;
  }
  if (needLines && pendingLine) {
    const problem = consumeLine(pendingLine);
    if (problem) return problem;
  }

  if (!wide) {
    if (scanner.longestLineBytes > limits.maxLineBytes) {
      return reject(
        path,
        "line_too_long",
        `a single line exceeds the ${limits.maxLineBytes}-byte cap`,
      );
    }
    if (
      scanner.controlBytes * 16 > byteLength
      || scanner.invalidBytes * 8 > byteLength
    ) {
      return reject(path, "binary_or_unknown", "bytes are not treated as text");
    }
    if (scanner.invalidBytes > 0) encoding = "utf-8-lossy";
    else if (!scanner.nonAscii) encoding = "us-ascii";
  }
  if (!limits.supportedEncodings.includes(encoding)) {
    return reject(
      path,
      "unsupported_encoding",
      `content is ${encoding}; this investigation accepts ${limits.supportedEncodings.join(", ")}`,
    );
  }
  const lossy = encoding === "utf-8-lossy";
  if (lossy && (shareSafe || !LINE_ORIENTED_MEDIA.has(media))) {
    return reject(
      path,
      "binary_or_unknown",
      shareSafe
        ? "non-UTF-8 text requires private intake before normalization review"
        : "structured content must be valid UTF-8 text",
    );
  }

  if (media === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(wholeTextBuffer);
    } catch {
      return reject(path, "unsupported_media", "JSON content must be valid JSON");
    }
    if (shareSafe && scanShareSafePrivacy(parsed).length > 0) {
      return reject(path, "redaction_failed", "share-safe privacy gate rejected the file");
    }
  }
  if (jsonLines && jsonLineRecords === 0) {
    return reject(
      path,
      "unsupported_media",
      "JSON Lines content must contain valid JSON on every non-empty line",
    );
  }
  if (shareSafe) {
    if (!SHARE_SAFE_MEDIA.has(media)) {
      return reject(
        path,
        "redaction_failed",
        "media type is not supported by the share-safe privacy gate",
      );
    }
    if (wholeText && media !== "application/json"
      && scanShareSafePrivacy({ relativePath: path, content: wholeTextBuffer }).length > 0) {
      return reject(path, "redaction_failed", "share-safe privacy gate rejected the file");
    }
    if (scanShareSafePrivacy({ relativePath: path }).length > 0) {
      return reject(path, "redaction_failed", "share-safe privacy gate rejected the file");
    }
  }

  return {
    ok: true,
    relativePath: path,
    mediaType: media,
    artifactKind: artifactKindFor(media, head),
    byteLength,
    digest: hash.digest("hex"),
    encoding,
    encodingStatus: lossy ? "normalized_non_utf8" : "utf8",
  };
}
