import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { sha256Hex, type EvidenceStore } from "../../evidence/store.js";
import type { CaseService, CaseStore } from "../cases/index.js";
import type { TriageJobStore } from "../triage-runs/index.js";
import { LogTimeRequestError } from "./bridge.js";
import {
  LOG_CORPUS_MAX_FILE_BYTES,
  corpusBuilderCapacityError,
  createLogTimeCasePort,
} from "./case-port.js";

const X = new Uint8Array([0x78]);
const Y = new Uint8Array([0x79]);
const X_HASH = sha256Hex(X);
const Y_HASH = sha256Hex(Y);

function evidenceFor(blobs = new Map([[X_HASH, X], [Y_HASH, Y]])) {
  const calls = { get: 0, head: 0, openRead: 0 };
  const evidence = {
    get: async () => {
      calls.get += 1;
      throw new Error("log-time bounded path must not call get");
    },
    head: async (hash: string) => {
      calls.head += 1;
      const bytes = blobs.get(hash);
      return bytes ? { hash, byteLength: bytes.byteLength, contentType: null } : null;
    },
    openRead: async (hash: string) => {
      calls.openRead += 1;
      const bytes = blobs.get(hash);
      if (!bytes) throw new Error("missing");
      return {
        meta: { hash, byteLength: bytes.byteLength, contentType: null },
        range: null,
        byteLength: bytes.byteLength,
        bytes: async function* () { yield bytes; },
      };
    },
  } as unknown as EvidenceStore;
  return { evidence, calls };
}

function corpusPort(fileCount: number) {
  const artifacts = Array.from({ length: fileCount }, (_, index) => ({
    id: `artifact-${index}`,
    relativePath: `logs/${String(index).padStart(4, "0")}.log`,
    contentHash: X_HASH,
    byteLength: X.byteLength,
  }));
  const storage = evidenceFor();
  return {
    port: createLogTimeCasePort({
      cases: { listArtifactsByCase: async () => artifacts } as unknown as CaseStore,
      domain: {} as Pick<CaseService, "getCase">,
      evidence: storage.evidence,
      jobs: {} as TriageJobStore,
    }),
    calls: storage.calls,
  };
}

describe("log corpus builder capacity", () => {
  it("keeps accepted rotated logs in stable order and excludes arbitrary suffixes", async () => {
    const storage = evidenceFor();
    const port = createLogTimeCasePort({
      cases: {
        listArtifactsByCase: async () => [
          { id: "b", relativePath: "logs/service.log.1", contentHash: X_HASH, byteLength: 1 },
          { id: "a", relativePath: "logs/service.log-2026-08-25", contentHash: X_HASH, byteLength: 1 },
          { id: "c", relativePath: "logs/service.log.exe", contentHash: X_HASH, byteLength: 1 },
        ],
      } as unknown as CaseStore,
      domain: {} as Pick<CaseService, "getCase">,
      evidence: storage.evidence,
      jobs: {} as TriageJobStore,
    });

    await expect(port.listCorpusFilesForCase("case-1")).resolves.toEqual([
      { relativePath: "logs/service.log-2026-08-25", contentBase64: "eA==" },
      { relativePath: "logs/service.log.1", contentBase64: "eA==" },
    ]);
    expect(storage.calls.get).toBe(0);
  });

  it("keeps the first committed duplicate path and skips missing stored bytes", async () => {
    const storage = evidenceFor(new Map([[Y_HASH, Y]]));
    const port = createLogTimeCasePort({
      cases: {
        listArtifactsByCase: async () => [
          { id: "first", relativePath: "logs/a.log", contentHash: X_HASH, byteLength: 1 },
          { id: "second", relativePath: "logs/a.log", contentHash: Y_HASH, byteLength: 1 },
          { id: "present", relativePath: "logs/b.log", contentHash: Y_HASH, byteLength: 1 },
        ],
      } as unknown as CaseStore,
      domain: {} as Pick<CaseService, "getCase">,
      evidence: storage.evidence,
      jobs: {} as TriageJobStore,
    });

    await expect(port.listCorpusFilesForCase("case-1")).resolves.toEqual([
      { relativePath: "logs/b.log", contentBase64: "eQ==" },
    ]);
    expect(storage.calls).toEqual({ get: 0, head: 2, openRead: 1 });
  });

  it("shares exact intake byte boundaries without allocating capacity-sized fixtures", () => {
    expect(corpusBuilderCapacityError(
      CORPUS_INTAKE_LIMITS.maxFileCount,
      0,
      LOG_CORPUS_MAX_FILE_BYTES,
    )).toBeNull();
    expect(corpusBuilderCapacityError(CORPUS_INTAKE_LIMITS.maxFileCount + 1, 0, 1))
      .toMatch(/4,096-file/);
    expect(corpusBuilderCapacityError(1, 0, LOG_CORPUS_MAX_FILE_BYTES + 1))
      .toMatch(/64 MiB/);
    expect(corpusBuilderCapacityError(
      2,
      CORPUS_INTAKE_LIMITS.maxExpandedBytes - LOG_CORPUS_MAX_FILE_BYTES + 1,
      LOG_CORPUS_MAX_FILE_BYTES,
    )).toMatch(/512 MiB/);
    expect(corpusBuilderCapacityError(
      2,
      CORPUS_INTAKE_LIMITS.maxExpandedBytes - LOG_CORPUS_MAX_FILE_BYTES,
      LOG_CORPUS_MAX_FILE_BYTES,
    )).toBeNull();
  });

  it("returns all 4,096 eligible files and rejects file 4,097 before storage", async () => {
    const accepted = corpusPort(CORPUS_INTAKE_LIMITS.maxFileCount);
    await expect(accepted.port.listCorpusFilesForCase("case-1"))
      .resolves.toHaveLength(CORPUS_INTAKE_LIMITS.maxFileCount);
    const rejected = corpusPort(CORPUS_INTAKE_LIMITS.maxFileCount + 1);
    await expect(rejected.port.listCorpusFilesForCase("case-1"))
      .rejects.toThrow(LogTimeRequestError);
    expect(rejected.calls).toEqual({ get: 0, head: 0, openRead: 0 });
  });

  it("rejects item and aggregate catalog overflow before probing even missing storage", async () => {
    for (const lengths of [
      [LOG_CORPUS_MAX_FILE_BYTES + 1],
      Array.from({ length: 9 }, () => LOG_CORPUS_MAX_FILE_BYTES),
    ]) {
      const storage = evidenceFor(new Map());
      const artifacts = lengths.map((byteLength, index) => ({
        id: `overflow-${index}`,
        relativePath: `logs/${index}.log`,
        contentHash: X_HASH,
        byteLength,
      }));
      const port = createLogTimeCasePort({
        cases: { listArtifactsByCase: async () => artifacts } as unknown as CaseStore,
        domain: {} as Pick<CaseService, "getCase">,
        evidence: storage.evidence,
        jobs: {} as TriageJobStore,
      });
      await expect(port.listCorpusFilesForCase("case-1")).rejects.toThrow(LogTimeRequestError);
      expect(storage.calls).toEqual({ get: 0, head: 0, openRead: 0 });
    }
  });
});
