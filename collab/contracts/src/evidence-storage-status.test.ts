import { describe, expect, it } from "vitest";
import {
  EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  parseEvidenceStorageStatus,
} from "./evidence-storage-status.js";

const base = {
  schemaId: EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  database: "postgres" as const,
  state: "ready" as const,
  checkedAt: "2026-09-01T12:00:00.000Z",
  maxUploadBytes: 30_000_000,
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
});
