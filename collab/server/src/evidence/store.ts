import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  get(hash: ContentHash): Promise<Uint8Array | null>;
  head(hash: ContentHash): Promise<BlobMetaV1 | null>;
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
}

export interface EvidenceWriteBatch extends EvidenceStore {
  /** Promote staged bytes while retaining the exclusive write lock. */
  promote(): Promise<void>;
  /** Remove staged/promoted bytes and release the exclusive write lock. */
  rollback(): Promise<void>;
  /** Keep promoted bytes, clean scratch state, and release the write lock. */
  finalize(): Promise<void>;
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

function blobPath(root: string, hash: ContentHash): string {
  return join(root, "blobs", hash.slice(0, 2), hash);
}

function metaPath(root: string, hash: ContentHash): string {
  return join(root, "blobs", hash.slice(0, 2), `${hash}.meta.json`);
}

function refPath(root: string, id: string): string {
  return join(root, "refs", `${id}.json`);
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
  readonly writeCoordination: "single_process" | "external";
  private writeTail: Promise<void> = Promise.resolve();
  private readonly acquireWriteLease:
    | (() => Promise<() => void | Promise<void>>)
    | undefined;

  constructor(opts: FilesystemEvidenceStoreOptions) {
    this.rootDir = opts.rootDir;
    this.acquireWriteLease = opts.acquireWriteLease;
    this.writeCoordination = opts.acquireWriteLease ? "external" : "single_process";
  }

  async ping(): Promise<void> {
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await mkdir(join(this.rootDir, "refs"), { recursive: true });
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

  async beginWriteBatch(): Promise<EvidenceWriteBatch> {
    const release = await this.acquireWriteLock();
    try {
      await this.ping();
      return new FilesystemEvidenceWriteBatch(this, release);
    } catch (error) {
      await release();
      throw error;
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

  async head(hash: ContentHash): Promise<BlobMetaV1 | null> {
    try {
      const raw = await readFile(metaPath(this.rootDir, hash), "utf8");
      return JSON.parse(raw) as BlobMetaV1;
    } catch {
      const bytes = await this.get(hash);
      if (!bytes) return null;
      return { hash, byteLength: bytes.byteLength, contentType: null };
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

  constructor(
    private readonly owner: FilesystemEvidenceStore,
    private readonly releaseLock: () => Promise<void>,
  ) {
    this.stageRoot = join(owner.rootDir, ".staging", randomUUID());
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

  async head(hash: ContentHash): Promise<BlobMetaV1 | null> {
    return this.staged.get(hash) ?? this.owner.head(hash);
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
    for (const [hash] of this.staged) {
      const destinationBlob = blobPath(this.owner.rootDir, hash);
      try {
        await stat(destinationBlob);
        continue;
      } catch {
        // This batch holds the owner's exclusive write lock, so absence is stable.
      }
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
    } finally {
      await this.release();
    }
  }

  async finalize(): Promise<void> {
    if (this.released) return;
    try {
      await rm(this.stageRoot, { recursive: true, force: true });
    } catch {
      // Committed evidence remains canonical; stale scratch cleanup is best effort.
    } finally {
      await this.release();
    }
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
