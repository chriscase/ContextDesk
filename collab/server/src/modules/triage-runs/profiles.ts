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
