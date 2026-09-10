import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvidenceRuntime } from "../../evidence/provider.js";
import { EvidenceProviderInstanceStorageError } from "../../evidence/provider-instance.js";
import type { LoadedEvidenceStorageSettings } from "../../evidence/s3-settings.js";
import {
  executeProviderIdentityOperation,
  parseProviderIdentityCliArgs,
  providerIdentityErrorCode,
  PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
  type ProviderIdentityOperatorDeps,
} from "./provider-identity.js";

const PIN = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const CANARY = "do-not-leak-provider-location-or-credential";

describe("provider identity CLI arguments", () => {
  it("accepts only one explicit inspect or confirmed init command", () => {
    expect(parseProviderIdentityCliArgs(["inspect", "--env-file", ".env.local"])).toEqual({
      action: "inspect",
      envFile: ".env.local",
      confirmed: false,
    });
    expect(parseProviderIdentityCliArgs(["init", "--yes", "--env-file", ".env.local"])).toEqual({
      action: "init",
      envFile: ".env.local",
      confirmed: true,
    });
  });

  it.each([
    { argv: [], code: "invalid_arguments" },
    { argv: ["status", "--env-file", ".env"], code: "invalid_arguments" },
    { argv: ["inspect"], code: "invalid_arguments" },
    { argv: ["inspect", "--yes", "--env-file", ".env"], code: "invalid_arguments" },
    { argv: ["inspect", "--env-file"], code: "invalid_arguments" },
    {
      argv: ["inspect", "--env-file", ".env", "--env-file", ".other"],
      code: "invalid_arguments",
    },
    { argv: ["inspect", "--env-file", ".env", "--unknown"], code: "invalid_arguments" },
    { argv: ["init", "--env-file", ".env"], code: "confirmation_required" },
    { argv: ["init", "--yes", "--yes", "--env-file", ".env"], code: "invalid_arguments" },
  ] as const)("rejects ambiguous arguments %#", ({ argv, code }) => {
    try {
      parseProviderIdentityCliArgs(argv);
      throw new Error("expected invalid arguments");
    } catch (error) {
      expect(providerIdentityErrorCode(error)).toBe(code);
    }
  });
});

describe("provider identity operator", () => {
  it("inspects and explicitly initializes a real filesystem location without startup recovery", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cd-provider-identity-operator-"));
    const root = join(parent, "evidence");
    const env = {
      COLLAB_STORAGE: "sqlite",
      COLLAB_EVIDENCE_PROVIDER: "filesystem",
      COLLAB_EVIDENCE_ROOT: root,
      COLLAB_EVIDENCE_PROVIDER_INSTANCE_ID: PIN,
    };
    try {
      const before = await executeProviderIdentityOperation({ action: "inspect", env });
      expect(before.status).toBe("uninitialized");
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      const created = await executeProviderIdentityOperation({
        action: "init",
        confirmed: true,
        env,
      });
      expect(created.status).toBe("created");
      await expect(executeProviderIdentityOperation({ action: "inspect", env }))
        .resolves.toMatchObject({ status: "matching" });
      await expect(executeProviderIdentityOperation({
        action: "init",
        confirmed: true,
        env,
      })).resolves.toMatchObject({ status: "existing" });
      const output = JSON.stringify({ before, created });
      expect(output).not.toContain(PIN);
      expect(output).not.toContain(root);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports legacy-unbound without constructing a runtime or loading credentials", async () => {
    const createRuntime = vi.fn();
    const loadCredentials = vi.fn();
    const result = await executeProviderIdentityOperation({
      action: "inspect",
      env: {},
      deps: deps(filesystemSettings(), createRuntime, loadCredentials),
    });
    expect(result).toEqual({
      schemaId: PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
      action: "inspect",
      status: "legacy_unbound",
      provider: "filesystem",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it("refuses init confirmation and a missing pin before runtime construction", async () => {
    const createRuntime = vi.fn();
    const loadSettings = vi.fn(() => filesystemSettings());
    await expect(executeProviderIdentityOperation({
      action: "init",
      env: {},
      deps: { ...deps(filesystemSettings(), createRuntime), loadSettings },
    })).rejects.toMatchObject({ code: "confirmation_required" });
    expect(loadSettings).not.toHaveBeenCalled();

    await expect(executeProviderIdentityOperation({
      action: "init",
      confirmed: true,
      env: {},
      deps: deps(filesystemSettings(), createRuntime),
    })).rejects.toMatchObject({ code: "pin_required" });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("inspects a pinned location without initialization, ping, or recovery", async () => {
    const inspectProviderInstance = vi.fn(async () => null);
    const initializeProviderInstance = vi.fn();
    const runtime = fakeRuntime({ inspectProviderInstance, initializeProviderInstance });
    const createRuntime = vi.fn(() => runtime);
    await expect(executeProviderIdentityOperation({
      action: "inspect",
      env: {},
      deps: deps(filesystemSettings(PIN), createRuntime),
    })).resolves.toMatchObject({ status: "uninitialized", provider: "filesystem" });
    expect(inspectProviderInstance).toHaveBeenCalledOnce();
    expect(initializeProviderInstance).not.toHaveBeenCalled();
    expect(runtime.store.ping).not.toHaveBeenCalled();
    expect(runtime.store.recoverUnreferencedWrites).not.toHaveBeenCalled();
  });

  it("reports a matching S3 marker without revealing identity or location", async () => {
    const runtime = fakeRuntime({
      inspectProviderInstance: vi.fn(async () => ({
        schemaId: "cd-collab.evidence_provider_instance.v1",
        providerInstanceId: PIN,
        providerKind: "s3",
      })),
    });
    const result = await executeProviderIdentityOperation({
      action: "inspect",
      env: { CANARY },
      deps: deps(s3Settings(PIN), vi.fn(() => runtime)),
    });
    expect(result).toMatchObject({ status: "matching", provider: "s3" });
    expect(JSON.stringify(result)).not.toContain(PIN);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it.each(["created", "existing", "reconciled"] as const)(
    "projects only sanitized %s initialization status",
    async (outcome) => {
      const runtime = fakeRuntime({
        initializeProviderInstance: vi.fn(async () => ({
          outcome,
          manifest: {
            schemaId: "cd-collab.evidence_provider_instance.v1",
            providerInstanceId: PIN,
            providerKind: "filesystem",
          },
        })),
      });
      const result = await executeProviderIdentityOperation({
        action: "init",
        confirmed: true,
        env: {},
        deps: deps(filesystemSettings(PIN), vi.fn(() => runtime)),
      });
      expect(result).toEqual({
        schemaId: PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
        action: "init",
        status: outcome,
        provider: "filesystem",
      });
      expect(runtime.inspectProviderInstance).not.toHaveBeenCalled();
      expect(runtime.store.ping).not.toHaveBeenCalled();
      expect(runtime.store.recoverUnreferencedWrites).not.toHaveBeenCalled();
    },
  );

  it.each([
    "invalid",
    "identity_mismatch",
    "unavailable",
    "initialization_outcome_unknown",
  ] as const)("preserves only sanitized %s failures", async (code) => {
    const runtime = fakeRuntime({
      inspectProviderInstance: vi.fn(async () => {
        throw new EvidenceProviderInstanceStorageError(code);
      }),
    });
    let failure: unknown;
    try {
      await executeProviderIdentityOperation({
        action: "inspect",
        env: { CANARY },
        deps: deps(filesystemSettings(PIN), vi.fn(() => runtime)),
      });
    } catch (error) {
      failure = error;
    }
    expect(providerIdentityErrorCode(failure)).toBe(code);
    expect(JSON.stringify(failure)).not.toContain(PIN);
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  });

  it("maps raw configuration and runtime failures to stable sanitized codes", async () => {
    await expect(executeProviderIdentityOperation({
      action: "inspect",
      env: { COLLAB_STORAGE: "other", CANARY },
    })).rejects.toMatchObject({ code: "invalid_configuration" });
    const broken = deps(filesystemSettings(PIN), vi.fn(() => {
      throw new Error(CANARY);
    }));
    await expect(executeProviderIdentityOperation({
      action: "inspect",
      env: { CANARY },
      deps: broken,
    })).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});

function filesystemSettings(pin?: string): LoadedEvidenceStorageSettings {
  return {
    provider: "filesystem",
    controlRoot: `/${CANARY}`,
    storage: "sqlite",
    maxUploadBytes: 1024,
    ...(pin ? { expectedProviderInstanceId: pin } : {}),
  };
}

function s3Settings(pin?: string): LoadedEvidenceStorageSettings {
  return {
    provider: "s3",
    controlRoot: `/${CANARY}`,
    storage: "sqlite",
    maxUploadBytes: 1024,
    ...(pin ? { expectedProviderInstanceId: pin } : {}),
    s3: {
      endpoint: `https://${CANARY}.example.test`,
      region: "garage",
      bucket: "war-room-evidence",
      prefix: "assigned/",
      forcePathStyle: true,
      allowHttp: false,
      caConfigured: false,
      caFilePath: null,
      timeoutMs: 30_000,
      maxUploadBytes: 1024,
      credentialsMode: "default_chain",
    },
  };
}

function deps(
  settings: LoadedEvidenceStorageSettings,
  createRuntime: ProviderIdentityOperatorDeps["createRuntime"] = vi.fn(),
  loadCredentials: ProviderIdentityOperatorDeps["loadCredentials"] = vi.fn(() => ({
    mode: "default_chain",
  }) as never),
): ProviderIdentityOperatorDeps {
  return {
    loadSettings: vi.fn(() => settings),
    loadCredentials,
    createRuntime,
  };
}

function fakeRuntime(overrides: Partial<EvidenceRuntime> = {}): EvidenceRuntime {
  return {
    store: {
      ping: vi.fn(async () => undefined),
      recoverUnreferencedWrites: vi.fn(async () => ({})),
    },
    inspectProviderInstance: vi.fn(async () => null),
    initializeProviderInstance: vi.fn(async () => null),
    ...overrides,
  } as unknown as EvidenceRuntime;
}
