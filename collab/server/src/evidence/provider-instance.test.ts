import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
  MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES,
  EvidenceProviderInstanceError,
  parseEvidenceProviderInstance,
  serializeEvidenceProviderInstance,
} from "./provider-instance.js";

const ID = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function valid(providerKind: "filesystem" | "s3" = "filesystem") {
  return {
    schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
    providerInstanceId: ID,
    providerKind,
  } as const;
}

function expectCode(input: Uint8Array, code: string): void {
  try {
    parseEvidenceProviderInstance(input);
    throw new Error("expected parser failure");
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceProviderInstanceError);
    expect((error as EvidenceProviderInstanceError).code).toBe(code);
    expect(String(error)).not.toContain(ID);
  }
}

describe("evidence provider instance manifest", () => {
  it("round-trips each provider in one deterministic canonical encoding", () => {
    for (const providerKind of ["filesystem", "s3"] as const) {
      const encoded = serializeEvidenceProviderInstance(valid(providerKind));
      expect(new TextDecoder().decode(encoded)).toBe(
        `{"schemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
          + `"providerInstanceId":"${ID}","providerKind":"${providerKind}"}`,
      );
      const parsed = parseEvidenceProviderInstance(encoded);
      expect(parsed).toEqual(valid(providerKind));
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(serializeEvidenceProviderInstance(parsed)).toEqual(encoded);
    }
  });

  it("accepts insignificant whitespace and member reordering", () => {
    const parsed = parseEvidenceProviderInstance(bytes(
      ` { "providerKind" : "s3", "providerInstanceId" : "${ID}", `
        + `"schemaId" : "${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}" } \n`,
    ));
    expect(parsed).toEqual(valid("s3"));
  });

  it("rejects malformed, trailing, non-UTF8, BOM, and oversized encodings", () => {
    expectCode(Uint8Array.of(0xff), "invalid_utf8");
    expectCode(bytes(`\ufeff${JSON.stringify(valid())}`), "bom");
    expectCode(bytes(`${JSON.stringify(valid())}x`), "trailing_data");
    expectCode(bytes("{"), "invalid_json");
    expectCode(bytes(" ".repeat(MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES + 1)), "too_large");
  });

  it("rejects duplicate keys, including escaped aliases and nested duplicates", () => {
    expectCode(bytes(
      `{"schemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
        + `"schemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
        + `"providerInstanceId":"${ID}","providerKind":"s3"}`,
    ), "duplicate_key");
    expectCode(bytes(
      `{"schemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
        + `"\\u0073chemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
        + `"providerInstanceId":"${ID}","providerKind":"s3"}`,
    ), "duplicate_key");
    expectCode(bytes(
      `{"schemaId":"${EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID}",`
        + `"providerInstanceId":"${ID}","providerKind":"s3",`
        + `"extra":{"a":1,"a":2}}`,
    ), "duplicate_key");
  });

  it("rejects roots, fields, schema, ids, and providers outside the closed shape", () => {
    expectCode(bytes("[]"), "invalid_shape");
    expectCode(bytes(JSON.stringify({ ...valid(), extra: "x" })), "unknown_field");
    const { providerKind: _omitted, ...missing } = valid();
    expectCode(bytes(JSON.stringify(missing)), "missing_field");
    expectCode(bytes(JSON.stringify({ ...valid(), schemaId: "wrong" })), "invalid_schema");
    for (const providerInstanceId of [
      ID.toUpperCase(),
      ` ${ID}`,
      `{${ID}}`,
      "00000000-0000-0000-0000-000000000000",
      "8d2f63fa-327e-0b90-9d43-aa4f10e1d3a2",
      "8d2f63fa-327e-4b90-7d43-aa4f10e1d3a2",
      "not-a-uuid",
    ]) {
      expectCode(bytes(JSON.stringify({ ...valid(), providerInstanceId })), "invalid_id");
    }
    expectCode(bytes(JSON.stringify({ ...valid(), providerKind: "file" })), "invalid_provider");
  });

  it("does not invoke accessors or accept symbols, exotic prototypes, or hidden fields", () => {
    let reads = 0;
    const accessor = {
      schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
      providerInstanceId: ID,
      get providerKind() {
        reads += 1;
        return "s3" as const;
      },
    };
    expect(() => serializeEvidenceProviderInstance(accessor)).toThrow(EvidenceProviderInstanceError);
    expect(reads).toBe(0);

    const symbol = { ...valid(), [Symbol("private")]: "x" };
    expect(() => serializeEvidenceProviderInstance(symbol)).toThrow(EvidenceProviderInstanceError);

    const exotic = Object.assign(Object.create({ inherited: true }), valid());
    expect(() => serializeEvidenceProviderInstance(exotic)).toThrow(EvidenceProviderInstanceError);

    const hidden = { ...valid() };
    Object.defineProperty(hidden, "providerKind", { value: "filesystem", enumerable: false });
    expect(() => serializeEvidenceProviderInstance(hidden)).toThrow(EvidenceProviderInstanceError);

    const hostile = new Proxy(valid(), {
      ownKeys() {
        throw new Error(`private ${ID}`);
      },
    });
    expect(() => serializeEvidenceProviderInstance(hostile)).toThrow(
      new EvidenceProviderInstanceError("invalid_shape"),
    );
  });

  it("fails closed across malformed scanner branches", () => {
    for (const input of [
      "",
      `{"schemaId":"bad\\x"}`,
      `{"schemaId":"bad\\u123"}`,
      `{"schemaId":01}`,
      `{"schemaId":1.}`,
      "[[[[[[[[[[null]]]]]]]]]]",
    ]) {
      expect(() => parseEvidenceProviderInstance(bytes(input))).toThrow(
        EvidenceProviderInstanceError,
      );
    }
  });
});
