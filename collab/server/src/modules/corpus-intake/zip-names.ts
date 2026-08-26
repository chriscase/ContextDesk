import { crc32 } from "node:zlib";
import { CORPUS_INTAKE_LIMITS, type CorpusIntakeLimitsV1, type CorpusRejectionReason } from "@cd-collab/contracts";
import { ZipError } from "./zip-error.js";

export const SIG_EOCD = 0x06054b50;
export const SIG_CD = 0x02014b50;
export const SIG_LOCAL = 0x04034b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

export const UNIX = 3;
export const S_IFMT = 0o170000;
export const S_IFLNK = 0o120000;
export const S_IFBLK = 0o060000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;
export const S_IFSOCK = 0o140000;

export const ZIP_LANGUAGE_UTF8 = 0x0800;
export const ZIP_ENCRYPTED = 0x0001;
export const ZIP_DATA_DESCRIPTOR = 0x0008;
export const ZIP_UNICODE_PATH = 0x7075;
export const ZIP64_EXTRA = 0x0001;
export const U32_MAX = 0xffffffff;
export const U16_MAX = 0xffff;

export function u16(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

export function u32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * ZIP64 stores sizes as 64-bit little-endian. Reading them as two 32-bit words
 * keeps the parser free of BigInt, and any value a JS number cannot hold
 * exactly is refused rather than silently rounded into a smaller budget.
 */
export function u64(buf: Uint8Array, offset: number): number {
  const low = u32(buf, offset);
  const high = u32(buf, offset + 4);
  const value = high * 0x1_0000_0000 + low;
  if (!Number.isSafeInteger(value)) {
    throw new ZipError("malformed_zip", "ZIP64 field exceeds the exact integer range");
  }
  return value;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function slashFold(name: string): string {
  return name.replace(/\\/g, "/");
}

export type NameDecode =
  | { ok: true; name: string }
  | { ok: false; reason: CorpusRejectionReason; detail: string };

export function decodeZipNameBytes(bytes: Uint8Array, flags: number): NameDecode {
  if (bytes.includes(0)) {
    return { ok: false, reason: "nul_in_path", detail: "NUL in path" };
  }
  if ((flags & ZIP_LANGUAGE_UTF8) !== 0) {
    try {
      return { ok: true, name: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return {
        ok: false,
        reason: "invalid_encoding",
        detail: "ZIP UTF-8 language bit is set but the name is not valid UTF-8",
      };
    }
  }
  if ([...bytes].some((octet) => octet > 0x7f)) {
    return {
      ok: false,
      reason: "invalid_encoding",
      detail: "ZIP name has non-ASCII bytes without the UTF-8 language bit",
    };
  }
  return { ok: true, name: Buffer.from(bytes).toString("ascii") };
}

export interface ZipExtras {
  unicodePath: { crc: number; nameBytes: Uint8Array } | null;
  zip64: Uint8Array | null;
}

export function parseExtras(
  buf: Uint8Array,
  start: number,
  end: number,
  label: string,
): ZipExtras {
  let unicodePath: { crc: number; nameBytes: Uint8Array } | null = null;
  let zip64: Uint8Array | null = null;
  for (let extra = start; extra + 4 <= end; ) {
    const headerId = u16(buf, extra);
    const dataSize = u16(buf, extra + 2);
    if (extra + 4 + dataSize > end) {
      throw new ZipError("malformed_zip", `${label} extra field is truncated`);
    }
    if (headerId === ZIP64_EXTRA) {
      if (zip64) throw new ZipError("malformed_zip", `duplicate ZIP64 extra in ${label}`);
      zip64 = buf.subarray(extra + 4, extra + 4 + dataSize);
    }
    if (headerId === ZIP_UNICODE_PATH) {
      if (unicodePath) {
        throw new ZipError("malformed_zip", "duplicate Info-ZIP Unicode Path extra");
      }
      if (dataSize < 5) {
        throw new ZipError("malformed_zip", "Info-ZIP Unicode Path extra is truncated");
      }
      const version = buf[extra + 4]!;
      if (version !== 1) {
        throw new ZipError("malformed_zip", "unsupported Info-ZIP Unicode Path extra version");
      }
      unicodePath = {
        crc: u32(buf, extra + 5),
        nameBytes: buf.subarray(extra + 9, extra + 4 + dataSize),
      };
    }
    extra += 4 + dataSize;
  }
  return { unicodePath, zip64 };
}

export function resolveCanonicalName(
  filenameBytes: Uint8Array,
  flags: number,
  unicodePath: { crc: number; nameBytes: Uint8Array } | null,
): NameDecode {
  if (!unicodePath) return decodeZipNameBytes(filenameBytes, flags);
  if ((crc32(Buffer.from(filenameBytes)) >>> 0) !== unicodePath.crc) {
    throw new ZipError(
      "malformed_zip",
      "Info-ZIP Unicode Path extra CRC does not match the filename field",
    );
  }
  if (unicodePath.nameBytes.includes(0)) {
    return { ok: false, reason: "nul_in_path", detail: "NUL in Unicode Path extra" };
  }
  try {
    return {
      ok: true,
      name: new TextDecoder("utf-8", { fatal: true }).decode(unicodePath.nameBytes),
    };
  } catch {
    return {
      ok: false,
      reason: "invalid_encoding",
      detail: "Info-ZIP Unicode Path extra is not valid UTF-8",
    };
  }
}

export function buildUnicodePathExtra(
  filename: string | Uint8Array,
  unicodeName: string,
): Uint8Array {
  const nameBytes = typeof filename === "string"
    ? Buffer.from(filename, "ascii")
    : Buffer.from(filename);
  const utf8 = Buffer.from(unicodeName, "utf8");
  const data = Buffer.alloc(5 + utf8.length);
  data.writeUInt8(1, 0);
  data.writeUInt32LE(crc32(nameBytes) >>> 0, 1);
  utf8.copy(data, 5);
  const extra = Buffer.alloc(4 + data.length);
  extra.writeUInt16LE(ZIP_UNICODE_PATH, 0);
  extra.writeUInt16LE(data.length, 2);
  data.copy(extra, 4);
  return extra;
}

/**
 * Normalize an intake path and refuse everything that could escape the
 * investigation's own namespace: absolute roots, drive letters, UNC shares,
 * `..` segments, NUL, and anything past the configured depth or length.
 */
export function normalizeIntakePath(
  raw: string,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): { ok: true; path: string } | { ok: false; reason: CorpusRejectionReason; detail: string } {
  if (!raw || !raw.trim()) return { ok: false, reason: "empty_path", detail: "empty path" };
  if (raw.includes("\0")) return { ok: false, reason: "nul_in_path", detail: "NUL in path" };
  const replaced = raw.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(replaced) || replaced.startsWith("//") || replaced.startsWith("\\\\")) {
    return { ok: false, reason: "drive_or_unc_path", detail: "drive or UNC path" };
  }
  if (replaced.startsWith("/") || replaced.startsWith("~")) {
    return { ok: false, reason: "absolute_path", detail: "absolute path" };
  }
  const nfc = replaced.normalize("NFC");
  if (nfc.length > limits.maxPathLength) {
    return { ok: false, reason: "path_too_long", detail: "path exceeds cap" };
  }
  const parts = nfc.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) {
    return { ok: false, reason: "path_traversal", detail: "`.` or `..` segment" };
  }
  if (parts.length > limits.maxPathDepth) {
    return { ok: false, reason: "path_too_deep", detail: "path depth exceeds cap" };
  }
  return { ok: true, path: parts.join("/") };
}

export function isNestedArchive(path: string): boolean {
  return /\.(zip|jar|war|apk|7z|rar)$/i.test(path);
}
