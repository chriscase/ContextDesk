import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import type { EvidenceStore } from "../../evidence/store.js";
import type { CaseService, CaseStore } from "../cases/index.js";
import type { TriageJobStore } from "../triage-runs/index.js";
import { LogTimeRequestError } from "./bridge.js";
import { corpusBuilderCapacityError, createLogTimeCasePort } from "./case-port.js";

function corpusPort(fileCount: number) {
  const artifacts = Array.from({ length: fileCount }, (_, index) => ({
    relativePath: `logs/${String(index).padStart(4, "0")}.log`,
    contentHash: `hash-${index}`,
  }));
  return createLogTimeCasePort({
    cases: {
      listArtifactsByCase: async () => artifacts,
    } as unknown as CaseStore,
    domain: {} as Pick<CaseService, "getCase">,
    evidence: {
      get: async () => new Uint8Array([0x78]),
    } as unknown as EvidenceStore,
    jobs: {} as TriageJobStore,
  });
}

describe("log corpus builder capacity", () => {
  it("keeps accepted rotated logs in analysis and excludes arbitrary suffixes", async () => {
    const port = createLogTimeCasePort({
      cases: {
        listArtifactsByCase: async () => [
          { relativePath: "logs/service.log.1", contentHash: "rotated" },
          { relativePath: "logs/service.log-2026-08-25", contentHash: "dated" },
          { relativePath: "logs/service.log.exe", contentHash: "disguised" },
        ],
      } as unknown as CaseStore,
      domain: {} as Pick<CaseService, "getCase">,
      evidence: {
        get: async () => new Uint8Array([0x78]),
      } as unknown as EvidenceStore,
      jobs: {} as TriageJobStore,
    });

    await expect(port.listCorpusFilesForCase("case-1")).resolves.toEqual([
      { relativePath: "logs/service.log-2026-08-25", contentBase64: "eA==" },
      { relativePath: "logs/service.log.1", contentBase64: "eA==" },
    ]);
  });

  it("shares exact intake byte boundaries without allocating capacity-sized fixtures", () => {
    expect(corpusBuilderCapacityError(
      CORPUS_INTAKE_LIMITS.maxFileCount,
      0,
      CORPUS_INTAKE_LIMITS.maxFileBytes,
    )).toBeNull();
    expect(corpusBuilderCapacityError(CORPUS_INTAKE_LIMITS.maxFileCount + 1, 0, 1))
      .toMatch(/4,096-file/);
    expect(corpusBuilderCapacityError(1, 0, CORPUS_INTAKE_LIMITS.maxFileBytes + 1))
      .toMatch(/64 MiB/);
    expect(corpusBuilderCapacityError(
      2,
      CORPUS_INTAKE_LIMITS.maxExpandedBytes - CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
      CORPUS_INTAKE_LIMITS.maxFileBytes,
    ))
      .toMatch(/512 MiB/);
    expect(corpusBuilderCapacityError(
      2,
      CORPUS_INTAKE_LIMITS.maxExpandedBytes - CORPUS_INTAKE_LIMITS.maxFileBytes,
      CORPUS_INTAKE_LIMITS.maxFileBytes,
    ))
      .toBeNull();
  });

  it("returns all 4,096 eligible files and explicitly rejects file 4,097", async () => {
    await expect(corpusPort(CORPUS_INTAKE_LIMITS.maxFileCount).listCorpusFilesForCase("case-1"))
      .resolves.toHaveLength(CORPUS_INTAKE_LIMITS.maxFileCount);
    await expect(corpusPort(CORPUS_INTAKE_LIMITS.maxFileCount + 1).listCorpusFilesForCase("case-1"))
      .rejects.toThrow(LogTimeRequestError);
  });
});
