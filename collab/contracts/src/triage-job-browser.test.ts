import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as packageRoot from "./index.js";
import { ContractViolation as ParseContractViolation } from "./parse.js";
import * as root from "./triage-job.js";
import {
  ContractViolation,
  TRIAGE_JOB_RERUN_AUTHORITY,
  TRIAGE_JOB_RERUN_IDEMPOTENCY,
  TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
  TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
  TRIAGE_JOB_RERUN_RESPONSE_CONTEXT,
  TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
  parseTriageJobRerunRefused,
  parseTriageJobRerunRequest,
  parseTriageJobRerunSuccess,
  type TriageJobRerunRefusedV1,
  type TriageJobRerunRequestV1,
  type TriageJobRerunResponseContextV1,
  type TriageJobRerunSuccessV1,
} from "./triage-job-browser.js";

const here = dirname(fileURLToPath(import.meta.url));
const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FROM_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_SNAPSHOT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const context: TriageJobRerunResponseContextV1 = {
  caseId: CASE_ID,
  fromJobId: FROM_JOB_ID,
  targetSnapshotId: TARGET_SNAPSHOT_ID,
};

function strictRequest(): TriageJobRerunRequestV1 {
  return {
    schemaId: TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
    caseId: CASE_ID,
    fromJobId: FROM_JOB_ID,
    targetSnapshotId: TARGET_SNAPSHOT_ID,
    expectedFromRequestFingerprint: "a".repeat(64),
    expectedTargetSnapshotFingerprint: "b".repeat(64),
    idempotencyKey: "browser-rerun-0001",
  };
}

function appliedJob() {
  return {
    schemaId: "cd-collab.triage_job.v1",
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    caseId: CASE_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotFingerprint: "b".repeat(64),
    requestFingerprint: "c".repeat(64),
    cancellationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    parentJobId: FROM_JOB_ID,
    request: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: TARGET_SNAPSHOT_ID,
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard",
      question: "Recheck the recorded investigation state.",
      policyFingerprint: null,
      taskFingerprint: "task-fingerprint",
      parentJobId: FROM_JOB_ID,
      candidates: [],
    },
    status: "queued",
    candidates: [],
    sameSnapshot: true,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "uid=lead",
    requestedByUsername: "lead",
    createdAt: "2026-09-09T12:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    stoppedReason: null,
  };
}

const importSpecifierRe =
  /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gu;

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(importSpecifierRe)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function resolveLocalModule(from: string, specifier: string): string {
  const candidate = resolve(dirname(from), specifier.replace(/\.js$/u, ".ts"));
  if (!existsSync(candidate)) throw new Error(`missing local module ${candidate}`);
  return candidate;
}

function browserGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of moduleSpecifiers(readFileSync(current, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(resolveLocalModule(current, specifier));
    }
  }
  return visited;
}

function forbiddenRuntimeSpecifiers(source: string): string[] {
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);
  return moduleSpecifiers(source).filter(
    (specifier) => !specifier.startsWith(".") || builtins.has(specifier),
  );
}

describe("browser-safe triage job contract", () => {
  it("re-exports the authoritative root symbols by identity", () => {
    expect(ContractViolation).toBe(ParseContractViolation);
    expect(TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID).toBe(
      root.TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
    );
    expect(TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID).toBe(
      root.TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
    );
    expect(TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID).toBe(
      root.TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
    );
    expect(TRIAGE_JOB_RERUN_AUTHORITY).toBe(root.TRIAGE_JOB_RERUN_AUTHORITY);
    expect(TRIAGE_JOB_RERUN_IDEMPOTENCY).toBe(root.TRIAGE_JOB_RERUN_IDEMPOTENCY);
    expect(TRIAGE_JOB_RERUN_RESPONSE_CONTEXT).toBe(
      root.TRIAGE_JOB_RERUN_RESPONSE_CONTEXT,
    );
    expect(parseTriageJobRerunRequest).toBe(root.parseTriageJobRerunRequest);
    expect(parseTriageJobRerunSuccess).toBe(root.parseTriageJobRerunSuccess);
    expect(parseTriageJobRerunRefused).toBe(root.parseTriageJobRerunRefused);
    expect(parseTriageJobRerunRequest).toBe(packageRoot.parseTriageJobRerunRequest);
    expect(parseTriageJobRerunSuccess).toBe(packageRoot.parseTriageJobRerunSuccess);
    expect(parseTriageJobRerunRefused).toBe(packageRoot.parseTriageJobRerunRefused);
  });

  it("parses request, success, and refusal values through the browser entry", () => {
    const request = parseTriageJobRerunRequest(strictRequest());
    expect(request.fromJobId).toBe(FROM_JOB_ID);

    const success: TriageJobRerunSuccessV1 = parseTriageJobRerunSuccess(
      {
        schemaId: TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
        ...context,
        applied: appliedJob(),
        replayed: true,
      },
      context,
    );
    expect(success.replayed).toBe(true);

    const refused: TriageJobRerunRefusedV1 = parseTriageJobRerunRefused(
      {
        schemaId: TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
        error: "triage_job_rerun_refused",
        ...context,
        reason: "target_not_forward_descendant",
        detail: "The selected snapshot is not a forward descendant.",
      },
      context,
    );
    expect(refused.reason).toBe("target_not_forward_descendant");
  });

  it("publishes the triage-job browser subpath", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types?: string; import?: string } | string>;
    };
    expect(pkg.exports["./triage-job"]).toEqual({
      types: "./dist/triage-job-browser.d.ts",
      import: "./dist/triage-job-browser.js",
    });
  });

  it("keeps the complete browser entry graph free of packages and Node built-ins", () => {
    const entry = join(here, "triage-job-browser.ts");
    const graph = browserGraph(entry);
    expect([...graph].map((path) => path.slice(here.length + 1)).sort()).toEqual([
      "case.ts",
      "parse.ts",
      "temporal.ts",
      "triage-job-browser.ts",
      "triage-job.ts",
      "triage-lifecycle.ts",
    ]);
    for (const file of graph) {
      expect(forbiddenRuntimeSpecifiers(readFileSync(file, "utf8")), file).toEqual([]);
    }
  });

  it("proves the browser graph guard catches direct and transitive forbidden imports", () => {
    expect(forbiddenRuntimeSpecifiers('import { createHash } from "node:crypto";')).toEqual([
      "node:crypto",
    ]);
    expect(forbiddenRuntimeSpecifiers('export * from "server-only-package";')).toEqual([
      "server-only-package",
    ]);
    expect(forbiddenRuntimeSpecifiers('const crypto = await import("node:crypto");')).toEqual([
      "node:crypto",
    ]);
  });
});
