import { describe, expect, it } from "vitest";
import { classifyBytes } from "./classify.js";
import { decodeBase64, previewCorpusBytes } from "./preview.js";

const LOG = new TextEncoder().encode("2026-08-15T00:00:00Z mailer timeout id=syn-1\n");

describe("classifyBytes", () => {
  it("accepts allowlisted text/log/json/csv/xml/eml and rejects binaries", () => {
    const log = classifyBytes("mailer/shared-timeout.log", LOG, "text/plain", "owner_only");
    expect("digest" in log).toBe(true);
    const json = classifyBytes(
      "mailer/event.json",
      new TextEncoder().encode('{"id":"syn-1","event":"timeout"}'),
      "application/json",
      "owner_only",
    );
    expect("mediaType" in json && json.mediaType).toBe("application/json");
    const binary = classifyBytes(
      "mailer/payload.bin",
      new Uint8Array([0, 1, 2, 3, 255]),
      "application/octet-stream",
      "owner_only",
    );
    expect("reason" in binary && binary.reason).toBe("unsupported_media");
    const nulLog = classifyBytes(
      "mailer/binary.log",
      new Uint8Array([0x41, 0x00, 0x42]),
      "text/plain",
      "owner_only",
    );
    expect("reason" in nulLog && nulLog.reason).toBe("binary_or_unknown");
  });

  it("fail-closes share_safe on privacy findings without echoing the payload", () => {
    const secret = "password: fixture-not-a-real-secret";
    const blocked = classifyBytes(
      "mailer/leaky.log",
      new TextEncoder().encode(`timeout\n${secret}\n`),
      "text/plain",
      "share_safe",
    );
    expect("reason" in blocked && blocked.reason).toBe("redaction_failed");
    if ("detail" in blocked) {
      expect(blocked.detail).not.toContain("fixture-not-a-real-secret");
      expect(blocked.detail).not.toContain(secret);
    }
    const allowed = classifyBytes(
      "mailer/leaky.log",
      new TextEncoder().encode(`timeout\n${secret}\n`),
      "text/plain",
      "owner_only",
    );
    expect("digest" in allowed).toBe(true);
  });

  it("rejects invalid UTF-8 and binary markers even when they occur after a text prefix", () => {
    const invalidUtf8 = new Uint8Array(2_050).fill(0x41);
    invalidUtf8.set([0xc3, 0x28], 2_048);
    const invalid = classifyBytes("mailer/invalid-tail.log", invalidUtf8, "text/plain", "owner_only");
    expect("reason" in invalid && invalid.reason).toBe("binary_or_unknown");

    const binaryTail = new Uint8Array(2_049).fill(0x41);
    binaryTail[2_048] = 0;
    const binary = classifyBytes("mailer/binary-tail.log", binaryTail, "text/plain", "owner_only");
    expect("reason" in binary && binary.reason).toBe("binary_or_unknown");
  });

  it("parses structured JSON and scans keys, values, paths, and source metadata", () => {
    const forbiddenJson = classifyBytes(
      "mailer/event.json",
      new TextEncoder().encode('{"nested":{"authorization":"synthetic-value"}}'),
      "application/json",
      "share_safe",
    );
    expect("reason" in forbiddenJson && forbiddenJson.reason).toBe("redaction_failed");

    const malformedJson = classifyBytes(
      "mailer/event.json",
      new TextEncoder().encode('{"event":'),
      "application/json",
      "owner_only",
    );
    expect("reason" in malformedJson && malformedJson.reason).toBe("unsupported_media");

    const privatePath = classifyBytes(
      "host.internal/event.log",
      LOG,
      "text/plain",
      "share_safe",
    );
    expect("reason" in privatePath && privatePath.reason).toBe("redaction_failed");

    const metadata = previewCorpusBytes({
      caseId: "case-1",
      actorId: "actor-1",
      origin: "files",
      privacyClass: "share_safe",
      sourceLabel: "host.internal",
      idempotencyKey: "batch-synthetic-1",
      files: [{ relativePath: "mailer/event.log", bytes: LOG, mediaType: "text/plain" }],
    });
    expect(metadata.report.accepted).toEqual([]);
    expect(metadata.report.rejected[0]?.reason).toBe("redaction_failed");
    expect(metadata.report.rejected[0]?.detail).not.toContain("host.internal");
  });

  it("uses a strict media policy for share-safe and declared formats", () => {
    const xml = classifyBytes(
      "mailer/event.xml",
      new TextEncoder().encode("<event>synthetic</event>"),
      "application/xml",
      "share_safe",
    );
    expect("reason" in xml && xml.reason).toBe("redaction_failed");

    const mismatched = classifyBytes(
      "mailer/event.json",
      new TextEncoder().encode('{"event":"synthetic"}'),
      "text/csv",
      "owner_only",
    );
    expect("reason" in mismatched && mismatched.reason).toBe("unsupported_media");
  });

  it("accepts only canonical base64", () => {
    expect(Buffer.from(decodeBase64("file", "c3ludGhldGljCg==")).toString("utf8")).toBe(
      "synthetic\n",
    );
    expect(() => decodeBase64("file", "c3ludGhldGljCg")).toThrow(/valid base64/);
    expect(() => decodeBase64("file", "c3ludGhldGljCg==\n")).toThrow(/valid base64/);
    expect(() => decodeBase64("file", "c3ludGhldGljCg===")).toThrow(/valid base64/);
  });
});

describe("previewCorpusBytes", () => {
  it("keeps mixed accepted and rejected files visible without decoding rejected bytes as text", () => {
    const preview = previewCorpusBytes({
      caseId: "case-1",
      actorId: "actor-1",
      origin: "files",
      privacyClass: "owner_only",
      sourceLabel: "synthetic source",
      idempotencyKey: "batch-synthetic-1",
      files: [
        { relativePath: "mailer/shared-timeout.log", bytes: LOG, mediaType: "text/plain" },
        {
          relativePath: "mailer/payload.exe",
          bytes: new Uint8Array([0x4d, 0x5a, 0x00]),
          mediaType: "application/octet-stream",
        },
      ],
    });
    expect(preview.report.accepted.map((row) => row.relativePath)).toEqual([
      "mailer/shared-timeout.log",
    ]);
    expect(preview.report.rejected.map((row) => row.relativePath)).toEqual(["mailer/payload.exe"]);
    expect(preview.classified).toHaveLength(1);
  });

  it("marks duplicate digests in the same batch", () => {
    const preview = previewCorpusBytes({
      caseId: "case-1",
      actorId: "actor-1",
      origin: "directory",
      privacyClass: "owner_only",
      sourceLabel: "synthetic source",
      idempotencyKey: "batch-synthetic-2",
      files: [
        { relativePath: "mailer/a.log", bytes: LOG },
        { relativePath: "mailer/b.log", bytes: LOG },
      ],
    });
    expect(preview.report.accepted.every((row) => row.duplicateDigest)).toBe(true);
  });
});
