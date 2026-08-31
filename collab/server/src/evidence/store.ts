import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FILE_SERVER_REF_SCHEMA_ID,
  type BlobMetaV1,
  type ContentHash,
  type FileServerReferenceV1,
  type VerificationStatus,
} from "@cd-collab/contracts";

/**
 * Pluggable evidence store: content-addressed local bytes plus first-class
 * controlled file-server references.
 *
 * Immutability: `put` is content-addressed (hash is identity); overwrites of an
 * existing hash are no-ops. Deletion is intentionally absent here — later domain
 * work must leave an auditable stub (see interface docs in README).
 *
 * File-server references stay references: this store never silently fetches or
 * caches remote bytes. Verification against an expected hash is an explicit,
 * recorded operation supplied with bytes by the caller (or marked unreachable).
 */
export interface EvidenceStore {
  readonly writeCoordination?: "single_process" | "external";
  put(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1>;
  stage(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<EvidenceStage>;
  /**
   * Stream bytes into an opaque scratch object without holding the global write
   * lease. Promotion is a separate, lock-acquiring step on the returned stage.
   */
  stageStream(
    source: AsyncIterable<Uint8Array>,
    opts: EvidenceStreamOptions,
  ): Promise<EvidenceStreamStage>;
  get(hash: ContentHash): Promise<Uint8Array | null>;
  head(hash: ContentHash, signal?: AbortSignal): Promise<BlobMetaV1 | null>;
  /**
   * Open a verified byte range as an exact-count async iterable. Fail closed on
   * missing/corrupt meta, digest mismatch, truncation, or concurrent size change.
   * No URLs or ETags — content hash is the only address.
   */
  openRead(
    hash: ContentHash,
    range?: EvidenceReadRange,
    signal?: AbortSignal,
  ): Promise<EvidenceReadHandle>;
  /** Re-hash on-disk bytes; returns false (fail closed) on missing or mutated blob. */
  verify(hash: ContentHash): Promise<boolean>;

  putFileServerReference(input: {
    uri: string;
    expectedHash?: ContentHash | null;
    verificationStatus?: VerificationStatus;
  }): Promise<FileServerReferenceV1>;
  getFileServerReference(id: string): Promise<FileServerReferenceV1 | null>;
  /**
   * Explicit verification. Pass `actualBytes` when the caller has retrieved
   * them out-of-band; omit to record `unreachable` without caching remote data.
   * Never silently upgrades a never-hashed ref to verified.
   */
  verifyFileServerReference(
    id: string,
    actualBytes?: Uint8Array,
  ): Promise<FileServerReferenceV1>;

  /**
   * Remove a file-server reference that was never paired with durable artifact
   * metadata. This is compensating rollback, not general evidence deletion.
   */
  abandonFileServerReference(id: string): Promise<void>;
  /**
   * Restore a previously read file-server reference after a failed pairing
   * with timeline/audit. Not general evidence mutation.
   */
  restoreFileServerReference(ref: FileServerReferenceV1): Promise<void>;

  /** Readiness probe for the byte backend. */
  ping(): Promise<void>;

  /**
   * Begin an exclusive staged write batch. Implementations that cannot provide
   * rollback-safe promotion omit this method; portable apply then fails closed.
   */
  beginWriteBatch?(): Promise<EvidenceWriteBatch>;

  /**
   * Register durable domain rows that may reference content-addressed hashes.
   * Recovery uses the union of every source so unreferenced crash residue can
   * be reclaimed without deleting a later retry or a successful COMMIT.
   */
  addReferencedContentHashSource?(loader: () => Promise<Iterable<string>>): void;

  /**
   * Reclaim hashes recorded in pending-write journals that no durable domain
   * row references. Implementations without journals omit this method.
   */
  recoverUnreferencedWrites?(
    referenced?: ReadonlySet<string>,
  ): Promise<EvidenceWriteRecoveryReport>;
}

/** Options for provider-neutral streaming evidence intake. */
export interface EvidenceStreamOptions {
  contentType?: string;
  /** Reject the stream once more than this many bytes have been accepted. */
  maxBytes: number;
  /** When set, the authoritative byte length must match after the source ends. */
  expectedLength?: number;
  signal?: AbortSignal;
}

/**
 * Staged streaming write. `meta` is authoritative for the scratched bytes.
 * Repeated promotion before settlement and repeated settlement with the same
 * mode/options are idempotent. Settlement is terminal and only promotion
 * acquires write coordination locks.
 */
export interface EvidenceStreamStage {
  readonly meta: BlobMetaV1;
  promote(): Promise<void>;
  rollback(): Promise<void>;
  finalize(options?: EvidenceFinalizeOptions): Promise<void>;
}

/** Inclusive byte range over a content-addressed blob. */
export interface EvidenceReadRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Verified read handle. `byteLength` is the exact count `bytes` will emit.
 * No URLs or ETags — callers address content solely by hash + range.
 */
export interface EvidenceReadHandle {
  readonly meta: BlobMetaV1;
  /** Null means the complete blob, including a valid zero-byte blob. */
  readonly range: EvidenceReadRange | null;
  readonly byteLength: number;
  /** Treat successful iteration completion as the integrity boundary. */
  bytes(): AsyncIterable<Uint8Array>;
}

export interface EvidenceFinalizeOptions {
  /**
   * Keep the pending-write journal after releasing the lock. Used when the
   * surrounding database COMMIT outcome is unknown so a later recovery pass
   * can reclaim unreferenced hashes or drop the journal once rows exist.
   */
  retainPendingJournal?: boolean;
}

export interface EvidenceWriteRecoveryReport {
  reclaimed: ContentHash[];
  journals: number;
}

export interface EvidenceWriteBatch extends EvidenceStore {
  /** Promote staged bytes while retaining the exclusive write lock. */
  promote(): Promise<void>;
  /** Remove staged/promoted bytes and release the exclusive write lock. */
  rollback(): Promise<void>;
  /** Keep promoted bytes, clean scratch state, and release the write lock. */
  finalize(options?: EvidenceFinalizeOptions): Promise<void>;
}

export interface EvidenceStage {
  readonly meta: BlobMetaV1;
  /** Make staged bytes visible at their immutable content address. */
  commit(): Promise<void>;
  /** Remove staging state and any final object created by this stage. */
  rollback(): Promise<void>;
  /** Release the per-digest lifecycle lock after the surrounding transaction settles. */
  release(): void;
}

export function sha256Hex(bytes: Uint8Array): ContentHash {
  return createHash("sha256").update(bytes).digest("hex");
}

export const EVIDENCE_PENDING_WRITE_SCHEMA_ID = "cd.evidence.pending_write.v1";

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const PENDING_JOURNAL_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const PENDING_JOURNAL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isContentHash(value: string): value is ContentHash {
  return CONTENT_HASH_RE.test(value);
}

function blobPath(root: string, hash: ContentHash): string {
  return join(root, "blobs", hash.slice(0, 2), hash);
}

function metaPath(root: string, hash: ContentHash): string {
  return join(root, "blobs", hash.slice(0, 2), `${hash}.meta.json`);
}

function refPath(root: string, id: string): string {
  return join(root, "refs", `${id}.json`);
}

function pendingDir(root: string): string {
  return join(root, ".pending");
}

function stagingDir(root: string): string {
  return join(root, ".staging");
}

function streamStagingDir(root: string): string {
  return join(root, ".stream-staging");
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a safe nonnegative integer`);
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

async function writeChunkFully(
  handle: FileHandle,
  chunk: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    throwIfAborted(signal);
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("evidence stream write made no progress");
    }
    offset += bytesWritten;
  }
  throwIfAborted(signal);
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertSameFileSnapshot(
  left: FileSnapshot,
  right: FileSnapshot,
  message: string,
): void {
  if (!sameFileSnapshot(left, right)) throw new Error(message);
}

async function writeFileDurable(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is best-effort; the journal file itself is already durable.
  }
}

export interface FilesystemEvidenceStoreOptions {
  rootDir: string;
  acquireWriteLease?: () => Promise<() => void | Promise<void>>;
}

/**
 * v1 byte-storage backend: filesystem beside the database.
 *
 * Decision criteria (see collab/README.md):
 * - Backup story: volume snapshot + pg dump; bytes and DB stay separable.
 * - Size ceiling: no PostgreSQL large-object practical limits for big attachments.
 * - Ops simplicity: ordinary files, easy inspection, clear path to object storage later.
 */
export class FilesystemEvidenceStore implements EvidenceStore {
  readonly rootDir: string;
  private readonly stageTails = new Map<string, Promise<void>>();
  private readonly activeStreamStages = new Set<string>();
  readonly writeCoordination: "single_process" | "external";
  private writeTail: Promise<void> = Promise.resolve();
  private readonly acquireWriteLease:
    | (() => Promise<() => void | Promise<void>>)
    | undefined;
  private readonly referencedSources: Array<() => Promise<Iterable<string>>> = [];

  constructor(opts: FilesystemEvidenceStoreOptions) {
    this.rootDir = opts.rootDir;
    this.acquireWriteLease = opts.acquireWriteLease;
    this.writeCoordination = opts.acquireWriteLease ? "external" : "single_process";
  }

  addReferencedContentHashSource(loader: () => Promise<Iterable<string>>): void {
    this.referencedSources.push(loader);
  }

  async ping(): Promise<void> {
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await mkdir(join(this.rootDir, "refs"), { recursive: true });
    await mkdir(pendingDir(this.rootDir), { recursive: true });
  }

  async beginWriteBatch(): Promise<EvidenceWriteBatch> {
    const release = await this.acquireWriteLock();
    try {
      await this.ping();
      if (this.referencedSources.length > 0) {
        await this.recoverUnreferencedWritesUnlocked(await this.loadBoundReferencedHashes());
      } else {
        await rm(stagingDir(this.rootDir), { recursive: true, force: true });
        await this.cleanupAbandonedStreamStagesUnlocked();
      }
      return new FilesystemEvidenceWriteBatch(this, release);
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

  async writePendingJournal(id: string, hashes: readonly ContentHash[]): Promise<void> {
    if (!PENDING_JOURNAL_ID_RE.test(id)) {
      throw new Error("invalid pending write journal id");
    }
    const safeHashes = hashes.filter((hash) => isContentHash(hash));
    await this.ping();
    await writeFileDurable(
      join(pendingDir(this.rootDir), `${id}.json`),
      JSON.stringify({
        schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
        id,
        hashes: safeHashes,
      }),
    );
  }

  async deletePendingJournal(id: string): Promise<void> {
    if (!PENDING_JOURNAL_ID_RE.test(id)) {
      throw new Error("invalid pending write journal id");
    }
    await rm(join(pendingDir(this.rootDir), `${id}.json`), { force: true });
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
    let names: string[] = [];
    try {
      names = await readdir(pendingDir(this.rootDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const path = join(pendingDir(this.rootDir), name);
      if (name.includes(".tmp")) {
        await rm(path, { force: true });
        continue;
      }
      if (!PENDING_JOURNAL_FILE_RE.test(name)) continue;
      journals += 1;
      let parsed: { schemaId?: unknown; hashes?: unknown } | null = null;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as {
          schemaId?: unknown;
          hashes?: unknown;
        };
      } catch {
        await rm(path, { force: true });
        continue;
      }
      if (
        parsed?.schemaId !== EVIDENCE_PENDING_WRITE_SCHEMA_ID
        || !Array.isArray(parsed.hashes)
      ) {
        await rm(path, { force: true });
        continue;
      }
      for (const hash of parsed.hashes) {
        if (typeof hash !== "string" || !isContentHash(hash) || referenced.has(hash)) {
          continue;
        }
        const blob = blobPath(this.rootDir, hash);
        const meta = metaPath(this.rootDir, hash);
        let existed = false;
        try {
          await stat(blob);
          existed = true;
        } catch {
          // Missing canonical bytes are still journaled crash residue.
        }
        try {
          await stat(meta);
          existed = true;
        } catch {
          // Meta may be absent if promotion was interrupted.
        }
        await rm(blob, { force: true });
        await rm(meta, { force: true });
        if (existed) reclaimed.push(hash);
      }
      await rm(path, { force: true });
    }
    await rm(stagingDir(this.rootDir), { recursive: true, force: true });
    await this.cleanupAbandonedStreamStagesUnlocked();
    return { reclaimed, journals };
  }

  private async cleanupAbandonedStreamStagesUnlocked(): Promise<void> {
    if (this.writeCoordination !== "single_process") return;
    let names: string[];
    try {
      names = await readdir(streamStagingDir(this.rootDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const stageId = name.slice(0, 36);
      if (this.activeStreamStages.has(stageId)) continue;
      await rm(join(streamStagingDir(this.rootDir), name), {
        recursive: true,
        force: true,
      });
    }
  }

  async put(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1> {
    const release = await this.acquireWriteLock();
    try {
      return await this.putUnlocked(bytes, opts);
    } finally {
      await release();
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

  async putUnlocked(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1> {
    await this.ping();
    const hash = sha256Hex(bytes);
    const path = blobPath(this.rootDir, hash);
    const metadataPath = metaPath(this.rootDir, hash);
    const meta: BlobMetaV1 = {
      hash,
      byteLength: bytes.byteLength,
      contentType: opts?.contentType ?? null,
    };
    try {
      await stat(path);
      if (!(await this.verify(hash))) {
        throw new Error("existing content-addressed evidence failed verification");
      }
      return meta;
    } catch (error) {
      if (error instanceof Error && error.message.includes("failed verification")) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    const temporaryMetaPath = `${metadataPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, bytes);
      await writeFile(temporaryMetaPath, JSON.stringify(meta), "utf8");
      await rename(temporaryPath, path);
      try {
        await rename(temporaryMetaPath, metadataPath);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await rm(temporaryMetaPath, { force: true });
      throw error;
    }
    return meta;
  }

  async stage(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<EvidenceStage> {
    await this.ping();
    const hash = sha256Hex(bytes);
    const releaseLock = await this.acquireStageLock(hash);
    const path = blobPath(this.rootDir, hash);
    const metadataPath = metaPath(this.rootDir, hash);
    const meta: BlobMetaV1 = {
      hash,
      byteLength: bytes.byteLength,
      contentType: opts?.contentType ?? null,
    };
    let existing = false;
    try {
      await stat(path);
      existing = true;
      if (!(await this.verify(hash))) {
        throw new Error("existing content-addressed evidence failed verification");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("failed verification")) {
        releaseLock();
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        releaseLock();
        throw error;
      }
    }
    const stagingDir = join(this.rootDir, "staging");
    await mkdir(stagingDir, { recursive: true });
    const stageId = randomUUID();
    const temporaryPath = existing ? null : join(stagingDir, `${hash}.${stageId}.blob`);
    const temporaryMetaPath = existing ? null : join(stagingDir, `${hash}.${stageId}.meta.json`);
    try {
      if (temporaryPath && temporaryMetaPath) {
        await writeFile(temporaryPath, bytes);
        await writeFile(temporaryMetaPath, JSON.stringify(meta), "utf8");
      }
    } catch (error) {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (temporaryMetaPath) await rm(temporaryMetaPath, { force: true });
      releaseLock();
      throw error;
    }
    let committed = existing;
    let created = false;
    let released = false;
    return {
      meta,
      commit: async () => {
        if (committed) return;
        if (!temporaryPath || !temporaryMetaPath) throw new Error("evidence stage is unavailable");
        await mkdir(dirname(path), { recursive: true });
        await rename(temporaryPath, path);
        created = true;
        try {
          await rename(temporaryMetaPath, metadataPath);
          committed = true;
        } catch (error) {
          await rm(path, { force: true });
          created = false;
          throw error;
        }
      },
      rollback: async () => {
        if (temporaryPath) await rm(temporaryPath, { force: true });
        if (temporaryMetaPath) await rm(temporaryMetaPath, { force: true });
        if (created) {
          await rm(path, { force: true });
          await rm(metadataPath, { force: true });
          committed = false;
          created = false;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        releaseLock();
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
    if (opts.contentType !== undefined && typeof opts.contentType !== "string") {
      throw new Error("contentType must be a string");
    }
    if (
      !source
      || typeof source[Symbol.asyncIterator] !== "function"
    ) {
      throw new Error("evidence stream source must be an AsyncIterable");
    }
    throwIfAborted(opts.signal);

    await this.ping();
    await mkdir(streamStagingDir(this.rootDir), { recursive: true });
    const stageId = randomUUID();
    const scratchBlob = join(streamStagingDir(this.rootDir), stageId);
    const scratchMeta = join(streamStagingDir(this.rootDir), `${stageId}.meta.json`);
    this.activeStreamStages.add(stageId);
    const cleanScratch = async (): Promise<void> => {
      const results = await Promise.allSettled([
        rm(scratchBlob, { force: true }),
        rm(scratchMeta, { force: true }),
      ]);
      this.activeStreamStages.delete(stageId);
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    };

    const hasher = createHash("sha256");
    let byteLength = 0;
    let handle: FileHandle | null = null;
    let streamed = false;
    let sourceFinished = false;
    let iterator: AsyncIterator<Uint8Array> | null = null;
    try {
      iterator = source[Symbol.asyncIterator]();
      handle = await open(scratchBlob, "w");
      while (true) {
        const next = await nextWithAbort(iterator, opts.signal);
        if (next.done) {
          sourceFinished = true;
          break;
        }
        const chunk = next.value;
        throwIfAborted(opts.signal);
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("evidence stream chunk must be a Uint8Array");
        }
        if (chunk.byteLength === 0) {
          throw new Error("evidence stream chunk must not be empty");
        }
        const nextLength = byteLength + chunk.byteLength;
        if (nextLength > opts.maxBytes) {
          throw new Error("evidence stream exceeded maxBytes");
        }
        const stableChunk = Uint8Array.from(chunk);
        await writeChunkFully(handle, stableChunk, opts.signal);
        hasher.update(stableChunk);
        byteLength = nextLength;
      }
      throwIfAborted(opts.signal);
      if (opts.expectedLength !== undefined && byteLength !== opts.expectedLength) {
        throw new Error("evidence stream length did not match expectedLength");
      }
      await handle.sync();
      throwIfAborted(opts.signal);
      await handle.close();
      handle = null;
      streamed = true;
    } finally {
      if (iterator && !sourceFinished) {
        try {
          if (typeof iterator.return === "function") {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          }
        } catch {
          // A hostile source cannot suppress descriptor/scratch cleanup.
        }
      }
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = null;
      }
      if (!streamed) {
        await cleanScratch();
      }
    }

    const hash = hasher.digest("hex") as ContentHash;
    const meta: BlobMetaV1 = Object.freeze({
      hash,
      byteLength,
      contentType: opts.contentType ?? null,
    });
    try {
      throwIfAborted(opts.signal);
      await writeFileDurable(scratchMeta, JSON.stringify(meta));
      throwIfAborted(opts.signal);
    } catch (error) {
      await cleanScratch();
      throw error;
    }

    const canonicalBlob = blobPath(this.rootDir, hash);
    const canonicalMeta = metaPath(this.rootDir, hash);
    let promoted = false;
    let created = false;
    let settled = false;
    let journalId: string | null = null;
    let releaseLifecycleLock: (() => Promise<void>) | null = null;
    let promotionPromise: Promise<void> | null = null;
    let settlementPromise: Promise<void> | null = null;
    let settlementMode: "rollback" | "finalize" | null = null;
    let finalizeRetainPendingJournal: boolean | null = null;
    let terminalPromotionFailure = false;

    const releaseLifecycle = async (): Promise<void> => {
      const release = releaseLifecycleLock;
      if (!release) return;
      await release();
      if (releaseLifecycleLock === release) releaseLifecycleLock = null;
    };

    const runPromotion = async (): Promise<void> => {
      const releaseWrite = await this.acquireWriteLock();
      let retainWriteLock = false;
      try {
        const releaseDigest = await this.acquireStageLock(hash);
        try {
          let existing = false;
          try {
            await stat(canonicalBlob);
            existing = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (existing) {
            const existingMeta = await this.readCanonicalMetaStrict(hash);
            await this.verifyCanonicalFile(
              canonicalBlob,
              hash,
              existingMeta.byteLength,
            );
            await cleanScratch();
            promoted = true;
            created = false;
            releaseLifecycleLock = releaseWrite;
            retainWriteLock = true;
            return;
          }

          try {
            await stat(canonicalMeta);
            throw new Error("orphaned evidence metadata exists without canonical bytes");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }

          await this.verifyCanonicalFile(scratchBlob, hash, byteLength);
          await writeFileDurable(scratchMeta, JSON.stringify(meta));
          journalId = randomUUID();
          await this.writePendingJournal(journalId, [hash]);
          try {
            await mkdir(dirname(canonicalBlob), { recursive: true });
            await rename(scratchBlob, canonicalBlob);
            created = true;
            try {
              await rename(scratchMeta, canonicalMeta);
              this.activeStreamStages.delete(stageId);
            } catch (error) {
              try {
                await rename(canonicalBlob, scratchBlob);
                created = false;
              } catch {
                terminalPromotionFailure = true;
              }
              throw error;
            }
          } catch (error) {
            let failure: unknown = error;
            try {
              if (created) {
                await rm(canonicalMeta, { force: true });
                await rm(canonicalBlob, { force: true });
                created = false;
                if (terminalPromotionFailure) await cleanScratch();
              }
              if (journalId) {
                await this.deletePendingJournal(journalId);
                journalId = null;
              }
            } catch (cleanupError) {
              failure = new AggregateError(
                [error, cleanupError],
                "evidence stream promotion cleanup failed",
              );
            }
            if (created || journalId) {
              // Fail closed: unresolved canonical/journal state remains owned by
              // this stage and must not be observed or adopted outside its lease.
              releaseLifecycleLock = releaseWrite;
              retainWriteLock = true;
            } else if (terminalPromotionFailure) {
              settled = true;
            }
            throw failure;
          }
          promoted = true;
          releaseLifecycleLock = releaseWrite;
          retainWriteLock = true;
        } finally {
          releaseDigest();
        }
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
          && (promoted || created || journalId !== null)
        ) {
          releaseLifecycleLock = await this.acquireWriteLock();
        }
        try {
          await cleanScratch();
          if (mode === "rollback" && created) {
            await rm(canonicalMeta, { force: true });
            await rm(canonicalBlob, { force: true });
            created = false;
            promoted = false;
          }
          if (!retainPendingJournal && journalId) {
            await this.deletePendingJournal(journalId);
            journalId = null;
          }
        } catch (error) {
          if (!created && journalId === null) await releaseLifecycle();
          throw error;
        }
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
    const path = blobPath(this.rootDir, hash);
    const meta = await this.readCanonicalMetaStrict(hash);
    throwIfAborted(signal);
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
    await this.verifyCanonicalFile(path, hash, meta.byteLength, signal);
    throwIfAborted(signal);

    const effectiveRange: EvidenceReadRange | null = range
      ? Object.freeze({ ...range })
      : null;
    const exactCount = effectiveRange
      ? effectiveRange.end - effectiveRange.start + 1
      : meta.byteLength;

    return {
      meta: Object.freeze({
        hash: meta.hash,
        byteLength: meta.byteLength,
        contentType: meta.contentType ?? null,
      }),
      range: effectiveRange,
      byteLength: exactCount,
      bytes: () => this.readVerifiedRange(path, meta, effectiveRange, signal),
    };
  }

  private async readCanonicalMetaStrict(hash: ContentHash): Promise<BlobMetaV1> {
    let raw: string;
    try {
      raw = await readFile(metaPath(this.rootDir, hash), "utf8");
    } catch {
      throw new Error("evidence metadata is missing");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("evidence metadata is corrupt");
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || typeof (parsed as BlobMetaV1).hash !== "string"
      || typeof (parsed as BlobMetaV1).byteLength !== "number"
      || (
        (parsed as BlobMetaV1).contentType !== null
        && typeof (parsed as BlobMetaV1).contentType !== "string"
      )
    ) {
      throw new Error("evidence metadata is corrupt");
    }
    const meta = parsed as BlobMetaV1;
    if (meta.hash !== hash || !isContentHash(meta.hash)) {
      throw new Error("evidence metadata hash mismatch");
    }
    assertSafeNonNegativeInteger(meta.byteLength, "meta.byteLength");
    return {
      hash: meta.hash,
      byteLength: meta.byteLength,
      contentType: meta.contentType,
    };
  }

  private async verifyOpenFileIncremental(
    handle: FileHandle,
    expectedHash: ContentHash,
    expectedLength: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const hasher = createHash("sha256");
    let position = 0;
    while (position < expectedLength) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedLength - position));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("evidence blob truncated or corrupted");
      }
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    throwIfAborted(signal);
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, expectedLength)).bytesRead !== 0) {
      throw new Error("evidence blob size does not match metadata");
    }
    if (hasher.digest("hex") !== expectedHash) {
      throw new Error("evidence blob failed verification");
    }
    throwIfAborted(signal);
  }

  private async verifyCanonicalFile(
    path: string,
    expectedHash: ContentHash,
    expectedLength: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch {
      throw new Error("evidence blob is missing");
    }
    try {
      const before = await handle.stat();
      throwIfAborted(signal);
      if (!before.isFile() || before.size !== expectedLength) {
        throw new Error("evidence blob size does not match metadata");
      }
      await this.verifyOpenFileIncremental(handle, expectedHash, expectedLength, signal);
      const after = await handle.stat();
      throwIfAborted(signal);
      if (!sameFileSnapshot(before, after)) {
        throw new Error("evidence blob changed during verification");
      }
    } finally {
      await handle.close();
    }
  }

  private readVerifiedRange(
    path: string,
    meta: BlobMetaV1,
    range: EvidenceReadRange | null,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const verifyOpenFileIncremental = (
      handle: FileHandle,
      expectedHash: ContentHash,
      expectedLength: number,
      readSignal?: AbortSignal,
    ): Promise<void> => this.verifyOpenFileIncremental(
      handle,
      expectedHash,
      expectedLength,
      readSignal,
    );
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        throwIfAborted(signal);
        let handle: FileHandle;
        try {
          handle = await open(path, "r");
        } catch {
          throw new Error("evidence blob is missing");
        }
        let verifiedSnapshot: FileSnapshot | null = null;
        let integrityComplete = false;
        try {
          const before = await handle.stat();
          throwIfAborted(signal);
          if (!before.isFile() || before.size !== meta.byteLength) {
            throw new Error("evidence blob size does not match metadata");
          }
          await verifyOpenFileIncremental(
            handle,
            meta.hash,
            meta.byteLength,
            signal,
          );
          const verified = await handle.stat();
          throwIfAborted(signal);
          if (!sameFileSnapshot(before, verified)) {
            throw new Error("evidence blob changed during verification");
          }
          verifiedSnapshot = verified;

          let position = range?.start ?? 0;
          let remaining = range
            ? range.end - range.start + 1
            : meta.byteLength;
          const emittedHasher = range === null ? createHash("sha256") : null;
          while (remaining > 0) {
            throwIfAborted(signal);
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.byteLength,
              position,
            );
            if (bytesRead <= 0) throw new Error("evidence read truncated");
            const chunk = buffer.subarray(0, bytesRead);
            emittedHasher?.update(chunk);
            position += bytesRead;
            remaining -= bytesRead;
            throwIfAborted(signal);
            yield Uint8Array.from(chunk);
          }

          if (emittedHasher) {
            if (emittedHasher.digest("hex") !== meta.hash) {
              throw new Error("evidence blob changed during read");
            }
          } else {
            await verifyOpenFileIncremental(
              handle,
              meta.hash,
              meta.byteLength,
              signal,
            );
          }
          const after = await handle.stat();
          throwIfAborted(signal);
          if (!sameFileSnapshot(verified, after)) {
            throw new Error("evidence blob changed during read");
          }
          integrityComplete = true;
        } finally {
          try {
            if (!signal?.aborted && !integrityComplete && verifiedSnapshot) {
              await verifyOpenFileIncremental(
                handle,
                meta.hash,
                meta.byteLength,
                signal,
              );
              assertSameFileSnapshot(
                verifiedSnapshot,
                await handle.stat(),
                "evidence blob changed during read",
              );
            }
          } finally {
            await handle.close();
          }
        }
      },
    };
  }

  private async acquireStageLock(hash: string): Promise<() => void> {
    const previous = this.stageTails.get(hash) ?? Promise.resolve();
    let unlock = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const queued = previous.then(() => current);
    this.stageTails.set(hash, queued);
    await previous;
    return () => {
      unlock();
      if (this.stageTails.get(hash) === queued) this.stageTails.delete(hash);
    };
  }

  async getUnlocked(hash: ContentHash): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(blobPath(this.rootDir, hash));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    return this.getUnlocked(hash);
  }

  async head(hash: ContentHash, signal?: AbortSignal): Promise<BlobMetaV1 | null> {
    throwIfAborted(signal);
    try {
      const raw = await readFile(metaPath(this.rootDir, hash), { encoding: "utf8", signal });
      throwIfAborted(signal);
      return JSON.parse(raw) as BlobMetaV1;
    } catch {
      throwIfAborted(signal);
      try {
        const bytes = await readFile(blobPath(this.rootDir, hash), { signal });
        throwIfAborted(signal);
        return { hash, byteLength: bytes.byteLength, contentType: null };
      } catch {
        throwIfAborted(signal);
        return null;
      }
    }
  }

  async verify(hash: ContentHash): Promise<boolean> {
    const bytes = await this.get(hash);
    if (!bytes) return false;
    return sha256Hex(bytes) === hash;
  }

  async putFileServerReference(input: {
    uri: string;
    expectedHash?: ContentHash | null;
    verificationStatus?: VerificationStatus;
  }): Promise<FileServerReferenceV1> {
    await this.ping();
    const expectedHash =
      input.expectedHash === undefined ? null : input.expectedHash;
    let verificationStatus = input.verificationStatus ?? "unverified";
    if (expectedHash === null) {
      // Never-hashed targets are representable and visibly unverifiable.
      if (verificationStatus === "verified") {
        throw new Error(
          "cannot mark a file-server reference verified without an expected hash",
        );
      }
      verificationStatus = verificationStatus === "unreachable"
        ? "unreachable"
        : "unverified";
    }
    const ref: FileServerReferenceV1 = {
      schemaId: FILE_SERVER_REF_SCHEMA_ID,
      id: randomUUID(),
      uri: input.uri,
      expectedHash,
      verificationStatus,
    };
    await writeFile(refPath(this.rootDir, ref.id), JSON.stringify(ref), "utf8");
    return ref;
  }

  async abandonFileServerReference(id: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("invalid file-server reference id");
    }
    await rm(refPath(this.rootDir, id), { force: true });
  }

  async restoreFileServerReference(ref: FileServerReferenceV1): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref.id)) {
      throw new Error("invalid file-server reference id");
    }
    await this.ping();
    await writeFile(refPath(this.rootDir, ref.id), JSON.stringify(ref), "utf8");
  }

  async getFileServerReference(
    id: string,
  ): Promise<FileServerReferenceV1 | null> {
    try {
      const raw = await readFile(refPath(this.rootDir, id), "utf8");
      return JSON.parse(raw) as FileServerReferenceV1;
    } catch {
      return null;
    }
  }

  async verifyFileServerReference(
    id: string,
    actualBytes?: Uint8Array,
  ): Promise<FileServerReferenceV1> {
    const existing = await this.getFileServerReference(id);
    if (!existing) {
      throw new Error(`file-server reference not found: ${id}`);
    }
    let next: FileServerReferenceV1;
    if (actualBytes === undefined) {
      next = { ...existing, verificationStatus: "unreachable" };
    } else if (existing.expectedHash === null) {
      // Still never-hashed: computing a hash does not silently verify without
      // an expected value established at put/update time. Fail closed.
      next = { ...existing, verificationStatus: "unverified" };
    } else if (sha256Hex(actualBytes) === existing.expectedHash) {
      next = { ...existing, verificationStatus: "verified" };
    } else {
      // Mismatch: fail closed — do not treat as verified.
      next = { ...existing, verificationStatus: "unverified" };
    }
    await writeFile(refPath(this.rootDir, id), JSON.stringify(next), "utf8");
    return next;
  }
}

class FilesystemEvidenceWriteBatch implements EvidenceWriteBatch {
  private readonly stageRoot: string;
  private readonly staged = new Map<ContentHash, BlobMetaV1>();
  private readonly created: Array<{ blob: string; meta: string }> = [];
  private released = false;
  private promoted = false;
  private journalId: string | null = null;

  constructor(
    private readonly owner: FilesystemEvidenceStore,
    private readonly releaseLock: () => Promise<void>,
  ) {
    this.stageRoot = join(stagingDir(owner.rootDir), randomUUID());
  }

  async put(bytes: Uint8Array, opts?: { contentType?: string }): Promise<BlobMetaV1> {
    if (this.promoted) throw new Error("evidence write batch is already promoted");
    const hash = sha256Hex(bytes);
    const meta: BlobMetaV1 = {
      hash,
      byteLength: bytes.byteLength,
      contentType: opts?.contentType ?? null,
    };
    const prior = this.staged.get(hash);
    if (prior) return prior;
    if ((await this.owner.head(hash)) && (await this.owner.verify(hash))) return meta;
    const path = blobPath(this.stageRoot, hash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(metaPath(this.stageRoot, hash), JSON.stringify(meta), "utf8");
    this.staged.set(hash, meta);
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
    if (this.staged.has(hash) && !this.promoted) {
      try {
        return new Uint8Array(await readFile(blobPath(this.stageRoot, hash)));
      } catch {
        return null;
      }
    }
    return this.owner.getUnlocked(hash);
  }

  async head(hash: ContentHash, signal?: AbortSignal): Promise<BlobMetaV1 | null> {
    throwIfAborted(signal);
    return this.staged.get(hash) ?? this.owner.head(hash, signal);
  }

  async verify(hash: ContentHash): Promise<boolean> {
    const bytes = await this.get(hash);
    return bytes !== null && sha256Hex(bytes) === hash;
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
      const destinationBlob = blobPath(this.owner.rootDir, hash);
      try {
        await stat(destinationBlob);
      } catch {
        createdHashes.push(hash);
      }
    }
    if (createdHashes.length > 0) {
      this.journalId = randomUUID();
      await this.owner.writePendingJournal(this.journalId, createdHashes);
    }
    for (const hash of createdHashes) {
      const destinationBlob = blobPath(this.owner.rootDir, hash);
      const destinationMeta = metaPath(this.owner.rootDir, hash);
      await mkdir(dirname(destinationBlob), { recursive: true });
      await rename(blobPath(this.stageRoot, hash), destinationBlob);
      this.created.push({ blob: destinationBlob, meta: destinationMeta });
      await rename(metaPath(this.stageRoot, hash), destinationMeta);
    }
    this.promoted = true;
  }

  async rollback(): Promise<void> {
    if (this.released) return;
    try {
      for (const row of [...this.created].reverse()) {
        await rm(row.meta, { force: true });
        await rm(row.blob, { force: true });
      }
      await rm(this.stageRoot, { recursive: true, force: true });
      if (this.journalId) {
        await this.owner.deletePendingJournal(this.journalId);
        this.journalId = null;
      }
    } finally {
      await this.release();
    }
  }

  async finalize(options?: EvidenceFinalizeOptions): Promise<void> {
    if (this.released) return;
    try {
      await rm(this.stageRoot, { recursive: true, force: true });
      if (!options?.retainPendingJournal && this.journalId) {
        await this.owner.deletePendingJournal(this.journalId);
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

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseLock();
  }
}

/** Test helper: overwrite blob bytes without changing the address (simulates corruption). */
export async function corruptBlobForTest(
  store: FilesystemEvidenceStore,
  hash: ContentHash,
  mutated: Uint8Array,
): Promise<void> {
  const path = blobPath(store.rootDir, hash);
  await writeFile(path, mutated);
}

/**
 * Test helper: release the exclusive write lock while leaving promoted bytes
 * and the pending-write journal in place, as a process crash after promote
 * and before COMMIT would.
 */
export async function abandonWriteBatchForCrashTest(batch: EvidenceWriteBatch): Promise<void> {
  if (!(batch instanceof FilesystemEvidenceWriteBatch)) {
    throw new Error("crash abandonment is only defined for filesystem evidence batches");
  }
  await batch.abandonForCrashTest();
}
