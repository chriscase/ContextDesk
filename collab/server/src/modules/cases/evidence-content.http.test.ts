import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArtifact, parseEvidenceUploadSuccess } from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore, sha256Hex } from "../../evidence/store.js";
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
const HERE = dirname(fileURLToPath(import.meta.url));

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
  options: { transferTimeoutMs?: number } = {},
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
    ...(options.transferTimeoutMs === undefined
      ? {}
      : { evidenceTransferTimeoutMs: options.transferTimeoutMs }),
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

function expectStorageUnavailable(res: { statusCode: number; body: string }): void {
  expect(res.statusCode).toBe(503);
  expect(JSON.parse(res.body)).toEqual({ error: "storage_unavailable" });
  expect(res.body).not.toMatch(/verification|blob|password|contentBase64/i);
}

function spyJsonBytesStore(store: FilesystemEvidenceStore) {
  return {
    get: vi.spyOn(store, "get"),
    head: vi.spyOn(store, "head"),
    openRead: vi.spyOn(store, "openRead"),
  };
}

function mockReadHandle(input: {
  hash: string;
  byteLength: number;
  range?: { start: number; end: number } | null;
  handleByteLength?: number;
  metaHash?: string;
  metaByteLength?: number;
  chunks: Uint8Array[];
  onReturn?: () => void;
  onNext?: (index: number, chunk: Uint8Array) => void;
}) {
  let index = 0;
  return {
    meta: {
      hash: input.metaHash ?? input.hash,
      byteLength: input.metaByteLength ?? input.byteLength,
      contentType: null,
    },
    range: input.range === undefined ? null : input.range,
    byteLength: input.handleByteLength ?? input.byteLength,
    bytes: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (index >= input.chunks.length) {
            return { done: true as const, value: undefined };
          }
          const chunk = input.chunks[index] ?? new Uint8Array();
          input.onNext?.(index, chunk);
          index += 1;
          return { done: false as const, value: chunk };
        },
        return: async () => {
          input.onReturn?.();
          return { done: true as const, value: undefined };
        },
      }),
    }),
  };
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
        filename: "quote_name.log",
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
      const readsBeforeValidators = openRead.mock.calls.length;
      for (const validator of [
        "*",
        `W/${etag}`,
        `"${"0".repeat(64)}", W/${etag}`,
      ]) {
        const conditional = await app.inject({
          method: "GET",
          url,
          headers: { cookie: dave, "if-none-match": validator },
        });
        expect(conditional.statusCode, validator).toBe(304);
        expect(conditional.body).toBe("");
        expect(conditional.headers.etag).toBe(etag);
      }
      expect(openRead).toHaveBeenCalledTimes(readsBeforeValidators);

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

  it("returns authorized JSON bytes without calling EvidenceStore.get", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyJsonBytesStore(store);
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Json bytes success");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "json bytes",
        privacyClass: "share_safe",
      });
      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      const response = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${artifact.id}/bytes`,
        headers: { cookie: dave },
      });
      expect(response.statusCode).toBe(200);
      expect(
        Buffer.from(
          (JSON.parse(response.body) as { contentBase64: string }).contentBase64,
          "base64",
        ).toString("utf8"),
      ).toBe(LOG);
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.head).toHaveBeenCalledTimes(1);
      expect(spies.openRead).toHaveBeenCalledTimes(1);
      expect(spies.head.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        spies.openRead.mock.invocationCallOrder[0] ?? 0,
      );
    });
  });

  it("returns JSON bytes when the opened handle yields a thenable iterable", async () => {
    await withApp(async ({ app, store }) => {
      const originalOpen = store.openRead.bind(store);
      const spies = spyJsonBytesStore(store);
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Thenable json bytes");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "thenable bytes",
        privacyClass: "share_safe",
      });
      spies.openRead.mockImplementation(async (hash, range) => {
        const handle = await originalOpen(hash, range);
        return {
          ...handle,
          bytes: async () => handle.bytes(),
        };
      });
      spies.get.mockClear();
      const response = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${artifact.id}/bytes`,
        headers: { cookie: dave },
      });
      expect(response.statusCode).toBe(200);
      expect(
        Buffer.from(
          (JSON.parse(response.body) as { contentBase64: string }).contentBase64,
          "base64",
        ).toString("utf8"),
      ).toBe(LOG);
      expect(spies.get).not.toHaveBeenCalled();
    });
  });

  it("refuses oversized JSON bytes without calling evidence.get", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyJsonBytesStore(store);
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
      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      const response = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${artifact.id}/bytes`,
        headers: { cookie: dave },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "too_large_for_json_bytes" });
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.head).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();
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

  it("fails closed with 503 for missing, corrupt, truncated, replaced, and mismatched JSON bytes", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyJsonBytesStore(store);
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Hostile json bytes");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "hostile store",
        privacyClass: "share_safe",
      });
      const hash = artifact.contentHash ?? "";
      const url = `/api/cases/${caseId}/evidence/${artifact.id}/bytes`;
      const originalHead = store.head.bind(store);
      const originalOpen = store.openRead.bind(store);
      const expected = new TextEncoder().encode(LOG);

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.head.mockResolvedValueOnce(null);
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.head.mockResolvedValueOnce({
        hash,
        byteLength: expected.byteLength + 64,
        contentType: null,
      });
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();

      spies.head.mockImplementation(originalHead);

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        chunks: [Uint8Array.from(expected.map((byte) => byte ^ 0xff))],
      }));
      const corrupt = await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      });
      expectStorageUnavailable(corrupt);
      expect(JSON.parse(corrupt.body)).not.toHaveProperty("contentBase64");
      expect(spies.get).not.toHaveBeenCalled();

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        chunks: [expected.subarray(0, 4)],
      }));
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        range: { start: 0, end: expected.byteLength - 1 },
        chunks: [expected],
      }));
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        handleByteLength: expected.byteLength + 1,
        chunks: [expected],
      }));
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();

      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        metaHash: "0".repeat(64),
        chunks: [expected],
      }));
      expectStorageUnavailable(await app.inject({
        method: "GET",
        url,
        headers: { cookie: dave },
      }));
      expect(spies.get).not.toHaveBeenCalled();

      spies.openRead.mockImplementation(originalOpen);
      expect(sha256Hex(expected)).toBe(hash);
    });
  });

  it("rejects an oversize JSON-bytes chunk before retaining it and closes the iterator", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyJsonBytesStore(store);
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Oversize json chunk");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "app.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "oversize chunk",
        privacyClass: "share_safe",
      });
      const hash = artifact.contentHash ?? "";
      const expected = new TextEncoder().encode(LOG);
      const huge = new Uint8Array(1_000_001).fill(0x61);
      let returned = 0;
      let nextCalls = 0;
      spies.get.mockClear();
      spies.head.mockClear();
      spies.openRead.mockClear();
      spies.openRead.mockResolvedValueOnce(mockReadHandle({
        hash,
        byteLength: expected.byteLength,
        chunks: [expected.subarray(0, 4), huge, expected],
        onNext: () => {
          nextCalls += 1;
        },
        onReturn: () => {
          returned += 1;
        },
      }));
      const response = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${artifact.id}/bytes`,
        headers: { cookie: dave },
      });
      expectStorageUnavailable(response);
      expect(spies.get).not.toHaveBeenCalled();
      expect(nextCalls).toBe(2);
      expect(returned).toBeGreaterThan(0);
      expect(response.body).not.toContain(Buffer.from(huge).toString("base64").slice(0, 24));
    });
  });

  it("does not call EvidenceStore.get from the JSON bytes service path", () => {
    const serviceSrc = readFileSync(join(HERE, "service.ts"), "utf8");
    const jsonBytes = serviceSrc.slice(
      serviceSrc.indexOf("async getArtifactJsonBytes"),
      serviceSrc.indexOf("async headEvidence"),
    );
    expect(jsonBytes).toContain("headEvidence");
    expect(jsonBytes).toContain("openEvidenceRead");
    expect(jsonBytes).not.toMatch(/this\.evidence\.get\s*\(/);
    expect(jsonBytes).toContain("collectExactJsonEvidenceBytes");
  });

  it("aborts a stalled verification preflight without publishing a response and cleans guards", async () => {
    await withApp(async ({ app, store }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await createCase(app, alice, "Timed out content");
      const artifact = await streamUpload(app, alice, caseId, {
        kind: "log",
        filename: "timeout.log",
        mediaType: "text/plain",
        body: LOG,
        summary: "stalled read",
        privacyClass: "share_safe",
      });
      let observedSignal: AbortSignal | undefined;
      store.openRead = vi.fn(async (_hash, _range, signal) => {
        observedSignal = signal;
        if (!signal) throw new Error("missing transfer signal");
        await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        throw new Error("unreachable");
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      let responsePublished = false;
      let requestRaw: http.IncomingMessage | undefined;
      let replyRaw: http.ServerResponse | undefined;
      app.server.once("request", (request, response) => {
        requestRaw = request;
        replyRaw = response;
      });
      const started = Date.now();
      await Promise.race([
        new Promise<void>((resolve) => {
          const req = http.request({
            method: "GET",
            host: "127.0.0.1",
            port,
            path: `/api/cases/${caseId}/evidence/${artifact.id}/content`,
            headers: { cookie: dave },
          });
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          req.on("error", done);
          req.on("close", done);
          req.on("response", (response) => {
            responsePublished = true;
            response.on("aborted", done);
            response.on("error", done);
            response.on("close", done);
          });
          req.end();
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("transfer guard did not terminate download")), 3_000);
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(2_500);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(observedSignal?.aborted).toBe(true);
      expect(store.openRead).toHaveBeenCalledTimes(1);
      expect(responsePublished).toBe(false);
      expect(requestRaw?.listenerCount("aborted") ?? 0).toBe(0);
      expect(replyRaw?.listenerCount("close") ?? 0).toBe(0);
    }, { transferTimeoutMs: 1_000 });
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
