import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { inspect as inspectValue } from "node:util";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PROVIDER_INSTANCE_S3_KEY,
  S3EvidenceProviderInstanceManager,
} from "./provider-instance-s3.js";
import {
  EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
  EvidenceProviderInstanceStorageError,
  serializeEvidenceProviderInstance,
} from "./provider-instance.js";
import type { S3EvidenceClient } from "./s3-store.js";

const ID_A = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const ID_B = "267ad846-b2e0-4af0-8d87-4d788e48c155";
const BUCKET = "contextdesk-evidence";

type Call = { readonly name: string; readonly input: Record<string, unknown> };
type Stored = { body: Uint8Array; etag: string; versionId?: string; deleteMarker?: boolean };

class FakeS3Client implements S3EvidenceClient {
  readonly calls: Call[] = [];
  readonly objects = new Map<string, Stored>();
  nextPut: "before-error" | "after-error" | null = null;
  beforePut: (() => void) | null = null;
  nextHeadError: unknown = null;
  getBody: unknown = undefined;
  getEtag: string | undefined;
  afterGet: (() => void) | null = null;
  private generation = 0;

  async send(command: unknown): Promise<unknown> {
    const name = command instanceof HeadObjectCommand
      ? "HeadObjectCommand"
      : command instanceof GetObjectCommand
        ? "GetObjectCommand"
        : command instanceof PutObjectCommand
          ? "PutObjectCommand"
          : "UnknownCommand";
    const input = (command as { input?: Record<string, unknown> }).input ?? {};
    this.calls.push({ name, input: { ...input } });
    const key = `${String(input.Bucket)}/${String(input.Key)}`;
    if (command instanceof HeadObjectCommand) {
      if (this.nextHeadError !== null) {
        const error = this.nextHeadError;
        this.nextHeadError = null;
        throw error;
      }
      const stored = this.objects.get(key);
      if (!stored) throw s3Error("NotFound", 404);
      return {
        ContentLength: stored.body.byteLength,
        ETag: stored.etag,
        ...(stored.versionId === undefined ? {} : { VersionId: stored.versionId }),
        ...(stored.deleteMarker === undefined ? {} : { DeleteMarker: stored.deleteMarker }),
      };
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(key);
      if (!stored) throw s3Error("NoSuchKey", 404);
      if (input.IfMatch !== stored.etag) throw s3Error("PreconditionFailed", 412);
      if (input.VersionId !== undefined && input.VersionId !== stored.versionId) {
        throw s3Error("NoSuchVersion", 404);
      }
      const response = {
        Body: this.getBody ?? chunked(stored.body),
        ContentLength: stored.body.byteLength,
        ETag: this.getEtag ?? stored.etag,
        ...(stored.versionId === undefined ? {} : { VersionId: stored.versionId }),
        ...(stored.deleteMarker === undefined ? {} : { DeleteMarker: stored.deleteMarker }),
      };
      const afterGet = this.afterGet;
      this.afterGet = null;
      afterGet?.();
      return response;
    }
    if (command instanceof PutObjectCommand) {
      const beforePut = this.beforePut;
      this.beforePut = null;
      beforePut?.();
      if (this.nextPut === "before-error") {
        this.nextPut = null;
        throw s3Error("InternalError", 500);
      }
      if (input.IfNoneMatch !== "*") throw s3Error("InvalidRequest", 400);
      if (this.objects.has(key)) throw s3Error("PreconditionFailed", 412);
      const body = input.Body;
      if (!(body instanceof Uint8Array)) throw s3Error("InvalidRequest", 400);
      if (input.ContentLength !== body.byteLength) throw s3Error("IncompleteBody", 400);
      this.generation += 1;
      this.objects.set(key, {
        body: new Uint8Array(body),
        etag: `"etag-${this.generation}"`,
        versionId: `v${this.generation}`,
      });
      if (this.nextPut === "after-error") {
        this.nextPut = null;
        throw s3Error("InternalError", 500);
      }
      return { ETag: `"etag-${this.generation}"`, VersionId: `v${this.generation}` };
    }
    throw new Error("unexpected command");
  }

  put(key: string, body: Uint8Array, overrides: Partial<Stored> = {}): void {
    this.generation += 1;
    this.objects.set(`${BUCKET}/${key}`, {
      body: new Uint8Array(body),
      etag: `"etag-${this.generation}"`,
      versionId: `v${this.generation}`,
      ...overrides,
    });
  }
}

function manager(
  fake: FakeS3Client,
  extra: { prefix?: string; randomProviderInstanceId?: () => string } = {},
) {
  return new S3EvidenceProviderInstanceManager({
    client: fake,
    bucket: BUCKET,
    ...extra,
  });
}

function manifestBytes(id = ID_A, providerKind: "filesystem" | "s3" = "s3") {
  return serializeEvidenceProviderInstance({
    schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
    providerInstanceId: id,
    providerKind,
  });
}

function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(
    new Error(`private bucket=${BUCKET} key=${EVIDENCE_PROVIDER_INSTANCE_S3_KEY} id=${ID_A}`),
    { name, $metadata: { httpStatusCode } },
  );
}

async function expectStorageCode(
  promise: Promise<unknown>,
  code: EvidenceProviderInstanceStorageError["code"],
): Promise<void> {
  return promise.then(
    () => {
      throw new Error("expected storage failure");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(EvidenceProviderInstanceStorageError);
      expect((error as EvidenceProviderInstanceStorageError).code).toBe(code);
      expect(
        [String(error), (error as Error).stack, JSON.stringify(error), inspectValue(error)]
          .join("\n"),
      ).not.toMatch(/contextdesk-evidence|provider-instance\.v1|8d2f|267a/u);
    },
  );
}

function chunked(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const split = Math.max(1, Math.floor(bytes.byteLength / 2));
      yield bytes.slice(0, split);
      if (split < bytes.byteLength) yield bytes.slice(split);
    },
  };
}

describe("S3EvidenceProviderInstanceManager", () => {
  it("keeps a missing inspection read-only and distinguishes denial from absence", async () => {
    const fake = new FakeS3Client();
    expect(await manager(fake).inspect()).toBeNull();
    expect(fake.calls.map((call) => call.name)).toEqual(["HeadObjectCommand"]);
    fake.nextHeadError = s3Error("AccessDenied", 403);
    await expectStorageCode(manager(fake).inspect(), "unavailable");
    expect(fake.calls.every((call) => call.name !== "PutObjectCommand")).toBe(true);
  });

  it("recognizes portable Code-only errors and rejects exposed delete markers", async () => {
    const codeOnly = new FakeS3Client();
    codeOnly.nextHeadError = Object.assign(new Error("missing"), {
      name: "Error",
      Code: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    expect(await manager(codeOnly).inspect()).toBeNull();

    const deleted = new FakeS3Client();
    deleted.nextHeadError = Object.assign(new Error("deleted"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
      $response: { headers: { "x-amz-delete-marker": "true" } },
    });
    await expectStorageCode(manager(deleted).inspect(), "invalid");
  });

  it("writes one canonical conditional object and returns it after restart", async () => {
    const fake = new FakeS3Client();
    const created = await manager(fake).initialize(ID_A);
    expect(created.outcome).toBe("created");
    expect(created.manifest).toEqual({
      schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
      providerInstanceId: ID_A,
      providerKind: "s3",
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.manifest)).toBe(true);
    const put = fake.calls.find((call) => call.name === "PutObjectCommand");
    expect(put?.input).toMatchObject({
      Bucket: BUCKET,
      Key: EVIDENCE_PROVIDER_INSTANCE_S3_KEY,
      IfNoneMatch: "*",
      ContentType: "application/json",
      ContentLength: manifestBytes().byteLength,
    });
    expect(put?.input.Body).toEqual(manifestBytes());
    expect((await manager(fake).initialize(ID_A)).outcome).toBe("existing");
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(1);
  });

  it("normalizes an empty or segmented prefix to the exact reserved key", async () => {
    const empty = new FakeS3Client();
    await manager(empty, { prefix: "" }).initialize(ID_A);
    expect(empty.calls.find((call) => call.name === "PutObjectCommand")?.input.Key)
      .toBe(EVIDENCE_PROVIDER_INSTANCE_S3_KEY);

    const prefixed = new FakeS3Client();
    await manager(prefixed, { prefix: "cases/prod/" }).initialize(ID_A);
    expect(prefixed.calls.find((call) => call.name === "PutObjectCommand")?.input.Key)
      .toBe(`cases/prod/${EVIDENCE_PROVIDER_INSTANCE_S3_KEY}`);
  });

  it("converges twenty independent concurrent initializers without overwrite", async () => {
    const fake = new FakeS3Client();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => manager(fake).initialize()),
    );
    expect(new Set(results.map((result) => result.manifest.providerInstanceId)).size).toBe(1);
    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(20);
    expect(fake.objects.size).toBe(1);
  });

  it("never overwrites an existing identity and fails a mismatched pin", async () => {
    const fake = new FakeS3Client();
    await manager(fake).initialize(ID_A);
    const before = fake.objects.values().next().value as Stored;
    await expectStorageCode(manager(fake).inspect(ID_B), "identity_mismatch");
    await expectStorageCode(manager(fake).initialize(ID_B), "identity_mismatch");
    expect(fake.objects.values().next().value).toEqual(before);
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(1);
  });

  it("rejects malformed, wrong-provider, oversized, and delete-marker objects", async () => {
    for (const stored of [
      { body: new TextEncoder().encode("not-json") },
      { body: manifestBytes(ID_A, "filesystem") },
      { body: new Uint8Array(513) },
      { body: manifestBytes(), deleteMarker: true },
    ]) {
      const fake = new FakeS3Client();
      fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, stored.body, stored);
      await expectStorageCode(manager(fake).inspect(), "invalid");
    }
  });

  it("rejects truncated, overflowing, and non-byte response bodies", async () => {
    for (const body of [
      chunked(manifestBytes().slice(0, -1)),
      chunked(new Uint8Array([...manifestBytes(), 0x20])),
      { async *[Symbol.asyncIterator]() { yield "not-bytes"; } },
    ]) {
      const fake = new FakeS3Client();
      fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes());
      fake.getBody = body;
      await expectStorageCode(manager(fake).inspect(), "invalid");
    }
  });

  it("bounds a stalled body read and releases the iterator", async () => {
    const fake = new FakeS3Client();
    fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes());
    let released = 0;
    fake.getBody = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            released += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await expectStorageCode(
      new S3EvidenceProviderInstanceManager({
        client: fake,
        bucket: BUCKET,
        responseBodyIdleTimeoutMs: 5,
      }).inspect(),
      "unavailable",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(released).toBe(1);
  });

  it("rejects a generation change after the bounded read", async () => {
    const fake = new FakeS3Client();
    fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes());
    fake.afterGet = () => fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes());
    await expectStorageCode(manager(fake).inspect(), "unavailable");
  });

  it("binds GET to the first HEAD generation and rejects mismatched GET metadata", async () => {
    const fake = new FakeS3Client();
    fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes());
    fake.getEtag = "\"unexpected-etag\"";
    await expectStorageCode(manager(fake).inspect(), "unavailable");
    expect(fake.calls.map((call) => call.name)).toEqual([
      "HeadObjectCommand",
      "GetObjectCommand",
    ]);
    expect(fake.calls[1]?.input).toMatchObject({
      IfMatch: "\"etag-1\"",
      VersionId: "v1",
    });
  });

  it("reports clean PUT success with failed readback as unknown", async () => {
    const fake = new FakeS3Client();
    let heads = 0;
    const original = fake.send.bind(fake);
    fake.send = async (command) => {
      if (command instanceof HeadObjectCommand) {
        heads += 1;
        if (heads === 2) throw s3Error("ServiceUnavailable", 503);
      }
      return original(command);
    };
    await expectStorageCode(manager(fake).initialize(ID_A), "initialization_outcome_unknown");
    expect(await manager(fake).inspect(ID_A)).toMatchObject({ providerInstanceId: ID_A });
  });

  it("accepts a conditional winner without retrying or overwriting", async () => {
    const fake = new FakeS3Client();
    fake.beforePut = () => fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes(ID_B));
    const result = await manager(fake).initialize();
    expect(result.outcome).toBe("existing");
    expect(result.manifest.providerInstanceId).toBe(ID_B);
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(1);
  });

  it("treats a same-pinned conditional winner as existing, not reconciled", async () => {
    const fake = new FakeS3Client();
    fake.beforePut = () => fake.put(EVIDENCE_PROVIDER_INSTANCE_S3_KEY, manifestBytes(ID_A));
    const result = await manager(fake).initialize(ID_A);
    expect(result.outcome).toBe("existing");
    expect(result.manifest.providerInstanceId).toBe(ID_A);
  });

  it("reconciles an applied PUT whose response was lost without replay", async () => {
    const fake = new FakeS3Client();
    fake.nextPut = "after-error";
    const result = await manager(fake).initialize(ID_A);
    expect(result.outcome).toBe("reconciled");
    expect(result.manifest.providerInstanceId).toBe(ID_A);
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(1);
  });

  it("reports an ambiguous absent PUT as unknown without replay", async () => {
    const fake = new FakeS3Client();
    fake.nextPut = "before-error";
    await expectStorageCode(manager(fake).initialize(ID_A), "initialization_outcome_unknown");
    expect(fake.calls.filter((call) => call.name === "PutObjectCommand")).toHaveLength(1);
    expect(fake.objects.size).toBe(0);
  });

  it("mints once, skips entropy on restart, and sanitizes provider failures", async () => {
    const fake = new FakeS3Client();
    let calls = 0;
    const instance = manager(fake, {
      randomProviderInstanceId: () => {
        calls += 1;
        return ID_A;
      },
    });
    await instance.initialize();
    await instance.initialize();
    expect(calls).toBe(1);
    fake.nextHeadError = s3Error("InternalError", 500);
    await expectStorageCode(instance.inspect(), "unavailable");
  });
});
