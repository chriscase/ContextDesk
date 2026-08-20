import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGREEMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, type Actor } from "../cases/index.js";
import { ExperimentService } from "../experiments/index.js";
import {
  SnapshotConflictError,
  SnapshotNotFoundError,
  SnapshotService,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/experiment-package.valid.json"), "utf8"),
) as unknown;

const alice: Actor = {
  id: "uid=alice,ou=people,dc=example,dc=test",
  username: "alice",
};
const eve: Actor = {
  id: "uid=eve,ou=people,dc=example,dc=test",
  username: "eve",
};

const LOG = "2026-08-15T00:00:00Z mailer timeout id=syn-1\n";
const GENERATED_AT = "2026-08-20T12:00:00.000Z";

async function withServices(
  fn: (ctx: {
    cases: CaseService;
    snapshots: SnapshotService;
    experiments: ExperimentService;
    audit: MemoryAuditStore;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-snapshots-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(store, audit, undefined, catalog);
  const experiments = new ExperimentService({ cases, audit });
  const snapshots = new SnapshotService({ cases, audit, experiments });
  try {
    await fn({ cases, snapshots, experiments, audit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("snapshot service", () => {
  it("freezes a hashed log snapshot, is idempotent, and audits the freeze", async () => {
    await withServices(async ({ cases, snapshots, audit }) => {
      const created = await cases.createCase(alice, { title: "war room" }, "test");
      const { artifact } = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "log",
          filename: "mailer.log",
          bytes: new TextEncoder().encode(LOG),
          summary: "synthetic mailer timeout",
        },
        "test",
      );
      const first = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [artifact.id] },
        "test",
        false,
      );
      expect(first.status).toBe("frozen");
      expect(first.fairness).toBe("same_snapshot");
      expect(first.items[0]?.contentHash).toBe(artifact.contentHash);
      const second = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [artifact.id] },
        "test",
        false,
      );
      expect(second.snapshotId).toBe(first.snapshotId);
      const listed = await snapshots.list(created.id, alice, false);
      expect(listed).toHaveLength(1);
      const loaded = await snapshots.get(created.id, first.snapshotId, alice, false);
      expect(loaded?.fingerprint).toBe(first.fingerprint);
      if (loaded?.items[0]) loaded.items[0].evidenceId = "mutated";
      const again = await snapshots.get(created.id, first.snapshotId, alice, false);
      expect(again?.items[0]?.evidenceId).toBe(artifact.id);

      const frozen = (await cases.listTimeline(created.id)).filter(
        (row) => row.kind === "snapshot_frozen",
      );
      expect(frozen).toHaveLength(1);
      const freezeAudits = await audit.list({ action: "snapshot_freeze" });
      const idempotent = await audit.list({ action: "snapshot_freeze_idempotent" });
      expect(freezeAudits).toHaveLength(1);
      expect(idempotent).toHaveLength(1);
    });
  });

  it("uses expectedHash for file-server refs and keeps unhashed refs unknown_visibility", async () => {
    await withServices(async ({ cases, snapshots }) => {
      const created = await cases.createCase(alice, { title: "refs" }, "test");
      const hashed = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "file_server_ref",
          uri: "https://files.example.test/hashed.bin",
          expectedHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          summary: "hashed remote",
        },
        "test",
      );
      const unhashed = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "file_server_ref",
          uri: "https://files.example.test/plain.bin",
          expectedHash: null,
          summary: "never hashed remote",
        },
        "test",
      );
      const same = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [hashed.artifact.id] },
        "test",
        false,
      );
      expect(same.fairness).toBe("same_snapshot");
      expect(same.items[0]?.contentHash).toBe(
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );
      const unknown = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [unhashed.artifact.id] },
        "test",
        false,
      );
      expect(unknown.fairness).toBe("unknown_visibility");
      expect(unknown.items[0]?.contentHash).toBeNull();
    });
  });

  it("rejects a stale parent fingerprint and unknown members", async () => {
    await withServices(async ({ cases, snapshots }) => {
      const created = await cases.createCase(alice, { title: "lineage" }, "test");
      const { artifact } = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "log",
          bytes: new TextEncoder().encode(LOG),
          summary: "log",
        },
        "test",
      );
      const parent = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [artifact.id] },
        "test",
        false,
      );
      await expect(
        snapshots.freeze(
          created.id,
          alice,
          {
            evidenceIds: [artifact.id],
            parentSnapshotId: parent.snapshotId,
            expectedParentFingerprint:
              "snap-0000000000000000000000000000000000000000000000000000000000000000",
            visibilityByEvidenceId: { [artifact.id]: "hidden" },
          },
          "test",
          false,
        ),
      ).rejects.toBeInstanceOf(SnapshotConflictError);

      await expect(
        snapshots.freeze(created.id, eve, { evidenceIds: [artifact.id] }, "test", false),
      ).rejects.toBeInstanceOf(SnapshotNotFoundError);
      expect(await snapshots.list(created.id, eve, false)).toEqual([]);
    });
  });

  it("derives a case board that separates supported, contradicted, agreement, and gold-unknown", async () => {
    await withServices(async ({ cases, snapshots, experiments }) => {
      const created = await cases.createCase(alice, { title: "board" }, "test");
      const held = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "log",
          bytes: new TextEncoder().encode(LOG),
          summary: "checkout log",
        },
        "test",
      );
      const missing = await cases.addEvidence(
        created.id,
        alice,
        {
          kind: "file_server_ref",
          uri: "https://files.example.test/missing.bin",
          expectedHash: null,
          summary: "unreachable-looking ref",
        },
        "test",
      );
      const supported = await cases.addContribution(
        created.id,
        alice,
        {
          kind: "hypothesis",
          body: "Inventory timeout is the cause",
          hypothesisStatus: "proposed",
          hypothesisLinks: [{ kind: "artifact", id: held.artifact.id }],
        },
        "test",
      );
      await cases.setHypothesisStatus(
        created.id,
        supported.id,
        alice,
        "supported",
        [{ kind: "artifact", id: held.artifact.id }],
        "test",
      );
      await cases.addContribution(
        created.id,
        alice,
        {
          kind: "hypothesis",
          body: "Pool exhaustion",
          hypothesisStatus: "contradicted",
          hypothesisLinks: [{ kind: "artifact", id: held.artifact.id }],
        },
        "test",
      );
      await experiments.importEnvelope(created.id, alice, PACKAGE, "test", false);
      const snapshot = await snapshots.freeze(
        created.id,
        alice,
        { evidenceIds: [held.artifact.id, missing.artifact.id] },
        "test",
        false,
      );
      const board = await snapshots.deriveBoard(
        created.id,
        alice,
        { snapshotId: snapshot.snapshotId, generatedAt: GENERATED_AT },
        false,
      );
      expect(board.generatedAt).toBe(GENERATED_AT);
      expect(board.snapshotId).toBe(snapshot.snapshotId);
      expect(board.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
      expect(board.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
      expect(board.gold.status).toBe("unknown");
      expect(board.known.some((row) => row.findingId === `hyp-${supported.id}`)).toBe(true);
      expect(board.known.every((row) => row.sourceKind !== "agreement")).toBe(true);
      expect(board.disputed.some((row) => row.summary === "Pool exhaustion")).toBe(true);
      expect(board.agreed.some((row) => row.evidenceRefs.includes("ev-demo-checkout-log"))).toBe(
        true,
      );
      expect(
        board.unknown.some((row) => row.findingId === `artifact-unknown-${missing.artifact.id}`),
      ).toBe(true);
      expect(board.newlyConcluded).toEqual([]);
    });
  });
});
