import { inflateRawSync, deflateRawSync, crc32 } from "node:zlib";
import {
  CORPUS_INTAKE_LIMITS,
  type CorpusRejectionReason,
} from "@cd-collab/contracts";

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFBLK = 0o060000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

export interface ZipMember {
  relativePath: string;
  bytes: Uint8Array;
}

export interface ZipRejection {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

export interface ZipExtractResult {
  members: ZipMember[];
  rejected: ZipRejection[];
}

class ZipError extends Error {
  constructor(
    readonly reason: CorpusRejectionReason,
    detail: string,
  ) {
    super(detail);
    this.name = "ZipError";
  }
}

function u16(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

function u32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

const ZIP_LANGUAGE_UTF8 = 0x0800;
const ZIP_ENCRYPTED = 0x0001;

function decodeZipName(
  buf: Uint8Array,
  offset: number,
  length: number,
  flags: number,
): { ok: true; name: string } | { ok: false; reason: CorpusRejectionReason; detail: string } {
  const bytes = buf.subarray(offset, offset + length);
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

export function normalizeIntakePath(raw: string): { ok: true; path: string } | { ok: false; reason: CorpusRejectionReason; detail: string } {
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
  if (nfc.length > CORPUS_INTAKE_LIMITS.maxPathLength) {
    return { ok: false, reason: "path_too_long", detail: "path exceeds cap" };
  }
  const parts = nfc.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) {
    return { ok: false, reason: "path_traversal", detail: "`.` or `..` segment" };
  }
  if (parts.length > CORPUS_INTAKE_LIMITS.maxPathDepth) {
    return { ok: false, reason: "path_too_deep", detail: "path depth exceeds cap" };
  }
  return { ok: true, path: parts.join("/") };
}

function findEocd(buf: Uint8Array): number {
  const min = 22;
  if (buf.length < min) throw new ZipError("malformed_zip", "archive too small");
  const maxScan = Math.min(buf.length - min, 65535);
  for (let i = 0; i <= maxScan; i += 1) {
    const offset = buf.length - min - i;
    if (u32(buf, offset) === SIG_EOCD) return offset;
  }
  throw new ZipError("malformed_zip", "end of central directory not found");
}

export function isNestedArchive(path: string): boolean {
  return /\.(zip|jar|war|apk|7z|rar)$/i.test(path);
}

interface CdEntry {
  name:
    | { ok: true; name: string }
    | { ok: false; reason: CorpusRejectionReason; detail: string };
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
  madeBy: number;
  externalAttr: number;
}

function parseCentralDirectory(buf: Uint8Array): CdEntry[] {
  const eocd = findEocd(buf);
  if (u32(buf, eocd) === SIG_ZIP64_EOCD || (eocd >= 20 && u32(buf, eocd - 20) === SIG_ZIP64_LOCATOR)) {
    throw new ZipError("unsupported_zip64", "ZIP64 is not accepted");
  }
  const diskEntries = u16(buf, eocd + 8);
  const totalEntries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  const commentLen = u16(buf, eocd + 20);
  if (eocd + 22 + commentLen !== buf.length) {
    throw new ZipError("malformed_zip", "EOCD comment length mismatch");
  }
  if (diskEntries !== totalEntries) {
    throw new ZipError("malformed_zip", "split archives are not accepted");
  }
  if (totalEntries > CORPUS_INTAKE_LIMITS.maxFileCount) {
    throw new ZipError("too_many_files", "file count exceeds cap");
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipError("malformed_zip", "central directory overruns EOCD");
  }
  const entries: CdEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > buf.length || u32(buf, cursor) !== SIG_CD) {
      throw new ZipError("malformed_zip", "central directory entry is corrupt");
    }
    const madeBy = u16(buf, cursor + 4);
    const flags = u16(buf, cursor + 8);
    const method = u16(buf, cursor + 10);
    const crc = u32(buf, cursor + 16);
    const compressed = u32(buf, cursor + 20);
    const uncompressed = u32(buf, cursor + 24);
    const nameLen = u16(buf, cursor + 28);
    const extraLen = u16(buf, cursor + 30);
    const commentLenEntry = u16(buf, cursor + 32);
    const externalAttr = u32(buf, cursor + 38);
    const localOffset = u32(buf, cursor + 42);
    const extraStart = cursor + 46 + nameLen;
    const extraEnd = extraStart + extraLen;
    for (let extra = extraStart; extra + 4 <= extraEnd; ) {
      const headerId = u16(buf, extra);
      const dataSize = u16(buf, extra + 2);
      if (extra + 4 + dataSize > extraEnd) {
        throw new ZipError("malformed_zip", "central directory extra field is truncated");
      }
      if (headerId === 0x0001) {
        throw new ZipError("unsupported_zip64", "ZIP64 extra field is not accepted");
      }
      extra += 4 + dataSize;
    }
    const name = decodeZipName(buf, cursor + 46, nameLen, flags);
    entries.push({
      name,
      method,
      flags,
      crc,
      compressed,
      uncompressed,
      localOffset,
      madeBy,
      externalAttr,
    });
    cursor += 46 + nameLen + extraLen + commentLenEntry;
  }
  if (cursor !== cdOffset + cdSize) {
    throw new ZipError("malformed_zip", "central directory size mismatch");
  }
  return entries;
}

function extractLocal(buf: Uint8Array, entry: CdEntry): Uint8Array {
  const offset = entry.localOffset;
  if (offset + 30 > buf.length || u32(buf, offset) !== SIG_LOCAL) {
    throw new ZipError("malformed_zip", "local file header is corrupt");
  }
  const flags = u16(buf, offset + 6);
  const method = u16(buf, offset + 8);
  const nameLen = u16(buf, offset + 26);
  const extraLen = u16(buf, offset + 28);
  if ((flags & ZIP_LANGUAGE_UTF8) !== (entry.flags & ZIP_LANGUAGE_UTF8)) {
    throw new ZipError("malformed_zip", "local name encoding does not match central directory");
  }
  if ((flags & ZIP_ENCRYPTED) !== (entry.flags & ZIP_ENCRYPTED) || method !== entry.method) {
    throw new ZipError("malformed_zip", "local header disagrees with central directory");
  }
  const name = decodeZipName(buf, offset + 30, nameLen, flags);
  if (!entry.name.ok || !name.ok || name.name.replace(/\\/g, "/") !== entry.name.name.replace(/\\/g, "/")) {
    throw new ZipError("malformed_zip", "local name does not match central directory");
  }
  const dataStart = offset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressed;
  if (dataEnd > buf.length) {
    throw new ZipError("malformed_zip", "truncated compressed data");
  }
  const payload = buf.subarray(dataStart, dataEnd);
  if (entry.method === 0) {
    if (payload.byteLength !== entry.uncompressed) {
      throw new ZipError("malformed_zip", "stored size mismatch");
    }
    return new Uint8Array(payload);
  }
  if (entry.method !== 8) {
    throw new ZipError("malformed_zip", `unsupported compression method ${entry.method}`);
  }
  try {
    const inflated = inflateRawSync(payload, { maxOutputLength: entry.uncompressed });
    return new Uint8Array(inflated);
  } catch {
    throw new ZipError("malformed_zip", "deflate stream is corrupt or exceeds declared size");
  }
}

function unixMode(entry: CdEntry): number | null {
  if (entry.madeBy >> 8 !== UNIX) return null;
  return (entry.externalAttr >>> 16) & 0xffff;
}

export function extractZip(archive: Uint8Array, startedAt = Date.now()): ZipExtractResult {
  if (archive.byteLength > CORPUS_INTAKE_LIMITS.maxArchiveBytes) {
    throw new ZipError("oversized_archive", "archive exceeds byte cap");
  }
  if (archive.byteLength >= 4 && u32(archive, 0) === SIG_ZIP64_EOCD) {
    throw new ZipError("unsupported_zip64", "ZIP64 is not accepted");
  }
  const rejected: ZipRejection[] = [];
  const members: ZipMember[] = [];
  const seen = new Set<string>();
  const seenOffsets = new Set<number>();
  let expanded = 0;
  const entries = parseCentralDirectory(archive);
  for (const entry of entries) {
    if (Date.now() - startedAt > CORPUS_INTAKE_LIMITS.maxProcessingMs) {
      throw new ZipError("processing_timeout", "extraction exceeded time cap");
    }
    if (!entry.name.ok) {
      rejected.push({
        relativePath: "<invalid-encoding>",
        reason: entry.name.reason,
        detail: entry.name.detail,
      });
      continue;
    }
    const entryName = entry.name.name;
    if (entry.flags & ZIP_ENCRYPTED) {
      rejected.push({
        relativePath: entryName,
        reason: "encrypted_archive",
        detail: "encrypted ZIP entries are rejected",
      });
      continue;
    }
    const dosAttr = entry.externalAttr & 0xff;
    if ((dosAttr & 0x08) !== 0) {
      rejected.push({ relativePath: entryName, reason: "device_entry", detail: "volume or device label" });
      continue;
    }
    if ((dosAttr & 0x10) !== 0 || entryName.endsWith("/")) continue;
    const mode = unixMode(entry);
    if (mode !== null) {
      const type = mode & S_IFMT;
      if (type === S_IFLNK) {
        rejected.push({ relativePath: entryName, reason: "symlink_or_hardlink", detail: "symlink" });
        continue;
      }
      if (type === S_IFBLK || type === S_IFCHR || type === S_IFIFO || type === S_IFSOCK) {
        rejected.push({ relativePath: entryName, reason: "device_entry", detail: "device or ipc entry" });
        continue;
      }
    }
    const normalized = normalizeIntakePath(entryName);
    if (!normalized.ok) {
      rejected.push({ relativePath: entryName, reason: normalized.reason, detail: normalized.detail });
      continue;
    }
    const foldKey = normalized.path.toLocaleLowerCase("en-US");
    if (seen.has(foldKey) || seen.has(normalized.path.normalize("NFC"))) {
      rejected.push({
        relativePath: normalized.path,
        reason: "duplicate_normalized_path",
        detail: "duplicate after Unicode/case normalization",
      });
      continue;
    }
    seen.add(foldKey);
    seen.add(normalized.path.normalize("NFC"));
    if (seenOffsets.has(entry.localOffset)) {
      rejected.push({
        relativePath: normalized.path,
        reason: "symlink_or_hardlink",
        detail: "hardlink or duplicate local offset",
      });
      continue;
    }
    seenOffsets.add(entry.localOffset);
    if (isNestedArchive(normalized.path)) {
      rejected.push({
        relativePath: normalized.path,
        reason: "nested_archive",
        detail: "nested archives are unsupported",
      });
      continue;
    }
    if (entry.uncompressed > CORPUS_INTAKE_LIMITS.maxFileBytes) {
      rejected.push({
        relativePath: normalized.path,
        reason: "file_too_large",
        detail: "declared file size exceeds cap",
      });
      continue;
    }
    if (entry.compressed > 0) {
      const ratio = entry.uncompressed / Math.max(entry.compressed, 1);
      if (ratio > CORPUS_INTAKE_LIMITS.maxCompressionRatio) {
        rejected.push({
          relativePath: normalized.path,
          reason: "extreme_ratio",
          detail: "compression ratio exceeds cap",
        });
        continue;
      }
    }
    if (expanded + entry.uncompressed > CORPUS_INTAKE_LIMITS.maxExpandedBytes) {
      throw new ZipError("oversized_expanded", "expanded size exceeds cap");
    }
    const bytes = extractLocal(archive, entry);
    if (bytes.byteLength !== entry.uncompressed) {
      throw new ZipError("malformed_zip", "inflated size mismatch");
    }
    if ((crc32(Buffer.from(bytes)) >>> 0) !== entry.crc) {
      throw new ZipError("malformed_zip", "CRC mismatch");
    }
    expanded += bytes.byteLength;
    members.push({ relativePath: normalized.path, bytes });
  }
  return { members, rejected };
}

export function buildTestZip(
  files: Array<{
    name: string;
    data: Uint8Array;
    method?: 0 | 8;
    encrypted?: boolean;
    unixMode?: number;
    extra?: Uint8Array;
    dosAttr?: number;
    flags?: number;
    nameBytes?: Uint8Array;
  }>,
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.nameBytes ?? Buffer.from(file.name, "utf8"));
    const raw = Buffer.from(file.data);
    const extra = file.extra ? Buffer.from(file.extra) : Buffer.alloc(0);
    const method = file.method ?? 0;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;
    const high = [...name].some((octet) => octet > 0x7f);
    const flags = file.flags ?? ((file.encrypted ? 1 : 0) | (high ? 0x0800 : 0));
    const local = Buffer.alloc(30 + name.length + extra.length + payload.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    name.copy(local, 30);
    extra.copy(local, 30 + name.length);
    payload.copy(local, 30 + name.length + extra.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length + extra.length);
    const unix = file.unixMode !== undefined;
    central.writeUInt32LE(SIG_CD, 0);
    central.writeUInt16LE(unix ? 3 << 8 : 0, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const modeBits = unix ? ((file.unixMode! & 0xffff) * 0x10000) : 0;
    const dosBits = (file.dosAttr ?? 0) & 0xff;
    central.writeUInt32LE((modeBits | dosBits) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export { ZipError };
