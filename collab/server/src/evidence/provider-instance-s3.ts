import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
  MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES,
  EvidenceProviderInstanceStorageError,
  assertCanonicalEvidenceProviderInstanceId,
  isEvidenceProviderInstanceStorageError,
  parseEvidenceProviderInstance,
  serializeEvidenceProviderInstance,
  type EvidenceProviderInstanceInitialization,
  type EvidenceProviderInstanceManager,
  type EvidenceProviderInstanceV1,
} from "./provider-instance.js";
import type { S3EvidenceClient } from "./s3-store.js";
import { normalizeEvidenceS3Prefix } from "./s3-settings.js";

export const EVIDENCE_PROVIDER_INSTANCE_S3_KEY =
  ".contextdesk/provider-instance.v1.json";

type S3Response = Readonly<Record<PropertyKey, unknown>>;

interface S3ObjectGeneration {
  readonly etag: string;
  readonly versionId: string | null;
  readonly contentLength: number;
}

export class S3EvidenceProviderInstanceManager
implements EvidenceProviderInstanceManager {
  private readonly client: S3EvidenceClient;
  private readonly bucket: string;
  private readonly key: string;
  private readonly randomProviderInstanceId: () => string;
  private readonly responseBodyIdleTimeoutMs: number;

  constructor(options: {
    client: S3EvidenceClient;
    bucket: string;
    prefix?: string;
    randomProviderInstanceId?: () => string;
    responseBodyIdleTimeoutMs?: number;
  }) {
    this.client = assertClient(options.client);
    this.bucket = normalizeBucket(options.bucket);
    this.key = `${normalizePrefix(options.prefix)}${EVIDENCE_PROVIDER_INSTANCE_S3_KEY}`;
    if (new TextEncoder().encode(this.key).byteLength > 1024) this.invalid();
    this.randomProviderInstanceId = options.randomProviderInstanceId ?? randomUUID;
    this.responseBodyIdleTimeoutMs = options.responseBodyIdleTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.responseBodyIdleTimeoutMs)
      || this.responseBodyIdleTimeoutMs < 1
      || this.responseBodyIdleTimeoutMs > 120_000
    ) {
      this.invalid();
    }
  }

  async inspect(
    expectedProviderInstanceId?: string,
  ): Promise<EvidenceProviderInstanceV1 | null> {
    if (expectedProviderInstanceId !== undefined) {
      this.assertExpectedId(expectedProviderInstanceId);
    }
    try {
      const before = await this.head();
      if (before === null) return null;
      const response = responseRecord(await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        IfMatch: before.etag,
        ...(before.versionId === null ? {} : { VersionId: before.versionId }),
      })));
      const generation = generationFromResponse(response);
      if (!sameGeneration(before, generation)) this.unavailable();
      const body = await collectExactBody(
        safeGet(response, "Body"),
        before.contentLength,
        this.responseBodyIdleTimeoutMs,
      );
      let manifest: EvidenceProviderInstanceV1;
      try {
        manifest = parseEvidenceProviderInstance(body);
      } catch {
        this.invalid();
      }
      if (manifest.providerKind !== "s3") this.invalid();
      if (
        expectedProviderInstanceId !== undefined
        && manifest.providerInstanceId !== expectedProviderInstanceId
      ) {
        this.mismatch();
      }
      const after = await this.head();
      if (after === null || !sameGeneration(before, after)) this.unavailable();
      return Object.freeze({
        schemaId: manifest.schemaId,
        providerInstanceId: manifest.providerInstanceId,
        providerKind: manifest.providerKind,
      });
    } catch (error) {
      if (isEvidenceProviderInstanceStorageError(error)) throw error;
      this.unavailable();
    }
  }

  async initialize(
    expectedProviderInstanceId?: string,
  ): Promise<EvidenceProviderInstanceInitialization> {
    if (expectedProviderInstanceId !== undefined) {
      this.assertExpectedId(expectedProviderInstanceId);
    }
    const existing = await this.inspect(expectedProviderInstanceId);
    if (existing !== null) {
      return Object.freeze({ outcome: "existing", manifest: existing });
    }

    const candidateId = expectedProviderInstanceId ?? this.randomProviderInstanceId();
    this.assertExpectedId(candidateId);
    const candidate: EvidenceProviderInstanceV1 = Object.freeze({
      schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
      providerInstanceId: candidateId,
      providerKind: "s3",
    });
    const body = serializeEvidenceProviderInstance(candidate);

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: "application/json",
        IfNoneMatch: "*",
      }));
    } catch (error) {
      if (isConditionalConflict(error)) {
        return await this.reconcile(candidate, expectedProviderInstanceId, "existing");
      }
      return await this.reconcile(candidate, expectedProviderInstanceId, "unknown");
    }

    let observed: EvidenceProviderInstanceV1 | null;
    try {
      observed = await this.inspect(candidate.providerInstanceId);
    } catch (error) {
      if (
        isEvidenceProviderInstanceStorageError(error)
        && (error.code === "invalid" || error.code === "identity_mismatch")
      ) {
        throw error;
      }
      this.outcomeUnknown();
    }
    if (observed === null) this.outcomeUnknown();
    return Object.freeze({ outcome: "created", manifest: observed });
  }

  private async reconcile(
    candidate: EvidenceProviderInstanceV1,
    expectedProviderInstanceId: string | undefined,
    reason: "existing" | "unknown",
  ): Promise<EvidenceProviderInstanceInitialization> {
    let observed: EvidenceProviderInstanceV1 | null;
    try {
      observed = await this.inspect(expectedProviderInstanceId);
    } catch (error) {
      if (
        isEvidenceProviderInstanceStorageError(error)
        && (error.code === "invalid" || error.code === "identity_mismatch")
      ) {
        throw error;
      }
      this.outcomeUnknown();
    }
    if (observed === null) this.outcomeUnknown();
    const isCandidate = observed.providerInstanceId === candidate.providerInstanceId;
    if (reason === "unknown" && !isCandidate && expectedProviderInstanceId !== undefined) {
      this.mismatch();
    }
    return Object.freeze({
      outcome: reason === "existing" ? "existing" : isCandidate ? "reconciled" : "existing",
      manifest: observed,
    });
  }

  private async head(): Promise<S3ObjectGeneration | null> {
    let response: S3Response;
    try {
      response = responseRecord(await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })));
    } catch (error) {
      if (isDeleteMarkerError(error)) {
        throw new EvidenceProviderInstanceStorageError("invalid");
      }
      if (isObjectNotFound(error)) return null;
      throw error;
    }
    return generationFromResponse(response);
  }

  private assertExpectedId(value: string): void {
    try {
      assertCanonicalEvidenceProviderInstanceId(value);
    } catch {
      this.invalid();
    }
  }

  private invalid(): never {
    throw new EvidenceProviderInstanceStorageError("invalid");
  }

  private mismatch(): never {
    throw new EvidenceProviderInstanceStorageError("identity_mismatch");
  }

  private unavailable(): never {
    throw new EvidenceProviderInstanceStorageError("unavailable");
  }

  private outcomeUnknown(): never {
    throw new EvidenceProviderInstanceStorageError("initialization_outcome_unknown");
  }
}

function assertClient(value: S3EvidenceClient): S3EvidenceClient {
  try {
    if (typeof value !== "object" || value === null || typeof value.send !== "function") {
      throw new EvidenceProviderInstanceStorageError("invalid");
    }
    return value;
  } catch (error) {
    if (isEvidenceProviderInstanceStorageError(error)) throw error;
    throw new EvidenceProviderInstanceStorageError("invalid");
  }
}

function normalizeBucket(value: string): string {
  try {
    const bucket = value.trim();
    if (
      bucket.length < 3
      || bucket.length > 63
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)
      || bucket.includes("..")
      || /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
      || bucket.startsWith("xn--")
      || bucket.startsWith("sthree-")
      || bucket.startsWith("amzn-s3-demo-")
      || bucket.endsWith("-s3alias")
      || bucket.endsWith("--ol-s3")
      || bucket.endsWith(".mrap")
      || bucket.endsWith("--x-s3")
      || bucket.endsWith("--table-s3")
      || bucket.split(".").some((label) =>
        label === "" || label.startsWith("-") || label.endsWith("-"))
    ) {
      throw new Error("invalid");
    }
    return bucket;
  } catch {
    throw new EvidenceProviderInstanceStorageError("invalid");
  }
}

function normalizePrefix(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  try {
    return normalizeEvidenceS3Prefix(value);
  } catch {
    throw new EvidenceProviderInstanceStorageError("invalid");
  }
}

function responseRecord(value: unknown): S3Response {
  if (typeof value !== "object" || value === null) {
    throw new EvidenceProviderInstanceStorageError("unavailable");
  }
  return value as S3Response;
}

function generationFromResponse(response: S3Response): S3ObjectGeneration {
  const contentLength = safeGet(response, "ContentLength");
  const etag = safeGet(response, "ETag");
  const versionId = safeGet(response, "VersionId");
  const deleteMarker = safeGet(response, "DeleteMarker");
  if (
    deleteMarker === true
    || !Number.isSafeInteger(contentLength)
    || (contentLength as number) < 1
    || (contentLength as number) > MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES
    || typeof etag !== "string"
    || etag.length < 1
    || etag.length > 1024
    || (versionId !== undefined
      && (typeof versionId !== "string" || versionId.length < 1 || versionId.length > 1024))
  ) {
    throw new EvidenceProviderInstanceStorageError("invalid");
  }
  return Object.freeze({
    etag,
    versionId: versionId === undefined ? null : versionId,
    contentLength: contentLength as number,
  });
}

function sameGeneration(left: S3ObjectGeneration, right: S3ObjectGeneration): boolean {
  return left.etag === right.etag
    && left.versionId === right.versionId
    && left.contentLength === right.contentLength;
}

async function collectExactBody(
  body: unknown,
  expectedLength: number,
  idleTimeoutMs: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength !== expectedLength) bodyInvalid();
    return new Uint8Array(body);
  }
  if (typeof body !== "object" || body === null) bodyInvalid();
  const iteratorFactory = safeGet(body as S3Response, Symbol.asyncIterator);
  if (typeof iteratorFactory !== "function") bodyInvalid();
  const iterator = Reflect.apply(iteratorFactory, body, []) as AsyncIterator<unknown>;
  const output = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    for (;;) {
      let next: IteratorResult<unknown>;
      try {
        next = await nextWithIdleDeadline(iterator, idleTimeoutMs);
      } catch {
        throw new EvidenceProviderInstanceStorageError("unavailable");
      }
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        bodyInvalid();
      }
      if (chunk.byteLength > expectedLength - offset) bodyInvalid();
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    releaseIterator(iterator);
    throw error;
  }
  if (offset !== expectedLength) {
    releaseIterator(iterator);
    bodyInvalid();
  }
  return output;
}

function bodyInvalid(): never {
  throw new EvidenceProviderInstanceStorageError("invalid");
}

function releaseIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Cleanup cannot make malformed remote bytes valid.
  }
}

function nextWithIdleDeadline(
  iterator: AsyncIterator<unknown>,
  idleTimeoutMs: number,
): Promise<IteratorResult<unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new EvidenceProviderInstanceStorageError("unavailable"))),
      idleTimeoutMs,
    );
    timer.unref?.();
    let pending: Promise<IteratorResult<unknown>>;
    try {
      pending = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function safeGet(value: S3Response, property: PropertyKey): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    throw new EvidenceProviderInstanceStorageError("unavailable");
  }
}

function isObjectNotFound(error: unknown): boolean {
  const status = safeErrorProperty(error, "$metadata");
  const statusCode = typeof status === "object" && status !== null
    ? safeErrorProperty(status, "httpStatusCode")
    : null;
  const codes = errorCodes(error);
  return statusCode === 404
    && codes.some((code) =>
      code === "NotFound" || code === "NoSuchKey" || code === "NoSuchKeyException");
}

function isConditionalConflict(error: unknown): boolean {
  const metadata = safeErrorProperty(error, "$metadata");
  const statusCode = typeof metadata === "object" && metadata !== null
    ? safeErrorProperty(metadata, "httpStatusCode")
    : null;
  const codes = errorCodes(error);
  return (statusCode === 412 && codes.includes("PreconditionFailed"))
    || (statusCode === 409 && codes.includes("ConditionalRequestConflict"));
}

function isDeleteMarkerError(error: unknown): boolean {
  if (safeErrorProperty(error, "DeleteMarker") === true) return true;
  const response = safeErrorProperty(error, "$response");
  const headers = safeErrorProperty(response, "headers");
  const marker = safeErrorProperty(headers, "x-amz-delete-marker");
  return marker === true || marker === "true";
}

function errorCodes(error: unknown): string[] {
  const values = [
    safeErrorProperty(error, "name"),
    safeErrorProperty(error, "Code"),
    safeErrorProperty(error, "code"),
  ];
  return values.filter((value): value is string => typeof value === "string");
}

function safeErrorProperty(value: unknown, property: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return null;
  try {
    return Reflect.get(value, property);
  } catch {
    return null;
  }
}
