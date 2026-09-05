import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractViolation as ParseContractViolation } from "./parse.js";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CATALOG_ACTION_AUTHORITY,
  SOURCE_CATALOG_IDEMPOTENCY,
  SOURCE_CATALOG_RESPONSE_CONTEXT,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_DESCRIPTION_MAX_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH,
  SOURCE_IDEMPOTENCY_KEY_RE,
  SOURCE_KINDS,
  SOURCE_LIFECYCLES,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_ACTIONS,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_REFUSALS,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_REFUSAL_DETAIL_MAX_LENGTH,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  SOURCE_UUID_RE,
  parseSource,
  parseSourceCreateRequest,
  parseSourceList,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type SourceV1,
} from "./source.js";
import {
  ContractViolation,
  PERMANENT_UNKNOWN_SOURCE_ID as browserPermanentUnknown,
  SOURCE_CATALOG_ACTION_AUTHORITY as browserAuthority,
  SOURCE_CATALOG_IDEMPOTENCY as browserIdempotency,
  SOURCE_CATALOG_RESPONSE_CONTEXT as browserResponseContext,
  SOURCE_CREATE_REQUEST_SCHEMA_ID as browserCreateSchemaId,
  SOURCE_DESCRIPTION_MAX_LENGTH as browserDescriptionMax,
  SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH as browserIdempotencyMax,
  SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH as browserIdempotencyMin,
  SOURCE_IDEMPOTENCY_KEY_RE as browserIdempotencyRe,
  SOURCE_KINDS as browserKinds,
  SOURCE_LIFECYCLES as browserLifecycles,
  SOURCE_LIST_SCHEMA_ID as browserListSchemaId,
  SOURCE_MUTATION_ACTIONS as browserActions,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID as browserRefusedSchemaId,
  SOURCE_MUTATION_REFUSALS as browserRefusals,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID as browserSuccessSchemaId,
  SOURCE_NAME_MAX_LENGTH as browserNameMax,
  SOURCE_REFUSAL_DETAIL_MAX_LENGTH as browserRefusalDetailMax,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID as browserRestoreSchemaId,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID as browserRetireSchemaId,
  SOURCE_SCHEMA_ID as browserSourceSchemaId,
  SOURCE_UUID_RE as browserUuidRe,
  parseSource as browserParseSource,
  parseSourceCreateRequest as browserParseCreate,
  parseSourceList as browserParseList,
  parseSourceMutationRefused as browserParseRefused,
  parseSourceMutationSuccess as browserParseSuccess,
  parseSourceRestoreRequest as browserParseRestore,
  parseSourceRetireRequest as browserParseRetire,
  type SourceCreateRequestV1,
  type SourceKind,
  type SourceLifecycle,
  type SourceListV1,
  type SourceMutationAction,
  type SourceMutationRefusal,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceRestoreRequestV1,
  type SourceRetireRequestV1,
} from "./source-catalog-browser.js";

const here = dirname(fileURLToPath(import.meta.url));
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

function permanentUnknown(): SourceV1 {
  return source({
    id: PERMANENT_UNKNOWN_SOURCE_ID,
    name: "Unknown",
    kind: "unknown",
    description: "Permanent unknown source. Never auto-upgraded.",
    lifecycle: "active",
    identityId: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    createdBy: "system",
  });
}

describe("browser source catalog contract", () => {
  it("re-exports the same constants, metadata, parsers, types, and ContractViolation", () => {
    expect(ContractViolation).toBe(ParseContractViolation);
    expect(browserPermanentUnknown).toBe(PERMANENT_UNKNOWN_SOURCE_ID);
    expect(browserSourceSchemaId).toBe(SOURCE_SCHEMA_ID);
    expect(browserListSchemaId).toBe(SOURCE_LIST_SCHEMA_ID);
    expect(browserCreateSchemaId).toBe(SOURCE_CREATE_REQUEST_SCHEMA_ID);
    expect(browserRetireSchemaId).toBe(SOURCE_RETIRE_REQUEST_SCHEMA_ID);
    expect(browserRestoreSchemaId).toBe(SOURCE_RESTORE_REQUEST_SCHEMA_ID);
    expect(browserSuccessSchemaId).toBe(SOURCE_MUTATION_SUCCESS_SCHEMA_ID);
    expect(browserRefusedSchemaId).toBe(SOURCE_MUTATION_REFUSED_SCHEMA_ID);
    expect(browserKinds).toBe(SOURCE_KINDS);
    expect(browserLifecycles).toBe(SOURCE_LIFECYCLES);
    expect(browserActions).toBe(SOURCE_MUTATION_ACTIONS);
    expect(browserRefusals).toBe(SOURCE_MUTATION_REFUSALS);
    expect(browserNameMax).toBe(SOURCE_NAME_MAX_LENGTH);
    expect(browserDescriptionMax).toBe(SOURCE_DESCRIPTION_MAX_LENGTH);
    expect(browserRefusalDetailMax).toBe(SOURCE_REFUSAL_DETAIL_MAX_LENGTH);
    expect(browserIdempotencyMin).toBe(SOURCE_IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(browserIdempotencyMax).toBe(SOURCE_IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(browserUuidRe).toBe(SOURCE_UUID_RE);
    expect(browserIdempotencyRe).toBe(SOURCE_IDEMPOTENCY_KEY_RE);
    expect(browserAuthority).toBe(SOURCE_CATALOG_ACTION_AUTHORITY);
    expect(browserIdempotency).toBe(SOURCE_CATALOG_IDEMPOTENCY);
    expect(browserResponseContext).toBe(SOURCE_CATALOG_RESPONSE_CONTEXT);
    expect(browserParseSource).toBe(parseSource);
    expect(browserParseList).toBe(parseSourceList);
    expect(browserParseCreate).toBe(parseSourceCreateRequest);
    expect(browserParseRetire).toBe(parseSourceRetireRequest);
    expect(browserParseRestore).toBe(parseSourceRestoreRequest);
    expect(browserParseSuccess).toBe(parseSourceMutationSuccess);
    expect(browserParseRefused).toBe(parseSourceMutationRefused);

    const kind: SourceKind = browserKinds[1];
    const lifecycle: SourceLifecycle = browserLifecycles[0];
    const action: SourceMutationAction = browserActions[0];
    const refusal: SourceMutationRefusal = browserRefusals[1];
    expect(kind).toBe("external-tool");
    expect(lifecycle).toBe("active");
    expect(action).toBe("create");
    expect(refusal).toBe("already_retired");
  });

  it("keeps authority, idempotency, and response-context metadata frozen", () => {
    expect(Object.isFrozen(browserAuthority)).toBe(true);
    expect(Object.isFrozen(browserIdempotency)).toBe(true);
    expect(Object.isFrozen(browserIdempotency.intentFields)).toBe(true);
    expect(Object.isFrozen(browserIdempotency.lookupKey)).toBe(true);
    expect(Object.isFrozen(browserResponseContext)).toBe(true);
  });

  it("parses list, create, retire, restore, success, and refused envelopes", () => {
    const parsedSource: SourceV1 = browserParseSource(source());
    expect(parsedSource.id).toBe(TOOL_ID);
    expect(parsedSource.kind).toBe("external-tool");

    const listed: SourceListV1 = browserParseList({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [permanentUnknown(), source()],
    });
    expect(listed.sources.map((row) => row.id)).toEqual([
      PERMANENT_UNKNOWN_SOURCE_ID,
      TOOL_ID,
    ]);

    const created: SourceCreateRequestV1 = browserParseCreate({
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name: "  Web assistant  ",
      kind: "external-tool",
      description: null,
      identityId: null,
      expectedRevision: 0,
      idempotencyKey: "src-create-0001",
    });
    expect(created.name).toBe("Web assistant");
    expect(created.expectedRevision).toBe(0);

    const retired: SourceRetireRequestV1 = browserParseRetire({
      schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
      sourceId: TOOL_ID,
      expectedRevision: 1,
      idempotencyKey: "src-retire-0001",
    });
    expect(retired.sourceId).toBe(TOOL_ID);

    const restored: SourceRestoreRequestV1 = browserParseRestore({
      schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
      sourceId: TOOL_ID,
      expectedRevision: 2,
      idempotencyKey: "src-restore-0001",
    });
    expect(restored.expectedRevision).toBe(2);

    const applied = source({ revision: 1, lifecycle: "active" });
    const succeeded: SourceMutationSuccessV1 = browserParseSuccess({
      schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
      action: "create",
      sourceId: TOOL_ID,
      expectedRevision: 0,
      previousRevision: 0,
      appliedRevision: 1,
      replayed: false,
      applied,
    });
    expect(succeeded.applied.id).toBe(TOOL_ID);
    expect(succeeded.appliedRevision).toBe(1);

    const refused: SourceMutationRefusedV1 = browserParseRefused({
      schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
      error: "source_catalog_refused",
      action: "retire",
      sourceId: TOOL_ID,
      expectedRevision: 1,
      reason: "already_retired",
      detail: "The recorded catalog state does not allow that action.",
      current: source({ lifecycle: "retired", revision: 2 }),
    });
    expect(refused.reason).toBe("already_retired");
    expect(refused.current?.lifecycle).toBe("retired");
  });

  it("classifies parser failures as ContractViolation", () => {
    expect(() => browserParseSource({})).toThrow(ContractViolation);
    expect(() => browserParseList({})).toThrow(ContractViolation);
    expect(() =>
      browserParseCreate({
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name: "Web assistant",
        kind: "external-tool",
        description: null,
        identityId: null,
        expectedRevision: 1,
        idempotencyKey: "src-create-0001",
      }),
    ).toThrow(ContractViolation);
  });

  it("points the source-catalog package export at the browser dist files", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types?: string; import?: string } | string>;
    };
    expect(pkg.exports["./source-catalog"]).toEqual({
      types: "./dist/source-catalog-browser.d.ts",
      import: "./dist/source-catalog-browser.js",
    });
  });
});
