import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
} from "@cd-collab/contracts/admin";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_LOST_EVENT,
  protectedApiFetch,
  protectedMultipartUpload,
  withBrowserMutationCsrf,
} from "./protected-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("protectedApiFetch CSRF", () => {
  it("attaches the canonical CSRF header to POST/PUT/PATCH/DELETE and not to GET", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, status: 200 } as Response));
    vi.stubGlobal("fetch", fetchMock);

    await protectedApiFetch("/api/cases", { method: "POST", headers: { "content-type": "application/json" } });
    await protectedApiFetch("/api/authz/group-role-map", { method: "PUT" });
    await protectedApiFetch("/api/profile/me", { method: "PATCH" });
    await protectedApiFetch("/api/authz/group-role-map", { method: "DELETE" });
    await protectedApiFetch("/api/cases");

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const posts = calls.filter(([, init]) => init?.method !== undefined);
    expect(posts[0]?.[1]?.headers).toMatchObject({
      "content-type": "application/json",
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(posts[1]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(posts[2]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(posts[3]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    const getInit = calls[4]?.[1];
    expect(getInit?.headers?.[COLLAB_CSRF_HEADER as never]).toBeUndefined();
  });

  it("does not overwrite a caller-supplied CSRF header", () => {
    const init = withBrowserMutationCsrf({
      method: "POST",
      headers: { [COLLAB_CSRF_HEADER]: "already" },
    });
    expect((init.headers as Record<string, string>)[COLLAB_CSRF_HEADER]).toBe("already");
  });

  it("still broadcasts auth-lost on 401/403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 } as Response)));
    const seen: number[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ status: number }>).detail.status);
    };
    window.addEventListener(AUTH_LOST_EVENT, listener);
    await protectedApiFetch("/api/cases", { method: "POST" });
    window.removeEventListener(AUTH_LOST_EVENT, listener);
    expect(seen).toEqual([403]);
  });
});

type ProgressHandler = (event: ProgressEvent) => void;

class MockXHR {
  static instances: MockXHR[] = [];
  status = 0;
  statusText = "";
  responseText = "";
  responseURL = "";
  withCredentials = false;
  method = "";
  url = "";
  body: unknown;
  aborted = false;
  sent = false;
  timeout = 0;
  requestHeaders: Record<string, string> = {};
  responseHeaders = "";
  abortCalls = 0;
  listeners = new Map<string, EventListener[]>();
  uploadListeners = new Map<string, EventListener[]>();
  upload = {
    addEventListener: (type: string, listener: EventListener) => {
      const list = this.uploadListeners.get(type) ?? [];
      list.push(listener);
      this.uploadListeners.set(type, list);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      const list = this.uploadListeners.get(type) ?? [];
      this.uploadListeners.set(
        type,
        list.filter((candidate) => candidate !== listener),
      );
    },
  };

  constructor() {
    MockXHR.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    );
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  getAllResponseHeaders(): string {
    return this.responseHeaders;
  }

  abort(): void {
    this.abortCalls += 1;
    this.aborted = true;
    this.emit("abort");
  }

  send(body?: unknown): void {
    this.sent = true;
    this.body = body;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, new Event(type));
    }
  }

  emitProgress(loaded: number, total: number | null): void {
    const event = {
      loaded,
      total: total ?? 0,
      lengthComputable: total !== null,
    } as ProgressEvent;
    for (const listener of this.uploadListeners.get("progress") ?? []) {
      (listener as ProgressHandler).call(this.upload, event);
    }
  }

  complete(status: number, body: string, headers = "content-type: application/json"): void {
    this.status = status;
    this.statusText = status === 201 ? "Created" : "";
    this.responseText = body;
    this.responseHeaders = headers;
    this.responseURL = this.url;
    this.emit("load");
  }

  failNetwork(): void {
    this.emit("error");
  }
}

function stubXhr(): typeof MockXHR {
  MockXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXHR);
  return MockXHR;
}

describe("protectedMultipartUpload", () => {
  const apiSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "protected-api.ts"),
    "utf8",
  );

  it("keeps XMLHttpRequest inside the protected helper only", () => {
    expect(apiSource).toMatch(/\bXMLHttpRequest\b/);
    expect(apiSource.match(/\bnew XMLHttpRequest\b/g)).toHaveLength(1);
    expect(apiSource).not.toMatch(/s3\.amazonaws|X-Amz-|presigned|createObjectURL|revokeObjectURL|new Blob\b/i);
  });

  it("sends same-origin credentials, CSRF, FormData, and the response status/headers/body", async () => {
    stubXhr();
    const body = new FormData();
    body.append("kind", "log");
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", { body });
    const xhr = MockXHR.instances[0];
    expect(xhr).toBeTruthy();
    expect(xhr?.method).toBe("POST");
    expect(xhr?.url).toBe(
      new URL("/api/cases/case-1/evidence/stream", window.location.href).href,
    );
    expect(xhr?.withCredentials).toBe(true);
    expect(xhr?.requestHeaders[COLLAB_CSRF_HEADER]).toBe(COLLAB_CSRF_HEADER_VALUE);
    expect(xhr?.requestHeaders["content-type"]).toBeUndefined();
    expect(xhr?.requestHeaders["Content-Type"]).toBeUndefined();
    expect(xhr?.body).toBe(body);
    expect(xhr?.sent).toBe(true);

    xhr?.complete(
      201,
      JSON.stringify({ artifact: { id: "artifact-1" } }),
      "content-type: application/json\r\nx-cd-upload: streamed\r\n",
    );
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-cd-upload")).toBe("streamed");
    expect(await response.text()).toBe(JSON.stringify({ artifact: { id: "artifact-1" } }));
    await expect(response.json()).resolves.toEqual({ artifact: { id: "artifact-1" } });
  });

  it("does not overwrite a caller-supplied CSRF header on multipart POST", async () => {
    stubXhr();
    const body = new FormData();
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body,
      headers: { [COLLAB_CSRF_HEADER]: "already" },
    });
    const xhr = MockXHR.instances[0];
    expect(xhr?.requestHeaders[COLLAB_CSRF_HEADER]).toBe("already");
    xhr?.complete(200, "{}");
    await pending;
  });

  it("reports determinate and indeterminate upload progress", async () => {
    stubXhr();
    const progress: Array<{ loaded: number; total: number | null }> = [];
    const body = new FormData();
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body,
      onUploadProgress: (event) => progress.push(event),
    });
    const xhr = MockXHR.instances[0];
    xhr?.emitProgress(10, 40);
    xhr?.emitProgress(25, null);
    xhr?.complete(200, "{}");
    await pending;
    expect(progress).toEqual([
      { loaded: 10, total: 40 },
      { loaded: 25, total: null },
    ]);
  });

  it("broadcasts auth-lost on 401 and 403 without rejecting HTTP errors", async () => {
    stubXhr();
    const seen: number[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ status: number }>).detail.status);
    };
    window.addEventListener(AUTH_LOST_EVENT, listener);
    try {
      const first = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
        body: new FormData(),
      });
      MockXHR.instances[0]?.complete(401, JSON.stringify({ error: "unauthenticated" }));
      const unauthorized = await first;
      expect(unauthorized.ok).toBe(false);
      expect(unauthorized.status).toBe(401);

      const second = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
        body: new FormData(),
      });
      MockXHR.instances[1]?.complete(403, JSON.stringify({ error: "forbidden" }));
      const forbidden = await second;
      expect(forbidden.status).toBe(403);
      expect(seen).toEqual([401, 403]);
    } finally {
      window.removeEventListener(AUTH_LOST_EVENT, listener);
    }
  });

  it("rejects network errors without settling HTTP success", async () => {
    stubXhr();
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body: new FormData(),
    });
    MockXHR.instances[0]?.failNetwork();
    await expect(pending).rejects.toMatchObject({ name: "TypeError", message: "Failed to fetch" });
  });

  it("cancels an in-flight upload via AbortSignal and settles once", async () => {
    stubXhr();
    const controller = new AbortController();
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body: new FormData(),
      signal: controller.signal,
    });
    const xhr = MockXHR.instances[0];
    expect(xhr?.sent).toBe(true);
    controller.abort();
    controller.abort();
    xhr?.complete(200, "{}");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr?.abortCalls).toBe(1);
  });

  it("rejects an already-aborted signal without sending", async () => {
    stubXhr();
    const controller = new AbortController();
    controller.abort();
    await expect(
      protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
        body: new FormData(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(MockXHR.instances[0]?.sent).toBe(false);
  });

  async function expectRejectedWithoutXhr(url: string): Promise<void> {
    stubXhr();
    await expect(
      protectedMultipartUpload(url, {
        body: new FormData(),
        headers: { extra: "nope", [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE },
      }),
    ).rejects.toMatchObject({ name: "TypeError", message: "Cross-origin upload is not allowed." });
    expect(MockXHR.instances).toHaveLength(0);
    expect(MockXHR.instances.filter((xhr) => xhr.sent)).toEqual([]);
    expect(
      MockXHR.instances.filter((xhr) => xhr.requestHeaders[COLLAB_CSRF_HEADER] !== undefined),
    ).toEqual([]);
    expect(MockXHR.instances.filter((xhr) => xhr.withCredentials)).toEqual([]);
  }

  it("normalizes a relative /api path to the current origin before sending CSRF", async () => {
    stubXhr();
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body: new FormData(),
    });
    const expected = new URL("/api/cases/case-1/evidence/stream", window.location.href);
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0]?.url).toBe(expected.href);
    expect(expected.origin).toBe(window.location.origin);
    expect(MockXHR.instances[0]?.requestHeaders[COLLAB_CSRF_HEADER]).toBe(COLLAB_CSRF_HEADER_VALUE);
    expect(MockXHR.instances[0]?.withCredentials).toBe(true);
    MockXHR.instances[0]?.complete(200, "{}");
    await pending;
  });

  it("rejects a cross-origin absolute URL before constructing XHR or attaching CSRF", async () => {
    await expectRejectedWithoutXhr("https://evil.example/api/cases/case-1/evidence/stream");
  });

  it("accepts an exact same-origin absolute URL and still sends CSRF", async () => {
    stubXhr();
    const url = `${window.location.origin}/api/cases/case-1/evidence/stream`;
    const pending = protectedMultipartUpload(url, { body: new FormData() });
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0]?.url).toBe(url);
    expect(MockXHR.instances[0]?.requestHeaders[COLLAB_CSRF_HEADER]).toBe(COLLAB_CSRF_HEADER_VALUE);
    expect(MockXHR.instances[0]?.withCredentials).toBe(true);
    MockXHR.instances[0]?.complete(200, "{}");
    await pending;
  });

  it("rejects protocol-relative and slash/backslash authority forms without constructing XHR", async () => {
    await expectRejectedWithoutXhr("//evil.example/path");
    await expectRejectedWithoutXhr("/\\evil.example/path");
    await expectRejectedWithoutXhr("/\\\\evil.example/path");
    await expectRejectedWithoutXhr("\\\\evil.example/path");
    await expectRejectedWithoutXhr("https:\\\\evil.example\\\\path");
    await expectRejectedWithoutXhr("blob:\\\\evil.example\\\\id");
  });

  it("rejects userinfo targeting another host or the current origin", async () => {
    const loc = new URL(window.location.href);
    await expectRejectedWithoutXhr("https://user:pass@evil.example/api/cases/case-1/evidence/stream");
    await expectRejectedWithoutXhr(
      `${loc.protocol}//user:pass@${loc.host}/api/cases/case-1/evidence/stream`,
    );
    await expectRejectedWithoutXhr(
      `${loc.protocol}//user@${loc.host}/api/cases/case-1/evidence/stream`,
    );
  });

  it("rejects non-http(s) schemes without constructing XHR", async () => {
    await expectRejectedWithoutXhr("javascript:alert(1)");
    await expectRejectedWithoutXhr("data:text/plain,hello");
    await expectRejectedWithoutXhr("blob:https://evil.example/4e4d-uuid");
    await expectRejectedWithoutXhr(`blob:${window.location.origin}/4e4d-uuid`);
    await expectRejectedWithoutXhr("file:///etc/passwd");
    await expectRejectedWithoutXhr("ftp://localhost/api/cases/case-1/evidence/stream");
  });

  it("resolves every upload URL through new URL against the current origin", () => {
    expect(apiSource).toMatch(/new URL\(raw, window\.location\.href\)/);
    expect(apiSource).toMatch(/parsed\.username/);
    expect(apiSource).toMatch(/parsed\.password/);
    expect(apiSource).not.toMatch(/if \(raw\.startsWith\("\/"\)/);
  });

  it("never overwrites foreign AbortSignal handlers and removes only its own listener", async () => {
    stubXhr();
    const controller = new AbortController();
    const foreign = vi.fn();
    const ownedBefore = controller.signal.onabort;
    controller.signal.addEventListener("abort", foreign);
    const pending = protectedMultipartUpload("/api/cases/case-1/evidence/stream", {
      body: new FormData(),
      signal: controller.signal,
    });
    expect(controller.signal.onabort).toBe(ownedBefore);
    MockXHR.instances[0]?.complete(200, "{}");
    await pending;
    expect(foreign).not.toHaveBeenCalled();
    controller.abort();
    expect(foreign).toHaveBeenCalledTimes(1);
    expect(MockXHR.instances[0]?.abortCalls).toBe(0);
  });
});
