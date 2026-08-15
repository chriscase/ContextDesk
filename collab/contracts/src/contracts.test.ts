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
  FILE_SERVER_REF_SCHEMA_ID,
  parseFileServerReference,
  parseHealthResponse,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas");

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
});
