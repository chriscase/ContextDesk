import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGREEMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
  parseExperimentPackage,
  parseGoldReference,
  parseHelpfulnessObservation,
  parseLabExportV2,
  type InteractionTraceV1,
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
import type { ExperimentRow } from "./store.js";

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
    experiments: MemoryExperimentStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-experiment-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const experimentStore = new MemoryExperimentStore();
  const experiments = new ExperimentService({
    cases: domain,
    audit,
    experiments: experimentStore,
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
    await fn({ app, audit, experiments: experimentStore });
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

  it("canonicalizes export-compatible fingerprints and rejects malformed ones at import", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const legacy = structuredClone(PACKAGE) as {
        packageId: string;
        taskFingerprint: string;
        snapshotFingerprint: string;
      };
      legacy.packageId = "pkg-legacy-fingerprint-spelling";
      legacy.taskFingerprint = legacy.taskFingerprint.toUpperCase();
      legacy.snapshotFingerprint = legacy.snapshotFingerprint.slice("snap-".length).toUpperCase();
      expect(parseExperimentPackage(legacy).taskFingerprint).toBe(legacy.taskFingerprint);

      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: legacy,
      });
      expect(imported.statusCode).toBe(200);
      const view = JSON.parse(imported.body) as {
        id: string;
        taskFingerprint: string;
        snapshotFingerprint: string;
      };
      expect(view.taskFingerprint).toMatch(/^task-[a-f0-9]{64}$/);
      expect(view.snapshotFingerprint).toMatch(/^snap-[a-f0-9]{64}$/);

      const exported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${view.id}/export`,
        headers: { cookie: dave },
      });
      expect(exported.statusCode).toBe(200);
      parseLabExportV2(JSON.parse(exported.body));

      const malformed = structuredClone(PACKAGE) as {
        packageId: string;
        taskFingerprint: string;
      };
      malformed.packageId = "pkg-malformed-fingerprint";
      malformed.taskFingerprint = "legacy-task-id";
      expect(parseExperimentPackage(malformed).taskFingerprint).toBe("legacy-task-id");
      const rejected = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: malformed,
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body).error).toMatch(/taskFingerprint.*SHA-256/);
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
      const exported = parseLabExportV2(JSON.parse(exportRes.body));
      expect(exported.privacyClass).toBe("share_safe");
      expect(exported.review.decision?.status).toBe("accepted");
      expect(exported.review.observations).toHaveLength(1);
      expect(exported.review.observations[0]?.candidateAlias).toBe("approach-1");
      expect(exported.review.omissions.participantIdentitiesIncluded).toBe(false);
      expect(exported.review.omissions.modelLabelsIncluded).toBe(false);
      expect(exported.review.omissions.freeTextIncluded).toBe(false);
      expect(exported.review.omissions.correlatableMetadataIncluded).toBe(false);
      expect(exported.review.gold).toBeNull();
      expect(exported.review.alignments.every((row) => row.status === "unknown")).toBe(true);
      expect(exported.review.caveats).toContain("agreement_not_correctness");
      expect(exported.review.caveats).toContain("gold_is_human_benchmark");
      expect(exported.comparison.caveats).toContain("agreement_not_correctness");
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
        "qwen-3.6-27b",
        '"reviewerUsername"',
        '"authorUsername"',
        "Cited the checkout timeout log as a symptom.",
        "Keep investigating the inventory timeout as a candidate cause.",
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

  it("withholds adversarial source prose and identities while keeping the synthetic export useful", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const privateEvidence = "db01.internal.example.com";
      const mutated = structuredClone(PACKAGE) as {
        packageId: string;
        candidates: { candidateId: string; modelLabel: string }[];
        agreement: {
          sharedAnchors: { evidenceRef: string; role: string }[];
          candidateSpecific: { evidenceRefs: string[] }[];
          roleConflicts: { evidenceRef: string; assignments: { role: string }[] }[];
          notes: string[];
        };
      };
      mutated.packageId = "https://lab.internal.example.com/private-package";
      mutated.candidates[0]!.modelLabel = "employer-model-private";
      mutated.agreement.sharedAnchors[0]!.evidenceRef = privateEvidence;
      mutated.agreement.sharedAnchors[0]!.role = "/Users/alice/employer/role.txt";
      mutated.agreement.candidateSpecific[0]!.evidenceRefs = [privateEvidence];
      mutated.agreement.roleConflicts[0]!.evidenceRef = privateEvidence;
      mutated.agreement.roleConflicts[0]!.assignments[0]!.role = "Bearer role-secret";
      mutated.agreement.notes.push("Employer incident INC-PRIVATE-7788 at /private/runbook.md");

      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: mutated,
      });
      expect(imported.statusCode).toBe(200);
      const experimentId = JSON.parse(imported.body).id as string;

      const observation = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/helpfulness`,
        headers: { cookie: alice },
        payload: {
          candidateId: mutated.candidates[0]!.candidateId,
          dimension: "actionability",
          score: 3,
          rationale: "See C:\\Users\\Alice\\employer\\incident.txt token=private-value",
          evidenceRefs: [privateEvidence],
        },
      });
      expect(observation.statusCode).toBe(200);

      const proposed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions`,
        headers: { cookie: alice },
        payload: {
          text: "Contact https://private.example.com/runbook before acting.",
          rationale: "request_id=req-private-123456 belongs to the employer incident.",
          evidenceRefs: [privateEvidence],
        },
      });
      expect(proposed.statusCode).toBe(200);
      const proposal = JSON.parse(proposed.body) as { id: string; revision: number };
      const accepted = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions/${proposal.id}/accept`,
        headers: { cookie: dave },
        payload: { expectedRevision: proposal.revision },
      });
      expect(accepted.statusCode).toBe(200);
      const acceptedDecision = JSON.parse(accepted.body) as { id: string; revision: number };

      const gold = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/gold`,
        headers: { cookie: dave },
        payload: {
          decisionId: acceptedDecision.id,
          expectedRevision: acceptedDecision.revision,
          evidenceAnchors: [privateEvidence],
          expectedRelationships: [
            { evidenceRef: privateEvidence, role: "file:///private/role" },
          ],
          notes: [
            GOLD_IS_HUMAN_BENCHMARK,
            "Employer-only gold note at /Users/alice/gold.txt",
          ],
        },
      });
      expect(gold.statusCode).toBe(200);

      const exportRes = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/export`,
        headers: { cookie: dave },
      });
      expect(exportRes.statusCode).toBe(200);
      const exported = parseLabExportV2(JSON.parse(exportRes.body));
      expect(exported.review.observations[0]?.score).toBe(3);
      expect(exported.review.decision?.status).toBe("accepted");
      expect(exported.review.gold?.version).toBe(1);
      expect(exported.review.agreement.sharedAnchors[0]?.evidenceAlias).toBe("evidence-1");
      expect(exported.review.candidates[0]?.candidateAlias).toBe("approach-1");

      const raw = exportRes.body as string;
      for (const privateValue of [
        "alice",
        "dave",
        "employer-model-private",
        "INC-PRIVATE-7788",
        "private.example.com",
        "internal.example.com",
        "/Users/",
        "/private/",
        "C:\\Users\\",
        "Bearer role-secret",
        "request_id",
        "token=private-value",
        '"modelLabel"',
        '"rationale"',
        '"text"',
        '"notes"',
      ]) {
        expect(raw).not.toContain(privateValue);
      }
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
      const exported = parseLabExportV2(JSON.parse(exportRes.body));
      expect(exported.review.gold?.version).toBe(2);
      expect(exported.review.gold?.goldAlias).toBe("gold-2");
      expect(exported.review.omissions.participantIdentitiesIncluded).toBe(false);
      expect(exported.review.caveats).toContain("gold_alignment_not_correctness");
      expect(exported.comparison.gold.status).toBe("present");
      const raw = exportRes.body as string;
      for (const token of [
        "rawModelCapture",
        '"prompt"',
        '"apiKey"',
        '"endpoint"',
        '"requestId"',
        "Bearer ",
        "ai-gateway.vercel.sh",
        '"promotedById"',
        '"promotedByUsername"',
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

const STRATEGY = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/strategy-package.converge.json"), "utf8"),
) as unknown;
const BENCH_ARTIFACT = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/bench-run-artifact.multi-strategy.json"),
    "utf8",
  ),
) as unknown;
const PLAIN = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/plain-transcript.incomplete.json"), "utf8"),
) as unknown;
const TRACE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/interaction-trace.programmatic.json"),
    "utf8",
  ),
) as unknown;
const CHAT_TRACE = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/interaction-trace.chat.json"), "utf8"),
) as unknown;

describe("interaction traces and strategy comparison", () => {
  it("preflights every strategy trace before persisting experiment state", async () => {
    await withApp(async ({ app, audit }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const malformed = structuredClone(STRATEGY) as {
        experiment: { packageId: string };
        traces: { rawHash: string | null }[];
      };
      malformed.experiment.packageId = "pkg-malformed-trace-preflight";
      malformed.traces[0]!.rawHash = "not-a-sha-256-digest";

      const rejected = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: malformed,
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body).error).toMatch(/rawHash.*SHA-256/);

      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
      });
      expect(JSON.parse(listed.body).experiments).toEqual([]);

      const timeline = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: token },
      });
      const events = (JSON.parse(timeline.body) as { events: { kind: string }[] }).events;
      expect(events.some((event) => event.kind === "experiment_imported")).toBe(false);
      expect(await audit.list({ action: "experiment_import" })).toEqual([]);
    });
  });

  it("imports a strategy package idempotently and projects question paths", async () => {
    await withApp(async ({ app }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const first = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: STRATEGY,
      });
      expect(first.statusCode).toBe(200);
      const view = JSON.parse(first.body) as {
        id: string;
        traces: { candidateId: string; sourceKind: string }[];
        comparison: {
          questionPaths: { candidateIds: string[] }[];
          sharedEvidence: { evidenceRef: string }[];
          notes: string[];
        };
      };
      expect(view.traces).toHaveLength(2);
      expect(view.comparison.questionPaths.length).toBeGreaterThan(1);
      expect(view.comparison.sharedEvidence.map((row) => row.evidenceRef).sort()).toEqual([
        "ev-demo-checkout-log",
        "ev-demo-inventory-timeout",
      ]);
      expect(view.comparison.notes).toContain("Textual similarity is not a winner.");

      const second = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: STRATEGY,
      });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).id).toBe(view.id);
      expect(JSON.parse(second.body).traces).toHaveLength(2);
    });
  });

  it("canonicalizes valid legacy trace metadata and rejects malformed digests before export", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const experiment = structuredClone(
        (STRATEGY as { experiment: Record<string, unknown> }).experiment,
      );
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: experiment,
      });
      expect(imported.statusCode).toBe(200);
      const experimentId = JSON.parse(imported.body).id as string;

      const legacy = structuredClone(CHAT_TRACE) as {
        rawHash: string;
        createdAt: string;
        events: { observedAt: { status: string; timestamp?: string }; excerptHash: string }[];
      };
      legacy.rawHash = legacy.rawHash.toUpperCase();
      legacy.createdAt = "2026-08-18T19:00:00-05:00";
      legacy.events[0]!.excerptHash = legacy.events[0]!.excerptHash.toUpperCase();
      legacy.events[0]!.observedAt = {
        status: "observed",
        timestamp: "2026-08-18T19:00:30-05:00",
      };
      const attached = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/traces`,
        headers: { cookie: alice },
        payload: legacy,
      });
      expect(attached.statusCode).toBe(200);
      const trace = JSON.parse(attached.body) as {
        rawHash: string;
        createdAt: string;
        events: { observedAt: { timestamp: string }; excerptHash: string }[];
      };
      expect(trace.rawHash).toMatch(/^[a-f0-9]{64}$/);
      expect(trace.createdAt).toBe("2026-08-19T00:00:00.000Z");
      expect(trace.events[0]?.observedAt.timestamp).toBe("2026-08-19T00:00:30.000Z");
      expect(trace.events[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/);

      const exported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/export`,
        headers: { cookie: dave },
      });
      expect(exported.statusCode).toBe(200);
      parseLabExportV2(JSON.parse(exported.body));

      const malformed = structuredClone(TRACE) as { rawHash: string | null };
      malformed.rawHash = "not-a-sha-256-digest";
      const rejected = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/traces`,
        headers: { cookie: alice },
        payload: malformed,
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body).error).toMatch(/rawHash.*SHA-256/);
    });
  });

  it("exports deliberately malformed legacy store metadata only through aliases and omissions", async () => {
    await withApp(async ({ app, experiments }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const envelope = parseExperimentPackage(
        (STRATEGY as { experiment: unknown }).experiment,
      );
      const row: ExperimentRow = {
        id: "legacy-experiment-row",
        caseId: created.id,
        packageId: "legacy-private-package-id",
        sourceSchemaId: envelope.schemaId,
        taskFingerprint: "legacy-malformed-task-fingerprint",
        snapshotFingerprint: "legacy-malformed-snapshot-fingerprint",
        candidates: envelope.candidates,
        agreement: envelope.agreement,
        createdAt: "legacy-malformed-created-at",
        importerId: "legacy-private-importer-id",
        importerUsername: "legacy-private-importer-username",
      };
      await experiments.insert(row);

      const trace = structuredClone(CHAT_TRACE) as InteractionTraceV1;
      trace.rawHash = "legacy-malformed-raw-hash";
      trace.createdAt = "legacy-malformed-trace-created-at";
      trace.efficiency.latency = { status: "observed", milliseconds: 91_234 };
      trace.events[0]!.excerptHash = "legacy-malformed-excerpt-hash";
      trace.events[0]!.observedAt = {
        status: "observed",
        timestamp: "legacy-malformed-observed-at",
      };
      await experiments.insertTrace(row.id, trace, "legacy-malformed-storage-fingerprint");

      const exportedResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${row.id}/export`,
        headers: { cookie: dave },
      });
      expect(exportedResponse.statusCode).toBe(200);
      const exported = parseLabExportV2(JSON.parse(exportedResponse.body));
      expect(exported.review.taskAlias).toBe("task-1");
      expect(exported.review.snapshotAlias).toBe("snapshot-1");
      expect(exported.review.omissions.correlatableMetadataIncluded).toBe(false);
      expect(
        exported.review.candidates.every(
          (candidate) => candidate.observedLatency.status === "unknown",
        ),
      ).toBe(true);
      expect(exported.traces[0]?.efficiency.latency.status).toBe("unknown");
      expect(
        exported.comparison.efficiency.every(
          (candidate) => candidate.efficiency.latency.status === "unknown",
        ),
      ).toBe(true);

      const raw = exportedResponse.body;
      for (const privateValue of [
        "legacy-private-package-id",
        "legacy-malformed-task-fingerprint",
        "legacy-malformed-snapshot-fingerprint",
        "legacy-malformed-created-at",
        "legacy-private-importer",
        "legacy-malformed-raw-hash",
        "legacy-malformed-trace-created-at",
        "legacy-malformed-excerpt-hash",
        "legacy-malformed-observed-at",
        '"milliseconds"',
        '"rawHash"',
        '"excerptHash"',
        '"createdAt"',
        '"observedAt"',
      ]) {
        expect(raw).not.toContain(privateValue);
      }
    });
  });

  it("imports a plain transcript as unknown structure and accepts a human annotation", async () => {
    await withApp(async ({ app }) => {
      const token = await login(app, "alice", ALICE);
      const created = await createCase(app, token);
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: STRATEGY,
      });
      const experimentId = JSON.parse(imported.body).id as string;
      const plain = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/traces`,
        headers: { cookie: token },
        payload: PLAIN,
      });
      expect(plain.statusCode).toBe(409);
      const incomplete = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: token },
        payload: JSON.parse(
          readFileSync(
            join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
            "utf8",
          ),
        ),
      });
      const otherId = JSON.parse(incomplete.body).id as string;
      const attached = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${otherId}/traces`,
        headers: { cookie: token },
        payload: { schemaId: "cd-collab.plain_transcript.v1", candidateId: "cand-qwen-3.6-27b", text: (PLAIN as { text: string }).text },
      });
      expect(attached.statusCode).toBe(200);
      const trace = JSON.parse(attached.body) as {
        completeness: string;
        unknowns: string[];
        events: { actor: string; authorUsername?: string }[];
      };
      expect(trace.completeness).toBe("unknown");
      expect(trace.unknowns).toEqual(expect.arrayContaining(["turns", "tools"]));
      expect(trace.events[0]?.actor).toBe("unknown");

      const annotated = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${otherId}/traces/cand-qwen-3.6-27b/annotations`,
        headers: { cookie: token },
        payload: { text: "Human: inventory timeout is the useful lead.", evidenceRefs: ["ev-demo-inventory-timeout"] },
      });
      expect(annotated.statusCode).toBe(200);
      expect(JSON.parse(annotated.body).events.at(-1).kind).toBe("human_annotation");
      expect(JSON.parse(annotated.body).events.at(-1).authorUsername).toBe("alice");
    });
  });

  it("rejects a conflicting trace and exports share-safe comparison", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: STRATEGY,
      });
      const experimentId = JSON.parse(imported.body).id as string;
      const conflict = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/traces`,
        headers: { cookie: alice },
        payload: { ...(TRACE as object), events: [] },
      });
      expect(conflict.statusCode).toBe(409);

      const exportRes = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/export`,
        headers: { cookie: dave },
      });
      expect(exportRes.statusCode).toBe(200);
      const exported = parseLabExportV2(JSON.parse(exportRes.body));
      expect(exported.traces).toHaveLength(2);
      expect(exported.comparison.questionPaths.length).toBeGreaterThan(1);
      expect(exported.traces.every((trace) => trace.excerptsIncluded === false)).toBe(true);
      expect(exported.traces.every((trace) => trace.efficiency.latency.status === "unknown")).toBe(true);
      const raw = exportRes.body as string;
      expect(raw).not.toContain("ai-gateway.vercel.sh");
      expect(raw).not.toContain("rawModelCapture");
      expect(raw).not.toContain('"prompt"');
      expect(raw).not.toContain('"rawHash"');
      expect(raw).not.toContain('"excerptHash"');
      expect(raw).not.toContain('"createdAt"');
      expect(raw).not.toContain('"observedAt"');
      expect(raw).not.toContain('"milliseconds"');
      expect(raw).not.toContain('"taskFingerprint"');
      expect(raw).not.toContain('"snapshotFingerprint"');
      expect(raw).not.toContain("Which inventory call is blocking checkout?");
      expect(raw).not.toContain("programmatic-agent");
    });
  });

  it("imports a hermetic bench-run artifact, accepts a decision, and keeps share-safe export fail-closed", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice);
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: BENCH_ARTIFACT,
      });
      expect(imported.statusCode).toBe(200);
      const view = JSON.parse(imported.body) as {
        id: string;
        packageId: string;
        candidates: { modelLabel: string; goldState: string; cost: { status: string }; usage: { status: string } }[];
        agreement: { sharedAnchors: { evidenceRef: string }[]; notes: string[] };
        traces: { completeness: string; unknowns: string[] }[];
        comparison: { sharedEvidence: unknown[] };
      };
      expect(view.packageId).toBe("pkg-synth-bench-multi-strategy-v1");
      expect(view.candidates.map((c) => c.modelLabel)).toEqual([
        "qwen-3.6-27b",
        "gpt-oss-120b",
        "ministral-3-14b-instruct-2512",
      ]);
      expect(view.candidates.every((c) => c.goldState === "unknown")).toBe(true);
      expect(view.candidates.every((c) => c.cost.status === "unknown")).toBe(true);
      expect(view.candidates.every((c) => c.usage.status === "unknown")).toBe(true);
      expect(view.traces).toHaveLength(3);
      expect(view.traces.every((trace) => trace.completeness === "partial")).toBe(true);
      expect(
        view.agreement.sharedAnchors.some((row) => row.evidenceRef === "ev-demo-checkout-log"),
      ).toBe(true);
      expect(view.comparison.sharedEvidence.length).toBeGreaterThan(0);

      const proposed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${view.id}/decisions`,
        headers: { cookie: alice },
        payload: {
          text: "Treat inventory timeout as the human-accepted cause for this synthetic bench import.",
          rationale: "Human decision after reviewing converted lanes; not a gold claim yet.",
          evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
        },
      });
      expect(proposed.statusCode).toBe(200);
      const proposal = JSON.parse(proposed.body) as { id: string; revision: number };
      const accepted = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${view.id}/decisions/${proposal.id}/accept`,
        headers: { cookie: dave },
        payload: { expectedRevision: proposal.revision },
      });
      expect(accepted.statusCode).toBe(200);

      const exportRes = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${view.id}/export`,
        headers: { cookie: dave },
      });
      expect(exportRes.statusCode).toBe(200);
      const exported = parseLabExportV2(JSON.parse(exportRes.body));
      expect(exported.privacyClass).toBe("share_safe");
      expect(exported.traces).toHaveLength(3);
      expect(exported.review.candidates).toHaveLength(3);
      const raw = exportRes.body as string;
      expect(raw).not.toContain("DeepSeek");
      expect(raw).not.toContain("ai-gateway.vercel.sh");
      expect(raw).not.toContain("qwen-3.6-27b");
      expect(raw).not.toContain('"prompt"');
      expect(raw).not.toContain("bearer ");
    });
  });
});
