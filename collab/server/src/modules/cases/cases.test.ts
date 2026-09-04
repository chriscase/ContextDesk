import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  AUTH_ERROR_SCHEMA_ID,
  parseArtifactAnnotation,
  parseArtifactAnnotationBulkResult,
  parseArtifactAnnotationList,
  isRfc4122Uuid,
  parseArtifact,
  parseCase,
  parseCaseList,
  parseContributionList,
  parseContribution,
  parseEvidenceList,
  parseEvidenceUploadSuccess,
  parseInvestigationCoordination,
  parseInvestigationCoordinationActionRefused,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationCoordinationChanged,
  parseProvenance,
  parseSourceList,
  parseTimeline,
} from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore, sha256Hex } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import { createAuthLog, createRateLimiter, MemorySessionStore, defaultSessionPolicy } from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { MemoryLocalGrantStore } from "../people/index.js";
import {
  artifactAnnotationBulkWriteDigest,
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
} from "./service.js";
import { MemoryCaseStore } from "./store.js";

const ALICE = "fixture-alice-secret";
const MISSING_CASE_ID = "30000000-0000-4000-8000-000000000003";
const MISSING_ARTIFACT_ID = "10000000-0000-4000-8000-000000000001";
const MISSING_CONTRIBUTION_ID = "20000000-0000-4000-8000-000000000002";
const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-1\n";
const EML = [
  "From: sender@example.test",
  "To: oncall@example.test",
  "Subject: synthetic timeout",
  "",
  "The mailer worker timed out.\n",
].join("\r\n");

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

class UnknownOnceAfterCommitCaseStore extends MemoryCaseStore {
  failAfterNextCommit = false;
  atomicCalls = 0;

  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    this.atomicCalls += 1;
    const result = await super.withAtomic(operation, audit);
    if (this.failAfterNextCommit) {
      this.failAfterNextCommit = false;
      throw new CaseStoreCommitOutcomeUnknownError();
    }
    return result;
  }
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
    domain: CaseService;
    catalog: CatalogService;
    store: FilesystemEvidenceStore;
    caseStore: MemoryCaseStore;
    grants: MemoryLocalGrantStore;
    roles: MutableGroupRoleMap;
    roleStore: MemoryGroupRoleStore;
  }) => Promise<void>,
  caseStore: MemoryCaseStore = new MemoryCaseStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-cases-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const grants = new MemoryLocalGrantStore();
  const domain = new CaseService(store, audit, caseStore, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const roleStore = new MemoryGroupRoleStore(roles);
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    grants,
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
      roleStore,
      audit,
    },
  });
  try {
    await fn({ app, audit, domain, catalog, store, caseStore, grants, roles, roleStore });
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

describe("cases timeline evidence provenance", () => {
  it("canonically hashes the bulk target set with durable resolved fields", () => {
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "20000000-0000-4000-8000-000000000002";
    const base = {
      body: "Canonical observation",
      privacyClass: "owner_only" as const,
      sourceId: "30000000-0000-4000-8000-000000000003",
    };
    expect(artifactAnnotationBulkWriteDigest({ ...base, artifactIds: [second, first] }))
      .toBe(artifactAnnotationBulkWriteDigest({ ...base, artifactIds: [first, second] }));
    expect(artifactAnnotationBulkWriteDigest({ ...base, artifactIds: [first, second] }))
      .not.toBe(artifactAnnotationBulkWriteDigest({
        ...base,
        sourceId: "40000000-0000-4000-8000-000000000004",
        artifactIds: [first, second],
      }));
  });
  it("serves versioned, identity-checked evidence list and upload envelopes", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic evidence envelope" },
      })).body));

      const emptyResponse = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
      });
      expect(emptyResponse.statusCode).toBe(200);
      expect(parseEvidenceList(JSON.parse(emptyResponse.body))).toMatchObject({
        caseId: created.id,
        artifacts: [],
      });

      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename: "envelope.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("synthetic evidence envelope").toString("base64"),
          summary: "Versioned upload envelope",
        },
      });
      expect(uploadResponse.statusCode).toBe(200);
      const uploaded = parseEvidenceUploadSuccess(JSON.parse(uploadResponse.body));
      expect(uploaded.caseId).toBe(created.id);
      expect(uploaded.artifact.caseId).toBe(created.id);
      expect(uploaded.summary.caseId).toBe(created.id);

      const populatedResponse = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
      });
      expect(populatedResponse.statusCode).toBe(200);
      const populated = parseEvidenceList(JSON.parse(populatedResponse.body));
      expect(populated.caseId).toBe(created.id);
      expect(populated.artifacts.map((artifact) => artifact.id)).toEqual([uploaded.artifact.id]);
    });
  });

  it("appends artifact annotations and serves case- and artifact-scoped lists", async () => {
    await withApp(async ({ app, audit, roles }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Artifact annotation fixture" },
      })).body));
      const uploaded = parseEvidenceUploadSuccess(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename: "annotated.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("annotated evidence").toString("base64"),
          summary: "Evidence with durable annotations",
        },
      })).body));

      const firstResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/${uploaded.artifact.id}/annotations`,
        headers: { cookie: alice },
        payload: {
          body: "The timeout begins after the retry boundary.",
          clientTime: "2026-09-01T11:00:00Z",
          idempotencyKey: "annotation-retry-1",
        },
      });
      expect(firstResponse.statusCode).toBe(200);
      const first = parseArtifactAnnotation(JSON.parse(firstResponse.body));

      const replayResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/${uploaded.artifact.id}/annotations`,
        headers: { cookie: alice },
        payload: {
          body: "The timeout begins after the retry boundary.",
          clientTime: "2026-09-01T11:05:00Z",
          idempotencyKey: "annotation-retry-1",
        },
      });
      expect(replayResponse.statusCode).toBe(200);
      expect(parseArtifactAnnotation(JSON.parse(replayResponse.body)).id).toBe(first.id);
      const mismatchResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/${uploaded.artifact.id}/annotations`,
        headers: { cookie: alice },
        payload: {
          body: "A different note must not reuse the retry token.",
          idempotencyKey: "annotation-retry-1",
        },
      });
      expect(mismatchResponse.statusCode).toBe(409);
      expect(JSON.parse(mismatchResponse.body)).toEqual({ error: "artifact_annotation_conflict" });

      const second = parseArtifactAnnotation(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/${uploaded.artifact.id}/annotations`,
        headers: { cookie: alice },
        payload: {
          body: "This is an independent observation, not a revised first note.",
          privacyClass: "share_safe",
        },
      })).body));
      expect(second.id).not.toBe(first.id);
      expect(second.privacyClass).toBe("share_safe");

      const byArtifact = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/${uploaded.artifact.id}/annotations`,
        headers: { cookie: alice },
      });
      expect(byArtifact.statusCode).toBe(200);
      expect(parseArtifactAnnotationList(JSON.parse(byArtifact.body)).annotations.map((item) => item.id).sort()).toEqual(
        [second.id],
      );

      const byCase = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
      });
      expect(byCase.statusCode).toBe(200);
      const list = parseArtifactAnnotationList(JSON.parse(byCase.body));
      expect(list.annotations).toHaveLength(1);
      expect(list.annotations.every((item) => item.caseId === created.id)).toBe(true);
      expect(list.annotations.every((item) => item.artifactId === uploaded.artifact.id)).toBe(true);

      const dave = await login(app, "dave", "fixture-dave-secret");
      const adminList = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: dave },
      });
      expect(adminList.statusCode).toBe(200);
      expect(parseArtifactAnnotationList(JSON.parse(adminList.body)).annotations.map((item) => item.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );

      // Private annotation visibility follows the live capability set, so a
      // role grant reveals the owner-only body and revocation immediately
      // removes it without changing case membership or stored history.
      roles.set("cn=contributors,ou=groups,dc=example,dc=test", "case-lead");
      const elevated = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
      });
      expect(parseArtifactAnnotationList(JSON.parse(elevated.body)).annotations.map((item) => item.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      roles.set("cn=contributors,ou=groups,dc=example,dc=test", "contributor");
      const revoked = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
      });
      expect(parseArtifactAnnotationList(JSON.parse(revoked.body)).annotations.map((item) => item.id)).toEqual(
        [second.id],
      );
      expect(await audit.list({ action: "artifact_annotation_create" })).toHaveLength(2);
      const timeline = parseTimeline(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: alice },
      })).body));
      expect(timeline.events.filter((event) => event.kind === "artifact_annotation_created")).toHaveLength(2);
    });
  });

  it("bulk-annotates one canonical target set and replays in each request's order", async () => {
    await withApp(async ({ app, audit, caseStore, grants }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Bulk annotation fixture" },
      })).body));
      const upload = async (filename: string) => parseEvidenceUploadSuccess(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename,
          mediaType: "text/plain",
          contentBase64: Buffer.from(filename).toString("base64"),
          summary: `Uploaded ${filename}`,
        },
      })).body)).artifact;
      const firstArtifact = await upload("bulk-first.txt");
      const secondArtifact = await upload("bulk-second.txt");
      const otherCase = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Other bulk annotation case" },
      })).body));
      const crossCaseArtifact = parseEvidenceUploadSuccess(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${otherCase.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename: "cross-case.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("cross-case").toString("base64"),
          summary: "Cross-case target",
        },
      })).body)).artifact;
      const missing = MISSING_ARTIFACT_ID;
      const key = "bulk-annotation-0001";
      const body = "The retry boundary applies to every selected artifact.";

      const first = parseArtifactAnnotationBulkResult(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds: [secondArtifact.id, missing, crossCaseArtifact.id, firstArtifact.id],
          body,
          clientTime: "2026-09-02T10:00:00Z",
          idempotencyKey: key,
        },
      })).body));
      expect(first.items.map((item) => item.artifactId)).toEqual([
        secondArtifact.id,
        missing,
        crossCaseArtifact.id,
        firstArtifact.id,
      ]);
      expect(first.items.map((item) => item.outcome)).toEqual([
        "created",
        "not_found",
        "not_found",
        "created",
      ]);
      expect(first.items.filter((item) => item.outcome === "created").every((item) => item.annotation.body === body))
        .toBe(true);
      expect((await caseStore.listTimeline(created.id))
        .filter((event) => event.kind === "artifact_annotation_created")).toHaveLength(2);
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toHaveLength(1);

      const annotationsBefore = await caseStore.listArtifactAnnotationsByCase(created.id);
      const timelineBefore = await caseStore.listTimeline(created.id);
      const auditsBefore = await audit.list({ action: "artifact_annotation_bulk_create" });
      const replay = parseArtifactAnnotationBulkResult(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds: [firstArtifact.id, crossCaseArtifact.id, secondArtifact.id, missing],
          body,
          clientTime: "2026-09-02T11:00:00Z",
          idempotencyKey: key,
        },
      })).body));
      expect(replay.items.map((item) => item.artifactId)).toEqual([
        firstArtifact.id,
        crossCaseArtifact.id,
        secondArtifact.id,
        missing,
      ]);
      expect(replay.items.map((item) => item.outcome)).toEqual([
        "replayed",
        "not_found",
        "replayed",
        "not_found",
      ]);
      const firstIds = new Map(first.items.flatMap((item) =>
        item.outcome === "not_found" ? [] : [[item.artifactId, item.annotation.id]]));
      expect(replay.items.flatMap((item) =>
        item.outcome === "not_found" ? [] : [[item.artifactId, item.annotation.id]]))
        .toEqual([
          [firstArtifact.id, firstIds.get(firstArtifact.id)],
          [secondArtifact.id, firstIds.get(secondArtifact.id)],
        ]);
      expect(await caseStore.listArtifactAnnotationsByCase(created.id)).toEqual(annotationsBefore);
      expect(await caseStore.listTimeline(created.id)).toEqual(timelineBefore);
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toEqual(auditsBefore);
      const intent = await caseStore.getArtifactAnnotationBulkIdempotency(created.id, users().get("alice")!.identity.id, key);
      expect(intent).not.toBeNull();
      expect(parseArtifactAnnotationBulkResult(JSON.parse(intent!.resultJson)).items.map((item) => item.artifactId))
        .toEqual([firstArtifact.id, secondArtifact.id, missing, crossCaseArtifact.id].sort());

      // The actor may create and replay their owner-only annotation, but the
      // ordinary GET list remains capability-redacted for a contributor.
      const listed = parseArtifactAnnotationList(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
      })).body));
      expect(listed.annotations).toEqual([]);
      const carolId = users().get("carol")!.identity.id;
      await caseStore.addParticipant(created.id, { identityId: carolId, username: "carol" }, "test");
      await grants.grant(carolId, "evidence:private:read", users().get("alice")!.identity.id);
      const carol = await login(app, "carol", "fixture-carol-secret");
      const privateReaderList = parseArtifactAnnotationList(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: carol },
      })).body));
      expect(privateReaderList.annotations.map((annotation) => annotation.body))
        .toEqual([body, body]);
      const privateReaderWrite = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: carol },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds: [firstArtifact.id],
          body: "Private-read alone must not authorize a write.",
          idempotencyKey: "bulk-private-reader-0001",
        },
      });
      expect(privateReaderWrite.statusCode).toBe(403);
      await grants.revoke(carolId, "evidence:private:read");
      const privateReaderRevoked = parseArtifactAnnotationList(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: carol },
      })).body));
      expect(privateReaderRevoked.annotations).toEqual([]);
      const metadata = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/${firstArtifact.id}`,
        headers: { cookie: alice },
      });
      expect(metadata.statusCode).toBe(200);
      expect(parseArtifact(JSON.parse(metadata.body)).id).toBe(firstArtifact.id);
      const bytes = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/evidence/${firstArtifact.id}/bytes`,
        headers: { cookie: alice },
      });
      expect(bytes.statusCode).toBe(404);
      for (const event of (await caseStore.listTimeline(created.id))
        .filter((item) => item.kind === "artifact_annotation_created")) {
        expect(JSON.parse(event.payload)).not.toHaveProperty("body");
      }
      expect((await audit.list({ action: "artifact_annotation_bulk_create" }))[0]?.target)
        .not.toContain(body);

      const conflict = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds: [firstArtifact.id, secondArtifact.id, missing, crossCaseArtifact.id],
          body: "Changed durable body",
          idempotencyKey: key,
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body)).toEqual({ error: "artifact_annotation_conflict" });

      const dave = await login(app, "dave", "fixture-dave-secret");
      const otherActor = parseArtifactAnnotationBulkResult(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: dave },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds: [firstArtifact.id],
          body,
          idempotencyKey: key,
        },
      })).body));
      expect(otherActor.items[0]?.outcome).toBe("created");
      expect(otherActor.items[0]?.outcome === "created" && otherActor.items[0].annotation.id)
        .not.toBe(firstIds.get(firstArtifact.id));

      const singularSameKey = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/${secondArtifact.id}/annotations`,
        headers: { cookie: alice },
        payload: {
          body: "The singular retry namespace is independent.",
          idempotencyKey: key,
        },
      });
      expect(singularSameKey.statusCode).toBe(200);
      expect(parseArtifactAnnotation(JSON.parse(singularSameKey.body)).artifactId)
        .toBe(secondArtifact.id);
    });
  });

  it("rolls back the whole bulk request when any insert fails", async () => {
    await withApp(async ({ app, audit, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Atomic bulk annotation fixture" },
      })).body));
      const artifactIds: string[] = [];
      for (const filename of ["atomic-a.txt", "atomic-b.txt"]) {
        artifactIds.push(parseEvidenceUploadSuccess(JSON.parse((await app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/evidence`,
          headers: { cookie: alice },
          payload: {
            kind: "attachment",
            filename,
            mediaType: "text/plain",
            contentBase64: Buffer.from(filename).toString("base64"),
            summary: filename,
          },
        })).body)).artifact.id);
      }
      let inserts = 0;
      let atomicCalls = 0;
      const originalInsert = caseStore.insertArtifactAnnotation.bind(caseStore);
      const originalAtomic = caseStore.withAtomic.bind(caseStore);
      caseStore.insertArtifactAnnotation = async (row) => {
        inserts += 1;
        if (inserts === 2) throw new Error("synthetic bulk insert failure");
        return originalInsert(row);
      };
      caseStore.withAtomic = async (operation, auditStore) => {
        atomicCalls += 1;
        return originalAtomic(operation, auditStore);
      };
      const timelineBefore = await caseStore.listTimeline(created.id);
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: {
          schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
          artifactIds,
          body: "Atomic observation",
          idempotencyKey: "bulk-atomic-0001",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(atomicCalls).toBe(1);
      expect(await caseStore.listArtifactAnnotationsByCase(created.id)).toEqual([]);
      expect(await caseStore.listTimeline(created.id)).toEqual(timelineBefore);
      expect(await caseStore.getArtifactAnnotationBulkIdempotency(
        created.id,
        users().get("alice")!.identity.id,
        "bulk-atomic-0001",
      )).toBeNull();
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toEqual([]);
    });
  });

  it("rejects malformed bulk locators before any durable write", async () => {
    await withApp(async ({ app, audit, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Malformed bulk annotation fixture" },
      })).body));
      const key = "bulk-invalid-0001";
      const request = {
        schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
        artifactIds: ["not-a-uuid"],
        body: "Must never be stored.",
        idempotencyKey: key,
      };
      const malformedArtifact = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: request,
      });
      expect(malformedArtifact.statusCode).toBe(400);
      const malformedCase = await app.inject({
        method: "POST",
        url: "/api/cases/not-a-uuid/evidence/annotations",
        headers: { cookie: alice },
        payload: { ...request, artifactIds: [MISSING_ARTIFACT_ID] },
      });
      expect(malformedCase.statusCode).toBe(400);
      const missingCase = await app.inject({
        method: "POST",
        url: `/api/cases/${MISSING_CASE_ID}/evidence/annotations`,
        headers: { cookie: alice },
        payload: { ...request, artifactIds: [MISSING_ARTIFACT_ID] },
      });
      expect(missingCase.statusCode).toBe(404);
      expect(JSON.parse(missingCase.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "forbidden",
      });
      expect(await caseStore.listArtifactAnnotationsByCase(created.id)).toEqual([]);
      expect(await caseStore.getArtifactAnnotationBulkIdempotency(
        created.id,
        users().get("alice")!.identity.id,
        key,
      )).toBeNull();
      expect((await caseStore.listTimeline(created.id)).filter((event) => event.kind === "artifact_annotation_created"))
        .toEqual([]);
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toEqual([]);
    });
  });

  it("replays a real bulk commit after its acknowledgement outcome was unknown", async () => {
    const caseStore = new UnknownOnceAfterCommitCaseStore();
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Unknown bulk annotation commit" },
      })).body));
      const uploaded = parseEvidenceUploadSuccess(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename: "unknown-commit.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("unknown commit evidence").toString("base64"),
          summary: "Unknown commit evidence",
        },
      })).body)).artifact;
      const request = {
        schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
        artifactIds: [uploaded.id],
        body: "Unknown commit",
        idempotencyKey: "bulk-unknown-0001",
      };
      caseStore.failAfterNextCommit = true;
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: request,
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "commit_outcome_unknown" });
      const committedAnnotations = await caseStore.listArtifactAnnotationsByCase(created.id);
      expect(committedAnnotations).toHaveLength(1);
      expect((await caseStore.listTimeline(created.id))
        .filter((event) => event.kind === "artifact_annotation_created")).toHaveLength(1);
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toHaveLength(1);
      const committedIntent = await caseStore.getArtifactAnnotationBulkIdempotency(
        created.id,
        users().get("alice")!.identity.id,
        request.idempotencyKey,
      );
      expect(committedIntent).not.toBeNull();
      const captured = caseStore.capture() as {
        artifactAnnotationBulkIntents: [string, unknown][];
      };
      expect(captured.artifactAnnotationBulkIntents).toHaveLength(1);

      const retry = parseArtifactAnnotationBulkResult(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/evidence/annotations`,
        headers: { cookie: alice },
        payload: request,
      })).body));
      expect(retry.items[0]?.outcome).toBe("replayed");
      expect(retry.items[0]?.outcome === "replayed" && retry.items[0].annotation.id)
        .toBe(committedAnnotations[0]?.id);
      expect(await caseStore.listArtifactAnnotationsByCase(created.id)).toEqual(committedAnnotations);
      expect((await caseStore.listTimeline(created.id))
        .filter((event) => event.kind === "artifact_annotation_created")).toHaveLength(1);
      expect(await audit.list({ action: "artifact_annotation_bulk_create" })).toHaveLength(1);
      expect((caseStore.capture() as { artifactAnnotationBulkIntents: unknown[] })
        .artifactAnnotationBulkIntents).toHaveLength(1);
    }, caseStore);
  });

  it("reports an unknown evidence COMMIT outcome without exposing driver details", async () => {
    await withApp(async ({ app, domain }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic unknown commit response" },
      })).body));
      const original = domain.addEvidence.bind(domain);
      domain.addEvidence = vi.fn(async () => {
        throw new CaseStoreCommitOutcomeUnknownError();
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/evidence`,
          headers: { cookie: alice },
          payload: {
            kind: "log",
            filename: "unknown-commit.log",
            mediaType: "text/plain",
            contentBase64: Buffer.from(LOG).toString("base64"),
            summary: "Synthetic unknown commit response.",
          },
        });
        expect(response.statusCode).toBe(503);
        expect(JSON.parse(response.body)).toEqual({ error: "commit_outcome_unknown" });
        expect(response.body).not.toMatch(/postgres|commit response|connection|password/i);
      } finally {
        domain.addEvidence = original;
      }
    });
  });

  it("rejects malformed clientTime values before creating durable state", async () => {
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      for (const clientTime of ["not-a-timestamp", "2026-02-31T00:00:00Z", 1234]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/cases",
          headers: { cookie: alice },
          payload: { title: "Must not persist", clientTime },
        });
        expect(response.statusCode).toBe(400);
      }
      const listed = parseCaseList(JSON.parse((await app.inject({
        method: "GET",
        url: "/api/cases",
        headers: { cookie: alice },
      })).body));
      expect(listed.cases).toEqual([]);
      expect(await audit.list({ action: "case_create" })).toEqual([]);
    });
  });

  it("persists an explicitly unknown Situation and lets authorized members refine it", async () => {
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic queue delay" },
      });
      expect(createdResponse.statusCode).toBe(200);
      const created = parseCase(JSON.parse(createdResponse.body));
      expect(created.problemStatement).toBe("");
      expect(created.affectedParties).toBe("");
      expect(created.impact).toBe("");
      expect(created.scope).toBe("");
      expect(created.openQuestions).toEqual([]);
      expect(created.investigationContext).toBeNull();

      const updatedResponse = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 0,
          problemStatement: "  Synthetic jobs remain queued after a worker restart.  ",
          affectedParties: "Fixture operators",
          impact: "Synthetic jobs require manual replay.",
          scope: "One disposable worker group.",
          openQuestions: [
            " Did lease recovery run before the queue stalled? ",
            "",
          ],
          investigationContext: {
            productName: "  Fixture Desk  ",
            version: "4.2",
            build: "build-007",
            component: "queue-worker",
            environment: "QA / us-central",
            organization: "Synthetic Harbor",
          },
        },
      });
      expect(updatedResponse.statusCode).toBe(200);
      const updated = parseCase(JSON.parse(updatedResponse.body));
      expect(updated.problemStatement).toBe(
        "Synthetic jobs remain queued after a worker restart.",
      );
      expect(updated.affectedParties).toBe("Fixture operators");
      expect(updated.impact).toBe("Synthetic jobs require manual replay.");
      expect(updated.scope).toBe("One disposable worker group.");
      expect(updated.openQuestions).toEqual([
        "Did lease recovery run before the queue stalled?",
      ]);
      expect(updated.investigationContext).toEqual({
        productName: "  Fixture Desk  ",
        version: "4.2",
        build: "build-007",
        component: "queue-worker",
        environment: "QA / us-central",
        organization: "Synthetic Harbor",
      });
      expect(updated.situationVersion).toBe(1);

      const fetched = parseCase(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}`,
        headers: { cookie: alice },
      })).body));
      expect(fetched).toEqual(updated);

      const timeline = parseTimeline(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: alice },
      })).body));
      expect(timeline.events.at(-1)?.kind).toBe("case_situation_updated");
      expect(
        (await audit.list({ action: "case_situation_update" })).some(
          (event) => event.target === created.id && event.outcome === "success",
        ),
      ).toBe(true);

      const noOp = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          problemStatement: `  ${updated.problemStatement}  `,
        },
      });
      expect(noOp.statusCode).toBe(200);
      expect(parseCase(JSON.parse(noOp.body)).situationVersion).toBe(1);
      expect(parseTimeline(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: alice },
      })).body)).events).toHaveLength(timeline.events.length);
      expect(await audit.list({ action: "case_situation_update" })).toHaveLength(1);

      const invalidTime = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          impact: "This must never be committed.",
          clientTime: "not-a-timestamp",
        },
      });
      expect(invalidTime.statusCode).toBe(400);
      const afterInvalidTime = parseCase(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}`,
        headers: { cookie: alice },
      })).body));
      expect(afterInvalidTime.impact).toBe(updated.impact);
      expect(afterInvalidTime.situationVersion).toBe(1);
      expect(await audit.list({ action: "case_situation_update" })).toHaveLength(1);

      const secondUpdate = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          impact: "Synthetic jobs now require two manual replay steps.",
          changedFields: ["problemStatement", "scope"],
          clientTime: "2026-08-24T12:00:00-05:00",
        },
      });
      expect(secondUpdate.statusCode).toBe(200);
      const second = parseCase(JSON.parse(secondUpdate.body));
      expect(second.situationVersion).toBe(2);

      const stale = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: {
          expectedVersion: 1,
          problemStatement: "A stale editor must not overwrite current context.",
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body)).toEqual({
        error: "situation_conflict",
        currentVersion: 2,
      });
      const afterStale = parseCase(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}`,
        headers: { cookie: alice },
      })).body));
      expect(afterStale.problemStatement).toBe(updated.problemStatement);
      expect(afterStale.impact).toBe(second.impact);
      expect(afterStale.situationVersion).toBe(2);
      const afterStaleTimeline = parseTimeline(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: alice },
      })).body));
      expect(afterStaleTimeline.events).toHaveLength(timeline.events.length + 1);
      expect(afterStaleTimeline.events.at(-1)?.clientTime).toBe("2026-08-24T17:00:00.000Z");
      expect(JSON.parse(afterStaleTimeline.events.at(-1)?.payload ?? "{}")).toMatchObject({
        changedFields: ["impact"],
        predecessorVersion: 1,
        situationVersion: 2,
      });
      expect(await audit.list({ action: "case_situation_update" })).toHaveLength(2);

      const carol = await login(app, "carol", "fixture-carol-secret");
      const viewerDenied = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: carol },
        payload: { scope: "Should not be accepted" },
      });
      expect(viewerDenied.statusCode).toBe(403);

      const eve = await login(app, "eve", "fixture-eve-secret");
      const nonMemberDenied = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: eve },
        payload: { scope: "Should not be accepted" },
      });
      expect(nonMemberDenied.statusCode).toBe(404);

      const malformed = await app.inject({
        method: "PATCH",
        url: `/api/cases/${created.id}/situation`,
        headers: { cookie: alice },
        payload: { openQuestions: "not-an-array" },
      });
      expect(malformed.statusCode).toBe(400);
    });
  });

  it("validates hypothesis link identities in-case before any durable write", async () => {
    await withApp(async ({ app, audit, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const createCase = async (title: string) => parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title },
      })).body));
      const createContribution = async (
        caseId: string,
        payload: Record<string, unknown>,
      ) => parseContribution(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload,
      })).body));
      const uploadArtifact = async (caseId: string, filename: string, content: string) => {
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${caseId}/evidence`,
          headers: { cookie: alice },
          payload: {
            kind: "log",
            filename,
            mediaType: "text/plain",
            contentBase64: Buffer.from(content).toString("base64"),
            summary: `${filename} summary`,
          },
        });
        expect(response.statusCode).toBe(200);
        return parseEvidenceUploadSuccess(JSON.parse(response.body)).artifact;
      };

      const primary = await createCase("Primary link authority fixture");
      const secondary = await createCase("Secondary link authority fixture");
      const primaryNote = await createContribution(primary.id, {
        kind: "note",
        body: "Primary case observation",
      });
      const secondaryNote = await createContribution(secondary.id, {
        kind: "note",
        body: "Secondary case observation",
      });
      const primaryArtifact = await uploadArtifact(primary.id, "primary.log", "primary\n");
      const secondaryArtifact = await uploadArtifact(secondary.id, "secondary.log", "secondary\n");
      for (const id of [
        primaryNote.id,
        secondaryNote.id,
        primaryArtifact.id,
        secondaryArtifact.id,
      ]) {
        expect(isRfc4122Uuid(id)).toBe(true);
      }

      const linked = await createContribution(primary.id, {
        kind: "hypothesis",
        body: "Both case-local link kinds are valid",
        hypothesisLinks: [
          { kind: "artifact", id: primaryArtifact.id },
          { kind: "contribution", id: primaryNote.id },
        ],
      });
      expect(linked.hypothesisLinks).toEqual([
        { kind: "artifact", id: primaryArtifact.id },
        { kind: "contribution", id: primaryNote.id },
      ]);
      const statusTarget = await createContribution(primary.id, {
        kind: "hypothesis",
        body: "Status mutation target",
      });

      const baselineLatest = await caseStore.listLatestRevisions(primary.id);
      const baselineTimeline = await caseStore.listTimeline(primary.id);
      const baselineCreateAudits = await audit.list({ action: "contribution_create" });
      const baselineStatusAudits = await audit.list({ action: "hypothesis_status" });
      const artifactLookup = vi.spyOn(caseStore, "getArtifact");
      const contributionLookup = vi.spyOn(caseStore, "listRevisions");

      const invalidUuidCreate = await app.inject({
        method: "POST",
        url: `/api/cases/${primary.id}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "hypothesis",
          body: "Rejected before store lookup",
          hypothesisLinks: [{ kind: "artifact", id: "not-a-uuid" }],
        },
      });
      expect(invalidUuidCreate.statusCode).toBe(400);
      const invalidUuidCreateFailure = JSON.parse(invalidUuidCreate.body) as {
        error?: string;
        detail?: string;
      };
      expect(invalidUuidCreateFailure.error).toBe("invalid");
      expect(artifactLookup).not.toHaveBeenCalled();
      expect(contributionLookup).not.toHaveBeenCalled();

      const invalidUuidContributionCreate = await app.inject({
        method: "POST",
        url: `/api/cases/${primary.id}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "hypothesis",
          body: "Rejected before contribution lookup",
          hypothesisLinks: [{ kind: "contribution", id: "also-not-a-uuid" }],
        },
      });
      expect(invalidUuidContributionCreate.statusCode).toBe(400);
      expect((JSON.parse(invalidUuidContributionCreate.body) as { detail?: string }).detail).toBe(
        invalidUuidCreateFailure.detail,
      );
      expect(artifactLookup).not.toHaveBeenCalled();
      expect(contributionLookup).not.toHaveBeenCalled();

      const invalidCreateLinks: Array<{
        label: string;
        links: unknown;
        kind?: string;
        idempotencyKey?: string;
      }> = [
        { label: "non-array", links: "not-an-array" },
        { label: "unknown kind", links: [{ kind: "url", id: primaryArtifact.id }] },
        { label: "non-string id", links: [{ kind: "artifact", id: 42 }] },
        { label: "empty id", links: [{ kind: "artifact", id: "" }] },
        { label: "null link", links: [null] },
        {
          label: "extra link key",
          links: [{ kind: "artifact", id: primaryArtifact.id, caseId: primary.id }],
        },
        {
          label: "nonexistent artifact",
          links: [{ kind: "artifact", id: MISSING_ARTIFACT_ID }],
          idempotencyKey: "invalid-link-create-1",
        },
        {
          label: "nonexistent contribution",
          links: [{ kind: "contribution", id: MISSING_CONTRIBUTION_ID }],
        },
        {
          label: "artifact kind with contribution id",
          links: [{ kind: "artifact", id: primaryNote.id }],
        },
        {
          label: "contribution kind with artifact id",
          links: [{ kind: "contribution", id: primaryArtifact.id }],
        },
        { label: "cross-case artifact", links: [{ kind: "artifact", id: secondaryArtifact.id }] },
        {
          label: "cross-case contribution",
          links: [{ kind: "contribution", id: secondaryNote.id }],
        },
        {
          label: "links on a note",
          kind: "note",
          links: [{ kind: "artifact", id: primaryArtifact.id }],
        },
      ];
      const createFailures = new Map<string, { error?: string; detail?: string }>();
      for (const attempt of invalidCreateLinks) {
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${primary.id}/contributions`,
          headers: { cookie: alice },
          payload: {
            kind: attempt.kind ?? "hypothesis",
            body: `Rejected: ${attempt.label}`,
            hypothesisLinks: attempt.links,
            ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
          },
        });
        expect(response.statusCode, attempt.label).toBe(400);
        const failure = JSON.parse(response.body) as { error?: string; detail?: string };
        expect(failure.error, attempt.label).toBe("invalid");
        createFailures.set(attempt.label, failure);
      }
      expect(createFailures.get("nonexistent artifact")?.detail).toBe(
        createFailures.get("cross-case artifact")?.detail,
      );
      expect(invalidUuidCreateFailure.detail).toBe(
        createFailures.get("nonexistent artifact")?.detail,
      );
      expect(createFailures.get("nonexistent contribution")?.detail).toBe(
        createFailures.get("cross-case contribution")?.detail,
      );

      const invalidStatusLinks: Array<{ label: string; links: unknown }> = [
        { label: "status non-array", links: { kind: "artifact", id: primaryArtifact.id } },
        { label: "status unknown kind", links: [{ kind: "url", id: primaryArtifact.id }] },
        { label: "status non-string id", links: [{ kind: "artifact", id: 42 }] },
        { label: "status empty id", links: [{ kind: "contribution", id: "" }] },
        { label: "status null link", links: [null] },
        {
          label: "status extra link key",
          links: [{ kind: "artifact", id: primaryArtifact.id, extra: true }],
        },
        {
          label: "status nonexistent artifact",
          links: [{ kind: "artifact", id: MISSING_ARTIFACT_ID }],
        },
        {
          label: "status nonexistent contribution",
          links: [{ kind: "contribution", id: MISSING_CONTRIBUTION_ID }],
        },
        {
          label: "status artifact kind with contribution id",
          links: [{ kind: "artifact", id: primaryNote.id }],
        },
        {
          label: "status cross-case artifact",
          links: [{ kind: "artifact", id: secondaryArtifact.id }],
        },
        {
          label: "status cross-case contribution",
          links: [{ kind: "contribution", id: secondaryNote.id }],
        },
      ];
      const statusFailures = new Map<string, { error?: string; detail?: string }>();
      for (const attempt of invalidStatusLinks) {
        const response = await app.inject({
          method: "POST",
          url: `/api/cases/${primary.id}/hypotheses/${statusTarget.id}/status`,
          headers: { cookie: alice },
          payload: { status: "supported", links: attempt.links },
        });
        expect(response.statusCode, attempt.label).toBe(400);
        const failure = JSON.parse(response.body) as { error?: string; detail?: string };
        expect(failure.error, attempt.label).toBe("invalid");
        statusFailures.set(attempt.label, failure);
      }
      expect(statusFailures.get("status nonexistent artifact")?.detail).toBe(
        statusFailures.get("status cross-case artifact")?.detail,
      );
      expect(statusFailures.get("status nonexistent contribution")?.detail).toBe(
        statusFailures.get("status cross-case contribution")?.detail,
      );

      const artifactCallsBeforeInvalidStatus = artifactLookup.mock.calls.length;
      const contributionCallsBeforeInvalidStatus = contributionLookup.mock.calls.length;
      const invalidUuidStatus = await app.inject({
        method: "POST",
        url: `/api/cases/${primary.id}/hypotheses/${statusTarget.id}/status`,
        headers: { cookie: alice },
        payload: {
          status: "supported",
          links: [{ kind: "artifact", id: "still-not-a-uuid" }],
        },
      });
      expect(invalidUuidStatus.statusCode).toBe(400);
      const invalidUuidStatusFailure = JSON.parse(invalidUuidStatus.body) as {
        error?: string;
        detail?: string;
      };
      expect(invalidUuidStatusFailure.detail).toBe(
        statusFailures.get("status nonexistent artifact")?.detail,
      );
      expect(artifactLookup).toHaveBeenCalledTimes(artifactCallsBeforeInvalidStatus);
      expect(contributionLookup).toHaveBeenCalledTimes(contributionCallsBeforeInvalidStatus + 1);
      expect(contributionLookup).not.toHaveBeenCalledWith("still-not-a-uuid");

      expect(await caseStore.listLatestRevisions(primary.id)).toEqual(baselineLatest);
      expect(await caseStore.listRevisions(statusTarget.id)).toHaveLength(1);
      expect(await caseStore.listTimeline(primary.id)).toEqual(baselineTimeline);
      expect(await audit.list({ action: "contribution_create" })).toEqual(
        baselineCreateAudits,
      );
      expect(await audit.list({ action: "hypothesis_status" })).toEqual(
        baselineStatusAudits,
      );
      expect(await caseStore.getContributionIdempotency(
        primary.id,
        "uid=alice,ou=people,dc=example,dc=test",
        "invalid-link-create-1",
      )).toBeNull();
    });
  });

  it("round-trips a fixture incident with attribution, hashes, revisions, and privacy", async () => {
    await withApp(async ({ app, audit, store }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: {
          title: "Synthetic mailer timeout",
          severity: "high",
          clientTime: "2000-01-01T00:00:00.000Z",
        },
      });
      expect(created.statusCode).toBe(200);
      const caseBody = parseCase(JSON.parse(created.body));
      expect(caseBody.status).toBe("open");
      const caseId = caseBody.id;

      const listed = parseCaseList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/cases",
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(listed.cases.map((c) => c.id)).toContain(caseId);

      const message = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: {
                kind: "message",
                body: "Seeing timeouts on the mailer worker.",
                clientTime: "1999-01-01T00:00:00.000Z",
              },
            })
          ).body,
        ),
      );
      expect(message.authorUsername).toBe("alice");
      expect(message.privacyClass).toBe("owner_only");
      expect(message.sourceId.length).toBeGreaterThan(0);

      const note = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: { kind: "note", body: "First look: queue depth climbed." },
            })
          ).body,
        ),
      );

      const hypothesis = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
              payload: {
                kind: "hypothesis",
                body: "Mailer pool exhaustion",
                hypothesisStatus: "proposed",
              },
            })
          ).body,
        ),
      );

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "action", body: "Page the mailer on-call." },
      });

      const logUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "log",
              filename: "app.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from(LOG).toString("base64"),
              summary: "Synthetic mailer timeout log",
            },
          })
        ).body,
      ) as { artifact: unknown; summary: unknown };
      const logArt = parseArtifact(logUpload.artifact);
      expect(logArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(LOG)));
      expect(await store.verify(logArt.contentHash ?? "")).toBe(true);
      expect(logArt.privacyClass).toBe("owner_only");
      const logSummary = parseContribution(logUpload.summary);

      const emailUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "email",
              filename: "alert.eml",
              mediaType: "message/rfc822",
              contentBase64: Buffer.from(EML).toString("base64"),
              summary: "Synthetic alert email",
              privacyClass: "share_safe",
            },
          })
        ).body,
      ) as { artifact: unknown };
      const emailArt = parseArtifact(emailUpload.artifact);
      expect(emailArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(EML)));
      expect(emailArt.privacyClass).toBe("share_safe");

      const edited = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${logSummary.id}/revisions`,
              headers: { cookie: alice },
              payload: { body: "Updated summary; original bytes must stay.", expectedRevision: 1 },
            })
          ).body,
        ),
      );
      expect(edited.revision).toBe(2);
      expect(edited.predecessorRevision).toBe(1);
      expect(logArt.contentHash).toBe(sha256Hex(new TextEncoder().encode(LOG)));

      const supported = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/hypotheses/${hypothesis.id}/status`,
              headers: { cookie: alice },
              payload: {
                status: "supported",
                links: [{ kind: "artifact", id: logArt.id }],
              },
            })
          ).body,
        ),
      );
      expect(supported.hypothesisStatus).toBe("supported");
      expect(supported.hypothesisLinks).toEqual([{ kind: "artifact", id: logArt.id }]);

      const noLink = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/hypotheses/${hypothesis.id}/status`,
        headers: { cookie: alice },
        payload: { status: "supported", links: [] },
      });
      expect(noLink.statusCode).toBe(400);

      const refUpload = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence`,
            headers: { cookie: alice },
            payload: {
              kind: "file_server_ref",
              uri: "https://files.example.test/incident/core.bin",
              expectedHash: sha256Hex(new TextEncoder().encode("remote")),
              summary: "Core dump stays on the file server",
            },
          })
        ).body,
      ) as { artifact: unknown };
      const refArt = parseArtifact(refUpload.artifact);
      expect(refArt.uri).toBe("https://files.example.test/incident/core.bin");
      expect(refArt.verificationStatus).toBe("unverified");
      const originalRef = { ...refArt };

      const recheck = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/evidence/${refArt.id}/recheck`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { artifact: unknown; status: string };
      expect(recheck.status).toBe("unreachable");
      const afterRecheck = parseArtifact(recheck.artifact);
      expect(afterRecheck.verificationStatus).toBe(originalRef.verificationStatus);
      expect(afterRecheck.uri).toBe(originalRef.uri);
      expect(afterRecheck.expectedHash).toBe(originalRef.expectedHash);

      const provenance = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${note.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const noteV2 = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${note.id}/revisions`,
              headers: { cookie: alice },
              payload: { body: "Revised observation after the log upload.", expectedRevision: 1 },
            })
          ).body,
        ),
      );
      expect(noteV2.revision).toBe(2);
      const contributionList = parseContributionList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(contributionList.caseId).toBe(caseId);
      expect(contributionList.contributions.find((item) => item.id === note.id)?.body).toBe(
        "Revised observation after the log upload.",
      );
      const chain = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${note.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(chain.revisions).toHaveLength(2);
      expect(chain.revisions[0]?.body).toBe("First look: queue depth climbed.");
      expect(chain.revisions[1]?.body).toBe("Revised observation after the log upload.");
      expect(provenance.revisions[0]?.revision).toBe(1);

      const dave = await login(app, "dave", "fixture-dave-secret");
      const statusRes = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/status`,
              headers: { cookie: dave },
              payload: { status: "monitoring" },
            })
          ).body,
        ),
      );
      expect(statusRes.status).toBe("monitoring");

      const bytesDeniedMember = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${logArt.id}/bytes`,
        headers: { cookie: alice },
      });
      expect(bytesDeniedMember.statusCode).toBe(404);
      expect(JSON.parse(bytesDeniedMember.body)).toEqual({ error: "not_found" });

      const bytesOk = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${logArt.id}/bytes`,
        headers: { cookie: dave },
      });
      expect(bytesOk.statusCode).toBe(200);
      expect(
        Buffer.from(
          (JSON.parse(bytesOk.body) as { contentBase64: string }).contentBase64,
          "base64",
        ).toString("utf8"),
      ).toBe(LOG);

      const carol = await login(app, "carol", "fixture-carol-secret");
      const bytesDenied = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/evidence/${logArt.id}/bytes`,
        headers: { cookie: carol },
      });
      expect(bytesDenied.statusCode).toBe(404);

      const added = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/participants`,
              headers: { cookie: dave },
              payload: {
                identityId: "uid=carol,ou=people,dc=example,dc=test",
                username: "carol",
              },
            })
          ).body,
        ),
      );
      expect(added.participants.some((p) => p.username === "carol")).toBe(true);
      const carolCase = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}`,
        headers: { cookie: carol },
      });
      expect(carolCase.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/legal-hold`,
        headers: { cookie: dave },
        payload: { legalHold: true },
      });
      const held = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions/${message.id}/tombstone`,
        headers: { cookie: alice },
      });
      expect(held.statusCode).toBe(409);

      await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/legal-hold`,
        headers: { cookie: dave },
        payload: { legalHold: false },
      });
      const tomb = parseContribution(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${caseId}/contributions/${message.id}/tombstone`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(tomb.tombstoned).toBe(true);
      expect(tomb.body).toBeNull();
      const tombChain = parseProvenance(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${caseId}/contributions/${message.id}/provenance`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(tombChain.revisions[0]?.body).toBe("Seeing timeouts on the mailer worker.");

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
      const seqs = timeline.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(timeline.events.some((e) => e.clientTime === "1999-01-01T00:00:00.000Z")).toBe(
        true,
      );
      const firstUserEvent = timeline.events.find((e) => e.kind === "contribution_created");
      expect(firstUserEvent?.seq).toBeLessThan(
        timeline.events.find((e) => e.kind === "evidence_recheck")?.seq ?? 0,
      );
      expect(timeline.events.some((e) => e.kind === "hypothesis_status")).toBe(true);
      expect(timeline.events.some((e) => e.kind === "evidence_recheck")).toBe(true);
      expect(timeline.events.every((e) => e.actorUsername.length > 0)).toBe(true);

      const audits = await audit.list();
      expect(audits.some((a) => a.action === "case_create" && a.identity?.includes("alice"))).toBe(
        true,
      );
      expect(audits.filter((a) => a.action === "contribution_create").length).toBeGreaterThan(3);
      expect(audits.some((a) => a.action === "evidence_register")).toBe(true);
      expect(audits.some((a) => a.action === "hypothesis_status")).toBe(true);
      expect(audits.some((a) => a.action === "contribution_tombstone")).toBe(true);

      const sources = parseSourceList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/catalog/sources",
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const sourceIds = new Set(sources.sources.map((s) => s.id));
      expect(sourceIds.has(message.sourceId)).toBe(true);
      expect(sourceIds.has(note.sourceId)).toBe(true);
      expect(sourceIds.has(logArt.sourceId)).toBe(true);
    });
  });

  it("rejects contributor writes from non-members", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Membership gate fixture" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = parseCase(JSON.parse(created.body)).id;
      const eve = await login(app, "eve", "fixture-eve-secret");

      const read = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}`,
        headers: { cookie: eve },
      });
      expect(read.statusCode).toBe(404);

      const write = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: eve },
        payload: { kind: "note", body: "This must not land." },
      });
      expect(write.statusCode).toBe(404);

      const ownerRead = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/timeline`,
        headers: { cookie: alice },
      });
      expect(parseTimeline(JSON.parse(ownerRead.body)).events).toHaveLength(1);
    });
  });

  it("cuts member case reads and writes after group-role revoke", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Revoke read fixture" },
      });
      const caseId = parseCase(JSON.parse(created.body)).id;
      const dave = await login(app, "dave", "fixture-dave-secret");

      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/authz/group-role-map",
        headers: { cookie: dave },
        payload: { group: "cn=contributors,ou=groups,dc=example,dc=test" },
      });
      expect(revoked.statusCode).toBe(200);

      const read = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}`,
        headers: { cookie: alice },
      });
      expect(read.statusCode).toBe(403);

      const write = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "note", body: "This must not land after revoke." },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  it("projects a bounded recent activity feed without exposing another case or contribution text", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const eve = await login(app, "eve", "fixture-eve-secret");
      const aliceCase = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic queue investigation", severity: "high" },
      })).body));
      const eveCase = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: eve },
        payload: { title: "Private synthetic investigation", severity: "low" },
      })).body));
      const privateBody = "Synthetic private observation must stay out of the feed";
      await app.inject({
        method: "POST",
        url: `/api/cases/${aliceCase.id}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "message", body: privateBody, privacyClass: "owner_only" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/activity?limit=2",
        headers: { cookie: alice },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        schemaId: string;
        activities: {
          caseId: string;
          caseTitle: string;
          kind: string;
          actorUsername: string;
          details: Record<string, unknown>;
        }[];
      };
      expect(body.schemaId).toBe("cd-collab.activity_feed.v1");
      expect(body.activities).toHaveLength(2);
      expect(body.activities.every((item) => item.caseId === aliceCase.id)).toBe(true);
      expect(body.activities.some((item) => item.kind === "contribution_created")).toBe(true);
      expect(body.activities.find((item) => item.kind === "contribution_created")?.details).toEqual({
        kind: "message",
      });
      expect(response.body).not.toContain(privateBody);
      expect(response.body).not.toContain(eveCase.id);
      expect(response.body).not.toContain(eveCase.title);
    });
  });

  it("replays identical contribution writes and requires expectedRevision on revise", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Contribution integrity fixture" },
      })).body));
      const first = parseContribution(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "note",
          body: "Authorized retry body.",
          idempotencyKey: "msg-syn-http1",
        },
      })).body));
      const replay = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "note",
          body: "Authorized retry body.",
          idempotencyKey: "msg-syn-http1",
        },
      });
      expect(replay.statusCode).toBe(200);
      expect(parseContribution(JSON.parse(replay.body)).id).toBe(first.id);
      const mismatch = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions`,
        headers: { cookie: alice },
        payload: {
          kind: "note",
          body: "Different authorized body.",
          idempotencyKey: "msg-syn-http1",
        },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(JSON.parse(mismatch.body)).toEqual({ error: "contribution_conflict" });

      const missingRev = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions/${first.id}/revisions`,
        headers: { cookie: alice },
        payload: { body: "Missing expected revision." },
      });
      expect(missingRev.statusCode).toBe(400);
      expect(JSON.parse(missingRev.body)).toEqual({ error: "expectedRevision is required" });

      const revised = parseContribution(JSON.parse((await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions/${first.id}/revisions`,
        headers: { cookie: alice },
        payload: { body: "Second revision.", expectedRevision: 1 },
      })).body));
      expect(revised.revision).toBe(2);
      const stale = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions/${first.id}/revisions`,
        headers: { cookie: alice },
        payload: { body: "Stale write.", expectedRevision: 1 },
      });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body)).toEqual({ error: "contribution_conflict", currentRevision: 2 });
    });
  });
});

describe("investigation coordination HTTP", () => {
  const request = (
    investigationId: string,
    action: "claim_self" | "release_self" | "assign_participant" | "release_participant",
    idempotencyKey: string,
    expectedRevision: number,
    targetIdentityId?: string,
  ) => ({
    schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
    investigationId,
    action,
    ...(targetIdentityId ? { targetIdentityId } : {}),
    expectedRevision,
    idempotencyKey,
  });

  it("conceals access, orders action authority, evaluates state, and replays exact successes", async () => {
    await withApp(async ({ app, domain, caseStore, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const carol = await login(app, "carol", "fixture-carol-secret");
      const dave = await login(app, "dave", "fixture-dave-secret");
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Synthetic coordination" },
      })).body));

      const initial = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
      });
      expect(initial.statusCode).toBe(200);
      expect(parseInvestigationCoordination(JSON.parse(initial.body))).toMatchObject({
        investigationId: created.id,
        coordinator: null,
        revision: 0,
        archived: false,
      });

      const concealed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: carol },
        payload: request(created.id, "claim_self", "coord-carol-01", 0),
      });
      expect(concealed.statusCode).toBe(404);

      // A recognized privileged action reaches its capability gate before
      // missing/extra request fields are disclosed by the strict parser.
      const privilegedBeforeStrictParse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: {
          action: "assign_participant",
          investigationId: created.id,
          surprise: true,
        },
      });
      expect(privilegedBeforeStrictParse.statusCode).toBe(403);
      const unknownAction = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: { action: "take_over" },
      });
      expect(unknownAction.statusCode).toBe(400);
      const wrongPathIdentity = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: request(MISSING_CASE_ID, "claim_self", "coord-wrong-path", 0),
      });
      expect(wrongPathIdentity.statusCode).toBe(400);
      const strictExtra = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: { ...request(created.id, "claim_self", "coord-strict-01", 0), surprise: true },
      });
      expect(strictExtra.statusCode).toBe(400);

      const claimPayload = request(created.id, "claim_self", "coord-alice-01", 0);
      const claimed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: claimPayload,
      });
      expect(claimed.statusCode).toBe(200);
      const claimedBody = parseInvestigationCoordinationActionSuccess(JSON.parse(claimed.body));
      expect(claimedBody.action).toBe("claim_self");
      expect(claimedBody.applied.revision).toBe(1);

      const replay = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: {
          ...claimPayload,
          expectedRevision: 999,
          clientTime: "2026-09-04T10:00:00-04:00",
        },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toBe(claimed.body);

      const mismatch = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: request(created.id, "release_self", "coord-alice-01", 1),
      });
      expect(mismatch.statusCode).toBe(409);
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(mismatch.body)).reason)
        .toBe("idempotency_intent_mismatch");

      const occupied = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: request(created.id, "claim_self", "coord-alice-02", 999),
      });
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(occupied.body)).reason)
        .toBe("already_coordinator");

      await domain.addParticipant(
        created.id,
        users().get("dave")!.identity,
        {
          identityId: users().get("eve")!.identity.id,
          username: users().get("eve")!.identity.username,
        },
        "test",
      );
      const ineligible = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: dave },
        payload: request(
          created.id,
          "assign_participant",
          "coord-dave-001",
          1,
          "uid=missing,ou=people,dc=example,dc=test",
        ),
      });
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(ineligible.body)).reason)
        .toBe("target_not_eligible");
      expect(await caseStore.getInvestigationCoordinationSuccessIntent(
        created.id,
        users().get("dave")!.identity.id,
        "coord-dave-001",
      )).toBeNull();

      const assigned = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: dave },
        payload: request(
          created.id,
          "assign_participant",
          "coord-alice-01",
          1,
          users().get("eve")!.identity.id,
        ),
      });
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(assigned.body)).applied.revision)
        .toBe(2);

      const changed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: dave },
        payload: request(
          created.id,
          "release_participant",
          "coord-dave-003",
          1,
          users().get("eve")!.identity.id,
        ),
      });
      expect(changed.statusCode).toBe(409);
      expect(parseInvestigationCoordinationChanged(JSON.parse(changed.body)).current.revision).toBe(2);

      const captured = caseStore.capture() as {
        cases: [string, { participants: { identityId: string; username: string }[] }][];
      };
      const capturedCase = captured.cases.find(([id]) => id === created.id)?.[1];
      expect(capturedCase).toBeDefined();
      capturedCase!.participants = capturedCase!.participants.filter(
        (participant) => participant.identityId !== users().get("eve")!.identity.id,
      );
      caseStore.restore(captured);
      const cleanup = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: dave },
        payload: request(
          created.id,
          "release_participant",
          "coord-dave-cleanup",
          2,
          users().get("eve")!.identity.id,
        ),
      });
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(cleanup.body)).applied)
        .toMatchObject({ coordinator: null, revision: 3 });

      await caseStore.updateCaseMeta({ id: created.id, status: "archived" });
      const archived = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: dave },
        payload: request(
          created.id,
          "release_participant",
          "coord-dave-004",
          3,
          users().get("eve")!.identity.id,
        ),
      });
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(archived.body)).reason)
        .toBe("investigation_archived");

      // A saved success bypasses fresh archive/CAS checks only after the
      // current request has passed session, capability, and case access.
      const archivedReplay = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: { ...claimPayload, expectedRevision: 44 },
      });
      expect(archivedReplay.body).toBe(claimed.body);

      const timeline = await caseStore.listTimeline(created.id);
      expect(timeline.filter((event) => event.kind === "investigation_coordination_changed"))
        .toHaveLength(3);
      expect((await audit.list()).filter(
        (event) => event.action === "investigation_coordination_changed"
          && event.outcome === "success",
      )).toHaveLength(3);
    });
  });

  it("performs no case-store read when the live session lacks investigation read", async () => {
    await withApp(async ({ app, caseStore, roleStore }) => {
      const alice = await login(app, "alice", ALICE);
      await roleStore.delete("cn=contributors,ou=groups,dc=example,dc=test");
      const getCase = vi.spyOn(caseStore, "getCase");
      const getCoordination = vi.spyOn(caseStore, "getInvestigationCoordination");
      const lockCase = vi.spyOn(caseStore, "lockCase");
      const withAtomic = vi.spyOn(caseStore, "withAtomic");
      const read = await app.inject({
        method: "GET",
        url: `/api/cases/${MISSING_CASE_ID}/coordination`,
        headers: { cookie: alice },
      });
      const write = await app.inject({
        method: "POST",
        url: `/api/cases/${MISSING_CASE_ID}/coordination`,
        headers: { cookie: alice },
        payload: request(MISSING_CASE_ID, "claim_self", "coord-alice-denied", 0),
      });
      expect(read.statusCode).toBe(403);
      expect(write.statusCode).toBe(403);
      expect(getCase).not.toHaveBeenCalled();
      expect(getCoordination).not.toHaveBeenCalled();
      expect(lockCase).not.toHaveBeenCalled();
      expect(withAtomic).not.toHaveBeenCalled();
    });
  });

  it("serializes concurrent claims through the case row boundary", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const eve = await login(app, "eve", "fixture-eve-secret");
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Concurrent coordination" },
      })).body));
      await domain.addParticipant(
        created.id,
        users().get("alice")!.identity,
        {
          identityId: users().get("eve")!.identity.id,
          username: users().get("eve")!.identity.username,
        },
        "test",
      );
      const responses = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/coordination`,
          headers: { cookie: alice },
          payload: request(created.id, "claim_self", "coord-race-alice", 0),
        }),
        app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/coordination`,
          headers: { cookie: eve },
          payload: request(created.id, "claim_self", "coord-race-eve", 0),
        }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const refused = responses.find((response) => response.statusCode === 409)!;
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(refused.body)).reason)
        .toBe("occupied");
      const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
      const winnerCookie = winnerIndex === 0 ? alice : eve;
      const loserCookie = winnerIndex === 0 ? eve : alice;
      const loserRelease = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: loserCookie },
        payload: request(created.id, "release_self", "coord-race-loser", 1),
      });
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(loserRelease.body)).reason)
        .toBe("not_coordinator");
      const winnerRelease = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: winnerCookie },
        payload: request(created.id, "release_self", "coord-race-winner", 1),
      });
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(winnerRelease.body)).applied)
        .toMatchObject({ coordinator: null, revision: 2 });
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(2);
    });
  });

  it("rolls projection, timeline, audit, and replay intent back together", async () => {
    const caseStore = new MemoryCaseStore();
    await withApp(async ({ app, audit }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Coordination rollback" },
      })).body));
      const originalAppend = audit.append.bind(audit);
      audit.append = vi.fn(async (event) => {
        if (event.action === "investigation_coordination_changed") throw new Error("synthetic audit failure");
        return originalAppend(event);
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload: request(created.id, "claim_self", "coord-rollback", 0),
      });
      expect(response.statusCode).toBe(400);
      expect(await caseStore.getInvestigationCoordination(created.id)).toBeNull();
      expect(await caseStore.getInvestigationCoordinationSuccessIntent(
        created.id,
        users().get("alice")!.identity.id,
        "coord-rollback",
      )).toBeNull();
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(0);
    }, caseStore);
  });

  it("maps an unknown coordination commit outcome to 503 without retrying", async () => {
    const caseStore = new UnknownOnceAfterCommitCaseStore();
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Unknown coordination outcome" },
      })).body));
      caseStore.failAfterNextCommit = true;
      const callsBefore = caseStore.atomicCalls;
      const payload = request(created.id, "claim_self", "coord-unknown-01", 0);
      const unknown = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload,
      });
      expect(unknown.statusCode).toBe(503);
      expect(JSON.parse(unknown.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(caseStore.atomicCalls - callsBefore).toBe(1);

      const retry = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        headers: { cookie: alice },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(retry.body)).applied.revision)
        .toBe(1);
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(1);
    }, caseStore);
  });
});
