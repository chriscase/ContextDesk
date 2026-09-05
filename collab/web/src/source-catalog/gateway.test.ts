import {
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  type SourceCreateRequestV1,
  type SourceMutationAction,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceRestoreRequestV1,
  type SourceRetireRequestV1,
  type SourceV1,
} from "@cd-collab/contracts/source-catalog";
import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
} from "@cd-collab/contracts/admin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT } from "../protected-api.js";
import { sourceCatalogGateway } from "./gateway.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SOURCE_ID = "22222222-2222-4222-8222-222222222222";

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: SOURCE_ID,
    name: "Synthetic assistant",
    kind: "external-tool",
    description: "Synthetic catalog fixture.",
    lifecycle: "active",
    identityId: null,
    createdAt: "2026-09-05T12:00:00.000Z",
    createdBy: "alice",
    revision: 1,
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<SourceCreateRequestV1> = {},
): SourceCreateRequestV1 {
  return {
    schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
    name: "Synthetic assistant",
    kind: "external-tool",
    description: "Synthetic catalog fixture.",
    identityId: null,
    expectedRevision: 0,
    idempotencyKey: "source-create-0001",
    ...overrides,
  };
}

function retireRequest(
  overrides: Partial<SourceRetireRequestV1> = {},
): SourceRetireRequestV1 {
  return {
    schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
    sourceId: SOURCE_ID,
    expectedRevision: 1,
    idempotencyKey: "source-retire-0001",
    ...overrides,
  };
}

function restoreRequest(
  overrides: Partial<SourceRestoreRequestV1> = {},
): SourceRestoreRequestV1 {
  return {
    schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
    sourceId: SOURCE_ID,
    expectedRevision: 2,
    idempotencyKey: "source-restore-0001",
    ...overrides,
  };
}

function success(
  action: SourceMutationAction,
  overrides: Partial<SourceMutationSuccessV1> = {},
): SourceMutationSuccessV1 {
  const isCreate = action === "create";
  const previousRevision = isCreate ? 0 : action === "retire" ? 1 : 2;
  const appliedRevision = previousRevision + 1;
  return {
    schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
    action,
    sourceId: SOURCE_ID,
    expectedRevision: previousRevision,
    previousRevision,
    appliedRevision,
    replayed: false,
    applied: source({
      lifecycle: action === "retire" ? "retired" : "active",
      revision: appliedRevision,
    }) as SourceV1 & { revision: number },
    ...overrides,
  };
}

function refusal(
  action: SourceMutationAction,
  overrides: Partial<SourceMutationRefusedV1> = {},
): SourceMutationRefusedV1 {
  const current = source({ lifecycle: "retired", revision: 2 });
  return {
    schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
    error: "source_catalog_refused",
    action,
    sourceId: SOURCE_ID,
    expectedRevision: action === "restore" ? 2 : 1,
    reason: action === "restore" ? "not_retired" : "already_retired",
    detail: "The source lifecycle already has that value.",
    current:
      action === "restore"
        ? source({ lifecycle: "active", revision: 2 })
        : current,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fetchMock(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Source Catalog transport gateway", () => {
  it("lists through the protected route and deeply freezes the parsed envelope", async () => {
    const fetch = fetchMock(jsonResponse({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [source()],
    }));

    const result = await sourceCatalogGateway.list(new AbortController().signal);

    expect(fetch).toHaveBeenCalledWith("/api/catalog/sources", {
      signal: expect.any(AbortSignal),
    });
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("expected list success");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.sources)).toBe(true);
    expect(Object.isFrozen(result.value.sources[0])).toBe(true);
    expect(() => {
      (result.value.sources[0] as { name: string }).name = "mutated";
    }).toThrow();
  });

  it.each([
    ["create", createRequest(), "/api/catalog/sources", 201],
    ["retire", retireRequest(), `/api/catalog/sources/${SOURCE_ID}/retire`, 200],
    ["restore", restoreRequest(), `/api/catalog/sources/${SOURCE_ID}/restore`, 200],
  ] as const)("sends an exact parsed %s request with CSRF and signal", async (
    action,
    request,
    route,
    status,
  ) => {
    const fetch = fetchMock(jsonResponse(success(action), status));
    const signal = new AbortController().signal;

    const result = await sourceCatalogGateway[action](request as never, signal);

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [actualRoute, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(actualRoute).toBe(route);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
    });
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("normalizes a create request through the authoritative request parser", async () => {
    const fetch = fetchMock(jsonResponse(success("create"), 201));
    const request = createRequest({
      name: "  Synthetic assistant  ",
      description: "  Synthetic catalog fixture.  ",
    });

    await expect(
      sourceCatalogGateway.create(request, new AbortController().signal),
    ).resolves.toMatchObject({ ok: true });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "Synthetic assistant",
      description: "Synthetic catalog fixture.",
    });
  });

  it("fails malformed requests locally without issuing a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await sourceCatalogGateway.retire(
      { ...retireRequest(), expectedRevision: 0 } as SourceRetireRequestV1,
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: false, error: { kind: "invalid_request" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects malformed and duplicate list payloads through the authoritative parser", async () => {
    fetchMock(jsonResponse({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source(), source()] }));
    await expect(
      sourceCatalogGateway.list(new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });

    fetchMock(jsonResponse({ schemaId: "wrong", sources: [] }));
    await expect(
      sourceCatalogGateway.list(new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
  });

  it.each([
    [400, { ok: false, error: { kind: "invalid", status: 400 } }],
    [500, { ok: false, error: { kind: "internal", status: 500 } }],
    [418, { ok: false, error: { kind: "unexpected_response", status: 418 } }],
  ] as const)("classifies HTTP %i without retaining its body", async (status, expected) => {
    const response = jsonResponse({ secret: "must-not-escape" }, status);
    const json = vi.spyOn(response, "json");
    fetchMock(response);
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual(expected);
    expect(json).not.toHaveBeenCalled();
  });

  it.each([401, 403] as const)(
    "reports protected auth loss for %i without reading the body",
    async (status) => {
      const response = jsonResponse({
        schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
        secret: "must-not-be-read",
      }, status);
      const json = vi.spyOn(response, "json");
      fetchMock(response);
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        await expect(
          sourceCatalogGateway.create(createRequest(), new AbortController().signal),
        ).resolves.toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(json).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("accepts only an authoritative 409 refusal for the requested action and identity", async () => {
    const body = refusal("retire");
    fetchMock(jsonResponse(body, 409));
    const result = await sourceCatalogGateway.retire(
      retireRequest(),
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "refused", status: 409, refusal: body },
    });
    if (result.ok || result.error.kind !== "refused") {
      throw new Error("expected refusal");
    }
    expect(Object.isFrozen(result.error.refusal)).toBe(true);
    expect(Object.isFrozen(result.error.refusal.current)).toBe(true);
  });

  it.each([
    refusal("restore"),
    refusal("retire", { sourceId: OTHER_SOURCE_ID, current: source({ id: OTHER_SOURCE_ID, lifecycle: "retired" }) }),
    refusal("retire", { expectedRevision: 99 }),
  ])("rejects a valid refusal belonging to a different request", async (body) => {
    fetchMock(jsonResponse(body, 409));
    await expect(
      sourceCatalogGateway.retire(retireRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "identity" },
    });
  });

  it("does not treat malformed 409 data as a refusal", async () => {
    fetchMock(jsonResponse({ error: "source_catalog_refused" }, 409));
    await expect(
      sourceCatalogGateway.retire(retireRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
  });

  it("recognizes only the exact bounded unknown-commit acknowledgement", async () => {
    fetchMock(jsonResponse({ error: "commit_outcome_unknown" }, 503));
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "commit_outcome_unknown", status: 503 },
    });

    fetchMock(jsonResponse({ error: "commit_outcome_unknown", detail: "untrusted" }, 503));
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unexpected_response", status: 503 },
    });
  });

  it.each([
    success("restore"),
    success("retire", { sourceId: OTHER_SOURCE_ID, applied: source({ id: OTHER_SOURCE_ID, lifecycle: "retired", revision: 2 }) as SourceV1 & { revision: number } }),
    success("retire", { expectedRevision: 99, previousRevision: 99, appliedRevision: 100, applied: source({ lifecycle: "retired", revision: 100 }) as SourceV1 & { revision: number } }),
  ])("rejects a success for another action, path, or live CAS revision", async (body) => {
    fetchMock(jsonResponse(body));
    await expect(
      sourceCatalogGateway.retire(retireRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "identity" },
    });
  });

  it("accepts a replay's original revision tuple while still matching action and path", async () => {
    const replay = success("retire", { replayed: true });
    fetchMock(jsonResponse(replay));
    await expect(
      sourceCatalogGateway.retire(
        retireRequest({ expectedRevision: 7 }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: true, value: replay });
  });

  it("requires create replay state to agree with the server status", async () => {
    fetchMock(jsonResponse(success("create", { replayed: true }), 201));
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "identity" },
    });

    fetchMock(jsonResponse(success("create"), 200));
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "identity" },
    });
  });

  it("rejects invalid JSON, wrong content type, and unexpected success status", async () => {
    fetchMock(new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(sourceCatalogGateway.list(new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "json" },
    });

    fetchMock(new Response(JSON.stringify({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [] }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    await expect(sourceCatalogGateway.list(new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason: "content_type" },
    });

    fetchMock(jsonResponse(success("create"), 202));
    await expect(
      sourceCatalogGateway.create(createRequest(), new AbortController().signal),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unexpected_response", status: 202 },
    });
  });

  it("distinguishes network, unexpected, and abort failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("synthetic network failure");
    }));
    await expect(sourceCatalogGateway.list(new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: { kind: "network" },
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("synthetic unexpected failure");
    }));
    await expect(sourceCatalogGateway.list(new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: { kind: "unexpected" },
    });

    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(sourceCatalogGateway.list(controller.signal)).resolves.toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports abort when cancellation wins after the request starts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      throw new TypeError("fetch aborted");
    }));
    await expect(sourceCatalogGateway.list(controller.signal)).resolves.toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
  });
});
