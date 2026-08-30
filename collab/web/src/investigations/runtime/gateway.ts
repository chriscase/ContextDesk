import {
  ContractViolation,
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  parseCase,
  parseCaseList,
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
  type ContributionV1,
  type EvidenceUploadSuccessV1,
  type InvestigationLifecycleActionRequestV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleExpectedV1,
  type InvestigationLifecycleV1,
  type LifecycleAction,
  type PrivacyClass,
} from "@cd-collab/contracts";
import { protectedApiFetch } from "../../protected-api.js";
import {
  classifyHttpFailure,
  classifyRequestException,
  protocolFailure,
  type RuntimeFailure,
} from "./errors.js";

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

export interface ApplyLifecycleActionInput {
  readonly action: LifecycleAction;
  readonly expected: InvestigationLifecycleExpectedV1;
  readonly clientTime?: string;
}

export interface InvestigationGateway {
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

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });

function failed<T>(error: RuntimeFailure): GatewayResult<T> {
  return { ok: false, error };
}

function aborted<T>(): GatewayResult<T> {
  return failed({ kind: "aborted" });
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
  return { ok: true, value: parsed };
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

  try {
    if (signal.aborted) return aborted();
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
      current: changed.current,
    });
  } catch {
    if (signal.aborted) return aborted();
  }

  try {
    if (signal.aborted) return aborted();
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
  } catch {
    return signal.aborted ? aborted() : genericConflict();
  }
}

export const investigationGateway: InvestigationGateway = {
  async listInvestigations({ signal }) {
    const result = await requestParsed(
      "/api/cases",
      {},
      signal,
      parseCaseList,
      (value) => caseCollectionIdentity(value.cases),
    );
    return result.ok ? { ok: true, value: [...result.value.cases] } : result;
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
    return requestParsed(
      "/api/cases",
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...input,
          ...(input.openQuestions === undefined
            ? {}
            : { openQuestions: [...input.openQuestions] }),
        }),
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
        && value.artifacts.every((artifact) => artifact.caseId === investigationId),
    );
    return result.ok ? { ok: true, value: [...result.value.artifacts] } : result;
  },

  async listContributions(investigationId, { signal }) {
    const result = await requestParsed(
      caseRoute(investigationId, "/contributions"),
      {},
      signal,
      parseContributionList,
      (value) => value.caseId === investigationId
        && value.contributions.every((item) => item.caseId === investigationId),
    );
    return result.ok ? { ok: true, value: [...result.value.contributions] } : result;
  },

  uploadEvidence(investigationId, input, { signal }) {
    return requestParsed(
      caseRoute(investigationId, "/evidence"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      },
      signal,
      parseEvidenceUploadSuccess,
      (value) => value.caseId === investigationId
        && value.artifact.caseId === investigationId
        && value.summary.caseId === investigationId,
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
    const request: InvestigationLifecycleActionRequestV1 = {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
      investigationId,
      action: input.action,
      expected: input.expected,
      ...(input.clientTime === undefined ? {} : { clientTime: input.clientTime }),
    };
    const fetched = await fetchProtected(
      caseRoute(investigationId, "/lifecycle"),
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(request),
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
