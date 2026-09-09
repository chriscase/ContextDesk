import { describe, expect, it } from "vitest";
import {
  PROVIDER_BOUND_REFERENCE_CONTEXT,
  PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
  PROVIDER_BOUND_REFERENCE_IDEMPOTENCY,
  PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS,
  parseProviderBoundReferenceCreate,
} from "./provider-reference.js";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
    providerAlias: "incident-archive",
    objectKey: "mail/2026-09/incident-42.eml",
    displayName: "Customer escalation email",
    summary: "Email retained in the configured incident archive.",
    privacyClass: "owner_only",
    clientTime: "2026-09-09T20:10:00.000Z",
    sourceId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "provider-ref-0001",
    ...overrides,
  };
}

describe("provider-bound reference create contract", () => {
  it("parses and freezes local-volume and S3-shaped keys without private coordinates", () => {
    const local = parseProviderBoundReferenceCreate(request());
    const s3Input = request({
      providerAlias: "operations-objects",
      objectKey: "logs/cluster-a/2026-09-09/app.log.gz",
      privacyClass: "share_safe",
    });
    delete s3Input.displayName;
    delete s3Input.clientTime;
    delete s3Input.sourceId;
    const s3 = parseProviderBoundReferenceCreate(s3Input);
    expect(local).toEqual(request());
    expect(s3).toEqual({
      schemaId: PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
      providerAlias: "operations-objects",
      objectKey: "logs/cluster-a/2026-09-09/app.log.gz",
      summary: "Email retained in the configured incident archive.",
      privacyClass: "share_safe",
      idempotencyKey: "provider-ref-0001",
    });
    expect(Object.isFrozen(local)).toBe(true);
    expect(Object.keys(local).filter((field) => (
      PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS as readonly string[]
    ).includes(field))).toEqual([]);
  });

  it("returns a detached value", () => {
    const raw = request();
    const parsed = parseProviderBoundReferenceCreate(raw);
    raw.providerAlias = "changed";
    expect(parsed.providerAlias).toBe("incident-archive");
    expect(parsed).not.toBe(raw);
  });

  it("rejects private, location, hash, and verification fields", () => {
    for (const field of PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS) {
      expect(() => parseProviderBoundReferenceCreate(request({ [field]: "forbidden" })))
        .toThrow(/unknown property|contract drift/u);
    }
  });

  it("publishes explicit server-only context and replay rules", () => {
    expect(PROVIDER_BOUND_REFERENCE_CONTEXT.observationTarget)
      .toBe("only_private_stored_binding_may_drive_stat_or_head_object");
    expect(PROVIDER_BOUND_REFERENCE_IDEMPOTENCY.automaticPostRetry).toBe(false);
    expect(PROVIDER_BOUND_REFERENCE_IDEMPOTENCY.intentFields).toContain("objectKey");
    expect(Object.isFrozen(PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS)).toBe(true);
  });
});
