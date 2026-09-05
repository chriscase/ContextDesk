import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_DESCRIPTION_MAX_LENGTH,
  SOURCE_IDENTITY_MAX_LENGTH,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_SCHEMA_ID,
  parseSource,
  parseSourceCreateRequest,
  parseSourceList,
  parseSourceMutationSuccess,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type SourceV1,
} from "./source.js";

const TOOL_ID = "11111111-1111-4111-8111-111111111111";

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: TOOL_ID,
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

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
    name: "Web assistant",
    kind: "external-tool",
    description: null,
    identityId: null,
    expectedRevision: 0,
    idempotencyKey: "src-create-0001",
    ...overrides,
  };
}

describe("UUID and identity bounds", () => {
  it("requires a lower-case UUID id", () => {
    expect(() => parseSource(source({ id: "s1" }))).toThrow(/lower-case UUID/);
    expect(() =>
      parseSource(source({ id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })),
    ).toThrow(/lower-case UUID/);
    expect(() => parseSource(source({ id: TOOL_ID.replaceAll("-", "") }))).toThrow(
      /lower-case UUID/,
    );
    expect(() =>
      parseSourceRetireRequest({
        schemaId: "cd-collab.source_retire_request.v1",
        sourceId: "11111111-1111-4111-8111-11111111111G",
        expectedRevision: 1,
        idempotencyKey: "src-retire-0001",
      }),
    ).toThrow(/lower-case UUID/);
  });

  it("rejects empty, overlong, and unnormalized identities", () => {
    expect(() => parseSource(source({ createdBy: "" }))).toThrow(/non-empty/);
    expect(() =>
      parseSource(source({ createdBy: "x".repeat(SOURCE_IDENTITY_MAX_LENGTH + 1) })),
    ).toThrow(/512/);
    expect(() => parseSource(source({ identityId: " alice" }))).toThrow(/NFKC-normalized/);
    expect(() => parseSource(source({ createdBy: "alice " }))).toThrow(/NFKC-normalized/);
    expect(() =>
      parseSourceCreateRequest(createRequest({ identityId: "uid=Ａlice,ou=people,dc=example,dc=test" })),
    ).toThrow(/NFKC-normalized/);
  });
});

describe("label and description bounds", () => {
  it("rejects empty, overlong, and empty-string descriptions", () => {
    expect(() => parseSource(source({ name: "" }))).toThrow(/non-empty/);
    expect(() => parseSource(source({ name: "x".repeat(SOURCE_NAME_MAX_LENGTH + 1) }))).toThrow(
      /200/,
    );
    expect(() => parseSource(source({ description: "" }))).toThrow(/non-empty/);
    expect(() =>
      parseSource(source({ description: "x".repeat(SOURCE_DESCRIPTION_MAX_LENGTH + 1) })),
    ).toThrow(/400/);
    expect(() => parseSourceCreateRequest(createRequest({ name: "   " }))).toThrow(/non-empty/);
    expect(() =>
      parseSourceCreateRequest(createRequest({ name: ` ${"x".repeat(SOURCE_NAME_MAX_LENGTH)}` })),
    ).toThrow(/200/);
  });

  it("preserves literal safe HTML-looking text instead of stripping it", () => {
    const label = "Tool <script>alert(1)</script>";
    expect(parseSource(source({ name: label, description: "Uses <b>html</b> as data" })).name).toBe(
      label,
    );
    expect(parseSourceCreateRequest(createRequest({ name: `  ${label}  ` })).name).toBe(label);
  });
});

describe("dangerous Unicode, control characters, and newlines", () => {
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

  it("rejects control, bidi, zero-width, and multi-line names on stored rows", () => {
    for (const name of hostile) {
      expect(() => parseSource(source({ name }))).toThrow(/control characters|bidi|multi-line/);
    }
  });

  it("rejects the same characters on create input before they can be stored", () => {
    for (const name of hostile) {
      expect(() => parseSourceCreateRequest(createRequest({ name }))).toThrow(
        /control characters|bidi|multi-line/,
      );
    }
    expect(() =>
      parseSourceCreateRequest(createRequest({ description: "first\nsecond" })),
    ).toThrow(/control characters|bidi|multi-line/);
  });
});

describe("NFKC behavior", () => {
  it("requires stored names to already be NFKC-trimmed", () => {
    expect(() => parseSource(source({ name: "  Web assistant  " }))).toThrow(/NFKC-normalized/);
    expect(() => parseSource(source({ name: "Cafe\u0301" }))).toThrow(/NFKC-normalized/);
    expect(parseSource(source({ name: "Café" })).name).toBe("Café");
  });

  it("normalizes create input rather than rejecting compatible Unicode", () => {
    expect(parseSourceCreateRequest(createRequest({ name: "Cafe\u0301" })).name).toBe("Café");
    expect(parseSourceCreateRequest(createRequest({ name: "  Tool  " })).name).toBe("Tool");
  });
});

describe("revision constraints", () => {
  it("rejects revision 0, non-integers, and null", () => {
    expect(() => parseSource(source({ revision: 0 }))).toThrow(/>= 1/);
    expect(() => parseSource(source({ revision: 1.5 }))).toThrow(/unsigned safe integer/);
    expect(() => parseSource(source({ revision: Number.MAX_SAFE_INTEGER + 2 }))).toThrow(
      /unsigned safe integer/,
    );
    expect(() => parseSource({ ...source(), revision: null })).toThrow(/never null/);
  });
});

describe("permanent unknown protection", () => {
  it("requires kind unknown, lifecycle active, and a null identity", () => {
    expect(() =>
      parseSource({
        ...source({
          id: PERMANENT_UNKNOWN_SOURCE_ID,
          kind: "human",
          name: "Unknown",
          createdBy: "system",
        }),
      }),
    ).toThrow(/kind unknown/);
    expect(() =>
      parseSource({
        ...source({
          id: PERMANENT_UNKNOWN_SOURCE_ID,
          kind: "unknown",
          name: "Unknown",
          lifecycle: "retired",
          createdBy: "system",
        }),
      }),
    ).toThrow(/remain active/);
    expect(() =>
      parseSource({
        ...source({
          id: PERMANENT_UNKNOWN_SOURCE_ID,
          kind: "unknown",
          name: "Unknown",
          identityId: "uid=alice,ou=people,dc=example,dc=test",
          createdBy: "system",
        }),
      }),
    ).toThrow(/must not bind an identity/);
  });
});

describe("prototype and constructor drift", () => {
  it("refuses __proto__ and constructor as own keys", () => {
    const withOwnKey = (base: object, key: string, value: unknown): unknown =>
      Object.defineProperty({ ...base }, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });

    expect(() => parseSource(withOwnKey(source(), "__proto__", { polluted: true }))).toThrow(
      /unknown key/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => parseSource(withOwnKey(source(), "constructor", { prototype: {} }))).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseSourceList(
        withOwnKey({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [] }, "__proto__", {
          polluted: true,
        }),
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseSourceCreateRequest(withOwnKey(createRequest(), "__proto__", { x: 1 })),
    ).toThrow(/unknown key/);
  });
});

describe("indexed nested list validation", () => {
  it("names the failing row for ISO, kind, and bound errors", () => {
    expect(() =>
      parseSourceList({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source(), { ...source(), createdAt: "2026-09-04T13:30:00" }],
      }),
    ).toThrow(/\$\.sources\[1\]\.createdAt/);
    expect(() =>
      parseSourceList({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source(), { ...source(), kind: "bot" }],
      }),
    ).toThrow(/\$\.sources\[1\]\.kind/);
    expect(() =>
      parseSourceList({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source(), { ...source(), name: "x".repeat(SOURCE_NAME_MAX_LENGTH + 1) }],
      }),
    ).toThrow(/\$\.sources\[1\]\.name/);
  });
});

describe("create expectedRevision and restore/retire keys", () => {
  it("rejects create expectedRevision other than 0", () => {
    expect(() => parseSourceCreateRequest(createRequest({ expectedRevision: 1 }))).toThrow(
      /must be 0/,
    );
  });

  it("rejects restore/retire idempotency keys with unsafe characters", () => {
    expect(() =>
      parseSourceRestoreRequest({
        schemaId: "cd-collab.source_restore_request.v1",
        sourceId: TOOL_ID,
        expectedRevision: 2,
        idempotencyKey: "<script>",
      }),
    ).toThrow(/8\.\.128/);
    expect(() =>
      parseSourceRetireRequest({
        schemaId: "cd-collab.source_retire_request.v1",
        sourceId: TOOL_ID,
        expectedRevision: 1,
        idempotencyKey: "short",
      }),
    ).toThrow(/8\.\.128/);
  });
});

describe("applied revision identity on success", () => {
  it("rejects appliedRevision that does not match applied.revision", () => {
    expect(() =>
      parseSourceMutationSuccess({
        schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
        action: "create",
        sourceId: TOOL_ID,
        expectedRevision: 0,
        previousRevision: 0,
        appliedRevision: 2,
        replayed: false,
        applied: source({ revision: 1 }),
      }),
    ).toThrow(/must equal appliedRevision/);
  });
});
