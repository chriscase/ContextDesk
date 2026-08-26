import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_BATCH_SCHEMA_ID,
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  parseCorpusIntakeBatch,
  parseCorpusIntakePreviewReport,
  parseTimeline,
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
import { buildTestZip, buildUnicodePathExtra } from "./zip.js";
import { corpusIntakeRequestDigest, decodeBase64, digestOf } from "./preview.js";

const ALICE = "fixture-alice-secret";
const ALICE_ID = "uid=alice,ou=people,dc=example,dc=test";
const CAROL_ID = "uid=carol,ou=people,dc=example,dc=test";
const DAVE_ID = "uid=dave,ou=people,dc=example,dc=test";
const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-1\n";
const LOG_B64 = Buffer.from(LOG).toString("base64");

interface CommitSeed {
  schemaId: typeof CORPUS_INTAKE_COMMIT_SCHEMA_ID;
  origin: "files" | "zip" | "directory";
  sourceLabel: string;
  privacyClass: "owner_only" | "share_safe";
  idempotencyKey: string;
  files: Array<{ relativePath: string; mediaType: string; contentBase64: string }>;
  archiveBase64: string | null;
}

function withPreviewToken(caseId: string, payload: CommitSeed, actorId = ALICE_ID) {
  const files = payload.files.map((file) => ({
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    bytes: decodeBase64(file.relativePath, file.contentBase64),
  }));
  const archive = payload.archiveBase64 ? decodeBase64("archive", payload.archiveBase64) : null;
  return {
    ...payload,
    previewToken: corpusIntakeRequestDigest({
      caseId,
      actorId,
      origin: payload.origin,
      sourceLabel: payload.sourceLabel,
      privacyClass: payload.privacyClass,
      idempotencyKey: payload.idempotencyKey,
      files,
      archive,
    }),
  };
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

class BoomStore extends MemoryCaseStore {
  boom = false;
  override async insertIntakeBatch(
    row: Parameters<MemoryCaseStore["insertIntakeBatch"]>[0],
  ): Promise<void> {
    if (this.boom) throw new Error("intake store failed");
    return super.insertIntakeBatch(row);
  }
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    domain: CaseService;
    store: FilesystemEvidenceStore;
    cases: MemoryCaseStore;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  caseStore: MemoryCaseStore = new MemoryCaseStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-corpus-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, caseStore, catalog);
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
    await fn({ app, domain, store, cases: caseStore, audit });
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
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function openCase(app: Awaited<ReturnType<typeof buildApp>>, session: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: session },
    payload: { title: "Synthetic corpus intake" },
  });
  expect(created.statusCode).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

describe("investigation corpus intake API", () => {
  it("previews and commits a ZIP, directory, and file batch with provenance", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const archive = buildTestZip([
        { name: "mailer/shared-timeout.log", data: Buffer.from(LOG) },
        { name: "mailer/payload.bin", data: Buffer.from([0, 1, 2, 255]) },
      ]);
      const preview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "zip",
          sourceLabel: "fixture-zip",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-0001",
          files: [],
          archiveBase64: Buffer.from(archive).toString("base64"),
        },
      });
      expect(preview.statusCode).toBe(200);
      const report = parseCorpusIntakePreviewReport(JSON.parse(preview.body));
      expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/shared-timeout.log"]);
      expect(report.rejected.some((row) => row.reason === "unsupported_media")).toBe(true);

      const invalidUtf8 = Buffer.concat([
        Buffer.from("mailer/"),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(".log"),
      ]);
      const undecodable = buildTestZip([
        { name: "mailer/placeholder.log", data: Buffer.from(LOG), nameBytes: invalidUtf8, flags: 0x0800 },
      ]);
      const encodingPreview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "zip",
          sourceLabel: "fixture-zip-encoding",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-encoding-1",
          files: [],
          archiveBase64: Buffer.from(undecodable).toString("base64"),
        },
      });
      expect(encodingPreview.statusCode).toBe(200);
      const encodingReport = parseCorpusIntakePreviewReport(JSON.parse(encodingPreview.body));
      expect(encodingReport.accepted).toEqual([]);
      expect(encodingReport.rejected.some((row) => row.reason === "invalid_encoding")).toBe(true);

      const unicodeSlip = buildTestZip([
        {
          name: "mailer/notes.log",
          data: Buffer.from(LOG),
          flags: 0,
          extra: buildUnicodePathExtra("mailer/notes.log", "../../etc/passwd"),
        },
      ]);
      const unicodePreview = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "zip",
          sourceLabel: "fixture-zip-unicode-path",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-unicode-1",
          files: [],
          archiveBase64: Buffer.from(unicodeSlip).toString("base64"),
        },
      });
      expect(unicodePreview.statusCode).toBe(200);
      const unicodeReport = parseCorpusIntakePreviewReport(JSON.parse(unicodePreview.body));
      expect(unicodeReport.accepted).toEqual([]);
      expect(unicodeReport.rejected.some((row) => row.reason === "path_traversal")).toBe(true);

      const committed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "zip",
          sourceLabel: "fixture-zip",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-0001",
          previewToken: report.previewToken,
          files: [],
          archiveBase64: Buffer.from(archive).toString("base64"),
        },
      });
      expect(committed.statusCode).toBe(200);
      const batch = parseCorpusIntakeBatch(JSON.parse(committed.body));
      expect(batch.schemaId).toBe(CORPUS_INTAKE_BATCH_SCHEMA_ID);
      expect(batch.items).toHaveLength(1);
      expect(batch.items[0]?.relativePath).toBe("mailer/shared-timeout.log");
      expect(batch.replayed).toBe(false);

      const replay = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "zip",
          sourceLabel: "fixture-zip",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-0001",
          previewToken: report.previewToken,
          files: [],
          archiveBase64: Buffer.from(archive).toString("base64"),
        },
      });
      const replayed = parseCorpusIntakeBatch(JSON.parse(replay.body));
      expect(replayed.replayed).toBe(true);
      expect(replayed.id).toBe(batch.id);
      expect(replayed.items[0]?.artifactId).toBe(batch.items[0]?.artifactId);

      const listed = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { artifacts: Array<{ filename: string | null }> };
      expect(listed.artifacts.filter((row) => row.filename === "mailer/shared-timeout.log")).toHaveLength(1);

      const fetched = parseCorpusIntakeBatch(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/corpus-intake/${batch.id}`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(fetched.id).toBe(batch.id);

      const directory = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "directory",
          sourceLabel: "fixture-directory",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-0002",
          files: [
            {
              relativePath: "workers/unique-worker.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from("2026-08-15T00:00:01Z worker unique-syn\n").toString(
                "base64",
              ),
            },
          ],
          archiveBase64: null,
        }),
      });
      expect(directory.statusCode).toBe(200);
      expect(parseCorpusIntakeBatch(JSON.parse(directory.body)).items).toHaveLength(1);
    });
  });

  it("deduplicates digest within the investigation while preserving the new path", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const first = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-dup-1",
          files: [
            { relativePath: "mailer/a.log", mediaType: "text/plain", contentBase64: LOG_B64 },
          ],
          archiveBase64: null,
        }),
      });
      const firstBatch = parseCorpusIntakeBatch(JSON.parse(first.body));
      const second = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-dup-2",
          files: [
            { relativePath: "mailer/b.log", mediaType: "text/plain", contentBase64: LOG_B64 },
          ],
          archiveBase64: null,
        }),
      });
      const secondBatch = parseCorpusIntakeBatch(JSON.parse(second.body));
      expect(secondBatch.items[0]?.artifactId).not.toBe(firstBatch.items[0]?.artifactId);
      expect(secondBatch.items[0]?.duplicateDigest).toBe(true);
      expect(secondBatch.items[0]?.relativePath).toBe("mailer/b.log");
      const timeline = parseTimeline(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/timeline`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(timeline.events.filter((event) => event.kind === "evidence_registered")).toHaveLength(2);
      const listed = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
          })
        ).body,
      ) as {
        artifacts: Array<{
          id: string;
          relativePath: string | null;
          contentHash: string | null;
          privacyClass: string;
          uploaderId: string;
          sourceId: string;
          intakeBatchId: string | null;
        }>;
      };
      expect(listed.artifacts.map((row) => row.relativePath).sort()).toEqual([
        "mailer/a.log",
        "mailer/b.log",
      ]);
      expect(new Set(listed.artifacts.map((row) => row.id)).size).toBe(2);
      expect(new Set(listed.artifacts.map((row) => row.contentHash)).size).toBe(1);
      expect(listed.artifacts.every((row) => row.privacyClass === "owner_only")).toBe(true);
      expect(listed.artifacts.every((row) => /^usr-[a-f0-9]{32}$/.test(row.uploaderId))).toBe(true);
      expect(new Set(listed.artifacts.map((row) => row.uploaderId)).size).toBe(1);
      expect(new Set(listed.artifacts.map((row) => row.sourceId)).size).toBe(1);
      expect(listed.artifacts.every((row) => row.intakeBatchId !== null)).toBe(true);
    });
  });

  it("rolls back the investigation record when the batch insert fails", async () => {
    const boom = new BoomStore();
    boom.boom = true;
    await withApp(async ({ app, store, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const failed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-boom-1",
          files: [
            { relativePath: "mailer/shared-timeout.log", mediaType: "text/plain", contentBase64: LOG_B64 },
          ],
          archiveBase64: null,
        }),
      });
      expect(failed.statusCode).toBe(400);
      expect(JSON.parse(failed.body)).toEqual({ error: "invalid" });
      const listed = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { artifacts: unknown[] };
      expect(listed.artifacts).toEqual([]);
      expect(await store.head(digestOf(Buffer.from(LOG)))).toBeNull();
      expect(await audit.list({ action: "corpus_intake_commit" })).toEqual([]);
      expect(await audit.list({ action: "contribution_create" })).toEqual([]);
    }, boom);
  });

  it("rejects viewers, missing sessions, and cross-investigation batch reads", async () => {
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const carol = await login(app, "carol", "fixture-carol-secret");
      const caseA = await openCase(app, alice);
      const caseB = await openCase(app, alice);
      const payload = withPreviewToken(caseA, {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        origin: "files",
        sourceLabel: "fixture-files",
        privacyClass: "owner_only",
        idempotencyKey: "batch-syn-auth-1",
        files: [
          { relativePath: "mailer/shared-timeout.log", mediaType: "text/plain", contentBase64: LOG_B64 },
        ],
        archiveBase64: null,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseA}/corpus-intake`,
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseA}/corpus-intake`,
            headers: { cookie: carol },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      const committed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseA}/corpus-intake`,
        headers: { cookie: alice },
        payload,
      });
      const batch = parseCorpusIntakeBatch(JSON.parse(committed.body));
      const cross = await app.inject({
        method: "GET",
        url: `/api/cases/${caseB}/corpus-intake/${batch.id}`,
        headers: { cookie: alice },
      });
      expect(cross.statusCode).toBe(404);
      const denied = await audit.list({ action: "corpus_intake_commit", identity: CAROL_ID });
      expect(denied).toHaveLength(1);
      expect(denied[0]?.target).toBe(caseA);
      expect(denied[0]?.outcome).toBe("denied");
    });
  });

  it("serializes concurrent idempotent commits and rejects key reuse for changed input", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const seed: CommitSeed = {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        origin: "files",
        sourceLabel: "fixture-concurrent",
        privacyClass: "owner_only",
        idempotencyKey: "batch-syn-concurrent-1",
        files: [
          { relativePath: "mailer/concurrent.log", mediaType: "text/plain", contentBase64: LOG_B64 },
        ],
        archiveBase64: null,
      };
      const payload = withPreviewToken(caseId, seed);
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/corpus-intake`,
          headers: { cookie: alice },
          payload,
        }),
        app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/corpus-intake`,
          headers: { cookie: alice },
          payload,
        }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const batches = responses.map((response) =>
        parseCorpusIntakeBatch(JSON.parse(response.body))
      );
      expect(new Set(batches.map((batch) => batch.id)).size).toBe(1);
      expect(new Set(batches.map((batch) => batch.items[0]?.artifactId)).size).toBe(1);
      expect(batches.map((batch) => batch.replayed).sort()).toEqual([false, true]);

      const changed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          ...seed,
          sourceLabel: "fixture-concurrent-changed",
        }),
      });
      expect(changed.statusCode).toBe(409);
      expect(JSON.parse(changed.body)).toEqual({
        error: "idempotency key already belongs to another request",
      });
    });
  });

  it("does not leak share-safe findings and leaves frozen snapshots immutable after later intake", async () => {
    await withApp(async ({ app, domain }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const caseId = await openCase(app, dave);
      const leak = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake/preview`,
        headers: { cookie: dave },
        payload: {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "share_safe",
          idempotencyKey: "batch-syn-leak-1",
          files: [
            {
              relativePath: "mailer/leaky.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from("timeout\npassword: fixture-not-a-real-secret\n").toString(
                "base64",
              ),
            },
          ],
          archiveBase64: null,
        },
      });
      expect(leak.body).not.toContain("fixture-not-a-real-secret");
      const report = parseCorpusIntakePreviewReport(JSON.parse(leak.body));
      expect(report.rejected[0]?.reason).toBe("redaction_failed");

      const first = parseCorpusIntakeBatch(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/corpus-intake`,
              headers: { cookie: dave },
              payload: withPreviewToken(caseId, {
                schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
                origin: "files",
                sourceLabel: "fixture-files",
                privacyClass: "owner_only",
                idempotencyKey: "batch-syn-snap-1",
                files: [
                  {
                    relativePath: "mailer/shared-timeout.log",
                    mediaType: "text/plain",
                    contentBase64: LOG_B64,
                  },
                ],
                archiveBase64: null,
              }, DAVE_ID),
            })
          ).body,
        ),
      );
      const actor = { id: "uid=dave,ou=people,dc=example,dc=test", username: "dave" };
      const frozen = await domain.createSnapshot(
        caseId,
        actor,
        { evidenceIds: [first.items[0]!.artifactId], visibility: "owner_only" },
        "test",
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: dave },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-snap-2",
          files: [
            {
              relativePath: "mailer/later.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from("later synthetic line\n").toString("base64"),
            },
          ],
          archiveBase64: null,
        }, DAVE_ID),
      });
      const listed = await domain.listSnapshots(caseId, actor, true);
      const again = listed.find((row) => row.id === frozen.id);
      expect(again?.evidence.map((row) => row.evidenceId)).toEqual([first.items[0]?.artifactId]);
      expect(again?.fingerprint).toBe(frozen.fingerprint);
      expect(alice.length).toBeGreaterThan(0);
    });
  });

  it("escapes malicious filenames as data, not markup", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const caseId = await openCase(app, alice);
      const name = "<img src=x onerror=alert(1)>.log";
      const committed = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/corpus-intake`,
        headers: { cookie: alice },
        payload: withPreviewToken(caseId, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "fixture-files",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-markup-1",
          files: [{ relativePath: name, mediaType: "text/plain", contentBase64: LOG_B64 }],
          archiveBase64: null,
        }),
      });
      const batch = parseCorpusIntakeBatch(JSON.parse(committed.body));
      expect(batch.items[0]?.relativePath).toBe(name);
      expect(committed.body).not.toMatch(/<script/i);
    });
  });
});
