import {
  ContractViolation,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
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
  type ArtifactKind,
  type ArtifactV1,
  type CaseV1,
  type ContributionKind,
  type ContributionV1,
  type EvidenceUploadSuccessV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleExpectedV1,
  type InvestigationLifecycleV1,
  type LifecycleAction,
  type PrivacyClass,
} from "@cd-collab/contracts/investigation-runtime";
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

export interface ApplyLifecycleActionInput {
  readonly action: LifecycleAction;
  readonly expected: InvestigationLifecycleExpectedV1;
  readonly clientTime?: string;
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

export interface InvestigationGateway extends Partial<InvestigationWriteGateway> {
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
  listContributions(
    investigationId: string,
    options: GatewayRequestOptions,
  ): Promise<GatewayResult<readonly ContributionV1[]>>;
  uploadEvidence(
    investigationId: string,
    input: UploadEvidenceInput,
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

function caseCollectionIdentity(cases: readonly CaseV1[]): boolean {
  const identities = new Set<string>();
  for (const investigation of cases) {
    if (investigation.id.length === 0 || identities.has(investigation.id)) return false;
    identities.add(investigation.id);
  }
  return true;
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

const UNAVAILABLE_WRITE_GATEWAY: InvestigationWriteGateway = Object.freeze({
  createContribution: () =>
    Promise.resolve(failed<ContributionV1>(WRITE_SEAM_UNAVAILABLE)),
  updateSituation: () => Promise.resolve(failed<CaseV1>(WRITE_SEAM_UNAVAILABLE)),
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

export const investigationGateway: InvestigationGatewayWithWrites = {
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

  uploadEvidence(investigationId, input, { signal }) {
    const serialized = serializeMutationBody(signal, () => uploadEvidenceBody(input));
    if (!serialized.ok) return Promise.resolve(failed(serialized.error));
    return requestParsed(
      caseRoute(investigationId, "/evidence"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialized.value,
      },
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
};
