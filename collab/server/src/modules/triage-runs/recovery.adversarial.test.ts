import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriageCandidateRunV1, TriageJobV1 } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import {
  bindRecoveryAuthorization,
  MutableGroupRoleMap,
  parseGroupRoleMap,
  type RecoveryAuthorizationDeps,
} from "../authz/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { CatalogService } from "../catalog/index.js";
import { MemoryLocalGrantStore, MemoryUserProfileStore } from "../people/index.js";
import {
  DeterministicMockTriageExecutor,
  TriageRunService,
  type TriageExecutionContext,
  type TriageRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore } from "./store.js";

const PRIVATE_LOG = "synthetic-owner-only-checkout-timeout";
const SHARE_SAFE_LOG = "synthetic-share-safe-checkout-timeout";
const LEAD = { id: "local:lead", username: "lead" };
const VIEWER = { id: "local:viewer", username: "viewer" };
const CONTRIBUTOR = { id: "local:contributor", username: "contributor" };
const ADMIN = { id: "local:admin", username: "admin" };
const HISTORICAL = {
  id: "imported:north-installation:actor-42",
  username: "historical",
};

function directory() {
  return new MapAuthAdapter(
    new Map([
      [
        "lead",
        {
          password: "lead-secret",
          identity: { id: LEAD.id, username: LEAD.username, displayName: "Lead" },
          groups: ["local:case-leads"],
        },
      ],
      [
        "viewer",
        {
          password: "viewer-secret",
          identity: { id: VIEWER.id, username: VIEWER.username, displayName: "Viewer" },
          groups: ["local:viewers"],
        },
      ],
      [
        "contributor",
        {
          password: "contributor-secret",
          identity: {
            id: CONTRIBUTOR.id,
            username: CONTRIBUTOR.username,
            displayName: "Contributor",
          },
          groups: ["local:contributors"],
        },
      ],
      [
        "admin",
        {
          password: "admin-secret",
          identity: { id: ADMIN.id, username: ADMIN.username, displayName: "Admin" },
          groups: ["local:admins"],
        },
      ],
      [
        "historical",
        {
          password: "historical-secret",
          identity: {
            id: HISTORICAL.id,
            username: HISTORICAL.username,
            displayName: "Historical",
          },
          groups: ["local:case-leads"],
        },
      ],
    ]),
  );
}

function roleMap() {
  return new MutableGroupRoleMap(
    parseGroupRoleMap(
      "local:admins=admin;local:case-leads=case-lead;local:contributors=contributor;local:viewers=viewer",
    ),
  );
}

async function seedProfile(
  profiles: MemoryUserProfileStore,
  actor: { id: string; username: string },
  provenance: "local" | "imported_historical" = "local",
) {
  const seeded = await profiles.touchOnLogin({
    id: actor.id,
    username: actor.username,
    displayName: actor.username,
    provenance,
    directorySubject: provenance === "local" ? null : actor.id,
  });
  expect(seeded.outcome).toBe("ok");
}

function request(snapshotId: string) {
  return {
    schemaId: "cd-collab.triage_job_request.v1" as const,
    snapshotId,
    mode: "deterministic_mock" as const,
    strategyId: "contextdesk.standard",
    question: "What happened and what should we inspect next?",
    policyFingerprint: null,
    taskFingerprint: "task-fingerprint",
    candidates: [
      {
        candidateId: "candidate-1",
        role: "reviewer",
        provider: "synthetic",
        profileId: null,
        model: "qwen-3.6-27b",
        version: null,
      },
    ],
  };
}

function queuedJob(input: {
  id: string;
  caseId: string;
  snapshotId: string;
  snapshotFingerprint: string;
  requestedBy: string;
  requestedByUsername: string;
}): TriageJobV1 {
  const spec = request(input.snapshotId);
  return {
    schemaId: "cd-collab.triage_job.v1",
    id: input.id,
    caseId: input.caseId,
    snapshotId: input.snapshotId,
    snapshotFingerprint: input.snapshotFingerprint,
    requestFingerprint: "d".repeat(64),
    cancellationId: `cancel-${input.id}`,
    request: spec,
    status: "queued",
    candidates: [
      {
        ...spec.candidates[0]!,
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
      },
    ],
    sameSnapshot: null,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: input.requestedBy,
    requestedByUsername: input.requestedByUsername,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    stoppedReason: null,
  };
}

async function recoveryFixture(options: {
  actor: { id: string; username: string };
  privacyClass: "owner_only" | "share_safe";
  provenance?: "local" | "imported_historical";
  executor?: TriageRunExecutor;
  recoveryDeps?: (deps: RecoveryAuthorizationDeps) => RecoveryAuthorizationDeps;
}) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-triage-recovery-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const caseStore = new MemoryCaseStore();
  const cases = new CaseService(evidence, audit, caseStore, new CatalogService());
  const jobs = new MemoryTriageJobStore();
  const profiles = new MemoryUserProfileStore();
  const grants = new MemoryLocalGrantStore();
  const adapter = directory();
  const roles = roleMap();
  await seedProfile(profiles, options.actor, options.provenance);
  const counts = { providerCalls: 0, privateByteReads: 0, observedPrivateBase64: null as string | null };
  const countingExecutor: TriageRunExecutor = {
    execute: async (context: TriageExecutionContext, signal: AbortSignal): Promise<TriageCandidateRunV1> => {
      counts.providerCalls += 1;
      const privateItem = context.evidence.find((item) => item.privacyClass === "owner_only");
      counts.observedPrivateBase64 = privateItem?.contentBase64 ?? null;
      const inner = options.executor ?? new DeterministicMockTriageExecutor();
      return inner.execute(context, signal);
    },
  };
  const deps: RecoveryAuthorizationDeps = {
    lookupGroups: (identity) => adapter.lookupGroups(identity),
    roles,
    profiles,
    grants,
  };
  const service = new TriageRunService({
    cases,
    audit,
    jobs,
    executor: countingExecutor,
    recoveryAuthorization: bindRecoveryAuthorization(options.recoveryDeps?.(deps) ?? deps),
  });
  const created = await cases.createCase(options.actor, { title: "Recovery auth fixture" }, "test");
  const bytes = options.privacyClass === "owner_only" ? PRIVATE_LOG : SHARE_SAFE_LOG;
  const artifact = await cases.addEvidence(
    created.id,
    options.actor,
    {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(bytes),
      summary: "Synthetic checkout timeout.",
      privacyClass: options.privacyClass,
    },
    "test",
  );
  const snapshot = await cases.createSnapshot(
    created.id,
    options.actor,
    {
      evidenceIds: [artifact.artifact.id],
      visibility: options.privacyClass,
    },
    "test",
  );
  const privateHash = artifact.artifact.contentHash;
  const originalGet = evidence.get.bind(evidence);
  (evidence as { get: typeof evidence.get }).get = async (hash) => {
    if (privateHash && hash === privateHash && options.privacyClass === "owner_only") {
      counts.privateByteReads += 1;
    }
    return originalGet(hash);
  };
  const job = queuedJob({
    id: "job-recover-auth",
    caseId: created.id,
    snapshotId: snapshot.id,
    snapshotFingerprint: snapshot.fingerprint,
    requestedBy: options.actor.id,
    requestedByUsername: options.actor.username,
  });
  await jobs.insert(job);
  return {
    root,
    audit,
    cases,
    caseStore,
    jobs,
    profiles,
    grants,
    service,
    counts,
    caseId: created.id,
    snapshot,
    jobId: job.id,
    actor: options.actor,
    privateHash,
  };
}

async function waitFor(
  service: TriageRunService,
  caseId: string,
  jobId: string,
  actor: { id: string; username: string },
  status: string,
  isAdmin = false,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.get(caseId, jobId, actor, isAdmin);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${status}`);
}

describe("triage restart recovery reauthorization", () => {
  it("resumes an active authorized requester with only current private-read capability", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "owner_only" });
    try {
      await fx.service.recoverPending();
      const completed = await waitFor(fx.service, fx.caseId, fx.jobId, LEAD, "completed");
      expect(completed.status).toBe("completed");
      expect(fx.counts.providerCalls).toBe(1);
      expect(fx.counts.privateByteReads).toBeGreaterThan(0);
      expect(fx.counts.observedPrivateBase64).toBe(Buffer.from(PRIVATE_LOG).toString("base64"));
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBeNull();
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed after suspension without a provider call or private-byte read", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "owner_only" });
    try {
      const current = await fx.profiles.getById(LEAD.id);
      if (!current) throw new Error("setup failed");
      await fx.profiles.setStatus(LEAD.id, "suspended", current.revision);
      await fx.service.recoverPending();
      const refused = await fx.jobs.get(fx.jobId);
      expect(refused?.status).toBe("failed");
      expect(refused?.stoppedReason).toBe("requester_suspended");
      expect(refused?.candidates[0]?.errorCode).toBe("requester_suspended");
      expect(fx.counts.providerCalls).toBe(0);
      expect(fx.counts.privateByteReads).toBe(0);
      expect(fx.counts.observedPrivateBase64).toBeNull();
      const events = await fx.audit.list({ action: "triage_job_recovered" });
      expect(events).toEqual([
        expect.objectContaining({
          identity: LEAD.id,
          target: `${fx.jobId}:requester_suspended`,
          outcome: "failure",
        }),
      ]);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed after the requester is disabled", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "owner_only" });
    try {
      const current = await fx.profiles.getById(LEAD.id);
      if (!current) throw new Error("setup failed");
      await fx.profiles.setStatus(LEAD.id, "disabled", current.revision);
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("requester_disabled");
      expect(fx.counts.providerCalls).toBe(0);
      expect(fx.counts.privateByteReads).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed for an imported_historical identity even with mapped groups", async () => {
    const fx = await recoveryFixture({
      actor: HISTORICAL,
      privacyClass: "share_safe",
      provenance: "imported_historical",
    });
    try {
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("requester_historical");
      expect(fx.counts.providerCalls).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves membership-loss refusal for a still-active requester", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "share_safe" });
    try {
      const captured = fx.caseStore.capture() as { cases: [string, { id: string; participants: unknown[] }][] };
      for (const [, row] of captured.cases) {
        if (row.id === fx.caseId) row.participants = [];
      }
      fx.caseStore.restore(captured);
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("requester_not_member");
      expect(fx.counts.providerCalls).toBe(0);
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.status).toBe("failed");
      expect((await fx.audit.list({ action: "triage_job_recovered" }))).toHaveLength(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed after run:strategies grant revocation", async () => {
    const fx = await recoveryFixture({ actor: VIEWER, privacyClass: "share_safe" });
    try {
      await fx.grants.grant(VIEWER.id, "run:strategies", ADMIN.id);
      const authorized = bindRecoveryAuthorization({
        lookupGroups: (identity) => directory().lookupGroups(identity),
        roles: roleMap(),
        profiles: fx.profiles,
        grants: fx.grants,
      });
      expect((await authorized(VIEWER)).kind).toBe("authorized");
      await fx.grants.revoke(VIEWER.id, "run:strategies");
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("requester_run_revoked");
      expect(fx.counts.providerCalls).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed after private-read revocation without leaking owner_only bytes", async () => {
    const fx = await recoveryFixture({ actor: CONTRIBUTOR, privacyClass: "owner_only" });
    try {
      await fx.grants.grant(CONTRIBUTOR.id, "run:strategies", ADMIN.id);
      await fx.grants.grant(CONTRIBUTOR.id, "evidence:private:read", ADMIN.id);
      await fx.grants.revoke(CONTRIBUTOR.id, "evidence:private:read");
      await fx.service.recoverPending();
      const refused = await fx.jobs.get(fx.jobId);
      expect(refused?.status).toBe("failed");
      expect(refused?.stoppedReason).toBe("requester_private_read_revoked");
      expect(fx.counts.providerCalls).toBe(0);
      expect(fx.counts.privateByteReads).toBe(0);
      expect(fx.counts.observedPrivateBase64).toBeNull();
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the profile store is unavailable", async () => {
    const fx = await recoveryFixture({
      actor: LEAD,
      privacyClass: "owner_only",
      recoveryDeps: (deps) => ({
        ...deps,
        profiles: {
          getById: async () => {
            throw new Error("profile store down");
          },
        },
      }),
    });
    try {
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("recovery_authorization_unavailable");
      expect(fx.counts.providerCalls).toBe(0);
      expect(fx.counts.privateByteReads).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the grant store is unavailable", async () => {
    const fx = await recoveryFixture({
      actor: LEAD,
      privacyClass: "owner_only",
      recoveryDeps: (deps) => ({
        ...deps,
        grants: {
          list: async () => {
            throw new Error("grant store down");
          },
        },
      }),
    });
    try {
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.stoppedReason).toBe("recovery_authorization_unavailable");
      expect(fx.counts.providerCalls).toBe(0);
      expect(fx.counts.privateByteReads).toBe(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed without a recovery-authorization seam and stays failed on a second restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-triage-recovery-missing-seam-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const cases = new CaseService(evidence, audit, new MemoryCaseStore(), new CatalogService());
    const jobs = new MemoryTriageJobStore();
    let providerCalls = 0;
    const service = new TriageRunService({
      cases,
      audit,
      jobs,
      executor: {
        execute: async (context, signal) => {
          providerCalls += 1;
          return new DeterministicMockTriageExecutor().execute(context, signal);
        },
      },
    });
    try {
      const created = await cases.createCase(LEAD, { title: "Missing seam" }, "test");
      const artifact = await cases.addEvidence(
        created.id,
        LEAD,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(SHARE_SAFE_LOG),
          summary: "Synthetic checkout timeout.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const snapshot = await cases.createSnapshot(
        created.id,
        LEAD,
        { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
        "test",
      );
      await jobs.insert(queuedJob({
        id: "job-missing-seam",
        caseId: created.id,
        snapshotId: snapshot.id,
        snapshotFingerprint: snapshot.fingerprint,
        requestedBy: LEAD.id,
        requestedByUsername: LEAD.username,
      }));
      await service.recoverPending();
      await service.recoverPending();
      expect((await jobs.get("job-missing-seam"))?.stoppedReason).toBe(
        "recovery_authorization_unavailable",
      );
      expect(providerCalls).toBe(0);
      expect(await audit.list({ action: "triage_job_recovered" })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for authorized recovery across a second restart", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "owner_only" });
    try {
      await fx.service.recoverPending();
      const completed = await waitFor(fx.service, fx.caseId, fx.jobId, LEAD, "completed");
      expect(completed.status).toBe("completed");
      await fx.service.recoverPending();
      expect((await fx.jobs.get(fx.jobId))?.status).toBe("completed");
      expect(fx.counts.providerCalls).toBe(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("lets a current admin resume without inheriting a stale non-member denial", async () => {
    const fx = await recoveryFixture({ actor: LEAD, privacyClass: "owner_only" });
    try {
      await seedProfile(fx.profiles, ADMIN);
      await fx.jobs.update({
        ...(await fx.jobs.get(fx.jobId))!,
        requestedBy: ADMIN.id,
        requestedByUsername: ADMIN.username,
      });
      await fx.service.recoverPending();
      const completed = await waitFor(fx.service, fx.caseId, "job-recover-auth", ADMIN, "completed", true);
      expect(completed.status).toBe("completed");
      expect(fx.counts.providerCalls).toBe(1);
      expect(fx.counts.observedPrivateBase64).toBe(Buffer.from(PRIVATE_LOG).toString("base64"));
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
