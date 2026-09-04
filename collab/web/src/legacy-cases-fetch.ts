import { protectedApiFetch } from "./protected-api.js";

/**
 * Compatibility transport for embedders and standalone Cases tests that have
 * not supplied the public collection page yet. The production War Room passes
 * collection props and never calls this function.
 */
export type LegacyCaseListResponse =
  | { readonly ok: true; readonly cases?: unknown[] }
  | { readonly ok: false; readonly status: number };

export async function fetchLegacyCaseList(): Promise<LegacyCaseListResponse> {
  const response = await protectedApiFetch("/api/cases");
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, ...(await response.json() as { cases?: unknown[] }) };
}
