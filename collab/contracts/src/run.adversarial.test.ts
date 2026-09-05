import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import { CONTRIBUTION_SCHEMA_ID } from "./contribution.js";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_SCHEMA_ID,
  type SourceV1,
} from "./source.js";
import {
  EXTERNAL_RUN_IMPORT_ERROR,
  EXTERNAL_RUN_IMPORT_LIMITS,
  EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
  EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
  EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT,
  EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
  EXTERNAL_RUN_SCHEMA_ID,
  parseExternalRun,
  parseExternalRunImportRefused,
  parseExternalRunImportRequest,
  parseExternalRunImportSuccess,
  type ExternalRunV1,
} from "./run.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTRIBUTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ARTIFACT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTPUT_HASH = "b1019aa43e0e82ea484cdde142a7c5b3d56664bfb838b01357e24e79067723d6";
const PROMPT_HASH = "2426ba4b46c4cb3d058d7fdd6c15e766dd2ee56721f87e643d56c6b5796f729b";

function withOwnKey(base: object, key: string, value: unknown): unknown {
  return Object.defineProperty({ ...base }, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
    importMode: "manual",
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    expectedSourceRevision: 3,
    outputText: "imported output",
    promptText: "imported prompt",
    promptCompleteness: "exact",
    outputCompleteness: "exact",
    workflowCompleteness: "partial",
    evidenceVisibility: "unknown",
    evidenceArtifactIds: [],
    snapshotBinding: null,
    visibilityNote: null,
    operator: {
      identityId: "uid=operator,ou=people,dc=example,dc=test",
      username: "operator",
    },
    provider: "example-assistant",
    model: "demo-model",
    version: "1.0",
    claimedTraces: ["mailer-pool"],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    idempotencyKey: "run-import-0001",
    ...overrides,
  };
}

function applied(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_SCHEMA_ID,
    id: RUN_ID,
    caseId: CASE_ID,
    contributionId: CONTRIBUTION_ID,
    sourceId: SOURCE_ID,
    outputHash: OUTPUT_HASH,
    outputText: "imported output",
    promptHash: PROMPT_HASH,
    promptText: "imported prompt",
    promptCompleteness: "exact",
    outputCompleteness: "exact",
    workflowCompleteness: "partial",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: "uid=alice,ou=people,dc=example,dc=test",
    importerUsername: "alice",
    operatorId: "uid=operator,ou=people,dc=example,dc=test",
    operatorUsername: "operator",
    provider: "example-assistant",
    model: "demo-model",
    version: "1.0",
    claimedTraces: ["mailer-pool"],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    corroborationState: "unverified",
    createdAt: "2026-09-05T12:00:00.000Z",
    importMode: "manual",
    sourceRevision: 3,
    evidenceArtifactIds: [],
    ...overrides,
  };
}

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: CONTRIBUTION_SCHEMA_ID,
    id: CONTRIBUTION_ID,
    caseId: CASE_ID,
    kind: "external_run",
    revision: 1,
    predecessorRevision: null,
    body: "Imported external run",
    contentHash: "sha256:imported-run",
    privacyClass: "owner_only",
    tombstoned: false,
    authorId: "uid=alice,ou=people,dc=example,dc=test",
    authorUsername: "alice",
    createdAt: "2026-09-05T12:00:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: SOURCE_ID,
    ...overrides,
  };
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
    importMode: "manual",
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    expectedSourceRevision: 3,
    replayed: false,
    applied: applied(),
    contribution: contribution(),
    ...overrides,
  };
}

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: SOURCE_ID,
    name: "Web assistant",
    kind: "external-tool",
    description: null,
    lifecycle: "active",
    identityId: null,
    createdAt: "2026-09-04T13:30:00.000Z",
    createdBy: "uid=alice,ou=people,dc=example,dc=test",
    revision: 1,
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_IMPORT_ERROR,
    importMode: "manual",
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    expectedSourceRevision: 3,
    reason: "case_archived",
    detail: "The recorded case or source state does not allow that import.",
    current: null,
    ...overrides,
  };
}

function legacyRun(overrides: Record<string, unknown> = {}): ExternalRunV1 {
  return {
    schemaId: EXTERNAL_RUN_SCHEMA_ID,
    id: RUN_ID,
    caseId: CASE_ID,
    contributionId: CONTRIBUTION_ID,
    sourceId: SOURCE_ID,
    outputHash: "not-a-sha",
    outputText: "imported output",
    promptHash: null,
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "partial",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: "alice",
    importerUsername: "alice",
    operatorId: "operator",
    operatorUsername: "operator",
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "share_safe",
    corroborationState: "unverified",
    createdAt: "yesterday",
    ...overrides,
  } as ExternalRunV1;
}

describe("hostile Unicode and control characters", () => {
  const hostile = [
    "Web\nassistant",
    "Web\rassistant",
    "Web\u0000assistant",
    "Web\u0007assistant",
    "Web\u001bassistant",
    "Web\u007fassistant",
    "Web\u200bassistant",
    "Web\u202eassistant",
    "Web\u2028assistant",
    "Web\u2066assistant",
  ];

  it("rejects control, bidi, and line-separator metadata on the request", () => {
    for (const provider of hostile) {
      expect(() => parseExternalRunImportRequest(request({ provider }))).toThrow(
        /control characters|bidi|multi-line/,
      );
    }
    expect(() =>
      parseExternalRunImportRequest(request({ claimedTraces: ["trace\u202e"] })),
    ).toThrow(/control characters|bidi|multi-line/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          operator: {
            identityId: "uid=op\u200berator,ou=people,dc=example,dc=test",
            username: "operator",
          },
        }),
      ),
    ).toThrow(/control characters|bidi|multi-line/);
  });

  it("lets notes keep ordinary newlines but rejects dangerous Unicode there too", () => {
    expect(
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          visibilityNote: "line one\nline two",
          uncertainty: "maybe\nlater",
        }),
      ).visibilityNote,
    ).toBe("line one\nline two");
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          visibilityNote: "line\u2028two",
        }),
      ),
    ).toThrow(/line separators|bidi|control characters/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          visibilityNote: "note\u202e",
        }),
      ),
    ).toThrow(/control characters|bidi|line separators/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ uncertainty: "maybe\u0000later" }),
      ),
    ).toThrow(/control characters|bidi|line separators/);
  });

  it("does not scan output or prompt for dangerous Unicode because those bytes are exact", () => {
    const outputText = "result\u202e\n\u0000";
    const promptText = "prompt\u200b";
    const parsed = parseExternalRunImportRequest(request({ outputText, promptText }));
    expect(parsed.outputText).toBe(outputText);
    expect(parsed.promptText).toBe(promptText);
  });

  it("rejects dangerous Unicode on stored success identities and refusal detail", () => {
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ importerUsername: "ali\u202ece" }) }),
      ),
    ).toThrow(/control characters|bidi|multi-line/);
    expect(() =>
      parseExternalRunImportRefused(refusal({ detail: "Archived\u202ecase" })),
    ).toThrow(/control characters|bidi|multi-line/);
  });
});

describe("unknown, inherited, prototype, and accessor keys", () => {
  it("refuses __proto__, constructor, and toString as own keys", () => {
    expect(() => parseExternalRun(withOwnKey(legacyRun(), "__proto__", { polluted: true }))).toThrow(
      /unknown key/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => parseExternalRun(withOwnKey(legacyRun(), "constructor", { prototype: {} }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunImportRequest(withOwnKey(request(), "toString", "nope"))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunImportSuccess(withOwnKey(success(), "valueOf", 1))).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseExternalRunImportRefused(withOwnKey(refusal(), "hasOwnProperty", true)),
    ).toThrow(/unknown key/);
  });

  it("does not treat an inherited prototype key as a supplied field", () => {
    const inherited = Object.create({
      schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
    }) as Record<string, unknown>;
    Object.assign(inherited, {
      importMode: "manual",
      caseId: CASE_ID,
      sourceId: SOURCE_ID,
      expectedSourceRevision: 3,
      outputText: "imported output",
      promptText: "imported prompt",
      promptCompleteness: "exact",
      outputCompleteness: "exact",
      workflowCompleteness: "partial",
      evidenceVisibility: "unknown",
      evidenceArtifactIds: [],
      snapshotBinding: null,
      visibilityNote: null,
      operator: null,
      provider: null,
      model: null,
      version: null,
      claimedTraces: [],
      uncertainty: null,
      timing: null,
      cost: null,
      redacted: false,
      privacyClass: "owner_only",
      idempotencyKey: "run-import-0001",
    });
    expect(() => parseExternalRunImportRequest(inherited)).toThrow(/no inherited properties/);
  });

  it("rejects accessors without invoking them, including nested response values", () => {
    let calls = 0;
    const hostileRequest = { ...request() };
    Object.defineProperty(hostileRequest, "provider", {
      enumerable: true,
      get() {
        calls += 1;
        return "should-not-run";
      },
    });
    expect(() => parseExternalRunImportRequest(hostileRequest)).toThrow(/accessor properties/);

    const hostileApplied = { ...applied() };
    Object.defineProperty(hostileApplied, "importerId", {
      enumerable: true,
      get() {
        calls += 1;
        return "should-not-run";
      },
    });
    expect(() =>
      parseExternalRunImportSuccess(success({ applied: hostileApplied })),
    ).toThrow(/accessor properties/);
    expect(calls).toBe(0);
  });

  it("rejects sparse arrays and non-data prototypes on import envelopes", () => {
    const sparse = Array(1) as string[];
    expect(() =>
      parseExternalRunImportRequest(request({ evidenceArtifactIds: sparse })),
    ).toThrow(/sparse arrays/);

    const inheritedRequest = Object.assign(Object.create({ authority: "admin" }), request());
    expect(() => parseExternalRunImportRequest(inheritedRequest)).toThrow(/no inherited properties/);
  });

  it("rejects cycles and symbol keys before contract traversal", () => {
    const cyclic = request() as Record<string, unknown>;
    cyclic.operator = cyclic;
    expect(() => parseExternalRunImportRequest(cyclic)).toThrow(/cyclic values/);

    const symbolKey = Symbol("authority");
    const withSymbol = request() as Record<PropertyKey, unknown>;
    withSymbol[symbolKey] = "admin";
    expect(() => parseExternalRunImportRequest(withSymbol)).toThrow(/symbol keys/);

    const cyclicSuccess = success() as Record<string, unknown>;
    (cyclicSuccess.applied as Record<string, unknown>).cycle = cyclicSuccess;
    expect(() => parseExternalRunImportSuccess(cyclicSuccess)).toThrow(/cyclic values/);

    const symbolCurrent = source({ lifecycle: "retired", revision: 2 }) as Record<
      PropertyKey,
      unknown
    >;
    symbolCurrent[symbolKey] = "admin";
    expect(() =>
      parseExternalRunImportRefused(
        refusal({ reason: "source_retired", current: symbolCurrent }),
      ),
    ).toThrow(/symbol keys/);
  });

  it("refuses JSON.parse __proto__ injection rather than silently accepting it", () => {
    const hostile = JSON.parse(
      JSON.stringify(request()).replace(
        /}$/,
        ',"__proto__":{"polluted":true}}',
      ),
    ) as unknown;
    expect(() => parseExternalRunImportRequest(hostile)).toThrow(ContractViolation);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("schema drift and nested extras", () => {
  it("rejects drifted schema ids and invented import modes", () => {
    expect(() =>
      parseExternalRunImportRequest(request({ schemaId: "cd-collab.external_run_import_request.v2" })),
    ).toThrow(ContractViolation);
    expect(() => parseExternalRunImportRequest(request({ importMode: "background" }))).toThrow(
      ContractViolation,
    );
    expect(() =>
      parseExternalRunImportSuccess(success({ schemaId: "cd-collab.external_run_import_success.v2" })),
    ).toThrow(ContractViolation);
    expect(() => parseExternalRun(legacyRun({ schemaId: "cd-collab.external_run.v2" }))).toThrow(
      ContractViolation,
    );
  });

  it("rejects nested extras on operator, applied, contribution, and current", () => {
    expect(() =>
      parseExternalRunImportRequest(
        request({
          operator: {
            identityId: "uid=operator,ou=people,dc=example,dc=test",
            username: "operator",
            role: "admin",
          },
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunImportSuccess(success({ applied: { ...applied(), nestedLeak: true } })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: { ...contribution(), predecessorId: CONTRIBUTION_ID } }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal({
          reason: "source_retired",
          current: { ...source({ lifecycle: "retired", revision: 2 }), nestedLeak: true },
        }),
      ),
    ).toThrow(/unknown key/);
  });

  it("rejects actor, automatic-write, and authority fields that do not exist on the request", () => {
    expect(() => parseExternalRunImportRequest(request({ actorId: "alice" }))).toThrow(/unknown key/);
    expect(() => parseExternalRunImportRequest(request({ importerId: "alice" }))).toThrow(
      /unknown key/,
    );
    expect(() => parseExternalRunImportRequest(request({ background: true }))).toThrow(
      /unknown key/,
    );
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.noAutomaticWrites).toContain("no_automatic");
  });
});

describe("404 non-domain design and permanent-unknown semantics", () => {
  it("keeps missing or concealed case, source, artifact, and snapshot out of the refusal enum", () => {
    for (const reason of [
      "source_not_found",
      "case_not_found",
      "artifact_not_found",
      "snapshot_not_found",
      "permanent_unknown_protected",
    ]) {
      expect(() => parseExternalRunImportRefused(refusal({ reason }))).toThrow(ContractViolation);
    }
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.concealed).toContain(
      "ordinary_indistinguishable_404",
    );
  });

  it("does not invent a permanent-unknown import refusal; kind unknown remains importable", () => {
    const unversionedUnknown = source({
      id: PERMANENT_UNKNOWN_SOURCE_ID,
      name: "Unknown",
      kind: "unknown",
      description: "Permanent unknown source. Never auto-upgraded.",
      createdAt: "1970-01-01T00:00:00.000Z",
      createdBy: "system",
    });
    delete unversionedUnknown.revision;
    expect(
      parseExternalRunImportRefused(
        refusal({
          reason: "source_not_versioned",
          sourceId: PERMANENT_UNKNOWN_SOURCE_ID,
          current: unversionedUnknown,
        }),
      ).current?.kind,
    ).toBe("unknown");
  });
});

describe("bound and completeness pressure", () => {
  it("rejects overlong metadata, traces, notes, and clientTime", () => {
    expect(() =>
      parseExternalRunImportRequest(
        request({ provider: "x".repeat(EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength + 1) }),
      ),
    ).toThrow(/200/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          claimedTraces: Array.from(
            { length: EXTERNAL_RUN_IMPORT_LIMITS.claimedTracesMax + 1 },
            (_, index) => `trace-${index}`,
          ),
        }),
      ),
    ).toThrow(/at most 32/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          visibilityNote: "x".repeat(EXTERNAL_RUN_IMPORT_LIMITS.visibilityNoteMaxLength + 1),
        }),
      ),
    ).toThrow(/1000/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ uncertainty: "x".repeat(EXTERNAL_RUN_IMPORT_LIMITS.uncertaintyMaxLength + 1) }),
      ),
    ).toThrow(/4000/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ clientTime: `${"2026-09-05T12:00:00.000Z"}${"0".repeat(41)}` }),
      ),
    ).toThrow(/64/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal({
          detail: "x".repeat(EXTERNAL_RUN_IMPORT_LIMITS.refusalDetailMaxLength + 1),
        }),
      ),
    ).toThrow(/600/);
  });

  it("rejects a success contribution that names a predecessor or leaves the first revision", () => {
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ predecessorId: ARTIFACT_A }) }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ revision: 1, predecessorRevision: 1 }) }),
      ),
    ).toThrow(/predecessor must be null/);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "import"],
    ["a number", 7],
  ])("refuses %s in place of a request object", (_label, body) => {
    expect(() => parseExternalRunImportRequest(body)).toThrow(ContractViolation);
  });
});
