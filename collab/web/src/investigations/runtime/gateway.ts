import {
  ContractViolation,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
  parseCase,
  parseCaseList,
  parseContribution,
  parseContributionList,
  parseEvidenceList,
  parseEvidenceUploadSuccess,
  parseInvestigationLifecycle,
  parseInvestigationLifecycleActionRefused,
  parseInvestigationLifecycleActionSuccess,
  parseInvestigationLifecycleChanged,
  parseInvestigationCoordination,
  parseInvestigationCoordinationActionRefused,
  parseInvestigationCoordinationActionRequest,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationCoordinationChanged,
  type ArtifactKind,
  type ArtifactV1,
  type CaseV1,
  type ContributionKind,
  type ContributionV1,
  type EvidenceUploadSuccessV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleExpectedV1,
  type InvestigationLifecycleV1,
  type InvestigationCoordinationActionRequestV1,
  type InvestigationCoordinationActionSuccessV1,
  type InvestigationCoordinationV1,
  type LifecycleAction,
  type PrivacyClass,
} from "@cd-collab/contracts/investigation-runtime";
import {
  INVESTIGATION_COLLECTION_LIMITS,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  parseInvestigationCollectionPage,
  parseInvestigationCollectionQuery,
  type InvestigationCollectionPageV1,
  type InvestigationCollectionQueryV1,
} from "@cd-collab/contracts/investigation-collection";
import {
  INVESTIGATION_OPERATIONS_QUEUE_LIMITS,
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  parseInvestigationOperationsQueuePage,
  parseInvestigationOperationsQueueQuery,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryV1,
} from "@cd-collab/contracts/investigation-operations-queue";
import {
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  parseArtifactAnnotation,
  parseArtifactAnnotationBulkResult,
  parseArtifactAnnotationList,
} from "./annotation-contract.js";
import type {
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationV1,
} from "./annotation-contract.js";
import { protectedApiFetch } from "../../protected-api.js";
import {
  classifyHttpFailure,
  classifyRequestException,
  protocolFailure,
  type RuntimeFailure,
} from "./errors.js";
import { deepFreezeDto } from "./deep-freeze.js";

export type GatewayResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeFailure };

export interface GatewayRequestOptions {
  /** Required so every caller makes cancellation and publication intentional. */
  readonly signal: AbortSignal;
}

export interface CoordinationGatewayRequestOptions extends GatewayRequestOptions {
  /** Authenticated actor supplied by the shell, never serialized into the request body. */
  readonly actorIdentityId: string;
}

export interface CreateInvestigationInput {
  readonly title: string;
  readonly severity?: CaseV1["severity"];
  readonly clientTime?: string;
  readonly problemStatement?: string;
  readonly affectedParties?: string;
  readonly impact?: string;
  readonly scope?: string;
  readonly openQuestions?: readonly string[];
  readonly investigationContext?: CaseV1["investigationContext"];
  readonly occurredAt?: string | null;
  readonly occurredAtPrecision?: CaseV1["occurredAtPrecision"];
  readonly occurredAtZone?: CaseV1["occurredAtZone"];
}

/** Transport-ready upload input. File reading and size limits belong to a controller. */
export interface UploadEvidenceInput {
  readonly kind: ArtifactKind;
  readonly summary: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly contentBase64?: string;
  readonly uri?: string;
  readonly expectedHash?: string | null;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
}

/**
 * Browser file upload input for the server's streaming multipart endpoint.
 * The Blob is passed to FormData unchanged; this seam intentionally has no
 * base64 or byte-array member, so large evidence never needs to be buffered
 * into a second in-memory representation.
 */
export interface UploadEvidenceStreamInput {
  readonly kind: ArtifactKind;
  readonly summary: string;
  readonly file: Blob;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly expectedHash?: string | null;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
}

/** A bounded, text-only projection of one evidence artifact's bytes. */
export interface EvidencePreviewValue {
  readonly artifactId: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly etag: string | null;
}

/** Optional validator for a cached preview representation. */
export interface PreviewEvidenceInput {
  readonly ifNoneMatch?: string;
}

/** Transport-ready contribution create input. Body composition is a controller concern. */
export interface CreateContributionInput {
  readonly kind: ContributionKind;
  readonly body: string;
  readonly hypothesisLinks?: readonly {
    readonly kind: "artifact" | "contribution";
    readonly id: string;
  }[];
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
  /** Caller-generated token; the server owns validation and replay semantics. */
  readonly idempotencyKey?: string;
}

/**
 * Transport-ready situation update input.
 *
 * `expectedVersion` is required so the server, not the browser, arbitrates a
 * concurrent edit. A controller derives it from the case it is editing; this
 * seam never defaults or infers one.
 */
export interface UpdateSituationInput {
  readonly expectedVersion: number;
  readonly problemStatement?: string;
  readonly affectedParties?: string;
  readonly impact?: string;
  readonly scope?: string;
  readonly openQuestions?: readonly string[];
  readonly investigationContext?: CaseV1["investigationContext"];
  readonly clientTime?: string;
}

/** Transport-ready metadata for one append-only artifact annotation. */
export interface CreateArtifactAnnotationInput {
  readonly body: string;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
  /** Stable caller-generated token used to replay an uncertain commit safely. */
  readonly idempotencyKey?: string;
}

/** Transport-ready input for one atomic, bounded annotation target set. */
export interface CreateArtifactAnnotationsBulkInput {
  readonly artifactIds: readonly string[];
  readonly body: string;
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
  /** Required so an uncertain commit can be replayed safely. */
  readonly idempotencyKey: string;
}

/** The optional annotation transport is resolved as one fail-closed seam. */
export interface InvestigationAnnotationGateway {
  listArtifactAnnotations(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<readonly ArtifactAnnotationV1[]>>;
  createArtifactAnnotation(
    investigationId: string,
    artifactId: string,
    input: CreateArtifactAnnotationInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<ArtifactAnnotationV1>>;
  /** Optional V1.1 bulk seam; old doubles may omit it and fail closed. */
  createArtifactAnnotationsBulk?(
    investigationId: string,
    input: CreateArtifactAnnotationsBulkInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<ArtifactAnnotationBulkResultV1>>;
}

/** Resolved atomic annotation set transport. */
export interface InvestigationBulkAnnotationGateway {
  createArtifactAnnotationsBulk(
    investigationId: string,
    input: CreateArtifactAnnotationsBulkInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<ArtifactAnnotationBulkResultV1>>;
}

export interface ApplyLifecycleActionInput {
  readonly action: LifecycleAction;
  readonly expected: InvestigationLifecycleExpectedV1;
  readonly clientTime?: string;
}

export type ApplyCoordinationActionInput = Omit<
  InvestigationCoordinationActionRequestV1,
  "schemaId" | "investigationId"
>;

/** Optional coordination transport; reads and actions are upgraded together. */
export interface InvestigationCoordinationGateway {
  getCoordination(
    investigationId: string,
    options: CoordinationGatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationCoordinationV1>>;
  applyCoordinationAction(
    investigationId: string,
    input: ApplyCoordinationActionInput,
    options: CoordinationGatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationCoordinationActionSuccessV1>>;
}

/**
 * The Runtime V1.1 write seams, kept as their own contract.
 *
 * They are deliberately not required members of `InvestigationGateway`: a
 * read-shaped transport double written before these seams existed stays a
 * valid gateway, and nothing is silently assumed about it. A caller resolves
 * this contract through `investigationWriteGateway`, which fails closed when
 * the underlying transport does not implement it.
 */
export interface InvestigationWriteGateway {
  createContribution(
    investigationId: string,
    input: CreateContributionInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<ContributionV1>>;
  updateSituation(
    investigationId: string,
    input: UpdateSituationInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<CaseV1>>;
}

/** A transport that carries both the read surface and the V1.1 write seams. */
export type InvestigationGatewayWithWrites =
  InvestigationGateway & InvestigationWriteGateway;

/**
 * Presentation-safe collection filters. The runtime supplies the schema opt-in;
 * extra keys never become query parameters.
 */
export interface InvestigationCollectionQueryInput {
  readonly q?: InvestigationCollectionQueryV1["q"];
  readonly status?: ReadonlyArray<InvestigationCollectionQueryV1["status"][number]>;
  readonly includeArchived?: InvestigationCollectionQueryV1["includeArchived"];
  readonly entityId?: InvestigationCollectionQueryV1["entityId"];
  readonly impactIdentity?: InvestigationCollectionQueryV1["impactIdentity"];
  readonly contributorId?: InvestigationCollectionQueryV1["contributorId"];
  readonly recordedFrom?: InvestigationCollectionQueryV1["recordedFrom"];
  readonly recordedTo?: InvestigationCollectionQueryV1["recordedTo"];
  readonly limit?: InvestigationCollectionQueryV1["limit"];
  readonly cursor?: InvestigationCollectionQueryV1["cursor"];
}

/**
 * Optional versioned collection-query transport.
 *
 * It is deliberately not required on `InvestigationGateway`: a list-shaped
 * double written before this seam existed stays valid. Callers resolve it
 * through `investigationCollectionQueryGateway`, which fails closed when the
 * method is missing instead of inventing a page or falling back to the list.
 */
export interface InvestigationCollectionQueryGateway {
  queryInvestigations(
    query: InvestigationCollectionQueryInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationCollectionPageV1>>;
}

/**
 * Presentation-safe Operations Queue filters. The authenticated actor is
 * deliberately absent: the server derives `mine` from the protected session.
 */
export interface InvestigationOperationsQueueQueryInput {
  readonly q?: InvestigationOperationsQueueQueryV1["q"];
  readonly status?: ReadonlyArray<InvestigationOperationsQueueQueryV1["status"][number]>;
  readonly includeArchived?: InvestigationOperationsQueueQueryV1["includeArchived"];
  readonly entityId?: InvestigationOperationsQueueQueryV1["entityId"];
  readonly impactIdentity?: InvestigationOperationsQueueQueryV1["impactIdentity"];
  readonly contributorId?: InvestigationOperationsQueueQueryV1["contributorId"];
  readonly recordedFrom?: InvestigationOperationsQueueQueryV1["recordedFrom"];
  readonly recordedTo?: InvestigationOperationsQueueQueryV1["recordedTo"];
  readonly coordinationScope?: InvestigationOperationsQueueQueryV1["coordinationScope"];
  readonly limit?: InvestigationOperationsQueueQueryV1["limit"];
  readonly cursor?: InvestigationOperationsQueueQueryV1["cursor"];
}

/** Optional read-only queue transport, independent of both collection seams. */
export interface InvestigationOperationsQueueGateway {
  queryOperationsQueue(
    query: InvestigationOperationsQueueQueryInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationOperationsQueuePageV1>>;
}

export interface InvestigationGateway
  extends
    Partial<InvestigationWriteGateway>,
    Partial<InvestigationAnnotationGateway>,
    Partial<InvestigationCollectionQueryGateway>,
    Partial<InvestigationCoordinationGateway>,
    Partial<InvestigationOperationsQueueGateway>
{
  listInvestigations(
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<readonly CaseV1[]>>;
  getInvestigation(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<CaseV1>>;
  createInvestigation(
    input: CreateInvestigationInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<CaseV1>>;
  listEvidence(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<readonly ArtifactV1[]>>;
  /** Read at most the bounded text preview; never exposes a raw Response. */
  previewEvidence?(
    investigationId: string,
    artifactId: string,
    input: PreviewEvidenceInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<EvidencePreviewValue & { readonly notModified?: boolean }>>;
  listContributions(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<readonly ContributionV1[]>>;
  uploadEvidence(
    investigationId: string,
    input: UploadEvidenceInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<EvidenceUploadSuccessV1>>;
  /** Optional streaming transport; legacy JSON gateways remain valid. */
  uploadEvidenceStream?(
    investigationId: string,
    input: UploadEvidenceStreamInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<EvidenceUploadSuccessV1>>;
  getLifecycle(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationLifecycleV1>>;
  applyLifecycleAction(
    investigationId: string,
    input: ApplyLifecycleActionInput,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<InvestigationLifecycleActionSuccessV1>>;
}

type Parser<T> = (raw: unknown) => T;
type IdentityCheck<T> = (value: T) => boolean;

type ResponseResult =
  | { ok: true; response: Response }
  | { ok: false; error: RuntimeFailure };

type SerializedBodyResult = GatewayResult<string>;

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });

function failed<T>(error: RuntimeFailure): GatewayResult<T> {
  return { ok: false, error };
}

function aborted<T>(): GatewayResult<T> {
  return failed({ kind: "aborted" });
}

function serializeMutationBody(
  signal: AbortSignal,
  snapshot: () => Record<string, unknown>,
): SerializedBodyResult {
  if (signal.aborted) return aborted();
  try {
    const body = JSON.stringify(snapshot());
    if (signal.aborted) return aborted();
    return { ok: true, value: body };
  } catch {
    return signal.aborted ? aborted() : failed({ kind: "unexpected" });
  }
}

function createInvestigationBody(input: CreateInvestigationInput): Record<string, unknown> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.severity !== undefined) body.severity = input.severity;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  if (input.problemStatement !== undefined) body.problemStatement = input.problemStatement;
  if (input.affectedParties !== undefined) body.affectedParties = input.affectedParties;
  if (input.impact !== undefined) body.impact = input.impact;
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.openQuestions !== undefined) {
    body.openQuestions = Array.from(input.openQuestions, (question) => question);
  }
  if (input.investigationContext !== undefined) {
    const context = input.investigationContext;
    body.investigationContext = context === null
      ? null
      : {
          productName: context.productName,
          version: context.version,
          build: context.build,
          component: context.component,
          environment: context.environment,
          organization: context.organization,
        };
  }
  if (input.occurredAt !== undefined) body.occurredAt = input.occurredAt;
  if (input.occurredAtPrecision !== undefined) {
    body.occurredAtPrecision = input.occurredAtPrecision;
  }
  if (input.occurredAtZone !== undefined) body.occurredAtZone = input.occurredAtZone;
  return body;
}

function uploadEvidenceBody(input: UploadEvidenceInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    summary: input.summary,
  };
  if (input.filename !== undefined) body.filename = input.filename;
  if (input.mediaType !== undefined) body.mediaType = input.mediaType;
  if (input.contentBase64 !== undefined) body.contentBase64 = input.contentBase64;
  if (input.uri !== undefined) body.uri = input.uri;
  if (input.expectedHash !== undefined) body.expectedHash = input.expectedHash;
  if (input.privacyClass !== undefined) body.privacyClass = input.privacyClass;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  if (input.sourceId !== undefined) body.sourceId = input.sourceId;
  return body;
}

function uploadEvidenceStreamBody(input: UploadEvidenceStreamInput): FormData {
  const body = new FormData();
  body.append("kind", input.kind);
  body.append("summary", input.summary);
  if (input.filename !== undefined) body.append("filename", input.filename);
  if (input.mediaType !== undefined) body.append("mediaType", input.mediaType);
  if (input.expectedHash !== undefined && input.expectedHash !== null) {
    body.append("expectedHash", input.expectedHash);
  }
  if (input.privacyClass !== undefined) body.append("privacyClass", input.privacyClass);
  if (input.clientTime !== undefined) body.append("clientTime", input.clientTime);
  if (input.sourceId !== undefined) body.append("sourceId", input.sourceId);
  if (input.filename === undefined) body.append("file", input.file);
  else body.append("file", input.file, input.filename);
  return body;
}

function createContributionBody(input: CreateContributionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    body: input.body,
  };
  const hypothesisLinks = input.hypothesisLinks;
  if (hypothesisLinks !== undefined) {
    if (input.kind !== "hypothesis") {
      throw new TypeError("hypothesis links require a hypothesis contribution");
    }
    if (!Array.isArray(hypothesisLinks)) throw new TypeError("invalid hypothesis links");
    body.hypothesisLinks = Array.from(hypothesisLinks, (candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new TypeError("invalid hypothesis link");
      }
      const kind: unknown = candidate.kind;
      const id: unknown = candidate.id;
      if ((kind !== "artifact" && kind !== "contribution") || typeof id !== "string") {
        throw new TypeError("invalid hypothesis link");
      }
      return { kind, id };
    });
  }
  if (input.privacyClass !== undefined) body.privacyClass = input.privacyClass;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  if (input.sourceId !== undefined) body.sourceId = input.sourceId;
  if (input.idempotencyKey !== undefined) body.idempotencyKey = input.idempotencyKey;
  return body;
}

function createArtifactAnnotationBody(
  input: CreateArtifactAnnotationInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = { body: input.body };
  if (input.privacyClass !== undefined) body.privacyClass = input.privacyClass;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  if (input.sourceId !== undefined) body.sourceId = input.sourceId;
  if (input.idempotencyKey !== undefined) body.idempotencyKey = input.idempotencyKey;
  return body;
}

function createArtifactAnnotationsBulkBody(
  artifactIds: readonly string[],
  input: CreateArtifactAnnotationsBulkInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
    artifactIds: Array.from(artifactIds, (artifactId) => artifactId),
    body: input.body,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.privacyClass !== undefined) body.privacyClass = input.privacyClass;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  if (input.sourceId !== undefined) body.sourceId = input.sourceId;
  return body;
}

function updateSituationBody(input: UpdateSituationInput): Record<string, unknown> {
  const body: Record<string, unknown> = { expectedVersion: input.expectedVersion };
  if (input.problemStatement !== undefined) body.problemStatement = input.problemStatement;
  if (input.affectedParties !== undefined) body.affectedParties = input.affectedParties;
  if (input.impact !== undefined) body.impact = input.impact;
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.openQuestions !== undefined) {
    body.openQuestions = Array.from(input.openQuestions, (question) => question);
  }
  if (input.investigationContext !== undefined) {
    const context = input.investigationContext;
    body.investigationContext = context === null
      ? null
      : {
          productName: context.productName,
          version: context.version,
          build: context.build,
          component: context.component,
          environment: context.environment,
          organization: context.organization,
        };
  }
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  return body;
}

function lifecycleActionBody(
  investigationId: string,
  input: ApplyLifecycleActionInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId,
    action: input.action,
    expected: {
      status: input.expected.status,
      legalHold: input.expected.legalHold,
      restoreTarget: input.expected.restoreTarget,
    },
  };
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  return body;
}

function coordinationActionBody(
  investigationId: string,
  input: ApplyCoordinationActionInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
    investigationId,
    action: input.action,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.targetIdentityId !== undefined) body.targetIdentityId = input.targetIdentityId;
  if (input.clientTime !== undefined) body.clientTime = input.clientTime;
  return body;
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

async function fetchProtected(
  route: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<ResponseResult> {
  if (signal.aborted) return { ok: false, error: { kind: "aborted" } };
  try {
    const response = await protectedApiFetch(route, { ...init, signal });
    if (signal.aborted) return { ok: false, error: { kind: "aborted" } };
    return { ok: true, response };
  } catch (cause) {
    return {
      ok: false,
      error: classifyRequestException(cause, signal.aborted),
    };
  }
}

async function parseSuccessfulResponse<T>(
  response: Response,
  signal: AbortSignal,
  parser: Parser<T>,
  identity: IdentityCheck<T>,
): Promise<GatewayResult<T>> {
  if (!isJsonResponse(response)) return failed(protocolFailure("content_type"));
  if (signal.aborted) return aborted();

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return signal.aborted ? aborted() : failed(protocolFailure("json"));
  }
  if (signal.aborted) return aborted();

  let parsed: T;
  try {
    if (signal.aborted) return aborted();
    parsed = parser(raw);
  } catch (cause) {
    if (signal.aborted) return aborted();
    return cause instanceof ContractViolation
      ? failed(protocolFailure("contract"))
      : failed({ kind: "unexpected" });
  }
  if (signal.aborted) return aborted();

  let identityMatches: boolean;
  try {
    if (signal.aborted) return aborted();
    identityMatches = identity(parsed);
  } catch {
    return signal.aborted ? aborted() : failed({ kind: "unexpected" });
  }
  if (signal.aborted) return aborted();
  if (!identityMatches) return failed(protocolFailure("identity"));
  if (signal.aborted) return aborted();
  return { ok: true, value: deepFreezeDto(parsed) };
}

async function requestParsed<T>(
  route: string,
  init: RequestInit,
  signal: AbortSignal,
  parser: Parser<T>,
  identity: IdentityCheck<T>,
): Promise<GatewayResult<T>> {
  const fetched = await fetchProtected(route, init, signal);
  if (!fetched.ok) return failed(fetched.error);
  if (!fetched.response.ok) {
    return failed(classifyHttpFailure(fetched.response.status));
  }
  return parseSuccessfulResponse(fetched.response, signal, parser, identity);
}

const MAX_UPLOAD_FAILURE_BODY_BYTES = 1_024;

type BoundedFailureBody =
  | { kind: "body"; text: string }
  | { kind: "aborted" }
  | { kind: "invalid" };

function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best-effort and must never delay failure classification.
  }
}

async function readBoundedFailureBody(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_UPLOAD_FAILURE_BODY_BYTES,
): Promise<BoundedFailureBody> {
  if (signal.aborted) return { kind: "aborted" };
  if (response.body === null) return { kind: "invalid" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let wakeAbort: (() => void) | null = null;
  const abortWake = new Promise<{ kind: "aborted" }>((resolve) => {
    wakeAbort = () => resolve({ kind: "aborted" });
  });
  const onAbort = () => {
    cancelBodyReader(reader);
    wakeAbort?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortWake]);
      if ("kind" in next) return next;
      if (signal.aborted) return { kind: "aborted" };
      if (next.done) break;
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > maxBytes - byteLength) {
        cancelBodyReader(reader);
        return { kind: "invalid" };
      }
      chunks.push(chunk.slice());
      byteLength += chunk.byteLength;
    }
    if (signal.aborted) return { kind: "aborted" };
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        kind: "body",
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      return { kind: "invalid" };
    }
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "invalid" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A hostile pending read may keep the lock; cancellation above is enough.
    }
  }
}

/**
 * Parse the one bounded commit acknowledgement claim shared by mutating
 * evidence operations. Authentication loss is classified from status before
 * any body claim, including a misleading `commit_outcome_unknown`. Only the
 * bounded known code is kept; every other 503 is generic unavailable.
 */
async function parseCommitOutcomeUnknownFailure<T>(
  response: Response,
  signal: AbortSignal,
): Promise<GatewayResult<T>> {
  const generic = (): GatewayResult<T> => failed(classifyHttpFailure(response.status));
  if (response.status === 401 || response.status === 403) {
    return generic();
  }
  if (response.status !== 503) return generic();
  if (!isJsonResponse(response)) return signal.aborted ? aborted() : generic();
  if (signal.aborted) return aborted();

  const bounded = await readBoundedFailureBody(response, signal);
  if (bounded.kind === "aborted") return aborted();
  if (bounded.kind === "invalid") return generic();
  if (signal.aborted) return aborted();

  let raw: unknown;
  try {
    raw = JSON.parse(bounded.text);
  } catch {
    return generic();
  }
  if (signal.aborted) return aborted();

  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return generic();
    }
    const error: unknown = (raw as Record<string, unknown>).error;
    if (error !== "commit_outcome_unknown") return generic();
    if (signal.aborted) return aborted();
    return failed(classifyHttpFailure(503, { kind: "commit_outcome_unknown" }));
  } catch {
    return signal.aborted ? aborted() : failed({ kind: "unexpected" });
  }
}

async function parseUploadFailure(
  response: Response,
  signal: AbortSignal,
): Promise<GatewayResult<EvidenceUploadSuccessV1>> {
  return parseCommitOutcomeUnknownFailure<EvidenceUploadSuccessV1>(response, signal);
}

function caseCollectionIdentity(cases: readonly CaseV1[]): boolean {
  const identities = new Set<string>();
  for (const investigation of cases) {
    if (investigation.id.length === 0 || identities.has(investigation.id)) return false;
    identities.add(investigation.id);
  }
  return true;
}

function investigationCollectionPageIdentity(page: InvestigationCollectionPageV1): boolean {
  const identities = new Set<string>();
  for (const item of page.items) {
    if (item.id.length === 0 || identities.has(item.id)) return false;
    identities.add(item.id);
  }
  return true;
}

function investigationOperationsQueuePageIdentity(
  page: InvestigationOperationsQueuePageV1,
): boolean {
  const identities = new Set<string>();
  for (const item of page.items) {
    const investigationId = item.investigation.id;
    if (
      investigationId.length === 0
      || identities.has(investigationId)
      || item.coordination.investigationId !== investigationId
      || item.coordination.archived !== (item.investigation.status === "archived")
    ) return false;
    identities.add(investigationId);
  }
  return true;
}

const COLLECTION_QUERY_FILTER_KEYS = [
  "q",
  "status",
  "includeArchived",
  "entityId",
  "impactIdentity",
  "contributorId",
  "recordedFrom",
  "recordedTo",
  "limit",
  "cursor",
] as const;

function snapshotImpactIdentity(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const identity = value as Record<string, unknown>;
  return {
    productName: identity.productName,
    version: identity.version,
    build: identity.build,
    component: identity.component,
    environment: identity.environment,
  };
}

/**
 * Copy only contract-approved filters. Inherited and unknown keys are dropped
 * so a later serializer cannot opt into ranking or a second schema.
 */
export function snapshotInvestigationCollectionQueryInput(
  input: InvestigationCollectionQueryInput,
): InvestigationCollectionQueryInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Object.freeze({ q: "\u0000" });
  }
  const record = input as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  if (record.q !== undefined) snapshot.q = record.q;
  if (record.status !== undefined) {
    snapshot.status = Array.isArray(record.status) ? Array.from(record.status) : record.status;
  }
  if (record.includeArchived !== undefined) snapshot.includeArchived = record.includeArchived;
  if (record.entityId !== undefined) snapshot.entityId = record.entityId;
  if (record.impactIdentity !== undefined) {
    snapshot.impactIdentity = snapshotImpactIdentity(record.impactIdentity);
  }
  if (record.contributorId !== undefined) snapshot.contributorId = record.contributorId;
  if (record.recordedFrom !== undefined) snapshot.recordedFrom = record.recordedFrom;
  if (record.recordedTo !== undefined) snapshot.recordedTo = record.recordedTo;
  if (record.limit !== undefined) snapshot.limit = record.limit;
  if (record.cursor !== undefined) snapshot.cursor = record.cursor;
  return deepFreezeDto(snapshot) as InvestigationCollectionQueryInput;
}

export function parseInvestigationCollectionQueryInput(
  input: InvestigationCollectionQueryInput,
): GatewayResult<InvestigationCollectionQueryV1> {
  try {
    const snapshot = snapshotInvestigationCollectionQueryInput(input);
    const body: Record<string, unknown> = {
      schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
    };
    const record = snapshot as Record<string, unknown>;
    for (const key of COLLECTION_QUERY_FILTER_KEYS) {
      if (record[key] !== undefined) body[key] = record[key];
    }
    return { ok: true, value: deepFreezeDto(parseInvestigationCollectionQuery(body)) };
  } catch (cause) {
    return cause instanceof ContractViolation
      ? failed(protocolFailure("contract"))
      : failed({ kind: "unexpected" });
  }
}

function serializeInvestigationCollectionQuery(
  query: InvestigationCollectionQueryV1,
): string {
  const params = new URLSearchParams();
  params.set("schemaId", query.schemaId);
  if (query.q !== "") params.set("q", query.q);
  for (const status of query.status) params.append("status", status);
  if (query.includeArchived) params.set("includeArchived", "true");
  if (query.entityId !== null) params.set("entityId", query.entityId);
  if (query.impactIdentity !== null) {
    params.set("impactIdentity", JSON.stringify({
      productName: query.impactIdentity.productName,
      version: query.impactIdentity.version,
      build: query.impactIdentity.build,
      component: query.impactIdentity.component,
      environment: query.impactIdentity.environment,
    }));
  }
  if (query.contributorId !== null) params.set("contributorId", query.contributorId);
  if (query.recordedFrom !== null) params.set("recordedFrom", query.recordedFrom);
  if (query.recordedTo !== null) params.set("recordedTo", query.recordedTo);
  if (query.limit !== INVESTIGATION_COLLECTION_LIMITS.defaultLimit) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor !== null) params.set("cursor", query.cursor);
  return params.toString();
}

export function investigationCollectionQueryKeyFromInput(
  input: InvestigationCollectionQueryInput | null,
): string | null {
  if (input === null) return null;
  const parsed = parseInvestigationCollectionQueryInput(input);
  return parsed.ok ? investigationCollectionQueryKey(parsed.value) : "invalid";
}

export function investigationCollectionQueryKey(
  query: InvestigationCollectionQueryV1,
): string {
  return JSON.stringify({
    q: query.q,
    status: [...query.status].sort(),
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    impactIdentity: query.impactIdentity === null
      ? null
      : {
          productName: query.impactIdentity.productName,
          version: query.impactIdentity.version,
          build: query.impactIdentity.build,
          component: query.impactIdentity.component,
          environment: query.impactIdentity.environment,
        },
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
    cursor: query.cursor,
    limit: query.limit,
  });
}

const OPERATIONS_QUEUE_QUERY_FILTER_KEYS = [
  ...COLLECTION_QUERY_FILTER_KEYS,
  "coordinationScope",
] as const;

/**
 * Snapshot only queue-contract fields. Unknown workload, ranking, actor, and
 * assignment inputs cannot become query parameters later.
 */
export function snapshotInvestigationOperationsQueueQueryInput(
  input: InvestigationOperationsQueueQueryInput,
): InvestigationOperationsQueueQueryInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Object.freeze({ q: "\u0000" });
  }
  const collection = snapshotInvestigationCollectionQueryInput(input);
  const record = input as Record<string, unknown>;
  return deepFreezeDto({
    ...collection,
    ...(record.coordinationScope === undefined
      ? {}
      : { coordinationScope: record.coordinationScope }),
  }) as InvestigationOperationsQueueQueryInput;
}

export function parseInvestigationOperationsQueueQueryInput(
  input: InvestigationOperationsQueueQueryInput,
): GatewayResult<InvestigationOperationsQueueQueryV1> {
  try {
    const snapshot = snapshotInvestigationOperationsQueueQueryInput(input);
    const body: Record<string, unknown> = {
      schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
    };
    const record = snapshot as Record<string, unknown>;
    for (const key of OPERATIONS_QUEUE_QUERY_FILTER_KEYS) {
      if (record[key] !== undefined) body[key] = record[key];
    }
    return {
      ok: true,
      value: deepFreezeDto(parseInvestigationOperationsQueueQuery(body)),
    };
  } catch (cause) {
    return cause instanceof ContractViolation
      ? failed(protocolFailure("contract"))
      : failed({ kind: "unexpected" });
  }
}

function serializeInvestigationOperationsQueueQuery(
  query: InvestigationOperationsQueueQueryV1,
): string {
  const params = new URLSearchParams();
  params.set("schemaId", query.schemaId);
  if (query.q !== "") params.set("q", query.q);
  for (const status of query.status) params.append("status", status);
  if (query.includeArchived) params.set("includeArchived", "true");
  if (query.entityId !== null) params.set("entityId", query.entityId);
  if (query.impactIdentity !== null) {
    params.set("impactIdentity", JSON.stringify({
      productName: query.impactIdentity.productName,
      version: query.impactIdentity.version,
      build: query.impactIdentity.build,
      component: query.impactIdentity.component,
      environment: query.impactIdentity.environment,
    }));
  }
  if (query.contributorId !== null) params.set("contributorId", query.contributorId);
  if (query.recordedFrom !== null) params.set("recordedFrom", query.recordedFrom);
  if (query.recordedTo !== null) params.set("recordedTo", query.recordedTo);
  params.set("coordinationScope", query.coordinationScope);
  if (query.limit !== INVESTIGATION_OPERATIONS_QUEUE_LIMITS.defaultLimit) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor !== null) params.set("cursor", query.cursor);
  return params.toString();
}

export function investigationOperationsQueueQueryKeyFromInput(
  input: InvestigationOperationsQueueQueryInput | null,
): string | null {
  if (input === null) return null;
  const parsed = parseInvestigationOperationsQueueQueryInput(input);
  return parsed.ok ? investigationOperationsQueueQueryKey(parsed.value) : "invalid";
}

export function investigationOperationsQueueQueryKey(
  query: InvestigationOperationsQueueQueryV1,
): string {
  return JSON.stringify({
    q: query.q,
    status: [...query.status].sort(),
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    impactIdentity: query.impactIdentity === null
      ? null
      : {
          productName: query.impactIdentity.productName,
          version: query.impactIdentity.version,
          build: query.impactIdentity.build,
          component: query.impactIdentity.component,
          environment: query.impactIdentity.environment,
        },
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
    coordinationScope: query.coordinationScope,
    cursor: query.cursor,
    limit: query.limit,
  });
}

function evidenceCollectionIdentity(
  investigationId: string,
  artifacts: readonly ArtifactV1[],
): boolean {
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    if (
      artifact.caseId !== investigationId
      || artifact.id.length === 0
      || identities.has(artifact.id)
    ) return false;
    identities.add(artifact.id);
  }
  return true;
}

const EVIDENCE_PREVIEW_LIMIT_BYTES = 65_536;
const EVIDENCE_PREVIEW_RANGE = `bytes=0-${EVIDENCE_PREVIEW_LIMIT_BYTES - 1}`;

function previewContentRange(
  header: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total < end + 1)) return null;
  return { start, end, total };
}

function previewContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readBoundedPreview(
  response: Response,
  signal: AbortSignal,
): Promise<GatewayResult<{ bytes: Uint8Array; truncated: boolean; received: number }>> {
  if (signal.aborted) return aborted();
  const declared = previewContentLength(response);
  if (declared !== null && declared > EVIDENCE_PREVIEW_LIMIT_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cancellation of a server that ignored the range request.
    }
    return failed(protocolFailure("content_type"));
  }
  const body = response.body;
  if (body === null || typeof body.getReader !== "function") {
    return failed(protocolFailure("content_type"));
  }
  const reader = body.getReader();
  const bounded = new Uint8Array(EVIDENCE_PREVIEW_LIMIT_BYTES);
  let received = 0;
  let truncated = false;
  const onAbort = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Best-effort cancellation; fetch has already observed the same signal.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) return aborted();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || chunk.byteLength === 0) continue;
      const remaining = EVIDENCE_PREVIEW_LIMIT_BYTES - received;
      const retained = Math.min(remaining, chunk.byteLength);
      if (retained > 0) {
        bounded.set(chunk.subarray(0, retained), received);
        received += retained;
      }
      if (chunk.byteLength > remaining) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // The bytes already retained are still a valid bounded preview.
        }
        break;
      }
    }
  } catch {
    return signal.aborted ? aborted() : failed(protocolFailure("content_type"));
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A canceled stream may already have released its reader.
    }
  }
  return { ok: true, value: { bytes: bounded.subarray(0, received), truncated, received } };
}

function decodeBoundedPreview(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\uFFFD") ? null : text;
  } catch {
    return null;
  }
}

function contributionCollectionIdentity(
  investigationId: string,
  contributions: readonly ContributionV1[],
): boolean {
  const identities = new Set<string>();
  for (const contribution of contributions) {
    if (
      contribution.caseId !== investigationId
      || contribution.id.length === 0
      || identities.has(contribution.id)
    ) return false;
    identities.add(contribution.id);
  }
  return true;
}

function annotationCollectionIdentity(
  investigationId: string,
  annotations: readonly ArtifactAnnotationV1[],
): boolean {
  const identities = new Set<string>();
  for (const annotation of annotations) {
    if (
      annotation.caseId !== investigationId
      || annotation.id.length === 0
      || annotation.artifactId.length === 0
      || identities.has(annotation.id)
    ) return false;
    identities.add(annotation.id);
  }
  return true;
}

/**
 * Bind a bulk acknowledgement to exactly the set the caller submitted.
 * Contract parsing validates each row, while this check prevents a valid
 * annotation from another target (or an omitted target) crossing the runtime
 * boundary.
 */
function annotationBulkIdentity(
  investigationId: string,
  artifactIds: readonly string[],
  result: ArtifactAnnotationBulkResultV1,
): boolean {
  const requested = new Set<string>();
  for (const artifactId of artifactIds) {
    if (typeof artifactId !== "string" || artifactId.length === 0 || requested.has(artifactId)) {
      return false;
    }
    requested.add(artifactId);
  }
  if (result.caseId !== investigationId || result.items.length !== requested.size) return false;

  const returned = new Set<string>();
  for (const item of result.items) {
    if (
      typeof item.artifactId !== "string"
      || !requested.has(item.artifactId)
      || returned.has(item.artifactId)
    ) return false;
    returned.add(item.artifactId);
    if (item.outcome === "not_found") continue;
    if (
      item.annotation.caseId !== investigationId
      || item.annotation.artifactId !== item.artifactId
      || item.annotation.id.length === 0
    ) return false;
  }
  return returned.size === requested.size;
}

function caseRoute(investigationId: string, suffix = ""): string {
  return `/api/cases/${encodeURIComponent(investigationId)}${suffix}`;
}

async function parseLifecycleConflict(
  response: Response,
  investigationId: string,
  action: LifecycleAction,
  signal: AbortSignal,
): Promise<GatewayResult<InvestigationLifecycleActionSuccessV1>> {
  const genericConflict = (): GatewayResult<InvestigationLifecycleActionSuccessV1> =>
    failed({ kind: "conflict", status: 409 });
  if (!isJsonResponse(response)) return signal.aborted ? aborted() : genericConflict();
  if (signal.aborted) return aborted();

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return signal.aborted ? aborted() : genericConflict();
  }
  if (signal.aborted) return aborted();

  let schemaId: unknown;
  let error: unknown;
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return genericConflict();
    }
    const record = raw as Record<string, unknown>;
    schemaId = record.schemaId;
    error = record.error;
  } catch {
    return signal.aborted ? aborted() : failed({ kind: "unexpected" });
  }
  if (signal.aborted) return aborted();

  const claimsChanged = schemaId === INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID
    || error === "lifecycle_changed";
  const claimsRefused = schemaId === INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID
    || error === "lifecycle_refused";
  if (!claimsChanged && !claimsRefused) return genericConflict();
  if (claimsChanged && claimsRefused) return failed(protocolFailure("contract"));

  try {
    if (signal.aborted) return aborted();
    if (claimsChanged) {
      const changed = parseInvestigationLifecycleChanged(raw);
      if (signal.aborted) return aborted();
      if (changed.investigationId !== investigationId || changed.action !== action) {
        return failed(protocolFailure("identity"));
      }
      if (signal.aborted) return aborted();
      return failed({
        kind: "lifecycle_changed",
        status: 409,
        investigationId: changed.investigationId,
        action: changed.action,
        current: deepFreezeDto(changed.current),
      });
    }

    const refusal = parseInvestigationLifecycleActionRefused(raw);
    if (signal.aborted) return aborted();
    if (refusal.investigationId !== investigationId || refusal.action !== action) {
      return failed(protocolFailure("identity"));
    }
    if (signal.aborted) return aborted();
    return failed(classifyHttpFailure(409, {
      kind: "lifecycle_refused",
      action: refusal.action,
      reason: refusal.reason,
      detail: refusal.detail,
    }));
  } catch (cause) {
    if (signal.aborted) return aborted();
    return cause instanceof ContractViolation
      ? failed(protocolFailure("contract"))
      : failed({ kind: "unexpected" });
  }
}

const MAX_COORDINATION_FAILURE_BODY_BYTES = 8_192;

function coordinationIntentTarget(
  request: InvestigationCoordinationActionRequestV1,
): string | null {
  return request.targetIdentityId ?? null;
}

function coordinationEnvelopeIdentity(
  investigationId: string,
  request: InvestigationCoordinationActionRequestV1,
  response: {
    readonly investigationId: string;
    readonly action: InvestigationCoordinationActionRequestV1["action"];
    readonly targetIdentityId: string | null;
  },
): boolean {
  return request.investigationId === investigationId
    && response.investigationId === investigationId
    && response.action === request.action
    && response.targetIdentityId === coordinationIntentTarget(request);
}

function coordinationSuccessIdentity(
  investigationId: string,
  request: InvestigationCoordinationActionRequestV1,
  actorIdentityId: string,
  response: InvestigationCoordinationActionSuccessV1,
): boolean {
  if (
    actorIdentityId.length === 0
    || !coordinationEnvelopeIdentity(investigationId, request, response)
    || response.applied.updatedBy?.identityId !== actorIdentityId
  ) return false;
  if (request.action === "claim_self") {
    return response.applied.coordinator?.identityId === actorIdentityId;
  }
  if (request.action === "release_self") {
    return response.previousCoordinator?.identityId === actorIdentityId;
  }
  return true;
}

async function parseCoordinationConflict(
  response: Response,
  investigationId: string,
  request: InvestigationCoordinationActionRequestV1,
  actorIdentityId: string,
  signal: AbortSignal,
): Promise<GatewayResult<InvestigationCoordinationActionSuccessV1>> {
  const genericConflict = (): GatewayResult<InvestigationCoordinationActionSuccessV1> =>
    failed({ kind: "conflict", status: 409 });
  if (!isJsonResponse(response)) return signal.aborted ? aborted() : genericConflict();
  const bounded = await readBoundedFailureBody(
    response,
    signal,
    MAX_COORDINATION_FAILURE_BODY_BYTES,
  );
  if (bounded.kind === "aborted") return aborted();
  if (bounded.kind === "invalid") return genericConflict();

  let raw: unknown;
  try {
    raw = JSON.parse(bounded.text);
  } catch {
    return genericConflict();
  }
  if (signal.aborted) return aborted();

  let schemaId: unknown;
  let error: unknown;
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return genericConflict();
    }
    const record = raw as Record<string, unknown>;
    schemaId = record.schemaId;
    error = record.error;
  } catch {
    return signal.aborted ? aborted() : failed({ kind: "unexpected" });
  }
  const claimsChanged = schemaId === INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID
    || error === "coordination_changed";
  const claimsRefused = schemaId === INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID
    || error === "coordination_refused";
  if (!claimsChanged && !claimsRefused) return genericConflict();
  if (claimsChanged && claimsRefused) return failed(protocolFailure("contract"));

  try {
    if (claimsChanged) {
      const changed = parseInvestigationCoordinationChanged(raw);
      if (!coordinationEnvelopeIdentity(investigationId, request, changed)) {
        return failed(protocolFailure("identity"));
      }
      if (
        changed.current.revision === request.expectedRevision
        || (request.action === "release_self"
          && changed.current.coordinator?.identityId !== actorIdentityId)
      ) return failed(protocolFailure("identity"));
      return failed(deepFreezeDto({
        kind: "coordination_changed",
        status: 409,
        investigationId: changed.investigationId,
        action: changed.action,
        targetIdentityId: changed.targetIdentityId,
        current: changed.current,
      }));
    }

    const refusal = parseInvestigationCoordinationActionRefused(raw);
    if (!coordinationEnvelopeIdentity(investigationId, request, refusal)) {
      return failed(protocolFailure("identity"));
    }
    const holder = refusal.current.coordinator?.identityId ?? null;
    if (
      (request.action === "claim_self"
        && refusal.reason === "already_coordinator"
        && holder !== actorIdentityId)
      || (request.action === "claim_self"
        && refusal.reason === "occupied"
        && (holder === null || holder === actorIdentityId))
      || (request.action === "release_self"
        && refusal.reason === "not_coordinator"
        && holder === actorIdentityId)
    ) return failed(protocolFailure("identity"));
    return failed(deepFreezeDto({
      kind: "coordination_refused",
      status: 409,
      investigationId: refusal.investigationId,
      action: refusal.action,
      targetIdentityId: refusal.targetIdentityId,
      reason: refusal.reason,
      detail: refusal.detail,
      current: refusal.current,
    }));
  } catch (cause) {
    if (signal.aborted) return aborted();
    return cause instanceof ContractViolation
      ? failed(protocolFailure("contract"))
      : failed({ kind: "unexpected" });
  }
}

/**
 * The answer every write seam gives when the transport does not implement it.
 *
 * A missing seam is reported, never ignored: the command still runs, still
 * fences, and still publishes a bounded failure, so an absent capability can
 * never be mistaken for a completed write.
 */
const WRITE_SEAM_UNAVAILABLE: RuntimeFailure = Object.freeze({
  kind: "unavailable",
  status: 503,
});

const QUERY_SEAM_UNAVAILABLE: RuntimeFailure = Object.freeze({
  kind: "unavailable",
  status: 503,
});

const UNAVAILABLE_WRITE_GATEWAY: InvestigationWriteGateway = Object.freeze({
  createContribution: () =>
    Promise.resolve(failed<ContributionV1>(WRITE_SEAM_UNAVAILABLE)),
  updateSituation: () => Promise.resolve(failed<CaseV1>(WRITE_SEAM_UNAVAILABLE)),
});

const UNAVAILABLE_ANNOTATION_GATEWAY: InvestigationAnnotationGateway = Object.freeze({
  listArtifactAnnotations: () =>
    Promise.resolve(failed<readonly ArtifactAnnotationV1[]>(WRITE_SEAM_UNAVAILABLE)),
  createArtifactAnnotation: () =>
    Promise.resolve(failed<ArtifactAnnotationV1>(WRITE_SEAM_UNAVAILABLE)),
});

const UNAVAILABLE_BULK_ANNOTATION_GATEWAY: InvestigationBulkAnnotationGateway = Object.freeze({
  createArtifactAnnotationsBulk: () =>
    Promise.resolve(failed<ArtifactAnnotationBulkResultV1>(WRITE_SEAM_UNAVAILABLE)),
});

const UNAVAILABLE_COLLECTION_QUERY_GATEWAY: InvestigationCollectionQueryGateway = Object.freeze({
  queryInvestigations: () =>
    Promise.resolve(failed<InvestigationCollectionPageV1>(QUERY_SEAM_UNAVAILABLE)),
});

const UNAVAILABLE_COORDINATION_GATEWAY: InvestigationCoordinationGateway = Object.freeze({
  getCoordination: () =>
    Promise.resolve(failed<InvestigationCoordinationV1>(WRITE_SEAM_UNAVAILABLE)),
  applyCoordinationAction: () =>
    Promise.resolve(failed<InvestigationCoordinationActionSuccessV1>(WRITE_SEAM_UNAVAILABLE)),
});

const UNAVAILABLE_OPERATIONS_QUEUE_GATEWAY: InvestigationOperationsQueueGateway = Object.freeze({
  queryOperationsQueue: () =>
    Promise.resolve(failed<InvestigationOperationsQueuePageV1>(QUERY_SEAM_UNAVAILABLE)),
});

/**
 * Resolve the write seams a gateway actually implements.
 *
 * Both seams are checked together, so a half-implemented transport cannot
 * expose one write while the other silently disappears. Nothing here asserts a
 * shape it has not observed: unless the gateway carries both seams, every
 * write resolves to the fail-closed adapter above.
 */
export function investigationWriteGateway(
  gateway: InvestigationGateway,
): InvestigationWriteGateway {
  const { createContribution, updateSituation } = gateway;
  if (createContribution === undefined || updateSituation === undefined) {
    return UNAVAILABLE_WRITE_GATEWAY;
  }
  const resolved: InvestigationWriteGateway = {
    createContribution(investigationId, input, options) {
      return createContribution.call(gateway, investigationId, input, options);
    },
    updateSituation(investigationId, input, options) {
      return updateSituation.call(gateway, investigationId, input, options);
    },
  };
  return Object.freeze(resolved);
}

/**
 * Resolve the complete artifact-annotation seam or expose an unavailable
 * adapter. Keeping the list and append operations together prevents a
 * partially upgraded transport from making the UI believe it can annotate
 * records that it cannot subsequently read.
 */
export function investigationAnnotationGateway(
  gateway: InvestigationGateway,
): InvestigationAnnotationGateway {
  const { listArtifactAnnotations, createArtifactAnnotation } = gateway;
  if (listArtifactAnnotations === undefined || createArtifactAnnotation === undefined) {
    return UNAVAILABLE_ANNOTATION_GATEWAY;
  }
  const resolved: InvestigationAnnotationGateway = {
    listArtifactAnnotations(investigationId, options) {
      return listArtifactAnnotations.call(gateway, investigationId, options);
    },
    createArtifactAnnotation(investigationId, artifactId, input, options) {
      return createArtifactAnnotation.call(
        gateway,
        investigationId,
        artifactId,
        input,
        options,
      );
    },
  };
  resolved.createArtifactAnnotationsBulk = gateway.createArtifactAnnotationsBulk === undefined
    ? UNAVAILABLE_BULK_ANNOTATION_GATEWAY.createArtifactAnnotationsBulk
    : function createArtifactAnnotationsBulk(investigationId, input, options) {
        return gateway.createArtifactAnnotationsBulk!.call(
          gateway,
          investigationId,
          input,
          options,
        );
      };
  return Object.freeze(resolved);
}

/**
 * Resolve the optional atomic set method independently of the legacy
 * per-artifact pair. Older test doubles remain valid, but any attempt to use
 * the bulk command against one is reported as unavailable rather than
 * fanning out through the singular method.
 */
export function investigationBulkAnnotationGateway(
  gateway: InvestigationGateway,
): InvestigationBulkAnnotationGateway {
  const createArtifactAnnotationsBulk = gateway.createArtifactAnnotationsBulk;
  if (createArtifactAnnotationsBulk === undefined) return UNAVAILABLE_BULK_ANNOTATION_GATEWAY;
  const resolved: InvestigationBulkAnnotationGateway = {
    createArtifactAnnotationsBulk(investigationId, input, options) {
      return createArtifactAnnotationsBulk.call(gateway, investigationId, input, options);
    },
  };
  return Object.freeze(resolved);
}

/**
 * Resolve the optional collection-query method independently of the legacy
 * unpaged list. Older test doubles remain valid, but a query request against
 * one is reported as unavailable rather than rewritten as `listInvestigations`.
 */
export function investigationCollectionQueryGateway(
  gateway: InvestigationGateway,
): InvestigationCollectionQueryGateway {
  const queryInvestigations = gateway.queryInvestigations;
  if (queryInvestigations === undefined) return UNAVAILABLE_COLLECTION_QUERY_GATEWAY;
  const resolved: InvestigationCollectionQueryGateway = {
    queryInvestigations(query, options) {
      return queryInvestigations.call(gateway, query, options);
    },
  };
  return Object.freeze(resolved);
}

/** Resolve coordination only when both its read and action methods exist. */
export function investigationCoordinationGateway(
  gateway: InvestigationGateway,
): InvestigationCoordinationGateway {
  const { getCoordination, applyCoordinationAction } = gateway;
  if (getCoordination === undefined || applyCoordinationAction === undefined) {
    return UNAVAILABLE_COORDINATION_GATEWAY;
  }
  const resolved: InvestigationCoordinationGateway = {
    getCoordination(investigationId, options) {
      return getCoordination.call(gateway, investigationId, options);
    },
    applyCoordinationAction(investigationId, input, options) {
      return applyCoordinationAction.call(gateway, investigationId, input, options);
    },
  };
  return Object.freeze(resolved);
}

/**
 * Resolve the queue read independently. Older transports remain valid, but a
 * queue request can never be rewritten as either legacy collection request.
 */
export function investigationOperationsQueueGateway(
  gateway: InvestigationGateway,
): InvestigationOperationsQueueGateway {
  const queryOperationsQueue = gateway.queryOperationsQueue;
  if (queryOperationsQueue === undefined) return UNAVAILABLE_OPERATIONS_QUEUE_GATEWAY;
  const resolved: InvestigationOperationsQueueGateway = {
    queryOperationsQueue(query, options) {
      return queryOperationsQueue.call(gateway, query, options);
    },
  };
  return Object.freeze(resolved);
}

export const investigationGateway: InvestigationGatewayWithWrites
  & InvestigationCollectionQueryGateway
  & InvestigationCoordinationGateway
  & InvestigationOperationsQueueGateway = {
  async listInvestigations({ signal }) {
    const result = await requestParsed(
      "/api/cases",
      {},
      signal,
      parseCaseList,
      (value) => caseCollectionIdentity(value.cases),
    );
    return result.ok
      ? { ok: true, value: deepFreezeDto([...result.value.cases]) }
      : result;
  },

  async queryInvestigations(input, { signal }) {
    if (signal.aborted) return aborted();
    const parsed = parseInvestigationCollectionQueryInput(input);
    if (signal.aborted) return aborted();
    if (!parsed.ok) return parsed;
    let search: string;
    try {
      if (signal.aborted) return aborted();
      search = serializeInvestigationCollectionQuery(parsed.value);
    } catch {
      return signal.aborted ? aborted() : failed({ kind: "unexpected" });
    }
    if (signal.aborted) return aborted();
    return requestParsed(
      `/api/cases?${search}`,
      {},
      signal,
      parseInvestigationCollectionPage,
      investigationCollectionPageIdentity,
    );
  },

  async queryOperationsQueue(input, { signal }) {
    if (signal.aborted) return aborted();
    const parsed = parseInvestigationOperationsQueueQueryInput(input);
    if (signal.aborted) return aborted();
    if (!parsed.ok) return parsed;
    let search: string;
    try {
      if (signal.aborted) return aborted();
      search = serializeInvestigationOperationsQueueQuery(parsed.value);
    } catch {
      return signal.aborted ? aborted() : failed({ kind: "unexpected" });
    }
    if (signal.aborted) return aborted();
    return requestParsed(
      `/api/cases?${search}`,
      {},
      signal,
      parseInvestigationOperationsQueuePage,
      investigationOperationsQueuePageIdentity,
    );
  },

  getInvestigation(investigationId, { signal }) {
    return requestParsed(
      caseRoute(investigationId),
      {},
      signal,
      parseCase,
      (value) => value.id === investigationId,
    );
  },

  createInvestigation(input, { signal }) {
    const serialized = serializeMutationBody(signal, () => createInvestigationBody(input));
    if (!serialized.ok) return Promise.resolve(failed(serialized.error));
    return requestParsed(
      "/api/cases",
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
      parseCase,
      (value) => value.id.length > 0,
    );
  },

  async listEvidence(investigationId, { signal }) {
    const result = await requestParsed(
      caseRoute(investigationId, "/evidence"),
      {},
      signal,
      parseEvidenceList,
      (value) => value.caseId === investigationId
        && evidenceCollectionIdentity(investigationId, value.artifacts),
    );
    return result.ok
      ? { ok: true, value: deepFreezeDto([...result.value.artifacts]) }
      : result;
  },

  async listArtifactAnnotations(investigationId, { signal }) {
    const result = await requestParsed(
      caseRoute(investigationId, "/evidence/annotations"),
      {},
      signal,
      parseArtifactAnnotationList,
      (value) => value.caseId === investigationId
        && annotationCollectionIdentity(investigationId, value.annotations),
    );
    return result.ok
      ? { ok: true, value: deepFreezeDto([...result.value.annotations]) }
      : result;
  },

  async createArtifactAnnotationsBulk(investigationId, input, { signal }) {
    let artifactIds: readonly string[];
    try {
      // Snapshot the target set before serialization and before the request
      // starts. A caller cannot mutate the identity we validate while fetch
      // is in flight.
      artifactIds = Object.freeze(Array.from(input.artifactIds, (artifactId) => artifactId));
    } catch {
      return signal.aborted ? aborted() : failed({ kind: "unexpected" });
    }
    const serialized = serializeMutationBody(
      signal,
      () => createArtifactAnnotationsBulkBody(artifactIds, input),
    );
    if (!serialized.ok) return failed(serialized.error);
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/evidence/annotations"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    if (!fetched.response.ok) {
      return parseCommitOutcomeUnknownFailure<ArtifactAnnotationBulkResultV1>(
        fetched.response,
        signal,
      );
    }
    return parseSuccessfulResponse(
      fetched.response,
      signal,
      parseArtifactAnnotationBulkResult,
      (value) => annotationBulkIdentity(investigationId, artifactIds, value),
    );
  },

  async previewEvidence(investigationId, artifactId, input, { signal }) {
    const headers: Record<string, string> = { Range: EVIDENCE_PREVIEW_RANGE };
    if (input.ifNoneMatch !== undefined) headers["If-None-Match"] = input.ifNoneMatch;
    const fetched = await fetchProtected(
      caseRoute(investigationId, `/evidence/${encodeURIComponent(artifactId)}/content`),
      { headers },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    const response = fetched.response;
    if (response.status === 304) {
      const etag = response.headers.get("etag");
      return {
        ok: true,
        value: deepFreezeDto({
          artifactId,
          text: "",
          truncated: false,
          etag,
          notModified: true as const,
        }),
      };
    }
    if (!response.ok) return failed(classifyHttpFailure(response.status));
    if (response.status !== 200 && response.status !== 206) {
      return failed({ kind: "unexpected_response", status: response.status });
    }
    const contentRange = previewContentRange(response.headers.get("content-range"));
    if (response.status === 206 && (!contentRange || contentRange.start !== 0)) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort stop after an invalid range representation.
      }
      return failed(protocolFailure("content_type"));
    }
    const bytes = await readBoundedPreview(response, signal);
    if (!bytes.ok) return bytes;
    const text = decodeBoundedPreview(bytes.value.bytes);
    if (text === null) return failed(protocolFailure("content_type"));
    const total = contentRange?.total ?? null;
    const covered = contentRange === null
      ? bytes.value.received
      : contentRange.end - contentRange.start + 1;
    const truncated = bytes.value.truncated
      || (total !== null && total > covered)
      || (total !== null && total > EVIDENCE_PREVIEW_LIMIT_BYTES);
    return {
      ok: true,
      value: deepFreezeDto({
        artifactId,
        text,
        truncated,
        etag: response.headers.get("etag"),
      }),
    };
  },

  async listContributions(investigationId, { signal }) {
    const result = await requestParsed(
      caseRoute(investigationId, "/contributions"),
      {},
      signal,
      parseContributionList,
      (value) => value.caseId === investigationId
        && contributionCollectionIdentity(investigationId, value.contributions),
    );
    return result.ok
      ? { ok: true, value: deepFreezeDto([...result.value.contributions]) }
      : result;
  },

  async uploadEvidence(investigationId, input, { signal }) {
    const serialized = serializeMutationBody(signal, () => uploadEvidenceBody(input));
    if (!serialized.ok) return failed(serialized.error);
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/evidence"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    if (!fetched.response.ok) {
      return parseUploadFailure(fetched.response, signal);
    }
    return parseSuccessfulResponse(
      fetched.response,
      signal,
      parseEvidenceUploadSuccess,
      (value) => value.caseId === investigationId
        && value.artifact.caseId === investigationId
        && value.summary.caseId === investigationId
        && value.artifact.id.length > 0
        && value.summary.id.length > 0,
    );
  },

  async uploadEvidenceStream(investigationId, input, { signal }) {
    let body: FormData;
    try {
      if (signal.aborted) return aborted();
      body = uploadEvidenceStreamBody(input);
    } catch {
      return signal.aborted ? aborted() : failed({ kind: "unexpected" });
    }
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/evidence/stream"),
      { method: "POST", body },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    if (!fetched.response.ok) return parseUploadFailure(fetched.response, signal);
    return parseSuccessfulResponse(
      fetched.response,
      signal,
      parseEvidenceUploadSuccess,
      (value) => value.caseId === investigationId
        && value.artifact.caseId === investigationId
        && value.summary.caseId === investigationId
        && value.artifact.id.length > 0
        && value.summary.id.length > 0,
    );
  },

  createContribution(investigationId, input, { signal }) {
    const serialized = serializeMutationBody(signal, () => createContributionBody(input));
    if (!serialized.ok) return Promise.resolve(failed(serialized.error));
    return requestParsed(
      caseRoute(investigationId, "/contributions"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
      parseContribution,
      (value) => value.caseId === investigationId && value.id.length > 0,
    );
  },

  createArtifactAnnotation(investigationId, artifactId, input, { signal }) {
    const serialized = serializeMutationBody(signal, () => createArtifactAnnotationBody(input));
    if (!serialized.ok) return Promise.resolve(failed(serialized.error));
    const route = caseRoute(
      investigationId,
      `/evidence/${encodeURIComponent(artifactId)}/annotations`,
    );
    return (async () => {
      const fetched = await fetchProtected(
        route,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: serialized.value,
        },
        signal,
      );
      if (!fetched.ok) return failed(fetched.error);
      if (!fetched.response.ok) {
        return parseCommitOutcomeUnknownFailure<ArtifactAnnotationV1>(fetched.response, signal);
      }
      return parseSuccessfulResponse(
        fetched.response,
        signal,
        parseArtifactAnnotation,
        (value) => value.caseId === investigationId
          && value.artifactId === artifactId
          && value.id.length > 0,
      );
    })();
  },

  updateSituation(investigationId, input, { signal }) {
    const serialized = serializeMutationBody(signal, () => updateSituationBody(input));
    if (!serialized.ok) return Promise.resolve(failed(serialized.error));
    return requestParsed(
      caseRoute(investigationId, "/situation"),
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
      parseCase,
      (value) => value.id === investigationId,
    );
  },

  getLifecycle(investigationId, { signal }) {
    return requestParsed(
      caseRoute(investigationId, "/lifecycle"),
      {},
      signal,
      parseInvestigationLifecycle,
      (value) => value.investigationId === investigationId,
    );
  },

  async applyLifecycleAction(investigationId, input, { signal }) {
    const serialized = serializeMutationBody(
      signal,
      () => lifecycleActionBody(investigationId, input),
    );
    if (!serialized.ok) return failed(serialized.error);
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/lifecycle"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    if (fetched.response.status === 409) {
      return parseLifecycleConflict(fetched.response, investigationId, input.action, signal);
    }
    if (!fetched.response.ok) {
      return failed(classifyHttpFailure(fetched.response.status));
    }
    return parseSuccessfulResponse(
      fetched.response,
      signal,
      parseInvestigationLifecycleActionSuccess,
      (value) => value.investigationId === investigationId && value.action === input.action,
    );
  },

  getCoordination(investigationId, { signal }) {
    return requestParsed(
      caseRoute(investigationId, "/coordination"),
      {},
      signal,
      parseInvestigationCoordination,
      (value) => value.investigationId === investigationId,
    );
  },

  async applyCoordinationAction(
    investigationId,
    input,
    { actorIdentityId, signal },
  ) {
    if (signal.aborted) return aborted();
    let request: InvestigationCoordinationActionRequestV1;
    try {
      request = parseInvestigationCoordinationActionRequest(
        coordinationActionBody(investigationId, input),
      );
    } catch (cause) {
      return cause instanceof ContractViolation
        ? failed(protocolFailure("contract"))
        : failed({ kind: "unexpected" });
    }
    if (signal.aborted) return aborted();
    const serialized = serializeMutationBody(signal, () => ({
      schemaId: request.schemaId,
      investigationId: request.investigationId,
      action: request.action,
      ...(request.targetIdentityId === undefined
        ? {}
        : { targetIdentityId: request.targetIdentityId }),
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      ...(request.clientTime === undefined ? {} : { clientTime: request.clientTime }),
    }));
    if (!serialized.ok) return failed(serialized.error);
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/coordination"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
      signal,
    );
    if (!fetched.ok) return failed(fetched.error);
    if (fetched.response.status === 401 || fetched.response.status === 403) {
      return failed(classifyHttpFailure(fetched.response.status));
    }
    if (fetched.response.status === 409) {
      return parseCoordinationConflict(
        fetched.response,
        investigationId,
        request,
        actorIdentityId,
        signal,
      );
    }
    if (!fetched.response.ok) {
      return parseCommitOutcomeUnknownFailure(fetched.response, signal);
    }
    return parseSuccessfulResponse(
      fetched.response,
      signal,
      parseInvestigationCoordinationActionSuccess,
      (value) => coordinationSuccessIdentity(
        investigationId,
        request,
        actorIdentityId,
        value,
      ),
    );
  },
};
