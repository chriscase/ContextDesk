import {
  ContractViolation,
  parseSourceCreateRequest,
  parseSourceList,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type SourceCreateRequestV1,
  type SourceListV1,
  type SourceMutationAction,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceRestoreRequestV1,
  type SourceRetireRequestV1,
} from "@cd-collab/contracts/source-catalog";
import { protectedApiFetch } from "../protected-api.js";

export const SOURCE_CATALOG_PROTOCOL_REASONS = [
  "content_type",
  "json",
  "contract",
  "identity",
] as const;

export type SourceCatalogProtocolReason =
  (typeof SOURCE_CATALOG_PROTOCOL_REASONS)[number];

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/**
 * A bounded failure vocabulary. It deliberately retains no response body,
 * URL, headers, exception, stack, or server-provided free-form message.
 */
export type SourceCatalogFailure =
  | { readonly kind: "invalid_request" }
  | { readonly kind: "auth_lost"; readonly status: 401 | 403 }
  | { readonly kind: "invalid"; readonly status: 400 }
  | {
      readonly kind: "refused";
      readonly status: 409;
      readonly refusal: DeepReadonly<SourceMutationRefusedV1>;
    }
  | { readonly kind: "commit_outcome_unknown"; readonly status: 503 }
  | { readonly kind: "internal"; readonly status: 500 }
  | { readonly kind: "unexpected_response"; readonly status: number }
  | { readonly kind: "protocol"; readonly reason: SourceCatalogProtocolReason }
  | { readonly kind: "aborted" }
  | { readonly kind: "network" }
  | { readonly kind: "unexpected" };

export type SourceCatalogResult<T> =
  | { readonly ok: true; readonly value: DeepReadonly<T> }
  | { readonly ok: false; readonly error: SourceCatalogFailure };

export interface SourceCatalogGateway {
  list(signal: AbortSignal): Promise<SourceCatalogResult<SourceListV1>>;
  create(
    request: SourceCreateRequestV1,
    signal: AbortSignal,
  ): Promise<SourceCatalogResult<SourceMutationSuccessV1>>;
  retire(
    request: SourceRetireRequestV1,
    signal: AbortSignal,
  ): Promise<SourceCatalogResult<SourceMutationSuccessV1>>;
  restore(
    request: SourceRestoreRequestV1,
    signal: AbortSignal,
  ): Promise<SourceCatalogResult<SourceMutationSuccessV1>>;
}

type MutationRequest =
  | SourceCreateRequestV1
  | SourceRetireRequestV1
  | SourceRestoreRequestV1;

type FetchResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: SourceCatalogFailure };

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

function succeeded<T>(value: T): SourceCatalogResult<T> {
  return Object.freeze({
    ok: true as const,
    value: deepFreeze(value),
  }) as SourceCatalogResult<T>;
}

function failed<T>(error: SourceCatalogFailure): SourceCatalogResult<T> {
  return deepFreeze({ ok: false as const, error: deepFreeze(error) });
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === "application/json"
    || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

function exceptionName(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  try {
    if (!("name" in cause)) return undefined;
    return typeof cause.name === "string" ? cause.name : undefined;
  } catch {
    return undefined;
  }
}

function isTypeError(cause: unknown): boolean {
  try {
    return cause instanceof TypeError;
  } catch {
    return false;
  }
}

function exceptionFailure(cause: unknown, signal: AbortSignal): SourceCatalogFailure {
  const name = exceptionName(cause);
  if (signal.aborted || name === "AbortError") return { kind: "aborted" };
  if (isTypeError(cause) || name === "NetworkError") return { kind: "network" };
  return { kind: "unexpected" };
}

function protocol(reason: SourceCatalogProtocolReason): SourceCatalogFailure {
  return { kind: "protocol", reason };
}

function requestSourceId(request: MutationRequest): string | null {
  return "sourceId" in request ? request.sourceId : null;
}

async function parseJson<T>(
  response: Response,
  signal: AbortSignal,
  parser: (raw: unknown) => T,
): Promise<SourceCatalogResult<T>> {
  if (!isJsonResponse(response)) return failed(protocol("content_type"));
  if (signal.aborted) return failed({ kind: "aborted" });
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return failed(signal.aborted ? { kind: "aborted" } : protocol("json"));
  }
  if (signal.aborted) return failed({ kind: "aborted" });
  try {
    return succeeded(parser(raw));
  } catch (cause) {
    if (signal.aborted) return failed({ kind: "aborted" });
    return failed(
      cause instanceof ContractViolation ? protocol("contract") : { kind: "unexpected" },
    );
  }
}

async function fetchProtected(
  route: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<FetchResult> {
  if (signal.aborted) return { ok: false, error: { kind: "aborted" } };
  try {
    const response = await protectedApiFetch(route, { ...init, signal });
    if (signal.aborted) return { ok: false, error: { kind: "aborted" } };
    return { ok: true, response };
  } catch (cause) {
    return { ok: false, error: exceptionFailure(cause, signal) };
  }
}

async function parseKnown503<T>(
  response: Response,
  signal: AbortSignal,
): Promise<SourceCatalogResult<T>> {
  if (!isJsonResponse(response)) {
    return failed({ kind: "unexpected_response", status: response.status });
  }
  if (signal.aborted) return failed({ kind: "aborted" });
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return failed(
      signal.aborted
        ? { kind: "aborted" }
        : { kind: "unexpected_response", status: response.status },
    );
  }
  if (signal.aborted) return failed({ kind: "aborted" });
  if (
    typeof raw === "object"
    && raw !== null
    && !Array.isArray(raw)
    && Object.keys(raw).length === 1
    && (raw as Record<string, unknown>).error === "commit_outcome_unknown"
  ) {
    return failed({ kind: "commit_outcome_unknown", status: 503 });
  }
  return failed({ kind: "unexpected_response", status: response.status });
}

function basicHttpFailure<T>(status: number): SourceCatalogResult<T> {
  if (status === 401 || status === 403) return failed({ kind: "auth_lost", status });
  if (status === 400) return failed({ kind: "invalid", status });
  if (status === 500) return failed({ kind: "internal", status });
  return failed({ kind: "unexpected_response", status });
}

async function parseRefusal(
  response: Response,
  signal: AbortSignal,
  request: MutationRequest,
  action: SourceMutationAction,
): Promise<SourceCatalogResult<SourceMutationSuccessV1>> {
  const parsed = await parseJson(response, signal, parseSourceMutationRefused);
  if (!parsed.ok) return parsed;
  const refusal = parsed.value;
  const expectedSourceId = requestSourceId(request);
  if (
    refusal.action !== action
    || refusal.expectedRevision !== request.expectedRevision
    || (action !== "create" && refusal.sourceId !== expectedSourceId)
  ) {
    return failed(protocol("identity"));
  }
  return failed({ kind: "refused", status: 409, refusal });
}

async function mutation(
  action: SourceMutationAction,
  rawRequest: MutationRequest,
  signal: AbortSignal,
): Promise<SourceCatalogResult<SourceMutationSuccessV1>> {
  let request: MutationRequest;
  try {
    request = action === "create"
      ? parseSourceCreateRequest(rawRequest)
      : action === "retire"
        ? parseSourceRetireRequest(rawRequest)
        : parseSourceRestoreRequest(rawRequest);
  } catch (cause) {
    return failed(
      cause instanceof ContractViolation ? { kind: "invalid_request" } : { kind: "unexpected" },
    );
  }

  if (signal.aborted) return failed({ kind: "aborted" });
  const route = action === "create"
    ? "/api/catalog/sources"
    : `/api/catalog/sources/${encodeURIComponent(requestSourceId(request) ?? "")}/${action}`;
  const fetched = await fetchProtected(
    route,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    signal,
  );
  if (!fetched.ok) return failed(fetched.error);
  const response = fetched.response;

  if (response.status === 401 || response.status === 403) {
    return basicHttpFailure(response.status);
  }
  if (response.status === 409) return parseRefusal(response, signal, request, action);
  if (response.status === 503) return parseKnown503(response, signal);
  if (!response.ok) return basicHttpFailure(response.status);
  const validStatus = action === "create"
    ? response.status === 200 || response.status === 201
    : response.status === 200;
  if (!validStatus) return failed({ kind: "unexpected_response", status: response.status });

  const parsed = await parseJson(response, signal, parseSourceMutationSuccess);
  if (!parsed.ok) return parsed;
  const success = parsed.value;
  const sourceMatches = action === "create" || success.sourceId === requestSourceId(request);
  const revisionMatches = success.replayed
    || success.expectedRevision === request.expectedRevision;
  const createStatusMatchesReplay = action !== "create"
    || (success.replayed ? response.status === 200 : response.status === 201);
  if (
    success.action !== action
    || !sourceMatches
    || !revisionMatches
    || !createStatusMatchesReplay
  ) {
    return failed(protocol("identity"));
  }
  return parsed;
}

export const sourceCatalogGateway: SourceCatalogGateway = {
  async list(signal) {
    const fetched = await fetchProtected("/api/catalog/sources", {}, signal);
    if (!fetched.ok) return failed(fetched.error);
    const response = fetched.response;
    if (response.status === 401 || response.status === 403) {
      return basicHttpFailure(response.status);
    }
    if (!response.ok) return basicHttpFailure(response.status);
    if (response.status !== 200) {
      return failed({ kind: "unexpected_response", status: response.status });
    }
    return parseJson(response, signal, parseSourceList);
  },

  create(request, signal) {
    return mutation("create", request, signal);
  },

  retire(request, signal) {
    return mutation("retire", request, signal);
  },

  restore(request, signal) {
    return mutation("restore", request, signal);
  },
};
