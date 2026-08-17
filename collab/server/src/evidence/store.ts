import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  put(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1>;
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

  /** Readiness probe for the byte backend. */
  ping(): Promise<void>;
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

  constructor(opts: FilesystemEvidenceStoreOptions) {
    this.rootDir = opts.rootDir;
  }

  async ping(): Promise<void> {
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await mkdir(join(this.rootDir, "refs"), { recursive: true });
  }

  async put(
    bytes: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<BlobMetaV1> {
    await this.ping();
    const hash = sha256Hex(bytes);
    const path = blobPath(this.rootDir, hash);
    const meta: BlobMetaV1 = {
      hash,
      byteLength: bytes.byteLength,
      contentType: opts?.contentType ?? null,
    };
    try {
      await stat(path);
      // Immutable: existing content-addressed object is a no-op.
      return meta;
    } catch {
      // continue to write
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    await writeFile(metaPath(this.rootDir, hash), JSON.stringify(meta), "utf8");
    return meta;
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(blobPath(this.rootDir, hash));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
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

/** Test helper: overwrite blob bytes without changing the address (simulates corruption). */
export async function corruptBlobForTest(
  store: FilesystemEvidenceStore,
  hash: ContentHash,
  mutated: Uint8Array,
): Promise<void> {
  const path = blobPath(store.rootDir, hash);
  await writeFile(path, mutated);
}
