import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import { CONTRIBUTION_SCHEMA_ID } from "./contribution.js";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_SCHEMA_ID,
  type SourceV1,
} from "./source.js";
import {
  COMPLETENESS,
  CORROBORATION_STATES,
  EVIDENCE_VISIBILITY,
  EXTERNAL_RUN_IMPORT_ERROR,
  EXTERNAL_RUN_IMPORT_IDEMPOTENCY,
  EXTERNAL_RUN_IMPORT_LIMITS,
  EXTERNAL_RUN_IMPORT_MODES,
  EXTERNAL_RUN_IMPORT_REFUSALS,
  EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
  EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
  EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT,
  EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID,
  EXTERNAL_RUN_SCHEMA_ID,
  IMPORTABLE_SOURCE_KINDS,
  parseExternalRun,
  parseExternalRunImportRefused,
  parseExternalRunImportRequest,
  parseExternalRunImportSuccess,
  type ExternalRunImportRefusal,
  type ExternalRunV1,
} from "./run.js";

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

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTRIBUTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ARTIFACT_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ARTIFACT_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OUTPUT_HASH = "b1019aa43e0e82ea484cdde142a7c5b3d56664bfb838b01357e24e79067723d6";
const PROMPT_HASH = "2426ba4b46c4cb3d058d7fdd6c15e766dd2ee56721f87e643d56c6b5796f729b";
const SNAPSHOT = "c".repeat(64);

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

function refusal(
  reason: ExternalRunImportRefusal,
  extras: Record<string, unknown> = {},
) {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID,
    error: EXTERNAL_RUN_IMPORT_ERROR,
    importMode: "manual",
    caseId: CASE_ID,
    sourceId: SOURCE_ID,
    expectedSourceRevision: 3,
    reason,
    detail: "The recorded case or source state does not allow that import.",
    current: null,
    ...extras,
  };
}

function currentFor(reason: ExternalRunImportRefusal): {
  sourceId: string;
  current: SourceV1 | null;
  expectedSourceRevision: number;
} {
  if (reason === "source_not_versioned") {
    return { sourceId: SOURCE_ID, current: legacySource(), expectedSourceRevision: 3 };
  }
  if (reason === "source_retired") {
    return {
      sourceId: SOURCE_ID,
      current: source({ lifecycle: "retired", revision: 4 }),
      expectedSourceRevision: 3,
    };
  }
  if (reason === "source_revision_mismatch") {
    return {
      sourceId: SOURCE_ID,
      current: source({ lifecycle: "active", revision: 9 }),
      expectedSourceRevision: 3,
    };
  }
  if (reason === "source_kind_not_importable") {
    return {
      sourceId: SOURCE_ID,
      current: source({ kind: "human", name: "Alice", revision: 3 }),
      expectedSourceRevision: 3,
    };
  }
  return { sourceId: SOURCE_ID, current: null, expectedSourceRevision: 3 };
}

describe("external-run import constants", () => {
  it("freezes schema identities, import mode, and importable kinds", () => {
    expect(EXTERNAL_RUN_SCHEMA_ID).toBe("cd-collab.external_run.v1");
    expect(EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID).toBe(
      "cd-collab.external_run_import_request.v1",
    );
    expect(EXTERNAL_RUN_IMPORT_SUCCESS_SCHEMA_ID).toBe(
      "cd-collab.external_run_import_success.v1",
    );
    expect(EXTERNAL_RUN_IMPORT_REFUSED_SCHEMA_ID).toBe(
      "cd-collab.external_run_import_refused.v1",
    );
    expect([...EXTERNAL_RUN_IMPORT_MODES]).toEqual(["manual"]);
    expect([...IMPORTABLE_SOURCE_KINDS]).toEqual([
      "external-tool",
      "internal-system",
      "unknown",
    ]);
    expect([...EXTERNAL_RUN_IMPORT_REFUSALS]).toEqual([
      "case_archived",
      "source_not_versioned",
      "source_retired",
      "source_revision_mismatch",
      "source_kind_not_importable",
      "privacy_mismatch",
      "idempotency_intent_mismatch",
    ]);
    expect([...COMPLETENESS]).toEqual(["exact", "partial", "unknown"]);
    expect([...EVIDENCE_VISIBILITY]).toEqual(["unknown", "importer_described"]);
    expect([...CORROBORATION_STATES]).toEqual([
      "unverified",
      "corroborated",
      "contradicted",
    ]);
  });

  it("freezes server-owned response context and transport/idempotency declarations", () => {
    expect(Object.isFrozen(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT)).toBe(true);
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT).toEqual({
      actor: "authenticated_actor_is_server_bound_and_never_accepted_from_the_wire",
      operator:
        "request_operator_null_maps_to_authenticated_importer_for_required_stored_operator_identity_fields_and_any_supplied_operator_is_descriptive_only_and_never_authority",
      hashes: "output_and_prompt_hashes_derive_from_exact_request_bytes",
      contributionActor: "contribution_and_importer_actor_binding_is_server_owned",
      parserCannotCompare:
        "parser_cannot_compare_request_content_or_authenticated_actor",
      artifacts:
        "server_verifies_same_case_readable_artifacts_exact_snapshot_membership_and_privacy",
      source:
        "server_verifies_source_visibility_active_version_kind_and_revision",
      authorization: "import_requires_server_authorized_case_write",
      audit: "successful_imports_are_appended_to_the_audit_log",
      atomicity: "run_and_contribution_persist_atomically",
      privacy: "explicit_privacy_class_is_required_and_redacted_grants_nothing",
      concealed:
        "missing_or_concealed_case_source_artifact_or_snapshot_is_ordinary_indistinguishable_404",
      authOrder:
        "authenticate_then_permission_and_case_visibility_before_durable_replay",
      noAutomaticWrites: "no_automatic_or_background_writes",
      parserLimit:
        "request_parser_does_not_claim_artifact_snapshot_existence_or_privacy_verification",
    });
    expect(Object.isFrozen(EXTERNAL_RUN_IMPORT_IDEMPOTENCY)).toBe(true);
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.lookupKey).toEqual([
      "caseId",
      "authenticatedActor",
      "idempotencyKey",
    ]);
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.excludesFromIntent).toEqual([
      "schemaId",
      "idempotencyKey",
      "expectedSourceRevision",
      "clientTime",
    ]);
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.statuses).toEqual({
      fresh: 201,
      replay: 200,
      refusal: 409,
      invalid: [400, 413],
      auth: [401, 403],
      concealed: 404,
      unknownCommit: 503,
      unknownCommitCode: "commit_outcome_unknown",
    });
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.persist).toBe("manual_attributed_writes_only");
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.uncertainOutcome).toContain("freeze_exact");
  });

  it("freezes request operator null mapping to the authenticated importer as never-authority", () => {
    expect(Object.isFrozen(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT)).toBe(true);
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.operator).toBe(
      "request_operator_null_maps_to_authenticated_importer_for_required_stored_operator_identity_fields_and_any_supplied_operator_is_descriptive_only_and_never_authority",
    );
  });
});

describe("parseExternalRun legacy compatibility", () => {
  it("accepts a legacy row without importMode, sourceRevision, or evidenceArtifactIds", () => {
    const parsed = parseExternalRun(legacyRun());
    expect(parsed).not.toHaveProperty("importMode");
    expect(parsed).not.toHaveProperty("sourceRevision");
    expect(parsed).not.toHaveProperty("evidenceArtifactIds");
    expect(parsed.outputHash).toBe("not-a-sha");
    expect(parsed.createdAt).toBe("yesterday");
    expect(validator("external-run.v1.json")(legacyRun())).toBe(true);
  });

  it("rejects revision 0 and unknown import modes on the optional fields", () => {
    expect(() => parseExternalRun(applied({ sourceRevision: 0 }))).toThrow(/>= 1/);
    expect(() =>
      parseExternalRun(
        legacyRun({ importMode: "automatic", sourceRevision: 1, evidenceArtifactIds: [] }),
      ),
    ).toThrow(
      ContractViolation,
    );
  });

  it("requires all manual-import fields together while preserving untouched legacy rows", () => {
    for (const partial of [
      { importMode: "manual" },
      { sourceRevision: 3 },
      { evidenceArtifactIds: [] },
      { importMode: "manual", sourceRevision: 3 },
    ]) {
      const candidate = legacyRun(partial);
      expect(() => parseExternalRun(candidate)).toThrow(/must appear together/);
      expect(validator("external-run.v1.json")(candidate)).toBe(false);
    }
  });
});

describe("parseExternalRun marked durable manual import", () => {
  it("accepts a truly valid marked row and the JSON Schema", () => {
    const parsed = parseExternalRun(
      applied({
        sourceRevision: 4,
        evidenceArtifactIds: [ARTIFACT_A, ARTIFACT_B],
        evidenceVisibility: "importer_described",
      }),
    );
    expect(parsed.importMode).toBe("manual");
    expect(parsed.sourceRevision).toBe(4);
    expect(parsed.evidenceArtifactIds).toEqual([ARTIFACT_A, ARTIFACT_B]);
    expect(parsed.outputHash).toBe(OUTPUT_HASH);
    expect(parsed.createdAt).toBe("2026-09-05T12:00:00.000Z");
    expect(parsed.corroborationState).toBe("unverified");
    expect(
      validator("external-run.v1.json")(
        applied({
          sourceRevision: 4,
          evidenceArtifactIds: [ARTIFACT_A, ARTIFACT_B],
          evidenceVisibility: "importer_described",
        }),
      ),
    ).toBe(true);
  });

  it("rejects marked rows with valid-looking wrong hashes, non-SHA hashes, and invalid timestamps", () => {
    const wrongHash = applied({ outputHash: "a".repeat(64) });
    expect(() => parseExternalRun(wrongHash)).toThrow(/exact outputText/);
    expect(validator("external-run.v1.json")(wrongHash)).toBe(true);

    const nonSha = applied({ outputHash: "not-a-sha" });
    expect(() => parseExternalRun(nonSha)).toThrow(/SHA-256/);
    expect(validator("external-run.v1.json")(nonSha)).toBe(false);

    const wrongPrompt = applied({ promptHash: "b".repeat(64) });
    expect(() => parseExternalRun(wrongPrompt)).toThrow(/exact promptText/);
    expect(validator("external-run.v1.json")(wrongPrompt)).toBe(true);

    const invalidTimestamp = applied({ createdAt: "yesterday" });
    expect(() => parseExternalRun(invalidTimestamp)).toThrow(/ISO-8601 instant/);
    expect(validator("external-run.v1.json")(invalidTimestamp)).toBe(false);
  });

  it("rejects marked rows with invalid prompt pairing, corroboration, or privacy/evidence relationships", () => {
    const unpairedPrompt = applied({
      promptText: null,
      promptHash: PROMPT_HASH,
      promptCompleteness: "unknown",
    });
    expect(() => parseExternalRun(unpairedPrompt)).toThrow(/if and only if/);
    expect(validator("external-run.v1.json")(unpairedPrompt)).toBe(false);

    const missingPromptHash = applied({ promptHash: null });
    expect(() => parseExternalRun(missingPromptHash)).toThrow(/if and only if/);
    expect(validator("external-run.v1.json")(missingPromptHash)).toBe(false);

    const corroborated = applied({ corroborationState: "corroborated" });
    expect(() => parseExternalRun(corroborated)).toThrow(/unverified/);
    expect(validator("external-run.v1.json")(corroborated)).toBe(false);

    const unknownWithArtifacts = applied({
      evidenceVisibility: "unknown",
      evidenceArtifactIds: [ARTIFACT_A],
    });
    expect(() => parseExternalRun(unknownWithArtifacts)).toThrow(/zero artifact ids/);
    expect(validator("external-run.v1.json")(unknownWithArtifacts)).toBe(false);

    const describedWithoutEvidence = applied({ evidenceVisibility: "importer_described" });
    expect(() => parseExternalRun(describedWithoutEvidence)).toThrow(
      /importer_described requires at least one/,
    );
    expect(validator("external-run.v1.json")(describedWithoutEvidence)).toBe(false);
  });

  it("requires marked evidence ids unique and already sorted", () => {
    expect(() =>
      parseExternalRun(
        applied({
          evidenceVisibility: "importer_described",
          evidenceArtifactIds: [ARTIFACT_B, ARTIFACT_A],
        }),
      ),
    ).toThrow(/canonical lexical order/);
  });
});

describe("parseExternalRunImportRequest", () => {
  it("accepts a valid manual request and the JSON Schema", () => {
    const parsed = parseExternalRunImportRequest(request());
    expect(parsed.importMode).toBe("manual");
    expect(parsed.outputText).toBe("imported output");
    expect(parsed.promptText).toBe("imported prompt");
    expect(parsed.operator?.username).toBe("operator");
    expect(validator("external-run-import-request.v1.json")(request())).toBe(true);
  });

  it("preserves output and prompt bytes exactly without trim or NFKC", () => {
    const outputText = "  Cafe\u0301 \n";
    const promptText = "\tprompt\r";
    const parsed = parseExternalRunImportRequest(request({ outputText, promptText }));
    expect(parsed.outputText).toBe(outputText);
    expect(parsed.promptText).toBe(promptText);
    expect(parsed.outputText).not.toBe("Café");
  });

  it("normalizes metadata with trim+NFKC and keeps ordinary newlines in notes", () => {
    const parsed = parseExternalRunImportRequest(
      request({
        evidenceVisibility: "importer_described",
        visibilityNote: "  first\nsecond  ",
        uncertainty: "  Cafe\u0301\nmaybe  ",
        provider: "  Example  ",
        claimedTraces: ["  Mailer  "],
        operator: {
          identityId: "  uid=operator,ou=people,dc=example,dc=test  ",
          username: "  operator  ",
        },
      }),
    );
    expect(parsed.visibilityNote).toBe("first\nsecond");
    expect(parsed.uncertainty).toBe("Café\nmaybe");
    expect(parsed.provider).toBe("Example");
    expect(parsed.claimedTraces).toEqual(["Mailer"]);
    expect(parsed.operator?.username).toBe("operator");
  });

  it("uses JSON Schema code-point length semantics for non-BMP metadata", () => {
    const provider = "😀".repeat(EXTERNAL_RUN_IMPORT_LIMITS.metadataMaxLength);
    const atLimit = request({ provider });
    expect(parseExternalRunImportRequest(atLimit).provider).toBe(provider);
    expect(validator("external-run-import-request.v1.json")(atLimit)).toBe(true);

    const overLimit = request({ provider: `${provider}😀` });
    expect(() => parseExternalRunImportRequest(overLimit)).toThrow(/200/);
    expect(validator("external-run-import-request.v1.json")(overLimit)).toBe(false);
  });

  it("enforces combined UTF-8 byte limits including multibyte text", () => {
    const acute = "é";
    const atLimit = acute.repeat(EXTERNAL_RUN_IMPORT_LIMITS.combinedTextMaxBytes / 2);
    expect(
      parseExternalRunImportRequest(
        request({ outputText: atLimit, promptText: null, promptCompleteness: "unknown" }),
      ).outputText,
    ).toBe(atLimit);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          outputText: acute.repeat(EXTERNAL_RUN_IMPORT_LIMITS.combinedTextMaxBytes / 2 + 1),
          promptText: null,
          promptCompleteness: "unknown",
        }),
      ),
    ).toThrow(/1,000,000 bytes|1000000 bytes/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          outputText: acute.repeat(400_000),
          promptText: acute.repeat(100_001),
        }),
      ),
    ).toThrow(/combined UTF-8/);
    expect(() => parseExternalRunImportRequest(request({ outputText: "" }))).toThrow(
      /non-empty output/,
    );
  });

  it("requires lower-case UUIDs, SHA-256 snapshot hashes, and bounded idempotency keys", () => {
    expect(() =>
      parseExternalRunImportRequest(request({ caseId: "CASE-1" })),
    ).toThrow(/lower-case UUID/);
    expect(() =>
      parseExternalRunImportRequest(request({ sourceId: CASE_ID.toUpperCase() })),
    ).toThrow(/lower-case UUID/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          snapshotBinding: "C".repeat(64),
        }),
      ),
    ).toThrow(/SHA-256/);
    expect(() =>
      parseExternalRunImportRequest(request({ expectedSourceRevision: 0 })),
    ).toThrow(/>= 1/);
    for (const idempotencyKey of ["short", `a${"b".repeat(128)}`, "run/import/1", "-leading"]) {
      expect(() => parseExternalRunImportRequest(request({ idempotencyKey }))).toThrow(
        /8\.\.128/,
      );
    }
    expect(
      parseExternalRunImportRequest(request({ idempotencyKey: "a......." })).idempotencyKey,
    ).toBe("a.......");
  });

  it("sorts unique evidence ids and rejects duplicates or more than 64", () => {
    const parsed = parseExternalRunImportRequest(
      request({
        evidenceVisibility: "importer_described",
        evidenceArtifactIds: [ARTIFACT_B, ARTIFACT_A],
      }),
    );
    expect(parsed.evidenceArtifactIds).toEqual([ARTIFACT_A, ARTIFACT_B]);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          evidenceArtifactIds: [ARTIFACT_A, ARTIFACT_A],
        }),
      ),
    ).toThrow(/duplicate evidence artifact id/);
    const tooMany = Array.from(
      { length: EXTERNAL_RUN_IMPORT_LIMITS.evidenceArtifactIdsMax + 1 },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
    );
    expect(() =>
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          evidenceArtifactIds: tooMany,
        }),
      ),
    ).toThrow(/at most 64/);
  });

  it("enforces the prompt completeness matrix", () => {
    expect(
      parseExternalRunImportRequest(
        request({ promptText: null, promptCompleteness: "unknown" }),
      ).promptCompleteness,
    ).toBe("unknown");
    expect(
      parseExternalRunImportRequest(
        request({ promptText: null, promptCompleteness: "partial" }),
      ).promptCompleteness,
    ).toBe("partial");
    expect(() =>
      parseExternalRunImportRequest(
        request({ promptText: null, promptCompleteness: "exact" }),
      ),
    ).toThrow(/forbidden when promptText is null/);
    expect(validator("external-run-import-request.v1.json")(
      request({ promptText: null, promptCompleteness: "exact" }),
    )).toBe(false);
    expect(
      parseExternalRunImportRequest(
        request({ promptText: "kept", promptCompleteness: "exact" }),
      ).promptText,
    ).toBe("kept");
  });

  it("enforces the evidence visibility matrix", () => {
    expect(() =>
      parseExternalRunImportRequest(
        request({ evidenceVisibility: "unknown", evidenceArtifactIds: [ARTIFACT_A] }),
      ),
    ).toThrow(/zero artifact ids/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ evidenceVisibility: "unknown", snapshotBinding: SNAPSHOT }),
      ),
    ).toThrow(/null snapshot/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ evidenceVisibility: "unknown", visibilityNote: "seen in chat" }),
      ),
    ).toThrow(/visibilityNote/);
    expect(() =>
      parseExternalRunImportRequest(request({ evidenceVisibility: "importer_described" })),
    ).toThrow(/importer_described requires at least one/);
    expect(
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          snapshotBinding: SNAPSHOT,
        }),
      ).snapshotBinding,
    ).toBe(SNAPSHOT);
    expect(
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          visibilityNote: "described by the importer",
        }),
      ).visibilityNote,
    ).toBe("described by the importer");
    expect(
      parseExternalRunImportRequest(
        request({
          evidenceVisibility: "importer_described",
          evidenceArtifactIds: [ARTIFACT_A],
        }),
      ).evidenceArtifactIds,
    ).toEqual([ARTIFACT_A]);
  });

  it("requires a complete operator pair when operator is present", () => {
    expect(parseExternalRunImportRequest(request({ operator: null })).operator).toBeNull();
    expect(() =>
      parseExternalRunImportRequest(
        request({ operator: { identityId: "uid=operator,ou=people,dc=example,dc=test" } }),
      ),
    ).toThrow(/username/);
    expect(() =>
      parseExternalRunImportRequest(
        request({ operator: { username: "operator" } }),
      ),
    ).toThrow(/identityId/);
    expect(() =>
      parseExternalRunImportRequest(
        request({
          operator: { identityId: "uid=operator,ou=people,dc=example,dc=test", username: "" },
        }),
      ),
    ).toThrow(/non-empty/);
  });

  it("requires explicit privacy and treats redacted as non-authority", () => {
    expect(
      parseExternalRunImportRequest(request({ redacted: true, privacyClass: "share_safe" }))
        .privacyClass,
    ).toBe("share_safe");
    expect(
      parseExternalRunImportRequest(request({ redacted: false, privacyClass: "owner_only" }))
        .redacted,
    ).toBe(false);
    const missingPrivacy = request();
    delete (missingPrivacy as { privacyClass?: unknown }).privacyClass;
    expect(() => parseExternalRunImportRequest(missingPrivacy)).toThrow(/privacyClass/);
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.privacy).toContain("redacted_grants_nothing");
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.operator).toContain("never_authority");
  });

  it("accepts optional explicit-offset clientTime and rejects zone-unspecified values", () => {
    expect(
      parseExternalRunImportRequest(
        request({ clientTime: "2026-09-05T12:00:00.000Z" }),
      ).clientTime,
    ).toBe("2026-09-05T12:00:00.000Z");
    expect(() =>
      parseExternalRunImportRequest(request({ clientTime: "2026-09-05T12:00:00" })),
    ).toThrow(/explicit offset/);
    expect(() => parseExternalRunImportRequest(request({ clientTime: null }))).toThrow(
      /never null/,
    );
  });
});

describe("parseExternalRunImportSuccess", () => {
  it("accepts a strict applied imported run and contribution identity", () => {
    const parsed = parseExternalRunImportSuccess(success());
    expect(parsed.applied.importMode).toBe("manual");
    expect(parsed.applied.sourceRevision).toBe(3);
    expect(parsed.applied.evidenceArtifactIds).toEqual([]);
    expect(parsed.applied.contributionId).toBe(parsed.contribution.id);
    expect(parsed.contribution.kind).toBe("external_run");
    expect(parsed.contribution.revision).toBe(1);
    expect(parsed.contribution.predecessorRevision).toBeNull();
    expect(parsed.contribution.tombstoned).toBe(false);
    expect(parsed.applied.corroborationState).toBe("unverified");
    expect(validator("external-run-import-success.v1.json")(success())).toBe(true);
  });

  it("accepts a replayed success that only flips replayed", () => {
    const parsed = parseExternalRunImportSuccess(success({ replayed: true }));
    expect(parsed.replayed).toBe(true);
    expect(parsed.applied.sourceRevision).toBe(3);
  });

  it("requires request-level case, source, and revision to match applied", () => {
    expect(() =>
      parseExternalRunImportSuccess(success({ caseId: ARTIFACT_A })),
    ).toThrow(/must match caseId/);
    expect(() =>
      parseExternalRunImportSuccess(success({ sourceId: ARTIFACT_A })),
    ).toThrow(/must match sourceId/);
    expect(() =>
      parseExternalRunImportSuccess(success({ expectedSourceRevision: 9 })),
    ).toThrow(/must equal expectedSourceRevision/);
  });

  it("requires contribution identity, kind, privacy, and lifecycle rules", () => {
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ contributionId: ARTIFACT_A }) }),
      ),
    ).toThrow(/must equal contribution.id/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ kind: "note" }) }),
      ),
    ).toThrow(/external_run/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ revision: 2, predecessorRevision: 1 }) }),
      ),
    ).toThrow(/revision must be 1/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ predecessorRevision: 0 }) }),
      ),
    ).toThrow(/predecessor must be null/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ tombstoned: true }) }),
      ),
    ).toThrow(/must not be tombstoned/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ privacyClass: "share_safe" }) }),
      ),
    ).toThrow(/must match applied.privacyClass/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ caseId: ARTIFACT_A }) }),
      ),
    ).toThrow(/must match caseId/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ sourceId: ARTIFACT_A }) }),
      ),
    ).toThrow(/must match sourceId/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ authorId: "uid=mallory,dc=example,dc=test" }) }),
      ),
    ).toThrow(/must match applied.importerId/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ contribution: contribution({ authorUsername: "mallory" }) }),
      ),
    ).toThrow(/must match applied.importerUsername/);
  });

  it("requires companion external_run contribution hypothesisStatus and hypothesisLinks to be null", () => {
    const statusPayload = success({
      contribution: contribution({ hypothesisStatus: "proposed" }),
    });
    expect(() => parseExternalRunImportSuccess(statusPayload)).toThrow(
      /hypothesisStatus must be null/,
    );
    expect(validator("external-run-import-success.v1.json")(statusPayload)).toBe(false);

    const linksPayload = success({
      contribution: contribution({
        hypothesisLinks: [{ kind: "artifact", id: ARTIFACT_A }],
      }),
    });
    expect(() => parseExternalRunImportSuccess(linksPayload)).toThrow(
      /hypothesisLinks must be null/,
    );
    expect(validator("external-run-import-success.v1.json")(linksPayload)).toBe(false);
  });

  it("requires SHA hashes, prompt-hash iff, and unverified corroboration", () => {
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ outputHash: "not-a-sha" }) }),
      ),
    ).toThrow(/SHA-256/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ outputHash: "a".repeat(64) }) }),
      ),
    ).toThrow(/exact outputText/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ promptHash: "b".repeat(64) }) }),
      ),
    ).toThrow(/exact promptText/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({
          applied: applied({ promptText: null, promptHash: PROMPT_HASH, promptCompleteness: "unknown" }),
        }),
      ),
    ).toThrow(/if and only if/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ promptHash: null }) }),
      ),
    ).toThrow(/if and only if/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({ applied: applied({ corroborationState: "corroborated" }) }),
      ),
    ).toThrow(/unverified/);
    expect(
      parseExternalRunImportSuccess(
        success({
          applied: applied({
            promptText: null,
            promptHash: null,
            promptCompleteness: "unknown",
          }),
        }),
      ).applied.promptHash,
    ).toBeNull();
  });

  it("requires applied evidence ids unique and already sorted", () => {
    expect(() =>
      parseExternalRunImportSuccess(
        success({
          applied: applied({
            evidenceVisibility: "importer_described",
            evidenceArtifactIds: [ARTIFACT_B, ARTIFACT_A],
          }),
        }),
      ),
    ).toThrow(/canonical lexical order/);
    expect(
      parseExternalRunImportSuccess(
        success({
          applied: applied({
            evidenceVisibility: "importer_described",
            evidenceArtifactIds: [ARTIFACT_A, ARTIFACT_B],
          }),
        }),
      ).applied.evidenceArtifactIds,
    ).toEqual([ARTIFACT_A, ARTIFACT_B]);
  });

  it("requires nonempty bounded run, importer, and operator identities", () => {
    expect(() =>
      parseExternalRunImportSuccess(success({ applied: applied({ importerId: "" }) })),
    ).toThrow(/non-empty/);
    expect(() =>
      parseExternalRunImportSuccess(
        success({
          applied: applied({
            importerUsername: "x".repeat(EXTERNAL_RUN_IMPORT_LIMITS.operatorUsernameMaxLength + 1),
          }),
        }),
      ),
    ).toThrow(/200/);
    expect(() =>
      parseExternalRunImportSuccess(success({ applied: applied({ operatorUsername: " alice" }) })),
    ).toThrow(/NFKC-normalized/);
  });
});

describe("parseExternalRunImportRefused pairings", () => {
  it("accepts every valid reason/current pairing and the JSON Schema", () => {
    for (const reason of EXTERNAL_RUN_IMPORT_REFUSALS) {
      const fields = currentFor(reason);
      const payload = refusal(reason, {
        sourceId: fields.sourceId,
        current: fields.current,
        expectedSourceRevision: fields.expectedSourceRevision,
      });
      expect(parseExternalRunImportRefused(payload).reason).toBe(reason);
      expect(validator("external-run-import-refused.v1.json")(payload)).toBe(true);
    }
  });

  it("enforces the current/action matrix for each refusal", () => {
    expect(() =>
      parseExternalRunImportRefused(refusal("case_archived", { current: source() })),
    ).toThrow(/current to be null/);
    expect(() =>
      parseExternalRunImportRefused(refusal("privacy_mismatch", { current: source() })),
    ).toThrow(/current to be null/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("idempotency_intent_mismatch", { current: source() }),
      ),
    ).toThrow(/current to be null/);
    expect(() =>
      parseExternalRunImportRefused(refusal("source_not_versioned", { current: source() })),
    ).toThrow(/no revision/);
    expect(() =>
      parseExternalRunImportRefused(refusal("source_not_versioned")),
    ).toThrow(/requires a current source/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_retired", { current: source({ lifecycle: "active", revision: 2 }) }),
      ),
    ).toThrow(/retired versioned source/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_retired", { current: legacySource() }),
      ),
    ).toThrow(/retired versioned source/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_revision_mismatch", {
          current: source({ revision: 3 }),
          expectedSourceRevision: 3,
        }),
      ),
    ).toThrow(/differ/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_revision_mismatch", {
          current: source({ lifecycle: "retired", revision: 9 }),
        }),
      ),
    ).toThrow(/active versioned source/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_revision_mismatch", { current: legacySource() }),
      ),
    ).toThrow(/active versioned source/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_kind_not_importable", {
          current: source({ kind: "external-tool", revision: 2 }),
        }),
      ),
    ).toThrow(/nonimportable kind/);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_kind_not_importable", {
          current: source({ kind: "human", lifecycle: "retired", revision: 2, name: "Alice" }),
        }),
      ),
    ).toThrow(/nonimportable kind/);
    const unversionedHuman = legacySource({ kind: "human", name: "Alice" });
    const unversionedKindRefusal = refusal("source_kind_not_importable", {
      current: unversionedHuman,
    });
    expect(() => parseExternalRunImportRefused(unversionedKindRefusal)).toThrow(/expected revision/);
    expect(validator("external-run-import-refused.v1.json")(unversionedKindRefusal)).toBe(false);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_kind_not_importable", {
          current: source({ kind: "human", name: "Alice", revision: 4 }),
          expectedSourceRevision: 3,
        }),
      ),
    ).toThrow(/expected revision/);
    expect(
      parseExternalRunImportRefused(
        refusal("source_kind_not_importable", {
          current: source({ kind: "contextdesk", name: "ContextDesk", revision: 3 }),
        }),
      ).current?.kind,
    ).toBe("contextdesk");
  });

  it("uses current source revision and permanent-unknown semantics", () => {
    const unversionedUnknown = permanentUnknown();
    delete unversionedUnknown.revision;
    expect(
      parseExternalRunImportRefused(
        refusal("source_not_versioned", {
          sourceId: PERMANENT_UNKNOWN_SOURCE_ID,
          current: unversionedUnknown,
        }),
      ).current?.id,
    ).toBe(PERMANENT_UNKNOWN_SOURCE_ID);
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_kind_not_importable", {
          sourceId: PERMANENT_UNKNOWN_SOURCE_ID,
          current: permanentUnknown({ revision: 1 }),
        }),
      ),
    ).toThrow(/nonimportable kind/);
    expect(() =>
      parseExternalRunImportRefused({
        ...refusal("case_archived"),
        reason: "permanent_unknown_protected",
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseExternalRunImportRefused({
        ...refusal("case_archived"),
        reason: "source_not_found",
      }),
    ).toThrow(ContractViolation);
  });

  it("does not model missing or concealed rows as domain refusals", () => {
    expect(EXTERNAL_RUN_IMPORT_REFUSALS).not.toContain("source_not_found");
    expect(EXTERNAL_RUN_IMPORT_REFUSALS).not.toContain("case_not_found");
    expect(EXTERNAL_RUN_IMPORT_REFUSALS).not.toContain("artifact_not_found");
    expect(EXTERNAL_RUN_IMPORT_REFUSALS).not.toContain("snapshot_not_found");
    expect(EXTERNAL_RUN_IMPORT_RESPONSE_CONTEXT.concealed).toContain("404");
    expect(EXTERNAL_RUN_IMPORT_IDEMPOTENCY.statuses.concealed).toBe(404);
  });

  it("requires current.id to match sourceId when current is present", () => {
    expect(() =>
      parseExternalRunImportRefused(
        refusal("source_retired", {
          current: source({ lifecycle: "retired", revision: 2, id: ARTIFACT_A }),
        }),
      ),
    ).toThrow(/must match sourceId/);
  });
});

describe("JSON Schema additionalProperties and parser/schema parity", () => {
  it("rejects unknown keys on every external-run import schema", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["external-run.v1.json", legacyRun()],
      ["external-run-import-request.v1.json", request()],
      ["external-run-import-success.v1.json", success()],
      ["external-run-import-refused.v1.json", refusal("case_archived")],
    ];
    for (const [file, payload] of cases) {
      const validate = validator(file);
      expect(validate(payload)).toBe(true);
      expect(validate({ ...payload, leak: true })).toBe(false);
    }
  });

  it("keeps schema and parser aligned for expressible request constraints", () => {
    expect(validator("external-run-import-request.v1.json")(request({ importMode: "automatic" }))).toBe(
      false,
    );
    expect(validator("external-run-import-request.v1.json")(request({ caseId: "not-a-uuid" }))).toBe(
      false,
    );
    expect(
      validator("external-run-import-success.v1.json")(
        success({ applied: applied({ corroborationState: "corroborated" }) }),
      ),
    ).toBe(false);
    expect(
      validator("external-run.v1.json")(applied({ corroborationState: "contradicted" })),
    ).toBe(false);
    expect(
      validator("external-run-import-success.v1.json")(
        success({ contribution: contribution({ hypothesisStatus: "contradicted" }) }),
      ),
    ).toBe(false);
    expect(
      validator("external-run-import-refused.v1.json")(
        refusal("source_not_versioned", { current: source() }),
      ),
    ).toBe(false);
  });
});
