import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  isBrowserMutationMethod,
} from "@cd-collab/contracts/admin";

export const AUTH_LOST_EVENT = "contextdesk:auth-lost";

function headerRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Canonical browser mutation CSRF header. Login, logout, and setup must not
 * use this helper; those paths are the documented CSRF exemptions.
 */
export function withBrowserMutationCsrf(init?: RequestInit): RequestInit {
  const method = (init?.method ?? "GET").toString().toUpperCase();
  if (!isBrowserMutationMethod(method)) return init ?? {};
  const headers = headerRecord(init?.headers);
  const hasCsrf = Object.keys(headers).some(
    (key) => key.toLowerCase() === COLLAB_CSRF_HEADER,
  );
  if (!hasCsrf) {
    headers[COLLAB_CSRF_HEADER] = COLLAB_CSRF_HEADER_VALUE;
  }
  return { ...init, headers };
}

/**
 * The one request boundary for authenticated War Room data. A denied response
 * invalidates the complete protected React tree in App; individual panels must
 * never decide which stale investigation bytes are safe to keep showing.
 * Public authentication, setup, and branding requests intentionally do not use
 * this helper.
 */
export async function protectedApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, withBrowserMutationCsrf(init));
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, {
      detail: { status: response.status },
    }));
  }
  return response;
}
