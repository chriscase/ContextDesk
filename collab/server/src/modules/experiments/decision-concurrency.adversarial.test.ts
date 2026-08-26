import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { ExperimentConflictError, ExperimentService, MemoryExperimentStore } from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const here = dirname(fileURLToPath(import.meta.url));
const SUMMARY = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-summary.valid.json"),
    "utf8",
  ),
) as unknown;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-decision-cas-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const store = new MemoryExperimentStore();
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  return { cases, experiments, store };
}

describe("concurrent experiment decision proposals", () => {
  it("keeps one first revision and refuses a forked concurrent propose", async () => {
    const { cases, experiments, store } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic decision CAS" }, "test");
    await cases.addParticipant(
      created.id,
      ALICE,
      { identityId: BOB.id, username: BOB.username },
      "test",
    );
    const imported = await experiments.importEnvelope(created.id, ALICE, SUMMARY, "test", false);
    const results = await Promise.allSettled([
      experiments.proposeDecision(
        created.id,
        imported.id,
        ALICE,
        {
          text: "Inspect the synthetic timeout path before changing capacity.",
          rationale: "Alice proposed first under an empty history.",
          evidenceRefs: [],
        },
        "test",
        false,
      ),
      experiments.proposeDecision(
        created.id,
        imported.id,
        BOB,
        {
          text: "A concurrent first proposal must not create a second head.",
          rationale: "Bob proposed first under the same empty history.",
          evidenceRefs: [],
        },
        "test",
        false,
      ),
    ]);
    const fulfilled = results.filter((row) => row.status === "fulfilled");
    const conflicts = results.filter(
      (row) => row.status === "rejected" && row.reason instanceof ExperimentConflictError,
    );
    const unexpected = results.filter(
      (row) => row.status === "rejected" && !(row.reason instanceof ExperimentConflictError),
    );
    expect(unexpected.map((row) => row.status === "rejected" ? String(row.reason) : "")).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    if (conflicts[0]?.status === "rejected") {
      expect((conflicts[0].reason as ExperimentConflictError).code).toBe("revision_conflict");
    }
    const history = await store.listDecisions(imported.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.revision).toBe(1);
    expect(new Set(history.map((row) => row.revision)).size).toBe(1);
    const timeline = await cases.listTimeline(created.id);
    expect(timeline.filter((event) => event.kind === "experiment_decision_proposed")).toHaveLength(1);
  });
});
