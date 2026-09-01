/**
 * Workbench case-port reads investigation-owned intake bytes, not the catalog.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  parseCorpusIntakePreviewReport,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { BoundedEvidenceReadError } from "../../evidence/bounded-read.js";
import {
  FilesystemEvidenceStore,
  sha256Hex,
  type EvidenceStore,
} from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { MemoryLogTimeStore } from "../log-time/index.js";
import {
  WORKBENCH_EVIDENCE_MAX_BYTES,
  createWorkbenchCasePort,
} from "./case-port.js";
import { MemoryWorkbenchStore, WorkbenchService } from "./index.js";

const ALICE = "fixture-alice-secret";
const LOG = "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003\n";

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const roleMap =
  "cn=contributors,ou=groups,dc=example,dc=test=contributor";

describe("workbench case-port over committed intake", () => {
  it("lists ZIP-committed logs by relative path and serves them over HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-workbench-port-"));
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const caseStore = new MemoryCaseStore();
    const catalog = new CatalogService(undefined, audit);
    const domain = new CaseService(store, audit, caseStore, catalog);
    const logTimeStore = new MemoryLogTimeStore();
    const workbench = new WorkbenchService({
      store: new MemoryWorkbenchStore(),
      cases: createWorkbenchCasePort({
        cases: caseStore,
        domain,
        evidence: store,
        currentNormalizationRevision: async (caseId) =>
          (await logTimeStore.getCorpus(caseId))?.corpusRevision ?? null,
      }),
      audit,
    });
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root }),
      pool: null,
      store,
      domain,
      catalog,
      workbench,
      security: {
        auth: {
          adapter: new MapAuthAdapter(users()),
          sessions: new MemorySessionStore(),
          policy: defaultSessionPolicy,
          roles,
          audit,
          log: createAuthLog(),
          limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
          cookieSecure: false,
        },
        roles,
        audit,
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: ALICE },
      });
      expect(login.statusCode).toBe(200);
      const raw = login.headers["set-cookie"];
      const cookieValue = Array.isArray(raw) ? raw[0] : raw;
      const cookie =
        typeof cookieValue === "string" ? (cookieValue.split(";")[0] ?? "") : "";
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie },
        payload: { title: "Workbench port" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = (JSON.parse(created.body) as { id: string }).id;
      const preview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "share_safe",
          idempotencyKey: "workbench-port-0001",
          files: [
            {
              relativePath: "gateway/edge.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from(LOG).toString("base64"),
            },
          ],
          archiveBase64: null,
        },
      });
      expect(preview.statusCode).toBe(200);
      const report = parseCorpusIntakePreviewReport(JSON.parse(preview.body));
      const committed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie },
        payload: {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "share_safe",
          idempotencyKey: "workbench-port-0001",
          previewToken: report.previewToken,
          files: [
            {
              relativePath: "gateway/edge.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from(LOG).toString("base64"),
            },
          ],
          archiveBase64: null,
        },
      });
      expect(committed.statusCode).toBe(200);
      const inventory = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/workbench`,
        headers: { cookie },
      });
      expect(inventory.statusCode).toBe(200);
      const body = JSON.parse(inventory.body) as {
        items?: { relativePath: string; displayLabel: string }[];
      };
      expect(body.items?.map((item) => item.relativePath)).toEqual(["gateway/edge.log"]);
      expect(body.items?.[0]?.displayLabel).toBe("edge.log");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workbench case-port bounded evidence reads", () => {
  const bytes = new TextEncoder().encode("2026-08-31T00:00:00Z INFO exact\n");
  const hash = sha256Hex(bytes);
  const actor = { id: "actor-1", username: "actor-one" };

  function portFor(
    byteLength = bytes.byteLength,
    present = true,
    privacyClass: "owner_only" | "share_safe" = "owner_only",
  ) {
    const calls = { get: 0, head: 0, openRead: 0 };
    const artifact = {
      id: "evidence-1",
      caseId: "case-1",
      filename: null,
      relativePath: "logs/exact.log",
      contentHash: hash,
      byteLength,
      refId: null,
      intakeBatchId: null,
      privacyClass,
    };
    const evidence = {
      get: async () => {
        calls.get += 1;
        throw new Error("workbench bounded path must not call get");
      },
      head: async () => {
        calls.head += 1;
        return present ? { hash, byteLength, contentType: null } : null;
      },
      openRead: async () => {
        calls.openRead += 1;
        return {
          meta: { hash, byteLength: bytes.byteLength, contentType: null },
          range: null,
          byteLength: bytes.byteLength,
          bytes: async function* () { yield bytes; },
        };
      },
    } as unknown as EvidenceStore;
    const port = createWorkbenchCasePort({
      cases: {
        listArtifactsByCase: async () => [artifact],
      } as unknown as MemoryCaseStore,
      domain: {
        getReadableHeldArtifact: async (
          _caseId: string,
          _evidenceId: string,
          _actor: typeof actor,
          _isAdmin: boolean,
          canReadPrivate: boolean,
        ) => privacyClass === "share_safe" || canReadPrivate ? artifact : null,
      } as unknown as CaseService,
      evidence,
      currentNormalizationRevision: async () => null,
    });
    return { port, calls };
  }

  it("uses strict Head/OpenRead for one file and exposes no production bulk method", async () => {
    const { port, calls } = portFor();
    await expect(
      port.listEvidenceDescriptors?.("case-1", actor, false, true),
    ).resolves.toEqual([{
      evidenceId: "evidence-1",
      relativePath: "logs/exact.log",
      digest: hash,
      intakeBatchId: null,
      privacyClass: "owner_only",
    }]);
    await expect(port.readEvidenceText?.("case-1", "evidence-1", actor, false, true))
      .resolves.toBe(new TextDecoder().decode(bytes));
    expect(port.listEvidenceFiles).toBeUndefined();
    expect(calls).toEqual({ get: 0, head: 2, openRead: 1 });
  });

  it("keeps an over-cap artifact metadata-viewable but rejects its selected read before storage", async () => {
    const { port, calls } = portFor(WORKBENCH_EVIDENCE_MAX_BYTES + 1);
    await expect(port.listEvidenceDescriptors?.("case-1", actor, false, true))
      .resolves.toHaveLength(1);
    calls.head = 0;
    await expect(port.readEvidenceText?.("case-1", "evidence-1", actor, false, true))
      .rejects.toBeInstanceOf(BoundedEvidenceReadError);
    expect(calls).toEqual({ get: 0, head: 0, openRead: 0 });
  });

  it("preserves missing-byte behavior without opening a body", async () => {
    const { port, calls } = portFor(bytes.byteLength, false);
    await expect(
      port.listEvidenceDescriptors?.("case-1", actor, false, true),
    ).resolves.toEqual([]);
    await expect(
      port.readEvidenceText?.("case-1", "evidence-1", actor, false, true),
    ).resolves.toBeNull();
    expect(calls).toEqual({ get: 0, head: 2, openRead: 0 });
  });

  it("omits owner-only descriptors and rechecks a revoked grant before bytes", async () => {
    const { port, calls } = portFor();
    await expect(
      port.listEvidenceDescriptors?.("case-1", actor, false, false),
    ).resolves.toEqual([]);
    await expect(
      port.readEvidenceText?.("case-1", "evidence-1", actor, false, false),
    ).resolves.toBeNull();
    expect(calls).toEqual({ get: 0, head: 0, openRead: 0 });

    await expect(
      port.listEvidenceDescriptors?.("case-1", actor, false, true),
    ).resolves.toHaveLength(1);
    calls.head = 0;
    await expect(
      port.readEvidenceText?.("case-1", "evidence-1", actor, false, false),
    ).resolves.toBeNull();
    expect(calls).toEqual({ get: 0, head: 0, openRead: 0 });
  });

  it("keeps share-safe evidence readable without a private-read capability", async () => {
    const { port, calls } = portFor(bytes.byteLength, true, "share_safe");
    await expect(
      port.listEvidenceDescriptors?.("case-1", actor, false, false),
    ).resolves.toHaveLength(1);
    await expect(
      port.readEvidenceText?.("case-1", "evidence-1", actor, false, false),
    ).resolves.toBe(new TextDecoder().decode(bytes));
    expect(calls).toEqual({ get: 0, head: 2, openRead: 1 });
  });
});
