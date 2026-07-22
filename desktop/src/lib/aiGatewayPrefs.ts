/**
 * Soft preferences for AI gateway setup UX.
 * URL only (never secrets). Host config + keychain remain source of truth after Save.
 */

const LAST_GATEWAY_URL_KEY = "cd-last-gateway-url";

export function loadLastGatewayUrl(): string {
  try {
    const v = localStorage.getItem(LAST_GATEWAY_URL_KEY)?.trim() ?? "";
    if (!v) return "";
    // Never treat loopback as a "gateway" memory.
    if (/127\.0\.0\.1|localhost/i.test(v)) return "";
    return v;
  } catch {
    return "";
  }
}

export function saveLastGatewayUrl(url: string): void {
  const u = url.trim().replace(/\/+$/, "");
  if (!u || /127\.0\.0\.1|localhost/i.test(u)) return;
  try {
    localStorage.setItem(LAST_GATEWAY_URL_KEY, u);
  } catch {
    /* quota / private mode */
  }
}

/** Prefer draft → last-saved soft pref → empty. */
export function resolveGatewayUrlPrefill(
  draftBaseUrl: string | undefined,
  providerKind: string | undefined,
): string {
  if (
    (providerKind === "openai_compatible" || providerKind === "anthropic") &&
    draftBaseUrl?.trim() &&
    !/127\.0\.0\.1|localhost/i.test(draftBaseUrl)
  ) {
    return draftBaseUrl.trim();
  }
  return loadLastGatewayUrl();
}
