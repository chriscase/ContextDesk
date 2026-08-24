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
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "./modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "./modules/authz/index.js";
import { CatalogService } from "./modules/catalog/index.js";
import { CaseService } from "./modules/cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./modules/experiments/index.js";
import { ExportService, testExportPrivacyConfig } from "./modules/export/index.js";
import { ImportService, MemoryRunStore } from "./modules/import/index.js";
import {
  MemoryTriageJobStore,
  loadConfiguredTriageProfileCatalog,
  RustBridgeTriageExecutor,
  TriageRunService,
  type RustBridgeTriageExecutorOptions,
} from "./modules/triage-runs/index.js";
import { PresenceService } from "./modules/presence/index.js";

export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "contracts", "fixtures");
const demoRoleMap = "cn=demo-lead,ou=groups,dc=example,dc=test=case-lead";

interface DemoApp {
  app: FastifyInstance;
  caseId: string;
  evidenceRoot: string;
}

interface DemoAppOptions {
  staticDir?: string | null;
  /** Explicit opt-in host bridge for a local, memory-backed live rehearsal. */
  gatewayRunner?: RustBridgeTriageExecutorOptions;
  /** Test seam for proving construction-failure cleanup; production uses buildApp. */
  appBuilder?: typeof buildApp;
  /** Test observer for the temporary root created before app construction. */
  onEvidenceRootCreated?: (root: string) => void;
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
          displayName: "Demo case lead",
        },
        groups: ["cn=demo-lead,ou=groups,dc=example,dc=test"],
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
      payload: observation,
    });
  }
  const proposed = await okJson<{ id: string; revision: number }>(app, {
    method: "POST",
    url: `/api/cases/${caseId}/experiments/${imported.id}/decisions`,
    cookie,
    payload: decision,
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
      evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      expectedRelationships: [
        { evidenceRef: "ev-demo-checkout-log", role: "symptom" },
        { evidenceRef: "ev-demo-inventory-timeout", role: "cause" },
      ],
      helpfulnessDimensions: ["evidence_support", "actionability"],
      notes: ["Synthetic demo benchmark. Not live provider output."],
    },
  });
  return imported.id;
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
      snapshotBinding: "snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb",
      redacted: true,
      privacyClass: "share_safe",
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
      contentBase64: Buffer.from("checkout request timed out while waiting for inventory service\n").toString("base64"),
      summary: "Synthetic checkout timeout evidence.",
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
      contentBase64: Buffer.from("inventory client timeout after pool exhaustion\n").toString("base64"),
      summary: "Synthetic inventory timeout evidence.",
      sourceId: source.id,
      privacyClass: "share_safe",
    },
  });
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
  const demoSnapshot = await okJson<{ id: string }>(app, {
    method: "POST",
    url: `/api/cases/${created.id}/snapshots`,
    cookie,
    payload: {
      evidenceIds: [checkoutEvidence.artifact.id, inventoryEvidence.artifact.id],
      visibility: "owner_only",
      protocolVersion: "synthetic-demo-v1",
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
      taskFingerprint: "demo-checkout-v1",
      candidates: [
        { candidateId: "qwen-reviewer", role: "reviewer", provider: "synthetic", profileId: null, model: "qwen-3.6-27b", version: null },
        { candidateId: "gpt-oss-contributor", role: "contributor", provider: "synthetic", profileId: null, model: "gpt-oss-120b", version: null },
        { candidateId: "ministral-challenger", role: "challenger", provider: "synthetic", profileId: null, model: "ministral-3-14b-instruct-2512", version: null },
      ],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const primaryExperimentId = await seedReviewedExperiment(
    app,
    cookie,
    created.id,
    await fixture("experiment-package.valid.json"),
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
      candidateId: "cand-qwen-3.6-27b",
      text:
        "Human: Determine why the fictional checkout request timed out.\n" +
        "Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms while waiting for inventory-client; evidence ev-demo-checkout-log\n" +
        "Tool: 2026-08-24T06:14:22Z inventory-client ERROR TimeoutError: inventory lookup exceeded 30000ms at InventoryClient.fetch (inventory-client.ts:118); evidence ev-demo-inventory-timeout\n" +
        "Assistant: The checkout timeout is recorded by all lanes. This lane treats the inventory-client timeout as the leading cause, pending pool and network measurements.",
    },
    {
      candidateId: "cand-gpt-oss-120b",
      text:
        "Human: Compare the fictional checkout and connection-pool signals.\n" +
        "Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms; evidence ev-demo-checkout-log\n" +
        "Tool: 2026-08-24T06:14:21Z connection-pool WARN active=40 idle=0 queued=17; evidence ev-demo-pool-exhaustion\n" +
        "Assistant: Pool exhaustion is a plausible upstream contributor. Inspect pool wait duration and dependency latency before declaring a root cause.",
    },
    {
      candidateId: "cand-ministral-14b",
      text:
        "Human: State only what the fictional checkout record establishes.\n" +
        "Tool: 2026-08-24T06:14:22Z checkout-service WARN request exceeded 30000ms while awaiting a dependency; evidence ev-demo-checkout-log\n" +
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
    await fixture("strategy-package.converge.json"),
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
  return created.id;
}

export async function buildDemoApp(options: DemoAppOptions = {}): Promise<DemoApp> {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "contextdesk-synthetic-demo-"));
  options.onEvidenceRootCreated?.(evidenceRoot);
  const evidence = new FilesystemEvidenceStore({ rootDir: evidenceRoot });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(evidence, audit, undefined, catalog);
  const imports = new ImportService({
    evidence,
    audit,
    cases,
    catalog,
    runs: new MemoryRunStore(),
  });
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: new MemoryExperimentStore(),
  });
  const triageRuns = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    ...(options.gatewayRunner
      ? { gatewayExecutor: new RustBridgeTriageExecutor(options.gatewayRunner) }
      : {}),
    profiles: loadConfiguredTriageProfileCatalog(),
  });
  const presence = new PresenceService();
  const exporter = new ExportService({
    cases,
    catalog,
    imports,
    audit,
    privacy: testExportPrivacyConfig({
      identityRedactions: {
        "uid=demo,ou=people,dc=example,dc=test": "demo-case-lead",
        demo: "demo-case-lead",
      },
    }),
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
      presence,
      experiments,
      exporter,
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
  const { app } = await buildDemoApp(gatewayRunner ? { gatewayRunner } : {});
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
