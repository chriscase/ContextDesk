import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { testConfig } from "./config.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { MemoryAuditStore } from "./modules/audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  HmacPublicIdentityCodec,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "./modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "./modules/authz/index.js";
import { CatalogService, MemoryCatalogStore } from "./modules/catalog/index.js";
import { CaseService, MemoryCaseStore } from "./modules/cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./modules/experiments/index.js";
import { EntityService } from "./modules/entities/index.js";
import { ExportService, testExportPrivacyConfig } from "./modules/export/index.js";
import { ImportService, MemoryRunStore } from "./modules/import/index.js";
import {
  createLogTimeCasePort,
  logTimeBridgeOptions,
  LogTimeService,
  MemoryLogTimeStore,
  ProcessLogTimeBridge,
  type LogTimeBridge,
} from "./modules/log-time/index.js";
import {
  memoryApplyBoundary,
  MemoryPortableApplyStateStore,
  PortableInvestigationService,
} from "./modules/portable-investigations/index.js";
import {
  MemoryTriageJobStore,
  loadConfiguredTriageProfileCatalog,
  RustBridgeTriageExecutor,
  TriageRunService,
  type TriageBatchRunExecutor,
  type TriageProfileOption,
  type RustBridgeTriageExecutorOptions,
} from "./modules/triage-runs/index.js";
import { PresenceService } from "./modules/presence/index.js";
import { ReferenceService } from "./modules/references/index.js";
import { ResolutionService } from "./modules/resolutions/index.js";
import { syntheticComponentHealth } from "./modules/component-health/index.js";
import type { ComponentHealthProjectorInputV1 } from "@cd-collab/contracts";
import type { SetupService } from "./modules/setup/index.js";

export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "contracts", "fixtures");
const demoRoleMap = "cn=demo-admins,ou=groups,dc=example,dc=test=admin";
const demoTaskIdentity = "demo-checkout-v1";

interface DemoApp {
  app: FastifyInstance;
  caseId: string;
  evidenceRoot: string;
}

interface DemoAppOptions {
  staticDir?: string | null;
  /** Explicit opt-in host bridge for a local, memory-backed live rehearsal. */
  gatewayRunner?: RustBridgeTriageExecutorOptions;
  /** Deterministic test seam for the same gateway orchestration path. */
  gatewayExecutor?: TriageBatchRunExecutor;
  /** Optional trusted local timestamp pipeline; never contacts a provider. */
  logTimeBridge?: LogTimeBridge;
  /** Safe profile metadata paired with a test gateway executor. */
  triageProfiles?: TriageProfileOption[];
  /** Test seam for proving construction-failure cleanup; production uses buildApp. */
  appBuilder?: typeof buildApp;
  /** Test observer for the temporary root created before app construction. */
  onEvidenceRootCreated?: (root: string) => void;
  /** Explicit setup host seam for first-run UI qualification. */
  setup?: SetupService;
  componentHealth?: ComponentHealthProjectorInputV1;
}

function demoUsers() {
  return new Map([
    [
      DEMO_USERNAME,
      {
        password: DEMO_PASSWORD,
        identity: {
          id: "uid=demo,ou=people,dc=example,dc=test",
          username: DEMO_USERNAME,
          displayName: "Demo administrator",
        },
        groups: ["cn=demo-admins,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function fixture(name: string): Promise<object> {
  const parsed = JSON.parse(await readFile(join(fixtureRoot, name), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`synthetic demo fixture must be an object: ${name}`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bindDemoExperimentEnvelope(
  envelope: object,
  snapshotFingerprint: string,
  taskFingerprint: string,
  evidenceIds: Readonly<Record<string, string>>,
  candidateIds: Readonly<Record<string, string>>,
): object {
  const seedIds = { ...evidenceIds, ...candidateIds };
  const retargetSeedIds = (value: unknown): unknown => {
    if (typeof value === "string") return seedIds[value] ?? value;
    if (Array.isArray(value)) return value.map(retargetSeedIds);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, row]) => [
          key,
          retargetSeedIds(row),
        ]),
      );
    }
    return value;
  };
  const clone = retargetSeedIds(structuredClone(envelope)) as Record<string, unknown>;
  const binding = { snapshotFingerprint, taskFingerprint };
  if (clone.schemaId !== "cd-collab.strategy_package.v1") {
    return { ...clone, ...binding };
  }
  if (typeof clone.experiment !== "object" || clone.experiment === null || Array.isArray(clone.experiment)) {
    throw new Error("synthetic demo strategy fixture must contain an experiment object");
  }
  return {
    ...clone,
    experiment: { ...(clone.experiment as Record<string, unknown>), ...binding },
  };
}

async function okJson<T>(
  app: FastifyInstance,
  input: {
    method: "GET" | "POST";
    url: string;
    cookie?: string;
    payload?: object;
  },
): Promise<T> {
  const response = await app.inject({
    method: input.method,
    url: input.url,
    ...(input.cookie ? { headers: { cookie: input.cookie } } : {}),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `synthetic demo seed failed: ${input.method} ${input.url} returned ${response.statusCode}: ${response.body}`,
    );
  }
  return JSON.parse(response.body) as T;
}

async function seedReviewedExperiment(
  app: FastifyInstance,
  cookie: string,
  caseId: string,
  envelope: object,
  evidenceIds: Readonly<Record<string, string>>,
  candidateIds: Readonly<Record<string, string>>,
  observations: {
    candidateId: string;
    dimension: string;
    score: number;
    rationale: string;
    evidenceRefs: string[];
  }[],
  decision: { text: string; rationale: string; evidenceRefs: string[] },
): Promise<string> {
  const imported = await okJson<{ id: string }>(app, {
    method: "POST",
    url: `/api/cases/${caseId}/experiments`,
    cookie,
    payload: envelope,
  });
  for (const observation of observations) {
    await okJson(app, {
      method: "POST",
      url: `/api/cases/${caseId}/experiments/${imported.id}/helpfulness`,
      cookie,
      payload: {
        ...observation,
        candidateId: candidateIds[observation.candidateId] ?? observation.candidateId,
        evidenceRefs: observation.evidenceRefs.map((id) => evidenceIds[id] ?? id),
      },
    });
  }
  const proposed = await okJson<{ id: string; revision: number }>(app, {
    method: "POST",
    url: `/api/cases/${caseId}/experiments/${imported.id}/decisions`,
    cookie,
    payload: {
      ...decision,
      evidenceRefs: decision.evidenceRefs.map((id) => evidenceIds[id] ?? id),
    },
  });
  const accepted = await okJson<{ id: string; revision: number }>(app, {
    method: "POST",
    url: `/api/cases/${caseId}/experiments/${imported.id}/decisions/${proposed.id}/accept`,
    cookie,
    payload: { expectedRevision: proposed.revision },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${caseId}/experiments/${imported.id}/gold`,
    cookie,
    payload: {
      decisionId: accepted.id,
      expectedRevision: accepted.revision,
      evidenceAnchors: [
        evidenceIds["ev-demo-checkout-log"],
        evidenceIds["ev-demo-inventory-timeout"],
      ],
      expectedRelationships: [
        { evidenceRef: evidenceIds["ev-demo-checkout-log"], role: "symptom" },
        { evidenceRef: evidenceIds["ev-demo-inventory-timeout"], role: "cause" },
      ],
      helpfulnessDimensions: ["evidence_support", "actionability"],
      notes: ["Synthetic demo benchmark. Not live provider output."],
    },
  });
  return imported.id;
}

/**
 * Synthetic evidence bodies for the demo investigation.
 *
 * These are fabricated for the fixture: fictional service names, fictional
 * order identifiers, and a fictional stack trace. They are deliberately
 * multi-line so the shipped demo shows the surrounding context and failing
 * frames an engineer actually reads, not a one-line summary.
 */
const DEMO_CHECKOUT_LOG = [
  "2026-08-24T06:14:18Z checkout-service INFO synthetic order syn-4412 accepted",
  "2026-08-24T06:14:19Z checkout-service INFO reserving synthetic inventory for syn-4412",
  "2026-08-24T06:14:20Z checkout-service WARN synthetic request syn-4412 waited 10000ms on inventory-client",
  "2026-08-24T06:14:21Z checkout-service WARN synthetic request syn-4412 waited 20000ms on inventory-client",
  "2026-08-24T06:14:22Z checkout-service WARN synthetic request syn-4412 exceeded 30000ms while waiting for inventory-client",
  "2026-08-24T06:14:22Z checkout-service ERROR synthetic order syn-4412 abandoned after timeout",
  "2026-08-24T06:14:23Z checkout-service INFO synthetic order syn-4413 accepted",
].join("\n") + "\n";

const DEMO_INVENTORY_LOG = [
  "2026-08-24T06:14:20Z inventory-client INFO synthetic lookup started for syn-4412",
  "2026-08-24T06:14:22Z inventory-client ERROR TimeoutError: synthetic inventory lookup exceeded 30000ms",
  "    at InventoryClient.fetch (fixtures/inventory-client.ts:118:15)",
  "    at CheckoutSession.reserve (fixtures/checkout-session.ts:64:22)",
  "    at async CheckoutHandler.submit (fixtures/checkout-handler.ts:31:5)",
  "2026-08-24T06:14:22Z inventory-client WARN synthetic client pool had no free connection for 30000ms",
].join("\n") + "\n";

const DEMO_POOL_LOG = [
  "2026-08-24T06:14:15Z connection-pool INFO active=22 idle=18 queued=0",
  "2026-08-24T06:14:18Z connection-pool WARN active=36 idle=4 queued=3",
  "2026-08-24T06:14:21Z connection-pool WARN active=40 idle=0 queued=17",
  "2026-08-24T06:14:22Z connection-pool ERROR synthetic pool saturated; no connection released for 30000ms",
  "2026-08-24T06:14:26Z connection-pool INFO active=31 idle=9 queued=0",
].join("\n") + "\n";

/**
 * Fixture material for the scenarios beside the model-comparison case.
 *
 * The demo showed exactly one investigation, and it was the most elaborate
 * kind the product supports: three model lanes, two experiments, gold scoring,
 * transcripts. Anyone opening the demo learned that a War Room investigation
 * means a model comparison — which is the opposite of what the product claims,
 * since a case resolved by a person reading notes is a first-class outcome
 * with its own contract (`investigation-resolution.ts`).
 *
 * So the demo now also shows the ordinary shapes: a case whose whole record is
 * human notes, one whose evidence is pasted correspondence rather than logs,
 * and one that is closed and filed away. Each is small on purpose — they exist
 * to show that the shape is legitimate, not to compete with the primary case.
 *
 * Everything here is synthetic: invented systems, invented people at
 * example.test, invented timestamps. Nothing is derived from a real
 * investigation, a real customer, or a real address.
 */
const DEMO_MAILER_LOG = [
  "2026-08-19T21:02:11Z mailer-worker INFO synthetic queue drain started depth=1840",
  "2026-08-19T21:02:44Z mailer-worker WARN synthetic queue depth rising depth=2610 drained=0",
  "2026-08-19T21:03:02Z mailer-worker ERROR synthetic worker restarted while holding 2610 queued messages",
  "2026-08-19T21:07:55Z mailer-worker INFO synthetic queue drain resumed depth=2610",
].join("\n") + "\n";

const DEMO_SUPPORT_EMAIL = [
  "From: operations@fixture-northwind.example.test",
  "To: oncall@example.test",
  "Date: Wed, 19 Aug 2026 21:31:00 +0000",
  "Subject: Synthetic report — overnight statements never arrived",
  "",
  "Our overnight statement run reported success but no statements reached",
  "recipients. Nothing was changed on our side this week. The fixture",
  "operations group noticed at the 21:30 check.",
  "",
  "-- Synthetic fixture correspondence; no real sender or recipient.",
].join("\r\n") + "\r\n";

const DEMO_CHAT_EXCERPT = [
  "[2026-08-19 21:34] fixture-oncall: statements job says success, nothing delivered",
  "[2026-08-19 21:36] fixture-platform: mailer worker restarted around 21:03, queue never drained",
  "[2026-08-19 21:41] fixture-oncall: so the job succeeded and the delivery stage silently dropped it?",
  "[2026-08-19 21:43] fixture-platform: that matches the restart window. nothing else touched that path.",
].join("\n") + "\n";

/**
 * A second investigation whose evidence is correspondence, not logs.
 *
 * Shows the email and chat capture path, and closes on a human-only
 * resolution: a person read the report, matched it to a restart window, and
 * wrote down what they concluded and what stayed unknown. No model ran.
 */
async function seedCorrespondenceCase(
  app: FastifyInstance,
  cookie: string,
  sourceId: string,
): Promise<string> {
  const created = await okJson<{ id: string }>(app, {
    method: "POST",
    url: "/api/cases",
    cookie,
    payload: {
      title: "Overnight statements reported sent but never arrived",
      severity: "medium",
      problemStatement:
        "A synthetic statement run reported success while no statement reached a recipient.",
      affectedParties: "Fixture Northwind operations group and their statement recipients",
      impact: "One synthetic overnight statement cycle was not delivered.",
      scope:
        "The recorded fixture covers the reported symptom, one mailer log, and the chat that followed. Delivery-provider records are not available here.",
      openQuestions: [
        "Did the delivery stage report success independently of the queue actually draining?",
        "Which statement recipients were affected in the fixture window?",
      ],
      // Recorded the evening it happened, before anyone opened the case.
      occurredAt: "2026-08-19T21:30:00Z",
    },
  });

  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "email",
      filename: "reported-symptom.eml",
      mediaType: "message/rfc822",
      contentBase64: Buffer.from(DEMO_SUPPORT_EMAIL).toString("base64"),
      summary:
        "Synthetic report from the fixture operations group: statement run reported success, nothing delivered.",
      sourceId,
      privacyClass: "share_safe",
    },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "attachment",
      filename: "oncall-chat.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from(DEMO_CHAT_EXCERPT).toString("base64"),
      summary: "Synthetic on-call chat excerpt pasted into the investigation as recorded context.",
      sourceId,
      privacyClass: "share_safe",
    },
  });
  const mailerLog = await okJson<{ artifact: { id: string } }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "log",
      filename: "mailer-worker.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from(DEMO_MAILER_LOG).toString("base64"),
      summary: "Synthetic mailer-worker log across the restart and the undrained queue.",
      sourceId,
      privacyClass: "share_safe",
    },
  });

  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/contributions`,
    cookie,
    payload: {
      kind: "hypothesis",
      body:
        "The statement job reported success for enqueueing, not for delivery, so a worker restart during the drain lost the batch silently.",
      privacyClass: "share_safe",
      hypothesisStatus: "supported",
      hypothesisLinks: [{ kind: "artifact", id: mailerLog.artifact.id }],
      sourceId,
    },
  });

  return created.id;
}

/**
 * A third investigation carrying nothing but human notes.
 *
 * No evidence file, no run, no snapshot — the record is what people wrote
 * down. This is the shape a historical or hand-reconstructed investigation
 * takes, and the demo previously had no example of it at all.
 *
 * It is also the backfill example: the work happened well before it was
 * written down, so `occurredAt` sits far behind the recording clock and the
 * surface labels it as historical rather than implying it happened today.
 */
async function seedHumanOnlyCase(app: FastifyInstance, cookie: string): Promise<string> {
  const created = await okJson<{ id: string }>(app, {
    method: "POST",
    url: "/api/cases",
    cookie,
    payload: {
      title: "Reconstructed: batch cutover stall (historical notes only)",
      severity: "low",
      problemStatement:
        "A synthetic overnight batch cutover stalled. Reconstructed from a hand-written on-call notebook; no machine records survive.",
      affectedParties: "Fixture batch operations rota",
      impact: "One synthetic overnight cycle ran late. No data was lost.",
      scope:
        "Everything recorded here is a person's recollection written down later. There is no log, no export, and no way to verify the timings.",
      openQuestions: ["Was the stall ever reproduced after the fixture cutover?"],
      // Only the day is known. Deliberately no time and no zone: the notebook
      // said "4 November", and inventing an offset would invent a fact.
      occurredAt: "2024-11-04",
    },
  });

  for (const note of [
    "Notebook, page 12: cutover started late because the preceding job had not released its lock.",
    "Notebook, page 13: operator waited for the lock rather than forcing it. Cycle completed roughly ninety minutes late.",
    "Recollection, recorded now: nobody wrote down which job held the lock, and the fixture system was decommissioned before this tool existed.",
  ]) {
    await okJson(app, {
      method: "POST",
      url: `/api/cases/${created.id}/contributions`,
      cookie,
      payload: { kind: "note", body: note, privacyClass: "share_safe" },
    });
  }

  return created.id;
}

/**
 * A fourth investigation that is finished and filed away.
 *
 * Exists so the archived state is visible in the demo at all: without one,
 * the archive control, the hidden-archived notice, and the restore path have
 * nothing to act on until the operator archives something themselves.
 */
async function seedArchivedCase(app: FastifyInstance, cookie: string): Promise<string> {
  const created = await okJson<{ id: string }>(app, {
    method: "POST",
    url: "/api/cases",
    cookie,
    payload: {
      title: "Duplicate report of the synthetic checkout timeouts",
      severity: "low",
      problemStatement:
        "A second synthetic report of the same checkout timeout, opened before the first was found.",
      affectedParties: "Fixture storefront operators",
      impact: "None beyond the original report.",
      scope: "Superseded by the primary checkout investigation.",
      occurredAt: "2026-08-24T07:05:00Z",
    },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/contributions`,
    cookie,
    payload: {
      kind: "note",
      body: "Closing this as a duplicate: the primary checkout investigation already holds the evidence.",
      privacyClass: "share_safe",
    },
  });
  // Monitoring first, so restoring it demonstrates the recorded prior status
  // rather than the `open` fallback.
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/status`,
    cookie,
    payload: { status: "monitoring" },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/status`,
    cookie,
    payload: { status: "archived" },
  });
  return created.id;
}

async function seed(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
  });
  if (login.statusCode !== 200) {
    throw new Error(`synthetic demo login seed failed: ${login.body}`);
  }
  const cookie = sessionCookie(login.headers);
  const created = await okJson<{ id: string }>(app, {
    method: "POST",
    url: "/api/cases",
    cookie,
    payload: {
      title: "Checkout timeouts — model and strategy comparison",
      severity: "high",
      problemStatement:
        "Synthetic checkout requests time out while waiting for the inventory service.",
      affectedParties: "Fixture storefront operators and synthetic checkout users",
      impact:
        "Synthetic checkout attempts do not complete within the expected service window.",
      scope:
        "The recorded fixture covers checkout-to-inventory calls; payment processing is outside the available evidence.",
      openQuestions: [
        "Did inventory pool pressure begin before checkout latency increased?",
        "Does the timeout reproduce when the fixture worker pool is isolated?",
      ],
    },
  });

  const source = await okJson<{ id: string }>(app, {
    method: "POST",
    url: "/api/catalog/sources",
    cookie,
    payload: {
      name: "Synthetic chat triage",
      kind: "external-tool",
      description: "Fixture transcript standing in for a pasted external chat",
    },
  });

  const checkoutEvidence = await okJson<{ artifact: { id: string } }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from(DEMO_CHECKOUT_LOG).toString("base64"),
      summary: "Synthetic checkout log: order syn-4412 waits on the inventory call, then times out.",
      sourceId: source.id,
      privacyClass: "share_safe",
    },
  });
  const inventoryEvidence = await okJson<{ artifact: { id: string } }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "log",
      filename: "inventory-timeout.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from(DEMO_INVENTORY_LOG).toString("base64"),
      summary: "Synthetic inventory-client trace: the failing frames for the timed-out lookup.",
      sourceId: source.id,
      privacyClass: "share_safe",
    },
  });
  const poolEvidence = await okJson<{ artifact: { id: string } }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/evidence`,
    cookie,
    payload: {
      kind: "log",
      filename: "connection-pool.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from(DEMO_POOL_LOG).toString("base64"),
      summary: "Synthetic connection-pool counters across the timeout window.",
      sourceId: source.id,
      privacyClass: "share_safe",
    },
  });
  const demoEvidenceIds = {
    "ev-demo-checkout-log": checkoutEvidence.artifact.id,
    "ev-demo-inventory-timeout": inventoryEvidence.artifact.id,
    "ev-demo-pool-exhaustion": poolEvidence.artifact.id,
  } as const;
  const demoCandidateIds = {
    "cand-qwen-3.6-27b": "qwen-reviewer",
    "cand-gpt-oss-120b": "gpt-oss-contributor",
    "cand-ministral-14b": "ministral-challenger",
    "cand-programmatic-agent": "programmatic-agent",
    "cand-chat-operator": "chat-operator",
  } as const;
  for (const body of [
    "Inventory timeout is the leading cause to investigate.",
    "Checkout and inventory pool pressure should be investigated together.",
  ]) {
    await okJson(app, {
      method: "POST",
      url: `/api/cases/${created.id}/contributions`,
      cookie,
      payload: {
        kind: "hypothesis",
        body,
        privacyClass: "share_safe",
        hypothesisStatus: "supported",
        hypothesisLinks: [
          { kind: "artifact", id: inventoryEvidence.artifact.id },
          { kind: "artifact", id: checkoutEvidence.artifact.id },
        ],
        sourceId: source.id,
      },
    });
  }
  const demoSnapshot = await okJson<{ id: string; fingerprint: string }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/snapshots`,
    cookie,
    payload: {
      evidenceIds: [
        checkoutEvidence.artifact.id,
        inventoryEvidence.artifact.id,
        poolEvidence.artifact.id,
      ],
      visibility: "owner_only",
      protocolVersion: "synthetic-demo-v1",
    },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/imports`,
    cookie,
    payload: {
      outputText:
        "The checkout log and inventory timeout point to inventory-client exhaustion; verify pool pressure before changing timeouts.",
      promptText: "What timed out in checkout, and what should we inspect next?",
      sourceId: source.id,
      operatorId: "synthetic-operator",
      operatorUsername: "demo-operator",
      evidenceVisibility: "importer_described",
      visibilityNote: "Synthetic fixture; no private or live-provider data.",
      snapshotBinding: demoSnapshot.fingerprint,
      redacted: true,
      privacyClass: "share_safe",
    },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/triage-runs`,
    cookie,
    payload: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: demoSnapshot.id,
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard.synthetic-demo",
      question: "What caused the checkout timeout and what should we inspect next?",
      policyFingerprint: null,
      taskFingerprint: demoTaskIdentity,
      candidates: [
        { candidateId: demoCandidateIds["cand-qwen-3.6-27b"], role: "reviewer", provider: "synthetic", profileId: null, model: "qwen-3.6-27b", version: null },
        { candidateId: demoCandidateIds["cand-gpt-oss-120b"], role: "contributor", provider: "synthetic", profileId: null, model: "gpt-oss-120b", version: null },
        { candidateId: demoCandidateIds["cand-ministral-14b"], role: "challenger", provider: "synthetic", profileId: null, model: "ministral-3-14b-instruct-2512", version: null },
      ],
    },
  });
  await okJson(app, {
    method: "POST",
    url: `/api/cases/${created.id}/triage-runs`,
    cookie,
    payload: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: demoSnapshot.id,
      mode: "deterministic_mock",
      strategyId: "contextdesk.strategy-paths.synthetic-demo",
      question: "How do the fictional programmatic and chat investigation paths compare?",
      policyFingerprint: null,
      taskFingerprint: demoTaskIdentity,
      candidates: [
        { candidateId: demoCandidateIds["cand-programmatic-agent"], role: "contributor", provider: "synthetic", profileId: null, model: "programmatic-agent", version: null },
        { candidateId: demoCandidateIds["cand-chat-operator"], role: "reviewer", provider: "synthetic", profileId: null, model: "chat-operator", version: null },
      ],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const experimentSnapshotFingerprint = `snap-${demoSnapshot.fingerprint}`;
  const experimentTaskFingerprint = `task-${sha256(demoTaskIdentity)}`;

  const primaryExperimentId = await seedReviewedExperiment(
    app,
    cookie,
    created.id,
    bindDemoExperimentEnvelope(
      await fixture("experiment-package.valid.json"),
      experimentSnapshotFingerprint,
      experimentTaskFingerprint,
      demoEvidenceIds,
      demoCandidateIds,
    ),
    demoEvidenceIds,
    demoCandidateIds,
    [
      {
        candidateId: "cand-qwen-3.6-27b",
        dimension: "evidence_support",
        score: 3,
        rationale: "Connected the checkout symptom to the inventory timeout with explicit evidence.",
        evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      },
      {
        candidateId: "cand-gpt-oss-120b",
        dimension: "actionability",
        score: 2,
        rationale: "Surfaced pool exhaustion as a useful next check without overstating certainty.",
        evidenceRefs: ["ev-demo-pool-exhaustion"],
      },
      {
        candidateId: "cand-ministral-14b",
        dimension: "uncertainty_calibration",
        score: 2,
        rationale: "Correctly kept the root cause provisional when only the shared symptom was supported.",
        evidenceRefs: ["ev-demo-checkout-log"],
      },
    ],
    {
      text: "Treat inventory-client timeout and pool pressure as the benchmark investigation path.",
      rationale:
        "The accepted path combines the shared checkout symptom with the strongest candidate-specific cause evidence.",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
  );

  const syntheticTraceTranscripts = [
    {
      candidateId: demoCandidateIds["cand-qwen-3.6-27b"],
      text:
        "Human: Determine why the fictional checkout request timed out.\n" +
        `Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms while waiting for inventory-client; evidence ${demoEvidenceIds["ev-demo-checkout-log"]}\n` +
        `Tool: 2026-08-24T06:14:22Z inventory-client ERROR TimeoutError: inventory lookup exceeded 30000ms at InventoryClient.fetch (inventory-client.ts:118); evidence ${demoEvidenceIds["ev-demo-inventory-timeout"]}\n` +
        "Assistant: The checkout timeout is recorded by all lanes. This lane treats the inventory-client timeout as the leading cause, pending pool and network measurements.",
    },
    {
      candidateId: demoCandidateIds["cand-gpt-oss-120b"],
      text:
        "Human: Compare the fictional checkout and connection-pool signals.\n" +
        `Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms; evidence ${demoEvidenceIds["ev-demo-checkout-log"]}\n` +
        `Tool: 2026-08-24T06:14:21Z connection-pool WARN active=40 idle=0 queued=17; evidence ${demoEvidenceIds["ev-demo-pool-exhaustion"]}\n` +
        "Assistant: Pool exhaustion is a plausible upstream contributor. Inspect pool wait duration and dependency latency before declaring a root cause.",
    },
    {
      candidateId: demoCandidateIds["cand-ministral-14b"],
      text:
        "Human: State only what the fictional checkout record establishes.\n" +
        `Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms while awaiting a dependency; evidence ${demoEvidenceIds["ev-demo-checkout-log"]}\n` +
        "Assistant: The timeout symptom is established. The record is not sufficient to choose between dependency latency, pool pressure, or another cause.",
    },
  ];
  for (const trace of syntheticTraceTranscripts) {
    await okJson(app, {
      method: "POST",
      url: `/api/cases/${created.id}/experiments/${primaryExperimentId}/traces`,
      cookie,
      payload: {
        schemaId: "cd-collab.plain_transcript.v1",
        candidateId: trace.candidateId,
        text: trace.text,
      },
    });
  }

  await seedReviewedExperiment(
    app,
    cookie,
    created.id,
    bindDemoExperimentEnvelope(
      await fixture("strategy-package.converge.json"),
      experimentSnapshotFingerprint,
      experimentTaskFingerprint,
      demoEvidenceIds,
      demoCandidateIds,
    ),
    demoEvidenceIds,
    demoCandidateIds,
    [
      {
        candidateId: "cand-programmatic-agent",
        dimension: "evidence_support",
        score: 3,
        rationale: "The structured path records evidence discovery and preserves tool provenance.",
        evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      },
      {
        candidateId: "cand-chat-operator",
        dimension: "actionability",
        score: 2,
        rationale: "The chat path asked a different question but converged on the same useful lead.",
        evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      },
    ],
    {
      text: "Both interaction strategies converge on inventory timeout as the next investigation target.",
      rationale:
        "Different question paths can be compared by evidence discovery, helpfulness, and gold convergence rather than wording.",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
  );

  // Seeded after the primary case so the inventory opens with the elaborate
  // investigation first and the ordinary shapes beside it, rather than
  // teaching a first-time reader that every case looks like a model bake-off.
  await seedCorrespondenceCase(app, cookie, source.id);
  await seedHumanOnlyCase(app, cookie);
  await seedArchivedCase(app, cookie);

  return created.id;
}

export async function buildDemoApp(options: DemoAppOptions = {}): Promise<DemoApp> {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "contextdesk-synthetic-demo-"));
  options.onEvidenceRootCreated?.(evidenceRoot);
  const evidence = new FilesystemEvidenceStore({ rootDir: evidenceRoot });
  const audit = new MemoryAuditStore();
  const caseStore = new MemoryCaseStore();
  const catalogStore = new MemoryCatalogStore();
  const runStore = new MemoryRunStore();
  const experimentStore = new MemoryExperimentStore();
  const jobStore = new MemoryTriageJobStore();
  const applyState = new MemoryPortableApplyStateStore();
  const catalog = new CatalogService(catalogStore, audit);
  const resolutions = new ResolutionService({ audit });
  const cases = new CaseService(evidence, audit, caseStore, catalog, resolutions);
  const investigations = {
    getCase: (id: string, actor: { id: string; username: string }, isAdmin: boolean) =>
      cases.getCase(id, actor, isAdmin),
    appendDomainTimeline: (
      caseId: string,
      event: {
        kind: string;
        actor: { id: string; username: string };
        targetId: string | null;
        clientTime: string | null;
        payload: unknown;
      },
    ) => cases.appendDomainTimeline(caseId, event),
  };
  resolutions.bindInvestigations(investigations);
  const entities = new EntityService({ audit, investigations });
  const references = new ReferenceService({ audit, investigations });
  evidence.addReferencedContentHashSource(() => caseStore.listReferencedContentHashes());
  evidence.addReferencedContentHashSource(() => runStore.listReferencedContentHashes());
  await evidence.recoverUnreferencedWrites();
  const imports = new ImportService({
    evidence,
    audit,
    cases,
    catalog,
    runs: runStore,
  });
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: experimentStore,
  });
  const triageRuns = new TriageRunService({
    cases,
    audit,
    jobs: jobStore,
    ...(options.gatewayExecutor
      ? { gatewayExecutor: options.gatewayExecutor }
      : options.gatewayRunner
        ? { gatewayExecutor: new RustBridgeTriageExecutor(options.gatewayRunner) }
        : {}),
    profiles: options.triageProfiles ?? loadConfiguredTriageProfileCatalog(),
  });
  const logTime = options.logTimeBridge
    ? new LogTimeService({
        store: new MemoryLogTimeStore(),
        bridge: options.logTimeBridge,
        cases: createLogTimeCasePort({
          cases: caseStore,
          domain: cases,
          evidence,
          jobs: jobStore,
        }),
        audit,
      })
    : null;
  const presence = new PresenceService();
  const exporter = new ExportService({
    cases,
    catalog,
    imports,
    audit,
    record: {
      involvementFor: (caseId) => entities.involvementsForExport(caseId),
      entityPrivacy: () => entities.entityPrivacyMap(),
      referencesFor: (caseId) => references.exportProjection(caseId),
      activeResolutionFor: (caseId) => resolutions.active(caseId),
    },
    privacy: testExportPrivacyConfig({
      identityRedactions: {
        "uid=demo,ou=people,dc=example,dc=test": "demo-case-lead",
        demo: "demo-case-lead",
      },
    }),
  });
  const applyBoundary = memoryApplyBoundary({
    cases: caseStore,
    catalog: catalogStore,
    experiments: experimentStore,
    runs: runStore,
    jobs: jobStore,
    evidence,
    audit,
    applyState,
  });
  const portable = new PortableInvestigationService({
    installationId: "inst-syntheticdemo",
    publicIdentities: new HmacPublicIdentityCodec(Buffer.alloc(32, 0x42)),
    cases,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState,
    probe: {
      cases: caseStore,
      catalog: catalogStore,
      experiments: experimentStore,
      runs: runStore,
      jobs: jobStore,
    },
    withTransaction: applyBoundary.withTransaction,
    applyCoordination: "single_instance",
    confirmationRestartDurable: false,
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(demoRoleMap));
  const staticDir =
    options.staticDir === undefined
      ? join(here, "..", "..", "web", "dist-demo")
      : options.staticDir;
  let app: FastifyInstance | null = null;
  try {
    app = await (options.appBuilder ?? buildApp)({
      config: testConfig({
        host: "127.0.0.1",
        port: 8787,
        serviceName: "contextdesk-synthetic-demo",
        evidenceRoot,
        staticDir,
      }),
      pool: null,
      store: evidence,
      domain: cases,
      catalog,
      imports,
      triageRuns,
      ...(logTime ? { logTime } : {}),
      presence,
      experiments,
      entities,
      references,
      resolutions,
      exporter,
      portable,
      publicIdentities: new HmacPublicIdentityCodec(Buffer.alloc(32, 0x42)),
      ...(options.setup ? { setup: options.setup } : {}),
      componentHealth: () => options.componentHealth ?? syntheticComponentHealth(),
      serveStatic: staticDir !== null,
      security: {
        auth: {
          adapter: new MapAuthAdapter(demoUsers()),
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
    app.addHook("onClose", async () => {
      await rm(evidenceRoot, { recursive: true, force: true });
    });
    const caseId = await seed(app);
    return { app, caseId, evidenceRoot };
  } catch (error) {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the construction/seed failure; explicit cleanup below is authoritative.
      }
    }
    await rm(evidenceRoot, { recursive: true, force: true });
    throw error;
  }
}

function demoPort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COLLAB_DEMO_PORT must be an integer 1..65535, got ${raw ?? ""}`);
  }
  return port;
}

function demoGatewayRunner(): RustBridgeTriageExecutorOptions | undefined {
  const command = (process.env.COLLAB_DEMO_TRIAGE_RUNNER ?? process.env.COLLAB_TRIAGE_RUNNER)?.trim();
  if (!command) return undefined;
  const rawTimeout = process.env.COLLAB_TRIAGE_RUNNER_TIMEOUT_MS ?? "300000";
  const timeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`COLLAB_TRIAGE_RUNNER_TIMEOUT_MS must be a positive integer, got ${rawTimeout}`);
  }
  return {
    command,
    timeoutMs,
    ...(process.env.COLLAB_TRIAGE_RUNNER_DATA_DIR?.trim()
      ? { dataDir: process.env.COLLAB_TRIAGE_RUNNER_DATA_DIR.trim() }
      : {}),
    ...(process.env.COLLAB_TRIAGE_LIBRARY?.trim()
      ? { library: process.env.COLLAB_TRIAGE_LIBRARY.trim() }
      : {}),
  };
}

async function main(): Promise<void> {
  const gatewayRunner = demoGatewayRunner();
  const localLogTime = logTimeBridgeOptions();
  const { app } = await buildDemoApp({
    ...(gatewayRunner ? { gatewayRunner } : {}),
    ...(localLogTime ? { logTimeBridge: new ProcessLogTimeBridge(localLogTime) } : {}),
  });
  const close = () => {
    void app.close().catch((error: unknown) => {
      process.stderr.write(
        `synthetic demo shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: demoPort(process.env.COLLAB_DEMO_PORT) });
    process.stdout.write(
      [
        "ContextDesk synthetic demo is ready.",
        `Open: ${address}`,
        `Sign in: ${DEMO_USERNAME} / ${DEMO_PASSWORD}`,
        gatewayRunner
          ? "Case state is synthetic and memory-backed; gateway runs are explicitly enabled through the host bridge."
          : "All state is synthetic, memory-backed, and removed when the server stops.",
        localLogTime
          ? "Local log chronology and timezone review are enabled through the trusted ContextDesk host."
          : "Local log chronology is hidden until COLLAB_BRIDGE_BIN and COLLAB_LOG_CORPUS_ROOT are configured.",
        "Use /health for a smoke check; /ready intentionally reports no production database.",
      ].join("\n") + "\n",
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
