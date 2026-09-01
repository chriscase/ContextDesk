/**
 * End-to-end journey over HTTP: commit a large synthetic corpus, then find a
 * root cause that lies past the old read boundary.
 *
 * Everything here is generated. No provider, no host binary, no private data.
 *
 * Before this change the journey below was impossible: the workbench read the
 * first 50,000 lines of the investigation and stopped, the API told the
 * responder to narrow their files, and narrowing did not help because the
 * selection was applied after the read. The last assertion is the point — the
 * answer says whether every selected line was actually searched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
  parseCorpusIntakePreviewReport,
  type WorkbenchSearchResultV1,
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
import { MemoryLocalGrantStore } from "../people/index.js";
import { createWorkbenchCasePort } from "./case-port.js";
import { MemoryWorkbenchStore, WorkbenchService } from "./index.js";

const ALICE = "fixture-alice-secret";
const ROLE_MAP = "cn=contributors,ou=groups,dc=example,dc=test=contributor";
const TOTAL_LINES = 200_000;
const ROOT_CAUSE_LINE = 150_000;
const ROOT_CAUSE = "connection pool exhausted while draining the retry queue";

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

/** A believable but entirely generated gateway log with one late root cause. */
function syntheticLog(): string {
  const lines: string[] = [];
  for (let n = 1; n <= TOTAL_LINES; n += 1) {
    if (n === ROOT_CAUSE_LINE) lines.push(`2024-03-10T09:14:02Z ERROR ${ROOT_CAUSE} rid-${n}`);
    else lines.push(`2024-03-10T08:00:00Z INFO edge accepted request rid-${n}`);
  }
  return `${lines.join("\n")}\n`;
}

async function harness(root: string) {
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
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(ROLE_MAP));
  const grants = new MemoryLocalGrantStore();
  await grants.grant(
    "uid=alice,ou=people,dc=example,dc=test",
    "evidence:private:read",
    "fixture",
  );
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    workbench,
    grants,
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
  return app;
}

describe("finding a late root cause over HTTP", () => {
  it("reaches line 150,000 of a 200,000-line corpus and states its coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-workbench-journey-"));
    const app = await harness(root);
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: ALICE },
      });
      expect(login.statusCode).toBe(200);
      const raw = login.headers["set-cookie"];
      const cookieValue = Array.isArray(raw) ? raw[0] : raw;
      const cookie = typeof cookieValue === "string" ? (cookieValue.split(";")[0] ?? "") : "";

      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie },
        payload: { title: "Late root cause" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = (JSON.parse(created.body) as { id: string }).id;

      const contentBase64 = Buffer.from(syntheticLog(), "utf8").toString("base64");
      const files = [
        { relativePath: "gateway/edge.log", mediaType: "text/plain", contentBase64 },
      ];
      const preview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "files",
          sourceLabel: "synthetic-gateway",
          privacyClass: "owner_only",
          idempotencyKey: "workbench-journey-0001",
          files,
          archiveBase64: null,
        },
      });
      expect(preview.statusCode, preview.body.slice(0, 400)).toBe(200);
      const report = parseCorpusIntakePreviewReport(JSON.parse(preview.body));
      const committed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie },
        payload: {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "synthetic-gateway",
          privacyClass: "owner_only",
          idempotencyKey: "workbench-journey-0001",
          previewToken: report.previewToken,
          files,
          archiveBase64: null,
        },
      });
      expect(committed.statusCode).toBe(200);

      // The inventory counts every line, not the first 50,000.
      const inventory = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/workbench`,
        headers: { cookie },
      });
      expect(inventory.statusCode).toBe(200);
      const listing = JSON.parse(inventory.body) as {
        items: { evidenceId: string; digest: string; lineCount: number; fullyRead: boolean }[];
        corpusTruncated: boolean;
        unreadFiles: string[];
      };
      expect(listing.corpusTruncated).toBe(false);
      expect(listing.unreadFiles).toEqual([]);
      expect(listing.items[0]?.lineCount).toBe(TOTAL_LINES);
      expect(listing.items[0]?.fullyRead).toBe(true);
      const evidenceId = listing.items[0]!.evidenceId;
      const fileDigest = listing.items[0]!.digest;

      // An unauthenticated caller is refused before any byte is read.
      const anonymous = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/workbench/search`,
        payload: { schemaId: WORKBENCH_SEARCH_REQUEST_SCHEMA_ID, query: "pool" },
      });
      expect(anonymous.statusCode).toBeGreaterThanOrEqual(401);

      const search = async (pageCursor: string | null): Promise<WorkbenchSearchResultV1> => {
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/workbench/search`,
          headers: { cookie },
          payload: {
            schemaId: WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
            query: "connection pool exhausted",
            mode: "case_insensitive",
            filters: {
              includeTerms: [],
              excludeTerms: [],
              severity: null,
              component: null,
              file: null,
              rotationFamily: null,
              timeFrom: null,
              timeTo: null,
              evidenceIds: [],
            },
            contextBefore: 1,
            contextAfter: 1,
            cursor: 0,
            pageCursor,
            limit: 50,
            expectedNormalizationRevision: null,
          },
        });
        expect(response.statusCode).toBe(200);
        return JSON.parse(response.body) as WorkbenchSearchResultV1;
      };

      const first = await search(null);
      // The first page cannot reach line 150,000 inside its work budget, and
      // says so as a page that stopped rather than a corpus that was cut off.
      expect(first.returned).toBe(0);
      expect(first.coverageComplete).toBe(false);
      expect(first.corpusTruncated).toBe(false);
      expect(first.nextPageCursor).not.toBeNull();

      const pages = [first];
      let cursor = first.nextPageCursor;
      while (cursor !== null && pages.length < 20) {
        const next = await search(cursor);
        pages.push(next);
        cursor = next.nextPageCursor;
      }
      const found = pages.flatMap((page) => page.matches);
      expect(found).toHaveLength(1);
      expect(found[0]?.lineNumber).toBe(ROOT_CAUSE_LINE);
      expect(found[0]?.text).toContain(ROOT_CAUSE);
      const last = pages.at(-1)!;
      // The whole point: the answer states that every selected line was read.
      expect(last.coverageComplete).toBe(true);
      expect(last.scannedLinesTotal).toBeGreaterThanOrEqual(TOTAL_LINES);
      expect(last.nextPageCursor).toBeNull();

      // The same line pages directly, and a locator bound to it resolves.
      const page = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/workbench/page?evidenceId=${evidenceId}&startLine=${ROOT_CAUSE_LINE}&limit=2`,
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      const rows = (JSON.parse(page.body) as { rows: { lineNumber: number; text: string }[] }).rows;
      expect(rows[0]?.lineNumber).toBe(ROOT_CAUSE_LINE);
      expect(rows[0]?.text).toContain(ROOT_CAUSE);

      const bookmark = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/workbench/bookmarks`,
        headers: { cookie },
        payload: {
          locator: {
            evidenceId,
            digestAtBind: fileDigest,
            byteOffset: found[0]!.byteOffset,
            lineNumber: ROOT_CAUSE_LINE,
            originalTimestamp: found[0]!.originalTimestamp,
            normalizedUtc: found[0]!.normalizedUtc,
            corpusRevision: null,
          },
          note: "root cause",
          idempotencyKey: "workbench-journey-bookmark-0001",
        },
      });
      expect(bookmark.statusCode, bookmark.body.slice(0, 300)).toBe(200);
      const saved = JSON.parse(bookmark.body) as {
        status: string;
        staleReason: string | null;
        shareSafeToken: string;
      };
      // A locator this deep in the corpus resolves. It used to be reported
      // unresolvable, because resolving it meant re-reading the whole
      // investigation and the read never reached line 150,000.
      expect(saved.status).toBe("resolved");
      expect(saved.staleReason).toBeNull();

      const resolved = await app.inject({
        method: "POST",
        url: "/api/workbench/locators/resolve",
        headers: { cookie },
        payload: {
          schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
          token: saved.shareSafeToken,
        },
      });
      expect(resolved.statusCode).toBe(200);
      const locator = JSON.parse(resolved.body) as {
        status: string;
        lineNumber: number | null;
        relativePath: string | null;
      };
      expect(locator.status).toBe("resolved");
      expect(locator.lineNumber).toBe(ROOT_CAUSE_LINE);
      expect(locator.relativePath).toBe("gateway/edge.log");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
