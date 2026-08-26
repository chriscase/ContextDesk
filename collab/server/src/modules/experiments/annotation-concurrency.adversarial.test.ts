import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { parseInteractionTrace, type InteractionTraceV1 } from "@cd-collab/contracts";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import {
  ExperimentService,
  MemoryExperimentStore,
  PgExperimentStore,
  type ExperimentStore,
} from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const CANDIDATE = "cand-qwen-3.6-27b";
const here = dirname(fileURLToPath(import.meta.url));
const SUMMARY = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-summary.valid.json"),
    "utf8",
  ),
) as unknown;
const PLAIN = {
  schemaId: "cd-collab.plain_transcript.v1" as const,
  candidateId: CANDIDATE,
  text: "checkout timed out, not sure about the pool\nmaybe inventory",
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-annotation-seq-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const store = new MemoryExperimentStore();
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  return { cases, experiments, store, audit };
}

function assembledTrace(
  trace: InteractionTraceV1,
  annotations: Awaited<ReturnType<ExperimentStore["listAnnotations"]>>,
) {
  const extra = annotations
    .filter((row) => row.candidateId === trace.candidateId)
    .map((row) => row.event)
    .sort((left, right) => left.sequence - right.sequence);
  return parseInteractionTrace({
    ...trace,
    events: [...trace.events, ...extra],
  });
}

async function seedTrace(
  cases: CaseService,
  experiments: ExperimentService,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic annotation CAS" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  const imported = await experiments.importEnvelope(created.id, ALICE, SUMMARY, "test", false);
  const trace = await experiments.importTrace(created.id, imported.id, ALICE, PLAIN, "test", false);
  return { caseId: created.id, experimentId: imported.id, trace };
}

describe("experiment trace annotation sequences", () => {
  it("persists unique sequences for sequential annotations without merge-time renumbering", async () => {
    const { cases, experiments, store } = await memoryHarness();
    const seeded = await seedTrace(cases, experiments);
    const first = await experiments.annotateTrace(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      { candidateId: CANDIDATE, text: "Alice: inventory timeout is the useful lead." },
      "test",
      false,
    );
    const second = await experiments.annotateTrace(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      { candidateId: CANDIDATE, text: "Bob: mailer retries still lag the inventory timeout." },
      "test",
      false,
    );
    const stored = (await store.listAnnotations(seeded.experimentId)).filter(
      (row) => row.candidateId === CANDIDATE,
    );
    expect(stored).toHaveLength(2);
    const sequences = stored.map((row) => row.event.sequence);
    expect(new Set(sequences).size).toBe(2);
    const lastImported = seeded.trace.events.at(-1)?.sequence ?? 0;
    expect(Math.min(...sequences)).toBe(lastImported + 1);
    expect(Math.max(...sequences)).toBe(lastImported + 2);
    const parsed = assembledTrace(seeded.trace, stored);
    expect(parsed.events.map((event) => event.sequence)).toEqual(
      [...seeded.trace.events.map((event) => event.sequence), ...sequences.sort((a, b) => a - b)],
    );
    expect(first.events.at(-2)?.sequence).not.toBe(first.events.at(-1)?.sequence);
    expect(second.events.map((event) => event.sequence)).toEqual(parsed.events.map((event) => event.sequence));
  });

  it("keeps concurrent annotations without duplicate stored sequences", async () => {
    const { cases, experiments, store } = await memoryHarness();
    const seeded = await seedTrace(cases, experiments);
    const results = await Promise.allSettled([
      experiments.annotateTrace(
        seeded.caseId,
        seeded.experimentId,
        ALICE,
        { candidateId: CANDIDATE, text: "Alice annotated the synthetic timeout under concurrency." },
        "test",
        false,
      ),
      experiments.annotateTrace(
        seeded.caseId,
        seeded.experimentId,
        BOB,
        { candidateId: CANDIDATE, text: "Bob annotated the same trace without forking sequence." },
        "test",
        false,
      ),
    ]);
    const unexpected = results.filter((row) => row.status === "rejected");
    expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
    const fulfilled = results.filter((row) => row.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const stored = (await store.listAnnotations(seeded.experimentId)).filter(
      (row) => row.candidateId === CANDIDATE,
    );
    expect(stored).toHaveLength(2);
    const sequences = stored.map((row) => row.event.sequence);
    expect(new Set(sequences).size).toBe(2);
    assembledTrace(seeded.trace, stored);
  });
});

describe.skipIf(!adminUrl())("postgres experiment trace annotation sequences", () => {
  it("persists unique PostgreSQL sequences for concurrent annotations", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-annotation-seq-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = new PgExperimentStore(pool);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        const seeded = await seedTrace(cases, experiments);
        const results = await Promise.allSettled([
          experiments.annotateTrace(
            seeded.caseId,
            seeded.experimentId,
            ALICE,
            { candidateId: CANDIDATE, text: "Alice annotated the PostgreSQL timeout under concurrency." },
            "test",
            false,
          ),
          experiments.annotateTrace(
            seeded.caseId,
            seeded.experimentId,
            BOB,
            { candidateId: CANDIDATE, text: "Bob annotated the PostgreSQL trace without forking sequence." },
            "test",
            false,
          ),
        ]);
        const unexpected = results.filter((row) => row.status === "rejected");
        expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
        expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(2);
        const stored = (await store.listAnnotations(seeded.experimentId)).filter(
          (row) => row.candidateId === CANDIDATE,
        );
        expect(stored).toHaveLength(2);
        expect(new Set(stored.map((row) => row.event.sequence)).size).toBe(2);
        assembledTrace(seeded.trace, stored);
      } finally {
        await pool.end();
      }
    });
  });
});
