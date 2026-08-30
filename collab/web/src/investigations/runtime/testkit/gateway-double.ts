import type {
  CaseV1,
  ContributionV1,
} from "@cd-collab/contracts/investigation-runtime";
import { vi } from "vitest";
import type { GatewayResult, InvestigationGateway } from "../gateway.js";
import { InvestigationRuntimeGatewayHarness } from "../InvestigationRuntimeProvider.js";
import {
  makeArchiveAllowedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makePopulatedCase,
} from "./fixtures.js";

/**
 * The runtime's internal transport seam, re-exported so a test outside the
 * runtime never reaches into `runtime/gateway.js` for a component or a type.
 * The testkit is as unreachable from a strategy as the gateway itself.
 */
export { InvestigationRuntimeGatewayHarness };
export type { GatewayResult, InvestigationGateway };

export function gatewayOk<T>(value: T): GatewayResult<T> {
  return { ok: true, value };
}

export function gatewayUnavailable<T>(): GatewayResult<T> {
  return { ok: false, error: { kind: "unavailable", status: 503 } };
}

/**
 * The single gateway double for Runtime V1 consumers. Every read answers with
 * the deterministic fixtures above; every mutation is unexpected until a test
 * names it, so an unasserted write shows up as a failure rather than a pass.
 */
export function createInvestigationGatewayDouble(
  overrides: Partial<InvestigationGateway> = {},
): InvestigationGateway {
  const unexpected = async <T,>(): Promise<GatewayResult<T>> => ({
    ok: false,
    error: { kind: "unexpected" },
  });
  return {
    listInvestigations: vi.fn(async () => gatewayOk(makeCaseList().cases)),
    getInvestigation: vi.fn(async () => gatewayOk(makePopulatedCase())),
    createInvestigation: vi.fn(() => unexpected<CaseV1>()),
    listEvidence: vi.fn(async () => gatewayOk(makeEvidenceList().artifacts)),
    listContributions: vi.fn(async () => gatewayOk(makeContributionList().contributions)),
    uploadEvidence: vi.fn(() => unexpected<never>()),
    createContribution: vi.fn(() => unexpected<ContributionV1>()),
    updateSituation: vi.fn(() => unexpected<CaseV1>()),
    getLifecycle: vi.fn(async () => gatewayOk(makeArchiveAllowedLifecycle())),
    applyLifecycleAction: vi.fn(() => unexpected<never>()),
    ...overrides,
  };
}
