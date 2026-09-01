import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  isBrowserMutationMethod,
} from "@cd-collab/contracts/admin";

export const AUTH_LOST_EVENT = "contextdesk:auth-lost";

export interface ProtectedUploadProgress {
  loaded: number;
  total: number | null;
}

export interface ProtectedMultipartUploadInit {
  method?: string;
  body: FormData;
  headers?: HeadersInit;
  signal?: AbortSignal;
  onUploadProgress?: (progress: ProtectedUploadProgress) => void;
}

export interface ProtectedMultipartResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Fail closed before any XHR exists. Every non-empty input is resolved against
 * the current origin so slash/backslash authority forms cannot bypass the
 * check. Only http(s) URLs whose origin matches `window.location.origin` and
 * that carry no embedded userinfo are allowed.
 */
function resolveSameOriginUploadUrl(input: RequestInfo | URL): string {
  const raw = requestUrl(input);
  if (!raw) {
    throw new TypeError("Cross-origin upload is not allowed.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, window.location.href);
  } catch {
    throw new TypeError("Cross-origin upload is not allowed.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Cross-origin upload is not allowed.");
  }
  if (parsed.origin !== window.location.origin) {
    throw new TypeError("Cross-origin upload is not allowed.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Cross-origin upload is not allowed.");
  }
  return parsed.href;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function headersFromXhr(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  const raw = xhr.getAllResponseHeaders();
  if (!raw) return headers;
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name) headers.append(name, value);
  }
  return headers;
}

function multipartRequestHeaders(init: ProtectedMultipartUploadInit): Record<string, string> {
  const method = (init.method ?? "POST").toString().toUpperCase();
  const csrfInit: RequestInit = init.headers === undefined
    ? { method }
    : { method, headers: init.headers };
  const headers = headerRecord(withBrowserMutationCsrf(csrfInit).headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") delete headers[key];
  }
  return headers;
}

function announceAuthLost(status: number): void {
  if (status === 401 || status === 403) {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { status } }));
  }
}

function toMultipartResponse(xhr: XMLHttpRequest, fallbackUrl: string): ProtectedMultipartResponse {
  const body = xhr.responseText ?? "";
  return {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    statusText: xhr.statusText,
    headers: headersFromXhr(xhr),
    url: xhr.responseURL || fallbackUrl,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : null),
  };
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

/**
 * Canonical same-origin multipart upload. Progress reporting needs
 * XMLHttpRequest; every other authenticated browser call keeps using fetch.
 * Session cookies travel as same-origin credentials. CSRF uses the same header
 * contract as `protectedApiFetch`. 401/403 broadcast `AUTH_LOST_EVENT`.
 */
export function protectedMultipartUpload(
  input: RequestInfo | URL,
  init: ProtectedMultipartUploadInit,
): Promise<ProtectedMultipartResponse> {
  let url: string;
  try {
    url = resolveSameOriginUploadUrl(input);
  } catch (cause) {
    return Promise.reject(cause);
  }
  const method = (init.method ?? "POST").toString().toUpperCase();
  const signal = init.signal;

  return new Promise((resolve, reject) => {
    let settled = false;
    const xhr = new XMLHttpRequest();
    const ownedAbort = (): void => {
      xhr.abort();
    };

    const cleanup = (): void => {
      signal?.removeEventListener("abort", ownedAbort);
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("error", onError);
      xhr.removeEventListener("abort", onAbort);
      xhr.removeEventListener("timeout", onTimeout);
      xhr.upload.removeEventListener("progress", onProgress);
    };

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onLoad = (): void => {
      settle(() => {
        announceAuthLost(xhr.status);
        if (xhr.status === 0) {
          reject(new TypeError("Failed to fetch"));
          return;
        }
        resolve(toMultipartResponse(xhr, url));
      });
    };
    const onError = (): void => {
      settle(() => reject(new TypeError("Failed to fetch")));
    };
    const onAbort = (): void => {
      settle(() => reject(abortError()));
    };
    const onTimeout = (): void => {
      settle(() => reject(new TypeError("Failed to fetch")));
    };
    const onProgress = (event: ProgressEvent): void => {
      if (settled) return;
      init.onUploadProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
      });
    };

    xhr.addEventListener("load", onLoad);
    xhr.addEventListener("error", onError);
    xhr.addEventListener("abort", onAbort);
    xhr.addEventListener("timeout", onTimeout);
    xhr.upload.addEventListener("progress", onProgress);

    if (signal) {
      if (signal.aborted) {
        settle(() => reject(abortError()));
        return;
      }
      signal.addEventListener("abort", ownedAbort);
    }

    try {
      xhr.open(method, url);
      xhr.withCredentials = true;
      const headers = multipartRequestHeaders({ ...init, method });
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.send(init.body);
    } catch (cause) {
      settle(() => {
        reject(cause instanceof Error ? cause : new TypeError("Failed to fetch"));
      });
    }
  });
}
