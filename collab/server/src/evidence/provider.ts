/**
 * Server-only evidence store factory. Assembles the filesystem or S3
 * EvidenceStore from secret-free settings plus separately loaded credentials.
 * AWS SDK option assembly stays in this adapter so later S3EvidenceStoreOptions
 * hardening can keep using an injected client.
 */
import { Agent as HttpsAgent } from "node:https";
import type { Readable } from "node:stream";
import { PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  createPostgresEvidenceWriteLease,
  type EvidenceWriteLeasePool,
  type EvidenceWriteLeaseRelease,
} from "./lease.js";
import type { EvidenceS3Credentials } from "./s3-secrets.js";
import {
  EVIDENCE_STORAGE_ERRORS,
  MAX_EVIDENCE_S3_CA_FILE_BYTES,
  MAX_EVIDENCE_S3_TIMEOUT_MS,
  MIN_EVIDENCE_S3_TIMEOUT_MS,
  readUnfollowedRegularFile,
  type EvidenceStorageSettings,
} from "./s3-settings.js";
import {
  createS3ClientConfig,
  createNonRetryingS3UploadClient,
  createTrackedAbortUploadClient,
  S3EvidenceStore,
  type S3EvidenceClient,
  type S3EvidenceStoreOptions,
} from "./s3-store.js";
import {
  FilesystemEvidenceStore,
  type EvidenceStore,
  type EvidenceWriteRecoveryReport,
} from "./store.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Conservative SDK retry budget for evidence S3. Not a tunable env setting. */
export const EVIDENCE_S3_CLIENT_MAX_ATTEMPTS = 3;

export const EVIDENCE_S3_PROVIDER_CONFIG_ERROR =
  "s3 evidence configuration is invalid";

export interface EvidenceS3RequestHandlerOptions {
  connectionTimeout: number;
  requestTimeout: number;
  throwOnRequestTimeout: true;
  httpsAgent?: HttpsAgent;
}

export type RuntimeEvidenceStore = EvidenceStore & {
  addReferencedContentHashSource: (loader: () => Promise<Iterable<string>>) => void;
  recoverUnreferencedWrites: (
    referenced?: ReadonlySet<string>,
  ) => Promise<EvidenceWriteRecoveryReport>;
};

export interface CreateEvidenceStoreOptions {
  settings: EvidenceStorageSettings;
  credentials?: EvidenceS3Credentials;
  writeLeasePool?: EvidenceWriteLeasePool | null;
  createWriteLease?: (
    pool: EvidenceWriteLeasePool,
  ) => () => Promise<EvidenceWriteLeaseRelease>;
  createS3Client?: (config: S3ClientConfig) => S3EvidenceClient;
  createRequestHandler?: (options: EvidenceS3RequestHandlerOptions) => unknown;
}

export function createEvidenceStore(
  options: CreateEvidenceStoreOptions,
): RuntimeEvidenceStore {
  const acquireWriteLease = writeLeaseFromPool(options);
  if (options.settings.provider === "filesystem") {
    return new FilesystemEvidenceStore({
      rootDir: options.settings.controlRoot,
      ...(acquireWriteLease ? { acquireWriteLease } : {}),
    });
  }
  if (options.settings.provider !== "s3") {
    failClosed();
  }
  try {
    return createS3EvidenceStore(options, acquireWriteLease);
  } catch (error) {
    rethrowSanitized(error);
  }
}

function writeLeaseFromPool(
  options: CreateEvidenceStoreOptions,
): (() => Promise<EvidenceWriteLeaseRelease>) | undefined {
  const pool = options.writeLeasePool;
  if (!pool) return undefined;
  const create = options.createWriteLease ?? createPostgresEvidenceWriteLease;
  return create(pool);
}

function createS3EvidenceStore(
  options: CreateEvidenceStoreOptions,
  acquireWriteLease: (() => Promise<EvidenceWriteLeaseRelease>) | undefined,
): RuntimeEvidenceStore {
  const settings = options.settings;
  if (settings.provider !== "s3") failClosed();
  assertConsistentS3Settings(settings.s3);
  const credentials = assertCredentialAlignment(
    settings.s3.credentialsMode,
    options.credentials,
  );
  const handlerOptions = requestHandlerOptions(settings.s3);
  const createRequestHandler =
    options.createRequestHandler ?? defaultCreateRequestHandler;
  const requestHandler = createRequestHandler(handlerOptions);
  const assembled = assembleS3StoreInput(settings, credentials);
  const clientConfig = createS3ClientConfig(assembled);
  clientConfig.maxAttempts = EVIDENCE_S3_CLIENT_MAX_ATTEMPTS;
  clientConfig.requestHandler =
    requestHandler as NonNullable<S3ClientConfig["requestHandler"]>;
  const createClient = options.createS3Client ?? defaultCreateS3Client;
  const client = new OpaqueS3EvidenceClient(createClient(clientConfig));
  const storeOptions: S3EvidenceStoreOptions = {
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    prefix: settings.s3.prefix,
    endpoint: settings.s3.endpoint,
    forcePathStyle: settings.s3.forcePathStyle,
    client,
    responseBodyIdleTimeoutMs: settings.s3.timeoutMs,
    ...(acquireWriteLease ? { acquireWriteLease } : {}),
  };
  return new S3EvidenceStore(storeOptions);
}

function assembleS3StoreInput(
  settings: Extract<EvidenceStorageSettings, { provider: "s3" }>,
  credentials: EvidenceS3Credentials,
): S3EvidenceStoreOptions {
  const assembled: S3EvidenceStoreOptions = {
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    prefix: settings.s3.prefix,
    endpoint: settings.s3.endpoint,
    forcePathStyle: settings.s3.forcePathStyle,
  };
  if (settings.s3.credentialsMode === "static" && credentials.mode === "static") {
    assembled.accessKeyId = credentials.accessKeyId();
    assembled.secretAccessKey = credentials.secretAccessKey();
    const sessionToken = credentials.sessionToken();
    if (sessionToken !== undefined) assembled.sessionToken = sessionToken;
  }
  return assembled;
}

function assertConsistentS3Settings(
  s3: Extract<EvidenceStorageSettings, { provider: "s3" }>["s3"],
): void {
  if (
    typeof s3.endpoint !== "string"
    || typeof s3.allowHttp !== "boolean"
    || (s3.credentialsMode !== "static" && s3.credentialsMode !== "default_chain")
    || typeof s3.timeoutMs !== "number"
    || !Number.isInteger(s3.timeoutMs)
    || s3.timeoutMs < MIN_EVIDENCE_S3_TIMEOUT_MS
    || s3.timeoutMs > MAX_EVIDENCE_S3_TIMEOUT_MS
    || typeof s3.forcePathStyle !== "boolean"
  ) {
    failClosed();
  }
  let url: URL;
  try {
    url = new URL(s3.endpoint);
  } catch {
    failClosed();
  }
  // The settings loader emits an origin-only endpoint. Reassert that shape at
  // this construction boundary so a handcrafted settings object cannot add
  // credentials, a path, query state, or a fragment after validation.
  if (
    url.origin !== s3.endpoint
    || url.username !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    failClosed();
  }
  if (url.protocol === "http:") {
    if (s3.allowHttp !== true) failClosed();
    if (s3.caConfigured === true) failClosed();
  } else if (url.protocol !== "https:") {
    failClosed();
  }
  if (s3.caConfigured === true) {
    if (typeof s3.caFilePath !== "string" || s3.caFilePath.length === 0) {
      failClosed();
    }
  } else if (s3.caConfigured === false) {
    if (s3.caFilePath !== null) failClosed();
  } else {
    failClosed();
  }
}

function assertCredentialAlignment(
  mode: "static" | "default_chain",
  credentials: EvidenceS3Credentials | undefined,
): EvidenceS3Credentials {
  if (!credentials || credentials.mode !== mode) failClosed();
  return credentials;
}

function requestHandlerOptions(
  s3: Extract<EvidenceStorageSettings, { provider: "s3" }>["s3"],
): EvidenceS3RequestHandlerOptions {
  const options: EvidenceS3RequestHandlerOptions = {
    connectionTimeout: s3.timeoutMs,
    requestTimeout: s3.timeoutMs,
    // Smithy's request timeout only logs by default. Evidence readiness and
    // I/O must reject so a connected but silent endpoint cannot hang startup.
    throwOnRequestTimeout: true,
  };
  if (s3.caConfigured && s3.caFilePath) {
    let ca: Buffer;
    try {
      ca = readUnfollowedRegularFile(s3.caFilePath, {
        maxBytes: MAX_EVIDENCE_S3_CA_FILE_BYTES,
        ownerOnly: false,
      });
    } catch {
      throw new Error(EVIDENCE_STORAGE_ERRORS.caFile);
    }
    options.httpsAgent = new HttpsAgent({
      ca,
      rejectUnauthorized: true,
    });
  }
  return options;
}

function defaultCreateRequestHandler(
  options: EvidenceS3RequestHandlerOptions,
): NodeHttpHandler {
  return new NodeHttpHandler(options);
}

function defaultCreateS3Client(config: S3ClientConfig): S3EvidenceClient {
  return new S3Client(config) as unknown as S3EvidenceClient;
}

function failClosed(): never {
  throw new Error(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
}

function rethrowSanitized(error: unknown): never {
  if (
    error instanceof Error
    && (
      error.message === EVIDENCE_S3_PROVIDER_CONFIG_ERROR
      || error.message === EVIDENCE_STORAGE_ERRORS.caFile
    )
  ) {
    throw error;
  }
  failClosed();
}

class OpaqueS3EvidenceClient implements S3EvidenceClient {
  readonly #send: S3EvidenceClient["send"];
  readonly #streamClient: S3Client | null;

  constructor(inner: S3EvidenceClient) {
    this.#send = inner.send.bind(inner);
    this.#streamClient = inner instanceof S3Client
      ? createNonRetryingS3UploadClient(inner)
      : null;
  }

  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    return this.#send(command, options);
  }

  async uploadStream(
    input: {
      Bucket: string;
      Key: string;
      Body: Readable;
      ContentLength?: number;
      ContentType?: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#streamClient) {
      await this.#send(
        new PutObjectCommand(input),
        signal ? { abortSignal: signal } : undefined,
      );
      return;
    }
    const abortController = new AbortController();
    const onAbort = (): void => {
      const reason = signal?.reason;
      abortController.abort(reason instanceof Error ? reason : undefined);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const tracked = createTrackedAbortUploadClient(this.#streamClient, abortController.signal);
    let failure: unknown;
    try {
      await new Upload({
        client: tracked.client,
        params: input,
        queueSize: 1,
        leavePartsOnError: false,
        abortController,
      }).done();
    } catch (error) {
      failure = error;
    } finally {
      await tracked.waitForRequests();
      signal?.removeEventListener("abort", onAbort);
    }
    if (failure !== undefined) throw failure;
  }

  toJSON(): { configured: true } {
    return { configured: true };
  }

  [INSPECT](): string {
    return "S3EvidenceClient { configured: true }";
  }
}
