import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_LIMITS,
  CORPUS_STREAM_COMMIT_SCHEMA_ID,
  CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
  V8_MAX_STRING_LENGTH,
  corpusIntakePeakResidentBytes,
  resolveCorpusIntakeLimits,
  type CorpusIntakeLimitsV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { CorpusIntakeRequestError } from "./errors.js";
import { CorpusIntakeSessionService } from "./session.js";
import { CorpusIntakeSpool } from "./spool.js";
import { buildTestZip, type TestZipFile, type TestZipOptions } from "./zip.js";

const MIB = 1024 * 1024;
const ALICE = { id: "alice", username: "alice" };
const LINE = "2026-08-25T00:00:00Z mailer timeout id=syn region=eu-west-1 attempt=3\n";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Fixtures are generated here rather than committed. A repository is the wrong
 * place for half a gigabyte of synthetic logs, and a generated corpus can be
 * sized to the exact boundary a test is about.
 */
function logBytes(byteLength: number, seed?: number): Buffer {
  const filled = Buffer.alloc(byteLength);
  // A seeded line makes members distinct. Identical members are legitimately
  // deduplicated by content address, which is the wrong shape for a test about
  // how many separate members a path reads.
  const unit = Buffer.from(seed === undefined ? LINE : `${LINE.trimEnd()} seed=${seed}\n`);
  for (let offset = 0; offset < byteLength; offset += unit.byteLength) {
    unit.copy(filled, offset, 0, Math.min(unit.byteLength, byteLength - offset));
  }
  if (byteLength > 0) filled[byteLength - 1] = 0x0a;
  return filled;
}

async function harness(limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-intake-adv-"));
  dirs.push(root);
  const audit = new MemoryAuditStore();
  const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
  const cases = new CaseService(
    evidence,
    audit,
    new MemoryCaseStore(),
    new CatalogService(undefined, audit),
  );
  const spool = new CorpusIntakeSpool(join(root, "spool"));
  const sessions = new CorpusIntakeSessionService({ spool, limits, domain: cases });
  const investigation = await cases.createCase(ALICE, { title: "Adversarial intake" }, "test");
  return { cases, evidence, sessions, spool, caseId: investigation.id };
}

/** Push one selection through preflight and upload without ever holding it whole. */
async function upload(
  sessions: CorpusIntakeSessionService,
  caseId: string,
  parts: Array<{ path: string; bytes: Buffer; mediaType?: string }>,
  overrides: Record<string, unknown> = {},
  chunkBytes = MIB,
) {
  const session = await sessions.preflight(caseId, ALICE, {
    schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
    origin: "files",
    sourceLabel: "adversarial upload",
    privacyClass: "owner_only",
    idempotencyKey: "batch-adversarial-01",
    parts: parts.map((part, index) => ({
      index,
      relativePath: part.path,
      declaredBytes: part.bytes.byteLength,
      declaredMediaType: part.mediaType ?? "text/plain",
    })),
    ...overrides,
  });
  for (const [index, part] of parts.entries()) {
    for (let offset = 0; offset < part.bytes.byteLength; offset += chunkBytes) {
      const end = Math.min(offset + chunkBytes, part.bytes.byteLength);
      const slice = part.bytes.subarray(offset, end);
      await sessions.receivePart(caseId, session.sessionId, index, offset, (async function* () {
        yield slice;
      })());
    }
  }
  return session;
}

async function uploadArchive(
  sessions: CorpusIntakeSessionService,
  caseId: string,
  files: TestZipFile[],
  options: TestZipOptions = {},
  limitOverrides: Record<string, unknown> = {},
) {
  const archive = Buffer.from(buildTestZip(files, options));
  return {
    archive,
    session: await upload(
      sessions,
      caseId,
      [{ path: "diagnostics.zip", bytes: archive, mediaType: "application/zip" }],
      { origin: "zip", ...limitOverrides },
    ),
  };
}

async function refusal(promise: Promise<unknown>): Promise<CorpusIntakeRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CorpusIntakeRequestError) return error;
    throw error;
  }
  throw new Error("expected the intake to be refused");
}

/** Peak heap plus off-heap buffers observed while `work` runs. */
async function peakResident<T>(work: () => Promise<T>): Promise<{ result: T; peakBytes: number }> {
  const sample = () => {
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.arrayBuffers;
  };
  const baseline = sample();
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, sample() - baseline);
  }, 20);
  try {
    const result = await work();
    peak = Math.max(peak, sample() - baseline);
    return { result, peakBytes: peak };
  } finally {
    clearInterval(timer);
  }
}

describe("streamed corpus intake at the advertised byte ceiling", () => {
  it(
    "accepts a corpus larger than any JSON body could carry, in bounded memory",
    { timeout: 180_000 },
    async () => {
      const { sessions, caseId } = await harness();
      const partBytes = 64 * MIB;
      const parts = Array.from({ length: 8 }, (_, index) => ({
        path: `mailer/part-${index}.log`,
        bytes: logBytes(partBytes),
      }));
      const totalBytes = partBytes * 8;
      expect(totalBytes).toBe(CORPUS_INTAKE_LIMITS.maxExpandedBytes);
      // The whole point: this corpus can never be one JSON body, because it is
      // larger than the longest string the runtime can hold.
      expect(totalBytes).toBeGreaterThan(V8_MAX_STRING_LENGTH);

      const { result: report, peakBytes } = await peakResident(async () => {
        const session = await upload(sessions, caseId, parts, {}, 8 * MIB);
        return sessions.expand(caseId, ALICE, session.sessionId);
      });
      expect(report.rejected).toEqual([]);
      expect(report.accepted).toHaveLength(8);
      expect(report.accepted.reduce((total, row) => total + row.byteLength, 0)).toBe(totalBytes);
      // Peak resident stays near the stated bound and nowhere near the corpus.
      expect(peakBytes).toBeLessThan(corpusIntakePeakResidentBytes(CORPUS_INTAKE_LIMITS) * 4);
      expect(peakBytes).toBeLessThan(totalBytes / 4);
    },
  );

  it(
    "holds the same peak for a corpus four times the size",
    { timeout: 180_000 },
    async () => {
      const measure = async (partCount: number): Promise<number> => {
        const { sessions, caseId } = await harness();
        const parts = Array.from({ length: partCount }, (_, index) => ({
          path: `mailer/part-${index}.log`,
          bytes: logBytes(32 * MIB),
        }));
        const { peakBytes } = await peakResident(async () => {
          const session = await upload(sessions, caseId, parts, {}, 8 * MIB);
          return sessions.expand(caseId, ALICE, session.sessionId);
        });
        return peakBytes;
      };
      const small = await measure(3);
      const large = await measure(12);
      // 96 MiB against 384 MiB under one ceiling. A lane that buffered the
      // corpus could not put both under the smaller corpus's own size.
      expect(small).toBeLessThan(96 * MIB);
      expect(large).toBeLessThan(96 * MIB);
    },
  );
});

describe("streamed corpus intake budget boundaries", () => {
  const narrow = resolveCorpusIntakeLimits({
    maxExpandedBytes: 2 * MIB,
    maxFileBytes: MIB,
    maxLineBytes: MIB,
    maxStructuredParseBytes: MIB,
    maxFileCount: 4,
    maxArchiveBytes: 8 * MIB,
  });

  it(
    "accepts a manifest at exactly the advertised ceiling and refuses one byte past it",
    async () => {
      const { sessions, caseId, spool } = await harness();
      const partBytes = 64 * MIB;
      const exact = Array.from({ length: 8 }, (_, index) => ({
        index,
        relativePath: `mailer/part-${index}.log`,
        declaredBytes: partBytes,
        declaredMediaType: "text/plain",
      }));
      expect(exact.reduce((total, part) => total + part.declaredBytes, 0))
        .toBe(CORPUS_INTAKE_LIMITS.maxExpandedBytes);

      // Refusing on the manifest costs no bytes, which is the point: an
      // operator learns a half-gigabyte selection is inadmissible before
      // spending the upload rather than after.
      const accepted = await sessions.preflight(caseId, ALICE, {
        schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
        origin: "files",
        sourceLabel: "ceiling selection",
        privacyClass: "owner_only",
        idempotencyKey: "batch-adversarial-02",
        parts: exact,
      });
      expect(accepted.selection.declaredBytes).toBe(CORPUS_INTAKE_LIMITS.maxExpandedBytes);
      expect(accepted.progress.uploadedBytes).toBe(0);

      const error = await refusal(sessions.preflight(caseId, ALICE, {
        schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
        origin: "files",
        sourceLabel: "ceiling selection",
        privacyClass: "owner_only",
        idempotencyKey: "batch-adversarial-03",
        parts: [
          ...exact,
          {
            index: 8,
            relativePath: "mailer/one-more-byte.log",
            declaredBytes: 1,
            declaredMediaType: "text/plain",
          },
        ],
      }));
      expect(error.payload.code).toBe("expanded_budget_exceeded");
      expect(await spool.partSize(caseId, accepted.sessionId, 0)).toBe(0);
    },
  );

  it("accepts exactly the expanded budget and refuses one byte more", async () => {
    const exact = await harness(narrow);
    const accepted = await uploadArchive(exact.sessions, exact.caseId, [
      { name: "mailer/a.log", data: logBytes(MIB) },
      { name: "mailer/b.log", data: logBytes(MIB) },
    ]);
    const report = await exact.sessions.expand(
      exact.caseId,
      ALICE,
      accepted.session.sessionId,
    );
    expect(report.accepted).toHaveLength(2);
    expect(report.accepted.reduce((total, row) => total + row.byteLength, 0))
      .toBe(narrow.maxExpandedBytes);

    const over = await harness(narrow);
    const rejected = await uploadArchive(over.sessions, over.caseId, [
      { name: "mailer/a.log", data: logBytes(MIB) },
      { name: "mailer/b.log", data: logBytes(MIB) },
      { name: "mailer/c.log", data: logBytes(1) },
    ]);
    const error = await refusal(
      over.sessions.expand(over.caseId, ALICE, rejected.session.sessionId),
    );
    expect(error.payload.code).toBe("expanded_budget_exceeded");
    expect(error.payload.limit).toBe(narrow.maxExpandedBytes);
    expect(error.payload.message).toMatch(/larger than this investigation accepts/);
  });

  it("accepts exactly the file count and refuses one file more", async () => {
    const exact = await harness(narrow);
    const accepted = await uploadArchive(
      exact.sessions,
      exact.caseId,
      Array.from({ length: narrow.maxFileCount }, (_, index) => ({
        name: `mailer/${index}.log`,
        data: logBytes(1_024),
      })),
    );
    const report = await exact.sessions.expand(exact.caseId, ALICE, accepted.session.sessionId);
    expect(report.accepted).toHaveLength(narrow.maxFileCount);

    const over = await harness(narrow);
    const rejected = await uploadArchive(
      over.sessions,
      over.caseId,
      Array.from({ length: narrow.maxFileCount + 1 }, (_, index) => ({
        name: `mailer/${index}.log`,
        data: logBytes(1_024),
      })),
    );
    const error = await refusal(over.sessions.expand(over.caseId, ALICE, rejected.session.sessionId));
    expect(error.payload.code).toBe("file_count_exceeded");
    expect(error.payload.limit).toBe(narrow.maxFileCount);
  });

  it("accepts exactly the per-file ceiling and refuses one byte more", async () => {
    const { sessions, caseId } = await harness(narrow);
    const { session } = await uploadArchive(sessions, caseId, [
      { name: "mailer/exact.log", data: logBytes(narrow.maxFileBytes) },
      { name: "mailer/over.log", data: logBytes(narrow.maxFileBytes + 1) },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/exact.log"]);
    expect(report.rejected).toEqual([
      {
        relativePath: "mailer/over.log",
        reason: "file_too_large",
        detail: "declared file size exceeds cap",
      },
    ]);
  });

  it("refuses an oversized loose file at preflight, before a byte is accepted", async () => {
    const { sessions, caseId, spool } = await harness(narrow);
    const error = await refusal(sessions.preflight(caseId, ALICE, {
      schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
      origin: "files",
      sourceLabel: "adversarial upload",
      privacyClass: "owner_only",
      idempotencyKey: "batch-adversarial-01",
      parts: [{
        index: 0,
        relativePath: "mailer/huge.log",
        declaredBytes: narrow.maxFileBytes + 1,
        declaredMediaType: "text/plain",
      }],
    }));
    expect(error.payload.code).toBe("per_file_bytes_exceeded");
    expect(await spool.recover()).toEqual({ removedSessions: 0, removedScratch: 0 });
  });
});

describe("streamed corpus intake archive safety", () => {
  it("refuses a compression bomb on its ratio, not on its expanded size", async () => {
    const { sessions, caseId } = await harness();
    const { session } = await uploadArchive(sessions, caseId, [
      { name: "mailer/bomb.log", data: logBytes(4 * MIB), method: 8 },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted).toEqual([]);
    expect(report.rejected.map((row) => row.reason)).toEqual(["extreme_ratio"]);
  });

  it("expands a ZIP64 archive through the streamed lane with every cap intact", async () => {
    const { sessions, caseId } = await harness();
    const { session } = await uploadArchive(
      sessions,
      caseId,
      [
        { name: "mailer/a.log", data: logBytes(4_096), zip64: true },
        { name: "mailer/../escape.log", data: logBytes(256), zip64: true },
      ],
      { zip64Directory: true },
    );
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/a.log"]);
    expect(report.rejected.map((row) => row.reason)).toEqual(["path_traversal"]);
  });

  it("refuses a nested archive by default and expands one when depth is configured", async () => {
    const inner = Buffer.from(buildTestZip([{ name: "inner/deep.log", data: logBytes(512) }]));
    const outer: TestZipFile[] = [
      { name: "mailer/outer.log", data: logBytes(256) },
      { name: "mailer/inner.zip", data: inner },
    ];

    const closed = await harness();
    const refused = await uploadArchive(closed.sessions, closed.caseId, outer);
    const shallow = await closed.sessions.expand(
      closed.caseId,
      ALICE,
      refused.session.sessionId,
    );
    expect(shallow.accepted.map((row) => row.relativePath)).toEqual(["mailer/outer.log"]);
    expect(shallow.rejected.map((row) => row.reason)).toEqual(["nested_archive"]);

    const nested = await harness(resolveCorpusIntakeLimits({ maxArchiveDepth: 1 }));
    const allowed = await uploadArchive(nested.sessions, nested.caseId, outer);
    const deep = await nested.sessions.expand(
      nested.caseId,
      ALICE,
      allowed.session.sessionId,
    );
    expect(deep.accepted.map((row) => row.relativePath).sort()).toEqual([
      "inner/deep.log",
      "mailer/outer.log",
    ]);
    expect(deep.rejected).toEqual([]);
  });

  it("refuses archive members that would escape the investigation namespace", async () => {
    const { sessions, caseId } = await harness();
    const { session } = await uploadArchive(sessions, caseId, [
      { name: "../escape.log", data: logBytes(128) },
      { name: "/etc/passwd.log", data: logBytes(128) },
      { name: "C:\\logs\\drive.log", data: logBytes(128) },
      { name: "mailer/link.log", data: logBytes(128), unixMode: 0o120777 },
      { name: "mailer/dev.log", data: logBytes(128), unixMode: 0o020666 },
      { name: "mailer/keep.log", data: logBytes(128) },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/keep.log"]);
    expect(report.rejected.map((row) => row.reason).sort()).toEqual([
      "absolute_path",
      "device_entry",
      "drive_or_unc_path",
      "path_traversal",
      "symlink_or_hardlink",
    ]);
  });

  it("refuses colliding paths after Unicode and case normalization", async () => {
    const { sessions, caseId } = await harness();
    const { session } = await uploadArchive(sessions, caseId, [
      { name: "mailer/caf\u00e9.log", data: logBytes(128) },
      { name: "mailer/cafe\u0301.log", data: logBytes(128) },
      { name: "mailer/CAFÉ.log", data: logBytes(128) },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted).toHaveLength(1);
    expect(report.rejected.map((row) => row.reason))
      .toEqual(["duplicate_normalized_path", "duplicate_normalized_path"]);
  });

  it("refuses two loose parts that normalize to the same path", async () => {
    const { sessions, caseId } = await harness();
    const session = await upload(sessions, caseId, [
      { path: "mailer/a.log", bytes: logBytes(128) },
      { path: "mailer/A.log", bytes: logBytes(256) },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/a.log"]);
    expect(report.rejected.map((row) => row.reason)).toEqual(["duplicate_normalized_path"]);
  });
});

describe("streamed corpus intake encodings", () => {
  const utf8 = Buffer.from("2026-08-25T00:00:00Z café timeout\n", "utf8");
  const ascii = Buffer.from("2026-08-25T00:00:00Z plain timeout\n", "ascii");
  const latin1 = Buffer.concat([
    Buffer.from("2026-08-25T00:00:00Z caf", "ascii"),
    Buffer.from([0xe9]),
    Buffer.from(" timeout\n", "ascii"),
  ]);
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("2026-08-25T00:00:00Z wide timeout\n", "utf16le"),
  ]);

  it("separates exact, lossy, and unsupported encodings in one mixed archive", async () => {
    const { sessions, caseId } = await harness();
    const { session } = await uploadArchive(sessions, caseId, [
      { name: "mailer/utf8.log", data: utf8 },
      { name: "mailer/ascii.log", data: ascii },
      { name: "mailer/latin1.log", data: latin1 },
      { name: "mailer/utf16.log", data: utf16 },
    ]);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => [row.relativePath, row.encodingStatus])).toEqual([
      ["mailer/utf8.log", "utf8"],
      ["mailer/ascii.log", "utf8"],
      ["mailer/latin1.log", "normalized_non_utf8"],
    ]);
    expect(report.rejected).toEqual([
      {
        relativePath: "mailer/utf16.log",
        reason: "unsupported_encoding",
        detail: "content is utf-16le; this investigation accepts utf-8, us-ascii, utf-8-lossy",
      },
    ]);
  });

  it("accepts UTF-16 once an owner configures it and refuses lossy text once they do not", async () => {
    const wide = await harness(resolveCorpusIntakeLimits({
      supportedEncodings: ["utf-8", "us-ascii", "utf-16le"],
    }));
    const { session } = await uploadArchive(wide.sessions, wide.caseId, [
      { name: "mailer/utf16.log", data: utf16 },
      { name: "mailer/latin1.log", data: latin1 },
    ]);
    const report = await wide.sessions.expand(wide.caseId, ALICE, session.sessionId);
    expect(report.accepted.map((row) => row.relativePath)).toEqual(["mailer/utf16.log"]);
    expect(report.rejected).toEqual([
      {
        relativePath: "mailer/latin1.log",
        reason: "unsupported_encoding",
        detail: "content is utf-8-lossy; this investigation accepts utf-8, us-ascii, utf-16le",
      },
    ]);
  });
});

describe("streamed corpus intake after commit", () => {
  it("commits and reads a large corpus one member at a time", async () => {
    const memberBytes = 16 * MIB;
    const memberCount = 6;
    const totalBytes = memberBytes * memberCount;

    // Record what the persistence path actually asks the spool for. A lane that
    // assembled the corpus would need one allocation the size of the corpus;
    // this proves the largest single read is one member.
    const reads: number[] = [];
    const root = await mkdtemp(join(tmpdir(), "cd-collab-intake-read-"));
    dirs.push(root);
    const audit = new MemoryAuditStore();
    const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
    const cases = new CaseService(
      evidence,
      audit,
      new MemoryCaseStore(),
      new CatalogService(undefined, audit),
    );
    class RecordingSpool extends CorpusIntakeSpool {
      override async readStaged(
        caseId: string,
        sessionId: string,
        digest: string,
      ): Promise<Uint8Array> {
        const bytes = await super.readStaged(caseId, sessionId, digest);
        reads.push(bytes.byteLength);
        return bytes;
      }
    }
    const sessions = new CorpusIntakeSessionService({
      spool: new RecordingSpool(join(root, "spool")),
      domain: cases,
    });
    const investigation = await cases.createCase(ALICE, { title: "Read back" }, "test");
    const caseId = investigation.id;

    const parts = Array.from({ length: memberCount }, (_, index) => ({
      path: `mailer/part-${index}.log`,
      bytes: logBytes(memberBytes, index),
    }));
    const session = await upload(sessions, caseId, parts, {}, 8 * MIB);
    const report = await sessions.expand(caseId, ALICE, session.sessionId);
    const batch = await sessions.commit(caseId, ALICE, session.sessionId, {
      schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
      previewToken: report.previewToken,
      idempotencyKey: "batch-adversarial-01",
    }, "test");
    expect(batch.items).toHaveLength(memberCount);

    // One read per distinct member, each bounded by the per-file ceiling.
    expect(reads).toHaveLength(memberCount);
    for (const read of reads) {
      expect(read).toBe(memberBytes);
      expect(read).toBeLessThanOrEqual(CORPUS_INTAKE_LIMITS.maxFileBytes);
    }

    const artifacts = await cases.listArtifacts(caseId, ALICE, false);
    expect(artifacts).toHaveLength(memberCount);
    const { result, peakBytes } = await peakResident(async () => {
      let total = 0;
      for (const artifact of artifacts) {
        const bytes = await evidence.get(artifact.contentHash!);
        expect(bytes?.byteLength).toBe(memberBytes);
        total += bytes?.byteLength ?? 0;
      }
      return total;
    });
    expect(result).toBe(totalBytes);
    // Later analysis reads members individually. The exact peak depends on when
    // the collector runs, but it can never reach the corpus, which is what a
    // whole-corpus read would require.
    expect(peakBytes).toBeLessThan(totalBytes);
  }, 120_000);
});
