import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  GOLD_IS_HUMAN_BENCHMARK,
  PORTABLE_APPLY_REQUEST_SCHEMA_ID,
  TRIAGE_JOB_REQUEST_SCHEMA_ID,
  attachPortableIntegrity,
  parsePortableArchive,
  portableApplyDeepLink,
  portableDestinationUuid,
  sealPortableArchive,
  type PortableArchiveV1,
  type PortableInvestigationUnsigned,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import {
  FilesystemEvidenceStore,
  sha256Hex,
  type EvidenceWriteBatch,
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
import { CatalogService, MemoryCatalogStore } from "../catalog/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "../experiments/index.js";
import { ImportService, MemoryRunStore } from "../import/index.js";
import { MemoryTriageJobStore, TriageRunService } from "../triage-runs/index.js";
import { loadPortableInstallationId } from "./installation.js";
import {
  memoryApplyBoundary,
  MemoryPortableApplyStateStore,
  persistPortableArchive,
  PortableCommitOutcomeUnknownError,
  withPgApplyTransaction,
  type MemoryApplyBoundary,
} from "./persist.js";
import {
  MAX_PORTABLE_ARCHIVE_BYTES,
  PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
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
  caseStore: MemoryCaseStore;
  imports: ImportService;
  triageRuns: TriageRunService;
  jobStore: MemoryTriageJobStore;
  experiments: ExperimentService;
  portable: PortableInvestigationService;
  applyBoundary: MemoryApplyBoundary;
  applyState: MemoryPortableApplyStateStore;
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
  const caseStore = new MemoryCaseStore();
  const catalogStore = new MemoryCatalogStore();
  const runStore = new MemoryRunStore();
  const experimentStore = new MemoryExperimentStore();
  const jobStore = new MemoryTriageJobStore();
  const applyState = new MemoryPortableApplyStateStore();
  const catalog = new CatalogService(catalogStore, audit);
  const cases = new CaseService(store, audit, caseStore, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases,
    catalog,
    runs: runStore,
  });
  const triageRuns = new TriageRunService({
    cases,
    audit,
    jobs: jobStore,
    profiles: [
      { id: "profile-qwen", label: "Synthetic Qwen", provider: "openai-compatible" },
      { id: "profile-oss", label: "Synthetic OSS", provider: "openai-compatible" },
    ],
  });
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: experimentStore,
  });
  const applyBoundary = memoryApplyBoundary({
    cases: caseStore,
    catalog: catalogStore,
    experiments: experimentStore,
    runs: runStore,
    jobs: jobStore,
    evidence: store,
    audit,
    applyState,
  });
  const portable = new PortableInvestigationService({
    installationId: "inst-syntheticnorth",
    cases,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState,
    withTransaction: applyBoundary.withTransaction,
    applyCoordination: "single_instance",
    confirmationRestartDurable: false,
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
  await cases.addParticipant(
    caseRow.id,
    ACTOR,
    { identityId: "actor-historical-reviewer", username: "historical-reviewer" },
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
    true,
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
      rationale: "The human review cites the frozen warning while the simulation cites nothing.",
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
    caseStore,
    imports,
    triageRuns,
    jobStore,
    experiments,
    portable,
    applyBoundary,
    applyState,
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
    [
      "reviewer-west",
      {
        password: "fixture-reviewer-secret",
        identity: { id: "actor-reviewer", username: "reviewer-west", displayName: "Reviewer West" },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

function identityMapFor(archive: PortableArchiveV1) {
  return archive.investigation.actors.map((source) =>
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
  );
}

function resealArchive(
  archive: PortableArchiveV1,
  mutate: (investigation: PortableInvestigationUnsigned) => void,
): PortableArchiveV1 {
  const { bundleFingerprint: _bundle, objectHashes: _hashes, ...unsigned } = structuredClone(
    archive.investigation,
  );
  mutate(unsigned as PortableInvestigationUnsigned);
  return sealPortableArchive({
    investigation: attachPortableIntegrity(unsigned as PortableInvestigationUnsigned),
    exportedAt: archive.exportedAt,
  });
}

function detachedArchiveFor(
  archive: PortableArchiveV1,
  digest: string,
): { archive: PortableArchiveV1; suppliedBlobs: NonNullable<Parameters<PortableInvestigationService["apply"]>[1]["suppliedBlobs"]> } {
  const original = archive.investigation.contentObjects.find((row) => row.digest === digest);
  if (!original?.payloadBase64) throw new Error("synthetic content must be inline before detaching");
  const { bundleFingerprint: _bundle, objectHashes: _hashes, ...unsigned } = structuredClone(
    archive.investigation,
  );
  const content = unsigned.contentObjects.find((row) => row.digest === digest);
  if (!content) throw new Error("synthetic detached content is missing");
  content.payloadBase64 = null;
  const investigation = attachPortableIntegrity(unsigned as PortableInvestigationUnsigned);
  return {
    archive: sealPortableArchive({ investigation, exportedAt: archive.exportedAt }),
    suppliedBlobs: [
      {
        digest,
        byteLength: original.byteLength,
        contentType: original.contentType,
        presence: "inline",
        payloadBase64: original.payloadBase64,
      },
    ],
  };
}

function applyInput(
  token: string,
  identityMap: ReturnType<typeof identityMapFor>,
  suppliedBlobs?: NonNullable<Parameters<PortableInvestigationService["apply"]>[1]["suppliedBlobs"]>,
) {
  return {
    confirmationToken: token,
    typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
    collisionPolicy: "remap_deterministic" as const,
    identityMap,
    ...(suppliedBlobs ? { suppliedBlobs } : {}),
  };
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
  it("exports a parseable supported archive and omits unsupported destination state", async () => {
    const row = await fixture();
    const archive = parsePortableArchive(await row.portable.exportArchive(row.caseId, ACTOR, false, true));
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
    expect(archive.investigation.triageJobs[0]).toMatchObject({
      status: "completed",
      requestMode: "deterministic_mock",
      question: "What should the fictional operator inspect next?",
      policyFingerprint: null,
      taskFingerprint: "ab".repeat(32),
      concurrency: null,
      sameSnapshot: true,
      agreementNotice: "Agreement is not proof of correctness.",
    });
    expect(archive.investigation.triageJobs[0]?.candidates.every(
      (candidate) => candidate.status === "completed" && candidate.summary !== undefined,
    )).toBe(true);
    expect(archive.investigation.experiments).toHaveLength(1);
    expect(archive.investigation.helpfulnessObservations).toHaveLength(1);
    expect(archive.investigation.decisions.at(-1)?.status).toBe("accepted");
    expect(archive.investigation.gold).toHaveLength(1);
    expect(archive.investigation.discussions).toEqual([]);
    expect(archive.investigation.alignments).toEqual([]);
    expect(archive.investigation.auditRefs).toEqual([]);
    expect(archive.investigation.participants).toEqual([]);
    expect(archive.investigation.sources.every((source) => source.identityId === null)).toBe(true);
    expect(archive.investigation.importedAiRuns.every((run) => run.opaquePayloadJson === null)).toBe(
      true,
    );
    expect(archive.investigation.actors.every((actor) => actor.roleNote === "Historical attribution only"))
      .toBe(true);
  });

  it("refuses export while any triage job or candidate remains nonterminal", async () => {
    const row = await fixture();
    const snapshot = (await row.cases.listSnapshots(row.caseId, ACTOR, false))[0];
    if (!snapshot) throw new Error("synthetic snapshot is missing");
    const queuedJob: TriageJobV1 = {
      schemaId: "cd-collab.triage_job.v1",
      id: "job-portable-nonterminal",
      caseId: row.caseId,
      snapshotId: snapshot.id,
      snapshotFingerprint: snapshot.fingerprint,
      requestFingerprint: "cd".repeat(32),
      cancellationId: "cancel-portable-nonterminal",
      parentJobId: null,
      request: {
        schemaId: TRIAGE_JOB_REQUEST_SCHEMA_ID,
        snapshotId: snapshot.id,
        mode: "deterministic_mock",
        strategyId: "synthetic-nonterminal",
        question: "Should this synthetic queued run be portable?",
        policyFingerprint: null,
        taskFingerprint: "de".repeat(32),
        candidates: [{
          candidateId: "candidate-nonterminal",
          role: "reviewer",
          provider: "openai-compatible",
          profileId: "profile-qwen",
          model: "qwen-3.6-27b",
          version: null,
        }],
      },
      status: "queued",
      candidates: [{
        candidateId: "candidate-nonterminal",
        role: "reviewer",
        provider: "openai-compatible",
        profileId: "profile-qwen",
        model: "qwen-3.6-27b",
        version: null,
        status: "queued",
        benchmarkRunId: null,
        outputHash: null,
        summary: null,
        evidenceRefs: [],
        unknowns: [],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        privacyClass: "owner_only",
      }],
      sameSnapshot: null,
      agreementNotice: "Agreement is not proof of correctness.",
      requestedBy: ACTOR.id,
      requestedByUsername: ACTOR.username,
      createdAt: "2042-03-04T11:59:00.000Z",
      updatedAt: "2042-03-04T11:59:00.000Z",
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      stoppedReason: null,
      workerId: null,
      leaseExpiresAt: null,
    };
    await row.jobStore.insert(queuedJob);
    await expect(row.portable.exportArchive(row.caseId, ACTOR, false, true)).rejects.toMatchObject({
      code: "unsupported_state",
    });
  });

  it("round-trips corpus intake batches, paths, provenance, and evidence bytes", async () => {
    const row = await fixture();
    const bytes = new TextEncoder().encode(
      "2042-03-04T11:30:00Z synthetic-router ERROR request timed out\n",
    );
    const seed = {
      origin: "files" as const,
      sourceLabel: "Synthetic router diagnostics",
      privacyClass: "owner_only" as const,
      idempotencyKey: "batch-synthetic-portable-1",
      files: [{
        relativePath: "router/timeout.log",
        mediaType: "text/plain",
        contentBase64: Buffer.from(bytes).toString("base64"),
      }],
      archiveBase64: null,
    };
    const preview = await row.cases.previewCorpusIntake(row.caseId, ACTOR, {
      schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
      ...seed,
    });
    const committed = await row.cases.commitCorpusIntake(
      row.caseId,
      ACTOR,
      {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        ...seed,
        previewToken: preview.previewToken,
      },
      "fixture",
    );

    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const exportedBatch = archive.investigation.intakeBatches?.[0];
    const exportedEvidence = archive.investigation.evidence.find(
      (item) => item.id === committed.items[0]?.artifactId,
    );
    expect(exportedBatch).toMatchObject({
      id: committed.id,
      origin: "files",
      sourceLabel: "Synthetic router diagnostics",
    });
    expect(exportedEvidence).toMatchObject({
      artifactKind: "log",
      relativePath: "router/timeout.log",
      intakeBatchId: committed.id,
      digest: sha256Hex(bytes),
    });

    const identityMap = identityMapFor(archive);
    const dryRun = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    expect(dryRun.report.exactReconstruction).toBe(true);
    const applied = await row.portable.apply(
      archive,
      applyInput(dryRun.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const restoredArtifacts = await row.cases.listArtifacts(applied.investigationId, ACTOR, false);
    const restoredEvidence = restoredArtifacts.find(
      (item) => item.relativePath === "router/timeout.log",
    );
    expect(restoredEvidence?.contentHash).toBe(sha256Hex(bytes));
    expect(restoredEvidence?.intakeBatchId).toBeTruthy();
    const restoredBatch = await row.cases.getCorpusIntakeBatch(
      applied.investigationId,
      restoredEvidence?.intakeBatchId as string,
    );
    expect(restoredBatch).toMatchObject({
      caseId: applied.investigationId,
      sourceLabel: "Synthetic router diagnostics",
      replayed: false,
    });
    expect(restoredBatch?.items[0]).toMatchObject({
      artifactId: restoredEvidence?.id,
      relativePath: "router/timeout.log",
      digest: sha256Hex(bytes),
    });
  });

  it("returns host-owned identity/collision/privacy facts and mints apply only for exact reconstruction", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const response = await row.portable.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: identityMapFor(archive),
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
    expect(response.apply.available).toBe(true);
    expect(response.apply.requiresExactReconstruction).toBe(true);
    expect(response.apply.typedConfirmation).toBe(PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE);
    if (response.report.exactReconstruction) {
      expect(response.apply.confirmationToken).toMatch(/^pit1\./);
      expect(response.apply.reason).toBeNull();
    } else {
      expect(response.apply.confirmationToken).toBeNull();
      expect(response.apply.reason).toBe("exact_reconstruction_required");
    }
    expect(response.report.applyAuthorized).toBe(false);
    expect(response.unsupported).not.toContain("investigation_situation_fields");
    expect(response.unsupported).toContain("imported_content_privacy_is_not_contract_bound");
  });

  it("blocks exact apply when an incoming archive represents unsupported source membership", async () => {
    const row = await fixture();
    const original = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const { bundleFingerprint: _bundle, objectHashes: _hashes, ...unsigned } = structuredClone(
      original.investigation,
    );
    unsigned.participants = [{ sourceActorId: ACTOR.id, role: "case-lead" }];
    const archive = sealPortableArchive({
      investigation: attachPortableIntegrity(unsigned as PortableInvestigationUnsigned),
      exportedAt: original.exportedAt,
    });
    const response = await row.portable.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: identityMapFor(archive),
      },
      ACTOR,
      false,
    );
    expect(response.report.exactReconstruction).toBe(false);
    expect(response.report.reconstructionStatus).toBe("blocked");
    expect(response.report.reconstructionReasons).toContainEqual(
      expect.objectContaining({ path: "$.investigation.participants" }),
    );
    expect(response.apply.confirmationToken).toBeNull();
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

    await expect(portable.exportArchive(row.caseId, ACTOR, false, true)).rejects.toMatchObject({
      code: "integrity_failure",
    } satisfies Partial<PortableServerError>);
  });

  it("reports a host-owned deterministic destination collision as blocked", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
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
    await expect(row.portable.exportArchive(row.caseId, ACTOR, false, true)).rejects.toMatchObject({
      code: "integrity_failure",
    } satisfies Partial<PortableServerError>);
  });

  it("rejects a tampered archive without reflecting planted content", async () => {
    const row = await fixture();
    const archive = JSON.parse(
      JSON.stringify(await row.portable.exportArchive(row.caseId, ACTOR, false, true)),
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

  it("preflights with a host catalog, rejects client destination authority, and exposes apply", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
      const identityMap = identityMapFor(archive);
      const response = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead },
        payload: { archive, mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      });
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as {
        report: { applyAuthorized: boolean; exactReconstruction: boolean };
        authorization: { sourceRolesTrusted: boolean };
        apply: { available: boolean; confirmationToken: string | null; typedConfirmation: string };
      };
      expect(parsed.report.applyAuthorized).toBe(false);
      expect(parsed.authorization.sourceRolesTrusted).toBe(false);
      expect(parsed.apply.available).toBe(true);
      expect(parsed.apply.typedConfirmation).toBe(PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE);

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

      const plantedApplyDestination = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/apply",
        headers: { cookie: lead },
        payload: {
          schemaId: "cd-collab.portable_investigation_apply_request.v1",
          confirmationToken: "pit1.forged",
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap,
          archive,
          destination: { identities: [], objectIds: {}, knownProfileIds: [] },
        },
      });
      expect(plantedApplyDestination.statusCode).toBe(400);

      const malformedSuppliedBlobs = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/apply",
        headers: { cookie: lead },
        payload: {
          schemaId: PORTABLE_APPLY_REQUEST_SCHEMA_ID,
          confirmationToken: "pit1.synthetic",
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap,
          archive,
          suppliedBlobs: { digest: row.evidenceHash },
        },
      });
      expect(malformedSuppliedBlobs.statusCode).toBe(400);
      expect(JSON.parse(malformedSuppliedBlobs.body)).toEqual({
        error: "portable_apply_request_invalid",
      });

      const capabilities = await app.inject({
        method: "GET",
        url: "/api/portable-investigations/capabilities",
        headers: { cookie: lead },
      });
      expect(capabilities.statusCode).toBe(200);
      expect(JSON.parse(capabilities.body)).toMatchObject({
        maximumArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES,
        apply: {
          available: true,
          requiresExactReconstruction: true,
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
        },
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
        JSON.stringify(await row.portable.exportArchive(row.caseId, ACTOR, false, true)),
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

describe("portable investigation apply", () => {
  it("applies an exact reconstruction once, preserves attribution-only people, and replays", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    expect(preview.report.exactReconstruction).toBe(true);
    expect(preview.apply.confirmationToken).toMatch(/^pit1\./);

    const applied = await row.portable.apply(
      archive,
      {
        confirmationToken: preview.apply.confirmationToken as string,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
        collisionPolicy: "remap_deterministic",
        identityMap,
      },
      ACTOR,
      false,
    );
    expect(applied.status).toBe("applied");
    expect(applied.authenticityClaim).toBe("none");
    expect(applied.destinationMembershipGranted).toBe(false);
    expect(applied.deepLink).toBe(portableApplyDeepLink(applied.investigationId));
    const imported = await row.cases.getCase(applied.investigationId, ACTOR, false);
    expect(imported?.title).toBe("Synthetic queue stall");
    expect(imported?.problemStatement).toBe("Synthetic workers stop draining a bounded queue.");
    expect(imported?.participants).toEqual([{ identityId: ACTOR.id, username: ACTOR.username }]);
    expect(imported?.participants.some((item) => item.identityId === "actor-historical-reviewer")).toBe(
      false,
    );
    const archivedJob = archive.investigation.triageJobs[0];
    const restoredJob = (await row.triageRuns.list(applied.investigationId, ACTOR, false))[0];
    if (!archivedJob || !restoredJob) throw new Error("portable triage history is missing");
    expect(restoredJob).toMatchObject({
      status: archivedJob.status,
      sameSnapshot: archivedJob.sameSnapshot,
      agreementNotice: archivedJob.agreementNotice,
      createdAt: archivedJob.createdAt,
      updatedAt: archivedJob.updatedAt,
      startedAt: archivedJob.startedAt,
      finishedAt: archivedJob.finishedAt,
      cancelRequestedAt: archivedJob.cancelRequestedAt,
      stoppedReason: archivedJob.stoppedReason,
      request: {
        mode: archivedJob.requestMode,
        strategyId: archivedJob.strategyId,
        question: archivedJob.question,
        policyFingerprint: archivedJob.policyFingerprint,
        taskFingerprint: archivedJob.taskFingerprint,
      },
    });
    expect(restoredJob.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      status: candidate.status,
      benchmarkRunId: candidate.benchmarkRunId,
      outputHash: candidate.outputHash,
      summary: candidate.summary,
      unknowns: candidate.unknowns,
      errorCode: candidate.errorCode,
      startedAt: candidate.startedAt,
      finishedAt: candidate.finishedAt,
      privacyClass: candidate.privacyClass,
    }))).toEqual(archivedJob.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      status: candidate.status,
      benchmarkRunId: candidate.benchmarkRunId,
      outputHash: candidate.outputHash,
      summary: candidate.summary,
      unknowns: candidate.unknowns,
      errorCode: candidate.errorCode,
      startedAt: candidate.startedAt,
      finishedAt: candidate.finishedAt,
      privacyClass: candidate.privacyClass,
    })));

    const replay = await row.portable.apply(
      archive,
      {
        confirmationToken: preview.apply.confirmationToken as string,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
        collisionPolicy: "remap_deterministic",
        identityMap,
      },
      ACTOR,
      false,
    );
    expect(replay.status).toBe("idempotent_replay");
    expect(replay.investigationId).toBe(applied.investigationId);
    const listed = (await row.cases.listCases(ACTOR, true)).filter(
      (item) => item.title === "Synthetic queue stall",
    );
    expect(listed).toHaveLength(2);
  });

  it("rejects resealed nonterminal history and blocks legacy incomplete candidate state", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const validPreview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );

    for (const status of ["queued", "running"] as const) {
      const nonterminal = structuredClone(archive);
      const job = nonterminal.investigation.triageJobs[0];
      if (!job) throw new Error("portable triage job is missing");
      (job as unknown as { status: string }).status = status;
      await expect(row.portable.preflight(
        nonterminal,
        { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
        ACTOR,
        false,
      )).rejects.toMatchObject({ code: "archive_invalid" });
      await expect(row.portable.apply(
        nonterminal,
        applyInput(validPreview.apply.confirmationToken as string, identityMap),
        ACTOR,
        false,
      )).rejects.toMatchObject({ code: "archive_invalid" });
    }

    const legacyIncomplete = resealArchive(archive, (investigation) => {
      const candidate = investigation.triageJobs[0]?.candidates[0];
      if (!candidate) throw new Error("portable triage candidate is missing");
      delete candidate.status;
    });
    const legacyPreview = await row.portable.preflight(
      legacyIncomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    expect(legacyPreview.report.exactReconstruction).toBe(false);
    expect(legacyPreview.apply.confirmationToken).toBeNull();
    expect(legacyPreview.report.reconstructionReasons).toContainEqual(
      expect.objectContaining({
        path: "$.investigation.triageJobs[0].candidates[0]",
        detail: "legacy triage candidate state cannot round-trip exactly",
      }),
    );
  });

  it("materializes detached supplied bytes and round-trips supported archive fields honestly", async () => {
    const row = await fixture();
    const original = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const detached = detachedArchiveFor(original, row.evidenceHash);
    const blob = join(row.root, "blobs", row.evidenceHash.slice(0, 2), row.evidenceHash);
    const meta = `${blob}.meta.json`;
    await rm(blob, { force: true });
    await rm(meta, { force: true });
    expect(await row.store.verify(row.evidenceHash)).toBe(false);
    const identityMap = identityMapFor(detached.archive);
    const preview = await row.portable.preflight(
      detached.archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap,
        suppliedBlobs: detached.suppliedBlobs,
      },
      ACTOR,
      false,
    );
    expect(preview.report.exactReconstruction).toBe(true);
    const applied = await row.portable.apply(
      detached.archive,
      applyInput(preview.apply.confirmationToken as string, identityMap, detached.suppliedBlobs),
      ACTOR,
      false,
    );
    expect(applied.status).toBe("applied");
    expect(await row.store.verify(row.evidenceHash)).toBe(true);
    expect(await row.store.get(row.evidenceHash)).toEqual(LOG_BYTES);

    const restored = await row.portable.exportArchive(applied.investigationId, ACTOR, false, true);
    expect(restored.investigation.investigation).toMatchObject({
      title: original.investigation.investigation.title,
      problemStatement: original.investigation.investigation.problemStatement,
      affectedParties: original.investigation.investigation.affectedParties,
      impact: original.investigation.investigation.impact,
      scope: original.investigation.investigation.scope,
      openQuestions: original.investigation.investigation.openQuestions,
      situationVersion: original.investigation.investigation.situationVersion,
      createdAt: original.investigation.investigation.createdAt,
    });
    const comparableContributions = (items: PortableArchiveV1["investigation"]["contributions"]) =>
      items
        .map((item) => ({
          kind: item.kind,
          body: item.body,
          createdAt: item.createdAt,
          authorId: item.authorId,
        }))
        .sort((left, right) => `${left.kind}:${left.body}`.localeCompare(`${right.kind}:${right.body}`));
    expect(comparableContributions(restored.investigation.contributions)).toEqual(
      comparableContributions(original.investigation.contributions),
    );
    expect(
      restored.investigation.contentObjects.find((item) => item.digest === row.evidenceHash)
        ?.payloadBase64,
    ).toBe(Buffer.from(LOG_BYTES).toString("base64"));
    expect(restored.investigation.timeline.map((item) => ({
      kind: item.kind,
      serverTime: item.serverTime,
    }))).toEqual(original.investigation.timeline.map((item) => ({
      kind: item.kind,
      serverTime: item.serverTime,
    })));
  });

  it("rolls back promoted evidence bytes when a later promotion boundary fails", async () => {
    const row = await fixture();
    const original = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const detached = detachedArchiveFor(original, row.evidenceHash);
    const blob = join(row.root, "blobs", row.evidenceHash.slice(0, 2), row.evidenceHash);
    await rm(blob, { force: true });
    await rm(`${blob}.meta.json`, { force: true });
    const identityMap = identityMapFor(detached.archive);
    const preview = await row.portable.preflight(
      detached.archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap,
        suppliedBlobs: detached.suppliedBlobs,
      },
      ACTOR,
      false,
    );
    const begin = row.store.beginWriteBatch?.bind(row.store);
    if (!begin) throw new Error("synthetic store must support evidence batches");
    row.store.beginWriteBatch = async (): Promise<EvidenceWriteBatch> => {
      const batch = await begin();
      return new Proxy(batch, {
        get(target, property, receiver) {
          if (property === "promote") {
            return async () => {
              await target.promote();
              throw new Error("synthetic post-promotion failure");
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const before = await row.caseStore.listCases();
    await expect(
      row.portable.apply(
        detached.archive,
        applyInput(preview.apply.confirmationToken as string, identityMap, detached.suppliedBlobs),
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "apply_refused" });
    expect(await row.store.verify(row.evidenceHash)).toBe(false);
    expect((await row.caseStore.listCases()).map((item) => item.id).sort()).toEqual(
      before.map((item) => item.id).sort(),
    );
    expect(await row.audit.list({ action: "portable_archive_apply" })).toEqual([]);
  });

  it("rejects duplicate, unrequested, and non-canonical supplied blobs", async () => {
    const row = await fixture();
    const original = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const detached = detachedArchiveFor(original, row.evidenceHash);
    const identityMap = identityMapFor(detached.archive);
    const preflight = (suppliedBlobs: typeof detached.suppliedBlobs) =>
      row.portable.preflight(
        detached.archive,
        {
          mode: "dry_run",
          collisionPolicy: "remap_deterministic",
          identityMap,
          suppliedBlobs,
        },
        ACTOR,
        false,
      );
    await expect(
      preflight([...detached.suppliedBlobs, ...detached.suppliedBlobs]),
    ).rejects.toMatchObject({ code: "archive_invalid" });
    await expect(
      preflight([
        {
          ...detached.suppliedBlobs[0],
          digest: "77".repeat(32),
        },
      ]),
    ).rejects.toMatchObject({ code: "archive_invalid" });
    await expect(
      preflight([
        {
          ...detached.suppliedBlobs[0],
          payloadBase64: `${detached.suppliedBlobs[0].payloadBase64}\n`,
        },
      ]),
    ).rejects.toMatchObject({ code: "archive_invalid" });
  });

  it("replays after service restart and scopes same-archive replay to the applying actor", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const first = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const restarted = new PortableInvestigationService({
      installationId: "inst-syntheticnorth",
      cases: row.cases,
      catalog: row.catalog,
      imports: row.imports,
      triageRuns: row.triageRuns,
      experiments: row.experiments,
      audit: row.audit,
      applyState: row.applyState,
      withTransaction: row.applyBoundary.withTransaction,
      applyCoordination: "single_instance",
      confirmationRestartDurable: false,
      now: () => "2042-03-04T12:00:00.000Z",
    });
    const replay = await restarted.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    expect(replay).toMatchObject({
      status: "idempotent_replay",
      investigationId: first.investigationId,
    });

    const other = { id: "actor-destination-west", username: "canonical-west" };
    const otherMap = archive.investigation.actors.map((source) =>
      source.sourceActorId === ACTOR.id
        ? {
            sourceActorId: source.sourceActorId,
            action: "map_existing" as const,
            destinationActorId: other.id,
          }
        : {
            sourceActorId: source.sourceActorId,
            action: "preserve_historical_external" as const,
            destinationActorId: null,
          },
    );
    const otherPreview = await restarted.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap: otherMap },
      other,
      true,
    );
    const otherApplied = await restarted.apply(
      archive,
      applyInput(otherPreview.apply.confirmationToken as string, otherMap),
      other,
      true,
    );
    expect(otherApplied.status).toBe("applied");
    expect(otherApplied.investigationId).not.toBe(first.investigationId);
    const historicalMappedUsername = "historical-canonical-west";
    const importedCase = await row.caseStore.getCase(otherApplied.investigationId);
    expect(importedCase?.createdBy).toBe(other.id);
    expect(importedCase?.createdByUsername).toBe(historicalMappedUsername);
    const revisions = await row.caseStore.listLatestRevisions(otherApplied.investigationId);
    expect(revisions.filter((item) => item.authorId === other.id).length).toBeGreaterThan(0);
    expect(revisions.filter((item) => item.authorId === other.id).every(
      (item) => item.authorUsername === historicalMappedUsername,
    )).toBe(true);
    const jobs = await row.triageRuns.list(otherApplied.investigationId, other, true);
    expect(jobs.every(
      (job) => job.requestedBy === other.id && job.requestedByUsername === historicalMappedUsername,
    )).toBe(true);
    const restoredExperiments = await row.experiments.list(otherApplied.investigationId, other, true);
    expect(restoredExperiments.flatMap((experiment) => experiment.decisions).every(
      (decision) => decision.authorUsername === historicalMappedUsername,
    )).toBe(true);
  });

  it("refuses metadata-only, unresolved identities, tamper, stale catalogs, and substituted maps before mutation", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const before = (await row.cases.listCases(ACTOR, true)).length;

    const unresolved = await row.portable.preflight(
      archive,
      {
        mode: "dry_run",
        collisionPolicy: "remap_deterministic",
        identityMap: identityMap.map((item) => ({
          ...item,
          action: "leave_unresolved" as const,
          destinationActorId: null,
        })),
      },
      ACTOR,
      false,
    );
    expect(unresolved.apply.confirmationToken).toBeNull();

    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const token = preview.apply.confirmationToken as string;

    const planted = JSON.parse(JSON.stringify(archive)) as PortableArchiveV1;
    planted.investigation.investigation.title = "PLANTED-ARCHIVE-CONTENT";
    await expect(
      row.portable.apply(
        planted,
        {
          confirmationToken: token,
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap,
        },
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "archive_invalid" });

    await expect(
      row.portable.apply(
        archive,
        {
          confirmationToken: token,
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap: identityMap.map((item) =>
            item.sourceActorId === ACTOR.id
              ? { ...item, action: "preserve_historical_external" as const, destinationActorId: null }
              : item,
          ),
        },
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "identity_map_mismatch" });

    await row.cases.createCase(
      ACTOR,
      { title: "Synthetic catalog mutation", severity: "low" },
      "fixture",
    );
    await expect(
      row.portable.apply(
        archive,
        {
          confirmationToken: token,
          typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
          collisionPolicy: "remap_deterministic",
          identityMap,
        },
        ACTOR,
        false,
      ),
    ).rejects.toMatchObject({ code: "stale_destination_catalog" });

    expect((await row.cases.listCases(ACTOR, true)).length).toBe(before + 1);
  });

  it("binds confirmation to the minting actor and lead authorization", async () => {
    const row = await fixture();
    const app = await appFor(row);
    try {
      const lead = await login(app, "operator-north", "fixture-operator-secret");
      const otherLead = await login(app, "reviewer-west", "fixture-reviewer-secret");
      const viewer = await login(app, "viewer-west", "fixture-viewer-secret");
      const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
      const identityMap = identityMapFor(archive);
      const preview = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/preflight",
        headers: { cookie: lead },
        payload: { archive, mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      });
      const token = (JSON.parse(preview.body) as { apply: { confirmationToken: string } }).apply
        .confirmationToken;
      const body = {
        schemaId: PORTABLE_APPLY_REQUEST_SCHEMA_ID,
        confirmationToken: token,
        typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
        collisionPolicy: "remap_deterministic",
        identityMap,
        archive,
      };
      const denied = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/apply",
        headers: { cookie: viewer },
        payload: body,
      });
      expect(denied.statusCode).toBe(403);
      const mismatched = await app.inject({
        method: "POST",
        url: "/api/portable-investigations/apply",
        headers: { cookie: otherLead },
        payload: body,
      });
      expect(mismatched.statusCode).toBe(409);
      expect(JSON.parse(mismatched.body)).toEqual({ error: "actor_mismatch" });
    } finally {
      await app.close();
    }
  });

  it("rolls back memory stores when a later write fails and isolates snapshots", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const before = await row.caseStore.listCases();
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive,
          report: preview.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            archive.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [item.digest, new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64"))]),
          ),
          ports: {
            ...ports,
            cases: new Proxy(ports.cases, {
              get(target, property, receiver) {
                if (property === "insertSnapshot") {
                  return async () => {
                    throw new Error("synthetic snapshot write failure");
                  };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          },
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/synthetic snapshot write failure/);
    expect((await row.caseStore.listCases()).map((item) => item.id).sort()).toEqual(
      before.map((item) => item.id).sort(),
    );

    const isolated = row.caseStore.capture();
    await row.caseStore.insertCase({
      ...before[0],
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "must-not-leak-into-snapshot",
    });
    row.caseStore.restore(isolated);
    expect(await row.caseStore.getCase("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeNull();
  });

  it("does not erase an unrelated memory write that races a failed apply transaction", async () => {
    const row = await fixture();
    const template = (await row.caseStore.listCases())[0];
    if (!template) throw new Error("synthetic case is missing");
    let entered!: () => void;
    let releaseFailure!: () => void;
    const transactionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const failNow = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const partialId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const unrelatedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const transaction = row.applyBoundary.withTransaction(async (ports) => {
      await ports.cases.insertCase({ ...template, id: partialId, title: "synthetic partial apply" });
      entered();
      await failNow;
      throw new Error("synthetic transaction failure");
    });
    await transactionEntered;
    const unrelatedWrite = row.caseStore.insertCase({
      ...template,
      id: unrelatedId,
      title: "synthetic unrelated write",
    });
    releaseFailure();
    await expect(transaction).rejects.toThrow(/synthetic transaction failure/);
    await unrelatedWrite;
    expect(await row.caseStore.getCase(partialId)).toBeNull();
    expect((await row.caseStore.getCase(unrelatedId))?.title).toBe("synthetic unrelated write");
  });

  it("applies concurrently as one write plus an idempotent replay", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const input = {
      confirmationToken: preview.apply.confirmationToken as string,
      typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION_VALUE,
      collisionPolicy: "remap_deterministic" as const,
      identityMap,
    };
    const [first, second] = await Promise.all([
      row.portable.apply(archive, input, ACTOR, false),
      row.portable.apply(archive, input, ACTOR, false),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["applied", "idempotent_replay"]);
    expect(first.investigationId).toBe(second.investigationId);
  });

  it("fails closed when PostgreSQL apply lacks cross-process evidence coordination", async () => {
    const row = await fixture();
    await expect(
      withPgApplyTransaction(
        {
          query: async () => {
            throw new Error("database must not be reached");
          },
        },
        row.store,
        async () => undefined,
      ),
    ).rejects.toThrow(/externally coordinated evidence writes/);
  });
});

describe.skipIf(!adminUrl())("portable investigation apply postgres rollback", () => {
  it("rolls back a partial PostgreSQL apply", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const cases = new PgCaseStore(client);
      const pgEvidence = new FilesystemEvidenceStore({
        rootDir: row.root,
        acquireWriteLease: async () => () => undefined,
      });
      await expect(
        withPgApplyTransaction(client, pgEvidence, async (ports) =>
          persistPortableArchive({
            archive,
            report: preview.report,
            identityMap,
            actor: ACTOR,
            destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
            contentBytes: new Map(
              archive.investigation.contentObjects
                .filter((item) => item.payloadBase64 !== null)
                .map((item) => [
                  item.digest,
                  new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
                ]),
            ),
            ports: {
              ...ports,
              audit: {
                append: async () => {
                  throw new Error("synthetic audit write failure");
                },
                list: async () => [],
              },
            },
            now: "2042-03-04T12:00:00.000Z",
          }),
        ),
      ).rejects.toThrow(/synthetic audit write failure/);
      expect(await cases.listCases()).toEqual([]);
    });
  });

  it("preserves committed metadata and evidence when the COMMIT response is interrupted", async () => {
    const row = await fixture();
    const bytes = new TextEncoder().encode("synthetic committed evidence bytes");
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const pgEvidence = new FilesystemEvidenceStore({
        rootDir: row.root,
        acquireWriteLease: async () => () => undefined,
      });
      const commitFault = {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          if (text === "COMMIT") throw new Error("synthetic interrupted COMMIT response");
          return result;
        },
      };
      await expect(
        withPgApplyTransaction(commitFault, pgEvidence, async (ports) => {
          await ports.cases.insertCase({
            id,
            title: "Synthetic committed outcome",
            problemStatement: "",
            affectedParties: "",
            impact: "",
            scope: "",
            openQuestions: [],
            situationVersion: 0,
            severity: "low",
            status: "open",
            legalHold: false,
            retentionClass: "standard",
            createdAt: "2042-03-04T12:00:00.000Z",
            createdBy: ACTOR.id,
            createdByUsername: ACTOR.username,
            participants: [{ identityId: ACTOR.id, username: ACTOR.username }],
          });
          return ports.evidence.put(bytes, { contentType: "text/plain" });
        }),
      ).rejects.toBeInstanceOf(PortableCommitOutcomeUnknownError);
      expect(await new PgCaseStore(client).getCase(id)).not.toBeNull();
      expect(await row.store.verify(sha256Hex(bytes))).toBe(true);
    });
  });
});
