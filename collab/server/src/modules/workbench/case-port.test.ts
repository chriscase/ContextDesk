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
import { FilesystemEvidenceStore } from "../../evidence/store.js";
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
import { createWorkbenchCasePort } from "./case-port.js";
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
          privacyClass: "owner_only",
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
          privacyClass: "owner_only",
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
