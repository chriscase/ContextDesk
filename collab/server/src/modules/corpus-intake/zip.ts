import { deflateRawSync, crc32 } from "node:zlib";
import { CORPUS_INTAKE_LIMITS, type CorpusIntakeLimitsV1 } from "@cd-collab/contracts";
import { memoryByteSource } from "./byte-source.js";
import { ZipError } from "./zip-error.js";
import {
  SIG_CD,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  U32_MAX,
  ZIP64_EXTRA,
} from "./zip-names.js";
import { walkZip, type ZipBudget, type ZipRejection } from "./zip-walk.js";

export interface ZipMember {
  relativePath: string;
  bytes: Uint8Array;
}

export interface ZipExtractResult {
  members: ZipMember[];
  rejected: ZipRejection[];
}

/**
 * In-memory convenience over the streaming walker, for the inline lane.
 *
 * Collecting members here is safe only because the inline lane's archive is
 * itself bounded by the per-request limit. Anything larger belongs to the
 * streamed session lane, which walks the same code without ever holding a
 * whole member set.
 */
export async function extractZip(
  archive: Uint8Array,
  startedAt = Date.now(),
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): Promise<ZipExtractResult> {
  const members: ZipMember[] = [];
  const rejected: ZipRejection[] = [];
  const budget: ZipBudget = { expandedBytes: 0, fileCount: 0 };
  await walkZip(memoryByteSource(archive), {
    limits,
    budget,
    checkDeadline: () => {
      if (Date.now() - startedAt > limits.maxProcessingMs) {
        throw new ZipError("processing_timeout", "extraction exceeded time cap");
      }
    },
    onRejected: (rejection) => rejected.push(rejection),
    onMember: async (member, bytes) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of bytes) {
        chunks.push(Uint8Array.prototype.slice.call(chunk));
        total += chunk.byteLength;
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      members.push({ relativePath: member.relativePath, bytes: joined });
    },
    spill: async (bytes) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of bytes) {
        chunks.push(Uint8Array.prototype.slice.call(chunk));
        total += chunk.byteLength;
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return memoryByteSource(joined);
    },
  });
  return { members, rejected };
}

export interface TestZipFile {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  encrypted?: boolean;
  unixMode?: number;
  extra?: Uint8Array;
  localExtra?: Uint8Array;
  dosAttr?: number;
  flags?: number;
  nameBytes?: Uint8Array;
  /** Move sizes and the local offset into a ZIP64 extra field. */
  zip64?: boolean;
  /** Emit a ZIP64 extra whose data stops short of the fields it must carry. */
  zip64TruncatedExtra?: boolean;
}

/** Force a ZIP64 end-of-directory record and locator even for a small archive. */
export interface TestZipOptions {
  zip64Directory?: boolean;
}

export function buildTestZip(
  files: TestZipFile[],
  options: TestZipOptions = {},
): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.nameBytes ?? Buffer.from(file.name, "utf8"));
    const raw = Buffer.from(file.data);
    const declaredExtra = file.extra ? Buffer.from(file.extra) : Buffer.alloc(0);
    const method = file.method ?? 0;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;
    const high = [...name].some((octet) => octet > 0x7f);
    const flags = file.flags ?? ((file.encrypted ? 1 : 0) | (high ? 0x0800 : 0));
    const zip64 = file.zip64 === true;
    const zip64Extra = zip64
      ? (() => {
        const carried = file.zip64TruncatedExtra ? 8 : 24;
        const data = Buffer.alloc(24);
        data.writeBigUInt64LE(BigInt(raw.length), 0);
        data.writeBigUInt64LE(BigInt(payload.length), 8);
        data.writeBigUInt64LE(BigInt(offset), 16);
        const field = Buffer.alloc(4 + carried);
        field.writeUInt16LE(ZIP64_EXTRA, 0);
        field.writeUInt16LE(carried, 2);
        data.copy(field, 4, 0, carried);
        return field;
      })()
      : Buffer.alloc(0);
    const extra = Buffer.concat([zip64Extra, declaredExtra]);
    const localExtra = file.localExtra !== undefined
      ? Buffer.from(file.localExtra)
      : declaredExtra;
    const local = Buffer.alloc(30 + name.length + localExtra.length + payload.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    name.copy(local, 30);
    localExtra.copy(local, 30 + name.length);
    payload.copy(local, 30 + name.length + localExtra.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length + extra.length);
    const unix = file.unixMode !== undefined;
    central.writeUInt32LE(SIG_CD, 0);
    central.writeUInt16LE(unix ? 3 << 8 : 0, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? U32_MAX : payload.length, 20);
    central.writeUInt32LE(zip64 ? U32_MAX : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const modeBits = unix ? ((file.unixMode! & 0xffff) * 0x10000) : 0;
    const dosBits = (file.dosAttr ?? 0) & 0xff;
    central.writeUInt32LE((modeBits | dosBits) >>> 0, 38);
    central.writeUInt32LE(zip64 ? U32_MAX : offset, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const trailers: Buffer[] = [];
  if (options.zip64Directory) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    trailers.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(options.zip64Directory ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(options.zip64Directory ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(options.zip64Directory ? U32_MAX : cd.length, 12);
  eocd.writeUInt32LE(options.zip64Directory ? U32_MAX : offset, 16);
  trailers.push(eocd);
  return Buffer.concat([...locals, cd, ...trailers]);
}

export { ZipError } from "./zip-error.js";
export { buildUnicodePathExtra, isNestedArchive, normalizeIntakePath } from "./zip-names.js";
export type { ZipRejection } from "./zip-walk.js";
