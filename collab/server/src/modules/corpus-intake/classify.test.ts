import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyBytes } from "./classify.js";
import { decodeBase64, duplicateDigestFlags, previewCorpusBytes } from "./preview.js";

const LOG = new TextEncoder().encode("2026-08-15T00:00:00Z mailer timeout id=syn-1\n");
const JSON_LINES = new TextEncoder().encode([
  '{"ts":"2026-08-15T00:00:00Z","level":"info","event":"checkout-started"}',
  '{"ts":"2026-08-15T00:00:01Z","level":"error","event":"checkout-failed"}',
  "",
].join("\n"));

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

  it("accepts common rotated log names while still classifying their bytes", () => {
    for (const path of [
      "mailer/service.log.1",
      "mailer/service.log-2026-08-25",
      "mailer/service.log.previous",
    ]) {
      const accepted = classifyBytes(path, LOG, "text/plain", "owner_only");
      expect("mediaType" in accepted && accepted.mediaType).toBe("text/x-log");
    }

    const binary = classifyBytes(
      "mailer/service.log.2",
      new Uint8Array([0x41, 0x00, 0x42]),
      "text/plain",
      "owner_only",
    );
    expect("reason" in binary && binary.reason).toBe("binary_or_unknown");

    const disguised = classifyBytes("mailer/service.log.exe", LOG, "text/plain", "owner_only");
    expect("reason" in disguised && disguised.reason).toBe("unsupported_media");
  });

  it("accepts valid JSON Lines as text logs with extension-scoped media aliases", () => {
    for (const [path, claimedMedia] of [
      ["api/events.jsonl", "application/json"],
      ["api/events.ndjson", "application/x-ndjson"],
    ] as const) {
      const accepted = classifyBytes(path, JSON_LINES, claimedMedia, "owner_only");
      expect("mediaType" in accepted && accepted.mediaType).toBe("text/x-log");
      expect("artifactKind" in accepted && accepted.artifactKind).toBe("log");
    }

    const ordinaryLogClaimingJson = classifyBytes(
      "api/events.log",
      JSON_LINES,
      "application/json",
      "owner_only",
    );
    expect("reason" in ordinaryLogClaimingJson && ordinaryLogClaimingJson.reason)
      .toBe("unsupported_media");
  });

  it("keeps JSON Lines validation, binary rejection, and share-safe privacy gates intact", () => {
    const malformed = classifyBytes(
      "api/malformed.jsonl",
      new TextEncoder().encode('{"event":"ok"}\n{"event":\n'),
      "application/json",
      "owner_only",
    );
    expect("reason" in malformed && malformed.reason).toBe("unsupported_media");

    const binary = classifyBytes(
      "api/binary.jsonl",
      new Uint8Array([0x7b, 0x00, 0x7d]),
      "application/json",
      "owner_only",
    );
    expect("reason" in binary && binary.reason).toBe("binary_or_unknown");

    const privateStructuredKey = classifyBytes(
      "api/private.jsonl",
      new TextEncoder().encode('{"authorization":"fixture-not-a-real-secret"}\n'),
      "application/json",
      "share_safe",
    );
    expect("reason" in privateStructuredKey && privateStructuredKey.reason).toBe("redaction_failed");
    if ("detail" in privateStructuredKey) {
      expect(privateStructuredKey.detail).not.toContain("fixture-not-a-real-secret");
    }
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

  it("accepts sparse non-UTF-8 private text but rejects binary markers and dense invalid bytes", () => {
    const invalidUtf8 = new Uint8Array(2_050).fill(0x41);
    invalidUtf8.set([0xc3, 0x28], 2_048);
    const invalid = classifyBytes("mailer/invalid-tail.log", invalidUtf8, "text/plain", "owner_only");
    expect("encodingStatus" in invalid && invalid.encodingStatus).toBe("normalized_non_utf8");

    const shareSafe = classifyBytes("mailer/invalid-tail.log", invalidUtf8, "text/plain", "share_safe");
    expect("reason" in shareSafe && shareSafe.reason).toBe("binary_or_unknown");

    const denseInvalid = classifyBytes(
      "mailer/dense-invalid.log",
      new Uint8Array(80).fill(0xff),
      "text/plain",
      "owner_only",
    );
    expect("reason" in denseInvalid && denseInvalid.reason).toBe("binary_or_unknown");

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
  it("accepts all six logs in the synthetic checkout-cascade ZIP", () => {
    const archive = readFileSync(
      new URL("../../../../../fixtures/log-lab/archives/checkout-cascade.zip", import.meta.url),
    );
    const preview = previewCorpusBytes({
      caseId: "case-checkout-cascade",
      actorId: "actor-synthetic-1",
      origin: "zip",
      privacyClass: "owner_only",
      sourceLabel: "synthetic checkout cascade",
      idempotencyKey: "batch-checkout-cascade-1",
      files: [],
      archive,
    });

    expect(preview.report.accepted.map((row) => row.relativePath)).toEqual([
      "api/app.jsonl",
      "audit/deploy.jsonl",
      "db/database.log",
      "edge/access.jsonl",
      "queue/events.jsonl",
      "worker/worker.log",
    ]);
    expect(preview.report.accepted.filter((row) => row.relativePath.endsWith(".jsonl")))
      .toHaveLength(4);
    expect(preview.report.accepted.every((row) => row.mediaType === "text/x-log"))
      .toBe(true);
    expect(preview.report.rejected).toEqual([]);
  });

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

describe("duplicateDigestFlags", () => {
  it("marks live known digests and within-batch repeats without weakening uniqueness", () => {
    const original = "ab".repeat(32);
    const other = "cd".repeat(32);
    expect(duplicateDigestFlags([original, other], new Set())).toEqual([false, false]);
    expect(duplicateDigestFlags([original, original], new Set())).toEqual([true, true]);
    expect(duplicateDigestFlags([original, other], new Set([original]))).toEqual([true, false]);
  });
});
