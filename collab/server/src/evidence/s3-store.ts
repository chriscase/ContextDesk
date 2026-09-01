import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3ClientConfig,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  FILE_SERVER_REF_SCHEMA_ID,
  parseFileServerReference,
  type BlobMetaV1,
  type ContentHash,
  type FileServerReferenceV1,
  type VerificationStatus,
} from "@cd-collab/contracts";
import {
  EVIDENCE_PENDING_WRITE_SCHEMA_ID,
  isContentHash,
  sha256Hex,
  type EvidenceFinalizeOptions,
  type EvidenceReadHandle,
  type EvidenceReadRange,
  type EvidenceStage,
  type EvidenceStore,
  type EvidenceStreamOptions,
  type EvidenceStreamStage,
  type EvidenceWriteBatch,
  type EvidenceWriteRecoveryReport,
} from "./store.js";

export interface S3EvidenceClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3EvidenceStoreOptions {
  bucket: string;
  region: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Test/injection seam. Production constructs an AWS SDK v3 `S3Client`. */
  client?: S3EvidenceClient;
  acquireWriteLease?: () => Promise<() => void | Promise<void>>;
  /**
   * Per-await GetObject body idle deadline in milliseconds. `undefined`
   * disables the deadline (direct unit fakes). When present, a safe integer >= 1.
   */
  responseBodyIdleTimeoutMs?: number;
}

export class S3EvidenceError extends Error {
  readonly operation: string;

  constructor(operation: string, reason: string) {
    super(`s3 evidence ${operation} failed: ${reason}`);
    this.name = "S3EvidenceError";
    this.operation = operation;
  }
}

const FILE_REF_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_JOURNAL_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const PENDING_JOURNAL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METADATA_SHA256 = "sha256";
const METADATA_BYTE_LENGTH = "bytelength";
const METADATA_CONTENT_TYPE = "contenttype";
const ASCII_PRINTABLE = /^[\u0020-\u007E]*$/;
const OBJECT_NOT_FOUND = new Set(["NoSuchKey", "NotFound", "NoSuchKeyException"]);
const MAX_FILE_REF_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 256;
const MAX_LIST_KEYS = 8192;

export function createS3ClientConfig(opts: S3EvidenceStoreOptions): S3ClientConfig {
  const region = requiredToken(opts.region, "region");
  requiredToken(opts.bucket, "bucket");
  normalizeBucket(opts.bucket);
  if (opts.prefix !== undefined) normalizePrefix(opts.prefix);
  const endpoint = normalizeEndpoint(opts.endpoint);
  const credentials = completeStaticCredentials(opts);
  const config: S3ClientConfig = {
    region,
    // Default SDK flexible checksums are not portable to Garage / ordinary S3.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    disableS3ExpressSessionAuth: true,
  };
  if (credentials !== undefined) config.credentials = credentials;
  if (endpoint !== undefined) config.endpoint = endpoint;
  if (opts.forcePathStyle === true) config.forcePathStyle = true;
  else if (opts.forcePathStyle === false) config.forcePathStyle = false;
  return config;
}

/**
 * S3-compatible EvidenceStore (Garage v2.3.0 and ordinary S3).
 *
 * Durable write batches journal pending hashes, then promote with CopyObject.
 * Crash recovery reclaims unreferenced journaled objects. Coordination is
 * in-process unless an external write lease is supplied.
 */
export class S3EvidenceStore implements EvidenceStore {
  readonly writeCoordination: "single_process" | "external";
  readonly responseBodyIdleTimeoutMs: number | undefined;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3EvidenceClient;
  private readonly acquireWriteLease:
    | (() => Promise<() => void | Promise<void>>)
    | undefined;
  private readonly referencedSources: Array<() => Promise<Iterable<string>>> = [];
  private readonly digestTails = new Map<string, Promise<void>>();
  private readonly liveStageHashes = new Set<string>();
  private readonly liveStagingKeys = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(opts: S3EvidenceStoreOptions) {
    this.responseBodyIdleTimeoutMs = validatedResponseBodyIdleTimeoutMs(
      opts.responseBodyIdleTimeoutMs,
    );
    const config = createS3ClientConfig(opts);
    this.bucket = normalizeBucket(opts.bucket);
    this.prefix = normalizePrefix(opts.prefix);
    this.client = opts.client ?? (new S3Client(config) as unknown as S3EvidenceClient);
    this.acquireWriteLease = opts.acquireWriteLease;
    this.writeCoordination = opts.acquireWriteLease ? "external" : "single_process";
  }

  addReferencedContentHashSource(loader: () => Promise<Iterable<string>>): void {
    this.referencedSources.push(loader);
  }

  async ping(): Promise<void> {
    try {
      await this.send("ping", new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError("ping", "unavailable");
    }
  }

  async beginWriteBatch(): Promise<EvidenceWriteBatch> {
    const release = await this.acquireWriteLock();
    try {
      if (this.referencedSources.length > 0) {
        await this.recoverUnreferencedWritesUnlocked(await this.loadBoundReferencedHashes());
      } else {
        await this.deletePrefix("beginWriteBatch", this.prefixed(".staging/"));
        await this.deletePrefix("beginWriteBatch", this.prefixed("staging/"));
        await this.cleanupAbandonedStreamStagesUnlocked("beginWriteBatch");
      }
      return new S3EvidenceWriteBatch(this, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  async recoverUnreferencedWrites(
    referenced?: ReadonlySet<string>,
  ): Promise<EvidenceWriteRecoveryReport> {
    const release = await this.acquireWriteLock();
    try {
      const hashes = await this.unionReferencedHashes(referenced);
      if (!hashes) {
        throw new Error("referenced content hashes are required for evidence recovery");
      }
      return await this.recoverUnreferencedWritesUnlocked(hashes);
    } finally {
      await release();
    }
  }

  async put(bytes: Uint8Array, opts?: { contentType?: string }): Promise<BlobMetaV1> {
    const release = await this.acquireWriteLock();
    try {
      return await this.putUnlocked(bytes, opts);
    } finally {
      await release();
    }
  }

  async putUnlocked(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1> {
    const hash = sha256Hex(bytes);
    const meta = blobMeta(hash, bytes, opts?.contentType);
    const existing = await this.head(hash);
    if (existing) {
      await this.assertExistingCanonical(hash, bytes.byteLength);
      return meta;
    }
    await this.putObject(this.blobKey(hash), bytes, meta, "put");
    return meta;
  }

  async stage(bytes: Uint8Array, opts?: { contentType?: string }): Promise<EvidenceStage> {
    const hash = sha256Hex(bytes);
    const meta = blobMeta(hash, bytes, opts?.contentType);
    const releaseDigest = await this.acquireDigestLock(hash);
    let existing = false;
    try {
      const releaseWrite = await this.acquireWriteLock();
      try {
        const head = await this.head(hash);
        if (head) {
          await this.assertExistingCanonical(hash, bytes.byteLength, "stage");
          existing = true;
        }
      } finally {
        await releaseWrite();
      }
    } catch (error) {
      releaseDigest();
      throw error;
    }
    const stagingObjectKey = existing ? null : this.prefixed(`staging/${randomUUID()}`);
    try {
      if (stagingObjectKey) {
        await this.putObject(stagingObjectKey, bytes, meta, "stage");
      }
    } catch (error) {
      releaseDigest();
      throw error;
    }
    this.liveStageHashes.add(hash);
    if (stagingObjectKey) this.liveStagingKeys.add(stagingObjectKey);
    let committed = existing;
    let created = false;
    let released = false;
    let rolledBack = false;
    let ownershipUnknown = false;
    let journalId: string | null = null;
    const withWriteLock = async (fn: () => Promise<void>): Promise<void> => {
      const releaseWrite = await this.acquireWriteLock();
      try {
        await fn();
      } finally {
        await releaseWrite();
      }
    };
    const dropLiveMarkers = (): void => {
      this.liveStageHashes.delete(hash);
      if (stagingObjectKey) this.liveStagingKeys.delete(stagingObjectKey);
    };
    return {
      meta,
      commit: async () => {
        await withWriteLock(async () => {
          if (committed) return;
          if (rolledBack || released) throw new S3EvidenceError("commit", "unavailable");
          if (!stagingObjectKey) throw new S3EvidenceError("commit", "unavailable");
          const already = await this.head(hash);
          if (already) {
            await this.assertExistingCanonical(hash, bytes.byteLength, "commit");
            committed = true;
            await this.deleteObjectBestEffort("commit", stagingObjectKey);
            return;
          }
          if (journalId === null) journalId = randomUUID();
          await this.writePendingJournal(journalId, [hash], "commit");
          const outcome = await this.copyCanonicalObject(
            stagingObjectKey,
            hash,
            bytes.byteLength,
            "commit",
          );
          if (outcome === "applied") {
            created = true;
            committed = true;
            await this.deleteObjectBestEffort("commit", stagingObjectKey);
            return;
          }
          if (outcome === "unknown") ownershipUnknown = true;
          throw new S3EvidenceError("commit", "unavailable");
        });
      },
      rollback: async () => {
        await withWriteLock(async () => {
          // Stale rollback after release is a no-op. Published canonical bytes
          // are never deleted here: identical content may already be adopted by
          // another lifecycle or process, and cross-process recovery versus an
          // active ad-hoc stage cannot be proven without an async/durable
          // release/finalize seam.
          if (released || rolledBack) return;
          if (stagingObjectKey) await this.deleteObject("rollback", stagingObjectKey);
          const published = created || committed;
          if (journalId && !published && !ownershipUnknown) {
            await this.deletePendingJournal(journalId, "rollback");
            journalId = null;
          }
          rolledBack = true;
        });
      },
      release: () => {
        if (released) return;
        released = true;
        dropLiveMarkers();
        releaseDigest();
      },
    };
  }

  async stageStream(
    source: AsyncIterable<Uint8Array>,
    opts: EvidenceStreamOptions,
  ): Promise<EvidenceStreamStage> {
    if (!opts || typeof opts !== "object") {
      throw new Error("evidence stream options are required");
    }
    assertSafeNonNegativeInteger(opts.maxBytes, "maxBytes");
    if (opts.expectedLength !== undefined) {
      assertSafeNonNegativeInteger(opts.expectedLength, "expectedLength");
      if (opts.expectedLength > opts.maxBytes) {
        throw new Error("expectedLength must not exceed maxBytes");
      }
    }
    if (opts.contentType !== undefined) {
      if (typeof opts.contentType !== "string") {
        throw new Error("contentType must be a string");
      }
      assertMetadataValue(opts.contentType, "stageStream");
    }
    if (opts.signal !== undefined) {
      assertAbortSignal(opts.signal);
    }
    if (!source || typeof source[Symbol.asyncIterator] !== "function") {
      throw new Error("evidence stream source must be an AsyncIterable");
    }
    throwIfAborted(opts.signal);

    const scratchKey = this.opaqueStreamStagingKey();
    this.liveStagingKeys.add(scratchKey);
    const hasher = createHash("sha256");
    let byteLength = 0;
    let sourceFinished = false;
    let iterator: AsyncIterator<Uint8Array> | null = null;
    let streamed = false;
    let intakeError: unknown = null;
    const stopSource = (): void => {
      if (!iterator || sourceFinished) return;
      sourceFinished = true;
      try {
        if (typeof iterator.return === "function") {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        }
      } catch {
        // A hostile source cannot suppress scratch cleanup.
      }
    };

    try {
      iterator = source[Symbol.asyncIterator]();
      const intake = iterateIntakeChunks({
        iterator,
        opts,
        hasher,
        onBytes: (nextLength) => {
          byteLength = nextLength;
        },
        onFinished: () => {
          sourceFinished = true;
        },
        onError: (error) => {
          intakeError = error;
        },
      });
      const input: {
        Bucket: string;
        Key: string;
        Body: Readable;
        ContentLength?: number;
        ContentType?: string;
      } = {
        Bucket: this.bucket,
        Key: scratchKey,
        Body: Readable.from(intake, { objectMode: true }),
      };
      if (opts.expectedLength !== undefined) input.ContentLength = opts.expectedLength;
      if (opts.contentType !== undefined) input.ContentType = opts.contentType;
      try {
        await this.send("stageStream", new PutObjectCommand(input));
      } catch (error) {
        if (intakeError !== null) throw intakeError;
        throw error;
      }
      throwIfAborted(opts.signal);
      if (opts.expectedLength !== undefined && byteLength !== opts.expectedLength) {
        throw new Error("evidence stream length did not match expectedLength");
      }
      streamed = true;
    } finally {
      if (!sourceFinished) stopSource();
      if (!streamed) {
        await this.deleteObjectBestEffort("stageStream", scratchKey);
        this.liveStagingKeys.delete(scratchKey);
      }
    }

    const hash = hasher.digest("hex") as ContentHash;
    const meta: BlobMetaV1 = Object.freeze({
      hash,
      byteLength,
      contentType: opts.contentType ?? null,
    });
    this.liveStageHashes.add(hash);

    let promoted = false;
    let created = false;
    let settled = false;
    let ownershipUnknown = false;
    let journalId: string | null = null;
    let releaseLifecycleLock: (() => Promise<void>) | null = null;
    let promotionPromise: Promise<void> | null = null;
    let settlementPromise: Promise<void> | null = null;
    let settlementMode: "rollback" | "finalize" | null = null;
    let finalizeRetainPendingJournal: boolean | null = null;

    const dropLiveMarkers = (): void => {
      this.liveStageHashes.delete(hash);
      this.liveStagingKeys.delete(scratchKey);
    };

    const releaseLifecycle = async (): Promise<void> => {
      const release = releaseLifecycleLock;
      if (!release) return;
      try {
        await release();
      } finally {
        if (releaseLifecycleLock === release) releaseLifecycleLock = null;
      }
    };

    const cleanScratch = async (operation: string): Promise<void> => {
      await this.deleteObject(operation, scratchKey);
      this.liveStagingKeys.delete(scratchKey);
    };

    const runPromotion = async (): Promise<void> => {
      const releaseWrite = await this.acquireWriteLock();
      let retainWriteLock = false;
      try {
        const existing = await this.head(hash);
        if (existing) {
          await this.assertExistingCanonical(hash, byteLength, "promote");
          await cleanScratch("promote");
          promoted = true;
          created = false;
          releaseLifecycleLock = releaseWrite;
          retainWriteLock = true;
          return;
        }

        if (journalId === null) journalId = randomUUID();
        await this.writePendingJournal(journalId, [hash], "promote");
        const outcome = await this.copyCanonicalObjectReplace(
          scratchKey,
          hash,
          meta,
          "promote",
        );
        if (outcome === "applied") {
          created = true;
          promoted = true;
          releaseLifecycleLock = releaseWrite;
          retainWriteLock = true;
          return;
        }
        if (outcome === "unknown") ownershipUnknown = true;
        releaseLifecycleLock = releaseWrite;
        retainWriteLock = true;
        throw new S3EvidenceError("promote", "unavailable");
      } finally {
        if (!retainWriteLock) await releaseWrite();
      }
    };

    const promote = async (): Promise<void> => {
      if (settled) throw new Error("evidence stream stage is already settled");
      if (settlementMode) {
        throw new Error(`evidence stream stage is already settling via ${settlementMode}`);
      }
      if (promoted) return;
      if (releaseLifecycleLock) {
        throw new Error("evidence stream failed promotion must be rolled back");
      }
      if (!promotionPromise) {
        promotionPromise = runPromotion().catch((error: unknown) => {
          promotionPromise = null;
          throw error;
        });
      }
      await promotionPromise;
      if (settlementMode) {
        throw new Error(
          `evidence stream stage began ${settlementMode} while promotion was in flight`,
        );
      }
    };

    const settle = async (
      mode: "rollback" | "finalize",
      options?: EvidenceFinalizeOptions,
    ): Promise<void> => {
      const retainPendingJournal = options?.retainPendingJournal === true;
      if (mode === "finalize" && !promoted) {
        if (promotionPromise) {
          throw new Error("evidence stream promotion must complete before finalize");
        }
        if (created || journalId !== null || releaseLifecycleLock) {
          throw new Error("evidence stream failed promotion must be rolled back");
        }
      }
      if (settlementPromise) {
        if (settlementMode !== mode) {
          throw new Error(`evidence stream stage is already settling via ${settlementMode}`);
        }
        if (
          mode === "finalize"
          && finalizeRetainPendingJournal !== retainPendingJournal
        ) {
          throw new Error("evidence stream finalize options conflict with the active settlement");
        }
        return settlementPromise;
      }
      if (settled) return;
      if (settlementMode && settlementMode !== mode) {
        throw new Error(`evidence stream stage is already settling via ${settlementMode}`);
      }
      if (mode === "finalize") {
        if (
          finalizeRetainPendingJournal !== null
          && finalizeRetainPendingJournal !== retainPendingJournal
        ) {
          throw new Error("evidence stream finalize options conflict with the active settlement");
        }
        finalizeRetainPendingJournal = retainPendingJournal;
      }
      settlementMode = mode;
      const attempt = (async () => {
        if (promotionPromise) {
          try {
            await promotionPromise;
          } catch {
            // Settlement still owns cleanup after a failed promotion.
          }
        }
        if (
          !releaseLifecycleLock
          && (promoted || created || journalId !== null || ownershipUnknown)
        ) {
          releaseLifecycleLock = await this.acquireWriteLock();
        }
        try {
          await cleanScratch(mode);
          let keepJournal = ownershipUnknown;
          if (mode === "rollback" && created) {
            const inspection = await this.inspectCanonical(hash, byteLength);
            if (inspection === "unknown" || inspection === "mismatch") {
              keepJournal = true;
            } else if (inspection === "match") {
              await this.deleteObject("rollback", this.blobKey(hash));
              created = false;
              promoted = false;
            } else {
              created = false;
              promoted = false;
            }
          }
          if (journalId && (mode === "rollback" ? !keepJournal : !retainPendingJournal)) {
            await this.deletePendingJournal(journalId, mode);
            journalId = null;
          }
        } catch (error) {
          if (!created && journalId === null && !ownershipUnknown) {
            dropLiveMarkers();
            await releaseLifecycle();
          }
          throw error;
        }
        dropLiveMarkers();
        await releaseLifecycle();
        settled = true;
      })();
      settlementPromise = attempt;
      try {
        await attempt;
      } catch (error) {
        if (settlementPromise === attempt) settlementPromise = null;
        throw error;
      }
    };

    return {
      meta,
      promote,
      rollback: () => settle("rollback"),
      finalize: (options) => settle("finalize", options),
    };
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    assertContentHash(hash, "get");
    return this.getObject(this.blobKey(hash), "get");
  }

  async head(hash: ContentHash, signal?: AbortSignal): Promise<BlobMetaV1 | null> {
    throwIfAborted(signal);
    assertContentHash(hash, "head");
    try {
      const output = await this.sendAllowMissing(
        "head",
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.blobKey(hash) }),
        signal,
      );
      if (output === null) return null;
      return trustedBlobMeta(asRecord(output, "head"), hash, "head");
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError("head", "unavailable");
    }
  }

  async openRead(
    hash: ContentHash,
    range?: EvidenceReadRange,
    signal?: AbortSignal,
  ): Promise<EvidenceReadHandle> {
    throwIfAborted(signal);
    if (!isContentHash(hash)) {
      throw new Error("invalid content hash");
    }
    if (range !== undefined) {
      assertSafeNonNegativeInteger(range.start, "range.start");
      assertSafeNonNegativeInteger(range.end, "range.end");
      if (range.end < range.start) {
        throw new Error("range.end must be greater than or equal to range.start");
      }
    }
    let headRecord: Record<string, unknown>;
    try {
      const output = await this.sendAllowMissing(
        "openRead",
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.blobKey(hash) }),
        signal,
      );
      if (output === null) {
        throw new S3EvidenceError("openRead", "not found");
      }
      headRecord = asRecord(output, "openRead");
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError("openRead", "unavailable");
    }
    const meta = Object.freeze(trustedBlobMeta(headRecord, hash, "openRead"));
    throwIfAborted(signal);
    const fence = parseObjectEtag(headRecord.ETag, "openRead");
    if (
      range !== undefined
      && (
        meta.byteLength === 0
        || range.start >= meta.byteLength
        || range.end >= meta.byteLength
      )
    ) {
      throw new Error("range is out of bounds");
    }
    await this.verifyCanonicalIncremental(hash, meta, fence, "openRead", signal);
    throwIfAborted(signal);

    const effectiveRange: EvidenceReadRange | null = range
      ? Object.freeze({ start: range.start, end: range.end })
      : null;
    const exactCount = effectiveRange
      ? effectiveRange.end - effectiveRange.start + 1
      : meta.byteLength;

    return Object.freeze({
      meta,
      range: effectiveRange,
      byteLength: exactCount,
      bytes: () => this.readVerifiedObject(hash, meta, effectiveRange, fence, signal),
    });
  }

  async verify(hash: ContentHash): Promise<boolean> {
    assertContentHash(hash, "verify");
    try {
      const output = await this.sendAllowMissing(
        "verify",
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.blobKey(hash) }),
      );
      if (output === null) return false;
      const record = asRecord(output, "verify");
      const meta = trustedBlobMeta(record, hash, "verify");
      const fence = parseObjectEtag(record.ETag, "verify");
      await this.verifyCanonicalIncremental(hash, meta, fence, "verify");
      return true;
    } catch (error) {
      if (isIntegrityFailure(error)) return false;
      throw error;
    }
  }

  async putFileServerReference(input: {
    uri: string;
    expectedHash?: ContentHash | null;
    verificationStatus?: VerificationStatus;
  }): Promise<FileServerReferenceV1> {
    const expectedHash = assertedExpectedHash(input.expectedHash, "putFileServerReference");
    let verificationStatus = input.verificationStatus ?? "unverified";
    if (expectedHash === null) {
      if (verificationStatus === "verified") {
        throw new Error("cannot mark a file-server reference verified without an expected hash");
      }
      verificationStatus = verificationStatus === "unreachable" ? "unreachable" : "unverified";
    }
    const ref = parsedFileServerReference(
      {
        schemaId: FILE_SERVER_REF_SCHEMA_ID,
        id: randomUUID(),
        uri: input.uri,
        expectedHash,
        verificationStatus,
      },
      "putFileServerReference",
    );
    await this.putReferenceObject(ref, "putFileServerReference");
    return ref;
  }

  async getFileServerReference(id: string): Promise<FileServerReferenceV1 | null> {
    assertFileRefId(id);
    try {
      const output = await this.sendAllowMissing(
        "getFileServerReference",
        new GetObjectCommand({ Bucket: this.bucket, Key: this.refKey(id) }),
      );
      if (output === null) return null;
      const record = asRecord(output, "getFileServerReference");
      const bytes = await readBoundedObjectBytes(
        record.Body,
        numericLength(record.ContentLength),
        MAX_FILE_REF_BYTES,
        "getFileServerReference",
        this.responseBodyIdleTimeoutMs,
      );
      return parseStoredReference(bytes, id, "getFileServerReference");
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError("getFileServerReference", "unavailable");
    }
  }

  async verifyFileServerReference(
    id: string,
    actualBytes?: Uint8Array,
  ): Promise<FileServerReferenceV1> {
    const existing = await this.getFileServerReference(id);
    if (!existing) {
      throw new S3EvidenceError("verifyFileServerReference", "not found");
    }
    let next: FileServerReferenceV1;
    if (actualBytes === undefined) {
      next = { ...existing, verificationStatus: "unreachable" };
    } else if (existing.expectedHash === null) {
      next = { ...existing, verificationStatus: "unverified" };
    } else if (sha256Hex(actualBytes) === existing.expectedHash) {
      next = { ...existing, verificationStatus: "verified" };
    } else {
      next = { ...existing, verificationStatus: "unverified" };
    }
    await this.putReferenceObject(next, "verifyFileServerReference");
    return next;
  }

  async abandonFileServerReference(id: string): Promise<void> {
    assertFileRefId(id);
    await this.deleteObject("abandonFileServerReference", this.refKey(id));
  }

  async restoreFileServerReference(ref: FileServerReferenceV1): Promise<void> {
    assertFileRefId(ref.id);
    const parsed = parsedFileServerReference(ref, "restoreFileServerReference");
    if (parsed.expectedHash !== null) {
      assertedExpectedHash(parsed.expectedHash, "restoreFileServerReference");
    }
    await this.putReferenceObject(parsed, "restoreFileServerReference");
  }

  blobKey(hash: ContentHash): string {
    return this.prefixed(`blobs/${hash.slice(0, 2)}/${hash}`);
  }

  opaqueStagingKey(scopeId: string): string {
    return this.prefixed(`.staging/${scopeId}/${randomUUID()}`);
  }

  opaqueStreamStagingKey(): string {
    return this.prefixed(`.stream-staging/${randomUUID()}/${randomUUID()}`);
  }

  batchStagingPrefix(scopeId: string): string {
    return this.prefixed(`.staging/${scopeId}/`);
  }

  pendingPrefix(): string {
    return this.prefixed(".pending/");
  }

  stagingResiduePrefix(): string {
    return this.prefixed(".staging/");
  }

  streamStagingResiduePrefix(): string {
    return this.prefixed(".stream-staging/");
  }

  directStagingResiduePrefix(): string {
    return this.prefixed("staging/");
  }

  async writePendingJournal(
    id: string,
    hashes: readonly ContentHash[],
    operation = "promote",
  ): Promise<void> {
    if (!PENDING_JOURNAL_ID_RE.test(id)) {
      throw new S3EvidenceError(operation, "invalid pending write journal id");
    }
    const safeHashes = hashes.filter((hash) => isContentHash(hash));
    const payload = Buffer.from(
      JSON.stringify({
        schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
        id,
        hashes: safeHashes,
      }),
      "utf8",
    );
    if (payload.byteLength > MAX_JOURNAL_BYTES) {
      throw new S3EvidenceError(operation, "pending write journal exceeds bound");
    }
    await this.send(
      operation,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.pendingJournalKey(id),
        Body: payload,
        ContentLength: payload.byteLength,
        ContentType: "application/json",
      }),
    );
  }

  async deletePendingJournal(id: string, operation = "finalize"): Promise<void> {
    if (!PENDING_JOURNAL_ID_RE.test(id)) {
      throw new S3EvidenceError(operation, "invalid pending write journal id");
    }
    await this.deleteObject(operation, this.pendingJournalKey(id));
  }

  async putObject(
    key: string,
    bytes: Uint8Array,
    meta: BlobMetaV1,
    operation: string,
  ): Promise<void> {
    if (meta.contentType !== null) assertMetadataValue(meta.contentType, operation);
    const input: {
      Bucket: string;
      Key: string;
      Body: Buffer;
      ContentLength: number;
      Metadata: Record<string, string>;
      ContentType?: string;
    } = {
      Bucket: this.bucket,
      Key: key,
      Body: Buffer.from(bytes),
      ContentLength: bytes.byteLength,
      Metadata: userMetadata(meta),
    };
    if (meta.contentType !== null) input.ContentType = meta.contentType;
    await this.send(operation, new PutObjectCommand(input));
  }

  async copyObject(fromKey: string, toKey: string, operation: string): Promise<void> {
    try {
      await this.send(
        operation,
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toKey,
          CopySource: encodeCopySource(this.bucket, fromKey),
          MetadataDirective: "COPY",
        }),
      );
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  async copyCanonicalObject(
    fromKey: string,
    hash: ContentHash,
    byteLength: number,
    operation: string,
  ): Promise<"applied" | "absent" | "unknown"> {
    const toKey = this.blobKey(hash);
    try {
      await this.copyObject(fromKey, toKey, operation);
    } catch {
      // Destination is still inspected below. A thrown CopyObject may have
      // applied bytes; absent vs unknown is decided from Head/Get, not the throw.
    }
    return this.probeCanonicalCopy(hash, byteLength, operation);
  }

  async copyCanonicalObjectReplace(
    fromKey: string,
    hash: ContentHash,
    meta: BlobMetaV1,
    operation: string,
  ): Promise<"applied" | "absent" | "unknown"> {
    const toKey = this.blobKey(hash);
    if (meta.contentType !== null) assertMetadataValue(meta.contentType, operation);
    const input: {
      Bucket: string;
      Key: string;
      CopySource: string;
      MetadataDirective: "REPLACE";
      Metadata: Record<string, string>;
      ContentType?: string;
    } = {
      Bucket: this.bucket,
      Key: toKey,
      CopySource: encodeCopySource(this.bucket, fromKey),
      MetadataDirective: "REPLACE",
      Metadata: userMetadata(meta),
    };
    if (meta.contentType !== null) input.ContentType = meta.contentType;
    try {
      await this.send(operation, new CopyObjectCommand(input));
    } catch {
      // Destination is still inspected below. A thrown CopyObject may have
      // applied bytes; absent vs unknown is decided from Head/Get, not the throw.
    }
    return this.probeCanonicalCopy(hash, meta.byteLength, operation);
  }

  private async probeCanonicalCopy(
    hash: ContentHash,
    byteLength: number,
    operation: string,
  ): Promise<"applied" | "absent" | "unknown"> {
    let present: boolean;
    try {
      present = await this.objectExists(this.blobKey(hash), operation);
    } catch {
      return "unknown";
    }
    if (!present) return "absent";
    try {
      await this.assertExistingCanonical(hash, byteLength, operation);
      return "applied";
    } catch {
      return "unknown";
    }
  }

  async deleteObject(operation: string, key: string): Promise<void> {
    await this.sendAllowMissing(
      operation,
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async deleteObjectBestEffort(operation: string, key: string): Promise<void> {
    try {
      await this.deleteObject(operation, key);
    } catch {
      // Canonical visibility already committed; leftover staging is not caller-visible.
    }
  }

  async deletePrefix(operation: string, prefix: string): Promise<void> {
    for (const key of await this.listAllKeys(operation, prefix)) {
      if (this.liveStagingKeys.has(key)) continue;
      await this.deleteObject(operation, key);
    }
  }

  async objectExists(key: string, operation: string): Promise<boolean> {
    const output = await this.sendAllowMissing(
      operation,
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return output !== null;
  }

  async getObject(key: string, operation: string): Promise<Uint8Array | null> {
    try {
      const output = await this.sendAllowMissing(
        operation,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (output === null) return null;
      const record = asRecord(output, operation);
      return await readObjectBytes(
        record.Body,
        numericLength(record.ContentLength),
        operation,
        this.responseBodyIdleTimeoutMs,
      );
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  async getJournalObject(key: string, operation: string): Promise<Uint8Array | "missing" | "malformed"> {
    try {
      const output = await this.sendAllowMissing(
        operation,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (output === null) return "missing";
      const record = asRecord(output, operation);
      const contentLength = numericLength(record.ContentLength);
      if (contentLength === undefined || contentLength > MAX_JOURNAL_BYTES) return "malformed";
      return await readBoundedObjectBytes(
        record.Body,
        contentLength,
        MAX_JOURNAL_BYTES,
        operation,
        this.responseBodyIdleTimeoutMs,
      );
    } catch (error) {
      if (error instanceof S3EvidenceError && error.operation === operation) {
        if (error.message.endsWith("malformed pending write journal") || error.message.endsWith("inconsistent object")) {
          return "malformed";
        }
        throw error;
      }
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  async listAllKeys(operation: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const seenTokens = new Set<string>();
    let token: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      if (pages > MAX_LIST_PAGES || keys.length > MAX_LIST_KEYS) {
        throw new S3EvidenceError(operation, "unavailable");
      }
      const input: {
        Bucket: string;
        Prefix: string;
        MaxKeys: number;
        ContinuationToken?: string;
      } = {
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: MAX_LIST_PAGE_SIZE,
      };
      if (token !== undefined) input.ContinuationToken = token;
      const output = asRecord(await this.send(operation, new ListObjectsV2Command(input)), operation);
      const contents = output.Contents;
      let pageCount = 0;
      if (contents !== undefined) {
        if (!Array.isArray(contents)) {
          throw new S3EvidenceError(operation, "unavailable");
        }
        if (contents.length > MAX_LIST_PAGE_SIZE) {
          throw new S3EvidenceError(operation, "unavailable");
        }
        for (const entry of contents) {
          if (typeof entry !== "object" || entry === null) {
            throw new S3EvidenceError(operation, "unavailable");
          }
          const key = (entry as { Key?: unknown }).Key;
          if (typeof key !== "string" || key === "" || !key.startsWith(prefix)) {
            throw new S3EvidenceError(operation, "unavailable");
          }
          keys.push(key);
          pageCount += 1;
        }
      }
      if (keys.length > MAX_LIST_KEYS) {
        throw new S3EvidenceError(operation, "unavailable");
      }
      const truncated = output.IsTruncated;
      if (truncated === true) {
        const next = output.NextContinuationToken;
        if (typeof next !== "string" || next === "") {
          throw new S3EvidenceError(operation, "unavailable");
        }
        if (seenTokens.has(next) || next === token || pageCount === 0) {
          throw new S3EvidenceError(operation, "unavailable");
        }
        seenTokens.add(next);
        token = next;
      } else if (truncated === false || truncated === undefined) {
        token = undefined;
      } else {
        throw new S3EvidenceError(operation, "unavailable");
      }
    } while (token !== undefined);
    return keys;
  }

  private pendingJournalKey(id: string): string {
    return this.prefixed(`.pending/${id}.json`);
  }

  private refKey(id: string): string {
    return this.prefixed(`refs/${id}.json`);
  }

  private prefixed(relative: string): string {
    return this.prefix === "" ? relative : `${this.prefix}/${relative}`;
  }

  private async putReferenceObject(
    ref: FileServerReferenceV1,
    operation: string,
  ): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(ref), "utf8");
    if (bytes.byteLength > MAX_FILE_REF_BYTES) {
      throw new S3EvidenceError(operation, "malformed file-server reference");
    }
    await this.send(
      operation,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.refKey(ref.id),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "application/json",
      }),
    );
  }

  async assertExistingCanonical(
    hash: ContentHash,
    byteLength: number,
    operation = "put",
  ): Promise<void> {
    const output = await this.sendAllowMissing(
      operation,
      new HeadObjectCommand({ Bucket: this.bucket, Key: this.blobKey(hash) }),
    );
    if (output === null) {
      throw new S3EvidenceError(
        operation,
        "existing content-addressed evidence failed verification",
      );
    }
    const record = asRecord(output, operation);
    const meta = trustedBlobMeta(record, hash, operation);
    if (meta.byteLength !== byteLength || meta.hash !== hash) {
      throw new S3EvidenceError(operation, "inconsistent metadata");
    }
    const fence = parseObjectEtag(record.ETag, operation);
    await this.verifyCanonicalIncremental(hash, meta, fence, operation);
  }

  async inspectCanonical(
    hash: ContentHash,
    byteLength: number,
  ): Promise<"match" | "absent" | "mismatch" | "unknown"> {
    try {
      const exists = await this.objectExists(this.blobKey(hash), "rollback");
      if (!exists) return "absent";
    } catch {
      return "unknown";
    }
    try {
      await this.assertExistingCanonical(hash, byteLength, "rollback");
      return "match";
    } catch (error) {
      if (
        error instanceof S3EvidenceError
        && (
          error.message.endsWith("failed verification")
          || error.message.endsWith("inconsistent metadata")
          || error.message.endsWith("inconsistent object")
        )
      ) {
        return "mismatch";
      }
      return "unknown";
    }
  }

  private async loadBoundReferencedHashes(): Promise<Set<string>> {
    const hashes = new Set<string>();
    for (const loader of this.referencedSources) {
      for (const hash of await loader()) {
        if (isContentHash(hash)) hashes.add(hash);
      }
    }
    return hashes;
  }

  private async unionReferencedHashes(
    explicit?: ReadonlySet<string>,
  ): Promise<Set<string> | null> {
    if (explicit === undefined && this.referencedSources.length === 0) {
      return null;
    }
    const hashes = new Set<string>();
    if (explicit !== undefined) {
      for (const hash of explicit) {
        if (isContentHash(hash)) hashes.add(hash);
      }
    }
    if (this.referencedSources.length > 0) {
      for (const hash of await this.loadBoundReferencedHashes()) {
        hashes.add(hash);
      }
    }
    return hashes;
  }

  private async recoverUnreferencedWritesUnlocked(
    referenced: ReadonlySet<string>,
  ): Promise<EvidenceWriteRecoveryReport> {
    const reclaimed: ContentHash[] = [];
    let journals = 0;
    const pendingPrefix = this.pendingPrefix();
    for (const key of await this.listAllKeys("recoverUnreferencedWrites", pendingPrefix)) {
      const name = key.slice(pendingPrefix.length);
      if (name.includes(".tmp")) {
        await this.deleteObjectBestEffort("recoverUnreferencedWrites", key);
        continue;
      }
      if (name.includes("/") || !PENDING_JOURNAL_FILE_RE.test(name)) continue;
      journals += 1;
      const body = await this.getJournalObject(key, "recoverUnreferencedWrites");
      if (body === "missing") continue;
      let parsed: { schemaId?: unknown; id?: unknown; hashes?: unknown } | null = null;
      if (body !== "malformed") {
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body), jsonReviver) as {
            schemaId?: unknown;
            id?: unknown;
            hashes?: unknown;
          };
        } catch {
          parsed = null;
        }
      }
      if (
        parsed?.schemaId !== EVIDENCE_PENDING_WRITE_SCHEMA_ID
        || parsed.id !== name.slice(0, -".json".length)
        || !Array.isArray(parsed.hashes)
        || !parsed.hashes.every((hash) => typeof hash === "string" && isContentHash(hash))
      ) {
        await this.deleteObject("recoverUnreferencedWrites", key);
        continue;
      }
      // Skip journals that still belong to an unreleased process-local stage.
      // Cross-process recovery versus an active ad-hoc stage cannot be proven
      // without an async/durable release/finalize seam.
      if (parsed.hashes.some((hash) => this.liveStageHashes.has(hash))) {
        continue;
      }
      for (const hash of parsed.hashes) {
        if (
          typeof hash !== "string"
          || !isContentHash(hash)
          || referenced.has(hash)
          || this.liveStageHashes.has(hash)
        ) {
          continue;
        }
        const blobKey = this.blobKey(hash);
        const existed = await this.objectExists(blobKey, "recoverUnreferencedWrites");
        await this.deleteObject("recoverUnreferencedWrites", blobKey);
        if (existed) reclaimed.push(hash);
      }
      await this.deleteObject("recoverUnreferencedWrites", key);
    }
    await this.deletePrefix("recoverUnreferencedWrites", this.stagingResiduePrefix());
    await this.deletePrefix("recoverUnreferencedWrites", this.directStagingResiduePrefix());
    await this.cleanupAbandonedStreamStagesUnlocked("recoverUnreferencedWrites");
    return { reclaimed, journals };
  }

  private async cleanupAbandonedStreamStagesUnlocked(operation: string): Promise<void> {
    if (this.writeCoordination === "external") {
      return;
    }
    await this.deletePrefix(operation, this.streamStagingResiduePrefix());
  }

  private async send(operation: string, command: unknown): Promise<unknown> {
    try {
      return await this.client.send(command);
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  private async sendAllowMissing(
    operation: string,
    command: unknown,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    throwIfAborted(signal);
    try {
      return await this.client.send(command, signal ? { abortSignal: signal } : undefined);
    } catch (error) {
      throwIfAborted(signal);
      if (isObjectNotFound(error)) return null;
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  async acquireOwnerWriteLock(): Promise<() => Promise<void>> {
    return this.acquireWriteLock();
  }

  private async verifyCanonicalIncremental(
    hash: ContentHash,
    meta: BlobMetaV1,
    fence: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const record = asRecord(
      await this.sendConditional(
        operation,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.blobKey(hash),
          IfMatch: fence,
        }),
        signal,
      ),
      operation,
    );
    if (parseObjectEtag(record.ETag, operation) !== fence) {
      throw new S3EvidenceError(operation, "object changed");
    }
    if (hasContentRange(record.ContentRange)) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    const contentLength = numericLength(record.ContentLength);
    if (contentLength !== meta.byteLength) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    await hashBodyExact(
      record.Body,
      meta.byteLength,
      hash,
      operation,
      signal,
      this.responseBodyIdleTimeoutMs,
    );
    throwIfAborted(signal);
  }

  private readVerifiedObject(
    hash: ContentHash,
    meta: BlobMetaV1,
    range: EvidenceReadRange | null,
    fence: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const sendConditional = (
      operation: string,
      command: unknown,
      readSignal?: AbortSignal,
    ): Promise<unknown> => this.sendConditional(operation, command, readSignal);
    const request = this.conditionalGetInput(hash, fence, range);
    const idleTimeoutMs = this.responseBodyIdleTimeoutMs;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        throwIfAborted(signal);
        const record = asRecord(
          await sendConditional("openRead", new GetObjectCommand(request), signal),
          "openRead",
        );
        if (parseObjectEtag(record.ETag, "openRead") !== fence) {
          throw new S3EvidenceError("openRead", "object changed");
        }
        const want = range ? range.end - range.start + 1 : meta.byteLength;
        const contentLength = numericLength(record.ContentLength);
        if (contentLength !== want) {
          throw new S3EvidenceError("openRead", "inconsistent object");
        }
        if (range) {
          const contentRange = parseInclusiveContentRange(record.ContentRange, "openRead");
          if (
            contentRange.start !== range.start
            || contentRange.end !== range.end
            || contentRange.total !== meta.byteLength
            || contentRange.end - contentRange.start + 1 !== want
          ) {
            throw new S3EvidenceError("openRead", "inconsistent object");
          }
        } else if (hasContentRange(record.ContentRange)) {
          throw new S3EvidenceError("openRead", "inconsistent object");
        }
        const hasher = range === null ? createHash("sha256") : null;
        let received = 0;
        for await (const chunk of iterateObjectBody(
          record.Body,
          "openRead",
          signal,
          idleTimeoutMs,
        )) {
          throwIfAborted(signal);
          if (chunk.byteLength === 0) continue;
          if (received + chunk.byteLength > want) {
            throw new S3EvidenceError("openRead", "inconsistent object");
          }
          const stable = Uint8Array.from(chunk);
          hasher?.update(stable);
          received += stable.byteLength;
          throwIfAborted(signal);
          yield stable;
        }
        if (received !== want) {
          throw new S3EvidenceError("openRead", "inconsistent object");
        }
        if (hasher && hasher.digest("hex") !== meta.hash) {
          throw new S3EvidenceError("openRead", "failed verification");
        }
        throwIfAborted(signal);
      },
    };
  }

  private conditionalGetInput(
    hash: ContentHash,
    fence: string,
    range: EvidenceReadRange | null,
  ): { Bucket: string; Key: string; IfMatch: string; Range?: string } {
    const input: { Bucket: string; Key: string; IfMatch: string; Range?: string } = {
      Bucket: this.bucket,
      Key: this.blobKey(hash),
      IfMatch: fence,
    };
    if (range) input.Range = `bytes=${range.start}-${range.end}`;
    return input;
  }

  private async sendConditional(
    operation: string,
    command: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    try {
      return await this.client.send(command, signal ? { abortSignal: signal } : undefined);
    } catch (error) {
      throwIfAborted(signal);
      if (isPreconditionFailed(error)) {
        throw new S3EvidenceError(operation, "object changed");
      }
      if (isObjectNotFound(error)) {
        throw new S3EvidenceError(operation, "object changed");
      }
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  private async acquireWriteLock(): Promise<() => Promise<void>> {
    const prior = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    let releaseLease: (() => void | Promise<void>) | undefined;
    try {
      releaseLease = await this.acquireWriteLease?.();
    } catch {
      release();
      throw new S3EvidenceError("lease", "unavailable");
    }
    return async () => {
      try {
        try {
          await releaseLease?.();
        } catch {
          throw new S3EvidenceError("lease", "unavailable");
        }
      } finally {
        release();
      }
    };
  }

  private async acquireDigestLock(hash: string): Promise<() => void> {
    const previous = this.digestTails.get(hash) ?? Promise.resolve();
    let unlock = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const queued = previous.then(() => current);
    this.digestTails.set(hash, queued);
    await previous;
    return () => {
      unlock();
      if (this.digestTails.get(hash) === queued) this.digestTails.delete(hash);
    };
  }
}

class S3EvidenceWriteBatch implements EvidenceWriteBatch {
  private readonly staged = new Map<ContentHash, { meta: BlobMetaV1; key: string }>();
  private readonly created: ContentHash[] = [];
  private readonly scopeId = randomUUID();
  private released = false;
  private cleanupComplete = false;
  private promoted = false;
  private ownershipUnknown = false;
  private journalId: string | null = null;
  private plannedHashes: ContentHash[] | null = null;

  constructor(
    private readonly owner: S3EvidenceStore,
    private readonly releaseLock: () => Promise<void>,
  ) {}

  async put(bytes: Uint8Array, opts?: { contentType?: string }): Promise<BlobMetaV1> {
    if (this.promoted) throw new Error("evidence write batch is already promoted");
    const hash = sha256Hex(bytes);
    const meta = blobMeta(hash, bytes, opts?.contentType);
    const prior = this.staged.get(hash);
    if (prior) return prior.meta;
    const existing = await this.owner.head(hash);
    if (existing) {
      await this.owner.assertExistingCanonical(hash, bytes.byteLength, "put");
      return meta;
    }
    const key = this.owner.opaqueStagingKey(this.scopeId);
    await this.owner.putObject(key, bytes, meta, "put");
    this.staged.set(hash, { meta, key });
    return meta;
  }

  async stage(): Promise<EvidenceStage> {
    throw new Error("nested evidence stages are unsupported in an evidence write batch");
  }

  async stageStream(): Promise<EvidenceStreamStage> {
    throw new Error("streaming evidence stages are unsupported in an evidence write batch");
  }

  async openRead(
    hash: ContentHash,
    range?: EvidenceReadRange,
    signal?: AbortSignal,
  ): Promise<EvidenceReadHandle> {
    return this.owner.openRead(hash, range, signal);
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    const staged = this.staged.get(hash);
    if (staged && !this.promoted) {
      return this.owner.getObject(staged.key, "get");
    }
    return this.owner.get(hash);
  }

  async head(hash: ContentHash, signal?: AbortSignal): Promise<BlobMetaV1 | null> {
    throwIfAborted(signal);
    const staged = this.staged.get(hash);
    if (staged && !this.promoted) return staged.meta;
    return this.owner.head(hash, signal);
  }

  async verify(hash: ContentHash): Promise<boolean> {
    const staged = this.staged.get(hash);
    if (staged && !this.promoted) {
      try {
        const bytes = await this.owner.getObject(staged.key, "get");
        if (bytes === null || sha256Hex(bytes) !== hash) return false;
        if (staged.meta.hash !== hash || staged.meta.byteLength !== bytes.byteLength) return false;
        return true;
      } catch (error) {
        if (isIntegrityFailure(error)) return false;
        throw error;
      }
    }
    return this.owner.verify(hash);
  }

  async putFileServerReference(): Promise<FileServerReferenceV1> {
    throw new Error("file-server references are unsupported in an evidence write batch");
  }

  async getFileServerReference(id: string): Promise<FileServerReferenceV1 | null> {
    return this.owner.getFileServerReference(id);
  }

  async abandonFileServerReference(): Promise<void> {
    throw new Error("file-server references are unsupported in an evidence write batch");
  }

  async restoreFileServerReference(): Promise<void> {
    throw new Error("file-server references are unsupported in an evidence write batch");
  }

  async verifyFileServerReference(): Promise<FileServerReferenceV1> {
    throw new Error("file-server references are unsupported in an evidence write batch");
  }

  async ping(): Promise<void> {
    await this.owner.ping();
  }

  async beginWriteBatch(): Promise<EvidenceWriteBatch> {
    throw new Error("nested evidence write batches are unsupported");
  }

  async promote(): Promise<void> {
    if (this.promoted) return;
    if (this.plannedHashes === null) {
      const planned: ContentHash[] = [];
      for (const [hash, staged] of this.staged) {
        if (await this.owner.objectExists(this.owner.blobKey(hash), "promote")) {
          await this.owner.assertExistingCanonical(hash, staged.meta.byteLength, "promote");
        } else {
          planned.push(hash);
        }
      }
      this.plannedHashes = planned;
    }
    if (this.plannedHashes.length > 0) {
      if (this.journalId === null) this.journalId = randomUUID();
      await this.owner.writePendingJournal(this.journalId, this.plannedHashes);
    }
    const createdSet = new Set(this.created);
    for (const hash of this.plannedHashes) {
      const staged = this.staged.get(hash);
      if (!staged) continue;
      if (await this.owner.objectExists(this.owner.blobKey(hash), "promote")) {
        await this.owner.assertExistingCanonical(hash, staged.meta.byteLength, "promote");
        if (!createdSet.has(hash)) {
          this.created.push(hash);
          createdSet.add(hash);
        }
        continue;
      }
      const outcome = await this.owner.copyCanonicalObject(
        staged.key,
        hash,
        staged.meta.byteLength,
        "promote",
      );
      if (outcome === "applied") {
        if (!createdSet.has(hash)) {
          this.created.push(hash);
          createdSet.add(hash);
        }
        continue;
      }
      if (outcome === "unknown") this.ownershipUnknown = true;
      throw new S3EvidenceError("promote", "unavailable");
    }
    this.ownershipUnknown = false;
    this.promoted = true;
  }

  async rollback(): Promise<void> {
    if (this.cleanupComplete) return;
    await this.runExclusiveCleanup(async () => {
      const inspections: Array<{ hash: ContentHash; inspection: "match" | "absent" | "mismatch" | "unknown" }> = [];
      for (const hash of this.created) {
        const staged = this.staged.get(hash);
        if (!staged) continue;
        inspections.push({
          hash,
          inspection: await this.owner.inspectCanonical(hash, staged.meta.byteLength),
        });
      }
      const retainJournal =
        this.ownershipUnknown
        || inspections.some((entry) => entry.inspection === "unknown" || entry.inspection === "mismatch");
      if (!retainJournal) {
        for (const entry of [...inspections].reverse()) {
          if (entry.inspection === "match") {
            await this.owner.deleteObject("rollback", this.owner.blobKey(entry.hash));
          }
        }
      }
      await this.deleteStagingResidue("rollback");
      if (this.journalId && !retainJournal) {
        await this.owner.deletePendingJournal(this.journalId, "rollback");
        this.journalId = null;
      }
    });
  }

  async finalize(options?: EvidenceFinalizeOptions): Promise<void> {
    if (this.cleanupComplete) return;
    await this.runExclusiveCleanup(async () => {
      await this.deleteStagingResidue("finalize");
      if (!options?.retainPendingJournal && this.journalId) {
        await this.owner.deletePendingJournal(this.journalId, "finalize");
        this.journalId = null;
      }
    });
  }

  async abandonForCrashTest(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseLock();
  }

  private async deleteStagingResidue(operation: string): Promise<void> {
    for (const staged of this.staged.values()) {
      await this.owner.deleteObjectBestEffort(operation, staged.key);
    }
    await this.owner.deletePrefix(operation, this.owner.batchStagingPrefix(this.scopeId));
  }

  private async runExclusiveCleanup(fn: () => Promise<void>): Promise<void> {
    let freshRelease: (() => Promise<void>) | undefined;
    if (this.released) {
      freshRelease = await this.owner.acquireOwnerWriteLock();
    }
    let cleanupError: unknown;
    try {
      await fn();
      this.cleanupComplete = true;
    } catch (error) {
      cleanupError = error;
    }
    let releaseError: unknown;
    try {
      if (freshRelease) {
        await freshRelease();
      } else {
        await this.release();
      }
    } catch (error) {
      releaseError = error;
    }
    if (cleanupError) throw cleanupError;
    if (releaseError) throw releaseError;
  }

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseLock();
  }
}

/**
 * Test helper: release the exclusive write lock while leaving promoted bytes
 * and the pending-write journal in place, as a process crash after promote
 * and before COMMIT would.
 */
export async function abandonS3WriteBatchForCrashTest(batch: EvidenceWriteBatch): Promise<void> {
  if (!(batch instanceof S3EvidenceWriteBatch)) {
    throw new Error("crash abandonment is only defined for S3 evidence batches");
  }
  await batch.abandonForCrashTest();
}

function blobMeta(hash: ContentHash, bytes: Uint8Array, contentType?: string): BlobMetaV1 {
  return {
    hash,
    byteLength: bytes.byteLength,
    contentType: contentType ?? null,
  };
}

function userMetadata(meta: BlobMetaV1): Record<string, string> {
  return {
    [METADATA_SHA256]: meta.hash,
    [METADATA_BYTE_LENGTH]: String(meta.byteLength),
    [METADATA_CONTENT_TYPE]: meta.contentType ?? "",
  };
}

function trustedBlobMeta(
  output: Record<string, unknown>,
  expectedHash: ContentHash,
  operation: string,
): BlobMetaV1 {
  const contentLength = numericLength(output.ContentLength);
  const metadata = lowercaseMetadata(output.Metadata);
  if (contentLength === undefined || metadata === null) {
    throw new S3EvidenceError(operation, "inconsistent metadata");
  }
  const sha = metadata[METADATA_SHA256];
  const lengthRaw = metadata[METADATA_BYTE_LENGTH];
  const contentTypeRaw = metadata[METADATA_CONTENT_TYPE];
  if (
    sha === undefined ||
    lengthRaw === undefined ||
    contentTypeRaw === undefined ||
    !isContentHash(sha) ||
    sha !== expectedHash ||
    !/^[0-9]+$/.test(lengthRaw)
  ) {
    throw new S3EvidenceError(operation, "inconsistent metadata");
  }
  const byteLength = Number(lengthRaw);
  if (!Number.isSafeInteger(byteLength) || byteLength !== contentLength) {
    throw new S3EvidenceError(operation, "inconsistent metadata");
  }
  if (
    contentTypeRaw !== ""
    && (typeof output.ContentType !== "string" || output.ContentType !== contentTypeRaw)
  ) {
    throw new S3EvidenceError(operation, "inconsistent metadata");
  }
  return {
    hash: sha,
    byteLength,
    contentType: contentTypeRaw === "" ? null : contentTypeRaw,
  };
}

function lowercaseMetadata(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return null;
    out[key.toLowerCase()] = entry;
  }
  return out;
}

async function readObjectBytes(
  body: unknown,
  contentLength: number | undefined,
  operation: string,
  idleTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (contentLength === undefined) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  if (body == null) {
    if (contentLength === 0) return new Uint8Array();
    throw new S3EvidenceError(operation, "unavailable");
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength !== contentLength) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    return new Uint8Array(body);
  }
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for await (const chunk of iterateObjectBody(body, operation, signal, idleTimeoutMs)) {
        if (chunk.byteLength === 0) continue;
        if (received + chunk.byteLength > contentLength) {
          throw new S3EvidenceError(operation, "inconsistent object");
        }
        chunks.push(chunk);
        received += chunk.byteLength;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
    if (received !== contentLength) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    return concatBytes(chunks, received);
  }
  // Production AWS SDK response bodies are Uint8Array or async iterable. A
  // transform-only body cannot be cancelled reliably if its Promise stalls,
  // so fail closed instead of creating an unbounded body-read seam.
  throw new S3EvidenceError(operation, "unavailable");
}

async function readBoundedObjectBytes(
  body: unknown,
  contentLength: number | undefined,
  maxBytes: number,
  operation: string,
  idleTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const malformed = boundedReadFailure(operation);
  if (contentLength === undefined || contentLength > maxBytes) {
    throw new S3EvidenceError(operation, malformed);
  }
  const limit = Math.min(contentLength, maxBytes);
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit) {
      throw new S3EvidenceError(operation, malformed);
    }
    if (body.byteLength !== contentLength) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    return new Uint8Array(body);
  }
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for await (const chunk of iterateObjectBody(body, operation, signal, idleTimeoutMs)) {
        if (chunk.byteLength === 0) continue;
        if (received + chunk.byteLength > limit) {
          throw new S3EvidenceError(
            operation,
            received + chunk.byteLength > maxBytes ? malformed : "inconsistent object",
          );
        }
        chunks.push(chunk);
        received += chunk.byteLength;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
    if (received !== contentLength) {
      throw new S3EvidenceError(operation, "inconsistent object");
    }
    return concatBytes(chunks, received);
  }
  throw new S3EvidenceError(operation, "unavailable");
}

function boundedReadFailure(operation: string): string {
  return operation === "getFileServerReference"
    || operation === "putFileServerReference"
    || operation === "verifyFileServerReference"
    || operation === "restoreFileServerReference"
    ? "malformed file-server reference"
    : "malformed pending write journal";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseStoredReference(
  bytes: Uint8Array,
  expectedId: string,
  operation: string,
): FileServerReferenceV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), jsonReviver) as unknown;
  } catch {
    throw new S3EvidenceError(operation, "malformed file-server reference");
  }
  const ref = parsedFileServerReference(parsed, operation);
  if (ref.id !== expectedId) {
    throw new S3EvidenceError(operation, "malformed file-server reference");
  }
  if (ref.expectedHash !== null && !isContentHash(ref.expectedHash)) {
    throw new S3EvidenceError(operation, "malformed file-server reference");
  }
  return ref;
}

function parsedFileServerReference(raw: unknown, operation: string): FileServerReferenceV1 {
  try {
    return parseFileServerReference(raw);
  } catch {
    throw new S3EvidenceError(operation, "malformed file-server reference");
  }
}

function jsonReviver(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new Error("unsafe");
  }
  return value;
}

function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof record.name === "string" ? record.name : "";
  const code =
    typeof record.Code === "string"
      ? record.Code
      : typeof record.code === "string"
        ? record.code
        : "";
  if (name === "NoSuchBucket" || code === "NoSuchBucket") return false;
  return record.$metadata?.httpStatusCode === 404
    && (OBJECT_NOT_FOUND.has(name) || OBJECT_NOT_FOUND.has(code));
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof record.name === "string" ? record.name : "";
  const code =
    typeof record.Code === "string"
      ? record.Code
      : typeof record.code === "string"
        ? record.code
        : "";
  return record.$metadata?.httpStatusCode === 412
    && (name === "PreconditionFailed" || code === "PreconditionFailed");
}

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof S3EvidenceError
    && (
      error.message.endsWith("inconsistent metadata")
      || error.message.endsWith("inconsistent object")
      || error.message.endsWith("failed verification")
      || error.message.endsWith("object changed")
    );
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new S3EvidenceError(operation, "unavailable");
  }
  return value as Record<string, unknown>;
}

function numericLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function* iterateIntakeChunks(args: {
  iterator: AsyncIterator<Uint8Array>;
  opts: EvidenceStreamOptions;
  hasher: ReturnType<typeof createHash>;
  onBytes: (byteLength: number) => void;
  onFinished: () => void;
  onError: (error: unknown) => void;
}): AsyncGenerator<Uint8Array, void, undefined> {
  let byteLength = 0;
  let finished = false;
  try {
    while (true) {
      const next = await nextWithAbort(args.iterator, args.opts.signal);
      if (next.done) {
        finished = true;
        args.onFinished();
        break;
      }
      throwIfAborted(args.opts.signal);
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("evidence stream chunk must be a Uint8Array");
      }
      if (chunk.byteLength === 0) {
        throw new Error("evidence stream chunk must not be empty");
      }
      const nextLength = byteLength + chunk.byteLength;
      if (nextLength > args.opts.maxBytes) {
        throw new Error("evidence stream exceeded maxBytes");
      }
      const stableChunk = Uint8Array.from(chunk);
      args.hasher.update(stableChunk);
      byteLength = nextLength;
      args.onBytes(byteLength);
      yield stableChunk;
    }
    throwIfAborted(args.opts.signal);
    if (
      args.opts.expectedLength !== undefined
      && byteLength !== args.opts.expectedLength
    ) {
      throw new Error("evidence stream length did not match expectedLength");
    }
  } catch (error) {
    args.onError(error);
    throw error;
  } finally {
    if (!finished) {
      try {
        if (typeof args.iterator.return === "function") {
          void Promise.resolve(args.iterator.return()).catch(() => undefined);
        }
      } catch {
        // A hostile source cannot suppress scratch cleanup.
      }
      args.onFinished();
    }
  }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe nonnegative integer`);
  }
}

function validatedResponseBodyIdleTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new S3EvidenceError("configure", "invalid responseBodyIdleTimeoutMs");
  }
  return value;
}

function assertAbortSignal(signal: AbortSignal): void {
  if (typeof signal !== "object" || signal === null || typeof signal.aborted !== "boolean") {
    throw new Error("signal must be an AbortSignal");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error("evidence stream aborted");
  }
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  throwIfAborted(signal);
  if (!signal) return iterator.next();
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(signal.reason ?? new Error("evidence stream aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let next: Promise<IteratorResult<T>>;
    try {
      next = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void next.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function parseObjectEtag(value: unknown, operation: string): string {
  if (typeof value !== "string" || value === "") {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  return value;
}

function hasContentRange(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function parseInclusiveContentRange(
  value: unknown,
  operation: string,
): { start: number; end: number; total: number } {
  if (typeof value !== "string") {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total < 0
  ) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  return { start, end, total };
}

function terminateGetObjectBody(body: unknown, reason?: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy === "function") {
    try {
      (destroy as (error?: Error) => void).call(
        body,
        reason instanceof Error ? reason : undefined,
      );
    } catch {
      // Hostile destroy cannot block abort/idle cleanup.
    }
    return;
  }
  const cancel = (body as { cancel?: unknown }).cancel;
  if (typeof cancel === "function") {
    try {
      void Promise.resolve(
        (cancel as (error?: Error) => unknown).call(
          body,
          reason instanceof Error ? reason : undefined,
        ),
      ).catch(() => undefined);
    } catch {
      // Hostile cancel cannot block abort/idle cleanup.
    }
  }
}

function cancelGetObjectIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Never await a hostile iterator.return on abort/idle/error.
  }
}

async function nextGetObjectChunk<T>(
  iterator: AsyncIterator<T>,
  opts: {
    operation: string;
    signal: AbortSignal | undefined;
    idleTimeoutMs: number | undefined;
    idleDeadline: number | undefined;
  },
): Promise<IteratorResult<T>> {
  throwIfAborted(opts.signal);
  if (opts.signal === undefined && opts.idleTimeoutMs === undefined) {
    return iterator.next();
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = opts.signal;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = signal?.reason;
      if (reason instanceof Error) {
        finish(() => reject(reason));
        return;
      }
      if (reason !== undefined) {
        finish(() => reject(reason));
        return;
      }
      finish(() => reject(new Error("evidence stream aborted")));
    };
    const onIdle = (): void => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      finish(() => reject(new S3EvidenceError(opts.operation, "unavailable")));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (opts.idleTimeoutMs !== undefined) {
      const now = Date.now();
      const deadline = opts.idleDeadline ?? now + opts.idleTimeoutMs;
      const remaining = deadline - now;
      if (remaining <= 0) {
        onIdle();
      } else {
        idleTimer = setTimeout(onIdle, remaining);
      }
    }
    if (settled) return;
    let next: Promise<IteratorResult<T>>;
    try {
      next = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void next.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal?.aborted) onAbort();
  });
}

async function* iterateObjectBody(
  body: unknown,
  operation: string,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  throwIfAborted(signal);
  if (body == null) return;
  if (body instanceof Uint8Array) {
    yield Uint8Array.from(body);
    return;
  }
  if (!isAsyncIterable(body)) {
    throw new S3EvidenceError(operation, "unavailable");
  }
  const iterator = body[Symbol.asyncIterator]();
  let idleDeadline: number | undefined;
  let completed = false;
  let failureReason: unknown;
  try {
    for (;;) {
      const now = Date.now();
      const deadline =
        idleTimeoutMs === undefined ? undefined : idleDeadline ?? now + idleTimeoutMs;
      const next = await nextGetObjectChunk(iterator, {
        operation,
        signal,
        idleTimeoutMs,
        idleDeadline: deadline,
      });
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new S3EvidenceError(operation, "unavailable");
      }
      throwIfAborted(signal);
      if (chunk.byteLength === 0) {
        // Empty chunks are not progress. Keep the same absolute deadline and
        // immediately await the next chunk without exposing caller work time.
        idleDeadline = deadline;
        continue;
      }
      idleDeadline = undefined;
      yield Uint8Array.from(chunk);
    }
  } catch (error) {
    failureReason = signal?.aborted ? signal.reason ?? error : error;
    if (signal?.aborted) {
      throwIfAborted(signal);
      throw error;
    }
    if (error instanceof S3EvidenceError) throw error;
    throw new S3EvidenceError(operation, "unavailable");
  } finally {
    if (!completed) {
      terminateGetObjectBody(body, failureReason);
      cancelGetObjectIterator(iterator);
    }
  }
}

async function hashBodyExact(
  body: unknown,
  expectedLength: number,
  expectedHash: ContentHash,
  operation: string,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): Promise<void> {
  throwIfAborted(signal);
  const hasher = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of iterateObjectBody(body, operation, signal, idleTimeoutMs)) {
      throwIfAborted(signal);
      if (chunk.byteLength === 0) continue;
      if (received + chunk.byteLength > expectedLength) {
        throw new S3EvidenceError(operation, "inconsistent object");
      }
      const stable = Uint8Array.from(chunk);
      hasher.update(stable);
      received += stable.byteLength;
    }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof S3EvidenceError) throw error;
    throw new S3EvidenceError(operation, "unavailable");
  }
  if (received !== expectedLength) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  if (hasher.digest("hex") !== expectedHash) {
    throw new S3EvidenceError(operation, "failed verification");
  }
  throwIfAborted(signal);
}

function requiredToken(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new S3EvidenceError("configure", `requires ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new S3EvidenceError("configure", `requires ${field}`);
  }
  return trimmed;
}

function completeStaticCredentials(
  opts: S3EvidenceStoreOptions,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
  const accessSupplied = opts.accessKeyId !== undefined;
  const secretSupplied = opts.secretAccessKey !== undefined;
  const sessionSupplied = opts.sessionToken !== undefined;
  if (!accessSupplied && !secretSupplied && !sessionSupplied) return undefined;
  if (accessSupplied !== secretSupplied || (sessionSupplied && !(accessSupplied && secretSupplied))) {
    throw new S3EvidenceError("configure", "requires a complete credential pair");
  }
  const accessKeyId = requiredToken(opts.accessKeyId as string, "accessKeyId");
  const secretAccessKey = requiredToken(opts.secretAccessKey as string, "secretAccessKey");
  if (!sessionSupplied) return { accessKeyId, secretAccessKey };
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: requiredToken(opts.sessionToken as string, "sessionToken"),
  };
}

function normalizeBucket(value: string): string {
  const bucket = requiredToken(value, "bucket").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(bucket) || bucket.includes("..")) {
    throw new S3EvidenceError("configure", "requires bucket");
  }
  return bucket;
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined) return "";
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.includes("\\") || trimmed.includes("\0") || trimmed.includes("://")) {
    throw new S3EvidenceError("configure", "invalid prefix");
  }
  const stripped = trimmed.replace(/^\/+|\/+$/g, "");
  if (stripped === "") return "";
  const segments = stripped.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new S3EvidenceError("configure", "invalid prefix");
    }
  }
  return stripped;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") throw new S3EvidenceError("configure", "invalid endpoint");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new S3EvidenceError("configure", "invalid endpoint");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new S3EvidenceError("configure", "invalid endpoint");
  }
  if (url.username || url.search !== "" || url.hash !== "" || !url.hostname) {
    throw new S3EvidenceError("configure", "invalid endpoint");
  }
  const authority = endpointAuthority(trimmed);
  if (authority.includes("@")) {
    throw new S3EvidenceError("configure", "invalid endpoint");
  }
  return trimmed.replace(/\/+$/g, "");
}

function endpointAuthority(raw: string): string {
  const scheme = raw.indexOf("://");
  const rest = scheme >= 0 ? raw.slice(scheme + 3) : raw;
  const end = rest.search(/[/?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function assertContentHash(hash: string, operation: string): asserts hash is ContentHash {
  if (!isContentHash(hash)) {
    throw new S3EvidenceError(operation, "invalid content hash");
  }
}

function assertedExpectedHash(
  value: ContentHash | null | undefined,
  operation: string,
): ContentHash | null {
  if (value === undefined || value === null) return null;
  if (!isContentHash(value)) {
    throw new S3EvidenceError(operation, "invalid content hash");
  }
  return value;
}

function assertFileRefId(id: string): void {
  if (!FILE_REF_ID_RE.test(id)) {
    throw new Error("invalid file-server reference id");
  }
}

function assertMetadataValue(value: string, operation: string): void {
  if (value.length > 1024 || !ASCII_PRINTABLE.test(value)) {
    throw new S3EvidenceError(operation, "invalid metadata");
  }
}
