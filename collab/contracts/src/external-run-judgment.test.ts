import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
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

const Ajv2020 = (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const loadSchema = (name: string): object =>
  JSON.parse(readFileSync(join(here, "..", "schemas", name), "utf8")) as object;

function validator(schemaName: string) {
  const AjvCtor = Ajv2020 as unknown as new (opts: object) => {
    compile: (schema: object) => (data: unknown) => boolean;
  };
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  return ajv.compile(loadSchema(schemaName));
}

const JUDGMENT_SCHEMA_FILES = [
  {
    file: "external-run-judgment.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_SCHEMA_ID,
  },
  {
    file: "external-run-judgment-request.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  },
  {
    file: "external-run-judgment-success.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_SUCCESS_SCHEMA_ID,
  },
  {
    file: "external-run-judgment-refused.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_REFUSED_SCHEMA_ID,
  },
  {
    file: "external-run-judgment-conflict.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_CONFLICT_SCHEMA_ID,
  },
  {
    file: "external-run-judgment-list.v1.json",
    schemaId: EXTERNAL_RUN_JUDGMENT_LIST_SCHEMA_ID,
  },
] as const;

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

type SchemaDocument = {
  $id: string;
  additionalProperties: boolean;
  properties: { schemaId: { const: string } };
};

function expectParserAndSchemaAccept(
  parse: (raw: unknown) => unknown,
  schemaFile: string,
  payload: unknown,
): void {
  expect(parse(payload)).toBeTruthy();
  expect(validator(schemaFile)(payload)).toBe(true);
}

function expectParserAndSchemaReject(
  parse: (raw: unknown) => unknown,
  schemaFile: string,
  payload: unknown,
): void {
  expect(() => parse(payload)).toThrow(ContractViolation);
  expect(validator(schemaFile)(payload)).toBe(false);
}

function expectSchemaAcceptsParserRejects(
  parse: (raw: unknown) => unknown,
  schemaFile: string,
  payload: unknown,
): void {
  expect(validator(schemaFile)(payload)).toBe(true);
  expect(() => parse(payload)).toThrow(ContractViolation);
}

function tooManyLinks() {
  return Array.from({ length: EXTERNAL_RUN_JUDGMENT_LIMITS.linksMax + 1 }, (_, index) => ({
    kind: "artifact" as const,
    id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
  }));
}

describe("external-run judgment JSON Schema / Ajv parity", () => {
  it("loads all six schemas into one Ajv instance and keeps $id aligned with TypeScript schema constants", () => {
    const AjvCtor = Ajv2020 as unknown as new (opts: object) => {
      compile: (schema: object) => (data: unknown) => boolean;
    };
    const ajv = new AjvCtor({ strict: true, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);
    expect(JUDGMENT_SCHEMA_FILES).toHaveLength(6);
    for (const { file, schemaId } of JUDGMENT_SCHEMA_FILES) {
      const schema = loadSchema(file) as SchemaDocument;
      expect(schema.$id).toBe(`https://cd-collab.local/schemas/${file}`);
      expect(schema.properties.schemaId.const).toBe(schemaId);
      expect(schema.additionalProperties).toBe(false);
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it("accepts valid parser+schema pairs for record, request, success, refusal, conflict, and list", () => {
    expectParserAndSchemaAccept(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: LDAP_DN }) }),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: OPAQUE_ACTOR_ID }) }),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ judgment: "corroborates", links: [] }),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("links_required"),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentConflict,
      "external-run-judgment-conflict.v1.json",
      conflict(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list(),
    );
    expectParserAndSchemaAccept(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({ judgments: [] }),
    );
  });

  it("rejects malformed schema IDs on every envelope", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ schemaId: "cd-collab.external_run_judgment.v2" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ schemaId: EXTERNAL_RUN_JUDGMENT_SCHEMA_ID }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ schemaId: "cd-collab.external_run_import_success.v1" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("case_archived", { schemaId: "cd-collab.external_run_judgment.v1" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentConflict,
      "external-run-judgment-conflict.v1.json",
      conflict({ schemaId: "cd-collab.external_run_judgment_list.v1" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({ schemaId: "not-a-schema" }),
    );
  });

  it("rejects unknown keys on every judgment schema", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ extra: true }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ actorId: ACTOR_ID }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ leak: true }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("case_archived", { retryable: false }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentConflict,
      "external-run-judgment-conflict.v1.json",
      conflict({ applied: record() }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({ nextCursor: null }),
    );
  });

  it("rejects mixed-case UUIDs on case, run, source, and link ids", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ caseId: CASE_ID.toUpperCase() }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ runId: RUN_ID.toUpperCase() }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ links: [{ kind: "artifact", id: ARTIFACT_A.toUpperCase() }] }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ run: runProjection({ sourceId: SOURCE_ID.toUpperCase() }) }),
    );
  });

  it("rejects invalid actor ids, bounded text, and non-canonical times that JSON Schema can express", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: " operator-42" }) }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: "operator-42 " }) }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: "op\nerator" }) }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: "op\u202eerator" }) }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({
        actor: actor({ id: "x".repeat(EXTERNAL_RUN_JUDGMENT_LIMITS.actorIdMaxLength + 1) }),
      }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ username: "op\nerator" }) }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ rationale: "because\r\n" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ recordedAt: "yesterday" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ recordedAt: "2024-02-11T09:20:00Z" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ recordedAt: "2024-02-11T09:20:00+00:00" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ run: runProjection({ createdAt: "2024-02-11T10:00:00+02:00" }) }),
    );
  });

  it("rejects bad judgment, refusal, and run-projection enums", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ judgment: "corroborated" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("case_archived", { reason: "run_not_found" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ run: runProjection({ corroborationState: "corroborated" }) }),
    );
  });

  it("rejects too many and duplicate links that JSON Schema can express", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ links: tooManyLinks() }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({
        links: [
          { kind: "artifact", id: ARTIFACT_A },
          { kind: "artifact", id: ARTIFACT_A },
        ],
      }),
    );
  });

  it("rejects seq below 1 and expectedSequence below 0", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ seq: 0 }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ seq: 1.5 }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ expectedSequence: -1 }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      request({ expectedSequence: Number.MAX_SAFE_INTEGER + 1 }),
    );
  });

  it("rejects a non-null refusal current", () => {
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("case_archived", { current: "present" }),
    );
    expectParserAndSchemaReject(
      parseExternalRunJudgmentRefused,
      "external-run-judgment-refused.v1.json",
      refusal("links_required", { current: record() }),
    );
  });

  it("JSON Schema cannot express cross-item lexical link order: schema accepts unsorted unique links, parser rejects", () => {
    const unsorted = request({
      links: [
        { kind: "contribution", id: CONTRIBUTION_ID },
        { kind: "artifact", id: ARTIFACT_A },
      ],
    });
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentRequest,
      "external-run-judgment-request.v1.json",
      unsorted,
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({
        links: [
          { kind: "artifact", id: ARTIFACT_B },
          { kind: "artifact", id: ARTIFACT_A },
        ],
      }),
    );
  });

  it("JSON Schema cannot express NFKC actor identity: schema accepts decomposed text, parser rejects", () => {
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgment,
      "external-run-judgment.v1.json",
      record({ actor: actor({ id: "Cafe\u0301" }) }),
    );
  });

  it("JSON Schema cannot compare nested envelope identities: schema accepts mismatched success identities, parser rejects", () => {
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ applied: record({ caseId: "99999999-9999-4999-8999-999999999999" }) }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ applied: record({ runId: "99999999-9999-4999-8999-999999999999" }) }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ run: runProjection({ id: "99999999-9999-4999-8999-999999999999" }) }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentSuccess,
      "external-run-judgment-success.v1.json",
      success({ run: runProjection({ caseId: "99999999-9999-4999-8999-999999999999" }) }),
    );
  });

  it("JSON Schema cannot compare conflict sequence values: schema accepts equal versions, parser rejects", () => {
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentConflict,
      "external-run-judgment-conflict.v1.json",
      conflict({ expectedSequence: 2, currentSequence: 2 }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentConflict,
      "external-run-judgment-conflict.v1.json",
      conflict({ expectedSequence: 0, currentSequence: 0 }),
    );
  });

  it("JSON Schema cannot express contiguous list identity/sequence: schema accepts a gap or identity drift, parser rejects", () => {
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({ judgments: [record({ seq: 2 })] }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({
        judgments: [record(), record({ seq: 3, links: [], rationale: null })],
      }),
    );
    expectSchemaAcceptsParserRejects(
      parseExternalRunJudgmentList,
      "external-run-judgment-list.v1.json",
      list({
        judgments: [record({ caseId: "99999999-9999-4999-8999-999999999999" })],
      }),
    );
  });
});

