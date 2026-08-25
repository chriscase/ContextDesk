import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
} from "@cd-collab/contracts/admin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT, protectedApiFetch, withBrowserMutationCsrf } from "./protected-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("protectedApiFetch CSRF", () => {
  it("attaches the canonical CSRF header to POST/PUT/PATCH/DELETE and not to GET", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 } as Response));
    vi.stubGlobal("fetch", fetchMock);

    await protectedApiFetch("/api/cases", { method: "POST", headers: { "content-type": "application/json" } });
    await protectedApiFetch("/api/authz/group-role-map", { method: "PUT" });
    await protectedApiFetch("/api/profile/me", { method: "PATCH" });
    await protectedApiFetch("/api/authz/group-role-map", { method: "DELETE" });
    await protectedApiFetch("/api/cases");

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    expect(calls).toHaveLength(5);
    expect(calls[0]?.[1]?.headers).toMatchObject({
      "content-type": "application/json",
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(calls[1]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(calls[2]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(calls[3]?.[1]?.headers).toMatchObject({
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    const getHeaders = calls[4]?.[1]?.headers as Record<string, string> | undefined;
    expect(getHeaders?.[COLLAB_CSRF_HEADER]).toBeUndefined();
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
