export const AUTH_LOST_EVENT = "contextdesk:auth-lost";

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
  const response = await fetch(input, init);
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, {
      detail: { status: response.status },
    }));
  }
  return response;
}
