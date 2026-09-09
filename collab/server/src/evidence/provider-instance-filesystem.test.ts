import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect as inspectValue } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PROVIDER_INSTANCE_DIRECTORY,
  EVIDENCE_PROVIDER_INSTANCE_FILENAME,
  FilesystemEvidenceProviderInstanceManager,
  type EvidenceProviderInstanceFilesystemOps,
} from "./provider-instance-filesystem.js";
import {
  EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
  EvidenceProviderInstanceStorageError,
  serializeEvidenceProviderInstance,
} from "./provider-instance.js";

const ID_A = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const ID_B = "267ad846-b2e0-4af0-8d87-4d788e48c155";

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "cd-provider-instance-"));
  const root = join(parent, "evidence");
  try {
    return await run(root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function manifestPath(root: string): string {
  return join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY, EVIDENCE_PROVIDER_INSTANCE_FILENAME);
}

function expectStorageCode(
  promise: Promise<unknown>,
  code: EvidenceProviderInstanceStorageError["code"],
): Promise<void> {
  return promise.then(
    () => {
      throw new Error("expected storage failure");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(EvidenceProviderInstanceStorageError);
      expect((error as EvidenceProviderInstanceStorageError).code).toBe(code);
      expect(String(error)).not.toMatch(/8d2f|267a|cd-provider-instance|\.contextdesk/u);
    },
  );
}

function nodeOps(overrides: Partial<EvidenceProviderInstanceFilesystemOps> = {}) {
  const base: EvidenceProviderInstanceFilesystemOps = {
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
  return { ...base, ...overrides };
}

describe("FilesystemEvidenceProviderInstanceManager", () => {
  it("keeps inspection read-only when the namespace is absent", async () => {
    await withRoot(async (root) => {
      let writes = 0;
      const ops = nodeOps({
        mkdir: async (...args) => {
          writes += 1;
          return mkdir(...args);
        },
        link: async (...args) => {
          writes += 1;
          return link(...args);
        },
        unlink: async (...args) => {
          writes += 1;
          return unlink(...args);
        },
      });
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root, ops });
      expect(await manager.inspect()).toBeNull();
      expect(writes).toBe(0);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("initializes canonical owner-only bytes and returns the same identity after restart", async () => {
    await withRoot(async (root) => {
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root });
      const created = await manager.initialize(ID_A);
      expect(created.outcome).toBe("created");
      expect(created.manifest).toEqual({
        schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
        providerInstanceId: ID_A,
        providerKind: "filesystem",
      });
      expect(Object.isFrozen(created)).toBe(true);
      expect(Object.isFrozen(created.manifest)).toBe(true);

      const path = manifestPath(root);
      expect(await readFile(path)).toEqual(Buffer.from(serializeEvidenceProviderInstance(created.manifest)));
      if (process.platform !== "win32") {
        expect((await lstat(path)).mode & 0o077).toBe(0);
      }
      const restarted = new FilesystemEvidenceProviderInstanceManager({ rootDir: root });
      expect(await restarted.inspect(ID_A)).toEqual(created.manifest);
      expect((await restarted.initialize(ID_A)).outcome).toBe("existing");
    });
  });

  it("converges twenty independent concurrent initializers without partial final bytes", async () => {
    await withRoot(async (root) => {
      const managers = Array.from(
        { length: 20 },
        () => new FilesystemEvidenceProviderInstanceManager({ rootDir: root }),
      );
      const observations: string[] = [];
      let reading = true;
      const reader = (async () => {
        while (reading) {
          try {
            observations.push((await readFile(manifestPath(root), "utf8")));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      const results = await Promise.all(managers.map((manager) => manager.initialize()));
      reading = false;
      await reader;
      expect(new Set(results.map((result) => result.manifest.providerInstanceId)).size).toBe(1);
      expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
      const canonical = new TextDecoder().decode(
        serializeEvidenceProviderInstance(results[0]!.manifest),
      );
      observations.push(await readFile(manifestPath(root), "utf8"));
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((body) => body === canonical)).toBe(true);
      const names = await import("node:fs/promises").then(({ readdir }) =>
        readdir(join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY)),
      );
      expect(names).toEqual([EVIDENCE_PROVIDER_INSTANCE_FILENAME]);
    });
  });

  it("never overwrites an existing identity and fails a mismatched pin", async () => {
    await withRoot(async (root) => {
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root });
      await manager.initialize(ID_A);
      const before = await readFile(manifestPath(root));
      await expectStorageCode(manager.inspect(ID_B), "identity_mismatch");
      await expectStorageCode(manager.initialize(ID_B), "identity_mismatch");
      expect(await readFile(manifestPath(root))).toEqual(before);
    });
  });

  it("rejects unsafe namespace and manifest entries and malformed stored data", async () => {
    await withRoot(async (root) => {
      await mkdir(root, { recursive: true });
      const outside = await mkdtemp(join(tmpdir(), "cd-provider-outside-"));
      try {
        await symlink(outside, join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY));
        await expectStorageCode(
          new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(),
          "invalid",
        );
      } finally {
        await rm(join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY), { force: true });
        await rm(outside, { recursive: true, force: true });
      }

      await mkdir(join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY), { mode: 0o700 });
      await writeFile(manifestPath(root), "not-json", { mode: 0o600 });
      await expectStorageCode(
        new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(),
        "invalid",
      );
      await rm(manifestPath(root));
      await symlink("missing", manifestPath(root));
      await expectStorageCode(
        new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(),
        "invalid",
      );
    });
  });

  it("rejects a symlinked evidence root and an accessible namespace", async () => {
    await withRoot(async (root) => {
      const target = await mkdtemp(join(tmpdir(), "cd-provider-root-target-"));
      try {
        await mkdir(join(target, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY), { mode: 0o700 });
        await symlink(target, root);
        await expectStorageCode(
          new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(),
          "invalid",
        );
      } finally {
        await rm(root, { force: true });
        await rm(target, { recursive: true, force: true });
      }

      if (process.platform !== "win32") {
        await mkdir(join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY), {
          recursive: true,
          mode: 0o755,
        });
        await expectStorageCode(
          new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).initialize(ID_A),
          "invalid",
        );
      }
    });
  });

  it("rejects wrong-provider and overly permissive manifests", async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY), {
        recursive: true,
        mode: 0o700,
      });
      const s3 = serializeEvidenceProviderInstance({
        schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
        providerInstanceId: ID_A,
        providerKind: "s3",
      });
      await writeFile(manifestPath(root), s3, { mode: 0o600 });
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root });
      await expectStorageCode(manager.inspect(), "invalid");
      if (process.platform !== "win32") {
        await chmod(manifestPath(root), 0o644);
        await expectStorageCode(manager.inspect(), "invalid");
      }
    });
  });

  it("rechecks permissions on the manifest that was actually opened", async () => {
    if (process.platform === "win32") return;
    await withRoot(async (root) => {
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root });
      await manager.initialize(ID_A);
      const base = nodeOps();
      let changed = false;
      const raced = new FilesystemEvidenceProviderInstanceManager({
        rootDir: root,
        ops: nodeOps({
          open: async (path, flags, mode) => {
            const handle = await base.open(path, flags, mode);
            if (path === manifestPath(root) && !changed) {
              changed = true;
              await chmod(path, 0o644);
            }
            return handle;
          },
        }),
      });
      await expectStorageCode(raced.inspect(), "invalid");
    });
  });

  it("reports directory-sync failure as unknown while leaving later inspection possible", async () => {
    await withRoot(async (root) => {
      const base = nodeOps();
      const ops = nodeOps({
        open: async (path, flags, mode) => {
          const handle = await base.open(path, flags, mode);
          if (path === join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY)) {
            return {
              ...handle,
              close: handle.close.bind(handle),
              read: handle.read.bind(handle),
              stat: handle.stat.bind(handle),
              write: handle.write.bind(handle),
              sync: async () => {
                throw new Error(`private ${root}`);
              },
            };
          }
          return handle;
        },
      });
      const manager = new FilesystemEvidenceProviderInstanceManager({ rootDir: root, ops });
      await expectStorageCode(manager.initialize(ID_A), "initialization_outcome_unknown");
      expect(await new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(ID_A))
        .toMatchObject({ providerInstanceId: ID_A });
    });
  });

  it("reconciles an applied link whose response was lost and syncs the namespace", async () => {
    if (process.platform === "win32") return;
    await withRoot(async (root) => {
      const base = nodeOps();
      let namespaceSyncs = 0;
      const namespace = join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY);
      const manager = new FilesystemEvidenceProviderInstanceManager({
        rootDir: root,
        ops: nodeOps({
          link: async (existingPath, newPath) => {
            await base.link(existingPath, newPath);
            throw new Error("link response lost");
          },
          open: async (path, flags, mode) => {
            const handle = await base.open(path, flags, mode);
            if (path !== namespace) return handle;
            return {
              close: handle.close.bind(handle),
              read: handle.read.bind(handle),
              stat: handle.stat.bind(handle),
              write: handle.write.bind(handle),
              sync: async () => {
                namespaceSyncs += 1;
                await handle.sync();
              },
            };
          },
        }),
      });
      const result = await manager.initialize(ID_A);
      expect(result.outcome).toBe("reconciled");
      expect(result.manifest.providerInstanceId).toBe(ID_A);
      expect(namespaceSyncs).toBeGreaterThan(0);
    });
  });

  it.each(["EIO", "EEXIST"])(
    "reports an applied %s link with failed durability confirmation as unknown",
    async (linkCode) => {
      if (process.platform === "win32") return;
      await withRoot(async (root) => {
        const base = nodeOps();
        const namespace = join(root, EVIDENCE_PROVIDER_INSTANCE_DIRECTORY);
        const manager = new FilesystemEvidenceProviderInstanceManager({
          rootDir: root,
          ops: nodeOps({
            link: async (existingPath, newPath) => {
              await base.link(existingPath, newPath);
              throw Object.assign(new Error("link response lost"), { code: linkCode });
            },
            open: async (path, flags, mode) => {
              const handle = await base.open(path, flags, mode);
              if (path !== namespace) return handle;
              return {
                close: handle.close.bind(handle),
                read: handle.read.bind(handle),
                stat: handle.stat.bind(handle),
                write: handle.write.bind(handle),
                sync: async () => {
                  throw new Error("directory sync unavailable");
                },
              };
            },
          }),
        });
        await expectStorageCode(
          manager.initialize(ID_A),
          "initialization_outcome_unknown",
        );
        expect(await new FilesystemEvidenceProviderInstanceManager({ rootDir: root }).inspect(ID_A))
          .toMatchObject({ providerInstanceId: ID_A });
      });
    },
  );

  it("mints the provider identity once and sanitizes reflective output", async () => {
    await withRoot(async (root) => {
      let calls = 0;
      const manager = new FilesystemEvidenceProviderInstanceManager({
        rootDir: root,
        ops: nodeOps({
          randomProviderInstanceId: () => {
            calls += 1;
            return ID_A;
          },
        }),
      });
      await manager.initialize();
      expect(calls).toBe(1);
      await manager.initialize();
      expect(calls).toBe(1);

      let caught: unknown;
      try {
        await manager.initialize(ID_B);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvidenceProviderInstanceStorageError);
      const all = [String(caught), (caught as Error).stack, JSON.stringify(caught), inspectValue(caught)]
        .join("\n");
      expect(all).not.toMatch(/8d2f|267a|cd-provider-instance|\.contextdesk/u);
    });
  });
});
