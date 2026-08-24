import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOLD_IS_HUMAN_BENCHMARK,
  TRIAGE_JOB_REQUEST_SCHEMA_ID,
  parsePortableArchive,
  portableDestinationUuid,
  type PortableArchiveV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
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
import { CaseService } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "../experiments/index.js";
import { ImportService, MemoryRunStore } from "../import/index.js";
import { MemoryTriageJobStore, TriageRunService } from "../triage-runs/index.js";
import { loadPortableInstallationId } from "./installation.js";
import {
  MAX_PORTABLE_ARCHIVE_BYTES,
  PORTABLE_APPLY_UNAVAILABLE_REASON,
  PortableInvestigationService,
  PortableServerError,
} from "./service.js";

const ACTOR = { id: "actor-north", username: "operator-north" };
const LOG_BYTES = new TextEncoder().encode(
  "2042-03-04T10:00:00Z queue-worker WARN synthetic backlog exceeded 40 items\n",
);
const ROLE_MAP = [
  "cn=leads,ou=groups,dc=example,dc=test=case-lead",
  "cn=viewers,ou=groups,dc=example,dc=test=viewer",
  "cn=admins,ou=groups,dc=example,dc=test=admin",
].join(";");

interface Fixture {
  root: string;
  store: FilesystemEvidenceStore;
  audit: MemoryAuditStore;
  catalog: CatalogService;
  cases: CaseService;
  imports: ImportService;
  triageRuns: TriageRunService;
  experiments: ExperimentService;
  portable: PortableInvestigationService;
  caseId: string;
  evidenceId: string;
  evidenceHash: string;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForCompleted(
  triageRuns: TriageRunService,
  caseId: string,
  jobId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await triageRuns.get(caseId, jobId, ACTOR, false);
    if (job && ["completed", "partial", "failed", "timed_out", "cancelled"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("synthetic triage did not complete");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cd-portable-server-"));
  roots.push(root);
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(store, audit, undefined, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases,
    catalog,
    runs: new MemoryRunStore(),
  });
  const triageRuns = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    profiles: [
      { id: "profile-qwen", label: "Synthetic Qwen", provider: "openai-compatible" },
      { id: "profile-oss", label: "Synthetic OSS", provider: "openai-compatible" },
    ],
  });
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: new MemoryExperimentStore(),
  });
  const portable = new PortableInvestigationService({
    installationId: "inst-syntheticnorth",
    cases,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    now: () => "2042-03-04T12:00:00.000Z",
  });

  const caseRow = await cases.createCase(
    ACTOR,
    {
      title: "Synthetic queue stall",
      severity: "high",
      problemStatement: "Synthetic workers stop draining a bounded queue.",
      affectedParties: "Synthetic operations group",
      impact: "Synthetic requests wait longer than expected.",
      scope: "One fictional worker pool.",
      openQuestions: ["Which synthetic signal precedes the stall?"],
    },
    "fixture",
  );
  await cases.addContribution(
    caseRow.id,
    ACTOR,
    { kind: "note", body: "Queue depth rose before workers stalled.", privacyClass: "share_safe" },
    "fixture",
  );
  await cases.addContribution(
    caseRow.id,
    ACTOR,
    { kind: "message", body: "Please verify the synthetic worker trace.", privacyClass: "share_safe" },
    "fixture",
  );
  const uploaded = await cases.addEvidence(
    caseRow.id,
    ACTOR,
    {
      kind: "log",
      filename: "synthetic-worker.log",
      mediaType: "text/plain",
      bytes: LOG_BYTES,
      summary: "Synthetic worker warning",
      privacyClass: "owner_only",
    },
    "fixture",
  );
  const snapshot = await cases.createSnapshot(
    caseRow.id,
    ACTOR,
    { evidenceIds: [uploaded.artifact.id], visibility: "owner_only" },
    "fixture",
  );
  const externalSource = await catalog.create(
    ACTOR,
    { name: "Fixture assistant", kind: "external-tool", description: "Synthetic only" },
    "fixture",
  );
  const imported = await imports.importRun(
    caseRow.id,
    ACTOR,
    {
      outputText: "A synthetic queue stall may follow worker saturation.",
      promptText: "Inspect the synthetic queue evidence.",
      sourceId: externalSource.id,
      operatorId: ACTOR.id,
      operatorUsername: ACTOR.username,
      promptCompleteness: "exact",
      outputCompleteness: "exact",
      workflowCompleteness: "partial",
      evidenceVisibility: "complete",
      snapshotBinding: snapshot.fingerprint,
      provider: "openai-compatible",
      model: "qwen-3.6-27b",
      privacyClass: "owner_only",
    },
    "fixture",
    false,
  );
  const queued = await triageRuns.create(
    caseRow.id,
    ACTOR,
    {
      schemaId: TRIAGE_JOB_REQUEST_SCHEMA_ID,
      snapshotId: snapshot.id,
      mode: "deterministic_mock",
      strategyId: "synthetic-two-lane",
      question: "What should the fictional operator inspect next?",
      policyFingerprint: null,
      taskFingerprint: "ab".repeat(32),
      candidates: [
        {
          candidateId: "candidate-qwen",
          role: "reviewer",
          provider: "openai-compatible",
          profileId: "profile-qwen",
          model: "qwen-3.6-27b",
          version: null,
        },
        {
          candidateId: "candidate-oss",
          role: "contributor",
          provider: "openai-compatible",
          profileId: "profile-oss",
          model: "gpt-oss-120b",
          version: null,
        },
      ],
    },
    "fixture",
    false,
  );
  const job = await waitForCompleted(triageRuns, caseRow.id, queued.id);
  const experiment = await experiments.importTriageJob(
    caseRow.id,
    ACTOR,
    job,
    imported,
    "fixture",
    false,
  );
  await experiments.recordHelpfulness(
    caseRow.id,
    experiment.id,
    ACTOR,
    {
      candidateId: "candidate-qwen",
      dimension: "evidence_support",
      score: 3,
      rationale: "The synthetic lane cites the frozen warning.",
      evidenceRefs: [uploaded.artifact.id],
    },
    "fixture",
    false,
  );
  const proposed = await experiments.proposeDecision(
    caseRow.id,
    experiment.id,
    ACTOR,
    {
      text: "Inspect the fictional worker pool.",
      rationale: "The frozen warning supports a bounded next step.",
      evidenceRefs: [uploaded.artifact.id],
      owner: ACTOR,
      remainingUnknowns: ["Whether the synthetic condition repeats"],
    },
    "fixture",
    false,
  );
  const accepted = await experiments.acceptDecision(
    caseRow.id,
    experiment.id,
    ACTOR,
    proposed.revision,
    "fixture",
    false,
  );
  await experiments.promoteGold(
    caseRow.id,
    experiment.id,
    ACTOR,
    {
      decisionId: accepted.id,
      expectedRevision: accepted.revision,
      evidenceAnchors: [uploaded.artifact.id],
      notes: [GOLD_IS_HUMAN_BENCHMARK, "Synthetic benchmark only."],
    },
    "fixture",
    false,
  );
  return {
    root,
    store,
    audit,
    catalog,
    cases,
    imports,
    triageRuns,
    experiments,
    portable,
    caseId: caseRow.id,
    evidenceId: uploaded.artifact.id,
    evidenceHash: uploaded.artifact.contentHash as string,
  };
}

function users() {
  return new Map([
    [
      "operator-north",
      {
        password: "fixture-operator-secret",
        identity: { id: ACTOR.id, username: ACTOR.username, displayName: "Operator North" },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "viewer-west",
      {
        password: "fixture-viewer-secret",
        identity: { id: "actor-west", username: "viewer-west", displayName: "Viewer West" },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? value.split(";")[0] ?? "" : "";
}

async function appFor(row: Fixture) {
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(ROLE_MAP));
  return buildApp({
    config: testConfig({ evidenceRoot: row.root }),
    pool: null,
    store: row.store,
    domain: row.cases,
    catalog: row.catalog,
    imports: row.imports,
    triageRuns: row.triageRuns,
    experiments: row.experiments,
    portable: row.portable,
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit: row.audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit: row.audit,
    },
    serveStatic: false,
  });
}

describe("portable installation identity", () => {
  it("persists one opaque id and rejects a malformed configured id", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-portable-installation-"));
    roots.push(root);
    const first = await loadPortableInstallationId(root);
    const second = await loadPortableInstallationId(root);
    expect(second).toBe(first);
    expect(first).toMatch(/^inst-[a-f0-9]{32}$/);
    expect((await readFile(join(root, "portable-installation-id"), "utf8")).trim()).toBe(first);
    await expect(loadPortableInstallationId(root, "host.example.test")).rejects.toThrow(
      /installation id is invalid/,
    );
  });
});

describe("portable investigation service", () => {
  it("exports a parseable full archive with revisions, bytes, runs, lanes, decisions, and gold", async () => {
    const row = await fixture();
    const archive = parsePortableArchive(await row.portable.exportArchive(row.caseId, ACTOR, false));
    expect(archive.investigation.investigation.title).toBe("Synthetic queue stall");
    expect(archive.investigation.investigation).toMatchObject({
      problemStatement: "Synthetic workers stop draining a bounded queue.",
      affectedParties: "Synthetic operations group",
      impact: "Synthetic requests wait longer than expected.",
      scope: "One fictional worker pool.",
      openQuestions: ["Which synthetic signal precedes the stall?"],
      situationVersion: 0,
    });
    expect(archive.investigation.evidence.map((item) => item.id)).toContain(row.evidenceId);
    expect(archive.investigation.contentObjects.find((item) => item.digest === row.evidenceHash)?.payloadBase64)
      .toBe(Buffer.from(LOG_BYTES).toString("base64"));
    expect(archive.investigation.importedAiRuns).toHaveLength(1);
    expect(archive.investigation.triageJobs[0]?.candidates).toHaveLength(2);
    expect(archive.investigation.experiments).toHaveLength(1);
    expect(archive.investigation.helpfulnessObservations).toHaveLength(1);
    expect(archive.investigation.decisions.at(-1)?.status).toBe("accepted");
    expect(archive.investigation.gold).toHaveLength(1);
    expect(archive.investigation.discussions[0]?.messageIds).toHaveLength(1);
    expect(archive.investigation.actors.every((actor) => actor.roleNote === "Historical attribution only"))
      .toBe(true);
  });

  it("returns host-owned identity/collision/privacy facts and never authorizes apply", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false);
    const response = await row.portable.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: archive.investigation.actors.map((source) =>
          source.sourceActorId === ACTOR.id
            ? {
                sourceActorId: source.sourceActorId,
                action: "map_existing" as const,
                destinationActorId: ACTOR.id,
              }
            : {
                sourceActorId: source.sourceActorId,
                action: "preserve_historical_external" as const,
                destinationActorId: null,
              },
        ),
      },
      ACTOR,
      false,
    );
    expect(response.privacy.classification).toBe("contains_owner_only");
    expect(response.privacy.inlineByteLength).toBeGreaterThan(LOG_BYTES.byteLength);
    expect(response.privacy.unclassifiedContentObjects).toBeGreaterThan(0);
    expect(response.report.idRemap.length).toBeGreaterThan(0);
    expect(response.authorization.destinationCatalogSource).toBe("host_visible_catalog");
    expect(response.authorization.sourceRolesTrusted).toBe(false);
    expect(response.authorization.destinationMembershipGranted).toBe(false);
    expect(response.apply).toEqual({
      available: false,
      reason: PORTABLE_APPLY_UNAVAILABLE_REASON,
    });
    expect(response.report.applyAuthorized).toBe(false);
    expect(response.unsupported).not.toContain("investigation_situation_fields");
    expect(response.unsupported).toContain("imported_content_privacy_is_not_contract_bound");
  });

  it("fails closed when Situation changes during archive assembly", async () => {
    const row = await fixture();
    let caseReads = 0;
    const mutatingCases = new Proxy(row.cases, {
      get(target, property, receiver) {
        if (property === "getCase") {
          return async (...args: Parameters<CaseService["getCase"]>) => {
            const found = await target.getCase(...args);
            caseReads += 1;
            return caseReads === 2 && found
              ? {
                  ...found,
                  problemStatement: "A concurrent synthetic edit must invalidate the archive.",
                  situationVersion: (found.situationVersion ?? 0) + 1,
                }
              : found;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const portable = new PortableInvestigationService({
      installationId: "inst-syntheticnorth",
      cases: mutatingCases,
      catalog: row.catalog,
      imports: row.imports,
      triageRuns: row.triageRuns,
      experiments: row.experiments,
      audit: row.audit,
      now: () => "2042-03-04T12:00:00.000Z",
    });

    await expect(portable.exportArchive(row.caseId, ACTOR, false)).rejects.toMatchObject({
      code: "integrity_failure",
    } satisfies Partial<PortableServerError>);
  });

  it("reports a host-owned deterministic destination collision as blocked", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false);
    const collisionId = portableDestinationUuid(
      archive.investigation.sourceInstallationId,
      "investigation",
      archive.investigation.investigation.id,
      0,
    );
    const collisionCases = {
      ...row.cases,
      listCases: async () => [
        {
          ...archive.investigation.investigation,
          schemaId: "cd-collab.case.v1" as const,
          id: collisionId,
          problemStatement: "",
          affectedParties: "",
          impact: "",
          scope: "",
          openQuestions: [],
          participants: [{ identityId: ACTOR.id, username: ACTOR.username }],
        },
      ],
      listContributions: async () => [],
      listArtifacts: async () => [],
      listSnapshots: async () => [],
      listTimeline: async () => [],
    } as unknown as CaseService;
    const collisionService = new PortableInvestigationService({
      installationId: "inst-destinationwest",
      cases: collisionCases,
      catalog: row.catalog,
      imports: {
        listRuns: async () => [],
      } as unknown as ImportService,
      triageRuns: {
        list: async () => [],
        listProfiles: () => [],
      } as unknown as TriageRunService,
      experiments: {
        list: async () => [],
      } as unknown as ExperimentService,
      audit: row.audit,
    });
    const response = await collisionService.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "fail",
        identityMap: archive.investigation.actors.map((source) => ({
          sourceActorId: source.sourceActorId,
          action: "preserve_historical_external" as const,
          destinationActorId: null,
        })),
      },
      ACTOR,
      false,
    );
    expect(response.report.counts.conflict).toBeGreaterThan(0);
    expect(response.report.counts.blocked).toBeGreaterThan(0);
    expect(response.report.reconstructionReasons.some((reason) => reason.code === "id_collision"))
      .toBe(true);
    expect(response.report.applyAuthorized).toBe(false);
  });

  it("fails closed when held evidence bytes mutate", async () => {
    const row = await fixture();
    const path = join(row.root, "blobs", row.evidenceHash.slice(0, 2), row.evidenceHash);
    await rm(path);
    await expect(row.portable.exportArchive(row.caseId, ACTOR, false)).rejects.toMatchObject({
      code: "integrity_failure",
    } satisfies Partial<PortableServerError>);
  });

  it("rejects a tampered archive without reflecting planted content", async () => {
    const row = await fixture();
    const archive = JSON.parse(
      JSON.stringify(await row.portable.exportArchive(row.caseId, ACTOR, false)),
    ) as PortableArchiveV1;
    archive.investigation.investigation.title = "PLANTED-ARCHIVE-CONTENT";
    await expect(
      row.portable.preflight(
        archive,
        { mode: "dry_run", collisionPolicy: "fail", identityMap: [] },
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "archive_invalid" });
  });
});

describe("portable investigation routes", () => {
  it("requires a lead, exports with no-store, and records metadata-only audit entries", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const viewer = await login(app, "viewer-west", "fixture-viewer-secret");
      const denied = await app.inject({
        method: "GET",
        url: `/api/cases/${row.caseId}/portable-archive`,
        headers: { cookie: viewer },
      });
      expect(denied.statusCode).toBe(403);

      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const exported = await app.inject({
        method: "GET",
        url: `/api/cases/${row.caseId}/portable-archive`,
        headers: { cookie: lead },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["cache-control"]).toBe("no-store");
      expect(exported.headers["content-disposition"]).toContain("contextdesk-investigation-");
      parsePortableArchive(JSON.parse(exported.body));
      const audits = await row.audit.list({ action: "portable_archive_export" });
      expect(audits.map((audit) => audit.outcome)).toEqual(["denied", "success"]);
      expect(JSON.stringify(audits)).not.toContain(Buffer.from(LOG_BYTES).toString("base64"));
    } finally {
      await app.close();
    }
  });

  it("preflights with a host catalog, rejects client destination authority, and exposes no apply route", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const archive = await row.portable.exportArchive(row.caseId, ACTOR, false);
      const identityMap = archive.investigation.actors.map((source) => ({
        sourceActorId: source.sourceActorId,
        action: source.sourceActorId === ACTOR.id ? ("map_existing" as const) : ("preserve_historical_external" as const),
        destinationActorId: source.sourceActorId === ACTOR.id ? ACTOR.id : null,
      }));
      const response = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead },
        payload: { archive, mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      });
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as {
        report: { applyAuthorized: boolean };
        authorization: { sourceRolesTrusted: boolean };
        apply: { available: boolean; reason: string };
      };
      expect(parsed.report.applyAuthorized).toBe(false);
      expect(parsed.authorization.sourceRolesTrusted).toBe(false);
      expect(parsed.apply).toEqual({
        available: false,
        reason: PORTABLE_APPLY_UNAVAILABLE_REASON,
      });

      const plantedDestination = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead },
        payload: {
          archive,
          mode: "dry_run",
          collisionPolicy: "fail",
          identityMap,
          destination: {
            identities: [{ actorId: "attacker", username: "attacker" }],
            objectIds: {},
            knownProfileIds: [],
          },
        },
      });
      expect(plantedDestination.statusCode).toBe(400);

      const apply = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/apply",
        headers: { cookie: lead },
        payload: {},
      });
      expect(apply.statusCode).toBe(404);

      const capabilities = await app.inject({
        method: "GET",
        url: "/api/portable-investigations/capabilities",
        headers: { cookie: lead },
      });
      expect(capabilities.statusCode).toBe(200);
      expect(JSON.parse(capabilities.body)).toMatchObject({
        maximumArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES,
        apply: { available: false, reason: PORTABLE_APPLY_UNAVAILABLE_REASON },
      });
    } finally {
      await app.close();
    }
  });

  it("returns a generic 422 for tampering and never reflects archive bytes", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const archive = JSON.parse(
        JSON.stringify(await row.portable.exportArchive(row.caseId, ACTOR, false)),
      ) as PortableArchiveV1;
      archive.investigation.investigation.title = "PLANTED-ARCHIVE-CONTENT";
      const response = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead },
        payload: { archive, mode: "dry_run", collisionPolicy: "fail", identityMap: [] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toBe('{"error":"archive_invalid"}');
      expect(response.body).not.toContain("PLANTED-ARCHIVE-CONTENT");
    } finally {
      await app.close();
    }
  });

  it("fails closed before parsing a request larger than the archive limit", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const oversized = { padding: "x".repeat(MAX_PORTABLE_ARCHIVE_BYTES + 1) };
      await expect(
        row.portable.preflight(
          oversized,
          { mode: "dry_run", collisionPolicy: "fail", identityMap: [] },
          ACTOR,
          false,
        ),
      ).rejects.toMatchObject<Partial<PortableServerError>>({ code: "archive_size_limit" });

      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const response = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead, "content-type": "application/json" },
        payload: JSON.stringify(oversized),
      });
      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
