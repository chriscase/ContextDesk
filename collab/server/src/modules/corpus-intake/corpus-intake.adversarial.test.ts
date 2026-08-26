import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_INTAKE_COMMIT_SCHEMA_ID } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { corpusIntakeRequestDigest, digestOf } from "./preview.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const BYTES = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout id=syn-race\n");

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-corpus-race-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const store = new MemoryCaseStore();
  const cases = new CaseService(evidence, audit, store, new CatalogService(undefined, audit));
  return { cases, evidence, audit };
}

function commitBody(caseId: string, actorId: string, key: string, relativePath: string) {
  const files = [{ relativePath, mediaType: "text/plain" as const, bytes: BYTES }];
  return {
    schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
    origin: "files" as const,
    sourceLabel: "synthetic concurrent source",
    privacyClass: "owner_only" as const,
    idempotencyKey: key,
    files: [
      {
        relativePath,
        mediaType: "text/plain",
        contentBase64: Buffer.from(BYTES).toString("base64"),
      },
    ],
    archiveBase64: null,
    previewToken: corpusIntakeRequestDigest({
      caseId,
      actorId,
      origin: "files",
      sourceLabel: "synthetic concurrent source",
      privacyClass: "owner_only",
      idempotencyKey: key,
      files,
      archive: null,
    }),
  };
}

describe("concurrent corpus intake digest classification", () => {
  it("marks exactly one concurrent distinct-key commit as the original digest", async () => {
    const { cases, evidence } = await harness();
    const created = await cases.createCase(ALICE, { title: "Synthetic concurrent digest" }, "test");
    await cases.addParticipant(
      created.id,
      ALICE,
      { identityId: BOB.id, username: BOB.username },
      "test",
    );
    const results = await Promise.all([
      cases.commitCorpusIntake(
        created.id,
        ALICE,
        commitBody(created.id, ALICE.id, "batch-syn-race-alice", "mailer/alice.log"),
        "test",
      ),
      cases.commitCorpusIntake(
        created.id,
        BOB,
        commitBody(created.id, BOB.id, "batch-syn-race-bob", "mailer/bob.log"),
        "test",
      ),
    ]);
    const flags = results.map((batch) => batch.items[0]?.duplicateDigest).sort();
    expect(flags).toEqual([false, true]);
    expect(new Set(results.map((batch) => batch.id)).size).toBe(2);
    expect(new Set(results.flatMap((batch) => batch.items.map((item) => item.artifactId))).size).toBe(2);
    const artifacts = await cases.listArtifacts(created.id, ALICE, false);
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((row) => row.contentHash)).size).toBe(1);
    expect(artifacts.every((row) => row.contentHash === digestOf(BYTES))).toBe(true);
    expect(await evidence.verify(digestOf(BYTES))).toBe(true);
    const timeline = await cases.listTimeline(created.id);
    expect(timeline.filter((event) => event.kind === "evidence_registered")).toHaveLength(2);
    expect(timeline.filter((event) => event.kind === "corpus_intake_committed")).toHaveLength(2);
  });
});
