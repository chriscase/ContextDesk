import { randomUUID } from "node:crypto";
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
  type EvidenceStage,
  type EvidenceStore,
  type EvidenceWriteBatch,
  type EvidenceWriteRecoveryReport,
} from "./store.js";

export interface S3EvidenceClient {
  send(command: unknown): Promise<unknown>;
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
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3EvidenceClient;
  private readonly acquireWriteLease:
    | (() => Promise<() => void | Promise<void>>)
    | undefined;
  private readonly referencedSources: Array<() => Promise<Iterable<string>>> = [];
  private readonly digestTails = new Map<string, Promise<void>>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(opts: S3EvidenceStoreOptions) {
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
      const hashes = referenced ?? (this.referencedSources.length > 0
        ? await this.loadBoundReferencedHashes()
        : null);
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
    let releaseWrite: (() => Promise<void>) | null = null;
    let existing = false;
    try {
      releaseWrite = await this.acquireWriteLock();
      const head = await this.head(hash);
      if (head) {
        await this.assertExistingCanonical(hash, bytes.byteLength);
        existing = true;
      }
    } catch (error) {
      if (releaseWrite) await releaseWrite();
      releaseDigest();
      throw error;
    }
    const stagingObjectKey = existing ? null : this.prefixed(`staging/${randomUUID()}`);
    try {
      if (stagingObjectKey) {
        await this.putObject(stagingObjectKey, bytes, meta, "stage");
      }
    } catch (error) {
      if (releaseWrite) await releaseWrite();
      releaseDigest();
      throw error;
    }
    let committed = existing;
    let created = false;
    let released = false;
    const canonicalKey = this.blobKey(hash);
    return {
      meta,
      commit: async () => {
        if (committed) return;
        if (!stagingObjectKey) throw new S3EvidenceError("commit", "unavailable");
        const already = await this.head(hash);
        if (already) {
          await this.assertExistingCanonical(hash, bytes.byteLength);
          committed = true;
          await this.deleteObjectBestEffort("commit", stagingObjectKey);
          return;
        }
        await this.copyObject(stagingObjectKey, canonicalKey, "commit");
        created = true;
        committed = true;
        await this.deleteObjectBestEffort("commit", stagingObjectKey);
      },
      rollback: async () => {
        if (stagingObjectKey) await this.deleteObject("rollback", stagingObjectKey);
        if (created) {
          await this.deleteObject("rollback", canonicalKey);
          committed = false;
          created = false;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        releaseDigest();
        // EvidenceStage.release is synchronous. Queue the possibly-async external
        // lease release; the in-process write tail remains blocked until it settles.
        void releaseWrite?.().catch(() => undefined);
      },
    };
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    assertContentHash(hash, "get");
    return this.getObject(this.blobKey(hash), "get");
  }

  async head(hash: ContentHash): Promise<BlobMetaV1 | null> {
    assertContentHash(hash, "head");
    try {
      const output = await this.sendAllowMissing(
        "head",
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.blobKey(hash) }),
      );
      if (output === null) return null;
      return trustedBlobMeta(asRecord(output, "head"), hash, "head");
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError("head", "unavailable");
    }
  }

  async verify(hash: ContentHash): Promise<boolean> {
    assertContentHash(hash, "verify");
    try {
      const bytes = await this.get(hash);
      if (!bytes || sha256Hex(bytes) !== hash) return false;
      const meta = await this.head(hash);
      if (!meta || meta.hash !== hash || meta.byteLength !== bytes.byteLength) return false;
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

  batchStagingPrefix(scopeId: string): string {
    return this.prefixed(`.staging/${scopeId}/`);
  }

  pendingPrefix(): string {
    return this.prefixed(".pending/");
  }

  stagingResiduePrefix(): string {
    return this.prefixed(".staging/");
  }

  directStagingResiduePrefix(): string {
    return this.prefixed("staging/");
  }

  async writePendingJournal(id: string, hashes: readonly ContentHash[]): Promise<void> {
    if (!PENDING_JOURNAL_ID_RE.test(id)) {
      throw new S3EvidenceError("promote", "invalid pending write journal id");
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
      throw new S3EvidenceError("promote", "pending write journal exceeds bound");
    }
    await this.send(
      "promote",
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
      return await readObjectBytes(record.Body, numericLength(record.ContentLength), operation);
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
      return await readBoundedObjectBytes(record.Body, contentLength, MAX_JOURNAL_BYTES, operation);
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
    do {
      const input: { Bucket: string; Prefix: string; ContinuationToken?: string } = {
        Bucket: this.bucket,
        Prefix: prefix,
      };
      if (token !== undefined) input.ContinuationToken = token;
      const output = asRecord(await this.send(operation, new ListObjectsV2Command(input)), operation);
      const contents = output.Contents;
      if (contents !== undefined) {
        if (!Array.isArray(contents)) {
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
        }
      }
      if (output.IsTruncated === true) {
        const next = output.NextContinuationToken;
        if (typeof next !== "string" || next === "") {
          throw new S3EvidenceError(operation, "unavailable");
        }
        if (seenTokens.has(next)) {
          throw new S3EvidenceError(operation, "unavailable");
        }
        seenTokens.add(next);
        token = next;
      } else {
        token = undefined;
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
    const bytes = await this.get(hash);
    if (!bytes || sha256Hex(bytes) !== hash) {
      throw new S3EvidenceError(
        operation,
        "existing content-addressed evidence failed verification",
      );
    }
    const meta = await this.head(hash);
    if (!meta || meta.byteLength !== byteLength || meta.hash !== hash) {
      throw new S3EvidenceError(operation, "inconsistent metadata");
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
      for (const hash of parsed.hashes) {
        if (typeof hash !== "string" || !isContentHash(hash) || referenced.has(hash)) {
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
    return { reclaimed, journals };
  }

  private async send(operation: string, command: unknown): Promise<unknown> {
    try {
      return await this.client.send(command);
    } catch (error) {
      if (error instanceof S3EvidenceError) throw error;
      throw new S3EvidenceError(operation, "unavailable");
    }
  }

  private async sendAllowMissing(operation: string, command: unknown): Promise<unknown | null> {
    try {
      return await this.client.send(command);
    } catch (error) {
      if (isObjectNotFound(error)) return null;
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
    } catch (error) {
      release();
      throw error;
    }
    return async () => {
      try {
        await releaseLease?.();
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
  private promoted = false;
  private journalId: string | null = null;

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

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    const staged = this.staged.get(hash);
    if (staged && !this.promoted) {
      return this.owner.getObject(staged.key, "get");
    }
    return this.owner.get(hash);
  }

  async head(hash: ContentHash): Promise<BlobMetaV1 | null> {
    const staged = this.staged.get(hash);
    if (staged && !this.promoted) return staged.meta;
    return this.owner.head(hash);
  }

  async verify(hash: ContentHash): Promise<boolean> {
    try {
      const bytes = await this.get(hash);
      if (bytes === null || sha256Hex(bytes) !== hash) return false;
      const meta = await this.head(hash);
      if (!meta || meta.hash !== hash || meta.byteLength !== bytes.byteLength) return false;
      return true;
    } catch (error) {
      if (isIntegrityFailure(error)) return false;
      throw error;
    }
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
    const createdHashes: ContentHash[] = [];
    for (const [hash] of this.staged) {
      if (!(await this.owner.objectExists(this.owner.blobKey(hash), "promote"))) {
        createdHashes.push(hash);
      }
    }
    if (createdHashes.length > 0) {
      this.journalId = randomUUID();
      await this.owner.writePendingJournal(this.journalId, createdHashes);
    }
    for (const hash of createdHashes) {
      const staged = this.staged.get(hash);
      if (!staged) continue;
      await this.owner.copyObject(staged.key, this.owner.blobKey(hash), "promote");
      this.created.push(hash);
    }
    this.promoted = true;
  }

  async rollback(): Promise<void> {
    if (this.released) return;
    try {
      for (const hash of [...this.created].reverse()) {
        await this.owner.deleteObject("rollback", this.owner.blobKey(hash));
      }
      await this.deleteStagingResidue("rollback");
      if (this.journalId) {
        await this.owner.deletePendingJournal(this.journalId, "rollback");
        this.journalId = null;
      }
    } finally {
      await this.release();
    }
  }

  async finalize(options?: EvidenceFinalizeOptions): Promise<void> {
    if (this.released) return;
    try {
      await this.deleteStagingResidue("finalize");
      if (!options?.retainPendingJournal && this.journalId) {
        await this.owner.deletePendingJournal(this.journalId, "finalize");
        this.journalId = null;
      }
    } catch {
      // Committed evidence remains canonical; stale scratch cleanup is best effort.
    } finally {
      await this.release();
    }
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
): Promise<Uint8Array> {
  if (contentLength === undefined) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  if (body == null) {
    if (contentLength === 0) return new Uint8Array();
    throw new S3EvidenceError(operation, "unavailable");
  }
  let bytes: Uint8Array | null = null;
  if (body instanceof Uint8Array) bytes = new Uint8Array(body);
  else if (
    typeof body === "object" &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function"
  ) {
    const raw = await (body as { transformToByteArray: () => Promise<unknown> }).transformToByteArray();
    if (raw instanceof Uint8Array) bytes = new Uint8Array(raw);
  }
  if (bytes === null) throw new S3EvidenceError(operation, "unavailable");
  if (bytes.byteLength !== contentLength) {
    throw new S3EvidenceError(operation, "inconsistent object");
  }
  return bytes;
}

async function readBoundedObjectBytes(
  body: unknown,
  contentLength: number | undefined,
  maxBytes: number,
  operation: string,
): Promise<Uint8Array> {
  if (contentLength === undefined || contentLength > maxBytes) {
    throw new S3EvidenceError(
      operation,
      operation === "getFileServerReference" || operation === "putFileServerReference"
        || operation === "verifyFileServerReference" || operation === "restoreFileServerReference"
        ? "malformed file-server reference"
        : "malformed pending write journal",
    );
  }
  const bytes = await readObjectBytes(body, contentLength, operation);
  if (bytes.byteLength > maxBytes) {
    throw new S3EvidenceError(
      operation,
      operation === "recoverUnreferencedWrites" ? "malformed pending write journal" : "malformed file-server reference",
    );
  }
  return bytes;
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

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof S3EvidenceError
    && (
      error.message.endsWith("inconsistent metadata")
      || error.message.endsWith("inconsistent object")
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
