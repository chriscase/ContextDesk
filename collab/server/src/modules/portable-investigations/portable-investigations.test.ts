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
  formatCompactInvestigationLocator,
  formatInvestigationResourceLocator,
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
import { InvestigationActivityService } from "../activity/index.js";
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
import { ImportService, MemoryRunStore, PgRunStore } from "../import/index.js";
import { MemoryTriageJobStore, TriageRunService } from "../triage-runs/index.js";
import { loadPortableInstallationId } from "./installation.js";
import {
  memoryApplyBoundary,
  MemoryPortableApplyStateStore,
  persistPortableArchive,
  PortableCommitOutcomeUnknownError,
  remapPortableTimelineTarget,
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

function injectCorroborationEvent(
  archive: PortableArchiveV1,
  target: { targetId: string | null; targetNamespace: string | null },
): PortableArchiveV1 {
  return resealArchive(archive, (investigation) => {
    const imported = investigation.timeline.find((row) => row.kind === "external_run_imported");
    if (!imported) throw new Error("imported-run timeline is missing");
    investigation.timeline.push({
      seq: Math.max(...investigation.timeline.map((row) => row.seq)) + 1,
      kind: "run_corroboration",
      actorId: imported.actorId,
      targetId: target.targetId,
      targetNamespace: target.targetNamespace,
      serverTime: imported.serverTime,
      objectHash: "",
    });
  });
}

function archiveContentBytes(archive: PortableArchiveV1) {
  return new Map(
    archive.investigation.contentObjects
      .filter((item) => item.payloadBase64 !== null)
      .map((item) => [
        item.digest,
        new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
      ]),
  );
}

async function persistFixtureArchive(row: Fixture, archive: PortableArchiveV1) {
  const identityMap = identityMapFor(archive);
  const dryRun = await row.portable.preflight(
    archive,
    { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
    ACTOR,
    false,
  );
  return row.applyBoundary.withTransaction((ports) =>
    persistPortableArchive({
      archive,
      report: dryRun.report,
      identityMap,
      actor: ACTOR,
      destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
      contentBytes: archiveContentBytes(archive),
      ports,
      now: "2042-03-04T12:00:00.000Z",
    }),
  );
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
    const exportedIntake = archive.investigation.timeline.find(
      (event) => event.kind === "corpus_intake_committed",
    );
    expect(exportedIntake?.targetNamespace).toBe("intake_batch");
    expect(exportedIntake?.targetId).toBe(committed.id);

    const identityMap = identityMapFor(archive);
    const dryRun = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    expect(dryRun.report.exactReconstruction).toBe(true);
    expect(dryRun.report.idRemap.some((row) =>
      row.namespace === "intake_batch" && row.sourceId === committed.id,
    )).toBe(true);
    expect(
      dryRun.report.idRemap.find((row) =>
        row.namespace === "intake_batch" && row.sourceId === committed.id,
      )?.destinationId,
    ).not.toBe(committed.id);
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
    const restoredTimeline = await row.cases.listTimeline(applied.investigationId);
    const restoredIntake = restoredTimeline.find((event) => event.kind === "corpus_intake_committed");
    expect(restoredIntake?.targetId).toBe(restoredEvidence?.intakeBatchId);
    expect(restoredIntake?.targetId).not.toBe(committed.id);
    expect(restoredIntake?.targetId).not.toBeNull();
  });

  it("refuses apply when corpus intake timeline lacks an intake-batch target", async () => {
    const row = await fixture();
    const bytes = new TextEncoder().encode(
      "2042-03-04T11:30:00Z synthetic-router ERROR request timed out\n",
    );
    const seed = {
      origin: "files" as const,
      sourceLabel: "Synthetic incomplete intake",
      privacyClass: "share_safe" as const,
      idempotencyKey: "batch-synthetic-incomplete-1",
      files: [{
        relativePath: "router/incomplete.log",
        mediaType: "text/plain",
        contentBase64: Buffer.from(bytes).toString("base64"),
      }],
      archiveBase64: null,
    };
    const preview = await row.cases.previewCorpusIntake(row.caseId, ACTOR, {
      schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
      ...seed,
    });
    await row.cases.commitCorpusIntake(
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
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "corpus_intake_committed");
      if (!event) throw new Error("corpus intake timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/intake-batch target/);
  });

  it("refuses apply when experiment gold timeline lacks a gold target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "experiment_gold_promoted");
      if (!event) throw new Error("experiment gold timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable gold target/);
  });

  it("refuses apply when experiment decision timeline lacks a decision target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind.startsWith("experiment_decision_"));
      if (!event) throw new Error("experiment decision timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable decision target/);
  });

  it("refuses apply when workstream attempt timeline lacks a composite job+candidate target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const missing = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind.startsWith("triage_candidate_"));
      if (!event) throw new Error("workstream attempt timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(missing);
    const dryRun = await row.portable.preflight(
      missing,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: missing,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            missing.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable job target/);

    const bareJob = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind.startsWith("triage_candidate_"));
      if (!event) throw new Error("workstream attempt timeline is missing");
      event.targetNamespace = "triage_job";
      event.targetId = investigation.triageJobs[0]!.id;
    });
    const bareMap = identityMapFor(bareJob);
    const bareDry = await row.portable.preflight(
      bareJob,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap: bareMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: bareJob,
          report: bareDry.report,
          identityMap: bareMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            bareJob.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable job target/);
  });

  it("refuses apply when snapshot timeline lacks a snapshot target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "snapshot_frozen");
      if (!event) throw new Error("snapshot timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable snapshot target/);
  });

  it("refuses apply when imported-run timeline lacks an imported-run target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "external_run_imported");
      if (!event) throw new Error("imported-run timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable imported-run target/);
  });

  it("refuses apply when contribution timeline lacks a contribution target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "contribution_created");
      if (!event) throw new Error("contribution timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable contribution target/);
  });

  it("refuses apply when evidence timeline lacks an evidence target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "evidence_registered");
      if (!event) throw new Error("evidence timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable evidence target/);
  });

  it("refuses apply when workstream job timeline lacks a job target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const missing = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind.startsWith("triage_job_"));
      if (!event) throw new Error("workstream job timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(missing);
    const dryRun = await row.portable.preflight(
      missing,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: missing,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            missing.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/workstream job timeline/);

    const job = archive.investigation.triageJobs[0];
    const candidateId = job?.candidates[0]?.candidateId;
    if (!job || !candidateId) throw new Error("portable triage job is missing");
    const collapsed = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind.startsWith("triage_job_"));
      if (!event) throw new Error("workstream job timeline is missing");
      event.targetNamespace = "triage_job";
      event.targetId = `${job.id}:${candidateId}`;
    });
    const collapsedMap = identityMapFor(collapsed);
    const collapsedDry = await row.portable.preflight(
      collapsed,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap: collapsedMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: collapsed,
          report: collapsedDry.report,
          identityMap: collapsedMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            collapsed.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/workstream job timeline/);
  });

  it("refuses apply when corroboration timeline is present even without an imported-run target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = injectCorroborationEvent(archive, {
      targetId: null,
      targetNamespace: null,
    });
    await expect(persistFixtureArchive(row, incomplete)).rejects.toThrow(
      /imported-run corroboration is not exact-applyable/,
    );
  });

  it("refuses to export imported-run corroboration as exact-applyable", async () => {
    const row = await fixture();
    const timeline = await row.cases.listTimeline(row.caseId);
    const imported = timeline.find((event) => event.kind === "external_run_imported");
    if (!imported?.targetId) throw new Error("imported-run timeline is missing");
    await row.imports.corroborate(
      row.caseId,
      imported.targetId,
      ACTOR,
      { state: "corroborated", links: [{ kind: "artifact", id: row.evidenceId }] },
      "fixture",
      false,
    );
    const sourceRuns = await row.imports.listRuns(row.caseId, ACTOR, false);
    expect(sourceRuns.map((run) => run.corroborationState)).toEqual(["corroborated"]);
    await expect(row.portable.exportArchive(row.caseId, ACTOR, false, true)).rejects.toMatchObject({
      code: "unsupported_state",
      message: expect.stringMatching(/imported-run corroboration is not exact-applyable/),
    });
  });

  it("refuses dry-run and apply of remapped imported-run corroboration timeline", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const imported = archive.investigation.timeline.find((event) => event.kind === "external_run_imported");
    if (!imported?.targetId) throw new Error("imported-run timeline is missing");
    const injected = injectCorroborationEvent(archive, {
      targetId: imported.targetId,
      targetNamespace: "imported_ai_run",
    });
    const identityMap = identityMapFor(injected);
    const dryRun = await row.portable.preflight(
      injected,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    expect(dryRun.report.exactReconstruction).toBe(false);
    expect(dryRun.report.reconstructionStatus).toBe("blocked");
    expect(dryRun.report.reconstructionReasons).toContainEqual(
      expect.objectContaining({
        path: "$.investigation.timeline",
        detail: expect.stringMatching(/imported-run corroboration is not exact-applyable/),
      }),
    );
    expect(dryRun.apply.confirmationToken).toBeNull();
    await expect(persistFixtureArchive(row, injected)).rejects.toThrow(
      /imported-run corroboration is not exact-applyable/,
    );
  });

  it("refuses apply when experiment helpfulness timeline lacks a helpfulness target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "experiment_helpfulness_recorded");
      if (!event) throw new Error("experiment helpfulness timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable helpfulness target/);
  });

  it("refuses apply when experiment trace timeline lacks a composite experiment+trace target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const missing = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "experiment_trace_imported");
      if (!event) throw new Error("experiment trace timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(missing);
    const dryRun = await row.portable.preflight(
      missing,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: missing,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            missing.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/experiment\+trace target/);

    const bareExperiment = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "experiment_trace_imported");
      if (!event) throw new Error("experiment trace timeline is missing");
      event.targetNamespace = "experiment";
      event.targetId = investigation.experiments[0]!.id;
    });
    const bareMap = identityMapFor(bareExperiment);
    const bareDry = await row.portable.preflight(
      bareExperiment,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap: bareMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: bareExperiment,
          report: bareDry.report,
          identityMap: bareMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            bareExperiment.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/experiment\+trace target/);
  });

  it("refuses apply when experiment import timeline lacks an experiment target", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const incomplete = resealArchive(archive, (investigation) => {
      const event = investigation.timeline.find((row) => row.kind === "experiment_imported");
      if (!event) throw new Error("experiment import timeline is missing");
      event.targetId = null;
      event.targetNamespace = null;
    });
    const identityMap = identityMapFor(incomplete);
    const dryRun = await row.portable.preflight(
      incomplete,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await expect(
      row.applyBoundary.withTransaction((ports) =>
        persistPortableArchive({
          archive: incomplete,
          report: dryRun.report,
          identityMap,
          actor: ACTOR,
          destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
          contentBytes: new Map(
            incomplete.investigation.contentObjects
              .filter((item) => item.payloadBase64 !== null)
              .map((item) => [
                item.digest,
                new Uint8Array(Buffer.from(item.payloadBase64 as string, "base64")),
              ]),
          ),
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/portable experiment target/);
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
    expect(response.unsupported).toContain("imported_run_corroboration");
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
  it("remaps portable experiment trace targets by experiment id and preserves the trace suffix", () => {
    const source = "11111111-1111-4111-8111-111111111111";
    const dest = "22222222-2222-4222-8222-222222222222";
    const report = {
      idRemap: [{ namespace: "experiment", sourceId: source, destinationId: dest }],
    } as Parameters<typeof remapPortableTimelineTarget>[0];
    expect(remapPortableTimelineTarget(report, "experiment", `${source}:trace-chat-operator-v1`)).toBe(
      `${dest}:trace-chat-operator-v1`,
    );
    expect(remapPortableTimelineTarget(report, "experiment", source)).toBe(dest);
  });

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

  it("preserves proposed vs accepted decision revisions after portable restore", async () => {
    const row = await fixture();
    const comments = (await row.cases.listContributions(row.caseId, ACTOR, false))
      .filter((item) => item.kind === "message");
    const comment = comments[0];
    if (!comment) throw new Error("fixture discussion comment is missing");
    await row.cases.reviseContribution(
      row.caseId,
      comment.id,
      ACTOR,
      "Please verify the synthetic worker trace after the timeout.",
      "fixture",
      comment.revision,
    );
    const activity = new InvestigationActivityService({
      cases: row.cases,
      installationId: "inst-syntheticnorth",
    });
    const sourcePage = await activity.listPage({ actor: ACTOR, isAdmin: false, caseId: row.caseId });
    const sourceProposed = sourcePage.items.find((item) => item.activityKind === "decision_proposed");
    const sourceAccepted = sourcePage.items.find((item) =>
      item.activityKind === "decision_accepted" && item.locator.kind === "decision_revision",
    );
    const sourceRevised = sourcePage.items.find((item) => item.summary === "revised a discussion comment");
    expect(sourceProposed?.locator.revision).toBe(1);
    expect(sourceAccepted?.locator.revision).toBe(2);
    expect(sourceRevised?.locator.kind).toBe("discussion_message");
    expect(sourceRevised?.locator.revision).toBe(comment.revision + 1);
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const destPage = await activity.listPage({
      actor: ACTOR,
      isAdmin: false,
      caseId: applied.investigationId,
    });
    const destProposed = destPage.items.find((item) => item.activityKind === "decision_proposed");
    const destAccepted = destPage.items.find((item) =>
      item.activityKind === "decision_accepted" && item.locator.kind === "decision_revision",
    );
    const destRevised = destPage.items.find((item) => item.summary === "revised a discussion comment");
    expect(destProposed?.locator.revision).toBe(1);
    expect(destAccepted?.locator.revision).toBe(2);
    expect(destRevised?.locator.kind).toBe("discussion_message");
    expect(destRevised?.locator.revision).toBe(comment.revision + 1);
    expect(destAccepted?.locator.resourceId).not.toBe(sourceAccepted?.locator.resourceId);
  });

  it("preserves hypothesis status revisions after portable restore", async () => {
    const row = await fixture();
    const hypothesis = await row.cases.addContribution(
      row.caseId,
      ACTOR,
      {
        kind: "hypothesis",
        body: "The synthetic stall is a bounded queue wait.",
        privacyClass: "share_safe",
      },
      "fixture",
    );
    const statused = await row.cases.setHypothesisStatus(
      row.caseId,
      hypothesis.id,
      ACTOR,
      "contradicted",
      [],
      "fixture",
    );
    expect(statused.revision).toBe(hypothesis.revision + 1);
    const activity = new InvestigationActivityService({
      cases: row.cases,
      installationId: "inst-syntheticnorth",
    });
    const sourcePage = await activity.listPage({ actor: ACTOR, isAdmin: false, caseId: row.caseId });
    const sourceUpdated = sourcePage.items.find((item) =>
      item.summary === "updated a working hypothesis" && item.locator.resourceId === hypothesis.id,
    );
    expect(sourceUpdated?.locator.kind).toBe("hypothesis");
    expect(sourceUpdated?.locator.revision).toBe(statused.revision);
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const destPage = await activity.listPage({
      actor: ACTOR,
      isAdmin: false,
      caseId: applied.investigationId,
    });
    const destUpdated = destPage.items.find((item) => item.summary === "updated a working hypothesis");
    const destHypotheses = (await row.cases.listContributions(applied.investigationId, ACTOR, false))
      .filter((item) => item.kind === "hypothesis");
    expect(destHypotheses).toHaveLength(1);
    expect(destHypotheses[0]?.hypothesisStatus).toBe("contradicted");
    expect(destHypotheses[0]?.revision).toBe(statused.revision);
    expect(destUpdated?.locator.kind).toBe("hypothesis");
    expect(destUpdated?.locator.revision).toBe(statused.revision);
    expect(destUpdated?.locator.resourceId).not.toBe(hypothesis.id);
  });

  it("preserves remapped hypothesis links after portable restore", async () => {
    const row = await fixture();
    const hypothesis = await row.cases.addContribution(
      row.caseId,
      ACTOR,
      {
        kind: "hypothesis",
        body: "The synthetic stall is corroborated by the worker log.",
        privacyClass: "share_safe",
        hypothesisStatus: "supported",
        hypothesisLinks: [{ kind: "artifact", id: row.evidenceId }],
      },
      "fixture",
    );
    expect(hypothesis.hypothesisLinks).toEqual([{ kind: "artifact", id: row.evidenceId }]);
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const destHypotheses = (await row.cases.listContributions(applied.investigationId, ACTOR, false))
      .filter((item) => item.kind === "hypothesis");
    const destEvidence = await row.cases.listArtifacts(applied.investigationId, ACTOR, false);
    expect(destHypotheses).toHaveLength(1);
    expect(destHypotheses[0]?.hypothesisStatus).toBe("supported");
    expect(destEvidence.some((item) => item.id === row.evidenceId)).toBe(false);
    expect(destHypotheses[0]?.hypothesisLinks).toEqual([
      { kind: "artifact", id: destEvidence.find((item) => item.contentHash === row.evidenceHash)?.id },
    ]);
  });

  it("binds each restored imported run to its own remapped external-run contribution", async () => {
    const row = await fixture();
    const first = (await row.imports.listRuns(row.caseId, ACTOR, true))[0];
    if (!first) throw new Error("fixture imported run is missing");
    await row.imports.importRun(
      row.caseId,
      ACTOR,
      {
        outputText: "A second synthetic stall follows a distinct worker timeout.",
        promptText: "Inspect the second synthetic queue evidence.",
        sourceId: first.sourceId,
        operatorId: ACTOR.id,
        operatorUsername: ACTOR.username,
        promptCompleteness: "exact",
        outputCompleteness: "exact",
        workflowCompleteness: "partial",
        evidenceVisibility: "complete",
        privacyClass: "owner_only",
      },
      "fixture",
      false,
    );
    const sourceRuns = await row.imports.listRuns(row.caseId, ACTOR, true);
    const sourceExternal = (await row.cases.listContributions(row.caseId, ACTOR, true))
      .filter((item) => item.kind === "external_run");
    expect(sourceRuns).toHaveLength(2);
    expect(new Set(sourceRuns.map((run) => run.contributionId)).size).toBe(2);
    expect(sourceExternal.map((item) => item.id).sort()).toEqual(
      sourceRuns.map((run) => run.contributionId).sort(),
    );
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const destRuns = await row.imports.listRuns(applied.investigationId, ACTOR, true);
    const destExternal = (await row.cases.listContributions(applied.investigationId, ACTOR, true))
      .filter((item) => item.kind === "external_run");
    expect(destRuns).toHaveLength(2);
    expect(new Set(destRuns.map((run) => run.contributionId)).size).toBe(2);
    expect(destExternal.map((item) => item.id).sort()).toEqual(
      destRuns.map((run) => run.contributionId).sort(),
    );
    expect(destRuns.some((run) => sourceRuns.some((source) => source.contributionId === run.contributionId)))
      .toBe(false);
  });

  it("preserves remapped hypothesis-status timeline links after portable restore", async () => {
    const row = await fixture();
    const hypothesis = await row.cases.addContribution(
      row.caseId,
      ACTOR,
      {
        kind: "hypothesis",
        body: "The synthetic stall is corroborated by the worker log.",
        privacyClass: "share_safe",
      },
      "fixture",
    );
    await row.cases.setHypothesisStatus(
      row.caseId,
      hypothesis.id,
      ACTOR,
      "supported",
      [{ kind: "artifact", id: row.evidenceId }],
      "fixture",
    );
    const sourceEvent = (await row.cases.listTimeline(row.caseId))
      .find((event) => event.kind === "hypothesis_status");
    expect(JSON.parse(sourceEvent?.payload ?? "{}").links).toEqual([
      { kind: "artifact", id: row.evidenceId },
    ]);
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    const destEvidence = await row.cases.listArtifacts(applied.investigationId, ACTOR, false);
    const destEvent = (await row.cases.listTimeline(applied.investigationId))
      .find((event) => event.kind === "hypothesis_status");
    expect(JSON.parse(destEvent?.payload ?? "{}").links).toEqual([
      { kind: "artifact", id: destEvidence.find((item) => item.contentHash === row.evidenceHash)?.id },
    ]);
  });

  it("reauthorizes remapped locators after portable restore and hides kind-confused ids", async () => {
    const row = await fixture();
    const activity = new InvestigationActivityService({
      cases: row.cases,
      installationId: "inst-syntheticnorth",
    });
    const sourcePage = await activity.listPage({ actor: ACTOR, isAdmin: false, caseId: row.caseId });
    const sourceObservation = sourcePage.items.find((item) => item.activityKind === "observation_recorded");
    const sourceDiscussion = sourcePage.items.find((item) => item.activityKind === "comment_added");
    const sourceEvidence = sourcePage.items.find((item) => item.activityKind === "evidence_added");
    const sourceFrozen = sourcePage.items.find((item) => item.activityKind === "evidence_frozen");
    const sourceImported = sourcePage.items.find((item) => item.summary === "imported analysis was recorded");
    const sourceDecision = sourcePage.items.find((item) => item.activityKind === "decision_proposed");
    const sourceGold = sourcePage.items.find((item) => item.summary === "recorded an accepted outcome benchmark");
    const sourceHelpfulness = sourcePage.items.find((item) => item.summary === "recorded a comparison observation");
    const sourceExperiment = sourcePage.items.find((item) => item.summary === "recorded a strategy comparison");
    const sourceTraces = sourcePage.items.filter((item) => item.summary === "imported a comparison trace");
    const sourceTrace = sourceTraces[0];
    const sourceAttempt = sourcePage.items.find((item) => item.locator.kind === "workstream_attempt");
    const intakeBytes = new TextEncoder().encode(
      "2042-03-04T11:31:00Z synthetic-router ERROR request timed out\n",
    );
    const intakeSeed = {
      origin: "files" as const,
      sourceLabel: "Synthetic locator intake",
      privacyClass: "share_safe" as const,
      idempotencyKey: "batch-synthetic-locator-1",
      files: [{
        relativePath: "router/locator.log",
        mediaType: "text/plain",
        contentBase64: Buffer.from(intakeBytes).toString("base64"),
      }],
      archiveBase64: null,
    };
    const intakePreview = await row.cases.previewCorpusIntake(row.caseId, ACTOR, {
      schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
      ...intakeSeed,
    });
    const intakeCommitted = await row.cases.commitCorpusIntake(
      row.caseId,
      ACTOR,
      {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        ...intakeSeed,
        previewToken: intakePreview.previewToken,
      },
      "fixture",
    );
    const sourceIntakePage = await activity.listPage({ actor: ACTOR, isAdmin: false, caseId: row.caseId });
    const sourceIntake = sourceIntakePage.items.find((item) => item.summary === "committed a log intake batch");
    expect(sourceIntake?.locator.kind).toBe("intake_batch");
    expect(sourceIntake?.locator.resourceId).toBe(intakeCommitted.id);
    expect(sourceIntake?.resolvedRoute).toContain("section=corpus-intake");
    expect(sourceIntake?.resolvedRoute).toContain("kind=intake-batch");
    expect(sourceIntake?.humanFinding).toBe(false);
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceIntake!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Intake batch" });
    const confusedIntake = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
      installationId: "inst-syntheticnorth",
      investigationId: row.caseId,
      kind: "evidence_item",
      resourceId: intakeCommitted.id,
    }));
    await expect(activity.resolve(ACTOR, false, confusedIntake)).rejects.toMatchObject({ code: "not_found" });
    expect(sourceObservation?.locator.resourceId).toBeTruthy();
    expect(sourceDiscussion?.locator.resourceId).toBeTruthy();
    expect(sourceEvidence?.locator.resourceId).toBe(row.evidenceId);
    expect(sourceFrozen?.locator.resourceId).toBeTruthy();
    expect(sourceFrozen?.locator.kind).toBe("evidence_context");
    expect(sourceFrozen?.resolvedRoute).toContain("section=triage-evidence-board");
    expect(sourceFrozen?.resolvedRoute).toContain("kind=snapshot");
    expect(sourceImported?.locator.kind).toBe("imported_ai_run");
    expect(sourceImported?.locator.resourceId).toBeTruthy();
    expect(sourceImported?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceImported?.locator.resourceId).not.toBe(sourceFrozen?.locator.resourceId);
    expect(sourceImported?.humanFinding).toBe(false);
    expect(sourceImported?.resolvedRoute).toContain("section=triage-capture");
    expect(sourceImported?.resolvedRoute).toContain("kind=imported-run");
    expect(sourceImported?.resolvedRoute).toContain(`item=${sourceImported?.locator.resourceId}`);
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceImported!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Imported analysis" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: row.caseId,
          kind: "evidence_context",
          resourceId: sourceImported!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(sourceDecision?.locator.kind).toBe("decision_revision");
    expect(sourceDecision?.locator.resourceId).toBeTruthy();
    expect(sourceDecision?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceGold?.locator.kind).toBe("gold");
    expect(sourceGold?.locator.resourceId).toBeTruthy();
    expect(sourceGold?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceGold?.humanFinding).toBe(true);
    expect(sourceHelpfulness?.locator.kind).toBe("helpfulness");
    expect(sourceHelpfulness?.locator.resourceId).toBeTruthy();
    expect(sourceHelpfulness?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceHelpfulness?.humanFinding).toBe(false);
    expect(sourceExperiment?.locator.kind).toBe("experiment");
    expect(sourceExperiment?.locator.resourceId).toBeTruthy();
    expect(sourceExperiment?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceExperiment?.humanFinding).toBe(false);
    expect(sourceTraces.length).toBeGreaterThan(1);
    expect(sourceTrace?.locator.kind).toBe("interaction_trace");
    expect(sourceTrace?.locator.resourceId).toContain(":");
    expect(sourceTrace?.locator.resourceId).not.toBe(row.caseId);
    expect(sourceTrace?.humanFinding).toBe(false);
    expect(new Set(sourceTraces.map((item) => item.locator.resourceId)).size).toBe(sourceTraces.length);
    expect(sourceAttempt?.locator.resourceId).toContain(":");
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceObservation!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Observation" });
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceGold!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Outcome benchmark" });
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceHelpfulness!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Comparison observation" });
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceTrace!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Imported comparison trace" });
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceExperiment!.locator)),
    ).resolves.toMatchObject({ authorized: true, resourceLabel: "Strategy comparison" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: row.caseId,
          kind: "comparison_finding",
          resourceId: sourceHelpfulness!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: row.caseId,
          kind: "decision_revision",
          resourceId: sourceGold!.locator.resourceId,
          revision: sourceGold!.locator.revision ?? 0,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const decisionIds = archive.investigation.decisions.map((decision) => decision.id);
    const goldIds = archive.investigation.gold.map((gold) => gold.goldId);
    const helpfulnessIds = archive.investigation.helpfulnessObservations.map((row) => row.id);
    const jobIds = archive.investigation.triageJobs.map((job) => job.id);
    const exportedDecisions = archive.investigation.timeline.filter((event) =>
      event.kind.startsWith("experiment_decision_"),
    );
    expect(exportedDecisions.length).toBeGreaterThan(0);
    for (const event of exportedDecisions) {
      expect(event.targetNamespace).toBe("decision");
      expect(decisionIds).toContain(event.targetId);
    }
    const exportedGold = archive.investigation.timeline.filter(
      (event) => event.kind === "experiment_gold_promoted",
    );
    expect(exportedGold.length).toBeGreaterThan(0);
    for (const event of exportedGold) {
      expect(event.targetNamespace).toBe("gold");
      expect(goldIds).toContain(event.targetId);
      expect(decisionIds).not.toContain(event.targetId);
    }
    const exportedHelpfulness = archive.investigation.timeline.filter(
      (event) => event.kind === "experiment_helpfulness_recorded",
    );
    expect(exportedHelpfulness.length).toBeGreaterThan(0);
    for (const event of exportedHelpfulness) {
      expect(event.targetNamespace).toBe("helpfulness");
      expect(helpfulnessIds).toContain(event.targetId);
      expect(decisionIds).not.toContain(event.targetId);
      expect(goldIds).not.toContain(event.targetId);
    }
    const experimentIds = archive.investigation.experiments.map((experiment) => experiment.id);
    const exportedTraces = archive.investigation.timeline.filter(
      (event) => event.kind === "experiment_trace_imported",
    );
    expect(exportedTraces.length).toBeGreaterThan(1);
    for (const event of exportedTraces) {
      expect(event.targetNamespace).toBe("experiment");
      expect(event.targetId).toMatch(/:/);
      const experimentId = event.targetId?.slice(0, event.targetId.indexOf(":"));
      expect(experimentIds).toContain(experimentId);
      expect(event.targetId).not.toBe(experimentId);
      expect(goldIds).not.toContain(event.targetId);
      expect(helpfulnessIds).not.toContain(event.targetId);
    }
    expect(new Set(exportedTraces.map((event) => event.targetId)).size).toBe(exportedTraces.length);
    const exportedAttempts = archive.investigation.timeline.filter((event) =>
      event.kind.startsWith("triage_candidate_"),
    );
    expect(exportedAttempts.length).toBeGreaterThan(0);
    for (const event of exportedAttempts) {
      expect(event.targetNamespace).toBe("triage_job");
      expect(event.targetId).toMatch(/:/);
      expect(jobIds).toContain(event.targetId?.slice(0, event.targetId.indexOf(":")));
    }
    const exportedIntakeEvents = archive.investigation.timeline.filter(
      (event) => event.kind === "corpus_intake_committed",
    );
    expect(exportedIntakeEvents.length).toBeGreaterThan(0);
    for (const event of exportedIntakeEvents) {
      expect(event.targetNamespace).toBe("intake_batch");
      expect(event.targetId).toBe(intakeCommitted.id);
    }

    const identityMap = identityMapFor(archive);
    const preview = await row.portable.preflight(
      archive,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    const applied = await row.portable.apply(
      archive,
      applyInput(preview.apply.confirmationToken as string, identityMap),
      ACTOR,
      false,
    );
    expect(applied.investigationId).not.toBe(row.caseId);

    const destPage = await activity.listPage({
      actor: ACTOR,
      isAdmin: false,
      caseId: applied.investigationId,
    });
    const destReload = await activity.listPage({
      actor: ACTOR,
      isAdmin: false,
      caseId: applied.investigationId,
    });
    expect(activity.canonicalPageBytes(destPage)).toBe(activity.canonicalPageBytes(destReload));

    const destObservation = destPage.items.find((item) => item.activityKind === "observation_recorded");
    const destDiscussion = destPage.items.find((item) => item.activityKind === "comment_added");
    const destEvidence = destPage.items.find((item) => item.activityKind === "evidence_added");
    const destFrozen = destPage.items.find((item) => item.activityKind === "evidence_frozen");
    const destImported = destPage.items.find((item) => item.summary === "imported analysis was recorded");
    const destDecision = destPage.items.find((item) => item.activityKind === "decision_proposed");
    const destGold = destPage.items.find((item) => item.summary === "recorded an accepted outcome benchmark");
    const destHelpfulness = destPage.items.find((item) => item.summary === "recorded a comparison observation");
    const destExperiment = destPage.items.find((item) => item.summary === "recorded a strategy comparison");
    const destTraces = destPage.items.filter((item) => item.summary === "imported a comparison trace");
    const destTrace = destTraces[0];
    const destAttempt = destPage.items.find((item) => item.locator.kind === "workstream_attempt");
    const destIntake = destPage.items.find((item) => item.locator.kind === "intake_batch");
    expect(destObservation?.locator.investigationId).toBe(applied.investigationId);
    expect(destDiscussion?.locator.investigationId).toBe(applied.investigationId);
    expect(destEvidence?.locator.investigationId).toBe(applied.investigationId);
    expect(destFrozen?.locator.investigationId).toBe(applied.investigationId);
    expect(destObservation?.humanFinding).toBe(false);
    expect(destDiscussion?.humanFinding).toBe(false);
    expect(destDecision?.humanFinding).toBe(false);
    expect(destAttempt?.humanFinding).toBe(false);
    expect(destObservation?.provenanceClass).toBe("historical_restored");
    expect(destDiscussion?.provenanceClass).toBe("historical_restored");
    expect(destObservation?.locator.resourceId).not.toBe(sourceObservation?.locator.resourceId);
    expect(destDiscussion?.locator.resourceId).not.toBe(sourceDiscussion?.locator.resourceId);
    expect(destObservation?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destDiscussion?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destEvidence?.locator.resourceId).not.toBe(sourceEvidence?.locator.resourceId);
    expect(destEvidence?.locator.kind).toBe("evidence_item");
    expect(destEvidence?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destFrozen?.locator.resourceId).not.toBe(sourceFrozen?.locator.resourceId);
    expect(destFrozen?.locator.kind).toBe("evidence_context");
    expect(destFrozen?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destFrozen?.resolvedRoute).toContain("section=triage-evidence-board");
    expect(destFrozen?.resolvedRoute).toContain("kind=snapshot");
    const destFrozenTimeline = await row.cases.listTimeline(applied.investigationId);
    const destContributionEvents = destFrozenTimeline.filter((event) =>
      /^contribution_|^hypothesis_/.test(event.kind),
    );
    expect(destContributionEvents.length).toBeGreaterThan(0);
    expect(destContributionEvents.some((event) => event.targetId === destObservation?.locator.resourceId)).toBe(true);
    expect(destContributionEvents.some((event) => event.targetId === destDiscussion?.locator.resourceId)).toBe(true);
    for (const event of destContributionEvents) {
      expect(event.targetId).toBeTruthy();
      expect(event.targetId).not.toBe(applied.investigationId);
    }
    const destEvidenceEvents = destFrozenTimeline.filter((event) => /^evidence_/.test(event.kind));
    expect(destEvidenceEvents.length).toBeGreaterThan(0);
    expect(destEvidenceEvents.some((event) => event.targetId === destEvidence?.locator.resourceId)).toBe(true);
    for (const event of destEvidenceEvents) {
      expect(event.targetId).toBeTruthy();
      expect(event.targetId).not.toBe(applied.investigationId);
    }
    const destFrozenEvents = destFrozenTimeline.filter((event) => event.kind === "snapshot_frozen");
    expect(destFrozenEvents.length).toBeGreaterThan(0);
    for (const event of destFrozenEvents) {
      expect(event.targetId).toBe(destFrozen?.locator.resourceId);
      expect(event.targetId).not.toBe(applied.investigationId);
    }
    expect(destImported?.locator.kind).toBe("imported_ai_run");
    expect(destImported?.locator.resourceId).toBeTruthy();
    expect(destImported?.locator.resourceId).not.toBe(sourceImported?.locator.resourceId);
    expect(destImported?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destImported?.locator.resourceId).not.toBe(destFrozen?.locator.resourceId);
    expect(destImported?.humanFinding).toBe(false);
    expect(destImported?.resolvedRoute).toContain("section=triage-capture");
    expect(destImported?.resolvedRoute).toContain("kind=imported-run");
    expect(destImported?.resolvedRoute).toContain(`item=${destImported?.locator.resourceId}`);
    const destImportedEvents = destFrozenTimeline.filter((event) => event.kind === "external_run_imported");
    expect(destImportedEvents.length).toBeGreaterThan(0);
    for (const event of destImportedEvents) {
      expect(event.targetId).toBe(destImported?.locator.resourceId);
      expect(event.targetId).not.toBe(applied.investigationId);
      expect(event.targetId).not.toBe(destFrozen?.locator.resourceId);
    }
    expect(destFrozenTimeline.some((event) => event.kind === "run_corroboration")).toBe(false);
    expect(destPage.items.some((item) => item.summary === "reviewed imported analysis")).toBe(false);
    const destRuns = await row.imports.listRuns(applied.investigationId, ACTOR, false);
    expect(destRuns.length).toBeGreaterThan(0);
    expect(destRuns.every((run) => run.corroborationState === "unverified")).toBe(true);
    expect(destDecision?.locator.kind).toBe("decision_revision");
    expect(destDecision?.locator.resourceId).not.toBe(sourceDecision?.locator.resourceId);
    expect(destGold?.locator.kind).toBe("gold");
    expect(destGold?.locator.resourceId).toBeTruthy();
    expect(destGold?.locator.resourceId).not.toBe(sourceGold?.locator.resourceId);
    expect(destGold?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destGold?.humanFinding).toBe(false);
    expect(destGold?.provenanceClass).toBe("historical_restored");
    expect(destGold?.resolvedRoute).toContain("section=decision-heading");
    expect(destGold?.resolvedRoute).toContain(`item=${destGold?.locator.resourceId}`);
    expect(destHelpfulness?.locator.kind).toBe("helpfulness");
    expect(destHelpfulness?.locator.resourceId).toBeTruthy();
    expect(destHelpfulness?.locator.resourceId).not.toBe(sourceHelpfulness?.locator.resourceId);
    expect(destHelpfulness?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destHelpfulness?.humanFinding).toBe(false);
    expect(destHelpfulness?.provenanceClass).toBe("historical_restored");
    expect(destHelpfulness?.resolvedRoute).toContain("section=cross-exam-heading");
    expect(destHelpfulness?.resolvedRoute).toContain(`item=${destHelpfulness?.locator.resourceId}`);
    expect(destExperiment?.locator.kind).toBe("experiment");
    expect(destExperiment?.locator.resourceId).toBeTruthy();
    expect(destExperiment?.locator.resourceId).not.toBe(sourceExperiment?.locator.resourceId);
    expect(destExperiment?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destExperiment?.humanFinding).toBe(false);
    expect(destExperiment?.provenanceClass).toBe("historical_restored");
    expect(destExperiment?.resolvedRoute).toContain("section=candidate-comparison-heading");
    expect(destExperiment?.resolvedRoute).toContain(`item=${destExperiment?.locator.resourceId}`);
    expect(destTraces.length).toBe(sourceTraces.length);
    expect(destTrace?.locator.kind).toBe("interaction_trace");
    expect(destTrace?.locator.resourceId).toBeTruthy();
    expect(destTrace?.locator.resourceId).toContain(":");
    expect(destTrace?.locator.resourceId).not.toBe(sourceTrace?.locator.resourceId);
    expect(destTrace?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destTrace?.humanFinding).toBe(false);
    expect(destTrace?.provenanceClass).toBe("historical_restored");
    expect(destTrace?.resolvedRoute).toContain("section=candidate-comparison-heading");
    expect(destTrace?.resolvedRoute).toContain(`item=${encodeURIComponent(destTrace?.locator.resourceId ?? "")}`);
    expect(new Set(destTraces.map((item) => item.locator.resourceId)).size).toBe(destTraces.length);
    expect(destAttempt?.locator.resourceId).not.toBe(sourceAttempt?.locator.resourceId);
    expect(destAttempt?.locator.resourceId).toContain(":");
    expect(destAttempt?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destIntake?.locator.kind).toBe("intake_batch");
    expect(destIntake?.locator.resourceId).toBeTruthy();
    expect(destIntake?.locator.resourceId).not.toBe(sourceIntake?.locator.resourceId);
    expect(destIntake?.locator.resourceId).not.toBe(applied.investigationId);
    expect(destIntake?.humanFinding).toBe(false);
    expect(destIntake?.resolvedRoute).toContain("section=corpus-intake");
    expect(destIntake?.resolvedRoute).toContain(`item=${destIntake?.locator.resourceId}`);
    const confusedDestIntake = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
      installationId: "inst-syntheticnorth",
      investigationId: applied.investigationId,
      kind: "evidence_item",
      resourceId: destIntake!.locator.resourceId,
    }));
    await expect(activity.resolve(ACTOR, false, confusedDestIntake)).rejects.toMatchObject({
      code: "not_found",
    });

    const destExperiments = await row.experiments.list(applied.investigationId, ACTOR, false);
    const destDecisionIds = destExperiments.flatMap((experiment) =>
      experiment.decisions.map((decision) => decision.id),
    );
    expect(destDecisionIds).toContain(destDecision?.locator.resourceId);
    expect(destExperiments.map((experiment) => experiment.id)).not.toContain(destDecision?.locator.resourceId);
    const destDecisionTimeline = await row.cases.listTimeline(applied.investigationId);
    const destDecisionEvents = destDecisionTimeline.filter((event) =>
      event.kind.startsWith("experiment_decision_"),
    );
    expect(destDecisionEvents.length).toBeGreaterThan(0);
    for (const event of destDecisionEvents) {
      expect(destDecisionIds).toContain(event.targetId);
      expect(event.targetId).not.toBe(applied.investigationId);
      expect(destExperiments.map((experiment) => experiment.id)).not.toContain(event.targetId);
    }
    const destGoldIds = destExperiments.flatMap((experiment) =>
      experiment.golds.map((gold) => gold.goldId),
    );
    expect(destGoldIds).toContain(destGold?.locator.resourceId);
    expect(destExperiments.map((experiment) => experiment.id)).not.toContain(destGold?.locator.resourceId);
    expect(destDecisionIds).not.toContain(destGold?.locator.resourceId);
    const destHelpfulnessIds = destExperiments.flatMap((experiment) =>
      experiment.observations.map((observation) => observation.id),
    );
    expect(destHelpfulnessIds).toContain(destHelpfulness?.locator.resourceId);
    expect(destExperiments.map((experiment) => experiment.id)).not.toContain(destHelpfulness?.locator.resourceId);
    expect(destDecisionIds).not.toContain(destHelpfulness?.locator.resourceId);
    expect(destGoldIds).not.toContain(destHelpfulness?.locator.resourceId);
    expect(destExperiments.map((experiment) => experiment.id)).toContain(destExperiment?.locator.resourceId);
    expect(destExperiment?.locator.resourceId).not.toBe(sourceExperiment?.locator.resourceId);
    expect(destExperiments.map((experiment) => experiment.id)).toContain(
      destTrace?.locator.resourceId.split(":")[0],
    );
    expect(destTrace?.locator.resourceId.split(":")[0]).not.toBe(sourceTrace?.locator.resourceId.split(":")[0]);
    expect(
      destTraces.map((item) => item.locator.resourceId.slice(item.locator.resourceId.indexOf(":") + 1)).sort(),
    ).toEqual(
      sourceTraces.map((item) => item.locator.resourceId.slice(item.locator.resourceId.indexOf(":") + 1)).sort(),
    );
    const destJobs = await row.triageRuns.list(applied.investigationId, ACTOR, false);
    const destJobPrefix = destAttempt?.locator.resourceId.split(":")[0];
    expect(destJobs.map((job) => job.id)).toContain(destJobPrefix);
    expect(destJobs.map((job) => job.id)).not.toContain(sourceAttempt?.locator.resourceId.split(":")[0]);
    const destAttemptTimeline = await row.cases.listTimeline(applied.investigationId);
    const destAttemptEvents = destAttemptTimeline.filter((event) =>
      event.kind.startsWith("triage_candidate_"),
    );
    expect(destAttemptEvents.length).toBeGreaterThan(0);
    for (const event of destAttemptEvents) {
      expect(event.targetId).toMatch(/:/);
      expect(destJobs.map((job) => job.id)).toContain(event.targetId?.split(":")[0]);
      expect(event.targetId).not.toBe(applied.investigationId);
      expect(destJobs.map((job) => job.id)).not.toContain(event.targetId);
    }
    const destJobEvents = destAttemptTimeline.filter((event) => event.kind.startsWith("triage_job_"));
    expect(destJobEvents.length).toBeGreaterThan(0);
    for (const event of destJobEvents) {
      expect(destJobs.map((job) => job.id)).toContain(event.targetId);
      expect(event.targetId).not.toMatch(/:/);
      expect(event.targetId).not.toBe(applied.investigationId);
    }
    const destArtifacts = await row.cases.listArtifacts(applied.investigationId, ACTOR, false);
    const destIntakeEvidence = destArtifacts.find((item) => item.relativePath === "router/locator.log");
    expect(destIntakeEvidence?.intakeBatchId).toBe(destIntake?.locator.resourceId);

    for (const item of [destObservation, destDiscussion, destEvidence, destFrozen, destImported, destDecision, destGold, destHelpfulness, destExperiment, destTrace, destAttempt, destIntake]) {
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(item!.locator)),
      ).resolves.toMatchObject({ authorized: true, locator: item!.locator });
    }

    const confused = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
      installationId: "inst-syntheticnorth",
      investigationId: applied.investigationId,
      kind: "evidence_item",
      resourceId: destObservation!.locator.resourceId,
    }));
    await expect(activity.resolve(ACTOR, false, confused)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        { id: "eve", username: "eve" },
        false,
        formatCompactInvestigationLocator(destEvidence!.locator),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const swapped = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
      installationId: "inst-syntheticnorth",
      investigationId: applied.investigationId,
      kind: "evidence_item",
      resourceId: sourceEvidence!.locator.resourceId,
    }));
    await expect(activity.resolve(ACTOR, false, swapped)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(ACTOR, false, formatCompactInvestigationLocator(sourceEvidence!.locator)),
    ).resolves.toMatchObject({ authorized: true });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "decision_revision",
          resourceId: destExperiments[0]!.id,
          revision: destDecision!.locator.revision ?? 0,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "gold",
          resourceId: destExperiments[0]!.id,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "decision_revision",
          resourceId: destGold!.locator.resourceId,
          revision: destGold!.locator.revision ?? 0,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "helpfulness",
          resourceId: destExperiments[0]!.id,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "comparison_finding",
          resourceId: destHelpfulness!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "evidence_context",
          resourceId: destImported!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "imported_ai_run",
          resourceId: destFrozen!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "evidence_context",
          resourceId: destTrace!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "interaction_trace",
          resourceId: destExperiments[0]!.id,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      activity.resolve(
        ACTOR,
        false,
        formatCompactInvestigationLocator(formatInvestigationResourceLocator({
          installationId: "inst-syntheticnorth",
          investigationId: applied.investigationId,
          kind: "comparison_finding",
          resourceId: destExperiment!.locator.resourceId,
        })),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
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

  it("reauthorizes remapped intake-batch locators after PostgreSQL apply", async () => {
    const row = await fixture();
    const bytes = new TextEncoder().encode(
      "2042-03-04T11:32:00Z synthetic-router ERROR request timed out\n",
    );
    const seed = {
      origin: "files" as const,
      sourceLabel: "Synthetic postgres intake",
      privacyClass: "share_safe" as const,
      idempotencyKey: "batch-synthetic-pg-locator-1",
      files: [{
        relativePath: "router/pg-locator.log",
        mediaType: "text/plain",
        contentBase64: Buffer.from(bytes).toString("base64"),
      }],
      archiveBase64: null,
    };
    const previewIntake = await row.cases.previewCorpusIntake(row.caseId, ACTOR, {
      schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
      ...seed,
    });
    const committed = await row.cases.commitCorpusIntake(
      row.caseId,
      ACTOR,
      {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        ...seed,
        previewToken: previewIntake.previewToken,
      },
      "fixture",
    );
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
      const pgRoot = await mkdtemp(join(tmpdir(), "cd-portable-pg-intake-"));
      roots.push(pgRoot);
      const pgEvidence = new FilesystemEvidenceStore({
        rootDir: pgRoot,
        acquireWriteLease: async () => () => undefined,
      });
      const investigationId = await withPgApplyTransaction(client, pgEvidence, async (ports) =>
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
          ports,
          now: "2042-03-04T12:00:00.000Z",
        }),
      );
      const pgCases = new CaseService(pgEvidence, new MemoryAuditStore(), new PgCaseStore(client));
      const activity = new InvestigationActivityService({
        cases: pgCases,
        installationId: "inst-syntheticnorth",
      });
      const page = await activity.listPage({ actor: ACTOR, isAdmin: false, caseId: investigationId });
      const intake = page.items.find((item) => item.locator.kind === "intake_batch");
      expect(intake?.locator.resourceId).toBeTruthy();
      expect(intake?.locator.resourceId).not.toBe(committed.id);
      expect(intake?.humanFinding).toBe(false);
      const timeline = await pgCases.listTimeline(investigationId);
      const committedEvent = timeline.find((event) => event.kind === "corpus_intake_committed");
      expect(committedEvent?.targetId).toBe(intake?.locator.resourceId);
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(intake!.locator)),
      ).resolves.toMatchObject({ authorized: true, resourceLabel: "Intake batch" });
      await expect(
        activity.resolve(
          { id: "eve", username: "eve" },
          false,
          formatCompactInvestigationLocator(intake!.locator),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const confused = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "evidence_item",
        resourceId: intake!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confused)).rejects.toMatchObject({ code: "not_found" });
      const gold = page.items.find((item) => item.locator.kind === "gold");
      expect(gold?.locator.resourceId).toBeTruthy();
      expect(gold?.humanFinding).toBe(false);
      expect(gold?.locator.resourceId).not.toBe(investigationId);
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(gold!.locator)),
      ).resolves.toMatchObject({ authorized: true, resourceLabel: "Outcome benchmark" });
      await expect(
        activity.resolve(
          { id: "eve", username: "eve" },
          false,
          formatCompactInvestigationLocator(gold!.locator),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const confusedGold = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "decision_revision",
        resourceId: gold!.locator.resourceId,
        revision: gold!.locator.revision ?? 0,
      }));
      await expect(activity.resolve(ACTOR, false, confusedGold)).rejects.toMatchObject({ code: "not_found" });
      const helpfulness = page.items.find((item) => item.locator.kind === "helpfulness");
      expect(helpfulness?.locator.resourceId).toBeTruthy();
      expect(helpfulness?.humanFinding).toBe(false);
      expect(helpfulness?.locator.resourceId).not.toBe(investigationId);
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(helpfulness!.locator)),
      ).resolves.toMatchObject({ authorized: true, resourceLabel: "Comparison observation" });
      await expect(
        activity.resolve(
          { id: "eve", username: "eve" },
          false,
          formatCompactInvestigationLocator(helpfulness!.locator),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const confusedHelpfulness = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "comparison_finding",
        resourceId: helpfulness!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confusedHelpfulness)).rejects.toMatchObject({
        code: "not_found",
      });
      const traces = page.items.filter((item) => item.locator.kind === "interaction_trace");
      expect(traces.length).toBeGreaterThan(1);
      expect(new Set(traces.map((item) => item.locator.resourceId)).size).toBe(traces.length);
      for (const trace of traces) {
        expect(trace.locator.resourceId).toContain(":");
        expect(trace.locator.resourceId).not.toBe(investigationId);
        expect(trace.humanFinding).toBe(false);
        expect(trace.resolvedRoute).toContain("section=candidate-comparison-heading");
        await expect(
          activity.resolve(ACTOR, false, formatCompactInvestigationLocator(trace.locator)),
        ).resolves.toMatchObject({ authorized: true, resourceLabel: "Imported comparison trace" });
        await expect(
          activity.resolve(
            { id: "eve", username: "eve" },
            false,
            formatCompactInvestigationLocator(trace.locator),
          ),
        ).rejects.toMatchObject({ code: "not_found" });
      }
      const confusedTrace = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "evidence_context",
        resourceId: traces[0]!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confusedTrace)).rejects.toMatchObject({
        code: "not_found",
      });
      const experiment = page.items.find((item) => item.locator.kind === "experiment");
      expect(experiment?.locator.resourceId).toBeTruthy();
      expect(experiment?.humanFinding).toBe(false);
      expect(experiment?.locator.resourceId).not.toBe(investigationId);
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(experiment!.locator)),
      ).resolves.toMatchObject({ authorized: true, resourceLabel: "Strategy comparison" });
      await expect(
        activity.resolve(
          { id: "eve", username: "eve" },
          false,
          formatCompactInvestigationLocator(experiment!.locator),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const confusedExperiment = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "comparison_finding",
        resourceId: experiment!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confusedExperiment)).rejects.toMatchObject({
        code: "not_found",
      });
      const imported = page.items.find((item) => item.summary === "imported analysis was recorded");
      const frozen = page.items.find((item) => item.activityKind === "evidence_frozen");
      expect(imported?.locator.kind).toBe("imported_ai_run");
      expect(imported?.locator.resourceId).toBeTruthy();
      expect(imported?.locator.resourceId).not.toBe(investigationId);
      expect(imported?.locator.resourceId).not.toBe(frozen?.locator.resourceId);
      expect(imported?.humanFinding).toBe(false);
      expect(imported?.resolvedRoute).toContain("section=triage-capture");
      expect(imported?.resolvedRoute).toContain("kind=imported-run");
      expect(frozen?.locator.kind).toBe("evidence_context");
      expect(frozen?.resolvedRoute).toContain("section=triage-evidence-board");
      expect(frozen?.resolvedRoute).toContain("kind=snapshot");
      await expect(
        activity.resolve(ACTOR, false, formatCompactInvestigationLocator(imported!.locator)),
      ).resolves.toMatchObject({ authorized: true, resourceLabel: "Imported analysis" });
      await expect(
        activity.resolve(
          { id: "eve", username: "eve" },
          false,
          formatCompactInvestigationLocator(imported!.locator),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      const confusedImported = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "evidence_context",
        resourceId: imported!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confusedImported)).rejects.toMatchObject({
        code: "not_found",
      });
      const confusedImportedSnapshot = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
        installationId: "inst-syntheticnorth",
        investigationId,
        kind: "imported_ai_run",
        resourceId: frozen!.locator.resourceId,
      }));
      await expect(activity.resolve(ACTOR, false, confusedImportedSnapshot)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(page.items.some((item) => item.summary === "reviewed imported analysis")).toBe(false);
      expect((await pgCases.listTimeline(investigationId)).some((event) => event.kind === "run_corroboration"))
        .toBe(false);
      const destRuns = await new PgRunStore(client).listByCase(investigationId);
      expect(destRuns.length).toBeGreaterThan(0);
      for (const run of destRuns) {
        expect(await new PgRunStore(client).listCorroborations(run.id)).toEqual([]);
      }
    });
  });

  it("refuses PostgreSQL apply of imported-run corroboration timeline", async () => {
    const row = await fixture();
    const archive = await row.portable.exportArchive(row.caseId, ACTOR, false, true);
    const imported = archive.investigation.timeline.find((event) => event.kind === "external_run_imported");
    if (!imported?.targetId) throw new Error("imported-run timeline is missing");
    const injected = injectCorroborationEvent(archive, {
      targetId: imported.targetId,
      targetNamespace: "imported_ai_run",
    });
    const identityMap = identityMapFor(injected);
    const preview = await row.portable.preflight(
      injected,
      { mode: "dry_run", collisionPolicy: "remap_deterministic", identityMap },
      ACTOR,
      false,
    );
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const pgRoot = await mkdtemp(join(tmpdir(), "cd-portable-pg-corroboration-"));
      roots.push(pgRoot);
      const pgEvidence = new FilesystemEvidenceStore({
        rootDir: pgRoot,
        acquireWriteLease: async () => () => undefined,
      });
      await expect(
        withPgApplyTransaction(client, pgEvidence, async (ports) =>
          persistPortableArchive({
            archive: injected,
            report: preview.report,
            identityMap,
            actor: ACTOR,
            destinationUsernames: new Map([[ACTOR.id, ACTOR.username]]),
            contentBytes: archiveContentBytes(injected),
            ports,
            now: "2042-03-04T12:00:00.000Z",
          }),
        ),
      ).rejects.toThrow(/imported-run corroboration is not exact-applyable/);
      expect(await new PgCaseStore(client).listCases()).toEqual([]);
    });
  });
});
