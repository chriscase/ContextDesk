import { createInflateRaw } from "node:zlib";
import { crc32 } from "node:zlib";
import {
  CORPUS_INTAKE_EXPANSION_WINDOW_BYTES,
  type CorpusIntakeLimitsV1,
  type CorpusRejectionReason,
} from "@cd-collab/contracts";
import type { ByteSource } from "./byte-source.js";
import {
  S_IFBLK,
  S_IFCHR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFSOCK,
  SIG_CD,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  U16_MAX,
  U32_MAX,
  UNIX,
  ZIP_ENCRYPTED,
  ZIP_LANGUAGE_UTF8,
  bytesEqual,
  decodeZipNameBytes,
  isNestedArchive,
  normalizeIntakePath,
  parseExtras,
  resolveCanonicalName,
  slashFold,
  u16,
  u32,
  u64,
  type NameDecode,
} from "./zip-names.js";
import { ZipError } from "./zip-error.js";
import {
  archiveDepthExceedsLimit,
  archiveExceedsLimit,
  compressionRatioExceedsLimit,
  expandedBytesExceedLimit,
  fileCountExceedsLimit,
  fileExceedsLimit,
} from "./limits.js";

export interface ZipRejection {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

export interface ZipWalkMember {
  relativePath: string;
  /** Uncompressed size the archive index declares; verified while streaming. */
  declaredBytes: number;
  compressedBytes: number;
  /** 0 for a member of the submitted archive, 1 inside a nested archive, ... */
  depth: number;
}

/**
 * Shared across a walk and every nested walk beneath it, so an archive cannot
 * multiply its allowance by nesting.
 */
export interface ZipBudget {
  expandedBytes: number;
  fileCount: number;
}

export class CorpusIntakeCancelled extends Error {
  constructor() {
    super("intake was cancelled");
    this.name = "CorpusIntakeCancelled";
  }
}

export interface ZipWalkOptions {
  limits: CorpusIntakeLimitsV1;
  budget: ZipBudget;
  depth?: number;
  /** Deadline check; throws to end the walk. */
  checkDeadline?: () => void;
  /** Cooperative cancellation, polled between entries and between windows. */
  isCancelled?: () => boolean;
  onMember: (member: ZipWalkMember, bytes: AsyncIterable<Uint8Array>) => Promise<void>;
  onRejected: (rejection: ZipRejection) => void;
  /**
   * Materialize a nested archive so it can be walked in turn. Required only
   * when `limits.maxArchiveDepth` is above zero; without it a nested archive is
   * refused rather than silently skipped.
   */
  spill?: (bytes: AsyncIterable<Uint8Array>, byteLength: number) => Promise<ByteSource>;
  onArchiveIndexed?: (info: { entryCount: number; declaredExpandedBytes: number; depth: number }) => void;
}

interface CdEntry {
  name: NameDecode;
  filenameBytes: Uint8Array;
  unicodePathPresent: boolean;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
  madeBy: number;
  externalAttr: number;
}

/**
 * A ZIP's own index can claim any number of entries. Parsing needs a finite cap
 * of its own, above the evidence-file allowance so transport metadata (Finder
 * sidecars, directory markers) does not consume the smaller budget.
 */
function centralDirectoryEntryCap(limits: CorpusIntakeLimitsV1): number {
  return Math.min(limits.maxFileCount * 4, 400_000);
}

async function findEocd(source: ByteSource): Promise<{ offset: number; tail: Uint8Array; tailStart: number }> {
  const min = 22;
  if (source.byteLength < min) throw new ZipError("malformed_zip", "archive too small");
  const scan = Math.min(source.byteLength, min + 65535);
  const tailStart = source.byteLength - scan;
  const tail = await source.read(tailStart, scan);
  for (let i = 0; i <= scan - min; i += 1) {
    const offset = scan - min - i;
    if (u32(tail, offset) === SIG_EOCD) {
      return { offset: tailStart + offset, tail, tailStart };
    }
  }
  throw new ZipError("malformed_zip", "end of central directory not found");
}

interface DirectoryLocation {
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
  eocdOffset: number;
}

/**
 * Locate the central directory, honouring ZIP64 when the archive declares it.
 *
 * A ZIP64 archive is a normal archive whose counts outgrew 16-bit fields; the
 * caps this intake enforces are the same either way. Refusing ZIP64 outright
 * would reject ordinary archives written by modern tools for no safety gain,
 * so the locator and record are parsed and every value re-checked.
 */
async function locateCentralDirectory(source: ByteSource): Promise<DirectoryLocation> {
  const { offset: eocdOffset, tail, tailStart } = await findEocd(source);
  const eocd = await source.read(eocdOffset, 22);
  const diskNumber = u16(eocd, 4);
  const cdDisk = u16(eocd, 6);
  const diskEntries = u16(eocd, 8);
  let totalEntries = u16(eocd, 10);
  let cdSize = u32(eocd, 12);
  let cdOffset = u32(eocd, 16);
  const commentLen = u16(eocd, 20);
  if (eocdOffset + 22 + commentLen !== source.byteLength) {
    throw new ZipError("malformed_zip", "EOCD comment length mismatch");
  }
  if (diskEntries !== totalEntries || diskNumber !== cdDisk) {
    throw new ZipError("malformed_zip", "split archives are not accepted");
  }
  const locatorOffset = eocdOffset - 20;
  const usesZip64 =
    totalEntries === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX
    || (locatorOffset >= tailStart && u32(tail, locatorOffset - tailStart) === SIG_ZIP64_LOCATOR);
  if (!usesZip64) {
    return { totalEntries, cdSize, cdOffset, eocdOffset };
  }
  if (locatorOffset < 0) {
    throw new ZipError("malformed_zip", "ZIP64 archive is missing its locator");
  }
  const locator = await source.read(locatorOffset, 20);
  if (u32(locator, 0) !== SIG_ZIP64_LOCATOR) {
    throw new ZipError("malformed_zip", "ZIP64 end-of-directory locator is missing");
  }
  if (u32(locator, 4) !== 0 || u32(locator, 16) !== 1) {
    throw new ZipError("malformed_zip", "split ZIP64 archives are not accepted");
  }
  const zip64Offset = u64(locator, 8);
  if (zip64Offset + 56 > source.byteLength) {
    throw new ZipError("malformed_zip", "ZIP64 end-of-directory record is out of range");
  }
  const record = await source.read(zip64Offset, 56);
  if (u32(record, 0) !== SIG_ZIP64_EOCD) {
    throw new ZipError("malformed_zip", "ZIP64 end-of-directory record is missing");
  }
  if (u32(record, 16) !== 0 || u32(record, 20) !== 0) {
    throw new ZipError("malformed_zip", "split ZIP64 archives are not accepted");
  }
  const zip64DiskEntries = u64(record, 24);
  totalEntries = u64(record, 32);
  if (zip64DiskEntries !== totalEntries) {
    throw new ZipError("malformed_zip", "split ZIP64 archives are not accepted");
  }
  cdSize = u64(record, 40);
  cdOffset = u64(record, 48);
  return { totalEntries, cdSize, cdOffset, eocdOffset: zip64Offset };
}

/** Apply the ZIP64 extra field's 64-bit values over the 32-bit placeholders. */
function applyZip64Extra(
  entry: { uncompressed: number; compressed: number; localOffset: number },
  extra: Uint8Array | null,
): void {
  if (!extra) return;
  let cursor = 0;
  const next = (): number => {
    if (cursor + 8 > extra.length) {
      throw new ZipError("malformed_zip", "ZIP64 extra field is truncated");
    }
    const value = u64(extra, cursor);
    cursor += 8;
    return value;
  };
  if (entry.uncompressed === U32_MAX) entry.uncompressed = next();
  if (entry.compressed === U32_MAX) entry.compressed = next();
  if (entry.localOffset === U32_MAX) entry.localOffset = next();
}

async function parseCentralDirectory(
  source: ByteSource,
  limits: CorpusIntakeLimitsV1,
): Promise<CdEntry[]> {
  const location = await locateCentralDirectory(source);
  if (location.cdOffset + location.cdSize > location.eocdOffset) {
    throw new ZipError("malformed_zip", "central directory overruns end of directory");
  }
  if (location.totalEntries > centralDirectoryEntryCap(limits)) {
    throw new ZipError("too_many_files", "archive entry count exceeds parsing cap");
  }
  const buf = await source.read(location.cdOffset, location.cdSize);
  const entries: CdEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < location.totalEntries; i += 1) {
    if (cursor + 46 > buf.length || u32(buf, cursor) !== SIG_CD) {
      throw new ZipError("malformed_zip", "central directory entry is corrupt");
    }
    const madeBy = u16(buf, cursor + 4);
    const flags = u16(buf, cursor + 8);
    const method = u16(buf, cursor + 10);
    const crc = u32(buf, cursor + 16);
    const nameLen = u16(buf, cursor + 28);
    const extraLen = u16(buf, cursor + 30);
    const commentLenEntry = u16(buf, cursor + 32);
    const externalAttr = u32(buf, cursor + 38);
    const extraStart = cursor + 46 + nameLen;
    const extraEnd = extraStart + extraLen;
    if (extraEnd + commentLenEntry > buf.length) {
      throw new ZipError("malformed_zip", "central directory entry overruns the directory");
    }
    const extras = parseExtras(buf, extraStart, extraEnd, "central directory");
    const sizes = {
      compressed: u32(buf, cursor + 20),
      uncompressed: u32(buf, cursor + 24),
      localOffset: u32(buf, cursor + 42),
    };
    applyZip64Extra(sizes, extras.zip64);
    const filenameBytes = Uint8Array.from(buf.subarray(cursor + 46, cursor + 46 + nameLen));
    entries.push({
      name: resolveCanonicalName(filenameBytes, flags, extras.unicodePath),
      filenameBytes,
      unicodePathPresent: extras.unicodePath !== null,
      method,
      flags,
      crc,
      compressed: sizes.compressed,
      uncompressed: sizes.uncompressed,
      localOffset: sizes.localOffset,
      madeBy,
      externalAttr,
    });
    cursor = extraEnd + commentLenEntry;
  }
  if (cursor !== location.cdSize) {
    throw new ZipError("malformed_zip", "central directory size mismatch");
  }
  return entries;
}

/** Where an entry's compressed payload begins, after validating its local header. */
async function locatePayload(source: ByteSource, entry: CdEntry): Promise<number> {
  const offset = entry.localOffset;
  if (offset + 30 > source.byteLength) {
    throw new ZipError("malformed_zip", "local file header is out of range");
  }
  const header = await source.read(offset, 30);
  if (u32(header, 0) !== SIG_LOCAL) {
    throw new ZipError("malformed_zip", "local file header is corrupt");
  }
  const flags = u16(header, 6);
  const method = u16(header, 8);
  const nameLen = u16(header, 26);
  const extraLen = u16(header, 28);
  if ((flags & ZIP_LANGUAGE_UTF8) !== (entry.flags & ZIP_LANGUAGE_UTF8)) {
    throw new ZipError("malformed_zip", "local name encoding does not match central directory");
  }
  if ((flags & ZIP_ENCRYPTED) !== (entry.flags & ZIP_ENCRYPTED) || method !== entry.method) {
    throw new ZipError("malformed_zip", "local header disagrees with central directory");
  }
  const filenameBytes = await source.read(offset + 30, nameLen);
  if (!bytesEqual(filenameBytes, entry.filenameBytes)) {
    throw new ZipError("malformed_zip", "local name does not match central directory");
  }
  const extraStart = offset + 30 + nameLen;
  const extraEnd = extraStart + extraLen;
  if (extraEnd > source.byteLength) {
    throw new ZipError("malformed_zip", "local extra field is out of range");
  }
  const extras = parseExtras(await source.read(extraStart, extraLen), 0, extraLen, "local");
  if (entry.unicodePathPresent) {
    if (extras.unicodePath) {
      const localName = resolveCanonicalName(filenameBytes, flags, extras.unicodePath);
      if (
        !entry.name.ok
        || !localName.ok
        || slashFold(localName.name) !== slashFold(entry.name.name)
      ) {
        throw new ZipError(
          "malformed_zip",
          "local Unicode Path extra does not match central directory",
        );
      }
    }
  } else if (extras.unicodePath) {
    throw new ZipError(
      "malformed_zip",
      "local Unicode Path extra is not present in the central directory",
    );
  } else {
    const name = decodeZipNameBytes(filenameBytes, flags);
    if (!entry.name.ok || !name.ok || slashFold(name.name) !== slashFold(entry.name.name)) {
      throw new ZipError("malformed_zip", "local name does not match central directory");
    }
  }
  if (extraEnd + entry.compressed > source.byteLength) {
    throw new ZipError("malformed_zip", "truncated compressed data");
  }
  return extraEnd;
}

/**
 * Stream one member's bytes, verifying CRC and declared size as they pass.
 *
 * Nothing accumulates: the inflater is fed one window at a time and its output
 * is handed straight on. The expanded-byte budget is charged as bytes appear,
 * so a member that lies about its size in the index is stopped at the moment it
 * overruns, not after it has been written out in full.
 */
async function* streamMember(
  source: ByteSource,
  entry: CdEntry,
  payloadStart: number,
  limits: CorpusIntakeLimitsV1,
  budget: ZipBudget,
  poll: () => void,
): AsyncGenerator<Uint8Array> {
  const window = CORPUS_INTAKE_EXPANSION_WINDOW_BYTES;
  let produced = 0;
  let digest = 0;
  const emit = function* (chunk: Uint8Array): Generator<Uint8Array> {
    if (chunk.byteLength === 0) return;
    produced += chunk.byteLength;
    if (fileExceedsLimit(produced, limits)) {
      throw new ZipError("file_too_large", "member exceeded the per-file cap while expanding");
    }
    if (produced > entry.uncompressed) {
      throw new ZipError("malformed_zip", "member produced more bytes than its index declares");
    }
    if (expandedBytesExceedLimit(budget.expandedBytes, chunk.byteLength, limits)) {
      throw new ZipError("oversized_expanded", "expanded size exceeds cap");
    }
    budget.expandedBytes += chunk.byteLength;
    digest = crc32(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), digest) >>> 0;
    yield chunk;
  };

  if (entry.method === 0) {
    if (entry.compressed !== entry.uncompressed) {
      throw new ZipError("malformed_zip", "stored size mismatch");
    }
    for (let read = 0; read < entry.compressed; read += window) {
      poll();
      const length = Math.min(window, entry.compressed - read);
      yield* emit(await source.read(payloadStart + read, length));
    }
  } else if (entry.method === 8) {
    // Wrapped so an abandoned member — one the classifier refused mid-stream —
    // still tears its inflater down instead of leaving it pinned.
    const inflate = createInflateRaw({ chunkSize: window });
    let settled = false;
    const pending: Uint8Array[] = [];
    let failure: Error | null = null;
    inflate.on("data", (chunk: Buffer) => {
      pending.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    inflate.on("error", () => {
      failure = new ZipError("malformed_zip", "deflate stream is corrupt");
    });
    const drain = function* (): Generator<Uint8Array> {
      while (pending.length > 0) {
        const chunk = pending.shift()!;
        for (const out of emit(chunk)) yield out;
      }
    };
    const write = (chunk: Uint8Array | null): Promise<void> =>
      new Promise((resolve, reject) => {
        const done = (error?: Error | null) => (error ? reject(error) : resolve());
        if (chunk === null) inflate.end(done);
        else inflate.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), done);
      });
    try {
      for (let read = 0; read < entry.compressed; read += window) {
        poll();
        const length = Math.min(window, entry.compressed - read);
        await write(await source.read(payloadStart + read, length));
        if (failure) throw failure;
        yield* drain();
      }
      await write(null);
      if (failure) throw failure;
      yield* drain();
      settled = true;
    } catch (error) {
      settled = true;
      inflate.destroy();
      if (error instanceof ZipError) throw error;
      throw new ZipError("malformed_zip", "deflate stream is corrupt or exceeds declared size");
    } finally {
      if (!settled) inflate.destroy();
    }
  } else {
    throw new ZipError("malformed_zip", `unsupported compression method ${entry.method}`);
  }

  if (produced !== entry.uncompressed) {
    throw new ZipError("malformed_zip", "inflated size mismatch");
  }
  if (digest !== entry.crc) {
    throw new ZipError("malformed_zip", "CRC mismatch");
  }
}

function unixMode(entry: CdEntry): number | null {
  if (entry.madeBy >> 8 !== UNIX) return null;
  return (entry.externalAttr >>> 16) & 0xffff;
}

/**
 * Walk one archive, streaming every acceptable member to `onMember` and
 * reporting every refusal to `onRejected`.
 *
 * The walk holds one window of bytes and one entry's metadata. Budgets are
 * shared with any nested walk, so depth cannot be used to multiply an
 * allowance, and a fatal archive-level problem throws rather than producing a
 * partial corpus that looks complete.
 */
export async function walkZip(source: ByteSource, options: ZipWalkOptions): Promise<void> {
  const { limits, budget } = options;
  const depth = options.depth ?? 0;
  const poll = (): void => {
    if (options.isCancelled?.()) throw new CorpusIntakeCancelled();
    options.checkDeadline?.();
  };
  poll();
  if (archiveExceedsLimit(source.byteLength, limits)) {
    throw new ZipError("oversized_archive", "archive exceeds byte cap");
  }
  const entries = await parseCentralDirectory(source, limits);
  options.onArchiveIndexed?.({
    entryCount: entries.length,
    declaredExpandedBytes: entries.reduce((total, entry) => total + entry.uncompressed, 0),
    depth,
  });
  const seen = new Set<string>();
  const seenOffsets = new Set<number>();
  for (const entry of entries) {
    poll();
    if (!entry.name.ok) {
      options.onRejected({
        relativePath: "<invalid-encoding>",
        reason: entry.name.reason,
        detail: entry.name.detail,
      });
      continue;
    }
    const entryName = entry.name.name;
    if (entry.flags & ZIP_ENCRYPTED) {
      options.onRejected({
        relativePath: entryName,
        reason: "encrypted_archive",
        detail: "encrypted ZIP entries are rejected",
      });
      continue;
    }
    const dosAttr = entry.externalAttr & 0xff;
    if ((dosAttr & 0x08) !== 0) {
      options.onRejected({
        relativePath: entryName,
        reason: "device_entry",
        detail: "volume or device label",
      });
      continue;
    }
    if ((dosAttr & 0x10) !== 0 || entryName.endsWith("/")) continue;
    const portableName = entryName.replace(/\\/g, "/");
    const portableParts = portableName.split("/");
    const portableBase = portableParts.at(-1) ?? "";
    // Finder adds transport metadata that is not investigation evidence. Skip
    // it before extraction so a normal diagnostic archive does not bury useful
    // logs under hundreds of meaningless rejection rows.
    if (
      portableParts[0] === "__MACOSX"
      || portableBase === ".DS_Store"
      || portableBase.startsWith("._")
    ) continue;
    budget.fileCount += 1;
    if (fileCountExceedsLimit(budget.fileCount, limits)) {
      throw new ZipError("too_many_files", "file count exceeds cap");
    }
    const mode = unixMode(entry);
    if (mode !== null) {
      const type = mode & S_IFMT;
      if (type === S_IFLNK) {
        options.onRejected({
          relativePath: entryName,
          reason: "symlink_or_hardlink",
          detail: "symlink",
        });
        continue;
      }
      if (type === S_IFBLK || type === S_IFCHR || type === S_IFIFO || type === S_IFSOCK) {
        options.onRejected({
          relativePath: entryName,
          reason: "device_entry",
          detail: "device or ipc entry",
        });
        continue;
      }
    }
    const normalized = normalizeIntakePath(entryName, limits);
    if (!normalized.ok) {
      options.onRejected({
        relativePath: entryName,
        reason: normalized.reason,
        detail: normalized.detail,
      });
      continue;
    }
    const foldKey = normalized.path.toLocaleLowerCase("en-US");
    if (seen.has(foldKey) || seen.has(normalized.path.normalize("NFC"))) {
      options.onRejected({
        relativePath: normalized.path,
        reason: "duplicate_normalized_path",
        detail: "duplicate after Unicode/case normalization",
      });
      continue;
    }
    seen.add(foldKey);
    seen.add(normalized.path.normalize("NFC"));
    if (seenOffsets.has(entry.localOffset)) {
      options.onRejected({
        relativePath: normalized.path,
        reason: "symlink_or_hardlink",
        detail: "hardlink or duplicate local offset",
      });
      continue;
    }
    seenOffsets.add(entry.localOffset);
    if (fileExceedsLimit(entry.uncompressed, limits)) {
      options.onRejected({
        relativePath: normalized.path,
        reason: "file_too_large",
        detail: "declared file size exceeds cap",
      });
      continue;
    }
    if (compressionRatioExceedsLimit(entry.compressed, entry.uncompressed, limits)) {
      options.onRejected({
        relativePath: normalized.path,
        reason: "extreme_ratio",
        detail: "compression ratio exceeds cap",
      });
      continue;
    }
    if (expandedBytesExceedLimit(budget.expandedBytes, entry.uncompressed, limits)) {
      throw new ZipError("oversized_expanded", "expanded size exceeds cap");
    }
    const payloadStart = await locatePayload(source, entry);
    const bytes = (): AsyncIterable<Uint8Array> =>
      streamMember(source, entry, payloadStart, limits, budget, poll);

    if (isNestedArchive(normalized.path)) {
      if (archiveDepthExceedsLimit(depth + 1, limits) || !options.spill) {
        options.onRejected({
          relativePath: normalized.path,
          reason: limits.maxArchiveDepth === 0 ? "nested_archive" : "archive_depth_exceeded",
          detail: limits.maxArchiveDepth === 0
            ? "nested archives are unsupported"
            : `nested archive depth exceeds the configured limit of ${limits.maxArchiveDepth}`,
        });
        continue;
      }
      const nested = await options.spill(bytes(), entry.uncompressed);
      try {
        await walkZip(nested, { ...options, depth: depth + 1 });
      } finally {
        await nested.close?.();
      }
      continue;
    }
    await options.onMember(
      {
        relativePath: normalized.path,
        declaredBytes: entry.uncompressed,
        compressedBytes: entry.compressed,
        depth,
      },
      bytes(),
    );
  }
}
