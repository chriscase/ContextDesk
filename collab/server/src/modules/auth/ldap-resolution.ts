/**
 * Login-name parsing for LDAP user resolution.
 * Never derives a domain or UPN suffix from a search base or other DN.
 */
export type ParsedLoginName =
  | { ok: true; form: "plain"; username: string }
  | { ok: true; form: "upn"; username: string; suffix: string }
  | { ok: true; form: "domain"; username: string; netbios: string }
  | { ok: false; reason: "empty" | "mixed" | "malformed" };

export function parseLoginName(input: string): ParsedLoginName {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  const hasSlash = trimmed.includes("\\");
  const hasAt = trimmed.includes("@");
  if (hasSlash && hasAt) return { ok: false, reason: "mixed" };
  if (hasSlash) {
    const parts = trimmed.split("\\");
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].includes("/") || parts[1].includes("/")) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, form: "domain", netbios: parts[0], username: parts[1] };
  }
  if (hasAt) {
    const at = trimmed.lastIndexOf("@");
    const username = trimmed.slice(0, at);
    const suffix = trimmed.slice(at + 1);
    if (!username || !suffix || suffix.includes("@") || suffix.includes("\\")) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true, form: "upn", username, suffix };
  }
  return { ok: true, form: "plain", username: trimmed };
}

export function sameIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, "en-US", { sensitivity: "accent" }) === 0;
}

export function normalizeGroupDns(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}
