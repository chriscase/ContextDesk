import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  MAX_SETUP_STATE_FILE_BYTES,
  parsePersistedSetupState,
  type PersistedSetupStateV1,
} from "@cd-collab/contracts/setup";

export type SetupStateStoreErrorCode =
  | "invalid_path"
  | "unsafe_path"
  | "state_missing"
  | "state_exists"
  | "state_busy"
  | "state_permissions"
  | "state_too_large"
  | "state_malformed"
  | "stale_revision"
  | "invalid_update"
  | "persistence_failed";

export class SetupStateStoreError extends Error {
  constructor(readonly code: SetupStateStoreErrorCode) {
    super(code);
    this.name = "SetupStateStoreError";
  }
}

export interface SetupStateStore {
  initialize(state: PersistedSetupStateV1): Promise<PersistedSetupStateV1>;
  load(): Promise<PersistedSetupStateV1>;
  compareAndSwap(
    expectedRevision: number,
    transform: (current: PersistedSetupStateV1) => PersistedSetupStateV1,
  ): Promise<PersistedSetupStateV1>;
}

export interface FileSetupStateStoreOptions {
  /** Test-only fault seam. Production callers should omit it. */
  beforeRename?: () => Promise<void>;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function currentRevision(state: PersistedSetupStateV1): number {
  return state.history[state.history.length - 1]?.revision ?? -1;
}

function stateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertSingleAppend(
  current: PersistedSetupStateV1,
  next: PersistedSetupStateV1,
): void {
  if (
    next.deploymentId !== current.deploymentId ||
    next.ownerTokenDigest !== current.ownerTokenDigest ||
    next.history.length !== current.history.length + 1
  ) {
    throw new SetupStateStoreError("invalid_update");
  }
  if (stateDigest(next.history.slice(0, -1)) !== stateDigest(current.history)) {
    throw new SetupStateStoreError("invalid_update");
  }
}

export class FileSetupStateStore implements SetupStateStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly options: FileSetupStateStoreOptions;

  constructor(filePath: string, options: FileSetupStateStoreOptions = {}) {
    if (
      !isAbsolute(filePath) ||
      resolve(filePath) !== filePath ||
      filePath === parse(filePath).root
    ) {
      throw new SetupStateStoreError("invalid_path");
    }
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.options = options;
  }

  async initialize(
    state: PersistedSetupStateV1,
  ): Promise<PersistedSetupStateV1> {
    const parsed = parsePersistedSetupState(structuredClone(state));
    return this.withExclusiveLock(async () => {
      try {
        await lstat(this.filePath);
        throw new SetupStateStoreError("state_exists");
      } catch (error) {
        if (error instanceof SetupStateStoreError) throw error;
        if (!isNodeError(error, "ENOENT")) {
          throw new SetupStateStoreError("persistence_failed");
        }
      }
      await this.writeAtomically(parsed);
      return parsed;
    });
  }

  async load(): Promise<PersistedSetupStateV1> {
    await this.ensureSecureParent();
    return this.readStateUnlocked();
  }

  async compareAndSwap(
    expectedRevision: number,
    transform: (current: PersistedSetupStateV1) => PersistedSetupStateV1,
  ): Promise<PersistedSetupStateV1> {
    return this.withExclusiveLock(async () => {
      const current = await this.readStateUnlocked();
      if (currentRevision(current) !== expectedRevision) {
        throw new SetupStateStoreError("stale_revision");
      }
      const before = structuredClone(current);
      const next = parsePersistedSetupState(transform(structuredClone(current)));
      assertSingleAppend(before, next);
      await this.writeAtomically(next);
      return next;
    });
  }

  private async ensureSecureParent(): Promise<void> {
    const parent = dirname(this.filePath);
    const root = parse(parent).root;
    const relative = parent.slice(root.length);
    const parts = relative.split(/[\\/]+/u).filter(Boolean);
    let current = root;

    for (const part of parts) {
      current = join(current, part);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw new SetupStateStoreError("unsafe_path");
        }
        try {
          await mkdir(current, { mode: 0o700 });
          metadata = await lstat(current);
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, "EEXIST")) {
            throw new SetupStateStoreError("unsafe_path");
          }
          metadata = await lstat(current);
        }
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new SetupStateStoreError("unsafe_path");
      }
    }

    try {
      if ((await realpath(parent)) !== parent) {
        throw new SetupStateStoreError("unsafe_path");
      }
      const parentMetadata = await lstat(parent);
      if (
        process.platform !== "win32" &&
        (parentMetadata.mode & 0o077) !== 0
      ) {
        throw new SetupStateStoreError("unsafe_path");
      }
      if (
        typeof process.getuid === "function" &&
        parentMetadata.uid !== process.getuid()
      ) {
        throw new SetupStateStoreError("unsafe_path");
      }
    } catch (error) {
      if (error instanceof SetupStateStoreError) throw error;
      throw new SetupStateStoreError("unsafe_path");
    }
  }

  private async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSecureParent();
    let lock: FileHandle | null = null;
    try {
      lock = await open(
        this.lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await lock.writeFile("setup-state-lock\n", "utf8");
      await lock.sync();
    } catch (error) {
      await lock?.close().catch(() => undefined);
      if (lock !== null) {
        await unlink(this.lockPath).catch(() => undefined);
      }
      if (isNodeError(error, "EEXIST")) {
        throw new SetupStateStoreError("state_busy");
      }
      throw new SetupStateStoreError("persistence_failed");
    }

    try {
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
      await this.syncParentDirectory().catch(() => undefined);
    }
  }

  private async readStateUnlocked(): Promise<PersistedSetupStateV1> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new SetupStateStoreError("state_missing");
      }
      throw new SetupStateStoreError("unsafe_path");
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new SetupStateStoreError("unsafe_path");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new SetupStateStoreError("state_permissions");
      }
      if (metadata.size > MAX_SETUP_STATE_FILE_BYTES) {
        throw new SetupStateStoreError("state_too_large");
      }
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_SETUP_STATE_FILE_BYTES) {
        throw new SetupStateStoreError("state_too_large");
      }
      try {
        return parsePersistedSetupState(JSON.parse(raw) as unknown);
      } catch {
        throw new SetupStateStoreError("state_malformed");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async writeAtomically(state: PersistedSetupStateV1): Promise<void> {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SETUP_STATE_FILE_BYTES) {
      throw new SetupStateStoreError("state_too_large");
    }

    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    let temporary: FileHandle | null = null;
    try {
      temporary = await open(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await temporary.writeFile(serialized, "utf8");
      await temporary.sync();
      await temporary.close();
      temporary = null;
      await chmod(temporaryPath, 0o600);
      await this.ensureSecureParent();
      await this.options.beforeRename?.();
      await rename(temporaryPath, this.filePath);
      await this.syncParentDirectory();
    } catch (error) {
      await temporary?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof SetupStateStoreError) throw error;
      throw new SetupStateStoreError("persistence_failed");
    }
  }

  private async syncParentDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(dirname(this.filePath), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
