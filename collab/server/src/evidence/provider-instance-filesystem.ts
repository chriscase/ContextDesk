import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
  MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES,
  EvidenceProviderInstanceStorageError,
  assertCanonicalEvidenceProviderInstanceId,
  isEvidenceProviderInstanceStorageError,
  parseEvidenceProviderInstance,
  serializeEvidenceProviderInstance,
  type EvidenceProviderInstanceInitialization,
  type EvidenceProviderInstanceManager,
  type EvidenceProviderInstanceV1,
} from "./provider-instance.js";

export const EVIDENCE_PROVIDER_INSTANCE_DIRECTORY = ".contextdesk";
export const EVIDENCE_PROVIDER_INSTANCE_FILENAME = "provider-instance.v1.json";

type StatView = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly size: number;
  readonly uid: number;
};

type FileHandleView = Pick<FileHandle, "close" | "read" | "stat" | "sync" | "write">;

export interface EvidenceProviderInstanceFilesystemOps {
  lstat(path: string): Promise<StatView>;
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<unknown>;
  open(path: string, flags: number, mode?: number): Promise<FileHandleView>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  randomProviderInstanceId(): string;
  randomTemporaryToken(): string;
  platform: NodeJS.Platform;
  ownerUid: number | null;
}

const DEFAULT_OPS: EvidenceProviderInstanceFilesystemOps = {
  lstat,
  mkdir,
  open,
  link,
  unlink,
  randomProviderInstanceId: randomUUID,
  randomTemporaryToken: () => randomBytes(16).toString("hex"),
  platform: process.platform,
  ownerUid: process.getuid?.() ?? null,
};

const READ_FLAGS = constants.O_RDONLY | noFollowFlag();
const WRITE_EXCLUSIVE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();

export class FilesystemEvidenceProviderInstanceManager
implements EvidenceProviderInstanceManager {
  private readonly rootDir: string;
  private readonly namespaceDir: string;
  private readonly manifestPath: string;
  private readonly ops: EvidenceProviderInstanceFilesystemOps;

  constructor(options: {
    rootDir: string;
    ops?: EvidenceProviderInstanceFilesystemOps;
  }) {
    this.rootDir = resolve(options.rootDir);
    this.namespaceDir = join(this.rootDir, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY);
    this.manifestPath = join(this.namespaceDir, EVIDENCE_PROVIDER_INSTANCE_FILENAME);
    this.ops = options.ops ?? DEFAULT_OPS;
  }

  async inspect(
    expectedProviderInstanceId?: string,
  ): Promise<EvidenceProviderInstanceV1 | null> {
    if (expectedProviderInstanceId !== undefined) {
      this.assertExpectedId(expectedProviderInstanceId);
    }
    try {
      const root = await this.lstatOrNull(this.rootDir);
      if (root === null) return null;
      if (root.isSymbolicLink() || !root.isDirectory()) this.invalid();

      const namespace = await this.lstatOrNull(this.namespaceDir);
      if (namespace === null) return null;
      if (namespace.isSymbolicLink() || !namespace.isDirectory()) this.invalid();
      this.assertOwnerOnly(namespace);

      const entry = await this.lstatOrNull(this.manifestPath);
      if (entry === null) return null;
      if (
        entry.isSymbolicLink()
        || !entry.isFile()
        || entry.size < 1
        || entry.size > MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES
        || (this.ops.platform !== "win32" && (entry.mode & 0o077) !== 0)
        || (
          this.ops.platform !== "win32"
          && this.ops.ownerUid !== null
          && entry.uid !== this.ops.ownerUid
        )
      ) {
        this.invalid();
      }

      let handle: FileHandleView | undefined;
      try {
        handle = await this.ops.open(this.manifestPath, READ_FLAGS);
        const opened = await handle.stat();
        if (
          !opened.isFile()
          || opened.dev !== entry.dev
          || opened.ino !== entry.ino
          || opened.size !== entry.size
          || opened.size < 1
          || opened.size > MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES
          || (this.ops.platform !== "win32" && (opened.mode & 0o077) !== 0)
          || (
            this.ops.platform !== "win32"
            && this.ops.ownerUid !== null
            && opened.uid !== this.ops.ownerUid
          )
        ) {
          this.invalid();
        }
        const bytes = new Uint8Array(opened.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            offset,
          );
          if (bytesRead === 0) this.unavailable();
          offset += bytesRead;
        }
        let manifest: EvidenceProviderInstanceV1;
        try {
          manifest = parseEvidenceProviderInstance(bytes);
        } catch {
          this.invalid();
        }
        if (manifest.providerKind !== "filesystem") this.invalid();
        if (
          expectedProviderInstanceId !== undefined
          && manifest.providerInstanceId !== expectedProviderInstanceId
        ) {
          this.mismatch();
        }
        const namespaceAfter = await this.lstatOrNull(this.namespaceDir);
        const entryAfter = await this.lstatOrNull(this.manifestPath);
        if (
          namespaceAfter === null
          || entryAfter === null
          || namespaceAfter.dev !== namespace.dev
          || namespaceAfter.ino !== namespace.ino
          || entryAfter.dev !== entry.dev
          || entryAfter.ino !== entry.ino
        ) {
          this.unavailable();
        }
        this.assertOwnerOnly(namespaceAfter);
        return manifest;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    } catch (error) {
      if (isEvidenceProviderInstanceStorageError(error)) throw error;
      this.unavailable();
    }
  }

  async initialize(
    expectedProviderInstanceId?: string,
  ): Promise<EvidenceProviderInstanceInitialization> {
    if (expectedProviderInstanceId !== undefined) {
      this.assertExpectedId(expectedProviderInstanceId);
    }
    await this.ensureRealDirectory(this.rootDir, true);
    const namespace = await this.ensureRealDirectory(this.namespaceDir, false);
    if (namespace.created) {
      try {
        await this.syncDirectory(this.rootDir);
      } catch {
        this.outcomeUnknown();
      }
    }
    const existing = await this.inspect(expectedProviderInstanceId);
    if (existing !== null) return Object.freeze({ outcome: "existing", manifest: existing });

    const candidateId = expectedProviderInstanceId ?? this.ops.randomProviderInstanceId();
    this.assertExpectedId(candidateId);
    const candidate: EvidenceProviderInstanceV1 = Object.freeze({
      schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
      providerInstanceId: candidateId,
      providerKind: "filesystem",
    });
    const body = serializeEvidenceProviderInstance(candidate);

    const temporaryPath = join(
      this.namespaceDir,
      `.provider-instance.v1.${this.ops.randomTemporaryToken()}.tmp`,
    );
    let temporaryExists = false;
    let published = false;
    try {
      await this.assertDirectoryStable(this.namespaceDir, namespace.entry);
      const handle = await this.ops.open(temporaryPath, WRITE_EXCLUSIVE_FLAGS, 0o600);
      temporaryExists = true;
      try {
        let offset = 0;
        while (offset < body.byteLength) {
          const { bytesWritten } = await handle.write(
            body,
            offset,
            body.byteLength - offset,
            offset,
          );
          if (bytesWritten === 0) this.unavailable();
          offset += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await this.assertDirectoryStable(this.namespaceDir, namespace.entry);
        await this.ops.link(temporaryPath, this.manifestPath);
        published = true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          const winner = await this.inspect(expectedProviderInstanceId);
          if (winner === null) this.unavailable();
          await this.confirmNamespaceDurability(namespace.entry);
          return Object.freeze({ outcome: "existing", manifest: winner });
        }
        const reconciled = await this.reconcile(candidate, expectedProviderInstanceId, true);
        await this.confirmNamespaceDurability(namespace.entry);
        return reconciled;
      }

      await this.confirmNamespaceDurability(namespace.entry);
      return Object.freeze({ outcome: "created", manifest: candidate });
    } catch (error) {
      if (isEvidenceProviderInstanceStorageError(error)) throw error;
      if (published) this.outcomeUnknown();
      return await this.reconcile(candidate, expectedProviderInstanceId, false);
    } finally {
      if (temporaryExists) {
        await this.ops.unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  private async reconcile(
    candidate: EvidenceProviderInstanceV1,
    expectedProviderInstanceId: string | undefined,
    mayHavePublished: boolean,
  ): Promise<EvidenceProviderInstanceInitialization> {
    let observed: EvidenceProviderInstanceV1 | null;
    try {
      observed = await this.inspect(expectedProviderInstanceId);
    } catch (error) {
      if (isEvidenceProviderInstanceStorageError(error)) {
        if (error.code === "identity_mismatch" || error.code === "invalid") {
          throw error;
        }
        if (mayHavePublished) this.outcomeUnknown();
        throw error;
      }
      if (mayHavePublished) this.outcomeUnknown();
      this.unavailable();
    }
    if (observed === null) {
      if (mayHavePublished) this.outcomeUnknown();
      this.unavailable();
    }
    return Object.freeze({
      outcome: observed.providerInstanceId === candidate.providerInstanceId
        ? "reconciled"
        : "existing",
      manifest: observed,
    });
  }

  private async ensureRealDirectory(
    path: string,
    recursive: boolean,
  ): Promise<{ readonly created: boolean; readonly entry: StatView }> {
    const before = await this.lstatOrNull(path);
    if (before !== null && (before.isSymbolicLink() || !before.isDirectory())) this.invalid();
    try {
      await this.ops.mkdir(path, { recursive, mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") this.unavailable();
    }
    const entry = await this.lstatOrNull(path).catch(() => this.unavailable());
    if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) this.invalid();
    if (path === this.namespaceDir) this.assertOwnerOnly(entry);
    return Object.freeze({ created: before === null, entry });
  }

  private async syncNamespaceDirectory(expected: StatView): Promise<void> {
    await this.assertDirectoryStable(this.namespaceDir, expected);
    await this.syncDirectory(this.namespaceDir, expected);
    await this.assertDirectoryStable(this.namespaceDir, expected);
  }

  private async confirmNamespaceDurability(expected: StatView): Promise<void> {
    try {
      await this.syncNamespaceDirectory(expected);
    } catch {
      this.outcomeUnknown();
    }
  }

  private async syncDirectory(path: string, expected?: StatView): Promise<void> {
    if (this.ops.platform === "win32") return;
    const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    const handle = await this.ops.open(
      path,
      constants.O_RDONLY | directoryFlag | noFollowFlag(),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isDirectory()
        || (expected !== undefined && (opened.dev !== expected.dev || opened.ino !== expected.ino))
      ) {
        this.unavailable();
      }
      if (path === this.namespaceDir) this.assertOwnerOnly(opened);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async assertDirectoryStable(path: string, expected: StatView): Promise<void> {
    const observed = await this.lstatOrNull(path);
    if (
      observed === null
      || observed.isSymbolicLink()
      || !observed.isDirectory()
      || observed.dev !== expected.dev
      || observed.ino !== expected.ino
    ) {
      this.unavailable();
    }
    if (path === this.namespaceDir) this.assertOwnerOnly(observed);
  }

  private async lstatOrNull(path: string): Promise<StatView | null> {
    try {
      return await this.ops.lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private assertExpectedId(value: string): void {
    try {
      assertCanonicalEvidenceProviderInstanceId(value);
    } catch {
      this.invalid();
    }
  }

  private assertOwnerOnly(entry: StatView): void {
    if (this.ops.platform === "win32") return;
    if ((entry.mode & 0o077) !== 0) this.invalid();
    if (this.ops.ownerUid !== null && entry.uid !== this.ops.ownerUid) this.invalid();
  }

  private invalid(): never {
    throw new EvidenceProviderInstanceStorageError("invalid");
  }

  private mismatch(): never {
    throw new EvidenceProviderInstanceStorageError("identity_mismatch");
  }

  private unavailable(): never {
    throw new EvidenceProviderInstanceStorageError("unavailable");
  }

  private outcomeUnknown(): never {
    throw new EvidenceProviderInstanceStorageError("initialization_outcome_unknown");
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
