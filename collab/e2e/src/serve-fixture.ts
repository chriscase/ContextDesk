/**
 * Test-only fixture process for browser qualification.
 *
 * Uses the existing `MapAuthAdapter` (same seam as collab HTTP tests). This is
 * not a production local-auth endpoint and does not add routes.
 */
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../server/src/app.js";
import { testConfig } from "../../server/src/config.js";
import { FilesystemEvidenceStore } from "../../server/src/evidence/store.js";
import { MemoryAuditStore } from "../../server/src/modules/audit/index.js";
import {
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
} from "../../server/src/modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../../server/src/modules/authz/index.js";
import { CatalogService, MemoryCatalogStore } from "../../server/src/modules/catalog/index.js";
import { CaseService, MemoryCaseStore } from "../../server/src/modules/cases/index.js";
import { ExportService, testExportPrivacyConfig } from "../../server/src/modules/export/index.js";
import { EntityService } from "../../server/src/modules/entities/index.js";
import { ReferenceService } from "../../server/src/modules/references/index.js";
import { ResolutionService } from "../../server/src/modules/resolutions/index.js";
import { ImportService, MemoryRunStore } from "../../server/src/modules/import/index.js";
import { ExperimentService, MemoryExperimentStore } from "../../server/src/modules/experiments/index.js";
import { PresenceService } from "../../server/src/modules/presence/index.js";
import {
  LogTimeService,
  MemoryLogTimeStore,
  ProcessLogTimeBridge,
  createLogTimeCasePort,
} from "../../server/src/modules/log-time/index.js";
import {
  MemoryLocalGrantStore,
  MemoryUserProfileStore,
} from "../../server/src/modules/people/index.js";
import {
  loadPortableInstallationId,
  memoryApplyBoundary,
  MemoryPortableApplyStateStore,
  PortableInvestigationService,
} from "../../server/src/modules/portable-investigations/index.js";
import {
  DeterministicMockTriageExecutor,
  MemoryTriageJobStore,
  RustBridgeTriageExecutor,
  TriageRunService,
} from "../../server/src/modules/triage-runs/index.js";
import { adapterUsers, FIXTURE_ROLE_MAP, SEEDED_SOURCES } from "./users.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDistEnv = process.env.COLLAB_E2E_STATIC_DIR?.trim();
const webDist = webDistEnv ? webDistEnv : join(here, "..", "..", "web", "dist");
const bridgeFixture = join(here, "..", "fixtures", "triage-bridge-runner.mjs");
const degradedBridgeFixture = join(here, "..", "fixtures", "triage-bridge-degraded-runner.mjs");

/**
 * Bridge selection for browser qualification.
 *
 * `1` runs the clean-lane fixture. `degraded` runs the mixed completed/partial/
 * failed fixture the War Room scenario catalog needs, so the shell can be
 * qualified against a run that did not go well. Anything else stays on the
 * provider-free synthetic executor.
 */
type BridgeMode = "off" | "clean" | "degraded";

function bridgeModeFrom(raw: string | undefined): BridgeMode {
  const value = raw?.trim().toLowerCase();
  if (value === "1" || value === "clean") return "clean";
  if (value === "degraded") return "degraded";
  return "off";
}

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "8788", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COLLAB_E2E_PORT must be 1..65535, got ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(
      `missing collab web build at ${webDist}; run: npm run build -w @cd-collab/web`,
    );
  }
  const root = await mkdtemp(join(tmpdir(), "cd-collab-e2e-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  await store.ping();
  const audit = new MemoryAuditStore();
  const caseStore = new MemoryCaseStore();
  const catalogStore = new MemoryCatalogStore();
  const runStore = new MemoryRunStore();
  const experimentStore = new MemoryExperimentStore();
  const jobStore = new MemoryTriageJobStore();
  const applyState = new MemoryPortableApplyStateStore();
  const profiles = new MemoryUserProfileStore();
  const grants = new MemoryLocalGrantStore();
  const catalog = new CatalogService(catalogStore, audit);
  // Same construction order as production: the resolution guard exists before
  // the case service, so a resolved status can never be reached without a
  // record even in the browser fixture.
  const resolutions = new ResolutionService({ audit });
  const domain = new CaseService(store, audit, caseStore, catalog, resolutions);
  const investigations = {
    getCase: (id: string, who: { id: string; username: string }, isAdmin: boolean) =>
      domain.getCase(id, who, isAdmin),
    appendDomainTimeline: (
      caseId: string,
      event: {
        kind: string;
        actor: { id: string; username: string };
        targetId: string | null;
        clientTime: string | null;
        payload: unknown;
      },
    ) => domain.appendDomainTimeline(caseId, event),
  };
  resolutions.bindInvestigations(investigations);
  const entities = new EntityService({ audit, investigations });
  const references = new ReferenceService({ audit, investigations });
  const imports = new ImportService({
    evidence: store,
    audit,
    applyState,
    cases: domain,
    catalog,
    runs: runStore,
  });
  const bridgeMode = bridgeModeFrom(process.env.COLLAB_E2E_BRIDGE);
  const triageRuns = new TriageRunService({
    cases: domain,
    audit,
    jobs: jobStore,
    ...(bridgeMode !== "off"
      ? {
          gatewayExecutor: new RustBridgeTriageExecutor({
            command: bridgeMode === "degraded" ? degradedBridgeFixture : bridgeFixture,
            timeoutMs: 30_000,
          }),
        }
      : { executor: new DeterministicMockTriageExecutor() }),
    ...(bridgeMode !== "off"
      ? {
          profiles: [
            { id: "profile:fixture-qwen", label: "Fixture Qwen", provider: "openai-compatible" },
            { id: "profile:fixture-gpt", label: "Fixture GPT-OSS", provider: "openai-compatible" },
            { id: "profile:fixture-ministral", label: "Fixture Ministral", provider: "openai-compatible" },
          ],
        }
      : {}),
  });
  const experiments = new ExperimentService({
    cases: domain,
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
    installationId: await loadPortableInstallationId(root),
    cases: domain,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState,
    withTransaction: applyBoundary.withTransaction,
    applyCoordination: "single_instance",
    confirmationRestartDurable: false,
  });
  // Log-time review runs against the real `contextdesk` host binary when one
  // is configured, so the browser suite exercises the shipped pipeline rather
  // than a stand-in. Without it the routes stay unregistered and the spec
  // skips, which is honest: there is nothing to review without the pipeline.
  const logTimeBin = process.env.COLLAB_E2E_LOG_TIME_BIN?.trim();
  const logTime = logTimeBin
    ? new LogTimeService({
        store: new MemoryLogTimeStore(),
        bridge: new ProcessLogTimeBridge({
          command: logTimeBin,
          cacheRoot: join(root, "log-corpora"),
          timeoutMs: 60_000,
        }),
        cases: createLogTimeCasePort({
          cases: caseStore,
          domain,
          evidence: store,
          jobs: jobStore,
        }),
        audit,
      })
    : null;
  const presence = new PresenceService();
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: testExportPrivacyConfig(),
    record: {
      involvementFor: (caseId) => entities.involvementsForExport(caseId),
      entityPrivacy: () => entities.entityPrivacyMap(),
      referencesFor: (caseId) => references.exportProjection(caseId),
      activeResolutionFor: (caseId) => resolutions.active(caseId),
    },
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(FIXTURE_ROLE_MAP));
  const actor = { id: "fixture-seed", username: "fixture" };
  await catalog.create(
    actor,
    {
      name: SEEDED_SOURCES.chatA,
      kind: "external-tool",
      description: "Deterministic e2e source A",
    },
    "fixture",
  );
  await catalog.create(
    actor,
    {
      name: SEEDED_SOURCES.chatB,
      kind: "external-tool",
      description: "Deterministic e2e source B",
    },
    "fixture",
  );

  const port = parsePort(process.env.COLLAB_E2E_PORT);
  const app = await buildApp({
    config: testConfig({
      evidenceRoot: root,
      staticDir: webDist,
      host: "127.0.0.1",
      port,
    }),
    pool: null,
    store,
    domain,
    catalog,
    imports,
    triageRuns,
    presence,
    ...(logTime ? { logTime } : {}),
    experiments,
    exporter,
    portable,
    entities,
    references,
    resolutions,
    profiles,
    grants,
    security: {
      auth: {
        adapter: new MapAuthAdapter(adapterUsers()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 40, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });

  const close = async (): Promise<void> => {
    await app.close();
  };
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });

  const address = await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(
    `cd-collab fixture server listening ${address} (MapAuthAdapter test-only; LDAP unused; /ready expects Postgres; bridge=${bridgeMode === "off" ? "synthetic" : bridgeMode})\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
