import { readFileSync } from "node:fs";
import { parseLiveQualificationCatalog } from "@cd-collab/contracts";

export interface TriageProfileOption {
  id: string;
  label: string;
  provider: string;
}

const MAX_PROFILES = 32;
const MAX_FIELD_LENGTH = 160;

function validField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * Parse the non-secret profile catalog supplied by the host deployment.
 * Profile ids are references only; credentials and endpoints stay in the
 * ContextDesk host configuration.
 *
 * Format: [{"id":"profile:employer","label":"Employer gateway","provider":"openai-compatible"}]
 */
export function parseTriageProfileCatalog(raw: string | undefined): TriageProfileOption[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const profiles: TriageProfileOption[] = [];
  for (const item of parsed.slice(0, MAX_PROFILES)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (!validField(row.id) || !validField(row.label) || !validField(row.provider)) continue;
    const id = row.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push({ id, label: row.label.trim(), provider: row.provider.trim() });
  }
  return profiles;
}

/**
 * Resolve the operator-facing catalog used by the live qualification path.
 * The file contains safe profile metadata only; credentials remain owned by
 * the host bridge. The legacy inline catalog remains supported for existing
 * deployments.
 */
export function loadConfiguredTriageProfileCatalog(
  env: NodeJS.ProcessEnv = process.env,
): TriageProfileOption[] {
  const path = env.COLLAB_LIVE_PROFILE_CATALOG?.trim();
  if (!path) return parseTriageProfileCatalog(env.COLLAB_TRIAGE_PROFILE_CATALOG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("live qualification profile catalog could not be loaded");
  }
  const catalog = parseLiveQualificationCatalog(raw);
  return catalog.profiles.map((profile) => ({
    id: profile.profileId,
    label: profile.label,
    provider: profile.provider,
  }));
}
