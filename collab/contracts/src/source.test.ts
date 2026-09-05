import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CATALOG_RESPONSE_CONTEXT,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_IDEMPOTENCY_KEY_RE,
  SOURCE_KINDS,
  SOURCE_LIFECYCLES,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_ACTIONS,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_REFUSALS,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  parseSource,
  parseSourceCreateRequest,
  parseSourceList,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type SourceMutationAction,
  type SourceMutationRefusal,
  type SourceV1,
} from "./source.js";

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

const TOOL_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";

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

function legacySource(): SourceV1 {
  const row = source();
  delete row.revision;
  return row;
}

function permanentUnknown(overrides: Partial<SourceV1> = {}): SourceV1 {
  return source({
    id: PERMANENT_UNKNOWN_SOURCE_ID,
    name: "Unknown",
    kind: "unknown",
    description: "Permanent unknown source. Never auto-upgraded.",
    lifecycle: "active",
    identityId: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    createdBy: "system",
    ...overrides,
  });
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

function retireRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
    sourceId: TOOL_ID,
    expectedRevision: 1,
    idempotencyKey: "src-retire-0001",
    ...overrides,
  };
}

function restoreRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
    sourceId: TOOL_ID,
    expectedRevision: 2,
    idempotencyKey: "src-restore-0001",
    ...overrides,
  };
}

function success(
  action: SourceMutationAction,
  applied: SourceV1,
  extras: Record<string, unknown> = {},
) {
  const previousRevision = action === "create" ? 0 : (applied.revision ?? 1) - 1;
  const appliedRevision = applied.revision ?? 1;
  return {
    schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
    action,
    sourceId: applied.id,
    expectedRevision: previousRevision,
    previousRevision,
    appliedRevision,
    replayed: false,
    applied,
    ...extras,
  };
}

function refusal(
  action: SourceMutationAction,
  reason: SourceMutationRefusal,
  extras: Record<string, unknown> = {},
) {
  return {
    schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
    error: "source_catalog_refused",
    action,
    sourceId: action === "create" ? null : TOOL_ID,
    expectedRevision: action === "create" ? 0 : 1,
    reason,
    detail: "The recorded catalog state does not allow that action.",
    current: null,
    ...extras,
  };
}

describe("source catalog constants", () => {
  it("preserves the existing kind, lifecycle, and schema identities", () => {
    expect([...SOURCE_KINDS]).toEqual([
      "human",
      "external-tool",
      "internal-system",
      "contextdesk",
      "unknown",
    ]);
    expect([...SOURCE_LIFECYCLES]).toEqual(["active", "retired"]);
    expect(SOURCE_SCHEMA_ID).toBe("cd-collab.source.v1");
    expect(SOURCE_LIST_SCHEMA_ID).toBe("cd-collab.source_list.v1");
    expect(PERMANENT_UNKNOWN_SOURCE_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect([...SOURCE_MUTATION_ACTIONS]).toEqual(["create", "retire", "restore"]);
  });

  it("freezes the server-only response context map", () => {
    expect(Object.isFrozen(SOURCE_CATALOG_RESPONSE_CONTEXT)).toBe(true);
    expect(SOURCE_CATALOG_RESPONSE_CONTEXT).toEqual({
      actor: "authenticated_actor_is_server_bound_and_never_accepted_from_the_wire",
      cas: "request_expectedRevision_must_equal_current_revision_before_apply",
      idempotency: "same_key_and_intent_replays_applied_success_different_intent_refuses",
      immutableKind: "source_kind_is_immutable_after_create",
      historicalRefs: "retired_sources_remain_resolvable_for_historical_references",
      identityUniqueness: "non_null_identityId_is_unique_across_the_catalog",
      projection: "list_projection_is_authorization_filtered_and_not_caller_authoritative",
      auth: "mutations_require_server_authorized_catalog_write",
      audit: "successful_mutations_are_appended_to_the_audit_log",
    });
  });
});

describe("parseSource", () => {
  it("accepts every kind and an optional revision", () => {
    for (const kind of SOURCE_KINDS) {
      const parsed = parseSource(source({ id: HUMAN_ID, kind, revision: 4 }));
      expect(parsed.kind).toBe(kind);
      expect(parsed.revision).toBe(4);
    }
  });

  it("accepts a legacy row without revision", () => {
    const parsed = parseSource(legacySource());
    expect(parsed).not.toHaveProperty("revision");
    expect(validator("source.v1.json")(legacySource())).toBe(true);
  });

  it("accepts the permanent unknown source and the JSON Schema", () => {
    const row = permanentUnknown();
    delete row.revision;
    expect(parseSource(row).id).toBe(PERMANENT_UNKNOWN_SOURCE_ID);
    expect(validator("source.v1.json")(row)).toBe(true);
  });

  it("preserves a safe HTML-like label as untrusted data", () => {
    const parsed = parseSource(source({ name: "Web <b>assistant</b> & tool" }));
    expect(parsed.name).toBe("Web <b>assistant</b> & tool");
  });
});

describe("parseSourceList", () => {
  it("parses nested rows through parseSource", () => {
    const listed = parseSourceList({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [legacySource(), source({ id: HUMAN_ID, kind: "human", name: "Alice" })],
    });
    expect(listed.sources).toHaveLength(2);
    expect(listed.sources[0]).not.toHaveProperty("revision");
    expect(listed.sources[1]?.kind).toBe("human");
    expect(
      validator("source-list.v1.json")({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [legacySource(), source({ id: HUMAN_ID, kind: "human", name: "Alice" })],
      }),
    ).toBe(true);
  });

  it("retains precise indexed error paths for nested validation", () => {
    expect(() =>
      parseSourceList({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source(), { ...source({ id: HUMAN_ID }), id: "not-a-uuid" }],
      }),
    ).toThrow(/\$\.sources\[1\]\.id/);
    expect(() =>
      parseSourceList({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source(), { ...permanentUnknown(), kind: "human" }],
      }),
    ).toThrow(/\$\.sources\[1\]\.kind/);
  });
});

describe("source mutation requests", () => {
  it("normalizes create labels and descriptions with NFKC and trim", () => {
    const parsed = parseSourceCreateRequest(
      createRequest({
        name: "  Cafe\u0301  ",
        description: "  pasted tool  ",
        identityId: "uid=alice,ou=people,dc=example,dc=test",
      }),
    );
    expect(parsed.name).toBe("Café");
    expect(parsed.description).toBe("pasted tool");
    expect(parsed.expectedRevision).toBe(0);
    expect(parsed.identityId).toBe("uid=alice,ou=people,dc=example,dc=test");
    expect(validator("source-create-request.v1.json")(createRequest())).toBe(true);
  });

  it("accepts retire and restore requests with expectedRevision >= 1", () => {
    expect(parseSourceRetireRequest(retireRequest()).sourceId).toBe(TOOL_ID);
    expect(parseSourceRestoreRequest(restoreRequest()).expectedRevision).toBe(2);
    expect(validator("source-retire-request.v1.json")(retireRequest())).toBe(true);
    expect(validator("source-restore-request.v1.json")(restoreRequest())).toBe(true);
    expect(() => parseSourceRetireRequest(retireRequest({ expectedRevision: 0 }))).toThrow(
      />= 1/,
    );
    expect(() => parseSourceRestoreRequest(restoreRequest({ expectedRevision: 0 }))).toThrow(
      />= 1/,
    );
  });

  it("accepts bounded idempotency keys and rejects malformed ones", () => {
    expect(SOURCE_IDEMPOTENCY_KEY_RE.test("a.......")).toBe(true);
    expect(parseSourceCreateRequest(createRequest({ idempotencyKey: "a......." })).idempotencyKey)
      .toBe("a.......");
    for (const idempotencyKey of ["short", `a${"b".repeat(128)}`, "src/create/1", "-leading"]) {
      expect(() => parseSourceCreateRequest(createRequest({ idempotencyKey }))).toThrow(
        /8\.\.128/,
      );
    }
  });
});

describe("source mutation success", () => {
  it("accepts create, retire, and restore applied outcomes", () => {
    const created = parseSourceMutationSuccess(success("create", source({ revision: 1 })));
    expect(created.previousRevision).toBe(0);
    expect(created.applied.lifecycle).toBe("active");
    const retired = parseSourceMutationSuccess(
      success("retire", source({ lifecycle: "retired", revision: 2 })),
    );
    expect(retired.appliedRevision).toBe(2);
    expect(retired.previousRevision).toBe(1);
    const restored = parseSourceMutationSuccess(
      success("restore", source({ lifecycle: "active", revision: 3 })),
    );
    expect(restored.applied.lifecycle).toBe("active");
    expect(validator("source-mutation-success.v1.json")(success("create", source()))).toBe(true);
  });

  it("requires applied revision and nested id/lifecycle rules", () => {
    const missingRevision = source();
    delete missingRevision.revision;
    expect(() => parseSourceMutationSuccess(success("create", missingRevision))).toThrow(
      /applied source revision is required/,
    );
    expect(() =>
      parseSourceMutationSuccess({
        ...success("create", source()),
        sourceId: HUMAN_ID,
      }),
    ).toThrow(/must match sourceId/);
    expect(() =>
      parseSourceMutationSuccess(success("create", source({ lifecycle: "retired" }))),
    ).toThrow(/active source/);
    expect(() =>
      parseSourceMutationSuccess(success("retire", source({ lifecycle: "active", revision: 2 }))),
    ).toThrow(/retired source/);
    expect(() =>
      parseSourceMutationSuccess(
        success("restore", source({ lifecycle: "retired", revision: 3 })),
      ),
    ).toThrow(/active source/);
  });

  it("enforces non-replayed retire/restore revision arithmetic", () => {
    expect(() =>
      parseSourceMutationSuccess(
        success("retire", source({ lifecycle: "retired", revision: 4 }), {
          previousRevision: 1,
          expectedRevision: 1,
        }),
      ),
    ).toThrow(/previousRevision \+ 1/);
    expect(() =>
      parseSourceMutationSuccess(
        success("restore", source({ revision: 3 }), {
          previousRevision: 2,
          expectedRevision: 1,
        }),
      ),
    ).toThrow(/must equal previousRevision/);
  });

  it("relaxes revision arithmetic on replay but never the applied action outcome", () => {
    const replayedRetire = parseSourceMutationSuccess(
      success("retire", source({ lifecycle: "retired", revision: 9 }), {
        replayed: true,
        previousRevision: 1,
        expectedRevision: 1,
        appliedRevision: 9,
      }),
    );
    expect(replayedRetire.appliedRevision).not.toBe(replayedRetire.previousRevision + 1);
    expect(replayedRetire.applied.lifecycle).toBe("retired");
    expect(() =>
      parseSourceMutationSuccess(
        success("retire", source({ lifecycle: "active", revision: 9 }), {
          replayed: true,
          previousRevision: 1,
          expectedRevision: 1,
          appliedRevision: 9,
        }),
      ),
    ).toThrow(/retired source/);
    expect(() =>
      parseSourceMutationSuccess(
        success("create", source({ lifecycle: "retired", revision: 1 }), { replayed: true }),
      ),
    ).toThrow(/active source/);
    expect(() =>
      parseSourceMutationSuccess(
        success("restore", source({ lifecycle: "retired", revision: 3 }), {
          replayed: true,
          previousRevision: 2,
          expectedRevision: 2,
        }),
      ),
    ).toThrow(/active source/);
  });

  it("protects the permanent unknown source from retire and restore success", () => {
    expect(() =>
      parseSourceMutationSuccess(
        success("retire", permanentUnknown({ lifecycle: "retired", revision: 2 })),
      ),
    ).toThrow(/cannot be retired or restored|must remain active/);
    expect(() =>
      parseSourceMutationSuccess(success("restore", permanentUnknown({ revision: 2 }))),
    ).toThrow(/cannot be retired or restored/);
  });
});

describe("source mutation refusal pairings", () => {
  const allowed: Record<SourceMutationRefusal, readonly SourceMutationAction[]> = {
    source_not_found: ["retire", "restore"],
    already_retired: ["retire"],
    not_retired: ["restore"],
    permanent_unknown_protected: ["retire", "restore"],
    expected_revision_mismatch: ["retire", "restore"],
    idempotency_intent_mismatch: SOURCE_MUTATION_ACTIONS,
  };

  function currentFor(
    action: SourceMutationAction,
    reason: SourceMutationRefusal,
  ): { sourceId: string | null; current: SourceV1 | null; expectedRevision: number } {
    const expectedRevision = action === "create" ? 0 : 1;
    if (reason === "source_not_found") {
      return { sourceId: TOOL_ID, current: null, expectedRevision };
    }
    if (reason === "already_retired") {
      return {
        sourceId: TOOL_ID,
        current: source({ lifecycle: "retired", revision: 2 }),
        expectedRevision,
      };
    }
    if (reason === "not_retired") {
      return { sourceId: TOOL_ID, current: source({ revision: 2 }), expectedRevision };
    }
    if (reason === "permanent_unknown_protected") {
      return {
        sourceId: PERMANENT_UNKNOWN_SOURCE_ID,
        current: permanentUnknown({ revision: 1 }),
        expectedRevision,
      };
    }
    if (reason === "expected_revision_mismatch") {
      return { sourceId: TOOL_ID, current: source({ revision: 4 }), expectedRevision };
    }
    if (action === "create") {
      return { sourceId: null, current: null, expectedRevision };
    }
    return { sourceId: TOOL_ID, current: source({ revision: 2 }), expectedRevision };
  }

  it("accepts every valid action/refusal pairing and rejects the rest", () => {
    for (const reason of SOURCE_MUTATION_REFUSALS) {
      for (const action of SOURCE_MUTATION_ACTIONS) {
        const fields = currentFor(action, reason);
        const parse = () =>
          parseSourceMutationRefused(
            refusal(action, reason, {
              sourceId: fields.sourceId,
              current: fields.current,
              expectedRevision: fields.expectedRevision,
            }),
          );
        if (allowed[reason].includes(action)) expect(parse).not.toThrow();
        else expect(parse).toThrow(/cannot refuse/);
      }
    }
  });

  it("enforces reason/current pairing", () => {
    expect(() =>
      parseSourceMutationRefused(refusal("retire", "source_not_found", { current: source() })),
    ).toThrow(/current to be null/);
    expect(() =>
      parseSourceMutationRefused(
        refusal("retire", "already_retired", { current: source({ lifecycle: "active" }) }),
      ),
    ).toThrow(/retired current source/);
    expect(() =>
      parseSourceMutationRefused(
        refusal("restore", "not_retired", {
          current: source({ lifecycle: "retired", revision: 2 }),
        }),
      ),
    ).toThrow(/active current source/);
    expect(() =>
      parseSourceMutationRefused(
        refusal("retire", "expected_revision_mismatch", {
          current: source({ revision: 3 }),
          expectedRevision: 3,
        }),
      ),
    ).toThrow(/differ/);
    expect(() =>
      parseSourceMutationRefused(
        refusal("retire", "permanent_unknown_protected", {
          sourceId: TOOL_ID,
          current: source(),
        }),
      ),
    ).toThrow(/permanent unknown source/);
    expect(
      validator("source-mutation-refused.v1.json")(refusal("retire", "source_not_found")),
    ).toBe(true);
  });

  it("bounds refusal detail", () => {
    expect(() =>
      parseSourceMutationRefused(refusal("retire", "source_not_found", { detail: "   " })),
    ).toThrow(/non-empty/);
    expect(() =>
      parseSourceMutationRefused(
        refusal("retire", "source_not_found", {
          detail: "x".repeat(SOURCE_REFUSAL_DETAIL_MAX_LENGTH + 1),
        }),
      ),
    ).toThrow(/600/);
  });
});

describe("JSON Schema additionalProperties", () => {
  it("rejects unknown keys on every source catalog schema", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["source.v1.json", source()],
      ["source-list.v1.json", { schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source()] }],
      ["source-create-request.v1.json", createRequest()],
      ["source-retire-request.v1.json", retireRequest()],
      ["source-restore-request.v1.json", restoreRequest()],
      ["source-mutation-success.v1.json", success("create", source())],
      ["source-mutation-refused.v1.json", refusal("retire", "source_not_found")],
    ];
    for (const [file, payload] of cases) {
      const validate = validator(file);
      expect(validate(payload)).toBe(true);
      expect(validate({ ...payload, leak: true })).toBe(false);
    }
  });
});

describe("unknown keys and schema drift", () => {
  it("rejects unknown keys, schema ids, kinds, and lifecycles", () => {
    expect(() => parseSource({ ...source(), extra: true })).toThrow(/unknown key/);
    expect(() => parseSource({ ...source(), schemaId: "cd-collab.source.v2" })).toThrow(
      ContractViolation,
    );
    expect(() => parseSource({ ...source(), kind: "bot" })).toThrow(ContractViolation);
    expect(() => parseSource({ ...source(), lifecycle: "archived" })).toThrow(ContractViolation);
    expect(() => parseSourceCreateRequest({ ...createRequest(), actorId: "alice" })).toThrow(
      /unknown key/,
    );
  });
});
