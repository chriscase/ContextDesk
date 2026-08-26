import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  CORPUS_INTAKE_EXPANSION_WINDOW_BYTES,
  CORPUS_STREAM_SESSION_SCHEMA_ID,
  parseCorpusIntakeSession,
  type CorpusIntakeSessionV1,
} from "@cd-collab/contracts";
import { fileByteSource, type ByteSource } from "./byte-source.js";
import { intakeError } from "./errors.js";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** Case ids reach the filesystem, so only an inert token may become a path segment. */
const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SpoolPaths {
  session: string;
  manifest: string;
  parts: string;
  staged: string;
  cancelled: string;
}

/**
 * On-disk home for in-flight intake.
 *
 * Everything a session needs to survive a browser reload or a server restart
 * lives here: the declared manifest, the bytes received so far, and the members
 * already expanded and classified. Received length is read back from the files
 * themselves rather than trusted from the manifest, so a crash mid-write
 * resumes from what actually landed.
 */
export class CorpusIntakeSpool {
  constructor(readonly rootDir: string) {}

  paths(caseId: string, sessionId: string): SpoolPaths {
    if (!CASE_ID_RE.test(caseId)) {
      throw intakeError("session_not_found", "This investigation cannot hold an intake session.", {
        detail: "case id is not a spoolable token",
        status: 404,
      });
    }
    if (!SESSION_ID_RE.test(sessionId)) {
      throw intakeError("session_not_found", "That intake session no longer exists.", {
        detail: "session id is not a UUID",
        status: 404,
      });
    }
    const session = join(this.rootDir, caseId, sessionId);
    return {
      session,
      manifest: join(session, "manifest.json"),
      parts: join(session, "parts"),
      staged: join(session, "staged"),
      cancelled: join(session, "cancelled"),
    };
  }

  async create(record: CorpusIntakeSessionV1): Promise<void> {
    const paths = this.paths(record.caseId, record.sessionId);
    await mkdir(paths.parts, { recursive: true });
    await mkdir(paths.staged, { recursive: true });
    await this.write(record);
  }

  /**
   * Durable manifest write: validate, temp file, fsync, rename.
   *
   * Validating on the way out matters because `read` fails closed on an
   * unparsable manifest: an inconsistent record written here would not surface
   * as an error, it would surface as a session that silently disappeared.
   */
  async write(record: CorpusIntakeSessionV1): Promise<void> {
    parseCorpusIntakeSession(record);
    const paths = this.paths(record.caseId, record.sessionId);
    await mkdir(dirname(paths.manifest), { recursive: true });
    const temporary = `${paths.manifest}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, paths.manifest);
  }

  /**
   * Read a session back, correcting every part's received length from the file
   * on disk. The manifest records intent; the files record fact.
   */
  async read(caseId: string, sessionId: string): Promise<CorpusIntakeSessionV1 | null> {
    const paths = this.paths(caseId, sessionId);
    let raw: string;
    try {
      raw = await readFile(paths.manifest, "utf8");
    } catch {
      return null;
    }
    let record: CorpusIntakeSessionV1;
    try {
      record = parseCorpusIntakeSession(JSON.parse(raw));
    } catch {
      return null;
    }
    if (record.caseId !== caseId || record.sessionId !== sessionId) return null;
    const parts = await Promise.all(record.parts.map(async (part) => {
      const received = await this.partSize(caseId, sessionId, part.index);
      const bounded = Math.min(received, part.declaredBytes);
      return {
        ...part,
        receivedBytes: bounded,
        complete: bounded === part.declaredBytes && part.digest !== null,
      };
    }));
    const uploadedBytes = parts.reduce((total, part) => total + part.receivedBytes, 0);
    return {
      ...record,
      parts,
      progress: { ...record.progress, uploadedBytes },
    };
  }

  private partPath(caseId: string, sessionId: string, index: number): string {
    return join(this.paths(caseId, sessionId).parts, `${index}.bin`);
  }

  async partSize(caseId: string, sessionId: string, index: number): Promise<number> {
    try {
      return (await stat(this.partPath(caseId, sessionId, index))).size;
    } catch {
      return 0;
    }
  }

  /**
   * Append one bounded request's worth of bytes at `offset`.
   *
   * Rewriting from an earlier offset is allowed and is how an interrupted
   * upload resumes: the tail is discarded and re-received. Nothing accumulates
   * in memory — the request stream is written straight through.
   */
  async writePart(
    caseId: string,
    sessionId: string,
    index: number,
    offset: number,
    stream: AsyncIterable<Uint8Array>,
    caps: { maxRequestBytes: number; declaredBytes: number },
  ): Promise<{ receivedBytes: number }> {
    const path = this.partPath(caseId, sessionId, index);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a+");
    try {
      const current = (await handle.stat()).size;
      if (offset > current) {
        throw intakeError(
          "part_offset_conflict",
          "Upload resumed past the bytes the server holds. Restart this part from the offset the session reports.",
          { detail: `offset ${offset} is beyond the received length ${current}`, observed: current },
        );
      }
      if (offset < current) await handle.truncate(offset);
      let written = 0;
      let position = offset;
      for await (const chunk of stream) {
        written += chunk.byteLength;
        if (written > caps.maxRequestBytes) {
          throw intakeError(
            "request_too_large",
            "This upload chunk is larger than one request may carry.",
            {
              detail: "chunk exceeded the per-request byte limit",
              limit: caps.maxRequestBytes,
              observed: written,
            },
          );
        }
        if (position + chunk.byteLength > caps.declaredBytes) {
          throw intakeError(
            "part_bytes_conflict",
            "This part sent more bytes than it declared at preflight.",
            {
              detail: "part exceeded its declared size",
              limit: caps.declaredBytes,
              observed: position + chunk.byteLength,
            },
          );
        }
        await handle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
      }
      await handle.sync();
      return { receivedBytes: position };
    } finally {
      await handle.close();
    }
  }

  /** SHA-256 of a completed part, computed by streaming it back off disk. */
  async partDigest(caseId: string, sessionId: string, index: number): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(this.partPath(caseId, sessionId, index), {
      highWaterMark: CORPUS_INTAKE_EXPANSION_WINDOW_BYTES,
    });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async openPart(caseId: string, sessionId: string, index: number) {
    return open(this.partPath(caseId, sessionId, index), "r");
  }

  partStream(caseId: string, sessionId: string, index: number): Readable {
    return createReadStream(this.partPath(caseId, sessionId, index), {
      highWaterMark: CORPUS_INTAKE_EXPANSION_WINDOW_BYTES,
    });
  }

  /**
   * Stage one expanded member. Bytes land in a scratch file first and are
   * renamed to their content address only once the member is accepted, so a
   * rejected or interrupted member never becomes visible as staged evidence.
   */
  async beginStagedMember(caseId: string, sessionId: string): Promise<{
    write: (chunk: Uint8Array) => Promise<void>;
    keep: (digest: string) => Promise<void>;
    discard: () => Promise<void>;
  }> {
    const paths = this.paths(caseId, sessionId);
    await mkdir(paths.staged, { recursive: true });
    const scratch = join(paths.staged, `pending-${randomUUID()}`);
    const handle = await open(scratch, "w");
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    return {
      write: async (chunk) => {
        await handle.write(chunk, 0, chunk.byteLength);
      },
      keep: async (digest) => {
        if (!DIGEST_RE.test(digest)) throw new Error("staged member digest is not a SHA-256 hex string");
        await handle.sync();
        await close();
        await rename(scratch, join(paths.staged, digest));
      },
      discard: async () => {
        await close();
        await rm(scratch, { force: true });
      },
    };
  }

  /**
   * Materialize a nested archive into session scratch so it can be walked.
   *
   * Nested archives are the one place expansion needs random access to bytes it
   * has only seen as a stream. The scratch file is deleted when the source is
   * closed, so it never outlives the walk that needed it.
   */
  async spillNestedArchive(
    caseId: string,
    sessionId: string,
    bytes: AsyncIterable<Uint8Array>,
    byteLength: number,
  ): Promise<ByteSource> {
    const paths = this.paths(caseId, sessionId);
    await mkdir(paths.staged, { recursive: true });
    const scratch = join(paths.staged, `nested-${randomUUID()}`);
    const writer = await open(scratch, "w");
    let written = 0;
    try {
      for await (const chunk of bytes) {
        await writer.write(chunk, 0, chunk.byteLength);
        written += chunk.byteLength;
      }
      await writer.sync();
    } finally {
      await writer.close();
    }
    const handle = await open(scratch, "r");
    const source = fileByteSource(handle, Math.min(written, byteLength));
    return {
      byteLength: source.byteLength,
      read: (offset, length) => source.read(offset, length),
      close: async () => {
        await handle.close();
        await rm(scratch, { force: true });
      },
    };
  }

  async readStaged(caseId: string, sessionId: string, digest: string): Promise<Uint8Array> {
    if (!DIGEST_RE.test(digest)) throw new Error("staged member digest is not a SHA-256 hex string");
    const bytes = await readFile(join(this.paths(caseId, sessionId).staged, digest));
    return new Uint8Array(bytes);
  }

  async markCancelled(caseId: string, sessionId: string): Promise<void> {
    const paths = this.paths(caseId, sessionId);
    await mkdir(paths.session, { recursive: true });
    await writeFile(paths.cancelled, "cancelled", "utf8");
  }

  async isCancelled(caseId: string, sessionId: string): Promise<boolean> {
    try {
      await stat(this.paths(caseId, sessionId).cancelled);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove every byte a session spooled. Used by commit and recovery. */
  async remove(caseId: string, sessionId: string): Promise<void> {
    await rm(this.paths(caseId, sessionId).session, { recursive: true, force: true });
  }

  /**
   * Drop the bytes but keep the manifest.
   *
   * A cancelled session has no claim on spool space, but a status poll that
   * lands after the cancel still deserves to be told what happened rather than
   * a bare not-found.
   */
  async purgeBytes(caseId: string, sessionId: string): Promise<void> {
    const paths = this.paths(caseId, sessionId);
    await rm(paths.parts, { recursive: true, force: true });
    await rm(paths.staged, { recursive: true, force: true });
    await rm(join(paths.session, "preview.json"), { force: true });
  }

  /**
   * Reclaim spool state a crash or an abandoned browser tab left behind.
   *
   * Sessions past their expiry are removed outright; scratch members from an
   * interrupted expansion are removed from sessions that survive, because a
   * `pending-*` file is by construction not addressable evidence.
   */
  async recover(now = Date.now()): Promise<{ removedSessions: number; removedScratch: number }> {
    let removedSessions = 0;
    let removedScratch = 0;
    let cases: string[] = [];
    try {
      cases = await readdir(this.rootDir);
    } catch {
      return { removedSessions, removedScratch };
    }
    for (const caseId of cases) {
      if (!CASE_ID_RE.test(caseId)) continue;
      let sessions: string[] = [];
      try {
        sessions = await readdir(join(this.rootDir, caseId));
      } catch {
        continue;
      }
      for (const sessionId of sessions) {
        if (!SESSION_ID_RE.test(sessionId)) {
          await rm(join(this.rootDir, caseId, sessionId), { recursive: true, force: true });
          continue;
        }
        const record = await this.read(caseId, sessionId);
        if (!record || Date.parse(record.expiresAt) <= now) {
          await this.remove(caseId, sessionId);
          removedSessions += 1;
          continue;
        }
        const paths = this.paths(caseId, sessionId);
        let staged: string[] = [];
        try {
          staged = await readdir(paths.staged);
        } catch {
          continue;
        }
        for (const name of staged) {
          if (DIGEST_RE.test(name)) continue;
          await rm(join(paths.staged, name), { force: true });
          removedScratch += 1;
        }
      }
    }
    return { removedSessions, removedScratch };
  }
}

export { CORPUS_STREAM_SESSION_SCHEMA_ID };
