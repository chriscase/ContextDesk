import { describe, expect, it } from "vitest";
import { classifyBytes } from "./classify.js";
import { previewCorpusBytes } from "./preview.js";

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
});

describe("previewCorpusBytes", () => {
  it("keeps mixed accepted and rejected files visible without decoding rejected bytes as text", () => {
    const preview = previewCorpusBytes({
      caseId: "case-1",
      origin: "files",
      privacyClass: "owner_only",
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
      origin: "directory",
      privacyClass: "owner_only",
      files: [
        { relativePath: "mailer/a.log", bytes: LOG },
        { relativePath: "mailer/b.log", bytes: LOG },
      ],
    });
    expect(preview.report.accepted.every((row) => row.duplicateDigest)).toBe(true);
  });
});
