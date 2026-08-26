import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  CORPUS_STREAM_COMMIT_SCHEMA_ID,
  CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
  V8_MAX_STRING_LENGTH,
  base64LengthForBytes,
  corpusIntakeInlineDecodedBytes,
  parseCorpusIntakeError,
  parseCorpusIntakeSession,
  resolveCorpusIntakeLimits,
  type CorpusIntakeLimitsV1,
  type CorpusIntakeSessionV1,
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
import { buildTestZip } from "./zip.js";

const ALICE = "fixture-alice-secret";
const CAROL = "fixture-carol-secret";
const LOG = "2026-08-25T00:00:00Z mailer timeout id=syn-1\n";
const ROLE_MAP =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor";

function users() {
  return new Map([
    ["alice", {
      password: ALICE,
      identity: {
        id: "uid=alice,ou=people,dc=example,dc=test",
        username: "alice",
        displayName: "alice",
      },
      groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
    }],
    ["carol", {
      password: CAROL,
      identity: {
        id: "uid=carol,ou=people,dc=example,dc=test",
        username: "carol",
        displayName: "carol",
      },
      groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
    }],
  ]);
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-intake-routes-"));
  const store = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, new MemoryCaseStore(), catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(ROLE_MAP));
  const app = await buildApp({
    config: testConfig({
      evidenceRoot: join(root, "evidence"),
      corpusIntakeSpoolRoot: join(root, "spool"),
      corpusIntakeLimits: limits,
    }),
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
    await fn({ app, audit });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function openCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: session },
    payload: { title: "Streamed corpus intake" },
  });
  expect(created.statusCode).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

function preflightPayload(
  parts: Array<{ relativePath: string; declaredBytes: number; declaredMediaType?: string }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
    origin: "files",
    sourceLabel: "streamed upload",
    privacyClass: "owner_only",
    idempotencyKey: "batch-http-000001",
    parts: parts.map((part, index) => ({
      index,
      relativePath: part.relativePath,
      declaredBytes: part.declaredBytes,
      declaredMediaType: part.declaredMediaType ?? "text/plain",
    })),
    ...overrides,
  };
}

describe("streamed corpus intake over HTTP", () => {
  it("carries a corpus through preflight, binary parts, preview, and commit", async () => {
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const first = Buffer.from(LOG.repeat(64));
      const second = Buffer.from(`${LOG}second\n`);

      const opened = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload([
          { relativePath: "mailer/a.log", declaredBytes: first.byteLength },
          { relativePath: "mailer/b.log", declaredBytes: second.byteLength },
        ]),
      });
      expect(opened.statusCode).toBe(201);
      const session = parseCorpusIntakeSession(JSON.parse(opened.body));
      expect(session.stages[0]).toBe("preflight");
      expect(session.limits.maxRequestBytes).toBe(CORPUS_INTAKE_LIMITS.maxRequestBytes);

      for (const [index, bytes] of [first, second].entries()) {
        const put = await app.inject({
          method: "PUT",
          url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/parts/${index}?offset=0`,
          headers: { cookie: alice, "content-type": "application/octet-stream" },
          payload: bytes,
        });
        expect(put.statusCode).toBe(200);
        const state = parseCorpusIntakeSession(JSON.parse(put.body));
        expect(state.parts[index]?.complete).toBe(true);
      }

      const status = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}`,
        headers: { cookie: alice },
      });
      expect(status.statusCode).toBe(200);
      const polled = parseCorpusIntakeSession(JSON.parse(status.body)) as CorpusIntakeSessionV1;
      expect(polled.progress.uploadedBytes).toBe(first.byteLength + second.byteLength);
      expect(polled.progress.determinate).toBe(true);

      const preview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/preview`,
        headers: { cookie: alice },
        payload: {},
      });
      expect(preview.statusCode).toBe(200);
      const report = JSON.parse(preview.body) as { previewToken: string; accepted: unknown[] };
      expect(report.accepted).toHaveLength(2);

      const commit = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/commit`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
          previewToken: report.previewToken,
          idempotencyKey: "batch-http-000001",
        },
      });
      expect(commit.statusCode).toBe(200);
      expect((JSON.parse(commit.body) as { items: unknown[] }).items).toHaveLength(2);
      expect(await audit.list({ action: "corpus_intake_preflight" })).not.toHaveLength(0);
      expect(await audit.list({ action: "corpus_intake_commit" })).not.toHaveLength(0);
    });
  });

  it("expands an uploaded ZIP and reports refusals per member", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const archive = Buffer.from(buildTestZip([
        { name: "mailer/keep.log", data: Buffer.from(LOG) },
        { name: "../escape.log", data: Buffer.from(LOG) },
      ]));
      const opened = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload(
          [{
            relativePath: "diagnostics.zip",
            declaredBytes: archive.byteLength,
            declaredMediaType: "application/zip",
          }],
          { origin: "zip" },
        ),
      });
      const session = parseCorpusIntakeSession(JSON.parse(opened.body));
      expect(session.unknowns).toContain("expanded_bytes");
      await app.inject({
        method: "PUT",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/parts/0?offset=0`,
        headers: { cookie: alice, "content-type": "application/octet-stream" },
        payload: archive,
      });
      const preview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/preview`,
        headers: { cookie: alice },
        payload: {},
      });
      expect(preview.statusCode).toBe(200);
      const report = JSON.parse(preview.body) as {
        accepted: Array<{ relativePath: string }>;
        rejected: Array<{ reason: string }>;
      };
      expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/keep.log"]);
      expect(report.rejected.map((row) => row.reason)).toEqual(["path_traversal"]);
    });
  });

  it("cancels a session and refuses further work on it", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const bytes = Buffer.from(LOG);
      const opened = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload([
          { relativePath: "mailer/a.log", declaredBytes: bytes.byteLength },
        ]),
      });
      const session = parseCorpusIntakeSession(JSON.parse(opened.body));
      const cancelled = await app.inject({
        method: "DELETE",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}`,
        headers: { cookie: alice },
      });
      expect(cancelled.statusCode).toBe(200);
      expect(parseCorpusIntakeSession(JSON.parse(cancelled.body)).state).toBe("cancelled");

      const rejected = await app.inject({
        method: "PUT",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/parts/0?offset=0`,
        headers: { cookie: alice, "content-type": "application/octet-stream" },
        payload: bytes,
      });
      expect(rejected.statusCode).toBe(409);
      expect(parseCorpusIntakeError(JSON.parse(rejected.body)).code).toBe("session_cancelled");
    });
  });
});

describe("streamed corpus intake refusals a reader can act on", () => {
  it("names request_too_large instead of failing to build a string", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      // The pre-streaming lane advertised a JSON body limit of 723,827,372
      // bytes, which V8 cannot turn into a string at all. The inline lane now
      // refuses above what it can actually parse and names the streamed lane.
      const oversized = Buffer.alloc(
        corpusIntakeInlineDecodedBytes(CORPUS_INTAKE_LIMITS) + 1_024,
      ).fill(0x41).toString("base64");
      expect(base64LengthForBytes(CORPUS_INTAKE_LIMITS.maxExpandedBytes))
        .toBeGreaterThan(V8_MAX_STRING_LENGTH);
      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "files",
          sourceLabel: "oversized inline",
          privacyClass: "owner_only",
          idempotencyKey: "batch-inline-00001",
          files: [{
            relativePath: "mailer/huge.log",
            mediaType: "text/plain",
            contentBase64: oversized,
          }],
          archiveBase64: null,
        },
      });
      expect(refused.statusCode).toBe(400);
      const body = JSON.parse(refused.body) as { error: string };
      expect(body.error).toContain("request_too_large");
      expect(body.error).toContain("streamed intake session");
    });
  });

  it("names the exact refusal for an inadmissible preflight", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const refused = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload([{
          relativePath: "mailer/huge.log",
          declaredBytes: CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
        }]),
      });
      expect(refused.statusCode).toBe(400);
      const error = parseCorpusIntakeError(JSON.parse(refused.body));
      expect(error.code).toBe("per_file_bytes_exceeded");
      expect(error.message).not.toBe("invalid");
    });
  });

  it("refuses a part chunk above the per-request limit while it streams", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const declared = CORPUS_INTAKE_LIMITS.maxRequestBytes + 4_096;
      const opened = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload([
          { relativePath: "mailer/a.log", declaredBytes: declared },
        ]),
      });
      const session = parseCorpusIntakeSession(JSON.parse(opened.body));
      const refused = await app.inject({
        method: "PUT",
        url: `/api/cases/${caseId}/corpus-intake/sessions/${session.sessionId}/parts/0?offset=0`,
        headers: { cookie: alice, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(declared).fill(0x41),
      });
      // The parts route hands Fastify the untouched stream, so the ceiling is
      // enforced as bytes arrive rather than by a body-length precheck. The
      // refusal is still specific, and the request stream is abandoned at the
      // limit rather than read to the end.
      expect(refused.statusCode).toBe(400);
      expect(parseCorpusIntakeError(JSON.parse(refused.body)).code).toBe("request_too_large");
    });
  });

  it("keeps a reader without write capability out of every session route", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const carol = await login(app, "carol", CAROL);
      const caseId = await openCase(app, alice);
      const denied = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: carol },
        payload: preflightPayload([{ relativePath: "mailer/a.log", declaredBytes: 8 }]),
      });
      expect(denied.statusCode).toBe(403);
    });
  });

  it("enforces an owner-local limit on both intake lanes, not only the streamed one", async () => {
    const narrowed = resolveCorpusIntakeLimits({ maxFileCount: 2 });
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const files = Array.from({ length: 3 }, (_, index) => ({
        relativePath: `mailer/${index}.log`,
        mediaType: "text/plain",
        contentBase64: Buffer.from(LOG).toString("base64"),
      }));

      // The inline lane parses against the same configuration the streamed lane
      // enforces, so an owner who narrows a limit narrows both.
      const inline = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "files",
          sourceLabel: "narrowed inline",
          privacyClass: "owner_only",
          idempotencyKey: "batch-inline-00002",
          files,
          archiveBase64: null,
        },
      });
      expect(inline.statusCode).toBe(400);
      expect((JSON.parse(inline.body) as { error: string }).error)
        .toContain("file_count_exceeded");

      const streamed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload(files.map((file) => ({
          relativePath: file.relativePath,
          declaredBytes: LOG.length,
        }))),
      });
      expect(streamed.statusCode).toBe(400);
      expect(parseCorpusIntakeError(JSON.parse(streamed.body)).code).toBe("file_count_exceeded");

      const accepted = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/sessions`,
        headers: { cookie: alice },
        payload: preflightPayload(files.slice(0, 2).map((file) => ({
          relativePath: file.relativePath,
          declaredBytes: LOG.length,
        }))),
      });
      expect(accepted.statusCode).toBe(201);
      expect(parseCorpusIntakeSession(JSON.parse(accepted.body)).limits.maxFileCount).toBe(2);
    }, narrowed);
  });
});
