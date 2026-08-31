import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  injectWithoutBrowserCsrf,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, CaseStoreCommitOutcomeUnknownError } from "./service.js";
import { MemoryCaseStore } from "./store.js";
import { assertMultipartTextFieldIntact } from "./routes.js";

const ALICE = "fixture-alice-secret";
const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-stream-1\n";
const EML = [
  "From: sender@example.test",
  "To: oncall@example.test",
  "Subject: synthetic timeout",
  "",
  "The mailer worker timed out.\n",
].join("\r\n");
const HERE = dirname(fileURLToPath(import.meta.url));

class UnknownCommitStore extends MemoryCaseStore {
  unknownCommit = false;
  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    const result = await super.withAtomic(operation, audit);
    if (this.unknownCommit) throw new CaseStoreCommitOutcomeUnknownError();
    return result;
  }
}

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
      "eve",
      {
        password: "fixture-eve-secret",
        identity: {
          id: "uid=eve,ou=people,dc=example,dc=test",
          username: "eve",
          displayName: "eve",
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
  boundary = "----cd-evidence-stream-test",
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

async function listScratch(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".stream-staging"))).sort();
  } catch {
    return [];
  }
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    store: FilesystemEvidenceStore;
    domain: CaseService;
    caseStore: MemoryCaseStore;
    root: string;
  }) => Promise<void>,
  options: {
    maxUploadBytes?: number;
    caseStore?: MemoryCaseStore;
    transferTimeoutMs?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-stream-http-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const caseStore = options.caseStore ?? new MemoryCaseStore();
  const domain = new CaseService(store, audit, caseStore, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({
      evidenceRoot: root,
      evidence: {
        provider: "filesystem",
        controlRoot: root,
        storage: "postgres",
        maxUploadBytes: options.maxUploadBytes ?? 536_870_912,
      },
    }),
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
    await fn({ app, store, domain, caseStore, root });
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

function spyStore(store: FilesystemEvidenceStore) {
  return {
    stageStream: vi.spyOn(store, "stageStream"),
    put: vi.spyOn(store, "put"),
    get: vi.spyOn(store, "get"),
    head: vi.spyOn(store, "head"),
    openRead: vi.spyOn(store, "openRead"),
    beginWriteBatch: vi.spyOn(store, "beginWriteBatch"),
  };
}

describe("POST /api/cases/:id/evidence/stream", () => {
  it("does not call store methods before session, write, and case access succeed", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyStore(store);
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Auth order stream");
      const body = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "unauth" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);

      const unauth = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { "content-type": body.contentType },
        payload: body.payload,
      });
      expect(unauth.statusCode).toBe(401);

      const csrf = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: alice, "content-type": body.contentType },
        payload: body.payload,
      });
      expect(csrf.statusCode).toBe(403);
      expect(JSON.parse(csrf.body)).toMatchObject({ error: "csrf_required" });

      const carol = await login(app, "carol", "fixture-carol-secret");
      const viewer = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: carol, "content-type": body.contentType },
        payload: body.payload,
      });
      expect(viewer.statusCode).toBe(403);

      const eve = await login(app, "eve", "fixture-eve-secret");
      const outsider = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: eve, "content-type": body.contentType },
        payload: body.payload,
      });
      expect(outsider.statusCode).toBe(404);
      expect(JSON.parse(outsider.body)).toEqual({ error: "not_found" });

      expect(spies.stageStream).not.toHaveBeenCalled();
      expect(spies.put).not.toHaveBeenCalled();
      expect(spies.get).not.toHaveBeenCalled();
      expect(spies.head).not.toHaveBeenCalled();
      expect(spies.openRead).not.toHaveBeenCalled();
      expect(spies.beginWriteBatch).not.toHaveBeenCalled();
    });
  });

  it("uploads log, email, and attachment streams without buffering or write batches", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyStore(store);
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Happy stream kinds");
      const samples = [
        {
          kind: "log",
          filename: "app.log",
          mediaType: "text/plain",
          body: LOG,
          summary: "streamed log",
        },
        {
          kind: "email",
          filename: "alert.eml",
          mediaType: "message/rfc822",
          body: EML,
          summary: "streamed email",
        },
        {
          kind: "attachment",
          filename: "capture.bin",
          mediaType: "application/octet-stream",
          body: Uint8Array.from([0, 255, 1, 254]),
          summary: "streamed attachment",
        },
      ] as const;
      for (const sample of samples) {
        const encoded = encodeMultipart([
          { kind: "field", name: "kind", value: sample.kind },
          { kind: "field", name: "summary", value: sample.summary },
          { kind: "field", name: "privacyClass", value: "share_safe" },
          {
            kind: "file",
            name: "file",
            filename: sample.filename,
            mediaType: sample.mediaType,
            body: sample.body,
          },
        ]);
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/evidence/stream`,
          headers: { cookie: alice, "content-type": encoded.contentType },
          payload: encoded.payload,
        });
        expect(response.statusCode).toBe(200);
        const uploaded = parseEvidenceUploadSuccess(JSON.parse(response.body));
        const artifact = parseArtifact(uploaded.artifact);
        expect(artifact.kind).toBe(sample.kind);
        expect(artifact.filename).toBe(sample.filename);
        expect(artifact.mediaType).toBe(sample.mediaType);
        const expectedBytes = typeof sample.body === "string"
          ? new TextEncoder().encode(sample.body)
          : sample.body;
        expect(artifact.contentHash).toBe(sha256Hex(expectedBytes));
        expect(await store.verify(artifact.contentHash ?? "")).toBe(true);
      }
      expect(spies.beginWriteBatch).not.toHaveBeenCalled();
      expect(spies.stageStream).toHaveBeenCalledTimes(3);
    });
  });

  it("rejects an empty file without catalog, blob, artifact, or scratch residue", async () => {
    await withApp(async ({ app, store, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Empty stream");
      const encoded = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "empty" },
        { kind: "field", name: "filename", value: "empty.log" },
        { kind: "field", name: "mediaType", value: "text/plain" },
        { kind: "file", name: "file", filename: "empty.log", mediaType: "text/plain", body: "" },
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: alice, "content-type": encoded.contentType },
        payload: encoded.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "evidence file must not be empty" });
      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence`,
        headers: { cookie: alice },
      });
      expect((JSON.parse(listed.body) as { artifacts: unknown[] }).artifacts).toEqual([]);
      expect(await store.head(sha256Hex(new Uint8Array()))).toBeNull();
      expect(await listScratch(root)).toEqual([]);
    });
  });

  it("rejects conflicting explicit and native file metadata", async () => {
    await withApp(async ({ app, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Conflicting metadata");
      for (const fields of [
        [{ kind: "field" as const, name: "filename", value: "other.log" }],
        [{ kind: "field" as const, name: "mediaType", value: "text/x-log" }],
      ]) {
        const encoded = encodeMultipart([
          { kind: "field", name: "kind", value: "log" },
          { kind: "field", name: "summary", value: "conflict" },
          ...fields,
          { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
        ]);
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/evidence/stream`,
          headers: { cookie: alice, "content-type": encoded.contentType },
          payload: encoded.payload,
        });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error).toMatch(/conflicts with file metadata/u);
      }
      expect(await listScratch(root)).toEqual([]);
    });
  });

  it("rejects truncated multipart field names and values before persistence", async () => {
    expect(() => assertMultipartTextFieldIntact({
      fieldnameTruncated: true,
      valueTruncated: false,
    })).toThrow("multipart text field was truncated");
    expect(() => assertMultipartTextFieldIntact({
      fieldnameTruncated: false,
      valueTruncated: true,
    })).toThrow("multipart text field was truncated");
    await withApp(async ({ app, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Truncated fields");
      const url = `/api/cases/${caseId}/evidence/stream`;
      for (const truncatedField of [
        { name: "summary", value: "x".repeat(8193) },
      ]) {
        const encoded = encodeMultipart([
          { kind: "field", name: "kind", value: "log" },
          { kind: "field", ...truncatedField },
          { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
        ]);
        const response = await app.inject({
          method: "POST",
          url,
          headers: { cookie: alice, "content-type": encoded.contentType },
          payload: encoded.payload,
        });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "multipart text field was truncated" });
      }
      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence`,
        headers: { cookie: alice },
      });
      expect((JSON.parse(listed.body) as { artifacts: unknown[] }).artifacts).toEqual([]);
      expect(await listScratch(root)).toEqual([]);
    });
  });

  it("rejects malformed, file-first, duplicate, trailing, second-file, and file_server_ref parts", async () => {
    await withApp(async ({ app, store }) => {
      const spies = spyStore(store);
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Malformed stream");
      const url = `/api/cases/${caseId}/evidence/stream`;
      const notMultipart = await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": "application/json" },
        payload: { kind: "log", summary: "no" },
      });
      expect(notMultipart.statusCode).toBeGreaterThanOrEqual(400);

      const fileFirst = encodeMultipart([
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "late" },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": fileFirst.contentType },
        payload: fileFirst.payload,
      })).statusCode).toBe(400);

      const duplicate = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "kind", value: "email" },
        { kind: "field", name: "summary", value: "dup" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": duplicate.contentType },
        payload: duplicate.payload,
      })).statusCode).toBe(400);

      const trailing = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "trail" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
        { kind: "field", name: "filename", value: "after.log" },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": trailing.contentType },
        payload: trailing.payload,
      })).statusCode).toBe(400);

      const second = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "two" },
        { kind: "file", name: "file", filename: "a.log", mediaType: "text/plain", body: "a" },
        { kind: "file", name: "file", filename: "b.log", mediaType: "text/plain", body: "b" },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": second.contentType },
        payload: second.payload,
      })).statusCode).toBe(400);

      const uri = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "uri" },
        { kind: "field", name: "uri", value: "https://files.example.test/x" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": uri.contentType },
        payload: uri.payload,
      })).statusCode).toBe(400);

      const fileRef = encodeMultipart([
        { kind: "field", name: "kind", value: "file_server_ref" },
        { kind: "field", name: "summary", value: "ref" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);
      expect((await app.inject({
        method: "POST",
        url,
        headers: { cookie: alice, "content-type": fileRef.contentType },
        payload: fileRef.payload,
      })).statusCode).toBe(400);

      expect(spies.beginWriteBatch).not.toHaveBeenCalled();
      expect(await listScratch(store.rootDir)).toEqual([]);
    });
  });

  it("enforces the stream size cap and leaves no scratch residue", async () => {
    await withApp(async ({ app, store, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Oversize stream");
      const encoded = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "too big" },
        { kind: "field", name: "filename", value: "big.log" },
        { kind: "field", name: "mediaType", value: "text/plain" },
        {
          kind: "file",
          name: "file",
          filename: "big.log",
          mediaType: "text/plain",
          body: "x".repeat(32),
        },
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: alice, "content-type": encoded.contentType },
        payload: encoded.payload,
      });
      expect(response.statusCode).toBe(413);
      expect(JSON.parse(response.body)).toEqual({ error: "upload exceeds size cap" });
      expect(await listScratch(root)).toEqual([]);
      expect(await store.head(sha256Hex(Buffer.from("x".repeat(32))))).toBeNull();
    }, { maxUploadBytes: 16 });
  });

  it("rejects an expected hash mismatch before promotion", async () => {
    await withApp(async ({ app, store }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Hash mismatch stream");
      const encoded = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "mismatch" },
        { kind: "field", name: "expectedHash", value: "0".repeat(64) },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: alice, "content-type": encoded.contentType },
        payload: encoded.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "held evidence hash mismatch" });
      expect(await store.head(sha256Hex(new TextEncoder().encode(LOG)))).toBeNull();
    });
  });

  it("maps an unknown COMMIT after promote to sanitized 503 without rollback", async () => {
    const caseStore = new UnknownCommitStore();
    await withApp(async ({ app, store, domain }) => {
      const spies = spyStore(store);
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Unknown stream commit http");
      caseStore.unknownCommit = true;
      const encoded = encodeMultipart([
        { kind: "field", name: "kind", value: "log" },
        { kind: "field", name: "summary", value: "unknown commit" },
        { kind: "field", name: "privacyClass", value: "share_safe" },
        { kind: "file", name: "file", filename: "app.log", mediaType: "text/plain", body: LOG },
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence/stream`,
        headers: { cookie: alice, "content-type": encoded.contentType },
        payload: encoded.payload,
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(response.body).not.toMatch(/postgres|password|connection/i);
      expect(spies.beginWriteBatch).not.toHaveBeenCalled();
      expect(await store.verify(sha256Hex(new TextEncoder().encode(LOG)))).toBe(true);
      expect(domain.addStreamedEvidence).toBeTypeOf("function");
    }, { caseStore });
  });

  it("keeps the legacy JSON upload cap at 1_000_000 decoded bytes", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Legacy json cap");
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "log",
          filename: "huge.log",
          mediaType: "text/plain",
          contentBase64: Buffer.alloc(1_000_001, 0x61).toString("base64"),
          summary: "too big for json",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "upload exceeds size cap" });
    });
  });

  it("aborts staging when the raw request is destroyed", async () => {
    await withApp(async ({ app, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Abort stream");
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const boundary = "----cd-abort-stream";
      const prelude = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nlog\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="summary"\r\n\r\nabort\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="abort.log"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
      ]);
      await new Promise<void>((resolve) => {
        const req = http.request({
          method: "POST",
          host: "127.0.0.1",
          port,
          path: `/api/cases/${caseId}/evidence/stream`,
          headers: {
            cookie: alice,
            "x-cd-collab-csrf": "1",
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "transfer-encoding": "chunked",
          },
        });
        req.on("error", () => resolve());
        req.write(prelude);
        req.write("aaaaaaaa");
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await listScratch(root)).toEqual([]);
    });
  });

  it("terminates a stalled authenticated upload when its transfer guard expires", async () => {
    await withApp(async ({ app, root }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await createCase(app, alice, "Timed out stream");
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const boundary = "----cd-timeout-stream";
      const prelude = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nlog\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="summary"\r\n\r\ntimeout\r\n`,
        ),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="timeout.log"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
      ]);
      const started = Date.now();
      await Promise.race([
        new Promise<void>((resolve) => {
          const req = http.request({
            method: "POST",
            host: "127.0.0.1",
            port,
            path: `/api/cases/${caseId}/evidence/stream`,
            headers: {
              cookie: alice,
              "x-cd-collab-csrf": "1",
              "content-type": `multipart/form-data; boundary=${boundary}`,
              "transfer-encoding": "chunked",
            },
          });
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          req.on("error", done);
          req.on("close", done);
          req.write(prelude);
          req.write("stalled");
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("transfer guard did not terminate upload")), 1_000);
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(750);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await listScratch(root)).toEqual([]);
    }, { transferTimeoutMs: 25 });
  });

  it("does not use forbidden multipart helpers or whole-file buffering", () => {
    const routesSrc = readFileSync(join(HERE, "routes.ts"), "utf8");
    const serviceSrc = readFileSync(join(HERE, "service.ts"), "utf8");
    const appSrc = readFileSync(join(HERE, "../../app.ts"), "utf8");
    expect(appSrc).toMatch(/attachFieldsToBody:\s*false/);
    expect(appSrc).toMatch(/fieldNameSize:\s*100/);
    expect(appSrc).toMatch(/fieldSize:\s*8192/);
    expect(appSrc).toMatch(/fields:\s*8/);
    expect(appSrc).toMatch(/files:\s*1/);
    expect(appSrc).toMatch(/parts:\s*9/);
    expect(appSrc).toMatch(/@fastify\/multipart/);
    expect(routesSrc).toMatch(/\.parts\(\)/);
    expect(routesSrc).not.toMatch(/request\.file\s*\(/);
    expect(routesSrc).not.toMatch(/request\.files\s*\(/);
    expect(routesSrc).not.toMatch(/saveRequestFiles/);
    expect(routesSrc).not.toMatch(/toBuffer\s*\(/);
    expect(routesSrc).not.toMatch(/presigned|getSignedUrl|createPresigned/);
    expect(routesSrc).not.toMatch(/queue\.push|queue\.shift/);
    expect(routesSrc).not.toMatch(/process\.stderr/);
    expect(routesSrc).not.toMatch(/setTimeout\(done,\s*250\)|setTimeout\(resolve,\s*250\)/);
    expect(routesSrc).toMatch(/for await/);
    const streamed = serviceSrc.slice(
      serviceSrc.indexOf("async addStreamedEvidence"),
      serviceSrc.indexOf("async previewCorpusIntake"),
    );
    expect(streamed).toContain("stageStream");
    expect(streamed).not.toContain("beginWriteBatch");
    expect(streamed).not.toMatch(/Buffer\.concat|arrayBuffer\(|toArray\(/);
  });
});
