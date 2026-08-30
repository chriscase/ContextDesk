import {
  CASE_LIST_SCHEMA_ID,
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  type CaseV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT } from "../../protected-api.js";
import { investigationGateway } from "./gateway.js";
import {
  RUNTIME_FIXTURE_IDS,
  makeArchiveAllowedLifecycle,
  makeArchiveRefusedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makePopulatedCase,
} from "./testkit/fixtures.js";
import { createDeferred } from "./testkit/promises.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function options(controller = new AbortController()) {
  return { signal: controller.signal };
}

function archivedCase(): CaseV1 {
  return { ...makePopulatedCase(), status: "archived" };
}

function lifecycleSuccess() {
  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    action: "archive",
    previousStatus: "monitoring",
    appliedStatus: "archived",
    case: archivedCase(),
  } as const;
}

function lifecycleChanged() {
  return {
    schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
    error: "lifecycle_changed",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    action: "archive",
    current: makeArchiveRefusedLifecycle(),
  } as const;
}

function lifecycleRefused() {
  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
    error: "lifecycle_refused",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    action: "archive",
    reason: "legal_hold",
    detail: "Clear the legal hold before archiving this investigation.",
  } as const;
}

describe("the complete Runtime V1 transport surface", () => {
  it("uses the eight protected routes and publishes only parsed values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const route = String(input);
        const method = init?.method ?? "GET";
        if (route === "/api/cases" && method === "GET") return jsonResponse(makeCaseList());
        if (route === "/api/cases" && method === "POST") return jsonResponse(makePopulatedCase());
        if (route.endsWith("/evidence") && method === "POST") {
          return jsonResponse(makeEvidenceUploadSuccess());
        }
        if (route.endsWith("/evidence")) return jsonResponse(makeEvidenceList());
        if (route.endsWith("/contributions")) return jsonResponse(makeContributionList());
        if (route.endsWith("/lifecycle") && method === "POST") {
          return jsonResponse(lifecycleSuccess());
        }
        if (route.endsWith("/lifecycle")) return jsonResponse(makeArchiveAllowedLifecycle());
        return jsonResponse(makePopulatedCase());
      },
    );
    const investigationId = RUNTIME_FIXTURE_IDS.populatedCase;
    const signalOptions = options();

    const createInput = Object.assign(
      Object.create({ inheritedCreateField: "must-not-cross" }) as Record<string, unknown>,
      {
        title: "Checkout latency after 4.8.0 rollout",
        severity: "high",
        clientTime: "2026-02-03T19:59:00.000Z",
        problemStatement: "Checkout latency is above the objective.",
        affectedParties: "Storefront customers",
        impact: "Timeouts",
        scope: "Checkout API",
        openQuestions: ["Are retries amplifying the affected requests?"],
        investigationContext: Object.assign(
          Object.create({ inheritedContextField: "must-not-cross" }) as Record<string, unknown>,
          {
            productName: "ContextDesk Storefront",
            version: "4.8.0",
            build: "2026.02.03.4",
            component: "checkout-api",
            environment: "production",
            organization: "Retail operations",
            extraContextField: "must-not-cross",
          },
        ),
        occurredAt: "2026-02-03T19:42:00.000Z",
        occurredAtPrecision: "second",
        occurredAtZone: "explicit",
        extraCreateField: "must-not-cross",
      },
    );
    const uploadInput = Object.assign(
      Object.create({ inheritedUploadField: "must-not-cross" }) as Record<string, unknown>,
      {
        kind: "log",
        summary: "Timeout excerpt",
        filename: "checkout.log",
        mediaType: "text/plain",
        contentBase64: "c3ludGhldGlj",
        uri: "file:///synthetic/checkout.log",
        expectedHash: null,
        privacyClass: "owner_only",
        clientTime: "2026-02-03T19:59:30.000Z",
        sourceId: "source-browser-upload",
        extraUploadField: "must-not-cross",
      },
    );
    const lifecycleInput = Object.assign(
      Object.create({ inheritedLifecycleField: "must-not-cross" }) as Record<string, unknown>,
      {
        action: "archive",
        expected: Object.assign(
          Object.create({ inheritedExpectedField: "must-not-cross" }) as Record<string, unknown>,
          {
            status: "monitoring",
            legalHold: false,
            restoreTarget: "monitoring",
            extraExpectedField: "must-not-cross",
          },
        ),
        clientTime: "2026-02-03T20:00:00.000Z",
        extraLifecycleField: "must-not-cross",
      },
    );

    const results = await Promise.all([
      investigationGateway.listInvestigations(signalOptions),
      investigationGateway.getInvestigation(investigationId, signalOptions),
      investigationGateway.createInvestigation(
        createInput as unknown as Parameters<
          typeof investigationGateway.createInvestigation
        >[0],
        signalOptions,
      ),
      investigationGateway.listEvidence(investigationId, signalOptions),
      investigationGateway.listContributions(investigationId, signalOptions),
      investigationGateway.uploadEvidence(
        investigationId,
        uploadInput as unknown as Parameters<typeof investigationGateway.uploadEvidence>[1],
        signalOptions,
      ),
      investigationGateway.getLifecycle(investigationId, signalOptions),
      investigationGateway.applyLifecycleAction(
        investigationId,
        lifecycleInput as unknown as Parameters<
          typeof investigationGateway.applyLifecycleAction
        >[1],
        signalOptions,
      ),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(fetchMock.mock.calls.map(([route, init]) => [String(route), init?.method ?? "GET"]))
      .toEqual([
        ["/api/cases", "GET"],
        [`/api/cases/${investigationId}`, "GET"],
        ["/api/cases", "POST"],
        [`/api/cases/${investigationId}/evidence`, "GET"],
        [`/api/cases/${investigationId}/contributions`, "GET"],
        [`/api/cases/${investigationId}/evidence`, "POST"],
        [`/api/cases/${investigationId}/lifecycle`, "GET"],
        [`/api/cases/${investigationId}/lifecycle`, "POST"],
      ]);

    const actionInit = fetchMock.mock.calls[7]?.[1];
    const actionBody = JSON.parse(String(actionInit?.body)) as Record<string, unknown>;
    expect(actionBody).toEqual({
      schemaId: "cd-collab.investigation_lifecycle_action_request.v1",
      investigationId,
      action: "archive",
      expected: {
        status: "monitoring",
        legalHold: false,
        restoreTarget: "monitoring",
      },
      clientTime: "2026-02-03T20:00:00.000Z",
    });
    expect(actionBody).not.toHaveProperty("targetStatus");

    const createInit = fetchMock.mock.calls[2]?.[1];
    expect(JSON.parse(String(createInit?.body))).toEqual({
      title: "Checkout latency after 4.8.0 rollout",
      severity: "high",
      clientTime: "2026-02-03T19:59:00.000Z",
      problemStatement: "Checkout latency is above the objective.",
      affectedParties: "Storefront customers",
      impact: "Timeouts",
      scope: "Checkout API",
      openQuestions: ["Are retries amplifying the affected requests?"],
      investigationContext: {
        productName: "ContextDesk Storefront",
        version: "4.8.0",
        build: "2026.02.03.4",
        component: "checkout-api",
        environment: "production",
        organization: "Retail operations",
      },
      occurredAt: "2026-02-03T19:42:00.000Z",
      occurredAtPrecision: "second",
      occurredAtZone: "explicit",
    });

    const uploadInit = fetchMock.mock.calls[5]?.[1];
    expect(JSON.parse(String(uploadInit?.body))).toEqual({
      kind: "log",
      summary: "Timeout excerpt",
      filename: "checkout.log",
      mediaType: "text/plain",
      contentBase64: "c3ludGhldGlj",
      uri: "file:///synthetic/checkout.log",
      expectedHash: null,
      privacyClass: "owner_only",
      clientTime: "2026-02-03T19:59:30.000Z",
      sourceId: "source-browser-upload",
    });

    for (const callIndex of [2, 5, 7]) {
      expect(fetchMock.mock.calls[callIndex]?.[1]?.headers).toEqual({
        "content-type": "application/json",
        [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
      });
    }
  });

  it("URL-encodes investigation identities instead of interpolating route text", async () => {
    const investigation = { ...makePopulatedCase(), id: "case /?# owned" };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(investigation));
    const result = await investigationGateway.getInvestigation(investigation.id, options());

    expect(result).toEqual({ ok: true, value: investigation });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/cases/case%20%2F%3F%23%20owned");
  });
});

describe("mutation body containment", () => {
  it("contains getter failures without fetching or publishing thrown detail", async () => {
    const secret = "private getter detail";
    const input = {} as Record<string, unknown>;
    Object.defineProperty(input, "title", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await investigationGateway.createInvestigation(
      input as unknown as Parameters<typeof investigationGateway.createInvestigation>[0],
      options(),
    );

    expect(result).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains cyclic and custom-stringifier failures without fetching", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingValue = {
      toJSON: () => {
        throw new Error("private stringify detail");
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const cycleResult = await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "log", summary: cyclic } as unknown as Parameters<
        typeof investigationGateway.uploadEvidence
      >[1],
      options(),
    );
    const stringifyResult = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: {
          status: throwingValue,
          legalHold: false,
          restoreTarget: "monitoring",
        },
      } as unknown as Parameters<typeof investigationGateway.applyLifecycleAction>[1],
      options(),
    );

    expect(cycleResult).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(stringifyResult).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives cancellation precedence when a snapshot getter aborts and throws", async () => {
    const controller = new AbortController();
    const expected = {
      get status() {
        controller.abort();
        throw new Error("must remain bounded");
      },
      legalHold: false,
      restoreTarget: "monitoring",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { action: "archive", expected } as unknown as Parameters<
        typeof investigationGateway.applyLifecycleAction
      >[1],
      options(controller),
    );

    expect(result).toEqual({ ok: false, error: { kind: "aborted" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("status-first bounded failures", () => {
  it.each([401, 403] as const)(
    "preserves protectedApiFetch auth loss for %i and never reads the body",
    async (status) => {
      const response = jsonResponse(lifecycleRefused(), status);
      const json = vi.spyOn(response, "json");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        const result = await investigationGateway.listInvestigations(options());
        expect(result).toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(json).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ status });
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it.each([401, 403] as const)(
    "preserves lifecycle auth loss for %i without reading a conflict-shaped body",
    async (status) => {
      const response = jsonResponse(lifecycleChanged(), status);
      const json = vi.spyOn(response, "json");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      const result = await investigationGateway.applyLifecycleAction(
        RUNTIME_FIXTURE_IDS.populatedCase,
        {
          action: "archive",
          expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
        },
        options(),
      );

      expect(result).toEqual({ ok: false, error: { kind: "auth_lost", status } });
      expect(json).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, { kind: "validation", status: 400 }],
    [404, { kind: "not_found", status: 404 }],
    [409, { kind: "conflict", status: 409 }],
    [503, { kind: "unavailable", status: 503 }],
    [500, { kind: "server_failure", status: 500 }],
    [418, { kind: "unexpected_response", status: 418 }],
  ] as const)("classifies HTTP %i without reading arbitrary error bodies", async (status, error) => {
    const response = jsonResponse({ private: "must-not-escape" }, status);
    const json = vi.spyOn(response, "json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await investigationGateway.listInvestigations(options());
    expect(result).toEqual({ ok: false, error });
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("bounds network and unexpected exceptions without publishing their messages", async () => {
    const secret = "private.example/token/synthetic-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new TypeError(secret));
    fetchMock.mockRejectedValueOnce(new Error(secret));

    const network = await investigationGateway.listInvestigations(options());
    const unexpected = await investigationGateway.listInvestigations(options());
    expect(network).toEqual({ ok: false, error: { kind: "network" } });
    expect(unexpected).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(JSON.stringify([network, unexpected])).not.toContain(secret);
  });
});

describe("successful response protocol and identity", () => {
  it("distinguishes content-type, JSON, and contract failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(makeCaseList())));
    fetchMock.mockResolvedValueOnce(new Response("not-json", {
      headers: { "content-type": "application/json" },
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...makeCaseList(),
      schemaId: "cd-collab.case_list.future",
    }));

    expect(await investigationGateway.listInvestigations(options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "content_type" },
    });
    expect(await investigationGateway.listInvestigations(options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "json" },
    });
    expect(await investigationGateway.listInvestigations(options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
  });

  it("rejects duplicate list identities and cross-case response envelopes", async () => {
    const duplicate = makePopulatedCase();
    const wrongCaseId = "case-other";
    const evidence = makeEvidenceList();
    const contributions = makeContributionList();
    const upload = makeEvidenceUploadSuccess();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: CASE_LIST_SCHEMA_ID,
      cases: [duplicate, duplicate],
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...evidence,
      caseId: wrongCaseId,
      artifacts: evidence.artifacts.map((item) => ({ ...item, caseId: wrongCaseId })),
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...contributions,
      caseId: wrongCaseId,
      contributions: contributions.contributions.map((item) => ({
        ...item,
        caseId: wrongCaseId,
      })),
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...upload,
      caseId: wrongCaseId,
      artifact: { ...upload.artifact, caseId: wrongCaseId },
      summary: { ...upload.summary, caseId: wrongCaseId },
    }));

    const identityFailure = { ok: false, error: { kind: "protocol", reason: "identity" } };
    expect(await investigationGateway.listInvestigations(options())).toEqual(identityFailure);
    expect(await investigationGateway.listEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.listContributions(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "log", summary: "Synthetic" },
      options(),
    )).toEqual(identityFailure);
  });

  it("uses the artifact contract to reject broken upload linkage", async () => {
    const upload = makeEvidenceUploadSuccess();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      ...upload,
      artifact: { ...upload.artifact, summaryContributionId: "different-summary" },
    }));

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "attachment", summary: "Synthetic" },
      options(),
    )).toEqual({ ok: false, error: { kind: "protocol", reason: "contract" } });
  });

  it("requires non-empty unique evidence and contribution identities", async () => {
    const evidence = makeEvidenceList();
    const contributions = makeContributionList();
    const upload = makeEvidenceUploadSuccess();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...evidence,
      artifacts: [{ ...evidence.artifacts[0], id: "" }],
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...evidence,
      artifacts: [evidence.artifacts[0], { ...evidence.artifacts[0] }],
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...contributions,
      contributions: [{ ...contributions.contributions[0], id: "" }],
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...contributions,
      contributions: [contributions.contributions[0], { ...contributions.contributions[0] }],
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...upload,
      artifact: { ...upload.artifact, id: "" },
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...upload,
      artifact: { ...upload.artifact, summaryContributionId: "" },
      summary: { ...upload.summary, id: "" },
    }));

    const identityFailure = { ok: false, error: { kind: "protocol", reason: "identity" } };
    expect(await investigationGateway.listEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.listEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.listContributions(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.listContributions(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "log", summary: "Synthetic" },
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "log", summary: "Synthetic" },
      options(),
    )).toEqual(identityFailure);
  });

  it("checks detail, create, lifecycle-preview, and action-success identities", async () => {
    const other = "case-other";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...makePopulatedCase(), id: other }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...makePopulatedCase(), id: "" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...makeArchiveAllowedLifecycle(),
      investigationId: other,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...lifecycleSuccess(),
      investigationId: other,
      case: { ...archivedCase(), id: other },
    }));
    const identityFailure = { ok: false, error: { kind: "protocol", reason: "identity" } };

    expect(await investigationGateway.getInvestigation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.createInvestigation(
      { title: "Synthetic" },
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.getLifecycle(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual(identityFailure);
    expect(await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
      },
      options(),
    )).toEqual(identityFailure);
  });

  it("keeps an empty parsed collection distinct from an unavailable collection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({ schemaId: CASE_LIST_SCHEMA_ID, cases: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    expect(await investigationGateway.listInvestigations(options())).toEqual({
      ok: true,
      value: [],
    });
    expect(await investigationGateway.listInvestigations(options())).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });
  });
});

describe("abort fences", () => {
  it("does not fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await investigationGateway.listInvestigations(options(controller))).toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish a response aborted immediately after fetch", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      return jsonResponse(makeCaseList());
    });

    expect(await investigationGateway.listInvestigations(options(controller))).toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
  });

  it("does not publish when cancellation happens during JSON parsing", async () => {
    const controller = new AbortController();
    const body = createDeferred<unknown>();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => body.promise,
    } as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const pending = investigationGateway.listInvestigations(options(controller));
    controller.abort();
    body.resolve(makeCaseList());
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it("checks cancellation again after the authoritative parser", async () => {
    const controller = new AbortController();
    const raw = makePopulatedCase() as CaseV1;
    Object.defineProperty(raw, "createdBy", {
      enumerable: true,
      get: () => {
        controller.abort();
        return "identity-alice";
      },
    });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => raw,
    } as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    expect(await investigationGateway.getInvestigation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it("checks cancellation after identity validation and before publication", async () => {
    const controller = new AbortController();
    const raw = makeEvidenceList();
    let reads = 0;
    Object.defineProperty(raw, "caseId", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads === 3) controller.abort();
        return RUNTIME_FIXTURE_IDS.populatedCase;
      },
    });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/problem+json" }),
      json: async () => raw,
    } as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await investigationGateway.listEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(controller),
    );
    expect(reads).toBe(3);
    expect(result).toEqual({ ok: false, error: { kind: "aborted" } });
  });
});

describe("typed lifecycle action conflicts", () => {
  it("returns the parsed changed state for identity-safe reconciliation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(lifecycleChanged(), 409));
    const result = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
      },
      options(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "lifecycle_changed",
        status: 409,
        investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
        action: "archive",
        current: makeArchiveRefusedLifecycle(),
      },
    });
  });

  it("preserves only the contract-bounded lifecycle refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(lifecycleRefused(), 409));
    const result = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: true, restoreTarget: "monitoring" },
      },
      options(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "lifecycle_refused",
        status: 409,
        action: "archive",
        reason: "legal_hold",
        detail: "Clear the legal hold before archiving this investigation.",
      },
    });
  });

  it("treats changed/refused identity or action disagreement as a protocol failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...lifecycleChanged(),
      investigationId: "case-other",
      current: {
        ...makeArchiveRefusedLifecycle(),
        investigationId: "case-other",
      },
    }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...lifecycleRefused(),
      action: "restore",
      reason: "not_archived",
    }, 409));
    const command = {
      action: "archive" as const,
      expected: { status: "monitoring" as const, legalHold: false, restoreTarget: "monitoring" as const },
    };

    const changed = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      command,
      options(),
    );
    const refused = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      command,
      options(),
    );
    expect(changed).toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });
    expect(refused).toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });
  });

  it("treats a recognized but malformed lifecycle conflict as a contract failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
      error: "lifecycle_changed",
      investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
      action: "archive",
    }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...lifecycleRefused(),
      detail: "",
    }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...lifecycleChanged(),
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
    }, 409));
    const command = {
      action: "archive" as const,
      expected: {
        status: "monitoring" as const,
        legalHold: false,
        restoreTarget: "monitoring" as const,
      },
    };
    const contractFailure = {
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    };

    expect(await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      command,
      options(),
    )).toEqual(contractFailure);
    expect(await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      command,
      options(),
    )).toEqual(contractFailure);
    expect(await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      command,
      options(),
    )).toEqual(contractFailure);
  });

  it("gives cancellation precedence while reading a declared conflict", async () => {
    const controller = new AbortController();
    const raw = lifecycleChanged() as Record<string, unknown>;
    Object.defineProperty(raw, "error", {
      enumerable: true,
      get: () => {
        controller.abort();
        return "lifecycle_changed";
      },
    });
    const response = {
      ok: false,
      status: 409,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => raw,
    } as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    expect(await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
      },
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it.each([
    new Response("not json", { status: 409 }),
    new Response("not json", {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
    jsonResponse({ error: "future_conflict", private: "not-published" }, 409),
  ])("keeps an unknown lifecycle 409 as a generic bounded conflict", async (response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await investigationGateway.applyLifecycleAction(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
      },
      options(),
    );
    expect(result).toEqual({ ok: false, error: { kind: "conflict", status: 409 } });
    expect(JSON.stringify(result)).not.toContain("not-published");
  });
});
