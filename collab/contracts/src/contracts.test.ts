import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ??
  addFormatsImport;
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_NOT_CORRECTNESS,
  BRIEF_SCHEMA_ID,
  CASE_SCHEMA_ID,
  EXPERIMENT_PACKAGE_SCHEMA_ID,
  EXPERIMENT_SUMMARY_SCHEMA_ID,
  FILE_SERVER_REF_SCHEMA_ID,
  PACKAGE_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  parseBrief,
  parseCase,
  parseExperimentImport,
  parseExperimentPackage,
  parseExperimentSummary,
  parseFileServerReference,
  parseHealthResponse,
  parsePromptPackage,
  parseDoctorReport,
  parseProfileCatalog,
  parseQualificationReport,
  parseSource,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas");
const fixturesDir = join(here, "..", "fixtures");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(schemasDir, name), "utf8")) as object;
}

describe("contracts unknown-field rejection", () => {
  it("rejects unknown keys on health responses", () => {
    expect(() =>
      parseHealthResponse({
        schemaId: "cd-collab.health.v1",
        status: "ok",
        service: "cd-collab",
        extra: true,
      }),
    ).toThrow(/unknown key/);
  });

  it("rejects verified file-server refs without an expected hash", () => {
    expect(() =>
      parseFileServerReference({
        schemaId: FILE_SERVER_REF_SCHEMA_ID,
        id: "ref-1",
        uri: "https://files.example.test/a.bin",
        expectedHash: null,
        verificationStatus: "verified",
      }),
    ).toThrow(/expectedHash/);
  });

  it("rejects unknown keys on sources", () => {
    expect(() =>
      parseSource({
        schemaId: SOURCE_SCHEMA_ID,
        id: "s1",
        name: "n",
        kind: "unknown",
        description: null,
        lifecycle: "active",
        identityId: null,
        createdAt: "t",
        createdBy: "a",
        extra: true,
      }),
    ).toThrow(/unknown key/);
  });

  it("accepts the valid brief fixture and rejects unknown fields", () => {
    const valid = JSON.parse(readFileSync(join(fixturesDir, "brief.valid.json"), "utf8"));
    const brief = parseBrief(valid);
    expect(brief.schemaId).toBe(BRIEF_SCHEMA_ID);
    expect(brief.importedRuns[0]?.presentation).toBe("imported_response");
    const invalid = JSON.parse(
      readFileSync(join(fixturesDir, "brief.unknown-field.json"), "utf8"),
    );
    expect(() => parseBrief(invalid)).toThrow(/unknown key/);
  });

  it("accepts the valid package fixture and rejects unknown fields", () => {
    const valid = JSON.parse(
      readFileSync(join(fixturesDir, "prompt-package.valid.json"), "utf8"),
    );
    const pkg = parsePromptPackage(valid);
    expect(pkg.schemaId).toBe(PACKAGE_SCHEMA_ID);
    expect(pkg.manifest.excludedByDefault).toEqual(["corroboration", "resolution"]);
    const invalid = JSON.parse(
      readFileSync(join(fixturesDir, "prompt-package.unknown-field.json"), "utf8"),
    );
    expect(() => parsePromptPackage(invalid)).toThrow(/unknown key/);
  });

  it("rejects unknown keys on cases", () => {
    expect(() =>
      parseCase({
        schemaId: CASE_SCHEMA_ID,
        id: "c1",
        title: "t",
        severity: "low",
        status: "open",
        legalHold: false,
        retentionClass: "standard",
        participants: [],
        createdAt: "t",
        createdBy: "alice",
        extra: true,
      }),
    ).toThrow(/unknown key/);
  });

  it("accepts the synthetic three-model experiment package and rejects unknown fields", () => {
    const valid = JSON.parse(
      readFileSync(join(fixturesDir, "experiment-package.valid.json"), "utf8"),
    );
    const pkg = parseExperimentPackage(valid);
    expect(pkg.schemaId).toBe(EXPERIMENT_PACKAGE_SCHEMA_ID);
    expect(pkg.candidates).toHaveLength(3);
    expect(pkg.candidates.every((c) => c.cost.status === "unknown")).toBe(true);
    expect(pkg.candidates.every((c) => c.goldState === "unknown")).toBe(true);
    expect(pkg.agreement.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
    const invalid = JSON.parse(
      readFileSync(join(fixturesDir, "experiment-package.unknown-field.json"), "utf8"),
    );
    expect(() => parseExperimentPackage(invalid)).toThrow(/unknown key/);
  });

  it("accepts an experiment summary without fabricating agreement or gold", () => {
    const valid = JSON.parse(
      readFileSync(join(fixturesDir, "experiment-summary.valid.json"), "utf8"),
    );
    const summary = parseExperimentSummary(valid);
    expect(summary.schemaId).toBe(EXPERIMENT_SUMMARY_SCHEMA_ID);
    expect(summary.agreement).toBeNull();
    expect(summary.candidates.every((c) => c.goldState === "unknown")).toBe(true);
    expect(parseExperimentImport(valid).schemaId).toBe(EXPERIMENT_SUMMARY_SCHEMA_ID);
  });

  it("rejects fabricated cost or missing agreement caveat", () => {
    const valid = JSON.parse(
      readFileSync(join(fixturesDir, "experiment-package.valid.json"), "utf8"),
    ) as Record<string, unknown>;
    const candidates = structuredClone(valid.candidates) as Record<string, unknown>[];
    candidates[0] = { ...candidates[0], cost: { status: "observed", amount: "0.01" } };
    expect(() =>
      parseExperimentPackage({ ...valid, candidates }),
    ).toThrow(/unknown key|cost/);
    const agreement = structuredClone(valid.agreement) as { notes: string[] };
    agreement.notes = ["strategies concurred"];
    expect(() =>
      parseExperimentPackage({ ...valid, agreement }),
    ).toThrow(/agreement-is-not-correctness/);
  });

  it("accepts never-hashed refs as unverified", () => {
    const ref = parseFileServerReference({
      schemaId: FILE_SERVER_REF_SCHEMA_ID,
      id: "ref-2",
      uri: "https://files.example.test/b.bin",
      expectedHash: null,
      verificationStatus: "unverified",
    });
    expect(ref.expectedHash).toBeNull();
    expect(ref.verificationStatus).toBe("unverified");
  });
});

describe("JSON Schema additionalProperties: false", () => {
  const AjvCtor = Ajv2020 as new (opts: {
    allErrors: boolean;
    strict: boolean;
  }) => { compile: (schema: object) => (data: unknown) => boolean };
  const ajv = new AjvCtor({ allErrors: true, strict: true });
  (addFormats as (instance: unknown) => void)(ajv);

  it("health schema rejects unknown fields", () => {
    const validate = ajv.compile(loadSchema("health.v1.json"));
    expect(
      validate({
        schemaId: "cd-collab.health.v1",
        status: "ok",
        service: "x",
        surprise: 1,
      }),
    ).toBe(false);
  });

  it("case schema rejects unknown fields", () => {
    const validate = ajv.compile(loadSchema("case.v1.json"));
    expect(
      validate({
        schemaId: CASE_SCHEMA_ID,
        id: "c",
        title: "t",
        severity: "low",
        status: "open",
        legalHold: false,
        retentionClass: "standard",
        participants: [],
        createdAt: "t",
        createdBy: "a",
        leak: true,
      }),
    ).toBe(false);
  });

  it("brief schema rejects unknown fields", () => {
    const validate = ajv.compile(loadSchema("brief.v1.json"));
    expect(
      validate({
        schemaId: BRIEF_SCHEMA_ID,
        privacyClass: "owner_only",
        header: {},
        timeline: [],
        hypotheses: [],
        actions: [],
        evidence: [],
        attributions: [],
        importedRuns: [],
        leak: true,
      }),
    ).toBe(false);
    expect(validate(JSON.parse(readFileSync(join(fixturesDir, "brief.valid.json"), "utf8")))).toBe(
      true,
    );
  });

  it("prompt-package schema rejects unknown fields", () => {
    const validate = ajv.compile(loadSchema("prompt-package.v1.json"));
    expect(
      validate({
        schemaId: PACKAGE_SCHEMA_ID,
        privacyClass: "share_safe",
        caseId: "c",
        snapshotIdentity: "h",
        manifest: {},
        excerpts: [],
        promptScaffold: null,
        leak: true,
      }),
    ).toBe(false);
    expect(
      validate(JSON.parse(readFileSync(join(fixturesDir, "prompt-package.valid.json"), "utf8"))),
    ).toBe(true);
  });

  it("file-server-ref schema rejects unknown fields", () => {
    const validate = ajv.compile(loadSchema("file-server-ref.v1.json"));
    expect(
      validate({
        schemaId: FILE_SERVER_REF_SCHEMA_ID,
        id: "r",
        uri: "https://files.example.test/c.bin",
        expectedHash: null,
        verificationStatus: "unverified",
        leak: true,
      }),
    ).toBe(false);
  });

  it("qualification report schema accepts the fixture and rejects prompt keys", () => {
    const validate = ajv.compile(loadSchema("qualification-report.v1.json"));
    expect(
      validate(
        JSON.parse(readFileSync(join(fixturesDir, "qualification-report.valid.json"), "utf8")),
      ),
    ).toBe(true);
    expect(
      validate(
        JSON.parse(
          readFileSync(join(fixturesDir, "qualification-report.unknown-field.json"), "utf8"),
        ),
      ),
    ).toBe(false);
    expect(() =>
      parseQualificationReport(
        JSON.parse(readFileSync(join(fixturesDir, "qualification-report.valid.json"), "utf8")),
      ),
    ).not.toThrow();
  });

  it("doctor report schema accepts the fixture and rejects prompt keys", () => {
    const validate = ajv.compile(loadSchema("doctor-report.v1.json"));
    expect(
      validate(JSON.parse(readFileSync(join(fixturesDir, "doctor-report.valid.json"), "utf8"))),
    ).toBe(true);
    expect(
      validate(
        JSON.parse(readFileSync(join(fixturesDir, "doctor-report.unknown-field.json"), "utf8")),
      ),
    ).toBe(false);
    expect(() =>
      parseDoctorReport(
        JSON.parse(readFileSync(join(fixturesDir, "doctor-report.valid.json"), "utf8")),
      ),
    ).not.toThrow();
  });

  it("profile catalog schema accepts the fixture and rejects endpoint keys", () => {
    const validate = ajv.compile(loadSchema("profile-catalog.v1.json"));
    expect(
      validate(JSON.parse(readFileSync(join(fixturesDir, "profile-catalog.valid.json"), "utf8"))),
    ).toBe(true);
    expect(
      validate(
        JSON.parse(readFileSync(join(fixturesDir, "profile-catalog.unknown-field.json"), "utf8")),
      ),
    ).toBe(false);
    expect(() =>
      parseProfileCatalog(
        JSON.parse(readFileSync(join(fixturesDir, "profile-catalog.valid.json"), "utf8")),
      ),
    ).not.toThrow();
  });
});
