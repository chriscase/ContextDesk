import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGREEMENT_NOT_CORRECTNESS,
  GOLD_ALIGNMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
  parseExperimentPackage,
  parseExperimentReviewExport,
  parseGoldReference,
  parseHelpfulnessObservation,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./index.js";

const ALICE = "fixture-alice-secret";
const DAVE = "fixture-dave-secret";
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as unknown;
const SUMMARY = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-summary.valid.json"),
    "utf8",
  ),
) as unknown;

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

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
      "dave",
      {
        password: DAVE,
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

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-experiment-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const experiments = new ExperimentService({
    cases: domain,
    audit,
    experiments: new MemoryExperimentStore(),
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    experiments,
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
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function createCase(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: token },
    payload: { title: "Synthetic checkout timeouts", severity: "medium" },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { id: string };
}

describe("experiment lab review loop", () => {
  it("imports a share-safe package idempotently and projects the candidate matrix", async () => {
    await withApp(async ({ app }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const first = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: PACKAGE,
      });
      expect(first.statusCode).toBe(200);
      const view = JSON.parse(first.body) as {
        id: string;
        packageId: string;
        candidates: { modelLabel: string; goldState: string; cost: { status: string } }[];
        agreement: { notes: string[]; roleConflicts: unknown[] };
      };
      expect(view.packageId).toBe(parseExperimentPackage(PACKAGE).packageId);
      expect(view.candidates.map((c) => c.modelLabel)).toEqual([
        "qwen-3.6-27b",
        "gpt-oss-120b",
        "ministral-14b",
      ]);
      expect(view.candidates.every((c) => c.goldState === "unknown")).toBe(true);
      expect(view.candidates.every((c) => c.cost.status === "unknown")).toBe(true);
      expect(view.agreement.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
      expect(view.agreement.roleConflicts.length).toBe(1);

      const second = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: PACKAGE,
      });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).id).toBe(view.id);
      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
      });
      expect(JSON.parse(listed.body).experiments).toHaveLength(1);
    });
  });

  it("imports an experiment summary without inventing agreement or gold", async () => {
    await withApp(async ({ app }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: SUMMARY,
      });
      expect(res.statusCode).toBe(200);
      const view = JSON.parse(res.body) as {
        candidates: { goldState: string }[];
        agreement: { sharedAnchors: unknown[]; notes: string[] };
      };
      expect(view.candidates).toHaveLength(3);
      expect(view.candidates.every((c) => c.goldState === "unknown")).toBe(true);
      expect(view.agreement.sharedAnchors).toEqual([]);
      expect(view.agreement.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
    });
  });

  it("records helpfulness, proposes then accepts a decision, and rejects stale revisions", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: PACKAGE,
      });
      const experimentId = JSON.parse(imported.body).id as string;

      const helpful = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/helpfulness`,
        headers: { cookie: alice },
        payload: {
          candidateId: "cand-qwen-3.6-27b",
          dimension: "evidence_support",
          score: 2,
          rationale: "Cited the checkout timeout log as a symptom.",
          evidenceRefs: ["ev-demo-checkout-log"],
        },
      });
      expect(helpful.statusCode).toBe(200);
      parseHelpfulnessObservation(JSON.parse(helpful.body));

      const proposed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions`,
        headers: { cookie: alice },
        payload: {
          text: "Keep investigating the inventory timeout as a candidate cause.",
          rationale: "Shared symptom agreement is not a gold answer.",
          evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
        },
      });
      expect(proposed.statusCode).toBe(200);
      const proposal = JSON.parse(proposed.body) as { id: string; revision: number; status: string };
      expect(proposal.status).toBe("proposed");
      expect(proposal.revision).toBe(1);

      const stale = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions/${proposal.id}/accept`,
        headers: { cookie: dave },
        payload: { expectedRevision: 0 },
      });
      expect(stale.statusCode).toBe(409);

      const accepted = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions/${proposal.id}/accept`,
        headers: { cookie: dave },
        payload: { expectedRevision: 1 },
      });
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(accepted.body).status).toBe("accepted");

      const again = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions/${proposal.id}/accept`,
        headers: { cookie: dave },
        payload: { expectedRevision: 2 },
      });
      expect(again.statusCode).toBe(409);

      const exportRes = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/export`,
        headers: { cookie: dave },
      });
      expect(exportRes.statusCode).toBe(200);
      const exported = parseExperimentReviewExport(JSON.parse(exportRes.body));
      expect(exported.privacyClass).toBe("share_safe");
      expect(exported.decision?.status).toBe("accepted");
      expect(exported.observations).toHaveLength(1);
      expect(exported.observations[0]?.reviewerId).toBe("participant");
      expect(exported.gold).toBeNull();
      expect(exported.alignments.every((row) => row.status === "unknown")).toBe(true);
      expect(exported.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
      expect(exported.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
      const raw = exportRes.body as string;
      for (const token of [
        "rawModelCapture",
        '"prompt"',
        '"prompts"',
        '"apiKey"',
        '"endpoint"',
        '"baseUrl"',
        '"requestId"',
        "Bearer ",
        "ai-gateway.vercel.sh",
      ]) {
        expect(raw).not.toContain(token);
      }
    });
  });

  it("rejects unknown package fields and does not fabricate cost", async () => {
    await withApp(async ({ app }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const res = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: {
          ...(PACKAGE as object),
          endpoint: "https://ai-gateway.vercel.sh/v1",
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("accepted decision to versioned gold", () => {
  async function acceptedExperiment(
    app: Awaited<ReturnType<typeof buildApp>>,
    alice: string,
    dave: string,
  ) {
    const created = await createCase(app, alice);
    const imported = await app.inject({
      method: "POST",
      url: `/api/cases/${created.id}/experiments`,
      headers: { cookie: alice },
      payload: PACKAGE,
    });
    const experimentId = JSON.parse(imported.body).id as string;
    const proposed = await app.inject({
      method: "POST",
      url: `/api/cases/${created.id}/experiments/${experimentId}/decisions`,
      headers: { cookie: alice },
      payload: {
        text: "Treat inventory timeout as the benchmark cause.",
        rationale: "Human decision over the synthetic checkout comparison.",
        evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      },
    });
    const proposal = JSON.parse(proposed.body) as { id: string; revision: number };
    const accepted = await app.inject({
      method: "POST",
      url: `/api/cases/${created.id}/experiments/${experimentId}/decisions/${proposal.id}/accept`,
      headers: { cookie: dave },
      payload: { expectedRevision: proposal.revision },
    });
    const decision = JSON.parse(accepted.body) as { id: string; revision: number };
    return { caseId: created.id, experimentId, decision };
  }

  it("rejects unauthenticated, contributor, and proposed-only promotion", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: PACKAGE,
      });
      const experimentId = JSON.parse(imported.body).id as string;
      const proposed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions`,
        headers: { cookie: alice },
        payload: {
          text: "Proposed only.",
          rationale: "Not accepted yet.",
          evidenceRefs: ["ev-demo-checkout-log"],
        },
      });
      const proposal = JSON.parse(proposed.body) as { id: string; revision: number };
      const unauthenticated = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/gold`,
        payload: {
          decisionId: proposal.id,
          expectedRevision: proposal.revision,
          evidenceAnchors: ["ev-demo-checkout-log"],
        },
      });
      expect(unauthenticated.statusCode).toBe(401);
      const contributor = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/gold`,
        headers: { cookie: alice },
        payload: {
          decisionId: proposal.id,
          expectedRevision: proposal.revision,
          evidenceAnchors: ["ev-demo-checkout-log"],
        },
      });
      expect(contributor.statusCode).toBe(403);
      const proposedOnly = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload: {
          decisionId: proposal.id,
          expectedRevision: proposal.revision,
          evidenceAnchors: ["ev-demo-checkout-log"],
        },
      });
      expect(proposedOnly.statusCode).toBe(400);
      expect(JSON.parse(proposedOnly.body).error).toMatch(/proposed/);
    });
  });

  it("promotes idempotently, versions on change, and refuses stale gold revisions", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const { caseId, experimentId, decision } = await acceptedExperiment(app, alice, dave);
      const payload = {
        decisionId: decision.id,
        expectedRevision: decision.revision,
        evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
        expectedRelationships: [
          { evidenceRef: "ev-demo-checkout-log", role: "symptom" },
          { evidenceRef: "ev-demo-inventory-timeout", role: "cause" },
        ],
        helpfulnessDimensions: ["evidence_support"],
      };
      const first = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const gold = parseGoldReference(JSON.parse(first.body));
      expect(gold.version).toBe(1);
      expect(gold.acceptedDecisionId).toBe(decision.id);
      expect(gold.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);

      const again = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload,
      });
      expect(again.statusCode).toBe(200);
      expect(JSON.parse(again.body).goldId).toBe(gold.goldId);
      expect(JSON.parse(again.body).version).toBe(1);

      const stale = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload: {
          ...payload,
          evidenceAnchors: ["ev-demo-checkout-log"],
          expectedRelationships: [{ evidenceRef: "ev-demo-checkout-log", role: "symptom" }],
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body).code).toBe("stale_gold");

      const next = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload: {
          ...payload,
          expectedGoldVersion: 1,
          evidenceAnchors: ["ev-demo-checkout-log"],
          expectedRelationships: [{ evidenceRef: "ev-demo-checkout-log", role: "symptom" }],
        },
      });
      expect(next.statusCode).toBe(200);
      const v2 = parseGoldReference(JSON.parse(next.body));
      expect(v2.version).toBe(2);
      expect(v2.predecessorGoldId).toBe(gold.goldId);
      expect(v2.goldId).not.toBe(gold.goldId);

      const view = await app.inject({
        method: "GET",
        url: `/api/cases/${caseId}/experiments/${experimentId}`,
        headers: { cookie: dave },
      });
      const body = JSON.parse(view.body) as {
        golds: { goldId: string; version: number; evidenceAnchors: string[] }[];
        gold: { version: number };
        candidates: { goldState: string }[];
        alignments: { candidateId: string; status: string }[];
      };
      expect(body.golds).toHaveLength(2);
      expect(body.golds[0]?.goldId).toBe(gold.goldId);
      expect(body.golds[0]?.evidenceAnchors).toEqual([
        "ev-demo-checkout-log",
        "ev-demo-inventory-timeout",
      ]);
      expect(body.gold.version).toBe(2);
      expect(body.candidates.every((c) => c.goldState === "present")).toBe(true);
      expect(body.alignments.map((row) => row.candidateId)).toEqual([
        "cand-qwen-3.6-27b",
        "cand-gpt-oss-120b",
        "cand-ministral-14b",
      ]);

      const exportRes = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/experiments/${experimentId}/export`,
        headers: { cookie: dave },
      });
      expect(exportRes.statusCode).toBe(200);
      const exported = parseExperimentReviewExport(JSON.parse(exportRes.body));
      expect(exported.gold?.version).toBe(2);
      expect(exported.gold?.promotedById).toBe("participant");
      expect(exported.notes).toContain(GOLD_ALIGNMENT_NOT_CORRECTNESS);
      const raw = exportRes.body as string;
      for (const token of [
        "rawModelCapture",
        '"prompt"',
        '"apiKey"',
        '"endpoint"',
        '"requestId"',
        "Bearer ",
        "ai-gateway.vercel.sh",
      ]) {
        expect(raw).not.toContain(token);
      }
    });
  });

  it("does not mutate a prior gold version in the memory store", async () => {
    const store = new MemoryExperimentStore();
    const gold = parseGoldReference(
      JSON.parse(
        readFileSync(
          join(here, "../../../../contracts/fixtures/gold-reference.valid.json"),
          "utf8",
        ),
      ),
    );
    await store.insert({
      id: gold.experimentId,
      caseId: gold.caseId,
      packageId: gold.packageId,
      sourceSchemaId: "cd-collab.experiment_package.v1",
      taskFingerprint: gold.taskFingerprint,
      snapshotFingerprint: gold.snapshotFingerprint,
      candidates: parseExperimentPackage(PACKAGE).candidates,
      agreement: parseExperimentPackage(PACKAGE).agreement,
      createdAt: gold.createdAt,
      importerId: "importer",
      importerUsername: "importer",
    });
    await store.insertGold(gold);
    await expect(store.insertGold(gold)).rejects.toThrow(/insert-only/);
    const listed = await store.listGolds(gold.experimentId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.evidenceAnchors).toEqual(gold.evidenceAnchors);
  });
});
