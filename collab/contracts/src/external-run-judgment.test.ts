import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_ERROR,
  EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY,
  EXTERNAL_RUN_JUDGMENT_LIMITS,
  EXTERNAL_RUN_JUDGMENT_LINK_KINDS,
  EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_NOT_CORRECTNESS,
  EXTERNAL_RUN_JUDGMENT_REFUSALS,
  EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT,
  EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_VALUES,
  parseExternalRunJudgment,
  parseExternalRunJudgmentConflict,
  parseExternalRunJudgmentList,
  parseExternalRunJudgmentRefused,
  parseExternalRunJudgmentRequest,
  parseExternalRunJudgmentSuccess,
  projectExternalRunJudgmentIdempotencyIntent,
  type ExternalRunJudgmentRefusal,
  type ExternalRunJudgmentValue,
} from "./external-run-judgment.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE_ID = "aabbccdd-eeff-4a11-8b22-ccddeeff0011";
const ARTIFACT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CONTRIBUTION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const RECORDED_AT = "2024-02-11T09:20:00.000Z";
const CREATED_AT = "2024-02-11T08:00:00.000Z";
const LDAP_DN = "uid=operator,ou=people,dc=example,dc=test";
const OPAQUE_ACTOR_ID = "operator-42";

function expectFrozen(value: unknown): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    value.forEach((item) => expectFrozen(item));
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") expectFrozen(nested);
    }
  }
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTOR_ID,
    username: "operator",
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    seq: 1,
    judgment: "corroborates",
    actor: actor(),
    links: [
      { kind: "artifact", id: ARTIFACT_A },
      { kind: "contribution", id: CONTRIBUTION_ID },
    ],
    rationale: "The linked checkout log matches the imported output.",
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    expectedSequence: 0,
    idempotencyKey: "run-judgment-0001",
    judgment: "corroborates",
    links: [
      { kind: "artifact", id: ARTIFACT_A },
      { kind: "contribution", id: CONTRIBUTION_ID },
    ],
    rationale: "The linked checkout log matches the imported output.",
    ...overrides,
  };
}

function runProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    createdAt: CREATED_AT,
    corroborationState: "unverified",
    ...overrides,
  };
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    applied: record(),
    replayed: false,
    run: runProjection(),
    ...overrides,
  };
}

function refusal(
  reason: ExternalRunJudgmentRefusal = "case_archived",
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_JUDGMENT_ERROR,
    caseId: CASE_ID,
    runId: RUN_ID,
    reason,
    detail: "The recorded case state does not allow that action.",
    current: null,
    ...overrides,
  };
}

function conflict(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    expectedSequence: 1,
    currentSequence: 2,
    ...overrides,
  };
}

function list(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID,
    caseId: CASE_ID,
    runId: RUN_ID,
    judgments: [
      record(),
      record({
        seq: 2,
        judgment: "insufficient_evidence",
        links: [],
        rationale: null,
        recordedAt: "2024-02-11T09:21:00.000Z",
      }),
    ],
    ...overrides,
  };
}

function repoRootFrom(start: string): string {
  let dir = start;
  while (true) {
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, "collab", "contracts", "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repo root not found");
    }
    dir = parent;
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function productionFromSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  while ((match = sideEffectRe.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`unresolved import ${specifier} from ${fromFile}`);
}

function walkProductionImportGraph(entryFile: string): {
  files: string[];
  nodeSpecifiers: string[];
} {
  const visited = new Set<string>();
  const nodeSpecifiers: string[] = [];
  const queue = [resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const specifier of productionFromSpecifiers(stripped)) {
      if (specifier.startsWith("node:")) {
        nodeSpecifiers.push(`${relative(dirname(entryFile), file)}:${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      queue.push(resolveRelativeImport(file, specifier));
    }
  }
  return { files: [...visited], nodeSpecifiers };
}

describe("external-run judgment constants", () => {
  it("freezes versioned schema ids, vocabularies, limits, and replay declarations", () => {
    expect(EXTERNAL_RUN_JUDGMENT_SCHEMA_ID).toBe("cd-collab.external_run_judgment.v1");
    expect(EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID).toBe(
      "cd-collab.external_run_judgment_request.v1",
    );
    expect(EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID).toBe(
      "cd-collab.external_run_judgment_success.v1",
    );
    expect(EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID).toBe(
      "cd-collab.external_run_judgment_refused.v1",
    );
    expect(EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID).toBe(
      "cd-collab.external_run_judgment_conflict.v1",
    );
    expect(EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID).toBe("cd-collab.external_run_judgment_list.v1");
    expect(EXTERNAL_RUN_JUDGMENT_VALUES).toEqual([
      "corroborates",
      "contradicts",
      "insufficient_evidence",
    ]);
    expect(EXTERNAL_RUN_JUDGMENT_LINK_KINDS).toEqual(["artifact", "contribution", "snapshot"]);
    expect(EXTERNAL_RUN_JUDGMENT_REFUSALS).toEqual([
      "case_archived",
      "idempotency_intent_mismatch",
      "privacy_mismatch",
      "links_required",
    ]);
    expect(EXTERNAL_RUN_JUDGMENT_NOT_CORRECTNESS).toMatch(/not a correctness verdict/);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_VALUES)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_LINK_KINDS)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_REFUSALS)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_LIMITS)).toBe(true);
    expect(EXTERNAL_RUN_JUDGMENT_LIMITS.actorIdMaxLength).toBe(512);
    expect("titleMaxLength" in EXTERNAL_RUN_JUDGMENT_LIMITS).toBe(false);
    expect("sourceMaxLength" in EXTERNAL_RUN_JUDGMENT_LIMITS).toBe(false);
    expect("cursorMinLength" in EXTERNAL_RUN_JUDGMENT_LIMITS).toBe(false);
    expect("cursorMaxLength" in EXTERNAL_RUN_JUDGMENT_LIMITS).toBe(false);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.lookupKey)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.intentFields)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.excludesFromIntent)).toBe(true);
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.statuses)).toBe(true);
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.lookupKey).toEqual([
      "caseId",
      "runId",
      "authenticatedActor",
      "idempotencyKey",
    ]);
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.intentFields).toEqual([
      "caseId",
      "runId",
      "judgment",
      "links",
      "rationale",
    ]);
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.excludesFromIntent).toEqual([
      "schemaId",
      "idempotencyKey",
      "expectedSequence",
    ]);
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.uncertainOutcome).toBe(
      "freeze_exact_payload_and_idempotency_key_before_retry",
    );
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.statuses.unknownCommit).toBe(503);
    expect(EXTERNAL_RUN_JUDGMENT_IDEMPOTENCY.statuses.unknownCommitCode).toBe(
      "commit_outcome_unknown",
    );
    expect(Object.isFrozen(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT)).toBe(true);
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.runProjection).toMatch(
      /immutable_identity_stub/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.runProjection).toMatch(/unverified/);
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.runProjection).toMatch(
      /never_mirrors_legacy_latest_corroboration/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.list).toBe(
      "complete_unpaged_ordered_contiguous_seq_starting_at_1_bounded_by_later_server_policy",
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.list).toMatch(/complete_unpaged/);
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.list).toMatch(
      /bounded_by_later_server_policy/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.identityMatch).toMatch(
      /server_or_gateway_enforces_route_path_request_and_envelope_case_and_run_identity_match/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.appliedIntent).toMatch(
      /server_or_gateway_enforces_applied_intent_equals_parsed_request/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.appliedSeq).toMatch(
      /applied_seq_equals_expected_sequence_plus_one_on_fresh_success/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.actorBinding).toMatch(
      /applied_actor_equals_authenticated_actor/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.parserCannotProveRequestOrAuth).toMatch(
      /parsers_cannot_prove_request_or_auth_facts/,
    );
    expect(EXTERNAL_RUN_JUDGMENT_RESPONSE_CONTEXT.parserCannotProveRequestOrAuth).toMatch(
      /server_or_gateway_enforces/,
    );
  });

  it("points the package export at the browser-safe dist files", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types?: string; import?: string } | string>;
    };
    expect(pkg.exports["./external-run-judgment"]).toEqual({
      types: "./dist/external-run-judgment.d.ts",
      import: "./dist/external-run-judgment.js",
    });
  });

  it("keeps the package subpath and transitive production imports free of node:* and run.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = repoRootFrom(here);
    const entry = resolve(here, "external-run-judgment.ts");
    const graph = walkProductionImportGraph(entry);
    expect(graph.nodeSpecifiers).toEqual([]);
    const repoRelative = graph.files.map((file) => relative(repoRoot, file).split(sep).join("/"));
    expect(repoRelative).toContain("collab/contracts/src/external-run-judgment.ts");
    expect(repoRelative.some((file) => file.endsWith("/run.ts") || file.endsWith("/run.js"))).toBe(
      false,
    );
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types?: string; import?: string } | string>;
    };
    const subpath = pkg.exports["./external-run-judgment"];
    expect(subpath).toEqual({
      types: "./dist/external-run-judgment.d.ts",
      import: "./dist/external-run-judgment.js",
    });
    if (typeof subpath !== "string") {
      const distJs = resolve(here, "..", subpath.import.replace(/^\.\//, ""));
      if (existsSync(distJs)) {
        const distGraph = walkProductionImportGraph(distJs);
        expect(distGraph.nodeSpecifiers).toEqual([]);
        const distRelative = distGraph.files.map((file) =>
          relative(repoRoot, file).split(sep).join("/"),
        );
        expect(
          distRelative.some((file) => file.endsWith("/run.ts") || file.endsWith("/run.js")),
        ).toBe(false);
      }
    }
  });
});

describe("external-run judgment record", () => {
  it("parses a frozen corroborates record with sorted unique links", () => {
    const parsed = parseExternalRunJudgment(
      record({
        links: [
          { kind: "artifact", id: ARTIFACT_A },
          { kind: "artifact", id: ARTIFACT_B },
          { kind: "contribution", id: CONTRIBUTION_ID },
          { kind: "snapshot", id: SNAPSHOT_ID },
        ],
      }),
    );
    expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_SCHEMA_ID);
    expect(parsed.seq).toBe(1);
    expect(parsed.judgment).toBe("corroborates");
    expect(parsed.actor).toEqual({ id: ACTOR_ID, username: "operator" });
    expect(parsed.links).toEqual([
      { kind: "artifact", id: ARTIFACT_A },
      { kind: "artifact", id: ARTIFACT_B },
      { kind: "contribution", id: CONTRIBUTION_ID },
      { kind: "snapshot", id: SNAPSHOT_ID },
    ]);
    expectFrozen(parsed);
  });

  it("allows empty links for every judgment value", () => {
    for (const judgment of EXTERNAL_RUN_JUDGMENT_VALUES) {
      const parsed = parseExternalRunJudgment(record({ judgment, links: [], rationale: null }));
      expect(parsed.judgment).toBe(judgment);
      expect(parsed.links).toEqual([]);
    }
  });

  it("normalizes actor username whitespace without rewriting already-canonical text", () => {
    const parsed = parseExternalRunJudgment(record({ actor: actor({ username: "  operator  " }) }));
    expect(parsed.actor.username).toBe("operator");
  });

  it("accepts LDAP DN and opaque actor ids without requiring UUID", () => {
    const ldap = parseExternalRunJudgment(record({ actor: actor({ id: LDAP_DN }) }));
    expect(ldap.actor.id).toBe(LDAP_DN);
    const opaque = parseExternalRunJudgment(record({ actor: actor({ id: OPAQUE_ACTOR_ID }) }));
    expect(opaque.actor.id).toBe(OPAQUE_ACTOR_ID);
  });
});

describe("external-run judgment request", () => {
  it("parses a frozen request including expectedSequence 0", () => {
    const parsed = parseExternalRunJudgmentRequest(request());
    expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID);
    expect(parsed.expectedSequence).toBe(0);
    expect(parsed.idempotencyKey).toBe("run-judgment-0001");
    expectFrozen(parsed);
  });

  it("accepts empty links on corroborates and contradicts requests", () => {
    for (const judgment of ["corroborates", "contradicts"] as const) {
      const parsed = parseExternalRunJudgmentRequest(request({ judgment, links: [] }));
      expect(parsed.links).toEqual([]);
    }
  });

  it("projects canonical intent excluding schemaId, idempotencyKey, and expectedSequence", () => {
    const left = projectExternalRunJudgmentIdempotencyIntent(
      request({ expectedSequence: 0, idempotencyKey: "run-judgment-0001" }),
    );
    const right = projectExternalRunJudgmentIdempotencyIntent(
      request({ expectedSequence: 4, idempotencyKey: "run-judgment-9999" }),
    );
    expect(left).toEqual(right);
    expect(left).toEqual({
      caseId: CASE_ID,
      runId: RUN_ID,
      judgment: "corroborates",
      links: [
        { kind: "artifact", id: ARTIFACT_A },
        { kind: "contribution", id: CONTRIBUTION_ID },
      ],
      rationale: "The linked checkout log matches the imported output.",
    });
    expect(Object.keys(left)).toEqual(["caseId", "runId", "judgment", "links", "rationale"]);
    expect("schemaId" in left).toBe(false);
    expect("idempotencyKey" in left).toBe(false);
    expect("expectedSequence" in left).toBe(false);
    expectFrozen(left);
  });

  it("projects equal intent when only the three excluded fields differ, where parseable", () => {
    const base = request();
    const excludedOnly = request({
      schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
      expectedSequence: 12,
      idempotencyKey: "run-judgment-alt-key",
    });
    expect(projectExternalRunJudgmentIdempotencyIntent(base)).toEqual(
      projectExternalRunJudgmentIdempotencyIntent(excludedOnly),
    );
    expect(() =>
      projectExternalRunJudgmentIdempotencyIntent(
        request({ schemaId: "cd-collab.external_run_judgment.v1" }),
      ),
    ).toThrow(ContractViolation);
  });

  it("treats changed semantic intent fields as a different intent", () => {
    const base = projectExternalRunJudgmentIdempotencyIntent(request());
    const changedJudgment = projectExternalRunJudgmentIdempotencyIntent(
      request({ judgment: "contradicts" }),
    );
    const changedLinks = projectExternalRunJudgmentIdempotencyIntent(
      request({ links: [{ kind: "snapshot", id: SNAPSHOT_ID }] }),
    );
    const changedRationale = projectExternalRunJudgmentIdempotencyIntent(
      request({ rationale: "A different recorded rationale." }),
    );
    const changedCase = projectExternalRunJudgmentIdempotencyIntent(
      request({ caseId: "99999999-9999-4999-8999-999999999999" }),
    );
    const changedRun = projectExternalRunJudgmentIdempotencyIntent(
      request({ runId: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(changedJudgment).not.toEqual(base);
    expect(changedLinks).not.toEqual(base);
    expect(changedRationale).not.toEqual(base);
    expect(changedCase).not.toEqual(base);
    expect(changedRun).not.toEqual(base);
  });
});

describe("external-run judgment success", () => {
  it("parses a frozen success envelope whose run projection stays an unverified identity stub", () => {
    const parsed = parseExternalRunJudgmentSuccess(success());
    expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID);
    expect(parsed.replayed).toBe(false);
    expect(parsed.applied.judgment).toBe("corroborates");
    expect(parsed.run).toEqual({
      id: RUN_ID,
      caseId: CASE_ID,
      sourceId: SOURCE_ID,
      createdAt: CREATED_AT,
      corroborationState: "unverified",
    });
    expect(parsed.run.corroborationState).toBe("unverified");
    expect("title" in parsed.run).toBe(false);
    expect("source" in parsed.run).toBe(false);
    expect(EXTERNAL_RUN_JUDGMENT_NOT_CORRECTNESS).not.toMatch(/correct$/);
    expectFrozen(parsed);
  });

  it("accepts a replayed success without treating the judgment as a correctness flip", () => {
    const parsed = parseExternalRunJudgmentSuccess(success({ replayed: true }));
    expect(parsed.replayed).toBe(true);
    expect(parsed.run.corroborationState).toBe("unverified");
  });
});

describe("external-run judgment refusal", () => {
  it("parses every stable refusal with current null", () => {
    for (const reason of EXTERNAL_RUN_JUDGMENT_REFUSALS) {
      const parsed = parseExternalRunJudgmentRefused(refusal(reason));
      expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID);
      expect(parsed.error).toBe(EXTERNAL_RUN_JUDGMENT_ERROR);
      expect(parsed.reason).toBe(reason);
      expect(parsed.current).toBeNull();
      expectFrozen(parsed);
    }
  });

  it("parses links_required as a server-policy refusal, not a request-parser failure", () => {
    const parsed = parseExternalRunJudgmentRefused(refusal("links_required"));
    expect(parsed.reason).toBe("links_required");
    expect(() =>
      parseExternalRunJudgmentRequest(request({ judgment: "corroborates", links: [] })),
    ).not.toThrow();
  });
});

describe("external-run judgment conflict", () => {
  it("parses a stale sequence conflict that is not equal", () => {
    const parsed = parseExternalRunJudgmentConflict(conflict());
    expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID);
    expect(parsed.expectedSequence).toBe(1);
    expect(parsed.currentSequence).toBe(2);
    expectFrozen(parsed);
  });

  it("accepts expectedSequence 0 against a later currentSequence", () => {
    const parsed = parseExternalRunJudgmentConflict(
      conflict({ expectedSequence: 0, currentSequence: 1 }),
    );
    expect(parsed.expectedSequence).toBe(0);
    expect(parsed.currentSequence).toBe(1);
  });
});

describe("external-run judgment list", () => {
  it("parses a frozen complete unpaged list starting at seq 1", () => {
    const parsed = parseExternalRunJudgmentList(list());
    expect(parsed.schemaId).toBe(EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID);
    expect(parsed.judgments.map((row) => row.seq)).toEqual([1, 2]);
    expect("nextCursor" in parsed).toBe(false);
    expectFrozen(parsed);
  });

  it("accepts an empty complete list", () => {
    const empty = parseExternalRunJudgmentList(list({ judgments: [] }));
    expect(empty.judgments).toEqual([]);
    expect("nextCursor" in empty).toBe(false);
  });
});

describe("external-run judgment type exports", () => {
  it("keeps judgment and refusal vocabularies assignable from the frozen arrays", () => {
    const judgment: ExternalRunJudgmentValue = EXTERNAL_RUN_JUDGMENT_VALUES[2];
    const reason: ExternalRunJudgmentRefusal = EXTERNAL_RUN_JUDGMENT_REFUSALS[3];
    expect(judgment).toBe("insufficient_evidence");
    expect(reason).toBe("links_required");
    expect(() => parseExternalRunJudgment(record({ extra: true }))).toThrow(ContractViolation);
  });
});
