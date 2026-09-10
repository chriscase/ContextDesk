import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvidenceStorageStatus } from "@cd-collab/contracts";
import type { EvidenceStorageProviderIdentityBinding } from "@cd-collab/contracts/evidence-storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp, projectStartupEvidenceProviderIdentityBinding } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import type { EvidenceProviderInstanceInitialization } from "../../evidence/provider-instance.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";

async function appForTest(options: {
  ping?: () => Promise<void>;
  s3?: boolean;
  store?: {
    ping(): void | Promise<void>;
    inspectProviderInstance?: () => Promise<unknown>;
    initializeProviderInstance?: () => Promise<unknown>;
    recoverUnreferencedWrites?: () => Promise<unknown>;
  };
  evidenceProviderIdentityBinding?: EvidenceStorageProviderIdentityBinding;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-evidence-storage-status-"));
  const audit = new MemoryAuditStore();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap("local:admins=admin;local:viewers=viewer"));
  const config = testConfig({
    evidenceRoot: root,
    authMode: "local",
    ...(options.s3
      ? {
          evidence: {
            provider: "s3" as const,
            controlRoot: root,
            storage: "postgres" as const,
            maxUploadBytes: 30_000_000,
            s3: {
              endpoint: "https://garage.example.test:3900",
              region: "garage",
              bucket: "war-room-evidence",
              prefix: "contextdesk/",
              forcePathStyle: true,
              allowHttp: false,
              caConfigured: false,
              caFilePath: null,
              timeoutMs: 30_000,
              maxUploadBytes: 30_000_000,
              credentialsMode: "default_chain" as const,
            },
          },
        }
      : {}),
  });
  const store = options.store
    ?? (options.ping ? { ping: options.ping } : new FilesystemEvidenceStore({ rootDir: root }));
  const app = await buildApp({
    config,
    pool: null,
    store,
    ...(options.evidenceProviderIdentityBinding
      ? { evidenceProviderIdentityBinding: options.evidenceProviderIdentityBinding }
      : {}),
    security: {
      auth: {
        adapter: new MapAuthAdapter(new Map([
          ["admin", { password: "admin-secret", identity: { id: "local:admin", username: "admin", displayName: "Admin" }, groups: ["local:admins"] }],
          ["viewer", { password: "viewer-secret", identity: { id: "local:viewer", username: "viewer", displayName: "Viewer" }, groups: ["local:viewers"] }],
        ])),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 5, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      roleStore: new MemoryGroupRoleStore(roles),
      audit,
    },
  });
  return { app, root };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: "admin" | "viewer") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: `${username}-secret` },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

describe("evidence storage status route", () => {
  it("is admin-only and reports secret-free filesystem readiness", async () => {
    const { app, root } = await appForTest();
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/evidence-storage" })).statusCode).toBe(401);
      const viewer = await login(app, "viewer");
      expect((await app.inject({ method: "GET", url: "/api/admin/evidence-storage", headers: { cookie: viewer } })).statusCode).toBe(403);
      const admin = await login(app, "admin");
      const response = await app.inject({ method: "GET", url: "/api/admin/evidence-storage", headers: { cookie: admin } });
      expect(response.statusCode).toBe(200);
      const body = parseEvidenceStorageStatus(JSON.parse(response.body));
      expect(body.provider).toBe("filesystem");
      expect(body.state).toBe("ready");
      expect(body.providerIdentityBinding).toBe("not_reported");
      expect(body.endpoint).toBeNull();
      expect(response.body).not.toMatch(/secret|access.?key|controlRoot|caFile/i);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unavailable provider without leaking implementation details", async () => {
    const { app, root } = await appForTest({ ping: async () => { throw new Error("private storage credentials"); } });
    try {
      const admin = await login(app, "admin");
      const response = await app.inject({ method: "GET", url: "/api/admin/evidence-storage", headers: { cookie: admin } });
      expect(response.statusCode).toBe(200);
      expect(parseEvidenceStorageStatus(JSON.parse(response.body)).state).toBe("unavailable");
      expect(response.body).not.toMatch(/private storage credentials|secret/i);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows only non-secret S3 connection facts", async () => {
    const { app, root } = await appForTest({ s3: true });
    try {
      const admin = await login(app, "admin");
      const response = await app.inject({ method: "GET", url: "/api/admin/evidence-storage", headers: { cookie: admin } });
      const body = parseEvidenceStorageStatus(JSON.parse(response.body));
      expect(body.provider).toBe("s3");
      expect(body.bucket).toBe("war-room-evidence");
      expect(body.credentialsMode).toBe("default_chain");
      expect(body.providerIdentityBinding).toBe("not_reported");
      expect(response.body).not.toMatch(/accessKey|secretAccess|controlRoot|caFile/i);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports validated after a configured prepare and legacy_unbound after an unpinned prepare", async () => {
    const pin = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
    const prepared = {
      outcome: "created",
      manifest: {
        schemaId: "cd-collab.evidence_provider_instance.v1",
        providerInstanceId: pin,
        providerKind: "filesystem",
      },
    } as const satisfies EvidenceProviderInstanceInitialization;
    expect(projectStartupEvidenceProviderIdentityBinding(prepared)).toBe("validated");
    expect(projectStartupEvidenceProviderIdentityBinding({ ...prepared, outcome: "existing" }))
      .toBe("validated");
    expect(projectStartupEvidenceProviderIdentityBinding({ ...prepared, outcome: "reconciled" }))
      .toBe("validated");
    expect(projectStartupEvidenceProviderIdentityBinding(null)).toBe("legacy_unbound");
    expect(() => projectStartupEvidenceProviderIdentityBinding(
      { ...prepared, outcome: "matching" } as unknown as EvidenceProviderInstanceInitialization,
    ))
      .toThrow(/startup preparation is unknown/);
    expect(JSON.stringify(projectStartupEvidenceProviderIdentityBinding(prepared))).not.toContain(pin);

    const { app, root } = await appForTest({ evidenceProviderIdentityBinding: "validated" });
    try {
      const admin = await login(app, "admin");
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/evidence-storage",
        headers: { cookie: admin },
      });
      const body = parseEvidenceStorageStatus(JSON.parse(response.body));
      expect(body.providerIdentityBinding).toBe("validated");
      expect(response.body).not.toContain(pin);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports legacy_unbound from an unpinned startup binding without identity internals", async () => {
    const { app, root } = await appForTest({ evidenceProviderIdentityBinding: "legacy_unbound" });
    try {
      const admin = await login(app, "admin");
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/evidence-storage",
        headers: { cookie: admin },
      });
      expect(parseEvidenceStorageStatus(JSON.parse(response.body)).providerIdentityBinding)
        .toBe("legacy_unbound");
      expect(response.body).not.toMatch(/providerInstanceId|marker|uuid|secret/i);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes with the existing ping only and does not inspect, initialize, or recover identity", async () => {
    const ping = vi.fn(async () => {});
    const inspectProviderInstance = vi.fn(async () => {
      throw new Error("inspect must not run on admin refresh");
    });
    const initializeProviderInstance = vi.fn(async () => {
      throw new Error("initialize must not run on admin refresh");
    });
    const recoverUnreferencedWrites = vi.fn(async () => {
      throw new Error("recovery must not run on admin refresh");
    });
    const { app, root } = await appForTest({
      store: {
        ping,
        inspectProviderInstance,
        initializeProviderInstance,
        recoverUnreferencedWrites,
      },
      evidenceProviderIdentityBinding: "validated",
    });
    try {
      const admin = await login(app, "admin");
      const first = await app.inject({
        method: "GET",
        url: "/api/admin/evidence-storage",
        headers: { cookie: admin },
      });
      const second = await app.inject({
        method: "GET",
        url: "/api/admin/evidence-storage",
        headers: { cookie: admin },
      });
      expect(parseEvidenceStorageStatus(JSON.parse(first.body)).providerIdentityBinding)
        .toBe("validated");
      expect(parseEvidenceStorageStatus(JSON.parse(second.body)).providerIdentityBinding)
        .toBe("validated");
      expect(ping).toHaveBeenCalledTimes(2);
      expect(inspectProviderInstance).not.toHaveBeenCalled();
      expect(initializeProviderInstance).not.toHaveBeenCalled();
      expect(recoverUnreferencedWrites).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
