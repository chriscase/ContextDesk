import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SETUP_STATE_FILE_BYTES,
  SETUP_STATE_SCHEMA_ID,
  parsePersistedSetupState,
  type PersistedSetupStateV1,
  type SetupStateEntryV1,
} from "@cd-collab/contracts/setup";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSetupStateStore,
  SetupStateStoreError,
} from "./state-store.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "contextdesk-setup-state-"),
  );
  roots.push(root);
  return root;
}

function initialState(tokenDigest = "a".repeat(64)): PersistedSetupStateV1 {
  return {
    schemaId: SETUP_STATE_SCHEMA_ID,
    deploymentId: "deployment:one",
    ownerTokenDigest: tokenDigest,
    history: [
      {
        stateId: "state:zero",
        revision: 0,
        phase: "awaiting_owner",
        occurredAtUnixMs: 1_000,
        claimId: null,
        claimantLabel: null,
        failureCode: null,
      },
    ],
  };
}

function appendClaim(state: PersistedSetupStateV1): PersistedSetupStateV1 {
  const next: SetupStateEntryV1 = {
    stateId: "state:one",
    revision: 1,
    phase: "claimed",
    occurredAtUnixMs: 1_001,
    claimId: "claim:one",
    claimantLabel: "Local operator",
    failureCode: null,
  };
  return parsePersistedSetupState({
    ...state,
    history: [...state.history, next],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileSetupStateStore", () => {
  it("persists owner-only state atomically and reloads it after restart", async () => {
    const root = await temporaryRoot();
    const file = join(root, "nested", "setup-state.json");
    const token = randomBytes(32).toString("base64url");
    const state = initialState(
      createHash("sha256").update(token).digest("hex"),
    );
    const first = new FileSetupStateStore(file);
    await expect(first.initialize(state)).resolves.toEqual(state);

    const metadata = await lstat(file);
    if (process.platform !== "win32") {
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain(token);
    expect(disk).toContain(state.ownerTokenDigest);

    const afterRestart = new FileSetupStateStore(file);
    await expect(afterRestart.load()).resolves.toEqual(state);
    await expect(afterRestart.initialize(state)).rejects.toMatchObject({
      code: "state_exists",
    });
  });

  it("permits exactly one concurrent initializer", async () => {
    const root = await temporaryRoot();
    const file = join(root, "setup-state.json");
    const stores = [new FileSetupStateStore(file), new FileSetupStateStore(file)];
    const results = await Promise.allSettled(
      stores.map((store) => store.initialize(initialState())),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(stores[0]?.load()).resolves.toEqual(initialState());
  });

  it("rejects stale revisions and any update other than one immutable append", async () => {
    const root = await temporaryRoot();
    const store = new FileSetupStateStore(join(root, "setup-state.json"));
    await store.initialize(initialState());

    await expect(
      store.compareAndSwap(9, appendClaim),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await expect(
      store.compareAndSwap(0, (state) => ({
        ...appendClaim(state),
        ownerTokenDigest: "b".repeat(64),
      })),
    ).rejects.toMatchObject({ code: "invalid_update" });
    await expect(
      store.compareAndSwap(0, (state) => {
        state.ownerTokenDigest = "c".repeat(64);
        return appendClaim(state);
      }),
    ).rejects.toMatchObject({ code: "invalid_update" });
    await expect(store.load()).resolves.toEqual(initialState());
  });

  it("keeps the prior state and removes scratch files when atomic rename fails", async () => {
    const root = await temporaryRoot();
    const file = join(root, "setup-state.json");
    await new FileSetupStateStore(file).initialize(initialState());
    const failing = new FileSetupStateStore(file, {
      beforeRename: async () => {
        throw new Error("injected write failure");
      },
    });

    await expect(failing.compareAndSwap(0, appendClaim)).rejects.toMatchObject({
      code: "persistence_failed",
    });
    await expect(new FileSetupStateStore(file).load()).resolves.toEqual(
      initialState(),
    );
    expect((await readdir(root)).sort()).toEqual(["setup-state.json"]);
  });

  it("fails closed on malformed and oversized state files", async () => {
    const root = await temporaryRoot();
    const malformed = join(root, "malformed.json");
    const oversized = join(root, "oversized.json");
    await writeFile(malformed, JSON.stringify({ secret: "not-state" }), { mode: 0o600 });
    await writeFile(oversized, "x".repeat(MAX_SETUP_STATE_FILE_BYTES + 1), {
      mode: 0o600,
    });

    await expect(new FileSetupStateStore(malformed).load()).rejects.toMatchObject({
      code: "state_malformed",
    });
    await expect(new FileSetupStateStore(oversized).load()).rejects.toMatchObject({
      code: "state_too_large",
    });
  });

  it("rejects symlinks, nonregular files, and unsafe permissions without path disclosure", async () => {
    const root = await temporaryRoot();
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await mkdir(realDirectory, { mode: 0o700 });
    await symlink(realDirectory, linkedDirectory);
    const linkedFile = join(linkedDirectory, "setup-state.json");

    let linkedError: unknown;
    try {
      await new FileSetupStateStore(linkedFile).initialize(initialState());
    } catch (error) {
      linkedError = error;
    }
    expect(linkedError).toBeInstanceOf(SetupStateStoreError);
    expect(String(linkedError)).not.toContain(root);

    const directoryAsFile = join(root, "directory-state");
    await mkdir(directoryAsFile);
    await expect(
      new FileSetupStateStore(directoryAsFile).load(),
    ).rejects.toMatchObject({ code: "unsafe_path" });

    if (process.platform !== "win32") {
      const permissive = join(root, "permissive.json");
      await writeFile(permissive, JSON.stringify(initialState()), { mode: 0o600 });
      await chmod(permissive, 0o644);
      await expect(new FileSetupStateStore(permissive).load()).rejects.toMatchObject({
        code: "state_permissions",
      });

      const permissiveParent = join(root, "permissive-parent");
      await mkdir(permissiveParent, { mode: 0o700 });
      await chmod(permissiveParent, 0o755);
      await expect(
        new FileSetupStateStore(join(permissiveParent, "state.json")).initialize(
          initialState(),
        ),
      ).rejects.toMatchObject({ code: "unsafe_path" });
    }
  });
});
