import {
  compactInvestigationLocator,
  parseInvestigationActivityError,
  parseInvestigationActivityPage,
  parseInvestigationResourceResolve,
  type InvestigationActivityFilterV1,
  type InvestigationActivityPageV1,
  type InvestigationResourceLocatorV1,
  type InvestigationResourceResolveV1,
} from "@cd-collab/contracts/investigation-activity";
import {
  parseCaseList,
  type CaseV1,
} from "@cd-collab/contracts/investigation-runtime";
import { protectedApiFetch } from "../protected-api.js";

export type OverviewFailure =
  | { readonly kind: "network" }
  | { readonly kind: "protocol" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "stale_cursor" | "malformed_cursor" | "invalid_filter" | "invalid_locator" | "not_found" };

export type OverviewGatewayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OverviewFailure };

export interface ActivityPageInput {
  readonly filter: InvestigationActivityFilterV1;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface OverviewGateway {
  listInvestigations(signal: AbortSignal): Promise<OverviewGatewayResult<readonly CaseV1[]>>;
  listActivity(input: ActivityPageInput, signal: AbortSignal): Promise<OverviewGatewayResult<InvestigationActivityPageV1>>;
  resolve(locator: InvestigationResourceLocatorV1, signal: AbortSignal): Promise<OverviewGatewayResult<InvestigationResourceResolveV1>>;
}

function failureForStatus(status: number): OverviewFailure {
  return { kind: "http", status };
}

async function parsedJson<T>(response: Response, parse: (raw: unknown) => T): Promise<OverviewGatewayResult<T>> {
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      try {
        const error = parseInvestigationActivityError(await response.json());
        return { ok: false, error: { kind: error.error } };
      } catch {
        return { ok: false, error: failureForStatus(response.status) };
      }
    }
    return { ok: false, error: failureForStatus(response.status) };
  }
  try {
    return { ok: true, value: parse(await response.json()) };
  } catch {
    return { ok: false, error: { kind: "protocol" } };
  }
}

export function activityQuery(input: ActivityPageInput): string {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 30));
  const { filter } = input;
  if (filter.investigationId) params.set("investigationId", filter.investigationId);
  if (filter.actorId) params.set("actorId", filter.actorId);
  if (filter.activityKind) params.set("activityKind", filter.activityKind);
  if (filter.stage) params.set("stage", filter.stage);
  if (filter.workstreamId) params.set("workstreamId", filter.workstreamId);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.assignedToMe !== undefined) params.set("assignedToMe", String(filter.assignedToMe));
  if (input.cursor) params.set("cursor", input.cursor);
  return `/api/investigation-activity?${params.toString()}`;
}

export const overviewGateway: OverviewGateway = {
  async listInvestigations(signal) {
    try {
      return await parsedJson(
        await protectedApiFetch("/api/cases", { signal }),
        (raw) => parseCaseList(raw).cases,
      );
    } catch {
      return { ok: false, error: { kind: "network" } };
    }
  },
  async listActivity(input, signal) {
    try {
      return await parsedJson(
        await protectedApiFetch(activityQuery(input), { signal }),
        parseInvestigationActivityPage,
      );
    } catch {
      return { ok: false, error: { kind: "network" } };
    }
  },
  async resolve(locator, signal) {
    const params = new URLSearchParams({ locator: compactInvestigationLocator(locator) });
    try {
      return await parsedJson(
        await protectedApiFetch(`/api/investigation-resources/resolve?${params.toString()}`, { signal }),
        parseInvestigationResourceResolve,
      );
    } catch {
      return { ok: false, error: { kind: "network" } };
    }
  },
};
