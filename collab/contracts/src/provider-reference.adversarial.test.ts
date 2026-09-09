import { describe, expect, it } from "vitest";
import {
  PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
  PROVIDER_BOUND_REFERENCE_LIMITS,
  parseProviderBoundReferenceCreate,
} from "./provider-reference.js";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
    providerAlias: "incident-archive",
    objectKey: "logs/service/app.log",
    summary: "Recorded external log reference.",
    privacyClass: "owner_only",
    idempotencyKey: "provider-ref-0001",
    ...overrides,
  };
}

describe("provider-bound reference adversarial parsing", () => {
  it("rejects malformed aliases", () => {
    for (const providerAlias of [
      "",
      "UPPER",
      "-leading",
      "trailing-",
      "two/parts",
      "s3:bucket",
      `a${"b".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.providerAliasMaxChars)}`,
    ]) {
      expect(() => parseProviderBoundReferenceCreate(request({ providerAlias })))
        .toThrow(/providerAlias/u);
    }
  });

  it("rejects traversal, URI, Windows, ambiguous, and reserved provider keys", () => {
    for (const objectKey of [
      "",
      "/absolute/log.txt",
      "C:\\logs\\app.log",
      "../secret",
      "logs/../secret",
      "logs/./app.log",
      "logs//app.log",
      "logs/app.log/",
      "https://example.invalid/app.log",
      "s3:bucket/key",
      "logs/app.log?version=1",
      "logs/app.log#fragment",
      "logs/%2e%2e/secret",
      "refs/secret.json",
      "BLOBS/aa/hash",
      ".contextdesk/provider-instance.v1.json",
      "logs/\u0000app.log",
    ]) {
      expect(() => parseProviderBoundReferenceCreate(request({ objectKey })))
        .toThrow(/objectKey/u);
    }
  });

  it("enforces key byte, segment, and segment-count bounds", () => {
    expect(() => parseProviderBoundReferenceCreate(request({
      objectKey: `logs/${"é".repeat(128)}`,
    }))).toThrow(/objectKey/u);
    expect(() => parseProviderBoundReferenceCreate(request({
      objectKey: Array.from({ length: 33 }, () => "a").join("/"),
    }))).toThrow(/objectKey/u);
    expect(() => parseProviderBoundReferenceCreate(request({
      objectKey: `x/${"a".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.objectKeyMaxBytes)}`,
    }))).toThrow(/objectKey/u);
  });

  it("rejects malformed optional and common mutation fields", () => {
    for (const overrides of [
      { privacyClass: "public" },
      { clientTime: "tomorrow" },
      { clientTime: "2026-02-30T12:00:00Z" },
      { clientTime: "2026-09-09T12:00:00+14:01" },
      { clientTime: "2026-09-09T24:00:00Z" },
      { sourceId: "source-one" },
      { idempotencyKey: "short" },
      { idempotencyKey: "provider/ref/0001" },
      { summary: " padded" },
      { displayName: "line\nbreak" },
      { displayName: "\u202eunsafe" },
      { schemaId: "cd-collab.provider_bound_reference_create.v2" },
      { unexpected: true },
    ]) {
      expect(() => parseProviderBoundReferenceCreate(request(overrides))).toThrow();
    }
  });

  it("accepts exact legal boundaries and rejects the adjacent values", () => {
    expect(parseProviderBoundReferenceCreate(request({ providerAlias: "a" })).providerAlias)
      .toBe("a");
    expect(parseProviderBoundReferenceCreate(request({
      providerAlias: `a${"b".repeat(62)}z`,
      objectKey: [
        "a".repeat(255),
        "b".repeat(255),
        "c".repeat(255),
        "d".repeat(254),
        "e",
      ].join("/"),
      displayName: "d".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.displayNameMaxChars),
      summary: "s".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.summaryMaxChars),
      idempotencyKey: "a".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.idempotencyKeyMinChars),
    }))).toBeTruthy();
    expect(() => parseProviderBoundReferenceCreate(request({
      displayName: "d".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.displayNameMaxChars + 1),
    }))).toThrow(/displayName/u);
    expect(() => parseProviderBoundReferenceCreate(request({
      summary: "s".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.summaryMaxChars + 1),
    }))).toThrow(/summary/u);
    expect(() => parseProviderBoundReferenceCreate(request({
      idempotencyKey: "a".repeat(PROVIDER_BOUND_REFERENCE_LIMITS.idempotencyKeyMaxChars + 1),
    }))).toThrow(/idempotencyKey/u);
    expect(() => parseProviderBoundReferenceCreate(request({
      objectKey: [
        "a".repeat(255),
        "b".repeat(255),
        "c".repeat(255),
        "d".repeat(254),
        "ef",
      ].join("/"),
    }))).toThrow(/objectKey/u);
  });

  it("rejects accessors without invoking them", () => {
    let invoked = 0;
    const raw = request();
    Object.defineProperty(raw, "objectKey", {
      enumerable: true,
      get() {
        invoked += 1;
        return "logs/app.log";
      },
    });
    expect(() => parseProviderBoundReferenceCreate(raw)).toThrow(/accessor/u);
    expect(invoked).toBe(0);
  });

  it("rejects symbols, non-enumerables, prototypes, cycles, and arrays", () => {
    const withSymbol = request();
    Object.defineProperty(withSymbol, Symbol("secret"), { value: true, enumerable: true });
    expect(() => parseProviderBoundReferenceCreate(withSymbol)).toThrow(/symbol/u);

    const nonEnumerable = request();
    Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
    expect(() => parseProviderBoundReferenceCreate(nonEnumerable)).toThrow(/non-enumerable/u);

    expect(() => parseProviderBoundReferenceCreate(
      Object.assign(Object.create({ inherited: true }), request()),
    )).toThrow(/plain data/u);

    const cyclic = request();
    cyclic.loop = cyclic;
    expect(() => parseProviderBoundReferenceCreate(cyclic)).toThrow(/cyclic/u);
    expect(() => parseProviderBoundReferenceCreate([])).toThrow();
  });
});
