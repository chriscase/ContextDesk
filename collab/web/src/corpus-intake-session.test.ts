import {
  CORPUS_INTAKE_LIMITS,
  corpusIntakeInlineDecodedBytes,
  resolveCorpusIntakeLimits,
} from "@cd-collab/contracts/corpus-intake";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBytes,
  runStreamedIntake,
  summarizeCorpusSelection,
} from "./corpus-intake-session.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("corpus selection preflight", () => {
  it("keeps a small selection inline and routes a large one to the streamed lane", () => {
    const inlineCap = corpusIntakeInlineDecodedBytes(CORPUS_INTAKE_LIMITS);
    expect(summarizeCorpusSelection("files", [
      { relativePath: "mailer/a.log", size: 1_024 },
    ]).lane).toBe("inline");
    // The inline lane is bounded by what one request can carry, not by the
    // corpus allowance, so a selection above it must not try to travel as one
    // JSON body.
    expect(summarizeCorpusSelection("files", [
      { relativePath: "mailer/a.log", size: inlineCap + 1 },
    ]).lane).toBe("streamed");
    expect(summarizeCorpusSelection("directory", Array.from(
      { length: 64 },
      (_, index) => ({ relativePath: `mailer/${index}.log`, size: 16 }),
    )).lane).toBe("streamed");
  });

  it("states counts, bytes, stages, and the unknowns it cannot resolve yet", () => {
    const archive = summarizeCorpusSelection("zip", [
      { relativePath: "diagnostics.zip", size: 24 * 1024 * 1024 },
    ]);
    expect(archive.fileCount).toBe(1);
    expect(archive.compressedBytes).toBe(24 * 1024 * 1024);
    expect(archive.expandedBytes).toBeNull();
    expect(archive.stages).toContain("archive_index");
    expect(archive.unknowns).toContain("expanded_bytes");
    expect(archive.blocking).toBeNull();

    const loose = summarizeCorpusSelection("files", [
      { relativePath: "mailer/a.log", size: 128 },
      { relativePath: "mailer/b.log", size: 256 },
    ]);
    expect(loose.expandedBytes).toBe(384);
    expect(loose.compressedBytes).toBeNull();
    expect(loose.unknowns).not.toContain("expanded_bytes");
  });

  it("names a blocking selection problem in the operator's own terms", () => {
    expect(summarizeCorpusSelection("zip", [
      { relativePath: "diagnostics.zip", size: CORPUS_INTAKE_LIMITS.maxArchiveBytes + 1 },
    ]).blocking).toMatch(/64 MiB or smaller/);
    expect(summarizeCorpusSelection("files", [
      { relativePath: "mailer/huge.log", size: CORPUS_INTAKE_LIMITS.maxFileBytes + 1 },
    ]).blocking).toMatch(/larger than 64 MiB/);
    expect(summarizeCorpusSelection("files", [])).toMatchObject({ blocking: null, fileCount: 0 });
  });

  it("reflects an owner-local limit rather than the built-in default", () => {
    const narrowed = resolveCorpusIntakeLimits({ maxArchiveBytes: 8 * 1024 * 1024 });
    expect(summarizeCorpusSelection("zip", [
      { relativePath: "diagnostics.zip", size: 12 * 1024 * 1024 },
    ], narrowed).blocking).toMatch(/8 MiB or smaller/);
  });

  it("formats byte counts the way an operator reads them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});

describe("streamed intake transfer", () => {
  function sessionRecord(parts: Array<{ declaredBytes: number; receivedBytes: number }>) {
    return {
      schemaId: "cd-collab.corpus_intake_session.v1",
      sessionId: "11111111-1111-4111-8111-111111111111",
      caseId: "case-1",
      origin: "files",
      sourceLabel: "streamed upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-web-000001",
      state: "awaiting_bytes",
      createdAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-25T06:00:00.000Z",
      limits: { ...CORPUS_INTAKE_LIMITS, maxRequestBytes: 4 },
      selection: {
        partCount: parts.length,
        declaredBytes: parts.reduce((total, part) => total + part.declaredBytes, 0),
        compressedBytes: null,
        expandedBytes: parts.reduce((total, part) => total + part.declaredBytes, 0),
      },
      stages: ["preflight", "upload", "classify", "privacy_scan", "stage_evidence", "commit"],
      unknowns: ["member_encodings", "duplicate_digests"],
      parts: parts.map((part, index) => ({
        index,
        relativePath: `mailer/${index}.log`,
        declaredBytes: part.declaredBytes,
        declaredMediaType: "text/plain",
        receivedBytes: part.receivedBytes,
        complete: part.receivedBytes === part.declaredBytes,
        digest: part.receivedBytes === part.declaredBytes ? "a".repeat(64) : null,
      })),
      progress: {
        stage: "upload",
        determinate: true,
        uploadedBytes: parts.reduce((total, part) => total + part.receivedBytes, 0),
        declaredBytes: parts.reduce((total, part) => total + part.declaredBytes, 0),
        expandedBytes: 0,
        expectedExpandedBytes: null,
        filesSeen: 0,
        filesAccepted: 0,
        filesRejected: 0,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      previewToken: null,
      batchId: null,
      failure: null,
    };
  }

  it("sends binary chunks rather than base64 and reports determinate progress", async () => {
    const bodies: Array<{ url: string; body: unknown; method: string }> = [];
    let received = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ url, body: init?.body, method: String(init?.method ?? "GET") });
      if (url.endsWith("/corpus-intake/sessions")) {
        return { ok: true, status: 201, json: async () => sessionRecord([{ declaredBytes: 10, receivedBytes: 0 }]) };
      }
      if (url.includes("/parts/")) {
        received = Math.min(10, received + 4);
        return { ok: true, status: 200, json: async () => sessionRecord([{ declaredBytes: 10, receivedBytes: received }]) };
      }
      if (url.endsWith("/preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ previewToken: "b".repeat(64), accepted: [], rejected: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => sessionRecord([{ declaredBytes: 10, receivedBytes: received }]) };
    }));

    const progress: number[] = [];
    const outcome = await runStreamedIntake({
      caseId: "case-1",
      origin: "files",
      sourceLabel: "streamed upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-web-000001",
      files: [{ relativePath: "mailer/0.log", file: new Blob([new Uint8Array(10)]) }],
      onProgress: (row) => progress.push(row.uploadedBytes),
    });

    expect(outcome.report.previewToken).toBe("b".repeat(64));
    const parts = bodies.filter((row) => row.url.includes("/parts/"));
    expect(parts).toHaveLength(3);
    // The whole point of this lane: chunks travel as Blob slices the browser
    // streams from disk, never as a base64 string held in the tab.
    for (const part of parts) {
      expect(part.body).toBeInstanceOf(Blob);
      expect(typeof part.body).not.toBe("string");
    }
    expect(parts.map((row) => new URL(row.url, "http://x").searchParams.get("offset")))
      .toEqual(["0", "4", "8"]);
    expect(progress.at(-1)).toBe(10);
  });

  it("resumes from the bytes the server already holds", async () => {
    const offsets: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/parts/")) {
        offsets.push(new URL(url, "http://x").searchParams.get("offset") ?? "");
        return { ok: true, status: 200, json: async () => sessionRecord([{ declaredBytes: 10, receivedBytes: 10 }]) };
      }
      if (url.endsWith("/preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ previewToken: "c".repeat(64), accepted: [], rejected: [] }),
        };
      }
      void init;
      return { ok: true, status: 200, json: async () => sessionRecord([{ declaredBytes: 10, receivedBytes: 10 }]) };
    }));

    await runStreamedIntake({
      caseId: "case-1",
      origin: "files",
      sourceLabel: "streamed upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-web-000001",
      files: [{ relativePath: "mailer/0.log", file: new Blob([new Uint8Array(10)]) }],
      resumeSession: sessionRecord([{ declaredBytes: 10, receivedBytes: 8 }]) as never,
    });
    expect(offsets).toEqual(["8"]);
  });

  it("surfaces the server's named refusal instead of a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        schemaId: "cd-collab.corpus_intake_error.v1",
        error: "expanded_budget_exceeded",
        code: "expanded_budget_exceeded",
        message: "The expanded corpus is larger than this investigation accepts.",
        detail: "expanded size exceeds cap",
        limit: 536870912,
        observed: null,
        path: null,
        retryable: false,
      }),
    })));
    await expect(runStreamedIntake({
      caseId: "case-1",
      origin: "files",
      sourceLabel: "streamed upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-web-000001",
      files: [{ relativePath: "mailer/0.log", file: new Blob([new Uint8Array(4)]) }],
    })).rejects.toMatchObject({
      payload: { code: "expanded_budget_exceeded", limit: 536870912 },
      message: "The expanded corpus is larger than this investigation accepts.",
    });
  });
});
