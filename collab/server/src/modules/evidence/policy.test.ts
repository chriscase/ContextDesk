import { describe, expect, it } from "vitest";
import {
  ALLOWED_MEDIA,
  MAX_JSON_EVIDENCE_BYTES,
  MAX_UPLOAD_BYTES,
  STREAM_ARTIFACT_KINDS,
  assertFilenameAllowed,
  assertJsonBytesAllowed,
  assertMediaTypeAllowed,
  assertUploadAllowed,
  isStreamArtifactKind,
} from "./policy.js";

describe("evidence upload policy", () => {
  it("keeps legacy JSON/base64 and JSON bytes GET bounded at 1_000_000 bytes", () => {
    expect(MAX_UPLOAD_BYTES).toBe(1_000_000);
    expect(MAX_JSON_EVIDENCE_BYTES).toBe(1_000_000);
    expect(() => assertUploadAllowed("text/plain", MAX_UPLOAD_BYTES)).not.toThrow();
    expect(() => assertUploadAllowed("text/plain", MAX_UPLOAD_BYTES + 1)).toThrow(
      "upload exceeds size cap",
    );
    expect(() => assertJsonBytesAllowed(MAX_JSON_EVIDENCE_BYTES)).not.toThrow();
    expect(() => assertJsonBytesAllowed(MAX_JSON_EVIDENCE_BYTES + 1)).toThrow(
      "too_large_for_json_bytes",
    );
  });

  it("allows only log, email, and attachment for streaming intake", () => {
    expect([...STREAM_ARTIFACT_KINDS]).toEqual(["log", "email", "attachment"]);
    expect(isStreamArtifactKind("log")).toBe(true);
    expect(isStreamArtifactKind("email")).toBe(true);
    expect(isStreamArtifactKind("attachment")).toBe(true);
    expect(isStreamArtifactKind("file_server_ref")).toBe(false);
  });

  it("preserves media type and filename validation independently of byte length", () => {
    for (const mediaType of ALLOWED_MEDIA) {
      expect(() => assertMediaTypeAllowed(mediaType)).not.toThrow();
      expect(() => assertUploadAllowed(mediaType, 0)).not.toThrow();
    }
    expect(() => assertMediaTypeAllowed("application/json")).toThrow(
      "media type not allowlisted: application/json",
    );
    expect(() => assertFilenameAllowed("app.log")).not.toThrow();
    expect(() => assertFilenameAllowed("../secret.log")).toThrow(
      "filename contains an invalid path segment",
    );
    expect(() => assertFilenameAllowed("/etc/passwd")).toThrow("filename must be relative");
  });
});
