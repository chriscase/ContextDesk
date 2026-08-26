/**
 * Adversarial coverage for the Log workbench service.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAuditStore } from "../audit/index.js";
import { MemoryWorkbenchStore } from "./store.js";
import {
  WorkbenchConflictError,
  WorkbenchService,
  type WorkbenchCasePort,
  type WorkbenchEvidenceFile,
} from "./service.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hugeCorpus(): WorkbenchEvidenceFile {
  const lines = Array.from({ length: 1_200 }, (_, index) => `ERROR timeout instance ${index} rid-${index}`);
  const text = `${lines.join("\n")}\n`;
  return {
    evidenceId: EVIDENCE_A,
    relativePath: "gateway/edge.log",
    digest: digest(text),
    intakeBatchId: null,
    privacyClass: "owner_only",
    text,
  };
}

function serviceWith(files: WorkbenchEvidenceFile[], revision: number | null = 1) {
  const cases: WorkbenchCasePort = {
    async getCase(id) {
      return id === CASE_ID ? { id } : null;
    },
    async listEvidenceFiles() {
      return files;
    },
    async currentNormalizationRevision() {
      return revision;
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline() {
      return undefined;
    },
  };
  return new WorkbenchService({
    store: new MemoryWorkbenchStore(),
    cases,
    audit: new MemoryAuditStore(),
  });
}

describe("bounded search work", () => {
  it("caps returned matches and reports at least N", async () => {
    const service = serviceWith([hugeCorpus()]);
    const result = await service.search(CASE_ID, ACTOR, false, {
      schemaId: "cd-collab.log_workbench_search_request.v1",
      query: "timeout",
      mode: "literal",
      filters: {
        includeTerms: [],
        excludeTerms: [],
        severity: null,
        component: null,
        file: null,
        rotationFamily: null,
        timeFrom: null,
        timeTo: null,
        evidenceIds: [],
      },
      contextBefore: 0,
      contextAfter: 0,
      cursor: 0,
      limit: 20,
      expectedNormalizationRevision: 1,
    });
    expect(result.returned).toBe(20);
    expect(result.bounded).toBe(true);
    expect(result.atLeast).toBeGreaterThan(20);
    expect(result.nextCursor).toBe(20);
  });

  it("refuses a catastrophic regex at the contract boundary", async () => {
    const service = serviceWith([hugeCorpus()]);
    await expect(
      service.search(CASE_ID, ACTOR, false, {
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "(a+)+",
        mode: "regex",
        filters: {
          includeTerms: [],
          excludeTerms: [],
          severity: null,
          component: null,
          file: null,
          rotationFamily: null,
          timeFrom: null,
          timeTo: null,
          evidenceIds: [],
        },
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 10,
        expectedNormalizationRevision: 1,
      }),
    ).rejects.toThrow(/safely bounded/);
  });

  it("treats a stale search cursor as a later window rather than an error", async () => {
    const service = serviceWith([hugeCorpus()]);
    const result = await service.search(CASE_ID, ACTOR, false, {
      schemaId: "cd-collab.log_workbench_search_request.v1",
      query: "timeout",
      mode: "literal",
      filters: {
        includeTerms: [],
        excludeTerms: [],
        severity: null,
        component: null,
        file: null,
        rotationFamily: null,
        timeFrom: null,
        timeTo: null,
        evidenceIds: [],
      },
      contextBefore: 0,
      contextAfter: 0,
      cursor: 5_000,
      limit: 10,
      expectedNormalizationRevision: 1,
    });
    expect(result.matches).toEqual([]);
    expect(result.atLeast).toBeGreaterThan(0);
  });
});

describe("unicode path identity", () => {
  it("keeps NFC and NFD relative paths as distinct evidence identities", async () => {
    const nfc = "cafe\u0301.log";
    const nfd = "caf\u00e9.log";
    const service = serviceWith([
      {
        evidenceId: EVIDENCE_A,
        relativePath: nfc,
        digest: digest("one\n"),
        intakeBatchId: null,
        privacyClass: "owner_only",
        text: "one\n",
      },
      {
        evidenceId: "55555555-5555-4555-8555-555555555555",
        relativePath: nfd,
        digest: digest("two\n"),
        intakeBatchId: null,
        privacyClass: "owner_only",
        text: "two\n",
      },
    ]);
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    expect(inventory.items).toHaveLength(2);
    expect(new Set(inventory.items.map((item) => item.relativePath)).size).toBe(2);
  });
});

describe("cross-investigation ids", () => {
  it("does not resolve a bookmark token minted on another investigation", async () => {
    const service = serviceWith([
      {
        evidenceId: EVIDENCE_A,
        relativePath: "gateway/edge.log",
        digest: digest("ok\n"),
        intakeBatchId: null,
        privacyClass: "owner_only",
        text: "ok\n",
      },
    ]);
    const denied = await service.resolveLocator(
      {
        schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
        token: "d".repeat(64),
      },
      ACTOR,
      false,
    );
    expect(denied.found).toBe(false);
    expect(denied.investigationId).toBeNull();
  });
});

describe("stale review rule", () => {
  it("refuses to preview a rule against a superseded revision", async () => {
    const service = serviceWith(
      [
        {
          evidenceId: EVIDENCE_A,
          relativePath: "worker/batch.log",
          digest: digest("2024-03-10 01:30:00 INFO start\n"),
          intakeBatchId: null,
          privacyClass: "owner_only",
          text: "2024-03-10 01:30:00 INFO start\n",
        },
      ],
      5,
    );
    await expect(
      service.previewRule(CASE_ID, ACTOR, false, {
        schemaId: "cd-collab.log_time_review_rule.v1",
        scope: "source",
        source: "worker/batch.log",
        rotationFamily: null,
        selectedEvidenceIds: [],
        ianaTimezone: "UTC",
        expectedRevision: 3,
        idempotencyKey: "rule-stale-0001",
      }),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });
});
