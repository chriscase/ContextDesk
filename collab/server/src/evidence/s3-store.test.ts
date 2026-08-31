import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { FILE_SERVER_REF_SCHEMA_ID, parseFileServerReference } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  abandonS3WriteBatchForCrashTest,
  createS3ClientConfig,
  S3EvidenceError,
  S3EvidenceStore,
} from "./s3-store.js";
import { EVIDENCE_PENDING_WRITE_SCHEMA_ID, sha256Hex } from "./store.js";

const SYNTHETIC_ACCESS = "gk-synthetic-access";
const SYNTHETIC_SECRET = "synthetic-secret-value";
const SYNTHETIC_ENDPOINT = "http://garage.test:3900";
const SYNTHETIC_BUCKET = "cd-evidence";
const SYNTHETIC_URI = "https://files.example.test/incident/app.log";
const ACL_FIELDS = [
  "ACL",
  "GrantFullControl",
  "GrantRead",
  "GrantReadACP",
  "GrantWriteACP",
  "AccessControlPolicy",
] as const;
const CHECKSUM_FIELDS = [
  "ChecksumAlgorithm",
  "ChecksumCRC32",
  "ChecksumCRC32C",
  "ChecksumSHA1",
  "ChecksumSHA256",
  "ChecksumCRC64NVME",
  "ContentMD5",
] as const;

class FakeS3Error extends Error {
  readonly Code: string;
  readonly $metadata: { httpStatusCode: number };

  constructor(name: string, status: number, message: string) {
    super(message);
    this.name = name;
    this.Code = name;
    this.$metadata = { httpStatusCode: status };
  }
}

interface FakeObject {
  body: Uint8Array;
  metadata: Record<string, string>;
  contentType: string | undefined;
  reportedLength?: number;
}

class FakeS3Client {
  readonly objects = new Map<string, FakeObject>();
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  bucketExists = true;
  nextError: Error | null = null;
  listPageSize = 1000;
  onSend: (() => void) | null = null;

  constructor(private readonly bucket: string) {}

  async send(command: unknown): Promise<unknown> {
    this.onSend?.();
    const name = commandName(command);
    const input = commandInput(command);
    this.calls.push({ name, input: { ...input } });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    if (command instanceof HeadBucketCommand) {
      if (!this.bucketExists || input.Bucket !== this.bucket) {
        throw new FakeS3Error("NotFound", 404, `NotFound bucket=${String(input.Bucket)}`);
      }
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const key = objectKey(input);
      const body = readInputBody(input.Body);
      this.objects.set(key, {
        body,
        metadata: lowercaseRecord(input.Metadata),
        contentType: typeof input.ContentType === "string" ? input.ContentType : undefined,
      });
      return { ETag: `"not-the-digest"` };
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.requireObject(input, "NoSuchKey");
      return {
        Body: { transformToByteArray: async () => new Uint8Array(stored.body) },
        ContentLength: stored.reportedLength ?? stored.body.byteLength,
        ContentType: stored.contentType,
        Metadata: { ...stored.metadata },
        ETag: `"not-the-digest"`,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const stored = this.requireObject(input, "NotFound");
      return {
        ContentLength: stored.reportedLength ?? stored.body.byteLength,
        ContentType: stored.contentType,
        Metadata: { ...stored.metadata },
        ETag: `"not-the-digest"`,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(objectKey(input));
      return {};
    }
    if (command instanceof CopyObjectCommand) {
      const source = parseCopySource(input.CopySource);
      const sourceKey = `${source.bucket}/${source.key}`;
      const stored = this.objects.get(sourceKey);
      if (!stored) {
        throw new FakeS3Error(
          "NoSuchKey",
          404,
          `NoSuchKey bucket=${source.bucket} key=${source.key}`,
        );
      }
      this.objects.set(objectKey(input), {
        body: new Uint8Array(stored.body),
        metadata: { ...stored.metadata },
        contentType: stored.contentType,
      });
      return { CopyObjectResult: { ETag: `"not-the-digest"` } };
    }
    if (command instanceof ListObjectsV2Command) {
      if (input.Bucket !== this.bucket) {
        throw new FakeS3Error("NoSuchBucket", 404, `NoSuchBucket bucket=${String(input.Bucket)}`);
      }
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      const all = [...this.objects.keys()]
        .filter((full) => full.startsWith(`${this.bucket}/`))
        .map((full) => full.slice(this.bucket.length + 1))
        .filter((key) => key.startsWith(prefix))
        .sort();
      const token = typeof input.ContinuationToken === "string" ? input.ContinuationToken : "";
      const from = token === "" ? 0 : all.findIndex((key) => key > token);
      const start = from < 0 ? all.length : from;
      const page = all.slice(start, start + this.listPageSize);
      const truncated = start + page.length < all.length;
      const last = page[page.length - 1];
      return {
        Contents: page.map((Key) => ({ Key, ETag: `"not-the-digest"` })),
        IsTruncated: truncated,
        ...(truncated && last !== undefined ? { NextContinuationToken: last } : {}),
      };
    }
    throw new FakeS3Error("NotImplemented", 400, `unsupported ${name}`);
  }

  object(key: string): FakeObject | undefined {
    return this.objects.get(`${this.bucket}/${key}`);
  }

  keys(): string[] {
    return [...this.objects.keys()]
      .filter((full) => full.startsWith(`${this.bucket}/`))
      .map((full) => full.slice(this.bucket.length + 1))
      .sort();
  }

  putRaw(
    key: string,
    body: Uint8Array,
    metadata: Record<string, string> = {},
    reportedLength?: number,
  ): void {
    const stored: FakeObject = {
      body: new Uint8Array(body),
      metadata: lowercaseRecord(metadata),
      contentType: undefined,
    };
    if (reportedLength !== undefined) stored.reportedLength = reportedLength;
    this.objects.set(`${this.bucket}/${key}`, stored);
  }

  private requireObject(input: Record<string, unknown>, missingName: "NoSuchKey" | "NotFound"): FakeObject {
    const key = objectKey(input);
    const stored = this.objects.get(key);
    if (!stored) {
      throw new FakeS3Error(
        missingName,
        404,
        `${missingName} at ${SYNTHETIC_ENDPOINT} bucket=${String(input.Bucket)} key=${String(input.Key)} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI}`,
      );
    }
    return stored;
  }
}

function commandName(command: unknown): string {
  if (typeof command === "object" && command !== null) {
    const name = (command as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === "string" && name !== "") return name;
  }
  return "UnknownCommand";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (typeof command === "object" && command !== null && "input" in command) {
    const input = (command as { input?: unknown }).input;
    if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  }
  return {};
}

function objectKey(input: Record<string, unknown>): string {
  return `${String(input.Bucket)}/${String(input.Key)}`;
}

function parseCopySource(value: unknown): { bucket: string; key: string } {
  const raw = String(value ?? "").replace(/^\//, "");
  const slash = raw.indexOf("/");
  if (slash < 0) return { bucket: decodeURIComponent(raw), key: "" };
  return {
    bucket: decodeURIComponent(raw.slice(0, slash)),
    key: raw
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/"),
  };
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function readInputBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  throw new Error("fake S3 expected Uint8Array body");
}

function lowercaseRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key.toLowerCase()] = entry;
  }
  return out;
}

function garageOptions(
  client: FakeS3Client,
  extra?: { prefix?: string; acquireWriteLease?: () => Promise<() => void | Promise<void>> },
) {
  return {
    bucket: SYNTHETIC_BUCKET,
    region: "garage",
    endpoint: SYNTHETIC_ENDPOINT,
    forcePathStyle: true as const,
    accessKeyId: SYNTHETIC_ACCESS,
    secretAccessKey: SYNTHETIC_SECRET,
    client,
    ...(extra?.prefix === undefined ? {} : { prefix: extra.prefix }),
    ...(extra?.acquireWriteLease ? { acquireWriteLease: extra.acquireWriteLease } : {}),
  };
}

function openStore(
  prefix?: string,
  extra?: { acquireWriteLease?: () => Promise<() => void | Promise<void>> },
): { fake: FakeS3Client; store: S3EvidenceStore } {
  const fake = new FakeS3Client(SYNTHETIC_BUCKET);
  return { fake, store: new S3EvidenceStore(garageOptions(fake, { prefix, ...extra })) };
}

function blobKey(hash: string, prefix?: string): string {
  const relative = `blobs/${hash.slice(0, 2)}/${hash}`;
  return prefix ? `${prefix}/${relative}` : relative;
}

function pendingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const root = prefix ? `${prefix}/.pending/` : ".pending/";
  return fake.keys().filter((key) => key.startsWith(root) && !key.slice(root.length).includes("/"));
}

function stagingKeys(fake: FakeS3Client, prefix?: string): string[] {
  const batchRoot = prefix ? `${prefix}/.staging/` : ".staging/";
  const directRoot = prefix ? `${prefix}/staging/` : "staging/";
  return fake.keys().filter((key) => key.startsWith(batchRoot) || key.startsWith(directRoot));
}

function assertNoAclOrChecksums(fake: FakeS3Client): void {
  for (const call of fake.calls) {
    for (const field of ACL_FIELDS) {
      expect(call.input[field], `${call.name}.${field}`).toBeUndefined();
    }
    for (const field of CHECKSUM_FIELDS) {
      expect(call.input[field], `${call.name}.${field}`).toBeUndefined();
    }
    expect(call.input.Tagging).toBeUndefined();
  }
}

function assertSanitized(error: unknown, extra: string[] = []): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(SYNTHETIC_ENDPOINT);
  expect(message).not.toContain(SYNTHETIC_BUCKET);
  expect(message).not.toContain(SYNTHETIC_ACCESS);
  expect(message).not.toContain(SYNTHETIC_SECRET);
  expect(message).not.toContain(SYNTHETIC_URI);
  expect(message).not.toContain("blobs/");
  expect(message).not.toContain("http://");
  expect(message).not.toContain("https://");
  for (const value of extra) expect(message).not.toContain(value);
}

function leaseTracker(): {
  acquireWriteLease: () => Promise<() => void | Promise<void>>;
  active: () => number;
  acquires: () => number;
  releases: () => number;
  maxActive: () => number;
} {
  let active = 0;
  let acquires = 0;
  let releases = 0;
  let maxActive = 0;
  return {
    acquireWriteLease: async () => {
      acquires += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return async () => {
        releases += 1;
        active -= 1;
      };
    },
    active: () => active,
    acquires: () => acquires,
    releases: () => releases,
    maxActive: () => maxActive,
  };
}

describe("S3EvidenceStore", () => {
  it("builds an explicit Garage-compatible client config without the default chain or ACLs", () => {
    const config = createS3ClientConfig({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      prefix: "/cases/prod/",
      endpoint: `${SYNTHETIC_ENDPOINT}/`,
      forcePathStyle: true,
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
      sessionToken: "synthetic-session",
    });
    expect(config.region).toBe("garage");
    expect(config.endpoint).toBe(SYNTHETIC_ENDPOINT);
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toEqual({
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
      sessionToken: "synthetic-session",
    });
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
    expect(config.disableS3ExpressSessionAuth).toBe(true);
    expect(config.credentialDefaultProvider).toBeUndefined();
    expect(config.profile).toBeUndefined();
    expect(config).not.toHaveProperty("ACL");
  });

  it("omits credentials so the SDK default provider chain can run", () => {
    const config = createS3ClientConfig({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      endpoint: SYNTHETIC_ENDPOINT,
      forcePathStyle: true,
    });
    expect(config.credentials).toBeUndefined();
    expect(config.credentialDefaultProvider).toBeUndefined();
    expect(config.profile).toBeUndefined();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const store = new S3EvidenceStore({
      bucket: SYNTHETIC_BUCKET,
      region: "garage",
      client: fake,
    });
    expect(store.writeCoordination).toBe("single_process");
  });

  it("rejects empty or invalid configuration without leaking values", () => {
    const secrets = {
      region: "garage",
      endpoint: SYNTHETIC_ENDPOINT,
      accessKeyId: SYNTHETIC_ACCESS,
      secretAccessKey: SYNTHETIC_SECRET,
    };
    const attempts: Array<() => unknown> = [
      () => createS3ClientConfig({ ...secrets, bucket: "  " }),
      () => createS3ClientConfig({ ...secrets, bucket: SYNTHETIC_BUCKET, region: "" }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          accessKeyId: "",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          secretAccessKey: "   ",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          prefix: "../secret",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://user:pass@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://user@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: "http://:pass@garage.test:3900",
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: `${SYNTHETIC_ENDPOINT}/?x=1`,
        }),
      () =>
        createS3ClientConfig({
          ...secrets,
          bucket: SYNTHETIC_BUCKET,
          endpoint: `${SYNTHETIC_ENDPOINT}/#frag`,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          accessKeyId: SYNTHETIC_ACCESS,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          secretAccessKey: SYNTHETIC_SECRET,
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          sessionToken: "synthetic-session",
        }),
      () =>
        createS3ClientConfig({
          bucket: SYNTHETIC_BUCKET,
          region: "garage",
          accessKeyId: SYNTHETIC_ACCESS,
          sessionToken: "synthetic-session",
        }),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(S3EvidenceError);
      try {
        attempt();
      } catch (error) {
        assertSanitized(error, ["user:pass", "../secret", "synthetic-session", "?x=1", "#frag"]);
      }
    }
  });

  it("round-trips bytes at the exact sharded prefix key and ignores ETag", async () => {
    const { fake, store } = openStore("cases/prod");
    const bytes = new TextEncoder().encode("synthetic-log-line\n");
    const meta = await store.put(bytes, { contentType: "text/plain" });
    expect(meta.hash).toBe(sha256Hex(bytes));
    expect(meta.byteLength).toBe(bytes.byteLength);
    expect(meta.contentType).toBe("text/plain");
    expect(fake.object(blobKey(meta.hash, "cases/prod"))).toBeDefined();
    const put = fake.calls.find((call) => call.name === "PutObjectCommand");
    expect(put?.input.Key).toBe(blobKey(meta.hash, "cases/prod"));
    expect(put?.input.Bucket).toBe(SYNTHETIC_BUCKET);
    const again = await store.put(bytes);
    expect(again.hash).toBe(meta.hash);
    expect(
      fake.calls.filter((call) => call.name === "PutObjectCommand" && call.input.Key === put?.input.Key),
    ).toHaveLength(1);
    const got = await store.get(meta.hash);
    expect(got).not.toBeNull();
    expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
    const head = await store.head(meta.hash);
    expect(head).toEqual({
      hash: meta.hash,
      byteLength: bytes.byteLength,
      contentType: "text/plain",
    });
    expect(await store.verify(meta.hash)).toBe(true);
    assertNoAclOrChecksums(fake);
  });

  it("does not overwrite a mutated canonical object and fails closed on bad metadata", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("original-bytes");
    const { hash } = await store.put(bytes);
    const stored = fake.object(blobKey(hash));
    expect(stored).toBeDefined();
    if (!stored) throw new Error("missing synthetic object");
    const mutated = new Uint8Array(bytes.byteLength);
    mutated.fill(0x41);
    stored.body = mutated;
    expect(await store.verify(hash)).toBe(false);
    const got = await store.get(hash);
    expect(got).not.toBeNull();
    expect(sha256Hex(got ?? new Uint8Array())).not.toBe(hash);
    await expect(store.put(bytes)).rejects.toThrow(/failed verification/);
    expect(Buffer.from(fake.object(blobKey(hash))?.body ?? []).equals(Buffer.from(mutated))).toBe(true);

    stored.body = bytes;
    stored.metadata.bytelength = "1";
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    stored.metadata.bytelength = String(bytes.byteLength);
    stored.metadata.sha256 = "0".repeat(64);
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    stored.metadata.sha256 = hash;
    stored.metadata.contenttype = "text/plain";
    stored.contentType = "application/octet-stream";
    await expect(store.head(hash)).rejects.toThrow(/inconsistent metadata/);
    expect(await store.verify(hash)).toBe(false);
    assertNoAclOrChecksums(fake);
  });

  it("translates true missing objects to null and rejects operational errors without leaking", async () => {
    const { fake, store } = openStore();
    const missing = sha256Hex(new TextEncoder().encode("absent"));
    expect(await store.get(missing)).toBeNull();
    expect(await store.head(missing)).toBeNull();
    expect(await store.verify(missing)).toBe(false);

    fake.nextError = new FakeS3Error(
      "SlowDown",
      503,
      `SlowDown at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET} key=blobs/ab/${missing} accessKey=${SYNTHETIC_ACCESS} secret=${SYNTHETIC_SECRET} URI=${SYNTHETIC_URI} response={"Code":"SlowDown"}`,
    );
    try {
      await store.get(missing);
      throw new Error("expected operational failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("get");
      assertSanitized(error);
      expect(String(error)).not.toContain(missing);
      expect(String(error)).not.toContain("SlowDown");
    }

    fake.nextError = new FakeS3Error(
      "NotFound",
      503,
      `operational NotFound at ${SYNTHETIC_ENDPOINT} bucket=${SYNTHETIC_BUCKET}`,
    );
    await expect(store.get(missing)).rejects.toBeInstanceOf(S3EvidenceError);

    await expect(store.get("../secret")).rejects.toThrow(/invalid content hash/);
    const before = fake.calls.length;
    await expect(store.head("ZZ")).rejects.toThrow(/invalid content hash/);
    expect(fake.calls).toHaveLength(before);
  });

  it("keeps staged bytes invisible, commits idempotently, and rolls back without touching deduped objects", async () => {
    const { fake, store } = openStore("inv");
    const bytes = new TextEncoder().encode("staged-synthetic-line\n");
    const stage = await store.stage(bytes, { contentType: "text/plain" });
    try {
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(fake.object(blobKey(stage.meta.hash, "inv"))).toBeUndefined();
      const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
      expect(String(staged?.input.Key)).toMatch(/^inv\/staging\/[0-9a-f-]{36}$/i);
      expect(String(staged?.input.Key)).not.toContain(stage.meta.hash);
      await stage.commit();
      await stage.commit();
      expect(await store.verify(stage.meta.hash)).toBe(true);
      const copy = fake.calls.find((call) => call.name === "CopyObjectCommand");
      expect(copy?.input.CopySource).toBe(
        encodeCopySource(SYNTHETIC_BUCKET, String(staged?.input.Key)),
      );
      await stage.rollback();
      expect(await store.head(stage.meta.hash)).toBeNull();
    } finally {
      stage.release();
      stage.release();
    }

    const shared = new TextEncoder().encode("shared-synthetic-line\n");
    const first = await store.put(shared, { contentType: "text/plain" });
    const later = await store.stage(shared, { contentType: "text/x-log" });
    try {
      await later.commit();
      await later.rollback();
    } finally {
      later.release();
    }
    expect(await store.verify(first.hash)).toBe(true);
    expect(await store.head(first.hash)).toEqual({
      hash: first.hash,
      byteLength: shared.byteLength,
      contentType: "text/plain",
    });
    assertNoAclOrChecksums(fake);
  });

  it("round-trips file-server references with the filesystem observable semantics", async () => {
    const { fake, store } = openStore("cases/prod");
    const expectedHash = sha256Hex(new TextEncoder().encode("remote"));
    const created = await store.putFileServerReference({
      uri: SYNTHETIC_URI,
      expectedHash,
      verificationStatus: "unverified",
    });
    const parsed = parseFileServerReference(created);
    expect(parsed.uri).toBe(SYNTHETIC_URI);
    expect(parsed.expectedHash).toBe(expectedHash);
    expect(parsed.verificationStatus).toBe("unverified");
    expect(fake.object(`cases/prod/refs/${created.id}.json`)).toBeDefined();
    expect(await store.getFileServerReference(created.id)).toEqual(created);
    const verified = await store.verifyFileServerReference(
      created.id,
      new TextEncoder().encode("remote"),
    );
    expect(verified.verificationStatus).toBe("verified");
    const mismatched = await store.verifyFileServerReference(
      created.id,
      new TextEncoder().encode("other"),
    );
    expect(mismatched.verificationStatus).toBe("unverified");

    await expect(
      store.putFileServerReference({
        uri: SYNTHETIC_URI,
        expectedHash: null,
        verificationStatus: "verified",
      }),
    ).rejects.toThrow(/expected hash/);
    await expect(
      store.putFileServerReference({
        uri: SYNTHETIC_URI,
        expectedHash: "not-a-hash",
      }),
    ).rejects.toThrow(/invalid content hash/);
    const neverHashed = await store.putFileServerReference({ uri: SYNTHETIC_URI });
    expect(neverHashed.expectedHash).toBeNull();
    expect(neverHashed.verificationStatus).toBe("unverified");
    const afterBytes = await store.verifyFileServerReference(
      neverHashed.id,
      new TextEncoder().encode("whatever"),
    );
    expect(afterBytes.verificationStatus).toBe("unverified");
    const unreachable = await store.verifyFileServerReference(neverHashed.id);
    expect(unreachable.verificationStatus).toBe("unreachable");

    await store.abandonFileServerReference(created.id);
    expect(await store.getFileServerReference(created.id)).toBeNull();
    const snapshot = { ...neverHashed, verificationStatus: "unreachable" as const };
    await store.restoreFileServerReference(snapshot);
    expect(await store.getFileServerReference(neverHashed.id)).toEqual(snapshot);
    await expect(store.abandonFileServerReference("../secret")).rejects.toThrow(
      /invalid file-server reference id/,
    );
    await expect(store.restoreFileServerReference({ ...snapshot, id: "../secret" })).rejects.toThrow(
      /invalid file-server reference id/,
    );
    expect(fake.calls.some((call) => String(call.input.Key) === SYNTHETIC_URI)).toBe(false);
    assertNoAclOrChecksums(fake);
  });

  it("rejects malformed, tampered, and unsafe file-server reference JSON", async () => {
    const { fake, store } = openStore();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fake.putRaw(`refs/${id}.json`, new TextEncoder().encode("{"));
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: "not-the-schema",
          id,
          uri: SYNTHETIC_URI,
          expectedHash: null,
          verificationStatus: "unverified",
        }),
      ),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: FILE_SERVER_REF_SCHEMA_ID,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          uri: SYNTHETIC_URI,
          expectedHash: null,
          verificationStatus: "unverified",
        }),
      ),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
    fake.putRaw(
      `refs/${id}.json`,
      new TextEncoder().encode(`{"schemaId":"${FILE_SERVER_REF_SCHEMA_ID}","__proto__":{"x":1}}`),
    );
    await expect(store.getFileServerReference(id)).rejects.toThrow(/malformed file-server reference/);
  });

  it("pings with HeadBucket and does not write a public object", async () => {
    const { fake, store } = openStore();
    await store.ping();
    expect(fake.calls.map((call) => call.name)).toEqual(["HeadBucketCommand"]);
    expect(fake.calls[0]?.input).toEqual({ Bucket: SYNTHETIC_BUCKET });
    expect(fake.objects.size).toBe(0);
    fake.bucketExists = false;
    try {
      await store.ping();
      throw new Error("expected ping failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("ping");
      assertSanitized(error);
    }
  });

  it("uses single_process coordination unless an external lease is supplied", () => {
    const { store } = openStore();
    expect(store.writeCoordination).toBe("single_process");
    expect(typeof store.beginWriteBatch).toBe("function");
    expect(typeof store.addReferencedContentHashSource).toBe("function");
    expect(typeof store.recoverUnreferencedWrites).toBe("function");
    const leased = new S3EvidenceStore({
      ...garageOptions(new FakeS3Client(SYNTHETIC_BUCKET)),
      acquireWriteLease: async () => () => undefined,
    });
    expect(leased.writeCoordination).toBe("external");
  });

  it("sanitizes a raw not-found from copy and never leaks keys", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("copy-missing-source\n");
    const stage = await store.stage(bytes);
    try {
      const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
      fake.objects.delete(`${SYNTHETIC_BUCKET}/${String(staged?.input.Key)}`);
      try {
        await stage.commit();
        throw new Error("expected copy failure");
      } catch (error) {
        expect(error).toBeInstanceOf(S3EvidenceError);
        expect((error as S3EvidenceError).operation).toBe("commit");
        assertSanitized(error, [stage.meta.hash, String(staged?.input.Key)]);
        expect(error).not.toBeInstanceOf(FakeS3Error);
      }
    } finally {
      stage.release();
    }
  });

  it("fails closed when downloaded bytes disagree with ContentLength", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("length-mismatch");
    const { hash } = await store.put(bytes);
    const stored = fake.object(blobKey(hash));
    expect(stored).toBeDefined();
    if (!stored) throw new Error("missing synthetic object");
    stored.reportedLength = bytes.byteLength + 1;
    try {
      await store.get(hash);
      throw new Error("expected length mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expect((error as S3EvidenceError).operation).toBe("get");
      assertSanitized(error, [hash]);
    }
    expect(await store.verify(hash)).toBe(false);
  });

  it("fails a batch put against a corrupt canonical object", async () => {
    const { fake, store } = openStore();
    const bytes = new TextEncoder().encode("corrupt-before-batch\n");
    const { hash } = await store.put(bytes);
    const canonical = fake.object(blobKey(hash));
    if (!canonical) throw new Error("missing synthetic canonical object");
    canonical.body = new Uint8Array(bytes.byteLength).fill(0x58);
    const batch = await store.beginWriteBatch();
    try {
      await expect(batch.put(bytes)).rejects.toThrow(/failed verification/);
      expect(stagingKeys(fake)).toEqual([]);
    } finally {
      await batch.rollback();
    }
  });

  it("keeps batch staging invisible, journals before copy, and finalizes canonical bytes", async () => {
    const { fake, store } = openStore("cases/prod");
    const bytes = new TextEncoder().encode("batch-visible-only-after-promote\n");
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(bytes, { contentType: "text/plain" });
    expect(await store.head(meta.hash)).toBeNull();
    expect(await batch.verify(meta.hash)).toBe(true);
    expect(fake.object(blobKey(meta.hash, "cases/prod"))).toBeUndefined();
    const staged = fake.calls.find((call) => call.name === "PutObjectCommand");
    expect(String(staged?.input.Key)).toMatch(/^cases\/prod\/\.staging\/[0-9a-f-]+\/[0-9a-f-]+$/i);
    expect(String(staged?.input.Key)).not.toContain(meta.hash);
    fake.calls.length = 0;
    await batch.promote();
    const names = fake.calls.map((call) => call.name);
    const journalPut = fake.calls.findIndex(
      (call) => call.name === "PutObjectCommand" && String(call.input.Key).includes("/.pending/"),
    );
    const copy = fake.calls.findIndex((call) => call.name === "CopyObjectCommand");
    expect(journalPut).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(journalPut);
    expect(names.slice(0, copy + 1).filter((name) => name === "CopyObjectCommand")).toHaveLength(1);
    const copyCall = fake.calls[copy];
    expect(copyCall?.input.CopySource).toBe(
      encodeCopySource(SYNTHETIC_BUCKET, String(staged?.input.Key)),
    );
    expect(await store.verify(meta.hash)).toBe(true);
    const canonical = fake.object(blobKey(meta.hash, "cases/prod"));
    if (!canonical) throw new Error("missing promoted synthetic object");
    canonical.metadata.bytelength = "1";
    expect(await batch.verify(meta.hash)).toBe(false);
    await expect(batch.head(meta.hash)).rejects.toThrow(/inconsistent metadata/);
    canonical.metadata.bytelength = String(bytes.byteLength);
    expect(pendingKeys(fake, "cases/prod")).toHaveLength(1);
    await batch.finalize();
    expect(await store.verify(meta.hash)).toBe(true);
    expect(pendingKeys(fake, "cases/prod")).toEqual([]);
    expect(stagingKeys(fake, "cases/prod")).toEqual([]);
    assertNoAclOrChecksums(fake);
  });

  it("rolls back only objects this batch created", async () => {
    const { fake, store } = openStore();
    const keptBytes = new TextEncoder().encode("pre-existing-canonical\n");
    const kept = await store.put(keptBytes);
    const createdBytes = new TextEncoder().encode("batch-created-canonical\n");
    const batch = await store.beginWriteBatch();
    const again = await batch.put(keptBytes);
    expect(again.hash).toBe(kept.hash);
    const created = await batch.put(createdBytes);
    await batch.promote();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.verify(created.hash)).toBe(true);
    await batch.rollback();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(await store.head(created.hash)).toBeNull();
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
    assertNoAclOrChecksums(fake);
  });

  it("reclaims unreferenced crash residue and keeps referenced hashes", async () => {
    const { fake, store } = openStore();
    const kept = await store.put(new TextEncoder().encode("kept-after-crash\n"));
    const batch = await store.beginWriteBatch();
    const crashed = await batch.put(new TextEncoder().encode("crashed-unreferenced\n"));
    await batch.promote();
    expect(pendingKeys(fake)).toHaveLength(1);
    expect(await store.verify(crashed.hash)).toBe(true);
    await abandonS3WriteBatchForCrashTest(batch);
    const recovered = await store.recoverUnreferencedWrites(new Set([kept.hash]));
    expect(recovered.journals).toBe(1);
    expect(recovered.reclaimed).toEqual([crashed.hash]);
    expect(await store.head(crashed.hash)).toBeNull();
    expect(await store.verify(kept.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
  });

  it("cleans an interrupted ad-hoc stage after a simulated process restart", async () => {
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const original = new S3EvidenceStore(garageOptions(fake));
    const interrupted = await original.stage(
      new TextEncoder().encode("interrupted-direct-stage\n"),
    );
    expect(stagingKeys(fake)).toHaveLength(1);
    const restarted = new S3EvidenceStore(garageOptions(fake));
    const recovered = await restarted.recoverUnreferencedWrites(new Set());
    expect(recovered).toEqual({ reclaimed: [], journals: 0 });
    expect(stagingKeys(fake)).toEqual([]);
    interrupted.release();
  });

  it("drops a retained journal once a later durable reference exists", async () => {
    const { fake, store } = openStore();
    const batch = await store.beginWriteBatch();
    const meta = await batch.put(new TextEncoder().encode("committed-then-referenced\n"));
    await batch.promote();
    await batch.finalize({ retainPendingJournal: true });
    expect(pendingKeys(fake)).toHaveLength(1);
    expect(await store.verify(meta.hash)).toBe(true);
    const recovered = await store.recoverUnreferencedWrites(new Set([meta.hash]));
    expect(recovered.reclaimed).toEqual([]);
    expect(await store.verify(meta.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
  });

  it("pages ListObjectsV2 for pending journals and staging residue", async () => {
    const { fake, store } = openStore();
    fake.listPageSize = 2;
    const live = await store.put(new TextEncoder().encode("live-paginated\n"));
    const orphans: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const bytes = new TextEncoder().encode(`orphan-paginated-${index}\n`);
      const hash = sha256Hex(bytes);
      orphans.push(hash);
      fake.putRaw(
        blobKey(hash),
        bytes,
        {
          sha256: hash,
          bytelength: String(bytes.byteLength),
          contenttype: "",
        },
      );
      fake.putRaw(
        `.pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}.json`,
        new TextEncoder().encode(
          JSON.stringify({
            schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
            id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
            hashes: [hash],
          }),
        ),
      );
      fake.putRaw(`.staging/${index}/${index}`, bytes);
    }
    const recovered = await store.recoverUnreferencedWrites(new Set([live.hash]));
    expect(recovered.journals).toBe(5);
    expect(recovered.reclaimed.sort()).toEqual([...orphans].sort());
    const lists = fake.calls.filter((call) => call.name === "ListObjectsV2Command");
    expect(lists.length).toBeGreaterThan(2);
    expect(lists.some((call) => typeof call.input.ContinuationToken === "string")).toBe(true);
    expect(pendingKeys(fake)).toEqual([]);
    expect(stagingKeys(fake)).toEqual([]);
    expect(await store.verify(live.hash)).toBe(true);
  });

  it("ignores path-crafted journal hashes and malformed journals without deleting live blobs", async () => {
    const { fake, store } = openStore();
    const live = await store.put(new TextEncoder().encode("live-blob\n"));
    const orphan = await store.put(new TextEncoder().encode("orphan-blob\n"));
    fake.putRaw(
      ".pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json",
      new TextEncoder().encode(
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          hashes: ["../secret", orphan.hash],
        }),
      ),
    );
    fake.putRaw(
      ".pending/not-a-uuid.json",
      new TextEncoder().encode(JSON.stringify({ hashes: [live.hash] })),
    );
    fake.putRaw(".pending/cccccccc-cccc-4ccc-8ccc-cccccccccccc.json", new TextEncoder().encode("{"));
    const recovered = await store.recoverUnreferencedWrites(new Set([live.hash]));
    expect(recovered.reclaimed).toEqual([]);
    expect(await store.verify(live.hash)).toBe(true);
    expect(await store.verify(orphan.hash)).toBe(true);
    expect(pendingKeys(fake)).toEqual([".pending/not-a-uuid.json"]);
  });

  it("reclaims a crashed batch on the next exclusive write when reference sources are bound", async () => {
    const { store } = openStore();
    const referenced = new Set<string>();
    store.addReferencedContentHashSource(async () => referenced);
    const batch = await store.beginWriteBatch();
    const crashed = await batch.put(new TextEncoder().encode("auto-recover-crash\n"));
    await batch.promote();
    await abandonS3WriteBatchForCrashTest(batch);
    expect(await store.verify(crashed.hash)).toBe(true);
    const next = await store.beginWriteBatch();
    const later = await next.put(new TextEncoder().encode("later-intake\n"));
    await next.promote();
    await next.finalize();
    expect(await store.head(crashed.hash)).toBeNull();
    expect(await store.verify(later.hash)).toBe(true);
  });

  it("refuses recovery without a referenced-hash set or bound source", async () => {
    const { store } = openStore();
    await expect(store.recoverUnreferencedWrites()).rejects.toThrow(
      /referenced content hashes are required/,
    );
  });

  it("holds one lock and lease from begin through promote and finalize", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const heldDuringSend: number[] = [];
    fake.onSend = () => {
      heldDuringSend.push(lease.active());
    };
    const store = new S3EvidenceStore(garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }));
    expect(store.writeCoordination).toBe("external");
    const batch = await store.beginWriteBatch();
    expect(lease.active()).toBe(1);
    expect(lease.maxActive()).toBe(1);
    await batch.put(new TextEncoder().encode("lease-held-throughout\n"));
    expect(lease.active()).toBe(1);
    await batch.promote();
    expect(lease.active()).toBe(1);
    expect(heldDuringSend.every((value) => value === 1)).toBe(true);
    await batch.finalize();
    expect(lease.active()).toBe(0);
    expect(lease.acquires()).toBe(1);
    expect(lease.releases()).toBe(1);
    await store.put(new TextEncoder().encode("after-batch\n"));
    expect(lease.acquires()).toBe(2);
    expect(lease.active()).toBe(0);
    expect(lease.maxActive()).toBe(1);
  });

  it("holds the external lease for an ad-hoc stage until release", async () => {
    const lease = leaseTracker();
    const fake = new FakeS3Client(SYNTHETIC_BUCKET);
    const heldDuringSend: number[] = [];
    fake.onSend = () => heldDuringSend.push(lease.active());
    const store = new S3EvidenceStore(
      garageOptions(fake, { acquireWriteLease: lease.acquireWriteLease }),
    );
    const stage = await store.stage(new TextEncoder().encode("leased-stage\n"));
    expect(lease.active()).toBe(1);
    expect(lease.acquires()).toBe(1);
    await stage.commit();
    expect(lease.active()).toBe(1);
    await stage.rollback();
    expect(lease.active()).toBe(1);
    expect(heldDuringSend.every((value) => value === 1)).toBe(true);
    stage.release();
    stage.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lease.active()).toBe(0);
    expect(lease.releases()).toBe(1);
  });

  it("fails closed on nested batch, stage, and file-reference mutations", async () => {
    const { store } = openStore();
    const batch = await store.beginWriteBatch();
    await expect(batch.beginWriteBatch()).rejects.toThrow(/nested evidence write batches/);
    await expect(batch.stage()).rejects.toThrow(/nested evidence stages/);
    await expect(batch.putFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.abandonFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.restoreFileServerReference()).rejects.toThrow(/file-server references/);
    await expect(batch.verifyFileServerReference()).rejects.toThrow(/file-server references/);
    await batch.rollback();
  });
});
