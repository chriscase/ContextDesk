/** Actual installed SDK/handler proof through the production opaque adapter.
 * Disposable file-backed S3 protocol objects; no network/live AWS qualification.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { ConfiguredRetryStrategy } from "@smithy/core/retry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceStore } from "./provider.js";
import { loadEvidenceS3Credentials } from "./s3-secrets.js";
import { loadEvidenceStorageSettings } from "./s3-settings.js";
import { S3EvidenceError, S3EvidenceStore } from "./s3-store.js";
import { DurableS3ProtocolFixture, type CopyFault } from "./testkit/s3-protocol-fixture.js";
import { sha256Hex } from "./store.js";
import { createSqliteRuntime } from "../db/sqlite.js";
import { CaseService } from "../modules/cases/index.js";
import { CatalogService } from "../modules/catalog/index.js";

function assembled(fixture: DurableS3ProtocolFixture, credentialFailure = false): S3EvidenceStore {
  const env = {
    COLLAB_EVIDENCE_PROVIDER: "s3", COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
    COLLAB_EVIDENCE_S3_REGION: "us-east-1", COLLAB_EVIDENCE_S3_BUCKET: fixture.bucket,
    COLLAB_EVIDENCE_S3_PREFIX: "evidence", COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "SYNTHETICACCESS", COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: "synthetic-secret",
  };
  return createEvidenceStore({
    settings: loadEvidenceStorageSettings(env, { controlRoot: fixture.root, storage: "postgres" }),
    credentials: loadEvidenceS3Credentials(env),
    createRequestHandler: () => fixture.handler,
    createS3Client: (config) => new S3Client({ ...config, retryStrategy: new ConfiguredRetryStrategy(3, 0),
      ...(credentialFailure ? { credentials: async () => { throw new Error("synthetic credentials failure"); } } : {}) }) as never,
  }) as S3EvidenceStore;
}
async function withFixture(work: (fixture: DurableS3ProtocolFixture, store: S3EvidenceStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cd-s3-sdk-"));
  try { const fixture = new DurableS3ProtocolFixture(root); await work(fixture, assembled(fixture)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
afterEach(() => vi.unstubAllEnvs());
const bytes = Buffer.from("synthetic-original-evidence\n");
describe("canonical CopyObject retry policy below SDK middleware", () => {
  it.each(["lost", "truncated", "empty", "malformed", "unclassified", "rejected", "embedded"] as CopyFault[])("one wire attempt through opaque production adapter for %s", async (fault) => {
    vi.stubEnv("AWS_MAX_ATTEMPTS", "9"); vi.stubEnv("AWS_RETRY_MODE", "adaptive");
    await withFixture(async (fixture, store) => {
      const stage = await store.stage(bytes);
      fixture.fault = fault;
      const before = fixture.heads;
      let failure: unknown;
      try { await stage.commit(); } catch (error) { failure = error; }
      expect(fixture.copies).toBe(1);
      expect(fixture.heads - before).toBeLessThanOrEqual(4); // one pre-copy read + at most three verification attempts
      if (fault === "rejected" || fault === "embedded") {
        expect(failure).toBeInstanceOf(S3EvidenceError);
        expect((failure as S3EvidenceError).commitOutcomeUnknown).toBe(false);
      } else {
        expect((failure as S3EvidenceError).commitOutcomeUnknown).toBe(true);
        if (fault === "lost") await stage.commit(); // verification only, no wire replay
        else await expect(stage.commit()).rejects.toBeInstanceOf(S3EvidenceError);
        expect(fixture.copies).toBe(1);
      }
      await stage.rollback(); stage.release();
    });
  });
  it("retains ordinary rejected-copy ownership without inventing unknown on verification-only repeat", async () => {
    await withFixture(async (fixture, store) => {
      const stage = await store.stage(bytes); fixture.fault = "rejected";
      let sawCopy = false;
      const base = fixture.handler as { handle: (request: { method: string; headers: Record<string, string> }, options?: unknown) => Promise<unknown> };
      const original = base.handle.bind(base);
      base.handle = async (request, options) => {
        if (request.method === "PUT" && request.headers["x-amz-copy-source"]) sawCopy = true;
        if (sawCopy) fixture.failProbes = true;
        return original(request, options);
      };
      await expect(stage.commit()).rejects.toMatchObject({ commitOutcomeUnknown: false, retainPendingJournal: true });
      await expect(stage.commit()).rejects.toMatchObject({ commitOutcomeUnknown: false, retainPendingJournal: true });
      await stage.rollback(); stage.release();
      expect(fixture.copies).toBe(1);
      expect((await fixture.records()).filter((item) => item.key.includes("/.pending/"))).toHaveLength(1);
    });
  });
  it("does not turn a lost dispatch plus a missing HEAD into proven absence or replay", async () => {
    await withFixture(async (fixture, store) => {
      const stage = await store.stage(bytes); fixture.fault = "lost_missing";
      await expect(stage.commit()).rejects.toMatchObject({ commitOutcomeUnknown: true });
      await expect(stage.commit()).rejects.toMatchObject({ commitOutcomeUnknown: true });
      await stage.rollback(); stage.release();
      expect(fixture.copies).toBe(1);
      expect((await fixture.records()).filter((item) => item.key.includes("/.pending/"))).toHaveLength(1);
      expect(fixture.deletes.some((key) => key.includes("/blobs/"))).toBe(false);
    });
  });
  it("does not dispatch when credentials fail and exposes only an ordinary sanitized error", async () => {
    await withFixture(async (fixture) => {
      const store = assembled(fixture, true);
      await expect(store.copyObject("staging/a", "canonical/a", "promote")).rejects.toMatchObject({
        message: "s3 evidence promote failed: unavailable", commitOutcomeUnknown: false, retainPendingJournal: false,
      });
      expect(fixture.copies).toBe(0);
    });
  });
  it("successful copy plus canonical verification permits the normal transaction, with reads retaining retry budget", async () => {
    await withFixture(async (fixture, store) => {
      const stage = await store.stage(bytes); await stage.commit(); stage.release();
      expect(fixture.copies).toBe(1); expect(await store.get(sha256Hex(bytes))).toEqual(new Uint8Array(bytes));
      fixture.failProbes = true; const before = fixture.heads;
      await expect(store.head(sha256Hex(bytes))).rejects.toBeInstanceOf(S3EvidenceError);
      expect(fixture.heads - before).toBe(3);
    });
  });
  it.each([false, true])("durable reopened objects and SQLite references recover unresolved writer; adopted=%s", async (adopted) => {
    await withFixture(async (fixture, store) => {
      const path = join(fixture.root, "cases.sqlite");
      const first = createSqliteRuntime(path);
      const cases = new CaseService(store, first.audit, first.cases, new CatalogService(first.catalog, first.audit));
      const actor = { id: "synthetic:lead", username: "lead" };
      const investigation = await cases.createCase(actor, { title: "Synthetic restart recovery" }, "fixture");
      const stage = await store.stage(bytes); fixture.fault = "lost";
      await expect(stage.commit()).rejects.toMatchObject({ commitOutcomeUnknown: true });
      await stage.rollback(); stage.release();
      expect((await fixture.records()).filter((item) => item.key.includes("/.pending/"))).toHaveLength(1);
      expect((await fixture.records()).filter((item) => item.key.includes("/blobs/"))).toHaveLength(1);
      expect(fixture.deletes.some((key) => key.includes("/blobs/"))).toBe(false);
      if (adopted) await cases.addEvidence(investigation.id, actor, { kind: "log", summary: "Adopted durable bytes", bytes, mediaType: "text/plain", filename: "original.log" }, "fixture");
      first.state.close();
      const restartedFixture = new DurableS3ProtocolFixture(fixture.root);
      const restarted = assembled(restartedFixture);
      const second = createSqliteRuntime(path);
      try {
        restarted.addReferencedContentHashSource(() => second.cases.listReferencedContentHashes());
        const recovery = await restarted.recoverUnreferencedWrites();
        expect(recovery.journals).toBe(1);
        expect(await restarted.head(sha256Hex(bytes))).toEqual(adopted ? expect.objectContaining({ hash: sha256Hex(bytes) }) : null);
        expect((await restartedFixture.records()).filter((item) => item.key.includes("/.pending/"))).toHaveLength(0);
        expect(restartedFixture.copies).toBe(0);
      } finally { second.state.close(); }
    });
  });
});
