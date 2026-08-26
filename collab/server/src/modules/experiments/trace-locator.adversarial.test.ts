import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  formatCompactInvestigationLocator,
  formatInvestigationResourceLocator,
  formatPortableExperimentTraceTarget,
  parseInteractionTrace,
  type InteractionTraceV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { InvestigationActivityService } from "../activity/index.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import {
  ExperimentService,
  MemoryExperimentStore,
  PgExperimentStore,
  type ExperimentStore,
} from "./index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const EVE = { id: "eve", username: "eve" };
const QWEN = "cand-qwen-3.6-27b";
const GPT = "cand-gpt-oss-120b";
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as unknown;
const CHAT = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/interaction-trace.chat.json"), "utf8"),
) as Record<string, unknown>;
const PROGRAMMATIC = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/interaction-trace.programmatic.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function remappedTrace(raw: Record<string, unknown>, candidateId: string): InteractionTraceV1 {
  return parseInteractionTrace({ ...raw, candidateId });
}

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-trace-locator-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const store = new MemoryExperimentStore();
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  const activity = new InvestigationActivityService({
    cases,
    installationId: INSTALLATION,
  });
  return { cases, experiments, store, activity };
}

async function seedTraces(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic trace locator" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  const aliceTrace = await experiments.importTrace(
    created.id,
    imported.id,
    ALICE,
    remappedTrace(CHAT, QWEN),
    "test",
    false,
  );
  const bobTrace = await experiments.importTrace(
    created.id,
    imported.id,
    BOB,
    remappedTrace(PROGRAMMATIC, GPT),
    "test",
    false,
  );
  expect(aliceTrace.traceId).not.toBe(bobTrace.traceId);
  expect(await store.listTraces(imported.id)).toHaveLength(2);
  return {
    caseId: created.id,
    experimentId: imported.id,
    aliceTrace,
    bobTrace,
  };
}

function compact(
  caseId: string,
  kind: "interaction_trace" | "evidence_context" | "comparison_finding" | "helpfulness",
  resourceId: string,
) {
  return formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: caseId,
    kind,
    resourceId,
  }));
}

async function assertTraceLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedTraces>>,
) {
  const aliceTarget = formatPortableExperimentTraceTarget(
    seeded.experimentId,
    seeded.aliceTrace.traceId,
  );
  const bobTarget = formatPortableExperimentTraceTarget(
    seeded.experimentId,
    seeded.bobTrace.traceId,
  );
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const items = page.items.filter((item) => item.summary === "imported a comparison trace");
  expect(items).toHaveLength(2);
  expect(items.map((item) => item.locator.resourceId).sort()).toEqual(
    [aliceTarget, bobTarget].sort(),
  );
  for (const item of items) {
    expect(item.locator.kind).toBe("interaction_trace");
    expect(item.locator.resourceId).not.toBe(seeded.experimentId);
    expect(item.locator.resourceId).not.toBe(seeded.caseId);
    expect(item.locator.resourceId).toContain(":");
    expect(item.humanFinding).toBe(false);
    expect(item.provenanceClass).toBe("ai_generated");
    expect(item.resolvedRoute).toContain("section=candidate-comparison-heading");
    expect(item.resolvedRoute).toContain(`item=${encodeURIComponent(item.locator.resourceId)}`);
    await expect(
      activity.resolve(ALICE, false, formatCompactInvestigationLocator(item.locator)),
    ).resolves.toMatchObject({
      authorized: true,
      resourceLabel: "Imported comparison trace",
      locator: item.locator,
    });
    await expect(
      activity.resolve(EVE, false, formatCompactInvestigationLocator(item.locator)),
    ).rejects.toMatchObject({ code: "not_found" });
  }
  expect(new Set(items.map((item) => item.locator.resourceId)).size).toBe(2);

  const confused = [
    compact(seeded.caseId, "evidence_context", aliceTarget),
    compact(seeded.caseId, "evidence_context", seeded.experimentId),
    compact(seeded.caseId, "interaction_trace", seeded.experimentId),
    compact(seeded.caseId, "interaction_trace", seeded.caseId),
    compact(seeded.caseId, "comparison_finding", aliceTarget),
    compact(seeded.caseId, "helpfulness", aliceTarget),
  ];
  for (const locator of confused) {
    await expect(activity.resolve(ALICE, false, locator), locator).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(activity.resolve(EVE, false, locator), locator).rejects.toMatchObject({
      code: "not_found",
    });
  }
}

describe("experiment trace locators", () => {
  it("addresses each imported trace, not the experiment, and hides kind-confused ids", async () => {
    const { cases, experiments, store, activity } = await memoryHarness();
    const seeded = await seedTraces(cases, experiments, store);
    const timeline = await cases.listTimeline(seeded.caseId);
    const events = timeline.filter((event) => event.kind === "experiment_trace_imported");
    expect(events.map((event) => event.targetId).sort()).toEqual(
      [
        formatPortableExperimentTraceTarget(seeded.experimentId, seeded.aliceTrace.traceId),
        formatPortableExperimentTraceTarget(seeded.experimentId, seeded.bobTrace.traceId),
      ].sort(),
    );
    await assertTraceLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres experiment trace locators", () => {
  it("addresses remapped interaction traces with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-trace-locator-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = new PgExperimentStore(pool);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      const activity = new InvestigationActivityService({
        cases,
        installationId: INSTALLATION,
      });
      try {
        const seeded = await seedTraces(cases, experiments, store);
        await assertTraceLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
