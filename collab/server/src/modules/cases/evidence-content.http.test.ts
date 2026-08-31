import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArtifact, parseEvidenceUploadSuccess } from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "./service.js";
import { MemoryCaseStore } from "./store.js";

const ALICE = "fixture-alice-secret";
const LOG = "0123456789abcdef-content-body\n";
const MISSING_ARTIFACT_ID = "10000000-0000-4000-8000-000000000001";

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
    [
      "carol",
      {
        password: "fixture-carol-secret",
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: "fixture-dave-secret",
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

function encodeMultipart(
  parts: Array<
    | { kind: "field"; name: string; value: string }
    | {
      kind: "file";
      name: string;
      filename: string;
      mediaType?: string;
      body: string | Uint8Array;
    }
  >,
  boundary = "----cd-evidence-content-test",
): { payload: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.kind === "field") {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
      ));
    } else {
      const body = typeof part.body === "string" ? Buffer.from(part.body) : Buffer.from(part.body);
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.mediaType ?? "application/octet-stream"}\r\n\r\n`,
      ));
      chunks.push(body);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    store: FilesystemEvidenceStore;
    domain: CaseService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-content-http-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, new MemoryCaseStore(), catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
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
    await fn({ app, store, domain });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function createCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookieHeader: string,
  title: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: cookieHeader },
    payload: { title },
  });
  expect(created.statusCode).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

async function streamUpload(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookieHeader: string,
  caseId: string,
  input: {
    kind: string;
    filename: string;
    mediaType: string;
    body: string | Uint8Array;
    summary: string;
    privacyClass?: string;
  },
) {
  const encoded = encodeMultipart([
    { kind: "field", name: "kind", value: input.kind },
    { kind: "field", name: "summary", value: input.summary },
    { kind: "field", name: "filename", value: input.filename },
    { kind: "field", name: "mediaType", value: input.mediaType },
    ...(input.privacyClass
      ? [{ kind: "field" as const, name: "privacyClass", value: input.privacyClass }]
      : []),
    {
      kind: "file",
      name: "file",
      filename: input.filename,
      mediaType: input.mediaType,
      body: input.body,
    },
  ]);
  const response = await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/evidence/stream`,
    headers: { cookie: cookieHeader, "content-type": encoded.contentType },
    payload: encoded.payload,
  });
  expect(response.statusCode).toBe(200);
  return parseArtifact(parseEvidenceUploadSuccess(JSON.parse(response.body)).artifact);
}

function expectNotFound(res: { statusCode: number; body: string }): void {
  expect(res.statusCode).toBe(404);
  expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  expect(res.statusCode).not.toBe(403);
}

describe("GET/HEAD evidence content and JSON bytes", () => {
  it("returns indistinguishable 404 for privacy, missing, file-ref, and unknown artifacts", async () => {
    await withApp(async ({ app, store }) => {
      const spies = {
        get: vi.spyOn(store, "get"),
        head: vi.spyOn(store, "head"),
        openRead: vi.spyOn(store, "openRead"),
      };
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const carol = await login(app, "carol", "fixture-carol-secret");
      const caseId = await createCase(app, alice, "Content privacy");
      const privateArt = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "private.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "owner only",
        privacyClass: "owner_only",
      });
      const sharedArt = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "shared.log",
        mediaType: "text/plain",
        body: "shared-bytes",
        summary: "share safe",
        privacyClass: "share_safe",
      });
      const ref = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "file_server_ref",
          uri: "https://files.example.test/incident/core.bin",
          summary: "remote",
        },
      });
      expect(ref.statusCode).toBe(200);
      const refId = parseEvidenceUploadSuccess(JSON.parse(ref.body)).artifact.id;

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();

      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${privateArt.id}/bytes`,
        headers: { cookie: alice, range: "bytes=0-3" },
      }));
      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${privateArt.id}/content`,
        headers: { cookie: alice, range: "bytes=0-3" },
      }));
      expectNotFound(await app.inject({
        method: "HEAD",
        url: `/api/cases/${caseId}/evidence/${privateArt.id}/content`,
        headers: { cookie: alice, range: "bytes=0-3" },
      }));
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.head).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();

      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${MISSING_ARTIFACT_ID}/content`,
        headers: { cookie: dave },
      }));
      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${refId}/content`,
        headers: { cookie: dave },
      }));
      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${refId}/bytes`,
        headers: { cookie: dave },
      }));
      expectNotFound(await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${sharedArt.id}/content`,
        headers: { cookie: carol },
      }));
    });
  });

  it("serves HEAD, 200, 206, 304, and 416 with exact content and representation headers", async () => {
    await withApp(async ({ app, store }) => {
      const openRead = vi.spyOn(store, "openRead");
      const dave = await login(app, "dave", "fixture-dave-secret");
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Content ranges");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "attachment",
        filename: 'quote"name.log',
        mediaType: "text/plain",
        body: LOG,
        summary: "ranged",
        privacyClass: "share_safe",
      });
      const hash = artifact.contentHash ?? "";
      const etag = `"${hash}"`;
      const url = `/api/cases/${caseId}/evidence/${artifact.id}/content`;

      const head = await app.inject({
        method: "HEAD",
        url,
        headers: { cookie: dave },
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers.etag).toBe(etag);
      expect(head.headers["accept-ranges"]).toBe("bytes");
      expect(head.headers["content-length"]).toBe(String(LOG.length));
      expect(head.headers["content-type"]).toBe("text/plain");
      expect(head.headers["content-disposition"]).toBe('attachment; filename="quote_name.log"');
      expect(head.headers["cache-control"]).toBe("no-store");
      expect(head.headers["x-content-type-options"]).toBe("nosniff");
      expect(openRead).not.toHaveBeenCalled();

      const full = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      });
      expect(full.statusCode).toBe(200);
      expect(full.body).toBe(LOG);
      expect(full.headers.etag).toBe(etag);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      expect(full.headers["content-length"]).toBe(String(LOG.length));
      expect(full.headers["content-type"]).toBe("text/plain");
      expect(full.headers["cache-control"]).toBe("no-store");
      expect(full.headers["x-content-type-options"]).toBe("nosniff");

      const partial = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave, range: "bytes=0-3" },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.body).toBe(LOG.slice(0, 4));
      expect(partial.headers["content-range"]).toBe(`bytes 0-3/${LOG.length}`);
      expect(partial.headers["content-length"]).toBe("4");

      const tail = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave, range: "bytes=4-" },
      });
      expect(tail.statusCode).toBe(206);
      expect(tail.body).toBe(LOG.slice(4));
      expect(tail.headers["content-range"]).toBe(`bytes 4-${LOG.length - 1}/${LOG.length}`);

      const cached = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave, "if-none-match": etag },
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(etag);

      for (const range of ["bytes=-4", "bytes=0-1,2-3", "bytes=abc", "bytes=5-1", "bytes=99-120"]) {
        const unsat = await app.inject({
          method: "GET",
          url,
          headers: { cookie: dave, range },
        });
        expect(unsat.statusCode, range).toBe(416);
        expect(unsat.headers["content-range"]).toBe(`bytes */${LOG.length}`);
        expect(unsat.body === "" || !unsat.body.includes("schemaId")).toBe(true);
      }
    });
  });

  it("refuses oversized JSON bytes without calling evidence.get", async () => {
    await withApp(async ({ app, store }) => {
      const get = vi.spyOn(store, "get");
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Large json bytes");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "large.log",
        mediaType: "text/plain",
        body: Buffer.alloc(1_000_001, 0x61),
        summary: "large json refusal",
        privacyClass: "share_safe",
      });
      get.mockClear();
      const response = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${artifact.id}/bytes`,
        headers: { cookie: dave },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "too_large_for_json_bytes" });
      expect(get).not.toHaveBeenCalled();
    });
  });

  it("does not read storage before session and case authorization succeed", async () => {
    await withApp(async ({ app, store }) => {
      const spies = {
        get: vi.spyOn(store, "get"),
        head: vi.spyOn(store, "head"),
        openRead: vi.spyOn(store, "openRead"),
      };
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Auth before bytes");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "auth before bytes",
        privacyClass: "share_safe",
      });
      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      const url = `/api/cases/${caseId}/evidence/${artifact.id}`;
      expect((await app.inject({ method: "GET", url: `${url}/bytes` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${url}/content` })).statusCode).toBe(401);
      expect((await app.inject({ method: "HEAD", url: `${url}/content` })).statusCode).toBe(401);
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.head).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();
    });
  });

  it("returns sanitized 503 before headers when openRead fails, and tears down midstream errors", async () => {
    await withApp(async ({ app, store }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Content stream failure");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "stream failure",
        privacyClass: "share_safe",
      });
      const url = `/api/cases/${caseId}/evidence/${artifact.id}/content`;
      const originalOpen = store.openRead.bind(store);
      store.openRead = vi.fn(async () => {
        throw new Error("evidence blob failed verification");
      });
      const beforeHeaders = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      });
      expect(beforeHeaders.statusCode).toBe(503);
      expect(JSON.parse(beforeHeaders.body)).toEqual({ error: "storage_unavailable" });
      expect(beforeHeaders.body).not.toMatch(/verification|blob|password/i);

      let cleaned = 0;
      store.openRead = vi.fn(async (hash, range) => {
        const handle = await originalOpen(hash, range);
        return {
          ...handle,
          bytes: () => ({
            [Symbol.asyncIterator]: () => {
              const inner = handle.bytes()[Symbol.asyncIterator]();
              return {
                next: async () => {
                  throw new Error("evidence blob failed verification");
                },
                return: async () => {
                  cleaned += 1;
                  if (typeof inner.return === "function") await inner.return();
                  return { done: true as const, value: undefined };
                },
              };
            },
          }),
        };
      });
      const midstream = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }).then(
        (res) => res,
        (err: unknown) => ({
          statusCode: 0,
          body: err instanceof Error ? err.message : String(err),
        }),
      );
      expect(midstream.statusCode).not.toBe(200);
      expect(String(midstream.body)).not.toContain("schemaId");
      expect(String(midstream.body)).not.toContain("contentBase64");
      expect(cleaned).toBeGreaterThan(0);
    });
  });
});
