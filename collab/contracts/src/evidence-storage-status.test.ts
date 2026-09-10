import { describe, expect, it } from "vitest";
import {
  EVIDENCE_STORAGE_PROVIDER_IDENTITY_BINDINGS,
  EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  parseEvidenceStorageStatus,
} from "./evidence-storage-status.js";

const base = {
  schemaId: EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  database: "postgres" as const,
  state: "ready" as const,
  checkedAt: "2026-09-01T12:00:00.000Z",
  maxUploadBytes: 30_000_000,
  providerIdentityBinding: "not_reported" as const,
};

describe("evidence storage status contract", () => {
  it("accepts a filesystem status without S3 details", () => {
    expect(parseEvidenceStorageStatus({
      ...base,
      provider: "filesystem",
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      requestTimeoutMs: null,
      credentialsMode: null,
    }).provider).toBe("filesystem");
  });

  it("accepts S3 diagnostics without secret material", () => {
    const parsed = parseEvidenceStorageStatus({
      ...base,
      provider: "s3",
      endpoint: "https://garage.example.test:3900",
      region: "garage",
      bucket: "war-room-evidence",
      prefix: "contextdesk/",
      requestTimeoutMs: 30_000,
      credentialsMode: "default_chain",
    });
    expect(parsed.bucket).toBe("war-room-evidence");
    expect(parsed).not.toHaveProperty("accessKeyId");
    expect(parsed).not.toHaveProperty("secretAccessKey");
  });

  it("rejects S3-shaped fields in a filesystem response", () => {
    expect(() => parseEvidenceStorageStatus({
      ...base,
      provider: "filesystem",
      endpoint: "https://unexpected.example.test",
      region: null,
      bucket: null,
      prefix: null,
      requestTimeoutMs: null,
      credentialsMode: null,
    })).toThrow(/filesystem status/i);
  });

  it("rejects incomplete S3 diagnostics", () => {
    expect(() => parseEvidenceStorageStatus({
      ...base,
      provider: "s3",
      endpoint: null,
      region: "garage",
      bucket: "war-room-evidence",
      prefix: "",
      requestTimeoutMs: 30_000,
      credentialsMode: "static",
    })).toThrow(/S3 status/i);
  });

  it.each(EVIDENCE_STORAGE_PROVIDER_IDENTITY_BINDINGS)(
    "accepts the exact provider identity binding %s",
    (providerIdentityBinding) => {
      expect(parseEvidenceStorageStatus({
        ...base,
        provider: "filesystem",
        endpoint: null,
        region: null,
        bucket: null,
        prefix: null,
        requestTimeoutMs: null,
        credentialsMode: null,
        providerIdentityBinding,
      }).providerIdentityBinding).toBe(providerIdentityBinding);
    },
  );

  it.each([
    "matching",
    "created",
    "existing",
    "reconciled",
    "uninitialized",
    "VALIDATED",
    "legacy-unbound",
    "",
  ])("rejects malformed or unknown provider identity binding %j", (providerIdentityBinding) => {
    expect(() => parseEvidenceStorageStatus({
      ...base,
      provider: "filesystem",
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      requestTimeoutMs: null,
      credentialsMode: null,
      providerIdentityBinding,
    })).toThrow(/providerIdentityBinding/);
  });

  it("rejects additional sensitive identity and credential fields", () => {
    const valid = {
      ...base,
      provider: "filesystem" as const,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      requestTimeoutMs: null,
      credentialsMode: null,
    };
    for (const extra of [
      { providerInstanceId: "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2" },
      { markerPath: "/var/lib/contextdesk/.contextdesk/provider-instance.v1.json" },
      { controlRoot: "/var/lib/contextdesk/evidence" },
      { accessKeyId: "AKIAEXAMPLE" },
      { secretAccessKey: "never-display" },
      { error: "HeadObject failed at s3://war-room-evidence" },
      { expectedProviderInstanceId: "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2" },
    ]) {
      expect(() => parseEvidenceStorageStatus({ ...valid, ...extra })).toThrow(/unknown key/);
    }
  });
});
