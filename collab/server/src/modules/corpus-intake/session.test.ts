import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_LIMITS,
  CORPUS_STREAM_COMMIT_SCHEMA_ID,
  CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
  parseCorpusIntakeSession,
  resolveCorpusIntakeLimits,
  type CorpusIntakeLimitsV1,
  type CorpusIntakePartDeclarationV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { CorpusIntakeRequestError } from "./errors.js";
import { CorpusIntakeSessionService } from "./session.js";
import { CorpusIntakeSpool } from "./spool.js";
import { buildTestZip } from "./zip.js";

const ALICE = { id: "alice", username: "alice" };
const LOG = "2026-08-25T00:00:00Z mailer timeout id=syn-1\n";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-intake-session-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(
    evidence,
    audit,
    new MemoryCaseStore(),
    new CatalogService(undefined, audit),
  );
  const spool = new CorpusIntakeSpool(join(root, "spool"));
  const sessions = new CorpusIntakeSessionService({ spool, limits, domain: cases });
  const investigation = await cases.createCase(ALICE, { title: "Streamed intake" }, "test");
  return { cases, evidence, audit, spool, sessions, caseId: investigation.id, root };
}

function stream(bytes: Uint8Array, chunkBytes = 64 * 1024): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
    }
  })();
}

function preflightBody(
  parts: CorpusIntakePartDeclarationV1[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
    origin: "files" as const,
    sourceLabel: "streamed investigation upload",
    privacyClass: "owner_only" as const,
    idempotencyKey: "batch-streamed-0001",
    parts,
    ...overrides,
  };
}

function filePart(index: number, relativePath: string, bytes: Uint8Array) {
  return {
    index,
    relativePath,
    declaredBytes: bytes.byteLength,
    declaredMediaType: "text/plain",
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CorpusIntakeRequestError) return error.payload.code;
    throw error;
  }
  throw new Error("expected the intake to be refused");
}

describe("streamed corpus intake preflight", () => {
  it("states counts, bytes, limits, stages, and truthful unknowns before any byte moves", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes), filePart(1, "mailer/b.log", bytes)]),
    );
    expect(parseCorpusIntakeSession(session).state).toBe("awaiting_bytes");
    expect(session.selection.partCount).toBe(2);
    expect(session.selection.declaredBytes).toBe(bytes.byteLength * 2);
    expect(session.selection.compressedBytes).toBeNull();
    expect(session.selection.expandedBytes).toBe(bytes.byteLength * 2);
    expect(session.limits).toEqual(CORPUS_INTAKE_LIMITS);
    expect(session.stages).toEqual([
      "preflight",
      "upload",
      "classify",
      "privacy_scan",
      "stage_evidence",
      "commit",
    ]);
    expect(session.unknowns).toEqual(["member_encodings", "duplicate_digests"]);
    expect(session.progress.determinate).toBe(true);
  });

  it("reports an archive's expanded size as unknown until its index is read", async () => {
    const { sessions, caseId } = await harness();
    const archive = buildTestZip([{ name: "mailer/a.log", data: Buffer.from(LOG) }]);
    const session = await sessions.preflight(caseId, ALICE, preflightBody(
      [{ index: 0, relativePath: "diagnostics.zip", declaredBytes: archive.byteLength, declaredMediaType: "application/zip" }],
      { origin: "zip" },
    ));
    expect(session.selection.compressedBytes).toBe(archive.byteLength);
    expect(session.selection.expandedBytes).toBeNull();
    expect(session.unknowns).toContain("expanded_bytes");
    expect(session.unknowns).toContain("member_count");
    expect(session.stages).toContain("archive_index");
  });

  it("refuses an inadmissible selection on the manifest alone", async () => {
    const { sessions, caseId } = await harness();
    const many = Array.from(
      { length: CORPUS_INTAKE_LIMITS.maxFileCount + 1 },
      (_, index) => filePart(index, `mailer/${index}.log`, Buffer.from(LOG)),
    );
    await expect(sessions.preflight(caseId, ALICE, preflightBody(many)))
      .rejects.toThrow(/file_count_exceeded/);
    await expect(sessions.preflight(caseId, ALICE, preflightBody([{
      index: 0,
      relativePath: "mailer/huge.log",
      declaredBytes: CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
      declaredMediaType: "text/plain",
    }]))).rejects.toThrow(/per_file_bytes_exceeded/);
  });
});

describe("streamed corpus intake transport", () => {
  it("accepts a part in bounded chunks and reports resumable progress", async () => {
    const { sessions, caseId, spool } = await harness();
    const bytes = Buffer.from(LOG.repeat(2_000));
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    const half = Math.floor(bytes.byteLength / 2);
    const first = await sessions.receivePart(
      caseId,
      session.sessionId,
      0,
      0,
      stream(bytes.subarray(0, half)),
    );
    expect(first.parts[0]?.receivedBytes).toBe(half);
    expect(first.parts[0]?.complete).toBe(false);
    expect(first.progress.determinate).toBe(true);

    const second = await sessions.receivePart(
      caseId,
      session.sessionId,
      0,
      half,
      stream(bytes.subarray(half)),
    );
    expect(second.parts[0]?.complete).toBe(true);
    expect(second.parts[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await spool.partSize(caseId, session.sessionId, 0)).toBe(bytes.byteLength);
  });

  it("re-receives from an earlier offset after an interrupted upload", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG.repeat(500));
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    // A connection that dies mid-part leaves a short prefix behind.
    await sessions.receivePart(caseId, session.sessionId, 0, 0, stream(bytes.subarray(0, 97)));
    const resumed = await sessions.receivePart(
      caseId,
      session.sessionId,
      0,
      40,
      stream(bytes.subarray(40)),
    );
    expect(resumed.parts[0]?.receivedBytes).toBe(bytes.byteLength);
    expect(resumed.parts[0]?.complete).toBe(true);

    // A duplicate request for the same range settles to the same digest.
    const repeated = await sessions.receivePart(caseId, session.sessionId, 0, 0, stream(bytes));
    expect(repeated.parts[0]?.digest).toBe(resumed.parts[0]?.digest);
  });

  it("refuses an offset beyond what the server holds instead of leaving a hole", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    expect(await code(sessions.receivePart(caseId, session.sessionId, 0, 10, stream(bytes))))
      .toBe("part_offset_conflict");
  });

  it("refuses a chunk larger than one request may carry", async () => {
    const limits = resolveCorpusIntakeLimits({ maxRequestBytes: 4_096 });
    const { sessions, caseId } = await harness(limits);
    const bytes = Buffer.from(LOG.repeat(400));
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    expect(bytes.byteLength).toBeGreaterThan(limits.maxRequestBytes);
    expect(await code(
      sessions.receivePart(caseId, session.sessionId, 0, 0, stream(bytes, bytes.byteLength)),
    )).toBe("request_too_large");
  });

  it("refuses a part that sends more than it declared", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    expect(await code(
      sessions.receivePart(caseId, session.sessionId, 0, 0, stream(Buffer.from(LOG.repeat(2)))),
    )).toBe("part_bytes_conflict");
  });

  it("will not expand until every declared part has landed", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes), filePart(1, "mailer/b.log", bytes)]),
    );
    await sessions.receivePart(caseId, session.sessionId, 0, 0, stream(bytes));
    expect(await code(sessions.expand(caseId, ALICE, session.sessionId))).toBe("part_incomplete");
  });
});

describe("streamed corpus intake expansion and commit", () => {
  async function uploadFiles(
    sessions: CorpusIntakeSessionService,
    caseId: string,
    files: Array<{ path: string; bytes: Uint8Array; mediaType?: string }>,
    overrides: Record<string, unknown> = {},
  ) {
    const session = await sessions.preflight(caseId, ALICE, preflightBody(
      files.map((file, index) => ({
        index,
        relativePath: file.path,
        declaredBytes: file.bytes.byteLength,
        declaredMediaType: file.mediaType ?? "text/plain",
      })),
      overrides,
    ));
    for (const [index, file] of files.entries()) {
      await sessions.receivePart(caseId, session.sessionId, index, 0, stream(file.bytes));
    }
    return session;
  }

  it("expands loose files, stages them, and commits addressable evidence", async () => {
    const { sessions, cases, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const session = await uploadFiles(sessions, caseId, [
      { path: "mailer/a.log", bytes },
      { path: "mailer/b.log", bytes: Buffer.from(`${LOG}second\n`) },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual([
      "mailer/a.log",
      "mailer/b.log",
    ]);
    expect(report.rejected).toEqual([]);
    const batch = await sessions.commit(caseId, ALICE, session.sessionId, {
      schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
      previewToken: report.previewToken,
      idempotencyKey: "batch-streamed-0001",
    }, "test");
    expect(batch.items).toHaveLength(2);
    const artifacts = await cases.listArtifacts(caseId, ALICE, false);
    expect(artifacts.map((row) => row.filename).sort()).toEqual([
      "mailer/a.log",
      "mailer/b.log",
    ]);
  });

  it("expands a ZIP without ever holding the whole archive", async () => {
    const { sessions, caseId } = await harness();
    const archive = buildTestZip([
      { name: "mailer/a.log", data: Buffer.from(LOG), method: 8 },
      { name: "mailer/b.log", data: Buffer.from(LOG.repeat(3)), method: 8 },
      { name: "mailer/../escape.log", data: Buffer.from(LOG) },
    ]);
    const session = await uploadFiles(
      sessions,
      caseId,
      [{ path: "diagnostics.zip", bytes: archive, mediaType: "application/zip" }],
      { origin: "zip" },
    );
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual([
      "mailer/a.log",
      "mailer/b.log",
    ]);
    expect(report.rejected.map((row) => row.reason)).toEqual(["path_traversal"]);
    const status = await sessions.status(caseId, session.sessionId);
    expect(status.state).toBe("previewed");
    expect(status.unknowns).toEqual([]);
    expect(status.selection.expandedBytes).toBe(LOG.length * 4);
  });

  it("replays an identical commit instead of writing a second copy", async () => {
    const { sessions, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const first = await uploadFiles(sessions, caseId, [{ path: "mailer/a.log", bytes }]);
    const report = await sessions.expand(caseId, ALICE, first.sessionId);
    const commitBody = {
      schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
      previewToken: report.previewToken,
      idempotencyKey: "batch-streamed-0001",
    };
    const committed = await sessions.commit(caseId, ALICE, first.sessionId, commitBody, "test");
    expect(committed.replayed).toBe(false);

    // A second session carrying identical bytes under the same key is a retry,
    // not a second corpus.
    const second = await uploadFiles(sessions, caseId, [{ path: "mailer/a.log", bytes }]);
    const replayReport = await sessions.expand(caseId, ALICE, second.sessionId);
    expect(replayReport.previewToken).toBe(report.previewToken);
    const replayed = await sessions.commit(caseId, ALICE, second.sessionId, {
      ...commitBody,
      previewToken: replayReport.previewToken,
    }, "test");
    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(committed.id);
  });

  it("refuses a commit whose preview token no longer describes the session", async () => {
    const { sessions, caseId } = await harness();
    const session = await uploadFiles(sessions, caseId, [
      { path: "mailer/a.log", bytes: Buffer.from(LOG) },
    ]);
    await sessions.expand(caseId, ALICE, session.sessionId);
    expect(await code(sessions.commit(caseId, ALICE, session.sessionId, {
      schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
      previewToken: "0".repeat(64),
      idempotencyKey: "batch-streamed-0001",
    }, "test"))).toBe("preflight_mismatch");
  });

  it("returns the same preview for a duplicate expand request", async () => {
    const { sessions, caseId } = await harness();
    const session = await uploadFiles(sessions, caseId, [
      { path: "mailer/a.log", bytes: Buffer.from(LOG) },
    ]);
    const first = await sessions.expand(caseId, ALICE, session.sessionId);
    const second = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(second).toEqual(first);
  });
});

describe("streamed corpus intake cancellation and recovery", () => {
  it("cancels during expansion, cleans the spool, and stages nothing", async () => {
    const { sessions, cases, caseId, spool } = await harness();
    const members = Array.from({ length: 64 }, (_, index) => ({
      name: `mailer/${index}.log`,
      data: Buffer.from(LOG.repeat(64)),
      method: 8 as const,
    }));
    const archive = buildTestZip(members);
    const session = await sessions.preflight(caseId, ALICE, preflightBody(
      [{
        index: 0,
        relativePath: "diagnostics.zip",
        declaredBytes: archive.byteLength,
        declaredMediaType: "application/zip",
      }],
      { origin: "zip" },
    ));
    await sessions.receivePart(caseId, session.sessionId, 0, 0, stream(archive));
    const expanding = sessions
      .expand(caseId, ALICE, session.sessionId)
      .then(() => null, (error: unknown) => error);
    // Cancel while the expander is still walking members, not before it starts.
    for (let tick = 0; tick < 200; tick += 1) {
      if ((await sessions.status(caseId, session.sessionId)).state === "expanding") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await sessions.status(caseId, session.sessionId)).state).toBe("expanding");
    await sessions.cancel(caseId, session.sessionId);
    const failure = await expanding;
    expect(failure).toBeInstanceOf(CorpusIntakeRequestError);
    expect((failure as CorpusIntakeRequestError).payload.code).toBe("session_cancelled");
    const status = await sessions.status(caseId, session.sessionId);
    expect(status.state).toBe("cancelled");
    await expect(stat(spool.paths(caseId, session.sessionId).staged)).rejects.toThrow();
    expect(await cases.listArtifacts(caseId, ALICE, false)).toEqual([]);
  });

  it("resumes an in-flight session after a process restart", async () => {
    const { sessions, spool, caseId } = await harness();
    const bytes = Buffer.from(LOG.repeat(200));
    const session = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    await sessions.receivePart(caseId, session.sessionId, 0, 0, stream(bytes.subarray(0, 300)));

    // A fresh service over the same spool is what a restarted process sees.
    const restarted = new CorpusIntakeSessionService({ spool, domain: {
      listCorpusDigests: async () => new Set<string>(),
      commitStagedCorpusIntake: async () => {
        throw new Error("not used");
      },
    } });
    const recovered = await restarted.status(caseId, session.sessionId);
    expect(recovered.parts[0]?.receivedBytes).toBe(300);
    expect(recovered.parts[0]?.complete).toBe(false);
    const finished = await restarted.receivePart(
      caseId,
      session.sessionId,
      0,
      300,
      stream(bytes.subarray(300)),
    );
    expect(finished.parts[0]?.complete).toBe(true);
  });

  it("reclaims expired sessions and interrupted scratch members", async () => {
    const { sessions, spool, caseId } = await harness();
    const bytes = Buffer.from(LOG);
    const live = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/a.log", bytes)]),
    );
    await sessions.receivePart(caseId, live.sessionId, 0, 0, stream(bytes));
    // A crash between "member written" and "member accepted" leaves scratch.
    await writeFile(join(spool.paths(caseId, live.sessionId).staged, "pending-crash"), "x");

    const expired = await sessions.preflight(
      caseId,
      ALICE,
      preflightBody([filePart(0, "mailer/b.log", bytes)], {
        idempotencyKey: "batch-streamed-0002",
      }),
    );
    await spool.write({ ...expired, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    const report = await spool.recover();
    expect(report.removedSessions).toBe(1);
    expect(report.removedScratch).toBe(1);
    expect(await spool.read(caseId, expired.sessionId)).toBeNull();
    expect(await readdir(spool.paths(caseId, live.sessionId).staged)).toEqual([]);
    expect((await spool.read(caseId, live.sessionId))?.parts[0]?.complete).toBe(true);
  });
});
