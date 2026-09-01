import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { FILE_SERVER_REF_SCHEMA_ID, parseFileServerReference } from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  abandonS3WriteBatchForCrashTest,
  createS3ClientConfig,
  S3EvidenceError,
  S3EvidenceStore,
} from "./s3-store.js";
import { EVIDENCE_PENDING_WRITE_SCHEMA_ID, sha256Hex } from "./store.js";

const SYNTHETIC_ACCESS = "gk-synthetic-access";
const SYNTHETIC_SECRET = "synthetic-secret-value";
const SYNTHETIC_ENDPOINT = "http://garage.test:3900";
const SYNTHETIC_BUCKET = "cd-evidence";
const SYNTHETIC_URI = "https://files.example.test/incident/app.log";
const ACL_FIELDS = [
  "ACL",
  "GrantFullControl",
  "GrantRead",
  "GrantReadACP",
  "GrantWriteACP",
  "AccessControlPolicy",
] as const;
const CHECKSUM_FIELDS = [
  "ChecksumAlgorithm",
  "ChecksumCRC32",
  "ChecksumCRC32C",
  "ChecksumSHA1",
  "ChecksumSHA256",
  "ChecksumCRC64NVME",
  "ContentMD5",
] as const;

class FakeS3Error extends Error {
  readonly Code: string;
  readonly $metadata: { httpStatusCode: number };

  constructor(name: string, status: number, message: string) {
    super(message);
    this.name = name;
    this.Code = name;
    this.$metadata = { httpStatusCode: status };
  }
}

interface FakeObject {
  body: Uint8Array;
  metadata: Record<string, string>;
  contentType: string | undefined;
  etag: string;
  reportedLength?: number;
  reportedGetLength?: number;
  reportedEtag?: string | null;
  reportedGetEtag?: string | null;
  reportedContentRange?: string | null;
  chunks?: Uint8Array[];
  chunkProducers?: Array<() => Uint8Array | Promise<Uint8Array>>;
  yieldCount?: { value: number };
  iteratorReturns?: { value: number };
  iteratorReturnHangs?: boolean;
  bodyDestroys?: { value: number };
  bodyCancelOnly?: boolean;
  bodyCancels?: { value: number };
  bodyCancelHangs?: boolean;
  transformOnly?: boolean;
  failAfterYields?: number;
  failYieldError?: Error;
  sequentialNext?: { pending: boolean; concurrent: number };
  headerDelayMs?: number;
  immediateUint8Body?: boolean;
}

class FakeS3Client {
  readonly objects = new Map<string, FakeObject>();
  readonly calls: Array<{
    name: string;
    input: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }> = [];
  transformToByteArrayCalls = 0;
  bucketExists = true;
  nextError: Error | null = null;
  listPageSize = 1000;
  onSend: (() => void) | null = null;
  throwAfterApplyKeys = new Set<string>();
  throwBeforeApplyKeys = new Set<string>();
  throwAfterApplyHits = 0;
  throwBeforeApplyHits = 0;
  headErrors = new Map<string, Error>();
  getErrors = new Map<string, Error>();
  deleteErrors = new Map<string, Error>();
  corruptCopy = new Map<string, { body?: Uint8Array; metadata?: Record<string, string> }>();
  listHandler: ((input: Record<string, unknown>) => unknown) | null = null;
  preserveEtagOnCopy = false;
  private etagSeq = 0;

  constructor(private readonly bucket: string) {}

  allocateEtag(): string {
    this.etagSeq += 1;
    return `"opaque-${this.etagSeq}"`;
  }

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.onSend?.();
    if (options?.abortSignal?.aborted) {
      throw options.abortSignal.reason ?? new Error("aborted");
    }
    const name = commandName(command);
    const input = commandInput(command);
    this.calls.push({ name, input: { ...input }, abortSignal: options?.abortSignal });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    if (command instanceof HeadBucketCommand) {
      if (!this.bucketExists || input.Bucket !== this.bucket) {
        throw new FakeS3Error("NotFound", 404, `NotFound bucket=${String(input.Bucket)}`);
      }
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const key = objectKey(input);
      const body = await readInputBody(input.Body);
      if (
        typeof input.ContentLength === "number"
        && input.ContentLength !== body.byteLength
      ) {
        throw new FakeS3Error(
          "IncompleteBody",
          400,
          `declared ${input.ContentLength} bytes but received ${body.byteLength}`,
        );
      }
      const etag = this.allocateEtag();
      this.objects.set(key, {
        body,
        metadata: lowercaseRecord(input.Metadata),
        contentType: typeof input.ContentType === "string" ? input.ContentType : undefined,
        etag,
      });
      return { ETag: etag };
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.requireObject(input, "NoSuchKey");
      const getError = this.getErrors.get(String(input.Key));
      if (getError) throw getError;
      if (typeof input.IfMatch === "string" && input.IfMatch !== stored.etag) {
        throw new FakeS3Error(
          "PreconditionFailed",
          412,
          `PreconditionFailed at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=${String(input.Key)} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
        );
      }
      const etagAtStart = stored.etag;
      let start = 0;
      let end = Math.max(stored.body.byteLength - 1, -1);
      let ranged = false;
      if (typeof input.Range === "string") {
        const parsed = parseByteRange(input.Range, stored.body.byteLength);
        if (parsed === "invalid") {
          throw new FakeS3Error("InvalidArgument", 400, `invalid range ${String(input.Range)}`);
        }
        if (parsed === "unsatisfiable") {
          throw new FakeS3Error(
            "InvalidRange",
            416,
            `InvalidRange at ${SYNTHETIC_ENDPOINT} key=${String(input.Key)}`,
          );
        }
        start = parsed.start;
        end = parsed.end;
        ranged = true;
      }
      const responseChunks = stored.chunks
        ?? (ranged ? [stored.body.slice(start, end + 1)] : [stored.body]);
      const total = stored.chunkProducers
        ? stored.body.byteLength
        : responseChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const contentRange = ranged
        ? stored.reportedContentRange === undefined
          ? `bytes ${start}-${end}/${stored.body.byteLength}`
          : stored.reportedContentRange ?? undefined
        : stored.reportedContentRange === undefined
          ? undefined
          : stored.reportedContentRange ?? undefined;
      const responseEtag = stored.reportedGetEtag !== undefined
        ? stored.reportedGetEtag
        : stored.reportedEtag === undefined
          ? stored.etag
          : stored.reportedEtag;
      if (stored.headerDelayMs !== undefined && stored.headerDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, stored.headerDelayMs);
        });
        if (options?.abortSignal?.aborted) {
          throw options.abortSignal.reason ?? new Error("aborted");
        }
      }
      return {
        Body: sdkBody(stored, responseChunks, etagAtStart, () => {
          this.transformToByteArrayCalls += 1;
        }),
        ContentLength: stored.reportedGetLength ?? stored.reportedLength ?? total,
        ContentType: stored.contentType,
        Metadata: { ...stored.metadata },
        ETag: responseEtag,
        ...(contentRange !== undefined ? { ContentRange: contentRange } : {}),
      };
    }
    if (command instanceof HeadObjectCommand) {
      const stored = this.requireObject(input, "NotFound");
      const headError = this.headErrors.get(String(input.Key));
      if (headError) throw headError;
      return {
        ContentLength: stored.reportedLength ?? stored.body.byteLength,
        ContentType: stored.contentType,
        Metadata: { ...stored.metadata },
        ETag: stored.reportedEtag === undefined ? stored.etag : stored.reportedEtag,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const deleteError = this.deleteErrors.get(String(input.Key));
      if (deleteError) throw deleteError;
      this.objects.delete(objectKey(input));
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const destKey = String(input.Key);
      if (input.MetadataDirective !== "COPY" && input.MetadataDirective !== "REPLACE") {
        throw new FakeS3Error("InvalidArgument", 400, "MetadataDirective must be COPY or REPLACE");
      }
      if (this.throwBeforeApplyKeys.has(destKey)) {
        this.throwBeforeApplyHits += 1;
        throw new FakeS3Error(
          "InternalError",
          500,
          `copy-before-apply at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=${destKey} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
        );
      }
      const source = parseCopySource(input.CopySource);
      const sourceKey = `${source.bucket}/${source.key}`;
      const stored = this.objects.get(sourceKey);
      if (!stored) {
        throw new FakeS3Error(
          "NoSuchKey",
          404,
          `NoSuchKey bucket=${source.bucket} key=${source.key}`,
        );
      }
      const corrupt = this.corruptCopy.get(destKey);
      const replace = input.MetadataDirective === "REPLACE";
      const etag = this.preserveEtagOnCopy ? stored.etag : this.allocateEtag();
      this.objects.set(objectKey(input), {
        body: new Uint8Array(corrupt?.body ?? stored.body),
        metadata: {
          ...(corrupt?.metadata ?? (replace ? lowercaseRecord(input.Metadata) : stored.metadata)),
        },
        contentType: replace
          ? typeof input.ContentType === "string"
            ? input.ContentType
            : undefined
          : stored.contentType,
        etag,
      });
      if (this.throwAfterApplyKeys.has(destKey)) {
        this.throwAfterApplyHits += 1;
        throw new FakeS3Error(
          "InternalError",
          500,
          `copy-after-apply at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=${destKey} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
        );
      }
      return { CopyObjectResult: { ETag: etag } };
    }
    if (command instanceof ListObjectsV2Command) {
      if (this.listHandler) return this.listHandler(input);
      if (input.Bucket !== this.bucket) {
        throw new FakeS3Error("NoSuchBucket", 404, `NoSuchBucket bucket=${String(input.Bucket)}`);
      }
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      const all = [...this.objects.keys()]
        .filter((full) => full.startsWith(`${this.bucket}/`))
        .map((full) => full.slice(this.bucket.length + 1))
        .filter((key) => key.startsWith(prefix))
        .sort();
      const token = typeof input.ContinuationToken === "string" ? input.ContinuationToken : "";
      const from = token === "" ? 0 : all.findIndex((key) => key > token);
      const start = from < 0 ? all.length : from;
      const requested =
        typeof input.MaxKeys === "number" && Number.isSafeInteger(input.MaxKeys) && input.MaxKeys > 0
          ? input.MaxKeys
          : 1000;
      const page = all.slice(start, start + Math.min(this.listPageSize, requested));
      const truncated = start + page.length < all.length;
      const last = page[page.length - 1];
      return {
        Contents: page.map((Key) => ({ Key, ETag: `"not-the-digest"` })),
        IsTruncated: truncated,
        ...(truncated && last !== undefined ? { NextContinuationToken: last } : {}),
      };
    }
    throw new FakeS3Error("NotImplemented", 400, `unsupported ${name}`);
  }

  object(key: string): FakeObject | undefined {
    return this.objects.get(`${this.bucket}/${key}`);
  }

  keys(): string[] {
    return [...this.objects.keys()]
      .filter((full) => full.startsWith(`${this.bucket}/`))
      .map((full) => full.slice(this.bucket.length + 1))
      .sort();
  }

  putRaw(
    key: string,
    body: Uint8Array,
    metadata: Record<string, string> = {},
    reportedLength?: number,
    extra?: {
      chunks?: Uint8Array[];
      chunkProducers?: Array<() => Uint8Array | Promise<Uint8Array>>;
      yieldCount?: { value: number };
      iteratorReturns?: { value: number };
      iteratorReturnHangs?: boolean;
      bodyDestroys?: { value: number };
      bodyCancelOnly?: boolean;
      bodyCancels?: { value: number };
      bodyCancelHangs?: boolean;
      transformOnly?: boolean;
      etag?: string;
      reportedEtag?: string | null;
      reportedGetEtag?: string | null;
      reportedGetLength?: number;
      reportedContentRange?: string | null;
      contentType?: string;
      failAfterYields?: number;
      failYieldError?: Error;
      sequentialNext?: { pending: boolean; concurrent: number };
      headerDelayMs?: number;
      immediateUint8Body?: boolean;
    },
  ): void {
    const stored: FakeObject = {
      body: new Uint8Array(body),
      metadata: lowercaseRecord(metadata),
      contentType: extra?.contentType,
      etag: extra?.etag ?? this.allocateEtag(),
    };
    if (reportedLength !== undefined) stored.reportedLength = reportedLength;
    if (extra?.chunks) stored.chunks = extra.chunks.map((chunk) => new Uint8Array(chunk));
    if (extra?.chunkProducers) stored.chunkProducers = extra.chunkProducers;
    if (extra?.yieldCount) stored.yieldCount = extra.yieldCount;
    if (extra?.iteratorReturns) stored.iteratorReturns = extra.iteratorReturns;
    if (extra?.iteratorReturnHangs) stored.iteratorReturnHangs = true;
    if (extra?.bodyDestroys) stored.bodyDestroys = extra.bodyDestroys;
    if (extra?.bodyCancelOnly) stored.bodyCancelOnly = true;
    if (extra?.bodyCancels) stored.bodyCancels = extra.bodyCancels;
    if (extra?.bodyCancelHangs) stored.bodyCancelHangs = true;
    if (extra?.transformOnly) stored.transformOnly = true;
    if (extra?.reportedEtag !== undefined) stored.reportedEtag = extra.reportedEtag;
    if (extra?.reportedGetEtag !== undefined) stored.reportedGetEtag = extra.reportedGetEtag;
    if (extra?.reportedGetLength !== undefined) stored.reportedGetLength = extra.reportedGetLength;
    if (extra?.reportedContentRange !== undefined) {
      stored.reportedContentRange = extra.reportedContentRange;
    }
    if (extra?.failAfterYields !== undefined) stored.failAfterYields = extra.failAfterYields;
    if (extra?.failYieldError) stored.failYieldError = extra.failYieldError;
    if (extra?.sequentialNext) stored.sequentialNext = extra.sequentialNext;
    if (extra?.headerDelayMs !== undefined) stored.headerDelayMs = extra.headerDelayMs;
    if (extra?.immediateUint8Body) stored.immediateUint8Body = true;
    this.objects.set(`${this.bucket}/${key}`, stored);
  }

  private requireObject(input: Record<string, unknown>, missingName: "NoSuchKey" | "NotFound"): FakeObject {
    const key = objectKey(input);
    const stored = this.objects.get(key);
    if (!stored) {
      throw new FakeS3Error(
        missingName,
        404,
        `${missingName} at ${SYNTHETIC_ENDPOINT} bucket=${String(input.Bucket)} key=${String(input.Key)} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
      );
    }
    return stored;
  }
}

function commandName(command: unknown): string {
  if (typeof command === "object" && command !== null) {
    const name = (command as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === "string" && name !== "") return name;
  }
  return "UnknownCommand";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (typeof command === "object" && command !== null && "input" in command) {
    const input = (command as { input?: unknown }).input;
    if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  }
  return {};
}

function objectKey(input: Record<string, unknown>): string {
  return `${String(input.Bucket)}/${String(input.Key)}`;
}

function parseCopySource(value: unknown): { bucket: string; key: string } {
  const raw = String(value ?? "").replace(/^\//, "");
  const slash = raw.indexOf("/");
  if (slash < 0) return { bucket: decodeURIComponent(raw), key: "" };
  return {
    bucket: decodeURIComponent(raw.slice(0, slash)),
    key: raw
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/"),
  };
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function sdkBody(
  stored: FakeObject,
  chunks: Uint8Array[] = stored.chunks ?? [stored.body],
  etagAtStart: string = stored.etag,
  onTransform?: () => void,
): unknown {
  const transformToByteArray = async (): Promise<Uint8Array> => {
    onTransform?.();
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };
  if (stored.transformOnly) {
    return { transformToByteArray };
  }
  if (stored.immediateUint8Body) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  const producers = stored.chunkProducers ?? chunks.map((chunk) => () => chunk);
  let index = 0;
  const iterator: AsyncIterator<Uint8Array> = {
    async next(): Promise<IteratorResult<Uint8Array>> {
      const sequential = stored.sequentialNext;
      if (sequential) {
        if (sequential.pending) sequential.concurrent += 1;
        sequential.pending = true;
      }
      try {
        if (stored.etag !== etagAtStart) {
          throw new FakeS3Error("InternalError", 500, "object mutated during get");
        }
        if (stored.failAfterYields !== undefined && index >= stored.failAfterYields) {
          throw stored.failYieldError ?? new Error("iterator-failed-mid-body");
        }
        const produce = producers[index];
        if (produce === undefined) return { done: true, value: undefined };
        const chunk = await produce();
        if (stored.yieldCount) stored.yieldCount.value += 1;
        index += 1;
        return { done: false, value: chunk };
      } finally {
        if (sequential) sequential.pending = false;
      }
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      if (stored.iteratorReturns) stored.iteratorReturns.value += 1;
      if (stored.iteratorReturnHangs) {
        return new Promise<IteratorResult<Uint8Array>>(() => undefined);
      }
      return { done: true, value: undefined };
    },
  };
  const base = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return iterator;
    },
    transformToByteArray,
  };
  if (stored.bodyCancelOnly) {
    return {
      ...base,
      cancel(): Promise<void> | void {
        if (stored.bodyCancels) stored.bodyCancels.value += 1;
        if (stored.bodyCancelHangs) return new Promise<void>(() => undefined);
      },
    };
  }
  return {
    ...base,
    destroy(): void {
      if (stored.bodyDestroys) stored.bodyDestroys.value += 1;
    },
  };
}

async function readInputBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof Readable) {
    return collectReadableBody(body);
  }
  if (isAsyncIterableBody(body)) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("fake S3 stream chunk must be a Uint8Array");
      }
      chunks.push(new Uint8Array(chunk));
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
  throw new Error("fake S3 expected Uint8Array or stream body");
}

function collectReadableBody(readable: Readable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    readable.on("data", (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        finish(() => reject(new Error("fake S3 stream chunk must be a Uint8Array")));
        return;
      }
      chunks.push(new Uint8Array(chunk));
      total += chunk.byteLength;
    });
    readable.on("end", () => {
      finish(() => {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of chunks) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        resolve(out);
      });
    });
    readable.on("error", (error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error("fake S3 stream failed")));
    });
    readable.resume();
  });
}

function isAsyncIterableBody(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function parseByteRange(
  value: string,
  size: number,
): { start: number; end: number } | "invalid" | "unsatisfiable" {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) return "invalid";
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return "invalid";
  if (size <= 0 || start >= size || end >= size) return "unsatisfiable";
  return { start, end };
}



function lowercaseRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key.toLowerCase()] = entry;
  }
  return out;
}

function garageOptions(
  client: FakeS3Client,
  extra?: {
    prefix?: string;
    acquireWriteLease?: () => Promise<() => void | Promise<void>>;
    responseBodyIdleTimeoutMs?: number;
  },
) {
  return {
    bucket: SYNTHETIC_BUCKET,
    region: "garage",
    endpoint: SYNTHETIC_ENDPOINT,
    forcePathStyle: true as const,
    accessKeyId: SYNTHETIC_ACCESS,
    secretAccessKey: SYNTHETIC_SECRET,
    client,
    ...(extra?.prefix === undefined ? {} : { prefix: extra.prefix }),
    ...(extra?.acquireWriteLease ? { acquireWriteLease: extra.acquireWriteLease } : {}),
    ...(extra?.responseBodyIdleTimeoutMs === undefined
      ? {}
      : { responseBodyIdleTimeoutMs: extra.responseBodyIdleTimeoutMs }),
  };
}

function openStore(
  prefix?: string,
  extra?: {
    acquireWriteLease?: () => Promise<() => void | Promise<void>>;
    responseBodyIdleTimeoutMs?: number;
  },
): { fake: FakeS3Client; store: S3EvidenceStore } {
  const fake = new FakeS3Client(SYNTHETIC_BUCKET);
  return { fake, store: new S3EvidenceStore(garageOptions(fake, { prefix, ...extra })) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function blobKey(hash: string, prefix?: string): string {
  const relative = `blobs/${hash.slice(0, 2)}/${hash}`;
  return prefix ? `${prefix}/${relative}` : relative;
}

function pendingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const root = prefix ? `${prefix}/.pending/` : ".pending/";
  return fake.keys().filter((key) => key.startsWith(root) && !key.slice(root.length).includes("/"));
}

function stagingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const batchRoot = prefix ? `${prefix}/.staging/` : ".staging/";
  const streamRoot = prefix ? `${prefix}/.stream-staging/` : ".stream-staging/";
  const directRoot = prefix ? `${prefix}/staging/` : "staging/";
  return fake.keys().filter(
    (key) => key.startsWith(batchRoot) || key.startsWith(streamRoot) || key.startsWith(directRoot),
  );
}

function streamStagingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const root = prefix ? `${prefix}/.stream-staging/` : ".stream-staging/";
  return fake.keys().filter((key) => key.startsWith(root));
}

function batchStagingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const batchRoot = prefix ? `${prefix}/.staging/` : ".staging/";
  const directRoot = prefix ? `${prefix}/staging/` : "staging/";
  return fake.keys().filter((key) => key.startsWith(batchRoot) || key.startsWith(directRoot));
}

function assertNoAclOrChecksums(fake: FakeS3Client): void {
  for (const call of fake.calls) {
    for (const field of ACL_FIELDS) {
      expect(call.input[field], `${call.name}.${field}`).toBeUndefined();
    }
    for (const field of CHECKSUM_FIELDS) {
      expect(call.input[field], `${call.name}.${field}`).toBeUndefined();
    }
    expect(call.input.Tagging).toBeUndefined();
    if (call.name === "CopyObjectCommand") {
      expect(
        call.input.MetadataDirective === "COPY" || call.input.MetadataDirective === "REPLACE",
        `${call.name}.MetadataDirective`,
      ).toBe(true);
    }
  }
}

function assertSanitized(error: unknown, extra: string[] = []): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(SYNTHETIC_ENDPOINT);
  expect(message).not.toContain(SYNTHETIC_BUCKET);
  expect(message).not.toContain(SYNTHETIC_ACCESS);
  expect(message).not.toContain(SYNTHETIC_SECRET);
  expect(message).not.toContain(SYNTHETIC_URI);
  expect(message).not.toContain("blobs/");
  expect(message).not.toContain("http://");
  expect(message).not.toContain("https://");
  for (const value of extra) expect(message).not.toContain(value);
}

function leaseTracker(): {
  acquireWriteLease: () => Promise<() => void | Promise<void>>;
  active: () => number;
  acquires: () => number;
  releases: () => number;
  maxActive: () => number;
} {
  let active = 0;
  let acquires = 0;
  let releases = 0;
  let maxActive = 0;
  return {
    acquireWriteLease: async () => {
      acquires += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return async () => {
        releases += 1;
        active -= 1;
      };
    },
    active: () => active,
    acquires: () => acquires,
    releases: () => releases,
    maxActive: () => maxActive,
  };
}

function exclusiveLease(): () => Promise<() => void | Promise<void>> {
  let tail = Promise.resolve();
  return async () => {
    const prior = tail;
    let unlock = (): void => undefined;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prior;
    return () => {
      unlock();
    };
  };
}

function assertPostCopyProbe(fake: FakeS3Client, destKey: string): void {
  const copyIndex = fake.calls.findIndex((call) => call.name === "CopyObjectCommand");
  expect(copyIndex).toBeGreaterThan(-1);
  const copy = fake.calls[copyIndex];
  expect(copy?.input.MetadataDirective).toBe("COPY");
  expect(copy?.input.Key).toBe(destKey);
  const after = fake.calls.slice(copyIndex + 1);
  assertCanonicalHeadThenConditionalGet(after, destKey, fake.object(destKey)?.etag);
}

function leakingLeaseError(kind: string): Error {
  return new Error(
    `${kind} lease failed at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
  );
}

function parseJournal(fake: FakeS3Client, key: string): { id: string; hashes: string[] } {
  const stored = fake.object(key);
  if (!stored) throw new Error(`missing journal ${key}`);
  return JSON.parse(new TextDecoder().decode(stored.body)) as { id: string; hashes: string[] };
}

async function collectChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function* asAsyncChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function scratchPuts(fake: FakeS3Client): Array<{ name: string; input: Record<string, unknown> }> {
  return fake.calls.filter((call) => {
    if (call.name !== "PutObjectCommand") return false;
    const key = String(call.input.Key);
    return key.includes(".stream-staging/")
      || key.includes(".staging/")
      || key.startsWith("staging/")
      || key.includes("/staging/");
  });
}

function assertStreamedScratchPut(fake: FakeS3Client): Record<string, unknown> {
  const put = scratchPuts(fake)[0];
  expect(put).toBeDefined();
  expect(put?.input.Body instanceof Uint8Array).toBe(false);
  expect(isAsyncIterableBody(put?.input.Body)).toBe(true);
  expect(String(put?.input.Key)).not.toMatch(/[0-9a-f]{64}/);
  return put?.input ?? {};
}

function assertReplaceCopy(
  fake: FakeS3Client,
  destKey: string,
  meta: { hash: string; byteLength: number; contentType: string | null },
): void {
  const copyIndex = fake.calls.findIndex(
    (call) => call.name === "CopyObjectCommand" && call.input.Key === destKey,
  );
  expect(copyIndex).toBeGreaterThan(-1);
  const copy = fake.calls[copyIndex];
  expect(copy?.input.MetadataDirective).toBe("REPLACE");
  const metadata = lowercaseRecord(copy?.input.Metadata);
  expect(metadata.sha256).toBe(meta.hash);
  expect(metadata.bytelength).toBe(String(meta.byteLength));
  expect(metadata.contenttype).toBe(meta.contentType ?? "");
  if (meta.contentType !== null) expect(copy?.input.ContentType).toBe(meta.contentType);
  const before = fake.calls.slice(0, copyIndex);
  expect(
    before.some(
      (call) => call.name === "PutObjectCommand" && String(call.input.Key).includes(".pending/"),
    ),
  ).toBe(true);
  const after = fake.calls.slice(copyIndex + 1);
  assertCanonicalHeadThenConditionalGet(after, destKey, fake.object(destKey)?.etag);
}

function assertCanonicalHeadThenConditionalGet(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  key: string,
  expectedEtag?: string,
): void {
  const headIndex = calls.findIndex(
    (call) => call.name === "HeadObjectCommand" && call.input.Key === key,
  );
  const getIndex = calls.findIndex(
    (call) =>
      call.name === "GetObjectCommand"
      && call.input.Key === key
      && call.input.Range === undefined,
  );
  expect(headIndex).toBeGreaterThan(-1);
  expect(getIndex).toBeGreaterThan(headIndex);
  const get = calls[getIndex];
  expect(get?.input.Range).toBeUndefined();
  expect(typeof get?.input.IfMatch).toBe("string");
  if (expectedEtag !== undefined) {
    expect(get?.input.IfMatch).toBe(expectedEtag);
  }
}

function canonicalUserMetadata(hash: string, byteLength: number, contentType = ""): Record<string, string> {
  return {
    sha256: hash,
    bytelength: String(byteLength),
    contenttype: contentType,
  };
}

function streamListOrDelete(
  fake: FakeS3Client,
  prefix?: string,
): Array<{ name: string; input: Record<string, unknown> }> {
  const root = prefix ? `${prefix}/.stream-staging/` : ".stream-staging/";
  return fake.calls.filter((call) => {
    if (call.name === "ListObjectsV2Command") {
      return String(call.input.Prefix ?? "") === root;
    }
    if (call.name === "DeleteObjectCommand") {
      return String(call.input.Key ?? "").startsWith(root);
    }
    return false;
  });
}

async function waitForCall(
  fake: FakeS3Client,
  name: string,
  timeoutMs = 1000,
): Promise<void> {
  const started = Date.now();
  while (!fake.calls.some((call) => call.name === name)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${name}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("S3EvidenceStore", () => {
  it("builds an explicit Garage-compatible client config without the default chain or ACLs", () => {
    const config = createS3ClientConfig({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      prefix: "/cases/prod/",
      endpoint: `${SYNTHETIC_ENDPOINT}/`,
      forcePathStyle: true,
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
      sessionToken: "synthetic-session",
    });
    expect(config.region).toBe("garage");
    expect(config.endpoint).toBe(SYNTHETIC_ENDPOINT);
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toEqual({
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
      sessionToken: "synthetic-session",
    });
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
    expect(config.disableS3ExpressSessionAuth).toBe(true);
    expect(config.credentialDefaultProvider).toBeUndefined();
    expect(config.profile).toBeUndefined();
    expect(config).not.toHaveProperty("ACL");
  });

  it("omits credentials so the SDK default provider chain can run", () => {
    const config = createS3ClientConfig({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      endpoint: SYNTHETIC_ENDPOINT,
      forcePathStyle: true,
    });
    expect(config.credentials).toBeUndefined();
    expect(config.credentialDefaultProvider).toBeUndefined();
    expect(config.profile).toBeUndefined();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      client: fake,
    });
    expect(store.writeCoordination).toBe("single_process");
  });

  it("rejects empty or invalid configuration without leaking values", () => {
    const secrets = {
      region: "garage",
      endpoint: SYNTHETIC_ENDPOINT,
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
    };
    const attempts: Array<() => unknown> = [
      () => createS3ClientConfig({ ...secrets, bucket: "  " }),
      () => createS3ClientConfig({ ...secrets, bucket: SYNTHETIC_BUCKET, region: "" }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          accessKeyId: "",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          secretAccessKey: "   ",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          prefix: "../secret",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://user:pass@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://user@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://:pass@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: `${SYNTHETIC_ENDPOINT}/?x=1`,
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: `${SYNTHETIC_ENDPOINT}/#frag`,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          accessKeyId: SYNTHETIC_ACCESS,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          secretAccessKey: SYNTHETIC_SECRET,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          sessionToken: "synthetic-session",
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          accessKeyId: SYNTHETIC_ACCESS,
          sessionToken: "synthetic-session",
        }),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(S3EvidenceError);
      try {
        attempt();
      } catch (error) {
        assertSanitized(error, ["user:pass", "../secret", "synthetic-session", "?x=1", "#frag"]);
      }
    }
  });

  it("round-trips bytes at the exact sharded prefix key and ignores ETag", async () => {
    const { fake, store } = openStore("cases/prod");
    const bytes = new TextEncoder().encode("synthetic-log-line\n");
    const meta = await store.put(bytes, { contentType: "text/plain" });
    expect(meta.hash).toBe(sha256Hex(bytes));
    expect(meta.byteLength).toBe(bytes.byteLength);
    expect(meta.contentType).toBe("text/plain");
    expect(fake.object(blobKey(meta.hash, "cases/prod"))).toBeDefined();
    const put = fake.calls.find((call) => call.name === "PutObjectCommand");
    expect(put?.input.Key).toBe(blobKey(meta.hash, "cases/prod"));
    expect(put?.input.Bucket).toBe(SYNTHETIC_BUCKET);
    const again = await store.put(bytes);
    expect(again.hash).toBe(meta.hash);
    expect(
      fake.calls.filter((call) => call.name === "PutObjectCommand" && call.input.Key === put?.input.Key),
    ).toHaveLength(1);
    const got = await store.get(meta.hash);
    expect(got).not.toBeNull();
    expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
    const head = await store.head(meta.hash);
    expect(head).toEqual({
      hash: meta.hash,
      byteLength: bytes.byteLength,
      contentType: "text/plain",
    });
    expect(await store.verify(meta.hash)).toBe(true);
    assertNoAclOrChecksums(fake);
  });

  it("does not overwrite a mutated canonical object and fails closed on bad metadata", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("original-bytes");
    const { hash } = await store.put(bytes);
    const stored = fake.object(blobKey(hash));
    expect(stored).toBeDefined();
    if (!stored) throw new Error("missing synthetic object");
    const mutated = new Uint8Array(bytes.byteLength);
    mutated.fill(0x41);
    stored.body = mutated;
    expect(await store.verify(hash)).toBe(false);
    const got = await store.get(hash);
    expect(got).not.toBeNull();
    expect(sha256Hex(got ?? new Uint8Array())).not.toBe(hash);
    await expect(store.put(bytes)).rejects.toThrow(/failed verification/);
    expect(Buffer.from(fake.object(blobKey(hash))?.body ?? []).equals(Buffer.from(mutated))).toBe(true);

    stored.body = bytes;
    stored.metadata.bytelength = "1";
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    stored.metadata.bytelength = String(bytes.byteLength);
    stored.metadata.sha256 = "0".repeat(64);
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    stored.metadata.sha256 = hash;
    stored.metadata.contenttype = "text/plain";
    stored.contentType = "application/octet-stream";
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    assertNoAclOrChecksums(fake);
  });

  it("translates true missing objects to null and rejects operational errors without leaking", async () => {
    const { fake, store } = openStore();
    const missing = sha256Hex(new TextEncoder().encode("absent"));
    expect(await store.get(missing)).toBeNull();
    expect(await store.head(missing)).toBeNull();
    expect(await store.verify(missing)).toBe(false);

    fake.nextError = new FakeS3Error(
      "SlowDown",
      503,
      `SlowDown at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=blobs/ab/${missing} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI} response={"Code":"SlowDown"}`,
    );
    try {
      await store.get(missing);
      throw new Error("expected operational failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("get");
      assertSanitized(error);
      expect(String(error)).not.toContain(missing);
      expect(String(error)).not.toContain("SlowDown");
    }

    fake.nextError = new FakeS3Error(
      "NotFound",
      503,
      `operational NotFound at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET}`,
    );
    await expect(store.get(missing)).rejects.toBeInstanceOf(S3EvidenceError);

    await expect(store.get("../secret")).rejects.toThrow(/invalid content hash/);
    const before = fake.calls.length;
    await expect(store.head("ZZ")).rejects.toThrow(/invalid content hash/);
    expect(fake.calls).toHaveLength(before);
  });

  it("keeps staged bytes invisible, commits idempotently, and rolls back without touching deduped objects", async () => {
    const { fake, store } = openStore("inv");
    const bytes = new TextEncoder().encode("staged-synthetic-line\n");
    const stage = await store.stage(bytes, { contentType: "text/plain" });
    try {
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(fake.object(blobKey(stage.meta.hash, "inv"))).toBeUndefined();
      const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
      expect(String(staged?.input.Key)).toMatch(/^inv\/staging\/[0-9a-f-]{36}$/i);
      expect(String(staged?.input.Key)).not.toContain(stage.meta.hash);
      await stage.commit();
      await stage.commit();
      expect(await store.verify(stage.meta.hash)).toBe(true);
      const copy = fake.calls.find((call) => call.name === "CopyObjectCommand");
      expect(copy?.input.CopySource).toBe(
        encodeCopySource(SYNTHETIC_BUCKET, String(staged?.input.Key)),
      );
      expect(copy?.input.MetadataDirective).toBe("COPY");
      await stage.rollback();
      expect(await store.verify(stage.meta.hash)).toBe(true);
      expect(pendingKeys(fake, "inv")).toHaveLength(1);
      expect(stagingKeys(fake, "inv")).toEqual([]);
    } finally {
      stage.release();
      stage.release();
    }
    await store.recoverUnreferencedWrites(new Set([sha256Hex(bytes)]));
    expect(await store.verify(sha256Hex(bytes))).toBe(true);
    expect(pendingKeys(fake, "inv")).toEqual([]);

    const shared = new TextEncoder().encode("shared-synthetic-line\n");
    const first = await store.put(shared, { contentType: "text/plain" });
    const later = await store.stage(shared, { contentType: "text/x-log" });
    try {
      await later.commit();
      await later.rollback();
    } finally {
      later.release();
    }
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.head(first.hash)).toEqual({
      hash: first.hash,
      byteLength: shared.byteLength,
      contentType: "text/plain",
    });
    assertNoAclOrChecksums(fake);
  });

  it("round-trips file-server references with the filesystem observable semantics", async () => {
    const { fake, store } = openStore("cases/prod");
    const expectedHash = sha256Hex(new TextEncoder().encode("remote"));
    const created = await store.putFileServerReference({
      uri: SYNTHETIC_URI,
      expectedHash,
      verificationStatus: "unverified",
    });
    const parsed = parseFileServerReference(created);
    expect(parsed.uri).toBe(SYNTHETIC_URI);
    expect(parsed.expectedHash).toBe(expectedHash);
    expect(parsed.verificationStatus).toBe("unverified");
    expect(fake.object(`cases/prod/refs/${created.id}.json`)).toBeDefined();
    expect(await store.getFileServerReference(created.id)).toEqual(created);
    const verified = await store.verifyFileServerReference(
      created.id,
      new TextEncoder().encode("remote"),
    );
    expect(verified.verificationStatus).toBe("verified");
    const mismatched = await store.verifyFileServerReference(
      created.id,
      new TextEncoder().encode("other"),
    );
    expect(mismatched.verificationStatus).toBe("unverified");

    await expect(
      store.putFileServerReference({
        uri: SYNTHETIC_URI,
        expectedHash: null,
        verificationStatus: "verified",
      }),
    ).rejects.toThrow(/expected hash/);
    await expect(
      store.putFileServerReference({
        uri: SYNTHETIC_URI,
        expectedHash: "not-a-hash",
      }),
    ).rejects.toThrow(/invalid content hash/);
    const neverHashed = await store.putFileServerReference({ uri: SYNTHETIC_URI });
    expect(neverHashed.expectedHash).toBeNull();
    expect(neverHashed.verificationStatus).toBe("unverified");
    const afterBytes = await store.verifyFileServerReference(
      neverHashed.id,
      new TextEncoder().encode("whatever"),
    );
    expect(afterBytes.verificationStatus).toBe("unverified");
    const unreachable = await store.verifyFileServerReference(neverHashed.id);
    expect(unreachable.verificationStatus).toBe("unreachable");

    await store.abandonFileServerReference(created.id);
    expect(await store.getFileServerReference(created.id)).toBeNull();
    const snapshot = { ...neverHashed, verificationStatus: "unreachable" as const };
    await store.restoreFileServerReference(snapshot);
    expect(await store.getFileServerReference(neverHashed.id)).toEqual(snapshot);
    await expect(store.abandonFileServerReference("../secret")).rejects.toThrow(
      /invalid file-server reference id/,
    );
    await expect(store.restoreFileServerReference({ ...snapshot, id: "../secret" })).rejects.toThrow(
      /invalid file-server reference id/,
    );
    expect(fake.calls.some((call) => String(call.input.Key) === SYNTHETIC_URI)).toBe(false);
    assertNoAclOrChecksums(fake);
  });

  it("rejects malformed, tampered, and unsafe file-server reference JSON", async () => {
    const { fake, store } = openStore();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fake.putRaw(`refs/${id}.json`, new TextEncoder().encode("{"));
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: "not-the-schema",
          id,
          uri: SYNTHETIC_URI,
          expectedHash: null,
          verificationStatus: "unverified",
        }),
      ),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: FILE_SERVER_REF_SCHEMA_ID,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          uri: SYNTHETIC_URI,
          expectedHash: null,
          verificationStatus: "unverified",
        }),
      ),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(`{"schemaId":"${FILE_SERVER_REF_SCHEMA_ID}","__proto__":{"x":1}}`),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
  });

  it("pings with HeadBucket and does not write a public object", async () => {
    const { fake, store } = openStore();
    await store.ping();
    expect(fake.calls.map((call) => call.name)).toEqual(["HeadBucketCommand"]);
    expect(fake.calls[0]?.input).toEqual({ Bucket: SYNTHETIC_BUCKET });
    expect(fake.objects.size).toBe(0);
    fake.bucketExists = false;
    try {
      await store.ping();
      throw new Error("expected ping failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("ping");
      assertSanitized(error);
    }
  });

  it("uses single_process coordination unless an external lease is supplied", () => {
    const { store } = openStore();
    expect(store.writeCoordination).toBe("single_process");
    expect(typeof store.beginWriteBatch).toBe("function");
    expect(typeof store.addReferencedContentHashSource).toBe("function");
    expect(typeof store.recoverUnreferencedWrites).toBe("function");
    const leased = new S3EvidenceStore({
      ...garageOptions(new FakeS3Client(SYNTHETIC_BUCKET)),
      acquireWriteLease: async () => () => undefined,
    });
    expect(leased.writeCoordination).toBe("external");
  });

  it("sanitizes a raw not-found from copy and never leaks keys", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("copy-missing-source\n");
    const stage = await store.stage(bytes);
    try {
      const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
      fake.objects.delete(`${SYNTHETIC_BUCKET}/${String(staged?.input.Key)}`);
      try {
        await stage.commit();
        throw new Error("expected copy failure");
      } catch (error) {
        expect(error).toBeInstanceOf(S3EvidenceError);
        expect((error as S3EvidenceError).operation).toBe("commit");
        assertSanitized(error, [stage.meta.hash, String(staged?.input.Key)]);
        expect(error).not.toBeInstanceOf(FakeS3Error);
      }
    } finally {
      stage.release();
    }
  });

  it("fails closed when downloaded bytes disagree with ContentLength", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("length-mismatch");
    const { hash } = await store.put(bytes);
    const stored = fake.object(blobKey(hash));
    expect(stored).toBeDefined();
    if (!stored) throw new Error("missing synthetic object");
    stored.reportedLength = bytes.byteLength + 1;
    try {
      await store.get(hash);
      throw new Error("expected length mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("get");
      assertSanitized(error, [hash]);
    }
    expect(await store.verify(hash)).toBe(false);
  });

  it("fails a batch put against a corrupt canonical object", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("corrupt-before-batch\n");
    const { hash } = await store.put(bytes);
    const canonical = fake.object(blobKey(hash));
    if (!canonical) throw new Error("missing synthetic canonical object");
    canonical.body = new Uint8Array(bytes.byteLength).fill(0x58);
    const batch = await store.beginWriteBatch();
    try {
      await expect(batch.put(bytes)).rejects.toThrow(/failed verification/);
      expect(stagingKeys(fake)).toEqual([]);
    } finally {
      await batch.rollback();
    }
  });

  it("keeps batch staging invisible, journals before copy, and finalizes canonical bytes", async () => {
    const { fake, store } = openStore("cases/prod");
    const bytes = new TextEncoder().encode("batch-visible-only-after-promote\n");
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(bytes, { contentType: "text/plain" });
    expect(await store.head(meta.hash)).toBeNull();
    expect(await batch.verify(meta.hash)).toBe(true);
    expect(fake.object(blobKey(meta.hash, "cases/prod"))).toBeUndefined();
    const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
    expect(String(staged?.input.Key)).toMatch(/^cases\/prod\/\.staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    expect(String(staged?.input.Key)).not.toContain(meta.hash);
    fake.calls.length = 0;
    await batch.promote();
    const names = fake.calls.map((call) => call.name);
    const journalPut = fake.calls.findIndex(
      (call) => call.name === "PutObjectCommand" && String(call.input.Key).includes(".pending/"),
    );
    const copy = fake.calls.findIndex((call) => call.name === "CopyObjectCommand");
    expect(journalPut).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(journalPut);
    expect(names.slice(0, copy + 1).filter((name) => name === "CopyObjectCommand")).toHaveLength(1);
    const copyCall = fake.calls[copy];
    expect(copyCall?.input.CopySource).toBe(
      encodeCopySource(SYNTHETIC_BUCKET, String(staged?.input.Key)),
    );
    expect(copyCall?.input.MetadataDirective).toBe("COPY");
    expect(await store.verify(meta.hash)).toBe(true);
    const canonical = fake.object(blobKey(meta.hash, "cases/prod"));
    if (!canonical) throw new Error("missing promoted synthetic object");
    canonical.metadata.bytelength = "1";
    expect(await batch.verify(meta.hash)).toBe(false);
    await expect(batch.head(meta.hash)).rejects.toThrow(/inconsistent metadata/);
    canonical.metadata.bytelength = String(bytes.byteLength);
    expect(pendingKeys(fake, "cases/prod")).toHaveLength(1);
    await batch.finalize();
    expect(await store.verify(meta.hash)).toBe(true);
    expect(pendingKeys(fake, "cases/prod")).toEqual([]);
    expect(stagingKeys(fake, "cases/prod")).toEqual([]);
    assertNoAclOrChecksums(fake);
  });

  it("rolls back only objects this batch created", async () => {
    const { fake, store } = openStore();
    const keptBytes = new TextEncoder().encode("pre-existing-canonical\n");
    const kept = await store.put(keptBytes);
    const createdBytes = new TextEncoder().encode("batch-created-canonical\n");
    const batch = await store.beginWriteBatch();
    const again = await batch.put(keptBytes);
    expect(again.hash).toBe(kept.hash);
    const created = await batch.put(createdBytes);
    await batch.promote();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.verify(created.hash)).toBe(true);
    await batch.rollback();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.head(created.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
    assertNoAclOrChecksums(fake);
  });

  it("reclaims unreferenced crash residue and keeps referenced hashes", async () => {
    const { fake, store } = openStore();
    const kept = await store.put(new TextEncoder().encode("kept-after-crash\n"));
    const batch = await store.beginWriteBatch();
    const crashed = await batch.put(new TextEncoder().encode("crashed-unreferenced\n"));
    await batch.promote();
    expect(pendingKeys(fake)).toHaveLength(1);
    expect(await store.verify(crashed.hash)).toBe(true);
    await abandonS3WriteBatchForCrashTest(batch);
    const recovered = await store.recoverUnreferencedWrites(new Set([kept.hash]));
    expect(recovered.journals).toBe(1);
    expect(recovered.reclaimed).toEqual([crashed.hash]);
    expect(await store.head(crashed.hash)).toBeNull();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("cleans an interrupted ad-hoc stage after a simulated process restart", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const original = new S3EvidenceStore(garageOptions(fake));
    const interrupted = await original.stage(
      new TextEncoder().encode("interrupted-direct-stage\n"),
    );
    expect(stagingKeys(fake)).toHaveLength(1);
    const restarted = new S3EvidenceStore(garageOptions(fake));
    const recovered = await restarted.recoverUnreferencedWrites(new Set());
    expect(recovered).toEqual({ reclaimed: [], journals: 0 });
    expect(stagingKeys(fake)).toEqual([]);
    interrupted.release();
  });

  it("drops a retained journal once a later durable reference exists", async () => {
    const { fake, store } = openStore();
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(new TextEncoder().encode("committed-then-referenced\n"));
    await batch.promote();
    await batch.finalize({ retainPendingJournal: true });
    expect(pendingKeys(fake)).toHaveLength(1);
    expect(await store.verify(meta.hash)).toBe(true);
    const recovered = await store.recoverUnreferencedWrites(new Set([meta.hash]));
    expect(recovered.reclaimed).toEqual([]);
    expect(await store.verify(meta.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("pages ListObjectsV2 for pending journals and staging residue", async () => {
    const { fake, store } = openStore();
    fake.listPageSize = 2;
    const live = await store.put(new TextEncoder().encode("live-paginated\n"));
    const orphans: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const bytes = new TextEncoder().encode(`orphan-paginated-${index}\n`);
      const hash = sha256Hex(bytes);
      orphans.push(hash);
      fake.putRaw(
        blobKey(hash),
        bytes,
        {
          sha256: hash,
          bytelength: String(bytes.byteLength),
          contenttype: "",
        },
      );
      fake.putRaw(
        `.pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}.json`,
        new TextEncoder().encode(
          JSON.stringify({
            schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
            id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
            hashes: [hash],
          }),
        ),
      );
      fake.putRaw(`.staging/${index}/${index}`, bytes);
    }
    const recovered = await store.recoverUnreferencedWrites(new Set([live.hash]));
    expect(recovered.journals).toBe(5);
    expect(recovered.reclaimed.sort()).toEqual([...orphans].sort());
    const lists = fake.calls.filter((call) => call.name === "ListObjectsV2Command");
    expect(lists.length).toBeGreaterThan(2);
    expect(lists.every((call) => call.input.MaxKeys === 1000)).toBe(true);
    expect(lists.some((call) => typeof call.input.ContinuationToken === "string")).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
    expect(await store.verify(live.hash)).toBe(true);
  });

  it("ignores path-crafted journal hashes and malformed journals without deleting live blobs", async () => {
    const { fake, store } = openStore();
    const live = await store.put(new TextEncoder().encode("live-blob\n"));
    const orphan = await store.put(new TextEncoder().encode("orphan-blob\n"));
    fake.putRaw(
      ".pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json",
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          hashes: ["../secret", orphan.hash],
        }),
      ),
    );
    fake.putRaw(
      ".pending/not-a-uuid.json",
      new TextEncoder().encode(JSON.stringify({ hashes: [live.hash] })),
    );
    fake.putRaw(".pending/cccccccc-cccc-4ccc-8ccc-cccccccccccc.json", new TextEncoder().encode("{"));
    const recovered = await store.recoverUnreferencedWrites(new Set([live.hash]));
    expect(recovered.reclaimed).toEqual([]);
    expect(await store.verify(live.hash)).toBe(true);
    expect(await store.verify(orphan.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([".pending/not-a-uuid.json"]);
  });

  it("reclaims a crashed batch on the next exclusive write when reference sources are bound", async () => {
    const { store } = openStore();
    const referenced = new Set<string>();
    store.addReferencedContentHashSource(async () => referenced);
    const batch = await store.beginWriteBatch();
    const crashed = await batch.put(new TextEncoder().encode("auto-recover-crash\n"));
    await batch.promote();
    await abandonS3WriteBatchForCrashTest(batch);
    expect(await store.verify(crashed.hash)).toBe(true);
    const next = await store.beginWriteBatch();
    const later = await next.put(new TextEncoder().encode("later-intake\n"));
    await next.promote();
    await next.finalize();
    expect(await store.head(crashed.hash)).toBeNull();
    expect(await store.verify(later.hash)).toBe(true);
  });

  it("refuses recovery without a referenced-hash set or bound source", async () => {
    const { store } = openStore();
    await expect(store.recoverUnreferencedWrites()).rejects.toThrow(
      /referenced content hashes are required/,
    );
  });

  it("holds one lock and lease from begin through promote and finalize", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const heldDuringSend: number[] = [];
    fake.onSend = () => {
      heldDuringSend.push(lease.active());
    };
    const store = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }));
    expect(store.writeCoordination).toBe("external");
    const batch = await store.beginWriteBatch();
    expect(lease.active()).toBe(1);
    expect(lease.maxActive()).toBe(1);
    await batch.put(new TextEncoder().encode("lease-held-throughout\n"));
    expect(lease.active()).toBe(1);
    await batch.promote();
    expect(lease.active()).toBe(1);
    expect(heldDuringSend.every((value) => value === 1)).toBe(true);
    await batch.finalize();
    expect(lease.active()).toBe(0);
    expect(lease.acquires()).toBe(1);
    expect(lease.releases()).toBe(1);
    await store.put(new TextEncoder().encode("after-batch\n"));
    expect(lease.acquires()).toBe(2);
    expect(lease.active()).toBe(0);
    expect(lease.maxActive()).toBe(1);
  });

  it("does not retain the write lease across outstanding stages so a third-digest put can finish first", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }),
    );
    const bytesA = new TextEncoder().encode("outstanding-stage-a\n");
    const bytesB = new TextEncoder().encode("outstanding-stage-b\n");
    const bytesC = new TextEncoder().encode("third-digest-put\n");
    const [stageA, stageB] = await Promise.all([store.stage(bytesA), store.stage(bytesB)]);
    expect(stageA.meta.hash).not.toBe(stageB.meta.hash);
    expect(lease.active()).toBe(0);
    expect(lease.maxActive()).toBe(1);
    expect(await store.head(stageA.meta.hash)).toBeNull();
    expect(await store.head(stageB.meta.hash)).toBeNull();
    const putMeta = await store.put(bytesC);
    expect(putMeta.hash).toBe(sha256Hex(bytesC));
    expect(await store.verify(putMeta.hash)).toBe(true);
    expect(lease.active()).toBe(0);
    await stageA.commit();
    await stageB.commit();
    expect(await store.verify(stageA.meta.hash)).toBe(true);
    expect(await store.verify(stageB.meta.hash)).toBe(true);
    expect(lease.active()).toBe(0);
    stageA.release();
    stageA.release();
    stageB.release();
    expect(lease.maxActive()).toBe(1);
  });

  it("fails closed on nested batch, stage, and file-reference mutations", async () => {
    const { store } = openStore();
    const batch = await store.beginWriteBatch();
    await expect(batch.beginWriteBatch()).rejects.toThrow(/nested evidence write batches/);
    await expect(batch.stage()).rejects.toThrow(/nested evidence stages/);
    await expect(
      batch.stageStream(asAsyncChunks([new Uint8Array([1])]), { maxBytes: 1 }),
    ).rejects.toThrow(/streaming evidence stages/);
    await expect(batch.putFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.abandonFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.restoreFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.verifyFileServerReference()).rejects.toThrow(/file-server references/);
    await batch.rollback();
  });

  it("unions explicit recovery hashes with bound referenced sources", async () => {
    const { fake, store } = openStore();
    const explicitBytes = new TextEncoder().encode("explicit-protected\n");
    const sourceBytes = new TextEncoder().encode("source-protected\n");
    const orphanBytes = new TextEncoder().encode("union-orphan\n");
    const explicitMeta = await store.put(explicitBytes);
    const sourceMeta = await store.put(sourceBytes);
    const orphanMeta = await store.put(orphanBytes);
    const journalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    fake.putRaw(
      `.pending/${journalId}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: journalId,
          hashes: [explicitMeta.hash, sourceMeta.hash, orphanMeta.hash],
        }),
      ),
    );
    store.addReferencedContentHashSource(async () => [sourceMeta.hash, "not-a-hash", "../secret"]);
    const recovered = await store.recoverUnreferencedWrites(
      new Set([explicitMeta.hash, "zz", "../secret"]),
    );
    expect(recovered.journals).toBe(1);
    expect(recovered.reclaimed).toEqual([orphanMeta.hash]);
    expect(await store.verify(explicitMeta.hash)).toBe(true);
    expect(await store.verify(sourceMeta.hash)).toBe(true);
    expect(await store.head(orphanMeta.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("treats CopyObject applied-then-thrown as applied for a stage and retains the journal", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("stage-applied-then-thrown\n");
    const stage = await store.stage(bytes);
    const hash = stage.meta.hash;
    fake.throwAfterApplyKeys.add(blobKey(hash));
    try {
      await stage.commit();
      await stage.commit();
      expect(fake.throwAfterApplyHits).toBe(1);
      assertPostCopyProbe(fake, blobKey(hash));
      expect(await store.verify(hash)).toBe(true);
      expect(pendingKeys(fake)).toHaveLength(1);
      const journal = parseJournal(fake, pendingKeys(fake)[0] ?? "");
      expect(journal.hashes).toEqual([hash]);
    } finally {
      stage.release();
    }
    const recovered = await store.recoverUnreferencedWrites(new Set([hash]));
    expect(recovered.reclaimed).toEqual([]);
    expect(await store.verify(hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("reclaims unreferenced bytes after a stage CopyObject applied-then-thrown commit", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("stage-applied-then-reclaim\n");
    const stage = await store.stage(bytes);
    fake.throwAfterApplyKeys.add(blobKey(stage.meta.hash));
    try {
      await stage.commit();
      expect(fake.throwAfterApplyHits).toBe(1);
      assertPostCopyProbe(fake, blobKey(stage.meta.hash));
      expect(pendingKeys(fake)).toHaveLength(1);
    } finally {
      stage.release();
    }
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered.reclaimed).toEqual([stage.meta.hash]);
    expect(await store.head(stage.meta.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("preserves a stage journal when CopyObject applies but the probe is unknown", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("stage-copy-unknown-probe\n");
    const stage = await store.stage(bytes);
    const canonical = blobKey(stage.meta.hash);
    fake.throwAfterApplyKeys.add(canonical);
    fake.headErrors.set(
      canonical,
      new FakeS3Error(
        "SlowDown",
        503,
        `probe failed at ${SYNTHETIC_ENDPOINT} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET}`,
      ),
    );
    try {
      try {
        await stage.commit();
        throw new Error("expected unknown copy outcome");
      } catch (error) {
        expect(error).toBeInstanceOf(S3EvidenceError);
        expect((error as S3EvidenceError).operation).toBe("commit");
        assertSanitized(error, [stage.meta.hash, canonical]);
      }
      expect(fake.throwAfterApplyHits).toBe(1);
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(fake.object(canonical)).toBeDefined();
      await stage.rollback();
      await stage.rollback();
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(fake.object(canonical)).toBeDefined();
    } finally {
      stage.release();
    }
    fake.headErrors.clear();
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered.reclaimed).toEqual([stage.meta.hash]);
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("treats CopyObject applied-then-thrown as applied for a batch and recovers by reference union", async () => {
    const { fake, store } = openStore();
    const keptBytes = new TextEncoder().encode("batch-applied-kept\n");
    const reclaimBytes = new TextEncoder().encode("batch-applied-reclaim\n");
    const batch = await store.beginWriteBatch();
    const kept = await batch.put(keptBytes);
    const reclaim = await batch.put(reclaimBytes);
    fake.throwAfterApplyKeys.add(blobKey(kept.hash));
    fake.throwAfterApplyKeys.add(blobKey(reclaim.hash));
    await batch.promote();
    await batch.promote();
    expect(fake.throwAfterApplyHits).toBe(2);
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.verify(reclaim.hash)).toBe(true);
    expect(pendingKeys(fake)).toHaveLength(1);
    const journal = parseJournal(fake, pendingKeys(fake)[0] ?? "");
    expect([...journal.hashes].sort()).toEqual([kept.hash, reclaim.hash].sort());
    await abandonS3WriteBatchForCrashTest(batch);
    store.addReferencedContentHashSource(async () => [kept.hash]);
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered.reclaimed).toEqual([reclaim.hash]);
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.head(reclaim.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("retries a partial batch promote with one full journal id", async () => {
    const { fake, store } = openStore();
    const firstBytes = new TextEncoder().encode("partial-promote-first\n");
    const secondBytes = new TextEncoder().encode("partial-promote-second\n");
    const batch = await store.beginWriteBatch();
    const first = await batch.put(firstBytes);
    const second = await batch.put(secondBytes);
    fake.throwBeforeApplyKeys.add(blobKey(second.hash));
    try {
      await batch.promote();
      throw new Error("expected partial promote failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("promote");
      assertSanitized(error, [first.hash, second.hash]);
    }
    expect(pendingKeys(fake)).toHaveLength(1);
    const journalKey = pendingKeys(fake)[0] ?? "";
    const before = parseJournal(fake, journalKey);
    expect([...before.hashes].sort()).toEqual([first.hash, second.hash].sort());
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.head(second.hash)).toBeNull();
    fake.throwBeforeApplyKeys.clear();
    await batch.promote();
    expect(pendingKeys(fake)).toEqual([journalKey]);
    const after = parseJournal(fake, journalKey);
    expect(after.id).toBe(before.id);
    expect([...after.hashes].sort()).toEqual([first.hash, second.hash].sort());
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.verify(second.hash)).toBe(true);
    await batch.finalize();
    expect(pendingKeys(fake)).toEqual([]);
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.verify(second.hash)).toBe(true);
  });

  it("does not let a cross-instance stale rollback delete canonical bytes another store adopted", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const acquireWriteLease = exclusiveLease();
    const storeA = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease }));
    const storeB = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease }));
    const bytes = new TextEncoder().encode("cross-instance-adopted\n");
    const stageA = await storeA.stage(bytes);
    await stageA.commit();
    expect(await storeA.verify(stageA.meta.hash)).toBe(true);
    const adopted = await storeB.put(bytes);
    expect(adopted.hash).toBe(stageA.meta.hash);
    await stageA.rollback();
    stageA.release();
    await stageA.rollback();
    expect(await storeB.verify(adopted.hash)).toBe(true);
    expect(await storeA.verify(adopted.hash)).toBe(true);
    expect(fake.object(blobKey(adopted.hash))).toBeDefined();
  });

  it("fails closed on malformed, missing, repeated, non-progressing, and exhausting ListObjectsV2 pagination", async () => {
    const scenarios: Array<{ name: string; handler: (input: Record<string, unknown>) => unknown }> = [
      {
        name: "malformed contents",
        handler: () => ({ Contents: "nope", IsTruncated: false }),
      },
      {
        name: "malformed truncated flag",
        handler: () => ({ Contents: [], IsTruncated: "true" }),
      },
      {
        name: "missing continuation token",
        handler: () => ({
          Contents: [{ Key: ".pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json" }],
          IsTruncated: true,
        }),
      },
      {
        name: "repeated continuation token",
        handler: () => ({
          Contents: [{ Key: ".pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json" }],
          IsTruncated: true,
          NextContinuationToken: "same-token",
        }),
      },
      {
        name: "non-progressing empty truncated page",
        handler: () => ({
          Contents: [],
          IsTruncated: true,
          NextContinuationToken: "empty-progress",
        }),
      },
      {
        name: "oversized page",
        handler: () => ({
          Contents: Array.from({ length: 1001 }, (_, index) => ({ Key: `.pending/k${index}` })),
          IsTruncated: false,
        }),
      },
    ];
    for (const scenario of scenarios) {
      const { fake, store } = openStore();
      fake.listHandler = scenario.handler;
      try {
        await store.recoverUnreferencedWrites(new Set());
        throw new Error(`expected ${scenario.name} to fail closed`);
      } catch (error) {
        expect(error, scenario.name).toBeInstanceOf(S3EvidenceError);
        expect((error as S3EvidenceError).operation).toBe("recoverUnreferencedWrites");
        assertSanitized(error);
      }
    }

    const pages = openStore();
    let page = 0;
    pages.fake.listHandler = () => {
      page += 1;
      return {
        Contents: [{ Key: `.pending/page-${page}` }],
        IsTruncated: true,
        NextContinuationToken: `tok-${page}`,
      };
    };
    try {
      await pages.store.recoverUnreferencedWrites(new Set());
      throw new Error("expected page-limit exhaustion to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("recoverUnreferencedWrites");
      assertSanitized(error);
    }
    expect(page).toBe(256);
    expect(
      pages.fake.calls.filter((call) => call.name === "ListObjectsV2Command").every(
        (call) => call.input.MaxKeys === 1000,
      ),
    ).toBe(true);

    const objects = openStore();
    let objectPage = 0;
    objects.fake.listHandler = () => {
      objectPage += 1;
      return {
        Contents: Array.from({ length: 1000 }, (_, index) => ({
          Key: `.pending/p${objectPage}-k${index}`,
        })),
        IsTruncated: true,
        NextContinuationToken: `objects-${objectPage}`,
      };
    };
    try {
      await objects.store.recoverUnreferencedWrites(new Set());
      throw new Error("expected object-limit exhaustion to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("recoverUnreferencedWrites");
      assertSanitized(error);
    }
    expect(objectPage).toBe(9);
    expect(
      objects.fake.calls.filter((call) => call.name === "ListObjectsV2Command").every(
        (call) => call.input.MaxKeys === 1000,
      ),
    ).toBe(true);
  });

  it("sanitizes delayed and rejected lease acquire/release without deadlocking the in-process tail", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    let acquireCalls = 0;
    let releaseCalls = 0;
    let failNextAcquire = true;
    let failNextRelease = true;
    const store = new S3EvidenceStore(
      garageOptions(fake, {
        acquireWriteLease: async () => {
          acquireCalls += 1;
          if (failNextAcquire) {
            failNextAcquire = false;
            throw leakingLeaseError("acquire");
          }
          return async () => {
            releaseCalls += 1;
            if (failNextRelease) {
              failNextRelease = false;
              throw leakingLeaseError("release");
            }
          };
        },
      }),
    );

    try {
      await store.put(new TextEncoder().encode("lease-acquire-fail\n"));
      throw new Error("expected acquire failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("lease");
      assertSanitized(error, ["acquire lease failed"]);
    }

    try {
      await store.put(new TextEncoder().encode("lease-release-fail\n"));
      throw new Error("expected release failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("lease");
      assertSanitized(error, ["release lease failed"]);
    }

    const first = new TextEncoder().encode("lease-ok-one\n");
    const second = new TextEncoder().encode("lease-ok-two\n");
    const [metaOne, metaTwo] = await Promise.all([store.put(first), store.put(second)]);
    expect(await store.verify(metaOne.hash)).toBe(true);
    expect(await store.verify(metaTwo.hash)).toBe(true);
    expect(acquireCalls).toBeGreaterThanOrEqual(4);
    expect(releaseCalls).toBeGreaterThanOrEqual(3);
  });

  it("does not sticky-adopt a recycled digest after a prior put on the same instance", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("recycle-no-sticky-adopt\n");
    const first = await store.put(bytes);
    fake.objects.delete(`${SYNTHETIC_BUCKET}/${blobKey(first.hash)}`);
    expect(await store.head(first.hash)).toBeNull();
    const batch = await store.beginWriteBatch();
    const again = await batch.put(bytes);
    expect(again.hash).toBe(first.hash);
    await batch.promote();
    expect(await store.verify(first.hash)).toBe(true);
    await batch.rollback();
    expect(await store.head(first.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("protects uncommitted live staging from same-process recover and beginWriteBatch", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("live-uncommitted-stage\n");
    const stage = await store.stage(bytes);
    try {
      expect(stagingKeys(fake)).toHaveLength(1);
      const recovered = await store.recoverUnreferencedWrites(new Set());
      expect(recovered).toEqual({ reclaimed: [], journals: 0 });
      expect(stagingKeys(fake)).toHaveLength(1);
      const batch = await store.beginWriteBatch();
      expect(stagingKeys(fake)).toHaveLength(1);
      await batch.rollback();
      expect(stagingKeys(fake)).toHaveLength(1);
    } finally {
      stage.release();
    }
    const after = await store.recoverUnreferencedWrites(new Set());
    expect(after).toEqual({ reclaimed: [], journals: 0 });
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("protects a committed live stage journal from same-process recover and batch startup", async () => {
    const { fake, store } = openStore();
    store.addReferencedContentHashSource(async () => []);
    const bytes = new TextEncoder().encode("live-committed-stage\n");
    const stage = await store.stage(bytes);
    try {
      await stage.commit();
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(await store.verify(stage.meta.hash)).toBe(true);
      const recovered = await store.recoverUnreferencedWrites(new Set());
      expect(recovered.reclaimed).toEqual([]);
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(await store.verify(stage.meta.hash)).toBe(true);
      const batch = await store.beginWriteBatch();
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(await store.verify(stage.meta.hash)).toBe(true);
      await batch.rollback();
    } finally {
      stage.release();
    }
    const after = await store.recoverUnreferencedWrites(new Set());
    expect(after.reclaimed).toEqual([sha256Hex(bytes)]);
    expect(pendingKeys(fake)).toEqual([]);
    expect(await store.head(sha256Hex(bytes))).toBeNull();
  });

  it("fails commit/promote when a 200 CopyObject stores corrupt bytes and keeps the journal", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("corrupt-copy-success\n");
    const stage = await store.stage(bytes);
    const dest = blobKey(stage.meta.hash);
    fake.corruptCopy.set(dest, { body: new Uint8Array(bytes.byteLength).fill(0x41) });
    try {
      await expect(stage.commit()).rejects.toBeInstanceOf(S3EvidenceError);
      assertPostCopyProbe(fake, dest);
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(await store.verify(stage.meta.hash)).toBe(false);
    } finally {
      stage.release();
    }

    const batchCase = openStore();
    const batch = await batchCase.store.beginWriteBatch();
    const first = await batch.put(new TextEncoder().encode("corrupt-batch-first\n"));
    const second = await batch.put(new TextEncoder().encode("corrupt-batch-second\n"));
    batchCase.fake.corruptCopy.set(blobKey(second.hash), {
      body: new Uint8Array(second.byteLength).fill(0x42),
    });
    await expect(batch.promote()).rejects.toBeInstanceOf(S3EvidenceError);
    expect(pendingKeys(batchCase.fake)).toHaveLength(1);
    expect(parseJournal(batchCase.fake, pendingKeys(batchCase.fake)[0] ?? "").hashes.sort()).toEqual(
      [first.hash, second.hash].sort(),
    );
    expect(await batchCase.store.verify(first.hash)).toBe(true);
    expect(await batchCase.store.verify(second.hash)).toBe(false);
    await batch.rollback();
    expect(pendingKeys(batchCase.fake)).toHaveLength(1);
    expect(parseJournal(batchCase.fake, pendingKeys(batchCase.fake)[0] ?? "").hashes.sort()).toEqual(
      [first.hash, second.hash].sort(),
    );
  });

  it("retains the full batch journal when rollback inspect is mismatch or unknown", async () => {
    const mismatch = openStore();
    const mismatchBytes = new TextEncoder().encode("rollback-mismatch\n");
    const mismatchBatch = await mismatch.store.beginWriteBatch();
    const mismatchMeta = await mismatchBatch.put(mismatchBytes);
    await mismatchBatch.promote();
    const stored = mismatch.fake.object(blobKey(mismatchMeta.hash));
    if (!stored) throw new Error("missing promoted object");
    stored.body = new Uint8Array(mismatchBytes.byteLength).fill(0x43);
    await mismatchBatch.rollback();
    expect(pendingKeys(mismatch.fake)).toHaveLength(1);
    expect(mismatch.fake.object(blobKey(mismatchMeta.hash))).toBeDefined();

    const unknownHead = openStore();
    const unknownBytes = new TextEncoder().encode("rollback-unknown-head\n");
    const unknownBatch = await unknownHead.store.beginWriteBatch();
    const unknownMeta = await unknownBatch.put(unknownBytes);
    await unknownBatch.promote();
    unknownHead.fake.headErrors.set(
      blobKey(unknownMeta.hash),
      new FakeS3Error("SlowDown", 503, `head failed at ${SYNTHETIC_ENDPOINT}`),
    );
    await unknownBatch.rollback();
    expect(pendingKeys(unknownHead.fake)).toHaveLength(1);
    expect(unknownHead.fake.object(blobKey(unknownMeta.hash))).toBeDefined();

    const unknownGet = openStore();
    const getBytes = new TextEncoder().encode("rollback-unknown-get\n");
    const getBatch = await unknownGet.store.beginWriteBatch();
    const getMeta = await getBatch.put(getBytes);
    await getBatch.promote();
    unknownGet.fake.getErrors.set(
      blobKey(getMeta.hash),
      new FakeS3Error("SlowDown", 503, `get failed at ${SYNTHETIC_ENDPOINT}`),
    );
    await getBatch.rollback();
    expect(pendingKeys(unknownGet.fake)).toHaveLength(1);
    expect(unknownGet.fake.object(blobKey(getMeta.hash))).toBeDefined();
  });

  it("retries batch rollback after a canonical DeleteObject failure with a fresh lock", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }));
    const bytes = new TextEncoder().encode("retry-canonical-delete\n");
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(bytes);
    await batch.promote();
    fake.deleteErrors.set(
      blobKey(meta.hash),
      new FakeS3Error("InternalError", 500, `delete canonical at ${SYNTHETIC_ENDPOINT}`),
    );
    await expect(batch.rollback()).rejects.toBeInstanceOf(S3EvidenceError);
    expect(lease.active()).toBe(0);
    expect(pendingKeys(fake)).toHaveLength(1);
    expect(fake.object(blobKey(meta.hash))).toBeDefined();
    fake.deleteErrors.clear();
    await batch.rollback();
    expect(lease.acquires()).toBe(2);
    expect(lease.releases()).toBe(2);
    expect(await store.head(meta.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
    const later = await store.put(new TextEncoder().encode("after-canonical-delete-retry\n"));
    expect(await store.verify(later.hash)).toBe(true);
  });

  it("retries finalize after a journal DeleteObject failure and does not swallow it", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }));
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(new TextEncoder().encode("retry-journal-delete\n"));
    await batch.promote();
    const journalKey = pendingKeys(fake)[0] ?? "";
    fake.deleteErrors.set(
      journalKey,
      new FakeS3Error("InternalError", 500, `delete journal at ${SYNTHETIC_ENDPOINT}`),
    );
    await expect(batch.finalize()).rejects.toBeInstanceOf(S3EvidenceError);
    expect(lease.active()).toBe(0);
    expect(pendingKeys(fake)).toEqual([journalKey]);
    expect(await store.verify(meta.hash)).toBe(true);
    fake.deleteErrors.clear();
    await batch.finalize();
    expect(lease.acquires()).toBe(2);
    expect(pendingKeys(fake)).toEqual([]);
    expect(await store.verify(meta.hash)).toBe(true);
    await batch.finalize();
    expect(lease.acquires()).toBe(2);
  });

  it("surfaces a rejected batch lease release, unblocks the tail, and does not double-release", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    let acquires = 0;
    let releases = 0;
    let failNextRelease = true;
    const store = new S3EvidenceStore(
      garageOptions(fake, {
        acquireWriteLease: async () => {
          acquires += 1;
          return async () => {
            releases += 1;
            if (failNextRelease) {
              failNextRelease = false;
              throw leakingLeaseError("release");
            }
          };
        },
      }),
    );
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(new TextEncoder().encode("lease-release-reject-batch\n"));
    await batch.promote();
    try {
      await batch.finalize();
      throw new Error("expected lease release failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("lease");
      assertSanitized(error, ["release lease failed"]);
    }
    expect(releases).toBe(1);
    expect(acquires).toBe(1);
    const later = await store.put(new TextEncoder().encode("after-batch-lease-reject\n"));
    expect(await store.verify(later.hash)).toBe(true);
    expect(await store.verify(meta.hash)).toBe(true);
    expect(acquires).toBe(2);
    expect(releases).toBe(2);
    await batch.finalize();
    expect(acquires).toBe(2);
  });

  it("clears sticky ownershipUnknown after a complete promote retry of the same journal", async () => {
    const { fake, store } = openStore();
    const firstBytes = new TextEncoder().encode("retry-unknown-first\n");
    const secondBytes = new TextEncoder().encode("retry-unknown-second\n");
    const batch = await store.beginWriteBatch();
    const first = await batch.put(firstBytes);
    const second = await batch.put(secondBytes);
    fake.throwAfterApplyKeys.add(blobKey(second.hash));
    fake.headErrors.set(
      blobKey(second.hash),
      new FakeS3Error("SlowDown", 503, `unknown probe at ${SYNTHETIC_ENDPOINT}`),
    );
    try {
      await batch.promote();
      throw new Error("expected unknown promote");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("promote");
      assertSanitized(error, [second.hash]);
    }
    expect(fake.throwAfterApplyHits).toBe(1);
    expect(pendingKeys(fake)).toHaveLength(1);
    const journalKey = pendingKeys(fake)[0] ?? "";
    const before = parseJournal(fake, journalKey);
    expect([...before.hashes].sort()).toEqual([first.hash, second.hash].sort());
    fake.throwAfterApplyKeys.clear();
    fake.headErrors.clear();
    await batch.promote();
    expect(pendingKeys(fake)).toEqual([journalKey]);
    const after = parseJournal(fake, journalKey);
    expect(after.id).toBe(before.id);
    expect([...after.hashes].sort()).toEqual([first.hash, second.hash].sort());
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.verify(second.hash)).toBe(true);
    await batch.rollback();
    expect(await store.head(first.hash)).toBeNull();
    expect(await store.head(second.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("bounds journal and file-reference reads by streaming chunks and stopping early", async () => {
    const { fake, store } = openStore();
    const journalId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const first = new Uint8Array(16).fill(0x11);
    const extra = new Uint8Array(64).fill(0x22);
    const yieldCount = { value: 0 };
    fake.putRaw(
      `.pending/${journalId}.json`,
      new Uint8Array([...first, ...extra, ...extra]),
      {},
      16,
      { chunks: [first, extra, extra], yieldCount },
    );
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered.reclaimed).toEqual([]);
    expect(yieldCount.value).toBe(2);
    expect(pendingKeys(fake)).toEqual([]);

    const refId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const refYield = { value: 0 };
    fake.putRaw(
      `refs/${refId}.json`,
      new Uint8Array([...first, ...extra, ...extra]),
      {},
      16,
      { chunks: [first, extra, extra], yieldCount: refYield },
    );
    await expect(store.getFileServerReference(refId)).rejects.toThrow(/malformed file-server reference|inconsistent object/);
    expect(refYield.value).toBe(2);

    const transformId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fake.putRaw(
      `.pending/${transformId}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: transformId,
          hashes: [],
        }),
      ),
      {},
      undefined,
      { transformOnly: true },
    );
    await expect(store.recoverUnreferencedWrites(new Set())).rejects.toBeInstanceOf(S3EvidenceError);
  });

  it("serializes same-digest ad-hoc stages until release", async () => {
    const { store } = openStore();
    const bytes = new TextEncoder().encode("same-digest-stage\n");
    const first = await store.stage(bytes);
    let secondReady = false;
    const secondPromise = store.stage(bytes).then((stage) => {
      secondReady = true;
      return stage;
    });
    await store.head(sha256Hex(bytes));
    expect(secondReady).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondReady).toBe(true);
    second.release();
  });

  it("keeps a throw-before-apply stage from publishing canonical bytes", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("stage-throw-before-apply\n");
    const stage = await store.stage(bytes);
    fake.throwBeforeApplyKeys.add(blobKey(stage.meta.hash));
    try {
      await expect(stage.commit()).rejects.toBeInstanceOf(S3EvidenceError);
      expect(fake.throwBeforeApplyHits).toBe(1);
      expect(fake.object(blobKey(stage.meta.hash))).toBeUndefined();
      expect(pendingKeys(fake)).toHaveLength(1);
      await stage.rollback();
      expect(pendingKeys(fake)).toEqual([]);
      expect(stagingKeys(fake)).toEqual([]);
      expect(fake.object(blobKey(stage.meta.hash))).toBeUndefined();
    } finally {
      stage.release();
    }
  });

  it("stages a multi-chunk stream with authoritative meta, then reads after promote", async () => {
    const { fake, store } = openStore("cases/prod");
    const chunks = [
      new TextEncoder().encode("alpha|"),
      new TextEncoder().encode("bravo|"),
      new TextEncoder().encode("charlie"),
    ];
    const bytes = concatBytes(chunks);
    const stage = await store.stageStream(asAsyncChunks(chunks), {
      maxBytes: bytes.byteLength,
      expectedLength: bytes.byteLength,
      contentType: "text/plain",
    });
    expect(stage.meta.hash).toBe(sha256Hex(bytes));
    expect(stage.meta.byteLength).toBe(bytes.byteLength);
    expect(stage.meta.contentType).toBe("text/plain");
    expect(Object.isFrozen(stage.meta)).toBe(true);
    expect(await store.head(stage.meta.hash)).toBeNull();
    const scratch = assertStreamedScratchPut(fake);
    expect(scratch.ContentLength).toBe(bytes.byteLength);
    expect(String(scratch.Key)).toMatch(/^cases\/prod\/\.stream-staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    expect(String(scratch.Key)).not.toContain("/.staging/");
    expect(streamStagingKeys(fake, "cases/prod")).toHaveLength(1);
    expect(batchStagingKeys(fake, "cases/prod")).toEqual([]);
    expect(stagingKeys(fake, "cases/prod")).toHaveLength(1);

    await stage.promote();
    expect(await store.head(stage.meta.hash)).toEqual(stage.meta);
    assertReplaceCopy(fake, blobKey(stage.meta.hash, "cases/prod"), stage.meta);
    const handle = await store.openRead(stage.meta.hash);
    expect(handle.range).toBeNull();
    expect(handle.byteLength).toBe(bytes.byteLength);
    expect(handle.meta).toEqual(stage.meta);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.meta)).toBe(true);
    expect(handle).not.toHaveProperty("etag");
    expect(handle).not.toHaveProperty("ETag");
    expect(JSON.stringify(handle)).not.toMatch(/etag/i);
    expect(Buffer.from(await collectChunks(handle.bytes())).equals(Buffer.from(bytes))).toBe(true);

    await stage.finalize();
    expect(stagingKeys(fake, "cases/prod")).toEqual([]);
    expect(pendingKeys(fake, "cases/prod")).toEqual([]);
    expect(await store.verify(stage.meta.hash)).toBe(true);
    assertNoAclOrChecksums(fake);
  });

  it("accepts a zero-byte stream and rejects a range on it", async () => {
    const { fake, store } = openStore();
    async function* empty(): AsyncIterable<Uint8Array> {
      // no chunks
    }
    const stage = await store.stageStream(empty(), { maxBytes: 0 });
    expect(stage.meta.hash).toBe(sha256Hex(new Uint8Array()));
    expect(stage.meta.byteLength).toBe(0);
    expect(stage.meta.contentType).toBeNull();
    await stage.promote();
    const handle = await store.openRead(stage.meta.hash);
    expect(handle.range).toBeNull();
    expect(handle.byteLength).toBe(0);
    expect(await collectChunks(handle.bytes())).toEqual(new Uint8Array());
    await expect(store.openRead(stage.meta.hash, { start: 0, end: 0 })).rejects.toThrow(
      /out of bounds/,
    );
    await stage.finalize();
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("rejects abort before and while awaiting the next source chunk and cleans scratch", async () => {
    const { fake, store } = openStore();
    const before = new AbortController();
    before.abort(new Error("already-aborted"));
    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
        maxBytes: 8,
        signal: before.signal,
      }),
    ).rejects.toThrow(/already-aborted/);
    expect(stagingKeys(fake)).toEqual([]);

    const pending = new AbortController();
    let enterWait!: () => void;
    const enteredWait = new Promise<void>((resolve) => {
      enterWait = resolve;
    });
    async function* hanging(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([9, 9, 9]);
      enterWait();
      await new Promise<never>(() => {
        // pending until abort
      });
    }
    const staging = store.stageStream(hanging(), { maxBytes: 64, signal: pending.signal });
    await enteredWait;
    pending.abort(new Error("pending-abort"));
    await expect(
      Promise.race([
        staging,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("abort did not reject promptly")), 100);
        }),
      ]),
    ).rejects.toThrow(/pending-abort/);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("rejects oversize, expectedLength mismatch, non-Uint8Array chunks, and invalid options", async () => {
    const { fake, store } = openStore();
    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array(8)]), { maxBytes: 4 }),
    ).rejects.toThrow(/maxBytes/);
    expect(stagingKeys(fake)).toEqual([]);

    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array(3)]), { maxBytes: 16, expectedLength: 5 }),
    ).rejects.toThrow(/expectedLength/);
    expect(stagingKeys(fake)).toEqual([]);

    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array(3)]), { maxBytes: 2, expectedLength: 3 }),
    ).rejects.toThrow(/expectedLength.*maxBytes/);
    expect(stagingKeys(fake)).toEqual([]);

    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array(0)]), { maxBytes: 0 }),
    ).rejects.toThrow(/must not be empty/);
    expect(stagingKeys(fake)).toEqual([]);

    async function* badChunk(): AsyncIterable<Uint8Array> {
      yield "not-bytes" as unknown as Uint8Array;
    }
    await expect(store.stageStream(badChunk(), { maxBytes: 16 })).rejects.toThrow(/Uint8Array/);
    expect(stagingKeys(fake)).toEqual([]);

    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array([1])]), { maxBytes: -1 }),
    ).rejects.toThrow(/maxBytes/);
    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array([1])]), { maxBytes: 1.5 }),
    ).rejects.toThrow(/maxBytes/);
    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
        maxBytes: 8,
        contentType: 123 as unknown as string,
      }),
    ).rejects.toThrow(/contentType/);
    await expect(
      store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
        maxBytes: 8,
        contentType: "text/plain\u0000",
      }),
    ).rejects.toThrow(/invalid metadata/);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("does not hold the write lease during intake and retains it through settlement", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }),
    );
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let sawMidStream!: () => void;
    const midStream = new Promise<void>((resolve) => {
      sawMidStream = resolve;
    });
    async function* delayedSource(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("lease-one|");
      sawMidStream();
      await gate;
      yield new TextEncoder().encode("lease-two");
    }
    const staging = store.stageStream(delayedSource(), {
      maxBytes: 64,
      contentType: "application/octet-stream",
    });
    await midStream;
    expect(lease.acquires()).toBe(0);
    expect(lease.active()).toBe(0);
    releaseGate();
    const stage = await staging;
    expect(lease.acquires()).toBe(0);
    expect(lease.active()).toBe(0);

    await stage.promote();
    expect(lease.acquires()).toBe(1);
    expect(lease.active()).toBe(1);
    await stage.promote();
    expect(lease.acquires()).toBe(1);
    await stage.finalize();
    expect(lease.active()).toBe(0);
    expect(lease.releases()).toBe(1);
    await stage.finalize();
    expect(lease.acquires()).toBe(1);
    await expect(stage.promote()).rejects.toThrow(/already settled/);
  });

  it("lets two outstanding stream stages complete while a third digest put finishes first", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }),
    );
    const bytesA = new TextEncoder().encode("outstanding-stream-a\n");
    const bytesB = new TextEncoder().encode("outstanding-stream-b\n");
    const bytesC = new TextEncoder().encode("third-digest-put\n");
    const [stageA, stageB] = await Promise.all([
      store.stageStream(asAsyncChunks([bytesA]), { maxBytes: bytesA.byteLength }),
      store.stageStream(asAsyncChunks([bytesB]), { maxBytes: bytesB.byteLength }),
    ]);
    expect(stageA.meta.hash).not.toBe(stageB.meta.hash);
    expect(lease.active()).toBe(0);
    expect(await store.head(stageA.meta.hash)).toBeNull();
    expect(await store.head(stageB.meta.hash)).toBeNull();
    const putMeta = await store.put(bytesC);
    expect(putMeta.hash).toBe(sha256Hex(bytesC));
    expect(await store.verify(putMeta.hash)).toBe(true);
    expect(lease.active()).toBe(0);
    await stageA.promote();
    expect(lease.active()).toBe(1);
    expect(await store.verify(stageA.meta.hash)).toBe(true);
    await stageA.finalize();
    expect(lease.active()).toBe(0);
    await stageB.promote();
    expect(lease.active()).toBe(1);
    expect(await store.verify(stageB.meta.hash)).toBe(true);
    await stageB.finalize();
    expect(lease.active()).toBe(0);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("retries idempotent settlement and rejects conflicting modes and finalize options", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("settlement-mode");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
    const rollback = stage.rollback();
    await expect(stage.finalize()).rejects.toThrow(/settling via rollback/);
    await rollback;
    await stage.rollback();
    expect(stagingKeys(fake)).toEqual([]);
    await expect(stage.promote()).rejects.toThrow(/already settled/);

    const other = await store.stageStream(asAsyncChunks([new TextEncoder().encode("opts\n")]), {
      maxBytes: 16,
    });
    await other.promote();
    const retaining = other.finalize({ retainPendingJournal: true });
    await expect(other.finalize()).rejects.toThrow(/options conflict/);
    await retaining;
    await other.finalize({ retainPendingJournal: true });
    await expect(other.finalize()).rejects.toThrow(/options conflict/);
    expect(pendingKeys(fake)).toHaveLength(1);
  });

  it("serializes rollback behind an in-flight promotion and makes promotion reject", async () => {
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let acquisitionStarted!: () => void;
    const acquisitionStart = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    let releases = 0;
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, {
        acquireWriteLease: async () => {
          acquisitionStarted();
          await acquireGate;
          return () => {
            releases += 1;
          };
        },
      }),
    );
    const bytes = new TextEncoder().encode("promote-rollback-overlap\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
    const promoting = stage.promote();
    await acquisitionStart;
    const rollingBack = stage.rollback();
    releaseAcquire();
    await expect(promoting).rejects.toThrow(/rollback.*in flight/);
    await rollingBack;
    expect(await store.head(stage.meta.hash)).toBeNull();
    expect(stagingKeys(fake)).toEqual([]);
    expect(pendingKeys(fake)).toEqual([]);
    expect(releases).toBe(1);
    await stage.rollback();
    await expect(stage.promote()).rejects.toThrow(/already settled/);
  });

  it("lets a preexisting duplicate survive streamed promote+rollback and fails a corrupt duplicate", async () => {
    const lease = leaseTracker();
    const { fake, store } = openStore(undefined, { acquireWriteLease: lease.acquireWriteLease });
    const bytes = new TextEncoder().encode("shared-stream-duplicate\n");
    const first = await store.put(bytes, { contentType: "text/plain" });
    expect(lease.active()).toBe(0);
    const stage = await store.stageStream(asAsyncChunks([bytes]), {
      maxBytes: bytes.byteLength,
      contentType: "text/x-log",
    });
    expect(stage.meta.hash).toBe(first.hash);
    await stage.promote();
    expect(await store.verify(first.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
    expect(lease.active()).toBe(1);
    await stage.rollback();
    expect(await store.verify(first.hash)).toBe(true);
    expect(stagingKeys(fake)).toEqual([]);
    expect(lease.active()).toBe(0);

    const mutated = new TextEncoder().encode("shared-stream-MUTATED!!\n");
    expect(mutated.byteLength).toBe(bytes.byteLength);
    const stored = fake.object(blobKey(first.hash));
    if (!stored) throw new Error("missing duplicate");
    stored.body = mutated;
    const corruptStage = await store.stageStream(asAsyncChunks([bytes]), {
      maxBytes: bytes.byteLength,
    });
    await expect(corruptStage.promote()).rejects.toThrow(/verification|corrupt|changed|mismatch/i);
    expect(Buffer.from(fake.object(blobKey(first.hash))?.body ?? []).equals(Buffer.from(mutated))).toBe(
      true,
    );
    await corruptStage.rollback();
    expect(Buffer.from(fake.object(blobKey(first.hash))?.body ?? []).equals(Buffer.from(mutated))).toBe(
      true,
    );
  });

  it("excludes a live stream stage from same-process recovery", async () => {
    const { fake, store } = openStore();
    fake.putRaw(".staging/stale-scratch", new Uint8Array([1]));
    fake.putRaw(".stream-staging/abandoned/stale", new Uint8Array([9]));
    let continueSource!: () => void;
    let sourceWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      sourceWaiting = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueSource = resolve;
    });
    async function* liveSource(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([2]);
      sourceWaiting();
      await gate;
      yield new Uint8Array([3]);
    }
    const staging = store.stageStream(liveSource(), { maxBytes: 2 });
    await waiting;
    await waitForCall(fake, "PutObjectCommand");
    continueSource();
    const stage = await staging;
    const liveKeys = streamStagingKeys(fake).filter((key) => key !== ".stream-staging/abandoned/stale");
    expect(liveKeys).toHaveLength(1);
    expect(String(liveKeys[0])).toMatch(/^\.stream-staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered).toEqual({ reclaimed: [], journals: 0 });
    expect(fake.object(".staging/stale-scratch")).toBeUndefined();
    expect(fake.object(".stream-staging/abandoned/stale")).toBeUndefined();
    expect(streamStagingKeys(fake)).toEqual(liveKeys);
    expect(fake.object(liveKeys[0] ?? "")).toBeDefined();
    await stage.rollback();
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("cleans scratch for hostile iterator construction, next, and return failures", async () => {
    const { fake, store } = openStore();
    const constructionFailure: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        throw new Error("iterator-construction-failed");
      },
    };
    await expect(
      store.stageStream(constructionFailure, { maxBytes: 8 }),
    ).rejects.toThrow(/iterator-construction-failed/);
    expect(stagingKeys(fake)).toEqual([]);

    const nextFailure: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => {
            throw new Error("iterator-next-failed");
          },
        };
      },
    };
    await expect(store.stageStream(nextFailure, { maxBytes: 8 })).rejects.toThrow(
      /iterator-next-failed/,
    );
    expect(stagingKeys(fake)).toEqual([]);

    let enteredWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      enteredWait = resolve;
    });
    const hostileReturn: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        let yielded = false;
        return {
          next: async () => {
            if (!yielded) {
              yielded = true;
              return { done: false, value: new Uint8Array([1]) };
            }
            enteredWait();
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: () => {
            throw new Error("hostile-return");
          },
        };
      },
    };
    const controller = new AbortController();
    const staging = store.stageStream(hostileReturn, {
      maxBytes: 8,
      signal: controller.signal,
    });
    await waiting;
    controller.abort(new Error("abort-hostile-source"));
    await expect(staging).rejects.toThrow(/abort-hostile-source/);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("treats applied-then-thrown stream CopyObject as applied and retains an unknown journal", async () => {
    const applied = openStore();
    const appliedBytes = new TextEncoder().encode("stream-applied-then-thrown\n");
    const appliedStage = await applied.store.stageStream(asAsyncChunks([appliedBytes]), {
      maxBytes: appliedBytes.byteLength,
    });
    applied.fake.throwAfterApplyKeys.add(blobKey(appliedStage.meta.hash));
    await appliedStage.promote();
    await appliedStage.promote();
    expect(applied.fake.throwAfterApplyHits).toBe(1);
    assertReplaceCopy(applied.fake, blobKey(appliedStage.meta.hash), appliedStage.meta);
    expect(await applied.store.verify(appliedStage.meta.hash)).toBe(true);
    expect(pendingKeys(applied.fake)).toHaveLength(1);
    await appliedStage.finalize();
    expect(pendingKeys(applied.fake)).toEqual([]);
    expect(await applied.store.verify(appliedStage.meta.hash)).toBe(true);

    const unknown = openStore();
    const unknownBytes = new TextEncoder().encode("stream-copy-unknown-probe\n");
    const unknownStage = await unknown.store.stageStream(asAsyncChunks([unknownBytes]), {
      maxBytes: unknownBytes.byteLength,
    });
    const canonical = blobKey(unknownStage.meta.hash);
    unknown.fake.throwAfterApplyKeys.add(canonical);
    unknown.fake.headErrors.set(
      canonical,
      new FakeS3Error(
        "SlowDown",
        503,
        `probe failed at ${SYNTHETIC_ENDPOINT} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET}`,
      ),
    );
    try {
      await unknownStage.promote();
      throw new Error("expected unknown copy outcome");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("promote");
      assertSanitized(error, [unknownStage.meta.hash, canonical]);
    }
    expect(unknown.fake.throwAfterApplyHits).toBe(1);
    expect(pendingKeys(unknown.fake)).toHaveLength(1);
    expect(unknown.fake.object(canonical)).toBeDefined();
    await unknownStage.rollback();
    await unknownStage.rollback();
    expect(pendingKeys(unknown.fake)).toHaveLength(1);
    expect(unknown.fake.object(canonical)).toBeDefined();
  });

  it("retries partial stream cleanup and does not let stale rollback delete adopted bytes", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }),
    );
    const bytes = new TextEncoder().encode("retry-stream-cleanup\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
    await stage.promote();
    const journalKey = pendingKeys(fake)[0] ?? "";
    fake.deleteErrors.set(
      journalKey,
      new FakeS3Error("InternalError", 500, `delete journal at ${SYNTHETIC_ENDPOINT}`),
    );
    await expect(stage.rollback()).rejects.toBeInstanceOf(S3EvidenceError);
    expect(lease.active()).toBe(1);
    expect(pendingKeys(fake)).toEqual([journalKey]);
    fake.deleteErrors.clear();
    await stage.rollback();
    expect(lease.active()).toBe(0);
    expect(await store.head(stage.meta.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);

    const kept = await store.put(new TextEncoder().encode("adopted-survivor\n"));
    const duplicate = await store.stageStream(asAsyncChunks([new TextEncoder().encode("adopted-survivor\n")]), {
      maxBytes: 32,
    });
    await duplicate.promote();
    await duplicate.rollback();
    expect(await store.verify(kept.hash)).toBe(true);
  });

  it("rejects finalize during promotion without poisoning later finalize", async () => {
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let acquisitionStarted!: () => void;
    const acquisitionStart = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    let releases = 0;
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore(
      garageOptions(fake, {
        acquireWriteLease: async () => {
          acquisitionStarted();
          await acquireGate;
          return () => {
            releases += 1;
          };
        },
      }),
    );
    const bytes = new TextEncoder().encode("stream-promote-finalize-overlap\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), {
      maxBytes: bytes.byteLength,
    });
    const promoting = stage.promote();
    await acquisitionStart;
    await expect(stage.finalize()).rejects.toThrow(/must complete before finalize/);
    releaseAcquire();
    await promoting;
    await stage.finalize();
    expect(await store.verify(stage.meta.hash)).toBe(true);
    expect(stagingKeys(fake)).toEqual([]);
    expect(pendingKeys(fake)).toEqual([]);
    expect(releases).toBe(1);
  });

  it("recovers a retained stream journal by the explicit and registered reference union", async () => {
    const { fake, store } = openStore();
    const reclaimBytes = new TextEncoder().encode("stream-retained-reclaim\n");
    const reclaim = await store.stageStream(asAsyncChunks([reclaimBytes]), {
      maxBytes: reclaimBytes.byteLength,
    });
    await reclaim.promote();
    await reclaim.finalize({ retainPendingJournal: true });
    expect(pendingKeys(fake)).toHaveLength(1);
    const reclaimed = await store.recoverUnreferencedWrites(new Set());
    expect(reclaimed).toEqual({ reclaimed: [reclaim.meta.hash], journals: 1 });
    expect(await store.head(reclaim.meta.hash)).toBeNull();

    const keepBytes = new TextEncoder().encode("stream-retained-reference\n");
    const keep = await store.stageStream(asAsyncChunks([keepBytes]), {
      maxBytes: keepBytes.byteLength,
    });
    await keep.promote();
    await keep.finalize({ retainPendingJournal: true });
    store.addReferencedContentHashSource(async () => new Set([keep.meta.hash]));
    const kept = await store.recoverUnreferencedWrites(new Set());
    expect(kept).toEqual({ reclaimed: [], journals: 1 });
    expect(await store.verify(keep.meta.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("openRead returns exact full and inclusive first/middle/tail ranges via native Range+IfMatch", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("0123456789");
    const stage = await store.stageStream(asAsyncChunks([bytes]), {
      maxBytes: bytes.byteLength,
      contentType: "text/plain",
    });
    await stage.promote();
    const full = await store.openRead(stage.meta.hash);
    expect(full.byteLength).toBe(10);
    expect(Buffer.from(await collectChunks(full.bytes())).equals(Buffer.from(bytes))).toBe(true);

    fake.calls.length = 0;
    const first = await store.openRead(stage.meta.hash, { start: 0, end: 2 });
    expect(first.range).toEqual({ start: 0, end: 2 });
    expect(Object.isFrozen(first.range)).toBe(true);
    expect(first.byteLength).toBe(3);
    expect(Buffer.from(await collectChunks(first.bytes())).toString()).toBe("012");
    const rangedGets = fake.calls.filter(
      (call) => call.name === "GetObjectCommand" && typeof call.input.Range === "string",
    );
    expect(rangedGets.length).toBeGreaterThan(0);
    expect(rangedGets.every((call) => typeof call.input.IfMatch === "string")).toBe(true);
    expect(rangedGets.every((call) => call.input.Range === "bytes=0-2")).toBe(true);
    expect(rangedGets.every((call) => call.input.IfMatch !== stage.meta.hash)).toBe(true);

    const middle = await store.openRead(stage.meta.hash, { start: 3, end: 6 });
    expect(Buffer.from(await collectChunks(middle.bytes())).toString()).toBe("3456");
    const tail = await store.openRead(stage.meta.hash, { start: 7, end: 9 });
    expect(Buffer.from(await collectChunks(tail.bytes())).toString()).toBe("789");
    await stage.finalize();
  });

  it("aborts the verification preflight, closes its body, and never starts the response GET", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("abort-during-canonical-preflight");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing canonical object");
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const iteratorReturns = { value: 0 };
    const bodyDestroys = { value: 0 };
    stored.chunkProducers = [() => {
      enteredResolve?.();
      return new Promise<Uint8Array>(() => undefined);
    }];
    stored.iteratorReturns = iteratorReturns;
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = bodyDestroys;
    fake.calls.length = 0;
    const controller = new AbortController();

    const opening = store.openRead(meta.hash, undefined, controller.signal);
    await entered;
    controller.abort(new Error("synthetic transfer disconnected"));

    await expect(opening).rejects.toThrow(/synthetic transfer disconnected/);
    const gets = fake.calls.filter((call) => call.name === "GetObjectCommand");
    expect(gets).toHaveLength(1);
    expect(gets[0]?.abortSignal).toBe(controller.signal);
    expect(iteratorReturns.value).toBeGreaterThan(0);
    expect(bodyDestroys.value).toBeGreaterThan(0);
  });

  it("refuses an already-aborted read before S3 work and signals both successful GETs", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("abort-signal-forwarding");
    const meta = await store.put(bytes);

    fake.calls.length = 0;
    const already = new AbortController();
    already.abort(new Error("already disconnected"));
    await expect(store.head(meta.hash, already.signal)).rejects.toThrow(/already disconnected/);
    await expect(store.openRead(meta.hash, undefined, already.signal)).rejects.toThrow(
      /already disconnected/,
    );
    expect(fake.calls).toEqual([]);

    const active = new AbortController();
    expect(await store.head(meta.hash, active.signal)).toEqual(meta);
    const handle = await store.openRead(meta.hash, { start: 0, end: 4 }, active.signal);
    expect(Buffer.from(await collectChunks(handle.bytes())).toString()).toBe("abort");
    const gets = fake.calls.filter((call) => call.name === "GetObjectCommand");
    expect(gets).toHaveLength(2);
    expect(gets.every((call) => call.abortSignal === active.signal)).toBe(true);
    const heads = fake.calls.filter((call) => call.name === "HeadObjectCommand");
    expect(heads.every((call) => call.abortSignal === active.signal)).toBe(true);
  });

  it("reads correctly when metadata replacement preserves the source ETag", async () => {
    const { fake, store } = openStore();
    fake.preserveEtagOnCopy = true;
    const bytes = new TextEncoder().encode("stable-etag-metadata-replace\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), {
      maxBytes: bytes.byteLength,
      contentType: "text/plain",
    });
    const scratchKey = stagingKeys(fake)[0] ?? "";
    const scratchEtag = fake.object(scratchKey)?.etag;
    await stage.promote();
    const canonical = fake.object(blobKey(stage.meta.hash));
    expect(canonical?.etag).toBe(scratchEtag);
    expect(canonical?.contentType).toBe("text/plain");
    expect(canonical?.metadata).toMatchObject({
      sha256: stage.meta.hash,
      bytelength: String(stage.meta.byteLength),
      contenttype: "text/plain",
    });
    const handle = await store.openRead(stage.meta.hash, { start: 0, end: 5 });
    expect(Buffer.from(await collectChunks(handle.bytes())).toString()).toBe("stable");
    await stage.finalize();
  });

  it("rejects invalid hashes and unsatisfiable ranges", async () => {
    const { store } = openStore();
    const bytes = new TextEncoder().encode("range-rejection-fixture");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
    await stage.promote();
    await expect(store.openRead("not-a-content-hash" as never)).rejects.toThrow(/invalid content hash/);
    await expect(store.openRead(stage.meta.hash, { start: -1, end: 1 })).rejects.toThrow(/range\.start/);
    await expect(store.openRead(stage.meta.hash, { start: 1.5, end: 2 })).rejects.toThrow(/range\.start/);
    await expect(
      store.openRead(stage.meta.hash, { start: 0, end: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow(/range\.end/);
    await expect(store.openRead(stage.meta.hash, { start: 2, end: 1 })).rejects.toThrow(
      /range\.end must be greater than or equal to range\.start/,
    );
    await expect(
      store.openRead(stage.meta.hash, { start: 0, end: bytes.byteLength }),
    ).rejects.toThrow(/out of bounds/);
    await expect(
      store.openRead(stage.meta.hash, { start: bytes.byteLength, end: bytes.byteLength }),
    ).rejects.toThrow(/out of bounds/);
    await stage.finalize();
  });

  it("fails closed on corrupt digest, truncated/oversized/malformed responses, and post-handle mutation", async () => {
    const { fake, store } = openStore();
    const small = new TextEncoder().encode("pre-open-corruption-bytes");
    const smallStage = await store.stageStream(asAsyncChunks([small]), { maxBytes: small.byteLength });
    await smallStage.promote();
    const smallStored = fake.object(blobKey(smallStage.meta.hash));
    if (!smallStored) throw new Error("missing small");
    smallStored.body = Uint8Array.from(small, (value) => value ^ 0xff);
    await expect(store.openRead(smallStage.meta.hash)).rejects.toThrow(
      /verification|corrupt|changed|mismatch|inconsistent/i,
    );
    await smallStage.finalize();

    const afterCreate = new TextEncoder().encode("after-handle-mutation!!!!");
    const afterStage = await store.stageStream(asAsyncChunks([afterCreate]), {
      maxBytes: afterCreate.byteLength,
    });
    await afterStage.promote();
    const afterHandle = await store.openRead(afterStage.meta.hash);
    const afterStored = fake.object(blobKey(afterStage.meta.hash));
    if (!afterStored) throw new Error("missing after");
    afterStored.body = new TextEncoder().encode("after-handle-MUTATED!!!!!");
    afterStored.etag = fake.allocateEtag();
    await expect(collectChunks(afterHandle.bytes())).rejects.toThrow(/changed|verification|mismatch/i);
    await afterStage.finalize();

    const rangedBytes = new TextEncoder().encode("0123456789abcdef");
    const rangedStage = await store.stageStream(asAsyncChunks([rangedBytes]), {
      maxBytes: rangedBytes.byteLength,
    });
    await rangedStage.promote();
    const key = blobKey(rangedStage.meta.hash);
    const rangedStored = fake.object(key);
    if (!rangedStored) throw new Error("missing ranged");
    const resetRanged = (): void => {
      rangedStored.reportedLength = undefined;
      rangedStored.reportedContentRange = undefined;
      rangedStored.chunks = undefined;
    };
    const rangedHandle = await store.openRead(rangedStage.meta.hash, { start: 2, end: 5 });
    rangedStored.reportedLength = 1;
    await expect(collectChunks(rangedHandle.bytes())).rejects.toThrow(/inconsistent|changed|truncated/i);

    resetRanged();
    const malformedHandle = await store.openRead(rangedStage.meta.hash, { start: 2, end: 5 });
    rangedStored.reportedContentRange = "not-a-content-range";
    await expect(collectChunks(malformedHandle.bytes())).rejects.toThrow(/inconsistent/i);

    resetRanged();
    const truncatedHandle = await store.openRead(rangedStage.meta.hash, { start: 2, end: 5 });
    rangedStored.chunks = [rangedBytes.slice(2, 4)];
    await expect(collectChunks(truncatedHandle.bytes())).rejects.toThrow(/inconsistent/i);

    resetRanged();
    const oversizedHandle = await store.openRead(rangedStage.meta.hash, { start: 2, end: 5 });
    rangedStored.chunks = [rangedBytes.slice(2, 8)];
    await expect(collectChunks(oversizedHandle.bytes())).rejects.toThrow(/inconsistent/i);
    await rangedStage.finalize();

    const transform = await store.put(new TextEncoder().encode("transform-only-open\n"));
    const transformStored = fake.object(blobKey(transform.hash));
    if (!transformStored) throw new Error("missing transform");
    transformStored.transformOnly = true;
    await expect(store.openRead(transform.hash)).rejects.toThrow(/unavailable|inconsistent/i);
  });

  it("delegates batch openRead to the owner after promote", async () => {
    const { store } = openStore();
    const bytes = new TextEncoder().encode("batch-open-read\n");
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(bytes, { contentType: "text/plain" });
    await batch.promote();
    const handle = await batch.openRead(meta.hash);
    expect(handle.meta.hash).toBe(meta.hash);
    expect(Buffer.from(await collectChunks(handle.bytes())).equals(Buffer.from(bytes))).toBe(true);
    const ranged = await batch.openRead(meta.hash, { start: 0, end: 4 });
    expect(Buffer.from(await collectChunks(ranged.bytes())).toString()).toBe("batch");
    await batch.finalize();
  });

  it("omits ContentLength on streamed put unless expectedLength is authoritative", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("no-content-length\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: 64 });
    const scratch = assertStreamedScratchPut(fake);
    expect(scratch.ContentLength).toBeUndefined();
    await stage.rollback();
  });

  it("verifies existing canonical bytes with Head then IfMatch Get, incrementally, and without transformToByteArray", async () => {
    const bytes = new TextEncoder().encode("canonical-chunked-body!!\n");
    const hash = sha256Hex(bytes);
    const first = bytes.slice(0, 8);
    const second = bytes.slice(8);
    const paths: Array<{ name: string; run: (store: S3EvidenceStore) => Promise<void> }> = [
      { name: "put", run: async (store) => { await store.put(bytes); } },
      {
        name: "stage",
        run: async (store) => {
          const stage = await store.stage(bytes);
          stage.release();
        },
      },
      {
        name: "stageStream",
        run: async (store) => {
          const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
          await stage.promote();
          await stage.finalize();
        },
      },
      {
        name: "batch",
        run: async (store) => {
          const batch = await store.beginWriteBatch();
          await batch.put(bytes);
          await batch.promote();
          await batch.finalize();
        },
      },
    ];
    for (const path of paths) {
      const { fake, store } = openStore();
      const yieldCount = { value: 0 };
      fake.putRaw(
        blobKey(hash),
        bytes,
        canonicalUserMetadata(hash, bytes.byteLength),
        undefined,
        { chunks: [first, second], yieldCount },
      );
      fake.transformToByteArrayCalls = 0;
      fake.calls.length = 0;
      await path.run(store);
      expect(yieldCount.value, path.name).toBe(2);
      expect(fake.transformToByteArrayCalls, path.name).toBe(0);
      assertCanonicalHeadThenConditionalGet(fake.calls, blobKey(hash), fake.object(blobKey(hash))?.etag);
      const ranged = fake.calls.some(
        (call) => call.name === "GetObjectCommand" && call.input.Key === blobKey(hash) && typeof call.input.Range === "string",
      );
      expect(ranged, path.name).toBe(false);
    }
  });

  it("rejects transform-only canonical bodies on every read path", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("transform-only-canonical\n");
    const hash = sha256Hex(bytes);
    fake.putRaw(
      blobKey(hash),
      bytes,
      canonicalUserMetadata(hash, bytes.byteLength),
      undefined,
      { transformOnly: true },
    );
    fake.transformToByteArrayCalls = 0;
    try {
      await store.put(bytes);
      throw new Error("expected transform-only put failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("put");
      expect((error as S3EvidenceError).message).toMatch(/unavailable/);
      assertSanitized(error);
    }
    expect(fake.transformToByteArrayCalls).toBe(0);
    await expect(store.get(hash)).rejects.toMatchObject({
      operation: "get",
      message: "s3 evidence get failed: unavailable",
    });
    expect(fake.transformToByteArrayCalls).toBe(0);
  });

  it("fails closed on hostile truncated oversized dishonest ContentRange and mutation without draining later chunks", async () => {
    const bytes = new TextEncoder().encode("canonical-hostile-source\n");
    const hash = sha256Hex(bytes);
    const key = blobKey(hash);
    const metadata = canonicalUserMetadata(hash, bytes.byteLength);

    const truncated = openStore();
    const truncatedYield = { value: 0 };
    truncated.fake.putRaw(key, bytes, metadata, undefined, {
      chunks: [bytes.slice(0, 6)],
      reportedGetLength: bytes.byteLength,
      yieldCount: truncatedYield,
    });
    try {
      await truncated.store.put(bytes);
      throw new Error("expected truncated put failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("put");
      expect((error as S3EvidenceError).message).toMatch(/inconsistent object/);
      assertSanitized(error);
    }
    expect(truncatedYield.value).toBe(1);

    const oversized = openStore();
    const produced: number[] = [];
    const sequentialNext = { pending: false, concurrent: 0 };
    const oversizedYield = { value: 0 };
    oversized.fake.putRaw(key, bytes, metadata, bytes.byteLength, {
      reportedGetLength: bytes.byteLength,
      sequentialNext,
      yieldCount: oversizedYield,
      chunkProducers: [
        () => {
          produced.push(0);
          return bytes.slice(0, 4);
        },
        () => {
          produced.push(1);
          return new Uint8Array(bytes.byteLength);
        },
        () => {
          produced.push(2);
          return new Uint8Array(256).fill(9);
        },
      ],
    });
    await expect(oversized.store.put(bytes)).rejects.toThrow(/inconsistent object/);
    expect(produced).toEqual([0, 1]);
    expect(oversizedYield.value).toBe(2);
    expect(sequentialNext.concurrent).toBe(0);
    expect(oversized.fake.transformToByteArrayCalls).toBe(0);

    const dishonest = openStore();
    const dishonestYield = { value: 0 };
    dishonest.fake.putRaw(key, bytes, metadata, undefined, {
      chunks: [bytes],
      reportedGetLength: bytes.byteLength + 1,
      yieldCount: dishonestYield,
    });
    await expect(dishonest.store.put(bytes)).rejects.toThrow(/inconsistent object/);
    expect(dishonestYield.value).toBe(0);

    const ranged = openStore();
    const rangeYield = { value: 0 };
    ranged.fake.putRaw(key, bytes, metadata, undefined, {
      chunks: [bytes],
      reportedContentRange: `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      yieldCount: rangeYield,
    });
    await expect(ranged.store.put(bytes)).rejects.toThrow(/inconsistent object/);
    expect(rangeYield.value).toBe(0);

    const mutated = openStore();
    mutated.fake.putRaw(key, bytes, metadata);
    mutated.fake.getErrors.set(
      key,
      new FakeS3Error(
        "PreconditionFailed",
        412,
        `PreconditionFailed at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=${key} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
      ),
    );
    try {
      await mutated.store.put(bytes);
      throw new Error("expected object-changed put failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("put");
      expect((error as S3EvidenceError).message).toMatch(/object changed/);
      assertSanitized(error);
    }
    expect(await mutated.store.inspectCanonical(hash, bytes.byteLength)).toBe("unknown");

    const etagSwap = openStore();
    etagSwap.fake.putRaw(key, bytes, metadata, undefined, { reportedGetEtag: `"mutated-etag"` });
    try {
      await etagSwap.store.put(bytes);
      throw new Error("expected etag mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("put");
      expect((error as S3EvidenceError).message).toMatch(/object changed/);
      assertSanitized(error);
    }

    const mid = openStore();
    const midYield = { value: 0 };
    mid.fake.putRaw(key, bytes, metadata, undefined, {
      chunks: [bytes.slice(0, 8), bytes.slice(8)],
      failAfterYields: 1,
      failYieldError: new Error("iterator-failed-mid-body"),
      yieldCount: midYield,
    });
    try {
      await mid.store.put(bytes);
      throw new Error("expected mid-iteration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("put");
      expect((error as S3EvidenceError).message).toMatch(/unavailable/);
      assertSanitized(error, ["iterator-failed-mid-body"]);
    }
    expect(midYield.value).toBe(1);
  });

  it("keeps a 200 corrupt copy unknown, retains the journal, and distinguishes operational verify failures", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("corrupt-copy-unknown-verify\n");
    const stage = await store.stage(bytes);
    const dest = blobKey(stage.meta.hash);
    fake.corruptCopy.set(dest, { body: new Uint8Array(bytes.byteLength).fill(0x41) });
    try {
      await expect(stage.commit()).rejects.toBeInstanceOf(S3EvidenceError);
      assertPostCopyProbe(fake, dest);
      expect(pendingKeys(fake)).toHaveLength(1);
      expect(await store.verify(stage.meta.hash)).toBe(false);
      expect(fake.object(dest)).toBeDefined();
    } finally {
      stage.release();
    }

    const operational = openStore();
    const live = await operational.store.put(new TextEncoder().encode("verify-slowdown\n"));
    operational.fake.getErrors.set(
      blobKey(live.hash),
      new FakeS3Error("SlowDown", 503, `SlowDown at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET}`),
    );
    try {
      await operational.store.verify(live.hash);
      throw new Error("expected operational verify failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("verify");
      expect((error as S3EvidenceError).message).toMatch(/unavailable/);
      assertSanitized(error);
    }

    const batchCase = openStore();
    const batch = await batchCase.store.beginWriteBatch();
    const unpromoted = await batch.put(new TextEncoder().encode("unpromoted-batch-verify\n"));
    expect(await batch.verify(unpromoted.hash)).toBe(true);
    const promotedBytes = new TextEncoder().encode("promoted-batch-verify\n");
    const promoted = await batch.put(promotedBytes);
    await batch.promote();
    const yieldCount = { value: 0 };
    const promotedStored = batchCase.fake.object(blobKey(promoted.hash));
    if (!promotedStored) throw new Error("missing promoted");
    promotedStored.chunks = [promotedBytes.slice(0, 6), promotedBytes.slice(6)];
    promotedStored.yieldCount = yieldCount;
    batchCase.fake.transformToByteArrayCalls = 0;
    expect(await batch.verify(promoted.hash)).toBe(true);
    expect(yieldCount.value).toBe(2);
    expect(batchCase.fake.transformToByteArrayCalls).toBe(0);
    await batch.finalize();
  });

  it("keeps stream scratch under .stream-staging and batch scratch under .staging", async () => {
    const { fake, store } = openStore();
    const streamBytes = new TextEncoder().encode("stream-prefix-key\n");
    const stage = await store.stageStream(asAsyncChunks([streamBytes]), { maxBytes: streamBytes.byteLength });
    const streamKey = String(assertStreamedScratchPut(fake).Key);
    expect(streamKey).toMatch(/^\.stream-staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    expect(streamKey.includes(".staging/")).toBe(false);
    expect(streamStagingKeys(fake)).toEqual([streamKey]);
    expect(batchStagingKeys(fake)).toEqual([]);

    const batch = await store.beginWriteBatch();
    await batch.put(new TextEncoder().encode("batch-prefix-key\n"));
    const batchKey = fake.calls
      .filter((call) => call.name === "PutObjectCommand")
      .map((call) => String(call.input.Key))
      .find((key) => key.startsWith(".staging/"));
    expect(batchKey).toMatch(/^\.staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    expect(String(batchKey).includes(".stream-staging/")).toBe(false);
    expect(batchStagingKeys(fake).some((key) => key.startsWith(".staging/"))).toBe(true);
    await batch.rollback();
    await stage.rollback();
  });

  it("single_process recovery and beginWriteBatch delete abandoned stream residue but keep a live same-process key", async () => {
    const { fake, store } = openStore();
    expect(store.writeCoordination).toBe("single_process");
    fake.putRaw(".stream-staging/abandoned/obj", new Uint8Array([1]));
    const bytes = new TextEncoder().encode("live-stream-same-process\n");
    const stage = await store.stageStream(asAsyncChunks([bytes]), { maxBytes: bytes.byteLength });
    const live = streamStagingKeys(fake).filter((key) => key !== ".stream-staging/abandoned/obj");
    expect(live).toHaveLength(1);
    const recovered = await store.recoverUnreferencedWrites(new Set());
    expect(recovered).toEqual({ reclaimed: [], journals: 0 });
    expect(fake.object(".stream-staging/abandoned/obj")).toBeUndefined();
    expect(streamStagingKeys(fake)).toEqual(live);

    fake.putRaw(".stream-staging/abandoned-later/obj", new Uint8Array([2]));
    const batch = await store.beginWriteBatch();
    expect(fake.object(".stream-staging/abandoned-later/obj")).toBeUndefined();
    expect(streamStagingKeys(fake)).toEqual(live);
    await batch.rollback();
    await stage.rollback();
    expect(streamStagingKeys(fake)).toEqual([]);
  });

  it("external coordination leaves foreign and live stream residue untouched and issues no stream list or delete", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const storeA = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: exclusiveLease() }));
    const storeB = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: exclusiveLease() }));
    expect(storeA.writeCoordination).toBe("external");
    expect(storeB.writeCoordination).toBe("external");
    fake.putRaw(".stream-staging/foreign-live/residue", new Uint8Array([7, 7]));

    let continueSource!: () => void;
    let sourceWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      sourceWaiting = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueSource = resolve;
    });
    async function* liveSource(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([2]);
      sourceWaiting();
      await gate;
      yield new Uint8Array([3]);
    }
    const staging = storeA.stageStream(liveSource(), { maxBytes: 2 });
    await waiting;
    await waitForCall(fake, "PutObjectCommand");
    const inFlightKey = String(
      fake.calls.find((call) => call.name === "PutObjectCommand")?.input.Key ?? "",
    );
    expect(inFlightKey).toMatch(/^\.stream-staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);

    fake.calls.length = 0;
    const recovered = await storeB.recoverUnreferencedWrites(new Set());
    expect(recovered).toEqual({ reclaimed: [], journals: 0 });
    expect(fake.object(".stream-staging/foreign-live/residue")).toBeDefined();
    expect(streamListOrDelete(fake)).toEqual([]);

    continueSource();
    const stage = await staging;
    expect(fake.object(inFlightKey)).toBeDefined();
    fake.calls.length = 0;
    const batch = await storeB.beginWriteBatch();
    expect(fake.object(inFlightKey)).toBeDefined();
    expect(fake.object(".stream-staging/foreign-live/residue")).toBeDefined();
    expect(streamListOrDelete(fake)).toEqual([]);
    expect(streamStagingKeys(fake).sort()).toEqual([inFlightKey, ".stream-staging/foreign-live/residue"].sort());
    await batch.rollback();
    await stage.rollback();
  });
});

describe("S3EvidenceStore response-body idle deadline", () => {
  const IDLE_MS = 80;

  function openIdleStore(idleMs = IDLE_MS): { fake: FakeS3Client; store: S3EvidenceStore } {
    return openStore(undefined, { responseBodyIdleTimeoutMs: idleMs });
  }

  function hangChunk(): Promise<Uint8Array> {
    return new Promise(() => undefined);
  }

  function expectUnavailable(error: unknown, operation: string): void {
    expect(error).toBeInstanceOf(S3EvidenceError);
    expect((error as S3EvidenceError).operation).toBe(operation);
    expect((error as S3EvidenceError).message).toBe(`s3 evidence ${operation} failed: unavailable`);
    assertSanitized(error, ["idle", "timeout", "socketTimeout", String(IDLE_MS)]);
  }

  async function expectPromptUnavailable(
    work: Promise<unknown>,
    operation: string,
  ): Promise<unknown> {
    const started = Date.now();
    let caught: unknown;
    try {
      await Promise.race([
        work,
        delay(IDLE_MS * 3).then(() => {
          throw new Error(`${operation} idle deadline did not fire`);
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) {
      throw new Error(`expected ${operation} to fail closed`);
    }
    if (caught instanceof Error && /did not fire/.test(caught.message)) {
      throw caught;
    }
    expectUnavailable(caught, operation);
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 3);
    return caught;
  }

  it("treats undefined responseBodyIdleTimeoutMs as disabled and rejects invalid values", () => {
    const { fake, store } = openStore();
    expect(store.responseBodyIdleTimeoutMs).toBeUndefined();
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new S3EvidenceStore(garageOptions(fake, {
        responseBodyIdleTimeoutMs: invalid,
      }))).toThrow(/invalid responseBodyIdleTimeoutMs/);
    }
    const armed = new S3EvidenceStore(garageOptions(fake, { responseBodyIdleTimeoutMs: 1 }));
    expect(armed.responseBodyIdleTimeoutMs).toBe(1);
  });

  it("does not count slow GetObject headers toward the body idle deadline", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("slow-headers-still-ok\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.headerDelayMs = IDLE_MS + 40;
    const started = Date.now();
    expect(await store.verify(meta.hash)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS);
  });

  it("fails closed on a stalled first body chunk without aborting the caller signal", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("stall-first-body-chunk\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    const iteratorReturns = { value: 0 };
    const bodyDestroys = { value: 0 };
    stored.chunkProducers = [() => hangChunk()];
    stored.iteratorReturns = iteratorReturns;
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = bodyDestroys;
    const controller = new AbortController();
    const opening = store.openRead(meta.hash, undefined, controller.signal);
    await expectPromptUnavailable(opening, "openRead");
    expect(controller.signal.aborted).toBe(false);
    expect(iteratorReturns.value).toBeGreaterThan(0);
    expect(bodyDestroys.value).toBeGreaterThan(0);
  });

  it("fails closed on a stalled later body chunk", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("stall-later-body-chunk!!");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [
      () => bytes.slice(0, 8),
      () => hangChunk(),
    ];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(store.verify(meta.hash), "verify");
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
  });

  it("allows a progressing body whose total duration exceeds idle while each gap is below it", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("progressing-body-gaps-ok!!");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    const parts = [
      bytes.slice(0, 8),
      bytes.slice(8, 16),
      bytes.slice(16),
    ];
    stored.chunkProducers = parts.map((part) => async () => {
      await delay(35);
      return part;
    });
    const started = Date.now();
    expect(await store.verify(meta.hash)).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(IDLE_MS);
  });

  it("does not treat an empty chunk as progress toward the next idle wait", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("empty-is-not-progress\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [
      async () => {
        await delay(50);
        return new Uint8Array();
      },
      async () => {
        await delay(50);
        return bytes;
      },
    ];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(store.verify(meta.hash), "verify");
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
  });

  it("leaves immediate Uint8Array bodies timer-free even with a 1ms idle deadline", async () => {
    const { fake, store } = openIdleStore(1);
    const bytes = new TextEncoder().encode("immediate-uint8-body\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.immediateUint8Body = true;
    fake.transformToByteArrayCalls = 0;
    expect(await store.verify(meta.hash)).toBe(true);
    const got = await store.get(meta.hash);
    expect(got).not.toBeNull();
    expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(fake.transformToByteArrayCalls).toBe(0);
    const handle = await store.openRead(meta.hash, { start: 0, end: 8 });
    expect(Buffer.from(await collectChunks(handle.bytes())).toString()).toBe("immediate");
  });

  it("preserves the original caller abort reason over idle expiry", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("caller-abort-wins-idle\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [() => hangChunk()];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    const controller = new AbortController();
    const reason = new Error("original-caller-abort");
    const opening = store.openRead(meta.hash, undefined, controller.signal);
    await delay(20);
    controller.abort(reason);
    await expect(opening).rejects.toBe(reason);
    expect(controller.signal.aborted).toBe(true);
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
  });

  it("cleans up a hostile iterator.return on idle without waiting", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("hostile-return-on-idle\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [() => hangChunk()];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    const started = Date.now();
    await expectPromptUnavailable(store.verify(meta.hash), "verify");
    expect(Date.now() - started).toBeLessThan(IDLE_MS * 3);
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
  });

  it("fire-and-forgets a hostile cancel-only body when an idle wait expires", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("hostile-cancel-on-idle\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [() => hangChunk()];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyCancelOnly = true;
    stored.bodyCancels = { value: 0 };
    stored.bodyCancelHangs = true;
    await expectPromptUnavailable(store.verify(meta.hash), "verify");
    expect(stored.bodyCancels.value).toBeGreaterThan(0);
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
  });

  it("does not call a hostile return after done and clears every success timer and listener", async () => {
    const successIdleMs = 12_345;
    const { fake, store } = openIdleStore(successIdleMs);
    const bytes = new TextEncoder().encode("success-cleans-listeners\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.bodyDestroys = { value: 0 };
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const handle = await store.openRead(meta.hash, undefined, controller.signal);
      expect(Buffer.from(await collectChunks(handle.bytes())).equals(Buffer.from(bytes))).toBe(true);
      const idleHandles = setTimeoutSpy.mock.calls.flatMap((call, index) =>
        call[1] === successIdleMs ? [setTimeoutSpy.mock.results[index]?.value] : []
      );
      const clearedHandles = clearTimeoutSpy.mock.calls.map((call) => call[0]);
      const abortAdds = addSpy.mock.calls.filter((call) => call[0] === "abort").length;
      const abortRemoves = removeSpy.mock.calls.filter((call) => call[0] === "abort").length;
      expect(idleHandles.length).toBeGreaterThan(0);
      expect(idleHandles.every((handle) => clearedHandles.includes(handle))).toBe(true);
      expect(abortAdds).toBeGreaterThan(0);
      expect(abortRemoves).toBe(abortAdds);
      expect(stored.bodyDestroys.value).toBe(0);
      expect(stored.iteratorReturns.value).toBe(0);
    } finally {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      removeSpy.mockRestore();
      addSpy.mockRestore();
    }
    controller.abort(new Error("abort-after-success"));
    await delay(20);
    expect(stored.bodyDestroys.value).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  });

  it("enforces the idle deadline on a stalled ranged GET after preflight", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("0123456789");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    const handle = await store.openRead(meta.hash, { start: 2, end: 5 });
    stored.chunkProducers = [() => hangChunk()];
    stored.reportedGetLength = 4;
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(collectChunks(handle.bytes()), "openRead");
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
    expect(stored.iteratorReturns.value).toBeGreaterThan(0);
  });

  it("enforces the idle deadline on the post-copy canonical probe", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("post-copy-probe-idle\n");
    const meta = await store.put(bytes);
    const stored = fake.object(blobKey(meta.hash));
    if (!stored) throw new Error("missing object");
    stored.chunkProducers = [() => hangChunk()];
    stored.iteratorReturns = { value: 0 };
    stored.iteratorReturnHangs = true;
    stored.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(store.put(bytes), "put");
    expect(stored.bodyDestroys.value).toBeGreaterThan(0);
  });

  it("enforces the idle deadline on journal, file-ref, and legacy iterable get paths", async () => {
    const { fake, store } = openIdleStore();
    const bytes = new TextEncoder().encode("legacy-iterable-get\n");
    const meta = await store.put(bytes);
    const blob = fake.object(blobKey(meta.hash));
    if (!blob) throw new Error("missing blob");
    blob.chunkProducers = [() => hangChunk()];
    blob.iteratorReturnHangs = true;
    blob.bodyDestroys = { value: 0 };
    fake.transformToByteArrayCalls = 0;
    await expectPromptUnavailable(store.get(meta.hash), "get");
    expect(fake.transformToByteArrayCalls).toBe(0);
    expect(blob.bodyDestroys.value).toBeGreaterThan(0);

    const created = await store.putFileServerReference({ uri: SYNTHETIC_URI });
    const ref = fake.object(`refs/${created.id}.json`);
    if (!ref) throw new Error("missing ref");
    ref.chunkProducers = [() => hangChunk()];
    ref.iteratorReturnHangs = true;
    ref.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(
      store.getFileServerReference(created.id),
      "getFileServerReference",
    );
    expect(ref.bodyDestroys.value).toBeGreaterThan(0);

    const journalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const journalBytes = new TextEncoder().encode(JSON.stringify({
      schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
      id: journalId,
      hashes: [],
    }));
    fake.putRaw(`.pending/${journalId}.json`, journalBytes, {}, undefined, {
      chunkProducers: [() => hangChunk()],
      iteratorReturnHangs: true,
      bodyDestroys: { value: 0 },
    });
    const journal = fake.object(`.pending/${journalId}.json`);
    if (!journal) throw new Error("missing journal");
    await expectPromptUnavailable(
      store.getJournalObject(`.pending/${journalId}.json`, "recoverUnreferencedWrites"),
      "recoverUnreferencedWrites",
    );
    expect(journal.bodyDestroys?.value).toBeGreaterThan(0);

    const batch = await store.beginWriteBatch();
    const unpromoted = await batch.put(new TextEncoder().encode("unpromoted-idle-verify\n"));
    const stagingKey = stagingKeys(fake)[0];
    if (!stagingKey) throw new Error("missing staging key");
    const staged = fake.object(stagingKey);
    if (!staged) throw new Error("missing staged object");
    staged.chunkProducers = [() => hangChunk()];
    staged.iteratorReturnHangs = true;
    staged.bodyDestroys = { value: 0 };
    await expectPromptUnavailable(batch.verify(unpromoted.hash), "get");
    await batch.rollback();
  });

  it("does not apply the GetObject idle deadline to intake chunk iteration", async () => {
    const { store } = openIdleStore(30);
    async function* slowIntake(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      await delay(80);
      yield new Uint8Array([4, 5, 6]);
    }
    const stage = await store.stageStream(slowIntake(), { maxBytes: 8 });
    expect(stage.meta.byteLength).toBe(6);
    await stage.rollback();
  });
});
